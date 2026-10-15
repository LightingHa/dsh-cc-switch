/**
 * dsh-cc-switch —— 把 cc-switch 的模型供应商直接接进 DeepSeek Harness。
 *
 * 做法：读 cc-switch 的数据库（`~/.cc-switch/cc-switch.db`），把每家供应商
 * 映射成 `@deepseek-ai/dsh-llm-pi-ai` 的 provider 路由，然后
 *
 *   1. 用 harness 凭据服务（ctx.credentials）存好 API Key，
 *   2. 通过 settings 服务把路由写进 profile 里 `llm-pi-ai` 条目的
 *      `providers` 字段（这正是 Web「模型」页面的写入路径，会持久化到
 *      profile 的 cordis.patch.yml，并热加载生效，无需重启）。
 *
 * 因此 cc-switch 里有什么模型，DSH 的模型选择器里就能选到什么模型；
 * 你在 cc-switch 里改完供应商，下一次同步就会跟上。
 */

import z from '@deepseek-ai/schemastery'

import { KNOWN_APP_TYPES, databaseStamp, readProviders, resolvePaths } from './ccswitch.js'
import { SUPPORTED_PROTOCOLS } from './convert.js'
import { buildPlan, isOwnedKey, ownedRoutesIn, profileDiffKeys, profileMatches } from './plan.js'
import { DEFAULT_PROBE_MAX_OUTPUT_TOKENS, formatProbeReport, probeRoutes } from './probe.js'
import { readState, stateMatches, statePathFor, writeState } from './state.js'

export const name = 'cc-switch'

// tools 是硬依赖（没有它就没有对外入口）；settings / credentials 用
// ctx.inject 惰性获取，缺失时插件只是「能诊断但不能写」，不会让 profile 起不来。
export const inject = ['tools']

/** 默认导入的 app 类型：cc-switch 里能直连第三方端点的那些。 */
const DEFAULT_APP_TYPES = ['claude', 'claude-desktop', 'codex', 'openclaw', 'mcode', 'pi', 'opencode', 'hermes', 'grokbuild', 'gemini']

/** 密钥回显掩码。 */
const MASK = '••••'

export const Config = z.object({
  enabled: z
    .boolean()
    .description('总开关；关闭后不自动同步，但仍可用 cc_switch 工具手动执行')
    .default(true),
  dbPath: z
    .string()
    .description('cc-switch 数据库路径；留空自动探测 ~/.cc-switch/cc-switch.db（也认 CC_SWITCH_DB / CC_SWITCH_HOME 环境变量）')
    .default(''),
  appTypes: z
    .string()
    .description(`要导入的 cc-switch app 类型（逗号分隔）。可选：${KNOWN_APP_TYPES.join(', ')}`)
    .default(DEFAULT_APP_TYPES.join(',')),
  include: z
    .string()
    .description('只导入名称/ID 命中这些关键字的供应商（逗号分隔，留空=不限制）')
    .default(''),
  exclude: z
    .string()
    .description('排除名称/ID 命中这些关键字的供应商（逗号分隔）')
    .default(''),
  routePrefix: z
    .string()
    .description('生成的路由名前缀（同时也是「本插件拥有的路由」的判定依据，以及凭据名前缀）')
    .default('ccswitch'),
  targetEntry: z
    .string()
    .description('写入哪个插件条目的 providers（DSH 内置的多提供方适配器条目 id）')
    .default('llm-pi-ai'),
  mode: z
    .union(['apply', 'plan'])
    .description('apply=把计划写入配置；plan=只计算并打日志，不改动配置')
    .default('apply'),
  onConflict: z
    .union(['skip', 'overwrite'])
    .description('路由名与 llm-pi-ai 里已有配置撞车时的行为：skip=跳过并警告，overwrite=覆盖')
    .default('skip'),
  importUnsupported: z
    .boolean()
    .description('连协议/端点不完整的供应商也写进去（会让模型选择器出现选不了的条目，一般保持 false）')
    .default(false),
  pruneOwnedRoutes: z
    .boolean()
    .description('清理本插件上一次写过、这次不再生成的路由与凭据（只清自己写过的，绝不碰别人的）')
    .default(true),
  writeCredentials: z
    .boolean()
    .description('把 cc-switch 里的 API Key 写进 harness 凭据存储，让路由直接可用')
    .default(true),
  usageModelHints: z
    .boolean()
    .description('用 cc-switch 代理日志里出现过的模型名补充模型清单（Codex 供应商常常只声明一个模型）')
    .default(true),
  syncOnLoad: z
    .boolean()
    .description('插件加载后自动同步一次')
    .default(true),
  loadDelayMs: z
    .number()
    .description('加载后延迟多久开始首次同步（毫秒），避开启动高峰')
    .default(2500),
  watchSeconds: z
    .number()
    .description('每隔多少秒检查一次 cc-switch 数据库变化并自动同步；0=关闭')
    .default(30),
  statePath: z
    .string()
    .description('清单文件路径；留空用 $DSH_HOME/cc-switch-state.json')
    .default(''),
  overrides: z
    .dict(z.any())
    .description('人工修正：{ 路由名: 要合并进该路由的字段 }，例如 {"ccswitch-codex-xxx":{"api":"openai-completions"}}')
    .default({}),
  probeTimeoutMs: z
    .number()
    .step(1)
    .min(1000)
    .description('action=probe 时单条路由的等待上限（毫秒）；中转端点常常几十秒才吐首字节')
    .default(120000),
  probeSlowFirstByteMs: z
    .number()
    .step(1)
    .min(1000)
    .description('体检时首字节超过这个毫秒数就标成「慢」')
    .default(30000),
  toolName: z
    .string()
    .description('工具公开名（与其它插件冲突时可改名）')
    .default('cc_switch'),
  debug: z
    .boolean()
    .description('把每次同步的细节打进日志')
    .default(false),
})

// ═══ 小工具 ═══════════════════════════════════════════════════════════════

export function parseList(value) {
  return String(value ?? '')
    .split(/[,;，；\s]+/)
    .map((item) => item.trim())
    .filter((item) => item !== '')
}

/**
 * 过滤关键字：只按逗号/分号切分。
 * 供应商名字里带空格很常见（"Ark Code Latest"、"Google 官方"），
 * 按空白切会把一个关键字拆成两个，导致误命中。
 */
export function parseFilters(value) {
  return String(value ?? '')
    .split(/[,;，；]+/)
    .map((item) => item.trim())
    .filter((item) => item !== '')
}

export function maskKey(value) {
  if (typeof value !== 'string' || value === '') return ''
  if (value.length <= 8) return MASK
  return `${value.slice(0, 4)}${MASK}`
}

function getService(ctx, name) {
  try {
    const viaGet = typeof ctx.get === 'function' ? ctx.get(name) : undefined
    if (viaGet !== undefined && viaGet !== null) return viaGet
  } catch {
    /* 服务未挂载 */
  }
  return ctx[name]
}

function matchesFilter(record, token) {
  const needle = token.toLowerCase()
  return String(record.name ?? '').toLowerCase().includes(needle) || String(record.id ?? '').toLowerCase().includes(needle)
}

/**
 * cc-switch 记录 -> 过滤后的记录列表。
 * `include` 一旦给出就表示「只要命中的这些」，与 appTypes 取并集语义；
 * `exclude` 永远最后生效。
 */
export function selectRecords(records, { appTypes = [], include = '', exclude = '' } = {}) {
  const types = new Set(appTypes)
  const includes = parseFilters(include)
  const excludes = parseFilters(exclude)
  const isForced = (record) => includes.length > 0 && includes.some((token) => matchesFilter(record, token))
  return records.filter((record) => {
    if (typeof record.appType !== 'string' || record.appType === '' || record.appType === 'unknown') return false
    const forced = isForced(record)
    if (includes.length > 0 && !forced) return false
    if (!forced && types.size > 0 && !types.has(record.appType)) return false
    if (excludes.some((token) => matchesFilter(record, token))) return false
    return true
  })
}

// ═══ 插件主体 ═════════════════════════════════════════════════════════════

export function apply(ctx, config = {}) {
  const log = {
    info: (...args) => {
      try {
        ctx.logger?.info?.(...args)
      } catch {
        /* logger 不可用时静默 */
      }
    },
    warn: (...args) => {
      try {
        ctx.logger?.warn?.(...args)
      } catch {
        /* 同上 */
      }
    },
    error: (...args) => {
      try {
        ctx.logger?.error?.(...args)
      } catch {
        /* 同上 */
      }
    },
    debug: (message) => {
      if (config.debug !== true) return
      try {
        ctx.logger?.info?.(`[cc-switch] ${message}`)
      } catch {
        /* 同上 */
      }
    },
  }

  const current = () => ({
    enabled: config.enabled !== false,
    dbPath: typeof config.dbPath === 'string' ? config.dbPath : '',
    appTypes: parseList(config.appTypes).length > 0 ? parseList(config.appTypes) : DEFAULT_APP_TYPES,
    include: config.include ?? '',
    exclude: config.exclude ?? '',
    routePrefix: typeof config.routePrefix === 'string' && config.routePrefix.trim() !== '' ? config.routePrefix.trim() : 'ccswitch',
    targetEntry: typeof config.targetEntry === 'string' && config.targetEntry.trim() !== '' ? config.targetEntry.trim() : 'llm-pi-ai',
    mode: config.mode === 'plan' ? 'plan' : 'apply',
    onConflict: config.onConflict === 'overwrite' ? 'overwrite' : 'skip',
    importUnsupported: config.importUnsupported === true,
    pruneOwnedRoutes: config.pruneOwnedRoutes !== false,
    writeCredentials: config.writeCredentials !== false,
    usageModelHints: config.usageModelHints !== false,
    syncOnLoad: config.syncOnLoad !== false,
    loadDelayMs: Number.isFinite(Number(config.loadDelayMs)) && Number(config.loadDelayMs) >= 0 ? Number(config.loadDelayMs) : 2500,
    watchSeconds: Number.isFinite(Number(config.watchSeconds)) && Number(config.watchSeconds) >= 0 ? Number(config.watchSeconds) : 30,
    statePath: statePathFor({ statePath: config.statePath ?? '' }),
    overrides: config.overrides && typeof config.overrides === 'object' ? config.overrides : {},
    probeTimeoutMs: Number.isFinite(config.probeTimeoutMs) && config.probeTimeoutMs >= 1000 ? config.probeTimeoutMs : 120000,
    probeSlowFirstByteMs: Number.isFinite(config.probeSlowFirstByteMs) && config.probeSlowFirstByteMs >= 1000 ? config.probeSlowFirstByteMs : 30000,
  })

  const runtime = { chain: Promise.resolve(), lastStamp: undefined, lastSummary: undefined }

  /** 读取当前 llm-pi-ai 条目的 providers（通过 settings 服务的投影）。 */
  function currentProvidersOf(settings, targetEntry) {
    const rows = settings.describe()
    const row = rows.find((entry) => entry.ns === targetEntry)
    if (row === undefined) return { row: undefined, providers: {} }
    const providers = row.value?.providers
    return { row, providers: providers !== undefined && providers !== null && typeof providers === 'object' ? providers : {} }
  }

  /** 归一化 baseURL 以便比较：去尾斜杠。 */
  function normalizeBaseURL(value) {
    return String(value ?? '').trim().replace(/\/+$/, '')
  }

  /**
   * 找出「同端点 + 同 Key」的已有路由。
   *
   * 为什么要专门提醒：同一把 Key 在 cc-switch 和 DSH 里各配了一份是很常见的事
   * （比如火山方舟的 Key 既存成了 `huoshan`，又在 cc-switch 里配了一家）。这时
   * 两条路由**共用同一份账号配额**，遇到 429 限流时在它们之间来回切是白费的 ——
   * 这个坑不点明，用户会以为换条路由就能绕过。
   *
   * 只比较、绝不回显 Key；也只解析端点相同的那少数几条，不做全量凭据扫描。
   */
  async function sharedQuotaWarnings({ plan, currentProviders, credentials, prefix }) {
    if (credentials === undefined) return []
    const ours = new Map()
    for (const entry of plan.credentials) {
      const profile = plan.routes[entry.routeKey]
      if (profile === undefined || typeof entry.value !== 'string' || entry.value === '') continue
      ours.set(entry.routeKey, { baseURL: normalizeBaseURL(profile.baseURL), value: entry.value })
    }
    if (ours.size === 0) return []

    const warnings = []
    for (const [key, profile] of Object.entries(currentProviders)) {
      if (isOwnedKey(key, prefix) || plan.managedRoutes.includes(key)) continue
      const ref = profile?.apiKeyEnv
      const base = normalizeBaseURL(profile?.baseURL)
      if (typeof ref !== 'string' || ref === '' || base === '') continue
      if (![...ours.values()].some((item) => item.baseURL === base)) continue
      let resolved
      try {
        resolved = await credentials.resolve(ref)
      } catch {
        continue
      }
      if (resolved?.value === undefined) continue
      const match = [...ours.entries()].find(([, item]) => item.baseURL === base && item.value === resolved.value)
      if (match === undefined) continue
      warnings.push(
        `路由 "${key}" 与 "${match[0]}" 用的是同一个端点、同一把 Key：账号配额共用，` +
          '遇到 429/限流时在它们之间切换没有用（只能等配额重置，或换别的账号/端点）',
      )
    }
    return warnings
  }

  /**
   * 执行一次同步。
   * @param options.reason - 触发来源，仅用于日志/汇报。
   * @param options.dryRun - 只计算不写入。
   * @param options.selection - 本次调用临时收窄的范围 `{ appTypes, include, exclude }`。
   * @param options.overrides - 本次调用附加的人工修正。
   * @returns 汇报对象（同时用于工具输出与日志）。
   */
  async function runOnce({ reason = 'manual', dryRun = false, overrides: argOverrides, selection } = {}) {
    const cfg = current()
    const selectionAppTypes = selection?.appTypes !== undefined && selection.appTypes.length > 0 ? selection.appTypes : cfg.appTypes
    const selectionInclude = selection?.include !== undefined ? selection.include : cfg.include
    const selectionExclude = selection?.exclude !== undefined ? selection.exclude : cfg.exclude
    const settings = getService(ctx, 'settings')
    const credentials = getService(ctx, 'credentials')
    const statePath = cfg.statePath
    const report = {
      ok: false,
      reason,
      applied: false,
      dryRun,
      source: 'missing',
      sourcePath: undefined,
      targetEntry: cfg.targetEntry,
      routePrefix: cfg.routePrefix,
      providers: { total: 0, selected: 0, imported: 0, skipped: 0 },
      routes: { add: [], update: [], remove: [], unchanged: [], conflicts: [], total: 0 },
      credentials: { written: 0, removed: 0, skipped: [] },
      appTypes: [],
      skipped: [],
      warnings: [],
      message: '',
    }

    if (settings === undefined) {
      report.message = '没有挂载 settings 服务，无法写入 llm-pi-ai 配置（该服务由 DSH 基础组合提供）'
      return report
    }

    // 1) 读 cc-switch
    const source = await readProviders({
      dbPath: cfg.dbPath,
      appTypes: selectionAppTypes,
      logger: { debug: log.debug, warn: log.warn },
    })
    report.source = source.source
    report.sourcePath = source.path
    report.appTypes = source.appTypes
    report.providers.total = source.records.length
    if (source.warning !== undefined) report.warnings.push(source.warning)
    if (source.source === 'missing') {
      report.message = source.warning ?? '没有找到 cc-switch 数据'
      return report
    }

    const records = selectRecords(source.records, {
      appTypes: selectionAppTypes,
      include: selectionInclude,
      exclude: selectionExclude,
    })
    for (const record of records) {
      if (cfg.usageModelHints !== true) record.usedModels = []
    }
    report.providers.selected = records.length

    // 2) 当前配置 + 清单
    const manifest = readState(statePath)
    let currentProviders = {}
    try {
      currentProviders = currentProvidersOf(settings, cfg.targetEntry).providers
    } catch (error) {
      report.message = `读取 ${cfg.targetEntry} 当前配置失败：${error?.message || error}`
      return report
    }

    const planConfig = {
      routePrefix: cfg.routePrefix,
      overrides: argOverrides !== undefined && argOverrides !== null ? { ...cfg.overrides, ...argOverrides } : cfg.overrides,
      onConflict: cfg.onConflict,
      importUnsupported: cfg.importUnsupported,
      pruneOwnedRoutes: cfg.pruneOwnedRoutes,
    }

    // 3) 两遍：先算出需要哪些凭据引用，再解析它们的现状
    const preliminary = buildPlan({ records, config: planConfig, currentProviders, manifest, credentialState: {} })
    const refs = [...new Set([...preliminary.managedCredentials, ...(manifest.credentials ?? [])])]
    const credentialState = {}
    if (credentials !== undefined) {
      for (const ref of refs) {
        try {
          const hit = await credentials.resolve(ref)
          if (hit !== undefined && hit !== null) credentialState[ref] = { value: hit.value, source: hit.source }
        } catch {
          /* 解析失败按「未知」处理 */
        }
      }
    }
    const plan = buildPlan({ records, config: planConfig, currentProviders, manifest, credentialState })

    report.providers.imported = plan.managedRoutes.length
    report.providers.skipped = plan.skipped.length
    report.skipped = plan.skipped.map((entry) => ({ appType: entry.appType, name: entry.name, reason: entry.reason }))
    report.warnings.push(...plan.warnings)
    try {
      report.warnings.push(...(await sharedQuotaWarnings({ plan, currentProviders, credentials, prefix: cfg.routePrefix })))
    } catch (error) {
      log.debug(`[cc-switch] 配额共用检测失败（忽略）：${error?.message || error}`)
    }
    report.routes = {
      add: [...plan.add],
      update: [...plan.update],
      remove: [...plan.remove],
      unchanged: [...plan.unchanged].slice(0, 50),
      conflicts: [...plan.conflicts],
      total: plan.managedRoutes.length,
      detail: Object.fromEntries(
        Object.entries(plan.sources).map(([key, value]) => [key, { ...value, models: (plan.routes[key]?.models ?? []).map((model) => model.id) }]),
      ),
    }

    const willApply = cfg.mode === 'apply' && !dryRun && plan.changed
    if (cfg.mode !== 'apply') report.warnings.push('插件处于 plan 模式：只计算计划，不写入配置')
    report.credentials.skipped = plan.credentialSkips

    if (!plan.changed) {
      report.ok = true
      report.message = `cc-switch 与 ${cfg.targetEntry} 已经一致（${plan.managedRoutes.length} 条路由），无需变更`
      report.credentials.written = 0
      runtime.lastSummary = { at: new Date().toISOString(), ...report }
      if (!stateMatches(manifest, plan.managedRoutes, plan.managedCredentials) && cfg.mode === 'apply' && !dryRun) {
        try {
          writeState(statePath, { routes: plan.managedRoutes, credentials: plan.managedCredentials, source: source.source })
        } catch (error) {
          report.warnings.push(`清单写入失败：${error?.message || error}`)
        }
      }
      return report
    }

    if (!willApply) {
      report.ok = true
      report.plan = { routes: plan.managedRoutes, credentials: plan.credentials.map((entry) => ({ ref: entry.ref, routeKey: entry.routeKey, key: maskKey(entry.value) })) }
      report.message = dryRun
        ? `预演：将新增 ${plan.add.length} 条、更新 ${plan.update.length} 条、删除 ${plan.remove.length} 条路由，写入 ${plan.credentialWrites.length} 个凭据`
        : `plan 模式：识别到 ${plan.managedRoutes.length} 条路由，按配置不做写入`
      return report
    }

    // 4) 先落凭据，再落路由：路由一旦注册就能立刻用
    if (cfg.writeCredentials && credentials !== undefined) {
      for (const entry of plan.credentialWrites) {
        try {
          await credentials.set(entry.ref, entry.value)
          report.credentials.written += 1
        } catch (error) {
          report.warnings.push(`凭据 ${entry.ref} 写入失败：${error?.message || error}`)
        }
      }
      for (const ref of plan.credentialRemovals) {
        try {
          await credentials.unset(ref)
          report.credentials.removed += 1
        } catch (error) {
          report.warnings.push(`凭据 ${ref} 清理失败：${error?.message || error}`)
        }
      }
    } else if (!cfg.writeCredentials) {
      report.warnings.push('writeCredentials=false：API Key 未写入凭据存储，请在「设置 → 模型」里手工填写')
    } else {
      report.warnings.push('没有挂载 credentials 服务：API Key 未写入，请在「设置 → 模型」里手工填写')
    }

    // 5) 一次 write 完成全部变更（settings 会持久化到 profile 补丁并热加载）
    const ops = []
    for (const [key, profile] of Object.entries(plan.routes)) {
      const existing = currentProviders[key]
      // 读回来的是 schemastery 解析后的配置（带一堆默认字段），必须用子集比较
      if (existing !== undefined && profileMatches(existing, profile)) continue
      if (existing !== undefined && cfg.debug) {
        log.debug(`[cc-switch] 路由 ${key} 需要更新，差异字段：${profileDiffKeys(existing, profile).join(', ')}`)
      }
      ops.push({ op: 'set', path: ['providers', key], value: profile })
    }
    for (const key of plan.remove) ops.push({ op: 'unset', path: ['providers', key] })

    if (ops.length > 0) {
      const failure = await writeProviders(settings, cfg.targetEntry, ops)
      if (failure !== undefined) {
        report.ok = false
        report.message = `写入 ${cfg.targetEntry} 失败：${failure?.message || failure}`
        return report
      }
      report.applied = true
    }

    try {
      writeState(statePath, { routes: plan.managedRoutes, credentials: plan.managedCredentials, source: source.source })
    } catch (error) {
      report.warnings.push(`清单写入失败：${error?.message || error}`)
    }

    report.ok = true
    report.message =
      `已同步 ${plan.managedRoutes.length} 条 cc-switch 路由到 ${cfg.targetEntry}` +
      `（新增 ${plan.add.length}，更新 ${plan.update.length}，删除 ${plan.remove.length}，凭据 ${report.credentials.written} 个）`
    runtime.lastSummary = { at: new Date().toISOString(), ...report }
    return report
  }

  /**
   * 体检：只读地实测每条路由能不能跑通、首字节要多久。
   *
   * 与同步共用「读取 → 选择 → 计划」的前半段，但**绝不写配置、绝不写凭据**。
   * 第三方中转端点最常见的毛病就是「配置全对，就是慢 / 断流」，在模型选择器里
   * 看不出来，只会在对话时报错；体检把这件事量化成首字节耗时和流是否正常结束。
   *
   * @param options.selection - 本次临时收窄的范围 `{ appTypes, include, exclude }`。
   * @returns `{ ok, source, results, text }`。
   */
  async function probeOnce({ selection } = {}) {
    const cfg = current()
    const selectionAppTypes = selection?.appTypes !== undefined && selection.appTypes.length > 0 ? selection.appTypes : cfg.appTypes
    const source = await readProviders({
      dbPath: cfg.dbPath,
      appTypes: selectionAppTypes,
      logger: { debug: log.debug, warn: log.warn },
    })
    if (source.source === 'missing') {
      return { ok: false, source: source.source, results: [], text: source.warning ?? '没有找到 cc-switch 数据' }
    }

    const records = selectRecords(source.records, {
      appTypes: selectionAppTypes,
      include: selection?.include !== undefined ? selection.include : cfg.include,
      exclude: selection?.exclude !== undefined ? selection.exclude : cfg.exclude,
    })
    if (cfg.usageModelHints !== true) {
      for (const record of records) record.usedModels = []
    }

    const settings = getService(ctx, 'settings')
    let currentProviders = {}
    if (settings !== undefined) {
      try {
        currentProviders = currentProvidersOf(settings, cfg.targetEntry).providers
      } catch {
        /* 体检不依赖当前配置：读不到就按空算 */
      }
    }

    const plan = buildPlan({
      records,
      config: {
        routePrefix: cfg.routePrefix,
        overrides: cfg.overrides,
        onConflict: cfg.onConflict,
        importUnsupported: cfg.importUnsupported,
        pruneOwnedRoutes: false,
      },
      currentProviders,
      manifest: readState(cfg.statePath),
      credentialState: {},
    })

    // Key 从 cc-switch 现场取，不经凭据存储（存储里读到的是脱敏值）
    const keys = {}
    for (const entry of plan.credentials) {
      if (entry.routeKey !== undefined) keys[entry.routeKey] = entry.value
    }

    const results = await probeRoutes({
      routes: plan.routes,
      keys,
      timeoutMs: cfg.probeTimeoutMs,
      slowFirstByteMs: cfg.probeSlowFirstByteMs,
      onProgress: (result) => log.debug(`[cc-switch] 体检 ${result.routeKey}：${result.status}，首字节 ${result.firstByteMs ?? '-'}ms`),
    })

    const bad = results.filter((result) => result.status === 'error' || result.status === 'timeout' || result.status === 'incomplete')
    return {
      ok: results.length > 0 && bad.length === 0,
      source: source.source,
      sourcePath: source.path,
      results,
      text: formatProbeReport(results, {
        timeoutMs: cfg.probeTimeoutMs,
        source: `${source.source} (${source.path})`,
        maxOutputTokens: DEFAULT_PROBE_MAX_OUTPUT_TOKENS,
      }),
    }
  }

  /** 等待若干毫秒。 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 永久性失败：重试没有意义。 */
function isPermanentWriteError(error) {
  const message = String(error?.message ?? error)
  return (
    message.includes('is not volatile') ||
    message.includes('No configurable plugin entry') ||
    message.includes('no volatile fields') ||
    message.includes('is no longer configurable')
  )
}

/**
   * 写入 llm-pi-ai 的 providers。
   *
   * 加载初期可能会和 profile 上的其它写入撞车（插件管理器安装/启用插件时会重写
   * profile 补丁与 package.json），表现为 mutate 抛错。写入本身是原子的，失败
   * 时什么都没落盘，所以退避重试是安全的 —— 这能把「首次自动同步偶发失败」变成
   * 正常成功。
   *
   * @returns 最后一次的错误；成功返回 undefined。
   */
  async function writeProviders(service, targetEntry, ops) {
    let lastError
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await service.mutate(targetEntry, ops, undefined)
        return undefined
      } catch (error) {
        lastError = error
        if (isPermanentWriteError(error)) return lastError
        log.warn(`[cc-switch] 写入 ${targetEntry} 第 ${attempt + 1} 次失败，准备重试：${error?.message || error}`)
        await delay(200 * (attempt + 1))
      }
    }
    return lastError
  }

  /** 串行化的同步入口：同一时刻只跑一次，后来的排队。
   * 返回本次调用自己的汇报（不会拿到别人那次的结果）。
   */
  function sync(options = {}) {
    const run = runtime.chain.then(async () => {
      try {
        return await runOnce(options)
      } catch (error) {
        log.error(`[cc-switch] 同步失败：${error?.stack || error}`)
        return {
          ok: false,
          reason: options.reason ?? 'manual',
          source: 'error',
          appTypes: [],
          providers: { total: 0, selected: 0, imported: 0, skipped: 0 },
          routes: { add: [], update: [], remove: [], unchanged: [], conflicts: [], total: 0, detail: {} },
          credentials: { written: 0, removed: 0, skipped: [] },
          skipped: [],
          warnings: [],
          message: `同步失败：${error?.message || error}`,
        }
      }
    })
    runtime.chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  // ── 自动同步：加载后一次 + 数据库变化时 ─────────────────────────────────

  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings', 'credentials'], (scope) => {
      scope.effect(() => {
        const cfg = current()
        if (!cfg.enabled) return () => {}
        const timers = []
        if (cfg.syncOnLoad) {
          timers.push(setTimeout(() => {
            void sync({ reason: 'load' }).then((report) => {
              if (report?.message) log.info(`[cc-switch] ${report.message}`)
              for (const warning of report?.warnings ?? []) log.warn(`[cc-switch] ${warning}`)
            })
          }, cfg.loadDelayMs))
        }
        const watchSeconds = cfg.watchSeconds
        if (Number.isFinite(watchSeconds) && watchSeconds > 0) {
          const watchPath = cfg.dbPath !== '' ? cfg.dbPath : resolvePaths({ dbPath: '' }).database
          runtime.lastStamp = databaseStamp(watchPath) ?? 'missing'
          timers.push(setInterval(() => {
            const stamp = databaseStamp(watchPath) ?? 'missing'
            if (stamp === runtime.lastStamp) return
            runtime.lastStamp = stamp
            void sync({ reason: 'watch' }).then((report) => {
              if (report?.message) log.info(`[cc-switch] ${report.message}`)
            })
          }, watchSeconds * 1000))
        }
        return () => {
          for (const timer of timers) {
            clearTimeout(timer)
            clearInterval(timer)
          }
        }
      })
    })
  }

  // ── 工具：让模型/用户能看到状态、手动同步 ──────────────────────────────

  const actions = ['status', 'sync', 'plan', 'probe', 'list', 'skip-list']

  function formatReport(report) {
    const lines = []
    lines.push(report.ok ? '✅ cc-switch 接入状态' : '⚠️ cc-switch 接入状态')
    lines.push(`· 数据源：${report.source}${report.sourcePath ? ` (${report.sourcePath})` : ''}`)
    lines.push(`· 目标条目：${report.targetEntry}（路由前缀 ${report.routePrefix}）`)
    if (report.appTypes?.length) lines.push(`· cc-switch app 类型：${report.appTypes.join(', ')}`)
    if (report.routes) {
      lines.push(
        `· 本次管理路由：${report.routes.total} 条（新增 ${report.routes.add.length}，更新 ${report.routes.update.length}，` +
          `删除 ${report.routes.remove.length}，未变 ${report.routes.unchanged.length}）`,
      )
      for (const key of report.routes.conflicts) lines.push(`  - ⚠ ${key} 与已有配置同名，已按 onConflict 处理`)
      for (const [key, info] of Object.entries(report.routes.detail ?? {})) {
        const models = info.models?.length ? info.models.join(', ') : '(未声明模型)'
        lines.push(`  - ${key} → ${info.protocol} @ ${info.baseURL} [${models}]`)
      }
    }
    if (report.credentials) {
      lines.push(`· 凭据：写入 ${report.credentials.written}，清理 ${report.credentials.removed}${report.credentials.skipped?.length ? `，跳过 ${report.credentials.skipped.length}` : ''}`)
    }
    if (report.plan?.credentials?.length) {
      for (const entry of report.plan.credentials) lines.push(`  - ${entry.ref} = ${entry.key}（${entry.routeKey}）`)
    }
    if (report.skipped?.length) {
      lines.push(`· 未导入 ${report.skipped.length} 家：`)
      for (const entry of report.skipped.slice(0, 20)) lines.push(`  - [${entry.appType}] ${entry.name}：${entry.reason}`)
    }
    for (const warning of report.warnings ?? []) lines.push(`· 提示：${warning}`)
    if (report.message) lines.push('', report.message)
    return lines.join('\n')
  }

  function listReport(report) {
    const lines = [`cc-switch 供应商（${report.appTypes?.join(', ') || '无'}）：`]
    lines.push(`共 ${report.providers?.total ?? 0} 家，准备导入 ${report.providers?.imported ?? 0} 家`)
    for (const [key, info] of Object.entries(report.routes?.detail ?? {})) {
      const models = info.models ?? []
      lines.push(`· [${info.appType}] ${info.name} → ${key}`)
      lines.push(`    ${info.protocol} @ ${info.baseURL}`)
      lines.push(`    模型(${models.length})：${models.slice(0, 12).join(', ')}${models.length > 12 ? ` … 还有 ${models.length - 12} 个` : ''}`)
    }
    if (report.skipped?.length) {
      lines.push('', `未导入（${report.skipped.length}）：`)
      for (const entry of report.skipped) lines.push(`· [${entry.appType}] ${entry.name}：${entry.reason}`)
    }
    return lines.join('\n')
  }

  const toolDefinition = {
    name: typeof config.toolName === 'string' && config.toolName.trim() !== '' ? config.toolName.trim() : 'cc_switch',
    description:
      '接入 cc-switch 的模型供应商：读取 cc-switch（~/.cc-switch/cc-switch.db）里配置的 Claude / Codex / OpenClaw / MCode / Pi 等供应商，' +
      '转换成 DeepSeek Harness 的 llm-pi-ai 路由并写入模型列表，同时把 API Key 存进凭据存储。' +
      'action=status 看现状，action=sync 立即同步，action=plan 只预演，action=probe 实测每条路由通不通/快不快，' +
      'action=list 列出识别到的供应商与模型，action=skip-list 只看没导入的原因。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: actions,
          description: 'status(默认)=状态；sync=立即同步；plan=预演不写入；probe=实测每条路由通不通/快不快；list=列出供应商；skip-list=只看未导入原因',
        },
        app_types: {
          type: 'string',
          description: `本次要导入的 app 类型（逗号分隔），留空用插件配置。可选：${KNOWN_APP_TYPES.join(', ')}`,
        },
        include: { type: 'string', description: '本次只导入名称/ID 命中这些关键字的供应商（逗号分隔）' },
        exclude: { type: 'string', description: '本次排除名称/ID 命中这些关键字的供应商（逗号分隔）' },
        dry_run: { type: 'boolean', description: 'true=只预演不写入（action=sync 时有效）' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
          ok: { type: 'boolean' },
          source: { type: 'string' },
          routes: { type: 'number' },
          imported: { type: 'number' },
          skipped: { type: 'number' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text ?? '' }],
    },
    // 体检会真打一次上游请求，慢的中转端点可能要等一分多钟，所以放宽到 10 分钟
    timeoutMs: 600000,
    isConcurrencySafe: () => false,
    presentCall: (args) => ({
      card: 'generic',
      title: toolDefinition.name,
      kind: 'call',
      rawInput: args,
    }),
    async execute(args = {}) {
      const action = typeof args.action === 'string' && actions.includes(args.action) ? args.action : 'status'
      const selection = {}
      if (typeof args.app_types === 'string' && args.app_types.trim() !== '') selection.appTypes = parseList(args.app_types)
      if (typeof args.include === 'string' && args.include.trim() !== '') selection.include = args.include
      if (typeof args.exclude === 'string' && args.exclude.trim() !== '') selection.exclude = args.exclude
      if (action === 'probe') {
        // 体检只读，不走同步链路：不写配置、不写凭据
        const probed = await probeOnce({ selection })
        return {
          text: probed.text,
          ok: probed.ok === true,
          source: String(probed.source ?? ''),
          routes: probed.results.length,
          imported: 0,
          skipped: 0,
        }
      }
      const dryRun = action === 'plan' || args.dry_run === true
      const report = await sync({ reason: `tool:${action}`, dryRun, selection })
      let text
      if (action === 'list') text = listReport(report)
      else if (action === 'skip-list') {
        text = (report.skipped ?? []).length
          ? `未导入的供应商：\n${report.skipped.map((entry) => `· [${entry.appType}] ${entry.name}：${entry.reason}`).join('\n')}`
          : '没有未导入的供应商：cc-switch 里能直连的供应商都已接入。'
      } else text = formatReport(report)
      return {
        text,
        ok: report.ok === true,
        source: String(report.source ?? ''),
        routes: report.routes?.total ?? 0,
        imported: report.providers?.imported ?? 0,
        skipped: report.providers?.skipped ?? 0,
      }
    },
  }

  try {
    ctx.tools.register(toolDefinition)
    log.debug(`已注册工具 ${toolDefinition.name}`)
  } catch (error) {
    log.error(`[cc-switch] 工具注册失败：${error?.message || error}`)
  }
}

/** 供测试与自检使用。 */
export const __internal = {
  DEFAULT_APP_TYPES,
  SUPPORTED_PROTOCOLS,
  maskKey,
  parseList,
  selectRecords,
  ownedRoutesIn,
  formatReportSource: 'cc-switch',
}