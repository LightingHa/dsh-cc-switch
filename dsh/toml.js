/**
 * 极小 TOML 读取器 —— 只为解析 cc-switch 里 Codex 供应商的 `config` 字符串。
 *
 * 覆盖 Codex `config.toml` 实际用到的语法子集：
 *   - 注释（#），字符串内的 # 不算注释
 *   - `key = value`、`a.b.c = value`（点号键）
 *   - `[table]`、`[table.sub]`、`[[array.of.tables]]`
 *   - 基本字符串 "..."（含 \n \t \" \\ \uXXXX 转义）、字面字符串 '...'、
 *     多行字符串 """...""" 与 '''...'''
 *   - 整数 / 浮点（允许 1_000 分隔）/ 布尔 / 数组（可嵌套、可跨行）/ 内联表
 *
 * 解析不出来的值按裸字符串原样返回，绝不抛异常：这个读取器的失败不应该
 * 让整条 cc-switch 供应商导入流程中断。
 */

/** 去掉不在字符串里的注释。 */
function stripComments(source) {
  let out = ''
  let quote = null // '"' | "'" | null
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    if (quote === null) {
      if (ch === '"' || ch === "'") {
        // 判断是否为多行字符串起始
        const triple = source.slice(i, i + 3)
        if (triple === '"""' || triple === "'''") {
          quote = triple
          out += triple
          i += 2
          continue
        }
        quote = ch
        out += ch
        continue
      }
      if (ch === '#') {
        while (i < source.length && source[i] !== '\n') i += 1
        out += '\n'
        continue
      }
      out += ch
      continue
    }
    if (quote.length === 3) {
      if (source.slice(i, i + 3) === quote) {
        out += quote
        i += 2
        quote = null
        continue
      }
      out += ch
      continue
    }
    if (ch === '\\') {
      out += ch + (source[i + 1] ?? '')
      i += 1
      continue
    }
    if (ch === quote) quote = null
    out += ch
  }
  return out
}

/** 按顶层换行切成逻辑语句（字符串与括号内的换行不算）。 */
function logicalStatements(source) {
  const statements = []
  let buf = ''
  let depth = 0
  let quote = null
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    if (quote !== null) {
      if (quote.length === 3) {
        if (source.slice(i, i + 3) === quote) {
          buf += quote
          i += 2
          quote = null
          continue
        }
      } else if (ch === '\\' && quote === '"') {
        buf += ch + (source[i + 1] ?? '')
        i += 1
        continue
      } else if (ch === quote) {
        quote = null
      } else if (ch === '\n') {
        // 单行字符串里出现换行：非法 TOML，容忍并按普通字符处理
        buf += ' '
        continue
      }
      buf += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      const triple = source.slice(i, i + 3)
      quote = triple === '"""' || triple === "'''" ? triple : ch
      buf += quote.length === 3 ? triple : ch
      if (quote.length === 3) i += 2
      continue
    }
    if (ch === '[' || ch === '{') depth += 1
    if (ch === ']' || ch === '}') depth = Math.max(0, depth - 1)
    if (ch === '\n' && depth === 0) {
      statements.push(buf)
      buf = ''
      continue
    }
    buf += ch
  }
  if (buf.trim()) statements.push(buf)
  return statements
}

/** 解析 `a.b."c d"` 形式的键路径。 */
function parseKeyPath(text) {
  const parts = []
  let buf = ''
  let quote = null
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote !== null) {
      if (ch === quote) {
        quote = null
        continue
      }
      buf += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '.') {
      parts.push(buf.trim())
      buf = ''
      continue
    }
    buf += ch
  }
  parts.push(buf.trim())
  return parts.filter((part) => part.length > 0)
}

/** 找到不在字符串/括号内的第一个 `=`。 */
function findTopLevelEquals(text) {
  let quote = null
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote !== null) {
      if (ch === '\\' && quote === '"') {
        i += 1
        continue
      }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '=') return i
  }
  return -1
}

/** 按顶层逗号切分数组/内联表元素。 */
function splitTopLevel(text) {
  const parts = []
  let buf = ''
  let depth = 0
  let quote = null
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote !== null) {
      if (ch === '\\' && quote === '"') {
        buf += ch + (text[i + 1] ?? '')
        i += 1
        continue
      }
      if (ch === quote) quote = null
      buf += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      buf += ch
      continue
    }
    if (ch === '[' || ch === '{') depth += 1
    if (ch === ']' || ch === '}') depth -= 1
    if (ch === ',' && depth === 0) {
      parts.push(buf)
      buf = ''
      continue
    }
    buf += ch
  }
  if (buf.trim()) parts.push(buf)
  return parts
}

const ESCAPES = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' }

function unescapeBasic(text) {
  return text.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (match, tail) => {
    if (tail[0] === 'u' || tail[0] === 'U') {
      const code = Number.parseInt(tail.slice(1), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return ESCAPES[tail] ?? tail
  })
}

/** 解析一个 TOML 值；无法识别时返回去掉首尾空白的裸字符串。 */
export function parseTomlValue(raw) {
  const text = raw.trim()
  if (text === '') return ''
  if (text.startsWith('"""') && text.endsWith('"""') && text.length >= 6) {
    // 多行基本字符串：忽略紧随起始定界符的换行
    return unescapeBasic(text.slice(3, -3).replace(/^\r?\n/, ''))
  }
  if (text.startsWith("'''") && text.endsWith("'''") && text.length >= 6) {
    return text.slice(3, -3).replace(/^\r?\n/, '')
  }
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    return unescapeBasic(text.slice(1, -1))
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
    return text.slice(1, -1)
  }
  if (text.startsWith('[') && text.endsWith(']')) {
    const inner = text.slice(1, -1)
    if (inner.trim() === '') return []
    return splitTopLevel(inner).map((part) => parseTomlValue(part))
  }
  if (text.startsWith('{') && text.endsWith('}')) {
    const out = {}
    for (const part of splitTopLevel(text.slice(1, -1))) {
      const eq = findTopLevelEquals(part)
      if (eq < 0) continue
      const path = parseKeyPath(part.slice(0, eq))
      if (path.length === 0) continue
      assign(out, path, parseTomlValue(part.slice(eq + 1)))
    }
    return out
  }
  if (text === 'true') return true
  if (text === 'false') return false
  if (/^[+-]?(\d[\d_]*)(\.\d[\d_]*)?([eE][+-]?\d+)?$/.test(text)) {
    const cleaned = text.replace(/_/g, '')
    const num = Number(cleaned)
    if (Number.isFinite(num)) return num
  }
  return text
}

function ensureTable(root, path) {
  let node = root
  for (const key of path) {
    if (typeof node[key] !== 'object' || node[key] === null || Array.isArray(node[key])) node[key] = {}
    node = node[key]
  }
  return node
}

function assign(node, path, value) {
  let target = node
  for (const key of path.slice(0, -1)) {
    if (typeof target[key] !== 'object' || target[key] === null || Array.isArray(target[key])) target[key] = {}
    target = target[key]
  }
  target[path[path.length - 1]] = value
}

/**
 * 解析 TOML 文本。
 * @param source - TOML 文本。
 * @returns 普通对象；输入非法也返回已解析出的部分。
 */
export function parseToml(source) {
  const root = {}
  if (typeof source !== 'string' || source.trim() === '') return root
  let table = root
  for (const statement of logicalStatements(stripComments(source))) {
    const line = statement.trim()
    if (line === '') continue
    if (line.startsWith('[[')) {
      const close = line.lastIndexOf(']]')
      if (close < 0) continue
      const path = parseKeyPath(line.slice(2, close))
      if (path.length === 0) continue
      const parent = ensureTable(root, path.slice(0, -1))
      const key = path[path.length - 1]
      if (!Array.isArray(parent[key])) parent[key] = []
      const entry = {}
      parent[key].push(entry)
      table = entry
      continue
    }
    if (line.startsWith('[')) {
      const close = line.lastIndexOf(']')
      if (close < 0) continue
      const path = parseKeyPath(line.slice(1, close))
      if (path.length === 0) continue
      table = ensureTable(root, path)
      continue
    }
    const eq = findTopLevelEquals(line)
    if (eq < 0) continue
    const path = parseKeyPath(line.slice(0, eq))
    if (path.length === 0) continue
    assign(table, path, parseTomlValue(line.slice(eq + 1)))
  }
  return root
}