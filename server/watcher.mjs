// Freilauf — watcher (planning 4.4, 4.5, 4.7): observes runs via tmux, the harnesses'
// transcript/DB and the inbox fallback; anomalies (traffic light), budget retry,
// cost estimation, auto-close of finished sessions (server/sessions.mjs), worktree cleanup.
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import db, { getRepo, getRun, addEvent, announceRun, allSettings, getSetting } from './db.mjs'
import { RUNS_DIR, sh, parseDbUtc, kurzid } from './util.mjs'
import { notify, notifyOnFor } from './notify.mjs'
import { handleReport, addEventOnce, notifyRun, branchSyncState, finishByTurnEnd, followUpHeader, clearAnomalies } from './reports.mjs'
import { transcriptState as cursorTranscriptState } from './cursor-transcript.mjs'
import { storeActivity } from './opencode-store.mjs'
import { deliverPendingGoals } from './goal.mjs'
import { claudeQuota, sevenForRun, quotaFullWindow } from './quota.mjs'
import { refreshClaudeLimits } from './claude-usage.mjs'
import { scanneNeueBytes, transkriptFehler, bewerteLogTreffer, terminalText, vorfallWeggrund,
  sandboxDenialSummary, sandboxBlockedSchwere, agentCopedAfter } from './detect.mjs'
import { vorfallMelden, vorfallEskalieren, vorfallVerwerfen, vorfaelleMeldenFaellig, offeneVorfaelle, vorfallLoesen, detektorLog, msVon } from './incidents.mjs'
import { pruefeTreffer, pruefLlmAktiv } from './pruefer.mjs'
import { HARNESS_PLUGINS, getHarness } from './harnesses/index.mjs'
import { PROVIDER_PLUGINS } from './providers/index.mjs'
import { flowsTick } from './flows/triggers.mjs'
import { reconcileClosedSession, tmuxSnapshot, sessionGone, shouldAutoClose, currentKeepMs, shouldCloseArchived, archiveSessionKeepMs,
  sandboxRuntime, sandboxHubId, containerName, stopRunContainer, finishedAtMs } from './sessions.mjs'
import { integrateTick, pushOperatorBase, integratorTimerOff, foreignChanges, ownWorktreePaths } from './integrate.mjs'
import { maybeAutoCleanup } from './cleanup.mjs'
// The two seams of SANDBOX_RESEARCH.md §7.4.4 / §7.7. Both answer for an
// unsandboxed run exactly what this file did before they existed, which is why
// every call site below could be rewired mechanically.
// The hub's own sandbox policy, from its one reader (run-def.mjs, "THE FOUR HUB
// SANDBOX SETTINGS ARE READ HERE AND NOWHERE ELSE"). Statically, like
// sandbox/index.mjs and run-edit.mjs import it: `sandboxInUse()` sits in the
// reconciliation pass and has to answer synchronously, and there is no cycle to
// dodge — run-def.mjs reaches watcher.mjs through no static edge.
import { sandboxHubMode } from './run-def.mjs'
import { runGit, agentHome, specOf } from './sandbox/exec.mjs'
import { isClone, removeClone } from './sandbox/clone.mjs'
import { env } from './env.mjs'

let timer = null

export function startWatcher() {
  if (timer) return
  timer = setInterval(() => tick().catch(e => console.error('[watcher]', e.message)), 30_000)
}
export function stopWatcher() { clearInterval(timer); timer = null }

/**
 * Runs that never got a session. Happens when the hub is terminated in the middle
 * of the start-up sequence (service restart, reboot, crash): the record is then
 * stuck on 'running' but has neither a session nor a worktree — the overview
 * shows a run that does not exist, and the terminal has nothing to attach to.
 *
 * 'gnadenfristSek' (grace period in seconds) guards against tearing down a run
 * that was created just now and whose fl-start is still working. At hub start-up
 * the grace period is 0: whatever is there must come from an earlier process.
 */
export function verwaisteLaeufeAbschliessen(gnadenfristSek = 300) {
  // A run without a session that is on its way BACK (resume_pending, see
  // resumeRun in runner.mjs) is not an orphan: its launch is the next pass's.
  const rows = db.prepare(`
    SELECT id, started_at FROM runs
    WHERE status IN ('running','waiting_help') AND tmux_session IS NULL AND resume_pending = 0
      AND started_at <= datetime('now', ?)
  `).all(`-${Math.max(0, gnadenfristSek)} seconds`)
  for (const run of rows) {
    db.prepare(`UPDATE runs SET status='failed', ended_at=datetime('now'), report_md=? WHERE id=?`)
      .run('Start was interrupted: the hub shut down before a tmux session existed '
        + '(service restart, reboot or crash). Nothing was started — '
        + '"Retry run" sets up anew.', run.id)
    addEvent(run.id, 'failed', { grund: 'start interrupted, no session' })
  }
  return rows.length
}

export async function tick() {
  verwaisteLaeufeAbschliessen()
  await collectInboxes()
  // Runs whose resume did not get a session last time (the tmux server was a
  // beat behind, fl-start failed): launched again before anything else looks
  // at them, so the loop below finds them with a session or still pending.
  await retryPendingResumes()
  const active = db.prepare(`SELECT * FROM runs WHERE status IN ('running','waiting_help')`).all()
  for (const run of active) {
    try { await watchRun(run) } catch (e) { console.error(`[watcher] ${run.id}:`, e.message) }
  }
  // One message about every session this pass found lost — not one per run.
  try { await announceResumes() } catch (e) { console.error('[watcher] resume summary:', e.message) }
  // The second prompt, for every run that still owes its session one: a hub
  // restarted between the start and the delivery, a session that had not drawn
  // yet, a run that was answering a help call (server/goal.mjs).
  try { await deliverPendingGoals() } catch (e) { console.error('[goal]', e.message) }
  // Claude's windows, from the account (server/claude-usage.mjs). Refreshed here
  // and not only when somebody opens a page, because the two things that USE the
  // numbers run without a browser: the budget gate that defers a start, and the
  // cost delta written at a run's end. Both read claudeQuota() synchronously —
  // this is what keeps its live half from going stale under them. Never throws.
  await refreshClaudeLimits()
  // Follow-up commissions: a finished run the operator typed new work into is
  // held to its expected duration from the moment of the commission, like any
  // first attempt (see below).
  try { await watchFollowUps() } catch (e) { console.error('[watcher]', e.message) }
  // The sandbox's denials become the one record a human sees — before the
  // assessment below, so a promotion made this pass is judged in this pass.
  // A complete no-op for every run that is not sandboxed.
  try { await watchSandboxBlocks() } catch (e) { console.error('[sandbox]', e.message) }
  await vorfaelleBewerten()
  await vorfaelleMeldenFaellig()
  await providerPuls()
  await finishCostsPass()
  await checkFinishedBranches()
  await retryDeferred()
  await startScheduled()
  // The tmux-cleanup agent: when memory is at or above the configured threshold
  // (server/cleanup.mjs), one runs by itself. The memory read is the sidebar's
  // cached measurement — the same number the panel shows, not a second one.
  try { await maybeAutoCleanup() } catch (e) { console.error('[cleanup]', e.message) }
  // The finish gate has its own 5-second timer (server/integrate.mjs); this is
  // the net under it, for the case that timer ever stops.
  if (!integratorTimerOff()) {
    try { await integrateTick() } catch (e) { console.error('[integrate]', e.message) }
    // origin is the operator's backup: commits he made on the base branch of the
    // main checkout himself are pushed from here. A push touches no working tree.
    try { await pushOperatorBase() } catch (e) { console.error('[integrate]', e.message) }
  }
  await closeOldSessions()
  await closeArchivedSessions()
  // The sandbox's own two passes, AFTER the session passes: a container's fate
  // follows its session's, so reconciling in the other order would look at
  // sessions the pass above is about to close. Both are a complete no-op on an
  // installation without a container runtime.
  try { await enforceMaxRuntime() } catch (e) { console.error('[sandbox]', e.message) }
  let containerPass = null
  try { containerPass = await reconcileContainers() } catch (e) { console.error('[sandbox]', e.message) }
  // …and the third: the built-in egress proxy a hub restart took with it. It
  // reads the pass above's VERDICT rather than asking the daemon again, which
  // is what keeps "the daemon did not answer" from being spent as an answer
  // here too (restoreSandboxProxies below says why it hangs on this call).
  try { await restoreSandboxProxies(containerPass?.verdict ?? null) } catch (e) { console.error('[sandbox]', e.message) }
  await cleanupWorktrees()
  // No-code flows: run_finished backstop, delays, cron (server/flows/triggers.mjs).
  try { await flowsTick() } catch (e) { console.error('[flows]', e.message) }
}

// ---------- inbox fallback (fl-report could not reach the hub) ----------
async function collectInboxes() {
  let dirs = []
  try { dirs = readdirSync(RUNS_DIR) } catch { return }
  for (const id of dirs) {
    const run = db.prepare('SELECT id FROM runs WHERE id = ?').get(id)
    if (!run) continue
    const f = join(RUNS_DIR, id, 'inbox.jsonl')
    if (!existsSync(f)) continue
    let lines = []
    try { lines = readFileSync(f, 'utf8').split('\n').filter(Boolean) } catch { continue }
    if (!lines.length) continue
    const rest = []
    for (const line of lines) {
      // 'inbox': there is no fl-report call left to answer, so the finish gate
      // types its answer into the session instead.
      try {
        const r = await handleReport(id, JSON.parse(line), 'inbox')
        // A report the hub REFUSES is a deterministic answer — replaying it can
        // never make it right, so it is dropped like the HTTP path would have
        // (a refused report must not loop every watcher pass). Only a THROWN
        // error is kept: it may be transient (a locked database, a hiccup), and
        // an inbox that swallowed a report is a report that never arrives.
        if (r && r.ok === false) continue
      } catch (e) {
        console.error('[inbox]', e.message)
        rest.push(line)
      }
    }
    // Keep what failed, clear the rest — a cleared inbox line has no second chance.
    writeFileSync(f, rest.length ? rest.join('\n') + '\n' : '')
  }
}

/**
 * Is the session still alive? Only has-session answers that honestly.
 * 'tmux display -p -t "=name"' returns exit 0 with empty output for a session that
 * does NOT exist — checks built on that therefore never trigger.
 *
 * Three answers, not two: true / false / null ("tmux did not say"). The null is
 * the whole point. This used to be `sh(...).ok`, so EVERY way that one
 * subprocess can fail — the 30 s timeout in sh(), a fork that fails under
 * memory pressure, a server too busy to answer, an EINTR — read as "the session
 * is gone", and watchRun() answers that by ABORTING the run. One flaky tmux
 * call was enough to kill a working agent, and the run's own record then said
 * 'tmux session ended', which is not what happened. Same family as
 * '--no-optional-locks' reading an empty status as a clean worktree.
 */
async function sessionLebt(session) {
  const gone = await sessionGone(session)
  return gone === null ? null : !gone
}

// ---------- single run ----------
async function watchRun(run) {
  let st = { pane_dead: '?', dead_status: '', dead_time: '', pid: '', cmd: '' }
  if (run.tmux_session) {
    const lebt = await sessionLebt(run.tmux_session)
    // null = tmux did not answer. Skip this run for this pass and try again in
    // 30 s: not knowing is a reason to wait, never a reason to end somebody's
    // work. A session that is really gone stays gone and is caught next tick.
    if (lebt === null) {
      console.error(`[watcher] ${run.id}: tmux gave no answer about ${run.tmux_session} — leaving the run alone`)
      return
    }
    if (!lebt) {
      // Session gone, and NOT by the hub's hand: a reboot, an update that took
      // the tmux server, a `tmux kill-server`. (Everything the hub ends itself
      // — the kill route, the sessions page, retention, archiving, a flow —
      // goes through reconcileClosedSession() directly and never gets here
      // with a run still on 'running'.) The run is RESUMED in a new session
      // (runner.mjs, resumeRun): its worktree, its prompt, its log and — for
      // claude — its whole conversation are still on disk, and abandoning
      // them was the most expensive thing a restart used to cost.
      // A run in the FINISH GATE is not resumed: it has reported, and its
      // agent disappearing there is the integrator's own case — `agent_gone`
      // escalation, the leftovers named for the operator (integrate.mjs).
      if (run.resume_pending) return       // already on its way (retryPendingResumes)
      if (!run.finish_state && await tryResume(run)) return
      // Cannot be resumed (cap reached, worktree gone, nothing to launch):
      // mark it closed right away, otherwise the worktree cleanup waits
      // forever for tmux_closed_at — AND end the run: nothing can report for
      // it any more, so leaving it on 'running' means the overview shows a run
      // that does not exist, forever. reconcileClosedSession() does both, and
      // is the same function the sessions page uses.
      addEventOnce(run.id, 'anomaly:session_gone')
      reconcileClosedSession(run.id, 'watcher')
    } else {
      const r = await sh('tmux', ['display', '-p', '-t', `=${run.tmux_session}`,
        '#{pane_dead} #{pane_dead_status} #{pane_dead_time} #{pane_pid} #{pane_current_command}'])
      if (r.ok && r.stdout.trim()) {
        const [a, b, c, d, e] = r.stdout.trim().split(/\s+/)
        st = { pane_dead: a, dead_status: b, dead_time: c, pid: d, cmd: e }
      }
    }
  }

  if (st.pane_dead === '1') {
    handleReport(run.id, { kind: '_pane_died', exit: st.dead_status }, 'internal').catch(() => {})
  }

  // Activity + tokens per harness
  const act = await measureActivity(run)
  if (act.lastActivity) {
    db.prepare('UPDATE runs SET last_activity_at=?, tokens_in=?, tokens_out=?, cost_usd=COALESCE(?, cost_usd) WHERE id=?')
      .run(act.lastActivity, act.tokensIn, act.tokensOut, act.costUsd ?? null, run.id)
  }

  // ---- traffic-light logic (planning 4.5) ----
  const now = Date.now()
  const startedMs = Date.parse(run.started_at.replace(' ', 'T') + 'Z')
  const expectedMs = run.expected_minutes * 60_000
  // The reading of THIS pass, not the row's — the UPDATE above already knows
  // better than the row that was loaded before it, and a decision one pass
  // behind is a decision made on a timestamp the hub has itself corrected.
  const lastActAt = act.lastActivity ?? run.last_activity_at
  const lastAct = lastActAt ? Date.parse(lastActAt.replace(' ', 'T') + 'Z') : startedMs

  // A run in the finish gate has reported and is deliberately waiting for the
  // hub (or for its own last commit) — none of the three "it is late" anomalies
  // says anything true about it.
  const inFinishGate = !!run.finish_state

  if (run.status === 'running' || run.status === 'waiting_help') {
    // yellow: no activity for 15 min — and only where activity is MEASURED.
    // measureActivity() has a source for claude, opencode and cursor and none
    // for hermes, and without one `lastAct` falls back to the run's start: every
    // hermes run longer than a quarter of an hour was therefore flagged as idle
    // while it worked. That is the same rule bewerteLogTreffer() already
    // follows — an unmeasured harness is UNKNOWN, never silent (AGENTS.md,
    // "Silence is only an argument where activity is measured").
    const idle = now - lastAct > 15 * 60_000
    // An agent that has SAID it waits for a human (its own hook, reports.mjs
    // "the agent's attention") is silent on purpose: the status word already
    // reads "waiting for input", and "no activity" under it would be the same
    // fact twice — the second time as an alarm about the operator's own pause.
    const waiting = run.agent_state === 'waiting'
    if (!inFinishGate && act.measured && idle && !waiting && st.pane_dead !== '1') {
      addEventOnce(run.id, 'anomaly:no_activity')
    }
    // …and the statement is RETRACTED when the agent is demonstrably back.
    // 'no_activity' used to be cleared by a progress report alone, so a run that
    // had been quiet once carried "no activity" in the overview for the rest of
    // its life — which reads as "this agent is not running" long after it is.
    // Same mechanism as a raised expected duration retracting its overrun.
    if (act.measured && !idle) retractNoActivity(run.id)
    // The same retraction for the sandbox's own yellow: a wall the agent got
    // past is history, not a call for attention (the veto, see below).
    if (act.measured) retractSandboxDenied(run.id, lastAct, now)
    // yellow: 80 % of the expected duration reached, no report
    if (!inFinishGate && now - startedMs > 0.8 * expectedMs && !run.report_md) {
      addEventOnce(run.id, 'anomaly:soft_overrun')
    }
    // red: expected duration exceeded without report/progress
    if (!inFinishGate && now - startedMs > expectedMs && !run.report_md) {
      const hadProgress = db.prepare(`SELECT 1 FROM events WHERE run_id=? AND kind='progress'`).get(run.id)
      if (!hadProgress) {
        addEventOnce(run.id, 'anomaly:overrun')
        await notifyRun(run.id, 'overrun',
          `🔴 Run exceeds the expected duration (${run.expected_minutes} min) without a report.`)
      }
    }
    // Rate limit / provider errors: hooks report themselves (reports.mjs); here are
    // the two sources the hub reads from the outside — transcript and pipe-pane log.
    await transkriptScannen(run)
    await logScannen(run)
    // cursor's second end channel, independent of any hook (see below).
    if (await cursorTurnEndDetected(run)) return
    // red: a Claude window that concerns THIS run is at 100 %. Only a claude
    // run draws from these windows — a run on another harness (opencode,
    // hermes, cursor) must not be flagged because somebody else's claude
    // session consumed the quota. The event names the window, so the overview
    // can say WHICH one is exhausted instead of a bare "quota exhausted".
    if (run.harness === 'claude') {
      const q = claudeQuota()
      const voll = quotaFullWindow(q, run.model ?? null)
      if (voll) {
        addEventOnce(run.id, 'anomaly:quota_full', { window: voll.label, pct: voll.pct, resets_at: voll.resets_at })
      }
    }
  }

}

// ---------- follow-up commissions ----------
/**
 * A finished run the operator typed new work into (`followup_since`, set by the
 * send route) is working again — and from the moment of the commission it is
 * held to the same expectation as a first attempt: `expected_minutes`, soft
 * overrun at 80 %, overrun with a notification at 100 %. Before this, a
 * follow-up that worked on and on without reporting was invisible: watchRun()
 * only ever sees running runs, and nothing else clocked the follow-up.
 *
 * The clock ends when the follow-up reports (reports.mjs, endFollowUpCommission),
 * when its session is closed (reconcileClosedSession) — or here, when the pane
 * turns out dead: a process that has exited can never report, so waiting out
 * the deadline would only produce a misleading alarm. The event says so, and
 * the run falls back to displaying as finished.
 */
async function watchFollowUps() {
  const rows = db.prepare(`SELECT * FROM runs WHERE followup_since IS NOT NULL
    AND status IN ('done','failed','aborted')`).all()
  for (const run of rows) {
    // The session was closed on purpose (kill route, retention, archive):
    // nothing can report any more. reconcileClosedSession usually cleared the
    // flag already — this is the net under it.
    if (run.tmux_closed_at) {
      db.prepare('UPDATE runs SET followup_since=NULL WHERE id=?').run(run.id)
      continue
    }
    if (run.tmux_session) {
      // The colon target: without it a live session can be missed (AGENTS.md).
      const r = await sh('tmux', ['display', '-p', '-t', `=${run.tmux_session}:`, '#{pane_dead}'])
      // No answer: tmux said nothing. The closeOldSessions pass owns the "is
      // the session still there" question and its consequences — wait.
      if (!r.ok || !r.stdout.trim()) continue
      if (r.stdout.trim() === '1') {
        db.prepare('UPDATE runs SET followup_since=NULL WHERE id=?').run(run.id)
        addEvent(run.id, 'followup_agent_gone')
        continue
      }
    }
    // A follow-up that HAS reported is in the gate or being merged — its
    // deadline is the finish gate's (`finish_started_at`), not this clock.
    if (run.finish_state || run.followup_open) continue
    // The agent answered and sits at its prompt (its own hook said so): the
    // commission is open because nobody reported, but nothing is being worked
    // on, and "follow-up exceeds the expected duration" would alarm about a
    // conversation the operator is in the middle of. The clock resumes the
    // moment the agent works again — every `_working` is a new instruction.
    if (run.agent_state === 'waiting') continue
    const expectedMs = run.expected_minutes * 60_000
    const elapsed = Date.now() - parseDbUtc(run.followup_since)
    if (elapsed > 0.8 * expectedMs) addEventOnce(run.id, 'anomaly:followup_soft_overrun')
    if (elapsed > expectedMs) {
      addEventOnce(run.id, 'anomaly:followup_overrun')
      await notifyRun(run.id, 'followup_overrun',
        `${followUpHeader(run, 'FOLLOW-UP OVERRUN')}\n\n🔴 Follow-up work exceeds the expected duration (${run.expected_minutes} min) without a follow-up report.`)
    }
  }
}

/**
 * claude's own slug rule for a project directory: EVERY character that is not a
 * letter or a digit becomes '-', with no collapsing — `/home/x` is `-home-x`
 * (measured, claude 2.1.261, SANDBOX_RESEARCH.md §11a.4).
 *
 * This used to be `replaceAll('/', '-')`, and that was a latent bug rather than a
 * simplification: a worktree path holding a dot, an underscore or a space
 * produced a directory the hub would never find, and both things that read this
 * path — the activity measurement and the claude incident channel — would have
 * gone silently blind. The run then looks idle while it works, which is the most
 * expensive shape a fault can take. No path on this machine triggered it, which
 * is exactly why it survived; a sandboxed run's newly generated paths raise the
 * odds, so it is fixed here rather than waited for.
 */
export function claudeProjectSlug(workdir) {
  return String(workdir ?? '').replace(/[^a-zA-Z0-9]/g, '-')
}

/**
 * Path of the Claude transcript: known in advance thanks to --session-id
 * (planning 7.1).
 *
 * The slug is derived from the WORKDIR, and a sandboxed run's workdir is the
 * same string inside and outside the container — so nothing about the slug rule
 * changes there. What moves is the home the projects directory hangs under
 * (§7.7), and `agentHome(run)` is the host home for every run that is not
 * sandboxed. `FREILAUF_CLAUDE_PROJECTS` stays the outermost answer: it is the
 * suite's fence, and a test must never read the operator's transcripts.
 */
export function claudeTranskriptPfad(run) {
  const dirName = claudeProjectSlug(run.workdir_effective)
  return `${env('CLAUDE_PROJECTS') ?? join(agentHome(run), '.claude/projects')}/${dirName}/${run.id}.jsonl`
}

/** Read a file starting at offset; returns { text, size }. If too far behind, only the tail. */
function neueBytes(pfad, offset, maxBytes = 2_000_000) {
  const size = statSync(pfad).size
  // File shorter than the offset: recreated or truncated (run retried) — start over.
  if (size < offset) offset = 0
  if (size === offset) return { text: '', size, uebersprungen: 0 }
  let von = offset, uebersprungen = 0
  if (size - von > maxBytes) { uebersprungen = size - maxBytes - von; von = size - maxBytes }
  const fd = openSync(pfad, 'r')
  try {
    const buf = Buffer.alloc(size - von)
    readSync(fd, buf, 0, buf.length, von)
    return { text: buf.toString('utf8'), size, uebersprungen, von }
  } finally { closeSync(fd) }
}

/**
 * Claude transcript: API errors appear there as dedicated lines with isApiErrorMessage
 * and Claude's own error enum — as unambiguous as the hook, just without the hook.
 * Catches the case where the StopFailure hook did not run, and yields every occurrence
 * with a timestamp (retry loops become visible as anzahl).
 */
async function transkriptScannen(run) {
  if (run.harness !== 'claude' || !run.workdir_effective) return
  const f = claudeTranskriptPfad(run)
  if (!existsSync(f)) return
  let chunk
  try { chunk = neueBytes(f, run.transcript_offset ?? 0) } catch { return }
  if (!chunk.text) return
  // Only evaluate complete lines; the remainder comes in the next pass.
  const schnitt = chunk.text.lastIndexOf('\n')
  if (schnitt < 0) return
  const komplett = chunk.text.slice(0, schnitt + 1)
  const neuerOffset = (chunk.von ?? run.transcript_offset ?? 0) + Buffer.byteLength(komplett, 'utf8')
  db.prepare('UPDATE runs SET transcript_offset = ? WHERE id = ?').run(neuerOffset, run.id)
  const fehler = transkriptFehler(komplett)
  if (!fehler.length) return
  detektorLog(run.id, { art: 'transkript', treffer: fehler.length, bytes: komplett.length })
  for (const fe of fehler) {
    const tsMs = fe.ts ? Date.parse(fe.ts) : Date.now()
    await vorfallMelden(run.id, { typ: fe.typ, quelle: 'transcript', schwere: 'rot',
      beleg: [fe.enum, fe.text].filter(Boolean).join(' — ').slice(0, 300), tsMs: Number.isFinite(tsMs) ? tsMs : Date.now() })
  }
}

/**
 * pipe-pane log (all harnesses, for hermes the ONLY source): only the new bytes,
 * patterns per harness, hits start out YELLOW. They turn red through repetition or
 * silence (vorfaelleBewerten) — or immediately, if the check LLM confirms it.
 */
async function logScannen(run) {
  const logf = join(RUNS_DIR, run.id, 'log.txt')
  if (!existsSync(logf)) return
  let chunk
  try { chunk = neueBytes(logf, run.log_offset ?? 0) } catch { return }
  if (chunk.uebersprungen) detektorLog(run.id, { art: 'log', hinweis: 'backlog skipped', bytes: chunk.uebersprungen })
  if (!chunk.text) return
  // The sandbox family is asked of the same bytes, in the same pass, and only
  // where there IS a sandbox: an unsandboxed run hitting EACCES has an ordinary
  // permission problem, and filing that as a sandbox denial would be a lie in
  // the data (SANDBOX_RESEARCH.md §7.12.1).
  const { treffer, sandboxTreffer, neuerOffset } =
    scanneNeueBytes(run.harness, chunk.text, chunk.von ?? run.log_offset ?? 0, { sandbox: run.sandbox === 1 })
  db.prepare('UPDATE runs SET log_offset = ? WHERE id = ?').run(neuerOffset, run.id)
  if (sandboxTreffer.length) {
    detektorLog(run.id, { art: 'sandbox', treffer: sandboxTreffer.map(t => t.zeile) })
    // Yellow and nothing more: a wall the agent ran into is worth SEEING, and a
    // policy that turns something away is very often doing its job. It never
    // escalates by itself — the escalation path for the sandbox is the proxy's
    // own denials (watchSandboxBlocks) and the agent's `fl-report access`.
    addEventOnce(run.id, 'anomaly:sandbox_denied', { line: sandboxTreffer[0].zeile })
  }
  if (!treffer.length) return
  detektorLog(run.id, { art: 'log', treffer: treffer.map(t => ({ typ: t.typ, zeile: t.zeile })) })

  // One occurrence per type; the number of lines is carried in the evidence. Otherwise
  // a retry loop with 20 lines in a single pass goes red immediately — that decision
  // belongs to the time-based assessment, not to the line count of a screen redraw.
  const jeTyp = new Map()
  for (const t of treffer) if (!jeTyp.has(t.typ)) jeTyp.set(t.typ, t)

  let urteil = null
  if (pruefLlmAktiv()) {
    const zeilen = terminalText(chunk.text).split('\n').filter(z => z.trim()).slice(-80)
    urteil = await pruefeTreffer({ runId: run.id, harness: run.harness, treffer: [...jeTyp.values()], zeilen })
    detektorLog(run.id, { art: 'llm', urteil })
  }

  if (urteil && urteil.problem === false) return   // check LLM: harmless (menu, the agent's own code …)
  for (const [typ, t] of jeTyp) {
    const bestaetigt = urteil && urteil.problem === true && urteil.blockiert === true
    await vorfallMelden(run.id, {
      typ: bestaetigt && urteil.typ && urteil.typ !== 'kein' ? urteil.typ : typ,
      quelle: urteil?.problem === true ? 'log+llm' : 'log',
      schwere: bestaetigt ? 'rot' : 'gelb',
      beleg: (urteil?.zitat || t.zeile).slice(0, 300),
    })
  }
}

/**
 * cursor: the turn end WITHOUT a hook.
 *
 * The `stop` hook in the worktree's `.cursor/hooks.json` is the fast path — it
 * reports within a second. This is the one that also works when the hook is not
 * there: a repository that brings its own hooks.json keeps the hub from writing
 * one (runner.mjs never overwrites), and a cursor version could rename the
 * event. The transcript cannot go away, because it is where cursor keeps the
 * conversation: a finished turn ends the file with {"type":"turn_ended"}.
 *
 * Costs one file read per pass and per running cursor run — the same thing
 * measureActivity() does for claude.
 */
async function cursorTurnEndDetected(run) {
  if (run.harness !== 'cursor' || run.status !== 'running') return false
  const state = cursorTranscriptState(run)
  if (!state?.turnEnded) return false
  return await finishByTurnEnd(run.id, 'cursor transcript')
}

/**
 * Assess open incidents by time and state, in two directions:
 *
 *   UP   yellow log incidents escalate (retry loop or silence after the hit) →
 *        red + a notification — bewerteLogTreffer's judgment, unchanged.
 *   DOWN everything that demonstrably went away resolves ITSELF
 *        (vorfallWeggrund in detect.mjs): the run came through, the agent kept
 *        working after the occurrence, or a yellow hit was never repeated. The
 *        operator then has one thing fewer to click away — and an incident that
 *        that was announced also announces its recovery
 *        (vorfallVerwerfen), so an alarm that rang is un-rung.
 *
 * What deliberately stays open: a red incident on a failed/aborted run (the
 * reason it did not come through — the operator decides), and merge_blocked
 * (the integrator's ladder, not time's).
 */
async function vorfaelleBewerten() {
  const rows = db.prepare(`SELECT i.*, r.last_activity_at, r.status AS run_status FROM incidents i
    LEFT JOIN runs r ON r.id = i.run_id
    WHERE i.geloest_am IS NULL`).all()
  const jetzt = Date.now()

  // UP: the yellow log incidents, by count and silence — as always.
  for (const v of rows) {
    if (!(v.schwere === 'gelb' && v.quelle?.startsWith('log'))) continue
    if (!['running', 'waiting_help'].includes(v.run_status ?? '')) continue
    const stufe = bewerteLogTreffer({ anzahl: v.anzahl, erstGesehenMs: msVon(v.erst_gesehen),
      zuletztGesehenMs: msVon(v.zuletzt_gesehen), letzteAktivitaetMs: v.last_activity_at ? msVon(v.last_activity_at) : null,
      jetztMs: jetzt })
    if (stufe === 'rot') {
      const grund = v.anzahl >= 2 ? `${v.anzahl}× within a short time` : 'no activity since the hit'
      await vorfallEskalieren(v.id, grund)
    }
  }

  // DOWN: the condition is gone — resolve without asking.
  for (const v of rows) {
    if (v.geloest_am !== null) continue   // just escalated above stays red, just resolved stays resolved
    const grund = vorfallWeggrund({
      typ: v.typ, schwere: v.schwere, runStatus: v.run_status ?? null,
      letzteAktivitaetMs: v.last_activity_at ? msVon(v.last_activity_at) : null,
      zuletztGesehenMs: msVon(v.zuletzt_gesehen), jetztMs: jetzt,
    })
    if (grund) await vorfallVerwerfen(v.id, grund)
  }
}

/**
 * Provider pulse: independently of the agents, check every 5 min whether the
 * providers of the running agents respond at all. An outage thus becomes visible
 * even when no agent is currently hitting it. Two consecutive failures = incident
 * (global), recovery closes it automatically — the next outage reopens it.
 */
// Pulse targets come from the plugins: provider plugins carry their own pulse
// endpoint, and harness plugins can add extra targets (claude → anthropic).
// A harness whose pulseId() returns null (cursor: no open endpoint for
// api2.cursor.sh) is explicitly "not monitored", not "healthy".
const PULS = {
  ...Object.fromEntries(Object.entries(PROVIDER_PLUGINS)
    .filter(([, p]) => p.pulse).map(([id, p]) => [id, p.pulse])),
  ...Object.assign({}, ...Object.values(HARNESS_PLUGINS).map(p => p.pulseTargets ?? {})),
}
const pulsZustand = { zuletztMs: 0, fehlschlaege: {} }
export function providerVonLauf(run) {
  const plugin = getHarness(run.harness)
  const id = plugin?.pulseId ? plugin.pulseId(run) : (run.provider ?? null)
  return id && PULS[id] ? id : null
}
async function providerPuls(jetzt = Date.now()) {
  if (env('PULS_AUS') === '1') return
  const takt = Number(env('PULS_TAKT_MS') ?? 5 * 60_000)
  if (jetzt - pulsZustand.zuletztMs < takt) return
  pulsZustand.zuletztMs = jetzt
  const aktiv = db.prepare(`SELECT harness, provider FROM runs WHERE status IN ('running','waiting_help')`).all()
  const provider = new Set(aktiv.map(providerVonLauf).filter(Boolean))
  for (const name of provider) {
    const ok = await pulsPruefen(name)
    const f = pulsZustand.fehlschlaege
    f[name] = ok ? 0 : (f[name] ?? 0) + 1
    const typ = `provider_down:${name}`
    if (!ok && f[name] >= 2) {
      await vorfallMelden(null, { typ, quelle: 'puls', schwere: 'rot', beleg: `${name}: ${f[name]} consecutive checks without a response` })
    } else if (ok) {
      for (const v of offeneVorfaelle(null)) if (v.typ === typ) await vorfallVerwerfen(v.id, 'erholt')
    }
  }
}
async function pulsPruefen(name) {
  const ziel = env('PULS_URL_TEST') ? { url: env('PULS_URL_TEST'), okStatus: [200] } : PULS[name]
  if (!ziel) return true
  try {
    const res = await fetch(ziel.url, { method: 'GET', signal: AbortSignal.timeout(10_000) })
    return ziel.okStatus.includes(res.status)
  } catch { return false }
}

/**
 * Take back 'anomaly:no_activity' — the agent is measurably working again.
 *
 * The event stays in the run's history as 'cleared:anomaly:no_activity' (that
 * is what clearAnomalies does), so the traffic light falls back and
 * addEventOnce fires again on the next genuine silence. The announcement is
 * explicit because nothing was ADDED here: the live channel hangs on
 * addEvent(), and a retraction that no page hears about would sit in the
 * overview until the next unrelated event.
 */
function retractNoActivity(runId) {
  const had = db.prepare(`SELECT 1 FROM events WHERE run_id=? AND kind='anomaly:no_activity' LIMIT 1`).get(runId)
  if (!had) return
  clearAnomalies(runId, ['anomaly:no_activity'])
  announceRun(runId, 'activity')
}

/** How long a sandbox denial keeps colouring a run that has since carried on. */
const SANDBOX_DENIED_SETTLE_MS = Number(env('SANDBOX_DENIED_SETTLE_MS') ?? 10 * 60_000) || 10 * 60_000

/**
 * Take back 'anomaly:sandbox_denied' — the veto, applied to the log family.
 *
 * The same evidence that stops a log hit escalating stops a wall colouring a
 * run for ever: measurable work AFTER the hit says the agent coped with it, and
 * a hit it coped with is history rather than a call for attention. The ten
 * minutes are `vorfallWeggrund()`'s own `arbeitMs` — retracting in the same
 * second as the hit would make the anomaly invisible, since an agent writes to
 * its transcript within a heartbeat of reading an error off its screen.
 *
 * `agentCopedAfter()` is that veto, imported and not copied: it is the first
 * line of bewerteLogTreffer() and the first line of sandboxBlockedSchwere().
 * A run that ends without ever coping keeps the anomaly, which is exactly what
 * one wants to read next to a run that did not come through.
 */
function retractSandboxDenied(runId, aktivMs, jetztMs = Date.now()) {
  const ev = db.prepare(`SELECT ts FROM events WHERE run_id=? AND kind='anomaly:sandbox_denied'
                         ORDER BY id DESC LIMIT 1`).get(runId)
  if (!ev) return
  const seit = msVon(ev.ts)
  if (!agentCopedAfter(aktivMs, seit)) return
  if (jetztMs - seit < SANDBOX_DENIED_SETTLE_MS) return
  clearAnomalies(runId, ['anomaly:sandbox_denied'])
  announceRun(runId, 'activity')
}

/** How many DISTINCT hosts turned away make a `sandbox_blocked` incident red (§7.12.1). */
const SANDBOX_BLOCK_HOSTS = Number(env('SANDBOX_BLOCKED_HOSTS') ?? 2) || 2

/**
 * The proxy's denials, as something a human notices (§7.12.1).
 *
 * `server/sandbox/index.mjs` writes one `sandbox:blocked` event per host per ten
 * minutes; this pass is what turns those events into the one record that reaches
 * the sidebar, the notification channel and the run's own page. Reading the
 * EVENTS rather than being called by the proxy is deliberate: the built-in proxy
 * runs in the hub process and iron-proxy does not, and a fact that only exists
 * while one particular engine is loaded is a fact that goes missing the day the
 * operator switches engines — or the hub restarts mid-run.
 *
 * Yellow to begin with, red when the wall is demonstrably in the way, and the
 * veto before either (sandboxBlockedSchwere). The high-water mark is the
 * incident's own `zuletzt_gesehen`, so a hub restarted between two passes picks
 * up where it left off and a resolved incident reopens on the next denial —
 * the auto-alarm principle, unchanged.
 */
export async function watchSandboxBlocks(jetztMs = Date.now()) {
  const rows = db.prepare(`SELECT id, last_activity_at FROM runs
                           WHERE sandbox=1 AND status IN ('running','waiting_help')`).all()
  for (const run of rows) {
    const evs = db.prepare(`SELECT ts, payload FROM events WHERE run_id=? AND kind='sandbox:blocked'
                            ORDER BY id`).all(run.id)
    if (!evs.length) continue
    const denials = evs.map(e => {
      let p = {}
      try { p = e.payload ? JSON.parse(e.payload) : {} } catch { p = {} }
      // The proxy's own timestamp where it gave one; the event's otherwise.
      const at = p.at ? Date.parse(p.at) : NaN
      return { host: p.host ?? '', atMs: Number.isFinite(at) ? at : msVon(e.ts) }
    })
    const summary = sandboxDenialSummary(denials)
    if (!summary.hosts.length || summary.zuletztMs == null) continue

    const aktivMs = run.last_activity_at ? msVon(run.last_activity_at) : null
    const beleg = (`${summary.hosts.length} host(s) turned away by the sandbox proxy: `
      + `${summary.hosts.slice(0, 6).join(', ')}${summary.hosts.length > 6 ? ', …' : ''}`
      + ` (${summary.count}× after the per-host throttle)`).slice(0, 300)

    // The LAST record of this type, resolved or not: it carries the high-water
    // mark. Asking only for OPEN ones would count the same denials up again on
    // every pass once somebody had clicked the incident away.
    const letzter = db.prepare(`SELECT * FROM incidents WHERE run_id=? AND typ='sandbox_blocked'
                                ORDER BY id DESC LIMIT 1`).get(run.id)
    if (!letzter || summary.zuletztMs > msVon(letzter.zuletzt_gesehen)) {
      await vorfallMelden(run.id, { typ: 'sandbox_blocked', quelle: 'proxy', schwere: 'gelb',
        beleg, tsMs: summary.zuletztMs })
    }

    const offen = offeneVorfaelle(run.id).find(v => v.typ === 'sandbox_blocked')
    if (!offen || offen.schwere !== 'gelb') continue
    const schwere = sandboxBlockedSchwere(summary, { letzteAktivitaetMs: aktivMs, jetztMs,
      hostSchwelle: SANDBOX_BLOCK_HOSTS })
    if (schwere !== 'rot') continue
    await vorfallEskalieren(offen.id, summary.hosts.length >= SANDBOX_BLOCK_HOSTS
      ? `${summary.hosts.length} distinct hosts turned away`
      : 'no activity since the denial')
  }
}

/**
 * Evaluate the Claude transcript (path known in advance thanks to --session-id, planning 7.1).
 *
 * `measured` is the answer to "does this harness have an activity source at
 * all" — set by the branches that have one, false in the fallthrough. It is
 * kept HERE, next to the code that implements it, rather than as a second list
 * somewhere: a harness that gains a source gains the flag in the same edit.
 */
async function measureActivity(run) {
  const out = { lastActivity: null, tokensIn: 0, tokensOut: 0, costUsd: null, measured: false }
  if (run.harness === 'claude' && run.workdir_effective) {
    out.measured = true
    const f = claudeTranskriptPfad(run)
    if (existsSync(f)) {
      try {
        const stat = statSync(f)
        out.lastActivity = new Date(stat.mtime).toISOString().replace('T', ' ').slice(0, 19)
        const text = readFileSync(f, 'utf8')
        const lines = text.split('\n').filter(Boolean)
        for (const line of lines.slice(-500)) {
          try {
            const j = JSON.parse(line)
            const u = j?.message?.usage
            if (u) {
              out.tokensIn += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
              out.tokensOut += (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
            }
          } catch {}
        }
      } catch {}
    }
    return out
  }
  // opencode: the session store — the run's whole session TREE, not the newest
  // session of its directory. A subagent gets a child session in the same
  // directory, so the old pick read a run's activity off a subagent that had
  // usually already finished (server/opencode-store.mjs has the measurement).
  if (run.harness === 'opencode' && run.workdir_effective) {
    out.measured = true
    const store = await storeActivity(run)
    if (store) {
      out.tokensIn = store.tokensIn
      out.tokensOut = store.tokensOut
      out.costUsd = store.costUsd
      if (store.lastActivityMs) {
        out.lastActivity = new Date(store.lastActivityMs).toISOString().replace('T', ' ').slice(0, 19)
      }
    }
    return out
  }
  // cursor: the transcript's mtime. cursor appends to it while it works
  // (measured: 325 → 693 → 994 → 1302 bytes across three tool calls, mtime
  // advancing each time), so it is an activity source exactly like claude's
  // transcript. Before this, measureActivity() returned nothing for cursor —
  // which left the traffic light's "no activity for 15 min" and the incident
  // detector's work-after-the-hit veto blind on this harness. Tokens are not in
  // there; for cursor the subscription usage panel is the honest source.
  if (run.harness === 'cursor') {
    out.measured = true
    const state = cursorTranscriptState(run)
    if (state) out.lastActivity = new Date(state.mtimeMs).toISOString().replace('T', ' ').slice(0, 19)
    return out
  }
  // hermes: state.db sessions (matched via cwd + time)
  if (run.harness === 'hermes' && run.workdir_effective) {
    try {
      const { DatabaseSync } = await import('node:sqlite')
      // Same indirection as the three harnesses above: the state store sits in
      // the home the agent ran with, which is the host home unless the run was
      // sandboxed (§7.7).
      const d = new DatabaseSync(join(agentHome(run), '.hermes/state.db'), { readOnly: true })
      const rows = d.prepare(`SELECT estimated_cost_usd, input_tokens, output_tokens FROM sessions
                              WHERE cwd = ? ORDER BY started_at DESC LIMIT 1`).all()
      // Column names can differ between versions — resolve defensively via PRAGMA.
      let row = rows[0]
      if (!row) {
        const cols = d.prepare(`SELECT name FROM pragma_table_info('sessions')`).all().map(c => c.name)
        if (cols.length) {
          const sel = ['estimated_cost_usd', 'input_tokens', 'output_tokens'].filter(c => cols.includes(c))
          if (sel.length) {
            row = d.prepare(`SELECT ${sel.join(',')} FROM sessions WHERE cwd = ? ORDER BY started_at DESC LIMIT 1`)
              .get(run.workdir_effective)
          }
        }
      }
      if (row) {
        out.costUsd = row.estimated_cost_usd ?? null
        out.tokensIn = row.input_tokens ?? 0
        out.tokensOut = row.output_tokens ?? 0
      }
      d.close()
    } catch {}
    return out
  }
  return out
}

/**
 * Costs at run end: Claude = delta of the 7-day quota in percentage points → €.
 *
 * The week read here is the run's own (`sevenForRun`) — the same one
 * runner.mjs wrote into quota7_start, so the two ends of the subtraction
 * describe one window. Taking the maximum instead made a run on Sonnet
 * expensive because somebody else's Fable week filled up while it ran.
 */
function finishCosts(run) {
  const q = claudeQuota()
  const seven = sevenForRun(run, q)
  const aboPreis = Number(db.prepare(`SELECT value FROM settings WHERE key='abo_price'`).get()?.value ?? 200) || 200
  let costEur = null
  if (run.harness === 'claude' && run.quota7_start != null && seven != null) {
    const delta = Math.max(0, seven - run.quota7_start)
    costEur = Math.round((delta / 100 / 4.348 * aboPreis) * 100) / 100
  }
  db.prepare(`UPDATE runs SET quota5_end=?, quota7_end=?, cost_eur=?, ended_at=COALESCE(ended_at, datetime('now')) WHERE id=?`)
    .run(q.five, seven, costEur, run.id)
}

// ---------- a lost session is resumed, not aborted ----------
// The outcomes of one pass, for the one message that names them all.
let resumeLog = []

/**
 * Hand a run whose session vanished to resumeRun(). true = the run is being
 * resumed (a new session stands, it is deferred on the budget gate, or the
 * launch is retried next pass); false = it cannot be, and the caller ends it
 * the way it always did. A refusal is written on the run, so "why was this
 * one aborted after all?" has an answer on its own page.
 */
async function tryResume(run) {
  const { resumeRun } = await import('./runner.mjs')
  let r
  try { r = await resumeRun(run.id, { reason: 'session_lost' }) } catch (e) { r = { ok: false, error: e.message } }
  if (r.ok || r.retry) { resumeLog.push({ runId: run.id, ...r }); return true }
  addEvent(run.id, 'resume_refused', { error: r.error })
  return false
}

/**
 * Runs marked for a resume whose launch has not produced a session yet — the
 * previous attempt could not try (no tmux server yet), or the hub restarted
 * between the mark and the launch. launchRun() reads the mark and resumes;
 * it also keeps the cap.
 */
async function retryPendingResumes() {
  const rows = db.prepare(`SELECT id FROM runs WHERE status IN ('running','waiting_help')
                           AND resume_pending = 1 AND tmux_session IS NULL`).all()
  if (!rows.length) return
  const { launchRun, resumeLaunchInFlight } = await import('./runner.mjs')
  for (const row of rows) {
    // A launch that began seconds ago is not a failed one — leave it alone.
    if (resumeLaunchInFlight(row.id)) continue
    try {
      const r = await launchRun(row.id)
      resumeLog.push({ runId: row.id, ...r })
    } catch (e) { console.error(`[watcher] resume ${row.id}:`, e.message) }
  }
}

/**
 * The lost sessions of one pass as ONE message. A reboot takes every session
 * at once, and a message per run was the shape the old abort path had — six
 * "aborted, work not merged" texts on the phone for one event. Muted runs
 * (the checkbox under the terminal) are left out; with nothing to say, nothing
 * is sent. A retry is named once as "still trying"; its success is a later
 * pass's message, and a final failure is failRun()'s own.
 */
async function announceResumes() {
  const log = resumeLog
  resumeLog = []
  if (!log.length) return
  const seen = new Set()
  const ok = [], deferred = [], retry = []
  for (const r of log) {
    if (seen.has(r.runId)) continue
    seen.add(r.runId)
    if (!notifyOnFor(r.runId)) continue
    if (r.ok && r.deferred) deferred.push(r)
    else if (r.ok) ok.push(r)
    else if (r.retry) retry.push(r)
  }
  if (!ok.length && !deferred.length && !retry.length) return
  const name = (id) => db.prepare('SELECT title FROM runs WHERE id=?').get(id)?.title || kurzid(id)
  const lines = ['🔁 tmux sessions were lost (a restart or a dead tmux server) — Freilauf resumed the runs:']
  if (ok.length) lines.push(`Resumed in a new session: ${ok.map(r => name(r.runId)).join(', ')}`)
  if (deferred.length) lines.push(`Waiting on the budget gate, resume pending: ${deferred.map(r => name(r.runId)).join(', ')}`)
  if (retry.length) lines.push(`Could not launch yet, trying again next pass: ${retry.map(r => name(r.runId)).join(', ')}`)
  await notify({ kind: 'system', text: lines.join('\n') })
}

// ---------- retry deferred runs ----------
async function retryDeferred() {
  const deferred = db.prepare(`SELECT * FROM runs WHERE status='deferred'`).all()
  if (!deferred.length) return
  // Same gate as at the start (scheduler.mjs) — dynamic import, because the
  // scheduler pulls in the runner and the watcher is loaded by hub.mjs first.
  const { budgetGate, startDeferredRun } = await import('./scheduler.mjs')
  for (const run of deferred) {
    if (await budgetGate(run.harness, run.model ?? null, run.provider ?? null)) continue
    startDeferredRun(run.id).then(r => {
      if (!r.ok) notifyRun(run.id, 'start_failed', `Start after deferral failed: ${r.error}`)
    }).catch(() => {})
  }
}

// ---------- planned single runs (point in time / "when the repo is free") ----------
async function startScheduled() {
  const wartend = db.prepare(`SELECT 1 FROM runs WHERE status='scheduled' LIMIT 1`).get()
  if (!wartend) return
  // Dynamic import for the same reason as retryDeferred above: the scheduler
  // pulls in the runner, and hub.mjs loads the watcher first.
  const { pickUpScheduled } = await import('./scheduler.mjs')
  await pickUpScheduled()
}

/**
 * Branch reconciliation AFTER the end (yellow: unpushed; planning 4.5/7.7).
 * Deliberately its own pass: watchRun() only ever sees running runs, so a check
 * for 'done'/'failed' there would never have become true.
 */
/**
 * Record the end costs once (delta of the 7-day quota → €, planning 4.4).
 * This too used to live in watchRun() and therefore never ran: only running runs
 * arrive there.
 */
async function finishCostsPass() {
  const rows = db.prepare(`SELECT * FROM runs
    WHERE status IN ('done','failed','aborted') AND quota7_end IS NULL`).all()
  for (const run of rows) {
    // A short run is over before the watcher sees it for the first time — and after
    // that it never comes around again (watchRun only receives running runs).
    // Without this final measurement, tokens and costs would stay at 0 forever.
    const act = await measureActivity(run)
    if (act.tokensIn || act.tokensOut || act.lastActivity) {
      db.prepare(`UPDATE runs SET last_activity_at=COALESCE(?, last_activity_at),
                  tokens_in=?, tokens_out=?, cost_usd=COALESCE(?, cost_usd) WHERE id=?`)
        .run(act.lastActivity, act.tokensIn, act.tokensOut, act.costUsd ?? null, run.id)
    }
    finishCosts(run)
  }
}

async function checkFinishedBranches() {
  const rows = db.prepare(`
    SELECT * FROM runs
    WHERE status IN ('done','failed') AND worktree IS NOT NULL
      AND id NOT IN (SELECT run_id FROM events WHERE kind IN ('anomaly:unpushed','branch_synced'))
  `).all()
  for (const run of rows) {
    const branch = run.branch_reported || run.branch_expected
    if (!branch || !existsSync(run.worktree)) continue
    const repo = getRepo(run.repo_id)
    if (!repo) continue
    const { upstream, track, synced } = await branchSyncState(repo.path, branch)
    if (synced) {
      addEvent(run.id, 'branch_synced', { branch })
      continue
    }
    addEventOnce(run.id, 'anomaly:unpushed', { branch, upstream: upstream || null, track })
    await notifyRun(run.id, 'unpushed', upstream
      ? `🟡 Branch '${branch}' has unpushed commits.`
      : `🟡 Branch '${branch}' is not pushed anywhere (no upstream).`)
  }
}

// ---------- cleanup (planning 4.7) ----------
/**
 * Close sessions whose work is over. Two things changed here against the first
 * version, both of which cost real memory on this machine:
 *
 * 1. The trigger used to be a DEAD pane only. With `--keep` (remain-on-exit) a
 *    claude that reported 'done' and then sits in its TUI keeps its pane alive
 *    indefinitely — the rule never fired for exactly the sessions that were
 *    piling up. finishedAtMs() therefore also counts the run's own end.
 * 2. The keep time is configurable in hours instead of whole days
 *    (sessionKeepMs, Settings → keep the tmux session open).
 *
 * One tmux listing serves all runs; the old version made two tmux calls per
 * open session.
 */
async function closeOldSessions() {
  const rows = db.prepare(`SELECT * FROM runs WHERE tmux_session IS NOT NULL AND tmux_closed_at IS NULL`).all()
  if (!rows.length) return
  const keepMs = currentKeepMs()
  const snap = await tmuxSnapshot()
  // No usable answer: do nothing at all this pass. Every run below would
  // otherwise look session-less at once — the listing's failure would end all
  // of them (see tmuxVerdict in sessions.mjs).
  if (!snap.ok) { await tmuxUnreachable(snap.reason); return }
  await tmuxAnswered()
  const live = new Map(snap.sessions.map(s => [s.name, s]))
  await tmuxServerGone(rows, live)
  const now = Date.now()
  for (const run of rows) {
    const session = live.get(run.tmux_session)
    if (!session) {                                                        // no longer exists
      if (!await confirmGone(run)) continue
      reconcileClosedSession(run.id, 'watcher')
      continue
    }
    if (!shouldAutoClose(session, run, keepMs, now)) continue
    await sh('tmux', ['kill-session', '-t', `=${run.tmux_session}`])
    reconcileClosedSession(run.id, 'retention')
    addEvent(run.id, 'tmux_closed', { reason: 'retention' })
  }
}

/**
 * The listing says this run's session is missing. For a run that is OVER that
 * is bookkeeping and the listing is good enough. For one that is still going,
 * acting on it ABORTS somebody's work — so it is asked a second time, directly
 * and by name, and only a confirmed 'gone' counts. Two independent answers
 * instead of one, exactly where the mistake is expensive.
 */
async function confirmGone(run) {
  if (!['running', 'waiting_help'].includes(run.status)) return true
  const gone = await sessionGone(run.tmux_session)
  if (gone === true) return true
  console.error(`[watcher] ${run.id}: listing said ${run.tmux_session} is gone, has-session said ${gone === false ? 'it is there' : 'nothing'} — leaving the run alone`)
  return false
}

/**
 * Every session at once is not N runs ending — it is the tmux server going
 * away, and the operator has to hear that as ONE fact. Without it the day this
 * happened produced 22 silent 'tmux_closed' rows and an aborted run whose
 * record blamed its own session, so the only way to the real cause was to read
 * the event log by hand.
 *
 * Raised only on the unambiguous shape: tmux positively reports no server while
 * the hub was tracking at least two open sessions.
 */
async function tmuxServerGone(rows, live) {
  if (live.size || rows.length < 2) return
  await vorfallMelden(null, {
    typ: 'tmux_gone', quelle: 'watcher', schwere: 'rot',
    beleg: `tmux reports no running server, ${rows.length} sessions of this hub were open. `
         + `Nothing of this was done by Freilauf. Every run that was still working is being resumed `
         + `in a new session (see the runs' own events: session_lost / resumed); `
         + `finished runs only lost the screen they left standing.`,
  })
}

/** tmux cannot be asked at all. Runs then hang on 'running' with no explanation — say so. */
async function tmuxUnreachable(reason) {
  console.error('[watcher] tmux unreachable:', reason)
  await vorfallMelden(null, {
    typ: 'tmux_unreachable', quelle: 'watcher', schwere: 'rot',
    beleg: `tmux gave no answer: ${String(reason).slice(0, 400)}. `
         + `Session cleanup is paused until it does — no run is ended on a guess.`,
  })
}

/** tmux answers again: the transient outage above is over and closes itself. */
async function tmuxAnswered() {
  for (const v of offeneVorfaelle(null)) {
    if (v.typ === 'tmux_unreachable') vorfallLoesen(v.id, 'watcher')
  }
}

// --------------------------------------------- containers: the same lesson again
//
// A sandboxed run works in a container while its tmux session holds the client
// (SANDBOX_RESEARCH.md §7.1). So the machine now holds two things per run that
// can disappear independently, and the reconciliation between them is this pass.
//
// tmuxVerdict()'s lesson applies here with full force, and it is the most
// important rule in this section: "docker did not answer" is `unreachable`, NOT
// "there are no containers". A daemon restart, a busy socket, a rootless
// docker.service that is still coming up after a reboot — every one of them
// answers like an empty machine, and a pass that spent that as "gone" would end
// every sandboxed run on the box at once. Nothing here acts on anything but
// `ok`.

/** The statuses that mean a run is still on its way — never reaped, whatever the container does. */
export const IN_FLIGHT_STATUSES = ['running', 'waiting_help', 'scheduled', 'deferred']

/**
 * What to do with ONE container of this hub. Pure, so the table below is a test
 * and not an argument:
 *
 *   'leave'          nothing to do — the ordinary case for a working run.
 *   'stop_orphan'    the container runs on with no session left to watch it:
 *                    the client died or the operator hit the detach chord
 *                    (§8.18). Stop it and say so.
 *   'container_gone' the run is in flight and its container is not there any
 *                    more: the agent died. `pane_dead` says the same thing, and
 *                    the ordinary paths (watchRun, closeOldSessions) decide what
 *                    that MEANS for the run — this only records the fact.
 *   'reap'           nothing is waiting on it any more: stop and remove.
 *
 * `status` is null for a container whose run is not in the database at all (a
 * deleted repo, a run wiped by hand): nothing can be waiting on that.
 *
 * `retention: 'keep'` is the operator asking to keep the container for `docker
 * exec` debugging after the run is over (§7.11). It buys exactly the retention
 * clock, no more: `overKeep` is what says the clock has run out, and a 'keep'
 * that never expired would be a container nothing on this machine ever removes.
 *
 * There is deliberately no `exists` here any more. It used to be a parameter
 * with a default of `true` and exactly one caller, which passed `true` — a rule
 * nobody was applying, and the shape a reader takes for a case that is handled.
 * It cannot vary because of what this function is asked ABOUT: the loop below
 * walks the containers the daemon LISTED, so every one of them exists by
 * construction. The other direction — a run that says sandboxed and has no
 * container in front of it — never reaches this table at all: an in-flight run
 * gets `sandbox:container_gone` from the second loop, and a terminal one is
 * `releasable()`'s business.
 */
export function containerVerdict({ status, sessionOpen, running, retention = 'run', overKeep = false }) {
  if (!status) return 'reap'
  if (IN_FLIGHT_STATUSES.includes(status)) {
    if (!running) return 'container_gone'          // an exited leftover is removed with the event
    return sessionOpen ? 'leave' : 'stop_orphan'
  }
  // Terminal. As long as the session stands, the container is what a follow-up
  // commission types into (§8.5) — retention closes both together, in that order.
  if (sessionOpen) return 'leave'
  if (retention === 'keep' && !overKeep) return 'leave'
  return 'reap'
}

/** Is the run's own session still open, as the hub's own bookkeeping has it? */
function sessionOpenFor(run) {
  return !!(run?.tmux_session && !run.tmux_closed_at)
}

/**
 * Could this hub own a container at all? Either the sandbox is switched on now,
 * or a run in the database once ran in one — a run that was sandboxed keeps its
 * flag, so a hub whose operator switched the feature off still reconciles what
 * it left behind.
 */
export function sandboxInUse() {
  // Through the canonical reader, never through a settings read of its own.
  // The four hub sandbox settings are read in run-def.mjs and nowhere else
  // (the banner there says why: three readers of `sandbox_allow_bypass` with
  // three rules meant a stored `'on'` let the form offer a break-glass the
  // endpoint refused). This one agreed with the canon by accident, which is
  // exactly how the other three started.
  if (sandboxHubMode() !== 'off') return true
  return !!db.prepare(`SELECT 1 FROM runs WHERE sandbox=1 LIMIT 1`).get()
}

/**
 * The reconciliation pass: every container this hub owns, against the runs
 * table. Two directions, because a mismatch has two shapes — a container with
 * no live run behind it, and a run that says sandboxed with no container in
 * front of it.
 */
export async function reconcileContainers(hubId = null, nowMs = Date.now()) {
  // Nothing to reconcile, and nothing to ask. A hub that has never launched a
  // sandboxed run and has the sandbox switched off owns no containers by
  // construction — shelling out to a daemon every 30 seconds to be told so
  // costs a subprocess per pass, and on a machine with no runtime at all it
  // would count as silence and eventually raise `docker_unreachable` about a
  // feature nobody switched on. The verdict rule protects live agents; this
  // guard protects the installations that will never have one.
  if (!sandboxInUse()) return { verdict: 'not_in_use', acted: [] }
  const rt = await sandboxRuntime()
  if (typeof rt?.listOwned !== 'function') return { verdict: 'no_runtime', acted: [] }
  const id = hubId ?? await sandboxHubId()
  if (id == null) return { verdict: 'no_runtime', acted: [] }

  const owned = await rt.listOwned(id)
  if (owned.verdict !== 'ok') {
    // 'no_daemon' is the ordinary state of a machine without Docker and says
    // nothing worth an alarm; only an answer the hub could not get at all is
    // worth counting, and only a repeated one is worth waking anybody for.
    if (owned.verdict === 'unreachable') await dockerUnreachable(owned.reason)
    return { verdict: owned.verdict, acted: [] }
  }
  await dockerAnswered()

  const keepMs = currentKeepMs()
  const acted = []
  const seen = new Set()
  // Runs whose containers this pass took away. What is left of such a run is
  // released AFTER the loop, never inside it — see releaseReaped() below.
  const reaped = new Map()
  for (const c of owned.containers) {
    seen.add(c.name)
    const run = c.runId ? getRun(c.runId) : null
    const spec = run ? specOf(run) : null
    const finished = finishedAtMs(null, run)
    const verdict = containerVerdict({
      status: run?.status ?? null,
      sessionOpen: sessionOpenFor(run),
      running: c.running,
      retention: spec?.retention ?? 'run',
      overKeep: finished != null && nowMs - finished >= keepMs,
    })
    // A proxy container is a tool of the run, not the run: it is reaped with it
    // and never carries an event of its own. Bringing a dead one back while its
    // run is still going is the sandbox facade's job (§8.19), not the reaper's —
    // and that is a division of labour rather than a gap, now that
    // `restoreSandboxProxies()` above calls that facade on every pass. A reaper
    // that STARTED a proxy container would be a second implementation of the
    // launch's proxy step: it cannot see the run's resolved allow list, its CA
    // or its network wiring, and it does not know a retryable failure from a
    // fatal one. `restoreProxies()` answers for the built-in engine today; the
    // iron-proxy container's revival is one more branch THERE, and this pass
    // picks it up without a line changing here.
    if (c.kind === 'proxy' && verdict !== 'reap') continue
    acted.push({ name: c.name, runId: c.runId, kind: c.kind, verdict })
    try {
      if (verdict === 'reap') {
        if (c.running) await rt.stopContainer(c.name, {})
        await rt.removeContainer(c.name, {})
        // A run whose row is GONE (a deleted repo, a run wiped by hand) still
        // owns a network named after the id on the container's label — that is
        // the whole reason the stand-in exists rather than a `if (run)`.
        if (c.runId) reaped.set(c.runId, run ?? { id: c.runId, sandbox: 1, sandbox_container: null })
      } else if (verdict === 'stop_orphan') {
        await rt.stopContainer(c.name, {})
        if (run) addEventOnce(run.id, 'sandbox:container_gone', { reason: 'no session left for this container', container: c.name })
      } else if (verdict === 'container_gone') {
        if (run) addEventOnce(run.id, 'sandbox:container_gone', { reason: 'container ended while the run was still going', container: c.name })
        await rt.removeContainer(c.name, {})
      }
    } catch (err) { console.error('[sandbox]', c.name, err.message) }
  }

  // The other direction: a run that says it is sandboxed and whose container the
  // daemon did not list at all. `--rm` takes a finished container away, so this
  // only says something for a run that is still supposed to be working.
  const flight = db.prepare(`SELECT * FROM runs WHERE sandbox=1 AND sandbox_container IS NOT NULL
                             AND status IN ('running','waiting_help')`).all()
  for (const run of flight) {
    const name = containerName(run)
    if (!name || seen.has(name)) continue
    acted.push({ name, runId: run.id, kind: 'agent', verdict: 'container_gone' })
    addEventOnce(run.id, 'sandbox:container_gone', { reason: 'container is no longer known to the runtime', container: name })
  }

  // What a reaped run still holds when its containers are gone, and what nothing
  // used to take back.
  for (const [runId, row] of reaped) {
    if (await releaseReaped(row)) acted.push({ name: runId, runId, kind: 'sandbox', verdict: 'released' })
  }
  // …and the same for a run whose containers the daemon does not list any more.
  // `--rm` takes a finished container away by itself, so the loop above never
  // sees the ordinary case at all — which is exactly how every ordinary run
  // leaked its network. The event is the marker, so this costs one pass per run
  // and then nothing.
  for (const row of releasable(nowMs, keepMs)) {
    if (reaped.has(row.id)) continue
    if (await releaseReaped(row)) acted.push({ name: row.id, runId: row.id, kind: 'sandbox', verdict: 'released' })
  }
  return { verdict: 'ok', acted }
}

/**
 * Everything a finished sandboxed run still holds outside its containers, given
 * back — and the reason this is a leak and not an untidiness.
 *
 * The per-run network is **persisted by the daemon**: `--rm` never takes it,
 * `docker stop` never takes it, and the reaper did not either. Docker's default
 * address pool subnets out after roughly 31 networks, and past that **no
 * sandboxed run starts at all** — a failure that arrives days after the runs
 * that caused it and looks like the runtime being broken. `teardownSandbox()`
 * also stops the built-in proxy listener inside THIS process (it was still
 * holding the finished run's allow policy) and the `docker events` tail child
 * watching a container that no longer exists.
 *
 * Called only from a pass that got an `ok` verdict out of the daemon — the rule
 * this whole section is written around. It is idempotent in both directions:
 * removing a network the daemon has already forgotten is a success, and
 * `sandbox:released` is written once, which is what keeps the sweep below from
 * shelling out for the same run every thirty seconds for ever.
 */
async function releaseReaped(row) {
  if (!row?.id) return false
  try {
    const { teardownSandbox } = await import('./sandbox/index.mjs')
    const out = await teardownSandbox(row, { reason: 'reaped', removeNetwork: true, force: true })
    addEventOnce(row.id, 'sandbox:released',
      { network: !!out?.network, proxy: !!out?.proxy, container: out?.container ?? null })
    return true
  } catch (err) { console.error('[sandbox]', err.message); return false }
}

/**
 * Sandboxed runs that are over, whose session is closed, and which have not been
 * released yet. Three exclusions, each of them a way it would otherwise be
 * wrong:
 *
 *  - a run still in flight, or one on its way back (`resume_pending`): §7.11's
 *    start order walks the clone, the home and the network again, and taking
 *    the network away under a resume that is already running would be the
 *    reaper undoing a recovery.
 *  - `retention: 'keep'` before its clock has run out — the operator asked to
 *    keep the container for `docker exec` debugging, and a network removed out
 *    from under it would make that container unreachable.
 *  - anything already carrying `sandbox:released`. The marker is read from the
 *    database and not from a Set in this process, because a hub that deploys as
 *    often as this one restarts oftener than a leak accumulates.
 */
function releasable(nowMs, keepMs) {
  const rows = db.prepare(`SELECT r.* FROM runs r
                           WHERE r.sandbox=1 AND r.tmux_closed_at IS NOT NULL
                             AND r.status NOT IN ('running','waiting_help','scheduled','deferred')
                             AND r.resume_pending IS NOT 1
                             AND NOT EXISTS (SELECT 1 FROM events e
                                             WHERE e.run_id=r.id AND e.kind='sandbox:released')`).all()
  return rows.filter((run) => {
    if ((specOf(run)?.retention ?? 'run') !== 'keep') return true
    const finished = finishedAtMs(null, run)
    return finished != null && nowMs - finished >= keepMs
  })
}

/**
 * The daemon cannot be asked at all — the `tmux_unreachable` twin, and it takes
 * its shape from that one on purpose. Raised only after REPEATED silence: a
 * single busy moment is not worth a page, and the pass has already done the
 * right thing about it, which is nothing.
 */
const dockerSilence = { count: 0 }
const DOCKER_UNREACHABLE_AFTER = Number(env('SANDBOX_UNREACHABLE_AFTER') ?? 3) || 3

async function dockerUnreachable(reason) {
  dockerSilence.count += 1
  if (dockerSilence.count < DOCKER_UNREACHABLE_AFTER) return
  console.error('[sandbox] container runtime unreachable:', reason)
  await vorfallMelden(null, {
    typ: 'docker_unreachable', quelle: 'watcher', schwere: 'rot',
    beleg: `The container runtime gave no answer ${dockerSilence.count} times in a row: `
         + `${String(reason ?? '').slice(0, 400)}. Sandboxed runs are left exactly as they are — `
         + `nothing is stopped, reaped or ended on a guess. Their tmux sessions and their work are untouched.`,
  })
}

/** The daemon answers again: the transient outage above closes itself. */
async function dockerAnswered() {
  if (!dockerSilence.count) return
  dockerSilence.count = 0
  for (const v of offeneVorfaelle(null)) {
    if (v.typ === 'docker_unreachable') vorfallLoesen(v.id, 'watcher')
  }
}

/** Test hook: forget how often the runtime has been silent. */
export function _resetDockerSilence() { dockerSilence.count = 0 }

// ------------------------------------ the proxy a hub restart took with it
//
// §8.19's `sandbox:proxy_restarted`, and the reason it is wired HERE.
//
// With the default `network.engine: 'builtin'` the run's egress proxy is a
// listener inside the hub PROCESS and the facade's handle map is in-process
// only. Measured across a real stop/start: the run survives, its tmux session
// survives, the container survives — and the listener is gone, while the
// container's frozen `HTTPS_PROXY` still points at the dead port. From that
// moment every request the agent makes fails with a connection error and the
// hub reads `running` throughout. This hub restarted 164 times in 30 days, so
// it is the ordinary case, and it is the invisible-failure shape this file has
// the most rules about.
//
// `restoreProxies()` in the facade does the repair (same port out of the run's
// own `sandbox.json`, same resolved allow list, fail-soft per run). This is the
// caller it was missing, and it is the watcher's pass rather than a timer of
// its own for two reasons: `hub.mjs` already runs a first pass two seconds
// after listen, so a restarted hub repairs its runs without waiting for
// anything else to happen; and a second timer over the same runs is the drift
// `reconcileContainers()`'s own banner is about.
//
// Three properties, each of them a way it would otherwise be wrong:
//
//  - **it hangs on the reconciliation pass's verdict**, not on a question of
//    its own. `ok` is a positive answer about the machine; `unreachable` means
//    the hub learned NOTHING, and acting on that is exactly the mistake
//    `tmuxVerdict()` exists to prevent. Not knowing is a reason to wait a pass.
//    `not_in_use` / `no_daemon` / `no_runtime` are the same refusal from the
//    other side: no runtime means no container, and no container means there is
//    nothing for a proxy to serve.
//  - **it is idempotent and cheap.** The facade skips a run this process
//    already holds a handle for, so the steady state costs one indexed query;
//    with no in-flight sandboxed run at all it costs that query and nothing
//    else. The ordinary hub — no sandbox — never gets past the verdict gate.
//  - **it does not thrash.** A port that cannot be rebound (something else took
//    it, the address is gone) writes a `warn` event per attempt, and a run in
//    that state stays in that state: an attempt per 30 seconds for ever would
//    be a run's history filled with one sentence. So a walk that restored
//    nothing doubles its own wait (30 s → 15 min), a walk that restored
//    something resets it, and a CHANGED set of candidates always gets a walk —
//    a new run must never wait out somebody else's backoff.
const proxyRestore = { candidates: '', nextAt: 0, waitMs: 0 }
const PROXY_RESTORE_BASE_MS = 30_000            // one watcher pass
const PROXY_RESTORE_MAX_MS = 15 * 60_000

/** Test hook: forget the backoff, so a suite's next pass really walks. */
export function _resetProxyRestore() {
  proxyRestore.candidates = ''; proxyRestore.nextAt = 0; proxyRestore.waitMs = 0
}

export async function restoreSandboxProxies(verdict, nowMs = Date.now()) {
  if (verdict !== 'ok') return null
  // The same set `restoreProxies()` walks, asked here only to decide WHETHER to
  // walk it: a run whose session the hub has closed is not owed a listener.
  const ids = db.prepare(`SELECT id FROM runs WHERE sandbox=1 AND status IN ('running','waiting_help')
                          AND tmux_closed_at IS NULL ORDER BY id`).all().map(r => r.id)
  if (!ids.length) { _resetProxyRestore(); return null }
  const key = ids.join(',')
  const changed = key !== proxyRestore.candidates
  if (!changed && nowMs < proxyRestore.nextAt) return null
  proxyRestore.candidates = key
  // Lazily, like releaseReaped() below: the facade imports this module for
  // `reconcileContainers`, so a static edge back would be the cycle.
  const { restoreProxies } = await import('./sandbox/index.mjs')
  const out = await restoreProxies()
  proxyRestore.waitMs = (changed || out?.restored?.length)
    ? PROXY_RESTORE_BASE_MS
    : Math.min(PROXY_RESTORE_MAX_MS, (proxyRestore.waitMs || PROXY_RESTORE_BASE_MS) * 2)
  proxyRestore.nextAt = nowMs + proxyRestore.waitMs
  return out
}

/**
 * `resources.maxRuntimeMinutes` from the run's frozen spec is a HARD stop
 * (§8.16): the container goes, the session goes, and the run ends as `aborted`
 * with the limit named. Everything softer — the expected duration, the overrun
 * ladder — stays exactly as it is; this is the one that does not merely say
 * something.
 *
 * Measured from the run's start, like every other clock on this row.
 */
async function enforceMaxRuntime(nowMs = Date.now()) {
  const rows = db.prepare(`SELECT * FROM runs WHERE sandbox=1 AND sandbox_spec IS NOT NULL
                           AND status IN ('running','waiting_help')`).all()
  for (const run of rows) {
    const raw = specOf(run)?.resources?.maxRuntimeMinutes
    // '' is not 0: an empty field means "no limit", and Number('') would make it
    // a limit of zero minutes — every sandboxed run killed at its first pass.
    if (raw == null || String(raw).trim() === '') continue
    const minutes = Number(raw)
    if (!Number.isFinite(minutes) || minutes <= 0) continue
    const startedMs = parseDbUtc(run.started_at)
    if (!Number.isFinite(startedMs) || nowMs - startedMs < minutes * 60_000) continue
    addEvent(run.id, 'sandbox:max_runtime', { minutes, container: run.sandbox_container ?? null })
    try {
      await stopRunContainer(run)
      if (run.tmux_session) await sh('tmux', ['kill-session', '-t', `=${run.tmux_session}`])
    } catch (err) { console.error('[sandbox]', err.message) }
    // The hub ended this deliberately, so it is reconciled as an end and never
    // resumed — reconcileClosedSession() writes the abort and the assessment.
    reconcileClosedSession(run.id, 'max_runtime')
    await notifyRun(run.id, 'max_runtime',
      `🔴 Run stopped: the sandbox's maximum runtime of ${minutes} min was reached.`)
  }
}

/**
 * Close sessions of ARCHIVED runs. Archiving is the operator's "put this
 * finished work away", so the session it left standing goes with it — by
 * default right away (keep 0). The archive route closes a keep-0 session at
 * the click; this pass is the net under it and the only path for a configured
 * delay (keep > 0) — and it catches runs archived before the rule existed,
 * whose archived_at is already in the past. Switched off (archive_session_on
 * != 1) the pass does nothing: such a session follows the ordinary retention.
 */
async function closeArchivedSessions() {
  const rows = db.prepare(`SELECT * FROM runs WHERE archived_at IS NOT NULL
                           AND tmux_session IS NOT NULL AND tmux_closed_at IS NULL`).all()
  if (!rows.length) return
  const keepMs = archiveSessionKeepMs(allSettings())
  if (keepMs == null) return
  const snap = await tmuxSnapshot()
  if (!snap.ok) return                        // no answer, no decisions — see closeOldSessions
  const live = new Map(snap.sessions.map(s => [s.name, s]))
  const now = Date.now()
  for (const run of rows) {
    const session = live.get(run.tmux_session)
    if (!session) {                                                        // no longer exists
      if (!await confirmGone(run)) continue
      reconcileClosedSession(run.id, 'watcher')
      continue
    }
    if (!shouldCloseArchived(run, keepMs, now)) continue
    await sh('tmux', ['kill-session', '-t', `=${run.tmux_session}`])
    reconcileClosedSession(run.id, 'archive')
    addEvent(run.id, 'tmux_closed', { reason: 'archive' })
  }
}

async function cleanupWorktrees() {
  // Remove when the branch is pushed (no [ahead]) or the PR is merged (gh pr view only,
  // squash merges make git ancestor checks worthless — planning 7.7); otherwise keep.
  const rows = db.prepare(`
    SELECT * FROM runs
    WHERE worktree IS NOT NULL AND status IN ('done','failed','aborted') AND tmux_closed_at IS NOT NULL
  `).all()
  for (const run of rows) {
    if (!existsSync(run.worktree)) continue
    const repo = getRepo(run.repo_id)
    const branch = run.branch_reported || run.branch_expected
    // The hub merged this run itself — there is nothing left the branch could
    // still be needed for. The dirt guard below still applies.
    let removable = run.merge_status === 'merged'
    if (branch && !removable) {
      const { synced } = await branchSyncState(repo.path, branch)
      if (synced) removable = true      // upstream exists AND nothing outstanding
      if (!removable) {
        const pr = await ghPrState(repo.path, branch)
        if (pr === 'MERGED') removable = true
      }
    }
    // Last safeguard before 'worktree remove --force': uncommitted work in the worktree
    // beats any 'removable'. Otherwise the cleanup deletes real work.
    if (removable) {
      // Through the seam: on a sandboxed run this reads the working copy inside
      // the container while it stands, and on the host with a hardened git when
      // it does not (§7.4.4). The `-C` is the seam's, hence only the arguments.
      const dirty = await runGit(run, ['status', '--porcelain'], { cwd: run.worktree })
      // Uncommitted work beats any 'removable' — the worktree extras and the
      // harness hook files do not, because the hub put those there itself
      // (foreignChanges() in integrate.mjs, shared with the finish gate).
      const fremd = foreignChanges(dirty.stdout, ownWorktreePaths(repo, run.harness))
      if (!dirty.ok || fremd.length) {
        addEventOnce(run.id, 'anomaly:worktree_dirty', { worktree: run.worktree, offen: fremd.slice(0, 20) })
        removable = false
      }
    }
    if (removable) {
      // A sandboxed run's working copy is a private CLONE, not a linked
      // worktree: `git worktree remove` knows nothing about it and `worktree
      // prune` never sees it (§8.9). removeClone() deletes the directory and
      // the ref the collected tip was parked under; for a linked worktree it
      // does nothing and the old command below is what runs.
      if (isClone(run)) {
        await removeClone(run)
      } else {
        await sh('git', ['-C', repo.path, 'worktree', 'remove', '--force', run.worktree])
      }
      addEvent(run.id, 'worktree_removed')
      // A local branch whose work is on the base branch has nothing left to
      // hold. Remote branches stay in v1: visible history is cheaper than an
      // accidental deletion.
      if (branch && run.merge_status === 'merged') {
        await sh('git', ['-C', repo.path, 'branch', '-D', branch])
      }
    }
  }
}

async function ghPrState(repoPath, branch) {
  const r = await sh('gh', ['pr', 'view', branch, '--json', 'state', '-q', '.state'], { cwd: repoPath, timeout: 15_000 })
  return r.ok ? r.stdout.trim() : null
}
