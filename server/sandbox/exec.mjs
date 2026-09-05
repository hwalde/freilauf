// Freilauf — the two seams the rest of the hub calls for a run's working copy
// and a run's agent state (SANDBOX_RESEARCH.md §7.4.4 and §7.7).
//
// The whole point of this file is that its callers stop asking whether a run is
// sandboxed. `agentHome(run)` and `runGit(run, args)` answer the same question
// for both kinds of run, and for an UNSANDBOXED run they answer it byte for byte
// the way the hub answers it today — so a call site can be rewired mechanically
// and nothing about an installation without Docker changes.

import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync, lstatSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { HOME, RUNS_DIR, sh } from '../util.mjs'
import { envIs } from '../env.mjs'

/**
 * The two git subcommands that were **measured** to execute nothing at all in a
 * deliberately hostile clone — `core.fsmonitor`, `core.sshCommand`,
 * `core.alternateRefsCommand`, `core.pager`, `core.editor`, `diff.external`,
 * `uploadpack.packObjectsHook` and twelve executable hooks, none of them fired
 * [measured, git 2.43.0, SANDBOX_RESEARCH.md §11a.1]. Everything that reads the
 * WORKING TREE fired something: `status` and `diff` ran `core.fsmonitor` and
 * `diff.external`, `add`/`commit` ran `pre-commit`, `post-index-change` and
 * `reference-transaction`, `checkout -- .` ran `post-checkout`.
 *
 * A list of two, and it stays a list of two unless somebody measures a third.
 */
const INERT_SUBCOMMANDS = new Set(['rev-parse', 'rev-list'])

/**
 * `-c` options passed alongside the config substitution below. On their own they
 * are NOT a boundary and must never be described as one — that was the finding:
 * a `filter.<n>.clean` driver, selected by a **tracked `.gitattributes` the agent
 * commits**, still ran on `status`, `add -A` and `diff HEAD` with all of these
 * set, because the driver is named in the repository's own config and there is no
 * `GIT_CONFIG_NOLOCAL`. `diff.<n>.textconv` and `merge.<n>.driver` are the same
 * family. What holds is replacing the config, and `core.hooksPath` is the half
 * the replacement cannot reach (`.git/hooks` stays at its default path, so
 * `post-index-change` fires without it).
 */
const HOOKS_OFF = ['-c', 'core.hooksPath=/dev/null']

/**
 * Where the CLI keeps its state for THIS run — the directory `HOME` points at
 * while the agent works, and therefore where every activity source, transcript
 * and session store of the harness plugins lives.
 *
 * Unsandboxed → the host home, which is what `homedir()` said before this
 * function existed. Sandboxed → `runs.sandbox_home`; that column is documented
 * as "NULL = the host home", so a sandboxed run whose home was never recorded
 * reads exactly as it did before too.
 */
export function agentHome(run) {
  if (!run) return HOME
  return (run.sandbox && run.sandbox_home) ? run.sandbox_home : HOME
}

/** The per-run home a sandboxed run gets: `~/agents/runs/<id>/home` (§7.7). */
export function sandboxHomeDir(runId) {
  return join(RUNS_DIR, String(runId), 'home')
}

/**
 * Anything whose NAME says it carries a secret. Not a security boundary — the
 * file is inside a directory only the hub user can reach anyway — but a seeded
 * `.credentials.json` at 0644 is the kind of thing that gets copied somewhere
 * else later, so the mode says what the content is.
 */
const CREDENTIAL_NAME = /(credential|auth|token|secret|\.env$|_key|\.key$|apikey|api_key)/i

/**
 * Write the files a harness plugin's `seedHome` returned into a run's home
 * (§7.9): `[{ path, content, mode? }]`, `path` relative to the home.
 *
 * Refuses rather than writes, in three cases, and each is a way a seed could
 * otherwise reach out of the home it is seeding: an absolute path, a path that
 * climbs out with `..`, and a symlink sitting where the file should go. The last
 * one is why this does not simply `writeFileSync`: `'w'` FOLLOWS a symlink, so a
 * link left behind by a previous run (or by the agent, on a retry that reuses
 * the directory) would redirect a credential file anywhere the hub user can
 * write.
 *
 * Returns `{ written: [...], refused: [{ path, reason }] }` and throws nothing:
 * a seed that could not be written is a fact the caller reports, not a start
 * that dies.
 */
export function seedHomeFiles(run, files) {
  const home = agentHome(run)
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const root = realOrResolve(home)
  const written = []
  const refused = []
  for (const file of files ?? []) {
    const rel = String(file?.path ?? '')
    if (!rel || isAbsolute(rel)) { refused.push({ path: rel, reason: 'absolute' }); continue }
    const target = resolve(home, rel)
    if (!inside(root, target)) { refused.push({ path: rel, reason: 'outside_home' }); continue }
    try {
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
      // The parent may itself be (or contain) a link out; realpath answers that
      // for the whole chain in one call.
      if (!inside(root, realOrResolve(dirname(target)))) { refused.push({ path: rel, reason: 'outside_home' }); continue }
      if (isSymlink(target)) { refused.push({ path: rel, reason: 'symlink' }); continue }
      const mode = file.mode ?? (CREDENTIAL_NAME.test(rel) ? 0o600 : 0o644)
      writeFileSync(target, String(file.content ?? ''), { mode })
      // …and again explicitly: `writeFileSync`'s mode applies to a file it
      // CREATES and is filtered by the umask. A retry reuses the home, so a
      // credential seeded a second time would otherwise keep whatever mode it
      // happened to have.
      chmodSync(target, mode)
      written.push(rel)
    } catch (err) {
      refused.push({ path: rel, reason: String(err.message ?? err) })
    }
  }
  return { written, refused }
}

function realOrResolve(p) { try { return realpathSync(p) } catch { return resolve(p) } }
function isSymlink(p) { try { return lstatSync(p).isSymbolicLink() } catch { return false } }
function inside(root, target) {
  if (target === root) return true
  return target.startsWith(root.endsWith(sep) ? root : root + sep)
}

/**
 * git against a run's working copy — the seam every `git -C <workdir>` in
 * integrate.mjs, watcher.mjs and runner.mjs goes through.
 *
 * Three branches:
 *
 *  1. **Unsandboxed** → `sh('git', ['-C', dir, ...args])`. Literally today's
 *     call, nothing added: a rewired caller must not start behaving differently
 *     on an installation that has no sandbox at all.
 *  2. **Sandboxed, container alive** → the same command through `exec` in the
 *     container, as the user the agent runs as.
 *  3. **Sandboxed, container gone** → the host, and this is the branch that was
 *     measured and rewritten. A container that is gone still leaves a working
 *     copy on disk, and the questions asked of it then — what is its tip, is it
 *     dirty — are what the operator sees on a dead run's page. But that working
 *     copy is a CLONE whose `.git/config`, `.git/hooks` and even its tracked
 *     `.gitattributes` belong to the agent, so "run git in it" is "run the
 *     agent's code on the host". Three answers, in this order:
 *
 *     - **`rev-parse` / `rev-list`** run plainly: they were measured to execute
 *       nothing in a deliberately hostile clone (§11a.1).
 *     - **Anything else is REFUSED by default**, with `unknown: true` on the
 *       result. That flag is load-bearing: `git status` failing must be read as
 *       "the dirt of this run is unknown", NEVER as "clean" — the same trap
 *       `--no-optional-locks` returning an empty status already has an entry in
 *       AGENTS.md for.
 *     - **`hostFallback: 'masked'`** is the escape hatch for the rescue path,
 *       which has to run somewhere: the clone's `.git/config` is replaced by a
 *       minimal one for the duration of the call and `core.hooksPath` is sent to
 *       `/dev/null`. That combination — and only that combination — was measured
 *       inert against all eight commands, `status`, `diff`, `add -A`, `commit`
 *       and `checkout -- .` included. The substitution alone still fires
 *       `post-index-change`; a denylist of config keys stops nothing at all,
 *       because a tracked `.gitattributes` names a `filter.<n>.clean` driver that
 *       the config-key denylist never sees.
 *
 *     For a sandboxed run that is NOT a clone (`worktree_kind = 'worktree'`) none
 *     of this applies: that `.git` is the operator's own, and the branch is the
 *     plain host call it always was.
 *
 * The return value is `sh()`'s, in every branch: `{ ok, code, stdout, stderr }`
 * — every existing caller destructures exactly that. A refusal adds `unknown:
 * true` next to it; a caller that does not look at it is no worse off than
 * before, and one that does can say "unknown" instead of guessing.
 */
export async function runGit(run, args, opts = {}) {
  const dir = opts.cwd ?? run?.workdir_effective
  const { cwd, user, hostFallback, ...shOpts } = opts
  if (!dir) return { ok: false, code: 1, stdout: '', stderr: 'runGit: no working directory' }

  if (!sandboxed(run)) return sh('git', ['-C', dir, ...args], shOpts)

  const inContainer = await execInContainer(run, ['git', '-C', dir, ...args], { user, ...shOpts })
  if (inContainer) return inContainer
  if (hostFallback === false) return refusal('runGit: container unavailable and host fallback refused')

  // The operator's own `.git`: nothing here is the agent's, so this is the call
  // it always was.
  if (!agentOwnedGit(run)) return sh('git', [...HOOKS_OFF, '-C', dir, ...args], hardenedOpts(shOpts))

  if (INERT_SUBCOMMANDS.has(subcommand(args))) {
    return sh('git', [...HOOKS_OFF, '-C', dir, ...args], hardenedOpts(shOpts))
  }
  if (hostFallback !== 'masked') {
    return refusal(`runGit: "${subcommand(args) ?? '?'}" reads the working copy of a sandboxed run whose `
      + 'container is gone; running it on the host would execute the agent\'s git configuration. '
      + 'Pass hostFallback:"masked" if this call has to happen anyway.')
  }
  return maskedHostGit(dir, [...HOOKS_OFF, '-C', dir, ...args], hardenedOpts(shOpts))
}

/** A failure that says "nobody looked", as opposed to "git looked and said no". */
function refusal(text) {
  return { ok: false, code: 1, stdout: '', stderr: text, unknown: true }
}

/**
 * The git subcommand inside an argument list that may start with git-level
 * options — `-C dir`, `-c k=v`, `--no-optional-locks`. The two that take a
 * separate value have to be skipped WITH their value, or `git -c x=y status`
 * would read as the subcommand `y`.
 */
function subcommand(args) {
  const list = args ?? []
  for (let i = 0; i < list.length; i++) {
    const a = String(list[i])
    if (a === '-c' || a === '-C' || a === '--git-dir' || a === '--work-tree' || a === '--namespace') { i++; continue }
    if (a.startsWith('-')) continue
    return a
  }
  return null
}

/**
 * Is this run's `.git` the agent's? A sandboxed run works in a private clone
 * (§7.4.2) whose config, hooks and attributes it owns outright. The check is the
 * one-line predicate `isClone()` in clone.mjs, repeated here rather than
 * imported so this module keeps its own small import graph — it is the value of
 * one column, and clone.mjs states the rule.
 */
function agentOwnedGit(run) {
  return run?.worktree_kind === 'clone'
}

/**
 * Run one git command against a clone whose `.git/config` has been replaced by a
 * minimal one for exactly the length of that call. This is the ONLY shape
 * measured inert for the commands that touch the working tree, and it is still
 * host execution of somebody else's repository — which is why it is opt-in and
 * why the config comes back in a `finally`.
 *
 * A leftover backup from a crashed earlier call is restored first rather than
 * clobbered: the backup is the agent's real config, and the file standing in its
 * place is our mask.
 */
async function maskedHostGit(dir, args, shOpts) {
  const cfg = join(dir, '.git', 'config')
  const bak = `${cfg}.freilauf-unmasked`
  if (existsSync(bak)) { try { renameSync(bak, cfg) } catch { /* the mask stands; the guard below refuses */ } }
  if (!existsSync(cfg)) {
    return refusal('runGit: no .git/config to mask — refusing to run git in an agent-owned repository unmasked')
  }
  const { writeMaskedGitConfig } = await import('./clone.mjs')
  try {
    renameSync(cfg, bak)
  } catch (err) {
    return refusal(`runGit: could not mask the clone's config (${String(err.message ?? err)})`)
  }
  try {
    // keepIdentity: the rescue path commits, and a commit without a committer
    // dies with "please tell me who you are". A name and a mail address are not
    // commands; everything that could be one is gone.
    await writeMaskedGitConfig(bak, cfg, { keepIdentity: true })
    return await sh('git', args, shOpts)
  } finally {
    try { rmSync(cfg, { force: true }); renameSync(bak, cfg) } catch { /* the backup stays next to it, and is picked up above */ }
  }
}

/**
 * The same three branches for a command that is not git — a merge check, a dry
 * run, anything §8.7 wants to run against a sandboxed run's working copy. One
 * dispatcher rather than two, so "which of the three cases is this" is answered
 * in one place and cannot drift.
 *
 * `argv` is `[command, ...args]`; `opts.cwd` defaults to the run's working copy.
 *
 * Branch 3 **refuses by default** here, and more firmly than in `runGit`: the
 * command is arbitrary, the working copy is the agent's, and there is no
 * equivalent of the two subcommands measured inert — a merge check IS the
 * agent's code, which is §8.7's whole point. `hostFallback: 'unsafe'` is the
 * deliberate opt-out for a caller that knows the command is the operator's own
 * and not the repository's.
 */
export async function runShell(run, argv, opts = {}) {
  const [bin, ...args] = argv ?? []
  if (!bin) return { ok: false, code: 1, stdout: '', stderr: 'runShell: no command' }
  const dir = opts.cwd ?? run?.workdir_effective
  const { cwd, user, hostFallback, ...shOpts } = opts

  if (!sandboxed(run)) return sh(bin, args, dir ? { cwd: dir, ...shOpts } : shOpts)

  const inContainer = await execInContainer(run, [bin, ...args], { user, cwd: dir, ...shOpts })
  if (inContainer) return inContainer
  if (hostFallback === false) return refusal('runShell: container unavailable and host fallback refused')
  if (agentOwnedGit(run) && hostFallback !== 'unsafe') {
    return refusal(`runShell: refusing to run "${bin}" on the host against the working copy of a sandboxed `
      + 'run whose container is gone. Pass hostFallback:"unsafe" if this command is the operator\'s own.')
  }
  return sh(bin, args, { ...(dir ? { cwd: dir } : {}), ...hardenedOpts(shOpts) })
}

/**
 * A run the hub really started in a container. `runs.sandbox` is 0/1, and
 * `sandbox_container` is written only once a container was actually created —
 * so a run that WANTED a sandbox and did not get one takes the plain host path,
 * which is the same thing `sandbox:bypassed` says on its record.
 * `FREILAUF_SANDBOX_OFF=1` is the hard off switch a test needs.
 */
function sandboxed(run) {
  if (envIs('SANDBOX_OFF', '1')) return false
  return !!(run?.sandbox && run?.sandbox_container)
}

/**
 * The environment for every host-side call on a sandboxed run's working copy.
 * `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL=/dev/null` take the two scopes
 * git calls PROTECTED out of the picture — which is worth doing and is NOT what
 * makes this safe: neither reaches the repository's own config, and there is no
 * `GIT_CONFIG_NOLOCAL`. What makes the call safe is the config substitution in
 * `maskedHostGit()`, or the command being one of the two measured inert.
 */
function hardenedOpts(shOpts) {
  return {
    ...shOpts,
    env: { ...process.env, ...(shOpts.env ?? {}), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }
}

/**
 * Run argv inside the run's container, or answer `null` when that is not
 * possible — a runtime module that is not there (an installation without the
 * sandbox at all), a daemon that does not answer, a container that has ended.
 * `null` means "the caller should take its own fallback"; it is never an error
 * of its own, because a container being gone is the ordinary end of a run.
 *
 * The runtime module is imported LAZILY, and that is the rule this project has
 * an entry in AGENTS.md for: a static import here would tie every caller of this
 * seam — integrate.mjs, watcher.mjs, runner.mjs — to a module that talks to a
 * container daemon, on machines that have none.
 */
async function execInContainer(run, argv, opts = {}) {
  let rt
  try { rt = await import('./runtime.mjs') } catch { return null }
  if (typeof rt?.execIn !== 'function' || typeof rt?.containerState !== 'function') return null
  const name = run.sandbox_container
  const runtime = runtimeId(run)
  try {
    const state = await rt.containerState(name, { runtime })
    // Only a container that is DEMONSTRABLY running is used. "The daemon did not
    // answer" is not "the container is alive" — and the host fallback is
    // hardened precisely so that taking it whenever we do not know is safe.
    if (!state || state.verdict !== 'ok' || !state.running) return null
    const r = await rt.execIn(name, argv, {
      runtime, user: opts.user ?? specOf(run)?.user, cwd: opts.cwd, timeout: opts.timeout,
    })
    // `gone` (the container vanished between the state and the exec) and
    // `no_daemon` mean the command DID NOT RUN — those are the third branch's
    // case. `unreachable` deliberately is NOT: `docker exec` propagates the
    // inner exit code, so a git that legitimately answered 1 (`rev-parse` of a
    // missing ref, `merge-tree` reporting a conflict) comes back with exactly
    // that verdict. Retrying such a command on the host would run a `commit` or
    // an `add -A` twice, and would turn a conflict into a second opinion.
    if (r?.gone || r?.verdict === 'no_daemon') return null
    return shShape(r)
  } catch {
    return null
  }
}

/** Whatever the runtime module hands back, in `sh()`'s shape. */
function shShape(r) {
  if (!r) return null
  return {
    ok: r.ok ?? (r.code === 0),
    code: r.code ?? (r.ok ? 0 : 1),
    stdout: String(r.stdout ?? ''),
    stderr: String(r.stderr ?? ''),
  }
}

/** The frozen spec of a run, or null — never a throw over a malformed column. */
export function specOf(run) {
  if (!run?.sandbox_spec) return null
  try { return JSON.parse(run.sandbox_spec) } catch { return null }
}

/**
 * Which container runtime this run was started with. Deliberately only the
 * run's own frozen spec: the runtime module owns discovery and the operator's
 * `sandbox_runtime` setting, and a second reader of that setting here would be
 * a second place the answer could be wrong.
 */
function runtimeId(run) {
  return specOf(run)?.runtime ?? undefined
}
