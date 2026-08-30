// Freilauf flows — execution engine. Walks a designer definition step by step,
// persists after every step (context, frames, log) so a flow run survives a hub
// restart and can suspend: "wait for run X to end" or "resume at time T".
//
// State model: `frames` is a stack of { path, index, loop? }. `path` addresses a
// sequence inside the definition snapshot ([] = root, [{stepId, branch}] = a
// branch of a switch step, [{stepId}] = the body of a container step). A frame
// with `loop` re-enters its sequence once per item ("for each"). The definition
// is snapshotted into the state at start, so editing a flow never breaks a
// suspended run.
import {
  createFlowRun, getFlowRun, updateFlowRun, waitingOnRun, dueDelayed,
} from './db.mjs'
import { STEP_MAP } from './steps.mjs'
import { setPath, varName } from './template.mjs'

const MAX_STEPS = 2000         // guard per resume: a flow is not a program (for-each bodies count too)

function sequenceAt(def, path) {
  let seq = def.sequence ?? []
  for (const { stepId, branch } of path) {
    const step = seq.find(s => s.id === stepId)
    if (!step) return null
    seq = branch != null ? (step.branches?.[branch] ?? []) : (step.sequence ?? [])
  }
  return seq
}

/** Start a flow run: builds the initial context and executes until done/suspended. */
export async function startFlowRun(flow, trigger, api, { triggerRunId = null } = {}) {
  const context = { trigger, vars: {}, flow: { id: flow.id ?? null, name: flow.name } }
  const state = { definition: flow.definition, frames: [{ path: [], index: 0 }] }
  const id = createFlowRun({ flow, triggerRunId, context, state })
  await execute(id, api)
  return id
}

/** Enter item i of a for-each frame: vars.<itemVar> and vars.<itemVar>_index (1-based). */
function enterLoopItem(context, loop) {
  setPath(context.vars, loop.itemVar, loop.items[loop.i])
  setPath(context.vars, `${loop.itemVar}_index`, loop.i + 1)
}

/** Continue a suspended flow run (after a run ended or a delay elapsed). */
export async function resumeFlowRun(flowRunId, api, resumeData = null) {
  const fr = getFlowRun(flowRunId)
  if (!fr || fr.status !== 'waiting') return
  if (resumeData?.run && fr.state.pending) {
    // The step that suspended wanted the finished run as its output.
    setPath(fr.context.vars, fr.state.pending.var, resumeData.run)
    fr.log.push(entry(fr.state.pending.step, 'resume', true, `run ${resumeData.run.id} ended: ${resumeData.run.outcome}`))
  }
  delete fr.state.pending
  updateFlowRun(fr.id, { status: 'running', context: fr.context, state: fr.state, log: fr.log })
  await execute(fr.id, api)
}

function entry(step, type, ok, msg) {
  return { ts: new Date().toISOString(), step: step?.id ?? null, name: step?.name ?? null, type, ok, msg: String(msg ?? '').slice(0, 2000) }
}

async function execute(flowRunId, api) {
  const fr = getFlowRun(flowRunId)
  if (!fr || fr.status !== 'running') return
  const { context, state, log } = fr
  const def = state.definition
  const save = (status, extra = {}) => updateFlowRun(flowRunId, { status, context, state, log, ...extra })

  for (let n = 0; n < MAX_STEPS; n++) {
    const frame = state.frames[state.frames.length - 1]
    if (!frame) { log.push(entry(null, 'end', true, 'flow finished')); return save('done', { ended: true }) }
    const seq = sequenceAt(def, frame.path)
    if (!seq || frame.index >= seq.length) {
      // End of a for-each body: next item instead of leaving the frame.
      if (frame.loop && frame.loop.i + 1 < frame.loop.items.length) {
        frame.loop.i++
        frame.index = 0
        enterLoopItem(context, frame.loop)
        save('running')
        continue
      }
      state.frames.pop()
      continue
    }
    const step = seq[frame.index++]
    const handler = STEP_MAP[step.type]
    if (!handler) { log.push(entry(step, step.type, false, `unknown step type`)); return save('failed', { error: `unknown step type ${step.type}`, ended: true }) }

    const t0 = Date.now()
    let result
    try {
      result = await handler.run(step.properties ?? {}, context, api, { flowRunId, step }) ?? {}
    } catch (err) {
      log.push(entry(step, step.type, false, err.message))
      return save('failed', { error: `${step.name || step.type}: ${err.message}`, ended: true })
    }
    const e = entry(step, step.type, true, result.msg ?? '')
    e.ms = Date.now() - t0
    log.push(e)
    if (result.output !== undefined && handler.output) {
      setPath(context.vars, varName(step.properties?.outputVar, step.type), result.output)
    }
    if (result.branch != null) state.frames.push({ path: [...frame.path, { stepId: step.id, branch: result.branch }], index: 0 })
    if (result.loop && result.loop.items.length) {
      const loop = { items: result.loop.items, itemVar: result.loop.itemVar, i: 0 }
      enterLoopItem(context, loop)
      state.frames.push({ path: [...frame.path, { stepId: step.id }], index: 0, loop })
    }
    if (result.stop) { log.push(entry(step, 'end', true, 'stopped by step')); return save('done', { ended: true }) }
    if (result.wait) {
      if (result.wait.runId) {
        state.pending = { step: { id: step.id, name: step.name }, var: varName(step.properties?.outputVar, step.type) }
        return save('waiting', { waitRunId: result.wait.runId })
      }
      return save('waiting', { resumeAt: result.wait.resumeAt })
    }
    save('running')
  }
  log.push(entry(null, 'end', false, `step limit ${MAX_STEPS} reached`))
  return save('failed', { error: 'step limit reached', ended: true })
}

/** Called when a run ended: resume every flow run waiting on it. */
export async function resumeWaitingOnRun(runId, api) {
  for (const fr of waitingOnRun(runId)) {
    const run = await api.runInfo(runId)
    await resumeFlowRun(fr.id, api, { run })
  }
}

/** Called periodically: resume delayed flow runs whose time has come. */
export async function resumeDelayed(api) {
  for (const fr of dueDelayed(new Date(api.now()).toISOString())) await resumeFlowRun(fr.id, api)
}

/** Stop a running/waiting flow run by hand. */
export function stopFlowRun(flowRunId) {
  const fr = getFlowRun(flowRunId)
  if (!fr || !['running', 'waiting'].includes(fr.status)) return false
  fr.log.push(entry(null, 'end', true, 'stopped by user'))
  updateFlowRun(fr.id, { status: 'stopped', context: fr.context, state: fr.state, log: fr.log, ended: true })
  return true
}
