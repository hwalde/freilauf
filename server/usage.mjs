// Freilauf — subscription usage of the configured coding agents.
//
// Each harness plugin may implement usage() and report what its subscription
// account has consumed (Claude: the 5-hour window and every 7-day window —
// general plus the per-model ones — from the account's own usage endpoint, with
// quota.json as the fallback; Cursor: spend, included amount and cycle end of
// the running period via the CLI token). Everything is best-effort and cached:
// a hanging endpoint must never block a page render.
import { enabledCodingAgents } from './coding-agents.mjs'
import { pluginCtx } from './plugins/context.mjs'
import { env } from './env.mjs'

// A minute, not two: the sidebar now re-fetches on its own timer (hub.js), so
// the numbers it shows are only as fresh as this window. The suite shortens it
// further (FREILAUF_USAGE_CACHE_MS) because a browser test must not wait a minute.
const CACHE_MS = Number(env('USAGE_CACHE_MS') ?? 60_000)
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
  const cached = cache.value && cache.key === key ? cache.value : null
  if (!force && cached && Date.now() - cache.at < CACHE_MS) return cached
  if (inflight && inflight.key === key) {
    // Stale-but-usable beats waiting: hand the old answer back and let the
    // refresh already in flight finish in the background.
    return !force && cached ? cached : inflight.promise
  }
  const task = (async () => {
    const out = []
    for (const agent of enabledCodingAgents()) {
      const plugin = agent.plugin
      if (!plugin?.usage) continue
      let data = null
      // The plugin is handed its own context, so what it reports can depend on
      // what the operator configured for it — the included amount cursor falls
      // back on used to be looked up HERE, which meant this aggregator knew one
      // vendor's field names and the budget gate computed the same percentage a
      // second time. Both now come out of the plugin, once.
      try { data = await plugin.usage(pluginCtx(agent.harness)) } catch { data = null }
      if (!data) {
        if (plugin.subscription) out.push({ harness: agent.harness, label: plugin.label, ok: false })
        continue
      }
      out.push({ harness: agent.harness, label: plugin.label, ok: true, data })
    }
    cache = { at: Date.now(), key, value: out }
    return out
  })()
  inflight = { key, promise: task }
  const release = () => { if (inflight?.promise === task) inflight = null }
  task.then(release, release)
  // Stale-while-revalidate, and the reason is a hang rather than a preference.
  //
  // layout() awaits this, twice (the rail and the panel), on EVERY page. The
  // plugins behind it talk to the network — cursor's dashboard endpoint alone
  // carries a 12 s timeout — so for two minutes the hub was fast and then one
  // unlucky page view paid for everybody, up to a quarter of a minute of a
  // white screen. Nothing on a page render may wait on somebody else's server.
  //
  // An expired entry is therefore returned as it stands while the refresh runs
  // behind it; the live channel re-fetches the sidebar anyway, so the new
  // numbers arrive on their own. `force` (the /api/usage route) still waits —
  // that caller asked for the current answer, not for a fast one.
  if (!force && cached) return cached
  return task
}

/** Test hook: let the cache age by `ms`, so staleness can be tested without waiting. */
export function _usageCacheAge(ms) { cache.at -= ms }

/** Test hook: drop the cache. */
export function _usageCacheReset() { cache = { at: 0, key: '', value: null }; inflight = null }
