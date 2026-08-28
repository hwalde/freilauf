#!/usr/bin/env node
// cc-hub — the TLS proxy in front of the hub (vpn-proxy.mjs).
//
// Why this file exists at its own name rather than inside e2e.mjs: everything
// tested here is about the TRANSPORT, and the e2e suite deliberately talks to
// the hub over plain loopback HTTP. AGENTS.md already carries the sentence this
// is the consequence of — "a green test against 127.0.0.1 says NOTHING about
// the path through the TLS proxy" — and until now nothing tested that path at
// all. Both bugs it found were invisible from either side on its own:
//
//  - an abandoned SSE stream leaked its UPSTREAM connection forever, because
//    `up.pipe(res)` unpipes on a dead destination but never destroys the
//    source. Every page view left a socket to the hub and a live SSE client
//    inside it behind. Measured on the running installation before the fix:
//    7 browser connections, 19 upstream ones.
//  - the proxy spoke HTTP/1.1 only, where a browser opens at most 6
//    connections per origin — and since the live channel exists, every open
//    tab holds one of them for as long as it is open.
//
// The upstream here is a stub rather than a real hub: what is being tested is
// what the proxy does with a connection, and a stub can COUNT its connections.
//
// Skipped, green, when openssl is missing — the same rule test/browser.mjs
// follows for Chromium: whoever cannot run it must not sit in front of a red
// test.
import { spawn, execFileSync } from 'node:child_process'
import http from 'node:http'
import http2 from 'node:http2'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect as tlsConnect } from 'node:tls'
import { gruppe, pruefe, uebersprungen, gleich, wahr, warteAuf, bericht, zaehler } from './mini.mjs'

const start = Date.now()
const PROJEKT = new URL('..', import.meta.url).pathname
const BIND = '127.0.0.1'

function freierPort() {
  return new Promise((r) => {
    const s = http.createServer()
    s.listen(0, BIND, () => { const p = s.address().port; s.close(() => r(p)) })
  })
}

function opensslDa() {
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true } catch { return false }
}

// ------------------------------------------------------------------ upstream
/**
 * A stub hub. It counts its open connections — that number IS the leak test —
 * and its `/sse` deliberately answers with `connection: keep-alive`, exactly as
 * server/events.mjs does: a hop-by-hop header, which HTTP/2 rejects outright.
 * Forwarding it unfiltered would have thrown on the first h2 client, so the
 * live channel would have been dead on arrival over the new protocol.
 */
function stubHub() {
  const offen = new Set()
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/sse')) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      })
      res.write(': connected\n\n')
      return   // never ends, like a real SSE stream
    }
    res.writeHead(200, { 'content-type': 'text/plain' }).end('hello\n')
  })
  server.on('connection', (sock) => {
    offen.add(sock)
    sock.on('close', () => offen.delete(sock))
  })
  return { server, offen }
}

async function main() {
  gruppe('The TLS proxy: HTTP/2, and a connection that really closes')

  if (!opensslDa()) {
    uebersprungen('the whole proxy suite', 'openssl is not installed — no certificate can be made')
    bericht('Proxy tests', start)
    return
  }

  const certDir = mkdtempSync(join(tmpdir(), 'cc-hub-proxy-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', join(certDir, 'dev-key.pem'), '-out', join(certDir, 'dev-cert.pem'),
    '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'],
  { stdio: 'ignore' })

  const { server: hub, offen } = stubHub()
  const hubPort = await freierPort()
  const proxyPort = await freierPort()
  await new Promise((r) => hub.listen(hubPort, BIND, r))

  const proxy = spawn(process.execPath, [join(PROJEKT, 'vpn-proxy.mjs')], {
    env: {
      ...process.env,
      CCHUB_VPN_BIND: BIND,
      CCHUB_VPN_PORT: String(proxyPort),
      CCHUB_LOCAL_PORT: String(hubPort),
      CCHUB_CERT_DIR: certDir,
      CCHUB_ALLOWED_HOSTS: `${BIND}:${proxyPort}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  proxy.stdout.resume(); proxy.stderr.resume()

  const authority = `${BIND}:${proxyPort}`
  /** One h2 session, since that is the whole point: a browser only opens one. */
  const h2 = () => http2.connect(`https://${authority}`, { rejectUnauthorized: false })

  const aufraeumen = () => {
    proxy.kill('SIGKILL')
    hub.close()
    rmSync(certDir, { recursive: true, force: true })
  }

  try {
    await warteAuf(async () => {
      try {
        await new Promise((res, rej) => {
          const s = tlsConnect({ host: BIND, port: proxyPort, rejectUnauthorized: false }, () => { s.destroy(); res() })
          s.on('error', rej)
        })
        return true
      } catch { return false }
    }, { was: 'the proxy accepts TLS', timeoutMs: 10_000 })

    // A browser that speaks h2 multiplexes EVERYTHING over one connection —
    // pages, fragments, static files and the SSE stream — so the 6-connection
    // ceiling that the live channel used to eat into stops existing.
    await pruefe('the proxy offers h2 over ALPN and still answers HTTP/1.1', async () => {
      const alpn = await new Promise((res) => {
        const s = tlsConnect({ host: BIND, port: proxyPort, rejectUnauthorized: false,
          ALPNProtocols: ['h2', 'http/1.1'] }, () => { const p = s.alpnProtocol; s.destroy(); res(p) })
      })
      gleich(alpn, 'h2', 'a browser that can, gets HTTP/2')
      const alt = await new Promise((res) => {
        const s = tlsConnect({ host: BIND, port: proxyPort, rejectUnauthorized: false,
          ALPNProtocols: ['http/1.1'] }, () => { const p = s.alpnProtocol; s.destroy(); res(p) })
      })
      gleich(alt, 'http/1.1', 'and the terminal\'s WebSocket keeps the protocol it needs')
    })

    await pruefe('a page comes through over h2', async () => {
      const sess = h2()
      try {
        const text = await new Promise((res, rej) => {
          const req = sess.request({ ':path': '/', ':authority': authority, origin: `https://${authority}` })
          let out = ''
          req.on('data', (c) => { out += c })
          req.on('end', () => res(out))
          req.on('error', rej)
          req.end()
        })
        gleich(text, 'hello\n', 'the upstream body arrives unchanged')
      } finally { sess.close() }
    })

    // The hub sends `connection: keep-alive` on its SSE response. That is a
    // hop-by-hop header; node rejects it on an h2 stream. Passing the upstream
    // headers straight through would therefore have killed the live channel for
    // every h2 client — silently, since the throw happens inside the proxy.
    await pruefe('an SSE stream survives the hop-by-hop headers HTTP/2 forbids', async () => {
      const sess = h2()
      try {
        const erstes = await new Promise((res, rej) => {
          const req = sess.request({ ':path': '/sse', ':authority': authority, origin: `https://${authority}` })
          req.on('data', (c) => res(String(c)))
          req.on('error', rej)
          setTimeout(() => rej(new Error('nothing arrived within 5 s')), 5000).unref()
          req.end()
        })
        gleich(erstes, ': connected\n\n', 'the stream opens and the first bytes come through')
      } finally { sess.close() }
    })

    // THE regression test. `up.pipe(res)` alone does not survive the client
    // going away: node unpipes a dead destination, it does not destroy the
    // source. Every abandoned SSE stream therefore left a socket to the hub —
    // and inside the hub a client record that receives every published event
    // plus a 25 s heartbeat — standing for the life of the process.
    await pruefe('an abandoned SSE stream takes its upstream connection with it', async () => {
      const grund = offen.size
      const sitzungen = []
      for (let i = 0; i < 8; i++) {
        const sess = h2()
        sitzungen.push(sess)
        await new Promise((res, rej) => {
          const req = sess.request({ ':path': `/sse?n=${i}`, ':authority': authority, origin: `https://${authority}` })
          req.on('data', () => res())
          req.on('error', rej)
          setTimeout(() => rej(new Error('the stream never opened')), 5000).unref()
          req.end()
        })
      }
      wahr(offen.size >= grund + 8, `all eight streams really reached the upstream (${offen.size} open)`)

      for (const sess of sitzungen) sess.destroy()
      await warteAuf(() => offen.size <= grund,
        { was: 'every upstream connection is closed again', timeoutMs: 10_000 })
      gleich(offen.size, grund, 'not one socket is left behind')
    })
  } finally {
    aufraeumen()
  }

  bericht('Proxy tests', start)
}

main().then(() => process.exit(zaehler.fehler.length ? 1 : 0),
  (err) => { console.error(err); process.exit(1) })
