// cc-hub — model lists and reasoning-effort levels, orchestrated across the
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
import { getProvider, providerLabel, providerHasKey } from './providers/index.mjs'
const execFileAsync = promisify(execFile)

const LISTE_MS = 6 * 60 * 60 * 1000   // model lists rarely change
const ENDPUNKTE_MS = 15 * 60 * 1000   // serving providers fluctuate more often
const HARNESS_MS = 24 * 60 * 60 * 1000 // effort levels only change on CLI updates
const ZEITLIMIT = 8_000

/**
 * Which providers can a harness offer HERE and NOW? Capability comes from the
 * harness plugin; a provider without credentials is only offered when the
 * harness can use it key-free — the dropdown must only show what will actually
 * run. (Restriction to the operator's per-coding-agent selection happens in
 * coding-agents.mjs on top of this.)
 */
export function providerFuerHarness(harness) {
  const plugin = getHarness(harness)
  if (!plugin || plugin.subscription) return []
  const out = []
  for (const id of plugin.providers ?? []) {
    const keyFree = (plugin.keyFreeProviders ?? []).includes(id)
    if (!keyFree && !providerHasKey(id)) continue
    out.push({ id, label: providerLabel(id), ...(keyFree ? { hinweisKey: 'provider.keyfree' } : {}) })
  }
  return out
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

async function json(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(ZEITLIMIT) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

/** Names and prices from the registry opencode itself uses. */
async function registry() {
  return holen('models.dev', LISTE_MS, () => json('https://models.dev/api.json'))
    .then(r => r.liste ?? {})
}

/** Helper context injected into provider plugins. */
export function providerCtx() {
  return { json, registry, env: process.env }
}

/**
 * `opencode models --pure` prints 568 lines — but only reliably when the
 * output goes to a FILE. Reading it through a pipe from node loses chunks at
 * process exit: measured 168, 244, 260, 307 instead of 360 OpenRouter models,
 * with perfectly stable output in a shell. A silently halved catalog would be
 * worse than none — hence the detour through a temp file.
 */
async function opencodeCliListe() {
  const file = join(tmpdir(), `cc-hub-opencode-models-${process.pid}.txt`)
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
  return holen(provider, LISTE_MS, () => plugin.fetchModels(providerCtx()))
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
