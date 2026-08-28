// cc-hub flows — the typed variable catalog: which variables exist at a given
// point in a definition, of which type and with which allowed values.
//
// This is what turns "type {{vars.extracted.needs_review}} and hope" into a
// choice: the designer offers only variables that exist at that spot, filters
// the operators by their type and lets a boolean or an enum be *picked*
// instead of typed. The same functions run on the server, so the designer and
// validateDefinition() judge a flow by identical rules.
//
// Pure — no database, no DOM, no Node API. server/web.mjs serves this file and
// template.mjs next to it verbatim to the browser under /static/flows/, which
// is why the relative import below keeps working in both worlds. Whatever gets
// imported here must stay just as free of Node.
import { OPS, varName } from './template.mjs'

export const TYPES = ['string', 'number', 'boolean', 'string_list', 'object', 'any']
export const RUN_STATUSES = ['scheduled', 'deferred', 'running', 'waiting_help', 'done', 'failed', 'aborted']
export const RUN_OUTCOMES = ['done', 'failed', 'aborted']
export const TRIGGER_ROOTS = ['trigger', 'vars', 'flow']
export const TRIGGER_KINDS = ['run_finished', 'run_merged', 'cron', 'manual']
// What the merge integrator writes into `runs.merge_status` — copied here, not
// imported, because this module has to stay free of anything the browser cannot
// run. A run of an installation without the integrator reports '' instead.
export const MERGE_STATUSES = [
  'nothing', 'merged', 'resolving', 'blocked_dirty', 'blocked_conflict', 'blocked_error',
  'blocked_no_remote', 'unmerged_commits', 'unmerged_dirty', 'unmerged_both', 'skipped_by_operator',
]

/** What actions.runInfo() delivers — the only picture a flow ever has of a run. */
export const RUN_SHAPE = {
  type: 'object',
  props: {
    id: { type: 'string' },
    short_id: { type: 'string' },
    status: { type: 'string', enum: RUN_STATUSES },
    // '' while the run is still going, hence not an enum-only field
    outcome: { type: 'string', enum: RUN_OUTCOMES },
    ended_normally: { type: 'boolean' },
    agent_id: { type: 'number' },
    agent_name: { type: 'string' },
    repo_id: { type: 'number' },
    repo_name: { type: 'string' },
    repo_path: { type: 'string' },
    harness: { type: 'string' },
    model: { type: 'string' },
    provider: { type: 'string' },
    branch: { type: 'string' },
    pr_url: { type: 'string' },
    report: { type: 'string' },
    help_text: { type: 'string' },
    exit_code: { type: 'number' },
    duration_min: { type: 'number' },
    started_at: { type: 'string' },
    ended_at: { type: 'string' },
    incidents: { type: 'number' },
    worktree: { type: 'string' },
    url: { type: 'string' },
    flow_run_id: { type: 'string' },
    merge_status: { type: 'string', enum: MERGE_STATUSES },
    merged_sha: { type: 'string' },
  },
}

/**
 * `trigger.merge` — the integration itself, and only under the `run_merged`
 * trigger. `sha` is what landed, `base` the branch it landed on,
 * `resolver_run_id` the conflict run that made it mergeable (empty when there
 * was none) and `files` the paths the merge changed.
 */
export const MERGE_SHAPE = {
  type: 'object',
  props: {
    sha: { type: 'string' },
    base: { type: 'string' },
    resolver_run_id: { type: 'string' },
    files: { type: 'string_list' },
  },
}

// ---------------- operators per type ----------------

/** Operators that ignore the right side — the designer hides the value field. */
export const UNARY_OPS = ['empty', 'not_empty', 'truthy', 'falsy']
const NUMERIC_OPS = ['eq', 'neq', 'gt', 'lt', 'gte', 'lte']

// Only what compare() can actually decide for that type. A boolean against
// "contains" is not a bug in compare(), it is a question without an answer.
const OPS_BY_TYPE = {
  boolean: ['truthy', 'falsy', 'eq', 'neq'],
  number: [...NUMERIC_OPS, 'empty', 'not_empty'],
  string_list: ['contains', 'not_contains', 'empty', 'not_empty', 'truthy', 'falsy'],
  object: ['contains', 'not_contains', 'empty', 'not_empty', 'truthy', 'falsy'],
}
export const opsForType = (type) => OPS_BY_TYPE[type] ?? OPS

/** The values a typed field can take at all — the designer makes a select of them. */
export function valuesFor(entry) {
  if (!entry) return null
  if (entry.type === 'boolean') return ['true', 'false']
  return entry.enum?.length ? [...entry.enum] : null
}

// ---------------- shapes ----------------

/** Flatten a shape into `{ path, type, enum }` entries — objects yield themselves and their fields. */
export function shapePaths(root, shape) {
  const s = shape ?? { type: 'any' }
  if (s.type === 'object' && s.props) {
    return [{ path: root, type: 'object', enum: null },
      ...Object.entries(s.props).flatMap(([k, v]) => shapePaths(`${root}.${k}`, v))]
  }
  return [{ path: root, type: TYPES.includes(s.type) ? s.type : 'any', enum: s.enum?.length ? [...s.enum] : null }]
}

/**
 * The shape of a step's output variable. `outputShape` in the registry is
 * either a literal shape or `{ from: … }` for the two cases that depend on the
 * step's own properties: the fields of an extraction and "wait for the run".
 * No shape at all means `any` — nothing about it can be checked, and nothing is.
 */
export function outputShapeOf(step, meta) {
  const decl = meta?.outputShape
  if (!decl) return { type: 'any' }
  if (decl.from === 'extract_fields') {
    const props = {}
    for (const f of step?.properties?.fields ?? []) {
      // Same sanitizing as llm.mjs schemaFromFields() — "is done" really does
      // become vars.<out>.is_done, and the designer says so.
      const name = varName(f?.name, '')
      if (!name) continue
      const type = TYPES.includes(f?.type) ? f.type : 'string'
      const list = String(f?.enumValues ?? '').split(',').map(s => s.trim()).filter(Boolean)
      props[name] = { type, enum: type === 'string' && list.length ? list : null }
    }
    return { type: 'object', props }
  }
  if (decl.from === 'run_if_wait') return step?.properties?.wait ? RUN_SHAPE : (decl.otherwise ?? { type: 'any' })
  // A step whose output depends on one of its own switches: `shell_command`
  // detached reports that it was detached, and nothing else.
  if (decl.from === 'if_field') return (step?.properties?.[decl.field] ? decl.then : decl.otherwise) ?? { type: 'any' }
  return decl
}

// ---------------- scope ----------------

const subSequences = (step) => [
  ...(step?.branches ? Object.values(step.branches) : []),
  ...(step?.sequence ? [step.sequence] : []),
]

/**
 * A place in the tree: either an existing step (`'<id>'`) or a spot a step is
 * about to be dropped into (`{ sequence, index }`, the live array by
 * reference — that is what the designer hands us while dragging).
 */
function asTarget(at) {
  if (typeof at === 'string' && at) return { stepId: at }
  if (at && Array.isArray(at.sequence)) return { sequence: at.sequence, index: at.index ?? 0 }
  return {}
}

function containsTarget(step, target) {
  for (const sub of subSequences(step)) {
    if (target.sequence && sub === target.sequence) return true
    for (const st of sub ?? []) {
      if (target.stepId && st?.id === target.stepId) return true
      if (containsTarget(st, target)) return true
    }
  }
  return false
}

/**
 * Every variable readable at `stepId` (null = the whole flow, for the root
 * editor). Order matters: a variable exists only after the step that writes
 * it. One written inside a branch or a loop body of an *earlier* step is
 * marked `conditional` — it may or may not have been set by the time the flow
 * arrives here, so it is offered but never warned about. `type: 'any'` means
 * "not describable" (set_var, an HTTP response) and silences every check below it.
 */
export function varsInScope(definition, stepMeta, at = null, trigger = null) {
  const target = asTarget(at)
  const out = []
  const seen = new Set()
  const add = (root, shape, from, conditional) => {
    for (const p of shapePaths(root, shape)) {
      if (seen.has(p.path)) continue
      seen.add(p.path)
      out.push({ ...p, from, conditional: !!conditional })
    }
  }

  add('trigger.kind', { type: 'string', enum: TRIGGER_KINDS }, 'trigger', false)
  add('trigger.at', { type: 'string' }, 'trigger', false)
  add('flow.id', { type: 'number' }, 'flow', false)
  add('flow.name', { type: 'string' }, 'flow', false)
  // A cron flow has no trigger run at all; a manual one only when "run now"
  // was given one — offered, but flagged as not guaranteed.
  const kind = trigger?.kind ?? 'run_finished'
  if (kind !== 'cron') add('trigger.run', RUN_SHAPE, 'trigger', kind === 'manual')
  // The merge exists under its own trigger and nowhere else — offering
  // {{trigger.merge.sha}} in a cron flow would promise a value that is never there.
  if (kind === 'run_merged') add('trigger.merge', MERGE_SHAPE, 'trigger', false)

  // The element type of a loop is the item type of the list it walks — known
  // whenever the list is a plain {{path}} into a described string_list.
  const itemType = (step) => {
    const m = String(step?.properties?.list ?? '').trim().match(/^\{\{\s*([^}|]+?)\s*\}\}$/)
    const found = m ? out.find(v => v.path === m[1].trim()) : null
    return found?.type === 'string_list' ? 'string' : 'any'
  }
  const loopVars = (st, conditional) => {
    const v = varName(st?.properties?.itemVar, 'item')
    const from = st?.name || st?.type
    add(`vars.${v}`, { type: itemType(st) }, from, conditional)
    add(`vars.${v}_index`, { type: 'number' }, from, conditional)
  }
  const stepVars = (st, conditional) => {
    const meta = stepMeta?.[st?.type]
    if (meta?.output) add(`vars.${varName(st?.properties?.outputVar, st.type)}`, outputShapeOf(st, meta), st?.name || st?.type, conditional)
    if (st?.type === 'for_each') loopVars(st, conditional)
  }
  const collectAll = (seq) => {
    for (const st of seq ?? []) { stepVars(st, true); for (const sub of subSequences(st)) collectAll(sub) }
  }

  const walk = (seq) => {
    const list = seq ?? []
    for (let i = 0; i < list.length; i++) {
      const st = list[i]
      if (target.sequence === seq && target.index === i) return true   // the drop spot
      if (target.stepId && st?.id === target.stepId) return true       // reached it — nothing after is in scope
      if (containsTarget(st, target)) {
        // We are somewhere inside this step: its loop element is in scope, its
        // own output variable is not — the step has not finished yet.
        if (st.type === 'for_each') loopVars(st, false)
        for (const sub of subSequences(st)) {
          if (sub === target.sequence || (sub ?? []).some(x => (target.stepId && x?.id === target.stepId) || containsTarget(x, target))) { walk(sub); break }
        }
        return true
      }
      stepVars(st, false)                                   // a sibling that ran before us
      for (const sub of subSequences(st)) collectAll(sub)    // …and whatever its branches may have set
    }
    return target.sequence === seq                          // dropping at the very end of the target sequence
  }
  walk(definition?.sequence)
  return out
}

// ---------------- checks ----------------

/** Every `{{path}}` in a template (the `| default:` part is not a path). */
export function templatePaths(text) {
  const out = []
  String(text ?? '').replace(/\{\{\s*([^}|]+?)\s*(?:\|\s*default:\s*([^}]*?)\s*)?\}\}/g, (_, p) => { out.push(String(p).trim()); return '' })
  return out
}

/** The catalog entry a whole-value `{{path}}` points at, or null for anything else. */
export function entryFor(expr, scope) {
  const m = String(expr ?? '').trim().match(/^\{\{\s*([^}|]+?)\s*\}\}$/)
  return m ? (scope.find(v => v.path === m[1].trim()) ?? null) : null
}

/**
 * Judge one path: 'ok' | 'unknown_var' (nothing writes that variable) |
 * 'unknown_field' (the variable exists, the field does not) | 'foreign' (not
 * one of our roots — left alone). Everything below an `any` is always ok.
 */
export function pathProblem(path, scope) {
  const p = String(path ?? '').trim()
  if (!p) return 'foreign'
  if (!TRIGGER_ROOTS.includes(p.split('.')[0])) return 'foreign'
  if (scope.some(v => v.path === p)) return 'ok'
  let best = null
  for (const v of scope) if (p.startsWith(v.path + '.') && (!best || v.path.length > best.path.length)) best = v
  if (!best) return p.startsWith('vars.') ? 'unknown_var' : 'unknown_field'
  return best.type === 'object' ? 'unknown_field' : 'ok'   // below a scalar/any we cannot know
}

/**
 * Can the right side ever match the left one? Returns a warning code or null.
 * A template on the right is never judged — its value is only known at run time.
 */
export function valueProblem(entry, op, right) {
  if (!entry || UNARY_OPS.includes(op)) return null
  const r = String(right ?? '').trim()
  if (!r || r.includes('{{')) return null
  // compare() stringifies, so a boolean is only ever "true" or "false".
  if (entry.type === 'boolean') return ['true', 'false'].includes(r.toLowerCase()) ? null : 'bool_value'
  if (entry.type === 'number' && NUMERIC_OPS.includes(op) && !Number.isFinite(Number(r))) return 'number_value'
  if (entry.enum?.length && ['eq', 'neq'].includes(op) && !entry.enum.some(v => v.toLowerCase() === r.toLowerCase())) return 'enum_value'
  return null
}

/** The comparison check for steps that declare a `value` field with a `typeOf` reference. */
function compareWarning(step, meta, scope) {
  const valueField = (meta.fields ?? []).find(f => f.kind === 'value' && f.typeOf)
  if (!valueField) return null
  const props = step?.properties ?? {}
  const entry = entryFor(props[valueField.typeOf], scope)
  if (!entry || entry.type === 'any') return null
  const opKey = valueField.opOf ?? 'op'
  const op = props[opKey] || 'eq'
  if (!opsForType(entry.type).includes(op)) return { field: opKey, code: 'op_type', path: entry.path, type: entry.type }
  const code = valueProblem(entry, op, props[valueField.key])
  return code ? { field: valueField.key, code, path: entry.path, type: entry.type, allowed: valuesFor(entry) } : null
}

const TEMPLATE_KINDS = ['text', 'textarea', 'var', 'value']

/**
 * Warnings for one step: variables nothing produces, fields an extraction does
 * not have, a comparison that can never be true. Warnings, never errors — an
 * expression may legitimately reach into an HTTP response we cannot describe,
 * and a half-built flow has to stay saveable.
 */
export function stepWarnings(step, meta, scope) {
  const out = []
  if (!meta) return out
  const props = step?.properties ?? {}
  for (const f of meta.fields ?? []) {
    if (!TEMPLATE_KINDS.includes(f.kind ?? 'text')) continue
    if (f.showIf && Object.entries(f.showIf).some(([k, v]) => props[k] !== v)) continue
    for (const path of templatePaths(props[f.key])) {
      const code = pathProblem(path, scope)
      if (code === 'unknown_var' || code === 'unknown_field') out.push({ field: f.key, code, path })
    }
  }
  const cmp = compareWarning(step, meta, scope)
  if (cmp) out.push(cmp)
  return out
}

/** Every warning in a definition, each tagged with the step it belongs to. */
export function definitionWarnings(definition, stepMeta, trigger = null) {
  const out = []
  const walk = (seq) => {
    for (const st of seq ?? []) {
      const scope = varsInScope(definition, stepMeta, st?.id ?? null, trigger)
      for (const w of stepWarnings(st, stepMeta?.[st?.type], scope)) {
        out.push({ stepId: st?.id ?? null, stepName: st?.name || st?.type || '?', ...w })
      }
      for (const sub of subSequences(st)) walk(sub)
    }
  }
  walk(definition?.sequence)
  return out
}

// ---------------- placement ----------------
//
// Not every building block may sit everywhere. The rules are declared in the
// registry (`placement`), never in the client, and are enforced three times:
// the designer refuses the drop (canInsertStep), marks an already-placed step
// red (validator.step) and explains it in the property panel; the server
// repeats the check in validateDefinition() so a hand-crafted definition
// cannot slip past.

/** The sequence a step sits in, plus its index — by reference, so the caller can compare. */
export function locateStep(definition, stepId) {
  const search = (seq) => {
    const i = (seq ?? []).findIndex(st => st?.id === stepId)
    if (i >= 0) return { sequence: seq, index: i }
    for (const st of seq ?? []) {
      for (const sub of subSequences(st)) { const r = search(sub); if (r) return r }
    }
    return null
  }
  return search(definition?.sequence)
}

/** True when a `stop` sits before `index` in this sequence — everything after it is dead. */
export function afterStop(sequence, index) {
  return (sequence ?? []).slice(0, index).some(st => st?.type === 'stop')
}

/**
 * Is a finished run readable at this spot? Either the trigger delivers one
 * ('sure' for run_finished, 'maybe' for manual — "run now" may be given one)
 * or an earlier start step waited for its run ('sure'). 'no' means the step
 * could only ever take its fallback branch.
 */
export function runAvailability(scope, trigger = null) {
  const fromStep = scope.some(v => v.path !== 'trigger.run.outcome' && v.path.endsWith('.outcome') && !v.conditional)
  if (fromStep) return 'sure'
  const trig = scope.find(v => v.path === 'trigger.run.outcome')
  if (!trig) return 'no'
  return trig.conditional ? 'maybe' : 'sure'
}

/**
 * Which rule a step lives under RIGHT NOW, as an i18n suffix, or null when none
 * applies. `needsRun` comes in two shapes and they must never be confused:
 *
 *   true                      the step always needs a finished run
 *                             (`switch_outcome` — it branches on an outcome).
 *   { whenField, is }         only one field value needs one. `send_message`
 *                             and `kill_run` need a run for the target "the
 *                             trigger run" and for that target ALONE — every
 *                             other target (an agent, a repo, all running runs,
 *                             a run id) reaches runs that have nothing to do
 *                             with this flow, and works in any flow, cron
 *                             included. Advertising the rule regardless of the
 *                             selected target would claim the opposite.
 */
export function activeRuleKey(step, meta) {
  const need = meta?.placement?.needsRun
  if (need === true) return 'needs_run'
  if (need && step?.properties?.[need.whenField] === need.is) return 'needs_run_target'
  return null
}

/**
 * May this step sit at `index` of `sequence`? Returns `{ code, severity }` or
 * null. Codes are i18n suffixes: `flows.placement.<code>.rule` states the rule,
 * `flows.placement.<code>.why` explains why it is broken here.
 */
export function placementProblem(step, stepMeta, { definition, sequence, index, trigger = null }) {
  const meta = stepMeta?.[step?.type]
  if (!meta) return null
  if (afterStop(sequence, index)) return { code: 'after_stop', severity: 'error' }
  const rule = activeRuleKey(step, meta)
  if (rule) {
    const at = step?.id ? step.id : { sequence, index }
    const have = runAvailability(varsInScope(definition, stepMeta, at, trigger), trigger)
    if (have === 'no') return { code: rule, severity: 'error' }
    if (have === 'maybe') return { code: `${rule}_maybe`, severity: 'warning' }
  }
  return null
}

/** placementProblem() for a step that is already in the tree. */
export function placementOf(step, definition, stepMeta, trigger = null) {
  const at = locateStep(definition, step?.id)
  if (!at) return null
  return placementProblem(step, stepMeta, { definition, sequence: at.sequence, index: at.index, trigger })
}

/** Every placement error in a definition (warnings excluded — those are not blocking). */
export function placementErrors(definition, stepMeta, trigger = null) {
  const out = []
  const walk = (seq) => {
    (seq ?? []).forEach((st, i) => {
      const p = placementProblem(st, stepMeta, { definition, sequence: seq, index: i, trigger })
      if (p?.severity === 'error') out.push({ stepId: st?.id ?? null, stepName: st?.name || st?.type || '?', ...p })
      for (const sub of subSequences(st)) walk(sub)
    })
  }
  walk(definition?.sequence)
  return out
}
