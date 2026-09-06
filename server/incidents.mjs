// Freilauf — incidents: the alarm model for rate limits, provider outages and the like.
//
// An incident is ONE record per (run, type). It gets opened, keeps counting further
// occurrences (anzahl, zuletzt_gesehen), can be resolved by a human — and REOPENS
// when the problem occurs again after being resolved. Like a car alarm: you can turn
// it off, but on the next break-in it wails again. The notification fires on opening
// and on every reopening, not on every single occurrence.
//
// Every decision additionally lands in <run>/detektor.jsonl — so one can later trace
// what was scanned, what matched and why something was (not) reported. Rate limits
// are hard to reproduce; the log is the substitute for the debugger.
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import db, { addEvent } from './db.mjs'
import { RUNS_DIR, fmtDbUtc } from './util.mjs'
import { notify, notifyMuted, detailUrl } from './notify.mjs'
import { TYPE_TEXT, agentCopedAfter } from './detect.mjs'
import { env } from './env.mjs'

/**
 * How long a red incident waits BEFORE the notification fires. The delay is a grace
 * period in which the incident can resolve itself (the agent retries and gets
 * through, the hit was the agent's own probe on its screen) — the operator then
 * hears nothing at all instead of an alarm that answered itself. Genuinely
 * blocked runs stay silent for exactly this long and then ring; everything that
 * recovers within the window never pages. 0 = immediately (the test suite).
 */
const NOTIFY_DELAY_MS = Number(env('INCIDENT_NOTIFY_DELAY_MS') ?? 10 * 60_000)

/** Timestamp in DB format (UTC, 'YYYY-MM-DD HH:MM:SS'). */
export function dbTime(ms = Date.now()) {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
}
export function msFrom(dbTs) {
  return dbTs ? Date.parse(String(dbTs).replace(' ', 'T') + 'Z') : NaN
}

/** Log line for the detector — append-only, never read during operation. */
export function detectorLog(runId, eintrag) {
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
export const HUMAN_TYPES = new Set(['auth_error', 'billing_error', 'model_error',
  // A branch that did not make it onto the base branch stays where it is until
  // somebody decides: merge it, commit the leftovers, or skip it. Waiting does
  // not help, so this belongs in the group that asks for hands.
  'merge_blocked',
  // The machine lost the tmux server, and with it every agent session at once.
  // Nothing the hub can retry, and a fact somebody has to see: the runs behind
  // those sessions stopped mid-work, whatever the reason was.
  'tmux_gone', 'tmux_unreachable',
  // The agent said, in so many words, that the sandbox is in its way
  // (`fl-report access`, SANDBOX.md). It is a question, and a
  // question only a human answers: allow the host for this run, allow it for
  // the repo, or tell the agent to do without. Waiting changes nothing.
  'sandbox_access',
  // The container runtime stopped answering — the `tmux_unreachable` twin, and
  // it needs hands for the same reason: a daemon that is gone does not come
  // back by itself, and every sandboxed run on the machine is behind it.
  'docker_unreachable'])

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
export function needsHuman(v, runStatus = null) {
  if (HUMAN_TYPES.has(String(v.typ).split(':')[0])) return true
  return v.schwere === 'rot' && ['failed', 'aborted'].includes(String(runStatus))
}

export function openIncidentsOf(runId) {
  return runId === null
    ? db.prepare(`SELECT * FROM incidents WHERE run_id IS NULL AND geloest_am IS NULL ORDER BY id`).all()
    : db.prepare(`SELECT * FROM incidents WHERE run_id = ? AND geloest_am IS NULL ORDER BY id`).all(runId)
}
export function allIncidentsOf(runId) {
  return db.prepare(`SELECT * FROM incidents WHERE run_id = ? ORDER BY id`).all(runId)
}
export function incidentById(id) { return db.prepare('SELECT * FROM incidents WHERE id = ?').get(id) }

/**
 * Report an occurrence. Returns { incident, ereignis } with ereignis ∈
 *   'neu' | 'wieder' | 'zusatz' | 'dedupe' | 'eskaliert'
 *
 * - Open incident of the same type: anzahl++, zuletzt_gesehen; an upgrade
 *   yellow→red (e.g. the hook confirms what the log scanner only suspected) notifies.
 *   UNLESS the agent has demonstrably worked since the last occurrence — then it
 *   is an echo (see echoVetoed below) and `zuletzt_gesehen` stands still.
 * - Resolved incident and the occurrence lies AFTER the resolution: reopen + notify,
 *   UNLESS the agent has demonstrably worked since (the same veto).
 * - Occurrence BEFORE the resolution (straggler from the transcript): only count it.
 * - Two sources see the same event (hook + transcript within 90 s): do not
 *   count it twice.
 */
export async function reportIncident(runId, { typ, quelle, schwere = 'rot', beleg = null, tsMs = Date.now(), noNotify = false }) {
  const ts = dbTime(tsMs)
  const letzter = runId === null
    ? db.prepare(`SELECT * FROM incidents WHERE run_id IS NULL AND typ = ? ORDER BY id DESC LIMIT 1`).get(typ)
    : db.prepare(`SELECT * FROM incidents WHERE run_id = ? AND typ = ? ORDER BY id DESC LIMIT 1`).get(runId, typ)

  let ereignis, row
  if (letzter && letzter.geloest_am === null) {
    const dedupe = quelle !== letzter.quelle && Math.abs(tsMs - msFrom(letzter.zuletzt_gesehen)) < 90_000
    const hoch = schwere === 'rot' && letzter.schwere === 'gelb'
    // An echo on an OPEN incident: the agent has demonstrably worked since the
    // last occurrence, so this hit is its TUI redrawing an old line. It is
    // counted, and `zuletzt_gesehen` is deliberately left standing — that column
    // is what "no recurrence for n minutes" reads (incidentGoneReason), and
    // moving it every 30 seconds is what kept the alarm alive. See echoVetoed().
    //
    // The two conditions above OUTRANK it, and each for its own reason. A
    // `dedupe` is two sources describing ONE event within 90 seconds; treating
    // it as an echo would count it twice, which is the very thing that rule
    // exists to prevent (an e2e check caught exactly that). And an occurrence
    // that ESCALATES the severity is not an echo whatever the activity says: a
    // hook or a confirmed transcript error is stronger evidence than the veto,
    // and its moment is a new statement worth recording.
    const echo = !dedupe && !hoch && echoVetoed(runId, letzter.zuletzt_gesehen)
    db.prepare(`UPDATE incidents SET anzahl = anzahl + ?,
                zuletzt_gesehen = CASE WHEN ? THEN zuletzt_gesehen ELSE max(zuletzt_gesehen, ?) END,
                schwere = CASE WHEN ? THEN 'rot' ELSE schwere END,
                beleg = COALESCE(?, beleg), quelle = CASE WHEN ? THEN ? ELSE quelle END WHERE id = ?`)
      .run(dedupe ? 0 : 1, echo ? 1 : 0, ts, hoch ? 1 : 0, beleg, hoch ? 1 : 0, quelle, letzter.id)
    ereignis = hoch ? 'eskaliert' : dedupe ? 'dedupe' : echo ? 'echo' : 'zusatz'
    row = incidentById(letzter.id)
  } else if (letzter && tsMs <= msFrom(letzter.geloest_am)) {
    // Straggler: the occurrence is older than the resolution — still belongs to the old incident.
    db.prepare(`UPDATE incidents SET anzahl = anzahl + 1 WHERE id = ?`).run(letzter.id)
    ereignis = 'zusatz'
    row = incidentById(letzter.id)
  } else if (letzter && echoVetoed(runId, letzter.geloest_am)) {
    // The agent has demonstrably worked SINCE this incident was closed, so it is
    // not blocked by an API error and this hit is text on its screen — the
    // rateLogHit() veto, applied to the one path that never had it. Counted like
    // a straggler, and deliberately NOT reopened: reopening would page again.
    db.prepare(`UPDATE incidents SET anzahl = anzahl + 1, beleg = COALESCE(?, beleg) WHERE id = ?`)
      .run(beleg, letzter.id)
    ereignis = 'echo'
    row = incidentById(letzter.id)
  } else if (letzter) {
    // Reopening: the same record, so the history (erst_gesehen, anzahl) is preserved.
    // gemeldet_am resets: the reopened episode is a new one and pages again —
    // after its own grace period, like any first occurrence.
    db.prepare(`UPDATE incidents SET geloest_am = NULL, geloest_von = NULL, zuletzt_gesehen = ?,
                anzahl = anzahl + 1, schwere = ?, quelle = ?, beleg = COALESCE(?, beleg),
                wieder_geoeffnet = wieder_geoeffnet + 1, gemeldet_am = NULL, notify_at = NULL WHERE id = ?`)
      .run(ts, schwere, quelle, beleg, letzter.id)
    ereignis = 'wieder'
    row = incidentById(letzter.id)
  } else {
    const r = db.prepare(`INSERT INTO incidents(run_id, typ, quelle, schwere, erst_gesehen, zuletzt_gesehen, beleg)
                          VALUES(?,?,?,?,?,?,?)`).run(runId, typ, quelle, schwere, ts, ts, beleg)
    ereignis = 'neu'
    row = incidentById(Number(r.lastInsertRowid))
  }

  detectorLog(runId, { art: 'vorfall', ereignis, typ, quelle, schwere: row.schwere, anzahl: row.anzahl, beleg })
  // An echo is the statement that NOTHING happened, so it writes no run event.
  // A redraw arrives on every watcher pass, and an event every 30 seconds is
  // three things at once: a row in `events` for ever, a publish on the live
  // channel that re-fetches the run's fragment, and a history in which the run's
  // own six steps are buried under thirteen hundred repetitions of one line —
  // measured on run 4eeaa0bc, 1296 `incident:dedupe` rows in twelve hours, 15 %
  // of the whole events table. The detector log above still records every
  // decision; that file is where "seen and ignored" belongs.
  if (runId && ereignis !== 'echo') addEvent(runId, `incident:${ereignis}`, { typ, quelle, schwere: row.schwere, id: row.id })

  const melden = !noNotify && row.schwere === 'rot' && ['neu', 'wieder', 'eskaliert'].includes(ereignis)
  if (melden) await scheduleNotification(row.id, tsMs)
  return { incident: row, ereignis }
}

/**
 * Is this occurrence an ECHO — a line the agent's TUI redrew — rather than the
 * problem happening again?
 *
 * Not if the agent has demonstrably worked since the moment we are measuring
 * against: the incident's resolution (may it REOPEN?) or its last occurrence
 * (may it keep an OPEN incident alive?). That is
 * `agentCopedAfter()` — detect.mjs's one named copy of "a working agent is
 * never escalated" — and until this existed it guarded only the SEVERITY of a
 * log hit, never the reopening. So a coding agent's TUI redrawing an old line
 * into the pipe-pane log was a full recurrence: the incident came back, the
 * grace period restarted and the phone rang again.
 *
 * Measured on run 4eeaa0bc (2026-09-06). Its claude hit a real 5-hour session
 * limit at 07:14 and the incident was rightly red. The limit ended with the
 * window's own reset at 16:29 — the account reported 19 % and the agent's own
 * status line read `11% 5h` while it drove five subagents. The log scanner went
 * on matching the SAME screen line, `You've hit your session limit · resets
 * 11:30am`, on every single watcher pass: `incident:dedupe` at 14:54:21,
 * 14:54:51, 14:55:21 … to 77 occurrences. Two things follow from that, and the
 * second is why this fence is not optional. The incident could never resolve
 * itself, because "no recurrence for 10 minutes" cannot become true while a
 * redraw manufactures one every 30 seconds. And it could not be resolved BY
 * HAND either: closing it at 15:01:23 was undone by the next pass at 15:01:51 —
 * `wieder_geoeffnet` 2, and a fresh notification with it. An alarm the operator
 * cannot switch off is worse than no alarm.
 *
 * **The first of those two was fixed by the second's fix and nothing else**, and
 * that is why this veto had to move one branch up. The reopen guard only ever
 * sees an incident somebody had already CLOSED; while one is open, the same
 * redraw walked into the ordinary `anzahl++, zuletzt_gesehen = now` branch and
 * pushed the resolution deadline forward by 30 seconds, for ever. Measured on
 * the same run a day later: incident 38 still open thirteen hours after the
 * limit had lifted, 255 occurrences, `zuletzt_gesehen` never older than the
 * last watcher pass, and the agent visibly committing code the whole time. So
 * an open incident asks the veto against its LAST OCCURRENCE, and an echo does
 * not move that column — which is exactly what lets incidentGoneReason() see
 * "the agent kept working after it" ten minutes later and close the alarm.
 *
 * Both directions stay right, which is the whole reason the veto is the right
 * rule here rather than a text comparison. A genuinely blocked agent stops
 * producing output, so its activity does not advance past the closure (or past
 * the last occurrence), the veto is false and the incident reopens, escalates
 * and pages exactly as before. A harness that measures no activity at all
 * (hermes) reports `null`, which is UNKNOWN and never a veto — those behave as
 * they always did. And a global incident has no agent to ask about.
 *
 * The freeze cannot latch, either: an agent that worked and is NOW blocked has
 * its activity standing still while `zuletzt_gesehen` stands still too, so the
 * open incident resolves itself once ("the agent kept working after it"), and
 * the very next occurrence finds a closed incident whose resolution is younger
 * than that activity — no veto, reopened, announced.
 */
function echoVetoed(runId, sinceAt) {
  if (!runId || !sinceAt) return false
  const r = db.prepare('SELECT last_activity_at FROM runs WHERE id = ?').get(runId)
  const workedAt = r?.last_activity_at ? msFrom(r.last_activity_at) : null
  return agentCopedAfter(workedAt, msFrom(sinceAt))
}

/**
 * Schedule (or, with a zero delay, send now) the notification for a red incident.
 * `notify_at` is when it becomes due; notifyDueIncidents() — the watcher
 * pass — sends everything that has come due and is STILL open. An incident that
 * resolves itself before then never pages (that is the point of the delay).
 */
async function scheduleNotification(id, tsMs = Date.now()) {
  if (NOTIFY_DELAY_MS <= 0) {
    const row = incidentById(id)
    await notifyIncident(row, row.wieder_geoeffnet ? 'wieder' : 'neu')
    db.prepare(`UPDATE incidents SET gemeldet_am = ?, notify_at = NULL WHERE id = ?`).run(dbTime(), id)
    return
  }
  db.prepare(`UPDATE incidents SET notify_at = ? WHERE id = ? AND gemeldet_am IS NULL AND geloest_am IS NULL`)
    .run(dbTime(tsMs + NOTIFY_DELAY_MS), id)
}

/**
 * Send every red incident whose notification delay has passed and that is STILL
 * open — the watcher pass runs this every tick. A still-open incident after the
 * grace period is one that did not resolve itself; that is the alarm.
 *
 * Rows with a notify_at only exist when a delay is configured (with delay 0 the
 * alarm goes out immediately at scheduleNotification()) — or when a test set one by hand.
 */
export async function notifyDueIncidents(jetztMs = Date.now()) {
  const rows = db.prepare(`SELECT id FROM incidents
    WHERE geloest_am IS NULL AND gemeldet_am IS NULL AND schwere = 'rot'
      AND notify_at IS NOT NULL AND notify_at <= ?`).all(dbTime(jetztMs))
  for (const { id } of rows) {
    const row = incidentById(id)
    if (!row || row.geloest_am !== null || row.gemeldet_am !== null) continue
    await notifyIncident(row, row.wieder_geoeffnet ? 'wieder' : 'neu')
    db.prepare(`UPDATE incidents SET gemeldet_am = ?, notify_at = NULL WHERE id = ?`).run(dbTime(), id)
  }
}

/** Upgrade yellow → red by the watcher (assessment by time/count). */
export async function escalateIncident(id, grund) {
  const row = incidentById(id)
  if (!row || row.geloest_am !== null || row.schwere === 'rot') return row
  db.prepare(`UPDATE incidents SET schwere = 'rot' WHERE id = ?`).run(id)
  const neu = incidentById(id)
  detectorLog(row.run_id, { art: 'eskalation', id, typ: row.typ, grund })
  if (row.run_id) addEvent(row.run_id, 'incident:eskaliert', { typ: row.typ, id, grund })
  // The escalation is a judgment by time/count, not a fresh occurrence — but it
  // is the moment the incident becomes an alarm, so it pages (with the same
  // grace period; escalation BY SILENCE means the agent has been stuck a while
  // already, so the delay only ever applies to the still-ambiguous cases).
  await scheduleNotification(id, Date.now())
  return neu
}

/** Incident resolved by a human. Another occurrence afterwards reopens it. */
export function resolveIncident(id, von = 'web') {
  const row = incidentById(id)
  if (!row || row.geloest_am !== null) return row
  db.prepare(`UPDATE incidents SET geloest_am = ?, geloest_von = ?, notify_at = NULL WHERE id = ?`)
    .run(dbTime(), von, id)
  detectorLog(row.run_id, { art: 'geloest', id, typ: row.typ, von })
  if (row.run_id) addEvent(row.run_id, 'incident:geloest', { typ: row.typ, id, von })
  return incidentById(id)
}

/** Resolve all open incidents of a run ("resolve all" button). */
export function resolveIncidentsOf(runId, von = 'web') {
  for (const v of openIncidentsOf(runId)) resolveIncident(v.id, von)
}

/**
 * An incident that resolved itself. The record stays (history, counts, the
 * detector's protocol) — but it no longer needs anybody, and the sidebar and
 * every open page learn so through the event. One that WAS announced on
 * the recovery is announced too: an alarm that rings must un-ring, or
 * the operator keeps a problem in mind that no longer exists.
 */
export async function dismissIncident(id, grund) {
  const row = incidentById(id)
  if (!row || row.geloest_am !== null) return row
  db.prepare(`UPDATE incidents SET geloest_am = ?, geloest_von = ?, notify_at = NULL WHERE id = ?`)
    .run(dbTime(), `auto:${grund}`, id)
  detectorLog(row.run_id, { art: 'verworfen', id, typ: row.typ, grund })
  if (row.run_id) addEvent(row.run_id, 'incident:auto_resolved', { typ: row.typ, id, grund })
  if (row.gemeldet_am !== null) await notifyResolved(incidentById(id), grund)
  return incidentById(id)
}

/** Traffic-light color from the incidents alone: 'rot' | 'gelb' | null. */
export function trafficLightFromIncidents(runId) {
  const r = db.prepare(`SELECT schwere FROM incidents WHERE run_id = ? AND geloest_am IS NULL`).all(runId)
  if (r.some(x => x.schwere === 'rot')) return 'rot'
  if (r.length) return 'gelb'
  return null
}

/**
 * What a run is called in a notification: the title first — "which work is
 * this about" is the reader's first question, and a bare uuid does not answer
 * it. The agent's name, the repo and the harness/model travel with it, so the
 * message is attributable without opening the hub.
 */
function runLabel(runId) {
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

async function notifyIncident(row, ereignis, grund = null) {
  const kopf = row.wieder_geoeffnet ? '🔴 AGAIN: ' : '🔴 '
  const name = TYPE_TEXT[row.typ] ?? row.typ
  const zeilen = [`${kopf}${name}`]
  if (row.run_id) {
    const { zeile, run } = runLabel(row.run_id)
    zeilen.push(zeile)
    // Say straight away whether this needs hands: the whole point of the alarm
    // is that the reader can tell a "get up" from a "noted" without opening it.
    zeilen.push(needsHuman(row, run?.status)
      ? '→ Needs you: this does not clear itself.'
      : '→ For information: the hub keeps going, nothing to do.')
  } else {
    zeilen.push('Global (provider pulse), affects all running agents.')
  }
  if (grund) zeilen.push(`Reason: ${grund}`)
  // The evidence ABOVE the bookkeeping: it is what answers "is this real?".
  if (row.beleg) zeilen.push(`Evidence: ${row.beleg}`)
  zeilen.push(`Source: ${row.quelle} · since ${fmtDbUtc(row.erst_gesehen)} · last ${fmtDbUtc(row.zuletzt_gesehen)} · ${row.anzahl}×${row.wieder_geoeffnet ? ` · reopened ${row.wieder_geoeffnet}×` : ''}`)
  if (notifyMuted(row.run_id)) { addEvent(row.run_id, 'notify_muted', { type: `incident:${row.typ}` }); return }
  const r = await notify({ kind: 'incident', runId: row.run_id ?? null, text: zeilen.join('\n'),
    url: row.run_id ? detailUrl(row.run_id) : detailUrl(null) })
  if (row.run_id) addEvent(row.run_id, 'notified', { type: `incident:${row.typ}`, delivered: r.sent })
}

// The run's notification checkbox (the one under its terminal) silences the
// alarms ABOUT that run too — an operator who unticked it is sitting in front of
// the session and sees what happens there. A global incident carries no run and
// is never muted by it. `notifyMuted()` comes from notify.mjs, which imports
// neither this module nor reports.mjs: the second, inverted copy that used to
// stand here existed only because those two import each other.

/** The counterpart of the alarm: an announced incident that cleared itself. */
async function notifyResolved(row, grund) {
  const name = TYPE_TEXT[row.typ] ?? row.typ
  const zeilen = [`✅ Resolved: ${name}`]
  if (row.run_id) {
    const { zeile } = runLabel(row.run_id)
    zeilen.push(zeile)
  } else {
    zeilen.push('Global (provider pulse).')
  }
  zeilen.push(`Recovered on its own (${grund}) · ${row.anzahl}× observed, last ${fmtDbUtc(row.zuletzt_gesehen)} · nothing left to do.`)
  if (notifyMuted(row.run_id)) { addEvent(row.run_id, 'notify_muted', { type: `incident_resolved:${row.typ}` }); return }
  const r = await notify({ kind: 'incident', runId: row.run_id ?? null, text: zeilen.join('\n'),
    url: row.run_id ? detailUrl(row.run_id) : detailUrl(null) })
  if (row.run_id) addEvent(row.run_id, 'notified', { type: `incident_resolved:${row.typ}`, delivered: r.sent })
}
