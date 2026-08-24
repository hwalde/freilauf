// cc-hub — Verarbeitung von Agent-Meldungen (cc-report → POST /api/runs/<id>/report
// oder Fallback inbox.jsonl, die der Watcher einsammelt). Planung 6 + 11.
import db, { addEvent } from './db.mjs'
import { notify, notifyLong, detailUrl } from './telegram.mjs'
import { sh } from './util.mjs'
import { vorfallMelden } from './incidents.mjs'
import { typVonClaudeFehler, typVonText, TYP_TEXT } from './detect.mjs'

const MAX_REPORT = 200 * 1024   // Planung 11: Report ≤ 200 kB

/** Ein Meldungs-Event verarbeiten. Liefert {ok, status?} */
export async function handleReport(runId, body) {
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId)
  // Planung 11: nur existierende Läufe in running/waiting_help akzeptieren.
  if (!run || !['running', 'waiting_help'].includes(run.status)) return { ok: false, error: 'unbekannter oder bereits beendeter Lauf' }
  const kind = String(body.kind || '')
  let text = typeof body.text === 'string' ? body.text : ''
  if (typeof body.file === 'string') {
    if (body.file.length > MAX_REPORT) return { ok: false, error: 'payload zu groß' }
    text = text ? `${text}\n\n${body.file}` : body.file
  }

  switch (kind) {
    case 'done': {
      db.prepare(`UPDATE runs SET status='done', ended_at=datetime('now'), report_md=? WHERE id=?`).run(text || null, runId)
      addEvent(runId, 'done')
      await notifyRun(runId, 'done', doneText(run, text), { fileName: `report-${runId.slice(0, 8)}.md`, fileContent: text })
      break
    }
    case 'failed': {
      db.prepare(`UPDATE runs SET status='failed', ended_at=datetime('now'), report_md=? WHERE id=?`)
        .run(`**Gescheitert:** ${text}`, runId)
      addEvent(runId, 'failed')
      await notifyRun(runId, 'failed', `❌ Lauf gescheitert${laufKopf(run)}\n${text}`, { fileName: `gescheitert-${runId.slice(0, 8)}.md`, fileContent: text })
      break
    }
    case 'help': {
      db.prepare(`UPDATE runs SET status='waiting_help', help_text=? WHERE id=?`).run(text, runId)
      addEvent(runId, 'help')
      // Die Frage MUSS vollständig ankommen — abgeschnitten ist sie nicht zu beantworten.
      await notifyRun(runId, 'help', `🆘 Hilferuf${laufKopf(run)}\n${text}`, { fileName: `hilferuf-${runId.slice(0, 8)}.md`, fileContent: text, dedupe: false })
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
      break
    case '_exit': {
      addEvent(runId, 'exit')
      const fresh = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId)
      if (fresh?.status === 'running') {
        // Prozess weg ohne done/failed → rot (Planung 4.5); Watcher bestätigt über pane_dead.
        addEventOnce(runId, 'anomaly:exit_without_report')
        await notifyRun(runId, 'exit_without_report', '🔴 Prozess beendet ohne Report.')
      }
      break
    }
    case '_rate_limit':   // alter Name, gleicher Weg
    case '_api_error': {
      // Hook-Meldung: claude 'StopFailure' (festes Enum) oder opencode 'session.error'
      // (Freitext). Der Hook ist die verlässlichste Quelle — sofort rot.
      const roh = String(body.error ?? (kind === '_rate_limit' ? 'rate_limit' : 'unknown'))
      let typ = typVonClaudeFehler(roh)
      if (typ === null) break                       // z. B. max_output_tokens: kein Provider-Problem
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
      const fresh = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId)
      if (fresh?.status === 'running') {
        db.prepare(`UPDATE runs SET status='failed', ended_at=datetime('now'), exit_code=? WHERE id=?`)
          .run(Number.isFinite(+body.exit) ? +body.exit : null, runId)
        await notifyRun(runId, 'pane_died', '🔴 Prozess tot ohne Report (tmux pane_dead).')
      }
      break
    }
    default:
      return { ok: false, error: `unbekannte Art '${kind}'` }
  }
  return { ok: true }
}

export function addEventOnce(runId, kind, payload = null) {
  const have = db.prepare('SELECT 1 FROM events WHERE run_id = ? AND kind = ? LIMIT 1').get(runId, kind)
  if (!have) addEvent(runId, kind, payload)
}

/**
 * Auffälligkeiten "erledigen sich" durch Fortschritt. Die Events bleiben als Historie
 * stehen, heißen danach aber 'cleared:*' — damit fällt die Ampel zurück (pages.mjs sucht
 * nach 'anomaly:%') und addEventOnce greift bei erneutem Auftreten wieder. Die
 * 'telegram_sent:*'-Flags bleiben absichtlich liegen: derselbe Typ soll auch dann keine
 * zweite Nachricht erzeugen (Planung 4.5).
 */
function clearAnomalies(runId, kinds) {
  const stmt = db.prepare(`UPDATE events SET kind = 'cleared:' || kind WHERE run_id = ? AND kind = ?`)
  for (const kind of kinds) stmt.run(runId, kind)
}

/** Kopfzeile mit Agent/Repo/Harness — so ist die Nachricht ohne Klick zuzuordnen. */
function laufKopf(run) {
  const a = run.agent_id ? db.prepare('SELECT name FROM agents WHERE id=?').get(run.agent_id)?.name : null
  const p = db.prepare('SELECT name FROM repos WHERE id=?').get(run.repo_id)?.name
  return ` — ${a ?? 'Einzellauf'} @ ${p ?? '?'} (${run.harness}${run.model ? '/' + run.model : ''})`
}

function doneText(run, report) {
  const dur = run.started_at
    ? `Dauer: ${Math.round((Date.now() - Date.parse(run.started_at.replace(' ', 'T') + 'Z')) / 60000)} min`
    : ''
  const vorfaelle = db.prepare(`SELECT typ, anzahl FROM incidents WHERE run_id = ? ORDER BY id`).all(run.id)
  const vf = vorfaelle.length ? ' · Vorfälle: ' + vorfaelle.map(v => `${TYP_TEXT[v.typ] ?? v.typ} ${v.anzahl}×`).join(', ') : ''
  const branch = run.branch_reported || run.branch_expected
  const zeile2 = [dur, branch ? `Branch: ${branch}` : null, run.pr_url ? `PR: ${run.pr_url}` : null].filter(Boolean).join(' · ')
  // Vollständiger Report; über 4096 Zeichen kappt notify() und notifyLong() hängt die Datei an.
  return `✅ Fertig${laufKopf(run)}\n${zeile2}${vf}\n\n${report || '(kein Report-Text)'}`
}

/**
 * Telegram mit Dedup pro (Lauf, Typ) — Planung 4.5: nur eine Nachricht je Auffälligkeits-Typ.
 */
export async function notifyRun(runId, type, text, lang = null) {
  const flag = `telegram_sent:${type}`
  const have = db.prepare('SELECT 1 FROM events WHERE run_id = ? AND kind = ? LIMIT 1').get(runId, flag)
  // Hilferufe sind nie Duplikate: jede Frage braucht eine Antwort.
  if (have && lang?.dedupe !== false) return false
  const voll = `${text}\n\nLauf: ${runId}`
  const ok = lang
    ? await notifyLong(voll, { fileName: lang.fileName, fileContent: lang.fileContent, url: detailUrl(runId) })
    : await notify(voll, detailUrl(runId))
  addEvent(runId, flag, { delivered: ok })
  addEvent(runId, 'telegram_sent', { type })
  return ok
}

/**
 * git-Hilfsprüfung für den Watcher: Upstream UND Tracking-Zustand.
 * Achtung, die Falle: '%(upstream:track)' ist auch dann leer, wenn der Branch GAR KEINEN
 * Upstream hat — leer allein heißt also nicht "gepusht". Darum kommt der Upstream mit
 * zurück und 'synced' ist nur wahr, wenn es einen Upstream gibt und nichts aussteht.
 * Liefert { upstream, track, synced }.
 */
export async function branchSyncState(repoPath, branch) {
  const r = await sh('git', ['-C', repoPath, 'for-each-ref',
    '--format=%(upstream)%09%(upstream:track)', `refs/heads/${branch}`])
  if (!r.ok) return { upstream: '', track: '', synced: false }
  const [upstream = '', track = ''] = r.stdout.trim().split('\t')
  return { upstream, track, synced: upstream !== '' && track === '' }
}
