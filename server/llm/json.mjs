// Freilauf — tolerant JSON extraction and repair for model answers.
//
// A model that has no native structured output does what it was trained on: it
// wraps the JSON in a markdown fence, writes "Sure, here is the JSON:" in front
// of it, forgets a quote around a key, or leaves a trailing comma behind. Every
// one of those answers is usable — but only if somebody is willing to look.
// That is this module, and nothing else: it turns a model's text into a value
// or says honestly that it could not.
//
// Two rules it is built on:
//
//   1. **Never eval.** Not `eval`, not `new Function`, not a `require('vm')`.
//      This text comes from a remote model; running it is the one mistake that
//      cannot be taken back.
//   2. **Never a regex for the balanced scan.** A `}` inside a string value
//      closes nothing, and no regular expression knows that. The scanner below
//      is thirty lines and it is right; a regex would be three lines and wrong
//      on the first report that contains a brace in a sentence.
//
// The module is pure: no I/O, no timers, no imports from the rest of the repo.
// That is deliberate — it makes it trivially unit-testable, and it is the layer
// every LLM call in the hub depends on.

/**
 * Which characters may close a string that opened with a given character.
 * A model that uses typographic quotes usually pairs them (“ … ”), but not
 * always — so an opener also accepts itself as its own closer.
 */
const CLOSERS = {
  '"': '"',
  "'": "'",
  '\u201c': '\u201d\u201c',   // “ closed by ” (or another “)
  '\u201d': '\u201d\u201c',   // ” used as an opener
  '\u2018': '\u2019\u2018',   // ‘ closed by ’
  '\u2019': '\u2019\u2018',   // ’ used as an opener
}

/** Valid JSON escape characters after a backslash. */
const JSON_ESCAPES = '"\\/bfnrtu'

const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/
const IDENT = /^-?[A-Za-z_$][A-Za-z0-9_$]*/

/** How much of a previous answer a candidate list may cost us. */
const MAX_CANDIDATES = 24

// ---------------------------------------------------------------------------
// the character scanner
// ---------------------------------------------------------------------------

/**
 * Read one string literal starting at `i` (which must be a quote character).
 * Returns `{ end, body, open, close }` where `body` is the RAW content
 * (backslash escapes still in it), or null when the literal never ends —
 * a truncated answer, and the one case that must fail rather than guess.
 */
function scanString(s, i) {
  const open = s[i]
  const closers = CLOSERS[open]
  if (!closers) return null
  let body = ''
  let j = i + 1
  while (j < s.length) {
    const c = s[j]
    if (c === '\\') {
      if (j + 1 >= s.length) return null      // trailing backslash: truncated
      body += c + s[j + 1]
      j += 2
      continue
    }
    if (closers.includes(c)) return { end: j, body, open, close: c }
    body += c
    j++
  }
  return null
}

/**
 * Index of the character that closes the container opened at `start`, or -1.
 * String literals are skipped whole, so a brace inside a value cannot close
 * anything — that is the entire reason this is not a regex.
 */
function balancedEnd(s, start) {
  const stack = []
  let i = start
  while (i < s.length) {
    const c = s[i]
    if (CLOSERS[c]) {
      const r = scanString(s, i)
      if (!r) return -1
      i = r.end + 1
      continue
    }
    if (c === '{' || c === '[') { stack.push(c); i++; continue }
    if (c === '}' || c === ']') {
      const open = stack.pop()
      if (!open) return -1
      if ((c === '}') !== (open === '{')) return -1
      if (!stack.length) return i
      i++
      continue
    }
    i++
  }
  return -1
}

/**
 * The balanced documents in `s`, in order, outermost only.
 *
 * When the FIRST opener never balances, the answer is truncated and we stop:
 * an object nested inside a cut-off document is a fragment, not the answer, and
 * returning it would be worse than admitting failure.
 */
function balancedCandidates(s, max = MAX_CANDIDATES) {
  const out = []
  let i = 0
  while (i < s.length && out.length < max) {
    let start = -1
    for (let k = i; k < s.length; k++) {
      if (s[k] === '{' || s[k] === '[') { start = k; break }
    }
    if (start < 0) break
    const end = balancedEnd(s, start)
    if (end < 0) break
    out.push(s.slice(start, end + 1))
    i = end + 1
  }
  return out
}

// ---------------------------------------------------------------------------
// markdown fences
// ---------------------------------------------------------------------------

/**
 * The bodies of ``` / ~~~ fenced blocks, with or without a language tag.
 * An unclosed fence (the model was cut off mid-block) yields everything after
 * the opener — the balanced scan then decides whether it is usable.
 */
function fencedBlocks(s) {
  const out = []
  const lines = s.split('\n')
  let i = 0
  while (i < lines.length) {
    const m = /^[ \t]*(`{3,}|~{3,})[ \t]*([A-Za-z0-9_+.#-]*)[ \t]*\r?$/.exec(lines[i])
    if (!m) { i++; continue }
    const marker = m[1][0]
    const close = new RegExp(`^[ \\t]*[${marker}]{3,}[ \\t]*\r?$`)
    const body = []
    let j = i + 1
    let closed = false
    for (; j < lines.length; j++) {
      if (close.test(lines[j])) { closed = true; break }
      body.push(lines[j])
    }
    out.push(body.join('\n'))
    i = closed ? j + 1 : lines.length
  }
  return out
}

// ---------------------------------------------------------------------------
// the repairs
// ---------------------------------------------------------------------------

/** Re-emit one character of a string body as valid JSON content. */
function escapeChar(c, note) {
  if (c === undefined) return ''
  if (c === '"') return '\\"'
  if (c === '\\') return '\\\\'
  if (c === '\n') { note('raw newline inside a string escaped'); return '\\n' }
  if (c === '\r') { note('raw carriage return inside a string escaped'); return '\\r' }
  if (c === '\t') { note('raw tab inside a string escaped'); return '\\t' }
  const code = c.charCodeAt(0)
  if (code < 0x20) {
    note('control character inside a string escaped')
    return '\\u' + code.toString(16).padStart(4, '0')
  }
  return c
}

/** A scanned literal, re-emitted as a proper double-quoted JSON string. */
function jsonString(r, note) {
  if (r.open === "'") note('single-quoted string re-quoted')
  else if (r.open !== '"') note('typographic quotes replaced with straight ones')
  let out = '"'
  const b = r.body
  for (let i = 0; i < b.length; i++) {
    const c = b[i]
    if (c === '\\') {
      const n = b[i + 1]
      // A valid JSON escape stays; anything else (`\'` from a single-quoted
      // string, `\x`) becomes the character itself, escaped if it needs it.
      out += JSON_ESCAPES.includes(n) ? c + n : escapeChar(n, note)
      i++
      continue
    }
    out += escapeChar(c, note)
  }
  return out + '"'
}

/**
 * Rewrite `src` into something JSON.parse can read, recording every repair.
 *
 * One pass, aware of where it is: inside a string nothing is repaired but the
 * delimiters and the control characters; outside one we know whether the next
 * token sits at a key position, which is what makes quoting an unquoted key
 * safe. Returns `{ ok: false }` when a string literal never closes — a
 * truncated answer is not repairable and must not be guessed at.
 */
function repairJson(src) {
  const repairs = []
  const note = r => { if (!repairs.includes(r)) repairs.push(r) }
  const s = String(src ?? '')
  let out = ''
  const stack = []          // 'obj' | 'arr'
  let keyPos = false        // the next bare token would be an object key
  let i = 0

  const dropTrailingComma = () => {
    let k = out.length
    while (k > 0 && /\s/.test(out[k - 1])) k--
    if (k > 0 && out[k - 1] === ',') {
      out = out.slice(0, k - 1)
      note('trailing comma removed')
    }
  }

  while (i < s.length) {
    const c = s[i]

    if (CLOSERS[c]) {
      const r = scanString(s, i)
      if (!r) return { ok: false, repairs }
      out += jsonString(r, note)
      i = r.end + 1
      continue
    }
    if (c === '{') { stack.push('obj'); keyPos = true; out += c; i++; continue }
    if (c === '[') { stack.push('arr'); keyPos = false; out += c; i++; continue }
    if (c === '}' || c === ']') { dropTrailingComma(); stack.pop(); keyPos = false; out += c; i++; continue }
    if (c === ':') { keyPos = false; out += c; i++; continue }
    if (c === ',') { keyPos = stack[stack.length - 1] === 'obj'; out += c; i++; continue }
    if (/\s/.test(c)) { out += c; i++; continue }

    const rest = s.slice(i)
    const num = NUMBER.exec(rest)
    if (num && keyPos) {
      // An unquoted numeric key (`{1: "a"}`) — a key is a string in JSON.
      out += JSON.stringify(num[0])
      note('unquoted object key quoted')
      i += num[0].length
      continue
    }
    if (num) {
      let tok = num[0]
      if (tok[0] === '+') { tok = tok.slice(1); note('stray leading + on a number removed') }
      out += tok
      i += num[0].length
      continue
    }
    const id = IDENT.exec(rest)
    if (id) {
      const tok = id[0]
      if (tok === 'true' || tok === 'false' || tok === 'null') {
        out += tok
      } else if (tok === 'NaN' || tok === 'Infinity' || tok === '-Infinity' || tok === 'undefined') {
        out += 'null'
        note(`${tok} replaced with null`)
      } else if (keyPos) {
        out += JSON.stringify(tok)
        note('unquoted object key quoted')
      } else {
        // An unquoted value we do not understand. Emitted verbatim on purpose:
        // the parse then fails honestly instead of inventing a string.
        out += tok
      }
      i += tok.length
      continue
    }
    out += c
    i++
  }
  return { ok: true, text: out, repairs }
}

// ---------------------------------------------------------------------------
// the entry point
// ---------------------------------------------------------------------------

function tryParse(text) {
  try { return { ok: true, value: JSON.parse(text) } } catch { return { ok: false } }
}

/** Everything worth trying, in the order it is worth trying it. */
function candidates(raw) {
  const out = []
  const seen = new Set()
  const add = (text, note) => {
    const t = String(text ?? '').trim()
    if (!t || seen.has(t) || out.length >= MAX_CANDIDATES) return
    seen.add(t)
    out.push({ text: t, note })
  }
  add(raw, 'as-is')
  for (const body of fencedBlocks(raw)) {
    add(body, 'from a markdown code fence')
    for (const b of balancedCandidates(body)) add(b, 'from a markdown code fence, prose around it removed')
  }
  for (const b of balancedCandidates(raw)) add(b, 'cut out of surrounding prose by a balanced scan')
  return out
}

/**
 * Turn a model's answer into a value.
 *
 * @param {string} text the raw answer
 * @returns {{ ok: boolean, value: any, repaired: string[], note: string }}
 *   `repaired` names every repair that was applied, `note` says where the
 *   document was found. Both exist so a failure — or a suspicious success — can
 *   be explained in a log line without re-running anything.
 */
export function extractJson(text) {
  const raw = String(text ?? '')
  const cands = candidates(raw)

  // First pass: no repairs at all. An answer that is already valid JSON must
  // never be touched, and a repair that "fixes" correct input is a bug we
  // would only find in production.
  for (const c of cands) {
    const v = tryParse(c.text)
    if (v.ok) return { ok: true, value: v.value, repaired: [], note: c.note }
  }
  // Second pass: repair, and say what was repaired.
  for (const c of cands) {
    const r = repairJson(c.text)
    if (!r.ok || r.text === c.text) continue
    const v = tryParse(r.text)
    if (v.ok) return { ok: true, value: v.value, repaired: r.repairs, note: `${c.note} (after repairs)` }
  }
  return {
    ok: false,
    value: null,
    repaired: [],
    note: cands.length
      ? 'no candidate parsed as JSON, with or without repairs'
      : 'no JSON document found in the answer',
  }
}
