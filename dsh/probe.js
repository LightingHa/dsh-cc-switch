/**
 * 路由体检：用最小的流式请求实测每条路由「能不能跑通、首字节要多久」。
 *
 * 为什么需要它：cc-switch 里很多是第三方中转/拼车端点，配置看起来完全正确，
 * 实际却可能很慢（首字节几十秒）、或者流跑到一半被上游掐断。这类问题在
 * 「设置 → 模型」里是看不出来的，只会表现为对话报错。体检直接按 pi-ai 会打的
 * 那个 URL 发一次真请求，把结果量化出来。
 *
 * 只读：体检不写任何配置，也不会把 Key 打印出来。
 *
 * @module dsh-cc-switch/probe
 */

/**
 * 各协议的最小流式探测请求：路径、请求体、结束标记、错误标记、鉴权头。
 *
 * `build(model, cap)` 里的 `cap` 是输出长度上限（token）：体检只关心「通不通、
 * 多久出首字节、流能不能正常收尾」，不需要模型真写一段东西。默认限到 16 token，
 * 免得一次体检吃掉用户一大块配额（按量计费/限流的端点尤其明显）。cap=0 表示不限。
 */
const PROBES = {
  'openai-responses': {
    path: '/responses',
    build: (model, cap) => ({ model, input: 'ping', stream: true, store: false, ...(cap > 0 ? { max_output_tokens: cap } : {}) }),
    done: ['response.completed'],
    failed: ['response.failed', '"type":"error"'],
    auth: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  'openai-completions': {
    path: '/chat/completions',
    build: (model, cap) => ({
      model,
      messages: [{ role: 'user', content: 'ping' }],
      stream: true,
      ...(cap > 0 ? { max_tokens: cap } : {}),
    }),
    done: ['[DONE]'],
    failed: ['"type":"error"', '"error":{'],
    auth: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  'anthropic-messages': {
    path: '/messages',
    // Anthropic 的 max_tokens 是必填项，不限长度时给个小值兜底
    build: (model, cap) => ({ model, max_tokens: cap > 0 ? cap : 64, stream: true, messages: [{ role: 'user', content: 'ping' }] }),
    done: ['message_stop'],
    failed: ['"type":"error"'],
    auth: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
  },
}

/** 体检支持的协议（与 pi-ai 的 PROTOCOLS 一致）。 */
export const PROBEABLE_APIS = Object.keys(PROBES)

/** 探测请求默认只要这么多输出 token：够判断连通性，又几乎不耗配额。 */
export const DEFAULT_PROBE_MAX_OUTPUT_TOKENS = 16

/** 抹掉文本里可能出现的密钥，并把多行压成一行。 */
function sanitize(text) {
  return String(text ?? '')
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-<已隐藏>')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, '$1<已隐藏>')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 截取标记附近的一小段文本，方便看清上游到底说了什么。 */
function snippetAround(text, marker, span = 240) {
  const index = text.indexOf(marker)
  if (index < 0) return sanitize(text).slice(0, span)
  return sanitize(text.slice(Math.max(0, index - 40), index + span))
}

/**
 * 把 fetch 失败的底层原因（DNS、证书、连接被拒）拼进汇报。
 * Node 的 `TypeError: fetch failed` 本身没有任何信息量，真正的原因在 cause 里。
 */
function causeText(error) {
  const cause = error?.cause
  if (cause === undefined || cause === null) return ''
  const code = typeof cause === 'object' ? (cause.code ?? cause.errno) : undefined
  const message = typeof cause === 'object' ? cause.message : String(cause)
  const detail = [code, message].filter((item) => item !== undefined && item !== '').join(' ')
  return detail === '' ? '' : `（${sanitize(detail)}）`
}

/** 读取非 2xx 响应的正文（有上限，避免把整页 HTML 塞进汇报）。 */
async function readErrorBody(response) {
  try {
    const text = await response.text()
    return sanitize(text).slice(0, 300)
  } catch {
    return ''
  }
}

/**
 * pi-ai 实际会请求的 URL：`{baseURL}` + 协议对应的路径。
 * @param baseURL - 路由配置的 baseURL。
 * @param api - 协议标识。
 * @returns 完整 URL；协议不认识时返回 undefined。
 */
export function probeUrlFor(baseURL, api) {
  const spec = PROBES[api]
  if (spec === undefined) return undefined
  return `${String(baseURL ?? '').replace(/\/+$/, '')}${spec.path}`
}

/**
 * 体检一条路由（单次尝试）。
 *
 * @param options.routeKey - 路由键（汇报用）。
 * @param options.profile - 要写入 pi-ai 的供应商 profile。
 * @param options.apiKey - 这条路由的 Key；没有就按无鉴权发（多数会 401，如实汇报）。
 * @param options.fetchImpl - 注入的 fetch（测试用）。
 * @param options.timeoutMs - 单条上限，到点就中断。
 * @param options.slowFirstByteMs - 首字节超过这个值就算「慢」。
 * @param options.maxBytes - 读够这么多字节就收工（不需要读完整段回答）。
 * @param options.maxOutputTokens - 请求里限制的输出长度（省配额）；0=不限。
 * @returns 体检结果对象。
 */
async function attemptOnce({
  routeKey,
  profile,
  apiKey,
  fetchImpl = fetch,
  timeoutMs = 180_000,
  slowFirstByteMs = 30_000,
  maxBytes = 262_144,
  maxOutputTokens = 16,
} = {}) {
  const result = {
    routeKey,
    displayName: profile?.displayName ?? routeKey,
    api: profile?.api,
    model: undefined,
    url: undefined,
    status: 'skipped',
    httpStatus: undefined,
    firstByteMs: undefined,
    totalMs: undefined,
    bytes: 0,
    done: false,
    truncated: false,
    errorText: undefined,
    note: undefined,
  }

  const spec = PROBES[profile?.api]
  if (spec === undefined) {
    result.status = 'error'
    result.errorText = `协议 ${profile?.api ?? '(空)'} 不支持体检（可用：${PROBEABLE_APIS.join(' / ')}）`
    return result
  }
  const model = Array.isArray(profile?.models) && profile.models.length > 0 ? profile.models[0]?.id : undefined
  if (typeof model !== 'string' || model === '') {
    result.status = 'error'
    result.errorText = '这条路由没有模型，无从体检'
    return result
  }
  result.model = model
  result.url = probeUrlFor(profile.baseURL, profile.api)
  if (typeof result.url !== 'string' || result.url.length === 0) {
    result.status = 'error'
    result.errorText = '没有 baseURL'
    return result
  }

  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const auth = typeof apiKey === 'string' && apiKey !== '' ? spec.auth(apiKey) : {}
  try {
    const response = await fetchImpl(result.url, {
      method: 'POST',
      headers: {
        ...auth,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...(profile.headers ?? {}),
      },
      body: JSON.stringify(spec.build(model, maxOutputTokens)),
      signal: controller.signal,
    })
    result.httpStatus = response?.status
    if (response === undefined || response.ok !== true) {
      result.status = 'error'
      result.errorText = `HTTP ${response?.status ?? '(无响应)'} ${await readErrorBody(response)}`.trim()
      return result
    }

    const reader = response.body?.getReader?.()
    if (reader === undefined) {
      result.status = 'error'
      result.errorText = '响应不是可读的流（上游没有按 SSE 返回）'
      return result
    }

    const decoder = new TextDecoder()
    let tail = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done === true) break
      if (result.firstByteMs === undefined) result.firstByteMs = Date.now() - started
      result.bytes += value.byteLength
      tail = (tail + decoder.decode(value, { stream: true })).slice(-8192)
      if (spec.done.some((marker) => tail.includes(marker))) {
        result.done = true
        break
      }
      if (result.bytes >= maxBytes) {
        result.truncated = true
        break
      }
    }
    try {
      await reader.cancel()
    } catch {
      /* 已经结束的流 cancel 会抛，忽略 */
    }

    const failedMarker = spec.failed.find((marker) => tail.includes(marker))
    if (failedMarker !== undefined) {
      result.status = 'error'
      result.errorText = `上游在流里报错：${snippetAround(tail, failedMarker)}`
      return result
    }
    if (result.done !== true) {
      result.status = 'incomplete'
      result.errorText = result.truncated
        ? `已读 ${result.bytes} 字节仍未看到完成标记（${spec.done.join(' / ')}）：回答太长或上游一直不收尾`
        : `流结束了却没看到完成标记（${spec.done.join(' / ')}）——多半是上游中途把连接掐断了`
      return result
    }
    result.status = result.firstByteMs > slowFirstByteMs ? 'slow' : 'ok'
    return result
  } catch (error) {
    const aborted = error?.name === 'AbortError'
    result.status = aborted ? 'timeout' : 'error'
    result.errorText = aborted
      ? `等待 ${seconds(timeoutMs)} 仍未完成` +
        (result.firstByteMs === undefined ? '，连首字节都没等到' : `（首字节 ${seconds(result.firstByteMs)} 已到达，之后卡住）`)
      : `${error?.name ?? 'Error'}: ${sanitize(error?.message ?? error)}${causeText(error)}`
    return result
  } finally {
    clearTimeout(timer)
    result.totalMs = Date.now() - started
  }
}

/**
 * 体检一条路由。
 *
 * 默认先发一次「限制输出长度」的请求（省配额）。有些端点不认 `max_tokens` /
 * `max_output_tokens` 这类参数，会直接回 4xx —— 那会被误判成「路由不可用」，
 * 所以遇到 4xx 会自动去掉长度上限再测一次，以第二次的结果为准（它更接近真实用法）。
 * 401/429 这类错误重测一次不花配额，代价可以忽略。
 *
 * @param options.maxOutputTokens - 探测请求的输出长度上限；`0` 表示一开始就不限。
 * @param options.retryWithoutCap - 遇到 4xx 是否去掉上限重测（默认 true）。
 * @param rest - 透传给单次尝试。
 * @returns 体检结果对象。
 */
export async function probeRoute({ maxOutputTokens = DEFAULT_PROBE_MAX_OUTPUT_TOKENS, retryWithoutCap = true, ...rest } = {}) {
  const first = await attemptOnce({ ...rest, maxOutputTokens })
  const is4xx = typeof first.httpStatus === 'number' && first.httpStatus >= 400 && first.httpStatus < 500
  if (!is4xx || !retryWithoutCap || maxOutputTokens === 0) return first
  const second = await attemptOnce({ ...rest, maxOutputTokens: 0 })
  if (second.httpStatus !== first.httpStatus) {
    second.note = `端点不接受「限制输出长度」的探测请求（HTTP ${first.httpStatus}），已去掉长度上限重测`
  }
  return second
}

/**
 * 逐条体检（串行，避免同时打爆一个中转端点）。
 *
 * @param options.routes - `{ [routeKey]: profile }`。
 * @param options.keys - `{ [routeKey]: apiKey }`。
 * @param options.onProgress - 每条测完回调一次（可用于日志）。
 * @param rest - 透传给 {@link probeRoute}。
 * @returns 结果数组，顺序与 routes 一致。
 */
export async function probeRoutes({ routes = {}, keys = {}, onProgress, ...rest } = {}) {
  const results = []
  for (const [routeKey, profile] of Object.entries(routes)) {
    const result = await probeRoute({ routeKey, profile, apiKey: keys[routeKey], ...rest })
    results.push(result)
    if (onProgress !== undefined) {
      try {
        onProgress(result)
      } catch {
        /* 回调出错不该影响体检 */
      }
    }
  }
  return results
}

const STATUS_LABEL = {
  ok: '✅ 可用',
  slow: '🐢 可用，但很慢',
  incomplete: '⚠️ 流没正常结束',
  timeout: '⏱️ 超时',
  error: '❌ 不可用',
  skipped: '⏭️ 未体检',
}

/** 秒数格式化：不到 10s 保留一位小数。 */
function seconds(ms) {
  if (ms === undefined) return '-'
  if (ms < 1000) return `${ms}ms`
  const value = ms / 1000
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}s`
}

/**
 * 把体检结果排成中文汇报。
 * @param results - {@link probeRoutes} 的结果。
 * @param options.timeoutMs - 用于说明单条上限。
 * @param options.source - 数据源路径说明。
 * @param options.maxOutputTokens - 探测请求的输出长度上限（说明「体检很省配额」）。
 * @returns 多行文本。
 */
export function formatProbeReport(results, { timeoutMs, source, maxOutputTokens } = {}) {
  const lines = []
  const counts = { ok: 0, slow: 0, incomplete: 0, timeout: 0, error: 0, skipped: 0 }
  for (const result of results) counts[result.status] = (counts[result.status] ?? 0) + 1
  lines.push(
    `🩺 cc-switch 路由体检：共 ${results.length} 条` +
      `（可用 ${counts.ok}，慢 ${counts.slow}，异常 ${counts.incomplete + counts.timeout + counts.error}）` +
      (timeoutMs === undefined ? '' : `，单条上限 ${seconds(timeoutMs)}`) +
      (maxOutputTokens > 0 ? `，每条只请求 ${maxOutputTokens} token 输出（省配额）` : ''),
  )
  if (source !== undefined) lines.push(`· 数据源：${source}`)
  if (results.length === 0) {
    lines.push('· 没有可体检的路由（先看看 action=list / skip-list）')
    return lines.join('\n')
  }
  for (const result of results) {
    lines.push(
      `· ${result.routeKey}（${result.displayName} / ${result.api ?? '?'} / 模型 ${result.model ?? '?'}）`,
    )
    lines.push(`    ${STATUS_LABEL[result.status] ?? result.status}：HTTP ${result.httpStatus ?? '-'}，首字节 ${seconds(result.firstByteMs)}，共 ${seconds(result.totalMs)}，${result.bytes} 字节`)
    if (result.errorText !== undefined) lines.push(`    ${result.errorText}`)
    if (result.note !== undefined) lines.push(`    ℹ️ ${result.note}`)
    if (result.httpStatus === 429) {
      lines.push('    提示：429 是账号配额/限流，不是接入配置的问题。等配额重置，或换一条**不同账号**的路由；')
      lines.push('    同一把 Key 生成的多条路由共用一份配额，在它们之间切换绕不开限流（status 里会提示哪些路由共用了 Key）。')
    }
    if (result.status === 'slow') {
      lines.push('    提示：首字节太久，对话时很容易被上游或网关掐断（表现为流读取失败）。可以换更快的路由，或给这条路由调大超时：')
      lines.push(`    overrides: { "${result.routeKey}": { timeoutMs: 600000, streamIdleTimeoutMs: 600000 } }`)
    }
  }
  return lines.join('\n')
}