// cc-hub — editing a stored run: what may change while it still has a future.
//
// Five operator wishes, one answer each, and all of them read the database at
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
//
// "Not started" means `scheduled` or `deferred`: both have no session and no
// worktree, and both reach launchRun() eventually. A started run is
// `running` / `waiting_help` — only its duration may change. The start time is
// deliberately only offered on a `scheduled` run, not a `deferred` one: a
// deferred run waits on quota, and `retryDeferred` starts it the moment the
// gate opens regardless of `start_at` — a start-time edit there would be a lie.
import db, { getRepo, getRun, addEvent } from './db.mjs'
import { fallbackTitle, applyGeneratedTitle } from './title.mjs'
import { runStartFromForm, BRANCH_MODES } from './run-def.mjs'
import { branchWorktree } from './runner.mjs'
import { clearAnomalies } from './reports.mjs'
import { t } from './i18n.mjs'

/**
 * What may be edited on a run in a given status. The ONE table the detail page
 * and the API both ask, so the form can never offer an edit the endpoint would
 * refuse (or the other way round).
 */
export function runEditAllowed(run) {
  if (!run) return { duration: false, prompt: false, repo: false, startTime: false, branch: false }
  // Not started yet: everything that is read at launch can still be changed.
  if (['scheduled', 'deferred'].includes(run.status)) {
    return {
      duration: true, prompt: true, repo: true,
      // Only a scheduled run waits on a time; a deferred one waits on quota and
      // starts the moment the gate opens, whatever start_at says.
      startTime: run.status === 'scheduled',
      branch: true,
    }
  }
  // Started: the session is what it is — only the live-read duration stays open.
  if (['running', 'waiting_help'].includes(run.status)) {
    return { duration: true, prompt: false, repo: false, startTime: false, branch: false }
  }
  return { duration: false, prompt: false, repo: false, startTime: false, branch: false }
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
} = {}, problems = []) {
  const run = getRun(runId)
  if (!run) { problems.push(t('api.unknown_run')); return { ok: false } }
  const erlaubt = runEditAllowed(run)

  const sets = []
  const vals = []
  const geaendert = []
  let startNow = false

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
    // and the overrun Telegram flag with them — a genuine overrun of the new
    // duration pages once again instead of staying silent behind the old flag.
    clearAnomalies(runId, ['anomaly:soft_overrun', 'anomaly:overrun', 'telegram_sent:overrun'])
  }

  addEvent(runId, 'edited', { fields: geaendert, ...(geaendert.includes('repo') ? { repo_id: Number(repoId) } : {}) })
  return { ok: true, ...(startNow ? { startNow: true } : {}) }
}
