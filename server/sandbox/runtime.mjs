// Freilauf — the container runtime: the command line, the lifecycle, and the
// three answers a runtime can give.
//
// Two halves, and they are deliberately different in kind:
//
//   A. buildRunArgv()/buildProxyArgv() are PURE. They turn a resolved sandbox
//      spec plus a run's context into an argv, and nothing else. That is where
//      the whole feature is actually verifiable — every flag of
//      SANDBOX_RESEARCH.md §7.11 is a line here and a unit test there, on a
//      machine that has no container runtime at all.
//   B. Everything below them talks to a daemon, and therefore never throws and
//      never spends "I did not learn anything" as "there is nothing". That is
//      runtimeVerdict(), and it is tmuxVerdict() from server/sessions.mjs
//      wearing a different vendor's error messages — for the same reason,
//      written down in AGENTS.md ("tmux did not answer is not the session is
//      gone"): a daemon restart must not end every sandboxed run.
//
// The one rule that outranks the others (the module contract): this file is
// importable and every function is callable on a machine with no Docker. The
// answer is then "not available", never a throw — the only throws in here come
// out of the pure builders, and they mean "this spec cannot become a command
// line", which is a readable refusal at launch (failRun) rather than a hang.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { env } from '../env.mjs'
import { sh } from '../util.mjs'
import { t } from '../i18n.mjs'
import { normalizeSpec } from './spec.mjs'
import { dataDir } from '../paths.mjs'

// ---------------------------------------------------------------------------
// Names, targets and constants that more than one module needs
// ---------------------------------------------------------------------------

/** The agent's container. `fl-<run id>` — what the labels and fl-kill look for. */
export function containerName(runId) { return `fl-${runId}` }
/** The run's egress proxy (§7.5.2). Reachable under this name on the internal network. */
export function proxyName(runId) { return `fl-proxy-${runId}` }
/** The run's internal network (§7.5.1). One per run, two members. */
export function networkName(runId) { return `fl-net-${runId}` }

/**
 * Where the hub's unix socket and CA appear INSIDE the container. Exported
 * because the caller sets `FL_HUB_SOCKET` from the same constant — a second
 * copy of the path is how the socket ends up mounted where nothing looks for it.
 */
export const HUB_SOCKET_TARGET = '/run/freilauf/hub.sock'
export const CA_TARGET = '/etc/freilauf/ca.crt'

/**
 * SIGTERM, then this many seconds, then SIGKILL. Baked into the container at
 * creation (`--stop-timeout`) AND used by stopContainer(), so a run stopped by
 * the hub and a run stopped by `docker stop` from a shell get the same grace.
 */
export const STOP_TIMEOUT_SEC = 30

/**
 * The Docker CLI intercepts exactly one thing on the input side: its detach
 * sequence. The default is `Ctrl-P Ctrl-Q`, and a bare Ctrl-P is held back
 * until the next key — which is a TUI's "previous" in every one of the four
 * coding agents. So it is overridden to a chord no TUI uses (§7.1, §8.18).
 */
export const DETACH_KEYS = 'ctrl-^,ctrl-^'

/**
 * What each runtime id means. `runsc` is gVisor, which is not a binary of its
 * own but a runtime REGISTERED with the docker daemon — hence the same CLI plus
 * one flag (§7.7's table, §4.1).
 */
const RUNTIMES = {
  docker: { bin: 'docker', runFlags: [] },
  runsc: { bin: 'docker', runFlags: ['--runtime=runsc'] },
  podman: { bin: 'podman', runFlags: [] },
}

/**
 * Known spec values that are NOT container runtimes. `srt` is Anthropic's
 * process sandbox (§4.6): the same seam, a weaker boundary, deliberately
 * deferred. It gets its own refusal so an operator who picked it is told that
 * it is not built yet, rather than that they made a typo.
 */
const NOT_IMPLEMENTED = new Set(['srt'])

/** An argv could not be built. Carries the i18n key so the UI can say it too. */
export class SandboxArgvError extends Error {
  constructor(key, params = {}) {
    super(t(key, params))
    this.name = 'SandboxArgvError'
    this.key = key
    this.params = params
  }
}

/**
 * The binary a runtime id is driven through. `FREILAUF_SANDBOX_RUNTIME_BIN`
 * replaces it wholesale — that is the e2e suite's shim, and it has to apply to
 * the PANE COMMAND as much as to the hub's own calls, or the suite would test a
 * command line nobody runs.
 */
export function runtimeBin(runtimeId) {
  const shim = env('SANDBOX_RUNTIME_BIN')
  if (shim) return shim
  return runtimeDef(runtimeId).bin
}

function runtimeDef(runtimeId) {
  const id = String(runtimeId ?? 'docker')
  const def = RUNTIMES[id]
  if (def) return { id, ...def }
  throw new SandboxArgvError(
    NOT_IMPLEMENTED.has(id) ? 'sandbox.runtime.reason_unsupported' : 'sandbox.runtime.reason_unknown',
    { id })
}

// ---------------------------------------------------------------------------
// A. The command line
// ---------------------------------------------------------------------------

/**
 * Is this value a real setting, or the empty string a form produces?
 *
 * `Number('')` is 0 AND finite (AGENTS.md has an entry for it), and one layer
 * out the same trap reads as a configured limit: `--memory 0` is not "no
 * limit", it is a refusal from the daemon, and `--cpus 0` is a container that
 * cannot run. So an empty, null or undefined resource produces NO FLAG AT ALL.
 */
function unset(v) {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '')
}

/** A size-shaped resource (`8g`, `64m`, a byte count). Empty → no flag. */
function sizeArg(flag, v) {
  if (unset(v)) return []
  const s = String(v).trim()
  return [flag, s]
}

/** A numeric resource (`--cpus 4`, `--pids-limit 4096`). Empty or ≤ 0 → no flag. */
function numArg(flag, v) {
  if (unset(v)) return []
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return []
  return [flag, String(n)]
}

/**
 * `$HOME/.cache` in a spec means the container's home, which is the run's home
 * directory at the identical path (§7.7). The spec is a document an operator
 * writes, so it may say `$HOME`, `${HOME}` or `~`.
 */
function expandHome(path, homeDir) {
  const s = String(path ?? '')
  if (!homeDir) return s
  return s
    .replace(/^\$\{HOME\}/, homeDir)
    .replace(/^\$HOME/, homeDir)
    .replace(/^~(?=\/|$)/, homeDir)
}

function absolute(p) {
  return typeof p === 'string' && p.startsWith('/')
}

/** Strip a trailing slash so `/tmp` and `/tmp/` cannot be two different mounts. */
function cleanTarget(p) {
  const s = String(p ?? '').trim()
  return s.length > 1 && s.endsWith('/') ? s.replace(/\/+$/, '') : s
}

/** Does `outer` sit at or above `inner`? Used for the mount-collision rule. */
function coversPath(outer, inner) {
  return outer === inner || inner.startsWith(outer.endsWith('/') ? outer : outer + '/')
}

/**
 * One `-v source:target[:mode]` entry, with the collisions checked against the
 * mounts the hub made for itself.
 *
 * A mount whose target IS one of the hub's own, or sits above one, is refused
 * rather than appended: a run that silently loses its run directory — the place
 * every agent is told to write its report — is the worst kind of bug, because
 * everything above it still reads as a healthy run. A mount INSIDE one of ours
 * is fine and is the ordinary case: worktree extras live under the workdir.
 */
function addMount(args, own, { source, target, mode }, { allowInsideOwn = true } = {}) {
  const src = String(source ?? '').trim()
  const tgt = cleanTarget(target ?? source)
  if (!absolute(src) || !absolute(tgt)) {
    throw new SandboxArgvError('sandbox.runtime.err_mount_path', { source: src || '?', target: tgt || '?' })
  }
  for (const existing of own) {
    if (existing.target === tgt) {
      throw new SandboxArgvError('sandbox.runtime.err_mount_duplicate', { target: tgt })
    }
    if (coversPath(tgt, existing.target)) {
      throw new SandboxArgvError('sandbox.runtime.err_mount_collision', { target: tgt, own: existing.target })
    }
    if (!allowInsideOwn && coversPath(existing.target, tgt)) {
      throw new SandboxArgvError('sandbox.runtime.err_mount_collision', { target: tgt, own: existing.target })
    }
  }
  const ro = String(mode ?? 'rw') === 'ro'
  args.push('-v', ro ? `${src}:${tgt}:ro` : `${src}:${tgt}`)
  own.push({ target: tgt })
}

/**
 * `-e KEY=VALUE` as two argv entries, never as one shell-quoted string. This is
 * an argv: nothing here goes through a shell, so a value containing a space, a
 * quote or a newline needs no escaping and must not get any — a quoted value
 * would arrive in the container WITH the quotes.
 *
 * A null value is skipped rather than passed. `docker run -e KEY` (no `=`) is
 * the documented "take it from MY environment" form, and the hub's environment
 * is the one thing a sandbox exists to keep out.
 */
function addEnv(args, key, value) {
  if (value === null || value === undefined) return
  const k = String(key)
  if (!k || k.includes('=') || /\s/.test(k)) throw new SandboxArgvError('sandbox.runtime.err_env_key', { key: k })
  args.push('-e', `${k}=${String(value)}`)
}

/**
 * The image reference the container is started from. A digest is used whenever
 * one is known, because that is what makes a run reproducible and what the
 * `started` event records (§7.10). A bare tag moves under the operator's feet.
 */
function imageRef(ref, digest) {
  const r = String(ref ?? '').trim()
  if (!r) throw new SandboxArgvError('sandbox.runtime.err_no_image', {})
  if (unset(digest) || r.includes('@')) return r
  const d = String(digest).trim()
  return `${r}@${d.includes(':') ? d : `sha256:${d}`}`
}

/**
 * The pane command of SANDBOX_RESEARCH.md §7.11 — `docker run -it …` — as an
 * argv. Pure: no daemon is asked, nothing is written, the only thing it reads
 * outside its arguments is the one binary seam above.
 *
 * `ctx` is everything the hub resolved for this run:
 *   { runId, hubId, workdir, homeDir, runDir, repoGitDir, emptyFile, hubSocket,
 *     uid, gid, env: {…}, mounts: [{source,target,mode}], image, digest,
 *     cmd: [], network, proxyUrl, caPath, term, binPaths: [] }
 *
 * `spec` is a sandbox profile; it is normalised here so a partial one (a test,
 * a hand-written profile) cannot reach a field that is undefined. normalizeSpec
 * is idempotent, so the ordinary caller — which already resolved and froze the
 * spec into runs.sandbox_spec — pays nothing for the safety.
 */
export function buildRunArgv(spec, ctx = {}) {
  const s = normalizeSpec(spec ?? {})
  const def = runtimeDef(s.runtime)
  const bin = runtimeBin(s.runtime)
  const runId = String(ctx.runId ?? '')
  const workdir = cleanTarget(ctx.workdir ?? '')
  if (!absolute(workdir)) throw new SandboxArgvError('sandbox.runtime.err_no_workdir', {})

  const args = ['run', ...def.runFlags]

  // -it: a TTY in the container, and the pane's stdin relayed into it. This is
  // what makes tmux's send-keys, capture-pane and pipe-pane work unchanged —
  // the pane's process is the CLI, and the byte stream is the container's.
  args.push('-it')
  // --rm removes the container when its client exits. `retention: keep` is the
  // one profile that does not want that: the container is left standing for a
  // `docker exec` post-mortem until the retention clock runs out (§7.11).
  if (s.retention !== 'keep') args.push('--rm')
  // --init puts tini at PID 1. Killing the pane sends SIGHUP to the CLI, which
  // forwards it — but a PID 1 without a handler for that signal never receives
  // it (pid_namespaces(7)), and node installs handlers for SIGTERM/SIGINT and
  // NOT for SIGHUP. Without this the agent survives its own pane (§7.1).
  args.push('--init')

  args.push('--name', containerName(runId))
  // The two labels the orphan reaper filters on: whose hub, and which run
  // (§7.11 "Reconciliation and orphans").
  args.push('--label', `freilauf.run=${runId}`)
  args.push('--label', `freilauf.hub=${String(ctx.hubId ?? '')}`)
  args.push('--detach-keys', DETACH_KEYS)
  args.push('--stop-timeout', String(STOP_TIMEOUT_SEC))

  // The uid question, one line per daemon type (§7.7):
  //   rootful docker  → --user <hub uid>:<hub gid>, so bind-mounted files stay
  //                     owned by the hub user and git does not refuse the repo;
  //   rootless docker → container root IS the hub user on the host, so the
  //                     caller hands NO uid and no flag is written;
  //   podman rootless → --userns=keep-id, podman's own answer to exactly this,
  //                     and --user is dropped because keep-id already maps it.
  if (def.id === 'podman') {
    args.push('--userns=keep-id')
  } else if (!unset(ctx.uid)) {
    args.push('--user', `${ctx.uid}:${unset(ctx.gid) ? ctx.uid : ctx.gid}`)
  }

  const homeDir = ctx.homeDir ? cleanTarget(ctx.homeDir) : null
  addEnv(args, 'HOME', homeDir)
  addEnv(args, 'USER', s.user)

  // The hardening set. --cap-drop ALL because an agent needs no capability the
  // kernel hands a container by default, and no-new-privileges because a setuid
  // binary inside the image must not be a way back up.
  args.push('--cap-drop', 'ALL')
  args.push('--security-opt', 'no-new-privileges')

  // A read-only root filesystem plus exactly the writable places named in the
  // spec. readOnlyRoot:false drops --read-only and keeps the tmpfs entries —
  // they are what the profile asks for, not a consequence of the flag.
  if (s.filesystem.readOnlyRoot) args.push('--read-only')
  for (const arg of tmpfsArgs(s, homeDir)) args.push(arg)

  const r = s.resources ?? {}
  args.push(...numArg('--pids-limit', r.pidsLimit))
  args.push(...sizeArg('--memory', r.memory))
  args.push(...sizeArg('--memory-swap', r.memorySwap))
  args.push(...numArg('--cpus', r.cpus))
  args.push(...sizeArg('--shm-size', r.shmSize))
  // resources.maxRuntimeMinutes is deliberately NOT a flag: no runtime has one.
  // It is the hub's clock and ends in a `docker stop` (§8.16).

  // The three network modes (§7.5.1). `open` writes no --network at all: that
  // IS the default bridge, and naming it would be a second way of saying the
  // same thing.
  const mode = s.network?.mode ?? 'allowlist'
  const proxied = mode === 'allowlist'
  if (mode === 'none') {
    args.push('--network', 'none')
  } else if (proxied) {
    args.push('--network', ctx.network || networkName(runId))
  }

  // Proxy and CA reach the agent ONLY under `allowlist`. Under `open` there is
  // nothing to proxy through, and under `none` there is nothing to reach — a
  // variable pointing at a proxy that is not there turns every request into a
  // connection error instead of the honest "no network".
  if (proxied) {
    const proxyUrl = ctx.proxyUrl || `http://${proxyName(runId)}:8080`
    for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY']) addEnv(args, key, proxyUrl)
    // The lowercase spellings as well, because a good deal of the toolchain a
    // repo brings (curl, python-requests, older go tools) reads only those, and
    // a tool that ignores the proxy on an internal network does not leak — it
    // fails, which is a support question nobody can answer from the outside.
    for (const key of ['https_proxy', 'http_proxy', 'all_proxy']) addEnv(args, key, proxyUrl)
    // Empty on purpose (§7.5.1): nothing is exempted from the proxy. Written
    // out rather than omitted so an image that bakes a NO_PROXY cannot punch a
    // hole in the policy.
    addEnv(args, 'NO_PROXY', '')
    addEnv(args, 'no_proxy', '')
    if (ctx.caPath) {
      // The hermes list plus git (§7.5.2). One CA file, five names, because
      // every runtime in the image looks for it under a different one.
      for (const key of ['SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE',
        'CURL_CA_BUNDLE', 'GIT_SSL_CAINFO']) addEnv(args, key, CA_TARGET)
    }
  }

  // The terminal (§8.17). TERM comes from the tmux pane, so the agent's TUI
  // draws the same way it draws outside a container; the locale is the image's.
  addEnv(args, 'TERM', ctx.term || 'xterm-256color')
  addEnv(args, 'LANG', 'C.UTF-8')
  addEnv(args, 'LC_ALL', 'C.UTF-8')
  addEnv(args, 'COLORTERM', 'truecolor')

  // Everything else the caller resolved: FL_RUN_ID, FL_RUN_TOKEN,
  // FL_HUB_SOCKET, the harness's and the provider's own variables, and the
  // telemetry switches the plugins declare (§7.5.4). Deliberately none of them
  // are named here — a vendor's variable belongs in that vendor's plugin.
  for (const [key, value] of Object.entries(ctx.env ?? {})) addEnv(args, key, value)

  // ---- mounts, in the order of §7.11 -------------------------------------
  const own = []
  const fs = s.filesystem ?? {}
  addMount(args, own, { source: ctx.workdir, target: workdir, mode: fs.worktree ?? 'rw' })
  if (ctx.repoGitDir) {
    // The operator's own .git, read-only: it is what the run fetches from, and
    // it is not the run's to change.
    addMount(args, own, { source: ctx.repoGitDir, target: ctx.repoGitDir, mode: fs.repoGit ?? 'ro' })
    if (ctx.emptyFile) {
      // A MINIMAL replacement over `<repo .git>/config` — never an empty file.
      // The config carries the operator's remotes, hooksPath and credential
      // helpers, and the run gets its remotes from its own clone, so masking is
      // cheaper and more honest than sanitising. But an EMPTY file does not mask
      // the config, it changes what the repository IS: on a sha256 repo `git log`
      // then reports "your current branch appears to be broken" and `ls-remote`
      // answers an all-zero sha with exit 0 (measured, §11a.2) — a wrong answer
      // that looks like a right one, the `--no-optional-locks` trap again.
      // `writeMaskedGitConfig()` in clone.mjs generates this file: it keeps
      // `core.repositoryformatversion` and `[extensions]` and drops everything
      // that names a command or carries a token.
      addMount(args, own, {
        source: ctx.emptyFile,
        target: `${cleanTarget(ctx.repoGitDir)}/config`,
        mode: 'ro',
      })
    }
  }
  if (ctx.runDir) addMount(args, own, { source: ctx.runDir, target: ctx.runDir, mode: 'rw' })
  if (homeDir) addMount(args, own, { source: ctx.homeDir, target: homeDir, mode: 'rw' })
  if (ctx.hubSocket) addMount(args, own, { source: ctx.hubSocket, target: HUB_SOCKET_TARGET, mode: 'rw' })
  // fl-report and its shared path helper, read-only at the identical path:
  // that is the whole hub↔agent channel from the agent's side.
  for (const p of ctx.binPaths ?? []) addMount(args, own, { source: p, target: p, mode: 'ro' })
  if (ctx.caPath) addMount(args, own, { source: ctx.caPath, target: CA_TARGET, mode: 'ro' })

  // What the caller resolved (worktree extras at their identical paths), then
  // what the operator wrote into the profile. Both go through the same
  // collision check, and both keep their own mode verbatim.
  for (const m of ctx.mounts ?? []) {
    addMount(args, own, { source: m.source, target: m.target ?? m.source, mode: m.mode ?? fs.extras ?? 'ro' })
  }
  for (const m of fs.extraMounts ?? []) {
    addMount(args, own, { source: m.source, target: m.target ?? m.source, mode: m.mode ?? 'ro' })
  }

  args.push('-w', workdir)
  args.push(imageRef(ctx.image ?? s.image?.ref, ctx.digest ?? s.image?.digest))
  for (const c of ctx.cmd ?? []) args.push(String(c))

  return { bin, args }
}

/**
 * The `--tmpfs` entries. Every writable place a read-only root still needs, and
 * nothing else. `/run` is derived rather than configured: it is what a
 * read-only root makes necessary (and where the hub socket's mount point sits),
 * so it appears exactly when --read-only does and only when the profile has not
 * named it itself.
 *
 * Sizes come from `filesystem.tmpfsSizes`; `resources.diskTmpfs` fills in for
 * an entry that names no size of its own. Two statements about one number is
 * one too many — tmpfsSizes is the specific one, so it wins.
 */
function tmpfsArgs(spec, homeDir) {
  const out = []
  const sizes = { ...(spec.filesystem?.tmpfsSizes ?? {}) }
  const fallback = spec.resources?.diskTmpfs
  const entries = Object.entries(sizes).map(([path, size]) => ({ path: cleanTarget(expandHome(path, homeDir)), size }))
  if (spec.filesystem?.readOnlyRoot && !entries.some(e => e.path === '/run')) {
    entries.push({ path: '/run', size: '64m', noexec: true })
  }
  for (const e of entries) {
    if (!absolute(e.path)) continue     // a tmpfs path that did not expand is not a mount point
    // nosuid always: nothing in a scratch directory should ever gain a uid.
    // NOT noexec on /tmp — `npm ci`, `pip install` and every build script in
    // the world execute out of it, and a noexec /tmp fails them in a way that
    // reads as a broken toolchain rather than as a policy.
    const opts = ['rw', e.noexec ? 'noexec' : null, 'nosuid'].filter(Boolean)
    const size = unset(e.size) ? fallback : e.size
    if (!unset(size)) opts.push(`size=${String(size).trim()}`)
    out.push('--tmpfs', `${e.path}:${opts.join(',')}`)
  }
  return out
}

/**
 * The run's egress proxy as a container (§7.5.2), or null when this run has
 * none: `open`/`none` have nothing to proxy, and the `builtin` engine is a
 * listener inside the hub process — a container for it would be a second
 * implementation of the same policy.
 *
 * `ctx`: { runId, hubId, network, configPath, caPath, image, digest, env }.
 * The proxy is started FIRST and needs both networks; this argv puts it on the
 * internal one, and the caller connects the bridge afterwards with
 * buildNetworkConnectArgv() — a container is created on one network, and the
 * second is a call of its own.
 */
export function buildProxyArgv(spec, ctx = {}) {
  const s = normalizeSpec(spec ?? {})
  if ((s.network?.mode ?? 'allowlist') !== 'allowlist') return null
  if ((s.network?.engine ?? 'builtin') !== 'iron-proxy') return null
  const def = runtimeDef(s.runtime)
  const bin = runtimeBin(s.runtime)
  const runId = String(ctx.runId ?? '')

  const args = ['run', ...def.runFlags, '-d', '--init']
  args.push('--name', proxyName(runId))
  args.push('--label', `freilauf.run=${runId}`)
  args.push('--label', `freilauf.hub=${String(ctx.hubId ?? '')}`)
  args.push('--label', 'freilauf.role=proxy')
  args.push('--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only')
  args.push('--network', ctx.network || networkName(runId))
  // The proxy holds the run's real credentials under `secrets.mode: inject`
  // (§7.8), so it gets the same resource fence as the agent — a proxy that can
  // be starved is a run that stalls.
  args.push(...numArg('--pids-limit', 256))
  args.push(...sizeArg('--memory', '512m'))
  for (const [key, value] of Object.entries(ctx.env ?? {})) addEnv(args, key, value)

  const own = []
  if (ctx.configPath) addMount(args, own, { source: ctx.configPath, target: '/etc/freilauf/proxy.yaml', mode: 'ro' })
  if (ctx.caPath) addMount(args, own, { source: ctx.caPath, target: CA_TARGET, mode: 'ro' })

  args.push(imageRef(ctx.image, ctx.digest))
  for (const c of ctx.cmd ?? []) args.push(String(c))
  return { bin, args }
}

/** `docker network connect <network> <container>` — the proxy's second leg. */
export function buildNetworkConnectArgv(network, name, { runtime = 'docker' } = {}) {
  return { bin: runtimeBin(runtime), args: ['network', 'connect', String(network), String(name)] }
}

// ---------------------------------------------------------------------------
// B. The three answers
// ---------------------------------------------------------------------------

/**
 * The daemon is not there, demonstrably. [documented] — this is the Docker
 * CLI's own sentence when the socket does not answer, quoted in Docker's
 * troubleshooting documentation; the podman half is [inferred] from the same
 * shape and is written broadly enough to catch its wording either way.
 *
 * Everything NOT matched here is `unreachable`, which is the safe answer: a
 * classifier that guesses "there is nothing" from an error it does not know
 * would end healthy runs the first time a vendor rewords a message. This is
 * tmuxVerdict()'s rule, and it is written down in AGENTS.md because it cost
 * this hub a working agent once already.
 */
const NO_DAEMON_RE = new RegExp([
  'cannot connect to the docker daemon',            // [documented] docker CLI
  'is the docker daemon running',                   // [documented] docker CLI, same message
  'docker daemon is not running',                   // [inferred] Docker Desktop wording
  'cannot connect to podman',                       // [inferred] podman CLI
  'unable to connect to podman',                    // [inferred] podman CLI
  'the docker daemon may not be running',           // [inferred]
].join('|'), 'i')

/**
 * Not "the daemon is down" but "the daemon answered, and there is no such
 * thing". [documented] — `docker inspect` answers `Error: No such object: x`,
 * `docker stop` answers `Error response from daemon: No such container: x`,
 * `docker network rm` answers `network x not found`. It is a separate question
 * from the verdict precisely because the exit code is the same 1: a caller that
 * read it as `unreachable` would wait for ever for a container that will never
 * exist again.
 */
const NOT_FOUND_RE = /no such (object|container|image|network)|network .* not found|container .* not found|no container with name/i

export function notFound(result) {
  if (result?.ok) return false
  return NOT_FOUND_RE.test(String(result?.stderr ?? '') + String(result?.stdout ?? ''))
}

/** [documented] `docker network create` on a name that is already there. */
const ALREADY_EXISTS_RE = /already exists|network with name .* already exists/i

/**
 * The three answers, and only the first two may be acted on:
 *
 *   'ok'          the command answered; its output is the truth.
 *   'no_daemon'   there is demonstrably no daemon, so there are no containers.
 *                 The empty truth.
 *   'unreachable' the hub learned NOTHING — a timeout, a fork that failed, a
 *                 missing binary, a socket in a broken state, a daemon still
 *                 booting after a reboot (§7.11). Do nothing, ask again next
 *                 pass; never end a run on this.
 *
 * A missing binary lands in `unreachable` on purpose, exactly as it does in
 * tmuxVerdict(): a PATH that lost an entry is not proof that Docker is gone.
 * Whether a runtime exists at all is runtimeInfo()'s question, asked once.
 */
export function runtimeVerdict(result) {
  if (result?.ok) return 'ok'
  const text = String(result?.stderr ?? '') + String(result?.stdout ?? '')
  return NO_DAEMON_RE.test(text) ? 'no_daemon' : 'unreachable'
}

/** One call, with the verdict attached. Never throws — sh() resolves on error. */
async function call(runtimeId, args, opts = {}) {
  let bin
  try {
    bin = runtimeBin(runtimeId)
  } catch (err) {
    // An unknown runtime id is a configuration answer, not a daemon answer.
    return { ok: false, code: 1, stdout: '', stderr: err.message, verdict: 'unreachable', bin: null }
  }
  const r = await sh(bin, args, { timeout: opts.timeout ?? 30_000 })
  return { ...r, bin, verdict: runtimeVerdict(r) }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

// The settings page, every run form and the launch path all ask this, so it is
// cached like usage.mjs and balances.mjs — and for the same reason: `docker
// info` talks to a daemon, and nothing on a page render may wait on that twice.
// The empty string first, then Number(): `Number('')` is 0 and finite, and a
// zero-millisecond TTL would mean `docker info` on every page render.
const INFO_CACHE_MS = unset(env('SANDBOX_INFO_CACHE_MS')) ? 60_000 : Number(env('SANDBOX_INFO_CACHE_MS'))
let infoCache = new Map()      // key → { at, value }
let infoFlight = new Map()     // key → promise

/** Test hook, and what the settings page's "scan again" button clears. */
export function _runtimeInfoCacheReset() { infoCache = new Map(); infoFlight = new Map() }

/**
 * Why the answer is what it is — as **dotted i18n keys**, never bare words.
 *
 * `reasonText()` on the settings page prints an undotted string VERBATIM, so a
 * reason of `no_binary` reached the operator as the literal word `no_binary` —
 * on the one line they read at exactly the moment they are trying to work out
 * what to install. The sentences behind these keys therefore say what to DO,
 * not only what is wrong.
 *
 * They carry **no placeholders**, and that is a constraint rather than a style:
 * `reasonText()` calls `t(key)` with no params, so a `{bin}` in one of them
 * would be rendered as the four characters `{bin}`. Where a parameterised
 * sentence is wanted — the build's own refusal — this module builds it itself
 * out of the `sandbox.runtime.*` family instead.
 *
 * The `sandbox.reason.*` family is shared with the launch path, which owns
 * `not_scanned`, `switched_off`, `no_runtime_module`, `hub_off` and
 * `harness_unsupported`. These five are this module's own.
 */
const REASON = {
  ok: 'sandbox.reason.ok',
  no_binary: 'sandbox.reason.no_binary',
  no_daemon: 'sandbox.reason.no_daemon',
  unreachable: 'sandbox.reason.unreachable',
  unknown_runtime: 'sandbox.reason.unknown_runtime',
  unsupported_runtime: 'sandbox.reason.unsupported_runtime',
}

/**
 * What this machine can actually drive. Never throws; on a machine without a
 * container runtime the answer is `{ available: false, reason: 'no_binary' }`
 * and every caller behaves as it does today.
 *
 * `reason` is a machine token, not a sentence: the page renders
 * `sandbox.runtime.reason_<token>` through t(), the way an anomaly kind is
 * rendered. A sentence in the data would be a sentence in one language.
 */
export async function runtimeInfo(runtimeId = null, { force = false } = {}) {
  const id = String(runtimeId ?? 'docker')
  let bin
  try {
    bin = runtimeBin(id)
  } catch (err) {
    return {
      available: false, id, bin: null, version: null, rootless: null,
      runtimes: [], cgroup: {}, userns: {},
      reason: err.key === 'sandbox.runtime.reason_unsupported'
        ? REASON.unsupported_runtime : REASON.unknown_runtime,
      message: err.message,
    }
  }
  // Keyed on what the answer is ABOUT, not only on time: pointing the shim at
  // another binary does not make the cached answer old, it makes it about
  // something else (usage.mjs has the same second key, for the same reason).
  const key = `${id}|${bin}`
  const hit = infoCache.get(key)
  if (!force && hit && Date.now() - hit.at < INFO_CACHE_MS) return hit.value
  const running = infoFlight.get(key)
  if (running) {
    if (!force && hit) return hit.value      // stale-while-revalidate
    return running
  }
  const task = (async () => {
    const value = await probeRuntime(id, bin)
    infoCache.set(key, { at: Date.now(), value })
    return value
  })()
  infoFlight.set(key, task)
  // The release hangs on the PROMISE and not on the end of the body. With no
  // runtime at all this function has barely an await, so a reset written after
  // the assignment would run BEFORE it — and every later caller would be handed
  // one stale promise for the life of the process. AGENTS.md has the entry;
  // this is the same handful of lines.
  const release = () => { if (infoFlight.get(key) === task) infoFlight.delete(key) }
  task.then(release, release)
  if (!force && hit) return hit.value
  return task
}

async function probeRuntime(id, bin) {
  const base = {
    available: false, id, bin, version: null, rootless: null,
    runtimes: [], cgroup: cgroupFacts(), userns: usernsFacts(), reason: REASON.unreachable, message: null,
  }
  // `info --format {{json .}}` is one call for everything the settings page
  // wants, and it is the call that fails when the daemon is down — which is
  // exactly the question. Parsing defensively: a field a future release renames
  // must cost that one field, never the answer.
  const r = await call(id, ['info', '--format', '{{json .}}'], { timeout: 15_000 })
  if (r.verdict === 'no_daemon') return { ...base, reason: REASON.no_daemon, message: (r.stderr || '').trim() || null }
  if (!r.ok) {
    const missing = r.code === 'ENOENT' || /ENOENT|not found/i.test(String(r.stderr ?? ''))
    return { ...base, reason: missing ? REASON.no_binary : REASON.unreachable, message: (r.stderr || '').trim() || null }
  }
  let info = null
  try { info = JSON.parse(r.stdout) } catch { info = null }
  if (!info || typeof info !== 'object') {
    // The daemon answered and we could not read it. That is not "no daemon".
    return { ...base, reason: REASON.unreachable, message: 'could not parse info output' }
  }
  return {
    ...base,
    available: true,
    reason: REASON.ok,
    version: versionFrom(info),
    rootless: rootlessFrom(info),
    runtimes: runtimesFrom(info),
    message: null,
  }
}

/** docker: `ServerVersion`. podman: `version.Version`. [documented for both] */
function versionFrom(info) {
  const v = info.ServerVersion ?? info.version?.Version ?? info.Version ?? null
  return v ? String(v) : null
}

/**
 * docker: `SecurityOptions` is a list of strings and carries `name=rootless`
 * when the daemon runs rootless [documented]. podman: `host.security.rootless`
 * is a boolean [documented]. Anything else answers null — "not known" is a
 * third answer, and the uid rule of §7.7 branches on it.
 */
function rootlessFrom(info) {
  if (typeof info.host?.security?.rootless === 'boolean') return info.host.security.rootless
  const opts = info.SecurityOptions
  if (Array.isArray(opts)) return opts.some(o => /rootless/i.test(String(o)))
  return null
}

/**
 * Which OCI runtimes the daemon knows — the question behind `runtime: runsc`.
 * docker: `Runtimes` is an object keyed by name [documented]. podman names its
 * single one under `host.ociRuntime.name` [documented].
 */
function runtimesFrom(info) {
  if (info.Runtimes && typeof info.Runtimes === 'object') return Object.keys(info.Runtimes).sort()
  const name = info.host?.ociRuntime?.name
  return name ? [String(name)] : []
}

/**
 * The cgroup controllers this USER has been delegated. Rootless Docker needs
 * `memory` and `pids` here or `--memory`/`--pids-limit` are silently ignored —
 * a resource fence that is not enforced is worse than none, because the
 * settings page says it is on. Read from the file rather than asked of the
 * daemon: it is the user's delegation, not the daemon's opinion.
 */
function cgroupFacts() {
  const out = { controllers: [], delegated: null, path: null }
  try {
    const uid = typeof process.getuid === 'function' ? process.getuid() : null
    if (uid === null) return out
    const path = `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/cgroup.controllers`
    out.path = path
    if (!existsSync(path)) return out
    out.controllers = readFileSync(path, 'utf8').trim().split(/\s+/).filter(Boolean)
    out.delegated = out.controllers.includes('memory') && out.controllers.includes('pids')
  } catch { /* a sysfs that does not answer is simply no information */ }
  return out
}

/**
 * The user-namespace switches a rootless daemon and every bwrap-based inner
 * sandbox depend on (§8.11). Ubuntu 24.04 restricts unprivileged user
 * namespaces through AppArmor; older kernels through the clone sysctl. Both are
 * read where they exist and reported as they stand — the hub never runs sudo,
 * so this is information for the setup guide and nothing else.
 */
function usernsFacts() {
  const out = {}
  for (const [key, path] of [
    ['unprivilegedUsernsClone', '/proc/sys/kernel/unprivileged_userns_clone'],
    ['apparmorRestrictUserns', '/proc/sys/kernel/apparmor_restrict_unprivileged_userns'],
  ]) {
    try {
      if (!existsSync(path)) continue
      const raw = readFileSync(path, 'utf8').trim()
      out[key] = raw === '' ? null : Number(raw)
    } catch { /* unreadable is the same as absent for this purpose */ }
  }
  return out
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * What the daemon says about one container.
 *
 * `exists` is tri-state on purpose: `false` means the daemon answered and there
 * is no such container, `null` means nobody answered. Only the first may end a
 * run — the second is the daemon-restart case the whole verdict exists for.
 */
export async function containerState(name, { runtime = 'docker' } = {}) {
  const r = await call(runtime, ['inspect', '--format',
    '{{.State.Running}}\t{{.State.ExitCode}}\t{{.State.OOMKilled}}\t{{.State.Status}}', String(name)])
  // "No such object" is an ANSWER, not a failure to answer — asked before the
  // verdict, because both come back with exit code 1.
  if (notFound(r)) return { verdict: 'ok', exists: false, running: false, exitCode: null, oom: false, status: null }
  if (r.verdict !== 'ok') {
    return { verdict: r.verdict, exists: null, running: null, exitCode: null, oom: null, status: null,
      reason: (r.stderr || '').trim() || null }
  }
  const f = String(r.stdout ?? '').trim().split('\t')
  const exitCode = Number(f[1])
  return {
    verdict: 'ok',
    exists: true,
    running: f[0] === 'true',
    exitCode: Number.isFinite(exitCode) ? exitCode : null,
    oom: f[2] === 'true',
    status: f[3] || null,
  }
}

/**
 * SIGTERM, then STOP_TIMEOUT_SEC, then SIGKILL. Stopping a container that is
 * already gone is a success: this runs on the kill route, on the sessions page
 * and in the retention pass, and every one of them may arrive second.
 */
export async function stopContainer(name, { runtime = 'docker', timeoutSec = STOP_TIMEOUT_SEC } = {}) {
  const r = await call(runtime, ['stop', '-t', String(timeoutSec), String(name)],
    { timeout: (Number(timeoutSec) + 15) * 1000 })
  if (notFound(r)) return { verdict: 'ok', ok: true, gone: true }
  return { verdict: r.verdict, ok: r.ok, gone: false, reason: r.ok ? null : (r.stderr || '').trim() || null }
}

/** Idempotent like stopContainer: `--rm` may already have taken it away. */
export async function removeContainer(name, { runtime = 'docker', force = false } = {}) {
  const args = ['rm']
  if (force) args.push('-f')
  args.push(String(name))
  const r = await call(runtime, args)
  if (notFound(r)) return { verdict: 'ok', ok: true, gone: true }
  return { verdict: r.verdict, ok: r.ok, gone: false, reason: r.ok ? null : (r.stderr || '').trim() || null }
}

/**
 * The per-run internal network (§7.5.1): no default route, and on Docker ≥ 28
 * no host address on the bridge either, so the host itself is unreachable from
 * the container.
 *
 * That driver option is refused by older engines, and a network is not
 * something a run can do without — so a rejection of the OPTION is retried
 * once without it rather than failing the launch. Creating a network that is
 * already there is a success: a resume walks this same path (§7.11).
 */
export async function createNetwork(name, { runtime = 'docker', internal = true, isolated = true } = {}) {
  const build = (withOption) => {
    const args = ['network', 'create']
    if (internal) args.push('--internal')
    if (withOption) args.push('-o', 'com.docker.network.bridge.gateway_mode_ipv4=isolated')
    args.push(String(name))
    return args
  }
  let r = await call(runtime, build(!!isolated))
  if (!r.ok && isolated && !notFound(r) && /gateway_mode|unknown option|invalid option|not supported|unsupported/i.test(String(r.stderr ?? ''))) {
    r = await call(runtime, build(false))
  }
  if (!r.ok && ALREADY_EXISTS_RE.test(String(r.stderr ?? ''))) return { verdict: 'ok', ok: true, existed: true }
  return { verdict: r.verdict, ok: r.ok, existed: false, reason: r.ok ? null : (r.stderr || '').trim() || null }
}

/** Idempotent: a network the daemon has already forgotten is a success. */
export async function removeNetwork(name, { runtime = 'docker' } = {}) {
  const r = await call(runtime, ['network', 'rm', String(name)])
  if (notFound(r)) return { verdict: 'ok', ok: true, gone: true }
  return { verdict: r.verdict, ok: r.ok, gone: false, reason: r.ok ? null : (r.stderr || '').trim() || null }
}

/**
 * Raise or lower a running container's fence — the live half of a policy
 * change (§7.12): memory, swap, cpus and the pid ceiling can be changed without
 * restarting the agent, and everything else cannot.
 *
 * Empty fields produce no flag, the same rule as at creation and through the
 * same two helpers — one of them reading `''` as a configured 0 would set a
 * running agent's memory limit to zero.
 */
export async function updateLimits(name, limits = {}, { runtime = 'docker' } = {}) {
  const args = ['update']
  args.push(...sizeArg('--memory', limits.memory))
  args.push(...sizeArg('--memory-swap', limits.memorySwap))
  args.push(...numArg('--cpus', limits.cpus))
  args.push(...numArg('--pids-limit', limits.pidsLimit))
  if (args.length === 1) return { verdict: 'ok', ok: true, changed: false }
  args.push(String(name))
  const r = await call(runtime, args)
  if (notFound(r)) return { verdict: 'ok', ok: false, changed: false, gone: true }
  return { verdict: r.verdict, ok: r.ok, changed: r.ok, reason: r.ok ? null : (r.stderr || '').trim() || null }
}

const UNITS = {
  b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12,
  kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4,
}

/**
 * `docker stats --no-stream --format '{{.MemUsage}} {{.CPUPerc}}'` prints
 * `1.234GiB / 8GiB 12.34%`. Pure and exported so the parsing is tested without
 * a daemon — the sessions page reads this for a sandboxed run instead of
 * walking a process tree that lives in another namespace (§7.11).
 */
export function parseStats(text) {
  const s = String(text ?? '').trim()
  if (!s) return null
  const mem = s.match(/([\d.]+)\s*(B|kB|MB|GB|TB|KiB|MiB|GiB|TiB)\b/i)
  const cpu = s.match(/([\d.]+)\s*%/)
  if (!mem && !cpu) return null
  const value = mem ? Number(mem[1]) : NaN
  const unit = mem ? UNITS[mem[2].toLowerCase()] : null
  const pct = cpu ? Number(cpu[1]) : NaN
  return {
    memBytes: Number.isFinite(value) && unit ? Math.round(value * unit) : null,
    cpuPct: Number.isFinite(pct) ? pct : null,
  }
}

/** Live resources of one container, or null when the daemon did not say. */
export async function containerStats(name, { runtime = 'docker' } = {}) {
  const r = await call(runtime, ['stats', '--no-stream', '--format', '{{.MemUsage}} {{.CPUPerc}}', String(name)],
    { timeout: 10_000 })
  if (!r.ok) return null
  return parseStats(r.stdout)
}

/**
 * Run another process inside the container — git for the finish gate, a health
 * probe, a cleanup. Deliberately NOT the way anything is typed into the agent's
 * TUI: that is the pane, and there is no API to signal an exec'd process
 * (§7.1(b)).
 */
export async function execIn(name, argv, { runtime = 'docker', user = null, cwd = null, timeout = 60_000 } = {}) {
  const args = ['exec']
  if (user) args.push('-u', String(user))
  if (cwd) args.push('-w', String(cwd))
  args.push(String(name), ...(argv ?? []).map(String))
  const r = await call(runtime, args, { timeout })
  if (notFound(r)) return { ...r, verdict: 'ok', gone: true }
  return { ...r, gone: false }
}

/**
 * `docker ps -a --filter label=freilauf.hub=<id>` → one row per container this
 * hub owns. Pure parser, exported for the same reason parseSessions() is.
 *
 * The run id comes out of the NAME rather than out of a label, because a label
 * whose key contains dots cannot be read back through a Go template portably —
 * and the name is the hub's own and carries the same information.
 */
export function parseOwned(text) {
  const out = []
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue
    const f = line.split('\t')
    const name = f[0]
    if (!name) continue
    const proxy = name.startsWith('fl-proxy-')
    const runId = proxy ? name.slice('fl-proxy-'.length) : (name.startsWith('fl-') ? name.slice(3) : null)
    out.push({
      name,
      runId: runId || null,
      kind: proxy ? 'proxy' : 'agent',
      state: f[1] || null,
      running: String(f[1] ?? '').toLowerCase() === 'running',
      status: f.slice(2).join('\t') || null,
    })
  }
  return out
}

/**
 * Every container of THIS hub, with the verdict attached.
 *
 * `verdict: 'unreachable'` comes back with an empty list, and the caller must
 * treat that as "I do not know", never as "there are none": the reconciliation
 * pass would otherwise stop and remove nothing at all — or worse, mark every
 * sandboxed run's container gone — the first time the daemon is busy (§8.1).
 */
export async function listOwned(hubId, { runtime = 'docker' } = {}) {
  const r = await call(runtime, ['ps', '-a', '--filter', `label=freilauf.hub=${String(hubId ?? '')}`,
    '--format', '{{.Names}}\t{{.State}}\t{{.Status}}'])
  if (r.verdict !== 'ok') {
    return { verdict: r.verdict, containers: [], reason: (r.stderr || '').trim() || null }
  }
  return { verdict: 'ok', containers: parseOwned(r.stdout), reason: null }
}

// ---------------------------------------------------------------------------
// Images (§7.10)
// ---------------------------------------------------------------------------
//
// The image is what pins the CLI — a sandboxed run never updates itself, and
// the digest it ran with is written into `runs.sandbox_spec.image.digest` and
// into the `started` event. That is the whole provenance story, so the build
// has to be reachable from the settings page rather than being a command in a
// README that somebody may or may not have run.
//
// NOTE, and it is not a formality: **these images have never been built.** This
// machine has no container runtime. What is written here is the argv and its
// refusals; whether the four installers inside the Dockerfiles work is what the
// first operator's build finds out. `sandbox/images/README.md` carries the same
// commands for a human, and the two are kept byte-comparable on purpose — a
// hub that builds something other than what the README tells an operator to
// build is how somebody ends up debugging the wrong image.

/** The base everything else is `FROM`. Its tag is the distribution it pins. */
const BASE_IMAGE = { name: 'base', dockerfile: 'sandbox/images/base.Dockerfile', version: '24.04' }

/** The checkout this module lives in — never the process's cwd (AGENTS.md). */
function appDir() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..')
}

/**
 * What to build for one image name, out of the plugin that owns it.
 *
 * The **plugin is the authority** for a harness image: `sandbox.image` carries
 * the Dockerfile and the build args, and the Dockerfile's own `ARG` defaults
 * are kept equal to them so an image and its declaration cannot say different
 * things. The version in the tag is therefore not a second constant — it is
 * read out of the `*_VERSION` build arg the plugin declares (the naming rule
 * the README states, which is what lets the hub build these files without a
 * translation table). `HERMES_COMMIT` and friends are pins, not versions.
 */
async function imageRecipe(name, { registry } = {}) {
  const id = String(name ?? '').trim()
  if (id === BASE_IMAGE.name) {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 1000
    const gid = typeof process.getgid === 'function' ? process.getgid() : 1000
    // The base is the ONLY one built with the uid: the harness layers are FROM
    // it and inherit the user, which is also why the README's harness commands
    // pass no UID/GID either (§7.7, and the README's "The uid question").
    return {
      ok: true,
      dockerfile: BASE_IMAGE.dockerfile,
      args: { UID: String(uid), GID: String(gid) },
      tag: taggedImage('base', BASE_IMAGE.version, registry),
    }
  }
  // Lazily, and by name: a static import of the registry here would close the
  // ring the AGENTS.md entry about claude.mjs → quota.mjs describes, and this
  // function is async anyway.
  let plugin = null
  try {
    const { getHarness } = await import('../harnesses/index.mjs')
    plugin = getHarness(id)
  } catch { plugin = null }
  const decl = plugin?.sandbox?.image
  if (!decl?.dockerfile) return { ok: false, reason: 'unknown_image' }
  const args = { ...(decl.args ?? {}) }
  const versionKey = Object.keys(args).find(k => k.endsWith('_VERSION'))
  const version = versionKey ? String(args[versionKey]) : 'latest'
  return { ok: true, dockerfile: decl.dockerfile, args, tag: taggedImage(id, version, registry) }
}

/**
 * `freilauf/agent-<name>:<version>`, with the operator's registry in front when
 * they configured one (`sandbox_image_registry`). Exported because the settings
 * page and the launch path both need to name the same image.
 */
export function taggedImage(name, version, registry = null) {
  const repo = `freilauf/agent-${name}`
  const prefix = registry ? String(registry).replace(/\/+$/, '') + '/' : ''
  return `${prefix}${repo}:${version}`
}

/**
 * The build argv, pure and unit-tested — the same shape the pure builders above
 * have, and for the same reason: it is the half that can be checked without a
 * daemon. Paths are absolute because the hub's working directory is a courtesy
 * and not a promise; the command is otherwise the README's, flag for flag.
 */
export function buildImageArgv(recipe, { runtime = 'docker', pull = 'if-missing', root = null } = {}) {
  const base = root ?? appDir()
  const args = ['build', '-f', join(base, recipe.dockerfile)]
  // `--pull` only for `always`. `if-missing` IS docker's default, and `never`
  // cannot be enforced at build time — a `FROM` whose image is absent is pulled
  // whatever anybody wanted. Saying so here beats a flag that does nothing.
  if (pull === 'always') args.push('--pull')
  for (const [k, v] of Object.entries(recipe.args ?? {})) {
    if (unset(v)) continue          // an empty build arg would override the Dockerfile's own default with ''
    args.push('--build-arg', `${k}=${v}`)
  }
  args.push('-t', recipe.tag)
  // The build CONTEXT is the images directory, not the checkout: everything
  // these Dockerfiles copy lives there, and a repository-wide context would
  // ship the whole hub to the daemon on every build.
  args.push(join(base, 'sandbox', 'images'))
  return { bin: runtimeBin(runtime), args }
}

/**
 * Build one of the shipped images. Never throws.
 *
 * On failure the **whole build log is kept**, not swallowed: which of the four
 * installers broke is only visible in it (the README's confidence table says
 * hermes is the one to build first, and why). It is written to a file under the
 * data directory and the returned sentence names that path — a page renders one
 * line, and a 400-line build log is not one line.
 *
 * `reason` here is a DISCRIMINATOR a caller branches on, never something shown
 * to anybody — `error` is the sentence, already translated. That is the other
 * half of the rule REASON above states: whatever a page might print is a key.
 */
export async function buildImage(name, { runtime = 'docker', registry = null, pull = 'if-missing', timeout = 30 * 60_000 } = {}) {
  const recipe = await imageRecipe(name, { registry })
  if (!recipe.ok) {
    return { ok: false, reason: 'unknown_image', image: String(name ?? ''), verdict: 'ok',
      error: t('sandbox.runtime.build_unknown_image', { image: String(name ?? '') }) }
  }
  const dockerfile = join(appDir(), recipe.dockerfile)
  if (!existsSync(dockerfile)) {
    return { ok: false, reason: 'no_dockerfile', image: recipe.tag, verdict: 'ok',
      error: t('sandbox.runtime.build_no_dockerfile', { image: String(name), path: dockerfile }) }
  }
  const { bin, args } = buildImageArgv(recipe, { runtime, pull })
  const r = await sh(bin, args, { timeout, maxBuffer: 16 * 1024 * 1024 })
  const verdict = runtimeVerdict(r)
  if (r.ok) {
    // The digest is asked for right away: it is what a spec is pinned with and
    // what the `started` event records, and asking later means asking about an
    // image that may have been rebuilt in between.
    const d = await imageDigest(recipe.tag, { runtime })
    return { ok: true, image: recipe.tag, verdict: 'ok', digest: d.digest, imageId: d.id, log: r.stdout }
  }
  if (verdict !== 'ok') {
    // No daemon, or none that answered. That is not a broken Dockerfile, and
    // saying "the build failed" about it would send the operator to the wrong
    // file entirely.
    return { ok: false, reason: verdict === 'no_daemon' ? 'no_daemon' : 'unreachable', image: recipe.tag, verdict,
      error: t('sandbox.runtime.build_unavailable', {
        image: recipe.tag,
        reason: t(verdict === 'no_daemon' ? 'sandbox.runtime.reason_no_daemon' : 'sandbox.runtime.reason_unreachable', { bin }),
      }) }
  }
  const log = String(r.stdout ?? '') + String(r.stderr ?? '')
  const path = writeBuildLog(name, [`$ ${bin} ${args.join(' ')}`, '', log].join('\n'))
  return {
    ok: false, reason: 'build_failed', image: recipe.tag, verdict: 'ok', log,
    error: t('sandbox.runtime.build_failed', { image: recipe.tag, detail: lastMeaningfulLine(log), log: path ?? '—' }),
  }
}

/** The last line that says something — a build log ends in blank lines and progress noise. */
function lastMeaningfulLine(log) {
  const lines = String(log ?? '').split('\n').map(l => l.trim()).filter(Boolean)
  return lines.length ? lines[lines.length - 1].slice(0, 300) : ''
}

/** Best effort in every direction: a log nobody could write is not a reason to lose the refusal. */
function writeBuildLog(name, text) {
  try {
    const path = join(dataDir(), `sandbox-build-${String(name).replace(/[^\w.-]/g, '_')}.log`)
    writeFileSync(path, text, { mode: 0o600 })
    return path
  } catch { return null }
}

/**
 * The digest of an image, so a spec can be pinned after a build.
 *
 * Two answers, and the difference matters more than it looks. `RepoDigests`
 * exists only for an image that came from (or went to) a registry, and it is
 * the ONLY one `buildRunArgv()` may put after the `@`: a locally built image
 * has an `Id` but no repo digest, and `docker run repo@sha256:<Id>` does not
 * resolve. So `digest` is the pinnable one and is null for a local build, while
 * `id` is always there and is what the `started` event can record as provenance
 * even when nothing was pushed.
 *
 * `{{index .RepoDigests 0}}` on its own is an error on an empty list — hence
 * the `{{if}}`, which is also what the README's own command silently assumes.
 */
export async function imageDigest(ref, { runtime = 'docker' } = {}) {
  const r = await call(runtime, ['image', 'inspect', '--format',
    '{{.Id}}\t{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}', String(ref)])
  if (notFound(r)) return { ok: false, reason: 'no_such_image', verdict: 'ok', digest: null, id: null, repoDigest: null }
  if (r.verdict !== 'ok') {
    return { ok: false, reason: r.verdict, verdict: r.verdict, digest: null, id: null, repoDigest: null,
      error: t('sandbox.runtime.digest_unavailable', {
        image: String(ref),
        reason: t(r.verdict === 'no_daemon' ? 'sandbox.runtime.reason_no_daemon' : 'sandbox.runtime.reason_unreachable',
          { bin: r.bin ?? 'docker' }),
      }) }
  }
  const [id = '', repoDigest = ''] = String(r.stdout ?? '').trim().split('\t')
  const at = repoDigest.lastIndexOf('@')
  return {
    ok: true, verdict: 'ok',
    id: id || null,
    repoDigest: repoDigest || null,
    digest: at > 0 ? repoDigest.slice(at + 1) : null,
  }
}

// ---------------------------------------------------------------------------
// The same argv from a shell
// ---------------------------------------------------------------------------
//
// `sandbox/wrap.sh` is the pane command of a sandboxed run, and a human runs it
// by hand to reproduce what an agent saw. It must produce EXACTLY the command
// line above — a second implementation in bash is the drift run-def.mjs exists
// to prevent, one language further out. So it does not build one: it calls
// `sandbox/runtime-cli.mjs`, which imports buildRunArgv() from this module and
// prints its answer NUL-separated for `mapfile -d ''`.
//
// NUL rather than a JSON array through `jq -r '.[]'`: an argument may contain a
// newline (a `--settings` JSON, a multi-line prompt), and that pipeline would
// split it in two. This module therefore stays a module and grows no entry
// point of its own — two printers with two on-disk formats is the drift again,
// one file further out.
