// cc-hub — scheduler (planning 4.2/4.8): the agents' cron expressions, global
// pipeline AND gate, budget gate with deferral instead of discarding.
import db, { addEvent } from './db.mjs'
import { scheduleDue } from './util.mjs'
import { createRun, launchRun } from './runner.mjs'
import { claudeGateBlocked, openrouterGateBlocked } from './quota.mjs'
import { notifyRun } from './reports.mjs'
import { defFromAgent } from './run-def.mjs'

let timer = null
const fired = new Map()   // "agentId@YYYY-MM-DDTHH:MM" -> true

export function startScheduler() {
  if (timer) return
  timer = setInterval(() => tick().catch(e => console.error('[scheduler]', e.message)), 30_000)
}
export function stopScheduler() { clearInterval(timer); timer = null }

async function tick() {
  const pipelineOn = db.prepare(`SELECT value FROM settings WHERE key='pipeline_on'`).get()?.value === '1'
  if (!pipelineOn) return
  const agents = db.prepare(`SELECT * FROM agents WHERE active = 1 AND schedule_kind <> 'manuell'`).all()
  const now = new Date()
  const slot = now.toISOString().slice(0, 16)
  for (const agent of agents) {
    if (!scheduleDue(agent, now)) continue
    const key = `${agent.id}@${slot}`
    if (fired.get(key)) continue
    fired.set(key, true)
    // The previous run of the same agent is still going? Then do NOT start another —
    // otherwise an agent whose run takes longer than its schedule laps itself
    // and worktrees and LLM sessions pile up. "No fixed limit"
    // (planning 4.2) means different agents, not the same one several times.
    const busy = db.prepare(`SELECT id FROM runs WHERE agent_id=?
      AND status IN ('running','waiting_help','deferred') LIMIT 1`).get(agent.id)
    if (busy) {
      addEvent(busy.id, 'schedule_skipped', { agent: agent.name, slot })
      continue
    }
    // One-off schedules fire exactly once and then switch themselves off.
    if (agent.schedule_kind === 'einmalig') {
      db.prepare(`UPDATE agents SET schedule_kind='manuell', run_at=NULL, updated_at=datetime('now') WHERE id=?`).run(agent.id)
    }
    await startForAgent(agent)
  }
  // Bound the map
  if (fired.size > 500) for (const k of fired.keys()) { if (!k.endsWith(slot)) fired.delete(k) }
}

/**
 * The budget gate for a harness: claude runs on the subscription quota,
 * everything else on OpenRouter credits. Also used by the watcher when it picks
 * a deferred run back up — one rule, one place.
 * Returns the blocking reason, or null when the start may happen.
 */
export async function budgetGate(harness) {
  const g = harness === 'claude'
    ? claudeGateBlocked()
    : await openrouterGateBlocked(Number(db.prepare(`SELECT value FROM settings WHERE key='openrouter_min_eur'`).get()?.value ?? 5) || 5)
  return g.blocked ? g : null
}

/**
 * THE start path: definition in, run out — for the scheduler, the "start now"
 * button, the single-run form, the JSON API and the flow steps alike. Before,
 * each of them created and launched its run itself, and only the agent path
 * knew the budget gate; a single run started into an exhausted quota and died
 * at the first API call instead of being deferred.
 *
 * Returns {ok, runId?, deferred?, error?}.
 */
export async function startRun(def, { repoId, agentId = null, promptExtra = null } = {}) {
  // Budget gate BEFORE the start; blocked → defer (retry in the watcher), do not discard.
  const gate = await budgetGate(def.harness)

  let runId
  try {
    runId = createRun({ ...def, repoId, agentId, promptExtra })
  } catch (e) {
    return { ok: false, error: e.message }
  }

  if (gate) {
    db.prepare(`UPDATE runs SET status='deferred' WHERE id=?`).run(runId)
    addEvent(runId, 'deferred', { reason: gate.reason, resets_at: gate.resets_at ?? null })
    notifyRun(runId, 'deferred', `🟡 Start deferred — ${gate.reason}${gate.resets_at ? ` (reset: ${gate.resets_at})` : ''}`)
    return { ok: true, runId, deferred: true }
  }
  const r = await launchRun(runId)
  return r.ok ? { ok: true, runId } : { ok: false, runId, error: r.error }
}

/**
 * Starts a run for an agent (also "start now" from the UI) — the agent row is
 * only the stored definition.
 * Returns {ok, runId?, deferred?, error?}.
 */
export async function startForAgent(agent, promptExtra = null) {
  return startRun(defFromAgent(agent), { repoId: agent.repo_id, agentId: agent.id, promptExtra })
}
