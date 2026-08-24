// cc-hub — Vorfälle: das Alarm-Modell für Rate-Limits, Provider-Ausfälle und Co.
//
// Ein Vorfall ist EIN Datensatz je (Lauf, Typ). Er wird eröffnet, zählt weitere
// Vorkommen mit (anzahl, zuletzt_gesehen), kann vom Menschen gelöst werden — und geht
// WIEDER auf, wenn das Problem nach dem Lösen erneut auftritt. Wie ein Autoalarm:
// abschalten geht, aber beim nächsten Einbruch heult er wieder. Telegram feuert beim
// Eröffnen und bei jedem Wieder-Öffnen, nicht bei jedem einzelnen Vorkommen.
//
// Jede Entscheidung landet zusätzlich in <run>/detektor.jsonl — damit man später
// nachvollziehen kann, was gescannt wurde, was getroffen hat und warum etwas (nicht)
// gemeldet wurde. Rate-Limits lassen sich schlecht nachstellen; das Protokoll ist der
// Ersatz für den Debugger.
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import db, { addEvent } from './db.mjs'
import { RUNS_DIR } from './util.mjs'
import { notify, detailUrl } from './telegram.mjs'
import { TYP_TEXT } from './detect.mjs'

/** Zeitstempel im DB-Format (UTC, 'YYYY-MM-DD HH:MM:SS'). */
export function dbZeit(ms = Date.now()) {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
}
export function msVon(dbTs) {
  return dbTs ? Date.parse(String(dbTs).replace(' ', 'T') + 'Z') : NaN
}

/** Protokollzeile für den Detektor — append-only, nie lesen im Betrieb. */
export function detektorLog(runId, eintrag) {
  if (!runId) return
  try {
    const dir = join(RUNS_DIR, runId)
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'detektor.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...eintrag }) + '\n')
  } catch { /* Protokoll ist Beiwerk, nie ein Grund zu scheitern */ }
}

export function offeneVorfaelle(runId) {
  return runId === null
    ? db.prepare(`SELECT * FROM incidents WHERE run_id IS NULL AND geloest_am IS NULL ORDER BY id`).all()
    : db.prepare(`SELECT * FROM incidents WHERE run_id = ? AND geloest_am IS NULL ORDER BY id`).all(runId)
}
export function alleVorfaelle(runId) {
  return db.prepare(`SELECT * FROM incidents WHERE run_id = ? ORDER BY id`).all(runId)
}
export function vorfall(id) { return db.prepare('SELECT * FROM incidents WHERE id = ?').get(id) }

/**
 * Vorkommen melden. Liefert { vorfall, ereignis } mit ereignis ∈
 *   'neu' | 'wieder' | 'zusatz' | 'dedupe' | 'eskaliert'
 *
 * - Offener Vorfall gleichen Typs: anzahl++, zuletzt_gesehen; eine Hochstufung
 *   gelb→rot (z. B. Hook bestätigt, was der Log-Scanner nur vermutete) meldet Telegram.
 * - Gelöster Vorfall und das Vorkommen liegt NACH dem Lösen: wieder öffnen + Telegram.
 * - Vorkommen VOR dem Lösen (Nachzügler aus dem Transkript): nur mitzählen.
 * - Zwei Quellen sehen dasselbe Ereignis (Hook + Transkript binnen 90 s): nicht
 *   doppelt zählen.
 */
export async function vorfallMelden(runId, { typ, quelle, schwere = 'rot', beleg = null, tsMs = Date.now(), stillMelden = false }) {
  const ts = dbZeit(tsMs)
  const letzter = runId === null
    ? db.prepare(`SELECT * FROM incidents WHERE run_id IS NULL AND typ = ? ORDER BY id DESC LIMIT 1`).get(typ)
    : db.prepare(`SELECT * FROM incidents WHERE run_id = ? AND typ = ? ORDER BY id DESC LIMIT 1`).get(runId, typ)

  let ereignis, row
  if (letzter && letzter.geloest_am === null) {
    const dedupe = quelle !== letzter.quelle && Math.abs(tsMs - msVon(letzter.zuletzt_gesehen)) < 90_000
    const hoch = schwere === 'rot' && letzter.schwere === 'gelb'
    db.prepare(`UPDATE incidents SET anzahl = anzahl + ?, zuletzt_gesehen = max(zuletzt_gesehen, ?),
                schwere = CASE WHEN ? THEN 'rot' ELSE schwere END,
                beleg = COALESCE(?, beleg), quelle = CASE WHEN ? THEN ? ELSE quelle END WHERE id = ?`)
      .run(dedupe ? 0 : 1, ts, hoch ? 1 : 0, beleg, hoch ? 1 : 0, quelle, letzter.id)
    ereignis = hoch ? 'eskaliert' : dedupe ? 'dedupe' : 'zusatz'
    row = vorfall(letzter.id)
  } else if (letzter && tsMs <= msVon(letzter.geloest_am)) {
    // Nachzügler: das Vorkommen ist älter als das Lösen — gehört noch zum alten Vorfall.
    db.prepare(`UPDATE incidents SET anzahl = anzahl + 1 WHERE id = ?`).run(letzter.id)
    ereignis = 'zusatz'
    row = vorfall(letzter.id)
  } else if (letzter) {
    // Wieder-Öffnen: derselbe Datensatz, damit Historie (erst_gesehen, anzahl) erhalten bleibt.
    db.prepare(`UPDATE incidents SET geloest_am = NULL, geloest_von = NULL, zuletzt_gesehen = ?,
                anzahl = anzahl + 1, schwere = ?, quelle = ?, beleg = COALESCE(?, beleg),
                wieder_geoeffnet = wieder_geoeffnet + 1 WHERE id = ?`)
      .run(ts, schwere, quelle, beleg, letzter.id)
    ereignis = 'wieder'
    row = vorfall(letzter.id)
  } else {
    const r = db.prepare(`INSERT INTO incidents(run_id, typ, quelle, schwere, erst_gesehen, zuletzt_gesehen, beleg)
                          VALUES(?,?,?,?,?,?,?)`).run(runId, typ, quelle, schwere, ts, ts, beleg)
    ereignis = 'neu'
    row = vorfall(Number(r.lastInsertRowid))
  }

  detektorLog(runId, { art: 'vorfall', ereignis, typ, quelle, schwere: row.schwere, anzahl: row.anzahl, beleg })
  if (runId) addEvent(runId, `incident:${ereignis}`, { typ, quelle, schwere: row.schwere, id: row.id })

  const melden = !stillMelden && row.schwere === 'rot' && ['neu', 'wieder', 'eskaliert'].includes(ereignis)
  if (melden) await telegramVorfall(row, ereignis)
  return { vorfall: row, ereignis }
}

/** Hochstufung gelb → rot durch den Watcher (Bewertung nach Zeit/Anzahl). */
export async function vorfallEskalieren(id, grund) {
  const row = vorfall(id)
  if (!row || row.geloest_am !== null || row.schwere === 'rot') return row
  db.prepare(`UPDATE incidents SET schwere = 'rot' WHERE id = ?`).run(id)
  const neu = vorfall(id)
  detektorLog(row.run_id, { art: 'eskalation', id, typ: row.typ, grund })
  if (row.run_id) addEvent(row.run_id, 'incident:eskaliert', { typ: row.typ, id, grund })
  await telegramVorfall(neu, 'eskaliert', grund)
  return neu
}

/** Vorfall vom Menschen gelöst. Ein erneutes Vorkommen danach öffnet ihn wieder. */
export function vorfallLoesen(id, von = 'web') {
  const row = vorfall(id)
  if (!row || row.geloest_am !== null) return row
  db.prepare(`UPDATE incidents SET geloest_am = ?, geloest_von = ? WHERE id = ?`).run(dbZeit(), von, id)
  detektorLog(row.run_id, { art: 'geloest', id, typ: row.typ, von })
  if (row.run_id) addEvent(row.run_id, 'incident:geloest', { typ: row.typ, id, von })
  return vorfall(id)
}

/** Alle offenen Vorfälle eines Laufs lösen (Knopf „alle lösen"). */
export function vorfaelleLoesen(runId, von = 'web') {
  for (const v of offeneVorfaelle(runId)) vorfallLoesen(v.id, von)
}

/** Gelber Log-Verdacht, der sich als harmlos herausgestellt hat (Prüf-LLM sagt nein). */
export function vorfallVerwerfen(id, grund) {
  const row = vorfall(id)
  if (!row || row.geloest_am !== null) return row
  db.prepare(`UPDATE incidents SET geloest_am = ?, geloest_von = ? WHERE id = ?`).run(dbZeit(), `auto:${grund}`, id)
  detektorLog(row.run_id, { art: 'verworfen', id, typ: row.typ, grund })
  return vorfall(id)
}

/** Ampelfarbe allein aus den Vorfällen: 'rot' | 'gelb' | null. */
export function ampelAusVorfaellen(runId) {
  const r = db.prepare(`SELECT schwere FROM incidents WHERE run_id = ? AND geloest_am IS NULL`).all(runId)
  if (r.some(x => x.schwere === 'rot')) return 'rot'
  if (r.length) return 'gelb'
  return null
}

async function telegramVorfall(row, ereignis, grund = null) {
  const kopf = ereignis === 'wieder' ? '🔴 ERNEUT: ' : ereignis === 'eskaliert' ? '🔴 Bestätigt: ' : '🔴 '
  const name = TYP_TEXT[row.typ] ?? row.typ
  const zeilen = [`${kopf}${name}`]
  if (row.run_id) {
    const run = db.prepare(`SELECT r.harness, r.model, r.provider, a.name AS agent, p.name AS repo
                            FROM runs r LEFT JOIN agents a ON a.id = r.agent_id LEFT JOIN repos p ON p.id = r.repo_id
                            WHERE r.id = ?`).get(row.run_id)
    if (run) zeilen.push(`Agent: ${run.agent ?? '(Einzellauf)'} · Repo: ${run.repo ?? '?'} · ${run.harness}${run.model ? '/' + run.model : ''}${run.provider ? ' via ' + run.provider : ''}`)
  } else {
    zeilen.push('Global (Provider-Puls), betrifft alle laufenden Agenten.')
  }
  zeilen.push(`Quelle: ${row.quelle} · seit ${row.erst_gesehen} UTC · zuletzt ${row.zuletzt_gesehen} UTC · ${row.anzahl}×${row.wieder_geoeffnet ? ` · ${row.wieder_geoeffnet}× wieder geöffnet` : ''}`)
  if (grund) zeilen.push(`Grund: ${grund}`)
  if (row.beleg) zeilen.push(`Beleg: ${row.beleg}`)
  if (row.run_id) zeilen.push(`Lauf: ${row.run_id}`)
  const ok = await notify(zeilen.join('\n'), row.run_id ? detailUrl(row.run_id) : detailUrl(null))
  if (row.run_id) addEvent(row.run_id, 'telegram_sent', { type: `incident:${row.typ}`, delivered: ok })
}
