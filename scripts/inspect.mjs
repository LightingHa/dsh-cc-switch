/**
 * 离线自检：不启动 DSH，直接读 cc-switch 并打印「会写入什么」。
 *
 *   node scripts/inspect.mjs [--json] [--db <路径>] [--app-types a,b]
 *
 * 用来确认映射是否符合预期，或者排查看不懂的供应商为什么没被导入。
 */

import { readProviders, resolvePaths } from '../dsh/ccswitch.js'
import { buildPlan } from '../dsh/plan.js'
import { selectRecords } from '../dsh/index.js'
import { maskKey } from '../dsh/index.js'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const value = (name) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] : undefined
}

const dbPath = value('db') ?? ''
const appTypes = (value('app-types') ?? 'claude,claude-desktop,codex,openclaw,mcode,pi,opencode,hermes,grokbuild,gemini')
  .split(/[,;，；\s]+/)
  .filter(Boolean)

const paths = resolvePaths({ dbPath })
const source = await readProviders({ dbPath, appTypes })
const records = selectRecords(source.records, { appTypes, include: '', exclude: '' })
const plan = buildPlan({ records, config: { routePrefix: 'ccswitch', onConflict: 'skip', pruneOwnedRoutes: true } })

if (flag('json')) {
  console.log(JSON.stringify({ source: source.source, path: source.path, appTypes: source.appTypes, plan: { ...plan, credentials: plan.credentials.map((entry) => ({ ...entry, value: maskKey(entry.value) })) } }, null, 2))
  process.exit(0)
}

console.log(`cc-switch 数据源：${source.source}  ${source.path ?? '(未找到)'}`)
console.log(`探测路径：${paths.database}`)
if (source.warning) console.log(`提示：${source.warning}`)
console.log(`app 类型：${source.appTypes.join(', ') || '(无)'}    供应商总数：${source.records.length}    本次选中：${records.length}`)
console.log(`\n将要写入 llm-pi-ai 的路由（${plan.managedRoutes.length} 条）：`)
for (const key of plan.managedRoutes) {
  const route = plan.routes[key]
  const info = plan.sources[key]
  console.log(`\n  ● ${key}`)
  console.log(`     来源：cc-switch [${info.appType}] ${info.name}`)
  console.log(`     协议：${route.api}    端点：${route.baseURL}`)
  if (route.apiKeyEnv) console.log(`     凭据：${route.apiKeyEnv} = ${maskKey(plan.credentials.find((entry) => entry.ref === route.apiKeyEnv)?.value ?? '')}`)
  console.log(`     模型(${route.models.length})：${route.models.map((model) => model.id).join(', ')}`)
}
if (plan.skipped.length > 0) {
  console.log(`\n未导入（${plan.skipped.length}）：`)
  for (const entry of plan.skipped) console.log(`  ✗ [${entry.appType}] ${entry.name}：${entry.reason}`)
}
console.log('\n以上只是预演，本脚本不会修改任何配置。')