// cc-hub flows — persistence. Own tables (flows, flow_runs) plus two retrofitted
// columns on runs: `flow_dispatched` (has the "run finished" trigger already been
// evaluated for this run?) and `flow_run_id` (which flow run started this run, if
// any). Everything else in the core schema stays untouched.
import db from '../db.mjs'
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

function addColumn(table, name, definition) {
  const have = db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === name)
  if (!have) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
}
addColumn('runs', 'flow_dispatched', 'INTEGER NOT NULL DEFAULT 0')
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
/** Flow runs suspended on a run that has now ended, or whose delay has elapsed. */
export function waitingOnRun(runId) {
  return db.prepare(`SELECT * FROM flow_runs WHERE status='waiting' AND wait_run_id = ?`).all(runId).map(hydrateRun)
}
export function dueDelayed(nowIso) {
  return db.prepare(`SELECT * FROM flow_runs WHERE status='waiting' AND resume_at IS NOT NULL AND resume_at <= ?`)
    .all(nowIso).map(hydrateRun)
}
export function runningFlowRuns() {
  return db.prepare(`SELECT * FROM flow_runs WHERE status IN ('running','waiting')`).all().map(hydrateRun)
}

/** Finished runs whose "run finished" trigger has not been evaluated yet. */
export function undispatchedRuns() {
  return db.prepare(`SELECT * FROM runs WHERE status IN ('done','failed','aborted') AND flow_dispatched = 0 ORDER BY ended_at`).all()
}
export function markDispatched(runId) {
  db.prepare('UPDATE runs SET flow_dispatched = 1 WHERE id = ?').run(runId)
}
export function markStartedByFlow(runId, flowRunId) {
  db.prepare('UPDATE runs SET flow_run_id = ? WHERE id = ?').run(flowRunId, runId)
}

export default db
