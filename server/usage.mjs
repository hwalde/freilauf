// cc-hub — subscription usage of the configured coding agents.
//
// Each harness plugin may implement usage() and report what its subscription
// account has consumed (Claude: the 5-hour window and both 7-day windows —
// general and fable — from quota.json; Cursor:
// spend, included amount and cycle end of the running period via the CLI
// token). Everything is best-effort and cached: a hanging endpoint must never
// block a page render.
import { getSetting } from './db.mjs'
import { enabledCodingAgents } from './coding-agents.mjs'

const CACHE_MS = 2 * 60_000
let cache = { at: 0, key: '', value: null }

/**
 * What the cached answer was computed FOR. The set of enabled coding agents
 * decides who gets asked at all, so a change to it makes the cached answer
 * wrong — not stale, wrong: with nothing configured the answer is [], and two
 * minutes of [] is what a freshly set-up hub would have shown after its first
 * page view. Time alone cannot express that, hence a second key.
 */
function agentKey() {
  return enabledCodingAgents().map(a => a.harness).sort().join(',')
}

/**
 * One request in flight per configuration.
 *
 * Two traps sit in this handful of lines, and the status sidebar walked into
 * both the day it started asking on every page:
 *
 *   1. The reset must hang on the PROMISE, not stand at the end of the body.
 *      With nothing configured the loop below has no `await` at all, so the
 *      body ran to completion — `inflight = null` included — before the
 *      assignment that stores the promise, and every later call got that one
 *      stale promise forever. The first page view of a fresh hub happens
 *      before anything is configured, so the panel stayed empty for the life
 *      of the process.
 *   2. An in-flight request may only be shared with a caller that wants the
 *      SAME thing. Keyed only on "is something running", a call made right
 *      after the operator enabled a coding agent got handed the answer to the
 *      question asked before that — correct-looking, and about the old world.
 */
let inflight = null   // { key, promise }

/**
 * Usage of all enabled coding agents: [{ harness, label, ok, data? }].
 * ok:false means the plugin is subscription-based but no usage source was
 * reachable — the UI shows that honestly instead of hiding the row.
 */
export async function subscriptionUsage({ force = false } = {}) {
  const key = agentKey()
  if (!force && cache.value && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.value
  if (inflight && inflight.key === key) return inflight.promise
  const task = (async () => {
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
    cache = { at: Date.now(), key, value: out }
    return out
  })()
  inflight = { key, promise: task }
  const release = () => { if (inflight?.promise === task) inflight = null }
  task.then(release, release)
  return task
}

/** Test hook: drop the cache. */
export function _usageCacheReset() { cache = { at: 0, key: '', value: null }; inflight = null }
