#!/usr/bin/env node
// cc-hub — Haupteinstieg: HTTP + WS + Scheduler + Watcher in einem Prozess (Planung 5).
import http from 'node:http'
import process from 'node:process'
import { route } from './web.mjs'
import { startTerminalServer } from './terminal.mjs'
import { startScheduler, stopScheduler } from './scheduler.mjs'
import { startWatcher, stopWatcher, verwaisteLaeufeAbschliessen } from './watcher.mjs'
import { setSetting, getSetting } from './db.mjs'

const PORT = Number(process.env.CCHUB_LOCAL_PORT ?? 8791)
const HOST = '127.0.0.1'   // Planung 11: App NIE anders erreichbar

const server = http.createServer((req, res) => route(req, res))
startTerminalServer(server)

server.listen(PORT, HOST, () => {
  console.log(`[cc-hub] läuft auf http://${HOST}:${PORT}`)
  // Zuerst aufräumen, was ein früherer Prozess mitten im Start hinterlassen hat:
  // ohne Gnadenfrist, denn diese Läufe können nicht mehr von uns stammen.
  const verwaist = verwaisteLaeufeAbschliessen(0)
  if (verwaist) console.log(`[cc-hub] ${verwaist} unterbrochene(n) Lauf/Läufe abgeschlossen (keine Session)`)
  startScheduler()
  startWatcher()
  // Nach Reboot: Zugang bleibt aus (fail-closed), Pipeline-Zustand kommt aus der DB.
  setSetting('access_on', '0')
  console.log(`[cc-hub] pipeline=${getSetting('pipeline_on') === '1' ? 'an' : 'aus'} (aus der DB), zugang=aus (fail-closed)`)
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopScheduler(); stopWatcher()
    server.close(() => process.exit(0))
    server.closeAllConnections()
    setTimeout(() => process.exit(0), 2000).unref()
  })
}
