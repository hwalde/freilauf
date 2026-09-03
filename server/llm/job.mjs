// Freilauf — the ONE place that turns an LLM job's purpose into a call plan.
//
// The hub asks a model four things of its own (title, check, extract, extras),
// and every one of them can name its own source. Before this module four
// callers each carried the same private copies: read `llm_<p>_source`, read
// `llm_<p>_or_routing`, parse the JSON tolerantly, resolve the chain. Four
// copies of one decision is how the copies drift — the same reason run-def.mjs
// exists. Every caller asks here now, and `llmJson()` (index.mjs) executes
// what this module planned.
//
// A job's plan is a CHAIN: the primary source first, then the fallbacks. On a
// transport failure (provider down, rate limit, timeout) `llmJson` walks the
// chain; only when the whole chain is exhausted does the exponential retry
// with jitter begin (`llm_retry_*`, see index.mjs). A fallback needs no code:
// it is an ordinary source id, resolved through the same plugin registry —
// `provider:deepseek`, or `agent:claude` (claude's print-only mode, `-p`),
// which is why a subscription that is already paid for can be the fallback
// for every question the hub asks.
import { getSetting } from '../db.mjs'
import { getSource, missingCredential, defaultSource } from './sources.mjs'

/**
 * Read the stored fallback list of one job.
 *
 * The settings page writes ONE source id (its select); the value is stored as
 * a comma-separated list so a hand-edited row can carry an ordered chain
 * without a migration. The parse is deliberately STRICT, the opposite of
 * `parseSource()`: an unprefixed value there means OpenRouter (the
 * backwards-compatible reading of an old row), while here junk means "no
 * fallback" — a half-typed value must never silently re-point a fallback at
 * OpenRouter.
 */
export function parseFallbackList(value) {
  return String(value ?? '')
    .split(/[,\s]+/)
    .map(s => s.trim())
    .filter(s => /^(provider|agent):[\w][\w.-]*$/.test(s))
}

/**
 * The fallback entries of one job, resolved against `primaryModel`.
 *
 * A fallback without a model of its own (`llm_<p>_fallback_model`) inherits
 * the primary's model — usually right, since both typically speak the same
 * OpenRouter-style slugs. An AGENT fallback needs no model at all: its plugin
 * picks its own default (claude does), and `llmJson` allows that.
 */
export function jobFallbacks(purpose, primaryModel) {
  const own = (getSetting(`llm_${purpose}_fallback_model`) ?? '').trim()
  return parseFallbackList(getSetting(`llm_${purpose}_fallback`))
    .map(source => ({ source, model: own || primaryModel }))
}

/**
 * The OpenRouter routing of one job: the serving-provider pin and the stored
 * auto-routing config. Tolerant of nulls and junk: no config, a broken blob —
 * all mean "no auto routing", the plain serving-provider setting then decides
 * alone. This used to be four identical private helpers, one per caller.
 */
export function jobRouting(purpose) {
  const servingProvider = (getSetting(`llm_${purpose}_or_provider`) ?? '').trim() || null
  const raw = getSetting(`llm_${purpose}_or_routing`)
  let orRouting = null
  if (raw) {
    try {
      const cfg = JSON.parse(raw)
      orRouting = cfg?.mode === 'auto' ? cfg : null
    } catch { /* old rows and nulls */ }
  }
  return { servingProvider, orRouting }
}

/**
 * The primary source of one job, as it is stored. Unset = OpenRouter, the
 * backwards-compatible reading every installation relies on.
 */
export function jobSource(purpose) {
  return (getSetting(`llm_${purpose}_source`) ?? '').trim() || defaultSource()
}

/**
 * Is at least one entry of the job's chain usable right now?
 *
 * "Usable" is what the old single-source check was: the source exists, is
 * switched on, and has every credential it declares as required. An agent
 * source declares none (its binary is probed optimistically, sources.mjs), so
 * picking one is enough — which is the point of offering them. The fallbacks
 * count in: a primary without a key and a fallback that has one is a working
 * job, and saying it is off would hide a configuration that works.
 */
export function chainUsable(purpose, primaryModel) {
  const entries = [{ source: jobSource(purpose), model: primaryModel }, ...jobFallbacks(purpose, primaryModel)]
  for (const entry of entries) {
    const src = getSource(entry.source)
    if (!src) continue
    if (!entry.model && src.kind !== 'agent') continue
    if (missingCredential(src.pluginId, src.plugin) !== null) continue
    return true
  }
  return false
}
