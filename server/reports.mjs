// cc-hub — processing of agent reports (cc-report → POST /api/runs/<id>/report
// or fallback inbox.jsonl collected by the watcher). Planning 6 + 11.
import db, { addEvent } from './db.mjs'
import { notify, notifyLong, detailUrl } from './telegram.mjs'
import { sh } from './util.mjs'
import { vorfallMelden } from './incidents.mjs'
import { typVonClaudeFehler, typVonText, TYP_TEXT } from './detect.mjs'
import { getHarness } from './harnesses/index.mjs'
import { transcriptState } from './cursor-transcript.mjs'

const MAX_REPORT = 200 * 1024   // planning 11: report ≤ 200 kB

/**
 * Process one report event. Returns `{ ok, message? }`.
 *
 * `via` says how the report reached the hub, and the finish gate needs it: with
 * 'http' the agent is standing in its own `cc-report` call and the answer travels
 * back as that tool's output — the cheapest moment there is. Every other channel
 * has no call to answer, so the same text is typed into the tmux session
 * instead (see server/integrate.mjs).
 */
export async function handleReport(runId, body, via = 'http') {
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId)
  // Planning 11: only accept existing runs in running/waiting_help.
  if (!run || !['running', 'waiting_help'].includes(run.status)) return { ok: false, error: 'unknown or already finished run' }
  const kind = String(body.kind || '')
  let text = typeof body.text === 'string' ? body.text : ''
  if (typeof body.file === 'string') {
    if (body.file.length > MAX_REPORT) return { ok: false, error: 'payload too large' }
    text = text ? `${text}\n\n${body.file}` : body.file
  }

  switch (kind) {
    case 'done': {
      // The finish gate: with repos.merge_mode='hub' a `done` report is CHECKED
      // rather than believed — is the worktree clean, does the branch still
      // merge? null means this repo does not want the hub to integrate, and
      // then everything below is byte for byte what it always was.
      const gate = await finishGate(runId, text, via)
      if (gate?.hold) return { ok: true, message: gate.message ?? null }
      db.prepare(`UPDATE runs SET status='done', ended_at=datetime('now'), report_md=? WHERE id=?`).run(text || null, runId)
      addEvent(runId, 'done')
      await notifyRun(runId, 'done', doneText(run, text, gate?.mergeLine ?? null), { fileName: `report-${runId.slice(0, 8)}.md`, fileContent: text })
      break
    }
    case 'failed': {
      db.prepare(`UPDATE runs SET status='failed', ended_at=datetime('now'), report_md=? WHERE id=?`)
        .run(`**Failed:** ${text}`, runId)
      addEvent(runId, 'failed')
      // Never merged automatically — but named: what a failed run left behind is
      // a fact the operator should not have to go looking for.
      const assessment = await assessAfterEnd(runId)
      await notifyRun(runId, 'failed', `❌ Run failed${laufKopf(run)}\n${text}${assessment}`, { fileName: `failed-${runId.slice(0, 8)}.md`, fileContent: text })
      break
    }
    case 'help': {
      db.prepare(`UPDATE runs SET status='waiting_help', help_text=? WHERE id=?`).run(text, runId)
      addEvent(runId, 'help')
      // The question MUST arrive completely — truncated it cannot be answered.
      await notifyRun(runId, 'help', `🆘 Help call${laufKopf(run)}\n${text}`, { fileName: `help-${runId.slice(0, 8)}.md`, fileContent: text, dedupe: false })
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
      // For most harnesses the end of a turn is just a note. For cursor it is
      // the end of the RUN (harnesses/cursor.mjs: turnEndsRun) — its TUI stays
      // standing afterwards, so nothing else will ever say the work is over.
      await finishByTurnEnd(runId, 'stop hook')
      break
    case '_exit': {
      addEvent(runId, 'exit')
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
 * `cc-report done` there waits forever, and everything the repo has queued
 * behind that run waits with it.
 *
 * Only from status 'running': `waiting_help` means the agent asked a question
 * and is deliberately idle until a human answers — ending its turn is the
 * correct behaviour there, not the end of the work. And a run that reported
 * properly is already 'done' by the time the hook fires (cc-report is a tool
 * call INSIDE the turn, the hook comes after it), so this only ever catches the
 * case it is meant for.
 *
 * The report text comes from the harness's transcript: the agent's own closing
 * words are what a human would have gotten had it called cc-report. Everything
 * else — Telegram, events, flows, cost accounting — happens because this goes
 * back through the normal 'done' path instead of writing the row itself.
 *
 * Returns true when the run was closed here.
 */
export async function finishByTurnEnd(runId, source) {
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId)
  if (!run || run.status !== 'running') return false
  if (!getHarness(run.harness)?.turnEndsRun) return false
  const state = run.harness === 'cursor' ? transcriptState(run) : null
  const note = `_(cc-hub closed this run: the agent ended its turn without calling \`cc-report done\` `
    + `— noticed via ${source}. The text above is the agent's own closing message`
    + `${state?.lastAnswer ? '' : ', which the transcript did not yield'}.)_`
  const text = [state?.lastAnswer, note].filter(Boolean).join('\n\n')
  addEvent(runId, 'turn_end_finished', { source, transcript: !!state?.lastAnswer })
  // 'internal': there is no cc-report call to answer here, so the finish gate
  // types its answer into the session instead (server/integrate.mjs).
  await handleReport(runId, { kind: 'done', text }, 'internal')
  return true
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
 * Telegram message. Empty where the repo does not want the hub to integrate.
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
 * recurrence. The 'telegram_sent:*' flags stay on purpose: the same type must
 * not produce a second message either (planning 4.5).
 */
function clearAnomalies(runId, kinds) {
  const stmt = db.prepare(`UPDATE events SET kind = 'cleared:' || kind WHERE run_id = ? AND kind = ?`)
  for (const kind of kinds) stmt.run(runId, kind)
}

/** Header line with agent/repo/harness — so the message is attributable without a click. */
function laufKopf(run) {
  const a = run.agent_id ? db.prepare('SELECT name FROM agents WHERE id=?').get(run.agent_id)?.name : null
  const p = db.prepare('SELECT name FROM repos WHERE id=?').get(run.repo_id)?.name
  return ` — ${a ?? 'single run'} @ ${p ?? '?'} (${run.harness}${run.model ? '/' + run.model : ''})`
}

/**
 * The "done" message. `mergeLine` is what the integration has to say about this
 * run — `Merged into main: abc1234`, or `Nothing to merge (no commits)`. It sits
 * on the second line next to duration and branch, because "where is the work
 * now" is the first thing one wants from a finished run.
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
  // Full report; over 4096 chars notify() truncates and notifyLong() attaches the file.
  return `✅ Done${laufKopf(run)}\n${zeile2}${vf}\n\n${report || '(no report text)'}`
}

/**
 * Telegram with dedupe per (run, type) — planning 4.5: only one message per anomaly type.
 */
export async function notifyRun(runId, type, text, lang = null) {
  const flag = `telegram_sent:${type}`
  const have = db.prepare('SELECT 1 FROM events WHERE run_id = ? AND kind = ? LIMIT 1').get(runId, flag)
  // Help calls are never duplicates: every question needs an answer.
  if (have && lang?.dedupe !== false) return false
  const voll = `${text}\n\nRun: ${runId}`
  const ok = lang
    ? await notifyLong(voll, { fileName: lang.fileName, fileContent: lang.fileContent, url: detailUrl(runId) })
    : await notify(voll, detailUrl(runId))
  addEvent(runId, flag, { delivered: ok })
  addEvent(runId, 'telegram_sent', { type })
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
