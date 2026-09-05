// Freilauf — the egress proxy: the engine interface, and the built-in CONNECT
// proxy that implements it (SANDBOX_RESEARCH.md §7.5, §7.12).
//
// A sandboxed run's container sits on an internal Docker network with no default
// route; its only way out is an HTTP proxy this module owns. Two engines answer
// the same interface:
//
//   builtin     — this file: an HTTP CONNECT proxy inside the hub process, one
//                 listener per run, policy in memory. It tunnels HTTPS rather
//                 than terminating it, so it can say yes or no to a HOST and
//                 nothing finer.
//   iron-proxy  — ironproxy.mjs: a container that terminates TLS and can
//                 therefore also judge methods and swap credentials in.
//
// The interface is what makes §10's phase order a choice rather than a rewrite,
// and `engineCapabilities()` is what keeps it honest: everything the built-in
// cannot do must be ASKABLE of the engine, so the profile editor greys those
// fields out instead of offering a switch that silently does nothing.
//
// What this module deliberately does NOT hold, for the built-in engine: a
// credential. `secrets.mode: 'inject'` needs TLS termination, and a proxy that
// terminated TLS with a hub-minted CA would be a very different piece of code
// with a very different blast radius. `engineCapabilities('builtin').inject` is
// false and `proxyPolicy()` refuses the combination rather than quietly running
// the weaker mode.
import http from 'node:http'
import net from 'node:net'
import dns from 'node:dns/promises'
import {
  createWriteStream, mkdirSync, existsSync, statSync, openSync, readSync, closeSync,
  writeFileSync, renameSync, rmSync, watch as watchPath,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { t } from '../i18n.mjs'
import { normalizeSpec } from './spec.mjs'
import { hostGlobMatch } from './presets.mjs'

// EVERYTHING THIS FILE NEEDS FROM THE HUB IS IMPORTED LAZILY, and that is a
// contract rather than a habit: `sandbox/proxy-entry.mjs` imports this module
// INSIDE the proxy container, where the only things mounted are `server/`,
// `lang/` and `sandbox/` — no database, no `~/.config`, no credential. A static
// import of `util.mjs` or `exec.mjs` here would decide, from a file nobody was
// editing, what the container has to be able to reach.

// ---------------------------------------------------------------- the engines

/**
 * What each engine can really do. The profile editor asks this, so a field that
 * would do nothing is greyed out rather than offered — the same rule the goal
 * field follows for a harness that knows no `/goal`.
 *
 * `tlsTerminate` is the root of the other two: without it the proxy sees a
 * CONNECT line and encrypted bytes, so there is no method to judge and no
 * header to swap a credential into.
 */
const ENGINES = {
  builtin: { tlsTerminate: false, inject: false, methods: false },
  'iron-proxy': { tlsTerminate: true, inject: true, methods: true },
}

/** Normalise an engine id; anything unknown is the built-in, which always works. */
export function proxyEngine(id) {
  return Object.hasOwn(ENGINES, id) ? id : 'builtin'
}

/** `{ tlsTerminate, inject, methods }` for an engine id. Never throws. */
export function engineCapabilities(id) {
  return { ...ENGINES[proxyEngine(id)] }
}

// ------------------------------------------------------- the upstream address fence

/**
 * The default `denyUpstreamCidrs` (§4.5): loopback, "this host", RFC 1918,
 * carrier-grade NAT, link-local — which is where every cloud metadata service
 * lives (AWS, GCP and Azure all answer on 169.254.169.254; Alibaba's
 * 100.100.100.200 falls into the CGNAT block) — plus the IPv6 equivalents.
 *
 * This is checked on the RESOLVED ADDRESS and not on the name, because the
 * attack this exists for is precisely an allowlisted name that resolves into
 * RFC 1918: `internal-metadata.example.com` on the allowlist with an A record of
 * 169.254.169.254, or a DNS-rebinding answer that is public on the first lookup
 * and private on the second. A name check alone closes neither.
 */
export const DEFAULT_DENY_CIDRS = [
  '0.0.0.0/8',          // "this host on this network"
  '10.0.0.0/8',         // RFC 1918
  '100.64.0.0/10',      // RFC 6598 CGNAT — Alibaba metadata lives at 100.100.100.200
  '127.0.0.0/8',        // loopback
  '169.254.0.0/16',     // link-local — AWS/GCP/Azure metadata at 169.254.169.254
  '172.16.0.0/12',      // RFC 1918
  '192.168.0.0/16',     // RFC 1918
  '::1/128',            // IPv6 loopback
  'fc00::/7',           // IPv6 unique local
  'fe80::/10',          // IPv6 link-local
]

/** IPv4 dotted quad or IPv6 text → a byte array, or null when it is not an address. */
function ipBytes(text) {
  const fam = net.isIP(text)
  if (fam === 4) {
    const parts = String(text).split('.')
    if (parts.length !== 4) return null
    const out = []
    for (const p of parts) {
      const n = Number(p)
      if (!Number.isInteger(n) || n < 0 || n > 255) return null
      out.push(n)
    }
    return out
  }
  if (fam !== 6) return null
  // An IPv4-mapped address (::ffff:1.2.3.4) IS that IPv4 address on the wire, so
  // it is unwrapped rather than compared as v6 — otherwise ::ffff:169.254.169.254
  // would walk straight past the v4 half of the list.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(text)
  if (mapped) return ipBytes(mapped[1])
  const head = String(text).split('%')[0]   // drop a zone index (fe80::1%eth0)
  const halves = head.split('::')
  if (halves.length > 2) return null
  const readGroups = (s) => (s ? s.split(':').filter((x) => x !== '') : [])
  const left = readGroups(halves[0])
  const right = halves.length === 2 ? readGroups(halves[1]) : []
  const fill = 8 - left.length - right.length
  if (halves.length === 1 && left.length !== 8) return null
  if (fill < 0) return null
  const groups = [...left, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...right]
  const out = []
  for (const g of groups) {
    const n = Number.parseInt(g, 16)
    if (!Number.isInteger(n) || n < 0 || n > 0xffff) return null
    out.push((n >> 8) & 0xff, n & 0xff)
  }
  return out.length === 16 ? out : null
}

function parseCidr(text) {
  const [addr, bitsText] = String(text).split('/')
  const bytes = ipBytes(addr)
  if (!bytes) return null
  const max = bytes.length * 8
  const bits = bitsText === undefined ? max : Number(bitsText)
  if (!Number.isInteger(bits) || bits < 0 || bits > max) return null
  return { text: String(text), bytes, bits }
}

function inCidr(cidr, bytes) {
  if (bytes.length !== cidr.bytes.length) return false   // v4 never matches a v6 range
  let left = cidr.bits
  for (let i = 0; i < bytes.length && left > 0; i++) {
    const take = Math.min(8, left)
    const mask = take === 8 ? 0xff : (0xff << (8 - take)) & 0xff
    if ((bytes[i] & mask) !== (cidr.bytes[i] & mask)) return false
    left -= take
  }
  return true
}

/**
 * The blocked range an address falls into, or null. An address that cannot be
 * parsed counts as blocked (returns the marker `invalid`): the fence must not be
 * opened by something the hub failed to understand.
 */
export function deniedCidr(policy, address) {
  const list = policy?.denyCidrs ?? []
  if (!list.length) return null
  const bytes = ipBytes(address)
  if (!bytes) return 'invalid'
  for (const c of list) if (inCidr(c, bytes)) return c.text
  return null
}

/** Boolean form of the above, for a caller that only wants the verdict. */
export function addressDenied(policy, address) {
  return deniedCidr(policy, address) !== null
}

// ------------------------------------------------------------------- the policy

const EMPTY_POLICY_REASON = 'allow list is empty'

/**
 * The resolved policy for one run — pure, frozen, and the ONLY thing the request
 * handlers read. Swapping it is a single assignment (see `reloadProxy`).
 *
 * Fail closed: anything that cannot be built leaves `broken` set, and a broken
 * policy refuses every host. A sandbox whose policy did not compile must not
 * open the gate — that is the one failure mode where "carry on" is worse than
 * "stop".
 */
export function proxyPolicy(spec, ctx = {}) {
  let broken = null
  let net_ = null
  try {
    net_ = normalizeSpec(spec ?? {}).network
  } catch (err) {
    broken = err?.message || String(err)
  }
  const n = net_ ?? {}
  const engine = proxyEngine(n.engine)
  const caps = engineCapabilities(engine)

  const allow = broken ? [] : uniqueStrings(n.allow)
  const deny = broken ? [] : uniqueStrings(n.deny)
  const mode = broken ? 'none' : (n.mode ?? 'allowlist')
  const auditOnly = broken ? false : n.auditOnly === true

  // A method list on an engine that cannot see a method is not a stricter
  // policy, it is a promise nobody keeps — so it is dropped and said so, rather
  // than stored and ignored. Same rule the run form applies to a routing block
  // hermes cannot pass through.
  const wantsMethods = !broken && Array.isArray(n.methods) && n.methods.length > 0
  const methods = wantsMethods && caps.methods ? n.methods.map((m) => String(m).toUpperCase()) : null

  // Not fatal, but never silent: a field the engine cannot honour is listed so
  // the form can grey it out and the event can say what was dropped.
  const unsupported = []
  if (wantsMethods && !caps.methods) unsupported.push('methods')
  if (!broken && ctx.secretsMode === 'inject' && !caps.inject) unsupported.push('secrets.inject')
  if (!broken && n.tlsTerminate === true && !caps.tlsTerminate) unsupported.push('tlsTerminate')

  const cidrSource = n.denyUpstreamCidrs === 'default' || n.denyUpstreamCidrs === undefined
    ? DEFAULT_DENY_CIDRS
    : (Array.isArray(n.denyUpstreamCidrs) ? n.denyUpstreamCidrs : [])
  const denyCidrs = []
  for (const c of cidrSource) {
    const parsed = parseCidr(c)
    if (parsed) denyCidrs.push(parsed)
    else if (!broken) broken = `unreadable CIDR: ${c}`
  }

  // An allowlist mode with nothing on the list denies everything. That is not an
  // error — it is what "default deny" means with an empty list — but the reason
  // is carried so the 403 can say it rather than leaving the agent guessing.
  const emptyAllow = !broken && mode === 'allowlist' && allow.length === 0

  return Object.freeze({
    mode, engine, auditOnly,
    allow: Object.freeze(allow),
    deny: Object.freeze(deny),
    methods: methods ? Object.freeze(methods) : null,
    denyCidrs: Object.freeze(denyCidrs),
    unsupported: Object.freeze(unsupported),
    emptyAllow,
    emptyAllowReason: emptyAllow ? EMPTY_POLICY_REASON : null,
    broken,
  })
}

function uniqueStrings(list) {
  const out = []
  for (const x of Array.isArray(list) ? list : []) {
    const s = String(x ?? '').trim().toLowerCase()
    if (s && !out.includes(s)) out.push(s)
  }
  return out
}

/**
 * The full verdict for one host: `{ action, allowed, reason, rule }`.
 * `action` is what the audit line records — 'allow', 'deny', or 'would_deny'
 * for the denial an audit-only run lets through and counts (§7.12.5).
 */
export function hostVerdict(policy, host) {
  const name = String(host ?? '').trim().toLowerCase()
  if (!policy || policy.broken) {
    return { action: 'deny', allowed: false, reason: 'policy_broken', rule: policy?.broken ?? 'no policy' }
  }
  if (policy.mode === 'none') return { action: 'deny', allowed: false, reason: 'no_network', rule: null }
  if (!name) return { action: 'deny', allowed: false, reason: 'not_allowed', rule: null }

  // Deny wins over allow, always and before anything else is asked: a deny entry
  // is the operator's way of carving a hole out of a preset they otherwise want,
  // and an ordering where allow could win would make that hole unreliable.
  const denied = policy.deny.find((p) => globMatch(p, name))
  if (denied) return audited(policy, { action: 'deny', allowed: false, reason: 'denied', rule: denied })

  if (policy.mode === 'open') return { action: 'allow', allowed: true, reason: 'open', rule: null }

  const allowed = policy.allow.find((p) => globMatch(p, name))
  if (allowed) return { action: 'allow', allowed: true, reason: 'allowed', rule: allowed }
  return audited(policy, { action: 'deny', allowed: false, reason: 'not_allowed', rule: null })
}

/**
 * Audit-only turns a denial into a recorded near-miss (§7.12.5): the request
 * goes through, and the host is counted so the repo page can propose an
 * allowlist grown from the repo's own traffic. This is the rollout mode the
 * whole "observe, then enforce" path hangs on, so the near-miss is a full audit
 * line and a counted host, not a log message.
 */
function audited(policy, verdict) {
  if (!policy.auditOnly) return verdict
  return { ...verdict, action: 'would_deny', allowed: true }
}

/** The plain question, for a caller that wants a boolean and nothing else. */
export function hostAllowed(policy, host) {
  return hostVerdict(policy, host).allowed
}

/** Whether a method is permitted. Always true on an engine that cannot see one. */
export function methodAllowed(policy, method) {
  if (!policy?.methods) return true
  return policy.methods.includes(String(method ?? '').toUpperCase())
}

function globMatch(pattern, host) {
  try {
    return hostGlobMatch(pattern, host) === true
  } catch {
    return false   // an unreadable pattern never grants access
  }
}

// ------------------------------------------------------------------ the 403 body

/**
 * What the agent reads. §7.12.1: the model reads its tool output, so the
 * instruction has to be IN the refusal — a sentence it can act on beats a wall
 * it hits five times. This is the escalation path, not decoration.
 */
export function deniedBody(host, verdict, extra = {}) {
  const why = reasonText(verdict, extra)
  return `${t('sandbox.proxy.denied', { host, reason: why })}\n`
}

function reasonText(verdict, extra = {}) {
  switch (verdict?.reason) {
    case 'denied': return t('sandbox.proxy.reason_denied', { rule: verdict.rule ?? '' })
    case 'no_network': return t('sandbox.proxy.reason_no_network')
    case 'policy_broken': return t('sandbox.proxy.reason_policy_broken', { reason: verdict.rule ?? '' })
    case 'method': return t('sandbox.proxy.reason_method', { method: extra.method ?? '' })
    case 'address': return t('sandbox.proxy.reason_address', { ip: extra.ip ?? '', cidr: extra.cidr ?? '' })
    case 'dns': return t('sandbox.proxy.reason_dns')
    default: return t('sandbox.proxy.reason_not_allowed')
  }
}

// -------------------------------------------------------------------- the audit

/**
 * One JSON line per request, appended to the run's `egress.jsonl`. The shape is
 * iron-proxy's own (`host, method, path, action, status_code, duration_ms`,
 * `rejected_by`), so the two engines produce ONE audit format and the reader
 * downstream never has to ask which proxy wrote a line.
 *
 * A header value NEVER enters it. A proxy log that carries an Authorization
 * header is a credential store with a different file name, and this one is
 * written into the run directory the operator hands around.
 */
export function auditLine(fields) {
  return JSON.stringify({
    at: new Date(fields.at ?? Date.now()).toISOString(),
    run: fields.run ?? null,
    engine: fields.engine ?? 'builtin',
    host: fields.host ?? null,
    port: fields.port ?? null,
    method: fields.method ?? null,
    path: fields.path ?? null,          // a CONNECT has none — null, never ''
    action: fields.action ?? 'deny',
    status_code: fields.status ?? null,
    duration_ms: Math.max(0, Math.round(fields.durationMs ?? 0)),
    bytes_in: fields.bytesIn ?? 0,
    bytes_out: fields.bytesOut ?? 0,
    rejected_by: fields.rejectedBy ?? null,
  })
}

function auditStream(runDir) {
  if (!runDir) return null
  const file = join(runDir, 'egress.jsonl')
  try {
    mkdirSync(dirname(file), { recursive: true })
    const s = createWriteStream(file, { flags: 'a' })
    // A run directory that cannot be written must not take the proxy down with
    // it: the audit is evidence, the tunnel is the run's work.
    s.on('error', () => {})
    return s
  } catch {
    return null
  }
}

// ------------------------------------------------------------- the public lifecycle

/**
 * Start the run's proxy. Returns a handle; the caller keeps it and hands it back
 * to `reloadProxy`/`stopProxy`.
 *
 * ctx: { runId, runDir, bind, port, onBlocked, secretsMode, hubId, placement,
 *        controlDir, outDir, network, image, digest, uid, gid, lang }
 *
 * `placement` is where the BUILT-IN engine's listener runs — `'process'` (the
 * hub itself) or `'container'`. It is not a second engine: the policy, the 403
 * body and the audit format are the same code either way, and only the address
 * the agent dials differs. The caller decides, because the decision is about the
 * daemon's posture and this module does not read one (see `proxyPlacement()` in
 * index.mjs).
 */
export async function startProxy(run, spec, ctx = {}) {
  const engine = proxyEngine(normalizeSafe(spec).network?.engine)
  if (engine === 'iron-proxy') {
    // Lazily, so a hub with no container runtime can still import this file —
    // and so ironproxy.mjs may import runtime.mjs without a cycle reaching back
    // here. Same rule the plugin files follow (AGENTS.md, "Pitfalls").
    const mod = await import('./ironproxy.mjs')
    return mod.startIronProxy(run, spec, ctx)
  }
  if (ctx.placement === 'container') return startBuiltinContainer(run, spec, ctx)
  return startBuiltin(run, spec, ctx)
}

/**
 * A live policy change (§7.12.3). For the built-in engine this is deliberately
 * ONE assignment of a frozen object: `handle.policy = next`. Every handler reads
 * `handle.policy` when a connection arrives, so the swap is atomic by
 * construction — no lock, no restart, and a tunnel already open is not dropped.
 * A tightening therefore applies to the NEXT connection, which is what
 * iron-proxy does too and what §7.12.3 accepts.
 */
export async function reloadProxy(handle, spec) {
  if (!handle) return { ok: false, reason: 'no handle' }
  if (handle.engine === 'iron-proxy') {
    const mod = await import('./ironproxy.mjs')
    return mod.reloadIronProxy(handle, spec)
  }
  const next = proxyPolicy(spec, { secretsMode: handle.secretsMode })
  // THE CONTAINER PLACEMENT'S CONTROL CHANNEL, and the reason it is a FILE.
  //
  // The hub cannot reach the proxy over the network — that is the whole problem
  // this placement exists to solve — so a management port would have to be
  // published back to the host, which is the bind that does not work under a
  // rootless daemon in the first place. The two candidates left were a file the
  // proxy watches and a `docker exec` that signals it. The file wins on four
  // counts, and each of them is a way exec would go wrong:
  //
  //   - `exec` would still need the file (a signal carries no policy), so it is
  //     strictly the file PLUS a daemon round trip;
  //   - it is durable. A proxy container that restarts, and a hub that restarts,
  //     both read the CURRENT policy on the way up. A signal sent to a proxy
  //     that was not listening is simply lost, and a run would go on enforcing
  //     the policy it was launched with while every page said otherwise;
  //   - `docker exec` into the egress boundary means the boundary accepts new
  //     processes. This container is `--read-only`, `--cap-drop ALL`,
  //     `--security-opt no-new-privileges` precisely so that it does not;
  //   - and it is the same shape iron-proxy already uses for its own config, so
  //     there is one answer to "where does a proxy's policy live".
  //
  // Written to a temporary name and RENAMED, so the proxy can never read half a
  // document; the container watches the DIRECTORY, which is what makes a rename
  // visible to it at all (a bind-mounted FILE would keep pointing at the old
  // inode — the trap that would have made this look like a silent no-op).
  if (handle.placement === 'container') {
    const written = writePolicyFile(handle, spec)
    if (!written.ok) return { ok: false, reason: written.reason, policy: handle.policy }
  }
  handle.policy = next            // ← the atomic swap
  handle.spec = spec
  return { ok: true, policy: next }
}

export async function stopProxy(handle) {
  if (!handle) return { ok: true }
  if (handle.engine === 'iron-proxy') {
    const mod = await import('./ironproxy.mjs')
    return mod.stopIronProxy(handle)
  }
  if (handle.placement === 'container') return stopBuiltinContainer(handle)
  return stopBuiltin(handle)
}

/**
 * Hand the engine §7.8's substitution table: `[{ name, placeholder, value,
 * header, prefix, hosts }]`, one entry per credential the container is to hold
 * a placeholder for.
 *
 * EVERY engine answers this, including the one that cannot do it — that is the
 * whole point of the function existing here rather than only on iron-proxy. The
 * built-in CONNECT proxy sees a CONNECT line and encrypted bytes: there is no
 * header to swap, and no amount of trying makes one appear. So it REFUSES, with
 * a reason naming the engine, and the caller fails the launch on it. The
 * alternative — a caller that has to know which engine it holds — is how the
 * capability question ends up answered in two places, and how one of them
 * eventually answers "no such function" instead of "this engine cannot".
 *
 * `{ ok: false, reason }` is a refusal, never a throw, and `{ ok: true }` means
 * the table is really in force.
 */
export async function setSecrets(handle, table) {
  if (!handle) return { ok: false, reason: 'no handle' }
  if (handle.engine === 'iron-proxy') {
    const mod = await import('./ironproxy.mjs')
    return mod.setSecretsIronProxy(handle, table)
  }
  return { ok: false, reason: t('sandbox.proxy.inject_engine_cannot', { engine: handle.engine ?? 'builtin' }) }
}

function normalizeSafe(spec) {
  try { return normalizeSpec(spec ?? {}) } catch { return { network: {} } }
}

// ------------------------------------------------------ the built-in CONNECT proxy

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])

async function startBuiltin(run, spec, ctx = {}) {
  const runId = ctx.runId ?? run?.id ?? null
  const handle = {
    engine: 'builtin',
    placement: 'process',
    runId,
    run,
    spec,
    secretsMode: ctx.secretsMode ?? null,
    policy: proxyPolicy(spec, { secretsMode: ctx.secretsMode }),
    onBlocked: typeof ctx.onBlocked === 'function' ? ctx.onBlocked : null,
    // The name resolver, as a seam. Real runs never set it; the egress suite
    // does, because the hostnames a POLICY test needs (`denied.test`,
    // `learnme.test`) are the ones deliberately not in anybody's DNS — and a
    // test that could only use names that resolve would be testing the
    // resolver. The fence test below it uses the real one, on purpose.
    lookup: typeof ctx.lookup === 'function' ? ctx.lookup : null,
    // Per-host running counts. The caller reports every denial and may throttle
    // on this number — §7.12.1 deduplicates per host per ten minutes, and that
    // is the caller's decision, not ours.
    blocked: new Map(),
    wouldBlock: new Map(),
    requests: 0,
    audit: auditStream(ctx.runDir),
    sockets: new Set(),
    server: null,
    port: null,
    url: null,
  }

  const server = http.createServer()
  handle.server = server
  server.on('connection', (sock) => {
    handle.sockets.add(sock)
    sock.on('close', () => handle.sockets.delete(sock))
  })
  server.on('connect', (req, socket, head) => onConnect(handle, req, socket, head))
  server.on('request', (req, res) => onRequest(handle, req, res))
  // A client that speaks nonsense must not take the listener with it.
  server.on('clientError', (_err, socket) => { try { socket.destroy() } catch {} })

  const bind = ctx.bind ?? '127.0.0.1'
  const port = ctx.port ?? 0
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, bind, () => { server.removeListener('error', reject); resolve() })
  })
  handle.port = server.address().port
  handle.bind = bind
  handle.url = `http://${bind.includes(':') ? `[${bind}]` : bind}:${handle.port}`
  return handle
}

async function stopBuiltin(handle) {
  for (const s of handle.sockets) { try { s.destroy() } catch {} }
  handle.sockets.clear()
  await new Promise((resolve) => {
    if (!handle.server) return resolve()
    handle.server.close(() => resolve())
    setTimeout(resolve, 2000).unref()   // a stuck close must not hang a teardown
  })
  if (handle.audit) { try { handle.audit.end() } catch {} }
  handle.audit = null
  return { ok: true }
}

/** `api.example.com:443` / `[::1]:443` → `{ host, port }`. */
export function splitHostPort(target, fallbackPort = 443) {
  const s = String(target ?? '').trim()
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(s)
  if (v6) return { host: v6[1], port: Number(v6[2] ?? fallbackPort) }
  const i = s.lastIndexOf(':')
  if (i > 0 && !s.slice(i + 1).includes(':')) {
    const p = Number(s.slice(i + 1))
    if (Number.isInteger(p) && p > 0) return { host: s.slice(0, i), port: p }
  }
  return { host: s, port: fallbackPort }
}

function countBlocked(map, host) {
  const n = (map.get(host) ?? 0) + 1
  map.set(host, n)
  return n
}

function record(handle, fields) {
  handle.requests++
  if (handle.audit) { try { handle.audit.write(auditLine({ ...fields, run: handle.runId }) + '\n') } catch {} }
}

function announceBlocked(handle, { host, method, path = null, action, at }) {
  const count = countBlocked(action === 'would_deny' ? handle.wouldBlock : handle.blocked, host)
  if (handle.onBlocked) {
    try { handle.onBlocked({ host, method, path, at, count, action }) } catch {}
  }
  return count
}

/**
 * The decision, shared by both entries. Resolves the name and vets the ADDRESS,
 * because an allowlisted name that resolves into RFC 1918 is exactly the attack
 * the CIDR fence exists for (§4.5): a public A record on the lookup the operator
 * did and a private one on the lookup the proxy does is DNS rebinding, and a
 * name check alone does not close it.
 *
 * The vetted address is returned and CONNECTED TO by address, so nothing can
 * change between the check and the connection.
 */
async function decide(handle, { host, port, method, path }) {
  const policy = handle.policy       // read once — a reload may land mid-request
  const verdict = hostVerdict(policy, host)
  if (!verdict.allowed) return { policy, verdict, address: null }
  if (!methodAllowed(policy, method)) {
    return { policy, verdict: { action: 'deny', allowed: false, reason: 'method', rule: null }, address: null }
  }

  let addresses = []
  if (net.isIP(host)) addresses = [{ address: host }]
  else {
    try {
      addresses = await (handle.lookup ? handle.lookup(host) : dns.lookup(host, { all: true }))
    } catch {
      return { policy, verdict: { action: 'deny', allowed: false, reason: 'dns', rule: null }, address: null }
    }
  }
  if (!addresses.length) {
    return { policy, verdict: { action: 'deny', allowed: false, reason: 'dns', rule: null }, address: null }
  }
  // ANY blocked address refuses the whole name. A name that resolves to both a
  // public and a private address is the rebinding case, and picking the public
  // one would leave the attack a retry away. The fence is NOT lifted by
  // auditOnly: audit-only is a rollout mode for the allowlist (§7.12.5), never
  // permission to hand the container the metadata service.
  for (const a of addresses) {
    const cidr = deniedCidr(policy, a.address)
    if (cidr) {
      return {
        policy, address: null,
        verdict: { action: 'deny', allowed: false, reason: 'address', rule: cidr },
        extra: { ip: a.address, cidr },
      }
    }
  }
  return { policy, verdict, address: addresses[0].address, port }
}

async function onConnect(handle, req, clientSocket, head) {
  const at = Date.now()
  // THE FIRST LINE, AND IT IS NOT DEFENSIVE PROGRAMMING — IT IS THE PROCESS.
  //
  // A socket with no `error` listener emits node's unhandled `'error'` event,
  // and that is an uncaught exception: the whole process dies. The denial path
  // below writes a 403 and ends the socket, and curl answers a refused tunnel by
  // RESETTING it — measured 2026-09-05 against the real daemon, `read
  // ECONNRESET` out of `TCP.onStreamRead`, the proxy gone one second after its
  // first denial and every later request failing with "could not resolve proxy".
  //
  // In the container placement that is a run whose egress dies at its first
  // blocked host. In the IN-PROCESS placement it is the same fault one layer up:
  // the listener lives in the hub, so an agent hitting its own allowlist would
  // have taken the scheduler, the watcher and every SSE client with it. The
  // handler further down (`shut`) is registered only after `net.connect()`
  // returns, which is far too late — the whole refusal happens before it, and so
  // does the DNS lookup in `decide()`.
  clientSocket.on('error', () => { try { clientSocket.destroy() } catch {} })
  const { host, port } = splitHostPort(req.url, 443)
  const d = await decide(handle, { host, port, method: 'CONNECT', path: null })

  if (!d.verdict.allowed) {
    const body = deniedBody(host, d.verdict, d.extra ?? {})
    announceBlocked(handle, { host, method: 'CONNECT', action: 'deny', at })
    record(handle, {
      at, host, port, method: 'CONNECT', path: null, action: 'deny', status: 403,
      durationMs: Date.now() - at, rejectedBy: d.verdict.reason,
    })
    // A 403 on a CONNECT is what the client shows the agent, so the body is
    // written out in full rather than left to the status line.
    try {
      clientSocket.write(
        'HTTP/1.1 403 Forbidden\r\n'
        + 'Content-Type: text/plain; charset=utf-8\r\n'
        + `Content-Length: ${Buffer.byteLength(body)}\r\n`
        + 'Connection: close\r\n\r\n' + body)
    } catch {}
    try { clientSocket.end() } catch {}
    return
  }

  const upstream = net.connect({ host: d.address, port }, () => {
    try {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: Freilauf\r\n\r\n')
    } catch {}
    if (head?.length) upstream.write(head)
    clientSocket.pipe(upstream)
    upstream.pipe(clientSocket)
  })

  let bytesIn = 0, bytesOut = 0
  upstream.on('data', (c) => { bytesIn += c.length })
  clientSocket.on('data', (c) => { bytesOut += c.length })

  // `pipe()` unpipes a dead destination; it does not tear the source down. The
  // existing vpn-proxy suite is the lesson: without these two lines an
  // abandoned tunnel leaves an upstream socket standing for the life of the
  // process, and nothing above says so.
  const shut = () => { try { upstream.destroy() } catch {}; try { clientSocket.destroy() } catch {} }
  clientSocket.on('close', shut)
  clientSocket.on('error', shut)
  upstream.on('close', () => {
    record(handle, {
      at, host, port, method: 'CONNECT', path: null,
      action: d.verdict.action, status: 200, durationMs: Date.now() - at, bytesIn, bytesOut,
    })
    if (d.verdict.action === 'would_deny') {
      announceBlocked(handle, { host, method: 'CONNECT', action: 'would_deny', at })
    }
    shut()
  })
  upstream.on('error', () => {
    record(handle, {
      at, host, port, method: 'CONNECT', path: null, action: d.verdict.action,
      status: 502, durationMs: Date.now() - at, bytesIn, bytesOut, rejectedBy: 'upstream',
    })
    shut()
  })
}

async function onRequest(handle, req, res) {
  const at = Date.now()
  // The same rule as the tunnel above, for the plain-HTTP entry: a client that
  // aborts while the hub is resolving a name, or that resets after reading the
  // 403, must cost this request and never the process.
  req.on('error', () => {})
  res.on('error', () => {})
  let target
  try {
    target = new URL(req.url.startsWith('http') ? req.url : `http://${req.headers.host ?? ''}${req.url}`)
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('bad request\n')
    return
  }
  const host = target.hostname
  const port = Number(target.port || 80)
  const path = target.pathname + target.search
  const method = req.method

  const d = await decide(handle, { host, port, method, path })
  if (!d.verdict.allowed) {
    const body = deniedBody(host, d.verdict, d.extra ?? {})
    announceBlocked(handle, { host, method, path, action: 'deny', at })
    record(handle, {
      at, host, port, method, path, action: 'deny', status: 403,
      durationMs: Date.now() - at, rejectedBy: d.verdict.reason,
    })
    res.writeHead(403, {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': String(Buffer.byteLength(body)),
    }).end(body)
    return
  }
  if (d.verdict.action === 'would_deny') {
    announceBlocked(handle, { host, method, path, action: 'would_deny', at })
  }

  const headers = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v
  }
  headers.host = target.port ? `${host}:${port}` : host

  const upstream = http.request({
    host: d.address, port, method, path, headers,
    setHost: false,
  }, (up) => {
    const out = {}
    for (const [k, v] of Object.entries(up.headers)) {
      if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v
    }
    res.writeHead(up.statusCode ?? 502, out)
    let bytes = 0
    up.on('data', (c) => { bytes += c.length })
    up.on('end', () => record(handle, {
      at, host, port, method, path, action: d.verdict.action,
      status: up.statusCode ?? 0, durationMs: Date.now() - at, bytesIn: bytes,
    }))
    up.pipe(res)
  })
  upstream.on('error', () => {
    record(handle, {
      at, host, port, method, path, action: d.verdict.action, status: 502,
      durationMs: Date.now() - at, rejectedBy: 'upstream',
    })
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    try { res.end('upstream error\n') } catch {}
  })
  // Same lesson as the tunnel above: the client going away has to destroy the
  // request it started, or the socket to the upstream is never released.
  res.on('close', () => { try { upstream.destroy() } catch {} })
  req.pipe(upstream)
}

// ---------------------------------------- the built-in engine, as a container
//
// Under a rootless daemon the built-in listener cannot live on the host (§11b,
// measured): the run's bridge is inside rootlesskit's own network namespace, the
// hub gets EADDRNOTAVAIL binding its gateway, and a container on an `--internal`
// network can reach no host address at all. The listener therefore moves ONTO
// that network — a container of its own, with a second leg to `bridge` for its
// own egress — and the agent's HTTPS_PROXY names it by container name.
//
// The policy engine does not move with it. `sandbox/proxy-entry.mjs` runs
// `runProxyProcess()` below, which is `startBuiltin()` reading its spec from a
// file: same `hostVerdict`, same `deniedBody`, same `auditLine`. That is the
// property the whole placement hangs on — a second matcher would be two
// allowlists that agree until the day they do not.

/** The policy document's name inside the control directory. */
export const POLICY_FILE = 'policy.json'
/** What the container writes into its one writable mount, and the hub tails. */
export const CONTAINER_AUDIT_FILE = 'egress.jsonl'
/** Written by the proxy once it is really listening — the readiness evidence. */
export const READY_FILE = 'ready.json'

/**
 * The document the hub writes and the container reads. It carries the SPEC and
 * not the resolved policy, so the container computes `proxyPolicy()` itself —
 * one policy builder, and a hub and a proxy that cannot come to disagree about
 * what an allow list means.
 */
export function policyDocument(spec, ctx = {}) {
  return JSON.stringify({
    version: 1,
    runId: ctx.runId ?? null,
    at: new Date(ctx.at ?? Date.now()).toISOString(),
    secretsMode: ctx.secretsMode ?? null,
    spec: spec ?? {},
  }) + '\n'
}

/**
 * The other half. A document that cannot be read returns `null` and the caller
 * KEEPS THE POLICY IT HAS — never falls back to an empty one, which in
 * allowlist mode is "deny everything" and would turn a typo in a rewrite into a
 * run whose egress silently stopped.
 */
export function readPolicyDocument(text) {
  let j
  try { j = JSON.parse(String(text ?? '')) } catch { return null }
  if (!j || typeof j !== 'object' || !j.spec || typeof j.spec !== 'object') return null
  return { spec: j.spec, secretsMode: j.secretsMode ?? null, runId: j.runId ?? null, at: j.at ?? null }
}

function writePolicyFile(handle, spec) {
  const dir = handle.controlDir
  if (!dir) return { ok: false, reason: 'no control directory' }
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tmp = join(dir, `.${POLICY_FILE}.tmp`)
    writeFileSync(tmp, policyDocument(spec, { runId: handle.runId, secretsMode: handle.secretsMode }), { mode: 0o600 })
    renameSync(tmp, join(dir, POLICY_FILE))
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: err?.message || String(err) }
  }
}

function failedContainer(runId, reason) {
  return { engine: 'builtin', placement: 'container', runId, ok: false, reason, policy: null, blocked: new Map(), wouldBlock: new Map() }
}

/**
 * Start `fl-proxy-<run id>` on the run's own internal network. Returns a handle,
 * or `{ ok: false, reason }` — never a throw, so `ensureProxy()` can turn it
 * into one readable sentence.
 *
 * READINESS IS POSITIVE EVIDENCE, not `docker run` exiting 0. A detached run
 * returns a container id the instant the daemon has accepted it, and a proxy
 * whose entry point dies a second later would leave the agent dialling a name
 * that resolves and refuses — which reads as a network fault for the rest of the
 * run. So the entry point writes `ready.json` after its listener is up, and this
 * function waits for that file; where it never appears, the container's own log
 * is read and put into the refusal, because that is where the reason is.
 */
async function startBuiltinContainer(run, spec, ctx = {}) {
  const runId = ctx.runId ?? run?.id ?? null
  if (!runId) return failedContainer(runId, 'no run id')
  if (!ctx.controlDir || !ctx.outDir) return failedContainer(runId, 'no control directory')

  let runtime
  try { runtime = await import('./runtime.mjs') }
  catch (err) { return failedContainer(runId, t('sandbox.proxy.engine_missing', { reason: err?.message || String(err) })) }

  const handle = {
    engine: 'builtin',
    placement: 'container',
    runId, run, spec,
    secretsMode: ctx.secretsMode ?? null,
    policy: proxyPolicy(spec, { secretsMode: ctx.secretsMode }),
    onBlocked: typeof ctx.onBlocked === 'function' ? ctx.onBlocked : null,
    blocked: new Map(),
    wouldBlock: new Map(),
    requests: 0,
    controlDir: ctx.controlDir,
    outDir: ctx.outDir,
    container: ctx.containerName ?? runtime.proxyName(runId),
    port: Number(ctx.port) > 0 ? Number(ctx.port) : runtime.EGRESS_PROXY_PORT,
    runtimeId: normalizeSafe(spec).runtime,
    // The run's OWN `egress.jsonl`, exactly where the in-process placement puts
    // it and where audit.mjs looks: the container writes into its private out
    // directory, the hub copies each line here. One audit file per run, one
    // format, whichever placement produced it.
    audit: auditStream(ctx.runDir),
    auditOffset: 0,
    watcher: null,
    tailTimer: null,
  }
  handle.url = `http://${handle.container}:${handle.port}`

  // A leftover from a previous attempt holds the name and would make `docker
  // run` fail with a collision rather than with the reason.
  try {
    await runtime.stopContainer(handle.container, { runtime: handle.runtimeId, timeoutSec: 5 })
    await runtime.removeContainer(handle.container, { runtime: handle.runtimeId, force: true })
  } catch { /* a name that is already free is the ordinary case */ }

  try {
    mkdirSync(handle.controlDir, { recursive: true, mode: 0o700 })
    mkdirSync(handle.outDir, { recursive: true, mode: 0o700 })
    // A stale readiness marker would make the wait below answer instantly for a
    // container that never came up.
    rmSync(join(handle.outDir, READY_FILE), { force: true })
  } catch (err) {
    return failedContainer(runId, err?.message || String(err))
  }
  const written = writePolicyFile(handle, spec)
  if (!written.ok) return failedContainer(runId, written.reason)

  let argv
  try {
    argv = runtime.buildEgressProxyArgv(spec, {
      runId, hubId: ctx.hubId, network: ctx.network, image: ctx.image, digest: ctx.digest,
      controlDir: handle.controlDir, outDir: handle.outDir, containerName: handle.container,
      port: handle.port, uid: ctx.uid, gid: ctx.gid, lang: ctx.lang, env: ctx.env,
    })
  } catch (err) {
    return failedContainer(runId, err?.message || String(err))
  }
  if (!argv) return failedContainer(runId, 'no proxy command line')

  const { sh } = await import('../util.mjs')
  const started = await sh(argv.bin, argv.args, { timeout: 120_000 })
  if (!started.ok) {
    return failedContainer(runId, (started.stderr || started.stdout || '').trim() || 'docker run failed')
  }

  const ready = await waitForReady(handle, Number(ctx.readyTimeoutMs ?? 20_000))
  if (!ready.ok) {
    const why = await containerLogTail(handle, runtime)
    try { await stopBuiltinContainer(handle) } catch {}
    return failedContainer(runId, `${ready.reason}${why ? ` · ${why}` : ''}`)
  }

  startAuditTail(handle)
  return handle
}

/**
 * TAKE A RUNNING PROXY CONTAINER BACK OVER, after a hub restart. This hub
 * restarts 164 times in 30 days, so it is the ordinary case and not an edge one.
 *
 * The container itself survives a restart untouched — the daemon keeps it and
 * the agent goes on dialling it by name — but the HANDLE dies with the process,
 * and two things hang on the handle: the audit tail that turns a denial into a
 * `sandbox:blocked` event, and the policy channel `changePolicy()` writes
 * through. Without them a restarted hub would go on enforcing correctly and stop
 * saying anything about it, and a policy change would be accepted and never
 * arrive.
 *
 * THIS IS WHERE THE FILE CONTROL CHANNEL PAYS FOR ITSELF. iron-proxy deliberately
 * refuses to be re-attached: its management key is minted per launch and lives
 * only in the old container's environment, so a fabricated handle would let
 * `changePolicy()` believe it had delivered a policy it did not. Here there is no
 * such secret — the channel is a file in a directory the hub owns — so a full,
 * honest handle can be rebuilt for a container the hub never started.
 *
 * The policy is REWRITTEN from the row's own spec on the way in. The row is the
 * truth about what this run's policy is; a control file that drifted from it (a
 * data directory restored from a backup, a half-written rewrite the old process
 * did not finish) is repaired rather than trusted.
 *
 * `{ ok: false, reason }` when the container is not demonstrably running —
 * "the daemon did not answer" is not "it is gone", and the caller then does
 * nothing rather than starting a second proxy on a name that is taken.
 */
export async function attachProxy(run, spec, ctx = {}) {
  const runId = ctx.runId ?? run?.id ?? null
  if (ctx.placement !== 'container') return { ok: false, reason: 'not a container placement' }
  if (proxyEngine(normalizeSafe(spec).network?.engine) !== 'builtin') {
    return { ok: false, reason: 'only the built-in engine can be re-attached' }
  }
  if (!runId || !ctx.controlDir || !ctx.outDir) return { ok: false, reason: 'no control directory' }

  let runtime
  try { runtime = await import('./runtime.mjs') }
  catch (err) { return { ok: false, reason: err?.message || String(err) } }

  const container = ctx.containerName ?? runtime.proxyName(runId)
  const runtimeId = normalizeSafe(spec).runtime
  const state = await runtime.containerState(container, { runtime: runtimeId })
  const verdict = state?.verdict ?? 'ok'
  if (verdict !== 'ok') return { ok: false, reason: 'the daemon did not answer' }
  if (!state?.running) return { ok: false, reason: 'the proxy container is not running' }

  const handle = {
    engine: 'builtin',
    placement: 'container',
    runId, run, spec,
    secretsMode: ctx.secretsMode ?? null,
    policy: proxyPolicy(spec, { secretsMode: ctx.secretsMode }),
    onBlocked: typeof ctx.onBlocked === 'function' ? ctx.onBlocked : null,
    blocked: new Map(),
    wouldBlock: new Map(),
    requests: 0,
    controlDir: ctx.controlDir,
    outDir: ctx.outDir,
    container,
    port: Number(ctx.port) > 0 ? Number(ctx.port) : runtime.EGRESS_PROXY_PORT,
    runtimeId,
    audit: auditStream(ctx.runDir),
    auditOffset: 0,
    watcher: null,
    tailTimer: null,
    reattached: true,
  }
  handle.url = `http://${handle.container}:${handle.port}`
  const written = writePolicyFile(handle, spec)
  if (!written.ok) return { ok: false, reason: written.reason }
  // The offset starts at the file's END: everything before it was copied into
  // the run's `egress.jsonl` and announced by the hub that started this proxy,
  // and announcing it again would raise events for denials the operator has
  // already seen. What that costs is written down rather than hidden — a denial
  // that happened while the hub was down stays in the proxy's own out file for
  // the audit export, and is not re-announced.
  startAuditTail(handle)
  return handle
}

async function waitForReady(handle, timeoutMs) {
  const file = join(handle.outDir, READY_FILE)
  const until = Date.now() + Math.max(1000, timeoutMs)
  while (Date.now() < until) {
    try { if (existsSync(file)) return { ok: true } } catch {}
    await new Promise((r) => setTimeout(r, 150))
  }
  return { ok: false, reason: t('sandbox.proxy.container_not_ready', { container: handle.container ?? '?' }) }
}

/** The last few lines of the proxy container's own log — where the reason is. */
async function containerLogTail(handle, runtime) {
  try {
    const { sh } = await import('../util.mjs')
    const bin = runtime.runtimeBin(handle.runtimeId)
    const r = await sh(bin, ['logs', '--tail', '20', handle.container], { timeout: 15_000 })
    return `${String(r.stdout ?? '')}${String(r.stderr ?? '')}`.trim().split('\n').slice(-4).join(' / ')
  } catch { return '' }
}

/**
 * THE DENIAL CHANNEL. `onBlocked` was an in-process callback; from a container
 * it has to be something the hub READS, and the audit line is already exactly
 * that — one JSON object per request, in a directory only the hub and the proxy
 * have a mount of.
 *
 * `fs.watch` on the DIRECTORY is the primary signal, and it really fires for a
 * container's write: a bind mount shares the underlying inode, so the host's
 * inotify sees it. The one-second timer next to it is a net and not a poll of
 * the file — it compares a `statSync` size and returns, because inotify does not
 * propagate on every filesystem an operator might have `~/.local/share` on, and
 * a denial that never reaches the hub is a `sandbox:blocked` event that never
 * happens.
 *
 * The offset starts at the file's CURRENT size, which is what makes this
 * idempotent across a hub restart: the lines already there were already copied
 * into the run's `egress.jsonl` and already announced, and re-announcing them
 * would re-raise events for denials the operator has seen.
 */
function startAuditTail(handle) {
  const file = join(handle.outDir, CONTAINER_AUDIT_FILE)
  try { handle.auditOffset = existsSync(file) ? statSync(file).size : 0 } catch { handle.auditOffset = 0 }
  let rest = ''
  const drain = () => {
    let size
    try { size = existsSync(file) ? statSync(file).size : 0 } catch { return }
    // A file that SHRANK was replaced or truncated; reading from a stale offset
    // would splice two documents together. Start over from its beginning.
    if (size < handle.auditOffset) { handle.auditOffset = 0; rest = '' }
    if (size === handle.auditOffset) return
    let text = ''
    try {
      const fd = openSync(file, 'r')
      try {
        const buf = Buffer.alloc(size - handle.auditOffset)
        const read = readSync(fd, buf, 0, buf.length, handle.auditOffset)
        handle.auditOffset += read
        text = buf.slice(0, read).toString('utf8')
      } finally { closeSync(fd) }
    } catch { return }
    rest += text
    const lines = rest.split('\n')
    rest = lines.pop() ?? ''
    for (const raw of lines) {
      const line = raw.trim()
      if (!line) continue
      handle.requests++
      try { handle.audit?.write(line + '\n') } catch {}
      let parsed
      try { parsed = JSON.parse(line) } catch { continue }
      if (!parsed || parsed.action === 'allow') continue
      const count = countBlocked(parsed.action === 'would_deny' ? handle.wouldBlock : handle.blocked, parsed.host)
      if (handle.onBlocked) {
        try {
          handle.onBlocked({
            host: parsed.host, method: parsed.method, path: parsed.path,
            at: Date.parse(parsed.at) || Date.now(), count, action: parsed.action,
          })
        } catch {}
      }
    }
  }
  try {
    handle.watcher = watchPath(handle.outDir, () => { try { drain() } catch {} })
    handle.watcher.on?.('error', () => {})
    // A watcher holds the event loop open. The hub has a listening server so it
    // would not notice — until a teardown is missed and the process will not
    // exit, which is the shape of leak this file already has one entry about.
    handle.watcher.unref?.()
  } catch { handle.watcher = null }
  handle.tailTimer = setInterval(() => { try { drain() } catch {} }, 1000)
  handle.tailTimer.unref?.()
  drain()
}

async function stopBuiltinContainer(handle) {
  try { handle.watcher?.close?.() } catch {}
  handle.watcher = null
  if (handle.tailTimer) { try { clearInterval(handle.tailTimer) } catch {} }
  handle.tailTimer = null
  if (handle.container) {
    try {
      const runtime = await import('./runtime.mjs')
      await runtime.stopContainer(handle.container, { runtime: handle.runtimeId, timeoutSec: 10 })
      await runtime.removeContainer(handle.container, { runtime: handle.runtimeId, force: true })
    } catch { /* teardown is fail-soft everywhere in this hub */ }
  }
  try { handle.audit?.end() } catch {}
  handle.audit = null
  return { ok: true }
}

// ------------------------------------------------- what runs IN the container

/**
 * The proxy process itself (`sandbox/proxy-entry.mjs`). It is `startBuiltin()`
 * with the policy read from a file instead of handed in, and the same live swap:
 * `handle.policy = proxyPolicy(next)` is one assignment of a frozen object, so a
 * rewrite takes effect on the NEXT connection and drops no tunnel that is open.
 *
 * Returns `{ handle, stop }`. Never binds anything until the policy has been
 * read once: a proxy that came up with an empty policy would deny everything for
 * as long as its first read took, and an agent's first request is usually its
 * `git fetch`.
 */
export async function runProxyProcess(opts = {}) {
  const policyPath = String(opts.policyPath ?? '')
  const outDir = String(opts.outDir ?? '')
  if (!policyPath) throw new Error('no policy file')

  const readSpec = () => {
    try {
      const doc = readPolicyDocument(readFileTextSync(policyPath))
      return doc
    } catch { return null }
  }
  const first = readSpec()
  if (!first) throw new Error(`policy file unreadable: ${policyPath}`)

  const handle = await startBuiltin({ id: first.runId ?? opts.runId ?? null }, first.spec, {
    runId: first.runId ?? opts.runId ?? null,
    runDir: outDir || null,
    bind: opts.bind ?? '0.0.0.0',
    port: Number(opts.port) > 0 ? Number(opts.port) : 8080,
    secretsMode: first.secretsMode,
  })

  // WATCH THE DIRECTORY, NOT THE FILE. The hub replaces the policy by rename, so
  // the file's inode changes on every change — a watch on the path would fire
  // once and then be watching something nobody writes to any more. The
  // one-second timer beside it is the same net the hub's audit tail carries, for
  // the same reason: inotify does not cross every filesystem a bind mount may
  // sit on, and a policy change that silently did not arrive is the failure this
  // whole placement exists to make impossible.
  let lastStamp = stampOf(policyPath)
  const reread = () => {
    const stamp = stampOf(policyPath)
    if (stamp === lastStamp) return
    lastStamp = stamp
    const next = readSpec()
    if (!next) return               // keep the policy in force; never fall to empty
    handle.spec = next.spec
    handle.secretsMode = next.secretsMode
    handle.policy = proxyPolicy(next.spec, { secretsMode: next.secretsMode })
  }
  let watcher = null
  try {
    watcher = watchPath(dirname(policyPath), () => { try { reread() } catch {} })
    watcher.on?.('error', () => {})
  } catch { watcher = null }
  const timer = setInterval(() => { try { reread() } catch {} }, 1000)

  // The readiness marker, LAST: it means "the listener is up and the policy is
  // the one in the file", which is what the hub waits for before it lets the
  // agent's container be created.
  if (outDir) {
    try {
      mkdirSync(outDir, { recursive: true })
      writeFileSync(join(outDir, READY_FILE),
        JSON.stringify({ at: new Date().toISOString(), port: handle.port, run: handle.runId }) + '\n')
    } catch { /* a marker that cannot be written is a start the hub will time out on, with the log to say why */ }
  }

  const stop = async () => {
    try { watcher?.close?.() } catch {}
    try { clearInterval(timer) } catch {}
    try { rmSync(join(outDir, READY_FILE), { force: true }) } catch {}
    await stopBuiltin(handle)
  }
  return { handle, stop }
}

function readFileTextSync(path) {
  const fd = openSync(path, 'r')
  try {
    const size = statSync(path).size
    const buf = Buffer.alloc(size)
    const read = readSync(fd, buf, 0, size, 0)
    return buf.slice(0, read).toString('utf8')
  } finally { closeSync(fd) }
}

/** mtime+size+inode — cheap, and it changes on a rename as well as on a rewrite. */
function stampOf(path) {
  try {
    const s = statSync(path)
    return `${s.ino}:${s.size}:${s.mtimeMs}`
  } catch { return 'gone' }
}
