// Freilauf — watcher (planning 4.4, 4.5, 4.7): observes runs via tmux, the harnesses'
// transcript/DB and the inbox fallback; anomalies (traffic light), budget retry,
// cost estimation, auto-close of finished sessions (server/sessions.mjs), worktree cleanup.
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import db, { getRepo, addEvent, announceRun, allSettings } from './db.mjs'
import { RUNS_DIR, sh, parseDbUtc, kurzid } from './util.mjs'
import { notify, notifyOnFor } from './notify.mjs'
import { handleReport, addEventOnce, notifyRun, branchSyncState, finishByTurnEnd, followUpHeader, clearAnomalies } from './reports.mjs'
import { transcriptState as cursorTranscriptState } from './cursor-transcript.mjs'
import { storeActivity } from './opencode-store.mjs'
import { deliverPendingGoals } from './goal.mjs'
import { claudeQuota, sevenForRun, quotaFullWindow } from './quota.mjs'
import { refreshClaudeLimits } from './claude-usage.mjs'
import { scanneNeueBytes, transkriptFehler, bewerteLogTreffer, terminalText, vorfallWeggrund } from './detect.mjs'
import { vorfallMelden, vorfallEskalieren, vorfallVerwerfen, vorfaelleMeldenFaellig, offeneVorfaelle, vorfallLoesen, detektorLog, msVon } from './incidents.mjs'
import { pruefeTreffer, pruefLlmAktiv } from './pruefer.mjs'
import { HARNESS_PLUGINS, getHarness } from './harnesses/index.mjs'
import { PROVIDER_PLUGINS } from './providers/index.mjs'
import { flowsTick } from './flows/triggers.mjs'
import { reconcileClosedSession, tmuxSnapshot, sessionGone, shouldAutoClose, currentKeepMs, shouldCloseArchived, archiveSessionKeepMs } from './sessions.mjs'
import { integrateTick, pushOperatorBase, integratorTimerOff, foreignChanges, ownWorktreePaths } from './integrate.mjs'
import { maybeAutoCleanup } from './cleanup.mjs'
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
    if (!inFinishGate && act.measured && idle && st.pane_dead !== '1') {
      addEventOnce(run.id, 'anomaly:no_activity')
    }
    // …and the statement is RETRACTED when the agent is demonstrably back.
    // 'no_activity' used to be cleared by a progress report alone, so a run that
    // had been quiet once carried "no activity" in the overview for the rest of
    // its life — which reads as "this agent is not running" long after it is.
    // Same mechanism as a raised expected duration retracting its overrun.
    if (act.measured && !idle) retractNoActivity(run.id)
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

/** Path of the Claude transcript: known in advance thanks to --session-id (planning 7.1). */
export function claudeTranskriptPfad(run) {
  const dirName = run.workdir_effective.replaceAll('/', '-')
  return `${env('CLAUDE_PROJECTS') ?? `${homedir()}/.claude/projects`}/${dirName}/${run.id}.jsonl`
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
  const { treffer, neuerOffset } = scanneNeueBytes(run.harness, chunk.text, chunk.von ?? run.log_offset ?? 0)
  db.prepare('UPDATE runs SET log_offset = ? WHERE id = ?').run(neuerOffset, run.id)
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
      const d = new DatabaseSync(`${homedir()}/.hermes/state.db`, { readOnly: true })
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
      const dirty = await sh('git', ['-C', run.worktree, 'status', '--porcelain'])
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
      await sh('git', ['-C', repo.path, 'worktree', 'remove', '--force', run.worktree])
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
