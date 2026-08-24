#!/usr/bin/env node
/**
 * TLS-Reverse-Proxy vor cc-hub (Planung 5).
 *
 *  - KEIN Host-Rewrite: cc-hub kennt keine Loopback-Sperre, die Anfrage geht
 *    unverändert an 127.0.0.1 durch.
 *  - Rebinding-/Cross-Site-Fence: Host MUSS in der Allowlist stehen,
 *    Origin muss exakt zur angefragten Authority passen, Sec-Fetch-Site: cross-site
 *    wird abgelehnt.
 *  - WebSocket-Upgrade wird durchgereicht (Terminal im Browser, Planung 7.4).
 *
 * Zugangsberechtigung liefert WireGuard: der Proxy bindet ausdrücklich NUR an
 * die wg-Adresse — fällt die Firewall aus, bleibt der Dienst trotzdem dicht.
 */
import http from 'node:http'
import https from 'node:https'
import { readFileSync } from 'node:fs'

const BIND = process.env.CCHUB_VPN_BIND
if (!BIND) {
  console.error('[cc-hub-vpn] CCHUB_VPN_BIND ist nicht gesetzt (die VPN-Adresse, an die der Proxy bindet).')
  console.error('[cc-hub-vpn] Absichtlich kein Default: an 0.0.0.0 darf dieser Dienst nie geraten.')
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
    console.error(`[cc-hub-vpn] CCHUB_ALLOWED_HOSTS: ${JSON.stringify(entry)} ist keine host[:port]-Authority`)
    process.exit(1)
  }
}
if (ALLOWED_HOSTS.length === 0) {
  console.error('[cc-hub-vpn] CCHUB_ALLOWED_HOSTS ist leer — so käme keine Anfrage durch')
  process.exit(1)
}

/**
 * Eine per Link aus einer anderen App geöffnete Seite meldet 'cross-site'. Dieser eine
 * Fall ist ungefährlich und soll durch: DNS-Rebinding fängt die Host-Allowlist ab, und
 * CSRF betrifft zustandsändernde Anfragen — eine Top-Level-GET-Navigation ist keine.
 * 'dest=document' schließt Frames aus, das Verfahren deckt also weiterhin ab:
 * fetch/XHR, Formular-POSTs, iframes und WebSockets von fremden Seiten.
 */
function isTopLevelNavigation(method, headers) {
  return (method === 'GET' || method === 'HEAD')
    && headers['sec-fetch-mode'] === 'navigate'
    && headers['sec-fetch-dest'] === 'document'
}

/** Grund der Ablehnung, oder null wenn die Anfrage durchdarf. Nur zum Loggen. */
function rejectReason(method, headers) {
  const host = (headers.host ?? '').toLowerCase()
  if (!ALLOWED_HOSTS.includes(host)) return `Host '${host}' nicht in der Allowlist`
  if (headers['sec-fetch-site'] === 'cross-site' && !isTopLevelNavigation(method, headers)) {
    return 'Sec-Fetch-Site: cross-site (keine Top-Level-Navigation)'
  }
  const origin = headers.origin
  if (origin !== undefined && origin !== `https://${host}` && origin !== `http://${host}`) {
    return `Origin '${origin}' passt nicht zu Host '${host}'`
  }
  return null
}

function acceptedAuthority(method, headers) {
  return rejectReason(method, headers) === null ? (headers.host ?? '').toLowerCase() : undefined
}

/** 403 mit Begründung ins Journal — sonst rätselt man im Browser vor sich hin. */
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
    res.end('forbidden: unerwarteter Host oder Origin\n')
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

// WebSocket-Upgrade: Handshake weiterreichen, danach roher Socket-Pipe.
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
    console.error(`[cc-hub-vpn] ${BIND} existiert nicht — läuft das VPN-Interface?`)
  } else {
    console.error(`[cc-hub-vpn] ${err.message}`)
  }
  process.exit(1)
})

server.listen(PORT, BIND, () => {
  console.log(`[cc-hub-vpn] ${BIND}:${PORT} -> http://${LOOPBACK_AUTHORITY}`)
  console.log(`[cc-hub-vpn] erlaubte Authorities: ${ALLOWED_HOSTS.join(', ')}`)
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0))
    server.closeAllConnections()
    setTimeout(() => process.exit(0), 2000).unref()
  })
}
