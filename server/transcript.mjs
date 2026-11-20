// Freilauf — the tail of what a run's agent said and did, in one shape for every
// coding agent (`GET /api/runs/<id>/transcript`, the supervisor's bundle, the
// flows' `transcript` source).
//
// The shape: `{ source, harness, messages: [{ role, at, text }], cut, note }`,
// newest last. `role` is `user`, `assistant`, `tool` (a call, one line) or
// `result` (a tool's answer, one line) for a harness record, and `screen` / `log`
// for the fallback. `at` is an ISO timestamp or null where the record has none.
//
// WHERE IT COMES FROM, in this order:
//   1. the harness plugin's optional `transcript(run, { tail, chars })`
//      capability — the coding agent's own record (claude's JSONL, cursor's
//      transcript, opencode's store). The vendor facts live there, never here.
//   2. the live pane's text, while the pane is alive — a TUI's screen reads far
//      better than its recording;
//   3. the cleaned tail of the recording (`log.txt`).
// `source` names which one answered. tmux has three answers, not two
// (`fallbackPlan()`): "could not answer" never reads as "dead" or "alive".
//
// A transcript can hold a secret an agent printed. This module never writes what
// it read to a log, an event or a case entry; the route is no more open than the
// run's log already is.
import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { RUNS_DIR, sh } from './util.mjs'
import { terminalText } from './detect.mjs'
import { readLogTail } from './run-log.mjs'
import { getHarness } from './harnesses/index.mjs'
import { paneAlive, sessionGone, paneTarget } from './sessions.mjs'

/** How many messages an answer holds by default, and at most whatever is asked. */
export const TRANSCRIPT_TAIL_DEFAULT = 40
export const TRANSCRIPT_TAIL_MAX = 200
/** The character budget of all messages together, by default and at most. */
export const TRANSCRIPT_CHARS_DEFAULT = 12_000
export const TRANSCRIPT_CHARS_MAX = 60_000
/** One message never takes more than this, so one huge paste cannot fill the budget. */
export const MESSAGE_CHARS_MAX = 4_000
/** A tool call or a tool's result is one line of at most this many characters. */
export const TOOL_LINE_MAX = 200
/** How many bytes of a JSONL record a reader takes from the end of the file. */
export const RECORD_TAIL_BYTES = 512 * 1024
/** How many lines of the live pane, and bytes of the recording, the fallback reads. */
const PANE_LINES = 300
const LOG_TAIL_BYTES = 48 * 1024

/** A whole number in [1, max] from a query value, or the default — compared, never coerced. */
export function boundedInt(raw, dflt, max) {
  const s = String(raw ?? '').trim()
  if (!/^\d+$/.test(s)) return dflt
  const n = Number(s)
  return n >= 1 ? Math.min(n, max) : dflt
}

/** `{ tail, chars }` from whatever a caller sent, inside the ceilings. */
export function transcriptLimits({ tail, chars } = {}) {
  return {
    tail: boundedInt(tail, TRANSCRIPT_TAIL_DEFAULT, TRANSCRIPT_TAIL_MAX),
    chars: boundedInt(chars, TRANSCRIPT_CHARS_DEFAULT, TRANSCRIPT_CHARS_MAX),
  }
}

/**
 * A tool call or result as ONE line: whitespace collapsed, cut at `max` with an
 * ellipsis. What a supervisor needs is the gist ("ran the tests"), not the payload.
 */
export function oneLine(text, max = TOOL_LINE_MAX) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}

/**
 * The newest `tail` messages whose texts fit into `chars`, newest last. Every
 * message is cut at `MESSAGE_CHARS_MAX` first (keeping its end, where the answer
 * usually is; `messageMax` widens that for a caller that wants whole
 * messages); then the oldest go until the rest fits — and if the newest alone
 * is over the budget, its end is kept. Never longer than `chars`. Says what was cut, so the reader knows
 * that there is more and how to ask for it.
 */
export function boundMessages(messages, { tail, chars, messageMax = MESSAGE_CHARS_MAX }) {
  const all = (messages ?? []).filter(m => m && String(m.text ?? '').trim())
  const total = all.length
  const keepEnd = (text, max) => (max > 1 ? '…' + text.slice(-(max - 1)) : '…')
  const keep = all.slice(-tail).map(m => {
    const text = String(m.text).trim()
    const long = text.length > messageMax
    return { role: String(m.role ?? 'unknown'), at: m.at ?? null,
      text: long ? keepEnd(text, messageMax) : text, ...(long ? { cut: true } : {}) }
  })
  let used = 0
  let first = keep.length
  for (let i = keep.length - 1; i >= 0; i--) {
    if (used + keep[i].text.length > chars) break
    used += keep[i].text.length
    first = i
  }
  let out = keep.slice(first)
  let charsCut = first > 0
  if (!out.length && keep.length) {
    const last = keep[keep.length - 1]
    out = [{ ...last, text: keepEnd(last.text, chars), cut: true }]
    charsCut = true
  }
  return {
    messages: out,
    cut: { older: total - out.length, chars: charsCut || out.some(m => m.cut) },
    total,
  }
}

/** The last `max` bytes of a file as text, and whether the start was cut off. */
export function readTailBytes(file, max = RECORD_TAIL_BYTES) {
  const size = statSync(file).size
  const len = Math.min(size, max)
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, size - len)
    return { text: buf.toString('utf8'), truncated: size > len }
  } finally { closeSync(fd) }
}

/** Terminal text as lines worth reading: right-trimmed, empty and repeated lines dropped. */
export function cleanScreen(text) {
  const out = []
  for (const l of String(text ?? '').split('\n').map(x => x.trimEnd())) {
    if (l && l !== out[out.length - 1]) out.push(l)
  }
  return out.join('\n')
}

/**
 * What the fallback reads, from tmux's two answers. Pure, so the three verdicts
 * are a test:
 *   `alive`  paneAlive(): true / false (pane dead) / null (no answer)
 *   `gone`   sessionGone(): true (demonstrably gone) / false / null (no answer)
 * → 'pane' while the pane lives, 'log' when the pane is dead or the session is
 * gone, 'unknown' when tmux could not say — then the screen is not read and the
 * answer says so.
 */
export function fallbackPlan(alive, gone) {
  if (alive === true) return 'pane'
  if (alive === false) return 'log'
  return gone === true ? 'log' : 'unknown'
}

/**
 * The coding agent's own record through its plugin, or null when the plugin has
 * no reader or its reader found nothing. A reader that throws is a reader that
 * found nothing — the fallback still answers.
 */
export async function harnessTranscript(run, limits = {}) {
  const reader = getHarness(run?.harness)?.transcript
  if (typeof reader !== 'function') return null
  try {
    const r = await reader.call(getHarness(run.harness), run, transcriptLimits(limits))
    if (!r || !Array.isArray(r.messages) || !r.messages.length) return null
    return r
  } catch (err) {
    console.error(`[transcript] ${run.harness} reader: ${err.message}`)
    return null
  }
}

async function paneText(session) {
  const r = await sh('tmux', ['capture-pane', '-p', '-J', '-S', `-${PANE_LINES}`, '-t', paneTarget(session)])
  return r.ok ? cleanScreen(r.stdout) : null
}

function logText(runId) {
  const f = join(RUNS_DIR, runId, 'log.txt')
  if (!existsSync(f)) return null
  try {
    return { text: cleanScreen(terminalText(readLogTail(f, LOG_TAIL_BYTES))),
      at: new Date(statSync(f).mtimeMs).toISOString() }
  } catch { return null }
}

/**
 * THE reader: the tail of a run's transcript, bounded, from the best source
 * there is. Never throws; a run with nothing anywhere answers `source: 'none'`
 * and an empty list, with a note saying what was missing.
 */
export async function runTranscript(run, opts = {}, nowMs = Date.now()) {
  const limits = transcriptLimits(opts)
  const own = await harnessTranscript(run, limits)
  if (own) {
    return { source: own.source ?? 'transcript', harness: run.harness, ...boundMessages(own.messages, limits), note: own.note ?? null }
  }
  const notes = []
  let plan = 'log'
  if (run?.tmux_session) {
    plan = fallbackPlan(await paneAlive(run.tmux_session), null)
    if (plan === 'unknown') plan = fallbackPlan(null, await sessionGone(run.tmux_session))
  } else {
    notes.push('the run has no tmux session')
  }
  if (plan === 'pane') {
    const text = await paneText(run.tmux_session)
    if (text !== null) {
      return { source: 'pane', harness: run.harness,
        ...boundMessages([{ role: 'screen', at: new Date(nowMs).toISOString(), text }], limits), note: null }
    }
    notes.push('tmux did not hand over the screen of the live pane')
  } else if (plan === 'unknown') {
    notes.push('tmux could not say whether the pane is alive, so the live screen was not read')
  } else if (run?.tmux_session) {
    notes.push('the pane is dead or the session is gone')
  }
  const log = logText(run.id)
  if (log && log.text) {
    return { source: 'log', harness: run.harness,
      ...boundMessages([{ role: 'log', at: log.at, text: log.text }], limits), note: notes.join('; ') || null }
  }
  notes.push('no recording exists')
  return { source: 'none', harness: run?.harness ?? null, messages: [], cut: { older: 0, chars: false }, total: 0,
    note: notes.join('; ') }
}
