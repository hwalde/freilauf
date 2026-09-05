// Freilauf flows — the step registry: ONE place that describes every building block
// (what the designer shows, which properties it has, how it executes).
//
// Each step: { type, component ('task'|'switch'|'container'), group, branches?, fields,
// output?, outputShape?, run }.
// `fields` drives the property editor in public/flows.js (shipped via
// GET /api/flows/meta) and the defaults/validation here; `outputShape` says what
// the output variable looks like, which is what varschema.mjs turns into typed
// pickers and "that variable does not exist" warnings; `run(props, ctx, api, info)`
// performs the step through the `api` object (actions.mjs in production, a stub in
// tests) and returns { msg?, output?, branch?, wait?, stop? }.
//
// Side effects never happen here directly — everything goes through `api`, so the
// engine stays testable and the coupling to the rest of the hub is one file.
import { render, resolve, compare, OPS, varName, toList } from './template.mjs'
import { STEP_ALIASES, renameSteps } from './aliases.mjs'
import { placementErrors, definitionWarnings } from './varschema.mjs'
import { RUN_DEF_FLOW_FIELDS, defFromFlowProps } from '../run-def.mjs'
import { llmSources } from '../llm/sources.mjs'

// A target selector aimed at the trigger run needs one to exist.
const TARGET_PLACEMENT = { needsRun: { whenField: 'target', is: 'trigger_run' } }

// The statuses a run may have — the CHECK on `runs.status` in server/db.mjs.
// Repeated here as a literal instead of imported because this file is the
// registry the designer and the unit tests load; a status the operator mistyped
// has to come back as a readable sentence from the step, not as an empty filter
// or a constraint error out of SQLite.
const RUN_STATUSES = ['scheduled', 'deferred', 'running', 'waiting_help', 'done', 'failed', 'aborted']

// ------------------------------------------- text the AGENT wrote, in a host shell
//
// A `shell_command` is host execution by design: `bash -lc`, as the hub's user,
// on the hub machine. That is the operator's tool and it stays one. What is NOT
// the operator's is the TEXT some of the flow variables carry: `run.report`,
// `run.last_report` and `run.help_text` are whatever the agent handed
// `fl-report`, `run.branch` and `run.pr_url` are whatever it reported as its
// branch and PR, and `merge.files` are the paths it chose to create. `render()`
// is raw substitution — it quotes nothing, because a template is text and not a
// command line — so
//
//     echo "{{trigger.run.report}}" >> log.txt
//
// hands the agent a shell. Inside the sandbox that is a way straight through the
// boundary: the box exists so an agent's *code* cannot reach the host, and a
// report is something an agent writes for free.
//
// The answer is an opt-in rather than a refusal or an escape, and each of the
// three was weighed:
//
//   escaping   would have to know where in the command the value lands (inside
//              quotes, in a heredoc, as part of a path). A wrapper that guesses
//              breaks working flows and still misses the cases it guessed wrong.
//   refusing   outright would break the legitimate use — an operator who wants
//              the branch name in a deploy command is not doing anything odd.
//   opt-in     says the thing out loud at the one moment somebody can judge it,
//              and leaves the step exactly as capable as it was.
//
// What this does NOT catch, and `docs/sandbox.md` says so in the same words: a
// value that reached `vars.*` through an `extract` step (an LLM reading the
// agent's report), through another `shell_command`'s `stdout`, or through an
// HTTP response. Those are agent text one hop further out, and no static check
// on a template can see it.
const AGENT_WRITTEN_LEAVES = new Set(['report', 'last_report', 'help_text', 'branch', 'pr_url', 'files'])

/**
 * Pure: the `{{…}}` paths in a template whose value the coding agent writes.
 * Matched on the LAST segment, so `trigger.run.report`, `vars.review.report`
 * and a future `run.report` are all one rule.
 */
export function agentWrittenVars(template) {
  const out = []
  for (const m of String(template ?? '').matchAll(/\{\{\s*([^}|]+?)\s*(?:\|[^}]*)?\}\}/g)) {
    const path = m[1].trim()
    if (AGENT_WRITTEN_LEAVES.has(path.split('.').pop()) && !out.includes(path)) out.push(path)
  }
  return out
}

/**
 * A checkbox's value, the way AGENTS.md says one has to be read: the string
 * `'0'` is truthy, so a ticked box is COMPARED against the values that mean yes
 * and never coerced.
 */
const ticked = (v) => v === true || v === 1
  || ['1', 'on', 'true', 'yes'].includes(String(v ?? '').trim().toLowerCase())

const TARGET_FIELDS = [
  { key: 'target', kind: 'select', options: ['trigger_run', 'agent', 'repo', 'all_running', 'run_id'], default: 'agent' },
  { key: 'agentId', kind: 'agent', showIf: { target: 'agent' } },
  { key: 'repoId', kind: 'repo', showIf: { target: 'repo' } },
  { key: 'runId', kind: 'text', showIf: { target: 'run_id' }, placeholder: '{{vars.review.id}}' },
]

/** Running runs a target selector points at (never the finished trigger run, except explicitly). */
async function targetRuns(props, ctx, api) {
  const filter = { statuses: ['running', 'waiting_help'] }
  switch (props.target) {
    case 'trigger_run': filter.runId = ctx.trigger?.run?.id; filter.statuses = null; break
    case 'agent': filter.agentId = Number(props.agentId) || null; break
    case 'repo': filter.repoId = Number(props.repoId) || null; break
    case 'run_id': filter.runId = String(resolve(props.runId, ctx) ?? '').trim(); break
    case 'all_running': break
    default: return []
  }
  if (props.target === 'agent' && !filter.agentId) return []
  if (props.target === 'run_id' && !filter.runId) return []
  return api.findRuns(filter)
}

// send_message / kill_run both report which runs they reached.
const RUNS_TOUCHED = { type: 'object', props: { count: { type: 'number' }, run_ids: { type: 'string_list' } } }

const WAIT_FIELDS = [
  { key: 'wait', kind: 'checkbox', default: true },
  { key: 'outputVar', kind: 'text', default: 'run' },
]

export const STEPS = [
  // ---------------- agents ----------------
  {
    type: 'send_message', component: 'task', group: 'agents', output: true,
    outputShape: RUNS_TOUCHED, placement: TARGET_PLACEMENT,
    fields: [
      ...TARGET_FIELDS,
      { key: 'text', kind: 'textarea', required: true, placeholder: 'main has moved ({{trigger.run.branch}} merged) — please pull the latest commits.' },
      { key: 'outputVar', kind: 'text', default: 'sent' },
    ],
    async run(props, ctx, api) {
      const runs = await targetRuns(props, ctx, api)
      const text = render(props.text, ctx)
      const alive = runs.filter(r => r.tmux_session && ['running', 'waiting_help'].includes(r.status))
      const ids = []
      for (const run of alive) { const r = await api.sendToRun(run, text); if (r.ok) ids.push(run.id) }
      return { msg: `sent to ${ids.length} run(s)`, output: { count: ids.length, run_ids: ids } }
    },
  },
  {
    type: 'start_agent', component: 'task', group: 'agents', output: true,
    // Without "wait" only the id exists; with it the finished run replaces the output.
    outputShape: { from: 'run_if_wait', otherwise: { type: 'object', props: { id: { type: 'string' }, deferred: { type: 'boolean' } } } },
    fields: [
      { key: 'agentId', kind: 'agent', required: true },
      { key: 'promptExtra', kind: 'textarea', placeholder: 'Additional instructions — {{vars.…}} placeholders allowed.' },
      ...WAIT_FIELDS,
    ],
    async run(props, ctx, api, info) {
      const extra = render(props.promptExtra, ctx).trim() || null
      const r = await api.startAgent(Number(props.agentId), extra, info.flowRunId)
      if (!r.ok) throw new Error(r.error || 'agent start failed')
      const out = { id: r.runId, deferred: !!r.deferred }
      // A deferred run (quota gate) still ends eventually — waiting stays correct.
      if (props.wait) return { msg: `started run ${r.runId} — waiting`, output: out, wait: { runId: r.runId } }
      return { msg: `started run ${r.runId}`, output: out }
    },
  },
  {
    type: 'start_single_run', component: 'task', group: 'agents', output: true,
    outputShape: { from: 'run_if_wait', otherwise: { type: 'object', props: { id: { type: 'string' }, deferred: { type: 'boolean' } } } },
    // The definition fields come from run-def.mjs — the same list the run form
    // and the agent form are built from, so a field cannot exist there and be
    // missing here.
    fields: [
      { key: 'repoId', kind: 'repo', required: true },
      ...RUN_DEF_FLOW_FIELDS,
      ...WAIT_FIELDS,
    ],
    async run(props, ctx, api, info) {
      // Templates first, then the definition: {{…}} may appear in every text field.
      const def = defFromFlowProps({
        ...props,
        model: render(props.model, ctx),
        prompt: render(props.prompt, ctx),
        branchPattern: render(props.branchPattern, ctx),
      })
      const r = await api.startSingle(def, Number(props.repoId), info.flowRunId)
      if (!r.ok) throw new Error(r.error || 'run start failed')
      const out = { id: r.runId, deferred: !!r.deferred }
      if (props.wait) return { msg: `started run ${r.runId} — waiting`, output: out, wait: { runId: r.runId } }
      return { msg: `started run ${r.runId}`, output: out }
    },
  },
  {
    type: 'kill_run', component: 'task', group: 'agents', output: true,
    outputShape: RUNS_TOUCHED, placement: TARGET_PLACEMENT,
    fields: [...TARGET_FIELDS, { key: 'outputVar', kind: 'text', default: 'killed' }],
    async run(props, ctx, api) {
      const runs = await targetRuns(props, ctx, api)
      const ids = []
      for (const run of runs) { if (await api.killRun(run)) ids.push(run.id) }
      return { msg: `aborted ${ids.length} run(s)`, output: { count: ids.length, run_ids: ids } }
    },
  },
  // Switching an agent's schedule on or off was a thing only a human could do,
  // on the agents page. A flow that reacts to what it finds — "the nightly job
  // has failed three times, stop it firing until somebody looks" — had no way to
  // say so, and neither had the flow that switches it back on afterwards.
  {
    type: 'toggle_agent', component: 'task', group: 'agents', output: true,
    outputShape: { type: 'object', props: {
      id: { type: 'number' }, name: { type: 'string' },
      active_before: { type: 'boolean' }, active_after: { type: 'boolean' },
      started_run_id: { type: 'string' } } },
    fields: [
      { key: 'agentId', kind: 'agent', required: true },
      { key: 'active', kind: 'select', options: ['on', 'off', 'toggle'], default: 'on' },
      { key: 'startNow', kind: 'checkbox', default: false, showIf: { active: 'on' } },
      { key: 'outputVar', kind: 'text', default: 'agent' },
    ],
    async run(props, ctx, api, info) {
      const agentId = Number(props.agentId) || null
      if (!agentId) throw new Error('toggle_agent: no agent chosen')
      const mode = props.active || 'on'
      // 'toggle' has to know the state before it can name the one it wants, so
      // it reads it the only way a step may — through the api, off the same row
      // setAgentActive is about to write.
      let want
      if (mode === 'toggle') {
        const before = await api.agentInfo(agentId)
        if (!before) throw new Error(`toggle_agent: agent ${agentId} does not exist`)
        want = !before.active
      } else want = mode === 'on'
      const r = await api.setAgentActive(agentId, want)
      if (!r.ok) throw new Error(`toggle_agent: ${r.error || 'could not switch the agent'}`)

      const out = { id: r.id, name: r.name, active_before: r.active_before, active_after: r.active_after, started_run_id: null }
      const state = `${r.name}: ${r.active_before ? 'on' : 'off'} → ${r.active_after ? 'on' : 'off'}`
      // Only after switching ON, and only when the box is ticked: an agent that
      // was just switched off must not be started by the same step.
      if (!(props.startNow && r.active_after)) return { msg: state, output: out }

      const s = await api.startAgentIfIdle(agentId, info.flowRunId)
      if (!s.ok) throw new Error(`toggle_agent: ${s.error || 'run start failed'}`)
      // A run of this agent is still going, so no second one is started. That is
      // the requested behaviour and therefore a result, not a failure — the step
      // says "skipped" and the flow reads `started_run_id: null` to branch on.
      if (!s.runId) return { msg: `${state} — skipped (agent is busy)`, output: out }
      out.started_run_id = s.runId
      return { msg: `${state} — started run ${s.runId}`, output: out }
    },
  },

  // ---------------- data ----------------
  {
    type: 'extract', component: 'task', group: 'data', output: true,
    // The fields the operator defined ARE the shape — strict json_schema makes
    // the model keep to them, enum values included.
    outputShape: { from: 'extract_fields' },
    fields: [
      { key: 'source', kind: 'select', options: ['report', 'log', 'transcript', 'report_and_log', 'custom'], default: 'report' },
      { key: 'sourceRun', kind: 'text', default: '{{trigger.run.id}}', placeholder: '{{vars.review.id}}' },
      { key: 'text', kind: 'textarea', showIf: { source: 'custom' } },
      { key: 'instructions', kind: 'textarea', placeholder: 'What to extract and how to judge it.' },
      { key: 'fields', kind: 'fields', required: true },
      // WHERE THE MODEL COMES FROM, not where the text comes from. `source`
      // above is the text (report / log / transcript / custom) and is stored in
      // saved flows, so it cannot be renamed — hence the second, longer name.
      // Empty = whatever Settings → check LLM points at.
      //
      // A getter, because the list of sources is not known when this module is
      // loaded: external plugin packages register during startup, and a plugin
      // the operator switches off must stop being offered. `stepsMeta()` is
      // serialized per request, and JSON.stringify runs the getter.
      {
        key: 'llmSource',
        kind: 'select',
        default: '',
        get options() { return ['', ...llmSources().map(s => s.id)] },
      },
      { key: 'model', kind: 'text', placeholder: 'empty = check-LLM model from the settings' },
      // The same fallback every other place that picks a model source offers:
      // a second source, tried when the first is down (transport). Empty =
      // the check job's fallback from the settings.
      {
        key: 'fallback',
        kind: 'select',
        default: '',
        get options() { return ['', ...llmSources().map(s => s.id)] },
      },
      { key: 'fallbackModel', kind: 'text', placeholder: 'empty = the primary model, or the fallback agent default' },
      { key: 'outputVar', kind: 'text', default: 'extracted' },
    ],
    async run(props, ctx, api) {
      let text
      if (props.source === 'custom') text = render(props.text, ctx)
      else {
        const runId = String(resolve(props.sourceRun || '{{trigger.run.id}}', ctx) ?? '').trim()
        if (!runId) throw new Error('extract: no source run (set "sourceRun" or use source=custom)')
        text = await api.runText(runId, props.source || 'report')
      }
      const fields = Array.isArray(props.fields) ? props.fields.filter(f => f?.name) : []
      if (!fields.length) throw new Error('extract: no fields defined')
      const out = await api.extract({
        text, instructions: props.instructions || '', fields,
        model: props.model || null,
        source: props.llmSource || null,
        fallback: props.fallback || null,
        fallbackModel: props.fallbackModel || null,
      })
      return { msg: `extracted ${Object.keys(out).length} field(s)`, output: out }
    },
  },
  {
    type: 'set_var', component: 'task', group: 'data', output: true,
    outputShape: { type: 'any' },          // whatever the template produced
    fields: [
      { key: 'outputVar', kind: 'text', required: true, default: 'value' },
      { key: 'value', kind: 'textarea', required: true },
    ],
    async run(props, ctx) {
      return { msg: `set vars.${varName(props.outputVar, 'value')}`, output: resolve(props.value, ctx) }
    },
  },
  {
    type: 'shell_command', component: 'task', group: 'data', output: true,
    // Detached there is nothing to report but the fact — the command outlives
    // this step, so an exit code or an output would be a promise we cannot keep.
    outputShape: { from: 'if_field', field: 'detach',
      then: { type: 'object', props: { ok: { type: 'boolean' }, detached: { type: 'boolean' } } },
      otherwise: { type: 'object', props: { ok: { type: 'boolean' }, exit_code: { type: 'number' }, stdout: { type: 'string' }, stderr: { type: 'string' } } } },
    fields: [
      { key: 'command', kind: 'textarea', required: true, placeholder: 'sleep 3; systemctl --user restart freilauf.service' },
      { key: 'cwd', kind: 'text', default: '{{trigger.run.repo_path}}' },
      { key: 'timeoutMinutes', kind: 'number', default: 10 },
      { key: 'detach', kind: 'checkbox', default: false },
      { key: 'allowAgentText', kind: 'checkbox', default: false },
      { key: 'outputVar', kind: 'text', default: 'shell' },
    ],
    async run(props, ctx, api) {
      // Text the agent wrote, in a shell that runs on the host as the operator
      // — refused unless the operator said so on this step. See
      // AGENT_WRITTEN_LEAVES above for why it is an opt-in and not an escape.
      const written = [...agentWrittenVars(props.command), ...agentWrittenVars(props.cwd)]
      if (written.length && !ticked(props.allowAgentText)) {
        throw new Error(`shell_command: ${written.join(', ')} is written by the coding agent, `
          + 'and this command runs on the hub machine as the hub\'s user — interpolating it would '
          + 'let a run execute code outside its sandbox. Tick "allow text the agent wrote" on this '
          + 'step if that is really what you mean.')
      }
      const command = render(props.command, ctx).trim()
      if (!command) throw new Error('shell_command: no command')
      const minutes = Math.max(1, Number(resolve(props.timeoutMinutes, ctx)) || 10)
      const out = await api.shell({
        command, cwd: render(props.cwd, ctx).trim(), timeoutMs: minutes * 60_000, detach: !!props.detach,
      })
      // An exit code is a result the flow branches on, never a failure of the
      // step — only a command that could not run at all throws (in api.shell).
      return { msg: out.detached ? 'detached' : `exit ${out.exit_code}`, output: out }
    },
  },
  {
    type: 'http_request', component: 'task', group: 'data', output: true,
    // `json` stays 'any': the response body has no schema we could know.
    outputShape: { type: 'object', props: { status: { type: 'number' }, ok: { type: 'boolean' }, body: { type: 'string' }, json: { type: 'any' } } },
    fields: [
      { key: 'url', kind: 'text', required: true, placeholder: 'https://…' },
      { key: 'method', kind: 'select', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], default: 'POST' },
      { key: 'headers', kind: 'textarea', placeholder: 'Authorization: Bearer …\nX-Key: value' },
      { key: 'body', kind: 'textarea', placeholder: '{"run": "{{trigger.run.id}}", "outcome": "{{trigger.run.outcome}}"}' },
      { key: 'outputVar', kind: 'text', default: 'http' },
    ],
    async run(props, ctx, api) {
      const headers = {}
      for (const line of String(props.headers ?? '').split('\n')) {
        const i = line.indexOf(':'); if (i > 0) headers[line.slice(0, i).trim()] = render(line.slice(i + 1).trim(), ctx)
      }
      const r = await api.http({ url: render(props.url, ctx), method: props.method || 'POST', headers, body: render(props.body, ctx) })
      return { msg: `HTTP ${r.status}`, output: r }
    },
  },
  // How many runs are there right now? `repos.max_parallel` answers that for the
  // SCHEDULER only — a flow start and an API start walk past it — so a flow that
  // hands out work had to improvise the number with a shell_command calling the
  // hub's own API and a condition on its body. That is three blocks, a network
  // round trip and a JSON parse for one integer the database already knows.
  {
    type: 'count_runs', component: 'task', group: 'data', output: true,
    outputShape: { type: 'object', props: {
      count: { type: 'number' }, ids: { type: 'string_list' }, titles: { type: 'string_list' } } },
    // No placement rule: it reads the hub's own state, never the trigger run, so
    // it is as legal under `cron` as it is after a finished run.
    fields: [
      { key: 'repoId', kind: 'repo' },
      { key: 'statuses', kind: 'text', default: 'running', placeholder: RUN_STATUSES.join(', ') },
      { key: 'titlePrefix', kind: 'text', placeholder: 'nightly ' },
      { key: 'agentId', kind: 'agent' },
      { key: 'outputVar', kind: 'text', default: 'runs' },
    ],
    async run(props, ctx, api) {
      const statuses = render(props.statuses, ctx).split(',').map(s => s.trim()).filter(Boolean)
      // A status nobody knows is rejected rather than dropped. Dropping it would
      // widen the filter instead of narrowing it — a typo would count every run
      // in the database and the flow would take the wrong branch on a number
      // that looks perfectly plausible.
      const unknown = statuses.filter(s => !RUN_STATUSES.includes(s))
      if (unknown.length) {
        throw new Error(`count_runs: unknown status ${unknown.join(', ')} — allowed: ${RUN_STATUSES.join(', ')}`)
      }
      const runs = await api.listRuns({
        repoId: Number(props.repoId) || null,
        agentId: Number(props.agentId) || null,
        // Nothing chosen = every status, the same way an empty repo means every repo.
        statuses: statuses.length ? statuses : null,
      })
      // The title filter is applied here, not in SQL: SQLite's LIKE folds ASCII
      // case only, so `Nächtlich` would not match a `nächtlich` prefix, while
      // JavaScript's toLowerCase() gets the umlauts right.
      const prefix = render(props.titlePrefix, ctx).trim().toLowerCase()
      const hits = prefix
        ? runs.filter(r => String(r.title ?? '').toLowerCase().startsWith(prefix))
        : runs
      return {
        msg: `${hits.length} Runs`,
        output: {
          count: hits.length,
          ids: hits.map(r => r.id),
          titles: hits.map(r => String(r.title ?? '')),
        },
      }
    },
  },

  // ---------------- control ----------------
  {
    type: 'condition', component: 'switch', group: 'control', branches: ['true', 'false'],
    fields: [
      { key: 'left', kind: 'var', required: true, placeholder: '{{trigger.run.outcome}}' },
      { key: 'op', kind: 'op', typeOf: 'left', options: OPS, default: 'eq' },
      { key: 'right', kind: 'value', typeOf: 'left', opOf: 'op', placeholder: 'done' },
    ],
    async run(props, ctx) {
      const ok = compare(resolve(props.left, ctx), props.op || 'eq', resolve(props.right, ctx))
      return { msg: `${props.op}: ${ok}`, branch: ok ? 'true' : 'false' }
    },
  },
  {
    type: 'switch_outcome', component: 'switch', group: 'control', branches: ['done', 'failed', 'aborted'],
    // Only meaningful where a finished run exists: the trigger delivers one, or
    // an earlier start step waited for its run. In a cron flow it would always
    // fall through to 'failed'.
    placement: { needsRun: true },
    fields: [{ key: 'value', kind: 'var', default: '{{trigger.run.outcome}}' }],
    async run(props, ctx) {
      const v = String(resolve(props.value || '{{trigger.run.outcome}}', ctx) ?? '').trim().toLowerCase()
      const branch = ['done', 'failed', 'aborted'].includes(v) ? v : 'failed'
      return { msg: `outcome ${v || '?'} → ${branch}`, branch }
    },
  },
  {
    type: 'for_each', component: 'container', group: 'control',
    fields: [
      { key: 'list', kind: 'var', required: true, placeholder: '{{vars.extracted.open_points}}' },
      { key: 'itemVar', kind: 'text', default: 'item' },
      { key: 'maxItems', kind: 'number', default: 50 },
    ],
    async run(props, ctx) {
      const max = Math.max(1, Number(props.maxItems) || 50)
      const all = toList(resolve(props.list, ctx))
      const items = all.slice(0, max)
      const cut = all.length > items.length ? ` (of ${all.length}, capped)` : ''
      return { msg: `${items.length} item(s)${cut}`, loop: { items, itemVar: varName(props.itemVar, 'item') } }
    },
  },
  {
    type: 'delay', component: 'task', group: 'control',
    fields: [{ key: 'minutes', kind: 'number', default: 5, required: true }],
    async run(props, ctx, api) {
      const min = Math.max(0, Number(resolve(props.minutes, ctx)) || 0)
      const resumeAt = new Date(api.now() + min * 60_000).toISOString()
      return { msg: `waiting ${min} min`, wait: { resumeAt } }
    },
  },
  {
    type: 'stop', component: 'task', group: 'control',
    fields: [{ key: 'reason', kind: 'text' }],
    async run(props, ctx) { return { msg: render(props.reason, ctx) || 'stop', stop: true } },
  },

  // ---------------- notify ----------------
  //
  // Channel-neutral: the step says something, the configured notifiers decide
  // where. It used to be `type: 'telegram'` and that type string is stored in
  // every saved flow definition, so the old name is still accepted — see
  // `STEP_ALIASES` below.
  {
    type: 'notify', component: 'task', group: 'notify', output: true,
    outputShape: { type: 'object', props: { delivered: { type: 'boolean' } } },
    fields: [
      { key: 'text', kind: 'textarea', required: true, placeholder: '🔁 {{trigger.run.agent_name}} finished: {{trigger.run.outcome}}' },
      { key: 'attachment', kind: 'textarea', placeholder: '{{trigger.run.report}} — sent as a file when non-empty' },
      { key: 'outputVar', kind: 'text', default: 'notify' },
    ],
    async run(props, ctx, api, info) {
      const ok = await api.notify(render(props.text, ctx), render(props.attachment, ctx),
        { runId: ctx.trigger?.run?.id ?? null, flowRunId: info?.flowRunId ?? null })
      // "no notifier configured" is not a failure of the step: a hub that says
      // nothing anywhere is a supported installation, and a flow that went red
      // over it would be reporting the operator's own choice as a fault.
      return { msg: ok ? 'sent' : 'not delivered (no notifier configured, or unreachable)', output: { delivered: ok } }
    },
  },
  {
    type: 'note', component: 'task', group: 'notify',
    fields: [{ key: 'text', kind: 'textarea', required: true }],
    async run(props, ctx) { return { msg: render(props.text, ctx) } },
  },
]

export const STEP_MAP = Object.fromEntries(STEPS.map(s => [s.type, s]))
export const GROUPS = ['agents', 'data', 'control', 'notify']

// Renamed step types live in `aliases.mjs` — a leaf module, because
// `flows/db.mjs` needs the same table and cannot import this file (steps.mjs →
// run-def.mjs → flows/attach.mjs → flows/db.mjs would close a ring).
//
// The alias in STEP_MAP is deliberately NOT in `STEPS`: the toolbox must offer
// one notify block, not two, and `stepsMeta()` is built from `STEPS`.
for (const [from, to] of Object.entries(STEP_ALIASES)) STEP_MAP[from] = STEP_MAP[to]
export { STEP_ALIASES, renameSteps }

/** Defaults for a fresh step of this type (designer toolbox). */
export function defaultProps(type) {
  const s = STEP_MAP[type]
  if (!s) return {}
  const out = {}
  for (const f of s.fields) out[f.key] = f.default ?? (f.kind === 'checkbox' ? false : f.kind === 'fields' ? [] : '')
  return out
}

/** Registry as plain data for the client (functions stripped). */
export function stepsMeta() {
  return STEPS.map(({ run, ...rest }) => rest)
}

/**
 * Validate a designer definition: known step types, required fields, branch
 * shape and placement rules. Returns a list of problems (empty = valid). Walks
 * recursively so a broken step inside a branch is found too. `trigger` is what
 * decides a placement rule — a step reading a run outcome is fine under a
 * run_finished trigger and broken under a cron one. `translate` turns a
 * placement code into the sentence the operator reads; without it the bare
 * code comes back (that is what the tests assert against).
 */
export function validateDefinition(def, trigger = null, translate = null) {
  const problems = []
  const walk = (seq, where) => {
    if (!Array.isArray(seq)) { problems.push(`${where}: sequence is not a list`); return }
    seq.forEach((step, i) => {
      const at = `${where}[${i}]`
      const s = STEP_MAP[step?.type]
      if (!s) { problems.push(`${at}: unknown step type '${step?.type}'`); return }
      const props = step.properties ?? {}
      for (const f of s.fields) {
        // The showIf skip gates BOTH rules below, so it comes first: a field the
        // designer is not showing is a field nobody was asked about.
        if (f.showIf && Object.entries(f.showIf).some(([k, v]) => props[k] !== v)) continue
        if (f.required) {
          const v = props[f.key]
          const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)
          if (empty) problems.push(`${step.name || step.type}: '${f.key}' is required`)
        }
        // A field may carry a rule of its own — today only the sandbox overrides
        // document, and it is there because that document is a WALL rather than a
        // convenience: a typo in it used to mean the step ran with less protection
        // than it asked for, and the only thing that noticed was the run, at 03:00.
        // So the designer that saves the flow refuses it, at the moment somebody
        // is there to read the reason. It takes the whole props bag rather than
        // the value, because the baseline it judges against depends on
        // `props.repoId` — a field of the step, not of this descriptor.
        //
        // The try/catch is not decoration: a field rule is code a plugin may one
        // day supply, and a throwing rule must not turn saving a flow into a 500.
        if (typeof f.validate === 'function') {
          try {
            for (const m of f.validate(props) ?? []) problems.push(`${step.name || step.type}: ${m}`)
          } catch (err) {
            problems.push(`${step.name || step.type}: ${err?.message ?? err}`)
          }
        }
      }
      if (s.component === 'switch') {
        for (const b of s.branches) walk(step.branches?.[b] ?? [], `${at}.${b}`)
      }
      if (s.component === 'container') walk(step.sequence ?? [], `${at}.body`)
    })
  }
  walk(def?.sequence, 'sequence')
  // Placement: same rules the designer enforces while dragging, repeated here
  // so a definition that never went through the designer cannot slip past.
  for (const p of placementErrors(def, STEP_MAP, trigger)) {
    problems.push(translate ? translate(p) : `${p.stepName}: ${p.code}`)
  }
  return problems
}

/**
 * Everything that is merely suspicious: a variable no step writes, a field an
 * extraction does not have, a comparison that can never be true, a step that
 * only *maybe* has its run. Never blocks saving — half-built flows are normal,
 * and an expression may point into an HTTP response we cannot describe.
 */
export function definitionHints(def, trigger = null) {
  return definitionWarnings(def, STEP_MAP, trigger)
}
