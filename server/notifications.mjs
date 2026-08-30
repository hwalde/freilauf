// Freilauf — Settings → Notifications (`/settings/notifications`).
//
// One page for the whole question "where does this hub say things, and does it
// have to say them anywhere at all". The answer to the second half is NO, and
// the page opens by saying so: an installation with no channel configured runs
// fully — it schedules, watches, merges, reports and records exactly as before,
// it is simply quiet. Nothing here nags, and nothing elsewhere in the hub does
// either.
//
// It is the Plugins page's little sibling and deliberately built out of the
// SAME blocks (`checkbox`, `credentialsBlock`, `settingsBlock`, `cardFooter`
// from plugins/web.mjs): one card per registered notifier with its enabled
// flag, its declared settings, its credentials, a "send test message" button
// and — when the plugin brings one — a link to its own setup wizard.
//
// The wizard is the second half of this module. `/telegram-setup` used to be a
// page in pages.mjs that knew about BotFather, `getUpdates` and chat ids; that
// is knowledge about Telegram and belongs to the Telegram plugin. What stayed
// behind is the dispatcher below: three routes that hand a plugin's `setup`
// declaration the page helpers it needs (`t`, `e`, its own base path) and put
// whatever it returns inside the ordinary layout.
import { escapeHtml as e } from './util.mjs'
import { redirect } from './web-helpers.mjs'
import { t } from './i18n.mjs'
import { layout, problemPage } from './pages.mjs'
import { pluginSource, pluginManifest } from './plugins/registry.mjs'
import {
  setPluginConfig, isPluginEnabled, credentialSpec, setCredential, pluginHasCredential,
} from './plugins/store.mjs'
import {
  checkbox, credentialsBlock, settingsBlock, cardFooter, saveDeclaredSettings,
} from './plugins/web.mjs'
import { pluginCtx } from './plugins/context.mjs'
import {
  notifierPlugins, notifierEntry, notifierConfigured, notifiersConfigured, sendTest,
} from './notify.mjs'

const BASE = '/settings/notifications'

/**
 * Path segments after `/settings/notifications/` that are ROUTES, never plugin
 * ids. A plugin calling itself `save` would otherwise shadow the save route —
 * and since plugin ids come from a stranger's package, that has to be decided
 * here rather than hoped about.
 */
const RESERVED = new Set(['save', 'test'])

const explain = (key) => `<p class="dim">${e(t(key))}</p>`

// ---------------------------------------------------------------------------
// the page
// ---------------------------------------------------------------------------

function card({ id, plugin }) {
  const on = isPluginEnabled(id)
  const ready = notifierConfigured(id)
  const badges = [
    ready
      ? `<span class="plugin-badge ok">${e(t('notify.badge_ready'))}</span>`
      : `<span class="plugin-badge">${e(t('notify.badge_not_ready'))}</span>`,
    typeof plugin.setup?.render === 'function'
      ? `<span class="plugin-badge" title="${e(t('notify.badge_setup_hint'))}">${e(t('notify.badge_setup'))}</span>` : '',
    pluginHasCredential(id) ? `<span class="plugin-badge ok">${e(t('plugins.badge_key'))}</span>` : '',
  ].filter(Boolean).join('')

  // The test button and the setup link stand OUTSIDE the save form: a <form>
  // inside a <form> is a parse error, and the inner button would submit the
  // outer one — here that would mean "Send test message" quietly saving the
  // card instead (the same trap the Plugins page's footer is written around).
  const test = `<form method="post" action="${BASE}/test" class="inline">
      <input type="hidden" name="id" value="${e(id)}">
      <button class="ghost"${ready ? '' : ' disabled'}>${e(t('notify.test'))}</button></form>`
  const setupLink = typeof plugin.setup?.render === 'function'
    ? `<a class="btn ghost" href="${BASE}/${e(id)}">${e(t(plugin.setup.labelKey ?? 'notify.setup_open'))}</a>` : ''

  return `<div class="card plugin-card ${on && ready ? 'ok' : ''}">
    <h3>${e(plugin.label)}</h3>
    ${plugin.descriptionKey ? `<p class="dim">${e(t(plugin.descriptionKey))}</p>` : ''}
    <div class="plugin-badges">${badges}</div>
    <form method="post" action="${BASE}/save" class="form-grid">
      <input type="hidden" name="id" value="${e(id)}">
      ${checkbox('enabled', on, t('plugins.enabled'))}
      ${credentialsBlock(id, plugin)}
      ${settingsBlock(id, plugin)}
      <div class="btn-row"><button>${e(t('settings.save'))}</button></div>
    </form>
    <div class="btn-row">${test}${setupLink}</div>
    ${pluginSource(id) === 'external' && pluginManifest(id)?.version
      ? `<p class="dim">${e(t('plugins.version', { version: pluginManifest(id).version }))}</p>` : ''}
    ${cardFooter(id, plugin.label)}
  </div>`
}

export async function pageNotifications(req, res, url) {
  const list = notifierPlugins()
  const state = notifiersConfigured()
    ? `<p class="ok">✓ ${e(t('notify.state_on'))}</p>`
    // Deliberately `dim` and not `warn`: nothing is wrong here. A hub with no
    // channel configured is a supported, complete installation.
    : `<p class="dim">${e(t('notify.state_off'))}</p>`

  const flash = url?.searchParams?.get('test') === 'ok'
    ? `<p class="ok">✓ ${e(t('notify.test_ok'))}</p>`
    : url?.searchParams?.get('test')
      ? `<p class="err">${e(t('notify.test_fail', { error: url.searchParams.get('test') }))}</p>`
      : ''

  const body = `
  <h2>${e(t('notify.title'))}</h2>
  ${explain('notify.intro')}
  ${explain('notify.optional')}
  ${state}
  ${flash}
  ${list.map(card).join('') || `<p class="dim">${e(t('notify.none_registered'))}</p>`}
  <p class="dim">${e(t('notify.add_hint'))} <a href="/settings/plugins">${e(t('plugins.title'))}</a></p>`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    .end(await layout(req, t('notify.title'), '/settings', body))
}

// ---------------------------------------------------------------------------
// saving one card
// ---------------------------------------------------------------------------

export async function notificationsSave(req, res, url, formBody) {
  const b = await formBody()
  const id = String(b.id ?? '').trim()
  const entry = notifierEntry(id)
  if (!entry) return problemPage(req, res, t('notify.title'), [t('plugins.problem_unknown', { id })], BASE)

  setPluginConfig(id, { kind: 'notifier', source: pluginSource(id) ?? 'builtin', enabled: b.enabled === '1' ? 1 : 0 })
  for (const spec of credentialSpec(entry.plugin)) {
    setCredential(id, spec.key, {
      mode: b[`cred_${spec.key}_mode`] === 'value' ? 'value' : 'env',
      envVar: b[`cred_${spec.key}_env`] ?? '',
      value: b[`cred_${spec.key}_value`] ?? '',
    })
  }
  saveDeclaredSettings(id, entry.plugin, b)
  redirect(res, BASE)
}

/**
 * "Send test message". The result travels in the query string rather than in a
 * flash store, for the same reason the Telegram test button always did: without
 * feedback the button clicks into the void, and success and failure looked
 * identical.
 */
export async function notificationsTest(req, res, url, formBody) {
  const b = await formBody()
  const r = await sendTest(String(b.id ?? '').trim())
  // Translated HERE, not on the page it redirects to: the reason may be a
  // plugin's own i18n key, a plugin's own untranslated sentence or an exception
  // message, and resolving all three in one place is what keeps the page from
  // rendering an English word into a German UI. (`t()` on an unknown key
  // returns the key, and everything is escaped where it is rendered.)
  const reason = r.ok ? 'ok'
    : (r.errorKey ? t(r.errorKey) : (r.error || t('notify.err_not_delivered')))
  redirect(res, `${BASE}?test=${encodeURIComponent(reason)}`)
}

// ---------------------------------------------------------------------------
// the setup wizard a plugin brings
// ---------------------------------------------------------------------------

/**
 * What a `setup` handler is handed besides its own context: the translator, the
 * escaper and its own base path.
 *
 * Passing `t` and `e` IN is what lets a built-in plugin render a translated
 * page without importing `i18n.mjs` — the import rule for built-in plugin files
 * (docs/plugins.md) is not negotiable, and a wizard that could only speak
 * English would be a poor trade for it.
 */
function pageHelpers(id) {
  return { t, e, base: `${BASE}/${id}` }
}

/** The plugin behind `/settings/notifications/<id>`, or null. */
function setupEntry(id) {
  if (RESERVED.has(id)) return null
  const entry = notifierEntry(id)
  return typeof entry?.plugin?.setup?.render === 'function' ? entry : null
}

/** `GET /settings/notifications/<id>` — the plugin's own wizard, in our layout. */
export async function notifierSetupPage(req, res, url, id) {
  const entry = setupEntry(id)
  if (!entry) return problemPage(req, res, t('notify.title'), [t('plugins.problem_unknown', { id })], BASE)
  let html
  try {
    html = await entry.plugin.setup.render(pluginCtx(id), pageHelpers(id), url)
  } catch (err) {
    // A broken wizard costs its own page and nothing else — the same rule the
    // registry's error list follows.
    return problemPage(req, res, t('notify.title'), [String(err?.message ?? err)], BASE)
  }
  const title = t('notify.setup_title', { name: entry.plugin.label })
  const body = `<h2>${e(title)}</h2>
    <p class="dim"><a href="${BASE}">${e(t('notify.back'))}</a></p>
    ${html}`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    .end(await layout(req, title, '/settings', body))
}

/** `POST /settings/notifications/<id>/<action>` — one step of the wizard. */
export async function notifierSetupAction(req, res, url, id, action, formBody) {
  const entry = setupEntry(id)
  const fn = entry?.plugin.setup.actions?.[action]
  // "test" is offered to every wizard without the plugin declaring it: sending
  // one message is the last step of every setup there is.
  if (!fn && action === 'test') return notificationsTest(req, res, url, async () => ({ id }))
  if (!fn) return problemPage(req, res, t('notify.title'), [t('plugins.problem_unknown', { id: `${id}/${action}` })], BASE)
  const b = await formBody()
  let r
  try {
    r = await fn(pluginCtx(id), pageHelpers(id), b)
  } catch (err) {
    return problemPage(req, res, t('notify.title'), [String(err?.message ?? err)], `${BASE}/${id}`)
  }
  if (r?.error) return problemPage(req, res, t('notify.title'), [String(r.error)], `${BASE}/${id}`)
  redirect(res, r?.redirect ?? `${BASE}/${id}`)
}

/** `GET /settings/notifications/<id>/json/<name>` — a wizard's own JSON call. */
export async function notifierSetupJson(req, res, url, id, name) {
  const entry = setupEntry(id)
  const fn = entry?.plugin.setup.json?.[name]
  const out = (code, obj) =>
    res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(obj))
  if (!fn) return out(404, { ok: false, error: t('notify.setup_json_unknown') })
  try {
    const r = await fn(pluginCtx(id), pageHelpers(id), url)
    out(r?.status ?? 200, r?.body ?? { ok: false, error: t('notify.setup_json_empty') })
  } catch (err) {
    out(200, { ok: false, error: String(err?.message ?? err) })
  }
}
