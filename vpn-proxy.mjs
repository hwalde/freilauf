#!/usr/bin/env node
/**
 * TLS reverse proxy in front of cc-hub (Planung 5).
 *
 *  - NO host rewrite: cc-hub has no loopback restriction, the request passes
 *    through to 127.0.0.1 unchanged.
 *  - Rebinding/cross-site fence: the Host MUST be in the allowlist,
 *    the Origin must match the requested authority exactly, Sec-Fetch-Site: cross-site
 *    is rejected.
 *  - WebSocket upgrades are passed through (terminal in the browser, Planung 7.4).
 *
 * Access authorization is provided by WireGuard: the proxy explicitly binds ONLY to
 * the wg address — if the firewall fails, the service still stays closed.
 *
 * ## Why HTTP/2, and why it is not a nicety
 *
 * This proxy used to be `https.createServer` — HTTP/1.1 only. A browser opens at
 * most **6 connections per origin** over HTTP/1.1, and since the live channel
 * exists (`server/events.mjs`) **every open cc-hub tab holds one of them open
 * forever**: an EventSource is a response that never ends. Four tabs left the
 * page two connections to load itself through; six left it none, and every
 * request simply queued in the browser until a tab was closed. That is what
 * "the hub hangs" was — the requests never reached this process at all, so
 * nothing in the hub's own timings could ever have shown it.
 *
 * `allowHTTP1: true` keeps the HTTP/1.1 path alive, which is what the terminal
 * needs: browsers do not run WebSockets over h2 (RFC 8441 is not advertised
 * here), so they open a separate HTTP/1.1 connection for the upgrade — and the
 * `upgrade` event below still fires for it. Measured against Node 22 before
 * this was written, because the h2 server's compat layer documents `request`
 * but not `upgrade`.
 *
 * ## The leak this file had, and the one line that fixes it
 *
 * `up.pipe(res)` alone does not survive the client going away. When a browser
 * closes an SSE stream — a navigation, a closed tab — the downstream `res` ends,
 * but the **upstream request to the hub was never destroyed**: node's `pipe()`
 * unpipes on a dead destination, it does not tear down the source. The socket to
 * the hub therefore stayed open forever, and with it the hub's SSE client
 * record: a `clients` entry that receives every published event, plus a 25 s
 * heartbeat interval, per page view, for the life of the process. Measured on
 * the running installation: 7 browser connections, 19 upstream ones.
 *
 * Hence `res.on('close')` → `upstream.destroy()`. Everything the hub does to
 * detect a gone client (`req.on('close')` in events.mjs) depends on this socket
 * actually closing.
 */
import http from 'node:http'
import http2 from 'node:http2'
import { readFileSync } from 'node:fs'

const BIND = process.env.CCHUB_VPN_BIND
if (!BIND) {
  console.error('[cc-hub-vpn] CCHUB_VPN_BIND is not set (the VPN address the proxy binds to).')
  console.error('[cc-hub-vpn] Deliberately no default: this service must never end up on 0.0.0.0.')
  process.exit(1)
}
const PORT = Number(process.env.CCHUB_VPN_PORT ?? 8790)
const TARGET_HOST = '127.0.0.1'
const TARGET_PORT = Number(process.env.CCHUB_LOCAL_PORT ?? 8791)
const CERT_DIR = process.env.CCHUB_CERT_DIR ?? `${process.env.HOME}/.local/certs/cc-hub`

const LOOPBACK_AUTHORITY = `${TARGET_HOST}:${TARGET_PORT}`

const ALLOWED_HOSTS = (process.env.CCHUB_ALLOWED_HOSTS ?? `${BIND}:${PORT}`)
  .split(',')
  .map((entry) => entry.trim().toLowerCase())
  .filter(Boolean)

for (const entry of ALLOWED_HOSTS) {
  if (!/^[a-z0-9.\-]+(:\d+)?$|^\[[0-9a-f:]+\](:\d+)?$/.test(entry)) {
    console.error(`[cc-hub-vpn] CCHUB_ALLOWED_HOSTS: ${JSON.stringify(entry)} is not a host[:port] authority`)
    process.exit(1)
  }
}
if (ALLOWED_HOSTS.length === 0) {
  console.error('[cc-hub-vpn] CCHUB_ALLOWED_HOSTS is empty — no request could get through')
  process.exit(1)
}

/**
 * Hop-by-hop headers (RFC 9110 §7.6.1). They describe ONE connection and must
 * not be forwarded onto another — and over HTTP/2 they are not merely wrong but
 * fatal: node rejects `connection`, `keep-alive`, `transfer-encoding` and
 * `upgrade` on an h2 stream with ERR_HTTP2_INVALID_CONNECTION_HEADERS. The hub's
 * SSE handler sends `connection: keep-alive`, so without this filter the live
 * channel would have thrown on the very first h2 client.
 */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade',
])

/**
 * Request headers as HTTP/1.1 knows them. An h2 client sends `:authority`
 * instead of `host` and node's compat layer keeps the pseudo-headers in
 * `req.headers`; forwarding one would make `http.request` throw on the invalid
 * name. The allowlist and the origin check below read `host`, so it has to be
 * the real authority on both protocols — otherwise every h2 request would be
 * rejected as "host '' not in the allowlist".
 */
function normalizeHeaders(raw) {
  const out = {}
  for (const [name, value] of Object.entries(raw)) {
    if (name.startsWith(':') || HOP_BY_HOP.has(name)) continue
    out[name] = value
  }
  if (!out.host && raw[':authority']) out.host = raw[':authority']
  return out
}

/** Response headers, cleaned for whichever protocol the client is speaking. */
function responseHeaders(raw) {
  const out = {}
  for (const [name, value] of Object.entries(raw)) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue
    out[name] = value
  }
  return out
}

/**
 * A page opened via a link from another app reports 'cross-site'. This one case is
 * harmless and is meant to pass: DNS rebinding is caught by the host allowlist, and
 * CSRF concerns state-changing requests — a top-level GET navigation is not one.
 * 'dest=document' excludes frames, so the mechanism still covers:
 * fetch/XHR, form POSTs, iframes and WebSockets from foreign pages.
 */
function isTopLevelNavigation(method, headers) {
  return (method === 'GET' || method === 'HEAD')
    && headers['sec-fetch-mode'] === 'navigate'
    && headers['sec-fetch-dest'] === 'document'
}

/** Reason for rejection, or null if the request may pass. Only used for logging. */
function rejectReason(method, headers) {
  const host = (headers.host ?? '').toLowerCase()
  if (!ALLOWED_HOSTS.includes(host)) return `Host '${host}' not in the allowlist`
  if (headers['sec-fetch-site'] === 'cross-site' && !isTopLevelNavigation(method, headers)) {
    return 'Sec-Fetch-Site: cross-site (not a top-level navigation)'
  }
  const origin = headers.origin
  if (origin !== undefined && origin !== `https://${host}` && origin !== `http://${host}`) {
    return `Origin '${origin}' does not match host '${host}'`
  }
  return null
}

function acceptedAuthority(method, headers) {
  return rejectReason(method, headers) === null ? (headers.host ?? '').toLowerCase() : undefined
}

/** Log the 403 with its reason to the journal — otherwise you sit in the browser guessing. */
function logReject(method, urlPath, h) {
  console.warn(`[cc-hub-vpn] 403 ${method} ${urlPath} — ${rejectReason(method, h)}`
    + ` (host=${h.host ?? '-'} origin=${h.origin ?? '-'} sec-fetch-site=${h['sec-fetch-site'] ?? '-'}`
    + ` sec-fetch-mode=${h['sec-fetch-mode'] ?? '-'} sec-fetch-dest=${h['sec-fetch-dest'] ?? '-'})`)
}

const options = {
  key: readFileSync(`${CERT_DIR}/dev-key.pem`),
  cert: readFileSync(`${CERT_DIR}/dev-cert.pem`),
  allowHTTP1: true,
  ALPNProtocols: ['h2', 'http/1.1'],
}

// An h2 browser multiplexes everything over ONE connection, so a handful of
// upstream sockets carries the whole UI. The cap is a fence rather than a
// budget: without it a runaway client could open sockets to the hub without
// bound, and the hub is single-process.
const agent = new http.Agent({ keepAlive: true, maxSockets: 128, maxFreeSockets: 16 })

const server = http2.createSecureServer(options, (req, res) => {
  const headers = normalizeHeaders(req.headers)
  if (acceptedAuthority(req.method, headers) === undefined) {
    logReject(req.method, req.url, headers)
    res.writeHead(403, { 'content-type': 'text/plain' })
    res.end('forbidden: unexpected host or origin\n')
    return
  }
  const upstream = http.request({
    host: TARGET_HOST, port: TARGET_PORT, method: req.method,
    path: req.url, headers, agent,
  }, (up) => {
    if (res.destroyed || res.closed) { up.destroy(); return }
    res.writeHead(up.statusCode ?? 502, responseHeaders(up.headers))
    up.pipe(res)
    // A destination that goes away must take the source with it. pipe() only
    // unpipes; the response body would otherwise keep the upstream socket busy.
    res.on('close', () => up.destroy())
  })
  // THE leak fix (see the file header): without this an abandoned SSE stream
  // leaves a socket to the hub — and a live SSE client inside it — forever.
  res.on('close', () => upstream.destroy())
  upstream.on('error', (err) => {
    if (res.destroyed || res.closed) return
    console.warn(`[cc-hub-vpn] upstream: ${err.message}`)
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
    res.end('bad gateway\n')
  })
  req.on('error', () => upstream.destroy())
  req.pipe(upstream)
})

// WebSocket upgrade: forward the handshake, then a raw socket pipe.
//
// Only HTTP/1.1 connections ever get here — browsers do not run WebSockets over
// h2 — and `allowHTTP1: true` is what keeps that path open on this port.
server.on('upgrade', (req, socket, head) => {
  const headers = normalizeHeaders(req.headers)
  // `upgrade` and `connection` are hop-by-hop and were stripped above — but the
  // handshake IS the hop, so they have to be put back for this one request.
  headers.connection = req.headers.connection ?? 'Upgrade'
  headers.upgrade = req.headers.upgrade ?? 'websocket'
  if (acceptedAuthority(req.method, headers) === undefined) {
    logReject(req.method, req.url, headers)
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
    return
  }
  const upstream = http.request({
    host: TARGET_HOST, port: TARGET_PORT, method: req.method,
    path: req.url, headers, agent: false,
  })
  upstream.on('upgrade', (up, upSocket, upHead) => {
    const lines = [`HTTP/1.1 ${up.statusCode} ${up.statusMessage}`]
    for (let i = 0; i < up.rawHeaders.length; i += 2) {
      lines.push(`${up.rawHeaders[i]}: ${up.rawHeaders[i + 1]}`)
    }
    socket.write(lines.join('\r\n') + '\r\n\r\n')
    if (upHead?.length) socket.write(upHead)
    upSocket.pipe(socket)
    socket.pipe(upSocket)
    // Same rule as above, and it matters more here: a tmux client hangs off the
    // far end of this pipe. 'close' rather than only 'error' — a browser tab
    // that simply goes away closes cleanly, and that used to leave the upstream
    // half of the pipe standing.
    const drop = () => { upSocket.destroy(); socket.destroy() }
    upSocket.on('error', drop)
    upSocket.on('close', drop)
    socket.on('error', drop)
    socket.on('close', drop)
  })
  upstream.on('response', () => socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'))
  upstream.on('error', (err) => {
    console.warn(`[cc-hub-vpn] upgrade: ${err.message}`)
    socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
  })
  socket.on('close', () => upstream.destroy())
  socket.on('error', () => upstream.destroy())
  if (head?.length) upstream.write(head)
  upstream.end()
})

server.on('error', (err) => {
  if (err.code === 'EADDRNOTAVAIL') {
    console.error(`[cc-hub-vpn] ${BIND} does not exist — is the VPN interface up?`)
  } else {
    console.error(`[cc-hub-vpn] ${err.message}`)
  }
  process.exit(1)
})

server.listen(PORT, BIND, () => {
  console.log(`[cc-hub-vpn] ${BIND}:${PORT} -> http://${LOOPBACK_AUTHORITY} (h2 + http/1.1)`)
  console.log(`[cc-hub-vpn] allowed authorities: ${ALLOWED_HOSTS.join(', ')}`)
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0))
    server.closeAllConnections?.()
    setTimeout(() => process.exit(0), 2000).unref()
  })
}
