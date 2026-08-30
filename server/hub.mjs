#!/usr/bin/env node
// Freilauf — main entry point: HTTP + WS + scheduler + watcher in one process (planning 5).
import http from 'node:http'
import process from 'node:process'
import { loadExternalPlugins } from './plugins/loader.mjs'
import { env } from './env.mjs'

// External plugin packages join the registry HERE, before any module that
// reads it has been evaluated — a coding agent that arrives after the first
// form was rendered is one the operator cannot choose, and the seed below
// validates against the registry too.
//
// That is why every import after this line is a DYNAMIC one: `import`
// statements are hoisted and all run before the first statement in the body,
// so a static import list would load the whole application first and this
// await would come too late. Top-level await is what makes the plain
// statement order true again.
await loadExternalPlugins()

const { route } = await import('./web.mjs')
const { startTerminalServer } = await import('./terminal.mjs')
const { startScheduler, stopScheduler } = await import('./scheduler.mjs')
const { startWatcher, stopWatcher, verwaisteLaeufeAbschliessen } = await import('./watcher.mjs')
const { startIntegrator, stopIntegrator } = await import('./integrate.mjs')
const { getSetting } = await import('./db.mjs')
const { seedIfEmpty } = await import('./coding-agents.mjs')
const { subscriptionUsage } = await import('./usage.mjs')
const { providerBalances } = await import('./balances.mjs')
const { sessionMemory } = await import('./sessions.mjs')
const { setLanguage } = await import('./i18n.mjs')
const { setTimezone } = await import('./util.mjs')
const { scanSystem } = await import('./plugins/discovery.mjs')

// UI language (default English) and, on a fresh installation, the optional
// coding agent seed file (installed e.g. by a private setup repo).
setLanguage(getSetting('ui_language') ?? 'en')
setTimezone(getSetting('ui_timezone') ?? '')
seedIfEmpty()

const PORT = Number(env('LOCAL_PORT') ?? 8791)
const HOST = '127.0.0.1'   // planning 11: the app is NEVER reachable any other way

const server = http.createServer((req, res) => route(req, res))
startTerminalServer(server)

server.listen(PORT, HOST, () => {
  console.log(`[freilauf] running on http://${HOST}:${PORT}`)
  // First clean up what an earlier process left behind mid-start:
  // no grace period, because these runs cannot be ours any more.
  const verwaist = verwaisteLaeufeAbschliessen(0)
  if (verwaist) console.log(`[freilauf] closed ${verwaist} interrupted run(s) (no session)`)
  startScheduler()
  startWatcher()
  // The finish gate's own timer: it wakes every 5 s, much denser than the
  // watcher, because an agent told "commit first" usually does it in seconds.
  startIntegrator()
  // The pipeline state comes from the DB. Access from the outside is NOT a
  // setting of this process — it is freilauf-vpn.service, which deliberately does
  // not start on its own (fail-closed) and is switched with `freilauf on|off`.
  console.log(`[freilauf] pipeline=${getSetting('pipeline_on') === '1' ? 'on' : 'off'} (from the DB)`)
  // Warm the two panels the status sidebar is built from, before a browser can
  // ask for them. Both are stale-while-revalidate now (usage.mjs), so the ONLY
  // request that can still wait on a vendor's API is the one that finds no
  // cached answer at all — which, without this, is the first page view after
  // every restart. Fire and forget: a start must never hang on somebody else's
  // server, and a failure here simply leaves the panel to the next caller.
  subscriptionUsage().catch(() => {})
  providerBalances().catch(() => {})
  // Same reason, a local one: the sidebar's memory reading shells out to tmux
  // and `ps` over every process on the machine, and without a warm cache the
  // first page view after a restart is the one that pays for it.
  sessionMemory().catch(() => {})
  // What is already on this machine — installed coding agent CLIs, API keys in
  // the environment. Deliberately AFTER listen and fire-and-forget: it shells
  // out once per coding agent plugin, and a start must never wait on that.
  // Never on a request path either; the Plugins page reads the stored result.
  try { scanSystem().catch(() => {}) } catch { /* a scan is a suggestion, never a requirement */ }
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopScheduler(); stopWatcher(); stopIntegrator()
    server.close(() => process.exit(0))
    server.closeAllConnections()
    setTimeout(() => process.exit(0), 2000).unref()
  })
}
