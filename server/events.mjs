// Freilauf — in-process event bus and its SSE fan-out (`GET /api/events`).
//
// Why this can be so small: HTTP, scheduler and watcher all run in ONE process
// (hub.mjs). Whoever changes a run is in the same memory as whoever holds the
// browser connection, so there is no broker, no queue and no second port — a
// publish is a function call.
//
// Why SSE and not the WebSocket that already exists: the terminal socket is a
// two-way byte pipe into tmux and has nothing to do with page state. Here the
// traffic is one-way, and SSE brings reconnection and event ids for free. It
// also survives vpn-proxy.mjs unchanged, which pipes the upstream response
// straight through (`up.pipe(res)`) without buffering.
//
// CAUTION, the lesson from AGENTS.md applies here too: a green test against
// 127.0.0.1 says NOTHING about the path through the TLS proxy. The heartbeat
// below is the insurance against a middlebox that closes idle connections.

const HEARTBEAT_MS = 25_000
const RING = 100          // events kept for a client that reconnects

let lastId = 0
const ring = []
const clients = new Set()

/**
 * Announce a change. `data.repoId` decides who hears it: a client watching one
 * repo is not interested in another's runs. An event WITHOUT a repoId is global
 * (quota, provider balances, pulse incidents) and always goes out.
 *
 * Never throws and never blocks — a broken client must not be able to take down
 * the watcher pass that is publishing.
 */
export function publish(type, data = {}) {
  const event = { id: ++lastId, type, data }
  ring.push(event)
  if (ring.length > RING) ring.shift()
  for (const client of clients) {
    try { send(client, event) } catch { drop(client) }
  }
  return event.id
}

function matches(client, event) {
  const repoId = event.data?.repoId
  if (repoId === undefined || repoId === null) return true   // global
  if (client.repoId === null) return true                    // client wants everything
  return String(repoId) === String(client.repoId)
}

function send(client, event) {
  if (!matches(client, event)) return
  // The id goes out even for a filtered-away event's neighbours, so a
  // reconnecting client never asks for a gap we have already dropped.
  client.res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`)
}

function drop(client) {
  clients.delete(client)
  clearInterval(client.beat)
  try { client.res.end() } catch { /* already gone */ }
}

/**
 * `GET /api/events[?repo=<id>]` — attach a browser.
 *
 * `X-Accel-Buffering: no` is for a reverse proxy that is NOT ours: nginx buffers
 * SSE by default and the stream then arrives in silent lumps. Our own proxy does
 * not need it; an operator who puts something else in front does.
 */
export function sseHandler(req, res, url) {
  const repo = url.searchParams.get('repo')
  const client = { res, repoId: repo === null || repo === '' ? null : repo, beat: null }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  // An immediate comment flushes the headers, so the browser fires `onopen` now
  // instead of at the first real event — which may be minutes away.
  res.write(': connected\n\n')

  // Catch-up after a reconnect. The browser sends the last id it saw; anything
  // newer that we still hold goes out before the live stream continues. Beyond
  // the ring we simply say nothing: the page re-renders from fragments anyway,
  // and a wrong replay is worse than a missing one.
  const seit = Number(req.headers['last-event-id'])
  if (Number.isFinite(seit)) {
    for (const event of ring) if (event.id > seit) { try { send(client, event) } catch { /* below */ } }
  }

  client.beat = setInterval(() => {
    try { res.write(': beat\n\n') } catch { drop(client) }
  }, HEARTBEAT_MS)
  // Without unref() the interval alone keeps the process alive on shutdown.
  client.beat.unref?.()

  clients.add(client)
  req.on('close', () => drop(client))
  req.on('error', () => drop(client))
}
