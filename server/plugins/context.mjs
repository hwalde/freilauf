// cc-hub — the context a plugin is handed.
//
// A plugin never touches `process.env` or `db.mjs` itself. Everything it may
// need arrives through this object, and that is what makes two things possible
// at once: an EXTERNAL package can do its work without importing anything of
// ours, and the operator's own credential — a stored value or a differently
// named environment variable — is honoured everywhere, because the plugin asks
// `ctx.secret()` instead of reading a fixed variable name.
//
//   json(url, headers, init)   fetch with a timeout; throws `HTTP <status>`
//   registry()                 the cached models.dev snapshot
//   provider(id)               another provider's descriptor, resolved at CALL time
//   env                        process.env (legacy reads; prefer secret())
//   secret(key = 'api_key')    the resolved credential — stored, named, declared
//   setting(key, fallback)     this plugin's own setting value
//   log(msg)                   one fail-soft console line, prefixed with the id
//
// `json` and `registry` used to live in models.mjs as `providerCtx()`. They are
// here now and models.mjs delegates, so there is exactly ONE implementation of
// the timeout, of the error shape and of the models.dev cache — a second copy
// would drift the way the run definition once did.
//
// Import discipline: this module reaches the database (through store.mjs), and
// a PLUGIN FILE still must not. Plugins receive the context, they do not build
// one. That is also why nothing here is imported by `server/harnesses/*.mjs` or
// `server/providers/*.mjs`.
import { getSetting } from '../db.mjs'
import { credentialValue } from './store.mjs'
import { pluginFields, pluginSettingKey } from './settings.mjs'
import { getPlugin, getProvider } from './registry.mjs'

/** Vendor calls made from a plugin: 8 seconds, exactly as before. */
const TIMEOUT_MS = 8_000

/** The models.dev snapshot changes rarely; the old cache window was six hours. */
const REGISTRY_MS = 6 * 60 * 60 * 1000

/**
 * A JSON call to a vendor.
 *
 * `init` is passed to fetch as it stands (method, body, …) — except for
 * `timeoutMs`, which is this helper's own knob: an LLM completion needs more
 * than the eight seconds a catalog fetch does. The signal is set AFTER the
 * spread so an init object can never accidentally disarm the timeout.
 *
 * A non-2xx answer throws `HTTP <status>` — the one error shape every caller in
 * the hub already matches on.
 */
export async function pluginJson(url, headers = {}, init = {}) {
  const { timeoutMs = TIMEOUT_MS, ...rest } = init ?? {}
  const res = await fetch(url, { ...rest, headers, signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

let registryCache = { at: 0, value: null }
let registryInflight = null

/**
 * Names, context lengths and prices from the registry opencode itself uses.
 *
 * Cached, and parallel askers share one request: several provider plugins reach
 * for it while a single form is being rendered. A failed refresh keeps serving
 * the previous snapshot — an outdated catalog is worth more than none, and the
 * free model input always works anyway.
 */
export async function modelRegistry() {
  if (registryCache.value && Date.now() - registryCache.at < REGISTRY_MS) return registryCache.value
  if (registryInflight) return registryInflight
  const task = (async () => {
    try {
      const value = await pluginJson('https://models.dev/api.json')
      registryCache = { at: Date.now(), value }
      return value
    } catch (err) {
      console.warn(`[plugins] models.dev: ${err.message}${registryCache.value ? ' — serving the previous snapshot' : ''}`)
      return registryCache.value ?? {}
    }
  })()
  registryInflight = task
  const release = () => { if (registryInflight === task) registryInflight = null }
  task.then(release, release)
  return task
}

/** Test hook: drop the models.dev snapshot. */
export function _registryReset() { registryCache = { at: 0, value: null }; registryInflight = null }

/**
 * One declared setting of this plugin.
 *
 * Resolved through the plugin's own field declaration so a historic
 * `settingKey` (`openrouter_min_eur`, `claude_gate_5h`, …) is honoured — that
 * is the whole reason the escape hatch exists. A key the plugin does not
 * declare falls back to the namespaced `plugin_<id>_<key>`, so a plugin can
 * store something it never put in a form.
 */
function settingOf(pluginId, key, fallback = null) {
  if (!pluginId) return fallback
  const plugin = getPlugin(pluginId)
  for (const group of ['settings', 'gate']) {
    const field = pluginFields(plugin, group).find(f => f.key === key)
    if (!field) continue
    const v = getSetting(pluginSettingKey(pluginId, field))
    if (v !== null && v !== undefined && String(v).trim() !== '') return v
    return field.default ?? fallback
  }
  const v = getSetting(`plugin_${pluginId}_${key}`)
  return v === null || v === undefined ? fallback : v
}

/**
 * The context for one plugin. `pluginId` may be null for the handful of callers
 * that only want the fetch helper and the registry (the model catalog fetches
 * predate credentials); `secret()` then answers null instead of guessing.
 */
export function pluginCtx(pluginId = null) {
  const id = pluginId ? String(pluginId) : null
  return {
    json: pluginJson,
    registry: modelRegistry,
    // Another plugin's descriptor — the one thing a harness plugin genuinely
    // needs from outside itself: opencode and hermes address a MODEL PROVIDER
    // and have to know its opencode prefix, its models.dev key and the
    // environment variables it declares.
    //
    // It has to be a function on the context rather than an import, and the
    // reason is a real cycle: `providers/index.mjs` re-exports the registry,
    // and the registry's module body builds `{claude, opencode, hermes, …}` out
    // of the very plugin files that would be importing it. A static import
    // there makes the plugin unimportable on its own — measured, `ReferenceError:
    // Cannot access 'opencode' before initialization`. Resolving here happens at
    // CALL time, which is after every module has finished evaluating.
    provider: (id) => getProvider(id),
    env: process.env,
    secret: (key = 'api_key') => (id ? credentialValue(id, key) : null),
    setting: (key, fallback = null) => settingOf(id, key, fallback),
    log: (msg) => { try { console.log(`[plugin ${id ?? '?'}] ${msg}`) } catch { /* a log line never fails a run */ } },
  }
}
