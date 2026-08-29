#!/usr/bin/env node
// cc-hub — main entry point: HTTP + WS + scheduler + watcher in one process (planning 5).
import http from 'node:http'
import process from 'node:process'
import { route } from './web.mjs'
import { startTerminalServer } from './terminal.mjs'
import { startScheduler, stopScheduler } from './scheduler.mjs'
import { startWatcher, stopWatcher, verwaisteLaeufeAbschliessen } from './watcher.mjs'
import { startIntegrator, stopIntegrator } from './integrate.mjs'
import { getSetting } from './db.mjs'
import { seedIfEmpty } from './coding-agents.mjs'
import { subscriptionUsage } from './usage.mjs'
import { providerBalances } from './balances.mjs'
import { sessionMemory } from './sessions.mjs'
import { setLanguage } from './i18n.mjs'

// UI language (default English) and, on a fresh installation, the optional
// coding agent seed file (installed e.g. by a private setup repo).
setLanguage(getSetting('ui_language') ?? 'en')
seedIfEmpty()

const PORT = Number(process.env.CCHUB_LOCAL_PORT ?? 8791)
const HOST = '127.0.0.1'   // planning 11: the app is NEVER reachable any other way

const server = http.createServer((req, res) => route(req, res))
startTerminalServer(server)

server.listen(PORT, HOST, () => {
  console.log(`[cc-hub] running on http://${HOST}:${PORT}`)
  // First clean up what an earlier process left behind mid-start:
  // no grace period, because these runs cannot be ours any more.
  const verwaist = verwaisteLaeufeAbschliessen(0)
  if (verwaist) console.log(`[cc-hub] closed ${verwaist} interrupted run(s) (no session)`)
  startScheduler()
  startWatcher()
  // The finish gate's own timer: it wakes every 5 s, much denser than the
  // watcher, because an agent told "commit first" usually does it in seconds.
  startIntegrator()
  // The pipeline state comes from the DB. Access from the outside is NOT a
  // setting of this process — it is cchub-vpn.service, which deliberately does
  // not start on its own (fail-closed) and is switched with `cchub on|off`.
  console.log(`[cc-hub] pipeline=${getSetting('pipeline_on') === '1' ? 'on' : 'off'} (from the DB)`)
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
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopScheduler(); stopWatcher(); stopIntegrator()
    server.close(() => process.exit(0))
    server.closeAllConnections()
    setTimeout(() => process.exit(0), 2000).unref()
  })
}
