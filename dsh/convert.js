/**
 * cc-switch 供应商 -> DSH `llm-pi-ai` 路由配置 的转换层。
 *
 * 目标结构就是 `@deepseek-ai/dsh-llm-pi-ai` 的 providers 字典值：
 *
 *   { displayName, apiKeyEnv, api, baseURL, models: [{ id, name, contextWindow, maxTokens, input }],
 *     headers, reasoningEfforts, retryPolicy }
 *
 * 当前版本（DSH 0.2.0-rc.2 / pi-ai 0.2.0-rc.2）的 `api` 只认三种协议：
 *   openai-completions | openai-responses | anthropic-messages
 * 其它协议（例如 Gemini 原生、Bedrock、Vertex）无法用「密钥 + 端点」描述，
 * 转换层会明确标注原因而不是生成一条跑不通的路由。
 */

import { parseToml } from './toml.js'

/** 当前 DSH 版本的 pi-ai 适配器支持的协议。 */
export const SUPPORTED_PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages']

/** pi-ai 认可的模型输入模态。 */
const MODALITIES = ['text', 'image']

/** pi-ai 认可的思考等级（键），值只能是其中之一。 */
const THINKING_LADDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

const DEFAULT_CONTEXT_WINDOW = 262144
const DEFAULT_MAX_TOKENS = 32768

/** 6 位 FNV-1a 短哈希，用于给过长的路由名做稳定后缀。 */
export function shortHash(text) {
  let hash = 0x811c9dc5
  const input = String(text ?? '')
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0').slice(0, 6)
}

/**
 * 把任意文本变成可做路由名/环境变量名的 ASCII 片段。
 * 中文名（例如「小胡王国」）转不出 ASCII，此时由调用方改用 id 或哈希。
 */
export function slugify(text, max = 24) {
  const ascii = String(text ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
  const cleaned = ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (cleaned === '') return ''
  if (cleaned.length <= max) return cleaned
  const head = cleaned.slice(0, Math.max(1, max - 7)).replace(/-+$/g, '')
  return `${head}-${shortHash(text)}`
}

/** 路由键片段：优先用 ASCII 化的 id，其次名称，最后用哈希兜底。 */
export function providerSlug(record, max = 24) {
  const fromName = slugify(record.name, max)
  const fromId = slugify(record.id, max)
  // cc-switch 的 id 常是 UUID：可读性差但对名称非 ASCII 的供应商是唯一稳定来源
  if (record.name && /[a-z0-9]/i.test(record.name) && fromName) return fromName
  if (fromId) return fromId
  if (fromName) return fromName
  return shortHash(`${record.appType}|${record.id}|${record.name}`)
}

/** 路由键：`<prefix>-<appType>-<slug>`。 */
export function routeKeyFor(record, prefix = 'ccswitch', suffix = '') {
  const cleanPrefix = slugify(prefix, 20) || 'ccswitch'
  const base = providerSlug(record)
  const tail = suffix ? `-${slugify(suffix, 20) || shortHash(suffix)}` : ''
  return `${cleanPrefix}-${record.appType}-${base}${tail}`
}

/** 凭据引用名：必须是 POSIX 标识符（/^[A-Za-z_][A-Za-z0-9_]*$/）。 */
export function envRefFor(record, prefix = 'ccswitch', suffix = '') {
  const raw = `${prefix}-${record.appType}-${providerSlug(record)}${suffix ? `-${suffix}` : ''}-api-key`
  const upper = raw.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  const withPrefix = upper.startsWith('CCSWITCH') ? upper : `CCSWITCH_${upper}`
  return withPrefix.endsWith('_API_KEY') ? withPrefix : `${withPrefix}_API_KEY`
}

/** 协议名归一化。 */
export function normalizeProtocol(value) {
  const text = String(value ?? '').toLowerCase().trim()
  if (text === '') return undefined
  if (text.includes('anthropic')) return 'anthropic-messages'
  if (text.includes('response')) return 'openai-responses'
  if (text.includes('completion')) return 'openai-completions'
  if (text === 'chat' || text.includes('openai_chat') || text.includes('openai-chat')) return 'openai-completions'
  if (text.includes('ai-sdk/anthropic')) return 'anthropic-messages'
  if (text.includes('ai-sdk/openai')) return 'openai-completions'
  return undefined
}

/** 取值：第一个非空字符串。 */
function str(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

/** 取值：第一个有限正数。 */
function num(...values) {
  for (const value of values) {
    const parsed = typeof value === 'string' ? Number(value.replace(/_/g, '')) : value
    if (typeof parsed === 'number' && Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed)
  }
  return undefined
}

/**
 * 把声明过的最低思考等级展开成 pi-ai 的 `reasoningEfforts`。
 * 例如 "high" -> { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high' }
 */
export function reasoningEffortsFrom(declared) {
  const level = String(declared ?? '').toLowerCase().trim()
  if (!THINKING_LADDER.includes(level)) return undefined
  const upto = THINKING_LADDER.slice(0, THINKING_LADDER.indexOf(level) + 1)
  const out = { off: null }
  for (const item of upto) out[item] = item
  return out
}

/** 归一化一个模型条目（cc-switch 各 app 类型字段名不一致）。 */
export function toModel(entry, { reasoningEffort, defaultInput } = {}) {
  if (typeof entry === 'string') {
    const id = entry.trim()
    if (id === '') return undefined
    const model = { id }
    const efforts = reasoningEffortsFrom(reasoningEffort)
    if (efforts !== undefined) model.reasoningEfforts = efforts
    return model
  }
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined
  const id = str(entry.id, entry.model, entry.modelId, entry.model_id, entry.name, entry.slug)
  if (id === undefined) return undefined
  const model = { id }
  const name = str(entry.name, entry.displayName, entry.display_name, entry.label)
  if (name !== undefined && name !== id) model.name = name
  const contextWindow = num(entry.contextWindow, entry.context_window, entry.contextLength, entry.context_length, entry.maxInputTokens, entry.max_input_tokens)
  if (contextWindow !== undefined) model.contextWindow = contextWindow
  const maxTokens = num(entry.maxTokens, entry.max_tokens, entry.maxOutputTokens, entry.max_output_tokens, entry.outputTokens)
  if (maxTokens !== undefined) model.maxTokens = maxTokens
  const declaredInput = Array.isArray(entry.input)
    ? entry.input
    : Array.isArray(entry.modalities)
      ? entry.modalities
      : Array.isArray(entry.inputModalities)
        ? entry.inputModalities
        : undefined
  if (declaredInput !== undefined) {
    const filtered = declaredInput.map((item) => String(item).toLowerCase()).filter((item) => MODALITIES.includes(item))
    if (filtered.length > 0) model.input = [...new Set(filtered)]
  }
  const effort = str(entry.reasoningEffort, entry.reasoning_effort, entry.reasoning, entry.effort) ?? reasoningEffort
  const efforts = reasoningEffortsFrom(effort)
  if (efforts !== undefined) model.reasoningEfforts = efforts
  return model
}

/** 去掉模型条目里的重复 id，保持顺序。 */
function dedupeModels(models) {
  const out = []
  const seen = new Set()
  for (const model of models) {
    if (model === undefined || model === null) continue
    if (seen.has(model.id)) continue
    seen.add(model.id)
    out.push(model)
  }
  return out
}

/** 从任意字符串/数组收集模型名。 */
function modelsFromStrings(values, options) {
  const list = []
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') list.push(toModel(value.trim(), options))
    else if (value !== undefined && value !== null) list.push(toModel(value, options))
  }
  return list
}

/** 去掉 baseURL 末尾多余的斜杠。 */
function cleanBaseUrl(url) {
  if (typeof url !== 'string') return undefined
  const trimmed = url.trim()
  if (trimmed === '') return undefined
  return trimmed.replace(/\/+$/g, '')
}

/** isFullUrl 时去掉已经指向具体接口的尾巴，还原成 API 根地址。 */
function stripEndpointTail(url) {
  if (typeof url !== 'string') return url
  return url.replace(/\/(chat\/completions|completions|responses|messages)\/?$/i, '')
}

/** 从 meta 里取请求头（自定义 UA / requestHeaders）。 */
function headersFrom(meta) {
  const headers = {}
  const ua = str(meta?.customUserAgent)
  if (ua !== undefined) setHeader(headers, 'User-Agent', ua)
  const declared = meta?.requestHeaders ?? meta?.request_headers
  if (declared !== null && typeof declared === 'object' && !Array.isArray(declared)) {
    for (const [name, value] of Object.entries(declared)) {
      if (typeof value !== 'string' || value === '') continue
      setHeader(headers, name, value)
    }
  }
  return headers
}

/**
 * 只保留 Fetch 真正接受的请求头。
 * pi-ai 在严格校验时会用 `new Headers()` 复检每个头，一个非法名字
 * 会让**整次**配置写入失败 —— 所以宁可丢掉它。
 */
function setHeader(headers, name, value) {
  if (typeof name !== 'string' || name.trim() === '' || /[\r\n]/.test(name) || /[\r\n]/.test(value)) return
  try {
    // eslint-disable-next-line no-new
    new Headers([[name, value]])
  } catch {
    return
  }
  headers[name] = value
}

/** 按 name 建索引，便于同一记录展开出多条路由时生成子键。 */
function makeEmitter({ record, options }) {
  const { prefix, problems, variants, seen } = options
  return function emit({ suffix = '', displayName, protocol, baseURL, apiKey, models, headers, notes = [], unusable = [] }) {
    const routeKey = routeKeyFor(record, prefix, suffix)
    const apiKeyEnv = apiKey ? envRefFor(record, prefix, suffix) : undefined
    const list = dedupeModels(models)
    const reasons = [...unusable]
    if (protocol === undefined || !SUPPORTED_PROTOCOLS.includes(protocol)) {
      reasons.push(
        protocol === undefined
          ? '无法判定协议（当前 DSH 只支持 openai-completions / openai-responses / anthropic-messages）'
          : `协议 "${protocol}" 不被当前 DSH 的 pi-ai 适配器支持`,
      )
    }
    if (baseURL === undefined) reasons.push('没有可用的 base_url（官方/需要 OAuth 登录的供应商无法直接导入）')
    if (list.length === 0) reasons.push('没有识别到任何模型，导入后会成为空路由')
    const profile = {}
    // pi-ai 严格校验会拒绝 `displayName: ""`，这里兜一个非空名字
    const label = typeof displayName === 'string' && displayName.trim() !== '' ? displayName.trim() : record.name
    profile.displayName = typeof label === 'string' && label.trim() !== '' ? label.trim() : '未命名供应商'
    if (apiKeyEnv !== undefined) profile.apiKeyEnv = apiKeyEnv
    if (protocol !== undefined) profile.api = protocol
    if (baseURL !== undefined) profile.baseURL = baseURL
    profile.models = list
    if (headers !== undefined && Object.keys(headers).length > 0) profile.headers = headers
    variants.push({
      routeKey,
      apiKeyEnv,
      apiKey,
      protocol,
      baseURL,
      models: list,
      displayName,
      headers,
      profile,
      problems: reasons,
      notes,
    })
    seen.add(routeKey)
  }
}

/** claude / claude-desktop：`{ env: { ANTHROPIC_* } }` */
function convertClaude(record, emit) {
  const env = record.config?.env
  if (env === null || typeof env !== 'object') {
    emit({ displayName: record.name, unusable: ['settings_config 里没有 env 对象（该供应商可能由 cc-switch 的直连模式托管）'] })
    return
  }
  const unusable = []
  if (str(env.CLAUDE_CODE_USE_BEDROCK) !== undefined) unusable.push('Bedrock 路由需要 AWS 签名，无法用密钥 + 端点描述')
  emit({
    displayName: record.name,
    protocol: normalizeProtocol(record.meta?.apiFormat) ?? 'anthropic-messages',
    baseURL: cleanBaseUrl(str(env.ANTHROPIC_BASE_URL)),
    apiKey: str(env.ANTHROPIC_AUTH_TOKEN, env.ANTHROPIC_API_KEY),
    models: modelsFromStrings([
      env.ANTHROPIC_MODEL,
      env.ANTHROPIC_DEFAULT_FABLE_MODEL,
      env.ANTHROPIC_DEFAULT_OPUS_MODEL,
      env.ANTHROPIC_DEFAULT_SONNET_MODEL,
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
      env.ANTHROPIC_SMALL_FAST_MODEL,
    ]),
    headers: headersFrom(record.meta),
    unusable,
  })
}

/** codex：`{ auth: { OPENAI_API_KEY }, config: "<toml>" }` */
function convertCodex(record, emit) {
  const config = record.config ?? {}
  const toml = parseToml(typeof config.config === 'string' ? config.config : '')
  const providerName = str(toml.model_provider)
  const tables = toml.model_providers ?? {}
  const table = (providerName !== undefined ? tables[providerName] : undefined) ?? tables.custom ?? {}
  const wire = str(table.wire_api) ?? str(toml.wire_api)
  const protocol =
    normalizeProtocol(record.meta?.apiFormat) ??
    normalizeProtocol(record.meta?.codexCopilotApiFormat) ??
    normalizeProtocol(wire) ??
    // Codex 自身 `wire_api` 缺省是 chat（OpenAI Chat Completions）
    (wire === undefined ? 'openai-completions' : undefined)
  const baseURL = cleanBaseUrl(
    str(
      table.base_url,
      config.openai_base_url,
      toml.openai_base_url,
      record.meta?.baseURL,
    ),
  )
  const keyField = str(record.meta?.apiKeyField)
  const keyFromField = keyField !== undefined ? readPath(config, keyField) : undefined
  const apiKey = str(
    keyFromField,
    config.auth?.OPENAI_API_KEY,
    config.auth?.OPENAI_APIKEY,
    config.auth?.api_key,
    config.experimental_bearer_token,
    toml.experimental_bearer_token,
    config.apiKey,
  )
  const declaredModels = modelsFromStrings([toml.model, config.model, record.meta?.model], {
    reasoningEffort: str(toml.model_reasoning_effort, config.model_reasoning_effort, record.meta?.reasoningEffort, record.meta?.reasoning),
  })
  const catalogModels = modelsFromCatalog(config.model_catalog_json)
  // cc-switch 自己的代理日志记录了这家供应商真实用过的模型 —— 对只声明
  // 一个 model 的 Codex 供应商来说，这是最实用的模型清单来源。
  const usedModels = modelsFromStrings(record.usedModels ?? [], {
    reasoningEffort: str(toml.model_reasoning_effort, record.meta?.reasoningEffort),
  })
  const unusable = []
  if (providerName !== undefined && tables[providerName] === undefined && Object.keys(tables).length > 0) {
    unusable.push(`Codex 配置里的 model_provider="${providerName}" 找不到对应的 [model_providers.${providerName}]`)
  }
  emit({
    displayName: record.name,
    protocol,
    baseURL,
    apiKey,
    models: [...declaredModels, ...catalogModels, ...usedModels],
    headers: headersFrom(record.meta),
    unusable,
  })
}

/** 读取 `a.b.c` 形式的路径。 */
function readPath(root, dotted) {
  let node = root
  for (const part of String(dotted).split('.')) {
    if (node === null || typeof node !== 'object') return undefined
    node = node[part]
  }
  return typeof node === 'string' || typeof node === 'number' ? String(node) : undefined
}

/** `model_catalog_json` 可能是内联 JSON，也可能是文件路径；只处理内联 JSON。 */
function modelsFromCatalog(value) {
  if (typeof value !== 'string') {
    if (value !== null && typeof value === 'object') return collectCatalogModels(value)
    return []
  }
  const text = value.trim()
  if (!text.startsWith('{') && !text.startsWith('[')) return []
  try {
    return collectCatalogModels(JSON.parse(text))
  } catch {
    return []
  }
}

function collectCatalogModels(node) {
  const list = []
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string') list.push(toModel(item))
        else if (item !== null && typeof item === 'object') list.push(toModel(item))
        else visit(item)
      }
      return
    }
    if (value !== null && typeof value === 'object') {
      if (typeof value.id === 'string' || typeof value.slug === 'string' || typeof value.model === 'string') {
        list.push(toModel(value))
        return
      }
      for (const child of Object.values(value)) visit(child)
    }
  }
  visit(node)
  return list
}

/** gemini：`{ env: { GEMINI_ / GOOGLE_ ... }, config }` —— 原生协议当前不支持。 */
function convertGemini(record, emit) {
  const env = record.config?.env ?? {}
  const declared = normalizeProtocol(record.meta?.apiFormat ?? record.config?.api ?? record.config?.apiFormat)
  const unusable = []
  if (declared === undefined) {
    unusable.push('Gemini 原生协议（generateContent）不在当前 DSH pi-ai 的可配置协议里；请改用 OpenAI 兼容网关，或在 cc-switch 里开启本地代理')
  }
  emit({
    displayName: record.name,
    protocol: declared,
    baseURL: cleanBaseUrl(str(env.GEMINI_BASE_URL, env.GOOGLE_GEMINI_BASE_URL, record.config?.baseUrl, record.config?.baseURL)),
    apiKey: str(env.GEMINI_API_KEY, env.GOOGLE_API_KEY, record.config?.apiKey),
    models: modelsFromStrings([env.GEMINI_MODEL, record.config?.model]),
    headers: headersFrom(record.meta),
    unusable,
  })
}

/** openclaw：`{ baseUrl, apiKey, api, models: [...] }`，与 pi-ai 几乎 1:1。 */
function convertOpenClaw(record, emit) {
  const config = record.config ?? {}
  // 兼容把整份 openclaw 配置（models.providers.<key>）写进 settings_config 的情况
  const inner = config.models?.providers ?? config.providers
  if (inner !== null && typeof inner === 'object' && !Array.isArray(inner) && Object.keys(inner).length > 0) {
    for (const [name, entry] of Object.entries(inner)) {
      if (entry === null || typeof entry !== 'object') continue
      emitOpenClawEntry(record, emit, entry, name)
    }
    return
  }
  emitOpenClawEntry(record, emit, config, undefined)
}

function emitOpenClawEntry(record, emit, entry, innerName) {
  const protocol = normalizeProtocol(entry.api ?? entry.apiFormat ?? entry.api_format ?? entry.wireApi ?? entry.wire_api) ?? 'openai-completions'
  const fullUrl = entry.isFullUrl === true || record.meta?.isFullUrl === true
  const raw = str(entry.baseUrl, entry.baseURL, entry.base_url, entry.url)
  emit({
    suffix: innerName,
    displayName: innerName !== undefined && innerName !== record.name ? `${record.name} · ${innerName}` : record.name,
    protocol,
    baseURL: cleanBaseUrl(fullUrl ? stripEndpointTail(raw) : raw),
    apiKey: str(entry.apiKey, entry.api_key, entry.key, entry.token),
    models: Array.isArray(entry.models) || (entry.models && typeof entry.models === 'object')
      ? modelsFromModelCollection(entry.models)
      : modelsFromStrings([entry.model, entry.defaultModel]),
    headers: headersFrom(record.meta),
  })
}

/** models 既可能是数组，也可能是 `{ <id>: {...} }` 字典（opencode/hermes 风格）。 */
function modelsFromModelCollection(value) {
  if (Array.isArray(value)) return modelsFromStrings(value)
  if (value !== null && typeof value === 'object') {
    const list = []
    for (const [id, entry] of Object.entries(value)) {
      if (entry === null || typeof entry !== 'object') {
        list.push(toModel(id))
        continue
      }
      list.push(toModel({ id, ...entry }))
    }
    return list
  }
  return []
}

/** mcode：`{ custom_provider: { <key>: { api, options: { baseURL, apiKey }, models } } }` */
function convertMcode(record, emit) {
  const config = record.config ?? {}
  const table = config.custom_provider ?? config.customProvider
  if (table !== null && typeof table === 'object' && !Array.isArray(table)) {
    const entries = Object.entries(table)
    if (entries.length === 0) {
      emit({ displayName: record.name, unusable: ['custom_provider 为空'] })
      return
    }
    for (const [name, entry] of entries) {
      if (entry === null || typeof entry !== 'object') continue
      if (entry.enabled === false) continue
      emitMcodeEntry(record, emit, entry, name)
    }
    return
  }
  emitMcodeEntry(record, emit, config, undefined)
}

function emitMcodeEntry(record, emit, entry, innerName) {
  const options = entry.options ?? entry
  emit({
    suffix: innerName,
    displayName: innerName !== undefined ? `${record.name} · ${innerName}` : record.name,
    protocol: normalizeProtocol(entry.api ?? entry.apiFormat),
    baseURL: cleanBaseUrl(str(options.baseURL, options.baseUrl, options.base_url)),
    apiKey: str(options.apiKey, options.api_key),
    models: modelsFromModelCollection(entry.models ?? []),
    headers: headersFrom(record.meta),
  })
}

/** pi：`{ models: { default }, model: { <id>: { model, base_url, api_key, api_backend } } }` */
function convertPi(record, emit) {
  const config = record.config ?? {}
  const table = config.model ?? config.models?.providers
  if (table !== null && typeof table === 'object' && !Array.isArray(table) && Object.keys(table).length > 0) {
    let emitted = 0
    for (const [name, entry] of Object.entries(table)) {
      if (entry === null || typeof entry !== 'object') continue
      const baseURL = str(entry.base_url, entry.baseUrl, entry.options?.baseURL)
      if (baseURL === undefined) continue
      emitted += 1
      emit({
        suffix: str(entry.name) ?? name,
        displayName: str(entry.name) ?? `${record.name} · ${name}`,
        protocol:
          normalizeProtocol(entry.api_backend ?? entry.apiBackend ?? entry.api) ??
          'openai-completions',
        baseURL: cleanBaseUrl(baseURL),
        apiKey: str(entry.api_key, entry.apiKey, entry.options?.apiKey),
        models: modelsFromStrings([
          entry.model,
          entry.id,
          entry.context_window !== undefined ? { id: str(entry.model) ?? name, contextWindow: entry.context_window } : undefined,
        ]).filter(Boolean),
        headers: headersFrom(record.meta),
      })
    }
    if (emitted === 0) emit({ displayName: record.name, unusable: ['pi 配置里的 model 表没有任何 base_url'] })
    return
  }
  convertGeneric(record, emit)
}

/**
 * 通用兜底：深度扫描 settings_config，找端点 / 密钥 / 协议 / 模型清单。
 * 覆盖 opencode、hermes、grokbuild 以及未来新增的 app 类型。
 */
function convertGeneric(record, emit) {
  const found = { urls: [], keys: [], protocols: [], models: [], modelHints: [], heads: [] }
  deepScan(record.config, found, [])
  const headers = headersFrom(record.meta)
  if (found.heads.length > 1) {
    for (const head of found.heads) {
      emit({
        suffix: head.name,
        displayName: `${record.name} · ${head.name}`,
        protocol: head.protocol,
        baseURL: head.baseURL,
        apiKey: head.apiKey,
        models: head.models,
        headers,
      })
    }
    return
  }
  emit({
    displayName: record.name,
    protocol: found.protocols[0],
    baseURL: cleanBaseUrl(found.urls[0]),
    apiKey: found.keys[0],
    models: dedupeModels([...found.models, ...modelsFromStrings(found.modelHints)]),
    headers,
  })
}

function deepScan(node, found, path, depth = 0) {
  if (node === null || typeof node !== 'object' || depth > 6) return
  // 任何一层里出现完整的 { baseURL, apiKey, models } 组合，就当成一条独立供应商
  const selfUrl = str(node.baseURL, node.baseUrl, node.base_url, node.options?.baseURL, node.options?.baseUrl)
  if (selfUrl !== undefined && path.length > 0) {
    const models = Array.isArray(node.models)
      ? modelsFromStrings(node.models)
      : node.models !== null && typeof node.models === 'object'
        ? modelsFromModelCollection(node.models)
        : []
    const apiKey = str(node.apiKey, node.api_key, node.key, node.token, node.options?.apiKey)
    const protocol = normalizeProtocol(node.api ?? node.apiFormat ?? node.api_backend ?? node.wireApi ?? node.wire_api ?? node.npm)
    found.heads.push({ name: path[path.length - 1], baseURL: cleanBaseUrl(selfUrl), apiKey, protocol, models })
    // 同时并入扁平集合：只有一条 head 时走的是扁平路径
    found.urls.push(selfUrl)
    if (apiKey !== undefined) found.keys.push(apiKey)
    if (protocol !== undefined && !found.protocols.includes(protocol)) found.protocols.push(protocol)
    found.models.push(...models)
    return
  }
  for (const [key, value] of Object.entries(node)) {
    if (value === null || value === undefined) continue
    const lower = key.toLowerCase()
    if (typeof value === 'string') {
      if (/^(base_?url|baseurl|api_?base|api_?url|endpoint|url|host)$/.test(lower) && /^https?:\/\//i.test(value)) found.urls.push(value)
      else if (/(api_?key|apikey|auth_?token|access_?token|secret|token)$/.test(lower) && value.trim() !== '') found.keys.push(value.trim())
      else if (/^(api|api_?backend|api_?format|wire_?api|protocol|npm|sdk)$/.test(lower)) {
        const protocol = normalizeProtocol(value)
        if (protocol !== undefined && !found.protocols.includes(protocol)) found.protocols.push(protocol)
      } else if (/^(defaultmodel|default_model|model|primary)$/.test(lower) && value.trim() !== '') found.modelHints.push(value.trim())
      continue
    }
    if (Array.isArray(value)) {
      if (/^models?$/.test(lower)) found.models.push(...modelsFromStrings(value))
      else deepScan(value, found, path, depth)
      continue
    }
    if (typeof value === 'object') {
      if (/^models?$/.test(lower)) {
        found.models.push(...modelsFromModelCollection(value))
        continue
      }
      deepScan(value, found, [...path, key], depth + 1)
    }
  }
}

/** 深度合并（用于 config.overrides 人工修正）。 */
export function deepMerge(base, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch === undefined ? base : patch
  const out = base !== null && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {}
  for (const [key, value] of Object.entries(patch)) {
    out[key] = key in out ? deepMerge(out[key], value) : value
  }
  return out
}

/** 按 app 类型分派。 */
const CONVERTERS = {
  claude: convertClaude,
  'claude-desktop': convertClaude,
  codex: convertCodex,
  gemini: convertGemini,
  openclaw: convertOpenClaw,
  mcode: convertMcode,
  pi: convertPi,
  opencode: convertGeneric,
  hermes: convertGeneric,
  grokbuild: convertGeneric,
}

/**
 * 把一条 cc-switch 供应商记录转换成 0..N 条 pi-ai 路由。
 * @param record - `ccswitch.js` 归一化后的记录。
 * @param options.prefix - 路由前缀。
 * @param options.overrides - `{ [routeKey]: partialProfile }` 人工修正。
 * @returns `{ variants, convertible }`
 */
export function convertRecord(record, { prefix = 'ccswitch', overrides = {} } = {}) {
  const problems = []
  const variants = []
  const seen = new Set()
  const emit = makeEmitter({ record, options: { prefix, problems, variants, seen } })
  const converter = CONVERTERS[record.appType] ?? convertGeneric
  try {
    converter(record, emit)
  } catch (error) {
    problems.push(`转换失败：${error?.message || error}`)
  }
  const refined = variants.map((variant) => {
    const override = overrides?.[variant.routeKey] ?? overrides?.[`${record.appType}:${record.id}`]
    const profile = override !== undefined ? deepMerge(variant.profile, override) : variant.profile
    const usable = variant.problems.length === 0
    return { ...variant, profile, usable, problems: variant.problems }
  })
  return {
    variants: refined,
    convertible: refined.filter((variant) => variant.usable),
    problems,
  }
}

/** 便于测试与自检：给一条 profile 补齐 pi-ai 的容量缺省值说明。 */
export function profileDefaults() {
  return { contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS }
}