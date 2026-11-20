// Freilauf — supervision: the case file of every run, and the one channel a
// supervisor run has to it.
//
// The rule the whole feature follows: the supervisor remembers nothing, the case
// file remembers everything. A supervisor run ("round") is short and fresh; what
// is known about a supervised run lives here, in `case_entries` and `case_state`
// (server/db.mjs creates them, this module is the only one that writes them).
//
// The shape of this file is a contract with the stages that build on it:
//
//   1. pure helpers at the top — bounds, author and minute checks, the refusal
//      sentences, `supervisionRefusal()`; no database, testable over a table;
//   2. readers — the case file, the case state, which agent supervises;
//   3. writers — `addCaseEntry()` is THE way an entry is written;
//   4. the operation table behind `POST /api/runs/<own id>/supervise` — an op is
//      registered with `registerSupervisorOp()`, never added to an if-chain.
//
// Importable without pages.mjs and without starting anything. Everything an
// AGENT reads from here (refusal sentences, answers) is an English literal, like
// the platform rules in runner.mjs; everything a HUMAN reads is rendered in
// server/supervision-pages.mjs through t().
import db, { getRun, addEvent, announceRun } from './db.mjs'
import { reportTokenOk } from './reports.mjs'
import { followUpActive } from './run-state.mjs'
import { shortId, toDbUtc } from './util.mjs'

// ------------------------------------------------------------------ pure helpers

/** Every kind an entry may have (SPEC 4.2). Anything else is refused. */
export const CASE_KINDS = ['look', 'note', 'message', 'reply', 'question', 'answer',
  'action', 'escalated', 'resolved', 'closed', 'reopened']

/** The longest text an entry keeps; a longer one is cut with an ellipsis and says so. */
export const CASE_TEXT_MAX = 4000

/** The longest choice label an operator's answer may carry. */
export const CASE_CHOICE_MAX = 100

/** "Look again in N minutes": at least one, at most a week. */
export const LOOK_AGAIN_MAX_MINUTES = 7 * 24 * 60

/** How many entries `caseEntries()` returns at most, whatever is asked. */
export const CASE_ENTRIES_CEILING = 200

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * A text as an entry keeps it: control characters other than newline and tab
 * removed (an entry is shown to humans and read by agents, and neither should
 * receive a terminal escape), line ends normalised, trimmed, and cut at `max`.
 * Returns `{ text, cut }` so a writer can say that something was dropped.
 */
export function boundCaseText(raw, max = CASE_TEXT_MAX) {
  const clean = String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
    .trim()
  if (clean.length <= max) return { text: clean, cut: false }
  return { text: clean.slice(0, max - 1) + '…', cut: true }
}

/**
 * Who may be named as the author of an entry: a supervisor run (its full id),
 * `run` (the supervised run itself), `operator`, `hub`, or `resolver:<name>`.
 */
export function caseAuthorValid(author) {
  const a = String(author ?? '')
  return UUID_RE.test(a) || a === 'run' || a === 'operator' || a === 'hub'
    || /^resolver:[A-Za-z0-9._@-]{1,64}$/.test(a)
}

/**
 * Minutes as the supervisor sends them (a number, or a string from a CLI) →
 * a whole number in range, or null. Compared, never coerced: `Number('')` is 0.
 */
export function lookAgainMinutes(raw) {
  if (raw === null || raw === undefined) return null
  const s = String(raw).trim()
  if (!/^\d+$/.test(s)) return null
  const n = Number(s)
  return n >= 1 && n <= LOOK_AGAIN_MAX_MINUTES ? n : null
}

/** A run reference as it may be echoed back: hex and dashes only, bounded. */
function cleanRef(ref) {
  return String(ref ?? '').toLowerCase().replace(/[^0-9a-f-]/g, '').slice(0, 36)
}

/**
 * Every sentence a supervisor can be refused with. English literals on purpose
 * (SPEC 7.7): an agent reads them, and they must say what IS the case so the
 * agent does not retry what cannot work.
 */
export const REFUSALS = {
  token: () => 'Refused: the bearer token is missing or does not belong to this run. '
    + 'fl-supervise sends FL_RUN_TOKEN, which the hub hands only to supervisor runs.',
  noCaller: () => 'Refused: the hub does not know the run named in the path.',
  notSupervisor: () => 'Refused: this run is not a supervisor run. Only a run started from an agent '
    + 'marked as supervisor may write the case files of other runs.',
  callerOver: () => 'Refused: this supervisor round has ended. A finished round cannot act on case files; '
    + 'the next round will pick the cases up.',
  noRun: () => 'Refused: name the run this operation is about (its full or short id).',
  unknown: (ref) => `Refused: no run matches '${cleanRef(ref)}'. Use the run's full id or its short id.`,
  ambiguous: (ref, ids) => `Refused: '${cleanRef(ref)}' matches more than one run (${ids.join(', ')}). `
    + 'Use a longer id.',
  self: () => 'Refused: that is your own run. A supervisor run is never a case; name the run you supervise.',
  otherSupervisor: (run) => `Refused: run ${shortId(run.id)} is a supervisor run itself. `
    + 'Supervisors do not supervise supervisors.',
  takenOut: (run) => `Refused: the operator took run ${shortId(run.id)} out of supervision. `
    + 'Leave it alone; it is not a case until the operator puts it back.',
  archived: (run) => `Refused: run ${shortId(run.id)} is archived. An archived run is not a case.`,
  unknownOp: (op, ops) => `Refused: unknown operation '${String(op ?? '').slice(0, 40)}'. `
    + `Known operations: ${ops.join(', ')}.`,
}

/**
 * THE authorisation check: may this caller run this op on that target?
 * Returns `null` when it may, otherwise `{ code, error }` with the sentence the
 * agent reads. Pure — it judges rows, never reads the database — so the whole
 * table of callers and targets is a unit test.
 *
 * `target` is the resolved run row, `null` when the reference matched nothing,
 * `undefined` when the op names no run at all. An ambiguous reference is the
 * resolver's answer (`resolveRunRef()`), because only it knows the candidates.
 *
 * A caller qualifies when its OWN row says `supervisor = 1` (copied from the
 * agent at creation) and it is still working: a round that has ended keeps its
 * token, and a token that outlives its round must not keep writing.
 */
export function supervisionRefusal(caller, op, target, ref = '') {
  if (!caller) return { code: 404, error: REFUSALS.noCaller() }
  if (caller.supervisor !== 1) return { code: 403, error: REFUSALS.notSupervisor() }
  const working = ['running', 'waiting_help'].includes(caller.status) || followUpActive(caller)
  if (!working) return { code: 403, error: REFUSALS.callerOver() }
  if (!op?.target) return null
  if (target === undefined) return { code: 400, error: REFUSALS.noRun() }
  if (target === null) return { code: 404, error: REFUSALS.unknown(ref) }
  if (target.id === caller.id) return { code: 403, error: REFUSALS.self() }
  if (target.supervisor === 1) return { code: 403, error: REFUSALS.otherSupervisor(target) }
  if (target.supervision_off === 1) return { code: 403, error: REFUSALS.takenOut(target) }
  if (target.archived_at) return { code: 403, error: REFUSALS.archived(target) }
  return null
}

// ----------------------------------------------------------------------- readers

/**
 * A run by its full or short id: `{ run }`, `{ run: null }` for nothing, or
 * `{ ambiguous: [short ids] }` when a prefix names several. A prefix must be at
 * least four characters, so a typo of one digit does not pick some run.
 */
export function resolveRunRef(ref) {
  const r = cleanRef(ref)
  if (!r) return { run: undefined }
  if (UUID_RE.test(r)) return { run: getRun(r) ?? null }
  if (r.length < 4) return { run: null }
  const rows = db.prepare('SELECT id FROM runs WHERE id LIKE ? ORDER BY started_at DESC LIMIT 11').all(`${r}%`)
  if (rows.length === 0) return { run: null }
  if (rows.length > 1) return { ambiguous: rows.slice(0, 10).map(x => shortId(x.id)) }
  return { run: getRun(rows[0].id) }
}

/**
 * The agents carrying the flag, switched on, in an active repo — lowest id
 * first. v1 runs one supervisor per hub: the first of these.
 */
export function supervisorAgents() {
  return db.prepare(`SELECT a.* FROM agents a JOIN repos r ON r.id = a.repo_id
    WHERE a.supervisor = 1 AND a.active = 1 AND r.active = 1 ORDER BY a.id`).all()
}

/** The agent that supervises this hub, or null. */
export function activeSupervisorAgent() {
  return supervisorAgents()[0] ?? null
}

/** Where a run's case stands, or null for a run nobody has written about. */
export function caseState(runId) {
  return db.prepare('SELECT * FROM case_state WHERE run_id = ?').get(runId) ?? null
}

/**
 * The newest `limit` entries of a run's case file, oldest first (the order one
 * reads a history in), `data` parsed. Bounded by `CASE_ENTRIES_CEILING`.
 */
export function caseEntries(runId, { limit = 50 } = {}) {
  const n = Math.max(1, Math.min(Number.isFinite(+limit) ? Math.floor(+limit) : 50, CASE_ENTRIES_CEILING))
  return db.prepare(`SELECT * FROM (SELECT id, run_id, ts, kind, author, text, data FROM case_entries
      WHERE run_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id`).all(runId, n)
    .map(row => {
      let data = null
      try { data = row.data ? JSON.parse(row.data) : null } catch { data = null }
      return { ...row, data }
    })
}

/** How many entries a run's case file holds. */
export function caseEntryCount(runId) {
  return db.prepare('SELECT count(*) c FROM case_entries WHERE run_id = ?').get(runId).c
}

// ----------------------------------------------------------------------- writers

function ensureCaseState(runId) {
  db.prepare('INSERT OR IGNORE INTO case_state(run_id) VALUES(?)').run(runId)
}

/**
 * Write one entry into a run's case file — the only function that inserts
 * into `case_entries`. It bounds the text, refuses an unknown kind or author,
 * makes sure the run has a case state row, and announces the run so an open
 * page refreshes (an entry is not an event, so nothing else would).
 *
 * Returns `{ id, cut }`; throws on a kind or author outside the lists, which is
 * a programming error and never the agent's.
 */
export function addCaseEntry(runId, { kind, author, text = '', data = null }) {
  if (!CASE_KINDS.includes(kind)) throw new Error(`unknown case entry kind: ${kind}`)
  if (!caseAuthorValid(author)) throw new Error(`invalid case entry author: ${author}`)
  const b = boundCaseText(text)
  const payload = data === null || data === undefined ? null : JSON.stringify(data)
  ensureCaseState(runId)
  const r = db.prepare('INSERT INTO case_entries(run_id, kind, author, text, data) VALUES(?,?,?,?,?)')
    .run(runId, kind, String(author), b.text, payload)
  announceRun(runId, 'case')
  return { id: Number(r.lastInsertRowid), cut: b.cut }
}

/** "Look again at": now plus `minutes`. Returns the stored UTC timestamp. */
export function setLookAgain(runId, minutes, nowMs = Date.now()) {
  ensureCaseState(runId)
  const at = toDbUtc(nowMs + minutes * 60_000)
  db.prepare('UPDATE case_state SET look_again_at = ? WHERE run_id = ?').run(at, runId)
  return at
}

/**
 * Take a run out of supervision (`off = true`) or put it back. Writes only on a
 * change, and every change is an event of the run, because the operator's
 * decision about the run is part of its history. Returns whether it changed.
 */
export function setSupervisionOff(runId, off, by = 'operator') {
  const run = getRun(runId)
  if (!run) return false
  const want = off ? 1 : 0
  if ((run.supervision_off === 1 ? 1 : 0) === want) return false
  db.prepare('UPDATE runs SET supervision_off = ? WHERE id = ?').run(want, runId)
  addEvent(runId, want ? 'supervision_off' : 'supervision_on', { by })
  return true
}

/**
 * The operator's answer on the run page or through the API: an `answer` entry
 * by `operator`, with the chosen label in `data.choice` when one was clicked.
 * Works whether or not a question is open — a remark for the supervisor is an
 * answer to the question that will come. Returns `{ ok, id }` or `{ ok:false, error }`
 * where `error` is an i18n key (a human reads it).
 */
export function answerCase(runId, { text = '', choice = '' } = {}) {
  const c = boundCaseText(choice, CASE_CHOICE_MAX).text
  const body = boundCaseText(text).text
  if (!body && !c) return { ok: false, error: 'case.err_answer_empty' }
  const r = addCaseEntry(runId, { kind: 'answer', author: 'operator', text: body, data: c ? { choice: c } : null })
  return { ok: true, id: r.id }
}

// ------------------------------------------------------------------ rounds

/**
 * SEAM for the round start (stage C): "Start now" on a supervisor agent comes
 * here instead of going straight to `startForAgent()`. Today it starts the
 * agent like any other — the hub-written case list and the due check are not
 * built yet. Stage C replaces the body with: run the due check by hand, start
 * one round with whatever is due ("nothing is due" when the list is empty).
 */
export async function startSupervisorRound(agent) {
  const { startForAgent } = await import('./scheduler.mjs')
  return startForAgent(agent)
}

// ---------------------------------------------------- the supervisor operations

/**
 * The operations a supervisor run may call, by name. Each entry:
 *   `target`  — true when the op names a run in `body.run` (then
 *               `supervisionRefusal()` judges that run before the handler runs);
 *   `handler(ctx)` — `ctx = { caller, target, body, nowMs }`, returns
 *               `{ code?, ...answer }` (code defaults to 200, `ok` to true).
 * Later stages register their ops here; the route does not change.
 */
const OPS = new Map()

export function registerSupervisorOp(name, { target = true, handler }) {
  if (typeof handler !== 'function') throw new Error(`supervisor op ${name}: handler missing`)
  OPS.set(name, { name, target: !!target, handler })
}

export function supervisorOps() { return [...OPS.keys()] }

/** What every answer about a target carries, so the agent knows which run it hit. */
function targetIds(run) { return { run: run.id, short_id: shortId(run.id) } }

registerSupervisorOp('note', {
  handler({ caller, target, body, nowMs }) {
    const text = boundCaseText(body.text).text
    if (!text) return { code: 400, ok: false, error: 'Refused: a note needs a text.' }
    const hasAgain = body.again !== undefined && body.again !== null && String(body.again).trim() !== ''
    const minutes = hasAgain ? lookAgainMinutes(body.again) : null
    if (hasAgain && minutes === null) {
      return { code: 400, ok: false, error: `Refused: --again takes whole minutes from 1 to ${LOOK_AGAIN_MAX_MINUTES}.` }
    }
    const e = addCaseEntry(target.id, { kind: 'note', author: caller.id, text: body.text,
      data: minutes ? { again_minutes: minutes } : null })
    const lookAgainAt = minutes ? setLookAgain(target.id, minutes, nowMs) : null
    return { ...targetIds(target), entry: e.id, cut: e.cut, look_again_at: lookAgainAt }
  },
})

registerSupervisorOp('again', {
  handler({ caller, target, body, nowMs }) {
    const minutes = lookAgainMinutes(body.minutes)
    if (minutes === null) {
      return { code: 400, ok: false, error: `Refused: give whole minutes from 1 to ${LOOK_AGAIN_MAX_MINUTES}.` }
    }
    const at = setLookAgain(target.id, minutes, nowMs)
    const e = addCaseEntry(target.id, { kind: 'action', author: caller.id, data: { op: 'again', minutes, at } })
    return { ...targetIds(target), entry: e.id, look_again_at: at }
  },
})

registerSupervisorOp('close', {
  handler({ caller, target, body }) {
    const reason = boundCaseText(body.reason).text
    if (!reason) return { code: 400, ok: false, error: 'Refused: closing a case needs a reason.' }
    const state = caseState(target.id)
    if (state?.closed_at) {
      return { ...targetIds(target), already_closed: true, closed_at: state.closed_at }
    }
    const e = addCaseEntry(target.id, { kind: 'closed', author: caller.id, text: body.reason })
    db.prepare(`UPDATE case_state SET closed_at = datetime('now'), closed_reason = ? WHERE run_id = ?`)
      .run(boundCaseText(body.reason).text, target.id)
    return { ...targetIds(target), entry: e.id, closed_at: caseState(target.id).closed_at }
  },
})

/**
 * `POST /api/runs/<callerId>/supervise`, served on the loopback listener and the
 * unix socket alike: both call this, so there is one set of rules. The bearer is
 * required on BOTH (an unsandboxed supervisor gets `FL_RUN_TOKEN` for exactly
 * this), and it must belong to the run in the path — no run can speak for another.
 *
 * Returns `{ code, body }`; the body is the JSON answer.
 */
export function handleSupervise(callerId, token, body = {}, nowMs = Date.now()) {
  if (!reportTokenOk(callerId, token)) return { code: 401, body: { ok: false, error: REFUSALS.token() } }
  const b = body && typeof body === 'object' ? body : {}
  const caller = getRun(callerId) ?? null
  const callerRefusal = supervisionRefusal(caller, null)
  if (callerRefusal) return { code: callerRefusal.code, body: { ok: false, error: callerRefusal.error } }
  const op = OPS.get(String(b.op ?? ''))
  if (!op) return { code: 400, body: { ok: false, error: REFUSALS.unknownOp(b.op, supervisorOps()) } }
  let target
  if (op.target) {
    const res = resolveRunRef(b.run)
    if (res.ambiguous) return { code: 409, body: { ok: false, error: REFUSALS.ambiguous(b.run, res.ambiguous), candidates: res.ambiguous } }
    target = res.run
  }
  const refusal = supervisionRefusal(caller, op, target, b.run)
  if (refusal) return { code: refusal.code, body: { ok: false, error: refusal.error } }
  const out = op.handler({ caller, target, body: b, nowMs }) ?? {}
  const { code = 200, ...rest } = out
  return { code, body: { ok: true, op: op.name, ...rest } }
}
