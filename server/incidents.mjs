// cc-hub — incidents: the alarm model for rate limits, provider outages and the like.
//
// An incident is ONE record per (run, type). It gets opened, keeps counting further
// occurrences (anzahl, zuletzt_gesehen), can be resolved by a human — and REOPENS
// when the problem occurs again after being resolved. Like a car alarm: you can turn
// it off, but on the next break-in it wails again. Telegram fires on opening and on
// every reopening, not on every single occurrence.
//
// Every decision additionally lands in <run>/detektor.jsonl — so one can later trace
// what was scanned, what matched and why something was (not) reported. Rate limits
// are hard to reproduce; the log is the substitute for the debugger.
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import db, { addEvent } from './db.mjs'
import { RUNS_DIR } from './util.mjs'
import { notify, detailUrl } from './telegram.mjs'
import { TYP_TEXT } from './detect.mjs'

/** Timestamp in DB format (UTC, 'YYYY-MM-DD HH:MM:SS'). */
export function dbZeit(ms = Date.now()) {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
}
export function msVon(dbTs) {
  return dbTs ? Date.parse(String(dbTs).replace(' ', 'T') + 'Z') : NaN
}

/** Log line for the detector — append-only, never read during operation. */
export function detektorLog(runId, eintrag) {
  if (!runId) return
  try {
    const dir = join(RUNS_DIR, runId)
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'detektor.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...eintrag }) + '\n')
  } catch { /* the log is incidental, never a reason to fail */ }
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
 * Report an occurrence. Returns { vorfall, ereignis } with ereignis ∈
 *   'neu' | 'wieder' | 'zusatz' | 'dedupe' | 'eskaliert'
 *
 * - Open incident of the same type: anzahl++, zuletzt_gesehen; an upgrade
 *   yellow→red (e.g. the hook confirms what the log scanner only suspected) notifies Telegram.
 * - Resolved incident and the occurrence lies AFTER the resolution: reopen + Telegram.
 * - Occurrence BEFORE the resolution (straggler from the transcript): only count it.
 * - Two sources see the same event (hook + transcript within 90 s): do not
 *   count it twice.
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
    // Straggler: the occurrence is older than the resolution — still belongs to the old incident.
    db.prepare(`UPDATE incidents SET anzahl = anzahl + 1 WHERE id = ?`).run(letzter.id)
    ereignis = 'zusatz'
    row = vorfall(letzter.id)
  } else if (letzter) {
    // Reopening: the same record, so the history (erst_gesehen, anzahl) is preserved.
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

/** Upgrade yellow → red by the watcher (assessment by time/count). */
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

/** Incident resolved by a human. Another occurrence afterwards reopens it. */
export function vorfallLoesen(id, von = 'web') {
  const row = vorfall(id)
  if (!row || row.geloest_am !== null) return row
  db.prepare(`UPDATE incidents SET geloest_am = ?, geloest_von = ? WHERE id = ?`).run(dbZeit(), von, id)
  detektorLog(row.run_id, { art: 'geloest', id, typ: row.typ, von })
  if (row.run_id) addEvent(row.run_id, 'incident:geloest', { typ: row.typ, id, von })
  return vorfall(id)
}

/** Resolve all open incidents of a run ("resolve all" button). */
export function vorfaelleLoesen(runId, von = 'web') {
  for (const v of offeneVorfaelle(runId)) vorfallLoesen(v.id, von)
}

/** Yellow log suspicion that turned out to be harmless (check LLM says no). */
export function vorfallVerwerfen(id, grund) {
  const row = vorfall(id)
  if (!row || row.geloest_am !== null) return row
  db.prepare(`UPDATE incidents SET geloest_am = ?, geloest_von = ? WHERE id = ?`).run(dbZeit(), `auto:${grund}`, id)
  detektorLog(row.run_id, { art: 'verworfen', id, typ: row.typ, grund })
  return vorfall(id)
}

/** Traffic-light color from the incidents alone: 'rot' | 'gelb' | null. */
export function ampelAusVorfaellen(runId) {
  const r = db.prepare(`SELECT schwere FROM incidents WHERE run_id = ? AND geloest_am IS NULL`).all(runId)
  if (r.some(x => x.schwere === 'rot')) return 'rot'
  if (r.length) return 'gelb'
  return null
}

async function telegramVorfall(row, ereignis, grund = null) {
  const kopf = ereignis === 'wieder' ? '🔴 AGAIN: ' : ereignis === 'eskaliert' ? '🔴 Confirmed: ' : '🔴 '
  const name = TYP_TEXT[row.typ] ?? row.typ
  const zeilen = [`${kopf}${name}`]
  if (row.run_id) {
    const run = db.prepare(`SELECT r.harness, r.model, r.provider, a.name AS agent, p.name AS repo
                            FROM runs r LEFT JOIN agents a ON a.id = r.agent_id LEFT JOIN repos p ON p.id = r.repo_id
                            WHERE r.id = ?`).get(row.run_id)
    if (run) zeilen.push(`Agent: ${run.agent ?? '(single run)'} · Repo: ${run.repo ?? '?'} · ${run.harness}${run.model ? '/' + run.model : ''}${run.provider ? ' via ' + run.provider : ''}`)
  } else {
    zeilen.push('Global (provider pulse), affects all running agents.')
  }
  zeilen.push(`Source: ${row.quelle} · since ${row.erst_gesehen} UTC · last ${row.zuletzt_gesehen} UTC · ${row.anzahl}×${row.wieder_geoeffnet ? ` · reopened ${row.wieder_geoeffnet}×` : ''}`)
  if (grund) zeilen.push(`Reason: ${grund}`)
  if (row.beleg) zeilen.push(`Evidence: ${row.beleg}`)
  if (row.run_id) zeilen.push(`Run: ${row.run_id}`)
  const ok = await notify(zeilen.join('\n'), row.run_id ? detailUrl(row.run_id) : detailUrl(null))
  if (row.run_id) addEvent(row.run_id, 'telegram_sent', { type: `incident:${row.typ}`, delivered: ok })
}
