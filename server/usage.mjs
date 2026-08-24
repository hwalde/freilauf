// cc-hub — subscription usage of the configured coding agents.
//
// Each harness plugin may implement usage() and report what its subscription
// account has consumed (Claude: 5-hour/7-day windows from quota.json; Cursor:
// spent USD of the current cycle via the CLI token). Everything is best-effort
// and cached: a hanging endpoint must never block a page render.
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
        // No public endpoint exposes the included quota — the percentage is
        // computed against a configurable amount (default: Pro's 20 USD).
        const included = Number(getSetting?.('cursor_included_usd') ?? 20) || 20
        data.included_usd = included
        data.pct = data.spent_usd != null ? Math.round((data.spent_usd / included) * 1000) / 10 : null
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
