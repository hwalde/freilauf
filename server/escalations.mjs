// Freilauf — escalations: a problem a supervisor cannot solve from inside the
// hub (credentials, credit, a service on the machine, a system elsewhere) and
// hands to somebody outside it. The hub only keeps the list; an external
// resolver collects it through the routes below, which are a FIXED interface
// (docs/escalations.md is the contract):
//
//   GET  /api/escalations                    state=open|claimed|resolved|dismissed|all, limit
//   POST /api/escalations/<id>/claim         by=<name>
//   POST /api/escalations/<id>/release
//   POST /api/escalations/<id>/resolve       outcome=solved|unsolved|operator, note, by
//   POST /api/escalations/<id>/dismiss
//
// Unknown id: 404. A transition the state does not allow: 409, nothing changes.
// Every timestamp ISO 8601 UTC with `Z`. `summary` and `run.title` are untrusted
// text the resolver reads, so their shape is kept strict here: one line,
// control characters gone, bounded.
//
// This module is the only writer of `escalations`. The run the escalation is
// about keeps the outcome in its case file (`escalated` when raised, `resolved`
// when resolved or dismissed), written through `addCaseEntry()`.
import db, { getRun, getRepo } from './db.mjs'
import { shortId, parseDbUtc } from './util.mjs'
import { addCaseEntry, boundCaseText, supervisionSetting } from './supervision.mjs'
import { notifyRun, reportHeader } from './reports.mjs'
import { notifyOnFor } from './notify.mjs'

// ------------------------------------------------------------------ the fixed lists

/** The classes an escalation may have — a closed list; anything else is refused when raised. */
export const ESCALATION_CLASSES = Object.freeze(['hub_defect', 'server_service', 'credentials', 'quota_or_credit',
  'external_system', 'needs_access', 'other'])

/** The states, in the order an escalation moves through them. */
export const ESCALATION_STATES = Object.freeze(['open', 'claimed', 'resolved', 'dismissed'])

/** The words `GET ?state=` takes: every state, and `all`. */
export const ESCALATION_STATE_FILTERS = Object.freeze([...ESCALATION_STATES, 'all'])

/** What `resolve` says came of it; `operator` means the problem now lies with the human. */
export const ESCALATION_OUTCOMES = Object.freeze(['solved', 'unsolved', 'operator'])

export const SUMMARY_MAX = 300
export const NOTE_MAX = 500
/** How long a run title may be in the answer — untrusted like the summary. */
export const TITLE_MAX_OUT = 200
export const ESCALATIONS_LIMIT_DEFAULT = 50
export const ESCALATIONS_LIMIT_MAX = 200

/** A resolver's name: it becomes the case-file author `resolver:<name>`, so the same shape. */
const NAME_RE = /^[A-Za-z0-9._@-]{1,64}$/

/** A claimed escalation not resolved within this long is announced once (the supervision clock). */
export const CLAIMED_REMIND_MS = 24 * 60 * 60_000

/** The grace in ms, held to its range ('' or junk is 0: tell at once). */
export function escalationGraceMs() {
  return supervisionSetting('grace') * 60_000
}

// ------------------------------------------------------------------ pure helpers

/**
 * Untrusted text as ONE line: every control character (newlines included)
 * becomes a space, runs of whitespace fold, the ends are trimmed. Returns
 * `{ text, cut }`; with `max` the text is cut there with an ellipsis.
 */
export function oneLine(raw, max = Infinity) {
  const s = String(raw ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (s.length <= max) return { text: s, cut: false }
  return { text: s.slice(0, max - 1) + '…', cut: true }
}

/** A database timestamp (`YYYY-MM-DD HH:MM:SS`, UTC) as ISO 8601 with `Z`, or null. */
export function isoUtc(ts) {
  const ms = typeof ts === 'number' ? ts : parseDbUtc(ts)
  return Number.isFinite(ms) ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z') : null
}

/** A resolver's name as sent, or null when it is not one. */
export function resolverName(raw) {
  const s = String(raw ?? '').trim()
  return NAME_RE.test(s) ? s : null
}

/**
 * Who the `resolved` entry is by: `resolver:<by>` when given, else
 * `resolver:<claimed_by>` when it was claimed, else the operator.
 */
export function resolvedAuthor({ by = null, claimedBy = null } = {}) {
  if (by) return `resolver:${by}`
  if (claimedBy) return `resolver:${claimedBy}`
  return 'operator'
}

/**
 * Which escalations the clock announces now (pure): an unclaimed one once its
 * grace has passed and it was not announced yet; a claimed one not resolved
 * within `CLAIMED_REMIND_MS` of its claim, once. Returns `[{ row, why }]`,
 * `why` 'unclaimed' or 'claimed_stale'.
 */
export function escalationsToAnnounce(rows, nowMs, graceMs) {
  const out = []
  for (const row of rows ?? []) {
    if (row.state === 'open' && !row.announced_at) {
      const created = parseDbUtc(row.created_at)
      if (Number.isFinite(created) && nowMs - created >= graceMs) out.push({ row, why: 'unclaimed' })
    } else if (row.state === 'claimed' && !row.reminded_at) {
      const claimed = parseDbUtc(row.claimed_at)
      if (Number.isFinite(claimed) && nowMs - claimed >= CLAIMED_REMIND_MS) out.push({ row, why: 'claimed_stale' })
    }
  }
  return out
}

// ------------------------------------------------------------------ readers

export function escalationById(id) {
  const s = String(id ?? '').trim()
  if (!/^\d{1,15}$/.test(s)) return null
  return db.prepare('SELECT * FROM escalations WHERE id=?').get(Number(s)) ?? null
}

/** One escalation in the shape of the contract. */
export function escalationItem(row) {
  const run = getRun(row.run_id)
  const agent = run?.agent_id ? db.prepare('SELECT name FROM agents WHERE id=?').get(run.agent_id)?.name ?? null : null
  const repo = run?.repo_id ? getRepo(run.repo_id)?.name ?? null : null
  return {
    id: row.id,
    created_at: isoUtc(row.created_at),
    class: row.class,
    summary: oneLine(row.summary, SUMMARY_MAX).text,
    state: row.state,
    run: {
      id: row.run_id,
      short_id: shortId(row.run_id),
      title: run?.title ? oneLine(run.title, TITLE_MAX_OUT).text : (agent ? oneLine(agent, TITLE_MAX_OUT).text : null),
      agent: agent ? oneLine(agent, TITLE_MAX_OUT).text : null,
      repo: repo ? oneLine(repo, TITLE_MAX_OUT).text : null,
      harness: run?.harness ?? null,
      status: run?.status ?? null,
    },
    claimed_by: row.claimed_by ?? null,
    claimed_at: isoUtc(row.claimed_at),
    resolved_at: isoUtc(row.resolved_at),
    outcome: row.outcome ?? null,
    note: row.note ?? null,
  }
}

/**
 * The list for `GET /api/escalations`: `{ ok, code?, error?, rows }`. An unknown
 * state word is a 400 naming the valid ones — "there are none" is never the
 * answer to "I do not know that word". Open and claimed ones come oldest first
 * (a queue: nothing starves behind newer ones); the others newest first.
 */
export function listEscalations({ state = 'open', limit = ESCALATIONS_LIMIT_DEFAULT } = {}) {
  const want = state === null || state === undefined || state === '' ? 'open' : String(state)
  if (!ESCALATION_STATE_FILTERS.includes(want)) {
    return { ok: false, code: 400, error: `unknown state '${oneLine(want, 40).text}' — one of: ${ESCALATION_STATE_FILTERS.join(', ')}` }
  }
  const n = Number(limit)
  const lim = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), ESCALATIONS_LIMIT_MAX) : ESCALATIONS_LIMIT_DEFAULT
  const queue = want === 'open' || want === 'claimed'
  const rows = want === 'all'
    ? db.prepare('SELECT * FROM escalations ORDER BY id DESC LIMIT ?').all(lim)
    : db.prepare(`SELECT * FROM escalations WHERE state=? ORDER BY id ${queue ? 'ASC' : 'DESC'} LIMIT ?`).all(want, lim)
  return { ok: true, state: want, limit: lim, rows }
}

/** How many escalations wait for somebody (open or claimed) — the nav label's number. */
export function pendingEscalationCount() {
  return db.prepare(`SELECT count(*) c FROM escalations WHERE state IN ('open', 'claimed')`).get().c
}

/** Is the feature in use — any escalation at all? (The page's nav entry also shows while a supervisor is active.) */
export function anyEscalation() {
  return !!db.prepare('SELECT 1 FROM escalations LIMIT 1').get()
}

// ------------------------------------------------------------------ raising

/**
 * Raise an escalation about `run` (a supervisor's `escalate`). Returns
 * `{ ok, code?, error?, id, announced, delivered }`. The class must be one of
 * the list, the summary one line of at most `SUMMARY_MAX` characters (longer
 * is refused, never cut: the resolver should read what was meant). The same
 * class about the same run while one is still open or claimed is refused — the
 * next round must not raise it again. With the grace setting at 0 (the default)
 * the operator hears of it at once; otherwise the supervision clock does that.
 */
export async function raiseEscalation({ run, by, cls, summary, nowMs = Date.now() }) {
  const c = String(cls ?? '').trim()
  if (!ESCALATION_CLASSES.includes(c)) {
    return { ok: false, code: 400, error: `Refused: '${oneLine(c, 40).text}' is not an escalation class. One of: ${ESCALATION_CLASSES.join(', ')}.` }
  }
  const s = oneLine(summary)
  if (!s.text) return { ok: false, code: 400, error: 'Refused: an escalation needs a one-line summary.' }
  if (s.text.length > SUMMARY_MAX) {
    return { ok: false, code: 400, error: `Refused: the summary has ${s.text.length} characters; at most ${SUMMARY_MAX}, on one line. Shorten it.` }
  }
  const dup = db.prepare(`SELECT id, state FROM escalations WHERE run_id=? AND class=? AND state IN ('open', 'claimed') ORDER BY id LIMIT 1`).get(run.id, c)
  if (dup) {
    return { ok: false, code: 409, escalation: dup.id,
      error: `Refused: escalation #${dup.id} (${c}) about run ${shortId(run.id)} is still ${dup.state}. Its result arrives in the case file.` }
  }
  const id = Number(db.prepare(`INSERT INTO escalations(run_id, raised_by, class, summary) VALUES(?,?,?,?)`)
    .run(run.id, by ?? null, c, s.text).lastInsertRowid)
  addCaseEntry(run.id, { kind: 'escalated', author: by, text: s.text, data: { escalation: id, class: c } })
  let announced = false
  let delivered = false
  if (escalationGraceMs() === 0) ({ announced, delivered } = await announceEscalation(escalationById(id), 'unclaimed'))
  return { ok: true, id, announced, delivered }
}

/**
 * Tell the operator about one escalation, on the urgent route, the run named
 * first and the link added by `notifyRun()`. Marks it announced (or reminded)
 * whether or not a channel took it — the same rule as every notified flag — so a
 * clock never repeats it. A muted run keeps its meaning: nothing is sent.
 */
export async function announceEscalation(row, why = 'unclaimed') {
  if (!row) return { announced: false, delivered: false }
  const run = getRun(row.run_id)
  const muted = !notifyOnFor(row.run_id)
  const head = run ? reportHeader(run, 'ESCALATION') : `run ${shortId(row.run_id)} ESCALATION:`
  const tail = why === 'claimed_stale'
    ? `🟠 Escalation #${row.id} was claimed by ${row.claimed_by ?? 'a resolver'} and is still not resolved after 24 h.`
    : `🚨 Escalation #${row.id}: the supervisor handed this to an external resolver and nobody has taken it yet. `
      + 'Resolve or dismiss it on the escalations page.'
  const text = `${head}\n\n[${row.class}] ${oneLine(row.summary, SUMMARY_MAX).text}\n\n${tail}`
  const delivered = run ? await notifyRun(row.run_id, 'escalation', text, { dedupe: false }) : false
  db.prepare(`UPDATE escalations SET ${why === 'claimed_stale' ? 'reminded_at' : 'announced_at'}=datetime('now') WHERE id=?`).run(row.id)
  return { announced: !muted, delivered }
}

/**
 * THE function the supervision clock calls on every pass
 * (server/supervision-clock.mjs): announce what has waited too long
 * (`escalationsToAnnounce()`). The immediate announcement at grace 0 happens
 * in `raiseEscalation()`.
 */
export async function escalationNotices(nowMs = Date.now()) {
  const rows = db.prepare(`SELECT * FROM escalations WHERE (state='open' AND announced_at IS NULL)
    OR (state='claimed' AND reminded_at IS NULL) ORDER BY id`).all()
  const due = escalationsToAnnounce(rows, nowMs, escalationGraceMs())
  for (const { row, why } of due) await announceEscalation(row, why)
  return due.length
}

// ------------------------------------------------------------------ the transitions

/** `{ ok:false, code, error }` for an id that names nothing, or a state the transition does not apply to. */
const notFound = (id) => ({ ok: false, code: 404, error: `no escalation #${oneLine(id, 20).text}` })
const conflict = (row, what) => ({ ok: false, code: 409, error: `escalation #${row.id} is ${row.state}; ${what}`, state: row.state })

/** One conditional UPDATE, so two resolvers racing for the same escalation cannot both win. */
function transition(id, fromStates, set, args) {
  const marks = fromStates.map(() => '?').join(',')
  return db.prepare(`UPDATE escalations SET ${set} WHERE id=? AND state IN (${marks})`).run(...args, id, ...fromStates).changes === 1
}

export function claimEscalation(id, by) {
  const row = escalationById(id)
  if (!row) return notFound(id)
  const name = resolverName(by)
  if (!name) return { ok: false, code: 400, error: 'by=<name> is required: letters, digits and . _ @ -, at most 64' }
  if (row.state !== 'open' || !transition(row.id, ['open'], `state='claimed', claimed_by=?, claimed_at=datetime('now')`, [name])) {
    return conflict(escalationById(row.id), 'only an open escalation can be claimed')
  }
  return { ok: true, row: escalationById(row.id) }
}

export function releaseEscalation(id) {
  const row = escalationById(id)
  if (!row) return notFound(id)
  if (row.state !== 'claimed' || !transition(row.id, ['claimed'], `state='open', claimed_by=NULL, claimed_at=NULL, reminded_at=NULL`, [])) {
    return conflict(escalationById(row.id), 'only a claimed escalation can be released')
  }
  return { ok: true, row: escalationById(row.id) }
}

/**
 * `resolve`: the outcome, an optional note (at most `NOTE_MAX`), an optional
 * `by`. Writes a `resolved` entry into the run's case file — which makes the
 * case due, so the next round continues from the result. `asOperator` is the
 * escalations page's own form: the operator resolving it, whoever had claimed it.
 */
export function resolveEscalation(id, { outcome, note, by, asOperator = false } = {}) {
  const row = escalationById(id)
  if (!row) return notFound(id)
  const out = String(outcome ?? '').trim()
  if (!ESCALATION_OUTCOMES.includes(out)) {
    return { ok: false, code: 400, error: `outcome must be one of: ${ESCALATION_OUTCOMES.join(', ')}` }
  }
  const hasBy = by !== undefined && by !== null && String(by).trim() !== ''
  const name = hasBy ? resolverName(by) : null
  if (hasBy && !name) return { ok: false, code: 400, error: 'by=<name>: letters, digits and . _ @ -, at most 64' }
  const text = boundCaseText(note, Number.MAX_SAFE_INTEGER).text
  if (text.length > NOTE_MAX) return { ok: false, code: 400, error: `note is at most ${NOTE_MAX} characters (it has ${text.length})` }
  if (!['open', 'claimed'].includes(row.state)
      || !transition(row.id, ['open', 'claimed'], `state='resolved', resolved_at=datetime('now'), outcome=?, note=?`, [out, text || null])) {
    return conflict(escalationById(row.id), 'only an open or claimed escalation can be resolved')
  }
  const author = asOperator ? 'operator' : resolvedAuthor({ by: name, claimedBy: row.claimed_by })
  addCaseEntry(row.run_id, { kind: 'resolved', author, text,
    data: { escalation: row.id, class: row.class, outcome: out } })
  return { ok: true, row: escalationById(row.id) }
}

/** `dismiss`: the operator's "not a problem". The case file hears it like a result, so the case is due. */
export function dismissEscalation(id) {
  const row = escalationById(id)
  if (!row) return notFound(id)
  if (!['open', 'claimed'].includes(row.state)
      || !transition(row.id, ['open', 'claimed'], `state='dismissed', resolved_at=datetime('now')`, [])) {
    return conflict(escalationById(row.id), 'only an open or claimed escalation can be dismissed')
  }
  addCaseEntry(row.run_id, { kind: 'resolved', author: 'operator',
    data: { escalation: row.id, class: row.class, outcome: 'dismissed' } })
  return { ok: true, row: escalationById(row.id) }
}

/**
 * `escalate {run, class, summary}` — the supervisor operation (registered in
 * supervision.mjs). An `escalated` entry by the supervisor, and the escalation.
 */
export async function escalateOp({ caller, target, body, nowMs }) {
  const r = await raiseEscalation({ run: target, by: caller.id, cls: body.class, summary: body.summary, nowMs })
  if (!r.ok) return { code: r.code, ok: false, error: r.error, ...(r.escalation ? { escalation: r.escalation } : {}) }
  return { run: target.id, short_id: shortId(target.id), escalation: r.id, class: String(body.class).trim(),
    announced: r.announced, delivered: r.delivered,
    message: escalationGraceMs() > 0
      ? 'Raised. The operator hears of it if nobody claims it in time; the result arrives in the case file.'
      : r.announced ? 'Raised, and the operator was told. The result arrives in the case file.'
        : 'Raised, not announced: the run is muted. The result arrives in the case file.' }
}
