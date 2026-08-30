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
import { RUNS_DIR, fmtDbUtc } from './util.mjs'
import { notify, detailUrl } from './telegram.mjs'
import { TYP_TEXT } from './detect.mjs'

/**
 * How long a red incident waits BEFORE Telegram fires. The delay is a grace
 * period in which the incident can resolve itself (the agent retries and gets
 * through, the hit was the agent's own probe on its screen) — the operator then
 * hears nothing at all instead of an alarm that answered itself. Genuinely
 * blocked runs stay silent for exactly this long and then ring; everything that
 * recovers within the window never pages. 0 = immediately (the test suite).
 */
const NOTIFY_DELAY_MS = Number(process.env.CCHUB_INCIDENT_NOTIFY_DELAY_MS ?? 10 * 60_000)

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

/**
 * Types that only a human can clear. A token, a credit balance and a wrong
 * model ID do not get better by waiting — every following run walks into the
 * same wall. A rate limit and a provider hiccup, on the other hand, pass by
 * themselves; the hub defers and retries.
 */
export const MENSCH_TYPEN = new Set(['auth_error', 'billing_error', 'model_error',
  // A branch that did not make it onto the base branch stays where it is until
  // somebody decides: merge it, commit the leftovers, or skip it. Waiting does
  // not help, so this belongs in the group that asks for hands.
  'merge_blocked',
  // The machine lost the tmux server, and with it every agent session at once.
  // Nothing the hub can retry, and a fact somebody has to see: the runs behind
  // those sessions stopped mid-work, whatever the reason was.
  'tmux_gone', 'tmux_unreachable'])

/**
 * Does this incident need a human — or is it just an observation?
 *
 * This is deliberately NOT the same question as 'schwere' (yellow/red). Severity
 * says how sure the detector is; this says whether anything is left to do.
 * Without the distinction, "resolve" asked the same click for "your account is
 * out of credits" and for "the provider hiccupped once and the run finished
 * fine" — and the second case is the overwhelming majority.
 *
 *   needs you    auth / billing / model, always. Plus: a confirmed (red)
 *                incident on a run that did NOT come through — that is the
 *                reason it did not, and the decision (retry? change model?
 *                wait?) is a human one.
 *   noticed      everything else. The record stays as history, the hub closes
 *                it by itself when the run finishes.
 */
export function brauchtMensch(v, runStatus = null) {
  if (MENSCH_TYPEN.has(String(v.typ).split(':')[0])) return true
  return v.schwere === 'rot' && ['failed', 'aborted'].includes(String(runStatus))
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
    // gemeldet_am resets: the reopened episode is a new one and pages again —
    // after its own grace period, like any first occurrence.
    db.prepare(`UPDATE incidents SET geloest_am = NULL, geloest_von = NULL, zuletzt_gesehen = ?,
                anzahl = anzahl + 1, schwere = ?, quelle = ?, beleg = COALESCE(?, beleg),
                wieder_geoeffnet = wieder_geoeffnet + 1, gemeldet_am = NULL, notify_at = NULL WHERE id = ?`)
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
  if (melden) await telegramPlanen(row.id, tsMs)
  return { vorfall: row, ereignis }
}

/**
 * Schedule (or, with a zero delay, send now) the Telegram for a red incident.
 * `notify_at` is when it becomes due; vorfaelleMeldenFaellig() — the watcher
 * pass — sends everything that has come due and is STILL open. An incident that
 * resolves itself before then never pages (that is the point of the delay).
 */
async function telegramPlanen(id, tsMs = Date.now()) {
  if (NOTIFY_DELAY_MS <= 0) {
    const row = vorfall(id)
    await telegramVorfall(row, row.wieder_geoeffnet ? 'wieder' : 'neu')
    db.prepare(`UPDATE incidents SET gemeldet_am = ?, notify_at = NULL WHERE id = ?`).run(dbZeit(), id)
    return
  }
  db.prepare(`UPDATE incidents SET notify_at = ? WHERE id = ? AND gemeldet_am IS NULL AND geloest_am IS NULL`)
    .run(dbZeit(tsMs + NOTIFY_DELAY_MS), id)
}

/**
 * Send every red incident whose notification delay has passed and that is STILL
 * open — the watcher pass runs this every tick. A still-open incident after the
 * grace period is one that did not resolve itself; that is the alarm.
 *
 * Rows with a notify_at only exist when a delay is configured (with delay 0 the
 * alarm goes out immediately at telegramPlanen) — or when a test set one by hand.
 */
export async function vorfaelleMeldenFaellig(jetztMs = Date.now()) {
  const rows = db.prepare(`SELECT id FROM incidents
    WHERE geloest_am IS NULL AND gemeldet_am IS NULL AND schwere = 'rot'
      AND notify_at IS NOT NULL AND notify_at <= ?`).all(dbZeit(jetztMs))
  for (const { id } of rows) {
    const row = vorfall(id)
    if (!row || row.geloest_am !== null || row.gemeldet_am !== null) continue
    await telegramVorfall(row, row.wieder_geoeffnet ? 'wieder' : 'neu')
    db.prepare(`UPDATE incidents SET gemeldet_am = ?, notify_at = NULL WHERE id = ?`).run(dbZeit(), id)
  }
}

/** Upgrade yellow → red by the watcher (assessment by time/count). */
export async function vorfallEskalieren(id, grund) {
  const row = vorfall(id)
  if (!row || row.geloest_am !== null || row.schwere === 'rot') return row
  db.prepare(`UPDATE incidents SET schwere = 'rot' WHERE id = ?`).run(id)
  const neu = vorfall(id)
  detektorLog(row.run_id, { art: 'eskalation', id, typ: row.typ, grund })
  if (row.run_id) addEvent(row.run_id, 'incident:eskaliert', { typ: row.typ, id, grund })
  // The escalation is a judgment by time/count, not a fresh occurrence — but it
  // is the moment the incident becomes an alarm, so it pages (with the same
  // grace period; escalation BY SILENCE means the agent has been stuck a while
  // already, so the delay only ever applies to the still-ambiguous cases).
  await telegramPlanen(id, Date.now())
  return neu
}

/** Incident resolved by a human. Another occurrence afterwards reopens it. */
export function vorfallLoesen(id, von = 'web') {
  const row = vorfall(id)
  if (!row || row.geloest_am !== null) return row
  db.prepare(`UPDATE incidents SET geloest_am = ?, geloest_von = ?, notify_at = NULL WHERE id = ?`)
    .run(dbZeit(), von, id)
  detektorLog(row.run_id, { art: 'geloest', id, typ: row.typ, von })
  if (row.run_id) addEvent(row.run_id, 'incident:geloest', { typ: row.typ, id, von })
  return vorfall(id)
}

/** Resolve all open incidents of a run ("resolve all" button). */
export function vorfaelleLoesen(runId, von = 'web') {
  for (const v of offeneVorfaelle(runId)) vorfallLoesen(v.id, von)
}

/**
 * An incident that resolved itself. The record stays (history, counts, the
 * detector's protocol) — but it no longer needs anybody, and the sidebar and
 * every open page learn so through the event. One that WAS announced on
 * Telegram also announces its recovery: an alarm that rings must un-ring, or
 * the operator keeps a problem in mind that no longer exists.
 */
export async function vorfallVerwerfen(id, grund) {
  const row = vorfall(id)
  if (!row || row.geloest_am !== null) return row
  db.prepare(`UPDATE incidents SET geloest_am = ?, geloest_von = ?, notify_at = NULL WHERE id = ?`)
    .run(dbZeit(), `auto:${grund}`, id)
  detektorLog(row.run_id, { art: 'verworfen', id, typ: row.typ, grund })
  if (row.run_id) addEvent(row.run_id, 'incident:auto_resolved', { typ: row.typ, id, grund })
  if (row.gemeldet_am !== null) await telegramAufgeloest(vorfall(id), grund)
  return vorfall(id)
}

/** Traffic-light color from the incidents alone: 'rot' | 'gelb' | null. */
export function ampelAusVorfaellen(runId) {
  const r = db.prepare(`SELECT schwere FROM incidents WHERE run_id = ? AND geloest_am IS NULL`).all(runId)
  if (r.some(x => x.schwere === 'rot')) return 'rot'
  if (r.length) return 'gelb'
  return null
}

/**
 * What a run is called in a Telegram message: the title first — "which work is
 * this about" is the reader's first question, and a bare uuid does not answer
 * it. The agent's name, the repo and the harness/model travel with it, so the
 * message is attributable without opening the hub.
 */
function runKennung(runId) {
  const run = db.prepare(`SELECT r.id, r.title, r.harness, r.model, r.provider, r.status, r.expected_minutes,
                            a.name AS agent, p.name AS repo
                          FROM runs r LEFT JOIN agents a ON a.id = r.agent_id LEFT JOIN repos p ON p.id = r.repo_id
                          WHERE r.id = ?`).get(runId)
  if (!run) return { zeile: `Run ${runId}`, run: null }
  const titel = run.title ?? runId.slice(0, 8)
  const wer = run.agent ? `agent ${run.agent}` : 'single run'
  const modell = `${run.harness}${run.model ? '/' + run.model : ''}${run.provider ? ' via ' + run.provider : ''}`
  return { zeile: `Run: ${titel} · ${wer} · repo ${run.repo ?? '?'} · ${modell}`, run }
}

async function telegramVorfall(row, ereignis, grund = null) {
  const kopf = row.wieder_geoeffnet ? '🔴 AGAIN: ' : '🔴 '
  const name = TYP_TEXT[row.typ] ?? row.typ
  const zeilen = [`${kopf}${name}`]
  if (row.run_id) {
    const { zeile, run } = runKennung(row.run_id)
    zeilen.push(zeile)
    // Say straight away whether this needs hands: the whole point of the alarm
    // is that the reader can tell a "get up" from a "noted" without opening it.
    zeilen.push(brauchtMensch(row, run?.status)
      ? '→ Needs you: this does not clear itself.'
      : '→ For information: the hub keeps going, nothing to do.')
  } else {
    zeilen.push('Global (provider pulse), affects all running agents.')
  }
  if (grund) zeilen.push(`Reason: ${grund}`)
  // The evidence ABOVE the bookkeeping: it is what answers "is this real?".
  if (row.beleg) zeilen.push(`Evidence: ${row.beleg}`)
  zeilen.push(`Source: ${row.quelle} · since ${fmtDbUtc(row.erst_gesehen)} · last ${fmtDbUtc(row.zuletzt_gesehen)} · ${row.anzahl}×${row.wieder_geoeffnet ? ` · reopened ${row.wieder_geoeffnet}×` : ''}`)
  if (telegramMuted(row.run_id)) { addEvent(row.run_id, 'telegram_muted', { type: `incident:${row.typ}` }); return }
  const ok = await notify(zeilen.join('\n'), row.run_id ? detailUrl(row.run_id) : detailUrl(null))
  if (row.run_id) addEvent(row.run_id, 'telegram_sent', { type: `incident:${row.typ}`, delivered: ok })
}

/**
 * The run's Telegram checkbox (`runs.telegram_on`, the one under its terminal)
 * silences the alarms ABOUT that run too — an operator who unticked it is
 * sitting in front of the session and sees what happens there. A global
 * incident carries no run and is never muted by it. Read here rather than
 * through reports.mjs, because that module imports this one.
 */
function telegramMuted(runId) {
  if (!runId) return false
  return db.prepare('SELECT telegram_on FROM runs WHERE id=?').get(runId)?.telegram_on === 0
}

/** The counterpart of the alarm: an announced incident that cleared itself. */
async function telegramAufgeloest(row, grund) {
  const name = TYP_TEXT[row.typ] ?? row.typ
  const zeilen = [`✅ Resolved: ${name}`]
  if (row.run_id) {
    const { zeile } = runKennung(row.run_id)
    zeilen.push(zeile)
  } else {
    zeilen.push('Global (provider pulse).')
  }
  zeilen.push(`Recovered on its own (${grund}) · ${row.anzahl}× observed, last ${fmtDbUtc(row.zuletzt_gesehen)} · nothing left to do.`)
  if (telegramMuted(row.run_id)) { addEvent(row.run_id, 'telegram_muted', { type: `incident_resolved:${row.typ}` }); return }
  const ok = await notify(zeilen.join('\n'), row.run_id ? detailUrl(row.run_id) : detailUrl(null))
  if (row.run_id) addEvent(row.run_id, 'telegram_sent', { type: `incident_resolved:${row.typ}`, delivered: ok })
}
