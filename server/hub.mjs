#!/usr/bin/env node
// cc-hub — main entry point: HTTP + WS + scheduler + watcher in one process (planning 5).
import http from 'node:http'
import process from 'node:process'
import { route } from './web.mjs'
import { startTerminalServer } from './terminal.mjs'
import { startScheduler, stopScheduler } from './scheduler.mjs'
import { startWatcher, stopWatcher, verwaisteLaeufeAbschliessen } from './watcher.mjs'
import { setSetting, getSetting } from './db.mjs'
import { seedIfEmpty } from './coding-agents.mjs'
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
  // After a reboot: access stays off (fail-closed), the pipeline state comes from the DB.
  setSetting('access_on', '0')
  console.log(`[cc-hub] pipeline=${getSetting('pipeline_on') === '1' ? 'on' : 'off'} (from the DB), access=off (fail-closed)`)
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopScheduler(); stopWatcher()
    server.close(() => process.exit(0))
    server.closeAllConnections()
    setTimeout(() => process.exit(0), 2000).unref()
  })
}
