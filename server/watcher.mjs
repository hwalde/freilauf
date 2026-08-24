// cc-hub — Watcher (Planung 4.4, 4.5, 4.7): Beobachtung der Läufe über tmux,
// Transkript/DB der Harnesses und inbox-Fallback; Auffälligkeiten (Ampel), Budget-Retry,
// Kosten-Schätzung, Auto-Schließen nach 3 Tagen, Worktree-Aufräumen.
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import db, { getRepo, addEvent } from './db.mjs'
import { RUNS_DIR, sh } from './util.mjs'
import { handleReport, addEventOnce, notifyRun, branchSyncState } from './reports.mjs'
import { claudeGateBlocked, openrouterGateBlocked, claudeQuota } from './quota.mjs'
import { scanneNeueBytes, transkriptFehler, bewerteLogTreffer, terminalText } from './detect.mjs'
import { vorfallMelden, vorfallEskalieren, vorfallVerwerfen, offeneVorfaelle, detektorLog, msVon } from './incidents.mjs'
import { pruefeTreffer, pruefLlmAktiv } from './pruefer.mjs'

let timer = null

export function startWatcher() {
  if (timer) return
  timer = setInterval(() => tick().catch(e => console.error('[watcher]', e.message)), 30_000)
}
export function stopWatcher() { clearInterval(timer); timer = null }

/**
 * Läufe, die nie eine Session bekommen haben. Passiert, wenn der Hub mitten im
 * Startvorgang beendet wird (Neustart des Dienstes, Reboot, Absturz): der Datensatz
 * steht dann auf 'running', hat aber weder Session noch Worktree — die Übersicht
 * zeigt einen Lauf, den es nicht gibt, und das Terminal kann sich nirgends anhängen.
 *
 * 'gnadenfristSek' schützt davor, einen Lauf abzuräumen, der gerade eben erst
 * angelegt wurde und dessen cc-start noch arbeitet. Beim Start des Hubs ist die
 * Frist 0: was dort steht, stammt zwangsläufig aus einem früheren Prozess.
 */
export function verwaisteLaeufeAbschliessen(gnadenfristSek = 300) {
  const rows = db.prepare(`
    SELECT id, started_at FROM runs
    WHERE status IN ('running','waiting_help') AND tmux_session IS NULL
      AND started_at <= datetime('now', ?)
  `).all(`-${Math.max(0, gnadenfristSek)} seconds`)
  for (const run of rows) {
    db.prepare(`UPDATE runs SET status='failed', ended_at=datetime('now'), report_md=? WHERE id=?`)
      .run('Start wurde unterbrochen: der Hub war beendet, bevor eine tmux-Session stand '
        + '(Dienst-Neustart, Reboot oder Absturz). Es wurde nichts gestartet — '
        + '„Lauf wiederholen" setzt neu auf.', run.id)
    addEvent(run.id, 'failed', { grund: 'Start unterbrochen, keine Session' })
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
  await closeOldSessions()
  await cleanupWorktrees()
}

// ---------- inbox-Fallback (cc-report konnte den Hub nicht erreichen) ----------
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
    // verarbeitet löschen
    writeFileSync(f, '')
  }
}

/**
 * Lebt die Session noch? Nur has-session beantwortet das ehrlich.
 * 'tmux display -p -t "=name"' liefert für eine NICHT existierende Session Exit 0 mit
 * leerer Ausgabe — darauf gebaute Prüfungen greifen deshalb nie.
 */
async function sessionLebt(session) {
  const r = await sh('tmux', ['has-session', '-t', `=${session}`])
  return r.ok
}

// ---------- einzelner Lauf ----------
async function watchRun(run) {
  let st = { pane_dead: '?', dead_status: '', dead_time: '', pid: '', cmd: '' }
  if (run.tmux_session) {
    if (!await sessionLebt(run.tmux_session)) {
      // Session ganz weg (Reboot, manuelles cc-kill). Gleich als geschlossen vermerken,
      // sonst wartet das Worktree-Aufräumen ewig auf tmux_closed_at.
      addEventOnce(run.id, 'anomaly:session_gone')
      db.prepare(`UPDATE runs SET tmux_closed_at=COALESCE(tmux_closed_at, datetime('now')) WHERE id=?`).run(run.id)
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

  // Aktivität + Tokens je Harness
  const act = await measureActivity(run)
  if (act.lastActivity) {
    db.prepare('UPDATE runs SET last_activity_at=?, tokens_in=?, tokens_out=?, cost_usd=COALESCE(?, cost_usd) WHERE id=?')
      .run(act.lastActivity, act.tokensIn, act.tokensOut, act.costUsd ?? null, run.id)
  }

  // ---- Ampel-Logik (Planung 4.5) ----
  const now = Date.now()
  const startedMs = Date.parse(run.started_at.replace(' ', 'T') + 'Z')
  const expectedMs = run.expected_minutes * 60_000
  const lastAct = run.last_activity_at ? Date.parse(run.last_activity_at.replace(' ', 'T') + 'Z') : startedMs

  if (run.status === 'running' || run.status === 'waiting_help') {
    // gelb: keine Aktivität seit 15 min
    if (now - lastAct > 15 * 60_000 && st.pane_dead !== '1') {
      addEventOnce(run.id, 'anomaly:no_activity')
    }
    // gelb: 80 % der Erwartung erreicht, kein Report
    if (now - startedMs > 0.8 * expectedMs && !run.report_md) {
      addEventOnce(run.id, 'anomaly:soft_overrun')
    }
    // rot: Erwartung überschritten ohne Report/Fortschritt
    if (now - startedMs > expectedMs && !run.report_md) {
      const hadProgress = db.prepare(`SELECT 1 FROM events WHERE run_id=? AND kind='progress'`).get(run.id)
      if (!hadProgress) {
        addEventOnce(run.id, 'anomaly:overrun')
        await notifyRun(run.id, 'overrun',
          `🔴 Lauf überschreitet die erwartete Dauer (${run.expected_minutes} min) ohne Report.`)
      }
    }
    // Rate-Limit / Provider-Fehler: Hooks melden sich selbst (reports.mjs); hier die
    // beiden Quellen, die der Hub von außen liest — Transkript und pipe-pane-Log.
    await transkriptScannen(run)
    await logScannen(run)
    // rot: quota.json ≥ 100 %
    const q = claudeQuota()
    if ((q.five ?? 0) >= 100 || (q.seven ?? 0) >= 100) addEventOnce(run.id, 'anomaly:quota_full')
  }

}

/** Pfad des Claude-Transkripts: steht dank --session-id vorab fest (Planung 7.1). */
export function claudeTranskriptPfad(run) {
  const dirName = run.workdir_effective.replaceAll('/', '-')
  return `${process.env.CCHUB_CLAUDE_PROJECTS ?? `${homedir()}/.claude/projects`}/${dirName}/${run.id}.jsonl`
}

/** Datei ab Offset lesen; liefert { text, size }. Bei zu großem Rückstand nur den Schluss. */
function neueBytes(pfad, offset, maxBytes = 2_000_000) {
  const size = statSync(pfad).size
  // Datei kürzer als der Offset: neu angelegt oder gekappt (Lauf wiederholt) — von vorn.
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
 * Claude-Transkript: API-Fehler stehen dort als eigene Zeilen mit isApiErrorMessage
 * und Claudes eigenem Fehler-Enum — so eindeutig wie der Hook, nur ohne Hook. Fängt
 * den Fall, dass der StopFailure-Hook nicht lief, und liefert jedes Vorkommen mit
 * Zeitstempel (Retry-Schleifen werden als anzahl sichtbar).
 */
async function transkriptScannen(run) {
  if (run.harness !== 'claude' || !run.workdir_effective) return
  const f = claudeTranskriptPfad(run)
  if (!existsSync(f)) return
  let chunk
  try { chunk = neueBytes(f, run.transcript_offset ?? 0) } catch { return }
  if (!chunk.text) return
  // Nur vollständige Zeilen werten; der Rest kommt beim nächsten Durchgang.
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
 * pipe-pane-Log (alle Harnesses, für hermes die EINZIGE Quelle): nur die neuen Bytes,
 * Muster je Harness, Treffer zunächst GELB. Rot wird daraus durch Wiederholung oder
 * Stille (vorfaelleBewerten) — oder sofort, wenn das Prüf-LLM es bestätigt.
 */
async function logScannen(run) {
  const logf = join(RUNS_DIR, run.id, 'log.txt')
  if (!existsSync(logf)) return
  let chunk
  try { chunk = neueBytes(logf, run.log_offset ?? 0) } catch { return }
  if (chunk.uebersprungen) detektorLog(run.id, { art: 'log', hinweis: 'Rückstand übersprungen', bytes: chunk.uebersprungen })
  if (!chunk.text) return
  const { treffer, neuerOffset } = scanneNeueBytes(run.harness, chunk.text, chunk.von ?? run.log_offset ?? 0)
  db.prepare('UPDATE runs SET log_offset = ? WHERE id = ?').run(neuerOffset, run.id)
  if (!treffer.length) return
  detektorLog(run.id, { art: 'log', treffer: treffer.map(t => ({ typ: t.typ, zeile: t.zeile })) })

  // Je Typ ein Vorkommen; die Anzahl der Zeilen steckt im Beleg. Sonst macht eine
  // Retry-Schleife mit 20 Zeilen in einem Durchgang sofort rot — das soll die
  // Bewertung nach Zeit entscheiden, nicht die Zeilenzahl eines Neuzeichnens.
  const jeTyp = new Map()
  for (const t of treffer) if (!jeTyp.has(t.typ)) jeTyp.set(t.typ, t)

  let urteil = null
  if (pruefLlmAktiv()) {
    const zeilen = terminalText(chunk.text).split('\n').filter(z => z.trim()).slice(-80)
    urteil = await pruefeTreffer({ runId: run.id, harness: run.harness, treffer: [...jeTyp.values()], zeilen })
    detektorLog(run.id, { art: 'llm', urteil })
  }

  if (urteil && urteil.problem === false) return   // Prüf-LLM: harmlos (Menü, eigener Code …)
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
 * Gelbe Log-Vorfälle nach Zeit und Anzahl bewerten: Retry-Schleife oder Stille nach
 * dem Treffer → rot (+ Telegram). Arbeitet der Agent dagegen eine halbe Stunde
 * weiter, ohne dass es wieder auftritt, war es nichts → automatisch geschlossen.
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
      const grund = v.anzahl >= 2 ? `${v.anzahl}× in kurzer Zeit` : 'seit dem Treffer keine Aktivität mehr'
      await vorfallEskalieren(v.id, grund)
    } else if (letzteAkt != null && letzteAkt > zuletzt && jetzt - zuletzt > 30 * 60_000) {
      vorfallVerwerfen(v.id, 'verlaufen: Agent arbeitete weiter')
    } else if (!['running', 'waiting_help'].includes(v.status) && jetzt - zuletzt > 30 * 60_000) {
      vorfallVerwerfen(v.id, 'verlaufen: Lauf beendet')
    }
  }
}

/**
 * Provider-Puls: unabhängig vom Agenten alle 5 min prüfen, ob die Provider der
 * laufenden Agenten überhaupt antworten. Ein Ausfall wird so auch sichtbar, wenn
 * gerade kein Agent dagegen läuft. Zwei Fehlschläge in Folge = Vorfall (global),
 * Erholung schließt ihn automatisch — der nächste Ausfall öffnet ihn wieder.
 */
const PULS = {
  anthropic:  { url: 'https://api.anthropic.com/v1/models', okStatus: [200, 401, 403] },
  openrouter: { url: 'https://openrouter.ai/api/v1/models', okStatus: [200] },
  deepseek:   { url: 'https://api.deepseek.com/models', okStatus: [200, 401] },
}
const pulsZustand = { zuletztMs: 0, fehlschlaege: {} }
export function providerVonLauf(run) {
  if (run.harness === 'claude') return 'anthropic'
  // cursor läuft über api2.cursor.sh — dafür gibt es keinen offenen Endpunkt, den man
  // ohne Anmeldung anpingen könnte. Lieber kein Puls als ein erfundener: null heißt
  // hier ausdrücklich „nicht überwacht", nicht „gesund".
  if (run.harness === 'cursor') return null
  return run.provider && PULS[run.provider] ? run.provider : null
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
      await vorfallMelden(null, { typ, quelle: 'puls', schwere: 'rot', beleg: `${name}: ${f[name]} Prüfungen in Folge ohne Antwort` })
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

/** Claude-Transkript auswerten (Pfad steht dank --session-id vorab fest, Planung 7.1). */
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
  // opencode: session-Store SQLite (Zuordnung über directory + Zeit, Planung 7.1)
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
  // hermes: state.db sessions (Zuordnung über cwd + Zeit)
  if (run.harness === 'hermes' && run.workdir_effective) {
    try {
      const { DatabaseSync } = await import('node:sqlite')
      const d = new DatabaseSync(`${homedir()}/.hermes/state.db`, { readOnly: true })
      const rows = d.prepare(`SELECT estimated_cost_usd, input_tokens, output_tokens FROM sessions
                              WHERE cwd = ? ORDER BY started_at DESC LIMIT 1`).all()
      // Spaltennamen können je Version abweichen — defensiv per PRAGMA auflösen.
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

/** Kosten beim Lauf-Ende: Claude = Delta des 7-Tage-Kontingents in Prozentpunkten → €. */
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

// ---------- verschobene Läufe erneut versuchen ----------
async function retryDeferred() {
  const deferred = db.prepare(`SELECT * FROM runs WHERE status='deferred'`).all()
  for (const run of deferred) {
    const gate = run.harness === 'claude'
      ? claudeGateBlocked()
      : await openrouterGateBlocked(Number(db.prepare(`SELECT value FROM settings WHERE key='openrouter_min_eur'`).get()?.value ?? 5) || 5)
    if (gate.blocked) continue
    db.prepare(`UPDATE runs SET status='running' WHERE id=?`).run(run.id)
    addEvent(run.id, 'deferred_retry')
    const { launchRun } = await import('./runner.mjs')
    launchRun(run.id).then(r => {
      if (!r.ok) notifyRun(run.id, 'start_failed', `Start nach Verschiebung fehlgeschlagen: ${r.error}`)
    }).catch(() => {})
  }
}

/**
 * Branch-Abgleich NACH dem Ende (gelb: ungepusht; Planung 4.5/7.7).
 * Bewusst ein eigener Durchgang: watchRun() bekommt nur laufende Läufe zu sehen,
 * dort wäre die Prüfung auf 'done'/'failed' nie wahr geworden.
 */
/**
 * Ende-Kosten einmalig festhalten (Delta des 7-Tage-Kontingents → €, Planung 4.4).
 * Auch das lief vorher in watchRun() und damit nie: dort kommen nur laufende Läufe an.
 */
async function finishCostsPass() {
  const rows = db.prepare(`SELECT * FROM runs
    WHERE status IN ('done','failed','aborted') AND quota7_end IS NULL`).all()
  for (const run of rows) {
    // Ein kurzer Lauf ist vorbei, bevor der Watcher ihn das erste Mal sieht — und
    // danach kommt er nie wieder vorbei (watchRun bekommt nur laufende Läufe).
    // Ohne diese letzte Messung stünden Tokens und Kosten für immer auf 0.
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
    const branch = run.branch_reported || run.branch_observed || run.branch_expected
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
      ? `🟡 Branch '${branch}' hat ungepushte Commits.`
      : `🟡 Branch '${branch}' ist nirgends gepusht (kein Upstream).`)
  }
}

// ---------- Aufräumen (Planung 4.7) ----------
async function closeOldSessions() {
  const retentionDays = Number(db.prepare(`SELECT value FROM settings WHERE key='retention_days'`).get()?.value ?? 3) || 3
  const rows = db.prepare(`SELECT * FROM runs WHERE tmux_session IS NOT NULL AND tmux_closed_at IS NULL`).all()
  for (const run of rows) {
    if (!await sessionLebt(run.tmux_session)) {   // existiert nicht mehr
      db.prepare(`UPDATE runs SET tmux_closed_at=datetime('now') WHERE id=?`).run(run.id)
      continue
    }
    const r = await sh('tmux', ['display', '-p', '-t', `=${run.tmux_session}`, '#{pane_dead} #{pane_dead_time}'])
    const [dead, deadTime] = r.stdout.trim().split(/\s+/)
    if (dead === '1' && deadTime && /^\d+$/.test(deadTime)) {
      const ageDays = (Date.now() / 1000 - Number(deadTime)) / 86400
      if (ageDays >= retentionDays) {
        await sh('tmux', ['kill-session', '-t', `=${run.tmux_session}`])
        db.prepare(`UPDATE runs SET tmux_closed_at=datetime('now') WHERE id=?`).run(run.id)
        addEvent(run.id, 'tmux_closed')
      }
    }
  }
}

async function cleanupWorktrees() {
  // Entfernen, wenn Branch gepusht (kein [ahead]) oder PR gemerged (nur gh pr view,
  // Squash-Merge macht git-Ancestor-Checks wertlos — Planung 7.7); sonst behalten.
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
      if (synced) removable = true      // Upstream vorhanden UND nichts ausstehend
      if (!removable) {
        const pr = await ghPrState(repo.path, branch)
        if (pr === 'MERGED') removable = true
      }
    }
    // Letzte Sicherung vor 'worktree remove --force': nicht committete Arbeit im Worktree
    // schlägt jedes 'removable'. Sonst löscht das Aufräumen echte Arbeit.
    if (removable) {
      const dirty = await sh('git', ['-C', run.worktree, 'status', '--porcelain'])
      // Die Worktree-Ergänzungen stammen von uns, nicht vom Agenten. Ein Symlink
      // 'referenz' fällt z. B. nicht unter die Ignore-Regel 'referenz/' (mit Schrägstrich)
      // und stünde sonst für immer als '?? referenz' da — der Worktree würde nie aufgeräumt.
      const eigene = new Set((repo.extras ?? []).map(x => String(x.path).replace(/\/+$/, '')))
      const fremd = dirty.stdout.split('\n').filter(Boolean)
        .filter(z => !eigene.has(z.slice(3).trim().replace(/\/+$/, '')))
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
