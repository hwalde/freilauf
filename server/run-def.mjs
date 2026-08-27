// cc-hub — the run definition: ONE description of what a run is made of.
//
// An agent and a single run differ in exactly two things: an agent has a name
// and a schedule and can be started again, a single run cannot. Everything else
// — coding agent, provider, model, effort, prompt, branch rule, expected
// duration, extra skills — is the SAME definition. It used to be written out
// four times (agent form, single-run form, JSON API, flow step), and the copies
// drifted: the single-run form forgot the branch mode it was prefilled with,
// the JSON API saved an agent without provider/effort/skills, and only the
// agent form validated the branch rule.
//
// Hence this module. It owns:
//   - the form block both forms embed          (runDefFields)
//   - form  → definition, with validation      (runDefFromForm)
//   - agent row → definition and back          (defFromAgent, saveAgent)
//   - the field list the flow designer shows   (RUN_DEF_FLOW_FIELDS)
//   - what was chosen last time                (rememberRunChoice, lastRunChoice)
//   - and, for the single run alone, its title and planned start
//     (runStartFields, runStartFromForm) — the two things an agent already has
//     in its name and its schedule
//
// The one place that turns a definition into a running run is
// startRun() in scheduler.mjs.
import db, { getRepo, getSetting, setSetting } from './db.mjs'
import { escapeHtml as e, toDbUtc } from './util.mjs'
import { TITLE_MAX } from './title.mjs'
import { providersForHarness, enabledCodingAgents } from './coding-agents.mjs'
import { getHarness } from './harnesses/index.mjs'
import { effortOptionen } from './models.mjs'
import { branchWorktree } from './runner.mjs'
import { skillFelder, skillsAusFormular } from './zusaetze.mjs'
import { flowAttachFields, attachmentsFromForm } from './flows/attach.mjs'
import { t } from './i18n.mjs'

/** 'keiner' = detached worktree, 'neu' = create a branch, 'fest' = use an existing one. */
export const BRANCH_MODES = ['keiner', 'neu', 'fest']

const branchLabel = (m) => m === 'neu' ? t('branch.new') : m === 'fest' ? t('branch.fixed') : t('branch.none')

export const DEFAULT_EXPECTED_MINUTES = 45

// ---------------------------------------------------------------- form block

/** Harness <select> options from the CONFIGURED coding agents. */
function harnessOptions(selected) {
  return enabledCodingAgents().map(a =>
    `<option value="${e(a.harness)}" ${selected === a.harness ? 'selected' : ''}>${e(a.plugin.label)}</option>`).join('')
}

/**
 * Provider and model selection.
 *
 * The list is not embedded server-side but fetched afterwards: if a provider
 * API hangs, a text field is still there immediately to type the slug into.
 * <datalist> provides the search for free.
 */
function modelFields(a = {}) {
  return `
  <label id="prov-label">Provider
    <select name="provider" id="prov" data-gewaehlt="${e(a.provider ?? '')}">
      <option value="">${e(t('model.provider_none'))}</option>
    </select>
    <span class="dim" id="prov-hint"></span>
  </label>

  <label>${e(t('agents.model'))}
    <input name="model" id="model" list="modelle" autocomplete="off" value="${e(a.model ?? '')}"
           placeholder="${e(t('model.model_ph'))}">
    <datalist id="modelle"></datalist>
  </label>
  <p class="dim" id="model-hint"></p>

  <label id="effort-label" hidden>${e(t('model.effort'))}
    <select name="effort" id="effort" data-gewaehlt="${e(a.effort ?? '')}">
      <option value="">${e(t('model.effort_default'))}</option>
    </select>
    <span class="dim" id="effort-hint"></span>
  </label>

  <fieldset class="zeitplan" id="or-routing" hidden>
    <legend>${e(t('or.legend'))}</legend>
    <label class="chk"><input type="checkbox" name="or_pin" value="1" id="or-pin" ${a.or_provider ? 'checked' : ''}>
      ${e(t('or.pin'))}</label>
    <label id="or-prov-label" ${a.or_provider ? '' : 'hidden'}>${e(t('or.provider_label'))}
      <select name="or_provider" id="or-prov"><option value="${e(a.or_provider ?? '')}">${e(a.or_provider ?? '')}</option></select>
    </label>
    <p class="dim">${e(t('or.hint'))}</p>
  </fieldset>`
}

/**
 * The SETUP part of the definition: which coding agent runs the task, on which
 * provider, with which model and effort. Split out of `runDefFields` because a
 * favorite (server/favorites.mjs) is exactly this part and nothing else — the
 * prompt, the branch rule and the duration belong to the task, not to the setup.
 */
export function runSetupFields(a = {}) {
  return `
  <label>${e(t('agents.harness'))} <select name="harness">${harnessOptions(a.harness)}</select></label>
  ${modelFields(a)}`
}

/**
 * The branch rule as form fields — used by both run forms and by the Quick-Run
 * dialog, which is the one place where a favorite's setup meets a task.
 * `data-branch-mode` lets hub.js hide the pattern where "no branch" is chosen.
 */
export function branchFields(a = {}) {
  return `
  <label>${e(t('runform.branch_mode'))} <select name="branch_mode" data-branch-mode>
    ${BRANCH_MODES.map(m => `<option value="${m}" ${a.branch_mode === m ? 'selected' : ''}>${e(branchLabel(m))}</option>`).join('')}
  </select></label>
  <label data-branch-pattern>${e(t('runform.branch_pattern'))} <input name="branch_pattern" value="${e(a.branch_pattern ?? '')}" placeholder="${e(t('runform.branch_pattern_ph'))}"></label>`
}

/**
 * The definition as form fields — embedded IDENTICALLY by the agent form and
 * the single-run form. `a` is an agent row, a remembered choice or {}.
 */
export function runDefFields(a = {}) {
  return `
  ${runSetupFields(a)}
  <label>${e(t('runform.prompt'))} <textarea name="prompt" rows="10" required>${e(a.prompt ?? '')}</textarea></label>
  ${branchFields(a)}
  <label>${e(t('runform.expected'))} <input type="number" name="expected_minutes" min="1" value="${a.expected_minutes ?? DEFAULT_EXPECTED_MINUTES}"></label>
  ${skillFelder(a.skills)}
  ${flowAttachFields(a.flows)}`
}

// ---------------------------------------------------------- form → definition

/**
 * Provider fields from the form. A serving provider is ONLY taken over when it
 * can technically be passed through (opencode + OpenRouter + checkbox) —
 * otherwise the DB would hold a promise that silently falls off at start.
 */
function providerFromForm(b, problems) {
  const provider = b.provider ?? ''
  // Not just "do we know the provider", but "can this harness use it HERE with
  // the operator's configuration" — otherwise the DB would store a combination
  // that fails at start.
  const allowed = providersForHarness(b.harness).map(p => p.id)
  if (provider !== '' && !allowed.includes(provider)) {
    const plugin = getHarness(b.harness)
    problems.push(plugin?.subscription
      ? t('form.subscription_no_provider', { harness: b.harness })
      : t('form.provider_unavailable', { provider, harness: b.harness, list: allowed.join(', ') || '—' }))
    return { provider: null, or_provider: null }
  }
  const pin = b.or_pin === '1' && b.harness === 'opencode' && provider === 'openrouter'
  return { provider: provider || null, or_provider: pin ? (b.or_provider?.trim() || null) : null }
}

/**
 * Validate the effort level. Same strictness as the serving provider: only
 * what actually arrives for exactly this combination is taken over. opencode
 * silently discards an unknown level, hermes checks nothing — a passed-through
 * nonsense value would fizzle silently and nobody would know the setting does
 * nothing.
 */
async function effortFromForm(b, problems) {
  const wanted = (b.effort ?? '').trim()
  if (!wanted) return null
  const r = await effortOptionen(b.harness, b.provider ?? '', b.model ?? '')
  if (!r.stufen?.includes(wanted)) {
    problems.push(t('form.effort_invalid', {
      effort: wanted,
      target: b.harness + (b.model ? ` (${b.model})` : ''),
      list: r.stufen ? r.stufen.join(', ') : t(r.hinweisKey ?? 'effort.unknown'),
    }))
    return null
  }
  return wanted
}

/**
 * Branch expectation "fixed" with a branch that another worktree already holds
 * cannot work — git grants a branch to exactly one worktree, and the classic
 * case is the repo's base branch, which the main checkout itself has. Without
 * this check the mistake only surfaced as a failed run at 'git worktree add'.
 * A pattern with placeholders is only resolved at start; that case stays with
 * the check in the runner (makeWorktree).
 */
async function fixedBranchProblem(b, problems) {
  const branch = b.branch_pattern?.trim()
  if (!branch || branch.includes('{')) return
  const repo = getRepo(+b.repo_id)
  if (!repo) return
  const worktree = await branchWorktree(repo.path, branch)
  if (worktree) problems.push(t('run.branch_in_use', { branch, worktree }))
}

/**
 * Coding agent, provider, model and effort out of a form body — with exactly the
 * validation `runDefFromForm` applies, because it IS that part of it. A favorite
 * saves this and nothing more, and a Quick Run turns it back into a form body,
 * so what is stored under a name can never mean something else than what the
 * run form would have made of the same inputs.
 */
export async function runSetupFromForm(b, problems = []) {
  const harness = String(b.harness ?? '')
  if (!getHarness(harness)) problems.push(t('run.unknown_harness', { harness }))
  else if (!enabledCodingAgents().some(a => a.harness === harness)) {
    problems.push(t('run.harness_not_configured', { harness }))
  }
  const pv = providerFromForm(b, problems)
  const effort = await effortFromForm(b, problems)
  return {
    harness,
    model: b.model?.trim() || null,
    provider: pv.provider,
    orProvider: pv.or_provider,
    effort,
  }
}

/**
 * Read the definition out of a form body and validate it — the SAME checks for
 * the agent form, the single-run form and the JSON API. Problems are collected
 * in `problems`; a definition is returned in any case, so the caller decides
 * whether to show the problem page or answer with JSON.
 */
export async function runDefFromForm(b, problems = []) {
  const setup = await runSetupFromForm(b, problems)
  const prompt = String(b.prompt ?? '')
  if (!prompt.trim()) problems.push(t('form.prompt_missing'))
  const branchMode = String(b.branch_mode ?? '')
  if (!BRANCH_MODES.includes(branchMode)) problems.push(t('form.branch_mode_unknown', { mode: branchMode }))
  if (branchMode !== 'keiner' && !b.branch_pattern?.trim()) problems.push(t('form.branch_missing'))
  if (branchMode === 'fest') await fixedBranchProblem(b, problems)
  return {
    ...setup,
    prompt,
    branchMode,
    branchPattern: b.branch_pattern?.trim() || null,
    expectedMinutes: +b.expected_minutes || DEFAULT_EXPECTED_MINUTES,
    skills: skillsAusFormular(b),
    flows: attachmentsFromForm(b),
  }
}

// -------------------------------------------------------- agent row ↔ definition

/** Agent row (DB columns) → definition, the shape createRun() and the flows expect. */
export function defFromAgent(agent) {
  return {
    harness: agent.harness,
    model: agent.model ?? null,
    provider: agent.provider ?? null,
    orProvider: agent.or_provider ?? null,
    effort: agent.effort ?? null,
    prompt: agent.prompt,
    branchMode: agent.branch_mode,
    branchPattern: agent.branch_pattern ?? null,
    expectedMinutes: agent.expected_minutes,
    skills: agent.skills ?? null,
    flows: agent.flows ?? null,
  }
}

/**
 * Create or update an agent from a definition — the only place that writes the
 * agents table. `schedule` may be omitted (the single-run form's "save as
 * agent" saves the definition without a schedule; the agent then runs manually).
 */
export function saveAgent({ id = null, repoId, name, def, schedule = null, active = 1 }) {
  const zp = schedule ?? { schedule: null, kind: 'manuell', days: null, time: null, weeks: null, anchor: null, run_at: null }
  if (id) {
    // A single UPDATE — before, 'active' was first set to 1 and then derived
    // again from exactly that freshly written value.
    db.prepare(`UPDATE agents SET name=?, harness=?, model=?, prompt=?, branch_mode=?, branch_pattern=?,
                expected_minutes=?, schedule=?, schedule_kind=?, schedule_days=?, schedule_time=?,
                schedule_weeks=?, schedule_anchor=?, run_at=?, provider=?, or_provider=?, effort=?,
                skills=?, flows=?, active=?, updated_at=datetime('now') WHERE id=?`).run(
      name, def.harness, def.model, def.prompt, def.branchMode, def.branchPattern,
      def.expectedMinutes, zp.schedule, zp.kind, zp.days, zp.time, zp.weeks, zp.anchor, zp.run_at,
      def.provider, def.orProvider, def.effort, def.skills, def.flows ?? null, active, id)
    return id
  }
  const r = db.prepare(`INSERT INTO agents(repo_id,name,harness,model,prompt,branch_mode,branch_pattern,expected_minutes,
              schedule,schedule_kind,schedule_days,schedule_time,schedule_weeks,schedule_anchor,run_at,
              provider,or_provider,effort,skills,flows,active)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    repoId, name, def.harness, def.model, def.prompt, def.branchMode,
    def.branchPattern, def.expectedMinutes,
    zp.schedule, zp.kind, zp.days, zp.time, zp.weeks, zp.anchor, zp.run_at,
    def.provider, def.orProvider, def.effort, def.skills, def.flows ?? null, active)
  return Number(r.lastInsertRowid)
}

// ------------------------------------------------------- agent lifecycle

/**
 * Whether a name is already used in a repo — the check the agents table now
 * enforces itself (`UNIQUE(repo_id, name)`). The form reports this as a
 * readable problem instead of letting SQLite's constraint surface as a 500.
 */
export function agentNameTaken(repoId, name, excludeId = null) {
  return excludeId
    ? !!db.prepare('SELECT id FROM agents WHERE repo_id=? AND name=? AND id<>?').get(repoId, name, excludeId)
    : !!db.prepare('SELECT id FROM agents WHERE repo_id=? AND name=?').get(repoId, name)
}

/**
 * The datetime suffix for a name collision on move: `2026-08-27-143055`
 * (UTC, second precision — the while-loop in moveAgent makes even two moves
 * in the same second distinct).
 */
export function moveSuffix(now = new Date()) {
  return now.toISOString().slice(0, 19).replace('T', '-').replace(/:/g, '')
}

/**
 * Move an agent to another repo. The name must stay unique THERE, so a
 * collision appends the datetime suffix — the one place that decides this,
 * so the form handler and the tests judge the same code.
 * Returns { ok, name?, repoId? } or { ok:false, error }.
 */
export function moveAgent(id, targetRepoId) {
  const agent = db.prepare('SELECT * FROM agents WHERE id=?').get(id)
  if (!agent) return { ok: false, error: t('agents.not_found') }
  const target = db.prepare('SELECT id FROM repos WHERE id=?').get(targetRepoId)
  if (!target) return { ok: false, error: t('agents.move_bad_repo') }
  if (targetRepoId === agent.repo_id) return { ok: false, error: t('agents.move_same_repo') }
  let name = agent.name
  while (agentNameTaken(targetRepoId, name, id)) name = `${agent.name}-${moveSuffix()}`
  db.prepare(`UPDATE agents SET repo_id=?, name=?, updated_at=datetime('now') WHERE id=?`)
    .run(targetRepoId, name, id)
  return { ok: true, name, repoId: targetRepoId }
}

/**
 * Delete an agent. Its past runs survive: the run carries the definition copy
 * (title, prompt, harness, …) and only the reference is cut first, so the
 * delete stays clean even with foreign keys enabled.
 */
export function deleteAgent(id) {
  db.prepare('UPDATE runs SET agent_id=NULL WHERE agent_id=?').run(id)
  db.prepare('DELETE FROM agents WHERE id=?').run(id)
}

// ----------------------------------- single run only: title and planned start

/**
 * How a single run enters the world. 'in' is only the convenient form of 'at'
 * ("in 20 minutes") and is resolved right here — the DB knows two waiting
 * kinds, not three.
 */
export const START_MODES = ['now', 'at', 'in', 'idle']

/**
 * Title and start time — the two things a single run has and an AGENT does not:
 * an agent already carries a name and a schedule. Hence these blocks sit next
 * to runDefFields() instead of inside it, and only the single-run form embeds
 * them: the title at the top, where one names a thing, the start time at the
 * bottom, next to the button that sets it off.
 */
export function runTitleField(v = {}) {
  return `
  <label>${e(t('runform.title_field'))}
    <input name="title" maxlength="${TITLE_MAX}" value="${e(v.title ?? '')}" placeholder="${e(t('runform.title_ph'))}">
    <span class="dim">${e(t('runform.title_hint'))}</span>
  </label>`
}

export function runStartTimeFields(v = {}) {
  const mode = START_MODES.includes(v.start_mode) ? v.start_mode : 'now'
  const modes = [
    ['now', t('start.mode_now')],
    ['at', t('start.mode_at')],
    ['in', t('start.mode_in')],
    ['idle', t('start.mode_idle')],
  ]
  // `data-start-switch` instead of an id: the Quick-Run dialog sits in the layout
  // of EVERY page, so this block exists twice on the single-run form — and two
  // elements with the same id are one element too many for a `getElementById`.
  return `
  <fieldset class="zeitplan">
    <legend>${e(t('start.legend'))}</legend>
    <label>${e(t('start.mode'))} <select name="start_mode" data-start-switch>
      ${modes.map(([id, label]) => `<option value="${id}" ${mode === id ? 'selected' : ''}>${e(label)}</option>`).join('')}
    </select></label>
    <div class="st" data-mode="at">
      <label>${e(t('start.at_label'))} <input type="datetime-local" name="start_at" value="${e(v.start_at ?? '')}"></label>
    </div>
    <div class="st" data-mode="in">
      <label>${e(t('start.in_label'))} <input type="number" name="start_in_minutes" min="1" step="1" value="${e(v.start_in_minutes ?? '30')}"></label>
    </div>
    <div class="st" data-mode="idle">
      <p class="dim">${e(t('start.idle_hint'))}</p>
    </div>
  </fieldset>`
}

/**
 * Title and start time out of the form — the counterpart to runDefFromForm(),
 * used by the single-run form and by POST /api/runs alike. Returns what
 * startRun() takes as options; the mode 'in' has already become a point in
 * time here.
 */
export function runStartFromForm(b, problems = [], nowMs = Date.now()) {
  const title = String(b.title ?? '').trim().slice(0, TITLE_MAX) || null
  const mode = String(b.start_mode ?? 'now')
  if (!START_MODES.includes(mode)) {
    problems.push(t('start.err_mode', { mode }))
    return { title, startMode: 'now', startAt: null }
  }
  if (mode === 'at') {
    // <input type="datetime-local"> sends LOCAL time without a zone; the hub
    // runs on the same machine as the browser's operator, so Date() reads it
    // the way it was meant, and the DB gets UTC as everywhere else.
    const ms = Date.parse(String(b.start_at ?? '').trim())
    if (!Number.isFinite(ms)) {
      problems.push(t('start.err_at'))
      return { title, startMode: 'now', startAt: null }
    }
    return { title, startMode: 'at', startAt: toDbUtc(ms) }
  }
  if (mode === 'in') {
    const min = Number(b.start_in_minutes)
    if (!Number.isFinite(min) || min <= 0) {
      problems.push(t('start.err_in'))
      return { title, startMode: 'now', startAt: null }
    }
    return { title, startMode: 'at', startAt: toDbUtc(nowMs + min * 60_000) }
  }
  if (mode === 'idle') return { title, startMode: 'idle', startAt: null }
  return { title, startMode: 'now', startAt: null }
}

// ------------------------------------------------------------ last used choice

const LAST_CHOICE_KEY = 'last_run_choice'

/** The stored blob, in the current shape. Old single-entry blobs are lifted. */
function choiceStore() {
  let v
  try { v = JSON.parse(getSetting(LAST_CHOICE_KEY) ?? 'null') } catch { return { harness: null, byHarness: {} } }
  if (!v || typeof v !== 'object') return { harness: null, byHarness: {} }
  // Before, exactly ONE setup was remembered — that one belongs to its harness.
  if (!v.byHarness) {
    return v.harness ? { harness: v.harness, byHarness: { [v.harness]: setupOf(v) } } : { harness: null, byHarness: {} }
  }
  return { harness: v.harness ?? null, byHarness: v.byHarness ?? {} }
}

/** Only the four setup fields, in the shape the form block reads (agent row keys). */
function setupOf(v = {}) {
  return {
    provider: v.provider ?? null,
    model: v.model ?? null,
    or_provider: v.or_provider ?? null,
    effort: v.effort ?? null,
  }
}

/**
 * Remember provider, model, serving provider and effort of the last definition
 * the operator sent off — PER coding agent. In practice the next run wants the
 * same combination, and picking a model from a 200-entry list again every time
 * is exactly the kind of work a form should do for you.
 *
 * Per coding agent, because the setups are not interchangeable: an opencode
 * model slug is nothing claude could run, and an effort level cursor knows sits
 * inside its model ID. Whoever switches the coding agent in the form must not
 * keep the previous one's model — hence one entry per harness plus the harness
 * that was used last (that one opens the form).
 *
 * Deliberately only these four fields: prompt, branch rule and duration belong
 * to the task, not to the setup.
 */
export function rememberRunChoice(def) {
  if (!def?.harness) return
  const store = choiceStore()
  store.harness = def.harness
  store.byHarness[def.harness] = setupOf({
    provider: def.provider ?? null,
    model: def.model ?? null,
    or_provider: def.orProvider ?? null,
    effort: def.effort ?? null,
  })
  setSetting(LAST_CHOICE_KEY, JSON.stringify(store))
}

/**
 * What this coding agent was last run with — `{ harness, provider, model,
 * or_provider, effort }`, the fields empty when nothing is remembered for it.
 * The form asks for exactly this when the coding agent is switched, so no
 * setting of the previous one is left standing.
 */
export function lastRunChoiceFor(harness) {
  if (!harness || !enabledCodingAgents().some(a => a.harness === harness)) return {}
  return { harness, ...setupOf(choiceStore().byHarness[harness]) }
}

/** The remembered choice in the shape the form block reads (agent row keys), or {}. */
export function lastRunChoice() {
  const store = choiceStore()
  // A coding agent that has since been switched off must not silently
  // preselect itself — the form would offer something the hub refuses.
  if (!store.harness || !enabledCodingAgents().some(a => a.harness === store.harness)) return {}
  return { harness: store.harness, ...setupOf(store.byHarness[store.harness]) }
}

// ------------------------------------------------------------------- flows

/**
 * The same definition as property fields for the flow designer ("start single
 * run"). One list, so a field cannot exist in the form and be missing in the
 * flow — which is exactly how the flow step lost provider pinning and skills.
 */
export const RUN_DEF_FLOW_FIELDS = [
  { key: 'harness', kind: 'harness', required: true },
  { key: 'provider', kind: 'text', placeholder: 'openrouter / opencode-zen / … (as in the run form)' },
  { key: 'model', kind: 'text' },
  { key: 'effort', kind: 'text' },
  { key: 'prompt', kind: 'textarea', required: true, placeholder: 'Review the report:\n{{trigger.run.report}}' },
  { key: 'branchMode', kind: 'select', options: BRANCH_MODES, default: 'keiner' },
  { key: 'branchPattern', kind: 'text', placeholder: 'flow/{date}-{kurz}' },
  { key: 'expectedMinutes', kind: 'number', default: DEFAULT_EXPECTED_MINUTES },
]

/** Flow step properties (already rendered templates) → definition. */
export function defFromFlowProps(props) {
  return {
    harness: props.harness,
    model: props.model || null,
    provider: props.provider || null,
    orProvider: null,
    effort: props.effort || null,
    prompt: props.prompt,
    branchMode: props.branchMode || 'keiner',
    branchPattern: props.branchPattern || null,
    expectedMinutes: Number(props.expectedMinutes) || DEFAULT_EXPECTED_MINUTES,
    skills: null,
    // Deliberately no attached flows: a run a flow starts must not start flows
    // itself — that is the loop guard, and a flow that wants to react to its own
    // run uses "wait" on the start step instead.
    flows: null,
  }
}
