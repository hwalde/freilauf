// cc-hub flows — the step registry: ONE place that describes every building block
// (what the designer shows, which properties it has, how it executes).
//
// Each step: { type, component ('task'|'switch'|'container'), group, branches?, fields,
// output?, run }.
// `fields` drives the property editor in public/flows.js (shipped via
// GET /api/flows/meta) and the defaults/validation here; `run(props, ctx, api, info)`
// performs the step through the `api` object (actions.mjs in production, a stub in
// tests) and returns { msg?, output?, branch?, wait?, stop? }.
//
// Side effects never happen here directly — everything goes through `api`, so the
// engine stays testable and the coupling to the rest of the hub is one file.
import { render, resolve, compare, OPS, varName, toList } from './template.mjs'

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

const WAIT_FIELDS = [
  { key: 'wait', kind: 'checkbox', default: true },
  { key: 'outputVar', kind: 'text', default: 'run' },
]

export const STEPS = [
  // ---------------- agents ----------------
  {
    type: 'send_message', component: 'task', group: 'agents', output: true,
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
    fields: [
      { key: 'repoId', kind: 'repo', required: true },
      { key: 'harness', kind: 'harness', required: true },
      { key: 'provider', kind: 'text', placeholder: 'openrouter / opencode-zen / … (as in the run form)' },
      { key: 'model', kind: 'text' },
      { key: 'effort', kind: 'text' },
      { key: 'prompt', kind: 'textarea', required: true, placeholder: 'Review the report:\n{{trigger.run.report}}' },
      { key: 'branchMode', kind: 'select', options: ['keiner', 'neu', 'fest'], default: 'keiner' },
      { key: 'branchPattern', kind: 'text', placeholder: 'flow/{date}-{kurz}' },
      { key: 'expectedMinutes', kind: 'number', default: 45 },
      ...WAIT_FIELDS,
    ],
    async run(props, ctx, api, info) {
      const r = await api.startSingle({
        repoId: Number(props.repoId), harness: props.harness, provider: props.provider || null,
        model: render(props.model, ctx) || null, effort: props.effort || null,
        prompt: render(props.prompt, ctx), branchMode: props.branchMode || 'keiner',
        branchPattern: props.branchPattern || null, expectedMinutes: Number(props.expectedMinutes) || 45,
      }, info.flowRunId)
      if (!r.ok) throw new Error(r.error || 'run start failed')
      const out = { id: r.runId }
      if (props.wait) return { msg: `started run ${r.runId} — waiting`, output: out, wait: { runId: r.runId } }
      return { msg: `started run ${r.runId}`, output: out }
    },
  },
  {
    type: 'kill_run', component: 'task', group: 'agents', output: true,
    fields: [...TARGET_FIELDS, { key: 'outputVar', kind: 'text', default: 'killed' }],
    async run(props, ctx, api) {
      const runs = await targetRuns(props, ctx, api)
      const ids = []
      for (const run of runs) { if (await api.killRun(run)) ids.push(run.id) }
      return { msg: `aborted ${ids.length} run(s)`, output: { count: ids.length, run_ids: ids } }
    },
  },

  // ---------------- data ----------------
  {
    type: 'extract', component: 'task', group: 'data', output: true,
    fields: [
      { key: 'source', kind: 'select', options: ['report', 'log', 'transcript', 'report_and_log', 'custom'], default: 'report' },
      { key: 'sourceRun', kind: 'text', default: '{{trigger.run.id}}', placeholder: '{{vars.review.id}}' },
      { key: 'text', kind: 'textarea', showIf: { source: 'custom' } },
      { key: 'instructions', kind: 'textarea', placeholder: 'What to extract and how to judge it.' },
      { key: 'fields', kind: 'fields', required: true },
      { key: 'model', kind: 'text', placeholder: 'empty = check-LLM model from the settings' },
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
      const out = await api.extract({ text, instructions: props.instructions || '', fields, model: props.model || null })
      return { msg: `extracted ${Object.keys(out).length} field(s)`, output: out }
    },
  },
  {
    type: 'set_var', component: 'task', group: 'data', output: true,
    fields: [
      { key: 'outputVar', kind: 'text', required: true, default: 'value' },
      { key: 'value', kind: 'textarea', required: true },
    ],
    async run(props, ctx) {
      return { msg: `set vars.${varName(props.outputVar, 'value')}`, output: resolve(props.value, ctx) }
    },
  },
  {
    type: 'http_request', component: 'task', group: 'data', output: true,
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

  // ---------------- control ----------------
  {
    type: 'condition', component: 'switch', group: 'control', branches: ['true', 'false'],
    fields: [
      { key: 'left', kind: 'text', required: true, placeholder: '{{trigger.run.outcome}}' },
      { key: 'op', kind: 'select', options: OPS, default: 'eq' },
      { key: 'right', kind: 'text', placeholder: 'done' },
    ],
    async run(props, ctx) {
      const ok = compare(resolve(props.left, ctx), props.op || 'eq', resolve(props.right, ctx))
      return { msg: `${props.op}: ${ok}`, branch: ok ? 'true' : 'false' }
    },
  },
  {
    type: 'switch_outcome', component: 'switch', group: 'control', branches: ['done', 'failed', 'aborted'],
    fields: [{ key: 'value', kind: 'text', default: '{{trigger.run.outcome}}' }],
    async run(props, ctx) {
      const v = String(resolve(props.value || '{{trigger.run.outcome}}', ctx) ?? '').trim().toLowerCase()
      const branch = ['done', 'failed', 'aborted'].includes(v) ? v : 'failed'
      return { msg: `outcome ${v || '?'} → ${branch}`, branch }
    },
  },
  {
    type: 'for_each', component: 'container', group: 'control',
    fields: [
      { key: 'list', kind: 'text', required: true, placeholder: '{{vars.extracted.open_points}}' },
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
  {
    type: 'telegram', component: 'task', group: 'notify', output: true,
    fields: [
      { key: 'text', kind: 'textarea', required: true, placeholder: '🔁 {{trigger.run.agent_name}} finished: {{trigger.run.outcome}}' },
      { key: 'attachment', kind: 'textarea', placeholder: '{{trigger.run.report}} — sent as a file when non-empty' },
      { key: 'outputVar', kind: 'text', default: 'telegram' },
    ],
    async run(props, ctx, api, info) {
      const ok = await api.telegram(render(props.text, ctx), render(props.attachment, ctx),
        { runId: ctx.trigger?.run?.id ?? null, flowRunId: info?.flowRunId ?? null })
      return { msg: ok ? 'sent' : 'not delivered (token/chat missing or unreachable)', output: { delivered: ok } }
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
 * shape. Returns a list of problems (empty = valid). Walks recursively so
 * a broken step inside a branch is found too.
 */
export function validateDefinition(def) {
  const problems = []
  const walk = (seq, where) => {
    if (!Array.isArray(seq)) { problems.push(`${where}: sequence is not a list`); return }
    seq.forEach((step, i) => {
      const at = `${where}[${i}]`
      const s = STEP_MAP[step?.type]
      if (!s) { problems.push(`${at}: unknown step type '${step?.type}'`); return }
      const props = step.properties ?? {}
      for (const f of s.fields) {
        if (!f.required) continue
        if (f.showIf && Object.entries(f.showIf).some(([k, v]) => props[k] !== v)) continue
        const v = props[f.key]
        const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)
        if (empty) problems.push(`${step.name || step.type}: '${f.key}' is required`)
      }
      if (s.component === 'switch') {
        for (const b of s.branches) walk(step.branches?.[b] ?? [], `${at}.${b}`)
      }
      if (s.component === 'container') walk(step.sequence ?? [], `${at}.body`)
    })
  }
  walk(def?.sequence, 'sequence')
  return problems
}
