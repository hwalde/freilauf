// cc-hub — watcher (planning 4.4, 4.5, 4.7): observes runs via tmux, the harnesses'
// transcript/DB and the inbox fallback; anomalies (traffic light), budget retry,
// cost estimation, auto-close of finished sessions (server/sessions.mjs), worktree cleanup.
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import db, { getRepo, addEvent } from './db.mjs'
import { RUNS_DIR, sh } from './util.mjs'
import { handleReport, addEventOnce, notifyRun, branchSyncState, finishByTurnEnd } from './reports.mjs'
import { transcriptState as cursorTranscriptState } from './cursor-transcript.mjs'
import { harnessOwnedPaths } from './runner.mjs'
import { claudeQuota } from './quota.mjs'
import { scanneNeueBytes, transkriptFehler, bewerteLogTreffer, terminalText } from './detect.mjs'
import { vorfallMelden, vorfallEskalieren, vorfallVerwerfen, offeneVorfaelle, detektorLog, msVon, brauchtMensch } from './incidents.mjs'
import { pruefeTreffer, pruefLlmAktiv } from './pruefer.mjs'
import { HARNESS_PLUGINS, getHarness } from './harnesses/index.mjs'
import { PROVIDER_PLUGINS } from './providers/index.mjs'
import { flowsTick } from './flows/triggers.mjs'
import { reconcileClosedSession, tmuxSessionMap, shouldAutoClose, currentKeepMs } from './sessions.mjs'

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
 * that was created just now and whose cc-start is still working. At hub start-up
 * the grace period is 0: whatever is there must come from an earlier process.
 */
export function verwaisteLaeufeAbschliessen(gnadenfristSek = 300) {
  const rows = db.prepare(`
    SELECT id, started_at FROM runs
    WHERE status IN ('running','waiting_help') AND tmux_session IS NULL
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
  const active = db.prepare(`SELECT * FROM runs WHERE status IN ('running','waiting_help')`).all()
  for (const run of active) {
    try { await watchRun(run) } catch (e) { console.error(`[watcher] ${run.id}:`, e.message) }
  }
  await vorfaelleBewerten()
  await providerPuls()
  await finishCostsPass()
  await checkFinishedBranches()
  await retryDeferred()
  await startScheduled()
  await closeOldSessions()
  await cleanupWorktrees()
  // No-code flows: run_finished backstop, delays, cron (server/flows/triggers.mjs).
  try { await flowsTick() } catch (e) { console.error('[flows]', e.message) }
}

// ---------- inbox fallback (cc-report could not reach the hub) ----------
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
    for (const line of lines) {
      try { await handleReport(id, JSON.parse(line)) } catch (e) { console.error('[inbox]', e.message) }
    }
    // clear what has been processed
    writeFileSync(f, '')
  }
}

/**
 * Is the session still alive? Only has-session answers that honestly.
 * 'tmux display -p -t "=name"' returns exit 0 with empty output for a session that
 * does NOT exist — checks built on that therefore never trigger.
 */
async function sessionLebt(session) {
  const r = await sh('tmux', ['has-session', '-t', `=${session}`])
  return r.ok
}

// ---------- single run ----------
async function watchRun(run) {
  let st = { pane_dead: '?', dead_status: '', dead_time: '', pid: '', cmd: '' }
  if (run.tmux_session) {
    if (!await sessionLebt(run.tmux_session)) {
      // Session gone entirely (reboot, manual cc-kill, the sessions page). Mark
      // it closed right away, otherwise the worktree cleanup waits forever for
      // tmux_closed_at — AND end the run: nothing can report for it any more, so
      // leaving it on 'running' means the overview shows a run that does not
      // exist, forever. reconcileClosedSession() does both, and is the same
      // function the sessions page uses.
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
    handleReport(run.id, { kind: '_pane_died', exit: st.dead_status }).catch(() => {})
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
  const lastAct = run.last_activity_at ? Date.parse(run.last_activity_at.replace(' ', 'T') + 'Z') : startedMs

  if (run.status === 'running' || run.status === 'waiting_help') {
    // yellow: no activity for 15 min
    if (now - lastAct > 15 * 60_000 && st.pane_dead !== '1') {
      addEventOnce(run.id, 'anomaly:no_activity')
    }
    // yellow: 80 % of the expected duration reached, no report
    if (now - startedMs > 0.8 * expectedMs && !run.report_md) {
      addEventOnce(run.id, 'anomaly:soft_overrun')
    }
    // red: expected duration exceeded without report/progress
    if (now - startedMs > expectedMs && !run.report_md) {
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
    // red: quota.json ≥ 100 %
    const q = claudeQuota()
    if ((q.five ?? 0) >= 100 || (q.seven ?? 0) >= 100) addEventOnce(run.id, 'anomaly:quota_full')
  }

}

/** Path of the Claude transcript: known in advance thanks to --session-id (planning 7.1). */
export function claudeTranskriptPfad(run) {
  const dirName = run.workdir_effective.replaceAll('/', '-')
  return `${process.env.CCHUB_CLAUDE_PROJECTS ?? `${homedir()}/.claude/projects`}/${dirName}/${run.id}.jsonl`
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
 * Assess yellow log incidents by time and count: retry loop or silence after the
 * hit → red (+ Telegram). If, on the other hand, the agent keeps working for half
 * an hour without it recurring, it was nothing → closed automatically.
 */
async function vorfaelleBewerten() {
  const rows = db.prepare(`SELECT i.*, r.last_activity_at, r.status FROM incidents i
    JOIN runs r ON r.id = i.run_id
    WHERE i.geloest_am IS NULL AND i.schwere = 'gelb' AND i.quelle LIKE 'log%'`).all()
  const jetzt = Date.now()
  for (const v of rows) {
    const letzteAkt = v.last_activity_at ? msVon(v.last_activity_at) : null
    const zuletzt = msVon(v.zuletzt_gesehen)
    const stufe = bewerteLogTreffer({ anzahl: v.anzahl, erstGesehenMs: msVon(v.erst_gesehen),
      zuletztGesehenMs: zuletzt, letzteAktivitaetMs: letzteAkt, jetztMs: jetzt })
    if (stufe === 'rot') {
      const grund = v.anzahl >= 2 ? `${v.anzahl}× within a short time` : 'no activity since the hit'
      await vorfallEskalieren(v.id, grund)
    } else if (letzteAkt != null && letzteAkt > zuletzt && jetzt - zuletzt > 30 * 60_000) {
      vorfallVerwerfen(v.id, 'expired: agent kept working')
    } else if (!['running', 'waiting_help'].includes(v.status) && jetzt - zuletzt > 30 * 60_000) {
      vorfallVerwerfen(v.id, 'expired: run ended')
    } else if (letzteAkt == null && jetzt - zuletzt > 30 * 60_000) {
      // cursor/hermes: no activity source, so neither "kept working" nor
      // "silent" can be proven. What did not recur within half an hour was
      // noise — that is the only statement available here, and it is enough.
      vorfallVerwerfen(v.id, 'expired: no recurrence')
    }
  }
  vorfaelleNachErfolgSchliessen()
}

/**
 * A run that came through ('done') has already answered what a rate limit or a
 * provider hiccup during it meant: nothing. Those incidents close with the run.
 * Asking a human to click away a question that answered itself is what made
 * "resolve" feel like busywork.
 *
 * What needs a human stays open (brauchtMensch): a login, a credit balance or a
 * wrong model ID does not get better on its own — the next run walks into it
 * again.
 */
function vorfaelleNachErfolgSchliessen() {
  const rows = db.prepare(`SELECT i.*, r.status FROM incidents i JOIN runs r ON r.id = i.run_id
    WHERE i.geloest_am IS NULL AND r.status = 'done'`).all()
  for (const v of rows) {
    if (!brauchtMensch(v, v.status)) vorfallVerwerfen(v.id, 'run finished successfully')
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
  if (process.env.CCHUB_PULS_AUS === '1') return
  const takt = Number(process.env.CCHUB_PULS_TAKT_MS ?? 5 * 60_000)
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
      for (const v of offeneVorfaelle(null)) if (v.typ === typ) vorfallVerwerfen(v.id, 'erholt')
    }
  }
}
async function pulsPruefen(name) {
  const ziel = process.env.CCHUB_PULS_URL_TEST ? { url: process.env.CCHUB_PULS_URL_TEST, okStatus: [200] } : PULS[name]
  if (!ziel) return true
  try {
    const res = await fetch(ziel.url, { method: 'GET', signal: AbortSignal.timeout(10_000) })
    return ziel.okStatus.includes(res.status)
  } catch { return false }
}

/** Evaluate the Claude transcript (path known in advance thanks to --session-id, planning 7.1). */
async function measureActivity(run) {
  const out = { lastActivity: null, tokensIn: 0, tokensOut: 0, costUsd: null }
  if (run.harness === 'claude' && run.workdir_effective) {
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
  // opencode: session store SQLite (matched via directory + time, planning 7.1)
  if (run.harness === 'opencode' && run.workdir_effective) {
    try {
      const { DatabaseSync } = await import('node:sqlite')
      const d = new DatabaseSync(`${homedir()}/.local/share/opencode/opencode.db`, { readOnly: true })
      const row = d.prepare(`SELECT cost, tokens_input, tokens_output, time_updated FROM session
                             WHERE directory = ? AND time_created >= ? ORDER BY time_created DESC LIMIT 1`)
        .get(run.workdir_effective, Date.parse(run.started_at.replace(' ', 'T') + 'Z') - 5000)
      if (row) {
        out.tokensIn = row.tokens_input ?? 0
        out.tokensOut = row.tokens_output ?? 0
        out.costUsd = row.cost ?? null
        if (row.time_updated) out.lastActivity = new Date(row.time_updated).toISOString().replace('T', ' ').slice(0, 19)
      }
      d.close()
    } catch {}
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

/** Costs at run end: Claude = delta of the 7-day quota in percentage points → €. */
function finishCosts(run) {
  const q = claudeQuota()
  const aboPreis = Number(db.prepare(`SELECT value FROM settings WHERE key='abo_price'`).get()?.value ?? 200) || 200
  let costEur = null
  if (run.harness === 'claude' && run.quota7_start != null && q.seven != null) {
    const delta = Math.max(0, q.seven - run.quota7_start)
    costEur = Math.round((delta / 100 / 4.348 * aboPreis) * 100) / 100
  }
  db.prepare(`UPDATE runs SET quota5_end=?, quota7_end=?, cost_eur=?, ended_at=COALESCE(ended_at, datetime('now')) WHERE id=?`)
    .run(q.five, q.seven, costEur, run.id)
}

// ---------- retry deferred runs ----------
async function retryDeferred() {
  const deferred = db.prepare(`SELECT * FROM runs WHERE status='deferred'`).all()
  if (!deferred.length) return
  // Same gate as at the start (scheduler.mjs) — dynamic import, because the
  // scheduler pulls in the runner and the watcher is loaded by hub.mjs first.
  const { budgetGate } = await import('./scheduler.mjs')
  for (const run of deferred) {
    if (await budgetGate(run.harness)) continue
    db.prepare(`UPDATE runs SET status='running' WHERE id=?`).run(run.id)
    addEvent(run.id, 'deferred_retry')
    const { launchRun } = await import('./runner.mjs')
    launchRun(run.id).then(r => {
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
  const live = await tmuxSessionMap()
  const now = Date.now()
  for (const run of rows) {
    const session = live.get(run.tmux_session)
    if (!session) { reconcileClosedSession(run.id, 'watcher'); continue }   // no longer exists
    if (!shouldAutoClose(session, run, keepMs, now)) continue
    await sh('tmux', ['kill-session', '-t', `=${run.tmux_session}`])
    reconcileClosedSession(run.id, 'retention')
    addEvent(run.id, 'tmux_closed', { reason: 'retention' })
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
    let removable = false
    if (branch) {
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
      // The worktree extras come from us, not from the agent. A symlink 'referenz',
      // for example, is not covered by the ignore rule 'referenz/' (with a slash)
      // and would otherwise sit there as '?? referenz' forever — the worktree would
      // never get cleaned up.
      // …and so are the harness hook files the hub itself wrote in before the
      // start (cursor: '.cursor/hooks.json'). Left in the list they would make
      // every cursor worktree "dirty" forever and none would ever be removed.
      const eigene = [...(repo.extras ?? []).map(x => String(x.path)), ...harnessOwnedPaths(run.harness)]
        .map(p => p.replace(/\/+$/, ''))
      // git names the directory ('?? .cursor/') when everything below it is
      // untracked, and the single file ('?? .cursor/hooks.json') when it is not
      // — so the comparison has to cover both.
      const fremd = dirty.stdout.split('\n').filter(Boolean)
        .map(z => z.slice(3).trim().replace(/\/+$/, ''))
        .filter(p => !eigene.some(e => p === e || p.startsWith(`${e}/`)))
      if (!dirty.ok || fremd.length) {
        addEventOnce(run.id, 'anomaly:worktree_dirty', { worktree: run.worktree, offen: fremd.slice(0, 20) })
        removable = false
      }
    }
    if (removable) {
      await sh('git', ['-C', repo.path, 'worktree', 'remove', '--force', run.worktree])
      addEvent(run.id, 'worktree_removed')
    }
  }
}

async function ghPrState(repoPath, branch) {
  const r = await sh('gh', ['pr', 'view', branch, '--json', 'state', '-q', '.state'], { cwd: repoPath, timeout: 15_000 })
  return r.ok ? r.stdout.trim() : null
}
