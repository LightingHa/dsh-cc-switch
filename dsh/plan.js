/**
 * 同步计划：把「cc-switch 里有什么」变成「要往 llm-pi-ai 写什么」。
 *
 * 纯函数，不碰 IO、不碰 ctx —— 方便单测，也让 `plan` 模式能安全地只做预演。
 *
 * 所有权模型：插件只管理「自己上一次写进去的那些路由键」（记录在清单文件里）。
 * 因此：
 *   - 别人（用户手写、其它插件）加进 llm-pi-ai 的供应商绝不会被删掉；
 *   - 路由键撞车时默认跳过并报警，而不是覆盖。
 */

import { convertRecord } from './convert.js'

/** 是否为本插件生成的路由键。 */
export function isOwnedKey(key, prefix = 'ccswitch') {
  return typeof key === 'string' && key.startsWith(`${prefix}-`)
}

/** 深比较（只用于普通 JSON 数据）。 */
export function sameJson(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false
    return a.every((item, index) => sameJson(item, b[index]))
  }
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((key) => Object.hasOwn(b, key) && sameJson(a[key], b[key]))
}

/**
 * 构造同步计划。
 * @param options.records - cc-switch 归一化记录。
 * @param options.config - 插件配置（prefix/targetEntry/过滤/覆盖）。
 * @param options.currentProviders - 目标条目当前的 providers 字典。
 * @param options.manifest - 上一次同步的清单 `{ routes: [], credentials: [] }`。
 * @param options.credentialState - `{ [ref]: { value, source } }` 当前凭据解析结果。
 * @returns 计划对象。
 */
export function buildPlan({
  records = [],
  config = {},
  currentProviders = {},
  manifest = { routes: [], credentials: [] },
  credentialState = {},
} = {}) {
  const prefix = config.routePrefix ?? 'ccswitch'
  const overrides = config.overrides ?? {}
  const ownedLast = new Set(Array.isArray(manifest.routes) ? manifest.routes : [])
  const ownedCredentialsLast = new Set(Array.isArray(manifest.credentials) ? manifest.credentials : [])
  const onConflict = config.onConflict === 'overwrite' ? 'overwrite' : 'skip'
  const skipUnsupported = config.importUnsupported !== true

  const routes = {}
  const credentials = []
  const credentialValues = {}
  const skipped = []
  const warnings = []
  const conflicts = []
  const add = []
  const update = []
  const unchanged = []
  const sources = {}

  for (const record of records) {
    const { variants, problems } = convertRecord(record, { prefix, overrides })
    const usable = variants.filter((variant) => variant.usable)
    const unusable = variants.filter((variant) => !variant.usable)
    // importUnsupported 打开时，不可用的路由也照样写进去（用户自担风险）
    if (!skipUnsupported) usable.push(...unusable)
    if (usable.length === 0) {
      const reason = [...problems, ...unusable.flatMap((variant) => variant.problems)].join('；') || '没有可导入的路由'
      skipped.push({ appType: record.appType, name: record.name, id: record.id, reason })
      continue
    }
    if (skipUnsupported) {
      for (const variant of unusable) {
        skipped.push({
          appType: record.appType,
          name: record.name,
          id: record.id,
          reason: `${variant.routeKey}：${variant.problems.join('；')}`,
        })
      }
    }
    for (const variant of usable) {
      const { routeKey, profile, apiKey, apiKeyEnv } = variant
      const existing = Object.hasOwn(currentProviders, routeKey) ? currentProviders[routeKey] : undefined
      const owned = ownedLast.has(routeKey)
      if (existing !== undefined && !owned && onConflict === 'skip') {
        conflicts.push(routeKey)
        warnings.push(`路由键 "${routeKey}" 已被 llm-pi-ai 里的其它配置占用，已跳过（如需覆盖请把 onConflict 设为 "overwrite"）`)
        continue
      }
      routes[routeKey] = profile
      sources[routeKey] = { appType: record.appType, name: record.name, id: record.id, protocol: variant.protocol, baseURL: variant.baseURL }
      if (apiKeyEnv !== undefined && typeof apiKey === 'string' && apiKey !== '') {
        credentials.push({ ref: apiKeyEnv, value: apiKey, routeKey })
        credentialValues[apiKeyEnv] = apiKey
      }
      if (existing === undefined) add.push(routeKey)
      else if (profileMatches(existing, profile)) unchanged.push(routeKey)
      else update.push(routeKey)
    }
  }

  // 撤销：上一次写过、这次不再生成的路由键
  const remove = []
  if (config.pruneOwnedRoutes !== false) {
    for (const key of ownedLast) {
      if (Object.hasOwn(routes, key)) continue
      if (!Object.hasOwn(currentProviders, key)) continue
      remove.push(key)
    }
  }

  // 凭据写入 / 清理
  const credentialWrites = []
  const credentialSkips = []
  for (const entry of credentials) {
    const state = credentialState[entry.ref]
    if (state !== undefined && state.source === 'env') {
      credentialSkips.push({ ref: entry.ref, reason: '同名凭据由启动环境提供（只读），已跳过写入' })
      continue
    }
    if (state !== undefined && state.value === entry.value) continue
    credentialWrites.push(entry)
  }
  const credentialRemovals = []
  if (config.pruneOwnedRoutes !== false) {
    for (const ref of ownedCredentialsLast) {
      if (Object.hasOwn(credentialValues, ref)) continue
      if (credentialState[ref] === undefined || credentialState[ref].source === 'env') continue
      credentialRemovals.push(ref)
    }
  }

  const changed =
    add.length > 0 || update.length > 0 || remove.length > 0 || credentialWrites.length > 0 || credentialRemovals.length > 0

  return {
    prefix,
    routes,
    sources,
    add,
    update,
    remove,
    unchanged,
    conflicts,
    skipped,
    warnings,
    credentials,
    credentialWrites,
    credentialRemovals,
    credentialSkips,
    managedRoutes: Object.keys(routes).sort(),
    managedCredentials: [...new Set(credentials.map((entry) => entry.ref))].sort(),
    changed,
  }
}

/**
 * 读回来的路由是否已经和我们要写的一致。
 *
 * 这里**必须**用子集比较而不是全等：`settings.describe()` 返回的是 schemastery
 * 解析后的配置，pi-ai 的 profile schema 会给每个供应商补上一堆默认字段
 * （defaultContextWindow / defaultMaxTokens / defaultInput / streamIdleTimeoutMs /
 * retryPolicy …）。全等比较会永远判定「有变化」，于是每轮同步都重写一次配置文件。
 *
 * 只比较本插件自己生成的字段：用户手工调过的其它字段（比如 retryPolicy）
 * 会被保留，而不是被我们冲掉。
 */
export function profileMatches(existing, generated) {
  if (existing === null || typeof existing !== 'object') return false
  for (const [key, value] of Object.entries(generated)) {
    if (!sameJson(existing[key], value)) return false
  }
  return true
}

/**
 * 找出已有配置里与本插件生成内容不一致的字段（诊断用）。
 */
export function profileDiffKeys(existing, generated) {
  if (existing === null || typeof existing !== 'object') return Object.keys(generated)
  return Object.entries(generated)
    .filter(([key, value]) => !sameJson(existing[key], value))
    .map(([key]) => key)
}

/** 供状态汇报：目标条目里属于本插件的路由键。 */
export function ownedRoutesIn(currentProviders = {}, prefix = 'ccswitch', manifest = {}) {
  const known = new Set(Array.isArray(manifest.routes) ? manifest.routes : [])
  return Object.keys(currentProviders)
    .filter((key) => known.has(key) || isOwnedKey(key, prefix))
    .sort()
}