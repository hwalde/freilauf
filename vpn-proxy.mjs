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
 */
import http from 'node:http'
import https from 'node:https'
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
function logReject(req) {
  const h = req.headers
  console.warn(`[cc-hub-vpn] 403 ${req.method} ${req.url} — ${rejectReason(req.method, h)}`
    + ` (host=${h.host ?? '-'} origin=${h.origin ?? '-'} sec-fetch-site=${h['sec-fetch-site'] ?? '-'}`
    + ` sec-fetch-mode=${h['sec-fetch-mode'] ?? '-'} sec-fetch-dest=${h['sec-fetch-dest'] ?? '-'})`)
}

const options = {
  key: readFileSync(`${CERT_DIR}/dev-key.pem`),
  cert: readFileSync(`${CERT_DIR}/dev-cert.pem`),
}

const agent = new http.Agent({ keepAlive: true })

const server = https.createServer(options, (req, res) => {
  if (acceptedAuthority(req.method, req.headers) === undefined) {
    logReject(req)
    res.writeHead(403, { 'content-type': 'text/plain' })
    res.end('forbidden: unexpected host or origin\n')
    return
  }
  const upstream = http.request({
    host: TARGET_HOST, port: TARGET_PORT, method: req.method,
    path: req.url, headers: req.headers, agent,
  }, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers)
    up.pipe(res)
  })
  upstream.on('error', (err) => {
    console.warn(`[cc-hub-vpn] upstream: ${err.message}`)
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
    res.end('bad gateway\n')
  })
  req.on('error', () => upstream.destroy())
  req.pipe(upstream)
})

// WebSocket upgrade: forward the handshake, then a raw socket pipe.
server.on('upgrade', (req, socket, head) => {
  if (acceptedAuthority(req.method, req.headers) === undefined) {
    logReject(req)
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
    return
  }
  const upstream = http.request({
    host: TARGET_HOST, port: TARGET_PORT, method: req.method,
    path: req.url, headers: req.headers, agent: false,
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
    const drop = () => { upSocket.destroy(); socket.destroy() }
    upSocket.on('error', drop)
    socket.on('error', drop)
  })
  upstream.on('response', () => socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'))
  upstream.on('error', (err) => {
    console.warn(`[cc-hub-vpn] upgrade: ${err.message}`)
    socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
  })
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
  console.log(`[cc-hub-vpn] ${BIND}:${PORT} -> http://${LOOPBACK_AUTHORITY}`)
  console.log(`[cc-hub-vpn] allowed authorities: ${ALLOWED_HOSTS.join(', ')}`)
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0))
    server.closeAllConnections()
    setTimeout(() => process.exit(0), 2000).unref()
  })
}
