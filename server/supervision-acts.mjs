// Freilauf — what a supervisor DOES to another run: the nudge (a message the
// hub types into that run's session), ending a run on purpose, the one question
// to the operator — and the run's side of it, `fl-report reply`.
//
// The handlers are registered as operations in server/supervision.mjs
// (`registerSupervisorOp()`), which authorises every call through
// `supervisionRefusal()` before a handler here runs. Entries are written only
// through `addCaseEntry()`; every run transition goes through `addEvent()` and
// the functions behind `POST /send` (reports.mjs) — never through that route,
// which records everything typed into a session as the operator.
//
// Everything an AGENT reads here (the nudge header, refusals, answers) is an
// English literal; the notification to the operator is a message about a run
// like every other (`notifyRun()`).
import db, { getRun, addEvent } from './db.mjs'
import { shortId, sendCommandToSession, fmtDurationEn, parseDbUtc } from './util.mjs'
import { FINISHED } from './run-state.mjs'
import { NUDGE_TAG, noteAgentState, answerHelpCall, startFollowUpCommission, notifyRun, reportHeader } from './reports.mjs'
import { notifyOnFor } from './notify.mjs'
import { addCaseEntry, boundCaseText, CASE_CHOICE_MAX, CASE_TEXT_MAX, supervisionSetting } from './supervision.mjs'

// ------------------------------------------------------------------ the nudge

/**
 * A conflict run is the integrator's tool, not a case: typing into
 * it or ending it would fight the merge it exists for. Acting goes to the run
 * it works for; looking at it stays allowed.
 */
function conflictRefusal(target) {
  if (!target.resolves_run_id) return null
  return { code: 403, ok: false, error: `Refused: run ${shortId(target.id)} is the integrator's conflict run for run `
    + `${shortId(target.resolves_run_id)}. Leave it to the integrator; act on run ${shortId(target.resolves_run_id)} instead.` }
}

/** The longest message a supervisor may have typed into a run. Longer is refused, never cut. */
export const NUDGE_TEXT_MAX = 4000

/** How many nudges a case may receive since the last `answer` entry ('' or junk is the default), held to 1–20. */
export function nudgeLimit() {
  return supervisionSetting('nudges')
}

/**
 * The message as the hub types it: `{ typed, pasted }`. Pure and stable, so the
 * header is a unit test.
 *
 *   typed   the tag, as KEYSTROKES — so the head of the submitted line starts
 *           with it even where claude collapses a long paste into a placeholder
 *           (docs/pitfalls.md), and the run's prompt hook can say "this was a
 *           nudge" (reports.mjs, submissionKind). A CONSTANT without digits:
 *           whatever is typed reaches a TUI as keys, and in a numbered menu or a
 *           dialog a digit is a choice — the supervisor's short id goes into the
 *           pasted header instead;
 *   pasted  the header the hub writes — who it is from, whose authority it
 *           carries, how to answer — and the supervisor's text after it, with
 *           only the envelope's own tag neutralised (`&lt;`), so the text can
 *           neither close the envelope nor open a second one.
 *
 * Only the hub composes the header; nothing the supervisor sends can change it.
 * Short and plain, because it lands in the context of an agent that may run on
 * a small model. "On behalf of the operator", never "from the operator": the
 * authority is the operator's, the words are the supervisor's.
 */
export function composeNudge({ from, text }) {
  const who = shortId(String(from ?? ''))
  const typed = `<${NUDGE_TAG}>`
  const body = String(text ?? '').replace(new RegExp(`<(/?${NUDGE_TAG})`, 'gi'), '&lt;$1')
  const pasted = [
    '',
    `From the supervisor of this Freilauf hub (run ${who}), on behalf of the operator and with the operator's authority.`,
    'Reply with: fl-report reply "<your answer>" — nobody reads your screen.',
    'Message:',
    body,
    `</${NUDGE_TAG}>`,
  ].join('\n')
  return { typed, pasted }
}

/** Runs a nudge is being typed into right now: a second one would interleave its keys with the first's. */
const TYPING = new Set()

/** How many nudges this case received since the operator last answered. */
export function nudgesSinceAnswer(runId) {
  return db.prepare(`SELECT count(*) c FROM case_entries WHERE run_id=? AND kind='message'
    AND id > COALESCE((SELECT max(id) FROM case_entries WHERE run_id=? AND kind='answer'), 0)`).get(runId, runId).c
}

const NUDGE_REFUSALS = {
  empty: () => 'Refused: a nudge needs a text.',
  long: (n) => `Refused: the message has ${n} characters; at most ${NUDGE_TEXT_MAX} are typed into a session. Shorten it.`,
  limit: (run, n, max) => `Refused: run ${shortId(run.id)} has received ${n} nudge(s) since the operator last answered, `
    + `and ${max} is the limit. Do not nudge it again: ask the operator (fl-supervise question) or escalate.`,
  noSession: (run) => `Refused: run ${shortId(run.id)} has no live session, so there is nobody to type into. `
    + 'Reviving it is a separate step; or end it, or close the case.',
  paneDead: (run) => `Refused: the agent of run ${shortId(run.id)} is gone — its pane is dead. Nothing was typed. `
    + 'Reviving it is a separate step; or end it, or close the case.',
  unknown: (run) => `Refused: tmux could not say whether run ${shortId(run.id)} is alive, so nothing was typed. `
    + 'Try again on a later round.',
  busy: (run) => `Refused: a nudge is being typed into run ${shortId(run.id)} right now. Wait for its answer; `
    + 'do not send two at once.',
  typeFailed: (run, why) => `Refused: typing into the session of run ${shortId(run.id)} failed (${why}). `
    + 'Nothing was recorded; read the case before trying again.',
}

/**
 * `nudge {run, text}`: type a message into another run's session, with the
 * header only the hub writes, and record what it means for that run:
 *
 *   - a `message` entry in its case file and a `supervisor_message` event;
 *   - a waiting agent reads as working from this moment (`noteAgentState`,
 *     source `supervisor`) — like the operator's input, never AS it;
 *   - into a run waiting for help it is the answer (`help_answered {via:'supervisor'}`);
 *   - into a finished run it opens a follow-up commission
 *     (`followup_started {via:'supervisor'}`), so the finish gate and the
 *     integration run again when it reports;
 *   - `runs.nudge_typed_at` is set BEFORE the keys go in, so the agent's own
 *     prompt hook — which may arrive before this function has finished — is
 *     read as the nudge's echo and changes nothing further.
 */
export async function nudgeOp({ caller, target, body }) {
  const conflict = conflictRefusal(target)
  if (conflict) return conflict
  const ids = { run: target.id, short_id: shortId(target.id) }
  const raw = String(body.text ?? '')
  const text = boundCaseText(raw, Number.MAX_SAFE_INTEGER).text
  if (!text) return { code: 400, ok: false, error: NUDGE_REFUSALS.empty() }
  if (text.length > NUDGE_TEXT_MAX) return { code: 400, ok: false, error: NUDGE_REFUSALS.long(text.length) }
  // One nudge per run at a time: two typed at once interleave their keys in one
  // session, and both would pass the limit below before either was counted.
  if (TYPING.has(target.id)) return { code: 409, ok: false, error: NUDGE_REFUSALS.busy(target) }
  TYPING.add(target.id)
  try { return await typeNudge({ caller, target, text, ids }) } finally { TYPING.delete(target.id) }
}

async function typeNudge({ caller, target, text, ids }) {
  const max = nudgeLimit()
  const sent = nudgesSinceAnswer(target.id)
  if (sent >= max) return { code: 403, ok: false, error: NUDGE_REFUSALS.limit(target, sent, max), nudges_since_answer: sent, limit: max }

  // Is there anybody to type into? Three answers, of which only one may act.
  const { paneAlive, sessionGone } = await import('./sessions.mjs')
  const session = target.tmux_session
  if (!session || target.tmux_closed_at) return { code: 409, ok: false, error: NUDGE_REFUSALS.noSession(target) }
  const alive = await paneAlive(session)
  if (alive === false) return { code: 409, ok: false, error: NUDGE_REFUSALS.paneDead(target) }
  if (alive !== true) {
    const gone = await sessionGone(session)
    if (gone === true) return { code: 409, ok: false, error: NUDGE_REFUSALS.noSession(target) }
    return { code: 503, ok: false, error: NUDGE_REFUSALS.unknown(target) }
  }

  db.prepare(`UPDATE runs SET nudge_typed_at=datetime('now') WHERE id=?`).run(target.id)
  const { typed, pasted } = composeNudge({ from: caller.id, text })
  const r = await sendCommandToSession(session, typed, pasted)
  if (!r.ok) {
    db.prepare('UPDATE runs SET nudge_typed_at=NULL WHERE id=?').run(target.id)
    return { code: 502, ok: false, error: NUDGE_REFUSALS.typeFailed(target, String(r.stderr || 'tmux error').trim().slice(0, 200)) }
  }
  db.prepare(`UPDATE runs SET last_activity_at=datetime('now') WHERE id=?`).run(target.id)

  // What the line means depends on where the run stands now that it was typed
  // — read AGAIN, because the checks and the typing took a second in which the
  // run may have reported or been answered. The same three ways the send route
  // takes, attributed to the supervisor.
  const fresh = getRun(target.id) ?? target
  const into = fresh.status === 'waiting_help' ? 'help'
    : FINISHED.includes(fresh.status) ? 'followup' : 'running'
  if (fresh.agent_state === 'waiting') noteAgentState(fresh, 'working', 'supervisor')
  addEvent(target.id, 'supervisor_message', { by: caller.id, into, text: text.slice(0, 500) })
  if (into === 'help') answerHelpCall(target.id, text, 'supervisor', { by: caller.id })
  else if (into === 'followup') startFollowUpCommission(target.id, text, 'supervisor', { by: caller.id })
  const e = addCaseEntry(target.id, { kind: 'message', author: caller.id, text, data: { into } })
  db.prepare('UPDATE case_state SET nudges = nudges + 1 WHERE run_id=?').run(target.id)
  return { ...ids, entry: e.id, into, nudges_since_answer: sent + 1, limit: max,
    message: into === 'help' ? 'Typed in; it answers the run\'s help call.'
      : into === 'followup' ? 'Typed in; it opened a follow-up commission, so the run reports and is integrated again.'
        : 'Typed in.' }
}

// ------------------------------------------------------------------ the reply

/**
 * `fl-report reply` (reports.mjs): a `reply` entry by `run` in the run's own
 * case file, and nothing else. An inbox replay of the same text is written
 * once: identical to the newest reply with no nudge since, it is the same
 * reply — a second nudge answered the same way is a new one.
 */
export function recordReply(runId, raw) {
  const text = boundCaseText(raw).text
  const last = db.prepare(`SELECT id, text FROM case_entries WHERE run_id=? AND kind='reply' ORDER BY id DESC LIMIT 1`).get(runId)
  if (last && last.text === text) {
    const nudgeSince = db.prepare(`SELECT 1 FROM case_entries WHERE run_id=? AND kind='message' AND id > ? LIMIT 1`).get(runId, last.id)
    if (!nudgeSince) return { duplicate: true, id: last.id }
  }
  const e = addCaseEntry(runId, { kind: 'reply', author: 'run', text })
  return { duplicate: false, id: e.id }
}

// ------------------------------------------------------------------ ending a run

/**
 * `end {run, reason}`: the kill route's semantics (sessions.mjs, `endRun`),
 * attributed to the supervisor with its run and the reason, plus an `action`
 * entry. The answer says what the existing semantics left behind, so the
 * supervisor does not assume more happened than did.
 */
export async function endOp({ caller, target, body }) {
  const conflict = conflictRefusal(target)
  if (conflict) return conflict
  const reason = boundCaseText(body.reason).text
  if (!reason) return { code: 400, ok: false, error: 'Refused: ending a run needs a reason.' }
  const { endRun } = await import('./sessions.mjs')
  const r = await endRun(target.id, { by: 'supervisor', supervisorRun: caller.id, reason })
  const e = addCaseEntry(target.id, { kind: 'action', author: caller.id, text: reason,
    data: { op: 'end', outcome: r.outcome, followup_abandoned: r.followupAbandoned, status_before: target.status } })
  const left = r.outcome === 'session_closed'
    ? `Run ${shortId(target.id)} had already ended (${target.status}); only its session was closed and its status stays.`
      + (r.followupAbandoned ? ' Its open follow-up commission was abandoned.' : '')
    : `Run ${shortId(target.id)} is now aborted and its session is closed.`
      + (r.followupAbandoned ? ' Its open follow-up commission was abandoned.' : '')
  return { run: target.id, short_id: shortId(target.id), entry: e.id, outcome: r.outcome,
    followup_abandoned: r.followupAbandoned,
    message: `${left} Unmerged work stays where it is (its worktree and branch); the hub assesses it and tells the operator `
      + 'if anything is left unmerged. Nothing was merged or deleted.' }
}

// ------------------------------------------------------------------ the question

/** At most this many answer buttons on one question. */
export const QUESTION_CHOICES_MAX = 6

/** The open question of a case: the newest `question` entry with no `answer` after it, or null. */
export function openQuestion(runId) {
  const q = db.prepare(`SELECT id, ts, text, data FROM case_entries WHERE run_id=? AND kind='question' ORDER BY id DESC LIMIT 1`).get(runId)
  if (!q) return null
  const answered = db.prepare(`SELECT 1 FROM case_entries WHERE run_id=? AND kind='answer' AND id > ? LIMIT 1`).get(runId, q.id)
  if (answered) return null
  let data = null
  try { data = q.data ? JSON.parse(q.data) : null } catch { data = null }
  return { ...q, data }
}

/**
 * Choice labels as the supervisor sent them (an array, or one string) →
 * `{ choices }` or `{ error }`. Each one line, bounded, non-empty, no duplicates.
 */
export function questionChoices(raw) {
  const list = raw === undefined || raw === null ? [] : Array.isArray(raw) ? raw : [raw]
  const out = []
  for (const c of list) {
    const label = boundCaseText(String(c ?? '').replace(/\s+/g, ' '), Number.MAX_SAFE_INTEGER).text
    if (!label) return { error: 'Refused: a choice needs a label.' }
    if (label.length > CASE_CHOICE_MAX) return { error: `Refused: a choice is a short label, at most ${CASE_CHOICE_MAX} characters.` }
    if (!out.includes(label)) out.push(label)
  }
  if (out.length > QUESTION_CHOICES_MAX) return { error: `Refused: at most ${QUESTION_CHOICES_MAX} choices.` }
  return { choices: out }
}

/** The text of the notification: the run named first (`reportHeader`), the question, the choices. */
export function questionMessage(run, text, choices) {
  return `${reportHeader(run, 'QUESTION FROM THE SUPERVISOR')}\n\n${text}`
    + (choices.length ? `\n\nChoices: ${choices.join(' · ')}` : '')
    + '\n\n❓ Answer on the run\'s page, in its case file.'
}

/**
 * `question {run, text, choices?}`: one prepared question to the operator about
 * a case — a `question` entry with its choices, and one message on the urgent
 * route (`supervisor_question`), the link added by `notifyRun()`. One open
 * question per case: a second waits until the first is answered. A muted run
 * keeps its meaning: the entry is written, nothing is sent, and the
 * answer says so.
 */
export async function questionOp({ caller, target, body, nowMs }) {
  const text = boundCaseText(body.text, Number.MAX_SAFE_INTEGER).text
  if (!text) return { code: 400, ok: false, error: 'Refused: a question needs a text.' }
  if (text.length > CASE_TEXT_MAX) return { code: 400, ok: false, error: `Refused: a question is at most ${CASE_TEXT_MAX} characters.` }
  const c = questionChoices(body.choices)
  if (c.error) return { code: 400, ok: false, error: c.error }
  const open = openQuestion(target.id)
  if (open) {
    const age = fmtDurationEn(Math.max(0, (nowMs - parseDbUtc(open.ts)) / 1000))
    return { code: 409, ok: false, open_question: open.id,
      error: `Refused: a question about run ${shortId(target.id)} is already open (asked ${age} ago). `
        + 'Wait for the operator\'s answer — it makes the case due again.' }
  }
  const e = addCaseEntry(target.id, { kind: 'question', author: caller.id, text,
    data: c.choices.length ? { choices: c.choices } : null })
  // notifyRun() itself honours the mute (and writes `notify_muted`); asked first
  // only so the answer can say which of the two happened.
  const muted = !notifyOnFor(target.id)
  const delivered = await notifyRun(target.id, 'supervisor_question', questionMessage(target, text, c.choices), { dedupe: false })
  return { run: target.id, short_id: shortId(target.id), entry: e.id, choices: c.choices, announced: !muted,
    delivered, message: muted
      ? 'Recorded, not announced: the run is muted. The operator sees it on the run\'s page.'
      : 'Asked. The answer arrives in the case file and makes the case due again.' }
}

/** What the run page needs of an open question: its id and its choice buttons, or null. */
export function questionForPage(runId) {
  const q = openQuestion(runId)
  return q ? { id: q.id, choices: Array.isArray(q.data?.choices) ? q.data.choices : [] } : null
}
