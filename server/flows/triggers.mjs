// cc-hub flows — triggers. Three kinds:
//   run_finished  a run this flow is ATTACHED to reached done/failed/aborted
//   cron          5-field cron expression, evaluated every tick (minute-debounced)
//   manual        only via the "run now" button / API
//
// `run_finished` carries no filter of its own any more. Which runs start the
// flow, and under which condition, is the attachment on the agent / the single
// run (`agents.flows` → `runs.flows`, see attach.mjs) — edited in the agent
// form, in the single-run form and in the flow editor, all three writing the
// same rows. A trigger filter next to it would be a second copy of the same
// statement, and the two would drift.
//
// Detection of finished runs is polling-based on `runs.flow_dispatched`: every
// path that ends a run (report, kill, pane_dead, watcher timeouts) is covered
// by ONE query instead of a hook in each of them. reports.mjs and the kill
// endpoint call `flowsTick()` right away for low latency; the watcher calls it
// every 30 s as the backstop.
import { listFlows, undispatchedRuns, markDispatched } from './db.mjs'
import { parseAttachments, attachmentFires } from './attach.mjs'
import { startFlowRun, resumeWaitingOnRun, resumeDelayed } from './engine.mjs'
import { actions, runInfo } from './actions.mjs'
import { cronMatches } from '../util.mjs'

export const TRIGGER_KINDS = ['run_finished', 'cron', 'manual']
export const OUTCOMES = ['done', 'failed', 'aborted']

/** Normalize a trigger object from the editor/API. */
export function normalizeTrigger(t = {}) {
  const kind = TRIGGER_KINDS.includes(t.kind) ? t.kind : 'manual'
  const out = { kind }
  if (kind === 'cron') out.expr = String(t.expr ?? '').trim()
  return out
}

/**
 * Which flows this finished run starts: its own attachments, filtered by their
 * condition and by the flow being active with a `run_finished` trigger. Pure
 * apart from the flow list — unit-tested against a handed-in one.
 */
export function flowsForRun(run, outcome, flows) {
  return parseAttachments(run.flows)
    .filter(a => attachmentFires(a, outcome))
    .map(a => flows.find(f => f.id === a.flowId))
    .filter(f => f && f.active && normalizeTrigger(f.trigger).kind === 'run_finished')
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
      // Loop guard: a run that a flow started carries no attachments of its own
      // (defFromFlowProps), and an agent started by a flow must not re-trigger
      // the flow that started it. Chaining is done with "wait" on the start step.
      if (run.flow_run_id) continue
      const at = new Date(api.now()).toISOString()
      // Every attached flow starts — in parallel, the way a no-code platform
      // fans a trigger out. One flow throwing at its first step must not keep
      // the others from running, hence allSettled around individual catches.
      await Promise.allSettled(flowsForRun(run, info.outcome, flows).map(flow =>
        startFlowRun(flow, { kind: 'run_finished', run: info, at }, api, { triggerRunId: run.id })
          .catch(e => console.error(`[flows] ${flow.name}:`, e.message))))
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
