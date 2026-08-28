// cc-hub — editing a stored run: what may change while it still has a future.
//
// Three operator wishes, one answer each, and all three read the database at
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
//
// "Not started" means `scheduled` or `deferred`: both have no session and no
// worktree, and both reach launchRun() eventually. A started run is
// `running` / `waiting_help` — only its duration may change.
import db, { getRepo, getRun, addEvent } from './db.mjs'
import { fallbackTitle, applyGeneratedTitle } from './title.mjs'
import { t } from './i18n.mjs'

/**
 * What may be edited on a run in a given status. The ONE table the detail page
 * and the API both ask, so the form can never offer an edit the endpoint would
 * refuse (or the other way round).
 */
export function runEditAllowed(run) {
  if (!run) return { duration: false, prompt: false, repo: false }
  // Not started yet: everything that is read at launch can still be changed.
  if (['scheduled', 'deferred'].includes(run.status)) {
    return { duration: true, prompt: true, repo: true }
  }
  // Started: the session is what it is — only the live-read duration stays open.
  if (['running', 'waiting_help'].includes(run.status)) {
    return { duration: true, prompt: false, repo: false }
  }
  return { duration: false, prompt: false, repo: false }
}

/**
 * Apply the requested edits to a stored run. Each of the three values may be
 * null/undefined to mean "not being changed". Problems land in `problems` and
 * nothing is applied when any of them is non-empty — the same collect-then-act
 * contract as runDefFromForm().
 *
 * Returns { ok: true } on success, { ok: false } otherwise (problems carry the
 * reasons). On success writes the run's 'edited' event, so the detail page's
 * history and the live channel learn about the change like any other.
 */
export function editRun(runId, { expectedMinutes = null, prompt = null, repoId = null } = {}, problems = []) {
  const run = getRun(runId)
  if (!run) { problems.push(t('api.unknown_run')); return { ok: false } }
  const erlaubt = runEditAllowed(run)

  const sets = []
  const vals = []
  const geaendert = []

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

  if (problems.length) return { ok: false }
  if (!sets.length) { problems.push(t('run.edit.nothing')); return { ok: false } }

  db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id=?`).run(...vals, runId)

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

  addEvent(runId, 'edited', { fields: geaendert, ...(geaendert.includes('repo') ? { repo_id: Number(repoId) } : {}) })
  return { ok: true }
}
