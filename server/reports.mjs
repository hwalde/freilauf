// Freilauf — processing of agent reports (fl-report → POST /api/runs/<id>/report
// or fallback inbox.jsonl collected by the watcher). Planning 6 + 11.
import db, { addEvent } from './db.mjs'
// `notifyChannels` and not `notify`: `completeFollowUp()` below takes an option
// literally called `notify`, and a parameter that silently shadows a module
// import is the kind of trap that only shows up the day somebody moves a line.
import { notify as notifyChannels, notifyOnFor, detailUrl } from './notify.mjs'
import { sh, parseDbUtc } from './util.mjs'
import { vorfallMelden, detektorLog } from './incidents.mjs'
import { typVonClaudeFehler, typVonText, TYP_TEXT, fremdeClaudeSession, isSessionStopped } from './detect.mjs'
import { getHarness } from './harnesses/index.mjs'
import { transcriptState } from './cursor-transcript.mjs'

const MAX_REPORT = 200 * 1024   // planning 11: report ≤ 200 kB

/**
 * The kinds the harness hooks deliver through fl-report. A claude hook event
 * carries its own session id — and a claude process the AGENT spawned (a probe,
 * a test) inherits the worktree's hooks and FL_RUN_ID while carrying its own
 * session id. Without the guard its failures land on this run as red incidents.
 */
const HOOK_KINDS = ['_turn_end', '_exit', '_api_error', '_rate_limit', '_idle', '_working', '_waiting']

// ------------------------------------------------------------ the agent's attention
//
// "Is the agent working, or is it sitting at its prompt waiting for me?" is a
// question the run's status could not answer. `running` stayed `running` while
// claude had long finished its turn, and a finished run stayed `done` while the
// operator was typing into its terminal — the terminal on the run page writes
// straight into tmux, so the hub never saw the conversation. And the only thing
// that could have said so was the coding agent itself.
//
// So the harnesses' hooks say it (docs/plugins.md, "Attention"): `_working`
// when the CLI starts processing input (claude UserPromptSubmit / PreToolUse,
// cursor beforeSubmitPrompt, opencode session.status busy, hermes
// pre_llm_call), `_waiting` or `_turn_end` when its turn is over and it waits
// for a human (claude Stop / Notification idle_prompt, cursor stop, opencode
// session.status idle, hermes on_session_end). `runs.agent_state` holds the
// last word, and server/run-state.mjs turns it into the status word the pages
// show. Two rules every hook has to keep, because each was measured to go wrong
// otherwise: a SUBAGENT's end is never "waiting" (opencode fires session.idle
// for every child session, claude fires SubagentStop — the parent is still
// working), and a state is only written when it CHANGES, so a hook firing on
// every tool call costs one UPDATE and no event.

/**
 * Record what the agent's hook said. Returns true when the state changed —
 * and only then writes an event, so the live channel re-renders the row.
 */
export function noteAgentState(run, state, source) {
  if (!run || !['working', 'waiting'].includes(state)) return false
  if (run.agent_state === state) return false
  db.prepare(`UPDATE runs SET agent_state=?, agent_state_at=datetime('now') WHERE id=?`).run(state, run.id)
  addEvent(run.id, state === 'waiting' ? 'agent_waiting' : 'agent_working', { source })
  run.agent_state = state
  return true
}

/**
 * The session is over (or a new one starts): whatever the old agent said about
 * its attention describes a process that is gone. No event — the end itself is
 * recorded by whoever ended it.
 */
export function clearAgentState(runId) {
  db.prepare(`UPDATE runs SET agent_state=NULL, agent_state_at=NULL WHERE id=? AND agent_state IS NOT NULL`).run(runId)
}

/**
 * A help call is answered — by the send route with the operator's text, or by
 * the agent's own `_working` hook when the operator typed the answer straight
 * into the terminal (then the hub never saw the text, and `help_answer` stays
 * empty). Either way the run is `running` again and the finish gate's clock,
 * which does not run while a run waits for a HUMAN, starts again from now.
 */
export function answerHelpCall(runId, text, via = 'web') {
  db.prepare(`UPDATE runs SET status='running', help_answer=COALESCE(?, help_answer),
              finish_started_at=CASE WHEN finish_state IS NULL THEN finish_started_at
                                     ELSE datetime('now') END WHERE id=? AND status='waiting_help'`).run(text, runId)
  addEvent(runId, 'help_answered', { text: text ? String(text).slice(0, 500) : null, via })
}

/**
 * How long after a report a `_working` that is NOT a human prompt is still the
 * tail of the reporting turn. `fl-report done` is a tool call INSIDE the turn,
 * and an agent usually makes two or three more calls after it — prints a
 * summary, runs `git status`, deletes its task file — before it stops.
 * Every one of those arrives as `_working` on a run that is already `done`,
 * and read as a commission it turned every finished run into "waiting for
 * input" the moment the agent went quiet. Two minutes, `FREILAUF_ATTENTION_GRACE_MS`.
 */
export function attentionGraceMs() {
  const raw = process.env.FREILAUF_ATTENTION_GRACE_MS
  if (raw === undefined || raw === '') return 2 * 60_000
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : 2 * 60_000
}

/**
 * Does a `_working` on a FINISHED run with no open commission open one? Pure,
 * so the rule can be stated in a test.
 *
 *   source 'prompt'   a human submitted a line (claude UserPromptSubmit, cursor
 *                     beforeSubmitPrompt, hermes pre_llm_call): a commission,
 *                     whenever it comes — nothing but a person produces it.
 *   anything else     a tool call, opencode's busy, an unnamed hook: only once
 *                     the grace window since the last report has passed. Inside
 *                     it, it is the reporting turn finishing.
 */
export function commissionOnWorking(source, sinceReportMs, graceMs = attentionGraceMs()) {
  if (source === 'prompt') return true
  return !(Number.isFinite(sinceReportMs) && sinceReportMs < graceMs)
}

/**
 * The moment of the run's latest report — the end of the first attempt, or
 * the latest follow-up's acceptance, whichever is later. Infinity ago when
 * nothing is known, so an unknown never reads as "just now".
 */
export function lastReportMs(run) {
  const stamps = []
  if (run?.ended_at) stamps.push(parseDbUtc(run.ended_at))
  const ev = db.prepare(`SELECT ts FROM events WHERE run_id=? AND kind IN ('done','followup_reported','followup_done','followup_failed')
    ORDER BY id DESC LIMIT 1`).get(run?.id)?.ts
  if (ev) stamps.push(parseDbUtc(ev))
  const known = stamps.filter(Number.isFinite)
  return known.length ? Math.max(...known) : -Infinity
}

/**
 * A finished run is given more work: the operator typed into its session. The
 * send route knows the moment exactly; the terminal on the run page does not
 * pass through the hub, so there the agent's own `_working` hook is what says
 * it. From this moment the run displays as running again and the watcher holds
 * it to its expected duration (watchFollowUps) — every new instruction restarts
 * that clock and retracts the previous commission's "longer than expected".
 */
export function startFollowUpCommission(runId, text, via = 'web') {
  db.prepare(`UPDATE runs SET followup_since=datetime('now') WHERE id=?`).run(runId)
  addEvent(runId, 'followup_started', { text: text ? String(text).slice(0, 500) : null, via })
  clearAnomalies(runId, ['anomaly:followup_soft_overrun', 'anomaly:followup_overrun',
    ...notifiedFlags('followup_overrun')])
}

/**
 * Process one report event. Returns `{ ok, message? }`.
 *
 * `via` says how the report reached the hub, and the finish gate needs it: with
 * 'http' the agent is standing in its own `fl-report` call and the answer travels
 * back as that tool's output — the cheapest moment there is. Every other channel
 * has no call to answer, so the same text is typed into the tmux session
 * instead (see server/integrate.mjs).
 */
export async function handleReport(runId, body, via = 'http') {
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId)
  if (!run) return { ok: false, error: 'unknown or already finished run' }
  // A run that is over can still be spoken to — its agent is still sitting in
  // the session, and the operator types more work into it. What it reports
  // then is a FOLLOW-UP (see handleFollowUp), not an error.
  if (['done', 'failed', 'aborted'].includes(run.status)) return handleFollowUp(run, body, via)
  // Planning 11: only accept existing runs in running/waiting_help.
  if (!['running', 'waiting_help'].includes(run.status)) return { ok: false, error: 'unknown or already finished run' }
  const kind = String(body.kind || '')
  // A hook report from a claude session that is NOT this run's own: the agent
  // spawned its own claude (a probe, an error-handling test), which inherited
  // the worktree's hooks and FL_RUN_ID. Its API errors are the run's subject
  // matter, not the run's provider problems — logged for the detector's
  // protocol, ignored otherwise. fl-report only sends session_id when the hook
  // JSON carried one, so an older fl-report changes nothing here.
  if (HOOK_KINDS.includes(kind) && fremdeClaudeSession(runId, run.harness, body.session_id)) {
    detektorLog(runId, { art: 'verworfen', grund: 'hook report from a foreign claude session (a process the agent spawned)',
      kind, session: body.session_id })
    return { ok: true, message: null }
  }
  let text = typeof body.text === 'string' ? body.text : ''
  if (typeof body.file === 'string') {
    if (body.file.length > MAX_REPORT) return { ok: false, error: 'payload too large' }
    text = text ? `${text}\n\n${body.file}` : body.file
  }
  // The DETAILED version of the report (fl-report --detail): the short report
  // is the message text, the detail is the attached document. Optional — a run
  // without one behaves exactly as before, and the document then carries the
  // full report again.
  const detail = typeof body.detail === 'string' ? body.detail : ''
  if (detail.length > MAX_REPORT) return { ok: false, error: 'payload too large' }

  // A terminal report for a CLEANUP run is the moment its work becomes visible
  // in the numbers: the agent freed memory while it worked, and the sidebar's
  // block must not go on serving a reading measured up to eight minutes earlier
  // (refreshSessionMemoryAfterRun in sessions.mjs). Done here, BEFORE the end
  // event below is published — the client answers that event by re-fetching the
  // sidebar fragment ~2 s later, and that render then carries the fresh value.
  // Any other run leaves the cache alone.
  if (['done', 'failed', '_pane_died'].includes(kind)) {
    import('./sessions.mjs').then(m => m.refreshSessionMemoryAfterRun(runId)).catch(() => {})
  }

  switch (kind) {
    case 'done': {
      // The finish gate: with repos.merge_mode='hub' a `done` report is CHECKED
      // rather than believed — is the worktree clean, does the branch still
      // merge? null means this repo does not want the hub to integrate, and
      // then everything below is byte for byte what it always was.
      //
      // The DETAILED report is stored BEFORE the gate runs: when the run has
      // work to merge the gate holds and the notification happens in the
      // integrator, so the detail has to be in the database already by then.
      if (detail) db.prepare(`UPDATE runs SET report_detail_md=? WHERE id=?`).run(detail, runId)
      const gate = await finishGate(runId, text, via)
      if (gate?.hold) return { ok: true, message: gate.message ?? null }
      db.prepare(`UPDATE runs SET status='done', ended_at=datetime('now'), report_md=?,
                  report_detail_md=COALESCE(report_detail_md, ?) WHERE id=?`)
        .run(text || null, detail || null, runId)
      addEvent(runId, 'done')
      await notifyRun(runId, 'done', doneText(run, text, gate?.mergeLine ?? null),
        { fileName: `report-${runId.slice(0, 8)}.md`, fileContent: detail || text })
      break
    }
    case 'failed': {
      db.prepare(`UPDATE runs SET status='failed', ended_at=datetime('now'), report_md=? WHERE id=?`)
        .run(`**Failed:** ${text}`, runId)
      addEvent(runId, 'failed')
      // Never merged automatically — but named: what a failed run left behind is
      // a fact the operator should not have to go looking for.
      const assessment = await assessAfterEnd(runId)
      await notifyRun(runId, 'failed', `${reportHeader(run)}\n\n${text}\n\n❌ Run failed · ${harnessLabel(run)}${assessment}`, { fileName: `failed-${runId.slice(0, 8)}.md`, fileContent: text })
      break
    }
    case 'help': {
      // A replayed help call (the inbox path) while the run is ALREADY waiting
      // on this very question must not ring again — `dedupe:false` exists so a
      // NEW question is always heard, and `isReplayedReport` guards the other
      // side of it.
      const schon = run.status === 'waiting_help' && run.help_text === text
      db.prepare(`UPDATE runs SET status='waiting_help', help_text=? WHERE id=?`).run(text, runId)
      addEvent(runId, 'help')
      // The question MUST arrive completely — truncated it cannot be answered.
      if (!schon) {
        await notifyRun(runId, 'help', `${reportHeader(run)}\n\n${text}\n\n🆘 Help call · ${harnessLabel(run)}`,
          { fileName: `help-${runId.slice(0, 8)}.md`, fileContent: text, dedupe: false })
      }
      break
    }
    case 'progress': {
      addEvent(runId, 'progress', { text })
      db.prepare(`UPDATE runs SET last_activity_at=datetime('now') WHERE id=?`).run(runId)
      clearAnomalies(runId, ['anomaly:overrun', 'anomaly:soft_overrun', 'anomaly:no_activity'])
      break
    }
    case 'branch': {
      db.prepare('UPDATE runs SET branch_reported=? WHERE id=?').run(String(body.branch || ''), runId)
      addEvent(runId, 'branch', { branch: body.branch })
      break
    }
    case 'pr': {
      db.prepare('UPDATE runs SET pr_url=? WHERE id=?').run(String(body.pr || ''), runId)
      addEvent(runId, 'pr', { pr: body.pr })
      break
    }
    case '_turn_end':
      addEvent(runId, 'turn_end')
      // A turn that ended is an agent waiting for input — for every harness
      // whose CLI stays up. For one whose process exits with the turn, `_exit`
      // clears it a moment later.
      noteAgentState(run, 'waiting', 'turn_end')
      // For most harnesses the end of a turn is just a note. For cursor it is
      // the end of the RUN (harnesses/cursor.mjs: turnEndsRun) — its TUI stays
      // standing afterwards, so nothing else will ever say the work is over.
      await finishByTurnEnd(runId, 'stop hook')
      break
    case '_waiting':
      noteAgentState(run, 'waiting', body.source ?? 'hook')
      break
    case '_working':
      noteAgentState(run, 'working', body.source ?? 'hook')
      // The agent was waiting on a help call and now processes input: somebody
      // answered — by hand, into the terminal, past the send route. The run is
      // running again; the answer's text is unknown and stays empty.
      if (run.status === 'waiting_help') answerHelpCall(runId, null, 'session')
      break
    case '_exit': {
      addEvent(runId, 'exit')
      clearAgentState(runId)
      const fresh = db.prepare('SELECT status, finish_state FROM runs WHERE id = ?').get(runId)
      // A run in the finish gate HAS reported. Its agent vanishing is not
      // "ended without a report", it is the escalation trigger (3.3).
      if (fresh?.finish_state) { await escalateGone(runId); break }
      if (fresh?.status === 'running') {
        // Process gone without done/failed → red (planning 4.5); the watcher confirms via pane_dead.
        addEventOnce(runId, 'anomaly:exit_without_report')
        await notifyRun(runId, 'exit_without_report', '🔴 Process ended without a report.')
      }
      break
    }
    case '_rate_limit':   // old name, same path
    case '_api_error': {
      // Hook report: claude 'StopFailure' (fixed enum) or opencode
      // 'session.error' (free text). The hook is the most reliable source —
      // immediately red.
      const roh = String(body.error ?? (kind === '_rate_limit' ? 'rate_limit' : 'unknown'))
      // The session being stopped is not a provider fault, and it is very often
      // the HUB doing the stopping (retention, the kill route, a flow, an
      // archive). The end is recorded by whoever ended it; an incident on top
      // of that is an alarm about our own cleanup — see isSessionStopped().
      if (isSessionStopped(text) || isSessionStopped(roh)) break
      let typ = typVonClaudeFehler(roh)
      if (typ === null) break                       // e.g. max_output_tokens: not a provider problem
      if (typ === 'unbekannt') typ = typVonText(`${roh} ${text}`)
      if (typ === 'rate_limit') db.prepare('UPDATE runs SET rate_limit_hits = rate_limit_hits + 1 WHERE id=?').run(runId)
      const beleg = [roh !== 'unknown' ? roh : null, text].filter(Boolean).join(' — ').slice(0, 300) || null
      await vorfallMelden(runId, { typ, quelle: `hook:${run.harness}`, schwere: 'rot', beleg })
      break
    }
    case '_idle':
      addEvent(runId, 'idle')
      db.prepare(`UPDATE runs SET last_activity_at=datetime('now') WHERE id=?`).run(runId)
      break
    case '_pane_died': {
      addEvent(runId, 'pane_died', { exit: body.exit ?? null })
      clearAgentState(runId)
      const fresh = db.prepare('SELECT status, finish_state FROM runs WHERE id = ?').get(runId)
      if (fresh?.finish_state) { await escalateGone(runId); break }
      if (fresh?.status === 'running') {
        db.prepare(`UPDATE runs SET status='failed', ended_at=datetime('now'), exit_code=? WHERE id=?`)
          .run(Number.isFinite(+body.exit) ? +body.exit : null, runId)
        const assessment = await assessAfterEnd(runId)
        await notifyRun(runId, 'pane_died', `🔴 Process dead without a report (tmux pane_dead).${assessment}`)
      }
      break
    }
    default:
      return { ok: false, error: `unknown kind '${kind}'` }
  }
  if (['done', 'failed', '_pane_died'].includes(kind)) {
    // The run may have just ended: evaluate the flows' "run finished" triggers
    // now instead of waiting for the next watcher tick (server/flows/).
    import('./flows/triggers.mjs').then(m => m.flowsTick()).catch(e => console.error('[flows]', e.message))
  }
  return { ok: true }
}

/**
 * The agent ended its turn without reporting — close the run anyway.
 *
 * This exists for one harness shape: cursor works through the task and then
 * stays in its TUI at "→ Add a follow-up". The pane never dies, the process
 * never exits, so `_pane_died` and `_exit` never come. Whoever waits for
 * `fl-report done` there waits forever, and everything the repo has queued
 * behind that run waits with it.
 *
 * Only from status 'running': `waiting_help` means the agent asked a question
 * and is deliberately idle until a human answers — ending its turn is the
 * correct behaviour there, not the end of the work. And a run that reported
 * properly is already 'done' by the time the hook fires (fl-report is a tool
 * call INSIDE the turn, the hook comes after it), so this only ever catches the
 * case it is meant for.
 *
 * The report text comes from the harness's transcript: the agent's own closing
 * words are what a human would have gotten had it called fl-report. Everything
 * else — the notification, events, flows, cost accounting — happens because this goes
 * back through the normal 'done' path instead of writing the row itself.
 *
 * Returns true when the run was closed here.
 */
export async function finishByTurnEnd(runId, source) {
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId)
  if (!run || run.status !== 'running') return false
  if (!getHarness(run.harness)?.turnEndsRun) return false
  const state = run.harness === 'cursor' ? transcriptState(run) : null
  const note = `_(Freilauf closed this run: the agent ended its turn without calling \`fl-report done\` `
    + `— noticed via ${source}. The text above is the agent's own closing message`
    + `${state?.lastAnswer ? '' : ', which the transcript did not yield'}.)_`
  const text = [state?.lastAnswer, note].filter(Boolean).join('\n\n')
  addEvent(runId, 'turn_end_finished', { source, transcript: !!state?.lastAnswer })
  // 'internal': there is no fl-report call to answer here, so the finish gate
  // types its answer into the session instead (server/integrate.mjs).
  await handleReport(runId, { kind: 'done', text }, 'internal')
  return true
}

// ------------------------------------------------------------ follow-up reports
//
// Three of the four coding agents stay in their TUI after `fl-report done`, and
// the run's terminal stays writable for exactly that reason: the operator reads
// the report, sees that something is not finished, and types the rest into the
// same session. The agent does it, commits — and until this existed nothing
// happened next: `handleReport()` refused a finished run, so the commits sat in
// the worktree, no merge, no flow, no message.
//
// A report from a finished run is therefore a FOLLOW-UP REPORT. Deliberately the
// SAME command (`fl-report done --file …`) and not a second one: the agent has
// just used it, it is the one instruction every prompt carries, and a second
// verb would be a second thing to forget. The hub can tell the two apart by
// itself — the run's status says whether this is the first report or another
// one — and the agent does not need to know.
//
// What a follow-up does, in the order it happens:
//   1. the text is appended to `report_md` under its own heading and kept on
//      its own in `followup_md`; `followups` counts them;
//   2. the finish gate runs exactly as for the first report (dirt, commits,
//      conflict), and the integrator merges — `followup_open` is what tells the
//      integrator's end (`finishMerged`, `closeKept`, `blockRun`) that this
//      integration belongs to a follow-up;
//   3. the attached flows fire again (`rearmDispatch`), the merged ones too;
//   4. the configured channels hear "FOLLOW-UP REPORT #n" — never deduplicated,
//      because every follow-up is news, and only while the run's notification
//      checkbox is on.
//
// The status of the run does NOT change: a `done` run stays `done`, a `failed`
// one stays `failed` (its record is the truth about the first attempt; what
// the follow-up delivered is in the merge line and the report).

/** The kinds a finished run still answers to. Hooks are handled apart. */
const FOLLOWUP_KINDS = ['done', 'failed', 'help', 'progress', 'branch', 'pr']

/**
 * Should a turn end on a FINISHED run count as its follow-up report?
 *
 * Only for a coding agent whose turn end is its run end (cursor: the TUI stays
 * standing, nothing else ever says the work is over), and only when there is
 * something to integrate — the worktree's tip has moved past what was merged
 * last. A follow-up that changed nothing (an answer, a list) has to be reported
 * with `fl-report done` by the agent itself; the net exists for the commits
 * that would otherwise never reach the base branch. Pure, so the rule can be
 * stated in a test.
 */
export function wantsTurnEndFollowUp(run, tip, harness) {
  if (!run || !['done', 'failed', 'aborted'].includes(run.status)) return false
  if (run.finish_state || run.followup_open) return false        // already reporting
  if (!harness?.turnEndsRun) return false
  if (!tip || !run.merged_sha) return false                        // nothing to compare against
  return tip !== run.merged_sha
}

async function handleFollowUp(run, body, via) {
  const runId = run.id
  const kind = String(body.kind || '')
  if (HOOK_KINDS.includes(kind) && fremdeClaudeSession(runId, run.harness, body.session_id)) {
    detektorLog(runId, { art: 'verworfen', grund: 'hook report from a foreign claude session (a process the agent spawned)', kind, session: body.session_id })
    return { ok: true, message: null }
  }
  // The agent of a follow-up in the gate is gone — the escalation, as for a
  // first report. Every other hook on a finished run is what it always was: nothing.
  if (['_exit', '_pane_died'].includes(kind)) {
    clearAgentState(runId)
    if (run.finish_state) { addEvent(runId, kind === '_exit' ? 'exit' : 'pane_died', { exit: body.exit ?? null }); await escalateGone(runId) }
    return { ok: true, message: null }
  }
  // The agent's attention on a FINISHED run: this is where "I typed into the
  // terminal and the run still says done" is answered. `_working` without an
  // open commission IS the commission — the operator gave the agent more work
  // straight through the terminal, past the send route, and the agent is the
  // only one who noticed. With one open, or a follow-up in the gate (the agent
  // committing what the gate asked for), the state is all that changes.
  if (kind === '_working') {
    const source = body.source ?? 'hook'
    noteAgentState(run, 'working', source)
    if (!run.followup_since && !run.followup_open && !run.finish_state
        && commissionOnWorking(source, Date.now() - lastReportMs(run))) {
      startFollowUpCommission(runId, null, 'session')
    }
    return { ok: true, message: null }
  }
  if (kind === '_waiting') {
    noteAgentState(run, 'waiting', body.source ?? 'hook')
    return { ok: true, message: null }
  }
  if (kind === '_turn_end') {
    noteAgentState(run, 'waiting', 'turn_end')
    await followUpByTurnEnd(run, 'stop hook')
    return { ok: true, message: null }
  }
  if (kind.startsWith('_')) return { ok: false, error: 'unknown or already finished run' }
  if (!FOLLOWUP_KINDS.includes(kind)) return { ok: false, error: `unknown kind '${kind}'` }

  let text = typeof body.text === 'string' ? body.text : ''
  if (typeof body.file === 'string') {
    if (body.file.length > MAX_REPORT) return { ok: false, error: 'payload too large' }
    text = text ? `${text}\n\n${body.file}` : body.file
  }
  const detail = typeof body.detail === 'string' ? body.detail : ''
  if (detail.length > MAX_REPORT) return { ok: false, error: 'payload too large' }
  // A replayed inbox line (fl-report wrote it because the hub's answer got
  // lost — a slow finish gate, a dropped connection) is the SAME report the
  // run already carried. The run is over, so the replay arrives here as a
  // follow-up — and an identical text must not ring a second time.
  if (isReplayedReport(run, kind, text)) return { ok: true, message: null }
  switch (kind) {
    case 'done':
      return followUpDone(run, text, detail, via)
    case 'failed': {
      // The follow-up did not work out. The run's own status is not touched —
      // it describes the first attempt — but the operator hears it. The
      // commission is over either way: the clock and its "longer than expected"
      // statement go the way they go on a delivered follow-up.
      endFollowUpCommission(runId)
      appendReport(runId, `**Follow-up failed:** ${text}`)
      addEvent(runId, 'followup_failed', { text: text.slice(0, 500) })
      await notifyRun(runId, 'followup_failed', `${followUpHeader(run, 'FOLLOW-UP FAILED')}\n\n${text}\n\n❌ Follow-up failed · ${harnessLabel(run)}`,
        { fileName: `followup-failed-${runId.slice(0, 8)}.md`, fileContent: text, dedupe: false })
      return { ok: true }
    }
    case 'help': {
      db.prepare(`UPDATE runs SET help_text=? WHERE id=?`).run(text, runId)
      addEvent(runId, 'help', { followup: true })
      await notifyRun(runId, 'help', `${followUpHeader(run, 'FOLLOW-UP HELP CALL')}\n\n${text}\n\n🆘 Help call · ${harnessLabel(run)}`,
        { fileName: `help-${runId.slice(0, 8)}.md`, fileContent: text, dedupe: false })
      return { ok: true }
    }
    case 'progress':
      addEvent(runId, 'progress', { text, followup: true })
      db.prepare(`UPDATE runs SET last_activity_at=datetime('now') WHERE id=?`).run(runId)
      // The traffic light falls back while the agent demonstrably works — the
      // same thing a progress report does for a first attempt (above). The
      // notification flag is NOT cleared: like a first run, a follow-up that
      // reported progress does not page about the overrun a second time.
      clearAnomalies(runId, ['anomaly:followup_soft_overrun', 'anomaly:followup_overrun'])
      return { ok: true }
    case 'branch':
      db.prepare('UPDATE runs SET branch_reported=? WHERE id=?').run(String(body.branch || ''), runId)
      addEvent(runId, 'branch', { branch: body.branch })
      return { ok: true }
    case 'pr':
      db.prepare('UPDATE runs SET pr_url=? WHERE id=?').run(String(body.pr || ''), runId)
      addEvent(runId, 'pr', { pr: body.pr })
      return { ok: true }
  }
  return { ok: false, error: `unknown kind '${kind}'` }
}

/** The follow-up text goes UNDER the first report, with a heading that says which one it is. */
function appendReport(runId, text, n = null) {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
  const heading = n == null ? `## Follow-up (${stamp})` : `## Follow-up report #${n} (${stamp})`
  const block = `\n\n---\n${heading}\n\n${text || '(no report text)'}`
  db.prepare(`UPDATE runs SET report_md = COALESCE(report_md, '') || ? WHERE id=?`).run(block, runId)
}

/**
 * Has this exact report already been processed? The one real double-send of a
 * report is the inbox replay: `fl-report` writes inbox.jsonl when the hub's
 * HTTP answer is lost (curl timed out after the hub had already processed the
 * report), and the watcher replays it. The run is over by then, so the replay
 * arrives as a follow-up — an identical text must not become a second message.
 *
 * Pure, so the rule can be stated in a test. Compares the report text against
 * what the run already holds: the first report, the latest follow-up, a help
 * question, or a failed report's text.
 */
export function isReplayedReport(run, kind, text) {
  if (!text) return false
  if (kind === 'help') return run?.help_text === text
  if (kind === 'failed') return run?.report_md === `**Failed:** ${text}`
  if (run?.followup_md === text) return true
  if (run?.report_md === text) return true
  // The FIRST report replayed after follow-ups were appended: it is now a
  // prefix of report_md (the follow-ups stand under their own headings).
  return typeof run?.report_md === 'string' && run.report_md.startsWith(text + '\n\n---')
}

/**
 * The follow-up commission is answered or given up: the clock (`followup_since`,
 * set by the send route) stops and the watcher's "longer than expected"
 * statement about it is retracted the same way a raised duration retracts one
 * (run-edit.mjs). While the follow-up is in the gate the run still displays as
 * working — through `followup_open`, which the integrator's ends clear.
 */
function endFollowUpCommission(runId) {
  db.prepare('UPDATE runs SET followup_since=NULL WHERE id=?').run(runId)
  clearAnomalies(runId, ['anomaly:followup_soft_overrun', 'anomaly:followup_overrun',
    ...notifiedFlags('followup_overrun')])
}

/**
 * A `done` from a finished run. The report is stored first, then the gate runs
 * like it would for a first report — a follow-up whose worktree is dirty is
 * told so in the same words, through the same channel.
 */
async function followUpDone(run, text, detail, via) {
  const runId = run.id
  // A follow-up that is still in the gate: the agent reports again after M1/M2,
  // exactly as a first run does. Its text was already appended; the gate is
  // simply asked again.
  if (run.followup_open && run.finish_state) {
    if (detail) db.prepare(`UPDATE runs SET followup_detail_md=? WHERE id=?`).run(detail, runId)
    const gate = await finishGate(runId, '', via)
    if (gate?.hold) return { ok: true, message: gate.message ?? null }
    const fresh = db.prepare('SELECT * FROM runs WHERE id=?').get(runId)
    return completeFollowUp(runId, { mergeLine: gate?.mergeLine ?? null, merged: false, message: true, followups: fresh.followups })
  }
  const n = (run.followups ?? 0) + 1
  // The commission is answered: the clock stops here and its "longer than
  // expected" statement is retracted. While the gate / merge runs the run still
  // displays as working — through `followup_open`, not through the clock.
  endFollowUpCommission(runId)
  appendReport(runId, text, n)
  // `finish_started_at` is reset on purpose: the first gate's clock is long over,
  // and the deadline counts from THIS report. `followup_open` is what the
  // integrator's end reads to announce the merge as a follow-up's.
  db.prepare(`UPDATE runs SET followups=?, followup_md=?, followup_detail_md=?,
              followup_open=1, finish_started_at=NULL WHERE id=?`)
    .run(n, text || null, detail || null, runId)
  addEvent(runId, 'followup_reported', { n })
  const gate = await finishGate(runId, '', via)
  if (gate?.hold) return { ok: true, message: gate.message ?? null }
  return completeFollowUp(runId, { mergeLine: gate?.mergeLine ?? null, merged: false, message: true, followups: n })
}

/**
 * cursor's net, for a follow-up: the turn ended on a finished run, and the
 * worktree holds commits nobody merged. The transcript's last answer is the
 * report, like finishByTurnEnd() does it for a first run.
 */
export async function followUpByTurnEnd(run, source) {
  const harness = getHarness(run.harness)
  if (!harness?.turnEndsRun) return false
  let tip = null
  try { tip = await (await import('./integrate.mjs')).tipOfRun(run) } catch { tip = null }
  if (!wantsTurnEndFollowUp(run, tip, harness)) return false
  const state = run.harness === 'cursor' ? transcriptState(run) : null
  const note = `_(Freilauf took this as a follow-up report: the agent ended its turn with new commits and without calling \`fl-report done\` — noticed via ${source}.)_`
  const text = [state?.lastAnswer, note].filter(Boolean).join('\n\n')
  addEvent(run.id, 'turn_end_finished', { source, transcript: !!state?.lastAnswer, followup: true })
  await followUpDone(run, text, 'internal')
  return true
}

/**
 * The follow-up has left the gate — merged, nothing to merge, kept on its
 * branch, or blocked. Called from here (no gate, or nothing to merge) and from
 * the integrator's three ends (server/integrate.mjs). One function, so the
 * three things that make a follow-up visible cannot come apart: the event, the
 * flows firing again, the message to the operator.
 *
 * `notify: false` is for a BLOCKED follow-up: the block itself is announced by
 * the integrator (T_BLOCKED_*), and a second message about the same run at the
 * same moment would be one too many.
 */
export async function completeFollowUp(runId, { mergeLine = null, merged = false, notify = true, message = false, followups = null } = {}) {
  const run = db.prepare('SELECT * FROM runs WHERE id=?').get(runId)
  if (!run) return { ok: false, error: 'unknown run' }
  const n = followups ?? run.followups
  // How long the follow-up took: since the previous report of this run.
  const prev = db.prepare(`SELECT ts FROM events WHERE run_id=? AND kind IN ('done','followup_done','followup_failed')
    ORDER BY id DESC LIMIT 1`).get(runId)?.ts
  const prevMs = prev ? Date.parse(prev.replace(' ', 'T') + 'Z') : NaN
  const minutes = Number.isFinite(prevMs) ? Math.round((Date.now() - prevMs) / 60000) : null
  db.prepare('UPDATE runs SET followup_open=0 WHERE id=?').run(runId)
  addEvent(runId, 'followup_done', { n, merged, merge: mergeLine })
  if (notify) {
    await notifyRun(runId, 'followup', followUpText(run, run.followup_md, mergeLine, { n, minutes }),
      { fileName: `followup-${n}-${runId.slice(0, 8)}.md`, fileContent: run.followup_detail_md ?? run.followup_md ?? '', dedupe: false })
  }
  // The run "ended again": whatever hangs on its end runs once more.
  try {
    const m = await import('./flows/db.mjs')
    m.rearmDispatch(runId, { merged })
  } catch (err) { console.error('[flows]', err.message) }
  import('./flows/triggers.mjs').then(m => m.flowsTick()).catch(e => console.error('[flows]', e.message))
  if (!message) return { ok: true }
  return { ok: true, message: `Freilauf: follow-up report #${n} received${mergeLine ? ` — ${mergeLine}` : ''}. It reaches the operator like the first one. Nothing more to do; stay in this session.` }
}

/**
 * The finish gate, reached by a dynamic import so the cycle stays open in one
 * direction only: server/integrate.mjs imports this module for notifyRun() and
 * doneText(). Same pattern the watcher uses for the scheduler.
 */
async function finishGate(runId, text, via) {
  try {
    const m = await import('./integrate.mjs')
    return await m.finishGate(runId, text, via)
  } catch (err) {
    console.error('[integrate]', err.message)
    return null   // fail-soft: a broken gate must never swallow a report
  }
}

/** The agent of a run in the finish gate is gone — that is an escalation, not a failure. */
async function escalateGone(runId) {
  try {
    const m = await import('./integrate.mjs')
    await m.escalate(runId, 'agent_gone')
  } catch (err) { console.error('[integrate]', err.message) }
}

/**
 * What a run that did not end with 'done' left behind, as a paragraph for the
 * notification message. Empty where the repo does not want the hub to integrate.
 */
export async function assessAfterEnd(runId) {
  try {
    const m = await import('./integrate.mjs')
    const assessment = await m.assessUnmerged(runId)
    if (!assessment) return ''
    const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId)
    const text = m.assessText(run, assessment)
    return text ? `\n\n${text}` : ''
  } catch (err) {
    console.error('[integrate]', err.message)
    return ''
  }
}

export function addEventOnce(runId, kind, payload = null) {
  const have = db.prepare('SELECT 1 FROM events WHERE run_id = ? AND kind = ? LIMIT 1').get(runId, kind)
  if (!have) addEvent(runId, kind, payload)
}

/**
 * Anomalies "resolve themselves" through progress. The events remain as
 * history but are renamed to 'cleared:*' — the traffic light falls back
 * (pages.mjs searches for 'anomaly:%') and addEventOnce fires again on
 * recurrence. The 'notified:*' flags stay on purpose: the same type must
 * not produce a second message either (planning 4.5).
 *
 * Exported because one other decision belongs to the same rule: when the
 * operator RAISES a running run's expected duration (run-edit.mjs), the
 * "longer than expected" statement the old value produced is retracted the
 * same way — and its notification flag with it, so a genuine overrun of the NEW
 * duration can page once again.
 */
export function clearAnomalies(runId, kinds) {
  const stmt = db.prepare(`UPDATE events SET kind = 'cleared:' || kind WHERE run_id = ? AND kind = ?`)
  for (const kind of kinds) stmt.run(runId, kind)
}

/** "claude/sonnet" — the harness and model as one label for the status line. */
function harnessLabel(run) {
  return `${run.harness}${run.model ? '/' + run.model : ''}`
}

/**
 * The header a report message begins with: which repo, and whether an agent or
 * a single run is reporting. A single run is named by its title, an agent run
 * by "AGENT <name>" — so the message is attributable without a click.
 */
function reportHeader(run, word = 'REPORT') {
  const p = db.prepare('SELECT name FROM repos WHERE id=?').get(run.repo_id)?.name ?? '?'
  const a = run.agent_id ? db.prepare('SELECT name FROM agents WHERE id=?').get(run.agent_id)?.name : null
  const name = a ? `AGENT ${a}` : (run.title ?? 'run')
  return `${p} / ${name} ${word}:`
}

/**
 * The header of everything a finished run says: the same shape as the first
 * report's, with the word that tells the reader that this is NOT
 * the run's first message — "FOLLOW-UP REPORT #2" instead of "REPORT". Whoever
 * reads it knows without opening the hub that the run was already over and that
 * somebody asked for more.
 */
export function followUpHeader(run, word = 'FOLLOW-UP REPORT', n = null) {
  return reportHeader(run, n ? `${word} #${n}` : word)
}

/**
 * The "follow-up done" message — the counterpart of doneText() for a report
 * after the run's end. `minutes` is the time since the previous report, which
 * is what a follow-up's duration means; the run's own start is long ago.
 */
export function followUpText(run, report, mergeLine = null, { n = 1, minutes = null } = {}) {
  const branch = run.branch_reported || run.branch_expected
  const zeile2 = [minutes != null ? `Follow-up time: ${minutes} min` : null, branch ? `Branch: ${branch}` : null,
    run.pr_url ? `PR: ${run.pr_url}` : null, mergeLine].filter(Boolean).join(' · ')
  const status = `✅ Follow-up #${n} done · ${harnessLabel(run)}${zeile2 ? ' · ' + zeile2 : ''}`
  return `${followUpHeader(run, 'FOLLOW-UP REPORT', n)}\n\n${report || '(no report text)'}\n\n${status}`
}


/**
 * The "done" message. `mergeLine` is what the integration has to say about this
 * run — `Merged into main: abc1234`, or `Nothing to merge (no commits)`. The
 * report itself sits right under the header; the status line with duration,
 * branch, merge result and incidents follows it.
 */
export function doneText(run, report, mergeLine = null) {
  const dur = run.started_at
    ? `Duration: ${Math.round((Date.now() - Date.parse(run.started_at.replace(' ', 'T') + 'Z')) / 60000)} min`
    : ''
  const vorfaelle = db.prepare(`SELECT typ, anzahl FROM incidents WHERE run_id = ? ORDER BY id`).all(run.id)
  const vf = vorfaelle.length ? ' · Incidents: ' + vorfaelle.map(v => `${TYP_TEXT[v.typ] ?? v.typ} ${v.anzahl}×`).join(', ') : ''
  const branch = run.branch_reported || run.branch_expected
  const zeile2 = [dur, branch ? `Branch: ${branch}` : null, run.pr_url ? `PR: ${run.pr_url}` : null,
    mergeLine].filter(Boolean).join(' · ')
  const status = `✅ Done · ${harnessLabel(run)}${zeile2 ? ' · ' + zeile2 : ''}${vf}`
  // Full report; over 4096 chars notify() truncates and notifyLong() attaches the file.
  return `${reportHeader(run)}\n\n${report || '(no report text)'}\n\n${status}`
}

/**
 * The per-run "already said this once" flag.
 *
 * It used to be called `telegram_sent:<type>`, and after the notification
 * rebuild that name would be a lie in the data: the flag is set when the
 * message went to WHATEVER channels are configured — a webhook, an e-mail, or
 * nothing at all. So it is `notified:<type>` now, and the old name is still
 * READ (`notifiedFlags()`), because a run that was told about its overrun
 * yesterday must not be told again today just because the hub was deployed in
 * between.
 *
 * `runs.telegram_on`, the column behind the checkbox, deliberately keeps ITS
 * name: renaming a column is a table rebuild, and this project's own rule about
 * `openrouter_min_eur` says that is a migration for nothing. An event kind is
 * different — it is queried by name, rendered into a run's history, and asserted
 * on in the tests.
 */
export const notifiedFlag = (type) => `notified:${type}`

/** Both names of one flag: what is written today, and what older rows carry. */
export function notifiedFlags(type) {
  return [notifiedFlag(type), `telegram_sent:${type}`]
}

/**
 * One message about a run, with dedupe per (run, type) — planning 4.5: only one
 * message per anomaly type, whichever channels carry it.
 */
export async function notifyRun(runId, type, text, lang = null) {
  // A conflict run is the integrator's tool, not work the operator asked for.
  // He hears about it through the run it works FOR — T-RESOLVING at the start,
  // the done line naming it after the merge, T-BLOCKED-CONFLICT when it did not
  // get there. No flag event either: there is nothing to deduplicate.
  if (db.prepare('SELECT resolves_run_id FROM runs WHERE id=?').get(runId)?.resolves_run_id) return false
  const [flag, legacy] = notifiedFlags(type)
  const have = db.prepare('SELECT 1 FROM events WHERE run_id = ? AND kind IN (?,?) LIMIT 1').get(runId, flag, legacy)
  // Help calls are never duplicates: every question needs an answer.
  if (have && lang?.dedupe !== false) return false
  // The run's own switch (the checkbox under its terminal). Off means: this
  // message is not sent, and it is written down that it was not — the flag is
  // deliberately NOT set, so switching the box back on lets the same type
  // through again. Everything else about the report happened already.
  if (!notifyOnFor(runId)) {
    addEvent(runId, 'notify_muted', { type })
    return false
  }
  const voll = `${text}\n\nRun: ${runId}\n🔗 ${detailUrl(runId)}`
  // One call, whether or not there is a file: the facade normalizes both, and a
  // channel decides for itself whether a long report travels as an attachment.
  const r = await notifyChannels({
    kind: 'run',
    runId,
    text: voll,
    url: detailUrl(runId),
    attachment: lang?.fileContent ? { fileName: lang.fileName, content: lang.fileContent } : null,
  })
  const ok = r.sent
  // The flag is written whether or not a channel took it — including when there
  // is no channel at all. It records that the hub HAS said this about this run,
  // and a hub with notifications switched off must not queue up a backlog that
  // fires the day one is configured.
  addEvent(runId, flag, { delivered: ok })
  addEvent(runId, 'notified', { type })
  return ok
}

/**
 * git helper check for the watcher: upstream AND tracking state.
 * The trap: '%(upstream:track)' is also empty when the branch has NO upstream
 * at all — empty alone does not mean "pushed". Hence the upstream comes back
 * too and 'synced' is only true when an upstream exists and nothing is pending.
 * Returns { upstream, track, synced }.
 */
export async function branchSyncState(repoPath, branch) {
  const r = await sh('git', ['-C', repoPath, 'for-each-ref',
    '--format=%(upstream)%09%(upstream:track)', `refs/heads/${branch}`])
  if (!r.ok) return { upstream: '', track: '', synced: false }
  const [upstream = '', track = ''] = r.stdout.trim().split('\t')
  return { upstream, track, synced: upstream !== '' && track === '' }
}
