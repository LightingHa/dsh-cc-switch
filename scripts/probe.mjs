#!/usr/bin/env node
/**
 * 离线体检：不启动 DSH，直接实测 cc-switch 里每条路由「能不能跑通、首字节多久」。
 *
 *   node scripts/probe.mjs                          # 体检全部可直连的供应商
 *   node scripts/probe.mjs --app-types codex        # 只体检 codex
 *   node scripts/probe.mjs --timeout 240000         # 单条最多等 4 分钟
 *   node scripts/probe.mjs --json                   # 机器可读输出
 *
 * 退出码：0=全部可用（含「慢」），2=有路由异常，1=没读到 cc-switch 数据。
 * Key 只在请求头里用，不会出现在任何输出中。
 */
import { readProviders } from '../dsh/ccswitch.js'
import { convertRecord } from '../dsh/convert.js'
import { formatProbeReport, probeRoutes } from '../dsh/probe.js'

const argv = process.argv.slice(2)
const valueOf = (name) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] : undefined
}
const timeoutMs = Number(valueOf('timeout') ?? 180_000)
const appTypes = (valueOf('app-types') ?? '')
  .split(/[,;，；\s]+/)
  .map((item) => item.trim())
  .filter((item) => item !== '')

const source = await readProviders({ dbPath: valueOf('db') ?? '', appTypes })
if (source.source === 'missing') {
  console.error(source.warning ?? '没有找到 cc-switch 数据')
  process.exit(1)
}
console.error(`数据源：${source.source} (${source.path})，供应商 ${source.records.length} 家`)

const routes = {}
const keys = {}
for (const record of source.records) {
  const { variants, problems } = convertRecord(record)
  const usable = variants.filter((variant) => variant.usable)
  if (usable.length === 0) {
    console.error(`· 跳过 [${record.appType}] ${record.name}：${problems.join('；') || '没有可直连的端点'}`)
    continue
  }
  for (const variant of usable) {
    routes[variant.routeKey] = variant.profile
    if (typeof variant.apiKey === 'string' && variant.apiKey !== '') keys[variant.routeKey] = variant.apiKey
  }
}

console.error(`开始体检 ${Object.keys(routes).length} 条路由（单条上限 ${Math.round(timeoutMs / 1000)}s，串行）…`)
const results = await probeRoutes({
  routes,
  keys,
  timeoutMs,
  onProgress: (result) => console.error(`  … ${result.routeKey}：${result.status}（首字节 ${result.firstByteMs ?? '-'}ms）`),
})

if (argv.includes('--json')) {
  console.log(JSON.stringify(results, null, 2))
} else {
  console.log(formatProbeReport(results, { timeoutMs, source: `${source.source} (${source.path})` }))
}

const bad = results.filter((result) => result.status === 'error' || result.status === 'timeout' || result.status === 'incomplete')
process.exit(bad.length > 0 ? 2 : 0)