// Freilauf — opencode's own log as an error source.
//
// A provider refusal such as "Free usage limit reached" stands in no message and
// no part of the session store (measured with 1.19.5 on two runs that hung for
// days): opencode keeps retrying, so `session.error` never fires. It stands in
// `<data>/log/opencode.log`, one logfmt line per event, shared by every opencode
// process of this home:
//
//   timestamp=… level=ERROR run=… message="stream error" … session.id=ses_… small=false
//     agent=build mode=primary error.error="AI_APICallError: …"
//
// `run=` is opencode's own process tag, not a Freilauf run: `session.id` is what
// assigns a line to a run (opencode 2 no longer writes it on these lines; there the
// store has the error, see storeErrors() and scanOpencodeLogs()). The offset belongs to the FILE, because one read serves
// every run. It is claimed like `runs.log_offset`: two readers cannot both get
// the same bytes (see claimOffset() in watcher.mjs).
import { openSync, readSync, fstatSync, closeSync, statSync } from 'node:fs'
import { join } from 'node:path'
import db from './db.mjs'
import { agentHome } from './sandbox/exec.mjs'
import { env } from './env.mjs'

// One pass reads at most this much and continues on the next. opencode writes
// about 2 MB a day here, so only a hub that was down for weeks ever hits it.
const MAX_BYTES_PER_PASS = 16 * 1024 * 1024
// A first read starts this far back: a run already in trouble when this code
// first sees the file must not have to fail a second time to be noticed.
const FIRST_READ_BACK = 1024 * 1024

export function opencodeLogPath(run = null) {
  return env('OPENCODE_LOG') ?? join(agentHome(run), '.local/share/opencode/log/opencode.log')
}

/** One logfmt line → { key: value }. `\"` and `\\` are unescaped inside quotes. */
export function parseLogfmt(line) {
  const out = {}
  const re = /([\w.]+)=(?:"((?:[^"\\]|\\.)*)"|(\S*))/g
  for (let m; (m = re.exec(line));) {
    out[m[1]] = m[2] !== undefined ? m[2].replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c)) : m[3]
  }
  return out
}

/**
 * The lines that matter from a stretch of the log: ERROR level, tied to a session.
 * `small=true` is opencode's side model writing a title; its failure stops nothing.
 * Returns [{ tsMs, sessionId, text }].
 */
export function errorLines(text) {
  const out = []
  for (const line of String(text).split('\n')) {
    if (!line.includes('level=ERROR') || !line.includes('session.id=')) continue
    const f = parseLogfmt(line)
    if (f.level !== 'ERROR' || !f['session.id'] || f.small === 'true') continue
    const tsMs = Date.parse(f.timestamp)
    out.push({
      tsMs: Number.isFinite(tsMs) ? tsMs : Date.now(),
      sessionId: f['session.id'],
      text: f['error.error'] ?? f['error.error.message'] ?? f.error ?? f.message ?? '',
    })
  }
  return out
}

function readRange(path, from, to) {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(to - from)
    const n = readSync(fd, buf, 0, buf.length, from)
    return buf.subarray(0, n)
  } finally { closeSync(fd) }
}

/**
 * The complete new lines of the file, once. A half-written last line stays for the
 * next pass. A new inode or a file shorter than the offset means opencode rotated
 * or truncated it, so reading starts at the beginning of what is there now.
 * Returns '' when there is nothing or the file cannot be read: this source going
 * away must never take the watcher pass with it.
 */
export function claimNewLogText(path) {
  let st
  try { st = statSync(path) } catch { return '' }
  const row = db.prepare('SELECT ino, offset FROM opencode_log_cursor WHERE path = ?').get(path) ?? null
  const ino = Number(st.ino)
  let from
  if (!row) from = Math.max(0, st.size - FIRST_READ_BACK)
  else if (Number(row.ino) !== ino || st.size < Number(row.offset)) from = 0
  else from = Number(row.offset)
  if (from >= st.size) {
    if (!row || Number(row.ino) !== ino || Number(row.offset) !== from) claim(path, row, ino, from)
    return ''
  }
  const to = Math.min(st.size, from + MAX_BYTES_PER_PASS)
  let buf
  try { buf = readRange(path, from, to) } catch { return '' }
  const cut = buf.lastIndexOf(0x0a)
  // A stretch without one line end: wait while the line is being written, and step
  // over it only when it fills the whole budget (nothing else could ever pass it).
  if (cut < 0 && buf.length < MAX_BYTES_PER_PASS) return ''
  const next = cut < 0 ? to : from + cut + 1
  if (!claim(path, row, ino, next)) return ''
  return cut < 0 ? '' : buf.subarray(0, cut + 1).toString('utf8')
}

/**
 * The same claim for opencode 2's error source, the session store: its log lines
 * carry no session id any more. `path` is `store:<run id>`, the offset a timestamp
 * in ms. Answers the position to read from; `advanceStoreCursor` moves it, and only
 * the one whose expected value still stands reports what it read.
 */
export function storeCursor(runId) {
  return Number(db.prepare('SELECT offset FROM opencode_log_cursor WHERE path = ?').get(`store:${runId}`)?.offset ?? 0)
}
export function advanceStoreCursor(runId, expected, next) {
  const path = `store:${runId}`
  const row = db.prepare('SELECT ino, offset FROM opencode_log_cursor WHERE path = ?').get(path) ?? null
  if (row && Number(row.offset) !== expected) return false
  return claim(path, row, 0, next)
}

function claim(path, row, ino, next) {
  if (!row) {
    const r = db.prepare('INSERT OR IGNORE INTO opencode_log_cursor(path, ino, offset) VALUES(?, ?, ?)').run(path, ino, next)
    return r.changes > 0
  }
  const r = db.prepare('UPDATE opencode_log_cursor SET ino = ?, offset = ? WHERE path = ? AND ino = ? AND offset = ?')
    .run(ino, next, path, row.ino, row.offset)
  return r.changes > 0
}

/**
 * A sandboxed run's log and a v2 run's store cursor belong to that run: a revived run
 * must not read its old errors again, so they go with the run, not with its activity.
 * Hourly, because this walks the whole table.
 */
let lastPrune = 0
export function pruneLogCursors(runsDir, { force = false } = {}) {
  if (!force && Date.now() - lastPrune < 3_600_000) return
  lastPrune = Date.now()
  const exists = db.prepare('SELECT 1 FROM runs WHERE id = ?')
  for (const { path } of db.prepare('SELECT path FROM opencode_log_cursor').all()) {
    const id = path.startsWith('store:') ? path.slice(6)
      : path.startsWith(`${runsDir}/`) ? path.slice(runsDir.length + 1).split('/')[0] : null
    if (id && !exists.get(id)) db.prepare('DELETE FROM opencode_log_cursor WHERE path = ?').run(path)
  }
}
