// Freilauf — the model-source registry for the hub's OWN questions.
//
// The hub asks a model four things: a name for a run (title.mjs), whether a log
// line is a real outage (pruefer.mjs), what a report contains (flows/llm.mjs)
// and which files a worktree should also carry (extras-suggest.mjs). All four
// used to talk to OpenRouter directly, with the URL, the auth header and the
// response shape copy-pasted four times.
//
// They ask a SOURCE now, and a source is one of two things:
//
//   provider:<id>   a model provider that declares `llm` — OpenRouter, DeepSeek,
//                   opencode Zen. The ordinary case: one HTTP call.
//   agent:<id>      a CODING AGENT that declares `llm` — claude, opencode,
//                   hermes, cursor. It starts a whole CLI session for one
//                   question, which is slower and dearer (the plugin says so
//                   with `llm.overhead`), and it is the one way to run the hub
//                   with nothing configured but a subscription one already pays
//                   for.
//
// The two are one flat list on purpose (PLAN §3.8): a coding agent's model
// identifiers already carry the provider (`anthropic/claude-…`,
// `openrouter/…`), so there is no second "which provider" field anywhere and
// the model picker is simply filled by the chosen source's own `models()`.
//
// **A bare value with no prefix means `provider:openrouter`.** That is not a
// convenience, it is the backwards-compatible reading of everything the
// settings table holds today — and it is what makes an installation that
// changes nothing behave byte for byte as it did.
import { allPlugins, getPlugin, pluginKind, binaryPresent } from '../plugins/registry.mjs'
import { isPluginEnabled, credentialSpec, credentialValue } from '../plugins/store.mjs'
import { pluginCtx } from '../plugins/context.mjs'

/** What an unprefixed source string has always meant. */
export const DEFAULT_SOURCE = 'provider:openrouter'

/** Model lists change rarely — the same window models.mjs uses for a catalog. */
const LIST_MS = 6 * 60 * 60 * 1000

/** How long an installed/not-installed answer is believed. */
const READY_MS = 5 * 60 * 1000

export function defaultSource() { return DEFAULT_SOURCE }

/**
 * Read a stored source string.
 *
 * Everything that is not `agent:<id>` or `provider:<id>` is read as an
 * OpenRouter provider source: an empty setting, a legacy value, a hand-edited
 * row. There is deliberately no "invalid" answer here — `getSource()` decides
 * whether the plugin behind it exists, and that is the one question worth an
 * error message.
 */
export function parseSource(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return { kind: 'provider', pluginId: 'openrouter' }
  const m = /^(provider|agent):(.+)$/.exec(raw)
  if (!m) return { kind: 'provider', pluginId: 'openrouter' }
  return { kind: m[1], pluginId: m[2].trim() }
}

/** The canonical string for a kind/plugin pair. */
export function sourceId(kind, pluginId) {
  return `${kind === 'harness' ? 'agent' : kind}:${pluginId}`
}

// ---------------------------------------------------------------------------
// readiness
// ---------------------------------------------------------------------------

/** pluginId → { at, installed } — what `command -v` last said about a CLI. */
const installed = new Map()

/**
 * Can the hub use this source right now?
 *
 * Fail-soft in both directions, and that is the whole design: a source that is
 * NOT ready is still listed, still marked and still selectable — the operator
 * may be one form field away from configuring it, and a picker that hides the
 * thing one is about to set up is useless.
 *
 * For a model provider the question is answered synchronously: is there a
 * credential for every credential the plugin declares as REQUIRED? (Zen
 * declares its key as optional because its free models answer without one, so
 * Zen is ready with nothing configured — which is true.)
 *
 * For a coding agent the honest answer needs `command -v`, which is I/O. So it
 * is cached, refreshed in the background by `refreshSourceReadiness()` and by
 * `sourceModels()`, and **optimistic while unknown**: telling an operator that
 * their installed claude is missing is the worse of the two lies, and the
 * truthful one arrives at the next render.
 */
function readyNow(kind, pluginId, plugin) {
  if (kind === 'provider') return missingCredential(pluginId, plugin) === null
  const seen = installed.get(pluginId)
  return seen ? seen.installed : true
}

/**
 * The key of the first REQUIRED credential this plugin has no value for, or
 * null when nothing is missing. Only `required` counts: a provider that serves
 * free models without a key (Zen) must not be reported as unconfigured.
 */
export function missingCredential(pluginId, plugin = getPlugin(pluginId)) {
  for (const c of credentialSpec(plugin)) {
    if (!c.required) continue
    if (!credentialValue(pluginId, c.key)) return c.key
  }
  return null
}

/**
 * Probe the coding agents' binaries once and remember the answer.
 * Fire-and-forget; never throws. Called from `sourceModels()` (opening the
 * model picker is exactly when a fresh answer is wanted) and available to any
 * page that wants to warm it.
 */
export async function refreshSourceReadiness() {
  const now = Date.now()
  await Promise.all(allPlugins()
    .filter(p => p.kind === 'harness' && p.plugin?.llm)
    .filter(p => { const s = installed.get(p.id); return !s || now - s.at > READY_MS })
    .map(async (p) => {
      try { installed.set(p.id, { at: Date.now(), installed: await binaryPresent(p.plugin.bin) }) } catch { /* unknown stays unknown */ }
    }))
}

// ---------------------------------------------------------------------------
// the list
// ---------------------------------------------------------------------------

function entry(p) {
  const llm = p.plugin.llm
  return {
    id: sourceId(p.kind, p.id),
    kind: p.kind === 'harness' ? 'agent' : 'provider',
    pluginId: p.id,
    label: p.plugin.label ?? p.id,
    schema: llm.schema === 'native' || llm.schema === 'json_object' ? llm.schema : 'prompt',
    overhead: !!llm.overhead,
    ready: readyNow(p.kind, p.id, p.plugin),
  }
}

/**
 * Every source the operator may pick: registered, enabled, and declaring `llm`.
 *
 * Model providers come first and coding agents after them, because that is the
 * order of the recommendation — an agent source is the fallback for a machine
 * with no API key at all, not the default.
 */
export function llmSources() {
  const out = []
  for (const p of allPlugins()) {
    if (!p.plugin?.llm || typeof p.plugin.llm.complete !== 'function') continue
    if (!isPluginEnabled(p.id)) continue
    out.push(entry(p))
  }
  return out.sort((a, b) =>
    (a.kind === b.kind ? 0 : a.kind === 'provider' ? -1 : 1) || a.label.localeCompare(b.label))
}

/**
 * One source by id, with the plugin behind it — or null.
 *
 * Null means exactly one thing to the caller: there is nothing to ask. A plugin
 * that was uninstalled, a package that failed to load, a coding agent the
 * operator switched off — all of them end here, and `llmJson()` turns it into a
 * readable `stage: 'config'` answer rather than a throw.
 */
export function getSource(id) {
  const { kind, pluginId } = parseSource(id)
  const want = kind === 'agent' ? 'harness' : 'provider'
  if (pluginKind(pluginId) !== want) return null
  const plugin = getPlugin(pluginId)
  if (!plugin?.llm || typeof plugin.llm.complete !== 'function') return null
  if (!isPluginEnabled(pluginId)) return null
  return { ...entry({ id: pluginId, kind: want, plugin }), plugin }
}

// ---------------------------------------------------------------------------
// the model list of one source
// ---------------------------------------------------------------------------

// A cache of its own, and not models.mjs's.
//
// models.mjs holds exactly these manners (a TTL, one in-flight promise shared
// by parallel askers, the previous list served when a refresh fails) — but
// `holen()` is private to it, and models.mjs imports i18n.mjs and the harness
// registry. The LLM layer is asked from the launch path and from the watcher,
// so it stays on the lean side of that import. Twenty lines here is the cheaper
// of the two prices; if `holen()` ever becomes exported, this should go.
const cache = new Map()      // sourceId -> { at, value }
const inflight = new Map()   // sourceId -> Promise

/**
 * The models this source offers, as `[{id, name}]`.
 *
 * Never throws and never rejects: a provider that is down, a CLI that is not
 * installed, a plugin whose `models()` is missing — all of them answer with an
 * empty list (or the previous one), because the model field always keeps its
 * free-text input and a form must not break over a vendor.
 */
export async function sourceModels(id) {
  const src = getSource(id)
  if (!src) return []
  const key = src.id
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < LIST_MS) return hit.value
  if (inflight.has(key)) return inflight.get(key)

  const task = (async () => {
    try {
      if (typeof src.plugin.llm.models !== 'function') return hit?.value ?? []
      // Asking a coding agent for its models means running its CLI, which is
      // also the moment its installed/not-installed answer is worth refreshing.
      if (src.kind === 'agent') refreshSourceReadiness().catch(() => {})
      const raw = await src.plugin.llm.models(pluginCtx(src.pluginId))
      const value = (Array.isArray(raw) ? raw : [])
        .map(m => (typeof m === 'string'
          ? { id: m, name: m }
          : { id: String(m?.id ?? ''), name: String(m?.name ?? m?.id ?? '') }))
        .filter(m => m.id)
      cache.set(key, { at: Date.now(), value })
      return value
    } catch (err) {
      console.warn(`[llm] models for ${key}: ${err.message}${hit ? ' — serving the previous list' : ''}`)
      return hit?.value ?? []
    } finally {
      inflight.delete(key)
    }
  })()
  inflight.set(key, task)
  return task
}
