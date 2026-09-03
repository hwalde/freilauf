// Freilauf — the run definition: ONE description of what a run is made of.
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
import { getHarness, goalSpec, harnessesWithGoal } from './harnesses/index.mjs'
import { effortOptionen } from './models.mjs'
import { branchWorktree } from './runner.mjs'
import { skillFelder, skillsAusFormular, skillListe, eintragName, eintragWert } from './zusaetze.mjs'
import { flowAttachFields, attachmentsFromForm, parseAttachments } from './flows/attach.mjs'
import { t } from './i18n.mjs'
import { KNOWN_QUANTIZATIONS, REGIONS, parseRoutingConfig } from './providers/openrouter-routing.mjs'

/** 'keiner' = detached worktree, 'neu' = create a branch, 'fest' = use an existing one. */
export const BRANCH_MODES = ['keiner', 'neu', 'fest']

/**
 * What each branch rule MEANS — one table, three consumers.
 *
 * The branch rule stopped being a yes/no about whether work reaches the base
 * branch the day the hub started integrating: under `merge_mode='hub'` the hub
 * merges every run, and the rule only decides under which NAME the work travels.
 * The form said none of that, and the prompt sentence for "no branch" still
 * promised "throwaway changes" — in the same prompt where MERGE_RULE promised
 * the opposite.
 *
 * So: the label, the explanation the form shows (per merge mode) and the
 * sentence the AGENT reads all come from here. Three copies of the same
 * statement is exactly the drift this module exists to prevent — and a
 * unit test checks that every `explain` key really exists in lang/en.json,
 * because a table may not name a string that is not there.
 *
 * `explain` values are i18n keys (UI, translated). `rule` values are English
 * constants (they go to an agent, like PLATFORM_RULES in runner.mjs) with
 * `{branch}` and `{base}` placeholders. The three `off` sentences are BYTE FOR
 * BYTE the ones that were inline in runner.mjs: with the integration switched
 * off, not one prompt may change.
 */
export const BRANCH_MODE_INFO = {
  keiner: {
    label: 'branch.none',
    explain: { off: 'branch.none.explain_off', hub: 'branch.none.explain_hub' },
    rule: {
      off: 'No branch — the worktree is detached; changes are throwaway changes.',
      hub: 'No branch — the worktree is detached; Freilauf merges your commits into {base} when you report done.',
      // Deliberately no 'keep': there is no branch to keep the work on.
    },
  },
  neu: {
    label: 'branch.new',
    explain: { off: 'branch.new.explain_off', hub: 'branch.new.explain_hub' },
    rule: {
      off: 'Create a new branch, name following the pattern {branch}.',
      hub: 'Create a new branch, name following the pattern {branch}; Freilauf merges it into {base} when you report done.',
      keep: 'Create a new branch, name following the pattern {branch}. The work STAYS on that branch: Freilauf will not merge it into {base}. Commit everything and push the branch before you report done.',
    },
  },
  fest: {
    label: 'branch.fixed',
    explain: { off: 'branch.fixed.explain_off', hub: 'branch.fixed.explain_hub' },
    rule: {
      off: 'Work on the existing branch {branch}.',
      hub: 'Work on the existing branch {branch}; Freilauf merges it into {base} when you report done.',
      keep: 'Work on the existing branch {branch}. The work STAYS on that branch: Freilauf will not merge it into {base}. Commit everything and push the branch before you report done.',
    },
  },
}

const branchLabel = (m) => t(BRANCH_MODE_INFO[m]?.label ?? 'branch.none')

/**
 * The sentence the agent reads about its branch — the one place that decides it.
 * `keep` only exists where there is a branch to keep the work on, so 'keiner'
 * falls back to the ordinary hub sentence rather than promising something it
 * cannot do.
 */
export function branchRuleText(mode, { branch = '', base = 'main', hubMerges = false, keepOnBranch = false } = {}) {
  const info = BRANCH_MODE_INFO[mode] ?? BRANCH_MODE_INFO.keiner
  const wanted = !hubMerges ? 'off' : (keepOnBranch && info.rule.keep) ? 'keep' : 'hub'
  return info.rule[wanted].replaceAll('{branch}', branch).replaceAll('{base}', base)
}

/**
 * The repo context a branch choice needs: which mode THIS repo integrates in,
 * its base branch — and the same for every repo, because one form can switch
 * repo without a page rebuild (the Quick-Run dialog has a repo <select>; the
 * header switcher reloads and needs none of this).
 */
export function branchContext(repoId = null) {
  const repos = db.prepare('SELECT id, merge_mode, base_branch FROM repos ORDER BY name').all()
  const modeOf = (r) => r?.merge_mode === 'hub' ? 'hub' : 'off'
  const here = repos.find(r => r.id === Number(repoId)) ?? repos[0] ?? null
  return {
    mergeMode: modeOf(here),
    base: here?.base_branch || 'main',
    modes: Object.fromEntries(repos.map(r => [r.id, modeOf(r)])),
    bases: Object.fromEntries(repos.map(r => [r.id, r.base_branch || 'main'])),
  }
}

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
/**
 * The OpenRouter serving-provider routing block — ONE widget with three modes:
 *
 *   offen  OpenRouter routes freely (the old default; no provider block sent)
 *   auto   the hub's best-provider selection: it fetches the model's endpoints,
 *          filters them against the requirements below (quantization, region,
 *          price caps, health, tool support), and pins the cheapest qualifying
 *          providers as an ordered fallback chain — cached per model+config
 *   pin    one serving provider, chosen by tag from the endpoint list
 *
 * Visible for provider=openrouter on EVERY harness — the pin can only be
 * PASSED THROUGH for opencode (the CLI carries it in OPENCODE_CONFIG_CONTENT);
 * hermes has no per-run provider routing. Where it cannot be passed the note
 * says so, and providerFromForm() drops the setting as it always did — visible
 * silence beats a field that pretends to do something.
 *
 * The auto requirements fold away behind <details> — they are the exception,
 * not the rule, and an always-open wall of fields teaches people to stop
 * reading forms.
 */
function orRoutingFields(a = {}) {
  let cfg = {}
  try { cfg = JSON.parse(a.or_routing ?? '') ?? {} } catch { /* old rows and nulls */ }
  const auto = cfg?.mode === 'auto' || (!a.or_provider && cfg?.quant_min !== undefined)
  const mode = a.or_provider ? 'pin' : (auto ? 'auto' : 'offen')
  return `
  <fieldset class="schedule" id="or-routing" hidden>
    <legend>${e(t('or.legend'))}</legend>
    <div class="btn-row" role="radiogroup" aria-label="${e(t('or.legend'))}">
      <label class="chk"><input type="radio" name="or_mode" value="offen" ${mode === 'offen' ? 'checked' : ''}>
        ${e(t('or.mode_offen'))}</label>
      <label class="chk"><input type="radio" name="or_mode" value="auto" ${mode === 'auto' ? 'checked' : ''}>
        ${e(t('or.mode_auto'))}</label>
      <label class="chk"><input type="radio" name="or_mode" value="pin" ${mode === 'pin' ? 'checked' : ''}>
        ${e(t('or.mode_pin'))}</label>
    </div>
    <label id="or-prov-label" ${mode === 'pin' ? '' : 'hidden'}>${e(t('or.provider_label'))}
      <select name="or_provider" id="or-prov"><option value="${e(a.or_provider ?? '')}">${e(a.or_provider ?? '')}</option></select>
    </label>
    <details id="or-auto-details" ${mode === 'auto' ? 'open' : ''} hidden>
      <summary>${e(t('or.auto_details'))}</summary>
      <label>${e(t('or.quant'))}
        <select name="or_quant" id="or-quant">
          <option value="">${e(t('or.quant_auto'))}</option>
          ${KNOWN_QUANTIZATIONS.map(q => `<option value="${q}" ${cfg.quant_min === q ? 'selected' : ''}>${q}</option>`).join('')}
        </select>
        <span class="dim">${e(t('or.quant_hint'))}</span>
      </label>
      <label>${e(t('or.region'))}
        <select name="or_region">
          ${REGIONS.map(r => `<option value="${r}" ${(cfg.location ?? 'all') === r ? 'selected' : ''}>${e(t('or.region_' + r))}</option>`).join('')}
        </select>
      </label>
      <label>${e(t('or.max_in'))}
        <input type="number" step="0.01" min="0" name="or_max_in" value="${e(cfg.max_in ?? '')}">
        <span class="dim">${e(t('or.max_hint'))}</span>
      </label>
      <label>${e(t('or.max_out'))}
        <input type="number" name="or_max_out" step="0.01" min="0" value="${cfg.max_out ?? ''}">
      </label>
    </details>
    <p class="dim">${e(t('or.hint'))}</p>
    <p class="warn" id="or-unsupported" hidden>${e(t('or.pin_unsupported'))}</p>
    <p class="dim" id="or-auto-hint" hidden></p>
  </fieldset>`
}

function modelFields(a = {}) {
  return `
  <label id="prov-label">${e(t('model.provider'))}
    <select name="provider" id="prov" data-gewaehlt="${e(a.provider ?? '')}">
      <option value="">${e(t('model.provider_none'))}</option>
    </select>
    <span class="dim" id="prov-hint"></span>
  </label>

  <label>${e(t('agents.model'))}
    <input name="model" id="model" list="modelle" autocomplete="off" value="${e(a.model ?? '')}"
           placeholder="${e(t('model.model_ph'))}">
    <datalist id="modelle"></datalist>
    <span class="dim" id="model-hint"></span>
  </label>

  <label id="effort-label" hidden>${e(t('model.effort'))}
    <select name="effort" id="effort" data-gewaehlt="${e(a.effort ?? '')}">
      <option value="">${e(t('model.effort_default'))}</option>
    </select>
    <span class="dim" id="effort-hint"></span>
  </label>

  ${orRoutingFields(a)}`
}

/**
 * The SETUP part of the definition: which coding agent runs the task, on which
 * provider, with which model and effort. Split out of `runDefFields` because a
 * favorite (server/favorites.mjs) is exactly this part and nothing else — the
 * prompt, the branch rule and the duration belong to the task, not to the setup.
 *
 * It is the ONE reusable agent+provider+model selection of the whole hub: the
 * agent form, the single-run form, the favorites and the merge settings all
 * render this same block, and a new settings page embeds it the same way. The
 * only customization is a STYLING option (`opts.wrapClass`) — a class on the
 * wrapping <fieldset> so a place can present the identical logic differently
 * (a settings page vs. the run form). Without it the markup is exactly what it
 * always was, so no existing caller changes.
 */
export function runSetupFields(a = {}, opts = {}) {
  const block = `
  <label>${e(t('agents.harness'))} <select name="harness">${harnessOptions(a.harness)}</select></label>
  ${modelFields(a)}`
  if (opts.wrapClass) return `<fieldset class="${e(opts.wrapClass)}">${block}</fieldset>`
  return block
}

/**
 * The base branch inside an explanation, as an element rather than as text.
 *
 * The Quick-Run dialog can switch repo without rebuilding the page, and a repo
 * brings its own base branch — so a sentence reading "merges into main" has to
 * be able to become "merges into trunk" in place. The interpolation therefore
 * puts a marker in and this turns the marker into a span hub.js can rewrite.
 * Everything around it is escaped first; the span is the only markup that gets
 * through.
 */
const BASE_MARK = '\u0001base\u0001'
function explainHtml(key, base) {
  return e(t(key, { base: BASE_MARK })).replaceAll(BASE_MARK, `<span data-base>${e(base)}</span>`)
}

/**
 * The branch rule as form fields — the ONE place it is rendered: the agent form,
 * the single-run form and the Quick-Run dialog all embed this and nothing else.
 *
 * A radio group with a line of explanation per option, because under
 * `merge_mode='hub'` the choice no longer means what its three words say: the
 * hub merges every run either way, and the rule only decides under which name
 * the work travels. BOTH explanations are rendered and CSS shows the one that
 * fits `data-merge-mode` — so the static case needs no JavaScript at all, and
 * the one form that can switch repo in place (Quick Run) only has to flip an
 * attribute.
 *
 * `name="branch_mode"` and its three values are unchanged, so runDefFromForm()
 * does not know the difference between a <select> and these radios.
 */
export function branchFields(a = {}, ctx = {}) {
  const mode = BRANCH_MODES.includes(a.branch_mode) ? a.branch_mode : 'keiner'
  const mergeMode = ctx.mergeMode === 'hub' ? 'hub' : 'off'
  const base = ctx.base || 'main'
  const keep = !!(a.keep_on_branch ?? a.keepOnBranch)
  const wahl = (m) => {
    const info = BRANCH_MODE_INFO[m]
    return `
    <label class="choice"><input type="radio" name="branch_mode" value="${m}" ${mode === m ? 'checked' : ''}>
      <b>${e(branchLabel(m))}</b>
      <small class="dim" data-explain="off">${explainHtml(info.explain.off, base)}</small>
      <small class="dim" data-explain="hub">${explainHtml(info.explain.hub, base)}</small></label>`
  }
  // The checkbox carries `hidden` from the server as well as the CSS rule: a
  // field that only CSS hides is a field that shows up when the stylesheet does
  // not load, and one that is hidden but still submits is worse than either.
  return `
  <fieldset class="branch-choice" data-branch-choice data-merge-mode="${mergeMode}"
            data-merge-modes="${e(JSON.stringify(ctx.modes ?? {}))}"
            data-merge-bases="${e(JSON.stringify(ctx.bases ?? {}))}">
    <legend>${e(t('runform.branch_rule'))}</legend>
    ${BRANCH_MODES.map(wahl).join('')}
    <label data-branch-pattern>${e(t('runform.branch_pattern'))} <input name="branch_pattern" value="${e(a.branch_pattern ?? '')}" placeholder="${e(t('runform.branch_pattern_ph'))}"></label>
    <label class="chk" data-hub-only ${mergeMode === 'hub' ? '' : 'hidden'}>
      <input type="checkbox" name="keep_on_branch" value="1" ${keep ? 'checked' : ''}>
      ${explainHtml('branch.keep', base)}
      <small class="dim">${e(t('branch.keep.hint'))}</small></label>
  </fieldset>`
}

/**
 * The goal: the SECOND prompt, folded away under the first one.
 *
 * It is not the task but the condition under which the task is over — and only
 * a coding agent whose plugin carries a `goal` spec knows one (claude does, as
 * `/goal <condition>`). So the block belongs to the harness, not to the form:
 * `data-goal-harnesses` names who has it, and hub.js shows or hides it when the
 * coding agent is switched. Hidden means DISABLED too, because a hidden field
 * that still submits is a text one cannot see and cannot correct.
 *
 * Open when there is a goal to see: whoever edits an agent that has one must not
 * have to find it behind a fold first.
 */
export function goalFields(a = {}) {
  const kann = harnessesWithGoal()
  if (!kann.length) return ''
  // The form shows the first configured coding agent when nothing is preselected
  // — that is what the browser picks out of a <select> without a `selected`.
  const harness = a.harness || enabledCodingAgents()[0]?.harness || ''
  const on = kann.includes(harness)
  const goal = a.goal ?? ''
  const max = goalSpec(harness)?.max ?? goalSpec(kann[0]).max
  return `
  <details class="goal" id="goal-block" data-goal-harnesses="${e(kann.join(' '))}"
           ${goal ? 'open' : ''} ${on ? '' : 'hidden'}>
    <summary>${e(t('goal.legend'))}</summary>
    <label>${e(t('goal.field'))}
      <textarea name="goal" rows="3" maxlength="${max}" placeholder="${e(t('goal.ph'))}"
                ${on ? '' : 'disabled'}>${e(goal)}</textarea>
      <span class="dim">${e(t('goal.hint'))}</span>
    </label>
  </details>`
}

/**
 * The definition as form fields — embedded IDENTICALLY by the agent form and
 * the single-run form. `a` is an agent row, a remembered choice or {}.
 */
export function runDefFields(a = {}, ctx = {}) {
  return `
  ${runSetupFields(a)}
  <label>${e(t('runform.prompt'))} <textarea name="prompt" rows="10" required>${e(a.prompt ?? '')}</textarea></label>
  ${goalFields(a)}
  ${branchFields(a, ctx)}
  <label>${e(t('runform.expected'))} <input type="number" name="expected_minutes" min="1" value="${a.expected_minutes ?? DEFAULT_EXPECTED_MINUTES}"></label>
  ${skillFelder(a.skills)}
  ${flowAttachFields(a.flows)}`
}

// ---------------------------------------------------------- form → definition

/**
 * Provider fields from the form. A serving-provider choice is ONLY taken over
 * when it can technically be passed through (opencode + OpenRouter) —
 * otherwise the DB would hold a promise that silently falls off at start.
 *
 * Three modes: `offen` (no provider block — the old default), `pin` (the tag
 * in or_provider) and `auto` (the requirements config, resolved to an ordered
 * provider chain at start — server/scheduler.mjs startRun, via the OpenRouter
 * plugin's routing capability). The parsed config is validated here: a
 * nonsense quantization minimum is a PROBLEM, never a silent "no filter".
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
    return { provider: null, or_provider: null, orRouting: null }
  }
  // The serving-provider routing only survives where it can be passed through
  // at all (opencode + OpenRouter) — the same gate the pin always had.
  const passable = b.harness === 'opencode' && provider === 'openrouter'
  if (provider !== 'openrouter') return { provider: provider || null, or_provider: null, orRouting: null }

  if (b.or_mode === 'pin') {
    return { provider, or_provider: b.or_provider?.trim() || null, orRouting: null }
  }
  if (b.or_mode === 'auto') {
    const cfg = parseRoutingConfig({
      quant_min: b.or_quant ?? '', location: b.or_region ?? 'all',
      max_in: b.or_max_in ?? '', max_out: b.or_max_out ?? '',
    })
    if (cfg.error) {
      problems.push(t('form.or_quant_unknown', { quant: cfg.error.replace('unknown quantization ', '') }))
      return { provider: provider || null, or_provider: null, orRouting: null }
    }
    if (!passable) return { provider, or_provider: null, orRouting: null }
    return { provider, or_provider: null, orRouting: cfg }
  }
  // "offen" (and anything that is not pin/auto): the empty default.
  return { provider: provider || null, or_provider: null, orRouting: null }
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
 * The goal out of the form. A coding agent that knows none simply has no goal —
 * the field is disabled there and sends nothing, so this only catches a request
 * that was not written by the form (the JSON API, a copied body).
 *
 * A leading `/goal` is stripped: whoever knows the command types it, and the
 * hub is the one that puts it in front. Too long is a problem and not a silent
 * cut — a condition trimmed in the middle would still be sent and mean
 * something else than what was written.
 */
function goalFromForm(b, problems) {
  const spec = goalSpec(String(b.harness ?? ''))
  const text = String(b.goal ?? '').replace(/^\s*\/goal\b\s*/i, '').trim()
  if (!text || !spec) return null
  if (text.length > spec.max) {
    problems.push(t('form.goal_too_long', { max: spec.max, len: text.length }))
    return null
  }
  return text
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
    orRouting: pv.orRouting ?? null,
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
  // Keeping the work on a branch needs a branch. Checked here rather than
  // silently ignored, because "the checkbox did nothing" is the kind of thing
  // one only notices three runs later.
  const keepOnBranch = b.keep_on_branch === '1' || b.keep_on_branch === 'on' ? 1 : 0
  if (keepOnBranch && branchMode === 'keiner') problems.push(t('form.keep_needs_branch'))
  return {
    ...setup,
    prompt,
    goal: goalFromForm(b, problems),
    branchMode,
    branchPattern: b.branch_pattern?.trim() || null,
    keepOnBranch,
    expectedMinutes: +b.expected_minutes || DEFAULT_EXPECTED_MINUTES,
    skills: skillsAusFormular(b),
    flows: attachmentsFromForm(b),
  }
}

/**
 * A stored SETUP back in the shape of a form body — the counterpart to
 * `runSetupFromForm()`, and the reason there is no second definition builder
 * anywhere in this codebase. A favorite uses it, and so does the conflict
 * resolver of server/integrate.mjs: both hold the setup half under a name and
 * both turn it back into a run through `runDefFromForm()`, the ordinary path.
 *
 * It used to live in favorites.mjs, where it only happened to sit — the function
 * knows nothing about favorites, it knows the form.
 *
 * The two list fields keep the shape the form parser produces (`<name>_list`
 * plus a companion field per entry), because that is what `skillsAusFormular()`
 * and `attachmentsFromForm()` read.
 */
export function setupToFormBody(setup = {}) {
  const routing = setup.orRouting ?? parseRoutingJson(setup.or_routing)
  const mode = routing?.mode === 'auto' ? 'auto' : (setup.or_provider ?? setup.orProvider) ? 'pin' : 'offen'
  const body = {
    harness: setup.harness,
    model: setup.model ?? '',
    provider: setup.provider ?? '',
    effort: setup.effort ?? '',
    // The serving-provider routing only survives where it can be passed through
    // at all (opencode + OpenRouter); providerFromForm() decides that, as always.
    or_mode: mode,
    or_provider: setup.or_provider ?? setup.orProvider ?? '',
    or_quant: routing?.quant_min ?? '',
    or_region: routing?.location ?? 'all',
    or_max_in: routing?.max_in ?? '',
    or_max_out: routing?.max_out ?? '',
    skills_list: [],
    flows_list: [],
  }
  for (const eintrag of skillListe(setup.skills)) {
    const name = eintragName(eintrag)
    body.skills_list.push(name)
    const wert = eintragWert(eintrag)
    if (wert) body[`skill_regler_${name}`] = wert
  }
  for (const a of parseAttachments(setup.flows)) {
    body.flows_list.push(String(a.flowId))
    body[`flow_when_${a.flowId}`] = a.when
  }
  return body
}

// -------------------------------------------------------- agent row ↔ definition

/** The routing config in the shape the DB column holds (JSON), or NULL. */
export function routingJson(routing) {
  return routing ? JSON.stringify(routing) : null
}

/** The DB column back into the config object — tolerant of old rows and nulls. */
export function parseRoutingJson(s) {
  try { return JSON.parse(s ?? '') ?? null } catch { return null }
}

/** Agent row (DB columns) → definition, the shape createRun() and the flows expect. */
export function defFromAgent(agent) {
  return {
    harness: agent.harness,
    model: agent.model ?? null,
    provider: agent.provider ?? null,
    orProvider: agent.or_provider ?? null,
    orRouting: parseRoutingJson(agent.or_routing),
    effort: agent.effort ?? null,
    prompt: agent.prompt,
    goal: agent.goal ?? null,
    branchMode: agent.branch_mode,
    branchPattern: agent.branch_pattern ?? null,
    keepOnBranch: agent.keep_on_branch ? 1 : 0,
    expectedMinutes: agent.expected_minutes,
    skills: agent.skills ?? null,
    flows: agent.flows ?? null,
  }
}

/**
 * No schedule at all — and the shape every schedule is spread over, so a new
 * schedule column cannot be forgotten by the callers that build a partial one.
 */
export const EMPTY_SCHEDULE = {
  schedule: null, kind: 'manuell', days: null, time: null, slots: null,
  weeks: null, anchor: null, run_at: null,
}

/**
 * Create or update an agent from a definition — the only place that writes the
 * agents table. `schedule` may be omitted (the single-run form's "save as
 * agent" saves the definition without a schedule; the agent then runs manually).
 */
export function saveAgent({ id = null, repoId, name, def, schedule = null, active = 1 }) {
  const zp = { ...EMPTY_SCHEDULE, ...(schedule ?? {}) }
  if (id) {
    // A single UPDATE — before, 'active' was first set to 1 and then derived
    // again from exactly that freshly written value.
    db.prepare(`UPDATE agents SET name=?, harness=?, model=?, prompt=?, goal=?, branch_mode=?, branch_pattern=?,
                keep_on_branch=?, expected_minutes=?, schedule=?, schedule_kind=?, schedule_days=?, schedule_time=?,
                schedule_slots=?, schedule_weeks=?, schedule_anchor=?, run_at=?, provider=?, or_provider=?, or_routing=?, effort=?,
                skills=?, flows=?, active=?, updated_at=datetime('now') WHERE id=?`).run(
      name, def.harness, def.model, def.prompt, def.goal ?? null, def.branchMode, def.branchPattern,
      def.keepOnBranch ? 1 : 0,
      def.expectedMinutes, zp.schedule, zp.kind, zp.days, zp.time, zp.slots, zp.weeks, zp.anchor, zp.run_at,
      def.provider, def.orProvider, routingJson(def.orRouting), def.effort, def.skills, def.flows ?? null, active, id)
    return id
  }
  const r = db.prepare(`INSERT INTO agents(repo_id,name,harness,model,prompt,goal,branch_mode,branch_pattern,keep_on_branch,expected_minutes,
              schedule,schedule_kind,schedule_days,schedule_time,schedule_slots,schedule_weeks,schedule_anchor,run_at,
              provider,or_provider,or_routing,effort,skills,flows,active)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    repoId, name, def.harness, def.model, def.prompt, def.goal ?? null, def.branchMode,
    def.branchPattern, def.keepOnBranch ? 1 : 0, def.expectedMinutes,
    zp.schedule, zp.kind, zp.days, zp.time, zp.slots, zp.weeks, zp.anchor, zp.run_at,
    def.provider, def.orProvider, routingJson(def.orRouting), def.effort, def.skills, def.flows ?? null, active)
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
  <fieldset class="schedule">
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
    or_routing: v.or_routing ?? null,
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
    or_routing: def.orRouting ?? null,
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
  // The OpenRouter serving-provider routing — the SAME three modes the run
  // form carries, only flatter (the designer has no folding): offen routes
  // freely, pin takes one tag, auto resolves the best provider per model at
  // start from the requirements below (provider + model must be openrouter
  // for any of it to reach the run).
  { key: 'orMode', kind: 'select', options: ['offen', 'auto', 'pin'], default: 'offen' },
  { key: 'orProvider', kind: 'text', placeholder: 'provider tag, e.g. parasail/fp8', showIf: { orMode: 'pin' } },
  { key: 'orQuant', kind: 'text', placeholder: 'min. quantization: fp8 / bf16 / q4 …', showIf: { orMode: 'auto' } },
  { key: 'orRegion', kind: 'select', options: ['all', 'us', 'eu', 'de', 'cn'], default: 'all', showIf: { orMode: 'auto' } },
  { key: 'orMaxIn', kind: 'number', placeholder: 'USD/Mio', showIf: { orMode: 'auto' } },
  { key: 'orMaxOut', kind: 'number', placeholder: 'USD/Mio', showIf: { orMode: 'auto' } },
  { key: 'prompt', kind: 'textarea', required: true, placeholder: 'Review the report:\n{{trigger.run.report}}' },
  // The second prompt (claude: '/goal <condition>'), typed into the session
  // after the start — see server/goal.mjs. A coding agent that knows none
  // simply ignores it.
  { key: 'goal', kind: 'textarea', placeholder: 'all tests pass and the branch is pushed' },
  { key: 'branchMode', kind: 'select', options: BRANCH_MODES, default: 'keiner' },
  { key: 'branchPattern', kind: 'text', placeholder: 'flow/{date}-{kurz}' },
  { key: 'keepOnBranch', kind: 'checkbox', default: false },
  { key: 'expectedMinutes', kind: 'number', default: DEFAULT_EXPECTED_MINUTES },
]

/** Flow step properties (already rendered templates) → definition. */
export function defFromFlowProps(props) {
  // The routing, validated the way the run form validates it — a nonsense
  // minimum becomes NO routing rather than a run that cannot start, and the
  // pin travels only where the provider is OpenRouter.
  const orMode = ['auto', 'pin'].includes(props.orMode) ? props.orMode : null
  let orProvider = null
  let orRouting = null
  if (props.provider === 'openrouter' && orMode === 'pin' && String(props.orProvider ?? '').trim()) {
    orProvider = String(props.orProvider).trim()
  } else if (props.provider === 'openrouter' && orMode === 'auto') {
    const cfg = parseRoutingConfig({
      quant_min: props.orQuant ?? '', location: props.orRegion ?? 'all',
      max_in: props.orMaxIn ?? '', max_out: props.orMaxOut ?? '',
    })
    if (!cfg?.error) orRouting = cfg
  }
  return {
    harness: props.harness,
    model: props.model || null,
    provider: props.provider || null,
    orProvider,
    orRouting,
    effort: props.effort || null,
    prompt: props.prompt,
    // Through the same gate as the form's: a coding agent without a goal spec
    // gets none, and a condition past the limit is dropped rather than cut in
    // the middle — half a condition means something else than the whole one.
    goal: goalFromForm({ harness: props.harness, goal: props.goal }, []),
    branchMode: props.branchMode || 'keiner',
    branchPattern: props.branchPattern || null,
    // Only where there is a branch to keep the work on — the same rule the form
    // enforces, so a flow cannot store a combination the form would refuse.
    keepOnBranch: props.keepOnBranch && props.branchMode !== 'keiner' ? 1 : 0,
    expectedMinutes: Number(props.expectedMinutes) || DEFAULT_EXPECTED_MINUTES,
    skills: null,
    // Deliberately no attached flows: a run a flow starts must not start flows
    // itself — that is the loop guard, and a flow that wants to react to its own
    // run uses "wait" on the start step instead.
    flows: null,
  }
}
