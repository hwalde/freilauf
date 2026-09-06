// Freilauf — the hub's SECOND listener: a unix socket carrying exactly two routes
// (SANDBOX_RESEARCH.md §7.6).
//
// WHY this exists at all, and why it is worth having for a run that is not
// sandboxed either. `FL_HUB_URL = http://127.0.0.1:<port>` is handed to every
// agent, and `FL_RUN_ID` is the whole authentication the report route has. That
// one port carries the hub's ENTIRE API: kill any run, type text into any
// session, edit the settings that hold the notification token and the operator's
// provider credentials. An agent that misreads an instruction — or a dependency
// it installed — reaches all of it. §6 lists "the hub itself" as an asset with
// exactly that path to it.
//
// A container makes the same question urgent for a different reason: `127.0.0.1`
// inside a container is the container, and on an internal network the host is
// unreachable by design. Binding the hub on the docker bridge as well would
// contradict the one sentence the deployment rests on ("binds firmly to
// 127.0.0.1"), so the channel is a unix socket the container gets bind-mounted.
//
// The socket is therefore NOT "the API on another transport". It is a narrow
// channel with an allowlist of two routes and a per-run bearer token, and the
// full API stays where it is.
import http from 'node:http'
import net from 'node:net'
import { chmodSync, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import db from './db.mjs'
import { body as readBody } from './web-helpers.mjs'
import { handleReport, reportTokenOk } from './reports.mjs'
import { env } from './env.mjs'
import { dataDir } from './paths.mjs'
import { t } from './i18n.mjs'

/**
 * Where the socket lives. `$XDG_RUNTIME_DIR` first because that is the directory
 * the system clears on logout and creates 0700 for this user alone; the data
 * directory as the fallback for a machine that has none (a service without a
 * session, a container). `FREILAUF_HUB_SOCKET` overrides both — a test suite
 * MUST point it into its own sandbox, or a second hub on this machine would
 * fight the running one for the same file.
 */
export function hubSocketPath() {
  const named = env('HUB_SOCKET')
  if (named && named.trim()) return named.trim()
  const runtime = process.env.XDG_RUNTIME_DIR
  if (runtime && runtime.trim()) return join(runtime.trim(), 'freilauf', 'hub.sock')
  return join(dataDir(), 'hub.sock')
}

/**
 * The route allowlist — deliberately a list of what IS served and not a list of
 * what is blocked. A "block these" rule grows a hole the day somebody adds a
 * route to web.mjs; this one grows nothing at all unless a line is added here,
 * and a socket that quietly gained a third route would hand the hub back to the
 * agent it was built to fence off.
 */
const ROUTES = [
  { name: 'report', method: 'POST', re: /^\/api\/runs\/([0-9a-f-]{36})\/report$/ },
  { name: 'sandbox', method: 'GET', re: /^\/api\/runs\/([0-9a-f-]{36})\/sandbox$/ },
]

/**
 * Which of the two routes a request is, or null. Exported because the allowlist
 * is the security property worth a test of its own.
 */
export function socketRoute(method, path) {
  const clean = String(path || '').split('?')[0]
  for (const r of ROUTES) {
    if (r.method !== method) continue
    const m = clean.match(r.re)
    if (m) return { name: r.name, runId: m[1] }
  }
  return null
}

/** The bearer out of an Authorization header — `Bearer <token>` or the bare token. */
export function bearerToken(req) {
  const raw = req?.headers?.authorization
  if (typeof raw !== 'string') return ''
  const m = raw.match(/^\s*Bearer\s+(\S+)\s*$/i)
  return m ? m[1] : raw.trim()
}

function json(res, code, obj) {
  const text = JSON.stringify(obj)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }).end(text)
}

/**
 * "What am I allowed to reach" — the run's own resolved policy, so a sandboxed
 * agent can diagnose itself instead of guessing why a host answers 403.
 *
 * An ALLOWLIST of fields and not a spread of `sandbox_spec`: that document also
 * carries the secrets mode, the harness knobs and the extra mounts, and a route
 * built as a spread would publish the next field somebody adds to the spec. Same
 * rule as `pickQuickFields` in web.mjs, for the same reason.
 */
function sandboxAnswer(run) {
  if (!run.sandbox) {
    // Not sandboxed is an ANSWER, not an error: it is the state of almost every
    // run, and an agent that asks deserves to be told plainly rather than
    // left to read a 404 as "the hub does not know me".
    return { ok: true, run: run.id, sandboxed: false, message: t('sandbox.socket.not_sandboxed') }
  }
  let spec = {}
  try { spec = JSON.parse(run.sandbox_spec || '{}') } catch { spec = {} }
  const net_ = spec.network ?? {}
  const res_ = spec.resources ?? {}
  const fs_ = spec.filesystem ?? {}
  return {
    ok: true,
    run: run.id,
    sandboxed: true,
    container: run.sandbox_container ?? null,
    network: {
      mode: net_.mode ?? null,
      allow: Array.isArray(net_.allow) ? net_.allow : [],
      deny: Array.isArray(net_.deny) ? net_.deny : [],
      presets: Array.isArray(net_.presets) ? net_.presets : [],
      auditOnly: !!net_.auditOnly,
    },
    resources: {
      memory: res_.memory ?? null,
      cpus: res_.cpus ?? null,
      pidsLimit: res_.pidsLimit ?? null,
      diskTmpfs: res_.diskTmpfs ?? null,
      maxRuntimeMinutes: res_.maxRuntimeMinutes ?? null,
    },
    filesystem: {
      worktree: fs_.worktree ?? null,
      readOnlyRoot: fs_.readOnlyRoot ?? null,
    },
    ask: t('sandbox.socket.ask_hint'),
  }
}

async function handle(req, res) {
  const route = socketRoute(req.method, req.url)
  if (!route) return json(res, 404, { ok: false, error: t('sandbox.socket.no_such_route') })
  // The token is REQUIRED here, and it has to match the id in the path — which
  // is also what keeps a run from asking about another run: there is no way to
  // name a foreign id and still carry its token.
  if (!reportTokenOk(route.runId, bearerToken(req))) {
    return json(res, 401, { ok: false, error: t('sandbox.socket.unauthorized') })
  }
  if (route.name === 'report') {
    let b = {}
    try { b = JSON.parse(await readBody(req) || '{}') } catch { /* an unreadable body is an empty one */ }
    // The SAME handler the 127.0.0.1 route calls. A second copy of the report
    // logic would be a second set of rules to keep in step — and the finish
    // gate, the follow-up path and the foreign-session guard all live in it.
    // `via: 'http'` because this caller CAN be answered, which is what that
    // parameter means; fl-report prints the answer into the agent's turn.
    const r = await handleReport(route.runId, b, 'http')
    // 2xx or fl-report files the report in inbox.jsonl and the watcher replays
    // it — the same contract the loopback route documents.
    return json(res, r.ok ? 200 : 400, r)
  }
  const run = db.prepare(`SELECT id, sandbox, sandbox_spec, sandbox_container FROM runs WHERE id = ?`).get(route.runId)
  if (!run) return json(res, 404, { ok: false, error: t('sandbox.socket.unknown_run') })
  return json(res, 200, sandboxAnswer(run))
}

let server = null
let listeningAt = null

/**
 * Is somebody listening on that path right now? A stale socket file refuses the
 * connection; a live one accepts it.
 *
 * This question is asked because the ANSWER decides whether the file is deleted,
 * and deleting a live socket takes the OTHER hub's channel away without either
 * process noticing. A second installation, a test suite that forgot its own
 * path, an operator running the hub by hand next to the service: all three are
 * ordinary, and none of them may cost the running hub its socket.
 */
function socketInUse(path) {
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (done) return; done = true; try { probe.destroy() } catch {} resolve(v) }
    const probe = net.connect(path)
    probe.on('connect', () => finish(true))
    probe.on('error', () => finish(false))
    setTimeout(() => finish(false), 500).unref()
  })
}

/**
 * Start the socket listener. Fail-soft in every direction: a hub that refused to
 * boot because a socket could not be created would be worse than a hub without
 * one — every run still reports over 127.0.0.1, and an unreachable hub still has
 * inbox.jsonl underneath it. Returns the path it listens on, or null.
 */
export async function startHubSocket() {
  if (server) return listeningAt
  const path = hubSocketPath()
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    if (existsSync(path)) {
      if (await socketInUse(path)) {
        console.log(`[freilauf] hub socket ${path} belongs to another process — carrying on without it`)
        return null
      }
      // Nobody is listening, so whatever is there is a leftover: a hub that was
      // killed rather than shut down leaves the file behind, and `listen()` on
      // an existing path is EADDRINUSE. Deliberately not conditional on it being
      // a socket — a stale regular file at this path would otherwise disable the
      // socket for good, and the path belongs to the hub either way.
      try { unlinkSync(path) } catch { /* gone already */ }
    }
    const srv = http.createServer((req, res) => {
      handle(req, res).catch((e) => {
        try { json(res, 500, { ok: false, error: e.message }) } catch { /* the client left */ }
      })
    })
    await new Promise((resolve, reject) => {
      srv.once('error', reject)
      srv.listen(path, () => { srv.removeListener('error', reject); resolve() })
    })
    // 0660, not 0666: the container runs as the same uid (§7.7), so owner and
    // group are enough — and everything else on this machine has no business
    // reporting for somebody's run.
    try { chmodSync(path, 0o660) } catch { /* a filesystem that cannot: not a reason to give up the socket */ }
    server = srv
    listeningAt = path
    console.log(`[freilauf] report socket on ${path}`)
    return path
  } catch (e) {
    console.log(`[freilauf] no report socket (${e.message}) — reports go over 127.0.0.1 as before`)
    return null
  }
}

/** Close the listener and take the socket file with it. Idempotent. */
export function stopHubSocket() {
  const srv = server
  const path = listeningAt
  server = null
  listeningAt = null
  if (!srv) return
  try { srv.close() } catch {}
  try { if (path && existsSync(path) && statSync(path).isSocket()) unlinkSync(path) } catch {}
}
