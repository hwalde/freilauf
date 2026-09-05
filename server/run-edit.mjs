// Freilauf — editing a stored run: what may change while it still has a future.
//
// Six operator wishes, one answer each, and all of them read the database at
// the moment they are used, so an edit needs no migration of anything already
// running:
//
//   - a running / waiting run's EXPECTED DURATION can be changed. The watcher's
//     traffic-light thresholds (soft_overrun at 80 %, overrun at 100 %), the
//     metrics and the overview all read `runs.expected_minutes` live, so a new
//     value takes effect at once. The already-running agent is deliberately NOT
//     told: the minutes in its prompt are informational, and editing a session
//     that stands would fight it.
//   - a not-yet-started run's PROMPT can be changed. `launchRun()` reads
//     `runs.prompt` when it starts, so the new text is what the session
//     actually launches with. A started run has no way back to this — its
//     session is already running the old text.
//   - a not-yet-started run can be MOVED to another repo. The worktree is
//     created from the repo at launch (base branch, repo prompt and extras are
//     read live there), so changing `runs.repo_id` moves the run's future, not
//     its past.
//   - a not-yet-started run's BRANCH RULE can be changed (mode, pattern and
//     keep-on-branch). `makeWorktree()` reads them at launch, and the agent's
//     prompt quotes the sentence they produce — so the same rule as prompt and
//     repo: editable until the run starts.
//   - a PLANNED run's START TIME can be changed, through exactly the same block
//     and parser the single-run form plans one with (`runStartTimeFields` /
//     `runStartFromForm`). Three of the four choices are a plain UPDATE; the
//     fourth — "now" — starts the run immediately (the budget gate still gets
//     to defer it), which is what "now" means when one plans a run.
//   - a not-yet-started run's SANDBOX can be changed — whether it happens in a
//     container at all, and the overrides that narrow its profile. Read at
//     launch like the branch rule (`prepareSandbox()` resolves the spec, makes
//     the clone and starts the container there), hence the same rule: editable
//     until the run starts, and never after. A RUNNING run's network policy is
//     loosened through the buttons next to a blocked host instead
//     (SANDBOX_RESEARCH.md §7.12) — that reloads a proxy, it does not edit a
//     plan, and it is a different question with a different answer.
//
// "Not started" means `scheduled` or `deferred`: both have no session and no
// worktree, and both reach launchRun() eventually. A started run is
// `running` / `waiting_help` — only its duration may change. The start time is
// deliberately only offered on a `scheduled` run, not a `deferred` one: a
// deferred run waits on quota, and `retryDeferred` starts it the moment the
// gate opens regardless of `start_at` — a start-time edit there would be a lie.
import db, { getRepo, getRun, addEvent } from './db.mjs'
import { fallbackTitle, applyGeneratedTitle } from './title.mjs'
import {
  runStartFromForm, BRANCH_MODES,
  sandboxHubMode, sandboxAllowBypass, sandboxLock, sandboxAllowedMountRoots,
  sandboxAgainst,
} from './run-def.mjs'
import { validateSandboxOverrides } from './sandbox/spec.mjs'
import { branchWorktree } from './runner.mjs'
import { clearAnomalies, notifiedFlags } from './reports.mjs'
import { t } from './i18n.mjs'

/**
 * What may be edited on a run in a given status. The ONE table the detail page
 * and the API both ask, so the form can never offer an edit the endpoint would
 * refuse (or the other way round).
 */
export function runEditAllowed(run) {
  const nothing = { duration: false, prompt: false, repo: false, startTime: false, branch: false, sandbox: false }
  if (!run) return nothing
  // Not started yet: everything that is read at launch can still be changed.
  if (['scheduled', 'deferred'].includes(run.status)) {
    return {
      duration: true, prompt: true, repo: true,
      // Only a scheduled run waits on a time; a deferred one waits on quota and
      // starts the moment the gate opens, whatever start_at says.
      startTime: run.status === 'scheduled',
      branch: true,
      // The sandbox is read at launch like the branch rule: `prepareSandbox()`
      // resolves the spec, makes the clone and starts the container when the
      // run starts, so until then both the yes/no and the overrides move the
      // run's future rather than its past. Not afterwards — the container is
      // standing, its network policy is in force, and the agent's whole home
      // lives inside it. The overrides' LIVE subset is changed on a running run
      // through the buttons next to a blocked host (§7.12), which is a
      // different act with a different answer: it reloads a proxy, it does not
      // edit a plan.
      sandbox: true,
    }
  }
  // Started: the session is what it is — only the live-read duration stays open.
  if (['running', 'waiting_help'].includes(run.status)) {
    return { ...nothing, duration: true }
  }
  // A finished run with an open follow-up commission is working again — the
  // watcher's overrun thresholds read `expected_minutes` live for it exactly as
  // for a running run, so the same argument as above applies: raising it takes
  // effect at once and retracts the "longer than expected" statement (editRun).
  if (['done', 'failed', 'aborted'].includes(run.status) && (run.followup_since || run.followup_open)) {
    return { ...nothing, duration: true }
  }
  return nothing
}

/**
 * A yes/no that arrives as text. `1` and `0` are what the select sends; the
 * words are what a script writes. Anything else is `null` — "I do not know what
 * you meant" — because the one reading that must never happen here is
 * `Boolean('0')`, which is true and would put a run into a container its
 * operator had just switched off.
 */
function sandboxYesNo(v) {
  const s = String(v).trim().toLowerCase()
  if (['1', 'on', 'true', 'yes'].includes(s)) return 1
  if (['0', 'off', 'false', 'no'].includes(s)) return 0
  return null
}

/**
 * Apply the requested edits to a stored run. Each of the values may be
 * null/undefined to mean "not being changed". Problems land in `problems` and
 * nothing is applied when any of them is non-empty — the same collect-then-act
 * contract as runDefFromForm().
 *
 * Async because the branch-in-use check (`branchWorktree`) is a git call,
 * exactly as in runDefFromForm().
 *
 * The start time goes through `runStartFromForm()`, the SAME parser the
 * single-run form uses, so an edit can never mean something else than what the
 * form would have made of the same inputs. A chosen "now" returns
 * `startNow: true` instead of storing a mode: the run is waiting for its time
 * no more, and the caller starts it (scheduler.startScheduledNow) the way a
 * fresh "now" run is started.
 *
 * Returns { ok: true, startNow? } on success, { ok: false } otherwise (problems
 * carry the reasons). On success writes the run's 'edited' event, so the detail
 * page's history and the live channel learn about the change like any other.
 */
export async function editRun(runId, {
  expectedMinutes = null, prompt = null, repoId = null,
  startMode = null, startAt = null, startInMinutes = null,
  branchMode = null, branchPattern = null, keepOnBranch = null,
  sandbox = null, sandboxOverrides = null,
} = {}, problems = []) {
  const run = getRun(runId)
  if (!run) { problems.push(t('api.unknown_run')); return { ok: false } }
  const erlaubt = runEditAllowed(run)

  const sets = []
  const vals = []
  const geaendert = []
  let startNow = false
  // Set where the edit takes a planned run OUT of its sandbox; written as an
  // event after the UPDATE, so a refused edit (problems below) leaves no trace.
  let sandboxBypassed = false

  if (expectedMinutes !== null && expectedMinutes !== undefined && expectedMinutes !== '') {
    if (!erlaubt.duration) problems.push(t('run.edit.duration_only_planned'))
    const min = Math.round(Number(expectedMinutes))
    if (!Number.isFinite(min) || min < 1) problems.push(t('run.edit.duration_invalid'))
    if (erlaubt.duration && Number.isFinite(min) && min >= 1 && min !== run.expected_minutes) {
      sets.push('expected_minutes=?')
      vals.push(min)
      geaendert.push('duration')
    }
  }

  if (prompt !== null && prompt !== undefined) {
    const text = String(prompt)
    if (!erlaubt.prompt) problems.push(t('run.edit.prompt_only_planned'))
    else if (!text.trim()) problems.push(t('form.prompt_missing'))
    else if (text.trim() !== run.prompt.trim()) {
      sets.push('prompt=?')
      vals.push(text)
      geaendert.push('prompt')
    }
  }

  if (repoId !== null && repoId !== undefined && repoId !== '') {
    const target = Number(repoId)
    if (!erlaubt.repo) problems.push(t('run.edit.repo_only_planned'))
    else if (!getRepo(target)) problems.push(t('agents.move_bad_repo'))
    else if (target !== run.repo_id) {
      sets.push('repo_id=?')
      vals.push(target)
      geaendert.push('repo')
    }
    // Same repo = no-op, not an error: the combined form pre-fills the select,
    // and a duration-only edit must not fail on its own untouched field.
  }

  // The start time, through the single-run form's own parser. 'at' / 'in' write
  // a point in time, 'idle' clears it, 'now' means "start it now".
  if (startMode !== null && startMode !== undefined) {
    if (!erlaubt.startTime) problems.push(t('run.edit.start_only_scheduled'))
    else {
      const s = runStartFromForm({
        start_mode: String(startMode),
        start_at: startAt ?? '',
        start_in_minutes: startInMinutes ?? '',
      }, problems)
      if (s.startMode === 'now') {
        startNow = true
        if (!geaendert.includes('start')) geaendert.push('start')
      } else if (s.startMode === 'at') {
        if (run.start_mode !== 'at' || (run.start_at ?? null) !== s.startAt) {
          sets.push('start_mode=?'); vals.push('at')
          sets.push('start_at=?'); vals.push(s.startAt)
          geaendert.push('start')
        }
      } else if (s.startMode === 'idle') {
        if (run.start_mode !== 'idle') {
          sets.push('start_mode=?'); vals.push('idle')
          sets.push('start_at=?'); vals.push(null)
          geaendert.push('start')
        }
      }
    }
  }

  // The branch rule, with the same validation runDefFromForm applies — it IS
  // that part of the definition. The branch-in-use check judges against the
  // repo the run will launch in, i.e. the new repo when the edit moves it.
  if (branchMode !== null && branchMode !== undefined) {
    if (!erlaubt.branch) problems.push(t('run.edit.branch_only_planned'))
    else {
      const mode = String(branchMode)
      if (!BRANCH_MODES.includes(mode)) problems.push(t('form.branch_mode_unknown', { mode }))
      const pattern = String(branchPattern ?? '').trim() || null
      if (mode !== 'keiner' && !pattern) problems.push(t('form.branch_missing'))
      const keep = (keepOnBranch === null || keepOnBranch === undefined)
        ? (run.keep_on_branch ? 1 : 0)
        : (keepOnBranch ? 1 : 0)
      if (keep && mode === 'keiner') problems.push(t('form.keep_needs_branch'))
      if (mode === 'fest' && pattern && !pattern.includes('{')) {
        const effRepoId = (repoId !== null && repoId !== undefined && repoId !== '') ? Number(repoId) : run.repo_id
        const effRepo = getRepo(effRepoId)
        if (effRepo) {
          const occupied = await branchWorktree(effRepo.path, pattern)
          if (occupied) problems.push(t('run.branch_in_use', { branch: pattern, worktree: occupied }))
        }
      }
      const changed = mode !== run.branch_mode ||
        pattern !== (run.branch_pattern ?? null) ||
        keep !== (run.keep_on_branch ? 1 : 0)
      if (changed) {
        sets.push('branch_mode=?'); vals.push(mode)
        sets.push('branch_pattern=?'); vals.push(pattern)
        sets.push('keep_on_branch=?'); vals.push(keep)
        geaendert.push('branch')
      }
    }
  }

  // The sandbox. A run's tri-state has already been RESOLVED (runs.sandbox is
  // 0/1 — decideSandbox() answered when the run was created), so the edit is a
  // yes/no, and it is read by comparing rather than by coercing: the string
  // '0' is truthy, and `sandbox ? 1 : 0` would switch a run INTO a container
  // for a caller that spelled the off state out. The overrides go through the
  // form's own validator, so an edit cannot store a document the form would
  // have refused.
  if (sandbox !== null && sandbox !== undefined && sandbox !== '') {
    if (!erlaubt.sandbox) problems.push(t('sandbox.problem.form.only_planned'))
    else {
      const on = sandboxYesNo(sandbox)
      if (on === null) problems.push(t('sandbox.problem.form.tristate_unknown', { value: String(sandbox), allowed: '1, 0' }))
      else {
        const hubMode = sandboxHubMode()
        if (hubMode === 'off' && on) problems.push(t('sandbox.problem.form.hub_off'))
        else if (!on && (hubMode === 'required' || !sandboxAllowBypass())) {
          problems.push(t(hubMode === 'required'
            ? 'sandbox.problem.form.required' : 'sandbox.problem.form.bypass_not_allowed', {}))
        } else if (on !== (run.sandbox ? 1 : 0)) {
          sets.push('sandbox=?'); vals.push(on)
          geaendert.push('sandbox')
          // Taking the walls down is a NAMED event, never a changed setting
          // (§7.3: "opting out is a break-glass event"). Without it this run
          // carried nothing at all: `sandboxStatusSuffix()` and
          // `hasSandboxStory()` both key on `sandbox:bypassed`, so a run that
          // was going to be contained and now is not showed neither
          // "sandboxed" nor "bypassed" in the overview and told nobody. Every
          // other way out of a sandbox — `decideSandbox()`'s opt-out, an
          // unavailable runtime, the break-glass button — writes it; this one
          // was the hole.
          //
          // The INVERSE deliberately gets no event of its own. Switching a
          // planned run's sandbox ON is a tightening, and the run then carries
          // `runs.sandbox = 1`, which is what the overview, the detail card and
          // `hasSandboxStory()` already read: a new event kind would need an
          // i18n string and a rendering rule to say what the column says. The
          // `edited {fields:['sandbox']}` line below records the act either way.
          if (!on) sandboxBypassed = true
        }
      }
    }
  }

  if (sandboxOverrides !== null && sandboxOverrides !== undefined) {
    if (!erlaubt.sandbox) problems.push(t('sandbox.problem.form.only_planned'))
    else {
      const lock = sandboxLock()
      // The baseline the LAUNCH will narrow from — hub plus the repo this run
      // will start in, which is the new one when the same edit moves it. Passed
      // because `validateSandboxOverrides()` only judges the lock when it has
      // something to narrow from: without it the `lock` above travelled and was
      // never read, and the operator learned at launch what the form could have
      // told them while they were typing.
      const { overrides, problems: op } = validateSandboxOverrides(sandboxOverrides, {
        lock,
        allowedMountRoots: sandboxAllowedMountRoots(),
        against: sandboxAgainst(
          (repoId !== null && repoId !== undefined && repoId !== '') ? Number(repoId) : run.repo_id, lock),
      })
      for (const p of op) problems.push(t(p.key, p.params))
      const json = JSON.stringify(overrides ?? {})
      if (!op.length && json !== (run.sandbox_overrides ?? '{}')) {
        sets.push('sandbox_overrides=?'); vals.push(json)
        if (!geaendert.includes('sandbox')) geaendert.push('sandbox')
      }
    }
  }

  if (problems.length) return { ok: false }
  // "now" is an action even when no column changes — a run told to start now
  // must not bounce off the "nothing to save" wall.
  if (!sets.length && !startNow) { problems.push(t('run.edit.nothing')); return { ok: false } }

  if (sets.length) {
    db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id=?`).run(...vals, runId)
  }

  // A prompt-derived title follows the prompt — but only while it is still the
  // prompt's fallback. An operator's rename or an LLM title is a decision that
  // stays. The WHERE on title keeps that rule safe even against a race with the
  // in-flight title generation.
  if (geaendert.includes('prompt')) {
    const altTitle = run.title
    const warFallback = altTitle && altTitle === fallbackTitle(run.prompt)
    if (warFallback) {
      const neu = fallbackTitle(String(prompt))
      db.prepare('UPDATE runs SET title=? WHERE id=? AND title=?').run(neu, runId, altTitle)
      // Regenerate in the background; on failure the new fallback stays, exactly
      // as at the original start.
      applyGeneratedTitle(runId, String(prompt)).catch(() => {})
    }
  }

  if (geaendert.includes('duration')) {
    // A raised expected duration RETRACTS the "runs longer than expected"
    // statement the old value produced: the anomaly events go the same way they
    // go on a progress report (renamed to 'cleared:*', so the traffic light
    // falls back and the watcher can fire them anew against the NEW value),
    // and the overrun notification flag with them — a genuine overrun of the new
    // duration pages once again instead of staying silent behind the old flag.
    // Both names of the flag: what is written today, and what a run from before
    // the notification rebuild carries (see notifiedFlags in reports.mjs).
    // The follow-up kinds belong here for the same reason: the expected
    // duration of an open follow-up commission is read live too, and a genuine
    // overrun of the NEW duration must be able to page again.
    clearAnomalies(runId, ['anomaly:soft_overrun', 'anomaly:overrun',
      'anomaly:followup_soft_overrun', 'anomaly:followup_overrun',
      ...notifiedFlags('overrun'), ...notifiedFlags('followup_overrun')])
  }

  // Before `edited`, because it is the more specific statement about the same
  // moment and a reader walking the events downwards should meet it first.
  if (sandboxBypassed) addEvent(runId, 'sandbox:bypassed', { by: 'edit', reason: 'opt_out' })

  addEvent(runId, 'edited', { fields: geaendert, ...(geaendert.includes('repo') ? { repo_id: Number(repoId) } : {}) })
  return { ok: true, ...(startNow ? { startNow: true } : {}) }
}
