// cc-hub — the Plugins page (Settings → Plugins).
//
// One page for the whole question "what can this hub drive, and with whose
// credentials". It replaces Settings → Coding agents, which only ever knew one
// of the two kinds: a model provider had no place to carry an enabled flag, a
// credential or a setting of its own, and an external package had no place at
// all.
//
// Four sections, in the order an operator meets them:
//
//   1. what the hub FOUND on this machine — asked once, answered here;
//   2. the coding agents (every registered one, configured or not — which is
//      what subsumes the old "add a coding agent" list into the same card);
//   3. the model providers;
//   4. the plugin packages, with their load errors as they stand.
//
// Two rules run through all of it:
//
//   - **A credential is named, never shown.** The page says whether a key was
//     found and WHICH environment variable it came from; the value never
//     reaches the markup. A password field submitted empty is a no-op in
//     `setCredential()`, so saving the form cannot wipe a stored key either.
//   - **A broken plugin makes the page MORE useful.** Every load failure is
//     listed with its message instead of costing the operator the page — that
//     is the whole reason `registryErrors()` collects instead of throwing.
import { escapeHtml as e, fmtDateTime } from '../util.mjs'
import { setSetting } from '../db.mjs'
import { redirect } from '../web-helpers.mjs'
import { t } from '../i18n.mjs'
// `providerChoiceBlock` lives in pages.mjs and is imported rather than copied:
// the same block is reachable from two pages, and the two copies it used to be
// had already drifted apart — see the comment above it there.
import { layout, problemPage, providerChoiceBlock } from '../pages.mjs'
import {
  allPlugins, registryErrors, getPlugin, pluginKind, pluginSource,
  pluginManifest, detectInstalled,
} from './registry.mjs'
import {
  pluginConfig, setPluginConfig, isPluginEnabled, setPluginProviders,
  credentialSpec, setCredential, pluginHasCredential, forgetPlugin,
} from './store.mjs'
import { installFromDirectory, uninstallPlugin, listPackages } from './install.mjs'
import { scanSystem, openDiscoveries, answerDiscovery, lastScanAt } from './discovery.mjs'
import { pluginFields, pluginSettingKey, pluginSettingValue } from './settings.mjs'

/** A `<p class="dim">` explanation — every section carries one (see PLAN §2). */
const explain = (key) => `<p class="dim">${e(t(key))}</p>`

// ---------------- the banner ----------------

/**
 * "cc-hub found N things on this machine it could use."
 *
 * DERIVED, not passed — the same shape as `setupBanner()`: the layout calls it
 * on every page, and it answers out of the database. Asking happens once,
 * because answering on the Plugins page (Add or Not now) writes
 * `discovery.answer` and the row stops being open.
 *
 * "Not now" here dismisses ALL open findings at once: from a banner there is
 * nothing to distinguish them by, and a banner one cannot get rid of is worse
 * than no banner.
 */
export function discoveryBanner(backTo = '/') {
  let open = []
  try { open = openDiscoveries() } catch { open = [] }   // never cost a page a string
  if (!open.length) return ''
  return `<div class="banner discovery">🔎 ${e(t('banner.discovery', { n: open.length }))}
    <a class="btn" href="/settings/plugins">${e(t('banner.discovery_cta'))}</a>
    <form method="post" action="/settings/plugins/discovery" class="inline">
      <input type="hidden" name="all" value="1">
      <input type="hidden" name="answer" value="dismissed">
      <input type="hidden" name="back" value="${e(backTo)}">
      <button class="ghost">${e(t('banner.discovery_dismiss'))}</button></form></div>`
}

// ---------------- small building blocks ----------------

/**
 * A checkbox that always submits.
 *
 * A `<form>` sends nothing at all for an unticked box, so a saved form could
 * never switch anything OFF. The hidden companion carrying `0` stands BEFORE
 * it and `parseForm()` keeps the last value — ticked wins, unticked leaves the
 * `0`. Every switch on this page goes through here, so the rule cannot be
 * forgotten in one place only.
 */
function checkbox(name, on, label, extra = '') {
  return `<input type="hidden" name="${e(name)}" value="0">
    <label class="chk"><input type="checkbox" name="${e(name)}" value="1" ${on ? 'checked' : ''}> ${e(label)}${extra}</label>`
}

/**
 * Is this credential explicitly declared optional?
 *
 * OpenCode Zen is: it serves its free models with no key at all, and a key only
 * adds the paid ones. Saying "no key found yet" there reads like a fault on a
 * provider that is working — which is the whole reason this exists. The test is
 * an explicit `required: false` and never the absence of the field, because
 * `credentialSpec()` normalises a plugin that predates it to exactly that value.
 */
function credentialOptional(plugin, key) {
  const declared = Array.isArray(plugin?.credentials)
    ? plugin.credentials.find(c => c && c.key === key) : null
  return !!declared && declared.required === false
}

/**
 * Where a credential currently comes from — presence and, for the environment,
 * the variable's NAME. Never its value: this string is rendered into a page.
 */
function credentialState(pluginId, spec, env = process.env) {
  const entry = pluginConfig(pluginId)?.config.credentials?.[spec.key] ?? null
  if (entry?.mode === 'value' && String(entry.value ?? '').trim()) return { present: true, via: 'stored' }
  const named = entry?.mode === 'env' ? String(entry.envVar ?? '').trim() : ''
  if (named && env[named]) return { present: true, via: 'env', name: named }
  const declared = (spec.envKeys ?? []).find(name => env[name])
  if (declared) return { present: true, via: 'env', name: declared }
  return { present: false, via: null, name: named || (spec.envKeys ?? [])[0] || '' }
}

/**
 * The credentials block — the answer to "a different API key, or a different
 * environment variable name".
 *
 * Naming the variable is the better answer where a machine can be given one,
 * and the hint says so; storing a value is offered because a machine cannot
 * always. The password field is deliberately never pre-filled — there is
 * nothing to show and `setCredential()` reads an empty submit as "keep what is
 * stored", so a save cannot silently delete a key.
 *
 * Two rules the fields themselves follow:
 *
 *  - **Only the field the chosen mode needs is on the page.** The block used to
 *    show "Name of the environment variable" AND "Value" side by side whatever
 *    the dropdown said, so half of it was always asking for something that
 *    would be ignored. Hidden AND `disabled`: this project has been bitten by a
 *    hidden field that still submitted, and every `form.form-grid` selector
 *    carries `:not([hidden])` for the same reason.
 *  - **The server renders the right one already.** hub.js keeps it in step
 *    while the dropdown is used, but the Welcome wizard renders this same block
 *    and a first paint must not depend on a script having run.
 */
function credentialsBlock(pluginId, plugin) {
  const specs = credentialSpec(plugin)
  if (!specs.length) return ''
  const rows = specs.map(spec => {
    const entry = pluginConfig(pluginId)?.config.credentials?.[spec.key] ?? null
    const mode = entry?.mode === 'value' ? 'value' : 'env'
    const optional = credentialOptional(plugin, spec.key)
    const state = credentialState(pluginId, spec)
    const status = state.present
      ? (state.via === 'stored'
        ? `<span class="ok">✓ ${e(t('plugins.cred_present_stored'))}</span>`
        : `<span class="ok">✓ ${e(t('plugins.cred_present_env', { name: state.name }))}</span>`)
      // A provider that works without a key must not be reported as if
      // something were broken — see credentialOptional().
      : `<span class="dim">${e(t(optional ? 'plugins.cred_missing_optional' : 'plugins.cred_missing'))}</span>`
    const declared = (spec.envKeys ?? []).length
      ? `<p class="dim">${e(t('plugins.cred_declared', { names: spec.envKeys.join(', ') }))}</p>` : ''
    const opt = optional ? `<p class="dim">${e(t('plugins.cred_optional'))}</p>` : ''
    const help = spec.helpKey ? `<p class="dim">${e(t(spec.helpKey))}</p>` : ''
    const off = (want) => (mode === want ? '' : ' hidden')
    const dis = (want) => (mode === want ? '' : ' disabled')
    return `<div class="cred">
      <b>${e(t(spec.labelKey))}</b> ${status}
      ${declared}${opt}${help}
      <label>${e(t('plugins.cred_mode'))}
        <select name="cred_${e(spec.key)}_mode">
          <option value="env" ${mode === 'env' ? 'selected' : ''}>${e(t('plugins.cred_mode_env'))}</option>
          <option value="value" ${mode === 'value' ? 'selected' : ''}>${e(t('plugins.cred_mode_value'))}</option>
        </select></label>
      <label${off('env')}>${e(t('plugins.cred_envvar'))}
        <input type="text" name="cred_${e(spec.key)}_env" value="${e(entry?.envVar ?? (spec.envKeys ?? [])[0] ?? '')}" autocomplete="off" spellcheck="false"${dis('env')}>
        <span class="dim">${e(t('plugins.cred_envvar_hint'))}</span></label>
      <label${off('value')}>${e(t('plugins.cred_value'))}
        <input type="password" name="cred_${e(spec.key)}_value" value="" autocomplete="new-password"${dis('value')}>
        <span class="dim">${e(t('plugins.cred_value_hint'))}</span></label>
    </div>`
  }).join('')
  return `<fieldset><legend>${e(t('plugins.credentials_legend'))}</legend>
    ${explain('plugins.credentials_explain')}
    ${rows}</fieldset>`
}

/** One `SettingField` a plugin declared for itself. */
function settingField(pluginId, field) {
  const name = `set_${field.key}`
  const value = pluginSettingValue(pluginId, field)
  const label = e(t(field.labelKey ?? field.key))
  const hint = field.hintKey ? `<span class="dim">${e(t(field.hintKey))}</span>` : ''
  if (field.type === 'switch') {
    return `<div>${checkbox(name, String(value) === '1' || value === true, t(field.labelKey ?? field.key))}${hint}</div>`
  }
  if (field.type === 'select') {
    const options = (field.options ?? []).map(o => {
      const id = typeof o === 'string' ? o : o.value
      const text = typeof o === 'string' ? o : t(o.labelKey ?? o.label ?? o.value)
      return `<option value="${e(id)}" ${String(value) === String(id) ? 'selected' : ''}>${e(text)}</option>`
    }).join('')
    return `<label>${label} <select name="${e(name)}">${options}</select>${hint}</label>`
  }
  const type = field.type === 'number' ? 'number' : field.type === 'password' ? 'password' : 'text'
  const num = field.type === 'number'
    ? `${field.min !== undefined ? ` min="${e(field.min)}"` : ''}${field.max !== undefined ? ` max="${e(field.max)}"` : ''}${field.step !== undefined ? ` step="${e(field.step)}"` : ''}`
    : ''
  // A password a plugin declares as a SETTING is still a secret: never pre-filled.
  const shown = type === 'password' ? '' : e(value ?? '')
  return `<label>${label} <input type="${type}" name="${e(name)}" value="${shown}"${num}>${hint}</label>`
}

function settingsBlock(pluginId, plugin) {
  const fields = pluginFields(plugin, 'settings')
  if (!fields.length) return ''
  return `<fieldset><legend>${e(t('plugins.settings_legend'))}</legend>
    ${fields.map(f => settingField(pluginId, f)).join('')}</fieldset>`
}

/**
 * The card's footer: what belongs to the plugin rather than to its settings.
 *
 * There are TWO removals here and they are not the same thing, which is what
 * "Forget configuration" managed to say accurately and nobody managed to read:
 *
 *  - **taking it out of the selection** — the configuration is dropped and the
 *    coding agent or model provider stops being offered in the forms. Nothing
 *    leaves this machine: the programme stays installed, and adding it back is
 *    one click. Every plugin has this;
 *  - **deleting the package** — an EXTERNAL plugin's directory is removed from
 *    the machine for good. Only an external package has this.
 *
 * They therefore get different words, different colours and different confirm
 * texts, and the harmless one carries a sentence saying what it does not do —
 * the reader of a button labelled "Remove" has every reason to expect the worse
 * of the two.
 *
 * The footer stands OUTSIDE the save form on purpose. A `<form>` inside a
 * `<form>` is not nesting, it is a parse error: the HTML parser drops the inner
 * one and its button ends up submitting the outer form — which here would mean
 * a removal quietly saving the plugin instead.
 */
function cardFooter(id, label, kind) {
  const forgetLabel = kind === 'provider' ? 'plugins.forget_provider' : 'plugins.forget_harness'
  const forget = pluginConfig(id)
    ? `<form method="post" action="/settings/plugins/remove" class="inline"
        onsubmit="return confirm(${e(JSON.stringify(t('plugins.forget_confirm', { label })))})">
        <input type="hidden" name="id" value="${e(id)}">
        <button class="ghost">${e(t(forgetLabel))}</button></form>
      <span class="dim footer-hint">${e(t('plugins.forget_hint'))}</span>` : ''
  let external = ''
  if (pluginSource(id) === 'external') {
    const version = pluginManifest(id)?.version ?? ''
    external = `<span class="dim">${e(t('plugins.external'))}${version ? ` · ${e(t('plugins.version', { version }))}` : ''}</span>
      <form method="post" action="/settings/plugins/uninstall" class="inline"
        onsubmit="return confirm(${e(JSON.stringify(t('plugins.uninstall_confirm', { label })))})">
        <input type="hidden" name="id" value="${e(id)}">
        <button class="danger">${e(t('plugins.uninstall'))}</button></form>
      <span class="dim footer-hint">${e(t('plugins.uninstall_hint'))}</span>`
  }
  if (!forget && !external) return ''
  return `<div class="btn-row plugin-footer">${forget}${external}</div>`
}

// ---------------- section 1: found on this machine ----------------

function discoverySection() {
  let open = []
  try { open = openDiscoveries() } catch { open = [] }
  const scanned = lastScanAt()
  const scanLine = `<div class="btn-row">
    <form method="post" action="/settings/plugins/scan" class="inline"><button>${e(t('plugins.scan_again'))}</button></form>
    <span class="dim">${e(scanned ? t('plugins.last_scan', { at: fmtDateTime(Date.parse(scanned)) }) : t('plugins.never_scanned'))}</span></div>`
  if (!open.length) return { html: '', scanLine }

  const cards = open.map(row => {
    const label = row.plugin?.label ?? row.plugin_id
    // What was found: a binary (with its path when the scan recorded one) or
    // the NAME of an environment variable. Never a value.
    const what = row.kind === 'harness'
      ? (row.detail?.path
        ? t('plugins.found_bin_path', { bin: row.detail.bin ?? row.plugin_id, path: row.detail.path })
        : t('plugins.found_bin', { bin: row.detail?.bin ?? row.plugin_id }))
      : t('plugins.found_env', { name: row.detail?.envVar ?? '' })
    return `<div class="card plugin-card">
      <h3>${e(label)} <span class="dim">${e(t(row.kind === 'harness' ? 'plugins.kind_harness' : 'plugins.kind_provider'))}</span></h3>
      <p>${e(what)}</p>
      <div class="btn-row">
        <form method="post" action="/settings/plugins/add" class="inline">
          <input type="hidden" name="id" value="${e(row.plugin_id)}">
          <button>${e(t('plugins.add'))}</button></form>
        <form method="post" action="/settings/plugins/discovery" class="inline">
          <input type="hidden" name="id" value="${e(row.id)}">
          <input type="hidden" name="answer" value="dismissed">
          <button class="ghost">${e(t('plugins.not_now'))}</button></form>
      </div></div>`
  }).join('')

  return {
    html: `<h2>${e(t('plugins.found_title'))}</h2>
      ${explain('plugins.found_explain')}
      ${cards}`,
    scanLine,
  }
}

// ---------------- section 2: coding agents ----------------

async function harnessSection() {
  let installed = []
  try { installed = await detectInstalled() } catch { installed = [] }
  const installedById = new Map(installed.map(i => [i.id, i.installed]))

  const cards = (await Promise.all(allPlugins().filter(p => p.kind === 'harness').map(async ({ id, plugin }) => {
    const configured = pluginConfig(id)
    const chosen = new Set(configured ? configured.config.providers : (plugin.providers ?? []))
    const isInstalled = installedById.get(id)
    const state = isInstalled
      ? `<span class="ok">✓ ${e(t('plugins.installed'))}</span>`
      : `<span class="warn">${e(t('plugins.not_installed'))}</span>`
    const hint = isInstalled || !plugin.installHint ? ''
      : `<p class="dim">${e(t('plugins.install_hint'))}: <code>${e(plugin.installHint)}</code></p>`
    return `<div class="card plugin-card ${configured && configured.enabled ? 'ok' : ''}">
      <h3>${e(plugin.label)} <span class="dim">${e(plugin.bin ?? id)}</span> ${state}</h3>
      ${plugin.descriptionKey ? `<p class="dim">${e(t(plugin.descriptionKey))}</p>` : ''}
      ${configured ? '' : `<p class="dim">${e(t('plugins.not_configured'))}</p>`}
      ${hint}
      <form method="post" action="/settings/plugins/save" class="form-grid">
        <input type="hidden" name="id" value="${e(id)}">
        ${checkbox('enabled', !!configured && configured.enabled === 1, t('plugins.enabled'))}
        <fieldset><legend>${e(t('plugins.providers_legend'))}</legend>
          ${await providerChoiceBlock(plugin, chosen)}</fieldset>
        ${credentialsBlock(id, plugin)}
        ${settingsBlock(id, plugin)}
        <div class="btn-row"><button>${e(t(configured ? 'settings.save' : 'plugins.add'))}</button></div>
      </form>
      ${cardFooter(id, plugin.label, 'harness')}
    </div>`
  }))).join('')

  return `<h2>${e(t('plugins.agents_title'))}</h2>
    ${explain('plugins.agents_explain')}
    ${cards || `<p class="dim">${e(t('plugins.none_registered'))}</p>`}`
}

// ---------------- section 3: model providers ----------------

function providerSection() {
  const cards = allPlugins().filter(p => p.kind === 'provider').map(({ id, plugin }) => {
    const on = isPluginEnabled(id)
    const badges = [
      plugin.llm ? `<span class="plugin-badge" title="${e(t('plugins.badge_llm_hint'))}">${e(t('plugins.badge_llm'))}</span>` : '',
      typeof plugin.balance === 'function' ? `<span class="plugin-badge" title="${e(t('plugins.badge_balance_hint'))}">${e(t('plugins.badge_balance'))}</span>` : '',
      pluginHasCredential(id) ? `<span class="plugin-badge ok">${e(t('plugins.badge_key'))}</span>` : '',
    ].filter(Boolean).join('')
    return `<div class="card plugin-card ${on ? 'ok' : ''}">
      <h3>${e(plugin.label)}</h3>
      ${plugin.descriptionKey ? `<p class="dim">${e(t(plugin.descriptionKey))}</p>` : ''}
      ${badges ? `<div class="plugin-badges">${badges}</div>` : ''}
      <form method="post" action="/settings/plugins/save" class="form-grid">
        <input type="hidden" name="id" value="${e(id)}">
        ${checkbox('enabled', on, t('plugins.enabled'))}
        ${credentialsBlock(id, plugin)}
        ${settingsBlock(id, plugin)}
        <div class="btn-row"><button>${e(t('settings.save'))}</button></div>
      </form>
      ${cardFooter(id, plugin.label, 'provider')}
    </div>`
  }).join('')

  return `<h2>${e(t('plugins.providers_title'))}</h2>
    ${explain('plugins.providers_explain')}
    ${cards || `<p class="dim">${e(t('plugins.none_registered'))}</p>`}`
}

// ---------------- section 4: plugin packages ----------------

function packagesSection() {
  let packages = []
  try { packages = listPackages() } catch { packages = [] }
  const rows = packages.map(p => `<tr${p.error ? ' class="broken"' : ''}>
    <td><code>${e(p.id)}</code></td>
    <td>${e(p.kind ? t(p.kind === 'harness' ? 'plugins.kind_harness' : 'plugins.kind_provider') : '—')}</td>
    <td>${e(p.name)}</td>
    <td>${e(p.version || '—')}</td>
    <td><code>${e(p.path)}</code></td>
    <td>${e(p.source)}</td>
    <td>${p.error ? `<code class="evidence">${e(p.error)}</code>` : ''}</td>
    <td>${p.error ? '' : `<form method="post" action="/settings/plugins/uninstall" class="inline"
      onsubmit="return confirm(${e(JSON.stringify(t('plugins.uninstall_confirm', { label: p.name })))})">
      <input type="hidden" name="id" value="${e(p.id)}">
      <button class="danger">${e(t('plugins.uninstall'))}</button></form>`}</td></tr>`).join('')

  // Registry errors are developer-facing English sentences (a broken manifest,
  // a refused id collision). They are rendered VERBATIM: translating a load
  // failure would only make it harder to search for.
  let errors = []
  try { errors = registryErrors() } catch { errors = [] }
  const errorBlock = errors.length
    ? `<h3>${e(t('plugins.errors_title'))}</h3>
       ${explain('plugins.errors_explain')}
       <ul class="incidents">${errors.map(x =>
      `<li class="red"><code>${e(x.where)}</code><code class="evidence">${e(x.error)}</code></li>`).join('')}</ul>`
    : ''

  return `<h2>${e(t('plugins.packages_title'))}</h2>
    ${explain('plugins.packages_explain')}
    ${rows ? `<div class="table-wrap"><table class="list plugin-packages"><thead><tr>
        <th>${e(t('plugins.pkg_col_id'))}</th><th>${e(t('plugins.pkg_col_kind'))}</th>
        <th>${e(t('plugins.pkg_col_name'))}</th><th>${e(t('plugins.pkg_col_version'))}</th>
        <th>${e(t('plugins.pkg_col_path'))}</th><th>${e(t('plugins.pkg_col_source'))}</th>
        <th>${e(t('plugins.pkg_col_error'))}</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div>`
    : `<p class="dim">${e(t('plugins.pkg_none'))}</p>`}
    ${errorBlock}
    <div class="card">
      <h3>${e(t('plugins.install_legend'))}</h3>
      ${explain('plugins.install_explain')}
      <form method="post" action="/settings/plugins/install" class="form-grid">
        <label>${e(t('plugins.install_path'))}
          <input type="text" name="path" placeholder="/path/to/plugin-package" spellcheck="false" autocomplete="off">
          <span class="dim">${e(t('plugins.install_path_hint'))}</span></label>
        <div class="btn-row"><button>${e(t('plugins.install'))}</button></div>
      </form>
      <p class="dim">${e(t('plugins.builtin_note'))}</p>
    </div>`
}

// ---------------- the page ----------------

export async function pagePlugins(req, res, url) {
  const found = discoverySection()
  const body = `
  <h2>${e(t('plugins.title'))}</h2>
  ${explain('plugins.intro')}
  ${found.html}
  ${found.scanLine}
  ${await harnessSection()}
  ${providerSection()}
  ${packagesSection()}`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    .end(await layout(req, t('plugins.title'), '/settings', body))
}

// ---------------- form handlers ----------------

const BACK = '/settings/plugins'

/** Only ever redirect back to a path on this hub. */
function safeBack(value) {
  const raw = String(value ?? '')
  return raw.startsWith('/') && !raw.startsWith('//') ? raw : BACK
}

/**
 * Save one plugin card: the enabled flag, the allowed model providers, the
 * credentials and the plugin's own declared settings.
 *
 * Everything is written through the store's own functions, so a value that
 * reaches the database has passed the same validation the seed and the wizard
 * pass — `setPluginProviders()` drops a provider the plugin does not declare,
 * `setCredential()` treats an empty password as "keep what is stored".
 */
export async function pluginsSave(req, res, url, formBody) {
  const b = await formBody()
  const id = String(b.id ?? '').trim()
  const plugin = getPlugin(id)
  if (!plugin) return problemPage(req, res, t('plugins.title'), [t('plugins.problem_unknown', { id })], BACK)
  const kind = pluginKind(id)

  setPluginConfig(id, { kind, source: pluginSource(id) ?? 'builtin', enabled: b.enabled === '1' ? 1 : 0 })
  if (kind === 'harness') setPluginProviders(id, b.providers_list ?? (b.providers ? [b.providers] : []))

  for (const spec of credentialSpec(plugin)) {
    const mode = b[`cred_${spec.key}_mode`] === 'value' ? 'value' : 'env'
    setCredential(id, spec.key, {
      mode,
      envVar: b[`cred_${spec.key}_env`] ?? '',
      value: b[`cred_${spec.key}_value`] ?? '',
    })
  }
  for (const field of pluginFields(plugin, 'settings')) {
    const raw = b[`set_${field.key}`]
    if (raw === undefined) continue
    setSetting(pluginSettingKey(id, field), String(raw))
  }
  redirect(res, BACK)
}

/**
 * "Add" from a finding: switch the plugin on with the providers it declares,
 * and record that this suggestion was answered — that is what makes the banner
 * go away and stay away.
 */
export async function pluginsAdd(req, res, url, formBody) {
  const b = await formBody()
  const id = String(b.id ?? '').trim()
  const plugin = getPlugin(id)
  if (!plugin) return problemPage(req, res, t('plugins.title'), [t('plugins.problem_unknown', { id })], BACK)
  const kind = pluginKind(id)
  setPluginConfig(id, { kind, source: pluginSource(id) ?? 'builtin', enabled: 1 })
  if (kind === 'harness') setPluginProviders(id, plugin.providers ?? [])
  answerDiscovery(`${kind}:${id}`, 'added')
  redirect(res, safeBack(b.back ?? BACK))
}

/** Forget a plugin's configuration — the plugin itself stays registered. */
export async function pluginsRemove(req, res, url, formBody) {
  const b = await formBody()
  const id = String(b.id ?? '').trim()
  if (!getPlugin(id)) return problemPage(req, res, t('plugins.title'), [t('plugins.problem_unknown', { id })], BACK)
  forgetPlugin(id)
  redirect(res, BACK)
}

/** Install an external package from a directory on this machine. */
export async function pluginsInstall(req, res, url, formBody) {
  const b = await formBody()
  const path = String(b.path ?? '').trim()
  if (!path) return problemPage(req, res, t('plugins.title'), [t('plugins.problem_no_path')], BACK)
  const r = await installFromDirectory(path)
  // The error is a developer-facing English sentence from install.mjs and is
  // shown as it stands: it names the manifest field or the colliding id.
  if (!r.ok) return problemPage(req, res, t('plugins.title'), [r.error], BACK)
  redirect(res, BACK)
}

/** Remove an external package: its directory and its stored configuration. */
export async function pluginsUninstall(req, res, url, formBody) {
  const b = await formBody()
  const r = uninstallPlugin(String(b.id ?? '').trim())
  if (!r.ok) return problemPage(req, res, t('plugins.title'), [r.error], BACK)
  redirect(res, BACK)
}

/** Scan the machine again. Never throws — a failed scan is an empty result. */
export async function pluginsScan(req, res, url, formBody) {
  await formBody()
  try { await scanSystem() } catch (err) { console.warn('[plugins] scan failed:', err.message) }
  redirect(res, BACK)
}

/**
 * Answer one finding, or every open one at once (the banner's "Not now").
 * Answering is what "asked once" means — see discovery.mjs.
 */
export async function pluginsDiscovery(req, res, url, formBody) {
  const b = await formBody()
  const answer = b.answer === 'added' ? 'added' : 'dismissed'
  try {
    if (b.all === '1') for (const row of openDiscoveries()) answerDiscovery(row.id, answer)
    else answerDiscovery(String(b.id ?? ''), answer)
  } catch (err) { console.warn('[plugins] discovery answer failed:', err.message) }
  redirect(res, safeBack(b.back ?? BACK))
}
