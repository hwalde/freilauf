#!/usr/bin/env node
// Freilauf — the built-in egress proxy, driven for real (SANDBOX_RESEARCH.md §7.5).
//
// Why this file exists at its own name, and next to test/proxy.mjs rather than
// inside it: the two proxies are different animals. `vpn-proxy.mjs` sits in
// FRONT of the hub and terminates TLS for a browser; `server/sandbox/proxy.mjs`
// sits BEHIND a sandboxed run and decides whether it may talk to a host at all.
// What is tested here is a decision, and a decision is only tested by driving a
// real request through the real listener — the unit group next door proves the
// policy arithmetic, and proved nothing about whether a CONNECT that the policy
// refuses actually answers 403 with the sentence the agent is supposed to read.
//
// The upstream is a stub, for the same reason test/proxy.mjs uses one: what is
// being tested is what the proxy does with a connection, and a stub can COUNT
// its connections. That count is the leak test, and it is here because the
// lesson is already written down in this repository — `pipe()` unpipes a dead
// destination, it does not destroy the source, so an abandoned tunnel leaves an
// upstream socket standing for the life of the process and nothing above says
// so.
//
// One thing has to be switched off deliberately: the upstream CIDR fence. Every
// stub in this file listens on 127.0.0.1, and loopback is in the default deny
// list precisely so an allowlisted name cannot be pointed at the hub itself. So
// the suite runs its ordinary cases with `denyUpstreamCidrs: []` and gives the
// fence a test of its own, where the point IS that loopback is refused.
//
// Usage: node test/proxy-egress.mjs
import http from 'node:http'
import net from 'node:net'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gruppe, pruefe, gleich, wahr, falsch, enthaelt, bericht, warteAuf, zaehler } from './mini.mjs'

const start = Date.now()
const BIND = '127.0.0.1'

const { startProxy, reloadProxy, stopProxy } = await import('../server/sandbox/proxy.mjs')

// --------------------------------------------------------------- the upstream

/** A stub the proxy forwards to. It counts open connections — that IS the leak test. */
function stubUpstream() {
  const offen = new Set()
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' }).end(`upstream:${req.url}\n`)
  })
  server.on('connection', (sock) => {
    offen.add(sock)
    sock.on('close', () => offen.delete(sock))
  })
  return { server, offen }
}

/** A raw TCP echo, so a CONNECT tunnel can be driven without any TLS at all. */
function stubTunnel() {
  const offen = new Set()
  const server = net.createServer((sock) => {
    offen.add(sock)
    sock.on('close', () => offen.delete(sock))
    sock.on('error', () => {})
    sock.on('data', (c) => { try { sock.write(Buffer.concat([Buffer.from('echo:'), c])) } catch {} })
  })
  return { server, offen }
}

const listen = (server, port = 0) =>
  new Promise((r) => server.listen(port, BIND, () => r(server.address().port)))

// ----------------------------------------------------------------- the clients

/** A plain HTTP proxy request: the absolute-form URL a proxy client sends. */
function proxyGet(proxyPort, url) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: BIND, port: proxyPort, method: 'GET', path: url,
      headers: { host: new URL(url).host },
    }, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

/**
 * A CONNECT, answered before any tunnel payload. Resolves with the status line
 * and the body the proxy wrote — which for a refusal is the whole point: a 403
 * body on a CONNECT is what the client shows the agent.
 */
function proxyConnect(proxyPort, target, { send = null, keepOpen = false } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: BIND, port: proxyPort }, () => {
      sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`)
    })
    let buf = ''
    let established = false
    let tunnel = ''
    sock.on('data', (c) => {
      if (!established) {
        buf += c.toString('latin1')
        const i = buf.indexOf('\r\n\r\n')
        if (i < 0) return
        const head = buf.slice(0, i)
        const rest = buf.slice(i + 4)
        const status = Number(/^HTTP\/1\.\d (\d+)/.exec(head)?.[1] ?? 0)
        if (status !== 200) {
          sock.destroy()
          return resolve({ status, body: rest, socket: null })
        }
        established = true
        tunnel += rest
        if (send) sock.write(send)
        if (!send) { sock.destroy(); return resolve({ status, body: '', socket: null }) }
        return
      }
      tunnel += c.toString('utf8')
      if (!keepOpen) { sock.destroy(); resolve({ status: 200, body: tunnel, socket: null }) }
    })
    sock.on('error', (err) => { if (!established) reject(err) })
    setTimeout(() => { if (keepOpen) resolve({ status: 200, body: tunnel, socket: sock }) }, 300).unref()
    setTimeout(() => reject(new Error(`no answer from the proxy for ${target}`)), 8000).unref()
  })
}

// ---------------------------------------------------------------------- helper

const specOf = (network) => ({ network: { mode: 'allowlist', denyUpstreamCidrs: [], ...network } })

function auditLines(runDir) {
  const file = join(runDir, 'egress.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

async function main() {
  gruppe('The sandbox egress proxy: default deny, a live swap, and no socket left behind')

  const runDir = mkdtempSync(join(tmpdir(), 'freilauf-egress-'))
  const { server: up, offen: upOffen } = stubUpstream()
  const { server: tun, offen: tunOffen } = stubTunnel()
  const upPort = await listen(up)
  const tunPort = await listen(tun)

  const blocked = []
  // Every name in this suite answers 127.0.0.1, where the stubs are. The
  // resolver is overridden rather than borrowed from the machine because the
  // names a POLICY test needs — `denied.test`, `learnme.test` — are exactly the
  // ones deliberately absent from anybody's DNS: without the override the proxy
  // would refuse them for the wrong reason and the test would pass for it. The
  // CIDR-fence test further down uses the REAL resolver, because there the
  // resolution is the thing under test.
  const lookup = async () => [{ address: BIND, family: 4 }]
  const handle = await startProxy({ id: 'r-egress' }, specOf({ allow: ['localhost'], deny: ['blocked.localhost'] }), {
    runId: 'r-egress',
    runDir,
    bind: BIND,
    lookup,
    onBlocked: (e) => blocked.push(e),
  })

  const aufraeumen = async () => {
    await stopProxy(handle)
    up.close(); tun.close()
    rmSync(runDir, { recursive: true, force: true })
  }

  try {
    await pruefe('an allowed host goes through, and the audit says so', async () => {
      const res = await proxyGet(handle.port, `http://localhost:${upPort}/hello`)
      gleich(res.status, 200, 'the upstream answered')
      enthaelt(res.body, 'upstream:/hello', 'and its body came through unchanged')

      await warteAuf(() => auditLines(runDir).some((l) => l.action === 'allow'),
        { was: 'the allow is written to egress.jsonl' })
      const line = auditLines(runDir).find((l) => l.action === 'allow')
      gleich(line.host, 'localhost', 'the host')
      gleich(line.method, 'GET', 'the method')
      gleich(line.path, '/hello', 'the path — a plain HTTP request has one')
      gleich(line.status_code, 200, 'the status')
      gleich(line.run, 'r-egress', 'and the run it belongs to')
      falsch(JSON.stringify(line).toLowerCase().includes('authorization'), 'and never a header value')
    })

    await pruefe('a denied host answers 403 with the sentence the agent acts on', async () => {
      const res = await proxyGet(handle.port, `http://denied.test:${upPort}/x`)
      gleich(res.status, 403, 'default deny: a host nobody allowed is refused')
      enthaelt(res.body, 'denied.test', 'the body names the host')
      enthaelt(res.body, 'fl-report access', 'and tells the agent what to do about it')
      wahr(blocked.some((b) => b.host === 'denied.test'), 'the caller was told, so it can raise sandbox:blocked')
      gleich(blocked.find((b) => b.host === 'denied.test').count, 1, 'with a running per-host count for its own throttle')

      const zweite = await proxyGet(handle.port, `http://denied.test:${upPort}/y`)
      gleich(zweite.status, 403, 'still refused')
      gleich(blocked.filter((b) => b.host === 'denied.test').at(-1).count, 2,
        'and the count is what lets a caller deduplicate — we report every one')
    })

    await pruefe('a denied CONNECT answers 403 too, and the body reaches the client', async () => {
      const res = await proxyConnect(handle.port, `denied.test:${tunPort}`)
      gleich(res.status, 403, 'the tunnel is refused')
      enthaelt(res.body, 'denied.test', 'the host is in the body, not only in the status line')
      enthaelt(res.body, 'fl-report access', 'and so is the way out')
    })

    await pruefe('an allowed CONNECT really tunnels', async () => {
      const res = await proxyConnect(handle.port, `localhost:${tunPort}`, { send: 'ping' })
      gleich(res.status, 200, 'the tunnel is established')
      enthaelt(res.body, 'echo:ping', 'and bytes cross it in both directions')
      // A tunnel's audit line carries its byte counts, so it is written when the
      // tunnel ENDS, not when it opens — the wait is the shape of the fact.
      await warteAuf(() => auditLines(runDir).some((l) => l.method === 'CONNECT' && l.action === 'allow'),
        { was: 'the finished tunnel is audited' })
      const line = auditLines(runDir).find((l) => l.method === 'CONNECT' && l.action === 'allow')
      gleich(line.path, null, 'a CONNECT has no path — null, never an empty string')
      gleich(line.host, 'localhost', 'the host it tunnelled to')
    })

    await pruefe('deny beats allow on the live listener, not only on paper', async () => {
      const res = await proxyGet(handle.port, `http://blocked.localhost:${upPort}/x`)
      gleich(res.status, 403, 'a deny entry carves its hole out of the allow list')
    })

    // §7.12.3: this is the property the whole "loosen it without losing the
    // agent" flow depends on. The agent's retry must succeed, with no restart
    // and no dropped connection.
    await pruefe('a live policy swap takes effect for the next request, without a restart', async () => {
      const vorher = handle.port
      const abgelehnt = await proxyGet(handle.port, `http://denied.test:${upPort}/z`)
      gleich(abgelehnt.status, 403, 'refused before the change')

      const res = await reloadProxy(handle, specOf({ allow: ['localhost', 'denied.test'], deny: ['blocked.localhost'] }))
      wahr(res.ok, 'the reload is accepted')

      const nachher = await proxyGet(handle.port, `http://denied.test:${upPort}/z`)
      gleich(nachher.status, 200, 'and the very next request goes through')
      gleich(handle.port, vorher, 'on the same listener — nothing was restarted')
      wahr(handle.server.listening, 'which is still up')
    })

    await pruefe('audit-only lets it through AND records what it would have blocked', async () => {
      const vorher = blocked.length
      await reloadProxy(handle, specOf({ allow: ['localhost'], auditOnly: true }))
      const res = await proxyGet(handle.port, `http://learnme.test:${upPort}/x`)
      gleich(res.status, 200, 'in audit-only the request is not stopped')
      enthaelt(res.body, 'upstream:/x', 'it really reached the upstream')

      // `handle.audit` is a createWriteStream: buffered, asynchronous, never
      // fsynced. Reading it with a synchronous readFileSync in the tick the
      // response resolved passes when the machine is idle and fails under load
      // — the two checks above wait for their line and this one did not.
      await warteAuf(() => auditLines(runDir).some((l) => l.host === 'learnme.test'),
        { was: 'the would-be denial is written to egress.jsonl' })
      const line = auditLines(runDir).find((l) => l.host === 'learnme.test')
      wahr(!!line, 'and it is written down')
      gleich(line.action, 'would_deny', 'as the denial it WOULD have been — the allowlist grows from this')
      wahr(blocked.length > vorher, 'the caller hears about it too')
      gleich(handle.wouldBlock.get('learnme.test'), 1, 'counted per host, which is what an Adopt button reads')
      gleich(handle.blocked.get('learnme.test'), undefined, 'and kept apart from a real denial')
    })

    // The lesson of test/proxy.mjs, one layer down: a tunnel is two sockets, and
    // a client that goes away has to take the upstream one with it.
    await pruefe('an abandoned tunnel takes its upstream connection with it', async () => {
      await reloadProxy(handle, specOf({ allow: ['localhost'] }))
      const grund = tunOffen.size
      const offen = []
      for (let i = 0; i < 8; i++) {
        const res = await proxyConnect(handle.port, `localhost:${tunPort}`, { send: 'x', keepOpen: true })
        gleich(res.status, 200, `tunnel ${i} is established`)
        offen.push(res.socket)
      }
      await warteAuf(() => tunOffen.size >= grund + 8,
        { was: 'all eight tunnels really reached the upstream' })

      for (const s of offen) s.destroy()
      await warteAuf(() => tunOffen.size <= grund,
        { was: 'every upstream socket is closed again', timeoutMs: 10_000 })
      gleich(tunOffen.size, grund, 'not one socket is left behind')
    })

    await pruefe('stopping the proxy closes the listener and everything on it', async () => {
      const fence = await startProxy({ id: 'r-stop' }, specOf({ allow: ['localhost'] }), { runId: 'r-stop', bind: BIND })
      const port = fence.port
      gleich((await proxyGet(port, `http://localhost:${upPort}/a`)).status, 200, 'it serves while it is up')
      await stopProxy(fence)
      let refused = false
      try { await proxyGet(port, `http://localhost:${upPort}/a`) } catch { refused = true }
      wahr(refused, 'and nothing answers on the port afterwards')
    })

    // The fence has its own listener because it is the one case where loopback
    // MUST be refused: an allowlisted name resolving into RFC 1918 or onto
    // 169.254.169.254 is exactly the SSRF/rebinding attack it exists for.
    await pruefe('the upstream CIDR fence refuses an allowlisted name that resolves inward', async () => {
      const gemeldet = []
      const vorher = upOffen.size
      const fence = await startProxy({ id: 'r-cidr' },
        // No `lookup` override and no `denyUpstreamCidrs: []`: the machine's own
        // resolver answers `localhost` with 127.0.0.1, and loopback is in the
        // default deny list. That IS the case — an allowlisted NAME pointed at
        // an address the run must not reach.
        { network: { mode: 'allowlist', allow: ['localhost'] } },
        { runId: 'r-cidr', runDir, bind: BIND, onBlocked: (e) => gemeldet.push(e) })
      try {
        const res = await proxyGet(fence.port, `http://localhost:${upPort}/secret`)
        gleich(res.status, 403, 'the name is on the allowlist and the ADDRESS still refuses it')
        enthaelt(res.body, '127.0.0.1', 'the body names the address it resolved to')
        enthaelt(res.body, '127.0.0.0/8', 'and the range that blocked it')
        wahr(gemeldet.some((b) => b.host === 'localhost'), 'the caller hears about it like any other denial')
        gleich(upOffen.size, vorher, 'and no new connection was made to the upstream')
        // The wait is the whole check here. Without it this was the same race
        // as the audit-only line above, only failing SAFE: an audit file that
        // had not flushed yet contains no line that is not a deny, so the
        // assertion passed on an empty file and never verified anything. The
        // deny has to be there FIRST, and only then does "and nothing else" mean
        // something.
        await warteAuf(() => auditLines(runDir).some((l) => l.run === 'r-cidr' && l.action === 'deny'),
          { was: 'the CIDR refusal is written to egress.jsonl' })
        falsch(auditLines(runDir).some((l) => l.run === 'r-cidr' && l.action !== 'deny'),
          'nothing but the refusal is recorded for it')
      } finally {
        await stopProxy(fence)
      }
    })

    await pruefe('mode "none" refuses everything, allowlist or not', async () => {
      const stumm = await startProxy({ id: 'r-none' },
        { network: { mode: 'none', allow: ['localhost'], denyUpstreamCidrs: [] } },
        { runId: 'r-none', bind: BIND })
      try {
        const res = await proxyGet(stumm.port, `http://localhost:${upPort}/x`)
        gleich(res.status, 403, 'a run with no network gets none')
        enthaelt(res.body, 'fl-report access', 'and is still told how to say so')
      } finally {
        await stopProxy(stumm)
      }
    })
  } finally {
    await aufraeumen()
  }

  bericht('Sandbox egress proxy tests', start)
}

main().then(() => process.exit(zaehler.fehler.length ? 1 : 0),
  (err) => { console.error(err); process.exit(1) })
