// cc-hub flows — triggers. Three kinds:
//   run_finished  a run reached done/failed/aborted (filters: agents, repo, outcomes)
//   cron          5-field cron expression, evaluated every tick (minute-debounced)
//   manual        only via the "run now" button / API
//
// Detection of finished runs is polling-based on `runs.flow_dispatched`: every
// path that ends a run (report, kill, pane_dead, watcher timeouts) is covered
// by ONE query instead of a hook in each of them. reports.mjs and the kill
// endpoint call `flowsTick()` right away for low latency; the watcher calls it
// every 30 s as the backstop.
import { listFlows, undispatchedRuns, markDispatched } from './db.mjs'
import { startFlowRun, resumeWaitingOnRun, resumeDelayed } from './engine.mjs'
import { actions, runInfo } from './actions.mjs'
import { cronMatches } from '../util.mjs'

export const TRIGGER_KINDS = ['run_finished', 'cron', 'manual']
export const OUTCOMES = ['done', 'failed', 'aborted']

/** Normalize a trigger object from the editor/API. */
export function normalizeTrigger(t = {}) {
  const kind = TRIGGER_KINDS.includes(t.kind) ? t.kind : 'manual'
  const out = { kind }
  if (kind === 'run_finished') {
    out.agentIds = (Array.isArray(t.agentIds) ? t.agentIds : []).map(Number).filter(Number.isFinite)
    // An agent belongs to exactly one repo — with agents chosen, a repo filter can
    // only ever narrow the result to nothing. The editor offers either/or; an older
    // definition (or a hand-written API call) is straightened out here.
    out.repoId = out.agentIds.length ? null : (Number(t.repoId) || null)
    out.outcomes = (Array.isArray(t.outcomes) ? t.outcomes : OUTCOMES).filter(o => OUTCOMES.includes(o))
    if (!out.outcomes.length) out.outcomes = [...OUTCOMES]
    out.singleRuns = t.singleRuns !== false           // runs without an agent
    out.flowStarted = t.flowStarted === true          // runs started by a flow (loop guard: off by default)
  }
  if (kind === 'cron') out.expr = String(t.expr ?? '').trim()
  return out
}

/** Does a run_finished trigger match this run? Pure — unit-tested. */
export function triggerMatches(trigger, run) {
  if (trigger.kind !== 'run_finished') return false
  if (!trigger.outcomes.includes(run.outcome)) return false
  if (trigger.repoId && run.repo_id !== trigger.repoId) return false
  if (run.flow_run_id && !trigger.flowStarted) return false
  if (run.agent_id) {
    if (trigger.agentIds.length && !trigger.agentIds.includes(run.agent_id)) return false
  } else if (!trigger.singleRuns || trigger.agentIds.length) return false
  return true
}

const cronFired = new Map()   // "flowId@YYYY-MM-DDTHH:MM" → true
let busy = false

/**
 * One pass: (1) resume flow runs waiting on runs that ended, (2) fire
 * run_finished triggers, (3) resume delays, (4) cron. Re-entrancy guarded —
 * reports.mjs and the watcher may call it at the same time.
 */
export async function flowsTick(api = actions) {
  if (busy) return
  busy = true
  try {
    const flows = listFlows().filter(f => f.active)
    for (const run of undispatchedRuns()) {
      markDispatched(run.id)                     // first, so a crash never double-fires
      const info = runInfo(run.id)
      try { await resumeWaitingOnRun(run.id, api) } catch (e) { console.error('[flows] resume', e.message) }
      for (const flow of flows) {
        if (!triggerMatches(normalizeTrigger(flow.trigger), info)) continue
        try {
          await startFlowRun(flow, { kind: 'run_finished', run: info, at: new Date(api.now()).toISOString() }, api, { triggerRunId: run.id })
        } catch (e) { console.error(`[flows] ${flow.name}:`, e.message) }
      }
    }
    await resumeDelayed(api)
    const now = new Date(api.now())
    const slot = now.toISOString().slice(0, 16)
    for (const flow of flows) {
      const trig = normalizeTrigger(flow.trigger)
      if (trig.kind !== 'cron' || !trig.expr || !cronMatches(trig.expr, now)) continue
      const key = `${flow.id}@${slot}`
      if (cronFired.get(key)) continue
      cronFired.set(key, true)
      try { await startFlowRun(flow, { kind: 'cron', run: null, at: now.toISOString() }, api) }
      catch (e) { console.error(`[flows] ${flow.name}:`, e.message) }
    }
    if (cronFired.size > 500) for (const k of cronFired.keys()) if (!k.endsWith(slot)) cronFired.delete(k)
  } finally { busy = false }
}

/** "Run now": optionally with a finished run as the simulated trigger. */
export async function runFlowNow(flow, runId = null, api = actions) {
  const info = runId ? runInfo(runId) : null
  if (runId && !info) throw new Error(`run ${runId} does not exist`)
  return startFlowRun(flow, { kind: 'manual', run: info, at: new Date(api.now()).toISOString() }, api, { triggerRunId: runId })
}
