// cc-hub — favorites: the setup of a run, saved under a name.
//
// Picking a coding agent, a provider, a model out of ~200 slugs and an effort
// level is the part of starting a run that is the same every time and answers
// nothing about the task. A favorite stores exactly that half of the run
// definition — plus the two opt-ins that behave like it (extra skills with their
// dial, attached flows) — so a run can be started from anywhere with a name and
// a task.
//
// Deliberately NOT part of a favorite: the prompt, the branch rule, the expected
// duration and the start time. The first belongs to the task, the other three
// are decided per run and stand in the Quick-Run dialog itself.
//
// There is no second validation here. `favoriteFromForm()` runs the form body
// through `runSetupFromForm()` — the very function the run form uses — and
// `favoriteToFormBody()` turns a stored favorite back into a form body, so a
// Quick Run goes through `runDefFromForm()` like every other start. What is
// saved under a name therefore cannot mean anything else than what the run form
// would have made of the same inputs.
import db from './db.mjs'
import { runSetupFromForm, setupToFormBody } from './run-def.mjs'
import { skillsAusFormular, skillAnzeige } from './zusaetze.mjs'
import { attachmentsFromForm, attachmentSummary } from './flows/attach.mjs'
import { harnessLabel } from './harnesses/index.mjs'
import { providerLabel } from './providers/index.mjs'
import { t } from './i18n.mjs'

/**
 * How many favorites there may be. A favorite is a shortcut, and a list one has
 * to read is not one — the Quick-Run dialog shall be a glance, not a search.
 * Overridable for an installation that really wants more.
 */
export const FAVORITES_MAX = Number(process.env.CCHUB_FAVORITES_MAX ?? 3) || 3

export function listFavorites() {
  return db.prepare('SELECT * FROM favorites ORDER BY id').all()
}

export function getFavorite(id) {
  return db.prepare('SELECT * FROM favorites WHERE id=?').get(Number(id)) ?? null
}

export function deleteFavorite(id) {
  db.prepare('DELETE FROM favorites WHERE id=?').run(Number(id))
}

/**
 * Read a favorite out of a form body: the name plus the setup, validated by the
 * run form's own function. Problems land in `problems`; a favorite is returned
 * in any case so the caller can render the form again.
 */
export async function favoriteFromForm(b, problems = []) {
  const name = String(b.name ?? '').trim()
  if (!name) problems.push(t('form.name_missing'))
  const setup = await runSetupFromForm(b, problems)
  return {
    name,
    harness: setup.harness,
    model: setup.model,
    provider: setup.provider,
    or_provider: setup.orProvider,
    effort: setup.effort,
    skills: skillsAusFormular(b),
    flows: attachmentsFromForm(b),
  }
}

/**
 * Create or update a favorite — the only place that writes the table. Returns
 * `{ ok, id }` or `{ ok: false, problems }`: the cap and the unique name are
 * decided here, not in the page, so the JSON path cannot slip past them.
 */
export function saveFavorite({ id = null, fav }) {
  const problems = []
  if (!id && listFavorites().length >= FAVORITES_MAX) {
    problems.push(t('fav.err_full', { max: FAVORITES_MAX }))
  }
  const taken = db.prepare('SELECT id FROM favorites WHERE name=?').get(fav.name)
  if (taken && taken.id !== Number(id)) problems.push(t('fav.err_name_taken', { name: fav.name }))
  if (problems.length) return { ok: false, problems }
  if (id) {
    db.prepare(`UPDATE favorites SET name=?, harness=?, model=?, provider=?, or_provider=?, effort=?,
                skills=?, flows=?, updated_at=datetime('now') WHERE id=?`)
      .run(fav.name, fav.harness, fav.model, fav.provider, fav.or_provider, fav.effort,
        fav.skills, fav.flows, Number(id))
    return { ok: true, id: Number(id) }
  }
  const r = db.prepare(`INSERT INTO favorites(name,harness,model,provider,or_provider,effort,skills,flows)
                        VALUES(?,?,?,?,?,?,?,?)`)
    .run(fav.name, fav.harness, fav.model, fav.provider, fav.or_provider, fav.effort, fav.skills, fav.flows)
  return { ok: true, id: Number(r.lastInsertRowid) }
}

/**
 * A stored favorite back in the shape of a form body — the counterpart to
 * `favoriteFromForm()`. This is what makes a Quick Run go through the ordinary
 * `runDefFromForm()` instead of building a definition of its own: the favorite
 * only fills in the fields the dialog does not ask for.
 *
 * The work itself is `setupToFormBody()` in run-def.mjs: a favorite is the setup
 * half of a run definition, and so is the conflict resolver's saved setup
 * (server/integrate.mjs). The function only ever happened to live here.
 */
export function favoriteToFormBody(fav) {
  return setupToFormBody(fav)
}

/** "claude · claude-opus-5 · effort high · unlazy (depth 4)" — one line for a list or a dialog. */
export function favoriteSummary(fav) {
  const teile = [harnessLabel(fav.harness) || fav.harness]
  if (fav.provider) teile.push(providerLabel(fav.provider))
  if (fav.model) teile.push(fav.model)
  if (fav.or_provider) teile.push(`${t('run.pinned')}: ${fav.or_provider}`)
  if (fav.effort) teile.push(`${t('model.effort')} ${fav.effort}`)
  const skills = skillAnzeige(fav.skills)
  if (skills.length) teile.push(`${t('skills.title')}: ${skills.join(', ')}`)
  const flows = attachmentSummary(fav.flows)
  if (flows) teile.push(`${t('flows.attach.legend')}: ${flows}`)
  return teile.join(' · ')
}
