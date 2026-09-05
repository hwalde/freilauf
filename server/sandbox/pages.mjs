// Freilauf — every page and block the sandbox needs (SANDBOX_RESEARCH.md §7.3
// "UI placement", §7.12, §7.13 "Pages").
//
// Its own file rather than more of server/pages.mjs, which is 3500 lines: the
// sandbox is one subject with a settings page, a profile editor, a repo block, a
// run card and two suffixes, and a subject that big is easier to keep honest
// where it stands together.
//
// THE ONE RULE THIS FILE IS WRITTEN AGAINST: an installation with no container
// runtime must not be offered a setting that does nothing. Every block below
// asks first, and where the answer is "no runtime" it says so and names what to
// install — a switch that looks configurable and is not is the failure
// AGENTS.md has an entry about (`SETTINGS_KEYS`), one layer up.
//
// The modules this file drives — `runtime.mjs`, `profiles.mjs`, `index.mjs` —
// are imported LAZILY, inside the function that uses them. Two reasons, and the
// second one is the load-bearing one: `index.mjs` reaches into the runner and
// the scheduler, which reach back into the pages, so a static import here would
// be the ring the plugin files already have a rule about; and a hub whose
// sandbox modules are not on disk at all must still render every page it has
// today, saying the sandbox is unavailable rather than failing to start.
import db, { getRepo, setSetting, allSettings, addEvent } from '../db.mjs'
import { escapeHtml as e } from '../util.mjs'
import { t } from '../i18n.mjs'
import { layout, problemPage } from '../pages.mjs'
import { redirect } from '../web-helpers.mjs'
import {
  DEFAULT_SPEC, HUB_MODES, SANDBOX_TRISTATE, normalizeSpec, pathLocked,
  validateSandboxOverrides,
} from './spec.mjs'
import { engineCapabilities, proxyEngine } from './proxy.mjs'
import { resolvedAllow, repoOriginUrl } from './presets.mjs'
import { blockedHosts } from './audit.mjs'

// ------------------------------------------------------------- the seams ----

/**
 * A sandbox module that may not be on disk. Returns `null` instead of throwing,
 * and the caller renders the honest "not available" rather than a 500.
 */
async function mod(name) {
  try { return await import(`./${name}.mjs`) }
  catch { return null }
}

/** The first of `names` this module actually exports, else `null`. */
function pick(m, names) {
  for (const n of names) if (typeof m?.[n] === 'function') return m[n]
  return null
}

/**
 * What the machine can do, asked of `runtime.mjs`.
 *
 * `{ available, id, bin, version, rootless, runtimes, reason }` — the shape the
 * module contract names. A missing module answers exactly like a missing
 * daemon, because from a page's point of view they are the same fact.
 */
export async function runtimeState() {
  // The facade's own discovery, not `runtimeInfo()` directly: it is the answer
  // the START decision uses, and a page that asked a different question could
  // offer a setting a run would then refuse to honour. It also honours
  // `FREILAUF_SANDBOX_OFF`, which `runtimeInfo()` deliberately does not — that
  // switch is about the HUB, not about what is installed on the machine.
  const m = await mod('index')
  const refresh = pick(m, ['refreshSandboxAvailability'])
  if (!refresh) return { available: false, reason: 'sandbox.reason.no_runtime_module', runtimes: [] }
  try {
    return { runtimes: [], ...(await refresh()) }
  } catch (err) {
    return { available: false, reason: String(err?.message ?? err), runtimes: [] }
  }
}

/**
 * The discovery's `reason` as something a person can read.
 *
 * It is two kinds of thing: an i18n key from the hub's own answer
 * ('sandbox.reason.switched_off') and a bare message from the runtime probe
 * ('unsupported', a daemon's error text). `t()` hands back the key it does not
 * know, and a key printed at somebody is worse than saying nothing — so a
 * dotted string that has no translation prints as nothing at all.
 */
export function reasonText(reason) {
  const raw = String(reason ?? '').trim()
  if (raw === '') return ''
  const text = t(raw)
  if (text !== raw) return text
  return raw.includes('.') && !raw.includes(' ') ? '' : raw
}

// ------------------------------------------------------- the hub's policy ----

const settings = () => allSettings()
const setting = (key) => {
  try { return db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value ?? '' }
  catch { return '' }
}

/**
 * A stored list — one entry per line, or a JSON array. Written as JSON, read
 * either way, because an operator who edits the database by hand writes lines.
 *
 * Junk is NOT half-parsed: a value that is neither is an empty list, which is
 * the safe reading for a lock (nothing is locked) and for the mount roots
 * (nothing may be mounted) alike.
 */
export function parseList(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return []
  if (text.startsWith('[')) {
    try {
      const v = JSON.parse(text)
      return Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim() !== '').map(x => x.trim()) : []
    } catch { return [] }
  }
  return text.split(/[\n,]/).map(s => s.trim()).filter(Boolean)
}

/**
 * The hub layer of §7.3, read live.
 *
 * Four of the fields come from `run-def.mjs`, which is the ONE reader of the
 * hub's sandbox settings — mode, bypass, lock and mount roots. It compares
 * rather than coerces (the string '0' is truthy, and AGENTS.md has that entry
 * twice over) and falls back to the documented default for the empty string as
 * well as for junk. The four here that stay are ids and paths this page is the
 * only consumer of.
 */
export async function hubPolicy(s = settings()) {
  // THE FOUR HUB SANDBOX SETTINGS ARE READ IN run-def.mjs AND NOWHERE ELSE.
  // This file used to read `sandbox_allow_bypass` with a rule of its own, and
  // there were three such rules in the tree: a stored 'on' meant "bypass
  // allowed" to two readers and "forbidden" to the third — so the form offered
  // a break-glass the endpoint refused, or the reverse. Same family as the
  // "'0' is truthy" entry in AGENTS.md's Pitfalls, one setting further out.
  //
  // Imported INSIDE the function, and that is what makes this function async:
  // `run-def.mjs` reaches the runner, which reaches the sandbox facade, which
  // reaches back here — a static import closed that ring and the watcher's
  // `sandboxHubMode()` became a ReferenceError in a file nobody had edited.
  // The plugin rule of AGENTS.md, one directory over.
  const rd = await import('../run-def.mjs')
  return {
    mode: rd.sandboxHubMode(),
    lock: rd.sandboxLock(),
    allowBypass: rd.sandboxAllowBypass(),
    allowedMountRoots: rd.sandboxAllowedMountRoots(),
    // The four below are this page's own and have no second reader: a runtime
    // id, an engine id and two paths, each read where it is used.
    runtime: String(s.sandbox_runtime ?? '').trim(),
    proxyEngine: proxyEngine(String(s.sandbox_proxy_engine ?? '').trim() || 'builtin'),
    caDir: String(s.sandbox_ca_dir ?? '').trim(),
    imageRegistry: String(s.sandbox_image_registry ?? '').trim(),
  }
}

/**
 * The resolved spec of the layers ABOVE the document being judged — what a
 * locked path is narrowed FROM.
 *
 * `validateSandboxOverrides()` only judges the lock when it is handed this
 * (`spec.mjs`: `if (against && lock.length)`), so a caller that passes `lock`
 * and no baseline passes a check that never runs. Three of this file's four
 * were exactly that, and the fourth — `sandboxReconfigure()` — was how a run
 * could take back everything the operator had locked.
 *
 * It comes out of `run-def.mjs` rather than being computed here, for the reason
 * the note above `hubPolicy()` gives: a second reading of "what does the hub
 * layer resolve to" is how the form and the launch come to disagree. Imported
 * inside the function like the rest of that module, because a static import
 * would close the ring documented there.
 *
 * `repoId` is the repo whose layer sits between the hub and the document;
 * `null` where there is none (the repo form itself, a profile).
 */
async function baselineAbove(repoId, lock) {
  if (!lock?.length) return null
  try {
    const rd = await import('../run-def.mjs')
    return rd.sandboxAgainst(repoId ?? null, lock)
  } catch { return null }
}

/** Is the sandbox switched on at all? The one question every block asks first. */
export async function sandboxOn(s = settings()) {
  return (await hubPolicy(s)).mode !== 'off'
}

/** The one-line summary next to the link on the settings index. */
export async function sandboxSettingsSummary() {
  return t(`sandbox.settings.mode_${(await hubPolicy()).mode}`)
}

// --------------------------------------------------------- small builders ----

const dim = (text) => `<span class="dim">${e(text)}</span>`

function select(name, value, options, extra = '') {
  return `<select name="${e(name)}"${extra}>${options.map(([v, label]) =>
    `<option value="${e(v)}"${String(v) === String(value ?? '') ? ' selected' : ''}>${e(label)}</option>`).join('')}</select>`
}

/**
 * A checkbox with its hidden `0` companion — an unticked box is simply absent
 * from a POST body, so without the companion "off" would read as "not
 * mentioned". Where the box is switched OFF entirely (a field the engine cannot
 * honour) BOTH inputs are disabled, or the companion alone would post a 0 that
 * quietly overwrites what the operator had set.
 */
function chk(name, on, label, { disabled = false, hint = '' } = {}) {
  const off = disabled ? ' disabled' : ''
  return `<input type="hidden" name="${e(name)}" value="0"${off}>
  <label class="chk"><input type="checkbox" name="${e(name)}" value="1"${on ? ' checked' : ''}${off}>
    ${e(label)}${hint ? ` ${dim(hint)}` : ''}</label>`
}

// ============================================================ the repo block

/**
 * The "Sandbox" block of the repo form, next to "Integration".
 *
 * Async because whether there IS a sandbox is a question about the machine.
 * With no runtime it renders a sentence and no inputs at all: a select the
 * operator can change and nothing reads is worse than an absent one, because
 * it reads as a promise.
 */
export async function sandboxRepoFields(r = {}) {
  const p = await hubPolicy()
  if (p.mode === 'off') {
    return `<fieldset class="schedule"><legend>${e(t('sandbox.page.repo_legend'))}</legend>
      <p class="dim">${e(t('sandbox.page.hub_off'))} <a href="/settings/sandbox">${e(t('sandbox.settings.title'))}</a></p>
    </fieldset>`
  }
  const state = await runtimeState()
  if (!state.available) {
    return `<fieldset class="schedule"><legend>${e(t('sandbox.page.repo_legend'))}</legend>
      <p class="warn">${e(t('sandbox.page.unavailable'))}</p>
      <p class="dim">${e(t('sandbox.page.install_hint'))}${state.reason ? ` (${e(state.reason)})` : ''}</p>
    </fieldset>`
  }

  const profiles = await listProfiles()
  const overrides = String(r.sandbox_overrides ?? '{}')
  let auditOnly = false
  try { auditOnly = JSON.parse(overrides || '{}')?.network?.auditOnly === true } catch {}
  const def = SANDBOX_TRISTATE.includes(r.sandbox_default) ? r.sandbox_default : 'inherit'

  return `<fieldset class="schedule" data-sandbox><legend>${e(t('sandbox.page.repo_legend'))}</legend>
    <p class="dim">${e(t('sandbox.page.repo_hint', { mode: t(`sandbox.settings.mode_${p.mode}`) }))}</p>
    <label>${e(t('sandbox.page.default'))} ${select('sandbox_default', def, [
      ['inherit', t('sandbox.page.tri_inherit')],
      ['on', t('sandbox.page.tri_on')],
      ['off', t('sandbox.page.tri_off')],
    ])}
      ${dim(t('sandbox.page.default_hint'))}</label>
    <label>${e(t('sandbox.page.profile'))} ${select('sandbox_profile_id', r.sandbox_profile_id ?? '', [
      ['', t('sandbox.page.profile_none')],
      ...profiles.map(pr => [String(pr.id), pr.builtin ? `${pr.name} (${t('sandbox.page.builtin')})` : pr.name]),
    ])}
      ${dim(t('sandbox.page.profile_hint'))}</label>
    <label>${e(t('sandbox.page.image'))} <input name="sandbox_image" value="${e(r.sandbox_image ?? '')}" placeholder="registry.example.com/team/java21:2026-09">
      ${dim(t('sandbox.page.image_hint'))}</label>
    ${chk('sandbox_audit_only', auditOnly, t('sandbox.page.audit_only'), { hint: t('sandbox.page.audit_only_hint') })}
    ${chk('merge_check_sandboxed', (r.merge_check_sandboxed ?? 0) === 1, t('sandbox.page.merge_check_sandboxed'),
      { hint: t('sandbox.page.merge_check_sandboxed_hint') })}
    <details class="sandbox-overrides"><summary>${e(t('sandbox.page.overrides'))}</summary>
      <p class="dim">${e(t('sandbox.page.overrides_hint'))}</p>
      ${p.lock.length ? `<p class="dim">${e(t('sandbox.page.locked_paths', { paths: p.lock.join(', ') }))}</p>` : ''}
      <textarea name="sandbox_overrides" rows="10" spellcheck="false">${e(overrides === '{}' ? '' : overrides)}</textarea>
    </details>
  </fieldset>`
}

/**
 * The repo form's sandbox half, out of the body.
 *
 * Returns `null` when the body carried none of it — a form rendered on a hub
 * with no runtime posts no sandbox fields at all, and the caller then leaves the
 * stored columns exactly as they are. Reading "absent" as "empty" is how a
 * configuration disappears the first time somebody saves a page that could not
 * show it.
 */
export async function sandboxRepoFromForm(b, problems) {
  const has = ['sandbox_default', 'sandbox_profile_id', 'sandbox_overrides', 'sandbox_image', 'sandbox_audit_only']
    .some(k => Object.hasOwn(b, k))
  if (!has) return null

  const p = await hubPolicy()
  const raw = String(b.sandbox_overrides ?? '').trim()
  // A repo's overrides narrow the HUB, so the hub layer alone is the baseline.
  const { overrides, problems: specProblems } = validateSandboxOverrides(raw, {
    lock: p.lock, allowedMountRoots: p.allowedMountRoots,
    against: await baselineAbove(null, p.lock),
  })
  for (const pr of specProblems) problems.push(t(pr.key, pr.params))

  // The audit-only checkbox is the one authority for `network.auditOnly`.
  // Saying it twice — once as a box, once inside the JSON — is two
  // contradictory statements about one policy, and the one that happened to be
  // applied last would silently win. Same rule the weekly schedule follows.
  if (Object.hasOwn(overrides?.network ?? {}, 'auditOnly')) {
    problems.push(t('sandbox.page.err_audit_twice'))
  }
  const auditOnly = b.sandbox_audit_only === '1' || b.sandbox_audit_only === 'on'
  const merged = { ...(overrides ?? {}) }
  if (auditOnly) merged.network = { ...(merged.network ?? {}), auditOnly: true }

  const profileRaw = String(b.sandbox_profile_id ?? '').trim()
  return {
    sandbox_default: SANDBOX_TRISTATE.includes(b.sandbox_default) ? b.sandbox_default : 'inherit',
    // '' means "no profile of its own"; Number('') is 0 and finite, which here
    // would mean profile number zero. The empty string is checked first.
    sandbox_profile_id: profileRaw === '' ? null : (Number.isInteger(+profileRaw) ? +profileRaw : null),
    sandbox_overrides: JSON.stringify(merged),
    sandbox_image: String(b.sandbox_image ?? '').trim() || null,
    merge_check_sandboxed: b.merge_check_sandboxed === '1' || b.merge_check_sandboxed === 'on' ? 1 : 0,
  }
}

/**
 * The Dry-run button — deliberately NOT part of the repo form.
 *
 * A `<form>` inside a `<form>` is a parse error and its button submits the
 * OUTER one, so a "Dry run" placed inside the settings form would silently be a
 * second Save. It stands under the form instead, where it also reads better:
 * one tests what is saved, not what is typed.
 */
export async function sandboxDryRunButton(repo) {
  if (!repo?.id || !(await sandboxOn())) return ''
  return `<div class="btn-row" id="sandbox-dryrun">
    <form method="post" action="/repos/sandbox/dry-run" class="inline">
      <input type="hidden" name="id" value="${e(String(repo.id))}">
      <button type="submit" class="ghost">${e(t('sandbox.action.dry_run'))}</button>
    </form>
    ${dim(t('sandbox.page.dry_run_hint'))}
  </div>`
}

// ==================================================== audit-only: "Adopt"

/**
 * "Hosts these runs reached that are not on the allowlist" (§7.12.5).
 *
 * Grown from the repo's OWN traffic: every run of this repo that carries an
 * `egress.jsonl` with `would_deny` lines — which is exactly what audit-only
 * writes. This is the rollout path an enterprise follows: observe, then
 * enforce, and the button is what makes the second step one click instead of a
 * transcription exercise.
 */
export function adoptCandidates(repoId, { limit = 40 } = {}) {
  let runs = []
  try {
    runs = db.prepare(`SELECT id FROM runs WHERE repo_id=? AND sandbox=1 ORDER BY rowid DESC LIMIT 200`).all(repoId)
  } catch { return [] }
  const byHost = new Map()
  for (const r of runs) {
    for (const h of blockedHosts(r.id, { action: 'would_deny' })) {
      const cur = byHost.get(h.host) ?? { host: h.host, count: 0, runs: 0, last: null }
      cur.count += h.count
      cur.runs += 1
      if (h.last && (!cur.last || h.last > cur.last)) cur.last = h.last
      byHost.set(h.host, cur)
    }
  }
  return [...byHost.values()].sort((a, b) => b.count - a.count || a.host.localeCompare(b.host)).slice(0, limit)
}

/** The block under the repo form: what audit-only saw, and the one button. */
export async function sandboxAdoptBlock(repo) {
  if (!repo?.id || !(await sandboxOn())) return ''
  const hosts = adoptCandidates(repo.id)
  if (!hosts.length) return ''
  return `<div class="card" id="sandbox-adopt">
    <h3>${e(t('sandbox.page.adopt_title'))}</h3>
    <p class="dim">${e(t('sandbox.page.adopt_hint'))}</p>
    <form method="post" action="/repos/sandbox/adopt">
      <input type="hidden" name="id" value="${e(String(repo.id))}">
      <div class="table-wrap"><table class="list"><thead><tr>
        <th></th><th>${e(t('sandbox.page.adopt_host'))}</th>
        <th>${e(t('sandbox.page.adopt_count'))}</th><th>${e(t('sandbox.page.adopt_runs'))}</th>
        <th>${e(t('sandbox.page.adopt_last'))}</th></tr></thead><tbody>
        ${hosts.map(h => `<tr>
          <td><input type="checkbox" name="host" value="${e(h.host)}" checked aria-label="${e(h.host)}"></td>
          <td><code>${e(h.host)}</code></td><td>${e(String(h.count))}</td><td>${e(String(h.runs))}</td>
          <td class="dim">${e(h.last ? String(h.last) : '–')}</td></tr>`).join('')}
      </tbody></table></div>
      <div class="btn-row"><button>${e(t('sandbox.action.adopt'))}</button>
        ${dim(t('sandbox.page.adopt_button_hint'))}</div>
    </form>
  </div>`
}

/**
 * Write the ticked hosts into the repo's own overrides.
 *
 * Two things this used to get wrong, and both made a button look like it had
 * worked when it had not:
 *
 *  - **it adopted exactly one host.** `parseForm()` collapses a repeated field
 *    to its LAST value and exposes the whole list under `<name>_list` — the
 *    convention the run multi-select (`b.run_list`) and the sessions page
 *    (`b.session_list`) already follow. Reading `b.host` with an
 *    `Array.isArray()` branch could therefore never see more than one: measured
 *    live, three ticked boxes produced one adopted host, a 303, and no warning.
 *    That is the payload of the whole audit-only rollout — observe, then
 *    enforce — quietly throwing away most of what the operator observed.
 *  - **it was a second writer of `repos.sandbox_overrides`**, skipping the
 *    validation and the lock check the repo form applies to the same column. A
 *    host the hub locked out was written into the repo and refused later, at
 *    launch, as an `override_refused` nobody was watching for. It goes through
 *    `validateSandboxOverrides()` against the same baseline the repo form uses
 *    now, so a locked allow list refuses an adopted host exactly the way it
 *    refuses a typed one — and the whole document is judged, because that is
 *    what the repo form would judge if the operator opened it.
 */
export async function sandboxAdopt(req, res, url, formBody) {
  const b = await formBody()
  const repo = getRepo(+b.id)
  if (!repo) return problemPage(req, res, t('sandbox.page.adopt_title'), [t('api.unknown_repo')], '/repos')
  const back = `/repos/edit?id=${repo.id}`
  const hosts = (b.host_list ?? (b.host ? [b.host] : [])).map(h => String(h).trim()).filter(Boolean)
  if (!hosts.length) {
    return problemPage(req, res, t('sandbox.page.adopt_title'), [t('sandbox.page.err_adopt_empty')], back)
  }
  let doc = {}
  try { doc = JSON.parse(repo.sandbox_overrides || '{}') } catch { doc = {} }
  const allow = Array.isArray(doc?.network?.allow) ? [...doc.network.allow] : []
  for (const h of hosts) if (!allow.includes(h)) allow.push(h)
  doc.network = { ...(doc.network ?? {}), allow }

  const p = await hubPolicy()
  const { problems } = validateSandboxOverrides(JSON.stringify(doc), {
    lock: p.lock, allowedMountRoots: p.allowedMountRoots,
    against: await baselineAbove(null, p.lock),
  })
  if (problems.length) {
    return problemPage(req, res, t('sandbox.page.adopt_title'), problems.map(pr => t(pr.key, pr.params)), back)
  }
  db.prepare('UPDATE repos SET sandbox_overrides=? WHERE id=?').run(JSON.stringify(doc), repo.id)
  redirect(res, back)
}

// ============================================================ the run card

/** The frozen spec of a run, normalized — `{}` for a run that never had one. */
export function runSpec(run) {
  let raw = {}
  try { raw = JSON.parse(run?.sandbox_spec || '{}') } catch { raw = {} }
  return normalizeSpec(raw)
}

/** Does this run's page have anything to say about a sandbox at all? */
export function hasSandboxStory(run) {
  if (!run) return false
  if (run.sandbox) return true
  if (run.sandbox_spec) return true
  try {
    return !!db.prepare(`SELECT 1 FROM events WHERE run_id=? AND kind='sandbox:bypassed' LIMIT 1`).get(run.id)
  } catch { return false }
}

/**
 * The "Sandbox" line of the run detail page (§7.13), and the three buttons the
 * whole feature is judged on (§7.12.2).
 *
 * Part of the run-detail fragment, so the live channel swaps it whole — which
 * is why the reconfigure textarea lives in a `<details>` of its own with an id:
 * hub.js already skips a fragment swap while `#run-edit` has focus, and this
 * card follows the same rule through `#sandbox-card :focus`.
 */
export async function sandboxCard(run, repo) {
  if (!hasSandboxStory(run)) return ''
  const p = await hubPolicy()
  const spec = runSpec(run)
  const bypassed = !run.sandbox
  const net = spec.network ?? DEFAULT_SPEC.network
  const res = spec.resources ?? DEFAULT_SPEC.resources

  const originUrl = await repoOriginUrl(repo?.path).catch(() => null)
  const allow = resolvedAllow(spec, { harness: run.harness, provider: run.provider, originUrl })
  const blocked = blockedHosts(run.id, { action: 'deny' })
  const inFlight = ['running', 'waiting_help'].includes(run.status)

  // A locked `network.allow` means no layer below the hub may ADD to it — so
  // both the run and the repo button would be refused, and a button that is
  // going to be refused is better greyed out with the reason than clicked.
  const allowLocked = pathLocked('network.allow', p.lock)

  const facts = []
  facts.push(`<li><span class="k">${e(t('sandbox.page.state'))}</span> ${
    bypassed ? e(t('sandbox.event.bypassed')) : e(t('sandbox.event.sandboxed'))}</li>`)
  if (spec.image?.ref) {
    // A digest is a PIN — `repo@sha256:…` resolves. An image id is not: a
    // locally built image has an `Id` and no repo digest, and printing that id
    // where a digest belongs would pass provenance off as something one could
    // pull. So the two are labelled apart, and only the first is called a
    // digest.
    const pin = spec.image.digest ? String(spec.image.digest) : null
    const id = !pin && spec.image.id ? String(spec.image.id) : null
    facts.push(`<li><span class="k">${e(t('sandbox.page.image'))}</span> <code>${e(spec.image.ref)}</code>${
      pin ? ` <span class="dim"><code>${e(pin.slice(0, 19))}</code></span>` : ''}${
      id ? ` <span class="dim">${e(t('sandbox.page.image_id'))} <code>${e(id.slice(0, 19))}</code></span>` : ''}</li>`)
  }
  facts.push(`<li><span class="k">${e(t('sandbox.page.network'))}</span> ${e(t(`sandbox.page.net_${net.mode}`))}${
    net.auditOnly ? ` <span class="dim">${e(t('sandbox.page.audit_only'))}</span>` : ''} <span class="dim">${e(net.engine)}</span></li>`)
  facts.push(`<li><span class="k">${e(t('sandbox.page.limits'))}</span> ${
    e(t('sandbox.page.limits_value', { memory: res.memory, cpus: res.cpus, pids: res.pidsLimit }))}</li>`)
  if (run.sandbox_container) {
    facts.push(`<li><span class="k">${e(t('sandbox.page.container'))}</span> <code>${e(run.sandbox_container)}</code></li>`)
  }

  const btn = (action, label, fields, { danger = false, disabled = false, title = '', confirmKey = null } = {}) => `
    <form method="post" action="/api/runs/${e(run.id)}/sandbox/${action}" class="inline"${
      confirmKey ? ` onsubmit="return confirm(${e(JSON.stringify(t(confirmKey)))})"` : ''}>
      ${fields}<button${danger ? ' class="danger"' : ''}${disabled ? ' disabled' : ''}${
        title ? ` title="${e(title)}"` : ''}>${e(t(label))}</button></form>`

  const blockedBlock = blocked.length
    ? `<div class="sandbox-blocked">
      <b>${e(t('sandbox.page.blocked_title'))}</b>
      <ul class="chips">${blocked.map(h => {
        const field = `<input type="hidden" name="host" value="${e(h.host)}">`
        return `<li><code>${e(h.host)}</code> <span class="dim">${e(t('sandbox.page.blocked_count', { n: h.count }))}</span>
          <span class="btn-row">
            ${btn('allow', 'sandbox.action.allow_run', `${field}<input type="hidden" name="scope" value="run">`,
              { disabled: allowLocked || !inFlight, title: allowLocked ? t('sandbox.page.locked_by_hub') : '' })}
            ${btn('allow', 'sandbox.action.allow_repo', `${field}<input type="hidden" name="scope" value="repo">`,
              { disabled: allowLocked, title: allowLocked ? t('sandbox.page.locked_by_hub') : '' })}
            ${btn('deny', 'sandbox.action.deny_tell', field, { disabled: !inFlight })}
          </span></li>`
      }).join('')}</ul>
      ${allowLocked ? `<p class="dim">${e(t('sandbox.page.locked_by_hub'))}</p>` : ''}
    </div>`
    : `<p class="dim">${e(t('sandbox.page.no_blocked'))}</p>`

  // "Continue without the sandbox" is a named, logged act and never a
  // convenience: it is only offered where the hub's own policy permits it, it
  // asks first, and it says in its own hint that it is recorded.
  const bypassBtn = !bypassed && inFlight && p.allowBypass
    ? `<div class="btn-row">${btn('bypass', 'sandbox.action.bypass', '', {
        danger: true, confirmKey: 'sandbox.page.bypass_confirm',
      })}${dim(t('sandbox.page.bypass_hint'))}</div>`
    : !bypassed && inFlight
      ? `<p class="dim">${e(t('sandbox.page.bypass_forbidden'))}</p>`
      : ''

  return `<div class="banner waiting" id="sandbox-card">
    <b>${e(t('sandbox.page.card_title'))}:</b>
    <ul class="chips">${facts.join('')}</ul>
    <details class="sandbox-allow"><summary>${e(t('sandbox.page.allow_list', { n: allow.length }))}</summary>
      ${allow.length ? `<ul class="chips">${allow.map(a => `<li><code>${e(a)}</code></li>`).join('')}</ul>`
        : `<p class="dim">${e(t('sandbox.page.allow_empty'))}</p>`}
      ${net.deny?.length ? `<p class="dim">${e(t('sandbox.page.deny_list'))}: ${net.deny.map(d => `<code>${e(d)}</code>`).join(' ')}</p>` : ''}
    </details>
    ${blockedBlock}
    ${bypassBtn}
    <div class="btn-row"><a class="btn ghost" href="/api/runs/${e(run.id)}/audit.jsonl">${e(t('sandbox.action.audit_export'))}</a>
      ${dim(t('sandbox.page.audit_export_hint'))}</div>
  </div>`
}

/**
 * "Reconfigure…" — the free-text half of §7.12.4, and deliberately NOT part of
 * the run-detail fragment.
 *
 * The live channel swaps everything the fragment carries by id, and a textarea
 * somebody is typing into lives only in the DOM: hub.js holds a swap back while
 * `#run-edit` has focus, and there is no such guard for anything else. So this
 * block gets an id of its own, is rendered by the PAGE alone, and a swap of the
 * card next to it leaves it standing — the same rule the prompt card and the
 * goal card already follow, for the same reason.
 */
export function sandboxReconfigureCard(run) {
  if (!run?.sandbox || !['running', 'waiting_help'].includes(run.status)) return ''
  const stored = String(run.sandbox_overrides ?? '')
  return `<details class="sandbox-reconfigure" id="sandbox-reconfigure">
    <summary>${e(t('sandbox.action.reconfigure'))}</summary>
    <p class="dim">${e(t('sandbox.page.reconfigure_hint'))}</p>
    <form method="post" action="/api/runs/${e(run.id)}/sandbox/reconfigure">
      <textarea name="overrides" rows="8" spellcheck="false">${e(stored === '{}' ? '' : stored)}</textarea>
      <div class="btn-row"><button>${e(t('sandbox.action.reconfigure_apply'))}</button></div>
    </form>
  </details>`
}

// ------------------------------------------------- the two little suffixes

/**
 * The overview's status cell suffix (§7.13). ONE statement per cell, so this is
 * a single dim line and never a second badge next to the status word: the cell
 * already carries traffic light, status, integration line and last anomaly, and
 * a fifth voice in it is how a cell stops being readable.
 */
export function sandboxStatusSuffix(run) {
  if (!run) return ''
  const zeilen = []
  if (run.sandbox) zeilen.push(t('sandbox.event.sandboxed'))
  else {
    let bypassed = false
    try {
      bypassed = !!db.prepare(`SELECT 1 FROM events WHERE run_id=? AND kind='sandbox:bypassed' LIMIT 1`).get(run.id)
    } catch {}
    if (bypassed) zeilen.push(t('sandbox.event.bypassed'))
  }
  // The two lifecycle facts that explain a run nobody else can explain: its
  // container disappeared, or it hit the runtime ceiling its profile set. Both
  // are the last word about the run, so where one exists it REPLACES the plain
  // "sandboxed" rather than standing under it — one statement per cell.
  try {
    const ev = db.prepare(`SELECT kind FROM events WHERE run_id=?
        AND kind IN ('sandbox:container_gone','sandbox:max_runtime') ORDER BY id DESC LIMIT 1`).get(run.id)
    if (ev) {
      zeilen.length = 0
      zeilen.push(t(`sandbox.lifecycle.${String(ev.kind).slice('sandbox:'.length)}`))
    }
  } catch {}
  return zeilen.length ? `<div class="dim sandbox-suffix">${e(zeilen[0])}</div>` : ''
}

/** The sessions page badge: "sandboxed", and the image it really runs. */
export function sandboxSessionBadge(s) {
  // `listSessions()` answers `{ container, image, measured }` for a sandboxed
  // session and nothing at all for an ordinary one — so the absence renders
  // nothing, which is the right answer for a session that is not in a
  // container.
  const sb = s?.sandbox
  if (!sb) return ''
  const image = typeof sb === 'object' ? sb.image : null
  return `<div class="dim sandbox-badge">${e(t('sandbox.lifecycle.badge'))}${
    image ? ` <code>${e(String(image))}</code>` : ''}</div>`
}

// ============================================================ the profiles

/**
 * The stored profiles. Asked of `profiles.mjs`, which owns the table and the
 * copy-on-write rule for a built-in; an installation whose sandbox modules are
 * not on disk gets an empty list and a page that says so, rather than a second
 * implementation of the same CRUD here — two owners of one table is the drift
 * `run-def.mjs` exists to prevent.
 */
export async function listProfiles() {
  const m = await mod('profiles')
  const fn = pick(m, ['listProfiles', 'allProfiles', 'profiles'])
  if (!fn) return []
  try { return (await fn()) ?? [] } catch { return [] }
}

async function getProfileRow(id) {
  const m = await mod('profiles')
  const fn = pick(m, ['getProfile', 'profile'])
  if (!fn) return null
  try { return (await fn(+id)) ?? null } catch { return null }
}

async function saveProfileRow(row) {
  const m = await mod('profiles')
  const fn = pick(m, ['saveProfile', 'writeProfile', 'upsertProfile'])
  if (!fn) throw new Error(t('sandbox.page.profiles_unavailable'))
  return fn(row)
}

async function deleteProfileRow(id) {
  const m = await mod('profiles')
  const fn = pick(m, ['deleteProfile', 'removeProfile'])
  if (!fn) throw new Error(t('sandbox.page.profiles_unavailable'))
  return fn(+id)
}

function profileList(profiles) {
  if (!profiles.length) return `<p class="dim">${e(t('sandbox.page.profiles_unavailable'))}</p>`
  return `<div class="table-wrap"><table class="list"><thead><tr>
    <th>${e(t('sandbox.page.profile'))}</th><th>${e(t('sandbox.page.profile_kind'))}</th><th></th></tr></thead><tbody>
    ${profiles.map(p => `<tr>
      <td><a href="/settings/sandbox/profile?id=${e(String(p.id))}">${e(p.name)}</a></td>
      <td class="dim">${e(t(p.builtin ? 'sandbox.page.builtin' : 'sandbox.page.own'))}</td>
      <td><form method="post" action="/settings/sandbox/profile/delete" class="inline"
            onsubmit="return confirm(${e(JSON.stringify(t('sandbox.page.profile_delete_confirm')))})">
        <input type="hidden" name="id" value="${e(String(p.id))}">
        <button class="danger"${p.builtin ? ' disabled title="' + e(t('sandbox.page.builtin_not_deletable')) + '"' : ''}>${e(t('sandbox.action.profile_delete'))}</button>
      </form></td></tr>`).join('')}
  </tbody></table></div>`
}

/** The profile editor — one profile per page, like a favorite, and for the same reason. */
export async function sandboxProfilePage(req, res, url) {
  const id = url.searchParams.get('id')
  const row = id ? await getProfileRow(id) : null
  if (id && !row) return problemPage(req, res, t('sandbox.page.profile'), [t('sandbox.page.err_profile_unknown')], '/settings/sandbox')
  const spec = row?.spec ?? '{}'
  const text = typeof spec === 'string' ? spec : JSON.stringify(spec, null, 2)
  const body = `<h2>${e(row ? t('sandbox.page.profile_edit', { name: row.name }) : t('sandbox.page.profile_new'))}</h2>
  ${row?.builtin ? `<p class="dim">${e(t('sandbox.page.builtin_copy_hint'))}</p>` : ''}
  <form method="post" action="/settings/sandbox/profile" class="settings form-grid">
    ${row ? `<input type="hidden" name="id" value="${e(String(row.id))}">` : ''}
    <label>${e(t('sandbox.page.profile_name'))} <input name="name" value="${e(row?.name ?? '')}" required></label>
    <label>${e(t('sandbox.page.profile_spec'))}
      <textarea name="spec" rows="24" spellcheck="false">${e(text === '{}' ? '' : text)}</textarea>
      ${dim(t('sandbox.page.profile_spec_hint'))}</label>
    <div class="btn-row"><button>${e(t('settings.save'))}</button>
      <a class="btn ghost" href="/settings/sandbox">${e(t('sandbox.action.back'))}</a></div>
  </form>
  <details><summary>${e(t('sandbox.page.default_spec'))}</summary>
    <pre>${e(JSON.stringify(DEFAULT_SPEC, null, 2))}</pre></details>`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    .end(await layout(req, t('sandbox.settings.title'), '/settings', body))
}

export async function sandboxProfileSave(req, res, url, formBody) {
  const b = await formBody()
  const back = b.id ? `/settings/sandbox/profile?id=${encodeURIComponent(b.id)}` : '/settings/sandbox/profile'
  const problems = []
  const name = String(b.name ?? '').trim()
  if (!name) problems.push(t('form.name_missing'))
  const p = await hubPolicy()
  // A profile is chosen at repo or run level, so the layer above it is the hub.
  const { overrides, problems: specProblems } = validateSandboxOverrides(String(b.spec ?? ''), {
    lock: p.lock, allowedMountRoots: p.allowedMountRoots,
    against: await baselineAbove(null, p.lock),
  })
  for (const pr of specProblems) problems.push(t(pr.key, pr.params))
  if (problems.length) return problemPage(req, res, t('sandbox.page.profile'), problems, back)
  // `saveProfile()` REFUSES rather than throwing — a profile naming
  // `secrets.mode: inject` with an engine that cannot inject, a name already
  // taken, an id that is gone. Its `problems` are i18n keys with params, the
  // same shape `validateSandboxOverrides()` answers in, so a contradiction the
  // module noticed reaches the operator as a readable page and never as a 500.
  try {
    const r = await saveProfileRow({ id: b.id ? +b.id : null, name, spec: JSON.stringify(overrides) })
    if (r?.problems?.length) {
      return problemPage(req, res, t('sandbox.page.profile'),
        r.problems.map(pr => t(pr.key, pr.params)), back)
    }
  } catch (err) {
    return problemPage(req, res, t('sandbox.page.profile'), [String(err?.message ?? err)], back)
  }
  redirect(res, '/settings/sandbox')
}

export async function sandboxProfileDelete(req, res, url, formBody) {
  const b = await formBody()
  try {
    const r = await deleteProfileRow(b.id)
    if (r?.ok === false) {
      return problemPage(req, res, t('sandbox.page.profile'),
        (r.problems ?? []).map(pr => t(pr.key, pr.params)), '/settings/sandbox')
    }
  } catch (err) {
    return problemPage(req, res, t('sandbox.page.profile'), [String(err?.message ?? err)], '/settings/sandbox')
  }
  redirect(res, '/settings/sandbox')
}

// ======================================================== Settings → Sandbox

const IMAGE_KINDS = ['base', 'claude', 'opencode', 'cursor', 'hermes']

/**
 * The hub layer of §7.3, the profile editor, the discovery result and the image
 * builds — one page, because they are one question: what may run in a sandbox
 * on this machine, and inside which walls.
 */
export async function pageSandboxSettings(req, res, url) {
  const s = settings()
  const p = await hubPolicy(s)
  const state = await runtimeState()
  const caps = engineCapabilities(p.proxyEngine)
  // Whether this engine can work on THIS daemon is the facade's question, asked
  // with the very predicate the launch asks — so the form cannot offer an engine
  // `prepareSandbox()` would refuse. Through `mod()` like everything else here,
  // and a hub without the module simply says nothing rather than failing.
  const engineFit = pick(await mod('index'), ['engineUsable'])?.(p.proxyEngine, state) ?? { ok: true }
  const profiles = await listProfiles()

  // The gate §7.13 names: `sandbox_mode` cannot be set above `off` while nothing
  // is found — the same shape as an unconfigured coding agent. Said in the form
  // AND enforced in the save, because a fence that only exists in the browser is
  // not one.
  const modeOptions = HUB_MODES.map(m => [m, t(`sandbox.settings.mode_${m}`)])
  const modeSelect = `<select name="sandbox_mode">${modeOptions.map(([v, label]) =>
    `<option value="${e(v)}"${v === p.mode ? ' selected' : ''}${
      v !== 'off' && !state.available && v !== p.mode ? ' disabled' : ''}>${e(label)}</option>`).join('')}</select>`

  const discovery = `<fieldset><legend>${e(t('sandbox.settings.discovery_legend'))}</legend>
    ${state.available
      ? `<p>${e(t('sandbox.settings.found', { id: state.id ?? '?', version: state.version ?? '?' }))}</p>
         <ul class="chips">
           ${state.bin ? `<li><span class="k">${e(t('sandbox.settings.binary'))}</span> <code>${e(state.bin)}</code></li>` : ''}
           <li><span class="k">${e(t('sandbox.settings.rootless'))}</span> ${e(t(state.rootless ? 'layout.on' : 'layout.off'))}</li>
           ${state.runtimes?.length ? `<li><span class="k">${e(t('sandbox.settings.runtimes'))}</span> ${e(state.runtimes.join(', '))}</li>` : ''}
         </ul>`
      : `<p class="warn">${e(t('sandbox.page.unavailable'))}</p>
         <p class="dim">${e(t('sandbox.page.install_hint'))}${reasonText(state.reason) ? ` (${e(reasonText(state.reason))})` : ''}</p>`}
    <p class="dim"><a href="/settings/sandbox">${e(t('sandbox.action.check_again'))}</a></p>
  </fieldset>`

  const body = `
  <h2>${e(t('sandbox.settings.title'))}</h2>
  <p class="dim">${e(t('sandbox.settings.intro'))}</p>
  ${discovery}
  <form method="post" action="/settings/sandbox" class="settings form-grid">
    <label>${e(t('sandbox.settings.mode'))} ${modeSelect}
      ${dim(t('sandbox.settings.mode_hint'))}</label>
    <label>${e(t('sandbox.settings.allow_bypass'))} ${select('sandbox_allow_bypass', p.allowBypass ? '1' : '0',
      [['1', t('layout.on')], ['0', t('layout.off')]])}
      ${dim(t('sandbox.settings.allow_bypass_hint'))}</label>
    <label>${e(t('sandbox.settings.runtime'))} <input name="sandbox_runtime" value="${e(p.runtime)}" list="sandbox-runtimes" placeholder="docker">
      <datalist id="sandbox-runtimes">${(state.runtimes ?? ['docker', 'podman']).map(r => `<option value="${e(r)}">`).join('')}</datalist>
      ${dim(t('sandbox.settings.runtime_hint'))}</label>
    <label>${e(t('sandbox.settings.lock'))}
      <textarea name="sandbox_lock" rows="6" spellcheck="false" placeholder="network.allow&#10;secrets.mode">${e(p.lock.join('\n'))}</textarea>
      ${dim(t('sandbox.settings.lock_hint'))}</label>
    <label>${e(t('sandbox.settings.mount_roots'))}
      <textarea name="sandbox_allowed_mount_roots" rows="4" spellcheck="false" placeholder="~/projects">${e(p.allowedMountRoots.join('\n'))}</textarea>
      ${dim(t('sandbox.settings.mount_roots_hint'))}</label>
    <fieldset><legend>${e(t('sandbox.settings.proxy_legend'))}</legend>
      <p class="dim">${e(t('sandbox.settings.proxy_hint'))}</p>
      <label>${e(t('sandbox.settings.proxy_engine'))} ${select('sandbox_proxy_engine', p.proxyEngine,
        [['builtin', t('sandbox.settings.engine_builtin')], ['iron-proxy', t('sandbox.settings.engine_iron')]])}</label>
      ${
        // Not theoretical: under a rootless daemon the built-in proxy has no
        // address a container can reach, and three of the four shipped profiles
        // name it. Without this line the operator learns that from a failed run.
        engineFit.ok ? '' : `<p class="err">${e(engineFit.error ?? t('sandbox.settings.engine_unusable'))}</p>`}
      <p class="dim">${e(t('sandbox.settings.engine_caps', {
        tls: t(caps.tlsTerminate ? 'layout.on' : 'layout.off'),
        inject: t(caps.inject ? 'layout.on' : 'layout.off'),
        methods: t(caps.methods ? 'layout.on' : 'layout.off'),
      }))}</p>
      ${
        // A field the chosen engine cannot honour is disabled, not merely
        // dimmed — and its reason stands next to it. Disabled means it does not
        // travel with the POST, and the save writes only what the body carried,
        // so a configured CA directory survives an engine switch and comes back
        // when an engine that can use it is chosen again.
        `<label>${e(t('sandbox.settings.ca_dir'))} <input name="sandbox_ca_dir" value="${e(p.caDir)}"${
          caps.tlsTerminate ? '' : ' disabled'} placeholder="~/.local/share/freilauf/sandbox-ca">
          ${dim(caps.tlsTerminate ? t('sandbox.settings.ca_dir_hint') : t('sandbox.settings.ca_dir_unsupported', { engine: p.proxyEngine }))}</label>`}
    </fieldset>
    <label>${e(t('sandbox.settings.image_registry'))} <input name="sandbox_image_registry" value="${e(p.imageRegistry)}" placeholder="freilauf">
      ${dim(t('sandbox.settings.image_registry_hint'))}</label>
    <div class="btn-row"><button>${e(t('settings.save'))}</button></div>
  </form>

  <h3>${e(t('sandbox.page.profiles_title'))}</h3>
  <p class="dim">${e(t('sandbox.page.profiles_hint'))}</p>
  ${profileList(profiles)}
  <p><a class="btn" href="/settings/sandbox/profile">${e(t('sandbox.action.profile_new'))}</a></p>

  <h3>${e(t('sandbox.settings.images_title'))}</h3>
  <p class="dim">${e(t('sandbox.settings.images_hint'))}</p>
  <div class="btn-row">
    ${IMAGE_KINDS.map(k => `<form method="post" action="/settings/sandbox/build" class="inline">
      <input type="hidden" name="image" value="${e(k)}">
      <button${state.available ? '' : ' disabled'}>${e(t('sandbox.action.build', { image: k }))}</button></form>`).join('')}
  </div>
  ${state.available ? '' : `<p class="dim">${e(t('sandbox.settings.images_need_runtime'))}</p>`}`

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    .end(await layout(req, t('sandbox.settings.title'), '/settings', body))
}

/**
 * Every setting this route may write — an allowlist, like the main settings
 * page's, and its own rather than an entry in that one: this page is where the
 * sandbox is configured, and a key that renders here and is dropped by a list
 * over there is exactly the failure `settingsKeys()` was made a function for.
 */
const SANDBOX_KEYS = ['sandbox_mode', 'sandbox_lock', 'sandbox_allow_bypass', 'sandbox_runtime',
  'sandbox_allowed_mount_roots', 'sandbox_proxy_engine', 'sandbox_ca_dir', 'sandbox_image_registry']

export async function sandboxSettingsSave(req, res, url, formBody) {
  const b = await formBody()
  const problems = []

  // The gate: above `off` needs a runtime. Refused here and not only greyed out
  // in the select, because a POST is not a browser.
  if (Object.hasOwn(b, 'sandbox_mode')) {
    const wanted = HUB_MODES.includes(b.sandbox_mode) ? b.sandbox_mode : 'off'
    if (wanted !== 'off') {
      const state = await runtimeState()
      if (!state.available) problems.push(t('sandbox.settings.err_no_runtime', { reason: reasonText(state.reason) }))
    }
  }
  for (const key of ['sandbox_lock', 'sandbox_allowed_mount_roots']) {
    if (!Object.hasOwn(b, key)) continue
    const raw = String(b[key] ?? '').trim()
    if (raw !== '' && parseList(raw).length === 0) problems.push(t('sandbox.settings.err_list', { field: t(`sandbox.settings.${key === 'sandbox_lock' ? 'lock' : 'mount_roots'}`) }))
  }
  if (problems.length) return problemPage(req, res, t('sandbox.settings.title'), problems, '/settings/sandbox')

  for (const key of SANDBOX_KEYS) {
    if (!Object.hasOwn(b, key)) continue
    // The two list fields are typed as lines and stored as JSON, so everything
    // that reads them reads one shape.
    if (key === 'sandbox_lock' || key === 'sandbox_allowed_mount_roots') {
      setSetting(key, JSON.stringify(parseList(b[key])))
      continue
    }
    if (key === 'sandbox_proxy_engine') { setSetting(key, proxyEngine(String(b[key] ?? ''))); continue }
    if (key === 'sandbox_mode') { setSetting(key, HUB_MODES.includes(b[key]) ? b[key] : 'off'); continue }
    setSetting(key, String(b[key] ?? ''))
  }
  redirect(res, '/settings/sandbox')
}

/**
 * Build one of the shipped images (§7.10). The build itself belongs to the
 * runtime module; this route is the button and the refusal.
 */
export async function sandboxBuild(req, res, url, formBody) {
  const b = await formBody()
  const name = String(b.image ?? '').trim()
  if (!IMAGE_KINDS.includes(name)) {
    return problemPage(req, res, t('sandbox.settings.images_title'), [t('sandbox.settings.err_unknown_image', { image: name })], '/settings/sandbox')
  }
  const rt = await mod('runtime')
  const build = pick(rt, ['buildImage', 'buildSandboxImage'])
  if (!build) {
    return problemPage(req, res, t('sandbox.settings.images_title'), [t('sandbox.settings.err_build_unavailable')], '/settings/sandbox')
  }
  const p = await hubPolicy()
  try {
    // The runtime travels with the request: an operator who configured podman
    // must not have their images built by docker. (`buildImage()` defaults to
    // docker, so leaving it out was a silent wrong answer rather than an error.)
    const r = await build(name, { runtime: p.runtime || undefined, registry: p.imageRegistry || undefined })
    if (r && r.ok === false) {
      // The sentence, never the log. It is already translated and it NAMES the
      // file the whole build output was written to — which is the only way to
      // find out which of the CLI installers broke, so it has to reach the
      // operator intact rather than being summarised away.
      return problemPage(req, res, t('sandbox.settings.images_title'),
        [String(r.error || r.reason || '')], '/settings/sandbox')
    }
  } catch (err) {
    return problemPage(req, res, t('sandbox.settings.images_title'), [String(err?.message ?? err)], '/settings/sandbox')
  }
  redirect(res, '/settings/sandbox')
}

/** The dry run of §7.12.5 — the policy somebody TESTED, not the one they hope is right. */
export async function sandboxDryRun(req, res, url, formBody) {
  const b = await formBody()
  const repo = getRepo(+b.id)
  if (!repo) return problemPage(req, res, t('sandbox.action.dry_run'), [t('api.unknown_repo')], '/repos')
  const back = `/repos/edit?id=${repo.id}`
  const m = await mod('index')
  const fn = pick(m, ['dryRun'])
  if (!fn) return problemPage(req, res, t('sandbox.action.dry_run'), [t('sandbox.page.err_dry_run_unavailable')], back)
  let result
  try { result = await fn(repo) }
  catch (err) { return problemPage(req, res, t('sandbox.action.dry_run'), [String(err?.message ?? err)], back) }

  const rows = Array.isArray(result?.checks) ? result.checks : []
  const body = `<h2>${e(t('sandbox.page.dry_run_title', { repo: repo.name }))}</h2>
  <p class="dim">${e(t('sandbox.page.dry_run_intro'))}</p>
  ${rows.length
    ? `<div class="table-wrap"><table class="list"><thead><tr>
        <th>${e(t('sandbox.page.dry_run_check'))}</th><th>${e(t('sandbox.page.dry_run_result'))}</th>
        <th>${e(t('sandbox.page.dry_run_detail'))}</th></tr></thead><tbody>
        ${rows.map(c => `<tr><td>${e(String(c.name ?? ''))}</td>
          <td>${c.ok ? '🟢' : '🔴'} ${e(t(c.ok ? 'sandbox.page.dry_run_ok' : 'sandbox.page.dry_run_failed'))}</td>
          <td class="dim">${e(String(c.detail ?? ''))}</td></tr>`).join('')}
      </tbody></table></div>`
    : `<p class="dim">${e(t('sandbox.page.dry_run_none'))}</p>`}
  <p><a class="btn" href="${e(back)}">${e(t('sandbox.action.back'))}</a></p>`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    .end(await layout(req, t('sandbox.action.dry_run'), '/repos', body, repo.id))
}

// ================================================= the three decision routes

/**
 * `changePolicy(run, patch, by)` on the facade — live where it can be, a
 * reconfigure-and-resume where it cannot (§7.12.3/§7.12.4). The patch this file
 * sends is spec-shaped with one extra key, `scope`, naming the layer the change
 * is persisted at: 'run' writes `runs.sandbox_overrides`, 'repo' the repo's.
 */
async function applyPolicy(run, patch, by) {
  const m = await mod('index')
  const fn = pick(m, ['changePolicy'])
  if (!fn) return { ok: false, error: t('sandbox.page.err_policy_unavailable') }
  try {
    const r = await fn(run, patch, by)
    // A facade that answers nothing has done the work and thrown nothing —
    // "undefined" is success, not silence, and a caller that read it as failure
    // would report a change that really happened as a refusal.
    if (r === undefined || r === null) return { ok: true }
    if (r.ok === false) return { ok: false, error: String(r.error || t('sandbox.page.err_policy_failed')) }
    return { ok: true, ...r }
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) }
  }
}

/**
 * Add a host to the allow list stored at one layer — the run's own overrides or
 * the repository's.
 *
 * The layer is the SCOPE of the button, and it is written here rather than
 * inside `changePolicy()`: that function's job is the running container, and
 * where a decision is remembered is a question about the form's layers. The two
 * halves are deliberately both done — persisting without applying would leave
 * the agent hitting the same wall until it is restarted, and applying without
 * persisting would lose the decision at the next resume.
 */
function rememberAllow(scope, run, host) {
  const table = scope === 'repo' ? 'repos' : 'runs'
  const id = scope === 'repo' ? run.repo_id : run.id
  if (id == null) return
  let doc = {}
  try {
    doc = JSON.parse(db.prepare(`SELECT sandbox_overrides AS o FROM ${table} WHERE id=?`).get(id)?.o || '{}')
  } catch { doc = {} }
  const allow = Array.isArray(doc?.network?.allow) ? [...doc.network.allow] : []
  if (!allow.includes(host)) allow.push(host)
  doc.network = { ...(doc.network ?? {}), allow }
  db.prepare(`UPDATE ${table} SET sandbox_overrides=? WHERE id=?`).run(JSON.stringify(doc), id)
}

/** "Allow for this run" / "Allow for this repo". */
export async function sandboxAllow(run, host, scope) {
  const p = await hubPolicy()
  if (pathLocked('network.allow', p.lock)) return { ok: false, error: t('sandbox.page.locked_by_hub') }
  const clean = String(host ?? '').trim()
  if (!clean) return { ok: false, error: t('sandbox.page.err_host_missing') }
  const where = scope === 'repo' ? 'repo' : 'run'
  rememberAllow(where, run, clean)
  // The patch replaces the list rather than appending to it — a spec patch is
  // merged field by field and an array IS a field, so the whole new list has to
  // travel or everything already on it would silently fall off.
  const current = runSpec(run).network?.allow ?? []
  const next = current.includes(clean) ? current : [...current, clean]
  return applyPolicy(run, { network: { allow: next } }, 'user')
}

/**
 * "Deny and tell the agent". The point of the third button is that a refusal is
 * an ANSWER: the agent asked for a host, and being told "no, do without it" is
 * something it can act on, where silence is a wall it hits again in a minute.
 */
export async function sandboxDeny(run, host) {
  const clean = String(host ?? '').trim()
  if (!clean) return { ok: false, error: t('sandbox.page.err_host_missing') }
  const text = t('sandbox.page.deny_message', { host: clean })
  if (run.tmux_session) {
    const { sendToSession } = await import('../util.mjs')
    try { await sendToSession(run.tmux_session, text) } catch {}
  }
  addEvent(run.id, 'sandbox:policy_changed', { by: 'user', denied: [clean] })
  return { ok: true, text }
}

/**
 * "Reconfigure…" — the free-text half of §7.12.4.
 *
 * THE FLOOR HOLDS HERE, and it did not. This route passed `lock` and no
 * `against`, so the lock check inside `validateSandboxOverrides()` never ran;
 * `changePolicy()` below merges a patch into the run's spec field by field and
 * narrows nothing of its own; and the result was frozen into
 * `runs.sandbox_spec` for the rest of the run, resumes included. Measured on a
 * live hub with `sandbox_lock = network,resources,filesystem,secrets`: one POST
 * turned `network.mode` from `allowlist` into `open`, added a host to a locked
 * allow list, switched `auditOnly` on, raised memory from 8g to 64g and cpus
 * from 4 to 64, and took `readOnlyRoot` off — every one of them a path the
 * operator had locked. Its sibling on the same card, `sandboxAllow()`, refuses
 * a locked `network.allow` readably, so the operator saw one path enforced and
 * reasonably assumed the other was.
 *
 * Two rules, and the second one is what a 400 has to mean:
 *
 *  - the patch is judged against the SAME baseline the launch resolves — hub
 *    plus this run's repo — with the same `narrow()` the layering applies, so a
 *    loosening comes back as the ordinary `sandbox.problem.locked` sentence
 *    naming the path and the value that stands;
 *  - **nothing is written on a refusal.** Both writes — this function's own
 *    `sandbox_overrides` and `changePolicy()`'s `sandbox_spec` — happen only
 *    after the check has passed. The evaluator's run answered 400 "the change
 *    could not be applied" with the weakened spec already on disk, which is
 *    worse than either outcome alone: the operator is told the weakening failed
 *    when it succeeded.
 */
export async function sandboxReconfigure(run, overridesText) {
  const p = await hubPolicy()
  const { overrides, problems } = validateSandboxOverrides(overridesText, {
    lock: p.lock,
    allowedMountRoots: p.allowedMountRoots,
    against: await baselineAbove(run?.repo_id, p.lock),
  })
  if (problems.length) return { ok: false, error: problems.map(pr => t(pr.key, pr.params)).join(' · ') }
  db.prepare('UPDATE runs SET sandbox_overrides=? WHERE id=?').run(JSON.stringify(overrides), run.id)
  return applyPolicy(run, overrides, 'user')
}

/**
 * The break-glass. Only where the hub's policy permits it, and it is never
 * quiet: `sandbox:bypassed` is written whatever the facade does, so the run's
 * own history says a human took the walls down even if the resume path fails
 * afterwards.
 */
export async function sandboxBypass(run, reason = '') {
  const p = await hubPolicy()
  if (!p.allowBypass) return { ok: false, error: t('sandbox.page.bypass_forbidden') }
  if (p.mode === 'required') return { ok: false, error: t('sandbox.problem.required', { layer: 'hub' }) }
  const m = await mod('index')
  const fn = pick(m, ['continueWithoutSandbox'])
  if (!fn) return { ok: false, error: t('sandbox.page.err_policy_unavailable') }
  try {
    const r = await fn(run.id, { by: 'user', reason })
    if (r && r.ok === false) return { ok: false, error: String(r.error || t('sandbox.page.err_policy_failed')) }
    return { ok: true, ...(r ?? {}) }
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) }
  }
}
