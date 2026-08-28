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
let cache = { at: 0, key: '', value: null }
// { key, promise } — see usage.mjs for both traps this shape avoids: a body
// without an `await` clearing the flag before it is set, and an in-flight
// request being shared with a caller that is asking about a different world.
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
  // Keyed on the relevant providers for the same reason usage.mjs is keyed on
  // the enabled coding agents: the selection decides who is asked, so changing
  // it does not make the answer old, it makes it about something else.
  const key = relevantProviderIds().join(',')
  const cached = cache.value && cache.key === key ? cache.value : null
  if (!force && cached && Date.now() - cache.at < CACHE_MS) return cached
  if (inflight && inflight.key === key) return !force && cached ? cached : inflight.promise
  const task = (async () => {
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
    cache = { at: Date.now(), key, value: out }
    return out
  })()
  inflight = { key, promise: task }
  const release = () => { if (inflight?.promise === task) inflight = null }
  task.then(release, release)
  // Stale-while-revalidate — same rule and same reason as usage.mjs: this is
  // awaited by layout() on every page, and it reaches two vendors' APIs.
  if (!force && cached) return cached
  return task
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

/** Test hook: let the cache age by `ms`, so staleness can be tested without waiting. */
export function _balanceCacheAge(ms) { cache.at -= ms }

/** Test hook: drop the cache. */
export function _balanceCacheReset() { cache = { at: 0, key: '', value: null }; inflight = null }
