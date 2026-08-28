// cc-hub flows — triggers. Four kinds:
//   run_finished  a run this flow is ATTACHED to reached done/failed/aborted
//   run_merged    the work of a run landed on the repo's base branch
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
// `run_merged` DOES carry a filter of its own, and exactly one: the repo. A
// merge is a property of the repository, not of the agent — the run whose work
// lands may be a conflict run that never carried an attachment, and "after
// every merge into this repo" is the sentence the operator actually means. An
// attachment could not say it.
//
// Detection of finished runs is polling-based on `runs.flow_dispatched`: every
// path that ends a run (report, kill, pane_dead, watcher timeouts) is covered
// by ONE query instead of a hook in each of them. reports.mjs and the kill
// endpoint call `flowsTick()` right away for low latency; the watcher calls it
// every 30 s as the backstop. Merges use the same marking scheme
// (`runs.merge_dispatched`), fed by the merge integrator, which calls
// `flowsTick()` right after it has written the merge.
import {
  listFlows, undispatchedRuns, markDispatched,
  undispatchedMerges, markMergeDispatched, mergeFacts, mergeFactsIfMerged, mergeTriggerRepoId,
} from './db.mjs'
import { parseAttachments, attachmentFires } from './attach.mjs'
import { startFlowRun, resumeWaitingOnRun, resumeDelayed } from './engine.mjs'
import { actions, runInfo } from './actions.mjs'
import { cronMatches } from '../util.mjs'

export const TRIGGER_KINDS = ['run_finished', 'run_merged', 'cron', 'manual']
export const OUTCOMES = ['done', 'failed', 'aborted']

/** Normalize a trigger object from the editor/API. */
export function normalizeTrigger(t = {}) {
  const kind = TRIGGER_KINDS.includes(t.kind) ? t.kind : 'manual'
  const out = { kind }
  if (kind === 'cron') out.expr = String(t.expr ?? '').trim()
  // null = every repo. Anything that is not a repo id becomes exactly that,
  // because "all of them" is the honest reading of "no repo chosen".
  if (kind === 'run_merged') out.repoId = mergeTriggerRepoId(t)
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

/**
 * Which flows a merge starts: every active `run_merged` flow whose repo filter
 * matches (`repoId: null` = all repos). Pure apart from the flow list, like
 * `flowsForRun` — and unlike it, the filter sits on the trigger, because a
 * merge belongs to the repository (see the note at the top of this file).
 */
export function flowsForMerge(run, flows) {
  return flows.filter(f => {
    if (!f.active) return false
    const trig = normalizeTrigger(f.trigger)
    return trig.kind === 'run_merged' && (trig.repoId == null || trig.repoId === run.repo_id)
  })
}

const cronFired = new Map()   // "flowId@YYYY-MM-DDTHH:MM" → true
let busy = false
let mergeColumnsMissing = false   // said once, not on every tick

/**
 * Fire the `run_merged` trigger for every merge nobody has looked at yet.
 *
 * Marked FIRST, like a finished run — a crash between the mark and the start
 * loses a flow run, a crash the other way round fires the same merge for ever.
 * A conflict run is marked and then skipped in the same pass: it merged the
 * origin run's work, and without the mark the next pass would try again.
 *
 * The merge columns belong to the integrator. Until its branch is merged into
 * this one they do not exist, and this whole block is a no-op with one line in
 * the log instead of a broken tick.
 */
async function dispatchMerges(flows, api) {
  let runs
  try { runs = undispatchedMerges() } catch (e) {
    if (!mergeColumnsMissing) console.error('[flows] run_merged is idle — the merge columns are not in this database:', e.message)
    mergeColumnsMissing = true
    return
  }
  for (const run of runs) {
    markMergeDispatched(run.id)
    if (run.resolves_run_id) continue          // the origin run carries this merge
    const info = runInfo(run.id)
    if (!info) continue
    const merge = mergeFacts(run)
    const at = new Date(api.now()).toISOString()
    await Promise.allSettled(flowsForMerge(run, flows).map(flow =>
      startFlowRun(flow, { kind: 'run_merged', run: info, merge, at }, api, { triggerRunId: run.id })
        .catch(e => console.error(`[flows] ${flow.name}:`, e.message))))
  }
}

/**
 * One pass: (1) resume flow runs waiting on runs that ended, (2) fire
 * run_finished triggers, (3) fire run_merged triggers, (4) resume delays,
 * (5) cron. Re-entrancy guarded — reports.mjs, the merge integrator and the
 * watcher may call it at the same time.
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
    await dispatchMerges(flows, api)
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

/**
 * "Run now": optionally with a finished run as the simulated trigger. When that
 * run really was merged, `trigger.merge` comes along — a flow built for
 * `run_merged` is tried out with the very data it would get, not with a hole
 * where its variables are.
 */
export async function runFlowNow(flow, runId = null, api = actions) {
  const info = runId ? runInfo(runId) : null
  if (runId && !info) throw new Error(`run ${runId} does not exist`)
  const trigger = { kind: 'manual', run: info, merge: runId ? mergeFactsIfMerged(runId) : null, at: new Date(api.now()).toISOString() }
  return startFlowRun(flow, trigger, api, { triggerRunId: runId })
}
