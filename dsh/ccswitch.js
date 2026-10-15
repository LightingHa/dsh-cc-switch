/**
 * 读取 cc-switch 的数据。
 *
 * cc-switch v3 之前把供应商写在 `~/.cc-switch/config.json`；v3/v4 换成
 * SQLite（`~/.cc-switch/cc-switch.db`）。两条来源都支持，数据库优先。
 *
 * 读取失败（没装 cc-switch、数据库正被写入、版本不认识）一律返回结构化结果
 * 而不是抛异常，插件据此给用户可操作的原因。
 */

import { copyFileSync, existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

/** cc-switch 支持的 app 类型（v4.0.6 内嵌枚举，多写的会被忽略）。 */
export const KNOWN_APP_TYPES = [
  'claude',
  'claude-desktop',
  'codex',
  'gemini',
  'grokbuild',
  'opencode',
  'openclaw',
  'hermes',
  'pi',
  'mcode',
]

/** 默认的 cc-switch 主目录。 */
export function defaultCcSwitchDir(home = homedir()) {
  return path.join(home, '.cc-switch')
}

/** 默认数据库路径。 */
export function defaultDbPath(home = homedir()) {
  return path.join(defaultCcSwitchDir(home), 'cc-switch.db')
}

/** 旧版 JSON 配置路径。 */
export function defaultLegacyPath(home = homedir()) {
  return path.join(defaultCcSwitchDir(home), 'config.json')
}

/** 安全 JSON.parse。 */
function parseJson(text) {
  if (typeof text !== 'string' || text.trim() === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * cc-switch 数据库可能开着 WAL：只读打开遇到 `-wal` 时可能失败。
 * 这时把 db/-wal/-shm 复制到临时目录再读，绝不写回原文件。
 */
function openReadOnlyCopy(dbPath) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-cc-switch-'))
  const target = path.join(dir, 'cc-switch.db')
  copyFileSync(dbPath, target)
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(`${dbPath}${suffix}`)) {
      try {
        copyFileSync(`${dbPath}${suffix}`, `${target}${suffix}`)
      } catch {
        /* 复制快照的附属文件失败时不致命 */
      }
    }
  }
  return target
}

/** 载入 node:sqlite（Node ≥ 22.13 默认可用；缺的时候给出明确原因）。 */
async function loadSqlite() {
  try {
    const mod = await import('node:sqlite')
    return mod?.DatabaseSync
  } catch {
    return undefined
  }
}

/** 数据库最后修改时间；用于变更探测。 */
export function databaseStamp(dbPath) {
  try {
    const stat = statSync(dbPath)
    return `${stat.mtimeMs}:${stat.size}`
  } catch {
    return undefined
  }
}

/**
 * 从 SQLite 读原始供应商行。
 * @param dbPath - 数据库路径。
 * @returns 行数组、settings 表、以及按供应商聚合的使用过的模型名。
 */
export async function readDatabase(dbPath, { logger } = {}) {
  const DatabaseSync = await loadSqlite()
  if (DatabaseSync === undefined) {
    throw new Error(
      '当前 Node 运行时没有 node:sqlite，无法读取 cc-switch 数据库' +
        '（Node ≥ 22.13 默认可用；22.5–22.12 需要 --experimental-sqlite。DSH 自带的 Node 24 满足）',
    )
  }
  let db
  let ephemeral
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
  } catch (error) {
    logger?.debug?.(`[cc-switch] 只读打开失败，改用快照读取：${error?.message || error}`)
    ephemeral = openReadOnlyCopy(dbPath)
    db = new DatabaseSync(ephemeral, { readOnly: true })
  }
  try {
    const providers = db.prepare('SELECT * FROM providers').all()
    let settings = []
    try {
      settings = db.prepare('SELECT key, value FROM settings').all()
    } catch {
      settings = []
    }
    const usage = new Map()
    try {
      const rows = db
        .prepare('SELECT DISTINCT provider_id, app_type, request_model FROM proxy_request_logs WHERE request_model IS NOT NULL')
        .all()
      for (const row of rows) {
        const model = typeof row.request_model === 'string' ? row.request_model.trim() : ''
        if (!model || model.startsWith('_')) continue
        const key = `${row.app_type ?? ''}|${row.provider_id ?? ''}`
        if (!usage.has(key)) usage.set(key, new Set())
        usage.get(key).add(model)
      }
    } catch {
      /* 早期版本没有这张表 */
    }
    return { rows: providers, settings, usage }
  } finally {
    try {
      db.close()
    } catch {
      /* 关闭失败无影响 */
    }
  }
}

/**
 * 读取旧版 JSON 配置（`~/.cc-switch/config.json`）。
 * 结构：`{ providers: { claude: {...} | [ {...} ], codex: {...} }, current: {...} }`
 */
export function readLegacy(filePath) {
  const raw = parseJson(readFileSync(filePath, 'utf8'))
  const rows = []
  const current = raw?.current ?? {}
  const providers = raw?.providers ?? {}
  for (const [appType, value] of Object.entries(providers)) {
    const list = Array.isArray(value) ? value : [value]
    for (const entry of list) {
      if (entry === null || typeof entry !== 'object') continue
      const id = String(entry.id ?? entry.name ?? `${appType}-${rows.length}`)
      rows.push({
        id,
        app_type: appType,
        name: entry.name ?? id,
        settings_config: JSON.stringify(entry.settingsConfig ?? entry.settings_config ?? {}),
        website_url: entry.websiteUrl ?? entry.website_url ?? null,
        category: entry.category ?? null,
        meta: JSON.stringify(entry.meta ?? {}),
        is_current: current[appType] === id ? 1 : 0,
      })
    }
  }
  return { rows, settings: [], usage: new Map() }
}

/** 展示名不能为空：pi-ai 会拒绝 `displayName: ""` 的路由，整次写入都会失败。 */
export function displayNameOf(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
    if (typeof candidate === 'number') return String(candidate)
  }
  return '未命名供应商'
}

/** 单条原始行 -> 宽松的记录对象（字段名在不同版本间有差异，全部兜住）。 */
export function normalizeRawRow(row, { usage } = {}) {
  const appType = String(row.app_type ?? row.appType ?? 'unknown')
  const id = String(row.id ?? '')
  const settingsConfig = row.settings_config ?? row.settingsConfig
  const config = typeof settingsConfig === 'string' ? parseJson(settingsConfig) ?? {} : settingsConfig ?? {}
  const metaRaw = row.meta
  const meta = typeof metaRaw === 'string' ? parseJson(metaRaw) ?? {} : metaRaw ?? {}
  const usageKey = `${appType}|${id}`
  const usedModels = usage?.get?.(usageKey)
  return {
    id,
    appType,
    name: displayNameOf(row.name, id, appType),
    category: row.category ?? undefined,
    websiteUrl: row.website_url ?? row.websiteUrl ?? undefined,
    providerType: row.provider_type ?? undefined,
    notes: row.notes ?? undefined,
    isCurrent: Number(row.is_current ?? row.isCurrent ?? 0) === 1,
    config,
    meta: meta && typeof meta === 'object' ? meta : {},
    usedModels: usedModels ? [...usedModels] : [],
  }
}

/**
 * 解析 cc-switch 来源路径：显式配置 > `CC_SWITCH_DB` / `CC_SWITCH_HOME` > 默认目录。
 * @returns 数据库路径（可能不存在）与旧版 JSON 路径。
 */
export function resolvePaths({ dbPath = '', home = homedir(), env = process.env } = {}) {
  const ccHome = env.CC_SWITCH_HOME && env.CC_SWITCH_HOME.trim() !== '' ? env.CC_SWITCH_HOME.trim() : defaultCcSwitchDir(home)
  const database = dbPath && dbPath.trim() !== ''
    ? dbPath.trim()
    : env.CC_SWITCH_DB && env.CC_SWITCH_DB.trim() !== ''
      ? env.CC_SWITCH_DB.trim()
      : path.join(ccHome, 'cc-switch.db')
  return { database, legacy: path.join(ccHome, 'config.json'), dir: ccHome }
}

/**
 * 读取并归一 cc-switch 的全部供应商。
 * @param options.dbPath - 显式数据库路径（留空自动探测）。
 * @param options.appTypes - 需要导入的 app 类型列表；留空表示全部。
 * @returns `{ source, path, records, appTypes, settings, warning }`
 */
export async function readProviders({ dbPath = '', appTypes = KNOWN_APP_TYPES, home = homedir(), env = process.env, logger } = {}) {
  const paths = resolvePaths({ dbPath, home, env })
  const wanted = new Set((appTypes.length > 0 ? appTypes : KNOWN_APP_TYPES).map((t) => String(t).trim()))
  let payload
  let source
  let usedPath
  let warning
  if (existsSync(paths.database)) {
    payload = await readDatabase(paths.database, { logger })
    source = 'database'
    usedPath = paths.database
  } else if (existsSync(paths.legacy)) {
    payload = readLegacy(paths.legacy)
    source = 'legacy-json'
    usedPath = paths.legacy
    warning = '未找到 cc-switch.db，已回退读取旧版 config.json（不含 v4 的 openclaw/mcode 等类型）'
  } else {
    return {
      source: 'missing',
      path: paths.database,
      records: [],
      appTypes: [],
      settings: {},
      warning: `未找到 cc-switch 数据：${paths.database}`,
    }
  }
  const settings = {}
  for (const row of payload.settings ?? []) {
    if (row && typeof row.key === 'string') settings[row.key] = row.value
  }
  const records = []
  for (const row of payload.rows ?? []) {
    const record = normalizeRawRow(row, { usage: payload.usage })
    if (!wanted.has(record.appType)) continue
    records.push(record)
  }
  const seen = new Map()
  for (const record of records) {
    seen.set(record.appType, (seen.get(record.appType) ?? 0) + 1)
  }
  return {
    source,
    path: usedPath,
    records,
    appTypes: [...seen.keys()].sort(),
    settings,
    warning,
  }
}