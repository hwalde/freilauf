// cc-hub — account balances of the configured model providers.
//
// The sibling of usage.mjs: that one asks the harness plugins what a
// SUBSCRIPTION has consumed, this one asks the provider plugins what an account
// still holds. Same ground rule — best-effort and cached, because a hanging
// endpoint must never block a page render.
//
// Why this is a module and not a function in quota.mjs: it used to be one.
// `openrouterCredits()` sat there with the URL, the auth header and the response
// shape of exactly one vendor hard-coded into it, which is the kind of
// provider-specific knowledge docs/plugins.md says belongs in the plugin. The
// moment a second provider reports a balance, the copy would have started.
import { getProvider, providerHasKey } from './providers/index.mjs'
import { enabledCodingAgents } from './coding-agents.mjs'
import { providerCtx } from './models.mjs'

const CACHE_MS = 2 * 60_000
let cache = { at: 0, value: null }
let inflight = null

/**
 * Provider ids worth asking: those that at least one ENABLED coding agent is
 * allowed to use. Without this filter the panel would report a balance for a
 * provider the operator never selected — a number nobody can act on.
 */
export function relevantProviderIds() {
  const ids = new Set()
  for (const agent of enabledCodingAgents()) {
    for (const id of agent.providerIds ?? []) ids.add(id)
  }
  return [...ids].sort()
}

/**
 * Balances of all relevant providers: [{ provider, label, ok, data? }].
 *
 * A provider WITHOUT a credential is left out entirely — there is nothing to
 * report and nothing wrong. `ok:false` therefore means what it says: a key is
 * configured but the endpoint did not answer, and the UI states that instead of
 * hiding it. (The same distinction usage.mjs draws for subscription plugins.)
 */
export async function providerBalances({ force = false } = {}) {
  if (!force && cache.value && Date.now() - cache.at < CACHE_MS) return cache.value
  if (inflight) return inflight
  inflight = (async () => {
    const ctx = providerCtx()
    const out = []
    for (const id of relevantProviderIds()) {
      const plugin = getProvider(id)
      if (!plugin?.balance) continue
      if (!providerHasKey(id, ctx.env)) continue
      let data = null
      try { data = await plugin.balance(ctx) } catch { data = null }
      out.push(data
        ? { provider: id, label: plugin.label, ok: true, data }
        : { provider: id, label: plugin.label, ok: false })
    }
    cache = { at: Date.now(), value: out }
    inflight = null
    return out
  })()
  return inflight
}

/**
 * What one provider still holds, in one currency — the shape a budget gate
 * needs. Returns null when the provider does not report, has no key, or knows
 * no such currency: "not reported" is never "zero".
 */
export function remainingIn(balance, currency = 'USD') {
  const amount = (balance?.amounts ?? []).find(a => a.currency === currency)
  return amount?.remaining ?? null
}

/** Test hook: drop the cache. */
export function _balanceCacheReset() { cache = { at: 0, value: null }; inflight = null }
