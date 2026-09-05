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

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, isIP } from 'node:net'
import { homedir } from 'node:os'
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
// `socket: true` says this runtime talks to a DAEMON over a unix socket, which
// is what makes the reachability question below askable at all. podman is
// deliberately false: it is daemonless, so "there is no socket" is not "there
// is no runtime" there, and a precheck would refuse a working installation.
const RUNTIMES = {
  docker: { bin: 'docker', runFlags: [], socket: true, ociRuntime: null },
  // `ociRuntime` is what the daemon has to have REGISTERED for this id to work,
  // and it is the whole difference between `runsc` and `docker`: the binary and
  // the socket are the same, the flag names a runtime the daemon may not know.
  runsc: { bin: 'docker', runFlags: ['--runtime=runsc'], socket: true, ociRuntime: 'runsc' },
  podman: { bin: 'podman', runFlags: [], socket: false, ociRuntime: null },
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
  // The id is validated FIRST, and then the seam replaces the binary. The other
  // order looks equivalent and is not: it made the shim disable the CHECK as
  // well as the binary, so with a seam set `runtimeInfo('nosuch')` probed the
  // shim and came back *available* — an operator's typo in `sandbox_runtime`
  // would then have been caught only on a machine with no seam, which is every
  // machine except the one running the suite. A test fence may replace what the
  // hub CALLS; it may not quietly replace what the hub ACCEPTS.
  const def = runtimeDef(runtimeId)
  const shim = env('SANDBOX_RUNTIME_BIN')
  return shim || def.bin
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
  // The mode is CHECKED, never coerced. `String(mode ?? 'rw') === 'ro'` read
  // everything that was not exactly the two letters `ro` as **writable**, so
  // `'copy'`, `'RO'` and `' ro'` all bind-mounted the operator's `.git`
  // read-write — a fail-open default on the one field that decides whether a
  // sandboxed run can rewrite the repository it was fenced off from. Same
  // family as `Number('')` reading as a configured `0`: a value that arrives as
  // a string is compared against the values that mean something, and anything
  // else is a refusal at launch rather than the loosest reading.
  const modeText = mode === null || mode === undefined ? 'rw' : String(mode)
  if (!MOUNT_MODES.has(modeText)) {
    throw new SandboxArgvError('sandbox.runtime.err_mount_mode', { target: tgt, mode: modeText })
  }
  args.push('-v', modeText === 'ro' ? `${src}:${tgt}:ro` : `${src}:${tgt}`)
  own.push({ target: tgt })
}

/** The only two bind-mount modes a container runtime knows. Everything else is a refusal. */
const MOUNT_MODES = new Set(['ro', 'rw'])

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
  // `ctx.tty === false` is the dry run's seam and nothing else's: `docker run
  // -it` from a process whose stdin is not a terminal answers "the input device
  // is not a TTY" and exits, so a probe container started from the hub (no pane,
  // no tmux) has to ask for the same argv without it.
  if (ctx.tty !== false) args.push('-it')
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
  // `USER` is deliberately NOT written here, and `spec.user` is deliberately not
  // its source. There used to be two authors of that one variable — this line
  // wrote `USER=<spec.user>` (`hub`) and the `ctx.env` loop below wrote
  // `USER=agent` a moment later, with Docker's last-one-wins settling it in
  // silence. `containerEnv()` in index.mjs is the surviving author and its
  // comment says why: `spec.user` is a POLICY word (the answer §7.7's table
  // gives per daemon type, and what actually binds is `--user <uid>:<gid>` from
  // `ctx.uid`), while `USER` is a LOGIN NAME and the only one that exists inside
  // the box is the image's own passwd entry. A caller that hands no `USER` in
  // `ctx.env` now gets none at all — which is what an unconfigured container
  // has anyway, and is not the disagreement the two authors were heading for.

  // The hardening set. --cap-drop ALL because an agent needs no capability the
  // kernel hands a container by default, and no-new-privileges because a setuid
  // binary inside the image must not be a way back up.
  //
  // DELIBERATELY NO `--security-opt apparmor=…`, and not as an omission: under a
  // ROOTLESS daemon there is no AppArmor confinement on containers to name in
  // the first place — the daemon runs unprivileged and cannot load or apply a
  // container profile — so the flag is inert there, and a design that leans on
  // it would be promising a wall that is not built [measured on this host: a
  // rootless daemon, `apparmor: enabled` in runc's feature list and nothing
  // confining the container]. The seccomp profile and the two flags above are
  // what really bind here; the strong AppArmor posture belongs to a rootful
  // installation and would have to be declared per profile, not assumed.
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
    //
    // AND `exec` HAS TO BE NAMED. Docker's `--tmpfs` defaults to `noexec,nodev`,
    // so omitting the word was not the same as allowing it: measured inside a
    // container started from this very argv, `chmod +x /tmp/x && /tmp/x` exited
    // **126** and `/proc/mounts` showed `noexec` — the comment above described
    // an intention the command line did not carry. `--tmpfs '/tmp:rw,exec,…'`
    // is what makes it true [measured 2026-09-05].
    const opts = ['rw', e.noexec ? 'noexec' : 'exec', 'nosuid']
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
  // [measured 2026-09-05, docker 29.8.0] THE VENDOR REWORDED IT. Against a
  // socket that does not exist, docker 29 answers "failed to connect to the
  // docker API at unix:///…; check if the path is correct and if the daemon is
  // running" — which none of the lines above match, so every lifecycle call
  // against a stopped daemon came back `unreachable` instead of `no_daemon`.
  // Safe, because unreachable is the answer that does nothing, but it means the
  // reconciliation pass could never reach the empty truth it is written for.
  'failed to connect to the docker api',
  'if the daemon is running',
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

// ---------------------------------------------------------------------------
// Where the daemon is — the socket, not the CLI
// ---------------------------------------------------------------------------
//
// A `docker` on the PATH is not a daemon, and the difference cost this
// installation two hours: rootful `docker.service` is stopped and disabled here,
// `/var/run/docker.sock` still EXISTS as a file (and connecting to it answers
// `EACCES`, because nobody is in the `docker` group), and the daemon that really
// runs is the rootless one at `$XDG_RUNTIME_DIR/docker.sock` [measured
// 2026-09-05]. So `runtimeInfo()` asks the SOCKET first, and a socket that
// demonstrably refuses is `no_daemon` before a single subprocess is spawned.
//
// Two things follow from the same measurement, and both are about the CHILD's
// environment rather than about ours:
//
//  - `dockerd-rootless-setuptool.sh` created an active docker CONTEXT, and the
//    CLI reads contexts out of `$HOME/.docker`. A child without `HOME` therefore
//    loses the context — and a Node library that never reads contexts at all
//    would fall back to the dead `/var/run/docker.sock`. `runtimeEnv()` ensures
//    `HOME` and, where this module resolved a rootless socket itself, hands the
//    CLI the same `DOCKER_HOST` it resolved, so the hub and the command it runs
//    can never disagree about which daemon they mean.
//  - `/var/run/docker.sock` is deliberately NOT written into `DOCKER_HOST`: it is
//    the CLI's own last resort anyway, and forcing it would override a working
//    context with the dead socket — the exact failure this section exists to end.

/** The one place the endpoint seams are named. See the two test fences below. */
const ENDPOINT_SEAM = 'SANDBOX_DOCKER_HOST'
const FORCE_SEAM = 'SANDBOX_RUNTIME_FORCE'

/** How long a socket may take to answer before "I do not know" is the answer. */
const SOCKET_TIMEOUT_MS = 1500

/**
 * Where this runtime's daemon is, resolved WITHOUT talking to anybody:
 *
 *   1. `FREILAUF_SANDBOX_DOCKER_HOST` — the operator's (and the suite's) seam.
 *      Pointing it at a path that does not exist is how a test forbids a runtime
 *      on a machine that has one, exactly as `FREILAUF_CURSOR_AUTH` and
 *      `FREILAUF_CLAUDE_CREDENTIALS` point at files that are not there.
 *   2. `DOCKER_HOST` (`CONTAINER_HOST` for podman) out of the environment.
 *   3. `$XDG_RUNTIME_DIR/docker.sock` — the rootless daemon.
 *   4. `/var/run/docker.sock` — the rootful one, and the CLI's own fallback.
 *
 * `source` says which of the four answered, because the answer's WEIGHT differs:
 * a socket we found ourselves under 3 is one we may hand on as `DOCKER_HOST`;
 * the legacy path under 4 is not (see above).
 */
export function runtimeEndpoint(runtimeId = 'docker') {
  const id = String(runtimeId ?? 'docker')
  const podman = id === 'podman'
  const seam = env(ENDPOINT_SEAM)
  if (seam !== undefined && String(seam).trim() !== '') {
    return { endpoint: String(seam).trim(), source: 'seam' }
  }
  const fromEnv = podman ? process.env.CONTAINER_HOST : process.env.DOCKER_HOST
  if (fromEnv && String(fromEnv).trim()) return { endpoint: String(fromEnv).trim(), source: 'env' }
  const xdg = String(process.env.XDG_RUNTIME_DIR ?? '').trim()
  if (xdg) {
    const path = join(xdg, podman ? 'podman/podman.sock' : 'docker.sock')
    if (existsSync(path)) return { endpoint: `unix://${path}`, source: 'xdg' }
  }
  return podman
    ? { endpoint: null, source: 'none' }
    : { endpoint: 'unix:///var/run/docker.sock', source: 'legacy' }
}

/** The filesystem path of a `unix://` endpoint, or null for anything else. */
function socketPath(endpoint) {
  const s = String(endpoint ?? '').trim()
  if (!s) return null
  if (s.startsWith('unix://')) return s.slice('unix://'.length) || null
  return s.startsWith('/') ? s : null
}

/**
 * Does something answer at this endpoint? Tri-state, and for the same reason
 * `tmuxVerdict()` is:
 *
 *   `true`  the socket accepted a connection — there is a daemon behind it.
 *   `false` the kernel refused, and said why: ENOENT (no socket at all),
 *           ECONNREFUSED (a socket file whose server is gone — a stopped
 *           daemon leaves exactly that) or EACCES (a socket this user may not
 *           talk to, which is `/var/run/docker.sock` on a host where nobody is
 *           in the `docker` group [measured]).
 *   `null`  we cannot say from here: a tcp/ssh/npipe endpoint, a timeout, or an
 *           error code nobody has seen yet. The CLI is then asked, as before.
 *
 * Nothing is written and nothing is sent — the connection is closed the moment
 * it stands. A daemon that is merely busy still accepts connections, which is
 * exactly why this is a cheaper question than `docker info` and a safe one.
 */
export async function endpointReachable(endpoint, { timeout = SOCKET_TIMEOUT_MS } = {}) {
  const path = socketPath(endpoint)
  if (!path) return { reachable: null, code: null, detail: endpoint ? 'not a unix socket' : 'no endpoint' }
  return new Promise((resolve) => {
    let done = false
    const finish = (value) => { if (!done) { done = true; try { sock.destroy() } catch {} resolve(value) } }
    const sock = connect(path)
    sock.setTimeout(timeout)
    sock.on('connect', () => finish({ reachable: true, code: null, detail: null }))
    sock.on('timeout', () => finish({ reachable: null, code: 'ETIMEDOUT', detail: `${path} did not answer` }))
    sock.on('error', (err) => {
      const code = err?.code ?? null
      const known = code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'EACCES'
      finish({ reachable: known ? false : null, code, detail: `${path}: ${code ?? err?.message ?? 'error'}` })
    })
  })
}

/**
 * Is the socket precheck asked at all?
 *
 * Not when the runtime is daemonless (podman), not when a binary seam names the
 * thing to drive — a shim is a script and has no socket, and a test fence may
 * replace what the hub CALLS — and not when `FREILAUF_SANDBOX_RUNTIME_FORCE=1`
 * says the operator (or the suite) has already answered the question. Forcing
 * does not invent a daemon: the CLI is still asked and still gets to say no.
 */
function socketPrechecked(def) {
  if (!def.socket) return false
  if (env(FORCE_SEAM) === '1') return false
  if (env('SANDBOX_RUNTIME_BIN')) return false
  return true
}

/**
 * The environment every runtime command is run with. `HOME` because the CLI
 * reads its contexts out of it, and the resolved `DOCKER_HOST` where we found
 * one ourselves — see the section comment above for why the legacy socket is
 * excluded from that.
 */
function runtimeEnv(runtimeId) {
  const out = { ...process.env }
  if (!out.HOME) {
    try { out.HOME = homedir() } catch { /* a machine that cannot say has none */ }
  }
  const { endpoint, source } = runtimeEndpoint(runtimeId)
  if (endpoint && (source === 'seam' || source === 'xdg')) {
    if (String(runtimeId ?? 'docker') === 'podman') out.CONTAINER_HOST = endpoint
    else out.DOCKER_HOST = endpoint
  }
  return out
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
  const r = await sh(bin, args, { timeout: opts.timeout ?? 30_000, env: runtimeEnv(runtimeId) })
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
  runtime_not_registered: 'sandbox.reason.runtime_not_registered',
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
  // The ENDPOINT is part of that question too — the same `docker` binary against
  // the rootless socket and against a dead one is two different answers, and a
  // suite that moves the seam between them must not be handed the first one.
  const key = `${id}|${bin}|${runtimeEndpoint(id).endpoint ?? ''}`
  const hit = infoCache.get(key)
  if (!force && hit && Date.now() - hit.at < INFO_CACHE_MS) return hit.value
  if (!force) {
    // Somebody is already asking the same question: join them rather than ask
    // the daemon twice. A cached answer is handed back at once and the refresh
    // finishes behind it (stale-while-revalidate, as on every page render).
    const running = infoFlight.get(key)
    if (running) return hit ? hit.value : running
  }
  // `force` starts a probe OF ITS OWN and never joins one in flight. Sharing
  // was the bug: a caller that explicitly asked for a fresh answer got the
  // answer to a question asked before it — which under load is a probe several
  // seconds old, and is the "fails once in four" shape a suite learns to
  // ignore. Waiting for the in-flight one and then probing would keep the
  // ordering too, but it makes a forced caller wait for a result it just said
  // it did not want; starting one costs a `docker info` instead.
  const startedAt = Date.now()
  const task = (async () => {
    const value = await probeRuntime(id, bin)
    // Two probes may now be in flight, so the SLOWER one must not overwrite a
    // newer answer that already landed — a cache is only ever moved forward.
    const current = infoCache.get(key)
    if (!current || current.at <= startedAt) infoCache.set(key, { at: Date.now(), value })
    return value
  })()
  infoFlight.set(key, task)
  // The release hangs on the PROMISE and not on the end of the body. With no
  // runtime at all this function has barely an await, so a reset written after
  // the assignment would run BEFORE it — and every later caller would be handed
  // one stale promise for the life of the process. AGENTS.md has the entry;
  // this is the same handful of lines.
  // Identity, not existence: with a forced probe running alongside an ordinary
  // one, whoever finishes first must clear only ITS OWN entry.
  const release = () => { if (infoFlight.get(key) === task) infoFlight.delete(key) }
  task.then(release, release)
  if (!force && hit) return hit.value
  return task
}

async function probeRuntime(id, bin) {
  const def = RUNTIMES[id] ?? RUNTIMES.docker
  const { endpoint, source } = runtimeEndpoint(id)
  const base = {
    available: false, id, bin, version: null, rootless: null, endpoint, endpointSource: source,
    runtimes: [], cgroup: cgroupFacts(), userns: usernsFacts(), reason: REASON.unreachable, message: null,
  }
  // THE SOCKET FIRST. A CLI on the PATH with no reachable daemon behind it is
  // exactly the state this installation sat in, and it is cheaper to find out
  // here than through a subprocess — a refusal from the kernel is an ANSWER
  // (`no_daemon`), while a timeout or an endpoint we cannot reason about is
  // not, and falls through to the CLI as before.
  if (socketPrechecked(def)) {
    const s = await endpointReachable(endpoint)
    if (s.reachable === false) {
      return { ...base, reason: REASON.no_daemon, message: s.detail }
    }
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
  const runtimes = runtimesFrom(info)
  // THE DAEMON ANSWERED IS NOT THIS RUNTIME WORKS. `runsc` is the same binary
  // and the same socket as `docker` plus one flag, so `docker info` succeeding
  // said nothing at all about whether gVisor is registered — and it is not, on
  // an ordinary daemon: its `Runtimes` here are `io.containerd.runc.v2` and
  // `runc` [measured 2026-09-05]. The settings page would have offered gVisor,
  // the profile would have looked validated, and every run so configured would
  // die in the pane with `unknown or invalid runtime name: runsc` (exit 125) —
  // a start failure with no diagnosis anywhere above it. The list is in the very
  // object we already parsed, so the check costs nothing.
  if (def.ociRuntime && runtimes.length && !runtimes.includes(def.ociRuntime)) {
    return {
      ...base, reason: REASON.runtime_not_registered, runtimes,
      version: versionFrom(info), rootless: rootlessFrom(info), cgroup: cgroupFacts(info),
      message: `the daemon knows ${runtimes.join(', ')}`,
    }
  }
  return {
    ...base,
    available: true,
    reason: REASON.ok,
    version: versionFrom(info),
    rootless: rootlessFrom(info),
    runtimes,
    // The daemon's own answer about what it can enforce outranks the delegation
    // file — see cgroupFacts().
    cgroup: cgroupFacts(info),
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
 * WHICH RESOURCE FENCES THIS HOST CAN REALLY ENFORCE.
 *
 * Two sources, and the daemon's own answer wins where it exists — because it is
 * the answer `docker run` will act on, while the delegation file is only the
 * ingredient it was computed from:
 *
 *  - `cgroup.controllers` under this user's systemd slice is the DELEGATION.
 *    Rootless Docker needs `memory` and `pids` in it or `--memory` and
 *    `--pids-limit` are silently ignored, and a fence that is not enforced is
 *    worse than none, because the settings page says it is on. Measured on this
 *    host: `cpu memory pids` — so `cpuset` and the io controller are NOT
 *    delegated, and `--cpuset-cpus` or an io limit would be refused by the
 *    daemon [measured 2026-09-05].
 *  - `docker info` reports the same thing from the other side: `MemoryLimit`,
 *    `SwapLimit`, `PidsLimit`, `CpuCfsQuota`/`CpuCfsPeriod` and `CPUSet` are
 *    booleans [documented], and this host answers `CPUSet: false` next to
 *    `true` for the rest.
 *
 * `limits` is therefore the field a form has to ask before it offers a fence:
 * a limit whose entry is `false` is one `docker run` would refuse, and `null`
 * means nobody could say — which is not permission to promise it either.
 * Nothing in `buildRunArgv()` writes `--cpuset-cpus` or an io limit today, and
 * this is the answer that keeps it that way: a new limit is offered only where
 * this says it holds.
 */
function cgroupFacts(info = null) {
  const out = { controllers: [], delegated: null, path: null, version: null, limits: {} }
  const has = (name) => (out.controllers.length ? out.controllers.includes(name) : null)
  try {
    const uid = typeof process.getuid === 'function' ? process.getuid() : null
    if (uid !== null) {
      const path = `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/cgroup.controllers`
      out.path = path
      if (existsSync(path)) {
        out.controllers = readFileSync(path, 'utf8').trim().split(/\s+/).filter(Boolean)
        // The three the shipped profiles actually write. `cpu` joins the pair
        // because `--cpus` is a cpu-controller quota, and a host that delegates
        // memory and pids but not cpu would silently drop it.
        out.delegated = ['memory', 'pids', 'cpu'].every(c => out.controllers.includes(c))
      }
    }
  } catch { /* a sysfs that does not answer is simply no information */ }
  // `true`/`false` only where somebody really said so — `Boolean(undefined)` is
  // `false`, and a fence reported as refused when nobody was asked would take
  // away a limit that works.
  const said = (v, fallback) => (typeof v === 'boolean' ? v : fallback)
  out.version = info?.CgroupVersion ? String(info.CgroupVersion) : null
  out.limits = {
    memory: said(info?.MemoryLimit, has('memory')),
    memorySwap: said(info?.SwapLimit, has('memory')),
    pids: said(info?.PidsLimit, has('pids')),
    cpus: said(info?.CpuCfsQuota, has('cpu')),
    // cpuset and io are the two this host does NOT have, and the two nothing
    // may quietly assume: `docker info` names cpuset itself, and the io
    // controller has no `info` field at all, so the delegation file is the only
    // witness for it.
    cpuset: said(info?.CPUSet, has('cpuset')),
    io: has('io'),
  }
  return out
}

/**
 * Which limits this host can enforce, as a plain question a form can ask:
 * `cgroupSupports(info, 'cpuset')`. `null` is "nobody could say", and it is
 * deliberately NOT `true` — offering a fence the daemon would refuse is the
 * same lie as a fence that is silently ignored.
 */
export function cgroupSupports(info, limit) {
  const v = info?.cgroup?.limits?.[String(limit)]
  return typeof v === 'boolean' ? v : null
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
  const profile = usernsProfile()
  out.apparmorUsernsProfile = profile.name
  out.apparmorUsernsProfilePath = profile.path
  // THE QUESTION IS "may a userns be created", NOT "did the docker package write
  // a profile". The sysctl above says the restriction is ON; it says nothing
  // about whether a profile lifts it for the binaries that matter, and Ubuntu
  // 24.04 ships exactly such a profile itself — `/etc/apparmor.d/rootlesskit`,
  // `flags=(unconfined)` with a `userns,` rule, and rootless Docker runs on this
  // host with the sysctl at 1 [measured 2026-09-05]. Reporting a gap that is not
  // there sends an operator to fix a working machine.
  //
  // `restricted` is therefore the ANSWER and not the ingredient: true only where
  // the kernel restricts and nothing was found that permits it, false where it
  // does not restrict or a profile does, null where we could not read enough to
  // say. What is deliberately not used is `aa-status`: as a normal user it
  // prints "You do not have enough privilege to read the profile set" and
  // **exits 0** [measured] — a false green of exactly the kind this project has
  // rules about.
  const restrict = out.apparmorRestrictUserns
  if (restrict === undefined || restrict === null) out.restricted = restrict === null ? null : false
  else if (Number(restrict) === 0) out.restricted = false
  else if (profile.name) out.restricted = false
  else out.restricted = profile.readable ? true : null
  return out
}

/**
 * The AppArmor profiles that are allowed to create a user namespace, read from
 * the profile FILES — the only source a hub that never runs `sudo` has. A
 * profile qualifies when it carries a bare `userns,` rule (the grant Ubuntu's
 * own `rootlesskit` profile uses) or is declared `flags=(unconfined)`.
 *
 * Bounded on purpose: the named candidates first, then at most a few dozen
 * top-level files, each read only if it is small. This runs behind the discovery
 * cache, and a directory scan that grew without a ceiling would be a page render
 * waiting on somebody's `/etc`.
 */
const APPARMOR_DIR = '/etc/apparmor.d'
const USERNS_CANDIDATES = ['rootlesskit', 'unprivileged_userns', 'docker', 'dockerd', 'podman', 'bwrap', 'unshare']
const APPARMOR_MAX_FILES = 60
const APPARMOR_MAX_BYTES = 64 * 1024

function usernsProfile() {
  const out = { name: null, path: null, readable: false }
  let names
  try {
    if (!existsSync(APPARMOR_DIR)) return out
    names = readdirSync(APPARMOR_DIR)
    out.readable = true
  } catch { return out }
  const ordered = [
    ...USERNS_CANDIDATES.filter(n => names.includes(n)),
    ...names.filter(n => !USERNS_CANDIDATES.includes(n)).slice(0, APPARMOR_MAX_FILES),
  ]
  for (const name of ordered) {
    const path = join(APPARMOR_DIR, name)
    try {
      const st = statSync(path)
      if (!st.isFile() || st.size > APPARMOR_MAX_BYTES) continue
      const text = readFileSync(path, 'utf8')
      // `userns,` as a rule of its own, or a profile that is unconfined anyway.
      if (/^\s*userns\s*,/m.test(text) || /flags\s*=\s*\(\s*[^)]*unconfined/.test(text)) {
        return { name, path, readable: true }
      }
    } catch { /* one unreadable profile is not an answer about the set */ }
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

/**
 * The gateway address of a network — the address the HOST holds on that
 * network's bridge, and therefore the only address a container on an internal
 * network can reach a host listener at (§7.5.2, the `builtin` engine).
 *
 * `null` with a reason where the daemon did not say: a network created with
 * `gateway_mode_ipv4=isolated` has no host address at all, and that is a
 * refusal for the built-in engine rather than something to guess around.
 */
export async function networkGateway(name, { runtime = 'docker' } = {}) {
  const r = await call(runtime, ['network', 'inspect', '--format',
    '{{range .IPAM.Config}}{{.Gateway}} {{end}}', String(name)])
  if (!r.ok) {
    return { verdict: r.verdict, ok: false, address: null, reason: (r.stderr || '').trim() || 'network inspect failed' }
  }
  // AN IP, OR NOTHING. `find(a => a !== '<no value>')` was not a check that the
  // token IS an address, and Docker 29.8.0 supplies one that is not:
  // a network created with `gateway_mode_ipv4=isolated` carries no Gateway key,
  // and the Go template stringifies the zero `netip.Addr` as **`invalid IP`**
  // [measured 2026-09-05]. The whitespace split then handed `"invalid"` back as
  // the address, `builtinBind()`'s explicit refusal never fired, and the proxy
  // called `listen(port, 'invalid')` — so the operator got
  // `ENOTFOUND getaddrinfo invalid` instead of the sentence this function was
  // written to give them. `net.isIP()` is the check, and it costs nothing.
  const address = String(r.stdout ?? '').trim().split(/\s+/).find(a => isIP(a) !== 0) ?? null
  return { verdict: 'ok', ok: !!address, address, reason: address ? null : 'the network has no gateway address' }
}

/**
 * The proxy's second leg (§7.5.1: "the proxy is on the internal network *and* on
 * the bridge"). A container is created on ONE network; every further one is a
 * call of its own, and this is that call — `buildNetworkConnectArgv()` used to
 * be exported and never invoked, which is exactly why an iron-proxy container
 * had no way out to the internet and the whole `allowlist` mode was a run with
 * no egress.
 *
 * Idempotent, because a resume walks the same start order again: a container
 * already on the network is a success, not an error.
 */
export async function connectNetwork(network, container, { runtime = 'docker' } = {}) {
  const { args } = buildNetworkConnectArgv(network, container, { runtime })
  const r = await call(runtime, args)
  if (r.ok) return { verdict: 'ok', ok: true, existed: false }
  const text = String(r.stderr ?? '') + String(r.stdout ?? '')
  if (/already exists in network|is already connected to network|endpoint with name .* already exists/i.test(text)) {
    return { verdict: 'ok', ok: true, existed: true }
  }
  return { verdict: r.verdict, ok: false, existed: false, reason: text.trim() || null }
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
  // Through `runtimeEnv()` like every other runtime call: a build that lost the
  // CLI's context would go looking for the daemon at the dead legacy socket.
  const r = await sh(bin, args, { timeout, maxBuffer: 16 * 1024 * 1024, env: runtimeEnv(runtime) })
  const verdict = runtimeVerdict(r)
  if (r.ok) {
    // The digest is asked for right away: it is what a spec is pinned with and
    // what the `started` event records, and asking later means asking about an
    // image that may have been rebuilt in between.
    const d = await imageDigest(recipe.tag, { runtime })
    return { ok: true, image: recipe.tag, verdict: 'ok', digest: d.digest, imageId: d.id, log: r.stdout }
  }
  // NO DAEMON, OR NO BINARY. That is not a broken Dockerfile, and saying "the
  // build failed" about it would send the operator to the wrong file entirely.
  //
  // The test used to be `verdict !== 'ok'`, and that made the `build_failed`
  // branch below UNREACHABLE: `runtimeVerdict()`'s default is `unreachable`, and
  // a build that really breaks fails with a message no daemon classifier
  // knows (`ERROR: failed to solve: …`). So every broken Dockerfile on this hub
  // was reported as "there is no container runtime" — the one diagnosis that
  // sends somebody to look at their installation instead of at their image.
  // Only a POSITIVE no-daemon answer, or a binary that is not there, is a
  // runtime problem; everything else is the build's own.
  const missingBin = r.code === 'ENOENT' || /ENOENT|not found/i.test(String(r.stderr ?? ''))
  if (verdict === 'no_daemon' || missingBin) {
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

// ---------------------------------------------------------------------------
// The dry run (§7.12.5)
// ---------------------------------------------------------------------------

/**
 * The checks the "test this configuration" button runs, and the one rule the
 * whole function is written around: **a check that could not run is reported as
 * NOT RUN, never as passed.**
 *
 * That rule exists because the previous state of this feature was the worst
 * shape a check can take. `dryRun()` in index.mjs called `rt?.dryRunChecks` —
 * a function that did not exist — so `checks` stayed empty and
 * `[].every(c => c.ok !== false)` made the answer `ok: true` every single time.
 * A production twin of a test that cannot fail: it told an operator their
 * profile was fine without having looked at anything.
 *
 * `ok` is therefore a THREE-valued answer, and the page's own "no checks" line
 * can no longer be reached:
 *   `true`   the check ran and passed
 *   `false`  the check ran and failed — this is the only value that makes the
 *            dry run as a whole fail
 *   `null`   the check did not run, and `detail` says why
 *
 * What it really does, in the order §7.12.5 lists: the resolved policy (pure,
 * always runnable — and the check that would have caught an allow list that
 * never reached the proxy), the image, and then a container started from the
 * spec with **no agent in it**, which answers whether the working copy is
 * reachable, whether the home is writable and whether the tmpfs sizes are what
 * they were asked to be. The egress probes need a proxy, and a dry run starts
 * none, so they are reported as not run with that as the reason rather than
 * quietly left out.
 */
export async function dryRunChecks(spec, { allow = [], repo = null, workdir = null } = {}) {
  const checks = []
  const add = (name, ok, detail = null) => { checks.push({ name, ok, detail }); return ok }
  let s
  try { s = normalizeSpec(spec ?? {}) } catch (err) {
    add('spec', false, err?.message || String(err))
    return checks
  }

  // 1. The policy, from the same function the proxy is configured with — so a
  //    resolved allow list that does not reach the proxy shows up HERE instead
  //    of as a run with no egress.
  const mode = s.network?.mode ?? 'allowlist'
  try {
    const { proxyPolicy } = await import('./proxy.mjs')
    const policy = proxyPolicy({ ...s, network: { ...(s.network ?? {}), allow, presets: [] } })
    if (policy.broken) add('policy', false, policy.broken)
    else if (mode === 'allowlist' && policy.allow.length === 0) {
      add('policy', false, 'the allow list is empty — every host would be refused')
    } else {
      add('policy', true, mode === 'allowlist' ? `${policy.allow.length} host patterns` : `network mode ${mode}`)
    }
  } catch (err) { add('policy', null, err?.message || String(err)) }

  const info = await runtimeInfo(s.runtime, { force: true })
  if (!info?.available) {
    add('runtime', false, info?.reason ?? 'no container runtime')
    add('image', null, 'no container runtime')
    add('container', null, 'no container runtime')
    add('egress', null, 'no container runtime')
    return checks
  }
  add('runtime', true, `${info.id}${info.version ? ` ${info.version}` : ''}${info.rootless ? ' (rootless)' : ''}`)

  // 2. The image. A missing one is the failure §7.10 calls the worst there is,
  //    and it is the cheapest thing to find out before a run pays for it.
  const ref = s.image?.ref ?? null
  if (!ref) add('image', false, 'the profile names no image')
  else {
    const d = await imageDigest(ref, { runtime: s.runtime })
    if (d?.ok) add('image', true, d.digest ? `${ref} @ ${d.digest}` : ref)
    else add('image', false, d?.reason ?? `image not available: ${ref}`)
  }

  // 3. The container itself, with no agent in it. `--network none` on purpose:
  //    a dry run must not create the per-run network or leave one behind, and
  //    what this container answers is about the FILESYSTEM.
  const probeDir = workdir || repo?.path || null
  if (!probeDir) {
    add('container', null, 'no working copy to probe with')
  } else {
    const tmpfs = Object.keys(s.filesystem?.tmpfsSizes ?? {})
    const script = [
      `test -d ${shq(probeDir)} && echo "workdir ok" || echo "workdir FAIL"`,
      ...tmpfs.map(p => `df -k ${shq(p)} >/dev/null 2>&1 && echo "tmpfs ${p} ok" || echo "tmpfs ${p} FAIL"`),
      'echo done',
    ].join('; ')
    let argv = null
    try {
      argv = buildRunArgv({ ...s, network: { ...(s.network ?? {}), mode: 'none' }, retention: 'run' }, {
        runId: `dryrun-${Date.now().toString(36)}`, hubId: '', tty: false,
        workdir: probeDir, uid: process.getuid?.() ?? null, gid: process.getgid?.() ?? null,
        cmd: ['sh', '-lc', script],
      })
    } catch (err) { add('container', false, err?.message || String(err)) }
    if (argv) {
      const r = await sh(argv.bin, argv.args, { timeout: 120_000, env: runtimeEnv(s.runtime) })
      const out = String(r.stdout ?? '')
      if (!r.ok && !out.includes('done')) {
        add('container', false, (String(r.stderr ?? '').trim().split('\n').pop() || 'the probe container did not run'))
      } else {
        add('container', !out.includes('FAIL'), out.trim().split('\n').filter(Boolean).join('; ') || null)
      }
    }
  }

  // 4. The egress probes of §7.12.5 need a live proxy, and a dry run starts
  //    none. Named and reported as not run — the one thing that must never
  //    happen here is a check that is missing looking like a check that passed.
  add('egress', null, mode === 'allowlist'
    ? 'a dry run starts no proxy; the allow list is checked by the policy row above'
    : `network mode ${mode} has no proxy to probe`)
  return checks
}

/** Single-quote a path for the `sh -lc` the probe container runs. */
function shq(s) { return `'${String(s).replaceAll("'", `'\\''`)}'` }
