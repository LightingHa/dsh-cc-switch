// dsh-cc-switch 单元测试：只依赖 Node 内置模块（node:test / node:sqlite）。
// 运行：node --test test/
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const require = createRequire(import.meta.url)

import { KNOWN_APP_TYPES, databaseStamp, readProviders, resolvePaths } from '../dsh/ccswitch.js'
import {
  SUPPORTED_PROTOCOLS,
  convertRecord,
  envRefFor,
  normalizeProtocol,
  reasoningEffortsFrom,
  routeKeyFor,
  slugify,
  toModel,
} from '../dsh/convert.js'
import { buildPlan, isOwnedKey, profileDiffKeys, profileMatches, sameJson } from '../dsh/plan.js'
import { PROBEABLE_APIS, formatProbeReport, probeRoute, probeRoutes, probeUrlFor } from '../dsh/probe.js'
import { readState, stateMatches, statePathFor, writeState } from '../dsh/state.js'
import { parseToml } from '../dsh/toml.js'
import { maskKey, parseList, selectRecords } from '../dsh/index.js'

const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

// ═══ TOML ════════════════════════════════════════════════════════════════

const CODEX_TOML = `
model_provider = "custom"
model = "gpt-6-astra"
model_reasoning_effort = "high"
disable_response_storage = true

[model_providers.custom]
name = "custom"
wire_api = "responses"
requires_openai_auth = true
base_url = "http://43.153.140.111:8080"
`

test('toml: 解析 Codex 供应商配置', () => {
  const parsed = parseToml(CODEX_TOML)
  assert.equal(parsed.model, 'gpt-6-astra')
  assert.equal(parsed.model_provider, 'custom')
  assert.equal(parsed.model_reasoning_effort, 'high')
  assert.equal(parsed.disable_response_storage, true)
  assert.equal(parsed.model_providers.custom.wire_api, 'responses')
  assert.equal(parsed.model_providers.custom.base_url, 'http://43.153.140.111:8080')
})

test('toml: 数组可跨行，字符串里的 # 不是注释', () => {
  const parsed = parseToml(`
notify = [ "C:\\\\a\\\\b.exe", "turn-ended" ]

[shell_environment_policy.set]
BROWSER = "chrome,iab" # 真注释
NODE = 'C:\\Users\\x\\.codex'
hash = "a#b"
`)
  assert.deepEqual(parsed.notify, ['C:\\a\\b.exe', 'turn-ended'])
  assert.equal(parsed.shell_environment_policy.set.BROWSER, 'chrome,iab')
  assert.equal(parsed.shell_environment_policy.set.NODE, 'C:\\Users\\x\\.codex')
  assert.equal(parsed.shell_environment_policy.set.hash, 'a#b')
})

test('toml: 数字 / 浮点 / 内联表 / 数组表', () => {
  const parsed = parseToml(`
port = 8080
ratio = 0.75
big = 1_000
inline = { a = 1, b = "x" }

[[plugins]]
name = "one"

[[plugins]]
name = "two"
`)
  assert.equal(parsed.port, 8080)
  assert.equal(parsed.ratio, 0.75)
  assert.equal(parsed.big, 1000)
  assert.deepEqual(parsed.inline, { a: 1, b: 'x' })
  assert.deepEqual(parsed.plugins, [{ name: 'one' }, { name: 'two' }])
})

// ═══ 命名 ════════════════════════════════════════════════════════════════

test('命名：路由键与凭据引用稳定且合法', () => {
  const record = { appType: 'codex', id: 'bbdee472-c0d9-4c6e-903b-7eaafd3f77f9', name: '小胡王国' }
  const key = routeKeyFor(record, 'ccswitch')
  assert.match(key, /^ccswitch-codex-[a-z0-9-]+$/)
  assert.equal(key, routeKeyFor(record, 'ccswitch'), '同一输入必须得到同一路由键')
  assert.ok(key.length < 64, `路由键不该无限长：${key}`)
  const ref = envRefFor(record, 'ccswitch')
  assert.match(ref, REF_PATTERN)
  assert.ok(ref.startsWith('CCSWITCH_'), ref)
})

test('命名：中文名走哈希，ASCII 名走可读 slug', () => {
  assert.equal(slugify('Ark Code Latest'), 'ark-code-latest')
  assert.equal(slugify('小胡王国'), '')
  assert.equal(slugify('a'.repeat(80), 12).length, 12)
  const a = routeKeyFor({ appType: 'codex', id: 'id-a', name: '同一个名字' })
  const b = routeKeyFor({ appType: 'codex', id: 'id-b', name: '同一个名字' })
  assert.notEqual(a, b, '名称相同但 id 不同时必须生成不同路由键')
})

test('协议归一化', () => {
  assert.equal(normalizeProtocol('responses'), 'openai-responses')
  assert.equal(normalizeProtocol('openai_responses'), 'openai-responses')
  assert.equal(normalizeProtocol('chat'), 'openai-completions')
  assert.equal(normalizeProtocol('openai-completions'), 'openai-completions')
  assert.equal(normalizeProtocol('anthropic-messages'), 'anthropic-messages')
  assert.equal(normalizeProtocol('@ai-sdk/anthropic'), 'anthropic-messages')
  assert.equal(normalizeProtocol('generateContent'), undefined)
})

test('思考等级展开成 pi-ai 形状', () => {
  assert.deepEqual(reasoningEffortsFrom('high'), { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high' })
  assert.equal(reasoningEffortsFrom('nonsense'), undefined)
})

test('模型字段归一化（含模态与容量）', () => {
  const model = toModel({ id: 'ark-code-latest', name: 'Ark Code Latest', contextWindow: 256000, maxTokens: 32000, input: ['text', 'image'] })
  assert.deepEqual(model, {
    id: 'ark-code-latest',
    name: 'Ark Code Latest',
    contextWindow: 256000,
    maxTokens: 32000,
    input: ['text', 'image'],
  })
  assert.deepEqual(toModel('plain-model'), { id: 'plain-model' })
  assert.equal(toModel({}), undefined)
  assert.deepEqual(toModel({ model: 'gpt-6-astra', reasoning_effort: 'medium' }).reasoningEfforts, {
    off: null,
    minimal: 'minimal',
    low: 'low',
    medium: 'medium',
  })
})

// ═══ 转换：各家 app 类型 ═════════════════════════════════════════════════

function record(appType, config, extra = {}) {
  return { id: extra.id ?? `${appType}-1`, appType, name: extra.name ?? `${appType} 供应商`, config, meta: extra.meta ?? {}, usedModels: extra.usedModels ?? [] }
}

test('claude：env 里的端点/令牌/模型', () => {
  const { convertible, variants } = convertRecord(
    record('claude', {
      env: {
        ANTHROPIC_BASE_URL: 'https://api.example.com',
        ANTHROPIC_AUTH_TOKEN: 'sk-abc123456',
        ANTHROPIC_MODEL: 'claude-sonnet-4-20250514',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4',
      },
    }),
  )
  assert.equal(variants.length, 1)
  assert.equal(convertible.length, 1)
  const [variant] = convertible
  assert.equal(variant.protocol, 'anthropic-messages')
  assert.equal(variant.profile.api, 'anthropic-messages')
  assert.equal(variant.profile.baseURL, 'https://api.example.com')
  assert.equal(variant.profile.apiKeyEnv, envRefFor({ appType: 'claude', id: 'claude-1', name: 'claude 供应商' }))
  assert.deepEqual(variant.profile.models.map((model) => model.id), ['claude-sonnet-4-20250514', 'claude-haiku-4'])
})

test('claude 官方：空 env 被明确跳过而不是生成坏路由', () => {
  const { convertible, variants } = convertRecord(record('claude', { env: {} }, { id: 'claude-official', name: 'Claude Official' }))
  assert.equal(convertible.length, 0)
  assert.equal(variants.length, 1)
  assert.ok(variants[0].problems.some((problem) => problem.includes('base_url')))
})

test('codex：TOML + 使用日志补充模型清单', () => {
  const { convertible } = convertRecord(
    record('codex', { auth: { OPENAI_API_KEY: 'sk-6a49abcdef' }, config: CODEX_TOML }, {
      id: 'bbdee472-c0d9-4c6e-903b-7eaafd3f77f9',
      name: '小胡王国',
      meta: { apiFormat: 'openai_responses' },
      usedModels: ['gpt-6-astra', 'gpt-6-luna', 'gpt-5.6-sol'],
    }),
  )
  assert.equal(convertible.length, 1)
  const [variant] = convertible
  assert.equal(variant.protocol, 'openai-responses')
  assert.equal(variant.profile.baseURL, 'http://43.153.140.111:8080')
  assert.equal(variant.apiKey, 'sk-6a49abcdef')
  assert.deepEqual(variant.profile.models.map((model) => model.id), ['gpt-6-astra', 'gpt-6-luna', 'gpt-5.6-sol'])
  assert.equal(variant.profile.models[0].reasoningEfforts.high, 'high')
})

test('codex：wire_api 缺失时按 Codex 自身缺省的 chat 处理', () => {
  const { convertible } = convertRecord(
    record('codex', {
      auth: { OPENAI_API_KEY: 'k' },
      config: 'model = "gpt-4o"\n\n[model_providers.custom]\nbase_url = "https://gw.example/v1"\n',
    }),
  )
  assert.equal(convertible[0].protocol, 'openai-completions')
})

test('openclaw：与 pi-ai 几乎 1:1', () => {
  const { convertible } = convertRecord(
    record('openclaw', {
      baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
      apiKey: '41fb72a5-1948-4d3a-8991-867bda5dc2a5',
      api: 'openai-completions',
      models: [
        { id: 'ark-code-latest', name: 'Ark Code Latest', contextWindow: 256000, input: ['text', 'image'], maxTokens: 32000 },
        { id: 'glm-4.7', name: 'GLM 4.7', contextWindow: 200000, input: ['text'], maxTokens: 128000 },
      ],
    }, { id: 'volcengine-plan', name: 'Ark Code Latest' }),
  )
  const [variant] = convertible
  assert.equal(variant.protocol, 'openai-completions')
  assert.equal(variant.profile.displayName, 'Ark Code Latest')
  assert.equal(variant.profile.models.length, 2)
  assert.deepEqual(variant.profile.models[0].input, ['text', 'image'])
  assert.equal(variant.profile.models[1].contextWindow, 200000)
})

test('openclaw：整份配置（models.providers）会被展开成多条路由', () => {
  const { convertible } = convertRecord(
    record('openclaw', {
      models: {
        providers: {
          one: { baseUrl: 'https://one.example/v1', apiKey: 'k1', api: 'openai-completions', models: ['m1'] },
          two: { baseUrl: 'https://two.example/v1', apiKey: 'k2', api: 'anthropic-messages', models: ['m2'] },
        },
      },
    }),
  )
  assert.equal(convertible.length, 2)
  assert.equal(new Set(convertible.map((variant) => variant.routeKey)).size, 2)
  assert.equal(convertible[1].protocol, 'anthropic-messages')
})

test('mcode：custom_provider 里的 options 与 api', () => {
  const { convertible } = convertRecord(
    record('mcode', {
      custom_provider: {
        'my-gw': { kind: 'openai', enabled: true, api: 'anthropic-messages', options: { baseURL: 'https://mcode.example/anthropic', apiKey: 'sk-mcode' }, models: [{ id: 'mm-1' }] },
      },
    }),
  )
  assert.equal(convertible.length, 1)
  assert.equal(convertible[0].protocol, 'anthropic-messages')
  assert.equal(convertible[0].profile.baseURL, 'https://mcode.example/anthropic')
  assert.equal(convertible[0].apiKey, 'sk-mcode')
})

test('gemini：原生协议给出可操作的原因；声明了 OpenAI 格式则导入', () => {
  const native = convertRecord(record('gemini', { env: { GEMINI_API_KEY: 'g', GEMINI_MODEL: 'gemini-3-pro', GEMINI_BASE_URL: 'https://generativelanguage.googleapis.com' } }))
  assert.equal(native.convertible.length, 0)
  assert.ok(native.variants[0].problems.some((problem) => problem.includes('Gemini')))

  const compat = convertRecord(record('gemini', { env: { GEMINI_API_KEY: 'g', GEMINI_BASE_URL: 'https://gw.example/v1', GEMINI_MODEL: 'gemini-3-pro' } }, { meta: { apiFormat: 'openai-completions' } }))
  assert.equal(compat.convertible.length, 1)
  assert.equal(compat.convertible[0].protocol, 'openai-completions')
})

test('通用兜底：opencode/hermes 风格配置也能扫出端点、密钥与模型', () => {
  const { convertible } = convertRecord(
    record('opencode', {
      provider: {
        acme: {
          npm: '@ai-sdk/openai-compatible',
          options: { baseURL: 'https://acme.example/v1', apiKey: 'sk-acme' },
          models: { 'acme-think': { name: 'Acme Think' }, 'acme-fast': { name: 'Acme Fast' } },
        },
      },
    }),
  )
  assert.equal(convertible.length, 1)
  const [variant] = convertible
  assert.equal(variant.protocol, 'openai-completions')
  assert.equal(variant.profile.baseURL, 'https://acme.example/v1')
  assert.deepEqual(variant.profile.models.map((model) => model.id).sort(), ['acme-fast', 'acme-think'])
})

test('人工修正 overrides 会合并进路由', () => {
  const base = record('openclaw', { baseUrl: 'https://x.example/v1', apiKey: 'k', api: 'openai-completions', models: ['m'] })
  const key = routeKeyFor(base, 'ccswitch')
  const { convertible } = convertRecord(base, { prefix: 'ccswitch', overrides: { [key]: { models: [{ id: 'm', contextWindow: 999 }, { id: 'extra' }] } } })
  assert.deepEqual(convertible[0].profile.models, [{ id: 'm', contextWindow: 999 }, { id: 'extra' }])
})

// ═══ 严格校验：复刻 llm-pi-ai 写入时的拒绝规则 ═══════════════════════════
// 这些规则来自 pi-ai 的 resolveProfiles()/resolveRouteModels()（strict 模式）
// 与 assertServiceable()：任何一条不满足，整次 settings.mutate 都会失败。

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const MODALITIES = ['text', 'image']

function assertPiAiServable(profile) {
  assert.equal(typeof profile.displayName, 'string')
  assert.ok(profile.displayName.length > 0, 'displayName 不能为空')
  assert.ok(SUPPORTED_PROTOCOLS.includes(profile.api), `api 必须是受支持协议：${profile.api}`)
  assert.ok(profile.baseURL === undefined || profile.baseURL.length > 0, 'baseURL 不能是空串')
  assert.equal('modelOverrides' in profile, false, 'models 与 modelOverrides 不能同时出现')
  assert.ok(Array.isArray(profile.models) && profile.models.length > 0, '必须至少有一个模型')
  const seen = new Set()
  for (const model of profile.models) {
    assert.ok(typeof model.id === 'string' && model.id.length > 0, '模型 id 不能为空')
    assert.ok(!seen.has(model.id), `模型 id 重复：${model.id}`)
    seen.add(model.id)
    assert.ok(model.name === undefined || model.name.length > 0, '模型 name 不能为空串')
    assert.ok(model.contextWindow === undefined || (Number.isInteger(model.contextWindow) && model.contextWindow > 0), `contextWindow 必须是正整数：${model.contextWindow}`)
    assert.ok(model.maxTokens === undefined || (Number.isInteger(model.maxTokens) && model.maxTokens > 0), `maxTokens 必须是正整数：${model.maxTokens}`)
    if (model.input !== undefined) {
      assert.ok(model.input.length > 0, 'input 不能是空数组')
      for (const modality of model.input) assert.ok(MODALITIES.includes(modality), `非法模态：${modality}`)
    }
    if (model.reasoningEfforts !== undefined) {
      const efforts = model.reasoningEfforts
      assert.ok(efforts !== null && Object.keys(efforts).length > 0, 'reasoningEfforts 不能为空')
      let beyondOff = false
      for (const [level, wire] of Object.entries(efforts)) {
        assert.ok(THINKING_LEVELS.includes(level), `非法思考等级：${level}`)
        if (wire === null) assert.equal(level, 'off', `只有 off 可以是 null：${level}`)
        else {
          assert.ok(typeof wire === 'string' && wire.length > 0, `思考等级 ${level} 的取值不能是空串`)
          beyondOff = true
        }
      }
      assert.ok(beyondOff, 'reasoningEfforts 至少要有一个 off 以外的等级')
    }
  }
  if (profile.headers !== undefined) {
    for (const [name, value] of Object.entries(profile.headers)) {
      assert.doesNotThrow(() => new Headers([[name, value]]), `非法请求头：${name}`)
    }
  }
}

test('严格校验：所有真实形状的 cc-switch 供应商都能通过 pi-ai 的写入校验', () => {
  const samples = [
    record('claude', { env: { ANTHROPIC_BASE_URL: 'https://a.example', ANTHROPIC_AUTH_TOKEN: 'k', ANTHROPIC_MODEL: 'claude-sonnet-4-20250514', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4' } }, { meta: { customUserAgent: 'cc-switch/4.0.6' } }),
    record('codex', { auth: { OPENAI_API_KEY: 'k' }, config: CODEX_TOML }, { usedModels: ['gpt-6-astra'] }),
    record('openclaw', { baseUrl: 'https://ark.example/v1', apiKey: 'k', api: 'openai-completions', models: [{ id: 'ark-code-latest', contextWindow: 256000, maxTokens: 32000, input: ['text', 'image'] }] }),
    record('mcode', { custom_provider: { gw: { api: 'anthropic-messages', options: { baseURL: 'https://m.example', apiKey: 'k' }, models: ['m1'] } } }),
    record('opencode', { provider: { acme: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://acme.example/v1', apiKey: 'sk-a' }, models: { 'acme-think': { name: 'Acme Think' } } } } }),
  ]
  let checked = 0
  for (const sample of samples) {
    for (const variant of convertRecord(sample).convertible) {
      assertPiAiServable(variant.profile)
      checked += 1
    }
  }
  assert.ok(checked >= 5, `应当检查到至少 5 条路由，实际 ${checked}`)
})

test('严格校验：cc-switch 里的脏数据（空名字/非法表头/坏容量）不会让写入失败', () => {
  const dirty = {
    id: '',
    appType: 'openclaw',
    name: '', // 空名字：pi-ai 会拒绝 displayName: ""
    config: {
      baseUrl: 'https://dirty.example/v1',
      apiKey: 'k',
      api: 'openai-completions',
      models: [
        { id: 'ok-model', name: '', contextWindow: -5, maxTokens: 0, input: ['text', 'audio'] },
        { id: 'dup-model' },
        { id: 'dup-model' },
      ],
    },
    meta: { requestHeaders: { 'bad header name': 'x', 'X-Good': 'y', 'X-Multiline': 'a\r\nb' }, customUserAgent: 'ua/1' },
    usedModels: [],
  }
  const { convertible } = convertRecord(dirty)
  assert.equal(convertible.length, 1)
  const [variant] = convertible
  assertPiAiServable(variant.profile)
  assert.ok(variant.profile.displayName.length > 0, '空名字必须有兜底')
  assert.equal(variant.profile.models.length, 2, '重复 id 必须去重')
  assert.equal(variant.profile.models[0].contextWindow, undefined, '非法容量必须被丢弃而不是写进去')
  assert.deepEqual(variant.profile.models[0].input, ['text'], '非法模态必须被过滤')
  assert.deepEqual(Object.keys(variant.profile.headers ?? {}), ['User-Agent', 'X-Good'], '非法表头必须被丢弃')
})

test('严格校验：空 displayName / 非法协议的记录被挡在计划外', () => {
  const plan = buildPlan({
    records: [
      { id: 'x', appType: 'openclaw', name: '', config: { baseUrl: 'https://x.example/v1', apiKey: 'k', api: 'openai-completions', models: [] }, meta: {}, usedModels: [] },
    ],
    config: PLUGIN_CONFIG,
    currentProviders: {},
    manifest: { routes: [], credentials: [] },
  })
  assert.deepEqual(plan.managedRoutes, [], '空模型清单必须跳过')
  assert.equal(plan.changed, false)
})

test('所有生成的路由都符合当前版本支持的协议集合', () => {
  const samples = [
    record('claude', { env: { ANTHROPIC_BASE_URL: 'https://a.example', ANTHROPIC_API_KEY: 'k', ANTHROPIC_MODEL: 'm' } }),
    record('codex', { auth: { OPENAI_API_KEY: 'k' }, config: CODEX_TOML }),
    record('openclaw', { baseUrl: 'https://b.example/v1', apiKey: 'k', api: 'openai-completions', models: ['m'] }),
  ]
  for (const sample of samples) {
    for (const variant of convertRecord(sample).convertible) {
      assert.ok(SUPPORTED_PROTOCOLS.includes(variant.profile.api), variant.profile.api)
    }
  }
})

// ═══ 计划 ════════════════════════════════════════════════════════════════

const PLUGIN_CONFIG = { routePrefix: 'ccswitch', onConflict: 'skip', pruneOwnedRoutes: true, importUnsupported: false }

function openclawRecord(id, name, url = `https://${id}.example/v1`) {
  return record('openclaw', { baseUrl: url, apiKey: `key-${id}`, api: 'openai-completions', models: ['m-1'] }, { id, name })
}

test('计划：首次同步是纯新增', () => {
  const plan = buildPlan({ records: [openclawRecord('a', 'A')], config: PLUGIN_CONFIG, currentProviders: {}, manifest: { routes: [], credentials: [] } })
  assert.equal(plan.add.length, 1)
  assert.equal(plan.update.length, 0)
  assert.equal(plan.remove.length, 0)
  assert.equal(plan.credentials.length, 1)
  assert.equal(plan.changed, true)
  assert.ok(isOwnedKey(plan.managedRoutes[0], 'ccswitch'))
})

test('计划：内容相同则完全不动（幂等）', () => {
  const first = buildPlan({ records: [openclawRecord('a', 'A')], config: PLUGIN_CONFIG, currentProviders: {}, manifest: { routes: [], credentials: [] } })
  const second = buildPlan({
    records: [openclawRecord('a', 'A')],
    config: PLUGIN_CONFIG,
    currentProviders: first.routes,
    manifest: { routes: first.managedRoutes, credentials: first.managedCredentials },
    credentialState: Object.fromEntries(first.credentials.map((entry) => [entry.ref, { value: entry.value, source: 'file' }])),
  })
  assert.equal(second.changed, false)
  assert.equal(second.add.length, 0)
  assert.equal(second.update.length, 0)
})

test('计划：供应商被删除后撤销自己写过的路由，但绝不碰别人的', () => {
  const first = buildPlan({ records: [openclawRecord('a', 'A')], config: PLUGIN_CONFIG, currentProviders: {}, manifest: { routes: [], credentials: [] } })
  const currentProviders = { ...first.routes, 'ali-bailian': { displayName: '别人的路由' } }
  const plan = buildPlan({
    records: [],
    config: PLUGIN_CONFIG,
    currentProviders,
    manifest: { routes: first.managedRoutes, credentials: first.managedCredentials },
    credentialState: Object.fromEntries(first.credentials.map((entry) => [entry.ref, { value: entry.value, source: 'file' }])),
  })
  assert.deepEqual(plan.remove, first.managedRoutes)
  assert.deepEqual(plan.credentialRemovals, first.managedCredentials)
  assert.ok(!plan.remove.includes('ali-bailian'))
  assert.deepEqual(plan.managedRoutes, [])
})

test('计划：撞到别人的同名路由时默认跳过并警告', () => {
  const built = buildPlan({ records: [openclawRecord('a', 'A')], config: PLUGIN_CONFIG, currentProviders: {}, manifest: { routes: [], credentials: [] } })
  const key = built.managedRoutes[0]
  const plan = buildPlan({
    records: [openclawRecord('a', 'A')],
    config: PLUGIN_CONFIG,
    currentProviders: { [key]: { displayName: '用户手写的同名路由', api: 'openai-completions', baseURL: 'https://other.example/v1', models: [{ id: 'x' }] } },
    manifest: { routes: [], credentials: [] },
  })
  assert.deepEqual(plan.conflicts, [key])
  assert.deepEqual(plan.managedRoutes, [])
  assert.ok(plan.warnings.some((warning) => warning.includes('已被 llm-pi-ai 里的其它配置占用')))

  const overwrite = buildPlan({
    records: [openclawRecord('a', 'A')],
    config: { ...PLUGIN_CONFIG, onConflict: 'overwrite' },
    currentProviders: { [key]: { displayName: '用户手写的同名路由' } },
    manifest: { routes: [], credentials: [] },
  })
  assert.deepEqual(overwrite.update, [key])
})

test('计划：被启动环境遮蔽的凭据不写入，只报告', () => {
  const built = buildPlan({ records: [openclawRecord('a', 'A')], config: PLUGIN_CONFIG, currentProviders: {}, manifest: { routes: [], credentials: [] } })
  const ref = built.credentials[0].ref
  const plan = buildPlan({
    records: [openclawRecord('a', 'A')],
    config: PLUGIN_CONFIG,
    currentProviders: {},
    manifest: { routes: [], credentials: [] },
    credentialState: { [ref]: { value: 'from-env', source: 'env' } },
  })
  assert.equal(plan.credentialWrites.length, 0)
  assert.equal(plan.credentialSkips.length, 1)
  assert.ok(plan.credentialSkips[0].reason.includes('启动环境'))
})

test('计划：缺模型/缺端点的供应商进 skipped 并带原因', () => {
  const plan = buildPlan({
    records: [record('openclaw', { apiKey: 'k' }, { id: 'broken', name: 'Broken' })],
    config: PLUGIN_CONFIG,
    currentProviders: {},
    manifest: { routes: [], credentials: [] },
  })
  assert.deepEqual(plan.managedRoutes, [])
  assert.ok(plan.skipped[0].reason.includes('base_url'))
})

test('计划：importUnsupported 打开后不再跳过', () => {
  const plan = buildPlan({
    records: [record('openclaw', { apiKey: 'k' }, { id: 'broken', name: 'Broken' })],
    config: { ...PLUGIN_CONFIG, importUnsupported: true },
    currentProviders: {},
    manifest: { routes: [], credentials: [] },
  })
  // 协议可以兜底成 openai-completions，但端点仍然没有 —— 说明它确实被写进来了
  assert.equal(plan.managedRoutes.length, 1)
})

test('计划：读回来的配置带 schema 默认字段时仍判定为「未变化」（幂等）', () => {
  const first = buildPlan({ records: [openclawRecord('a', 'A')], config: PLUGIN_CONFIG, currentProviders: {}, manifest: { routes: [], credentials: [] } })
  const key = first.managedRoutes[0]
  // settings.describe() 返回的是 schemastery 解析后的配置：多出一堆默认字段
  const resolved = {
    ...structuredClone(first.routes[key]),
    defaultContextWindow: 262144,
    defaultMaxTokens: 32768,
    defaultInput: ['text'],
    streamIdleTimeoutMs: 300000,
    maxRequestImageBytes: 20971520,
    requestImagePixelBudget: 4194304,
    requestImageMaxBytes: 1048576,
    retryPolicy: { maxAttempts: 4, baseDelayMs: 500 },
  }
  const plan = buildPlan({
    records: [openclawRecord('a', 'A')],
    config: PLUGIN_CONFIG,
    currentProviders: { [key]: resolved },
    manifest: { routes: first.managedRoutes, credentials: first.managedCredentials },
    credentialState: Object.fromEntries(first.credentials.map((entry) => [entry.ref, { value: entry.value, source: 'file' }])),
  })
  assert.equal(plan.changed, false, `多出来的默认字段不该被判成变化：${plan.update.join(', ')}`)
  assert.deepEqual(plan.update, [])
  assert.deepEqual(plan.unchanged, [key])
})

test('计划：用户改了插件管理的字段时判定为更新', () => {
  const first = buildPlan({ records: [openclawRecord('a', 'A')], config: PLUGIN_CONFIG, currentProviders: {}, manifest: { routes: [], credentials: [] } })
  const key = first.managedRoutes[0]
  const plan = buildPlan({
    records: [openclawRecord('a', 'A')],
    config: PLUGIN_CONFIG,
    currentProviders: { [key]: { ...structuredClone(first.routes[key]), baseURL: 'https://wrong.example/v1' } },
    manifest: { routes: first.managedRoutes, credentials: first.managedCredentials },
  })
  assert.deepEqual(plan.update, [key])
  assert.equal(plan.changed, true)
})

test('profileMatches：子集语义', () => {
  const generated = { displayName: 'A', api: 'openai-completions', models: [{ id: 'm' }] }
  assert.equal(profileMatches({ ...generated, retryPolicy: { maxAttempts: 9 } }, generated), true)
  assert.equal(profileMatches({ ...generated, models: [{ id: 'other' }] }, generated), false)
  assert.equal(profileMatches({ displayName: 'A' }, generated), false)
  assert.equal(profileMatches(undefined, generated), false)
  assert.deepEqual(profileDiffKeys({ ...generated, retryPolicy: {} }, generated), [])
  assert.deepEqual(profileDiffKeys({ displayName: 'B', api: 'openai-completions', models: [{ id: 'm' }] }, generated), ['displayName'])
})

test('sameJson 深比较', () => {
  assert.equal(sameJson({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), true)
  assert.equal(sameJson({ a: [1, 2] }, { a: [2, 1] }), false)
  assert.equal(sameJson({ a: 1 }, { a: 1, b: undefined }), false)
})

// ═══ 清单 / 配置小工具 ═══════════════════════════════════════════════════

test('清单：读写往返与比较', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ccswitch-state-'))
  try {
    const file = path.join(dir, 'state.json')
    assert.deepEqual(readState(file).routes, [])
    writeState(file, { routes: ['b', 'a', 'a'], credentials: ['R'], source: 'database' })
    const state = readState(file)
    assert.deepEqual(state.routes, ['a', 'b'])
    assert.equal(state.source, 'database')
    assert.equal(stateMatches(state, ['a', 'b'], ['R']), true)
    assert.equal(stateMatches(state, ['a'], ['R']), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('清单路径遵循 DSH_HOME 或显式配置', () => {
  assert.equal(statePathFor({ statePath: '', home: 'C:\\h', env: { DSH_HOME: 'C:\\dsh' } }), path.join('C:\\dsh', 'cc-switch-state.json'))
  assert.equal(statePathFor({ statePath: 'D:\\x\\s.json', env: {} }), 'D:\\x\\s.json')
})

test('配置解析小工具', () => {
  assert.deepEqual(parseList('claude, codex；openclaw '), ['claude', 'codex', 'openclaw'])
  assert.equal(maskKey('sk-abcdefghijkl'), 'sk-a••••')
  assert.equal(maskKey('short'), '••••')
})

test('selectRecords：appTypes 过滤 + include 强制 + exclude 优先', () => {
  const records = [
    { appType: 'claude', id: 'c1', name: 'Claude 官方' },
    { appType: 'codex', id: 'x1', name: '小胡王国' },
    { appType: 'gemini', id: 'g1', name: 'Google 官方' },
  ]
  assert.deepEqual(selectRecords(records, { appTypes: ['codex'] }).map((r) => r.id), ['x1'])
  // include 表示「只要命中的」：即使不在 appTypes 里也强制带上
  assert.deepEqual(selectRecords(records, { appTypes: ['codex'], include: 'Google 官方' }).map((r) => r.id), ['g1'])
  assert.deepEqual(selectRecords(records, { appTypes: ['claude', 'codex'], include: 'Google 官方, 小胡' }).map((r) => r.id), ['x1', 'g1'])
  assert.deepEqual(selectRecords(records, { appTypes: ['codex'], include: '王国', exclude: '小胡' }).map((r) => r.id), [])
  assert.deepEqual(selectRecords(records, {}).length, 3)
  // 带空格的名字必须整体匹配，不能被空白拆成两个关键字
  assert.deepEqual(selectRecords(records, { appTypes: [], include: 'Google 官方' }).map((r) => r.id), ['g1'])
})

test('resolvePaths：显式 > 环境变量 > 默认目录', () => {
  assert.equal(resolvePaths({ dbPath: 'D:\\x.db', home: 'C:\\h', env: {} }).database, 'D:\\x.db')
  assert.equal(resolvePaths({ dbPath: '', home: 'C:\\h', env: { CC_SWITCH_DB: 'D:\\y.db' } }).database, 'D:\\y.db')
  assert.equal(resolvePaths({ dbPath: '', home: 'C:\\h', env: {} }).database, path.join('C:\\h', '.cc-switch', 'cc-switch.db'))
  assert.equal(resolvePaths({ dbPath: '', home: 'C:\\h', env: {} }).legacy, path.join('C:\\h', '.cc-switch', 'config.json'))
})

// ═══ 端到端：真的建一个 cc-switch 数据库来读 ═════════════════════════════

function makeFixtureDb(dir) {
  const file = path.join(dir, 'cc-switch.db')
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE providers (
      id TEXT, app_type TEXT, name TEXT, settings_config TEXT, website_url TEXT,
      category TEXT, created_at INTEGER, sort_index INTEGER, notes TEXT, icon TEXT,
      icon_color TEXT, meta TEXT, is_current BOOLEAN, in_failover_queue BOOLEAN,
      cost_multiplier TEXT, limit_daily_usd TEXT, limit_monthly_usd TEXT, provider_type TEXT
    );
    CREATE TABLE settings (key TEXT, value TEXT);
    CREATE TABLE proxy_request_logs (request_id TEXT, provider_id TEXT, app_type TEXT, request_model TEXT, created_at INTEGER);
  `)
  const rows = [
    ['claude-official', 'claude', 'Claude Official', { env: {} }, {}],
    ['dddd-1111', 'claude', '某 Claude 中转', { env: { ANTHROPIC_BASE_URL: 'https://cc.example.com', ANTHROPIC_AUTH_TOKEN: 'sk-ccsecret123456', ANTHROPIC_MODEL: 'claude-sonnet-4-20250514' } }, {}],
    ['codex-uuid', 'codex', '小胡王国', { auth: { OPENAI_API_KEY: 'sk-6a49secret' }, config: CODEX_TOML }, { apiFormat: 'openai_responses' }],
    ['gemini-official', 'gemini', 'Google Official', { env: {}, config: {} }, {}],
    ['volcengine-plan', 'openclaw', 'Ark Code Latest', { baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3', apiKey: '41fb72a5-secret', api: 'openai-completions', models: [{ id: 'ark-code-latest', name: 'Ark Code Latest', contextWindow: 256000, input: ['text', 'image'], maxTokens: 32000 }] }, {}],
  ]
  const insert = db.prepare('INSERT INTO providers (id, app_type, name, settings_config, meta, is_current, sort_index) VALUES (?, ?, ?, ?, ?, ?, ?)')
  rows.forEach((row, index) => insert.run(row[0], row[1], row[2], JSON.stringify(row[3]), JSON.stringify(row[4]), index === 2 ? 1 : 0, index))
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('currentProviderCodex', 'codex-uuid')
  const log = db.prepare('INSERT INTO proxy_request_logs (request_id, provider_id, app_type, request_model, created_at) VALUES (?, ?, ?, ?, ?)')
  log.run('r1', 'codex-uuid', 'codex', 'gpt-6-astra', 1)
  log.run('r2', 'codex-uuid', 'codex', 'gpt-6-luna', 2)
  log.run('r3', 'codex-uuid', 'codex', '_codex_session', 3)
  db.close()
  return file
}

test('读取器：真实形状的数据库 -> 记录 -> 计划', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ccswitch-db-'))
  try {
    const dbPath = makeFixtureDb(dir)
    assert.ok(databaseStamp(dbPath) !== undefined)

    const source = await readProviders({ dbPath, appTypes: KNOWN_APP_TYPES })
    assert.equal(source.source, 'database')
    assert.equal(source.records.length, 5)
    assert.deepEqual(source.appTypes, ['claude', 'codex', 'gemini', 'openclaw'])
    assert.equal(source.settings.currentProviderCodex, 'codex-uuid')
    const codex = source.records.find((item) => item.appType === 'codex')
    assert.equal(codex.isCurrent, true)
    assert.deepEqual(codex.usedModels.sort(), ['gpt-6-astra', 'gpt-6-luna'])

    const records = selectRecords(source.records, {
      appTypes: parseList('claude,codex,openclaw,gemini'),
      include: '',
      exclude: '',
    })
    const plan = buildPlan({ records, config: PLUGIN_CONFIG, currentProviders: {}, manifest: { routes: [], credentials: [] } })
    assert.equal(plan.managedRoutes.length, 3, `应导入 3 条（claude 中转 / codex / openclaw），实际：${plan.managedRoutes.join(', ')}`)
    assert.equal(plan.skipped.length, 2, 'claude 官方与 gemini 官方应被跳过')
    for (const key of plan.managedRoutes) assert.match(key, /^ccswitch-/)
    const codexRoute = plan.managedRoutes.find((key) => key.includes('codex'))
    assert.equal(plan.routes[codexRoute].api, 'openai-responses')
    assert.deepEqual(plan.routes[codexRoute].models.map((model) => model.id), ['gpt-6-astra', 'gpt-6-luna'])
    // 凭据引用合法且唯一
    const refs = plan.credentials.map((entry) => entry.ref)
    assert.equal(new Set(refs).size, refs.length)
    for (const ref of refs) assert.match(ref, REF_PATTERN)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ═══ 体检（probe）═════════════════════════════════════════════════════════════

/** 造一个假的 SSE 响应：按 chunks 逐块吐出，最后 done。 */
function sseResponse(chunks, { status = 200, chunkDelayMs = 0, text } = {}) {
  const encoder = new TextEncoder()
  let index = 0
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    text: async () => text ?? chunks.join(''),
    body: {
      getReader() {
        return {
          async read() {
            if (index >= chunks.length) return { value: undefined, done: true }
            if (chunkDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, chunkDelayMs))
            const chunk = chunks[index]
            index += 1
            return { value: encoder.encode(chunk), done: false }
          },
          async cancel() {},
        }
      },
    },
  }
}

const RESPONSES_PROFILE = {
  displayName: '中转A',
  api: 'openai-responses',
  baseURL: 'https://gw.example/v1/',
  models: [{ id: 'gpt-x' }],
}

test('体检：支持的协议与 convert 里的协议表一致', () => {
  assert.deepEqual([...PROBEABLE_APIS].sort(), [...SUPPORTED_PROTOCOLS].sort())
})

test('体检：URL 就是 pi-ai 会打的那个（去尾斜杠 + 协议路径）', () => {
  assert.equal(probeUrlFor('https://gw.example/v1/', 'openai-responses'), 'https://gw.example/v1/responses')
  assert.equal(probeUrlFor('https://gw.example', 'openai-completions'), 'https://gw.example/chat/completions')
  assert.equal(probeUrlFor('https://gw.example', 'anthropic-messages'), 'https://gw.example/messages')
  assert.equal(probeUrlFor('https://gw.example', 'bedrock'), undefined)
})

test('体检：responses 协议跑通 —— 请求形状、鉴权头、完成标记都对', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return sseResponse(['event: response.created\ndata: {}\n\n', 'event: response.completed\ndata: {}\n\n'])
  }
  const result = await probeRoute({ routeKey: 'r1', profile: RESPONSES_PROFILE, apiKey: 'sk-secret-value', fetchImpl })
  assert.equal(result.status, 'ok')
  assert.equal(result.done, true)
  assert.equal(result.url, 'https://gw.example/v1/responses')
  assert.equal(result.model, 'gpt-x')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-secret-value')
  assert.equal(calls[0].init.headers.Accept, 'text/event-stream')
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.model, 'gpt-x')
  assert.equal(body.stream, true)
  assert.equal(typeof result.firstByteMs, 'number')
  assert.ok(result.totalMs >= result.firstByteMs)
  assert.ok(result.bytes > 0)
})

test('体检：chat/completions 与 messages 各自的路径、鉴权、结束标记', async () => {
  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push({ url, headers: init.headers, body: JSON.parse(init.body) })
    return url.endsWith('/messages')
      ? sseResponse(['event: message_stop\ndata: {}\n\n'])
      : sseResponse(['data: {"choices":[]}\n\n', 'data: [DONE]\n\n'])
  }
  const chat = await probeRoute({
    routeKey: 'c',
    profile: { displayName: 'B', api: 'openai-completions', baseURL: 'https://gw.example/api/v3', models: [{ id: 'm' }] },
    apiKey: 'k',
    fetchImpl,
  })
  assert.equal(chat.status, 'ok')
  assert.equal(seen[0].url, 'https://gw.example/api/v3/chat/completions')
  assert.equal(seen[0].headers.Authorization, 'Bearer k')
  assert.deepEqual(seen[0].body.messages, [{ role: 'user', content: 'ping' }])

  const anthropic = await probeRoute({
    routeKey: 'a',
    profile: { displayName: 'C', api: 'anthropic-messages', baseURL: 'https://gw.example', models: [{ id: 'claude-x' }] },
    apiKey: 'k2',
    fetchImpl,
  })
  assert.equal(anthropic.status, 'ok')
  assert.equal(seen[1].url, 'https://gw.example/messages')
  assert.equal(seen[1].headers['x-api-key'], 'k2')
  assert.equal(seen[1].headers['anthropic-version'], '2023-06-01')
  assert.equal(seen[1].headers.Authorization, undefined)
  assert.equal(seen[1].body.max_tokens, 16)
})

test('体检：首字节太慢标成「慢」，并给出调大超时的具体写法', async () => {
  const fetchImpl = async () => sseResponse(['data: [DONE]\n\n'], { chunkDelayMs: 40 })
  const result = await probeRoute({
    routeKey: 'slow-route',
    profile: { displayName: '慢中转', api: 'openai-completions', baseURL: 'https://gw.example', models: [{ id: 'm' }] },
    apiKey: 'k',
    fetchImpl,
    slowFirstByteMs: 5,
  })
  assert.equal(result.status, 'slow')
  assert.equal(result.done, true)
  const text = formatProbeReport([result], { timeoutMs: 120000 })
  assert.match(text, /🐢/)
  assert.match(text, /slow-route/)
  assert.match(text, /overrides/)
  assert.match(text, /单条上限 120s/)
})

test('体检：流提前结束（没有完成标记）判成 incomplete', async () => {
  const fetchImpl = async () => sseResponse(['data: {"type":"response.output_text.delta","delta":"你"}\n\n'])
  const result = await probeRoute({ routeKey: 'r', profile: RESPONSES_PROFILE, apiKey: 'k', fetchImpl })
  assert.equal(result.status, 'incomplete')
  assert.equal(result.done, false)
  assert.match(result.errorText, /掐断/)
})

test('体检：上游在流里报错时，摘出错误原文且不给 Key 打码漏出去', async () => {
  // 这正是「配置全对却报错」的典型：中转端点把自己的上游错误塞进 SSE
  const fetchImpl = async () =>
    sseResponse(['data: {"type":"error","error":{"type":"stream_read_error","message":"upstream sk-abcdef0123456789 closed"}}\n\n'])
  const result = await probeRoute({ routeKey: 'r', profile: RESPONSES_PROFILE, apiKey: 'sk-my-secret-key', fetchImpl })
  assert.equal(result.status, 'error')
  assert.match(result.errorText, /stream_read_error/)
  assert.ok(!result.errorText.includes('sk-abcdef0123456789'), '上游正文里的密钥必须打码')
  assert.match(result.errorText, /sk-<已隐藏>/)
})

test('体检：HTTP 4xx/5xx 如实汇报状态码与正文', async () => {
  const fetchImpl = async () => sseResponse([], { status: 401, text: '{"error":{"message":"invalid api key"}}' })
  const result = await probeRoute({ routeKey: 'r', profile: RESPONSES_PROFILE, apiKey: 'bad', fetchImpl })
  assert.equal(result.status, 'error')
  assert.equal(result.httpStatus, 401)
  assert.match(result.errorText, /HTTP 401/)
  assert.match(result.errorText, /invalid api key/)
})

test('体检：连不上就是连不上，不伪装成超时', async () => {
  const fetchImpl = async () => {
    const error = new Error('connect ECONNREFUSED 127.0.0.1:1')
    error.cause = { code: 'ECONNREFUSED' }
    throw error
  }
  const result = await probeRoute({ routeKey: 'r', profile: RESPONSES_PROFILE, apiKey: 'k', fetchImpl })
  assert.equal(result.status, 'error')
  assert.match(result.errorText, /ECONNREFUSED/)
})

test('体检：fetch failed 要把 cause 里的真实原因（DNS/证书）说出来', async () => {
  const fetchImpl = async () => {
    const error = new TypeError('fetch failed')
    error.cause = Object.assign(new Error('getaddrinfo ENOTFOUND gw.example'), { code: 'ENOTFOUND' })
    throw error
  }
  const result = await probeRoute({ routeKey: 'r', profile: RESPONSES_PROFILE, apiKey: 'k', fetchImpl })
  assert.equal(result.status, 'error')
  assert.match(result.errorText, /fetch failed/)
  assert.match(result.errorText, /ENOTFOUND/)
  assert.match(result.errorText, /gw\.example/)
})

test('体检：等不到响应就按超时收场，并说明首字节到没到', async () => {
  const fetchImpl = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('This operation was aborted')
        error.name = 'AbortError'
        reject(error)
      })
    })
  const result = await probeRoute({ routeKey: 'r', profile: RESPONSES_PROFILE, apiKey: 'k', fetchImpl, timeoutMs: 60 })
  assert.equal(result.status, 'timeout')
  assert.match(result.errorText, /等待 60ms 仍未完成/)
  assert.match(result.errorText, /连首字节都没等到/)
})

test('体检：协议不认识 / 没有模型时不发请求', async () => {
  const fetchImpl = async () => {
    throw new Error('不该发请求')
  }
  const unknownApi = await probeRoute({
    routeKey: 'r',
    profile: { displayName: 'X', api: 'bedrock', baseURL: 'https://gw.example', models: [{ id: 'm' }] },
    apiKey: 'k',
    fetchImpl,
  })
  assert.equal(unknownApi.status, 'error')
  assert.match(unknownApi.errorText, /不支持体检/)

  const noModel = await probeRoute({
    routeKey: 'r2',
    profile: { displayName: 'Y', api: 'openai-completions', baseURL: 'https://gw.example', models: [] },
    apiKey: 'k',
    fetchImpl,
  })
  assert.equal(noModel.status, 'error')
  assert.match(noModel.errorText, /没有模型/)

  const noBase = await probeRoute({
    routeKey: 'r3',
    profile: { displayName: 'Z', api: 'openai-completions', models: [{ id: 'm' }] },
    apiKey: 'k',
    fetchImpl,
  })
  assert.equal(noBase.status, 'error')
})

test('体检：没有 Key 也照发（很多中转会直接 401，如实汇报比不测更有用）', async () => {
  const calls = []
  const fetchImpl = async (_url, init) => {
    calls.push(init)
    return sseResponse(['data: [DONE]\n\n'])
  }
  const result = await probeRoute({
    routeKey: 'r',
    profile: { displayName: 'N', api: 'openai-completions', baseURL: 'https://gw.example', models: [{ id: 'm' }] },
    fetchImpl,
  })
  assert.equal(result.status, 'ok')
  assert.equal(calls[0].headers.Authorization, undefined)
})

test('体检：自定义 headers 会带上（cc-switch 里的 requestHeaders 就是这么来的）', async () => {
  const calls = []
  const fetchImpl = async (_url, init) => {
    calls.push(init)
    return sseResponse(['data: [DONE]\n\n'])
  }
  await probeRoute({
    routeKey: 'r',
    profile: {
      displayName: 'H',
      api: 'openai-completions',
      baseURL: 'https://gw.example',
      models: [{ id: 'm' }],
      headers: { 'X-Custom': 'v' },
    },
    apiKey: 'k',
    fetchImpl,
  })
  assert.equal(calls[0].headers['X-Custom'], 'v')
  assert.equal(calls[0].headers.Authorization, 'Bearer k')
})

test('体检：probeRoutes 串行跑完每条路由并逐条回调进度', async () => {
  const progress = []
  const fetchImpl = async () => sseResponse(['data: [DONE]\n\n'])
  const results = await probeRoutes({
    routes: {
      a: { displayName: 'A', api: 'openai-completions', baseURL: 'https://a.example', models: [{ id: 'm' }] },
      b: { displayName: 'B', api: 'openai-completions', baseURL: 'https://b.example', models: [{ id: 'm' }] },
    },
    keys: { a: 'ka' },
    fetchImpl,
    onProgress: (result) => progress.push(result.routeKey),
  })
  assert.deepEqual(
    results.map((result) => result.routeKey),
    ['a', 'b'],
  )
  assert.deepEqual(progress, ['a', 'b'])
  assert.equal(results.every((result) => result.status === 'ok'), true)
})

test('体检：进度回调抛错不影响体检本身', async () => {
  const fetchImpl = async () => sseResponse(['data: [DONE]\n\n'])
  const results = await probeRoutes({
    routes: { a: { displayName: 'A', api: 'openai-completions', baseURL: 'https://a.example', models: [{ id: 'm' }] } },
    fetchImpl,
    onProgress: () => {
      throw new Error('回调炸了')
    },
  })
  assert.equal(results.length, 1)
  assert.equal(results[0].status, 'ok')
})

test('体检：读到字节上限就收工，不会把整段回答拉完', async () => {
  const fetchImpl = async () => sseResponse(['x'.repeat(500), 'x'.repeat(500), 'data: [DONE]\n\n'])
  const result = await probeRoute({ routeKey: 'r', profile: RESPONSES_PROFILE, apiKey: 'k', fetchImpl, maxBytes: 600 })
  assert.equal(result.truncated, true)
  assert.equal(result.status, 'incomplete')
  assert.match(result.errorText, /已读 \d+ 字节/)
})

test('体检：汇报文本覆盖各种结论，且没有路由时给出下一步', () => {
  const empty = formatProbeReport([])
  assert.match(empty, /没有可体检的路由/)
  assert.match(empty, /list \/ skip-list/)

  const mixed = formatProbeReport(
    [
      { routeKey: 'ok-route', displayName: 'A', api: 'openai-completions', model: 'm', status: 'ok', httpStatus: 200, firstByteMs: 800, totalMs: 1500, bytes: 600 },
      { routeKey: 'bad-route', displayName: 'B', api: 'openai-responses', model: 'm', status: 'error', httpStatus: 502, firstByteMs: undefined, totalMs: 300, bytes: 0, errorText: 'HTTP 502 bad gateway' },
    ],
    { timeoutMs: 120000, source: 'database (/x/cc-switch.db)' },
  )
  assert.match(mixed, /共 2 条/)
  assert.match(mixed, /可用 1，慢 0，异常 1/)
  assert.match(mixed, /✅ 可用/)
  assert.match(mixed, /❌ 不可用/)
  assert.match(mixed, /首字节 800ms/)
  assert.match(mixed, /database \(\/x\/cc-switch\.db\)/)
})