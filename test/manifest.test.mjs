// dsh-cc-switch 清单契约测试：验证包真的能被 DSH 的 profile 加载器识别。
//
// 加载器（@deepseek-ai/dsh-app-boot）的规则：
//   · profile 的 `dsh.profile.bundles` 里列出包名；
//   · 该包的 package.json 必须声明 `dsh.bundle.patch`（字符串或字符串数组）；
//   · 补丁文件是一个 YAML 数组，用 `insert` 把插件条目挂进 cordis 树；
//   · 如果声明了 @deepseek-ai/dsh* 的 peerDependencies，必须满足当前运行时版本，
//     否则整包会被跳过。
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import * as yaml from 'js-yaml'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageDir = path.resolve(here, '..')
const manifest = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'))

/** 复刻 dsh-app-boot 的 bundlePatchFiles()。 */
function bundlePatchFiles(bundle) {
  const declared = typeof bundle.patch === 'string' ? [bundle.patch] : bundle.patch
  if (!Array.isArray(declared) || !declared.every((file) => typeof file === 'string')) {
    throw new Error('dsh.bundle.patch must be a file path or a list of file paths')
  }
  return declared
}

test('清单：包名、入口、类型都符合 DSH 插件约定', () => {
  assert.equal(manifest.name, 'dsh-cc-switch')
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
  assert.equal(manifest.type, 'module')
  assert.ok(existsSync(path.join(packageDir, manifest.main)), `入口不存在：${manifest.main}`)
  assert.ok(existsSync(path.join(packageDir, manifest.exports['.'])))
  // 随包发布的内容必须包含补丁与入口
  for (const required of ['dsh', 'cordis.patch.yml']) {
    assert.ok(manifest.files.includes(required), `files 里缺少 ${required}`)
  }
})

test('清单：dsh.bundle.patch 能解析到真实文件', () => {
  const bundle = manifest.dsh?.bundle
  assert.ok(bundle !== undefined, '缺少 dsh.bundle 声明，加载器不会把它当 bundle')
  const files = bundlePatchFiles(bundle)
  assert.ok(files.length > 0)
  for (const file of files) {
    const resolved = path.resolve(packageDir, file)
    assert.ok(resolved.startsWith(packageDir), `补丁文件跑出包目录：${file}`)
    assert.ok(existsSync(resolved), `补丁文件不存在：${file}`)
  }
})

test('清单：补丁是合法的 YAML，且用 insert 挂载插件条目', () => {
  const files = bundlePatchFiles(manifest.dsh.bundle)
  const entries = yaml.load(readFileSync(path.join(packageDir, files[0]), 'utf8'))
  assert.ok(Array.isArray(entries), '补丁顶层必须是 YAML 数组')
  const inserted = []
  for (const entry of entries) {
    if (Array.isArray(entry?.insert)) inserted.push(...entry.insert)
  }
  assert.equal(inserted.length, 1, '本插件只应该挂一个条目')
  const [entry] = inserted
  assert.equal(entry.id, 'cc-switch')
  assert.equal(entry.name, 'dsh-cc-switch', 'name 必须是可被 Node 解析的包名')
  // 条目 id 就是 settings 命名空间；不能被配成别的名字
  assert.equal(typeof entry.id, 'string')
})

test('清单：没有会让加载器跳过本包的不兼容 peerDependencies', () => {
  const peers = manifest.peerDependencies ?? {}
  for (const [name, range] of Object.entries(peers)) {
    if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue
    assert.equal(range, '*', `声明了会被版本检查的 peer：${name}@${range}；要么删掉，要么用 *`)
  }
})

test('安装：桌面 profile 已把本包列为依赖与 bundle，且补丁可解析', (t) => {
  // DSH_HOME 就是 harness 主目录（通常以 .dsh 结尾）；没有它时退回用户目录。
  const dshHome = process.env.DSH_HOME ?? (process.env.USERPROFILE ?? process.env.HOME) + path.sep + '.dsh'
  const profileDir = process.env.DSH_PROFILE_DIR ?? path.join(dshHome, 'profiles', process.env.DSH_PROFILE ?? 'desktop')
  if (!existsSync(path.join(profileDir, 'package.json'))) {
    t.skip(`本机没有 ${profileDir}`)
    return
  }
  const profile = JSON.parse(readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
  assert.equal(profile.dependencies?.['dsh-cc-switch'], `file:${packageDir.replace(/\\/g, '/')}`)
  assert.ok(profile.dsh?.profile?.bundles?.includes('dsh-cc-switch'), 'bundles 里没有 dsh-cc-switch')

  // 加载器按包名解析：先 dsh 安装目录，再 profile 目录
  const require = createRequire(path.join(profileDir, 'noop.cjs'))
  const resolved = require.resolve('dsh-cc-switch/package.json')
  assert.ok(existsSync(resolved), `profile 里解析不到 dsh-cc-switch：${resolved}`)
  const installed = JSON.parse(readFileSync(resolved, 'utf8'))
  const installedFiles = bundlePatchFiles(installed.dsh.bundle)
  const installedDir = path.dirname(resolved)
  for (const file of installedFiles) {
    const patchPath = path.resolve(installedDir, file)
    assert.ok(existsSync(patchPath), `已安装副本缺少补丁：${patchPath}`)
    const entries = yaml.load(readFileSync(patchPath, 'utf8'))
    const inserted = entries.flatMap((entry) => (Array.isArray(entry?.insert) ? entry.insert : []))
    assert.equal(inserted[0]?.name, 'dsh-cc-switch', '已安装副本的补丁内容不对（可能需要重跑 pnpm install）')
  }

  // 已安装副本必须和源码一致 —— pnpm 的 file: 依赖是快照，改完源码要重装
  const sameEntry = readFileSync(path.join(installedDir, 'dsh/index.js'), 'utf8') === readFileSync(path.join(packageDir, 'dsh/index.js'), 'utf8')
  assert.ok(sameEntry, 'profile 里的副本已过期，请在 profile 目录重跑 pnpm install')
})

// 发布契约：awesome-dsh-plugin 收录 + npm 发布所需的元数据。
// 规则来源：awesome-dsh-plugin/contributing.md 与 dshmarket 的目录读取逻辑。
test('发布：npm 与市场收录所需元数据齐全', () => {
  assert.equal(manifest.author, 'LightingHa')
  assert.equal(manifest.license, 'MIT')
  assert.equal(manifest.publishConfig?.access, 'public', '公共 npm 需要 publishConfig.access=public')
  assert.ok(manifest.keywords.includes('dsh-plugin'), 'keywords 里要有 dsh-plugin')

  // 仓库名要与 npm 包名一致，市场才会自动采集下载量映射
  assert.equal(path.basename(manifest.repository.url).replace(/\.git$/, ''), manifest.name)

  // 宿主版本用 engines.dsh 声明（市场据此显示兼容性）；
  // 不声明 @deepseek-ai/dsh-* peer，否则版本不满足时整包会被加载器跳过
  assert.match(manifest.engines?.dsh ?? '', /^>=\d+\.\d+\.\d+/, 'engines.dsh 要用 semver 范围')
  // 读 cc-switch 的 SQLite 库要用 node:sqlite：22.13 起才不需要 --experimental-sqlite
  assert.match(manifest.engines?.node ?? '', /^>=22\.(1[3-9]|[2-9]\d)/, 'engines.node 不能低于 22.13')
  assert.equal(manifest.peerDependencies, undefined, '本项目刻意不声明 peerDependencies')

  // 市场卡片元数据
  assert.equal(manifest.dsh?.catalog?.category, 'model')
  assert.ok(manifest.dsh.catalog.summary.en.length > 20)
  assert.ok(manifest.dsh.catalog.summary.zh.length > 10)
  assert.ok(manifest.dsh.catalog.capabilities.length > 0)

  for (const file of ['LICENSE', 'CHANGELOG.md']) {
    assert.ok(existsSync(path.join(packageDir, file)), `缺少 ${file}`)
    assert.ok(manifest.files.includes(file), `files 里缺少 ${file}`)
  }
})

test('发布：市场投稿条目符合 awesome-dsh-plugin 的格式要求', () => {
  const entryPath = path.join(packageDir, 'marketplace', 'LightingHa__dsh-cc-switch.yml')
  assert.ok(existsSync(entryPath), '缺少投稿条目文件（市场收录用）')
  const raw = readFileSync(entryPath, 'utf8')
  const entry = yaml.load(raw)

  assert.equal(entry.url, 'https://github.com/LightingHa/dsh-cc-switch')
  assert.equal(entry.name, 'LightingHa/dsh-cc-switch')
  assert.equal(entry.category, 'model', 'cc-switch 属于 Models & Providers 分类')
  assert.ok(entry.description.en.endsWith('.'), '英文描述要以句号结尾')
  assert.ok(entry.description.zh.endsWith('。'), '中文描述要以句号结尾')
  // 描述里有 ": " 时 YAML 会把它当嵌套键，必须加引号
  assert.match(raw, /^\s*en:\s*"/m, '含 ": " 的描述必须加引号')
  // npm 映射由 registry 自动采集，手写会被校验拒绝
  assert.equal(entry.npm, undefined, '条目里不能手写 npm 字段')
  assert.equal(path.basename(entryPath), 'LightingHa__dsh-cc-switch.yml', '文件名必须是 <owner>__<repo>.yml')
})