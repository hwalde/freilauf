// cc-hub flows — persistence. Own tables (flows, flow_runs) plus three retrofitted
// columns on runs: `flow_dispatched` (has the "run finished" trigger already been
// evaluated for this run?), `merge_dispatched` (the same question for the
// "run merged" trigger) and `flow_run_id` (which flow run started this run, if
// any). Everything else in the core schema stays untouched — the merge columns
// themselves (`merge_status`, `merged_sha`, `resolves_run_id`, …) belong to the
// merge integrator and are only ever read here.
import db, { getSetting } from '../db.mjs'
import { randomUUID } from 'node:crypto'

db.exec(`
CREATE TABLE IF NOT EXISTS flows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  trigger TEXT NOT NULL DEFAULT '{"kind":"manual"}',   -- JSON, see triggers.mjs
  definition TEXT NOT NULL DEFAULT '{"properties":{},"sequence":[]}',  -- designer JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS flow_runs (
  id TEXT PRIMARY KEY,
  flow_id INTEGER REFERENCES flows(id) ON DELETE SET NULL,
  flow_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK(status IN ('running','waiting','done','failed','stopped')),
  trigger_run_id TEXT,        -- the run whose end started this flow run (may be NULL)
  context TEXT NOT NULL,      -- JSON: { trigger, vars }
  state TEXT NOT NULL,        -- JSON: { frames } — where execution resumes
  log TEXT NOT NULL DEFAULT '[]',   -- JSON list of { ts, step, type, msg, ok }
  wait_run_id TEXT,           -- suspended until this run ends
  resume_at TEXT,             -- suspended until this time (delay step)
  error TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_flow_runs_flow ON flow_runs(flow_id, started_at);
CREATE INDEX IF NOT EXISTS idx_flow_runs_wait ON flow_runs(status, wait_run_id);
`)

export function hasColumn(table, name) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === name)
}
function addColumn(table, name, definition) {
  if (!hasColumn(table, name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
}
addColumn('runs', 'flow_dispatched', 'INTEGER NOT NULL DEFAULT 0')
addColumn('runs', 'merge_dispatched', 'INTEGER NOT NULL DEFAULT 0')
addColumn('runs', 'flow_run_id', 'TEXT')
// Runs that were already finished when the flow module arrived must not fire
// triggers retroactively — a hub restart would otherwise replay history.
db.exec(`UPDATE runs SET flow_dispatched=1 WHERE status IN ('done','failed','aborted') AND flow_dispatched=0
         AND ended_at IS NOT NULL AND ended_at < datetime('now', '-1 hour')`)

const parse = (s, fallback) => { try { return JSON.parse(s) } catch { return fallback } }

// One-time migration: the `run_finished` trigger used to carry its own filter
// (agentIds / repoId / outcomes / singleRuns). That filter now lives as an
// attachment on the agent (`agents.flows`, see attach.mjs) so the agent form
// and the flow editor edit the same rows instead of two copies. Old triggers
// are converted once and then reduced to their bare kind.
// Single runs cannot be reached retroactively — there is no row to hang the
// attachment on until one is created; such flows keep working via "run now".
;(function migrateTriggersToAttachments() {
  const done = db.prepare(`SELECT value FROM settings WHERE key='flows_attach_migrated'`).get()?.value
  if (done === '1') return
  const OUT = { 'done,failed,aborted': 'always', done: 'done', failed: 'failed', aborted: 'aborted', 'aborted,failed': 'not_done' }
  const whenOf = (o) => OUT[[...new Set(o ?? [])].sort().join(',')] ?? 'always'
  const attach = new Map()   // agentId → [{ flowId, when }]
  for (const row of db.prepare('SELECT id, trigger FROM flows').all()) {
    const trig = parse(row.trigger, { kind: 'manual' })
    if (trig.kind !== 'run_finished') continue
    const when = whenOf(trig.outcomes)
    const ids = Array.isArray(trig.agentIds) && trig.agentIds.length
      ? trig.agentIds.map(Number)
      : db.prepare(trig.repoId ? 'SELECT id FROM agents WHERE repo_id=?' : 'SELECT id FROM agents')
        .all(...(trig.repoId ? [trig.repoId] : [])).map(a => a.id)
    for (const id of ids) attach.set(id, [...(attach.get(id) ?? []), { flowId: row.id, when }])
    db.prepare('UPDATE flows SET trigger=? WHERE id=?').run(JSON.stringify({ kind: 'run_finished' }), row.id)
  }
  for (const [agentId, list] of attach) {
    db.prepare('UPDATE agents SET flows=? WHERE id=?').run(JSON.stringify(list), agentId)
  }
  db.prepare(`INSERT INTO settings(key,value) VALUES('flows_attach_migrated','1')
              ON CONFLICT(key) DO UPDATE SET value='1'`).run()
})()

/**
 * Runs that were already merged when this code first ran count as dispatched —
 * the same "never replay history" rule `flow_dispatched` follows above. Without
 * it the first start after an update would fire the `run_merged` trigger for
 * every merge the integrator ever made.
 *
 * The merge columns belong to the integrator, so this is a no-op on an
 * installation that does not have them yet.
 */
export function markExistingMergesDispatched() {
  if (!hasColumn('runs', 'merge_status')) return 0
  return db.prepare(`UPDATE runs SET merge_dispatched=1 WHERE merge_status='merged' AND merge_dispatched=0`).run().changes
}
markExistingMergesDispatched()

/**
 * A flow run left on `running` by a hub restart is a lie: the engine persists
 * after every step, but nothing ever picks such a row up again — there is no
 * startup resume, and repeating the step that was in flight would not be
 * idempotent (it may have sent a message, started a run, restarted the hub).
 * So it is closed as failed, with the reason in its own log.
 *
 * `waiting` is deliberately untouched: that state is a row, not a stack frame,
 * and the watcher resumes it exactly as before.
 */
export function failRunningFlowRuns() {
  const rows = db.prepare(`SELECT id, log FROM flow_runs WHERE status='running'`).all()
  const msg = 'hub restarted while this step was running'
  for (const row of rows) {
    const log = parse(row.log, [])
    log.push({ ts: new Date().toISOString(), step: null, name: null, type: 'end', ok: false, msg })
    db.prepare(`UPDATE flow_runs SET status='failed', error=?, log=?,
                ended_at=COALESCE(ended_at, datetime('now')) WHERE id=?`).run(msg, JSON.stringify(log), row.id)
  }
  return rows.length
}
failRunningFlowRuns()

function hydrate(row) {
  if (!row) return null
  return {
    ...row,
    trigger: parse(row.trigger, { kind: 'manual' }),
    definition: parse(row.definition, { properties: {}, sequence: [] }),
  }
}

export function listFlows() {
  return db.prepare('SELECT * FROM flows ORDER BY name').all().map(hydrate)
}
export function getFlow(id) {
  return hydrate(db.prepare('SELECT * FROM flows WHERE id = ?').get(id))
}
export function saveFlow({ id = null, name, active = 1, trigger, definition }) {
  const trig = JSON.stringify(trigger ?? { kind: 'manual' })
  const def = JSON.stringify(definition ?? { properties: {}, sequence: [] })
  if (id) {
    db.prepare(`UPDATE flows SET name=?, active=?, trigger=?, definition=?, updated_at=datetime('now') WHERE id=?`)
      .run(name, active ? 1 : 0, trig, def, id)
    return +id
  }
  const r = db.prepare('INSERT INTO flows(name, active, trigger, definition) VALUES(?,?,?,?)')
    .run(name, active ? 1 : 0, trig, def)
  return Number(r.lastInsertRowid)
}
/**
 * A free name for a flow that was saved without one. The name is optional in
 * the UI — a flow hangs on an agent or a single run, and naming each of four
 * attached flows is a hurdle — but the column is UNIQUE and `flow_runs` keeps a
 * copy of the name, so the row needs something. Counts up instead of using the
 * id: the id is only known after the INSERT.
 */
export function autoFlowName() {
  const taken = new Set(db.prepare('SELECT name FROM flows').all().map(r => r.name))
  for (let n = 1; ; n++) {
    const candidate = `Flow ${n}`
    if (!taken.has(candidate)) return candidate
  }
}
/**
 * The repo a `run_merged` trigger is filtered to — null = every repo. ONE rule,
 * used by `normalizeTrigger()` when a flow is saved and by the repo page when it
 * lists what runs after a merge; two readings of "which repo is this about"
 * would be the drift this module keeps avoiding.
 */
export const mergeTriggerRepoId = (trigger) => Number(trigger?.repoId) || null

/**
 * Every flow that reacts to a merge of this repo — its own and the ones that
 * watch all repos. Deliberately including the switched-off ones: this list is
 * the repo page's answer to "what happens after a merge here", and a flow that
 * is off is part of that answer, not absent from it.
 */
export function flowsForMergeOfRepo(repoId) {
  const id = Number(repoId) || 0
  return listFlows().filter(f => {
    if ((f.trigger?.kind ?? 'manual') !== 'run_merged') return false
    const on = mergeTriggerRepoId(f.trigger)
    return on === null || on === id
  })
}

export function deleteFlow(id) { db.prepare('DELETE FROM flows WHERE id = ?').run(id) }
export function toggleFlow(id) { db.prepare('UPDATE flows SET active = 1 - active WHERE id = ?').run(id) }

// ---------------- flow runs ----------------
function hydrateRun(row) {
  if (!row) return null
  return {
    ...row,
    context: parse(row.context, { trigger: {}, vars: {} }),
    state: parse(row.state, { frames: [] }),
    log: parse(row.log, []),
  }
}
export function createFlowRun({ flow, triggerRunId = null, context, state }) {
  const id = randomUUID()
  db.prepare(`INSERT INTO flow_runs(id, flow_id, flow_name, status, trigger_run_id, context, state)
              VALUES(?,?,?,'running',?,?,?)`)
    .run(id, flow.id ?? null, flow.name, triggerRunId, JSON.stringify(context), JSON.stringify(state))
  return id
}
export function getFlowRun(id) {
  return hydrateRun(db.prepare('SELECT * FROM flow_runs WHERE id = ?').get(id))
}
export function listFlowRuns(flowId = null, limit = 100) {
  const rows = flowId
    ? db.prepare('SELECT * FROM flow_runs WHERE flow_id = ? ORDER BY started_at DESC LIMIT ?').all(flowId, limit)
    : db.prepare('SELECT * FROM flow_runs ORDER BY started_at DESC LIMIT ?').all(limit)
  return rows.map(hydrateRun)
}
/** Persist context/state/log; status and wait fields as given. */
export function updateFlowRun(id, { status, context, state, log, waitRunId = null, resumeAt = null, error = null, ended = false }) {
  db.prepare(`UPDATE flow_runs SET status=?, context=?, state=?, log=?, wait_run_id=?, resume_at=?, error=?,
              ended_at=CASE WHEN ? THEN COALESCE(ended_at, datetime('now')) ELSE ended_at END WHERE id=?`)
    .run(status, JSON.stringify(context), JSON.stringify(state), JSON.stringify(log),
      waitRunId, resumeAt, error, ended ? 1 : 0, id)
}
/** How long a finished flow run is kept, in days. 0 = forever; the default is 7. */
export function flowRunKeepDays(settings = null) {
  const raw = settings ? settings.flow_runs_keep_days : getSetting('flow_runs_keep_days')
  if (raw == null || String(raw).trim() === '') return 7
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : 7
}

/**
 * Delete flow runs that are over their keep time. Returns how many went.
 *
 * Nothing ever deleted a flow run, which was fine while a flow was something a
 * finished agent run started — a handful a day. A CRON flow is the other case:
 * the one that deploys pushed commits fires every ten minutes, 144 runs a day,
 * for as long as the machine is up. /flows/runs would silt up with rows saying
 * "nothing to do".
 *
 * `failed` is kept FOUR TIMES as long, and that is the whole point of splitting
 * the rule: the successful ones are the noise, the failed one is the reason
 * somebody opens the page at all — and they are rare, so keeping them costs
 * nothing. `waiting` and `running` are never touched, whatever their age: a
 * waiting flow run is not old, it is suspended, and deleting it would drop work
 * that is still going to happen.
 */
export function pruneFlowRuns(nowMs = Date.now(), settings = null) {
  const days = flowRunKeepDays(settings)
  if (!days) return 0
  const cutoff = (factor) => new Date(nowMs - days * factor * 86_400_000).toISOString().replace('T', ' ').slice(0, 19)
  const del = db.prepare(`DELETE FROM flow_runs WHERE status IN ('done','stopped')
                          AND ended_at IS NOT NULL AND ended_at < ?`).run(cutoff(1))
  const delFailed = db.prepare(`DELETE FROM flow_runs WHERE status='failed'
                                AND ended_at IS NOT NULL AND ended_at < ?`).run(cutoff(4))
  return Number(del.changes) + Number(delFailed.changes)
}

/** Flow runs suspended on a run that has now ended, or whose delay has elapsed. */
export function waitingOnRun(runId) {
  return db.prepare(`SELECT * FROM flow_runs WHERE status='waiting' AND wait_run_id = ?`).all(runId).map(hydrateRun)
}
export function dueDelayed(nowIso) {
  return db.prepare(`SELECT * FROM flow_runs WHERE status='waiting' AND resume_at IS NOT NULL AND resume_at <= ?`)
    .all(nowIso).map(hydrateRun)
}

/** Finished runs whose "run finished" trigger has not been evaluated yet. */
export function undispatchedRuns() {
  return db.prepare(`SELECT * FROM runs WHERE status IN ('done','failed','aborted') AND flow_dispatched = 0 ORDER BY ended_at`).all()
}
export function markDispatched(runId) {
  db.prepare('UPDATE runs SET flow_dispatched = 1 WHERE id = ?').run(runId)
}
/**
 * Merged runs whose "run merged" trigger has not been evaluated yet — including
 * the conflict runs (`resolves_run_id` set), which the dispatcher marks and then
 * skips: their merge is the origin run's merge, and a flow must fire once per
 * integration, not once per run involved in it.
 *
 * Reads columns the merge integrator owns; the caller catches a database that
 * does not have them yet.
 */
export function undispatchedMerges() {
  return db.prepare(`SELECT * FROM runs WHERE merge_status = 'merged' AND merge_dispatched = 0
                     ORDER BY merged_at`).all()
}
export function markMergeDispatched(runId) {
  db.prepare('UPDATE runs SET merge_dispatched = 1 WHERE id = ?').run(runId)
}
/**
 * What a flow may know about the merge itself: the commit it landed as, the
 * branch it landed on, the conflict run that made it mergeable (if any) and the
 * files it changed. The file list comes from the `merged` event the integrator
 * writes — an event, not a column, because it is a list; a merge without one
 * (an older record, a hand-made row) simply reports no files instead of failing.
 */
export function mergeFacts(run) {
  const repo = db.prepare('SELECT base_branch FROM repos WHERE id = ?').get(run.repo_id)
  const ev = db.prepare(`SELECT payload FROM events WHERE run_id = ? AND kind = 'merged'
                         ORDER BY id DESC LIMIT 1`).get(run.id)
  const payload = parse(ev?.payload ?? '', {}) ?? {}
  return {
    sha: run.merged_sha ?? '',
    base: repo?.base_branch ?? '',
    resolver_run_id: run.resolver_run_id ?? null,
    files: Array.isArray(payload.files) ? payload.files.map(String) : [],
  }
}
/** `mergeFacts` for a run id — null when it was never merged, or the columns are not there. */
export function mergeFactsIfMerged(runId) {
  try {
    const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId)
    return run?.merge_status === 'merged' ? mergeFacts(run) : null
  } catch { return null }
}
export function markStartedByFlow(runId, flowRunId) {
  db.prepare('UPDATE runs SET flow_run_id = ? WHERE id = ?').run(flowRunId, runId)
}

export default db
