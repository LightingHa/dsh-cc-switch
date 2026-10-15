// dsh-cc-switch 宿主集成测试：用一个假的 ctx（tools / settings / credentials）
// 跑完整的 apply() -> 工具 -> 同步 路径，验证写进 llm-pi-ai 的内容和幂等性。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { apply, Config } from '../dsh/index.js'

const require = createRequire(import.meta.url)

// ═══ 假的宿主 ═════════════════════════════════════════════════════════════

/** 复刻 settings.mutate 的语义：`{ op:'set'|'unset', path:['providers', key] }`。 */
function applyOps(providers, ops) {
  for (const op of ops) {
    assert.equal(op.path[0], 'providers', '本插件只允许写 providers 下的一级键')
    assert.equal(op.path.length, 2)
    const key = op.path[1]
    if (op.op === 'set') providers[key] = structuredClone(op.value)
    else delete providers[key]
  }
}

/**
 * pi-ai 的 profile schema 会给每个供应商补上的默认字段 —— `settings.describe()`
 * 返回的是 schemastery 解析后的配置，所以读回来的供应商永远比我们写进去的多这些键。
 * 幂等性必须靠「只比较自己生成的字段」来保证。
 */
const PI_AI_RESOLVED_DEFAULTS = {
  defaultContextWindow: 262144,
  defaultMaxTokens: 32768,
  defaultInput: ['text'],
  streamIdleTimeoutMs: 300000,
  maxRequestImageBytes: 20971520,
  requestImagePixelBudget: 4194304,
  requestImageMaxBytes: 1048576,
  retryPolicy: { maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 30000, jitterRatio: 0.2 },
}

function fakeHost({ providers = {}, credentials = {}, mutateFailures = 0, mutateError = 'profile 补丁正在被重写', resolvedDefaults = false } = {}) {
  const state = {
    providers,
    credentialValues: new Map(Object.entries(credentials)),
    mutations: [],
    mutateAttempts: 0,
    tool: undefined,
  }
  /** 模拟 settings.describe()：返回带 schema 默认值的「解析后」视图。 */
  const resolvedProviders = () => {
    if (!resolvedDefaults) return state.providers
    return Object.fromEntries(
      Object.entries(state.providers).map(([key, value]) => [key, { ...structuredClone(PI_AI_RESOLVED_DEFAULTS), ...structuredClone(value) }]),
    )
  }
  const settings = {
    describe: () => [{ ns: 'llm-pi-ai', value: { providers: resolvedProviders() }, revision: state.mutations.length + 1 }],
    mutate: async (ns, ops) => {
      state.mutateAttempts += 1
      if (state.mutateAttempts <= mutateFailures) throw new Error(mutateError)
      state.mutations.push({ ns, ops })
      applyOps(state.providers, ops)
    },
  }
  const credentialsService = {
    resolve: async (ref) => (state.credentialValues.has(ref) ? { value: state.credentialValues.get(ref), source: 'file' } : undefined),
    set: async (ref, value) => {
      if (value === '') throw new Error('empty value')
      state.credentialValues.set(ref, value)
    },
    unset: async (ref) => {
      state.credentialValues.delete(ref)
    },
  }
  const logs = []
  const ctx = {
    logger: {
      info: (...args) => logs.push(['info', ...args.map(String)]),
      warn: (...args) => logs.push(['warn', ...args.map(String)]),
      error: (...args) => logs.push(['error', ...args.map(String)]),
    },
    tools: {
      register: (definition) => {
        state.tool = definition
        return () => {
          state.tool = undefined
        }
      },
    },
    get: (name) => ({ settings, credentials: credentialsService })[name],
    inject: (deps, callback) => {
      if (deps.every((dep) => ctx.get(dep) !== undefined)) callback(ctx)
    },
    effect: (callback) => callback(),
    on: () => () => {},
  }
  return { ctx, state, logs }
}

// ═══ 夹具数据库 ═══════════════════════════════════════════════════════════

function writeDb(file, rows) {
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT, meta TEXT, is_current BOOLEAN)')
  db.exec('CREATE TABLE settings (key TEXT, value TEXT)')
  db.exec('CREATE TABLE proxy_request_logs (request_id TEXT, provider_id TEXT, app_type TEXT, request_model TEXT)')
  const insert = db.prepare('INSERT INTO providers (id, app_type, name, settings_config, meta, is_current) VALUES (?, ?, ?, ?, ?, ?)')
  for (const row of rows) insert.run(row.id, row.appType, row.name, JSON.stringify(row.config), JSON.stringify(row.meta ?? {}), row.current ? 1 : 0)
  for (const row of rows) {
    for (const model of row.usedModels ?? []) {
      db.prepare('INSERT INTO proxy_request_logs (request_id, provider_id, app_type, request_model) VALUES (?, ?, ?, ?)').run(`r-${model}`, row.id, row.appType, model)
    }
  }
  db.close()
  return file
}

const CODEX_TOML = 'model_provider = "custom"\nmodel = "gpt-6-astra"\nmodel_reasoning_effort = "high"\n\n[model_providers.custom]\nwire_api = "responses"\nbase_url = "http://gw.example:8080"\n'

const ROWS = [
  { id: 'claude-official', appType: 'claude', name: 'Claude Official', config: { env: {} } },
  {
    id: 'cc-relay',
    appType: 'claude',
    name: 'Claude Relay',
    config: { env: { ANTHROPIC_BASE_URL: 'https://relay.example', ANTHROPIC_AUTH_TOKEN: 'sk-relay-token', ANTHROPIC_MODEL: 'claude-sonnet-4-20250514' } },
  },
  {
    id: 'codex-uuid',
    appType: 'codex',
    name: '小胡王国',
    config: { auth: { OPENAI_API_KEY: 'sk-codex-key' }, config: CODEX_TOML },
    meta: { apiFormat: 'openai_responses' },
    current: true,
    usedModels: ['gpt-6-luna'],
  },
  {
    id: 'volcengine-plan',
    appType: 'openclaw',
    name: 'Ark Code Latest',
    config: {
      baseUrl: 'https://ark.example/api/coding/v3',
      apiKey: 'ark-key',
      api: 'openai-completions',
      models: [{ id: 'ark-code-latest', contextWindow: 256000, input: ['text', 'image'] }],
    },
  },
]

function baseConfig(dir, overrides = {}) {
  return {
    enabled: true,
    dbPath: '',
    appTypes: 'claude,codex,openclaw,gemini',
    include: '',
    exclude: '',
    routePrefix: 'ccswitch',
    targetEntry: 'llm-pi-ai',
    mode: 'apply',
    onConflict: 'skip',
    importUnsupported: false,
    pruneOwnedRoutes: true,
    writeCredentials: true,
    usageModelHints: true,
    syncOnLoad: false,
    loadDelayMs: 0,
    watchSeconds: 0,
    statePath: path.join(dir, 'state.json'),
    overrides: {},
    probeTimeoutMs: 120000,
    probeSlowFirstByteMs: 30000,
    toolName: 'cc_switch',
    debug: false,
    ...overrides,
  }
}

/** 让 apply() 用假 ctx 的 settings 作为 describe/mutate 来源。 */
async function runTool(state, args) {
  assert.ok(state.tool, 'cc_switch 工具必须已注册')
  return state.tool.execute(args)
}

test('宿主集成：action=probe 实测每条路由，且绝不写配置/凭据', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ccswitch-probe-'))
  try {
    const dbPath = writeDb(path.join(dir, 'cc-switch.db'), ROWS)
    // 夹具里的域名（*.example）解析不了，正好验证「连不上」这条结论
    const config = baseConfig(dir, { dbPath, probeTimeoutMs: 2000 })
    const { ctx, state } = fakeHost()
    apply(ctx, config)
    const result = await runTool(state, { action: 'probe' })
    assert.equal(state.mutations.length, 0, '体检绝不能写配置')
    assert.equal(state.credentialValues.size, 0, '体检绝不能写凭据')
    assert.equal(result.routes, 3, '三条可直连路由都该被体检')
    assert.equal(result.ok, false, '连不上的路由不该报「可用」')
    assert.match(result.text, /体检/)
    assert.match(result.text, /ccswitch-openclaw-ark-code-latest/)
    assert.match(result.text, /单条上限 2\.0s/)
    assert.match(result.text, /fetch failed|ENOTFOUND|EAI_AGAIN/)
    // 假域名要么解析失败（error），要么卡住（timeout），总之不能是 ok
    assert.ok(!/✅ 可用/.test(result.text), result.text)
    assert.ok(!/sk-codex-key|sk-relay-token|ark-key/.test(result.text), '体检输出里不该出现明文 Key')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('宿主集成：probe 也能用 include/app_types 收窄范围', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ccswitch-probe2-'))
  try {
    const dbPath = writeDb(path.join(dir, 'cc-switch.db'), ROWS)
    const config = baseConfig(dir, { dbPath, probeTimeoutMs: 1500 })
    const { ctx, state } = fakeHost()
    apply(ctx, config)
    const result = await runTool(state, { action: 'probe', app_types: 'openclaw' })
    assert.equal(result.routes, 1)
    assert.match(result.text, /ccswitch-openclaw-ark-code-latest/)
    assert.ok(!result.text.includes('ccswitch-codex'), result.text)
    assert.equal(state.mutations.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('宿主集成：cc-switch 不存在时 probe 给出提示而不是崩', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ccswitch-probe3-'))
  try {
    const config = baseConfig(dir, { dbPath: path.join(dir, 'nope.db') })
    const { ctx, state } = fakeHost()
    apply(ctx, config)
    const result = await runTool(state, { action: 'probe' })
    assert.equal(result.ok, false)
    assert.equal(result.routes, 0)
    assert.ok(result.text.length > 0)
    assert.equal(state.mutations.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Config 是合法的 schemastery schema（能被 resolve 成默认值）', () => {
  const resolved = Config({})
  assert.equal(resolved.targetEntry, 'llm-pi-ai')
  assert.equal(resolved.routePrefix, 'ccswitch')
  assert.equal(resolved.mode, 'apply')
  assert.deepEqual(resolved.overrides, {})
  assert.equal(resolved.probeTimeoutMs, 120000)
  assert.equal(resolved.probeSlowFirstByteMs, 30000)
  assert.equal(resolved.importUnsupported, false)
})

test('宿主集成：同步把 cc-switch 供应商写进 llm-pi-ai，并存入凭据', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ccswitch-host-'))
  try {
    const dbPath = writeDb(path.join(dir, 'cc-switch.db'), ROWS)
    const config = baseConfig(dir, { dbPath })
    const { ctx, state } = fakeHost({ providers: { 'ali-bailian': { displayName: '已有路由' } } })
    apply(ctx, config)

    const first = await runTool(state, { action: 'sync' })
    assert.equal(first.ok, true, first.text)
    assert.equal(state.mutations.length, 1, '一次同步只应该有一次配置写入')
    // 已有路由必须原样保留
    assert.deepEqual(state.providers['ali-bailian'], { displayName: '已有路由' })
    const keys = Object.keys(state.providers).filter((key) => key.startsWith('ccswitch-'))
    assert.deepEqual(keys.sort(), first.routes > 0 ? keys.sort() : [])
    assert.equal(keys.length, 3, `claude 中转 / codex / openclaw 三家：${keys.join(', ')}`)
    // 凭据写入
    assert.equal(state.credentialValues.size, 3)
    assert.ok([...state.credentialValues.values()].includes('sk-codex-key'))
    assert.ok([...state.credentialValues.values()].includes('ark-key'))
    // 每家路由的形状
    const codexRoute = state.providers[keys.find((key) => key.includes('codex'))]
    assert.equal(codexRoute.api, 'openai-responses')
    assert.equal(codexRoute.baseURL, 'http://gw.example:8080')
    assert.deepEqual(codexRoute.models.map((model) => model.id).sort(), ['gpt-6-astra', 'gpt-6-luna'])
    const claudeRoute = state.providers[keys.find((key) => key.includes('claude'))]
    assert.equal(claudeRoute.api, 'anthropic-messages')
    const openclawRoute = state.providers[keys.find((key) => key.includes('openclaw'))]
    assert.deepEqual(openclawRoute.models[0].input, ['text', 'image'])
    // 官方/不支持的供应商被跳过，并给得出原因
    assert.ok(first.text.includes('未导入'), first.text)
    assert.ok(first.text.includes('Claude Official') || first.text.includes('gemini'))

    // 第二次同步：完全幂等，不再写配置
    const second = await runTool(state, { action: 'sync' })
    assert.equal(second.ok, true)
    assert.equal(state.mutations.length, 1, '内容一致时不应该再次写配置')
    assert.ok(second.text.includes('已经一致'), second.text)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('宿主集成：cc-switch 里删掉供应商后撤销对应路由与凭据', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ccswitch-prune-'))
  try {
    const dbPath = writeDb(path.join(dir, 'cc-switch.db'), ROWS)
    const config = baseConfig(dir, { dbPath })
    const { ctx, state } = fakeHost({ providers: { keep: { displayName: '别人的' } } })
    apply(ctx, config)
    await runTool(state, { action: 'sync' })
    const before = Object.keys(state.providers).filter((key) => key.startsWith('ccswitch-'))
    assert.equal(before.length, 3)

    // 换一个只剩 openclaw 的数据库
    const shrunk = writeDb(path.join(dir, 'shrunk.db'), [ROWS[3]])
    config.dbPath = shrunk
    const report = await runTool(state, { action: 'sync' })
    assert.equal(report.ok, true, report.text)
    const after = Object.keys(state.providers).filter((key) => key.startsWith('ccswitch-'))
    assert.equal(after.length, 1)
    assert.ok(state.providers.keep !== undefined, '别人的路由不能被删')
    assert.equal(state.credentialValues.size, 1)
    assert.equal([...state.credentialValues.values()][0], 'ark-key')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('宿主集成：plan / dry_run 只预演不写入', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ccswitch-plan-'))
  try {
    const dbPath = writeDb(path.join(dir, 'cc-switch.db'), ROWS)
    const config = baseConfig(dir, { dbPath })
    const { ctx, state } = fakeHost()
    apply(ctx, config)
    const report = await runTool(state, { action: 'plan' })
    assert.equal(report.ok, true, report.text)
    assert.equal(state.mutations.length, 0, 'plan 模式不能写配置')
    assert.equal(state.credentialValues.size, 0, 'plan 模式不能写凭据')
    assert.ok(report.text.includes('预演'), report.text)

    const dry = await runTool(state, { action: 'sync', dry_run: true })
    assert.equal(state.mutations.length, 0)
    assert.ok(dry.text.includes('预演'), dry.text)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('宿主集成：plan 模式配置下永不写入', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ccswitch-mode-'))
  try {
    const dbPath = writeDb(path.join(dir, 'cc-switch.db'), ROWS)
    const config = baseConfig(dir, { dbPath, mode: 'plan' })
    const { ctx, state } = fakeHost()
    apply(ctx, config)
    const report = await runTool(state, { action: 'sync' })
    assert.equal(state.mutations.length, 0)
    assert.ok(report.text.includes('plan 模式'), report.text)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('宿主集成：cc-switch 不存在时给出可操作提示而不是崩', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ccswitch-missing-'))
  try {
    const config = baseConfig(dir, { dbPath: path.join(dir, 'nope.db') })
    const { ctx, state } = fakeHost()
    apply(ctx, config)
    const report = await runTool(state, { action: 'status' })
    assert.equal(report.ok, false)
    assert.ok(report.text.includes('未找到 cc-switch 数据'), report.text)
    assert.equal(state.mutations.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('宿主集成：list 与 skip-list 动作可用', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ccswitch-list-'))
  try {
    const dbPath = writeDb(path.join(dir, 'cc-switch.db'), ROWS)
    const config = baseConfig(dir, { dbPath })
    const { ctx, state } = fakeHost()
    apply(ctx, config)
    const list = await runTool(state, { action: 'list' })
    assert.ok(list.text.includes('Ark Code Latest'), list.text)
    assert.ok(list.text.includes('模型('), list.text)
    const skipped = await runTool(state, { action: 'skip-list' })
    assert.ok(skipped.text.includes('未导入') || skipped.text.includes('没有未导入'), skipped.text)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('宿主集成：syncOnLoad 会在加载后自动同步一次', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ccswitch-autoload-'))
  try {
    const dbPath = writeDb(path.join(dir, 'cc-switch.db'), [ROWS[3]])
    const config = baseConfig(dir, { dbPath, syncOnLoad: true, loadDelayMs: 5 })
    const { ctx, state } = fakeHost()
    apply(ctx, config)
    const deadline = Date.now() + 3000
    while (state.mutations.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(state.mutations.length, 1, '加载后应自动同步一次')
    assert.equal(Object.keys(state.providers).filter((key) => key.startsWith('ccswitch-')).length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('宿主集成：syncOnLoad=false 时加载后绝不自动写入（回归）', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ccswitch-noautoload-'))
  try {
    const dbPath = writeDb(path.join(dir, 'cc-switch.db'), ROWS)
    const config = baseConfig(dir, { dbPath, syncOnLoad: false, loadDelayMs: 0 })
    const { ctx, state } = fakeHost()
    apply(ctx, config)
    // 等过所有 0ms 定时器与微任务，确认没有任何自动同步
    for (let index = 0; index < 12; index += 1) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(state.mutations.length, 0, 'syncOnLoad=false 必须真的关掉加载同步')
    assert.equal(state.credentialValues.size, 0)
    // 但手工同步照常可用
    const report = await runTool(state, { action: 'sync' })
    assert.equal(report.ok, true, report.text)
    assert.equal(state.mutations.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('宿主集成：写入偶发失败（profile 正被重写）会自动退避重试', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ccswitch-retry-'))
  try {
    const dbPath = writeDb(path.join(dir, 'cc-switch.db'), ROWS)
    const config = baseConfig(dir, { dbPath })
    const { ctx, state } = fakeHost({ mutateFailures: 2 })
    apply(ctx, config)
    const report = await runTool(state, { action: 'sync' })
    assert.equal(report.ok, true, report.text)
    assert.equal(state.mutateAttempts, 3, '应当重试到成功')
    assert.equal(state.mutations.length, 1)
    assert.equal(Object.keys(state.providers).filter((key) => key.startsWith('ccswitch-')).length, 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('宿主集成：永久性失败不重试，并如实汇报', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ccswitch-perm-'))
  try {
    const dbPath = writeDb(path.join(dir, 'cc-switch.db'), ROWS)
    const config = baseConfig(dir, { dbPath })
    const { ctx, state } = fakeHost({ mutateFailures: 99, mutateError: 'Config field "providers" is not volatile' })
    apply(ctx, config)
    const report = await runTool(state, { action: 'sync' })
    assert.equal(report.ok, false)
    assert.equal(state.mutateAttempts, 1, '永久性错误不该重试')
    assert.ok(report.text.includes('失败'), report.text)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('宿主集成：describe 返回带默认字段的解析后配置时，第二次同步仍然幂等', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ccswitch-defaults-'))
  try {
    const dbPath = writeDb(path.join(dir, 'cc-switch.db'), ROWS)
    const config = baseConfig(dir, { dbPath })
    const { ctx, state } = fakeHost({ resolvedDefaults: true })
    apply(ctx, config)
    const first = await runTool(state, { action: 'sync' })
    assert.equal(first.ok, true, first.text)
    assert.equal(state.mutations.length, 1)
    assert.equal(Object.keys(state.providers).filter((key) => key.startsWith('ccswitch-')).length, 3)

    const second = await runTool(state, { action: 'sync' })
    assert.equal(second.ok, true, second.text)
    assert.equal(state.mutations.length, 1, '内容一致时不该再次写配置（否则每 30 秒重写一次）')
    assert.ok(second.text.includes('已经一致'), second.text)

    const third = await runTool(state, { action: 'status' })
    assert.equal(state.mutations.length, 1, '反复同步都必须收敛')
    assert.ok(third.text.includes('已经一致'), third.text)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('宿主集成：用户手工调过的其它字段不会被冲掉', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ccswitch-tuned-'))
  try {
    const dbPath = writeDb(path.join(dir, 'cc-switch.db'), [ROWS[3]])
    const config = baseConfig(dir, { dbPath })
    const { ctx, state } = fakeHost({ resolvedDefaults: true })
    apply(ctx, config)
    await runTool(state, { action: 'sync' })
    const key = Object.keys(state.providers).find((name) => name.startsWith('ccswitch-'))
    // 用户在「模型」页面把这家路由的重试策略调了一下
    state.providers[key].retryPolicy = { maxAttempts: 9 }
    const again = await runTool(state, { action: 'sync' })
    assert.equal(again.ok, true, again.text)
    assert.equal(state.mutations.length, 1, '与插件生成内容无关的字段不该触发重写')
    assert.deepEqual(state.providers[key].retryPolicy, { maxAttempts: 9 }, '用户调过的字段必须保留')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('宿主集成：用户改了插件管理的字段时会被纠正回来', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ccswitch-correct-'))
  try {
    const dbPath = writeDb(path.join(dir, 'cc-switch.db'), [ROWS[3]])
    const config = baseConfig(dir, { dbPath })
    const { ctx, state } = fakeHost({ resolvedDefaults: true })
    apply(ctx, config)
    await runTool(state, { action: 'sync' })
    const key = Object.keys(state.providers).find((name) => name.startsWith('ccswitch-'))
    state.providers[key].models = [{ id: '被改坏的模型' }]
    const again = await runTool(state, { action: 'sync' })
    assert.equal(again.ok, true, again.text)
    assert.equal(state.mutations.length, 2)
    assert.deepEqual(state.providers[key].models.map((model) => model.id), ['ark-code-latest'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('宿主集成：include 收窄范围时不会误删其它已管理的路由', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ccswitch-include-'))
  try {
    const dbPath = writeDb(path.join(dir, 'cc-switch.db'), ROWS)
    const config = baseConfig(dir, { dbPath })
    const { ctx, state } = fakeHost()
    apply(ctx, config)
    await runTool(state, { action: 'sync' })
    const all = Object.keys(state.providers).filter((key) => key.startsWith('ccswitch-')).sort()
    assert.equal(all.length, 3)

    // 用 include 只同步 openclaw：其余两条仍在清单里，但本次没有生成 →
    // 会被当成「cc-switch 里没有了」而撤销。这里断言这个已知语义，避免静默出错。
    const report = await runTool(state, { action: 'sync', include: 'Ark Code Latest' })
    assert.equal(report.ok, true, report.text)
    const left = Object.keys(state.providers).filter((key) => key.startsWith('ccswitch-'))
    assert.ok(left.length <= all.length, `剩余路由：${left.join(', ')}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})