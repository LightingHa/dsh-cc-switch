/**
 * 清单文件：记录本插件上一次写进 llm-pi-ai 的路由键与凭据引用。
 *
 * 有它才敢做「撤销」：只有本插件自己写过的键才会被清理，用户手写或其它插件
 * 写入的供应商永远不会被误删。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** 默认清单路径：`$DSH_HOME/cc-switch-state.json`。 */
export function statePathFor({ statePath = '', home = homedir(), env = process.env } = {}) {
  if (typeof statePath === 'string' && statePath.trim() !== '') return statePath.trim()
  const dshHome = env.DSH_HOME && env.DSH_HOME.trim() !== '' ? env.DSH_HOME.trim() : path.join(home, '.dsh')
  return path.join(dshHome, 'cc-switch-state.json')
}

const EMPTY = { version: 1, routes: [], credentials: [], updatedAt: null, source: null }

/** 读取清单；不存在或损坏时返回空清单。 */
export function readState(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return {
      version: 1,
      routes: Array.isArray(parsed?.routes) ? parsed.routes.filter((key) => typeof key === 'string') : [],
      credentials: Array.isArray(parsed?.credentials) ? parsed.credentials.filter((ref) => typeof ref === 'string') : [],
      updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : null,
      source: typeof parsed?.source === 'string' ? parsed.source : null,
    }
  } catch {
    return { ...EMPTY }
  }
}

/** 原子写入清单。 */
export function writeState(file, state) {
  const payload = {
    version: 1,
    routes: [...new Set(state.routes ?? [])].sort(),
    credentials: [...new Set(state.credentials ?? [])].sort(),
    updatedAt: new Date().toISOString(),
    source: state.source ?? null,
  }
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
  return payload
}

/** 清单是否已经反映给定的路由/凭据集合。 */
export function stateMatches(state, routes, credentials) {
  const a = [...new Set(state.routes ?? [])].sort()
  const b = [...new Set(routes ?? [])].sort()
  if (a.length !== b.length || a.some((key, index) => key !== b[index])) return false
  const c = [...new Set(state.credentials ?? [])].sort()
  const d = [...new Set(credentials ?? [])].sort()
  return c.length === d.length && c.every((ref, index) => ref === d[index])
}