// Freilauf — the readable chat of an opencode run, from opencode's own store.
//
// opencode is a full-screen TUI, so its terminal recording is 97 % escape
// sequences and has no line structure; the conversation itself is in the session
// store. This renders the store into `chat.md` in the run directory: the task,
// the answers and the tool calls with shortened input and output, subagents
// included. The file is rewritten as a whole (atomically, only when the store
// moved), so a tool call that finished later is simply right on the next pass.
import { existsSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { RUNS_DIR } from './util.mjs'
import { openStore, runSessionIds, runStartMs, isV2Store } from './opencode-store.mjs'

export const CHAT_FILE = 'chat.md'
// Tool output can be huge, and the beginning of a run says what it was for while
// its end says how it went. So the cap keeps both and cuts the middle.
export const CHAT_MAX_BYTES = 2_000_000
const CHAT_HEAD_BYTES = 200_000
const TEXT_MAX = 24_000
const INPUT_MAX = 300
const OUTPUT_HEAD = 500
const OUTPUT_TAIL = 300

export const chatPath = (runId) => join(RUNS_DIR, runId, CHAT_FILE)

const stamps = new Map()    // run id → what the store looked like at the last write
const renders = new Map()   // run id → { at, ms } of the last render
// A big tree takes a noticeable moment on the hub's event loop (measured: 269 ms for
// 132 sessions and 83 MB), and a working agent moves the store on every pass. So the
// periodic refresh keeps a live chat at most a minute behind, and longer if rendering
// would otherwise take more than 2 % of the time. Every other caller gets it current.
const REFRESH_MS = 60_000
const REFRESH_FACTOR = 50

function shorten(text, head, tail) {
  const s = String(text ?? '')
  if (s.length <= head + tail) return s
  const marker = `[… ${s.length - head - tail} characters left out …]`
  return tail ? `${s.slice(0, head)}\n${marker}\n${s.slice(-tail)}` : `${s.slice(0, head)}\n${marker}`
}

const indent = (s, prefix) => String(s).split('\n').map(l => prefix + l).join('\n')
const utc = (ms) => new Date(Number(ms)).toISOString().slice(0, 19).replace('T', ' ')

function toolEntry(r) {
  const name = r.tool ?? 'tool'
  const input = r.input == null ? '' : ` ${shorten(typeof r.input === 'string' ? r.input : JSON.stringify(r.input), INPUT_MAX, 0)}`
  const call = `> ${name}${input}`
  if (r.status === 'error') return `${call}\n${indent(shorten(r.error ?? 'error', OUTPUT_HEAD, OUTPUT_TAIL), '  ! ')}`
  if (r.status !== 'completed') return `${call}\n  (${r.status ?? 'pending'})`
  const out = r.output ?? ''
  return out ? `${call}\n${indent(shorten(out, OUTPUT_HEAD, OUTPUT_TAIL), '  < ')}` : call
}

/**
 * opencode 2 keeps a message's parts inside its own row: `content` on an assistant
 * message, `text` on a user message. Tool output is `state.content`, a list of parts,
 * and a failed call's `state.error` is an object. Rows of the types `system`,
 * `synthetic` and `compaction` are opencode talking to the model; `idle` repeats the
 * error the assistant message already carries.
 */
function* queryRowsV2(d, ids) {
  const rows = d.prepare(`SELECT session_id AS session, type, time_created AS at, data FROM session_message
    WHERE session_id IN (${ids.map(() => '?').join(',')}) AND type IN ('user', 'assistant')
    ORDER BY time_created, seq`).iterate(...ids)
  for (const r of rows) {
    let m
    try { m = JSON.parse(r.data) } catch { continue }
    const base = { session: r.session, at: r.at, role: r.type }
    if (r.type === 'user') { yield { ...base, type: 'text', text: m.text }; continue }
    for (const c of m.content ?? []) {
      if (c.type === 'text') yield { ...base, type: 'text', text: c.text }
      else if (c.type === 'tool') {
        const st = c.state ?? {}
        yield { ...base, type: 'tool', tool: c.name, status: st.status,
          input: st.input == null ? null : JSON.stringify(st.input),
          output: (st.content ?? []).map(x => x?.text ?? '').filter(Boolean).join('\n'),
          error: st.error?.message ?? (st.error ? String(st.error) : null) }
      }
    }
    if (m.error) yield { ...base, type: 'message-error', error: m.error.message ?? JSON.stringify(m.error) }
  }
}

function queryRows(d, ids) {
  if (isV2Store(d)) return queryRowsV2(d, ids)
  const list = ids.map(() => '?').join(',')
  // Fields rather than whole rows: a message row can carry the run's complete
  // diff, and this query runs on the hub's event loop.
  return d.prepare(`
    SELECT p.session_id AS session, p.time_created AS at, p.id AS id,
           json_extract(p.data, '$.type') AS type,
           json_extract(p.data, '$.text') AS text,
           json_extract(p.data, '$.tool') AS tool,
           json_extract(p.data, '$.state.status') AS status,
           json_extract(p.data, '$.state.input') AS input,
           json_extract(p.data, '$.state.output') AS output,
           json_extract(p.data, '$.state.error') AS error,
           json_extract(m.data, '$.role') AS role
    FROM part p JOIN message m ON m.id = p.message_id
    WHERE p.session_id IN (${list}) AND json_extract(p.data, '$.type') IN ('text', 'tool')
    UNION ALL
    SELECT session_id, time_updated, id, 'message-error', NULL, NULL, NULL, NULL, NULL,
           json_extract(data, '$.error'), json_extract(data, '$.role')
    FROM message WHERE session_id IN (${list}) AND json_extract(data, '$.error') IS NOT NULL
    ORDER BY at, id`).iterate(...ids, ...ids)
}

/**
 * The chat text of these sessions, chronologically, never over `maxBytes`.
 * Separate from the file access so the suite can hand it a fixture store.
 */
export function renderChat(d, ids, { title = '', maxBytes = CHAT_MAX_BYTES } = {}) {
  const sessionRow = d.prepare(`SELECT title, parent_id FROM ${isV2Store(d) ? 'session_v2' : 'session'} WHERE id = ?`)
  const headBudget = Math.min(CHAT_HEAD_BYTES, Math.floor(maxBytes / 4))
  const start = `# ${title}\nGenerated by Freilauf from the opencode session store. Tool input and output are shortened.\n`
  const head = [start]
  let headBytes = Buffer.byteLength(start)
  let tail = []
  let tailStart = 0
  let tailBytes = 0
  let omitted = 0
  const tailBudget = maxBytes - headBudget - 200   // the room for the marker line

  const add = (entry) => {
    const bytes = Buffer.byteLength(entry) + 1
    if (!omitted && !tail.length && headBytes + bytes <= headBudget) {
      head.push(entry)
      headBytes += bytes
      return
    }
    tail.push({ entry, bytes })
    tailBytes += bytes
    while (tailBytes > tailBudget && tailStart < tail.length) {
      tailBytes -= tail[tailStart].bytes
      tailStart++
      omitted++
    }
    // Compacted now and then, because shift() per entry is quadratic on 100 000 rows.
    if (tailStart > 1024) { tail = tail.slice(tailStart); tailStart = 0 }
  }

  let lastSession = null
  let lastRole = null
  let entries = 0
  for (const r of queryRows(d, ids)) {
    let entry = ''
    if (r.type === 'text') {
      if (!String(r.text ?? '').trim()) continue
    }
    if (r.session !== lastSession) {
      const s = sessionRow.get(r.session)
      entry += `\n===== ${s?.parent_id ? 'subagent' : 'session'}: ${s?.title ?? r.session} =====\n`
      lastSession = r.session
      lastRole = null
    }
    if (r.role !== lastRole || r.type === 'text') {
      entry += `\n--- ${r.role ?? '?'} · ${utc(r.at)} UTC ---\n`
      lastRole = r.role
    }
    if (r.type === 'text') entry += shorten(r.text, TEXT_MAX, 0)
    else if (r.type === 'tool') entry += toolEntry(r)
    else entry += `! error: ${shorten(r.error, OUTPUT_HEAD, OUTPUT_TAIL)}`
    add(entry)
    entries++
  }
  if (!entries) return null
  const kept = tail.slice(tailStart).map(x => x.entry)
  const marker = omitted ? [`\n[… ${omitted} entries left out to keep this file under ${maxBytes} bytes …]`] : []
  return [...head, ...marker, ...kept].join('\n') + '\n'
}

/** Changes whenever the store's rows for these sessions do. */
function storeStamp(d, ids) {
  const v2 = isV2Store(d)
  const q = d.prepare(`SELECT COUNT(*) AS n, MAX(time_updated) AS t FROM ${v2 ? 'session_message' : 'part'} WHERE session_id = ?`)
  const m = d.prepare(`SELECT MAX(time_updated) AS t FROM ${v2 ? 'session_message' : 'message'} WHERE session_id = ?`)
  return ids.map(id => { const r = q.get(id); return `${id}:${r.n}:${r.t}:${m.get(id).t}` }).join(',')
}

/**
 * Bring a run's chat file up to date. Returns true when the file is current.
 * Answers false rather than throwing on everything that can go wrong (no store,
 * a schema that moved, a sandbox home the hub cannot read): such a run simply
 * falls back on its capped terminal recording. A chat already on disk stays.
 *
 * Mode 600: the file holds tool output, and it must not be readable by more
 * accounts than the recording it replaces on the page.
 */
export function syncChat(run, { periodic = false } = {}) {
  if (run?.harness !== 'opencode' || !run.workdir_effective) return false
  const dir = join(RUNS_DIR, run.id)
  if (!existsSync(dir)) return false
  const last = renders.get(run.id)
  if (periodic && last && Date.now() - last.at < Math.max(REFRESH_MS, REFRESH_FACTOR * last.ms)) return true
  const d = openStore(run)
  if (!d) return false
  const file = chatPath(run.id)
  try {
    const ids = runSessionIds(d, run.workdir_effective, runStartMs(run))
    if (!ids.length) return false
    const stamp = storeStamp(d, ids)
    if (stamps.get(run.id) === stamp && existsSync(file)) return true
    const began = Date.now()
    const text = renderChat(d, ids, { title: `Chat of run ${run.id}` })
    renders.set(run.id, { at: Date.now(), ms: Date.now() - began })
    if (text === null) return false
    const tmp = `${file}.${process.pid}.tmp`
    try {
      writeFileSync(tmp, text, { mode: 0o600 })
      renameSync(tmp, file)
    } catch (e) {
      try { rmSync(tmp, { force: true }) } catch {}
      throw e
    }
    stamps.set(run.id, stamp)
    return true
  } catch (e) {
    console.error(`[opencode-chat] ${run.id}: ${e.message}`)
    return false
  } finally {
    try { d.close() } catch {}
  }
}
