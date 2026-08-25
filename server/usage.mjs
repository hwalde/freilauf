// cc-hub — subscription usage of the configured coding agents.
//
// Each harness plugin may implement usage() and report what its subscription
// account has consumed (Claude: 5-hour/7-day windows from quota.json; Cursor:
// spend, included amount and cycle end of the running period via the CLI
// token). Everything is best-effort and cached: a hanging endpoint must never
// block a page render.
import { getSetting } from './db.mjs'
import { enabledCodingAgents } from './coding-agents.mjs'

const CACHE_MS = 2 * 60_000
let cache = { at: 0, value: null }
let inflight = null

/**
 * Usage of all enabled coding agents: [{ harness, label, ok, data? }].
 * ok:false means the plugin is subscription-based but no usage source was
 * reachable — the UI shows that honestly instead of hiding the row.
 */
export async function subscriptionUsage({ force = false } = {}) {
  if (!force && cache.value && Date.now() - cache.at < CACHE_MS) return cache.value
  if (inflight) return inflight
  inflight = (async () => {
    const out = []
    for (const agent of enabledCodingAgents()) {
      const plugin = agent.plugin
      if (!plugin?.usage) continue
      let data = null
      try { data = await plugin.usage() } catch { data = null }
      if (!data) {
        if (plugin.subscription) out.push({ harness: agent.harness, label: plugin.label, ok: false })
        continue
      }
      if (data.kind === 'cursor') {
        // The included amount comes from Cursor itself (GetCurrentPeriodUsage).
        // Only when that endpoint stays silent does the configured fallback step
        // in — and then the UI says so instead of presenting a guess as a fact.
        if (data.included_usd == null) {
          data.included_usd = Number(getSetting?.('cursor_included_usd') ?? 20) || 20
          data.included_estimated = true
        }
        data.pct = data.spent_usd != null && data.included_usd
          ? Math.round((data.spent_usd / data.included_usd) * 1000) / 10 : null
      }
      out.push({ harness: agent.harness, label: plugin.label, ok: true, data })
    }
    cache = { at: Date.now(), value: out }
    inflight = null
    return out
  })()
  return inflight
}

/** Test hook: drop the cache. */
export function _usageCacheReset() { cache = { at: 0, value: null }; inflight = null }
