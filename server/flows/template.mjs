// Freilauf flows — pure helpers: {{path}} templates, dotted-path lookup and the
// condition operators. No I/O, no database — this is what the unit tests cover.

/** Read `a.b.0.c` from an object; undefined when any segment is missing. */
export function getPath(obj, path) {
  if (path === '' || path == null) return obj
  let cur = obj
  for (const seg of String(path).split('.')) {
    if (cur == null) return undefined
    cur = cur[seg]
  }
  return cur
}

function toText(v) {
  if (v === undefined || v === null) return ''
  if (typeof v === 'object') return JSON.stringify(v, null, 2)
  return String(v)
}

/**
 * Replace every `{{ path }}` with the value from the context. Objects render
 * as pretty JSON, missing values as an empty string — a template must never
 * throw over a variable that a previous step did not set.
 * `{{ path | default: text }}` falls back to `text` when the value is empty.
 */
export function render(template, ctx) {
  return String(template ?? '').replace(/\{\{\s*([^}|]+?)\s*(?:\|\s*default:\s*([^}]*?)\s*)?\}\}/g, (_, path, fallback) => {
    const v = getPath(ctx, path.trim())
    const s = toText(v)
    return s === '' && fallback !== undefined ? fallback : s
  })
}

/** Whole-value lookup: `{{vars.x}}` alone returns the value itself (keeps type), anything else renders as text. */
export function resolve(template, ctx) {
  const m = String(template ?? '').trim().match(/^\{\{\s*([^}|]+?)\s*\}\}$/)
  if (m) return getPath(ctx, m[1].trim())
  return render(template, ctx)
}

export const OPS = ['eq', 'neq', 'contains', 'not_contains', 'empty', 'not_empty', 'truthy', 'falsy', 'gt', 'lt', 'gte', 'lte', 'matches']

const truthy = (v) => {
  if (typeof v === 'string') return !['', '0', 'false', 'no', 'off', 'null', 'undefined'].includes(v.trim().toLowerCase())
  if (Array.isArray(v)) return v.length > 0
  return !!v
}
const num = (v) => { const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? '').trim()); return Number.isFinite(n) ? n : NaN }
const text = (v) => toText(v)

/** Evaluate `left <op> right`; strings compare case-insensitively after trim. */
export function compare(left, op, right) {
  const l = text(left).trim(), r = text(right).trim()
  switch (op) {
    case 'eq': return l.toLowerCase() === r.toLowerCase()
    case 'neq': return l.toLowerCase() !== r.toLowerCase()
    case 'contains': return l.toLowerCase().includes(r.toLowerCase())
    case 'not_contains': return !l.toLowerCase().includes(r.toLowerCase())
    case 'empty': return l === ''
    case 'not_empty': return l !== ''
    case 'truthy': return truthy(left)
    case 'falsy': return !truthy(left)
    case 'gt': return num(left) > num(right)
    case 'lt': return num(left) < num(right)
    case 'gte': return num(left) >= num(right)
    case 'lte': return num(left) <= num(right)
    case 'matches': try { return new RegExp(r, 'i').test(l) } catch { return false }
    default: return false
  }
}

/** Set `vars.a.b` = value (creates intermediate objects). */
export function setPath(obj, path, value) {
  const segs = String(path).split('.').filter(Boolean)
  if (!segs.length) return
  let cur = obj
  for (const seg of segs.slice(0, -1)) {
    if (cur[seg] == null || typeof cur[seg] !== 'object') cur[seg] = {}
    cur = cur[seg]
  }
  cur[segs[segs.length - 1]] = value
}

/**
 * A list out of whatever a template produced — the input of the "for each" step.
 * An array stays as it is, a JSON list is parsed, any other text becomes one item
 * per line (that is what an LLM field of type list or a report enumeration looks
 * like); a single object/number becomes a one-element list. Never throws.
 */
export function toList(v) {
  if (Array.isArray(v)) return v
  if (v === undefined || v === null) return []
  if (typeof v === 'object') return [v]
  const s = String(v).trim()
  if (!s) return []
  if (s.startsWith('[')) {
    try { const j = JSON.parse(s); if (Array.isArray(j)) return j } catch { /* not JSON — treat as text */ }
  }
  return s.split('\n').map(x => x.trim()).filter(Boolean)
}

/** Variable name for a step output: letters, digits, underscore; fallback given by the step. */
export function varName(s, fallback) {
  const v = String(s ?? '').trim().replace(/[^A-Za-z0-9_]/g, '_')
  return v || fallback
}
