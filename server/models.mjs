// Freilauf — model lists and reasoning-effort levels, orchestrated across the
// plugin registries (server/providers, server/harnesses). All remote fetches
// happen HERE, in the server: the browser only reaches the hub on 127.0.0.1
// and must not contact foreign hosts.
//
// Ground rule (the same one balances.mjs and usage.mjs follow): a hanging or broken
// provider API must NEVER block the form. In doubt the caller gets an outdated
// list or none at all — the free slug input always works.
import { execFile } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { getHarness } from './harnesses/index.mjs'
import { t } from './i18n.mjs'
import { getProvider, providerLabel } from './providers/index.mjs'
import { pluginCtx, pluginJson, modelRegistry } from './plugins/context.mjs'
import { pluginHasCredential } from './plugins/store.mjs'
const execFileAsync = promisify(execFile)

const LISTE_MS = 6 * 60 * 60 * 1000   // model lists rarely change
const ENDPUNKTE_MS = 15 * 60 * 1000   // serving providers fluctuate more often
const HARNESS_MS = 24 * 60 * 60 * 1000 // effort levels only change on CLI updates
// A coding agent's own credential store: cheap to read, but it changes the
// moment the operator logs the CLI in, and the Plugins page is exactly where
// they would go to look afterwards. Five minutes is short enough that "I just
// added it" is not contradicted for long.
const OWN_CRED_MS = 5 * 60 * 1000

/**
 * Which providers can a harness offer HERE and NOW? Capability comes from the
 * harness plugin; a provider without credentials is only offered when the
 * harness can use it key-free — the dropdown must only show what will actually
 * run. (Restriction to the operator's per-coding-agent selection happens in
 * coding-agents.mjs on top of this.)
 *
 * "Has a credential" is `pluginHasCredential()`, the SAME question the budget
 * gate, balances.mjs and the Plugins page ask — not `providerHasKey()`, which
 * only ever looked at `process.env`. A provider whose key the operator stored
 * as a value on the Plugins page was honoured at launch (the run gets it
 * through `secret()`) and never offered in the run form: configured, working,
 * invisible.
 */
export function providerFuerHarness(harness) {
  const plugin = getHarness(harness)
  if (!plugin || plugin.subscription) return []
  const out = []
  for (const id of plugin.providers ?? []) {
    const keyFree = (plugin.keyFreeProviders ?? []).includes(id)
    if (!keyFree && !pluginHasCredential(id)) continue
    // The hint says what it MEANS for the operator, not by which mechanism it
    // comes about: "works without an own key" read like a fault report next to
    // a provider that was working perfectly well. The Plugins page can say more
    // than this (it asks the coding agent what it really holds); a dropdown
    // entry has room for the consequence and nothing else.
    out.push({ id, label: providerLabel(id), ...(keyFree ? { hinweisKey: 'provider.no_key_needed' } : {}) })
  }
  return out
}

/**
 * Which model providers does this coding agent hold credentials for ITSELF?
 *
 * The plugin capability (`ownCredentials(ctx)`, see server/harnesses/opencode.mjs
 * and docs/plugins.md) is optional, may probe the machine, and answers `null`
 * for "could not be established" — which the UI must never render as a claim.
 * Callers get exactly those three answers back: `null` (unknown, fall back to
 * the declared `keyFreeProviders`), `[]` (asked, holds none) or the ids.
 *
 * Cached here rather than in the plugin, the way `effortLevels()` already is:
 * a plugin file may not import this module, and the page asks once per card.
 * A probe that throws is an unknown answer, never a failed page.
 */
export async function harnessOwnCredentials(harness) {
  const plugin = getHarness(harness)
  if (typeof plugin?.ownCredentials !== 'function') return null
  // Wrapped in an object because `holen()` treats a cached null as "nothing
  // cached" — the unknown answer would otherwise re-probe on every render.
  const r = await holen(`owncreds:${plugin.id}`, OWN_CRED_MS, async () => {
    const ids = await plugin.ownCredentials(pluginCtx(plugin.id))
    return { ids: Array.isArray(ids) ? ids.map(String) : null }
  })
  return r.liste?.ids ?? null
}

// ---------------- cache infrastructure ----------------
const cache = new Map()      // key -> { at, value }
const laufend = new Map()    // key -> Promise; parallel form requests share one fetch

function frisch(key, maxAge) {
  const e = cache.get(key)
  return e && Date.now() - e.at < maxAge ? e.value : null
}

async function holen(key, maxAge, fetchFn) {
  const good = frisch(key, maxAge)
  if (good) return { liste: good, veraltet: false }
  if (laufend.has(key)) return laufend.get(key)

  const p = (async () => {
    try {
      const value = await fetchFn()
      cache.set(key, { at: Date.now(), value })
      return { liste: value, veraltet: false }
    } catch (err) {
      const old = cache.get(key)?.value
      console.warn(`[models] ${key}: ${err.message}${old ? ' — serving stale list' : ''}`)
      return old ? { liste: old, veraltet: true } : { liste: null, veraltet: false, fehler: err.message }
    } finally {
      laufend.delete(key)
    }
  })()
  laufend.set(key, p)
  return p
}

// The fetch helper and the models.dev snapshot live in the plugin context now
// (server/plugins/context.mjs), so a plugin gets exactly ONE implementation of
// the timeout, of the `HTTP <status>` error shape and of that cache — whether
// it is asked for a model list here, for a balance from quota.mjs or for a
// completion from server/llm.
const json = pluginJson
const registry = modelRegistry

/**
 * Helper context injected into provider plugins.
 *
 * Delegates to `pluginCtx()`, which adds what this one could never have: the
 * credential the operator configured (`secret()`) and the plugin's own settings
 * (`setting()`). Callers that name the provider get those; the handful that do
 * not — the catalog fetches, which predate credentials — get the same fetch
 * helper they always had.
 */
export function providerCtx(providerId = null) {
  return pluginCtx(providerId)
}

/**
 * `opencode models --pure` prints 568 lines — but only reliably when the
 * output goes to a FILE. Reading it through a pipe from node loses chunks at
 * process exit: measured 168, 244, 260, 307 instead of 360 OpenRouter models,
 * with perfectly stable output in a shell. A silently halved catalog would be
 * worse than none — hence the detour through a temp file.
 */
async function opencodeCliListe() {
  const file = join(tmpdir(), `freilauf-opencode-models-${process.pid}.txt`)
  try {
    await execFileAsync('sh', ['-c', `opencode models --pure > ${JSON.stringify(file)}`], { timeout: 120_000 })
    return readFileSync(file, 'utf8')
  } finally {
    try { rmSync(file, { force: true }) } catch { /* cleanup is best-effort */ }
  }
}

/**
 * Which models does the LOCAL opencode actually accept for this provider?
 * opencode's provider list is credential-gated — the vendor catalog on the
 * other hand contains models that would fail here immediately for lack of a
 * key. Returns null when opencode cannot be asked (then the catalog stands).
 */
async function opencodeIds(provider) {
  const prefix = getProvider(provider)?.ocPrefix
  if (!prefix) return null
  const all = await holen('opencode-cli', LISTE_MS, async () => {
    const stdout = await opencodeCliListe()
    return stdout.split('\n').map(z => z.trim()).filter(Boolean)
  })
  if (!all.liste) return null
  return all.liste.filter(z => z.startsWith(prefix + '/')).map(z => z.slice(prefix.length + 1))
}

/**
 * Models of one provider. Returns { liste, veraltet, fehler? } — 'liste' is
 * null when nothing could be fetched; the form then keeps the free slug input.
 */
function katalog(provider) {
  const plugin = getProvider(provider)
  if (!plugin) return Promise.resolve({ liste: null, veraltet: false, fehler: t('api.unknown_provider', { provider }) })
  return holen(provider, LISTE_MS, () => plugin.fetchModels(providerCtx(provider)))
}

export async function modelList(provider, harness = null) {
  // Subscription harnesses (claude, cursor) act as their own "provider": the
  // model list belongs to the account and comes from the harness plugin.
  const sub = getHarness(provider)
  if (sub?.subscription && sub.fetchModels) {
    return holen(provider, LISTE_MS, () => sub.fetchModels())
  }
  const k = await katalog(provider)
  if (harness !== 'opencode') return k

  // For opencode only what opencode accepts counts. The catalog then merely
  // provides the description (name, context, price hint).
  const ids = await opencodeIds(provider)
  if (!ids?.length) return k.liste ? { ...k, katalog: true } : k
  const meta = new Map((k.liste ?? []).map(m => [m.id, m]))
  return {
    liste: ids.map(id => meta.get(id) ?? { id, name: id, ctx: null, tools: true })
      .sort((a, b) => a.id.localeCompare(b.id)),
    veraltet: k.veraltet ?? false,
  }
}

/**
 * Serving providers (endpoints) of an OpenRouter model.
 * Important: ALWAYS use 'tag' as the value — 'provider_name' is not unique
 * (the same "Google" stands for several regions).
 */
export function orEndpoints(modelId) {
  const id = String(modelId ?? '').trim()
  // OpenRouter IDs may start with '~' (e.g. ~anthropic/claude-fable-latest).
  if (!/^[\w.~\-]+\/[\w.~\-:]+$/.test(id)) {
    return Promise.resolve({ liste: null, veraltet: false, fehler: t('api.model_id_shape') })
  }
  return holen(`endpoints:${id}`, ENDPUNKTE_MS, async () => {
    const j = await json(`https://openrouter.ai/api/v1/models/${id}/endpoints`)
    return (j.data?.endpoints ?? []).map(ep => ({
      tag: ep.tag,
      name: ep.provider_name ?? ep.tag,
      ctx: ep.context_length ?? null,
      uptime: ep.uptime_last_30m ?? null,
    })).filter(ep => ep.tag)
  })
}

/** When was the list last fetched? For the "as of hh:mm" hint. */
export function standVon(provider) {
  const at = cache.get(provider)?.at
  return at ? new Date(at).toISOString() : null
}

// ================= reasoning effort =================
// Three layers with different strictness — which is why this is orchestrated
// here instead of typing a level list somewhere:
//   claude   accepts each of its levels for EVERY model (measured, no gating)
//   opencode validates against its catalog and SILENTLY discards unknowns
//   hermes   validates nothing and passes everything through

/** opencode's own catalog snapshot — byte-identical with models.dev, but offline. */
async function katalogRegistry() {
  const local = join(homedir(), '.cache', 'opencode', 'models.json')
  try { return JSON.parse(readFileSync(local, 'utf8')) } catch { /* then via network */ }
  return registry()
}

/**
 * Effort levels of a model according to the catalog. Exactly this list is what
 * opencode validates against. Only type==='effort' has levels — 'toggle'
 * (on/off only) and 'budget_tokens' (token budget only) support reasoning but
 * no levels; a level dropdown would simply be wrong there.
 */
async function registryEffort(provider, model) {
  const mdKey = getProvider(provider)?.mdKey
  if (!mdKey) return null
  const kat = await holen('katalog-registry', LISTE_MS, katalogRegistry)
  const m = kat.liste?.[mdKey]?.models?.[model]
  if (!m?.reasoning) return null
  const eff = (m.reasoning_options ?? []).find(o => o.type === 'effort')
  return eff?.values?.length ? { stufen: eff.values, standard: null, pflicht: false } : null
}

/** What OpenRouter itself says about the model (additionally knows default and mandatory). */
async function openrouterEffort(model) {
  const k = await katalog('openrouter')
  return k.liste?.find(m => m.id === model)?.reasoning ?? null
}

/**
 * Levels for exactly this combination of harness, provider and model.
 * Returns { stufen: null, hinweisKey } when nothing reliable is available —
 * the form then hides the field. A field that does nothing would be worse than
 * none: with opencode and hermes a wrong level fizzles silently.
 */
export async function effortOptionen(harness, provider, model) {
  if (!harness) return { stufen: null, hinweisKey: 'effort.no_harness' }
  const plugin = getHarness(harness)
  if (!plugin) return { stufen: null, hinweisKey: 'effort.unknown_harness' }
  const helpers = {
    ownLevels: async () => {
      if (!plugin.effortLevels) return null
      const r = await holen(`stufen:${plugin.id}`, HARNESS_MS, () => plugin.effortLevels())
      return r.liste ?? null
    },
    registryEffort,
    openrouterEffort,
  }
  return plugin.effortOptions({ provider: provider || '', model: model || '', helpers })
}
