// Freilauf — the sandbox facade: the one module the rest of the hub imports
// (SANDBOX_RESEARCH.md §7.11 for the lifecycle, §7.3 for the decision, §7.12 for
// changing a policy on a run that is already going).
//
// Everything else under `server/sandbox/` is a piece of machinery — the spec and
// its layering, the clone, the proxy, the container runtime. This file is the
// only one `scheduler.mjs` and `runner.mjs` know about, and it exists so those
// two carry one branch each instead of a sandbox's worth of knowledge.
//
// Three rules govern every function below, and they are the same three the whole
// feature stands or falls on:
//
//  1. **Nothing changes for an installation without a container runtime, or for
//     a run the operator did not ask to sandbox.** Every function here is
//     callable on a machine with no Docker; the answer is then "not available",
//     never a throw. `runs.sandbox = 0` must take exactly the path the hub took
//     before this module existed — which is why `launchRun()` does not even
//     import this file for such a run.
//  2. **A weakening is always named.** A run that was going to be sandboxed and
//     is not gets `sandbox:bypassed {by, reason}`; an override the layering
//     refused gets `sandbox:override_refused`. Silence is the one outcome that
//     is never right: a policy that quietly gives way is not a policy.
//  3. **Every step of the start order is idempotent**, because a resume walks
//     the same order again (§7.11): the clone is reused, the home is re-seeded,
//     the network is created only if missing, the proxy started only if missing,
//     and a container still holding the run's name is stopped first.
//
// The sibling modules are imported LAZILY, one cached promise each. Two reasons,
// both load-bearing: a hub with no sandbox must not pay for loading the runtime,
// the proxy and the clone module on every start; and a module that is missing or
// broken must degrade to "not available" instead of taking the hub's import
// graph down with it. The same rule the harness plugins follow (AGENTS.md,
// "Pitfalls": a plugin file that needs something from the hub's own modules
// imports it inside the function that uses it).
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import db, { addEvent, getSetting, setSetting } from '../db.mjs'
import { RUNS_DIR, kurzid, sh } from '../util.mjs'
import { env } from '../env.mjs'
import { t } from '../i18n.mjs'
// The one reader of the four hub sandbox settings — see "the hub layer" below.
import { sandboxHubMode, sandboxAllowBypass, sandboxLock, sandboxHubSpec, sandboxAgainst } from '../run-def.mjs'
import { appendAuditFile } from './audit.mjs'

// --------------------------------------------------------------- lazy siblings

const loaded = new Map()
/**
 * One sibling module, or `null` when it cannot be loaded. The failure is cached
 * with the module: a missing `runtime.mjs` must not cost an import attempt on
 * every watcher pass, and it must not be reported once per pass either.
 */
function sibling(name) {
  if (!loaded.has(name)) {
    loaded.set(name, import(`./${name}.mjs`).catch(err => {
      console.warn(`[sandbox] ${name}.mjs is not available: ${err.message}`)
      return null
    }))
  }
  return loaded.get(name)
}

/** The same, but for a caller that cannot go on without it. */
async function need(name) {
  const m = await sibling(name)
  if (!m) throw new Error(t('sandbox.launch.module_missing', { module: `${name}.mjs` }))
  return m
}

/**
 * "Could not try" is not "tried and died" (AGENTS.md), and in a sandbox that
 * distinction has a fuse behind it (§11.3): after a server reboot the first
 * watcher pass runs at once, and on a rootless installation the container
 * daemon's user unit may still be coming up. Three passes against a daemon that
 * is merely slow would burn the whole `RESUME_MAX` cap and end the run with
 * `resume_refused` — for an infrastructure hiccup, not for a CLI that cannot
 * start.
 *
 * An error carrying `sandboxRetry` therefore means: the hub learned NOTHING. The
 * launch leaves `resume_pending` standing, does not count an attempt, and the
 * next pass asks again. Only a launch that really got as far as starting the CLI
 * and failed is an attempt.
 */
function retryable(message) {
  const err = new Error(message)
  err.sandboxRetry = true
  return err
}

/**
 * The runtime is not there AT LAUNCH — a different question from "could not be
 * asked", and the caller has to be able to tell them apart, because §8.1 and
 * `sandboxOutcome()` already answer it one way at PLAN time and the launch path
 * answered it another way entirely.
 *
 * Under `sandbox_mode: 'required'` an unreachable daemon is a refusal: the run
 * must not start unsandboxed. Under `available` (and `optional`) it is a
 * **bypass** — the run starts on the host and the weakening is written down,
 * exactly as it is when the plan sees the same thing a second earlier. A fresh
 * start into a daemon that had just gone away therefore used to end `failed`
 * where the identical situation one function earlier ended in a named bypass.
 *
 * Both marks travel: `sandboxRetry` for a resume (do not spend an attempt), and
 * `sandboxBypassable` plus `sandboxReason` for a caller that may take the plain
 * path instead. Which one the caller acts on is the recovery design's decision,
 * not this module's — this function's job is to hand over an answer it CAN act
 * on rather than one word for two different situations.
 */
function unavailable(message, reason) {
  const err = retryable(message)
  err.sandboxUnavailable = true
  err.sandboxReason = reason ?? 'unknown'
  err.sandboxBypassable = hubSandboxMode() !== 'required'
  return err
}

// ------------------------------------------------------------- names and ids

/** The container this run gets. One name, derived, so nothing has to remember it. */
export function containerName(runId) { return `fl-${runId}` }
/** …and its private network. */
export function networkName(runId) { return `fl-net-${runId}` }
/** Where the run's own HOME lives on the host (§7.7). */
export function homeDir(runId) { return join(RUNS_DIR, String(runId), 'home') }
/** The spec document handed to `fl-start --sandbox` and kept as the audit record (§7.14). */
export function specPath(runId) { return join(RUNS_DIR, String(runId), 'sandbox.json') }

/**
 * The socket path INSIDE the container (§7.6, §7.11). A constant on purpose:
 * the agent-side `fl-report` reads `FL_HUB_SOCKET`, and a path that varied per
 * run would be one more thing every harness's seeded configuration had to know.
 */
export const CONTAINER_HUB_SOCKET = '/run/freilauf/hub.sock'

/**
 * This installation's identity, for the `freilauf.hub=` label that
 * `reconcileContainers()` filters on. Minted once and stored, because the
 * question it answers is "is this container mine, or the e2e suite's?" — two
 * hubs sharing a Docker daemon is the same situation two hubs sharing a tmux
 * server already are, and the answer has to survive a restart.
 */
export function hubId() {
  let id = getSetting('sandbox_hub_id')
  if (!id) { id = kurzid(randomUUID()); setSetting('sandbox_hub_id', id) }
  return id
}

// ------------------------------------------------------------- the hub layer

// The four hub settings — `sandbox_mode`, `sandbox_allow_bypass`,
// `sandbox_lock`, `sandbox_allowed_mount_roots` — used to be read here a second
// time, with rules that did not match the ones in run-def.mjs: `String(v) ===
// '1'` against a comparison with the words that mean no. A stored `'on'`
// therefore meant "the operator may leave the sandbox" to the form and
// "forbidden" to this file, on the one switch where disagreeing readers put the
// break glass behind a button that refuses. There is ONE reader now
// (run-def.mjs, "THE FOUR HUB SANDBOX SETTINGS ARE READ HERE AND NOWHERE
// ELSE"), and this file borrows it — the import is at the top, and it is
// deliberately static even though run-def.mjs is the heavier module: the four
// are `function` declarations on both sides, so the existing cycle through
// scheduler.mjs is walked past hoisted bindings and never touches a value in
// its temporal dead zone. That is the difference between this and the
// `claude.mjs → quota.mjs` ring AGENTS.md has an entry about.

/** `sandbox_mode`, defaulting to `off` — an empty string is "not set", never a mode. */
export function hubSandboxMode() { return sandboxHubMode() }

/** May a lower layer opt out at all (`sandbox_allow_bypass`)? Unset means yes. */
function allowBypass() { return sandboxAllowBypass() }

/** The hub's locked paths — junk means "nothing locked", never a crash. */
function hubLock() { return sandboxLock() }

/**
 * The two hub settings that are spec fields rather than policy: which runtime
 * and which proxy engine.
 *
 * This used to be a COPY of `sandboxHubSpec()` in run-def.mjs, and the copy is
 * the drift this whole file has a comment about one paragraph up: the launch
 * resolved the hub layer WITH those two settings while `sandboxAgainst()` — the
 * baseline every form judges a locked override against — resolved it without
 * them, so on a podman hub with `runtime` locked the form accepted a switch back
 * to docker (against an empty baseline it narrows nothing) and the launch then
 * refused it. There is one reader now, and it is the one AGENTS.md nominates:
 * every place below calls `sandboxHubSpec()` from run-def.mjs.
 */

// --------------------------------------------------------------- discovery

/**
 * The cached discovery answer, for the forms and for the decision at start.
 *
 * Synchronous on purpose — it sits on the launch path and in every form render,
 * exactly like `claudeQuota()` — so the *refresh* is async and fills this, while
 * the *read* is not. A caller that needs the answer to be current (the start
 * decision does: starting a run unsandboxed because a minute-old scan said the
 * daemon was down is the wrong direction to be wrong in) awaits
 * `refreshSandboxAvailability()` first.
 */
let availability = { available: false, reason: 'sandbox.reason.not_scanned', at: 0 }
let scanning = null
const AVAILABILITY_TTL_MS = 60_000

export function sandboxAvailable() { return availability }

export async function refreshSandboxAvailability({ force = false } = {}) {
  // A hard off for the test suites: no scan, no daemon, no ambiguity.
  if (env('SANDBOX_OFF') === '1') {
    availability = { available: false, reason: 'sandbox.reason.switched_off', at: Date.now() }
    return availability
  }
  if (!force && availability.at && Date.now() - availability.at < AVAILABILITY_TTL_MS) return availability
  // The in-flight promise is released BY the promise, never at the end of the
  // body: with no runtime module the body has no `await` at all, so a reset at
  // the end would run before the assignment that set it and every later call
  // would get one stale promise for the life of the process (AGENTS.md has this
  // entry for the usage and balance caches).
  if (scanning) return scanning
  scanning = (async () => {
    const rt = await sibling('runtime')
    if (!rt?.runtimeInfo) return { available: false, reason: 'sandbox.reason.no_runtime_module', at: Date.now() }
    try {
      // The SAME reader as the layering above — `sandbox_runtime` was read
      // here a third time, with a third spelling of "empty means unset".
      const info = await rt.runtimeInfo(sandboxHubSpec()?.runtime ?? null)
      return { ...info, available: !!info?.available, at: Date.now() }
    } catch (err) {
      return { available: false, reason: err.message, at: Date.now() }
    }
  })().then(a => { availability = a; scanning = null; return a },
    err => { scanning = null; throw err })
  return scanning
}

// ------------------------------------------------------------ the decision

/**
 * Can this coding agent be run in a sandbox at all? The plugin's own answer
 * (§7.9): a descriptor with no `sandbox` block declares that it cannot.
 * Fail-soft — an unknown harness is "no", which is what `createRun()` refuses
 * on its own a moment later anyway.
 */
async function sandboxableHarness(harness) {
  try {
    // From the REGISTRY, not from `harnesses/index.mjs`: `sandboxable()` is the
    // validated answer (a malformed `sandbox` block is refused rather than
    // dropped), and the registry is where an external plugin's declaration
    // arrives too.
    const { sandboxable } = await import('../plugins/registry.mjs')
    return !!sandboxable(harness)
  } catch { return false }
}

/**
 * THE decision, made once in `startRun()` before `createRun()` — so the run's
 * row says from its very first moment what it will run as, exactly the way
 * `or_routing` is frozen there.
 *
 * Two halves, and the difference between them is the rule this whole feature
 * hangs on:
 *
 *  - what is READ LIVE, until launch: the repo's sandbox default, its profile
 *    and its overrides, like `repos.prompt` and `repos.base_branch`. Editing
 *    repo config affects the NEXT run, never a running one — but "the next run"
 *    means the next one to be *created*, and that is here.
 *  - what is FROZEN: the resolved spec. `launchRun()` reads `runs.sandbox_spec`
 *    from the row, never the profile again, so a profile edited while a run is
 *    in flight cannot change the container that run is already living in. A
 *    reconfiguration (§7.12.4) is the one thing that writes a new spec, and it
 *    writes it into the row.
 *
 * Returns everything `startRun()` has to write and say:
 *   { sandbox, profileId, overrides, spec, problems, events, refused }
 * `problems` are rendered sentences (the caller renders them next to the form
 * field, like every other start refusal); `events` are `[kind, payload]` pairs
 * the caller writes once the run row exists — a bypass has no run to hang on
 * before `createRun()`.
 */
export async function planSandbox({ repo, agent = null, def = {} } = {}) {
  const plan = { sandbox: 0, profileId: null, overrides: '{}', spec: null, problems: [], events: [], refused: [] }
  const hubMode = hubSandboxMode()
  // The feature does not exist here: no module is loaded, no scan is made, and
  // an installation that never heard of the sandbox pays exactly one settings
  // read for it.
  if (hubMode === 'off') return plan

  const spec = await sibling('spec')
  if (!spec?.decideSandbox) return plan

  const sandboxable = await sandboxableHarness(def.harness)
  const decision = spec.decideSandbox({
    hubMode, allowBypass: allowBypass(),
    repo: repo?.sandbox_default, agent: agent?.sandbox, run: def.sandbox,
    sandboxable,
  })

  // The decision is only half the answer; a container runtime that is not there
  // is the other half (§8.1). Both are folded together by one PURE function, so
  // the whole matrix is testable without a daemon on the machine.
  const av = await refreshSandboxAvailability()
  const outcome = sandboxOutcome({ decision, hubMode, available: av.available, unavailableReason: av.reason })
  plan.problems = outcome.problems
  plan.events = outcome.events
  if (!outcome.sandbox) return plan

  // The layering (§7.3). The innermost profile wins — an agent's `null` means
  // "the repo's", which is why the chain is written out rather than merged.
  const profiles = await sibling('profiles')
  const profileOf = (id) => (id && profiles?.profileSpec ? profiles.profileSpec(id) : null)
  const runProfileId = def.sandboxProfileId ?? agent?.sandbox_profile_id ?? null
  const effectiveProfileId = runProfileId ?? repo?.sandbox_profile_id ?? null

  const resolved = spec.resolveSandboxSpec({
    hub: { spec: sandboxHubSpec(), lock: hubLock() },
    repo: {
      profile: profileOf(repo?.sandbox_profile_id),
      overrides: parseOverrides(repo?.sandbox_overrides),
      spec: repo?.sandbox_image ? { image: { ref: repo.sandbox_image } } : null,
    },
    agentOrRun: {
      profile: runProfileId && runProfileId !== repo?.sandbox_profile_id ? profileOf(runProfileId) : null,
      overrides: parseOverrides(def.sandboxOverrides ?? agent?.sandbox_overrides),
    },
  })

  plan.sandbox = 1
  plan.profileId = effectiveProfileId
  plan.overrides = JSON.stringify(parseOverrides(def.sandboxOverrides ?? agent?.sandbox_overrides) ?? {})
  plan.spec = resolved.spec
  plan.refused = resolved.refused ?? []
  // Every refusal of the layering becomes an event on the run: an override that
  // looks saved and is not in force is the "field that looks like it saved and
  // did not" failure, one layer out.
  for (const r of plan.refused) plan.events.push(['sandbox:override_refused', r])
  return plan
}

/**
 * `decideSandbox()`'s answer + whether a runtime is really there, folded into
 * what `startRun()` writes and says. **Pure** on purpose: this is where §7.3's
 * refusal rule and §8.1's availability rule meet, and both have to be testable
 * over the whole matrix on a machine with no container daemon.
 *
 * Three outcomes and no fourth:
 *   - a **problem**: the hub said `required` and something below said `off`, or
 *     the coding agent cannot be sandboxed, or there is no runtime and the hub
 *     said `required`. The caller renders it and starts nothing. Never a silent
 *     downgrade — a policy that quietly gives way is not a policy.
 *   - a **bypass**: the run starts unsandboxed and the reason is written down
 *     (`opt_out` when a layer asked for it, `unavailable` when the runtime is
 *     not there). An operator who believes their runs are contained and learns
 *     later that Docker was not installed is the worst outcome this feature has.
 *   - `sandbox: 1`, plus one `sandbox:override_refused` per refused override.
 */
export function sandboxOutcome({ decision, hubMode, available, unavailableReason = 'unknown', refused = [] } = {}) {
  const out = { sandbox: 0, problems: [], events: [] }
  if (decision?.refused) {
    out.problems.push(t(decision.refused.reason, { layer: decision.refused.layer ?? '', harness: decision.refused.harness ?? '' }))
    return out
  }
  if (!decision?.sandbox) {
    // Opting out of something that WOULD have been sandboxed is break-glass and
    // is written down; opting out of something that was never going to be is a
    // no-op and says nothing — `decideSandbox()` draws that line, not us.
    if (decision?.bypass) out.events.push(['sandbox:bypassed', { by: decision.bypass.by, reason: 'opt_out' }])
    return out
  }
  if (!available) {
    if (hubMode === 'required') {
      out.problems.push(t('sandbox.launch.runtime_required', { reason: unavailableReason }))
      return out
    }
    out.events.push(['sandbox:bypassed', { by: 'unavailable', reason: unavailableReason }])
    return out
  }
  out.sandbox = 1
  for (const r of refused) out.events.push(['sandbox:override_refused', r])
  return out
}

/**
 * `<repo.path>/.git`, resolved — a repository may itself be a worktree, or use a
 * `.git` FILE pointing elsewhere, and the mask has to be taken from the config
 * that is really in force. Falls back to the obvious path when git cannot be
 * asked, which is the same answer for every ordinary checkout.
 */
async function sourceGitDir(repoPath) {
  const r = await sh('git', ['-C', repoPath, 'rev-parse', '--git-common-dir'])
  const raw = r.ok ? r.stdout.trim() : ''
  return raw ? resolve(repoPath, raw) : join(repoPath, '.git')
}

/** An overrides column or form value as an object; junk is `{}`, never a throw. */
function parseOverrides(v) {
  if (!v) return null
  if (typeof v === 'object') return v
  try {
    const doc = JSON.parse(String(v))
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : null
  } catch { return null }
}

// -------------------------------------------------------------- the start

/**
 * The frozen spec of a run, filled out against the defaults. Read from the ROW,
 * never resolved again: a resume must use the spec the run was reconfigured
 * with, and a profile edited while the run was down must not change the
 * container it comes back into.
 */
async function runSpec(run) {
  const spec = await need('spec')
  let doc = {}
  try { doc = run.sandbox_spec ? JSON.parse(run.sandbox_spec) : {} } catch { doc = {} }
  return spec.normalizeSpec(doc)
}

/**
 * §7.11's start order, and its defining property is that every step is
 * idempotent — because a resume walks exactly this order again:
 *
 *   resolve the spec (from the row) → clone (reused if it exists) → seed the
 *   per-run home → write sandbox.json → create the network only if missing →
 *   start the proxy only if missing → stop any container still holding the name.
 *
 * Any failure BEFORE the tmux session exists removes what it created and throws;
 * `launchRun()` turns that into `failRun()` with the reason. That is §7.10's
 * rule and it is not negotiable: a run that hangs because an image is missing is
 * the worst outcome there is, because every layer above it reads as healthy.
 *
 * Returns what the launch needs: `{ spec, specPath, workdir, home, container,
 * network, proxyUrl, hubSocket, resolvedAllow, env }`.
 */
export async function prepareSandbox(run, repo, opts = {}) {
  const runId = run.id
  const runDir = join(RUNS_DIR, runId)
  const container = containerName(runId)
  const network = networkName(runId)
  const home = homeDir(runId)

  // 0. Can the runtime be ASKED at all? On a fresh start `planSandbox()` has
  //    already answered this a moment ago; on a resume right after a reboot it
  //    is the whole question, and the answer has to be "wait", never "fail"
  //    (§11.3). A daemon that is still starting is not a run that cannot start.
  //    Asked BEFORE anything is created, so a launch that cannot go ahead leaves
  //    the disk exactly as it found it.
  //
  //    `force` on purpose, and the comment on `sandboxAvailable()` already said
  //    why without this call honouring it: the cached answer stands for 60 s,
  //    and a resume right after a reboot is exactly the case where the daemon
  //    came up in that minute. Measured: a resume waited 31 s after the daemon
  //    was back, for nothing. Starting a run against a minute-old "the daemon is
  //    down" is the wrong direction to be wrong in.
  const av = await refreshSandboxAvailability({ force: true })
  if (!av.available) throw unavailable(t('sandbox.launch.runtime_unreachable', { container }), av.reason)
  mkdirSync(runDir, { recursive: true })

  try {
    // 1. The spec, as the row holds it.
    const spec = await runSpec(run)

    // 2. The working copy. `makeSandboxClone()` reuses an existing directory —
    //    a retry and a resume both find their own half-finished work there, and
    //    that is what the run still wants merged.
    const clone = await need('clone')
    const wc = await clone.makeSandboxClone(repo, run, { branch: opts.branch ?? null })

    // 3. The per-run home (§7.7). Created before anything is seeded into it, and
    //    seeded by the HARNESS PLUGIN — the hub does not know what a claude
    //    `.claude.json` or an opencode `auth.json` has to contain, and the
    //    operator's own `~/.claude` is deliberately never mounted.
    mkdirSync(home, { recursive: true, mode: 0o700 })
    const seeded = await seedHarnessHome(run, spec, { workdir: wc.dir, home })

    // 4. The record of what is being launched (§7.14). Written HERE, before the
    //    network and the proxy, so a failure in either still leaves behind the
    //    document that says what was attempted; rewritten at the end with the
    //    proxy's own address, which cannot be known before it is listening.
    // 3b. The mask that goes over the operator's `.git/config` inside the box.
    //
    //     NOT an empty file, and that was measured (§11a.2): emptying a
    //     repository's config silently changes what the repository IS — on a
    //     sha256 repo `git log` reports "your current branch appears to be
    //     broken", and `git ls-remote` answers **exit 0 with an all-zero sha**. A
    //     wrong answer that exits 0 is the same trap as `--no-optional-locks`
    //     reading an empty status as a clean worktree. `writeMaskedGitConfig()`
    //     keeps `core.repositoryformatversion` and the `[extensions]` block, so
    //     the mount stops being a lie about the repository, and drops what can
    //     carry a token (`remote.*`) or name a command (`filter.*`, `merge.*`,
    //     `diff.*`, `uploadpack.*`, the command-shaped `core.*` keys).
    //
    //     A mask that cannot be written is a HARD failure, not a warning: the
    //     alternative is mounting the operator's real config — remote URLs with
    //     credentials in them included — into the container this whole feature
    //     exists to fence off.
    const repoGitDir = await sourceGitDir(repo.path)
    const maskPath = join(runDir, 'masks', 'repo.config')
    mkdirSync(join(runDir, 'masks'), { recursive: true })
    await clone.writeMaskedGitConfig(join(repoGitDir, 'config'), maskPath)

    const binPaths = hubBinPaths()
    const ctx = {
      version: 1, run: runId, hub: hubId(),
      container, network: spec.network?.mode === 'none' ? 'none' : network,
      // `homeDir` is the name BOTH readers of this document use — `fl-start`
      // refuses a spec without `.ctx.homeDir`, and `buildRunArgv()` mounts
      // `ctx.homeDir` — so writing only `home` here made every sandboxed run
      // die at the launcher with "sandbox document has no .ctx.homeDir". `home`
      // travels alongside for the same reason `emptyFile` does below: a name
      // this file already handed out is not taken away in the commit that fixes
      // the other one.
      workdir: wc.dir, homeDir: home, home, runDir, repoGitDir,
      hubSocket: CONTAINER_HUB_SOCKET,
      binPaths,
      // Two names for one path, deliberately and temporarily: `gitConfigMask`
      // says what it is, `emptyFile` is what `runtime.mjs` reads today and is a
      // name that now says something false. The rename crosses files, so the
      // alias travels until that module has moved over.
      gitConfigMask: maskPath, emptyFile: maskPath,
      // Resolved ONCE, from the run's own harness and provider, and handed on
      // to the proxy below as well as recorded here — see `resolveAllowList()`.
      resolvedAllow: await resolveAllowList(spec, repo, run),
      // The hub's CA, where the operator configured one (`sandbox_ca_dir`).
      // `runtime.mjs` mounts it and names it in five environment variables; it
      // used to be consumed there and produced by nobody, so a TLS-terminating
      // proxy handed the container certificates it had no way to trust.
      caPath: hubCaPath(),
      // §7.7's uid table, decided HERE because `buildRunArgv()` cannot know the
      // daemon's posture and deliberately does not guess. Rootful: run as the
      // hub user, so bind-mounted files stay owned by it — and because claude's
      // `bypassPermissions` refuses to run as root. Rootless: `null`, i.e. no
      // `--user` at all, because container root IS the hub user on the host
      // there; a non-root container user would write host files as
      // `subuid + n − 1`, which the hub's own `git status` would then read as
      // somebody else's.
      uid: av.rootless ? null : process.getuid?.() ?? null,
      gid: av.rootless ? null : process.getgid?.() ?? null,
      rootless: !!av.rootless,
      env: containerEnv({ home, binPaths }),
      // What the coding agent's plugin wants changed about its own command line
      // inside the box (§7.9). It travels in the DOCUMENT and not only in the
      // return value, because `fl-start` is the other reader of that command
      // line: `--setting-sources` used to be fl-start's own idea, which made
      // the plugin's declaration and the launcher two authors of one fact. See
      // harnessLaunchOverrides() below.
      launchOverrides: await harnessLaunchOverrides(run, spec),
      proxyUrl: null,
    }
    await writeSpecFile(runId, spec, ctx)

    // A TLS-terminating proxy without a CA in the container is a run whose every
    // HTTPS call fails with a certificate error — so it is a refusal at launch
    // with the setting named, never a start that looks healthy.
    if (spec.network?.tlsTerminate === true && !ctx.caPath) {
      throw new Error(t('sandbox.launch.no_ca'))
    }

    // 5. The network — created only if missing. `internal: true` is what makes
    //    the proxy the only way out: a container on it has no default route.
    //
    //    `isolated` is where the two engines part company, and it is the whole
    //    of §7.5.1's "the proxy is on the internal network *and* on the bridge"
    //    made real. iron-proxy IS a container on this network, so the network
    //    can keep `gateway_mode_ipv4=isolated` and the host stays unreachable
    //    from the box — the strong posture. The built-in engine is a listener in
    //    the HUB PROCESS on the host, so the gateway address is the only way the
    //    container can reach it at all; isolating the gateway away would leave
    //    that run with no egress whatsoever, which is what it had. The cost is
    //    written down in `ensureProxy()` and in SANDBOX_RESEARCH.md.
    if (spec.network?.mode !== 'none' && spec.network?.mode !== 'open') {
      const rt = await sibling('runtime')
      const builtin = (spec.network?.engine ?? 'builtin') === 'builtin'
      if (rt?.createNetwork) {
        const created = await rt.createNetwork(network, {
          runtime: spec.runtime, internal: true, isolated: !builtin,
        })
        // A network that could not be created is a run with no network at all —
        // and under `allowlist` that is a container that reaches nothing while
        // every layer above it reads as healthy. Refuse instead.
        if (created && created.ok === false) {
          throw new Error(t('sandbox.launch.network_failed', { network, reason: created.reason ?? '' }))
        }
      }
    }

    // 6. The proxy — started only if this process is NOT already holding one for
    //    this run. The handle lives in this process, so "already running" is a
    //    question about this process's memory; a hub that was restarted holds
    //    none and starts a new one, which is what makes a resume walk this step
    //    again without leaving a second listener behind.
    //
    //    The port is REMEMBERED across a restart (`portOfRecordedProxy`): the
    //    container's `HTTPS_PROXY` was frozen at creation, so a resumed
    //    built-in listener that took a fresh ephemeral port would be a proxy at
    //    an address nothing points at.
    const proxy = await ensureProxy(run, spec, {
      runDir, network, allow: ctx.resolvedAllow, port: portOfRecordedProxy(runId),
    })
    ctx.proxyUrl = proxy?.url ?? null
    ctx.env = { ...ctx.env, ...(opts.env ?? {}) }

    // 7. An orphan holding the name. A retry, a reconfiguration and a resume all
    //    reuse `fl-<id>`, and `docker run --name` refuses a name that is taken —
    //    so the leftover of the previous attempt goes first, and the verdict
    //    decides: "the daemon did not answer" is not "there is no container",
    //    and starting into an unanswered daemon would collide a moment later.
    await stopOrphan(container, spec.runtime)

    // 8. The container's own lifecycle, into `docker-events.jsonl` (§7.14).
    //    Started here because it has to be listening BEFORE the container is
    //    created: `create` and `start` are the two events nobody can
    //    reconstruct afterwards, and they happen in `fl-start`, seconds from
    //    now.
    startDockerEvents(runId, container, spec)

    await writeSpecFile(runId, spec, ctx)
    db.prepare('UPDATE runs SET sandbox_container=?, sandbox_home=? WHERE id=?').run(container, home, runId)
    if (seeded?.refused?.length) addEvent(runId, 'warn', { seed_home_refused: seeded.refused })
    if (proxy) {
      addEvent(runId, 'sandbox:proxy_started', {
        engine: proxy.engine ?? 'builtin', url: proxy.url ?? null,
        allow: ctx.resolvedAllow, mode: spec.network?.mode ?? null,
        audit_only: !!spec.network?.auditOnly,
      })
    }
    return {
      spec, specPath: specPath(runId), workdir: wc.dir, branch: wc.branch ?? null,
      home, container, network: ctx.network, proxyUrl: ctx.proxyUrl,
      hubSocket: CONTAINER_HUB_SOCKET, resolvedAllow: ctx.resolvedAllow,
      launchOverrides: ctx.launchOverrides,
    }
  } catch (err) {
    // A retryable failure means the runtime could not be ASKED, so there is
    // nothing to tear down and no way to do it — and tearing down would be the
    // wrong idea anyway: the clone, the home and the network are exactly what
    // the next pass wants to find standing.
    if (err?.sandboxRetry) throw err
    // Otherwise: half a sandbox must not outlive the start that failed to build it.
    await teardownSandbox({ ...run, sandbox: 1, sandbox_container: container, sandbox_home: home },
      { reason: 'prepare_failed', removeNetwork: true }).catch(() => {})
    throw err
  }
}

/**
 * What the coding agent's plugin wants changed about its own command line
 * INSIDE a container (`sandbox.launchOverrides`, §7.9). claude answers
 * `{ mode: 'bypassPermissions', settingSources: 'user' }`:
 *
 *  - `mode` reaches `fl-start` as `--mode`. Inside the box there is nothing left
 *    to ask about, and `IS_SANDBOX` — which the plugin sets in its own
 *    `sandbox.env`, and which this file deliberately does not set — is what lets
 *    that mode be accepted as container root under a rootless daemon (§7.7).
 *  - `settingSources` reaches `fl-start` through the sandbox DOCUMENT
 *    (`ctx.launchOverrides`), which is why this answer is computed while the
 *    document is being written rather than only at the end. `fl-start` used to
 *    apply `--setting-sources user` out of its own head while the plugin
 *    declared the same thing and nothing read the declaration — two authors of
 *    one fact, and the disagreement they were heading for is expensive:
 *    measured (§11a.3), six committed lines of `"disableAllHooks": true` in a
 *    repository's own `.claude/settings.json` drop every hook the hub hands
 *    over with `--settings`, and the symptom is a run that simply never
 *    reports.
 *
 * Fail-soft: no declaration, or one that throws, means the ordinary command line.
 */
async function harnessLaunchOverrides(run, spec) {
  try {
    const { sandboxDecl } = await import('../plugins/registry.mjs')
    const fn = sandboxDecl(run.harness)?.launchOverrides
    return typeof fn === 'function' ? (fn({ spec, run }) ?? {}) : {}
  } catch { return {} }
}

/**
 * `sandbox.json`, 0600 — it names hosts, mounts and the run's own paths.
 *
 * The shape is what `fl-start --sandbox` reads: `{ appDir, spec, ctx }`. `appDir`
 * is the hub's own checkout, resolved from THIS FILE rather than from
 * `deployDir()` or the working directory — a hub started by hand out of a
 * checkout is still that checkout's hub, the same `import.meta.url` idiom
 * `skillsSourceDir()` uses and for the same reason — and the wrapper derives
 * `sandbox/wrap.sh` from it. `ctx.cmd` and `ctx.term` are filled in by the
 * launcher, which knows the pane; everything already in `ctx.env` wins over
 * what it adds, which is the right precedence: the hub decided those.
 *
 * IT REFUSES A SYMLINK AT THE TARGET, and that is not belt and braces: this file
 * lands in `~/agents/runs/<id>/`, which `buildRunArgv()` mounts READ-WRITE into
 * the container at the agent's own uid, and it is rewritten on every resume and
 * every reconfiguration. `writeFileSync`'s `'w'` follows a link, so an agent that
 * replaces `sandbox.json` with one gets the hub to write through it as the HUB
 * user on the next launch. `writeFileNoSymlink()` (exec.mjs) is the two-line
 * guard `seedHomeFiles()` already kept; it answers false rather than throwing, so
 * the refusal is turned into the launch failure it is — a run whose `sandbox.json`
 * is somebody else's file must not start, because that file is what
 * `fl-start --sandbox` reads AND the audit record of what was launched.
 */
async function writeSpecFile(runId, spec, ctx) {
  const appDir = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')
  const exec = await need('exec')
  const path = specPath(runId)
  const ok = exec.writeFileNoSymlink(path, JSON.stringify({ version: 1, appDir, spec, ctx }, null, 2), { mode: 0o600 })
  if (!ok) throw new Error(t('sandbox.launch.spec_write_refused', { path }))
}

/**
 * The directories the run's `fl-*` scripts are mounted from — and therefore the
 * directories that have to be on the container's `PATH`.
 *
 * This is not tidiness. The image's own `PATH` does not contain the hub user's
 * home, the run's `HOME` is the per-run one, and the base image adds the
 * directory through `/etc/profile.d`, which a login shell reads and the `bash -c`
 * a run actually is does not. So without this, `fl-report` is not on `PATH`
 * inside the box — and with it goes every claude and cursor hook that calls it
 * by bare name. That is the exact failure shape this hub has the most rules
 * about: the session stands, the pane is alive, the run says `running`, and
 * nothing can ever report.
 */
function hubBinPaths() {
  // The same resolution `flReportPath()` makes in runner.mjs — repeated rather
  // than imported, because runner.mjs imports THIS file and a static import back
  // would close the ring (AGENTS.md, "Pitfalls": claude.mjs and quota.mjs).
  const dirs = new Set([dirname(env('REPORT_SCRIPT') ?? `${homedir()}/.local/bin/fl-report`)])
  const start = env('START_SCRIPT')
  if (start) dirs.add(dirname(start))
  return [...dirs].filter(Boolean)
}

/**
 * The CA certificate the container is to trust, or null. `sandbox_ca_dir` is the
 * operator's setting; `ca.crt` inside it is the file (the same name
 * `runtime.mjs` mounts it under, `CA_TARGET`).
 *
 * It had no producer at all: `ctx.caPath` was read in three places in
 * `runtime.mjs` and written nowhere, so the documented CA mount and the setting
 * behind it were dead code — and under `tlsTerminate` that is a container whose
 * every HTTPS call fails on an unknown issuer. Null is fine where nothing
 * terminates TLS; where something does, `prepareSandbox()` refuses.
 */
function hubCaPath() {
  const dir = String(getSetting('sandbox_ca_dir') ?? '').trim()
  if (!dir) return null
  const file = join(dir, 'ca.crt')
  return existsSync(file) ? file : null
}

/**
 * The port the run's proxy was last recorded at, or 0 for "pick one".
 *
 * A container's `HTTPS_PROXY` is fixed the moment it is created, so a built-in
 * listener that comes back on a fresh ephemeral port after a hub restart is a
 * proxy at an address nothing points at — the agent would keep dialling the old
 * one. The address is in `sandbox.json`, which is written before the launch and
 * is the audit record anyway, so it is also the answer to "which port do I have
 * to be on".
 */
function portOfRecordedProxy(runId) {
  try {
    const url = readSpecFile(runId)?.ctx?.proxyUrl
    if (!url) return 0
    const port = Number(new URL(String(url)).port)
    return Number.isInteger(port) && port > 0 ? port : 0
  } catch { return 0 }
}

/** The image's own login account. Cosmetic — see `containerEnv()`. */
const IMAGE_ACCOUNT = 'agent'

/**
 * The environment every sandboxed run gets, whatever its harness. Pure, so the
 * PATH rule above is assertable without a container.
 *
 * `USER` is deliberately NOT `spec.user`. Those two words look like the same
 * thing and are not: `spec.user` is a POLICY word — `hub` means "the hub's own
 * uid", the answer §7.7's table gives per daemon type — and what actually binds
 * is `--user <uid>:<gid>`, which `ctx.uid` carries. `USER` is a LOGIN NAME, and
 * the only login name that exists inside the box is the one the image's passwd
 * entry declares. Setting `USER=hub` against an image whose account is `agent`
 * would leave a CLI that resolves `$USER` against `/etc/passwd` disagreeing with
 * itself — the class of thing that surfaces as an unexplained failure inside a
 * container nobody can attach to. `FREILAUF_SANDBOX_IMAGE_ACCOUNT` is the seam
 * for an operator image built with a different account name.
 */
export function containerEnv({ home, binPaths = [] }) {
  const base = ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin']
  return {
    HOME: home,
    USER: env('SANDBOX_IMAGE_ACCOUNT') || IMAGE_ACCOUNT,
    PATH: [...binPaths, `${home}/.local/bin`, ...base].filter(Boolean).join(':'),
  }
}

/**
 * The allow list the run really got — for the record, for the prompt (§7.12.1),
 * for the API, for the page AND, since this was the whole defect, for the
 * PROXY.
 *
 * Two things used to go wrong here at once, and they compounded:
 *
 *  - the run's coding agent and model provider were not passed, so the
 *    `harness` and `provider` presets expanded to nothing. `pages.mjs` passed
 *    both, so the page said 23 hosts where the event said 17 — two renderings
 *    of one list, disagreeing about whether the run could reach its own model
 *    API;
 *  - and nothing handed the answer to the proxy at all. `ensureProxy()` started
 *    it from the RAW spec, whose `network.allow` is empty in every shipped
 *    profile (they carry `presets` instead) — so `balanced`, `locked_down`,
 *    `audit` and `open_net` all enforced an EMPTY allow list, which under
 *    default-deny means the container reached nothing whatsoever.
 *
 * One resolution, one list, three readers. `run` is optional because the dry
 * run has no run; there the two plugin presets contribute what the profile's
 * own `network.allow` does and nothing more, which is the honest answer for a
 * check that is not about any particular coding agent.
 */
async function resolveAllowList(spec, repo, run = null) {
  const presets = await sibling('presets')
  if (!presets?.resolvedAllow) return spec?.network?.allow ?? []
  try {
    const originUrl = presets.repoOriginUrl ? await presets.repoOriginUrl(repo?.path) : null
    return presets.resolvedAllow(spec, {
      originUrl, repo,
      harness: run?.harness ?? null,
      provider: run?.provider ?? null,
    })
  } catch { return spec?.network?.allow ?? [] }
}

/**
 * The spec a PROXY is configured from: the same document, with the presets
 * already expanded into `network.allow` and `network.presets` emptied so
 * nothing downstream expands them a second time (or, as it did, not at all).
 *
 * This is the one seam that makes "the list recorded in the event", "the list
 * the agent is told about" and "the list that is enforced" the same three
 * words. Every caller that starts or reloads a proxy goes through it.
 */
export function specForProxy(spec, allow) {
  const list = Array.isArray(allow) ? allow : []
  return { ...(spec ?? {}), network: { ...(spec?.network ?? {}), allow: list, presets: [] } }
}

/**
 * The harness plugin fills the run's home (§7.7, §7.9). Defensive on every
 * side: a plugin may declare no `seedHome` at all (then the home is an empty
 * directory and the CLI makes its own), and one that throws costs a warning,
 * not a start.
 */
async function seedHarnessHome(run, spec, ctx) {
  try {
    const { getHarness } = await import('../harnesses/index.mjs')
    const seed = getHarness(run.harness)?.sandbox?.seedHome
    if (typeof seed !== 'function') return { written: [], refused: [] }
    const files = await seed({ run, spec, ...ctx }) ?? []
    const exec = await sibling('exec')
    if (!exec?.seedHomeFiles) return { written: [], refused: [] }
    return exec.seedHomeFiles({ ...run, sandbox: 1, sandbox_home: ctx.home }, files)
  } catch (err) {
    return { written: [], refused: [{ path: '(seedHome)', reason: err.message }] }
  }
}

// ---------------------------------------------------------------- the proxy

/**
 * The live proxy handles, per run. In memory because the built-in engine IS an
 * http server in this process; the iron-proxy engine's handle is a container
 * name and could be rediscovered, but both go through the same map so a caller
 * never has to know which engine it got.
 */
const proxies = new Map()

/**
 * The run's proxy — started only if this process is not already holding one for
 * it, which is what lets a resume walk this step again without a second listener.
 *
 * Two refusals live here, and both are the same rule: **a promise the profile
 * made must not be quietly downgraded.**
 *
 *  - `network.mode: 'allowlist'` with no proxy module at all is a hard failure.
 *    A container that was supposed to reach four hosts and instead reaches the
 *    whole internet is not a degraded sandbox, it is no sandbox — and nothing on
 *    the page would say so.
 *  - `secrets.mode: 'inject'` needs an engine that terminates TLS (§7.8), and
 *    three of the four seeded profiles ask for it. If that engine will not
 *    start, the run FAILS with the reason. Falling back to `env` would put the
 *    operator's real key inside the very container the profile promised held
 *    nothing but a placeholder — the worst lie this feature could tell, because
 *    it is told to somebody who picked the strict profile in order to be safe.
 *    The question is asked of `engineCapabilities()`, not of an engine's name,
 *    so a third engine that can inject works without touching this file.
 *
 * A `secrets.mode: 'env'` profile whose named engine will not start is the one
 * case that DOES fall back to the built-in CONNECT proxy: nothing was promised
 * there beyond "these hosts and no others", and the built-in engine keeps that
 * promise. The fallback is written down as a warning all the same.
 *
 * `allowFallback: false` switches that one case off, for the one caller that
 * must not have it: reviving a container-engine proxy under a run that is
 * ALREADY GOING (`restoreProxies()`). The fallback remakes the run's network to
 * give the host an address on it — which cannot work while the agent's own
 * container is attached to it, and would not help if it could, since that
 * container's `HTTPS_PROXY` names the proxy container and not the host.
 */
async function ensureProxy(run, spec, { runDir, network, allow, port = 0, allowFallback = true }) {
  const mode = spec.network?.mode ?? 'allowlist'
  if (mode === 'open' || mode === 'none') return null
  const existing = proxies.get(run.id)
  if (existing) return existing

  const proxy = await sibling('proxy')
  if (!proxy?.startProxy) throw new Error(t('sandbox.launch.proxy_unavailable', { mode }))

  const engine = spec.network?.engine ?? 'builtin'
  const wantsInject = (spec.secrets?.mode ?? 'env') === 'inject'
  const caps = proxy.engineCapabilities?.(engine) ?? {}
  if (wantsInject && caps.inject !== true) {
    throw new Error(t('sandbox.launch.inject_needs_engine', { engine }))
  }

  // THE list, resolved once by the caller and handed here. Started from the raw
  // spec, every shipped profile enforced an empty allow list — see
  // `specForProxy()`.
  const effective = specForProxy(spec, allow)

  const ctx = {
    runId: run.id, runDir, hubId: hubId(),
    network: network ?? networkName(run.id),
    secretsMode: spec.secrets?.mode ?? 'env',
    // WHERE THE BUILT-IN LISTENER BINDS, and why it is not a matter of taste.
    //
    // The built-in engine is an HTTP CONNECT listener inside the hub PROCESS, on
    // the host. The agent's container is on a `--internal` network, so the only
    // host address it can reach is that network's own gateway — and on Docker
    // ≥ 28 `gateway_mode_ipv4=isolated` removes even that. The default used to
    // be `127.0.0.1`, which the container resolves to ITSELF: `HTTPS_PROXY`
    // pointed at a port inside the container, every request failed with a
    // connection error, and the hub read `running` throughout. `allowlist` had
    // therefore never worked end to end with this engine.
    //
    // So: the network for a built-in run is created WITHOUT gateway isolation
    // (see the network step in `prepareSandbox()`), and the listener binds to
    // that network's gateway address. What that costs is stated rather than
    // hidden: the container can then also reach host services listening on that
    // bridge — which is why the proxy's own `denyUpstreamCidrs` (loopback,
    // RFC 1918, link-local, CGNAT) is not optional, and why the strong posture
    // is `engine: 'iron-proxy'`, whose proxy is a container and lets the run's
    // network stay isolated. The listener is reachable from this run's network
    // and from the host itself, and from nothing else: a per-run docker bridge
    // is not routed off the machine and Docker isolates it from other networks.
    //
    // `FREILAUF_SANDBOX_PROXY_BIND` stays as the operator's override and now
    // OUTRANKS the gateway, for an installation that publishes the proxy
    // somewhere of its own.
    bind: await builtinBind(engine, network ?? networkName(run.id), spec.runtime, mode),
    port,
    onBlocked: (info) => onBlocked(run.id, info),
  }
  let handle = await proxy.startProxy(run, effective, ctx)
  if (!handle || handle.ok === false) {
    const reason = handle?.reason ?? t('sandbox.launch.proxy_unavailable', { mode })
    if (wantsInject) throw new Error(t('sandbox.launch.proxy_failed', { reason }))
    if (engine === 'builtin' || !allowFallback) throw new Error(t('sandbox.launch.proxy_failed', { reason }))
    // The fallback engine needs a network the HOST has an address on, and the
    // one that was created for iron-proxy deliberately does not have one. No
    // container is on it yet at this point, so it is remade rather than the
    // fallback being turned into a refusal — otherwise the documented
    // "fall back to the built-in engine" would only ever be a launch failure.
    const rtNet = await sibling('runtime')
    if (rtNet?.createNetwork) {
      try {
        await rtNet.removeNetwork?.(ctx.network, { runtime: spec.runtime })
        await rtNet.createNetwork(ctx.network, { runtime: spec.runtime, internal: true, isolated: false })
      } catch { /* builtinBind() below refuses in a sentence if this did not help */ }
    }
    const fallbackCtx = { ...ctx, bind: await builtinBind('builtin', ctx.network, spec.runtime, mode) }
    handle = await proxy.startProxy(run, specForProxy({ ...spec, network: { ...spec.network, engine: 'builtin' } }, allow), fallbackCtx)
    if (!handle || handle.ok === false) throw new Error(t('sandbox.launch.proxy_failed', { reason }))
    addEvent(run.id, 'warn', { proxy_engine_fallback: engine, reason })
  }
  // The proxy's SECOND LEG (§7.5.1: "the proxy is on the internal network *and*
  // on the bridge"). `buildNetworkConnectArgv()` was exported and never called,
  // so an iron-proxy container sat on the internal network alone — with no way
  // out to the internet it was supposed to be the only way to. Idempotent, so a
  // resume walks it again; a failure is fatal, because a proxy that cannot
  // reach anything is a run with no egress and nothing above it would say so.
  if (handle.engine === 'iron-proxy' && handle.container) {
    const rt = await sibling('runtime')
    const bridge = env('SANDBOX_PROXY_UPSTREAM_NETWORK') || 'bridge'
    const r = await rt?.connectNetwork?.(bridge, handle.container, { runtime: spec.runtime })
    if (r && !r.ok) {
      try { await proxy.stopProxy?.(handle) } catch {}
      throw new Error(t('sandbox.launch.proxy_no_egress', { network: bridge, reason: r.reason ?? '' }))
    }
  }
  proxies.set(run.id, handle)
  return handle
}

/**
 * The address the built-in listener binds to for one run — the operator's
 * override, else the run network's own gateway. A `null` gateway is a REFUSAL
 * and not a fall back to loopback: loopback inside the container is the
 * container, and a proxy variable pointing there is exactly the silent
 * no-egress run this whole change exists to end.
 */
async function builtinBind(engine, network, runtime, mode) {
  const override = env('SANDBOX_PROXY_BIND')
  if (override) return String(override)
  if (engine !== 'builtin') return '0.0.0.0'
  const rt = await sibling('runtime')
  if (!rt?.networkGateway) throw new Error(t('sandbox.launch.proxy_unavailable', { mode }))
  const g = await rt.networkGateway(network, { runtime })
  if (!g?.address) throw new Error(t('sandbox.launch.proxy_unreachable', { network, reason: g?.reason ?? '' }))
  return g.address
}

/**
 * A denial, from the proxy. Deduplicated per host per ten minutes (§7.12.1): a
 * single 403 may be exactly what the policy intended, and an event per blocked
 * request would bury the run's own history under one npm install.
 */
const blockedSeen = new Map()
const BLOCK_DEDUPE_MS = 10 * 60_000
function onBlocked(runId, info) {
  try {
    // `action` decides WHICH event this is, and dropping it was the whole
    // defect: an audit-only run's `would_deny` — a request that WENT THROUGH
    // and was merely counted — was written as `sandbox:blocked`, byte for byte
    // like a real 403. The incident rule reads that kind, so the rollout mode
    // that exists to be silent raised a RED incident saying two hosts had been
    // turned away, on a run where nothing was. Same family as every other
    // "an alarm that fires for a working agent" entry in AGENTS.md.
    //
    // `sandbox:would_block` is the learning record §7.12.5 wants — it is what
    // the repo page grows an allow list out of — and nothing escalates on it.
    const audit = info?.action === 'would_deny'
    const kind = audit ? 'sandbox:would_block' : 'sandbox:blocked'
    const key = `${runId}|${kind}|${info?.host ?? ''}`
    const last = blockedSeen.get(key) ?? 0
    if (Date.now() - last < BLOCK_DEDUPE_MS) return
    blockedSeen.set(key, Date.now())
    addEvent(runId, kind, {
      host: info?.host ?? null, method: info?.method ?? null,
      count: info?.count ?? 1, at: info?.at ?? new Date().toISOString(),
      action: info?.action ?? 'deny', audit_only: audit,
    })
  } catch { /* a denial that could not be recorded must not break the proxy */ }
}

// ------------------------------------------------------ the container's log

/**
 * `docker events --filter container=fl-<id>` for the life of the run, one JSON
 * line each into `docker-events.jsonl` (§7.14).
 *
 * WHY THE HUB CANNOT ANSWER THIS ITSELF, which is the whole reason the file
 * exists: `create`, `start`, `die` with its exit code, `oom` and `exec_create`
 * are facts about a container that is gone by the time anybody asks. The hub
 * learns the exit code, and only if it happens to look; it never learns that
 * the kernel's OOM killer was the reason, or that something ran an `exec` in
 * there. An auditor asks exactly those.
 *
 * FAIL-SOFT IN EVERY DIRECTION, and the direction that matters most is the
 * process: the child is `unref`ed and detached from the run's fate is not
 * assumed — `stopDockerEvents()` kills it from `teardownSandbox()`, which runs
 * on every path a run can end, including twice and including on a machine with
 * no runtime at all. A daemon that answers nothing, a `docker` that is not
 * there, a line that is not JSON: all of them cost the line and never the run.
 *
 * The filter is set BEFORE the container exists on purpose. `docker events`
 * matches the filter against each event's own actor, so a name that appears
 * later is matched from its first event — which is the only way `create` and
 * `start` are ever seen.
 */
const eventTails = new Map()

function startDockerEvents(runId, container, spec) {
  if (spec?.audit?.dockerEvents === false) return
  if (eventTails.has(runId)) return
  // Claimed before the first await: two prepare passes racing must not each
  // spawn a tail, and the placeholder is what makes the check above true for
  // the second one.
  eventTails.set(runId, null)
  ;(async () => {
    try {
      const rt = await sibling('runtime')
      if (!rt?.runtimeBin) { eventTails.delete(runId); return }
      const { spawn } = await import('node:child_process')
      const child = spawn(rt.runtimeBin(spec?.runtime), [
        'events', '--filter', `container=${container}`, '--format', '{{json .}}',
      ], { stdio: ['ignore', 'pipe', 'ignore'], detached: false })
      child.on('error', () => {})
      child.unref?.()
      // A tail that was torn down while this was starting must not outlive it.
      if (!eventTails.has(runId)) { try { child.kill('SIGTERM') } catch {} ; return }
      eventTails.set(runId, child)
      let rest = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        rest += chunk
        const lines = rest.split('\n')
        rest = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          let j
          try { j = JSON.parse(line) } catch { continue }
          // `at` is what the audit export sorts the whole stream by, so it is
          // ISO 8601 here like every other record — the daemon's own
          // `timeNano` is nanoseconds since the epoch and would sort as a
          // number among timestamps.
          const at = Number.isFinite(Number(j.timeNano)) && Number(j.timeNano) > 0
            ? new Date(Number(j.timeNano) / 1e6).toISOString()
            : new Date().toISOString()
          appendAuditFile(runId, 'docker-events.jsonl', {
            at, run: String(runId), status: j.status ?? j.Action ?? null,
            id: j.id ?? j.Actor?.ID ?? null, from: j.from ?? j.Actor?.Attributes?.image ?? null,
            exit_code: j.Actor?.Attributes?.exitCode ?? null,
            attributes: j.Actor?.Attributes ?? null,
          })
        }
      })
      child.stdout.on('error', () => {})
      child.on('exit', () => { if (eventTails.get(runId) === child) eventTails.delete(runId) })
    } catch { eventTails.delete(runId) }
  })()
}

/** Stop the tail. Idempotent, and safe for a run that never had one. */
function stopDockerEvents(runId) {
  if (!eventTails.has(runId)) return
  const child = eventTails.get(runId)
  eventTails.delete(runId)
  try { child?.kill?.('SIGTERM') } catch {}
}

// ---------------------------------------------------------------- secrets

/**
 * Which environment variables of this run carry a credential — the plugins'
 * own answer (§7.8, `sandbox.credentials` in the descriptor, falling back to the
 * ordinary `credentials`/`envKeys` declaration). Asked of the run's provider and
 * of its coding agent, because a subscription CLI has no provider and a
 * provider-based one has both.
 *
 * The answer is a map rather than a set, because `inject` needs to know how that
 * credential may be swapped in (`injection: { header, prefix, hosts }`, see
 * docs/plugins.md). `injection` is `null` where the plugin declared none, and
 * that is a statement rather than a gap — cursor deliberately declares its
 * `CURSOR_API_KEY` without one, because which header cursor sends it in is
 * nowhere established.
 */
async function secretDeclarations(run) {
  const out = new Map()
  try {
    const { getPlugin } = await import('../plugins/registry.mjs')
    const { credentialSpec } = await import('../plugins/store.mjs')
    for (const id of [run.provider, run.harness].filter(Boolean)) {
      const plugin = getPlugin(id)?.plugin ?? getPlugin(id)
      if (!plugin) continue
      const declared = Array.isArray(plugin.sandbox?.credentials) ? plugin.sandbox.credentials : credentialSpec(plugin)
      for (const c of declared ?? []) {
        const inj = c?.injection && Array.isArray(c.injection.hosts) && c.injection.hosts.length
          ? { header: c.injection.header || 'Authorization', prefix: c.injection.prefix ?? '', hosts: c.injection.hosts.map(String) }
          : null
        for (const k of c?.envKeys ?? []) out.set(String(k), { plugin: id, key: c?.key ?? String(k), injection: inj })
      }
    }
  } catch { /* an unanswerable question masks nothing, which is `env` mode */ }
  return out
}

/**
 * §7.8's `inject` mode, applied to the environment a session is about to be
 * given: the container gets a **placeholder**, and the proxy is told what to
 * swap it for, on requests to that credential's own hosts and nowhere else.
 *
 * `pairs` is `[{ name, value }]` and comes back the same shape. Under
 * `secrets.mode: 'env'` it comes back untouched, which is what every run does
 * today; under `none` the credentials are dropped entirely (the CLI's seeded
 * auth file is its authentication then).
 *
 * If the engine cannot be handed the table, the launch FAILS rather than
 * proceeding. Two ways to be wrong here and both are worse than a refusal: put
 * the real key in, and the profile's promise was a lie; put the placeholder in
 * with nobody swapping it, and every API call 401s on a run that looks healthy.
 *
 * The same rule answers the credential the PLUGIN cannot inject. A variable
 * whose plugin declares no `injection` is documented as "not available for
 * injection, which is a working configuration and not a defect" — under `env`.
 * Under `inject` there is no third answer for it: passing the real value would
 * be the lie, and a placeholder would be the 401. So the launch refuses and
 * names the variable, which is a sentence an operator can act on ("this coding
 * agent needs `secrets.mode: env`").
 */
export async function applySecrets(run, spec, pairs) {
  const mode = spec?.secrets?.mode ?? 'env'
  if (mode === 'env') return { pairs, injected: [] }
  const decls = await secretDeclarations(run)
  if (!decls.size) return { pairs, injected: [] }

  if (mode === 'none') {
    return { pairs: pairs.filter(p => !decls.has(p.name)), injected: [] }
  }

  const table = []
  const undeclared = []
  const out = pairs.map(p => {
    const decl = decls.get(p.name)
    if (!decl || !p.value) return p
    if (!decl.injection) { undeclared.push(p.name); return p }
    const placeholder = `fl-token-${randomUUID().replaceAll('-', '')}`
    table.push({ name: p.name, key: decl.key, placeholder, value: p.value, ...decl.injection })
    return { name: p.name, value: placeholder }
  })
  if (undeclared.length) {
    throw new Error(t('sandbox.launch.inject_no_declaration', { vars: undeclared.join(', ') }))
  }
  if (!table.length) return { pairs: out, injected: [] }

  const proxy = await sibling('proxy')
  const handle = proxies.get(run.id)
  if (!proxy?.setSecrets || !handle) throw new Error(t('sandbox.launch.inject_unsupported'))
  const applied = await proxy.setSecrets(handle, table)
  // The answer is CHECKED, and this is the whole point of the refusal being a
  // value rather than an exception: an engine that cannot inject says so, and
  // the caller turns that into a failed run with the reason on it. An
  // unchecked call here would put placeholders in the container and let the
  // run start against a proxy that swaps nothing.
  if (!applied?.ok) throw new Error(t('sandbox.launch.inject_failed', { reason: applied?.reason ?? '' }))
  return { pairs: out, injected: table.map(e => e.name) }
}

// ------------------------------------------------------------- the teardown

/**
 * The reverse of `prepareSandbox()`, and it has to be safe in three situations
 * that all really happen: on a run that was never sandboxed, twice in a row, and
 * on a machine with no container runtime at all. So every step is guarded, every
 * failure is swallowed, and the function never throws.
 */
export async function teardownSandbox(run, opts = {}) {
  const runId = run?.id ?? null
  const container = run?.sandbox_container || (runId ? containerName(runId) : null)
  const out = { container: null, proxy: false, network: false }
  // Before the early return, and deliberately: a `docker events` tail is a
  // process, and a process that outlives the run it was watching is exactly
  // what "must not keep a process alive past the run" means. Idempotent and
  // free for a run that never had one.
  if (runId) stopDockerEvents(runId)
  if (!run?.sandbox && !opts.force) return out

  // The proxy first: it is ours, it is cheap to stop, and stopping it before the
  // container means the agent's last requests are refused rather than tunnelled
  // into a teardown.
  const handle = runId ? proxies.get(runId) : null
  if (handle) {
    try { const proxy = await sibling('proxy'); await proxy?.stopProxy?.(handle) } catch { /* fail-soft */ }
    proxies.delete(runId)
    out.proxy = true
  }

  const rt = await sibling('runtime')
  const runtime = await runtimeOf(run)
  if (container && rt?.stopContainer) {
    try {
      await rt.stopContainer(container, { runtime, timeoutSec: opts.timeoutSec ?? 30 })
      if (rt.removeContainer) await rt.removeContainer(container, { runtime, force: true })
      out.container = container
    } catch { /* a container that will not stop is the reconciler's problem, not the caller's */ }
  }
  // The network survives a reboot (the daemon persists it) and is worth nothing
  // afterwards, so it goes with the run — but only when the caller says the run
  // is really over: a reconfiguration stops the container and starts another one
  // on the same network.
  if (runId && opts.removeNetwork !== false && rt?.removeNetwork) {
    try { await rt.removeNetwork(networkName(runId), { runtime }); out.network = true } catch { /* fail-soft */ }
  }
  // The dedupe keys carry the host (and now the kind), so deleting the bare
  // `<id>|` deleted nothing at all and every finished run's hosts stayed in this
  // map for the life of the process.
  if (runId) for (const k of [...blockedSeen.keys()]) if (k.startsWith(`${runId}|`)) blockedSeen.delete(k)
  return out
}

/**
 * Bring back the proxies of runs that are still going after a HUB RESTART
 * (§8.19's `sandbox:proxy_restarted`, which was promised and never written).
 *
 * The built-in engine is a listener inside the hub process and the `proxies`
 * Map is in-process only, so a restart takes it with it — while the container
 * keeps running with `HTTPS_PROXY` pointing at the port that has just died.
 * From that moment every request the agent makes fails with a connection error
 * and the hub reads `running` throughout. This hub restarts 164 times in 30
 * days, so that is the ordinary case rather than the edge one.
 *
 * Three properties, each of them the reason it works at all:
 *
 *  - **the same port**. `portOfRecordedProxy()` reads it out of the run's own
 *    `sandbox.json`; a fresh ephemeral port would be a listener nothing dials.
 *  - **the same list**. The spec is read from the ROW, and the allow list is
 *    resolved from it exactly as at launch — a restart must not quietly widen
 *    or narrow what the run was started with.
 *  - **idempotent and fail-soft**. A run this process already holds a handle for
 *    is skipped; a run whose proxy cannot be brought back gets a `warn` event
 *    and is left alone, never failed — the agent may well be between requests,
 *    and ending somebody's work over a listener is worse than the listener.
 *
 * AN ENGINE WHOSE PROXY IS A CONTAINER is the §8.19 case next door, and it is
 * answered here rather than in the reaper — the reaper's business is a container
 * that should be gone, and starting one means `ensureProxy()`, which lives in
 * this file. A hub restart does NOT cost such a run its proxy: the daemon kept
 * the container running and the agent goes on dialling it by name. What the
 * restart costs is the HANDLE, and one thing on it cannot be recovered — the
 * management API key is minted per launch (`randomBytes`, ironproxy.mjs) and
 * lives only in that container's environment. So the two states are answered
 * differently, and the difference is positive evidence as usual:
 *
 *  - **the proxy container is running** → left alone. Nothing is restarted
 *    around a working proxy to recover a handle, and no handle is fabricated
 *    for it either: one that cannot reach `/v1/reload` would let
 *    `changePolicy()` believe it had delivered a policy it did not. The honest
 *    answer there is the refusal that function now gives.
 *  - **the daemon says the container is gone** (or exists and is not running) →
 *    started again, because that IS a run with no egress at all: every request
 *    the agent makes fails with a connection error while the hub reads
 *    `running` throughout, which is the worst shape a fault can take.
 *  - **the daemon did not answer** → nothing. `tmuxVerdict()`'s rule one layer
 *    over: not knowing is a reason to wait, never a reason to act.
 *
 * The revive deliberately does NOT take `ensureProxy()`'s fallback to the
 * built-in engine. That fallback REMAKES the run's network, and on a live run
 * the agent's container is sitting on it — while `HTTPS_PROXY` names the proxy
 * CONTAINER, which a listener on the host does not answer to. A fallback that
 * is right at launch is destructive here.
 */
export async function restoreProxies() {
  if (hubSandboxMode() === 'off') return { restored: [], skipped: [] }
  const out = { restored: [], skipped: [] }
  let rows = []
  try {
    rows = db.prepare(
      `SELECT * FROM runs WHERE sandbox=1 AND status IN ('running','waiting_help') AND tmux_closed_at IS NULL`).all()
  } catch { return out }
  for (const row of rows) {
    if (proxies.has(row.id)) { out.skipped.push(row.id); continue }
    try {
      const spec = await runSpec(row)
      const mode = spec.network?.mode ?? 'allowlist'
      if (mode === 'open' || mode === 'none') { out.skipped.push(row.id); continue }
      const engine = spec.network?.engine ?? 'builtin'
      const repo = db.prepare('SELECT * FROM repos WHERE id=?').get(row.repo_id) ?? null
      let port = 0
      if (engine === 'builtin') {
        // The port the container is already dialling. A fresh ephemeral one
        // would be a listener nothing talks to.
        port = portOfRecordedProxy(row.id)
        if (!port) { out.skipped.push(row.id); continue }
      } else if (!(await containerProxyGone(row, spec))) {
        // Running, or the daemon said nothing. Both mean "do not touch it".
        out.skipped.push(row.id); continue
      }
      const allow = await resolveAllowList(spec, repo, row)
      const handle = await ensureProxy(row, spec, {
        runDir: join(RUNS_DIR, String(row.id)), network: networkName(row.id), allow, port,
        // See the block comment: the built-in fallback remakes the run's network,
        // and this run's agent is on it.
        allowFallback: engine === 'builtin',
      })
      if (handle) {
        addEvent(row.id, 'sandbox:proxy_restarted', {
          engine: handle.engine ?? engine, url: handle.url ?? null, allow, mode,
          container: handle.container ?? null,
        })
        out.restored.push(row.id)
      } else out.skipped.push(row.id)
    } catch (err) {
      addEvent(row.id, 'warn', { proxy_restart_failed: err?.message || String(err) })
      out.skipped.push(row.id)
    }
  }
  return out
}

/**
 * Is this run's PROXY CONTAINER demonstrably not running? Only `true` counts as
 * a reason to start one: an unanswered daemon and a container that is up both
 * answer `false`, and a container that exists but has exited is removed first so
 * the name is free (`docker run` would otherwise collide with the corpse).
 */
async function containerProxyGone(row, spec) {
  const rt = await sibling('runtime')
  if (!rt?.containerState || !rt?.proxyName) return false
  const container = rt.proxyName(row.id)
  const state = await rt.containerState(container, { runtime: spec.runtime })
  const verdict = state?.verdict ?? (rt.runtimeVerdict ? rt.runtimeVerdict(state) : 'ok')
  if (verdict !== 'ok') return false
  if (state?.running) return false
  if (state?.exists) await rt.removeContainer?.(container, { runtime: spec.runtime, force: true })
  return true
}

/** Which runtime a run was started with — its own frozen spec, never the setting. */
async function runtimeOf(run) {
  try {
    const exec = await sibling('exec')
    return exec?.specOf?.(run)?.runtime ?? undefined
  } catch { return undefined }
}

/**
 * Stop whatever still answers to a container name. The verdict decides, and that
 * is `tmuxVerdict()`'s lesson applied one layer over: "the daemon did not
 * answer" is not "there is no container". Starting into an unanswered daemon
 * would collide on the name a second later, so an `unreachable` verdict is a
 * reason to refuse the start, not to hope.
 */
async function stopOrphan(container, runtime) {
  const rt = await sibling('runtime')
  if (!rt?.containerState) return
  const state = await rt.containerState(container, { runtime })
  const verdict = state?.verdict ?? (rt.runtimeVerdict ? rt.runtimeVerdict(state) : 'ok')
  // `unreachable` is "the hub learned nothing", so it is a RETRYABLE failure —
  // never an attempt against the resume cap (§11.3).
  if (verdict === 'unreachable') throw retryable(t('sandbox.launch.runtime_unreachable', { container }))
  if (!state?.exists) return
  if (state.running && rt.stopContainer) await rt.stopContainer(container, { runtime, timeoutSec: 30 })
  if (rt.removeContainer) await rt.removeContainer(container, { runtime, force: true })
}

// ---------------------------------------------------------- reconciliation

/**
 * The watcher's pass over what the daemon is actually holding (§7.11).
 *
 * Two directions, and neither may act on a guess:
 *   - a container whose run is over and whose session is closed is stopped and
 *     removed (hermes' orphan reaper, with its rule that a RUNNING container of
 *     a run still in flight is never reaped);
 *   - a run that says it is sandboxed and whose container is gone gets
 *     `sandbox:container_gone`. Whether that ENDS the run is the recovery
 *     design's decision, not this module's — the watcher owns it.
 *
 * `unreachable` does nothing at all. A daemon that stopped for thirty seconds
 * must not end every sandboxed run on the machine, which is exactly what a
 * reconciler reading "no containers" out of an unanswered question would do.
 */
// The watcher owns the reaper, and this is the one place that says so.
//
// There were two implementations of this for a while, and two reapers over one
// daemon is exactly the drift `run-def.mjs` exists to prevent — with the twist
// that here the wrong answer does not merely disagree, it KILLS A WORKING
// AGENT. The watcher's is the one that is right and tested: it reads
// `tmux_closed_at` rather than an empty `tmux_session` (nothing in this hub ever
// NULLs that column), it knows §8.18's `stop_orphan` case, it honours
// `retention: 'keep'`, and it does nothing at all on a hub that has the sandbox
// off and never sandboxed a run — without which a machine with no Docker binary
// would read a `docker ps` ENOENT as silence every thirty seconds and eventually
// raise `docker_unreachable` about a feature nobody switched on.
//
// It is re-exported here rather than moved, because the facade is what the rest
// of the hub imports and a caller should not have to know which module happens
// to hold the loop.
export { reconcileContainers } from '../watcher.mjs'

// ------------------------------------------------------ changing a policy

/**
 * Which spec paths can be changed on a container that is already running, and
 * which need a new one (§7.12.3). The table is written out in both directions
 * and the DEFAULT is `restart`, deliberately: a change nobody classified must
 * not be applied "live" and then quietly not be in force — a policy the operator
 * believes is enforced and is not is worse than one that cost a restart.
 *
 * Live:
 *   - the network policy — allow, deny, presets, methods, audit-only. The proxy
 *     rewrites its rules and the agent's very next retry succeeds; a tightening
 *     applies to the next connection, which is what §7.12.3 accepts.
 *   - memory, memory-swap, cpus, pids — `docker update` documents all four for a
 *     running container.
 *   - what is merely recorded: retention, the audit switches.
 *
 * Restart (Docker cannot change any of these on a running container):
 *   - every filesystem field — a mount, a wider tmpfs, read-only root, the
 *     protected paths;
 *   - the image, the runtime, the user, `innerSandbox`;
 *   - `network.mode` and `network.engine` and `tlsTerminate` — the container's
 *     network is chosen at creation, and so is whether there is a proxy at all;
 *   - `secrets.mode` — the environment is set at creation;
 *   - `resources.shmSize` and `resources.diskTmpfs` — creation-time sizes.
 */
export const LIVE_POLICY_PATHS = [
  'network.allow', 'network.deny', 'network.presets', 'network.methods',
  'network.auditOnly', 'network.denyUpstreamCidrs',
  'resources.memory', 'resources.memorySwap', 'resources.cpus', 'resources.pidsLimit',
  'resources.maxRuntimeMinutes',
  'retention', 'audit',
]

/** Which of those need the proxy told, and which need `docker update`. */
const PROXY_PATHS = new Set(['network.allow', 'network.deny', 'network.presets', 'network.methods',
  'network.auditOnly', 'network.denyUpstreamCidrs', 'audit'])
const LIMIT_PATHS = new Set(['resources.memory', 'resources.memorySwap', 'resources.cpus', 'resources.pidsLimit'])

/**
 * Split a patch into what can be applied to the running container and what
 * cannot. Pure, so the table above is testable without a daemon.
 *
 * A patch is a partial spec document (`{ network: { allow: [...] } }`); its
 * dotted leaf paths are what is classified. A path under a live prefix is live;
 * everything else — including a path nobody has heard of — needs a restart.
 */
export function classifyPolicyPatch(patch) {
  const live = [], restart = []
  for (const path of leafPaths(patch ?? {})) {
    (LIVE_POLICY_PATHS.some(p => path === p || path.startsWith(`${p}.`)) ? live : restart).push(path)
  }
  return {
    live, restart,
    needsRestart: restart.length > 0,
    proxy: live.some(p => PROXY_PATHS.has(topTwo(p))),
    limits: live.some(p => LIMIT_PATHS.has(topTwo(p))),
  }
}

/**
 * Every locked path a patch would LOOSEN, as `{path, kept}` — the params of
 * `sandbox.problem.locked`, so the caller's sentence is the one the form
 * already says.
 *
 * The baseline is `sandboxAgainst()`, the resolved layer above this run; where
 * that cannot be computed but a lock IS set, the run's own current spec stands
 * in — never "no baseline, no check", because that is exactly how the form's
 * copy of this rule came to be dead code.
 */
function lockedLoosenings(spec, patch, current, repoId) {
  const lock = hubLock()
  if (!lock?.length || !patch || typeof patch !== 'object') return []
  let baseline = null
  try {
    // The same function the form calls, from the same module the four hub
    // settings already come from — and it is asked only where a lock is really
    // set, because it reaches the profile store and the repo row.
    baseline = sandboxAgainst(repoId ?? null, lock)
  } catch { baseline = null }
  if (!baseline) baseline = current
  const out = []
  for (const path of spec.specPaths(patch)) {
    if (!spec.pathLocked(path, lock)) continue
    const kept = specValueAt(baseline, path)
    if (!spec.narrow(path, kept, specValueAt(patch, path)).refused) continue
    out.push({ path, kept: JSON.stringify(kept) })
  }
  return out
}

/** One dotted path out of a spec document. `undefined` where the layer is silent. */
function specValueAt(doc, path) {
  let cur = doc
  for (const part of String(path).split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = cur[part]
  }
  return cur
}

/** `network.allow.0` → `network.allow`; the classification is about the FIELD. */
function topTwo(path) { return path.split('.').slice(0, 2).join('.') }

/** Every leaf of a partial document, dotted. An array or a null IS a leaf. */
function leafPaths(doc, prefix = '') {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return prefix ? [prefix] : []
  const out = []
  for (const [k, v] of Object.entries(doc)) {
    const path = prefix ? `${prefix}.${k}` : k
    // A plain object one level deep under `harness`, `tmpfsSizes` or `image` is
    // still the field being changed, not a container of fields — but recursing
    // is right for `network`/`resources`/`filesystem`, so recurse and let the
    // prefix match above catch both.
    out.push(...(v && typeof v === 'object' && !Array.isArray(v) ? leafPaths(v, path) : [path]))
  }
  return out
}

/**
 * Change a running run's sandbox policy (§7.12.2, §7.12.3, §7.12.4).
 *
 * `patch` is a partial spec; `by` says who asked (`user`, `repo`, `flow`). The
 * split above decides what happens:
 *
 *  - **live** — the new spec is written into `runs.sandbox_spec`, the proxy is
 *    reloaded and/or `docker update` is run, and `sandbox:policy_changed
 *    {by, diff}` records both ends. The agent's next retry succeeds; nothing is
 *    typed into its session and nothing is interrupted.
 *  - **restart** — the run is RECONFIGURED AND RESUMED (§7.12.4). It is not
 *    thrown away: `resumeRun()` closes the books on the old session, launches
 *    the harness's resume form in the new container, and the agent keeps its
 *    conversation.
 *
 * A LIVE CHANGE HAS TWO HALVES AND THEY ARE DELIVERED SEPARATELY — §7.12.3
 * splits it that way and the answer has to say so. The network rules go to the
 * proxy, `memory`/`cpus`/`pidsLimit` go to `docker update`, and a patch may
 * carry one, the other or both. So each half is attempted on its own merits
 * (a limits-only patch never asks after a proxy) and the ANSWER is derived
 * from what really landed rather than from having reached the end of the
 * function:
 *
 *   | asked for | delivered | answer |
 *   |---|---|---|
 *   | one half | that half | `ok: true` |
 *   | one half | nothing | `ok: false`, that half's own reason |
 *   | both | both | `ok: true` |
 *   | both | one | `ok: false, partial: true`, and the reason names the half that did not land |
 *
 * The invariant is the one this function was rewritten for: **the hub never
 * reports a change it did not make.** It used to be broken in both directions
 * at once. A missing proxy handle — the state this hub is in after every
 * restart — was reported as a success, so an operator clicked "Allow for this
 * run", was told it had worked, and the agent kept hitting the same wall; the
 * fix for that then refused the WHOLE call, so a patch that raised a memory
 * limit lost its limits half to a proxy it never needed. `applied` was already
 * the right shape for the honest answer, and it was written before it was
 * read: `applied.limits = true` was set for a `docker update` that had
 * answered `ok: false` (that function returns a verdict, it does not throw),
 * which is the same lie one field over.
 *
 * `applied` is the truth per half, `partial` says the two disagree, and the
 * event carries `enforced` so a run's own record says whether the policy it
 * now names is the policy in force. The spec row is written either way and
 * that is deliberate (see below): a change nothing could deliver TODAY is
 * still what the next resume must come back with.
 */
export async function changePolicy(run, patch, by = 'user') {
  const row = typeof run === 'string' ? db.prepare('SELECT * FROM runs WHERE id=?').get(run) : run
  if (!row) return { ok: false, error: 'run not found' }
  if (!row.sandbox) return { ok: false, error: t('sandbox.launch.not_sandboxed') }
  const spec = await sibling('spec')
  if (!spec) return { ok: false, error: t('sandbox.launch.module_missing', { module: 'spec.mjs' }) }

  const before = await runSpec(row)

  // THE FLOOR IS CHECKED HERE TOO, and that is the point of this block rather
  // than a duplicated line. This function is a public export: the "Reconfigure…"
  // card reaches it, a flow may, the read/write API may, and a future caller
  // certainly will. It used to merge the patch field by field and narrow
  // NOTHING of its own — so §7.3's one rule held only because `pages.mjs`
  // happened to validate first, and the day it stopped (it had, once: the route
  // passed `lock` and no `against`, so the check inside
  // `validateSandboxOverrides()` never ran) one POST turned a locked
  // `network.mode` from `allowlist` into `open` and froze it into
  // `runs.sandbox_spec` for the rest of the run.
  //
  // Judged against the SAME baseline the form judges against — hub plus this
  // run's repo — so a caller that already passed the form's check can never be
  // refused here for a different reading of the same rule; and a lock that
  // could not be resolved falls back to the run's own current spec rather than
  // to no check at all.
  const refusals = lockedLoosenings(spec, patch, before, row.repo_id)
  if (refusals.length) {
    return {
      ok: false, refused: refusals,
      error: refusals.map(r => t('sandbox.problem.locked', r)).join(' · '),
    }
  }

  const kind = classifyPolicyPatch(patch)
  const after = spec.normalizeSpec(mergeDeep(before, patch ?? {}))
  const diff = { paths: [...kind.live, ...kind.restart], live: kind.live, restart: kind.restart }

  if (kind.needsRestart) return reconfigureAndResume(row, after, { by, reason: 'policy_change', diff })

  // Live. The row is written FIRST — a resume a second later (a lost session, a
  // reboot) has to come back with the policy the operator just asked for, not
  // with the one they just replaced.
  db.prepare('UPDATE runs SET sandbox_spec=? WHERE id=?').run(JSON.stringify(after), row.id)

  const applied = { proxy: false, limits: false }
  // One sentence per half that was asked for and did not land. It is what the
  // caller renders, so it is a translated sentence and not a code — and there
  // is one per half rather than one per call, because "the limits are in force
  // and the network rules are not" is two facts and the operator has to act on
  // the second one.
  const unapplied = []

  if (kind.proxy) {
    let handle = proxies.get(row.id)
    const proxy = await sibling('proxy')
    // NO HANDLE is the state this hub is in after every restart. So the missing
    // handle is answered by trying to bring the proxy back first (a restart is
    // exactly what `restoreProxies()` exists for) and, where that cannot be
    // done, by a refusal the caller can render — never by a quiet `ok: true`.
    if (!handle) {
      try { await restoreProxies() } catch { /* fail-soft */ }
      handle = proxies.get(row.id)
    }
    if (!handle) {
      addEvent(row.id, 'warn', { proxy_reload_failed: 'no_proxy' })
      unapplied.push(t('sandbox.launch.proxy_gone'))
    } else if (!proxy?.reloadProxy) {
      // A handle with nothing left to reload it: proxy.mjs is gone from under a
      // running hub. Rare, and still a network change that did not happen.
      addEvent(row.id, 'warn', { proxy_reload_failed: 'no_module' })
      unapplied.push(t('sandbox.launch.module_missing', { module: 'proxy.mjs' }))
    } else {
      // The answer is READ. `applied.proxy = true` used to be written whatever
      // came back, so a reload the engine refused — an iron-proxy whose
      // management listener the hub cannot reach is the case that really
      // happens — still told the page and the event log that the new policy was
      // in force. A policy that quietly did not apply is worse than one that
      // did not change: the operator stops watching.
      // The RESOLVED list again, for the same reason it is resolved at launch:
      // a reload handed the raw spec would replace a working allow list with
      // the profile's unexpanded (and therefore empty) one — a policy change
      // that switched the run's egress off.
      const repo = db.prepare('SELECT * FROM repos WHERE id=?').get(row.repo_id) ?? null
      const allow = await resolveAllowList(after, repo, row)
      const r = await proxy.reloadProxy(handle, specForProxy(after, allow))
      applied.proxy = r?.ok === true
      if (!applied.proxy) {
        addEvent(row.id, 'warn', { proxy_reload_failed: r?.reason ?? 'unknown' })
        unapplied.push(t('sandbox.launch.proxy_reload_refused', { reason: r?.reason ?? 'unknown' }))
      }
    }
  }

  if (kind.limits) {
    const rt = await sibling('runtime')
    // No runtime module and no container are the same fact from here: there is
    // nothing for `docker update` to act on, so the new limits are recorded and
    // not in force. Saying so is the whole rule; it used to be a silent skip.
    if (!rt?.updateLimits || !row.sandbox_container) {
      addEvent(row.id, 'warn', { docker_update: row.sandbox_container ? 'no_runtime' : 'no_container' })
      unapplied.push(t('sandbox.launch.limits_no_container'))
    } else {
      try {
        // `updateLimits()` RETURNS a verdict rather than throwing — a daemon
        // that did not answer, a container that is gone and a refused flag all
        // come back as `ok: false`. Reading only the exception was the same
        // defect the proxy half above carries the comment for.
        const r = await rt.updateLimits(row.sandbox_container, after.resources, { runtime: after.runtime })
        applied.limits = r?.ok === true
        if (!applied.limits) {
          const reason = r?.gone ? 'container gone' : (r?.reason || r?.verdict || 'unknown')
          addEvent(row.id, 'warn', { docker_update: reason })
          unapplied.push(t('sandbox.launch.limits_failed', { reason }))
        }
      } catch (err) {
        addEvent(row.id, 'warn', { docker_update: err.message })
        unapplied.push(t('sandbox.launch.limits_failed', { reason: err.message }))
      }
    }
  }

  const enforced = unapplied.length === 0
  const partial = !enforced && (applied.proxy || applied.limits)
  addEvent(row.id, 'sandbox:policy_changed', { by, diff, applied, live: true, enforced })
  if (enforced) return { ok: true, live: true, applied, spec: after }
  return {
    ok: false, live: true, partial, applied, spec: after,
    error: [partial ? t('sandbox.launch.policy_partial') : null, ...unapplied].filter(Boolean).join(' · '),
  }
}

/**
 * §7.12.4, in the order the section spells out — and the order is not cosmetic,
 * it is what stops a watcher pass one second later from starting a second resume
 * with the OLD spec:
 *
 *   1. the new spec into `runs.sandbox_spec` AND `resume_pending = 1`,
 *   2. `sandbox:restarting {reason, diff}`,
 *   3. stop the container,
 *   4. close the tmux session,
 *   5. `resumeRun()` — a DIRECT call, because "the hub does not resume a session
 *      it ended itself" is a rule about the watcher not undoing a deliberate
 *      kill, and a caller that closed the session in order to resume it is the
 *      opposite case.
 *
 * Step 1 is one statement and it comes first for one reason: between step 3 and
 * step 5 this run has no session, and a watcher pass landing in that window
 * would otherwise decide the session was LOST and start a resume of its own —
 * with the spec it read before this function wrote the new one. The mark makes
 * that pass find a run already on its way; the spec makes even a pass that wins
 * the race resume with the right policy. `resumeRun()`'s own guard against a
 * pending run is what would then refuse OUR call, so step 5 passes
 * `adoptPending` — the guard exists to stop two watcher passes launching one
 * run twice, and a caller that set the mark itself is not that.
 */
async function reconfigureAndResume(row, spec, { by, reason, diff, resumeText = null }) {
  // Step 1, both halves in one statement: the new spec AND the mark. Whoever
  // resumes this run from here on — us, or a watcher pass that finds the session
  // gone one second from now — resumes it with the spec the operator just asked
  // for, and sees a run already on its way rather than starting a second one.
  db.prepare('UPDATE runs SET sandbox_spec=?, resume_pending=1 WHERE id=?').run(JSON.stringify(spec), row.id)
  addEvent(row.id, 'sandbox:restarting', { reason, by, diff })

  const rt = await sibling('runtime')
  if (rt?.stopContainer && row.sandbox_container) {
    try { await rt.stopContainer(row.sandbox_container, { runtime: spec.runtime, timeoutSec: 30 }) } catch { /* fail-soft */ }
    try { await rt.removeContainer?.(row.sandbox_container, { runtime: spec.runtime, force: true }) } catch { /* fail-soft */ }
  }
  // The proxy goes with it: the new container gets a new one from the new spec,
  // and a listener left behind would be a second one for the same run.
  const handle = proxies.get(row.id)
  if (handle) {
    try { const proxy = await sibling('proxy'); await proxy?.stopProxy?.(handle) } catch { /* fail-soft */ }
    proxies.delete(row.id)
  }
  await closeSession(row)

  const { resumeRun } = await import('../runner.mjs')
  const text = resumeText ?? RECONFIGURE_PROMPT.replace('{diff}', (diff?.paths ?? []).join(', ') || 'the sandbox policy')
  // `adoptPending` because step 1 set the mark: `resumeRun()`'s guard is there
  // to stop two watcher passes launching one run twice, and a caller that set
  // the mark itself in order to resume is the opposite case.
  const r = await resumeRun(row.id, {
    reason: reason === 'bypass' ? 'sandbox_bypass' : 'sandbox_reconfigure', text, adoptPending: true,
  })
  return { ok: !!r?.ok, live: false, resumed: r, spec }
}

/**
 * The continuation an agent reads after a reconfiguration. It says what changed,
 * in place of the recovery design's "interrupted by a server restart" sentence —
 * an agent told only "continue" retries whatever it was blocked on without
 * knowing that the block is gone.
 */
export const RECONFIGURE_PROMPT = `Your session was restarted because the sandbox this run works in was reconfigured: {diff}. Your conversation up to the restart is what you see above; the working copy is exactly as you left it.

{context}

Continue the task from where you were. If you were blocked by the sandbox before the restart, try that step again — the change was made for it. Everything the platform rules said still applies: commit your work, write the two report files and run \`fl-report done\` exactly as instructed.`

/**
 * Close the run's tmux session, the way every deliberate end does — but for a
 * run that is about to be RESUMED, not ended.
 *
 * `killSessions()` reaches `reconcileClosedSession()`, and that function's whole
 * job is to decide that a run whose session went away is over: it writes
 * `aborted`, and `resumeRun()` a moment later refuses a run that is not running.
 * Measured twice live — a reconfigure produced `[sandbox:restarting, aborted]`
 * and `resumed {ok:false}`, and the break-glass answered "the change could not
 * be applied" after `sandbox=0` and the container were already gone.
 *
 * `resume_pending` is what tells that reconciler this closure is a step in a
 * resume rather than an end, so it is set HERE, before the session is touched,
 * for every caller — `reconfigureAndResume()` sets it in the same statement as
 * the new spec, and the break-glass had nothing at all. Setting it twice costs
 * nothing; not setting it costs the run.
 */
async function closeSession(row) {
  if (!row.tmux_session) return
  try { db.prepare('UPDATE runs SET resume_pending=1 WHERE id=?').run(row.id) } catch { /* fail-soft */ }
  try {
    const { killSessions } = await import('../sessions.mjs')
    await killSessions([row.tmux_session])
  } catch (err) { console.warn(`[sandbox] session ${row.tmux_session} not closed: ${err.message}`) }
}

// ------------------------------------------------------------- break-glass

/**
 * "Continue without the sandbox" (§7.12.4). The escape hatch, and every part of
 * it is deliberate:
 *
 *  - only when `sandbox_allow_bypass` permits it. A hub whose operator switched
 *    that off has no break-glass, which is the whole point of switching it off.
 *  - `runs.sandbox = 0`, the container down, and the run RESUMED on the host —
 *    in the same clone, with its commits and its working state.
 *  - **`HOME` stays the run's own home**, which is what makes this a resume
 *    rather than a fresh start: the harness's conversation lives in there
 *    (`~/agents/runs/<id>/home/.claude/projects/…`), and pointing the resumed
 *    CLI at the operator's host home would lose it. `runs.sandbox_home` is
 *    therefore kept — `agentHome()` reads it, and `launchRun()` passes it on.
 *  - the credentials are re-seeded for real. Under `secrets.mode: 'inject'` the
 *    old container held placeholders and the proxy did the swapping; on the host
 *    there is no proxy, so the run continues in `env` mode.
 *  - `sandbox:bypassed {by: 'user', reason}` — an explicit, named, notified act.
 *
 * Where a harness cannot be made to work this way, `resumeRun()` falls back to a
 * fresh launch with the original prompt and SAYS so in its own `resumed` event
 * (`resume_form: 'fresh'`) — that is its documented behaviour for a coding agent
 * with no resume form, and it is the honest answer here too.
 */
export async function continueWithoutSandbox(runId, { by = 'user', reason = '' } = {}) {
  const row = db.prepare('SELECT * FROM runs WHERE id=?').get(runId)
  if (!row) return { ok: false, error: 'run not found' }
  if (!row.sandbox) return { ok: false, error: t('sandbox.launch.not_sandboxed') }
  if (!allowBypass()) return { ok: false, error: t('sandbox.problem.bypass_not_allowed', { layer: 'hub' }) }

  const spec = await runSpec(row).catch(() => null)
  // `sandbox = 0` first: from this moment `launchRun()` takes the plain path,
  // whoever calls it. The home is deliberately NOT cleared — see above.
  db.prepare('UPDATE runs SET sandbox=0 WHERE id=?').run(runId)
  db.prepare(`UPDATE runs SET sandbox_spec=? WHERE id=?`)
    .run(JSON.stringify({ ...(spec ?? {}), secrets: { ...(spec?.secrets ?? {}), mode: 'env' } }), runId)
  addEvent(runId, 'sandbox:bypassed', { by, reason: String(reason ?? '').slice(0, 500) })

  // §7.12.4 calls this "an explicit, named, NOTIFIED act", and it was the first
  // two only. Channel-neutral through `server/notify.mjs` (the hub names no
  // channel anywhere), muted for a run whose operator unticked the box — the
  // same rule every other message about a run keeps — and fail-soft in every
  // direction: an installation with nothing configured is a complete
  // installation, and a break-glass must not fail because nobody is listening.
  try {
    if (row.telegram_on !== 0) {
      const { notify } = await import('../notify.mjs')
      await notify({
        kind: 'sandbox_bypassed', runId,
        text: t('sandbox.notify.bypassed', {
          title: row.title ?? runId, by,
          reason: String(reason ?? '').trim() || t('sandbox.notify.bypassed_no_reason'),
        }),
      })
    } else {
      addEvent(runId, 'notify_muted', { type: 'sandbox_bypassed' })
    }
  } catch { /* a message that could not be sent must not stop the break-glass */ }

  await teardownSandbox({ ...row, sandbox: 1 }, { reason: 'bypass', removeNetwork: true })
  // The mark BEFORE the session goes — `closeSession()` sets it, and it is what
  // stops the reconciler from aborting a run this function is in the middle of
  // resuming (see there).
  await closeSession(row)
  const { resumeRun } = await import('../runner.mjs')
  const r = await resumeRun(runId, {
    reason: 'sandbox_bypass', adoptPending: true,
    text: BYPASS_PROMPT.replace('{reason}', String(reason ?? '').trim() || 'a human decided the sandbox was in the way'),
  })
  // A resume that did not take leaves a real state behind — `sandbox = 0`, the
  // container gone, the work intact — so the answer says so instead of a bare
  // "the change could not be applied". The sandbox IS off; what failed is the
  // relaunch, and that is what the operator has to act on.
  if (!r?.ok) {
    addEvent(runId, 'warn', { bypass_resume_failed: r?.error ?? r?.reason ?? 'unknown' })
    return { ok: false, bypassed: true, resumed: r, error: t('sandbox.launch.bypass_resume_failed') }
  }
  return { ok: true, bypassed: true, resumed: r }
}

export const BYPASS_PROMPT = `Your session was restarted WITHOUT the sandbox: {reason}. You are now running directly on the host, with the same working copy and the same task. Your conversation up to the restart is what you see above.

{context}

Continue the task from where you were. Whatever the sandbox was blocking is no longer blocked — but you are now working on a real machine, so stay inside your working directory and do not change anything outside it. Everything the platform rules said still applies: commit your work, write the two report files and run \`fl-report done\` exactly as instructed.`

// ---------------------------------------------------------------- dry run

/**
 * §7.12.5: start the image with the resolved spec and NO agent, and check the
 * things a policy is usually wrong about — the working copy is reachable, the
 * allow list really answers, a host that must fail really fails, and the tmpfs
 * sizes are what they were asked to be.
 *
 * Its value is entirely in being a button somebody presses BEFORE a run: Claude
 * Code's devcontainer verifies its own firewall exactly this way, and the
 * difference between a policy somebody tested and one somebody hopes is right is
 * this table.
 */
export async function dryRun(repoOrSpec) {
  const av = await refreshSandboxAvailability({ force: true })
  if (!av.available) return { ok: false, reason: av.reason ?? 'unavailable', checks: [] }
  const specMod = await sibling('spec')
  if (!specMod) return { ok: false, reason: 'sandbox.launch.module_missing', checks: [] }

  const repo = repoOrSpec && typeof repoOrSpec === 'object' && 'path' in repoOrSpec ? repoOrSpec : null
  const resolved = repo
    ? specMod.resolveSandboxSpec({
        hub: { spec: sandboxHubSpec(), lock: hubLock() },
        repo: {
          profile: (await sibling('profiles'))?.profileSpec?.(repo.sandbox_profile_id) ?? null,
          overrides: parseOverrides(repo.sandbox_overrides),
        },
      })
    : { spec: specMod.normalizeSpec(repoOrSpec ?? {}), refused: [] }

  const allow = await resolveAllowList(resolved.spec, repo)
  const rt = await sibling('runtime')
  const checks = []
  if (rt?.dryRunChecks) {
    // The runtime module owns anything that really starts a container; a hub
    // whose runtime module cannot do it yet still gets the resolved answer,
    // which is most of what the button is for.
    try { checks.push(...await rt.dryRunChecks(resolved.spec, { allow, repo })) }
    catch (err) { checks.push({ name: 'runtime', ok: false, detail: err.message }) }
  }
  // Deliberately no event: `events.run_id` is NOT NULL, and a dry run has no run
  // to hang one on — it exists precisely so that no run has to be spent finding
  // out. The page renders the table; the record is the page.
  return { ok: checks.every(c => c.ok !== false), spec: resolved.spec, allow, refused: resolved.refused, checks }
}

// ------------------------------------------------------------------ helpers

/** A partial document laid over a full one. Arrays REPLACE — a patch that says `allow: [...]` means that list. */
function mergeDeep(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch ?? base
  const out = { ...(base ?? {}) }
  for (const [k, v] of Object.entries(patch)) {
    out[k] = (v && typeof v === 'object' && !Array.isArray(v) && base?.[k] && typeof base[k] === 'object' && !Array.isArray(base[k]))
      ? mergeDeep(base[k], v) : v
  }
  return out
}

/**
 * The facts the agent's prompt names (§7.12.1) — read from what the run really
 * launched with, never from a profile, so the sentence in the prompt and the
 * container the agent is in cannot say different things.
 */
export function sandboxPromptFacts(prep) {
  if (!prep) return null
  const spec = prep.spec ?? {}
  return {
    workdir: prep.workdir ?? null,
    mode: spec.network?.mode ?? 'allowlist',
    allow: prep.resolvedAllow ?? spec.network?.allow ?? [],
    auditOnly: !!spec.network?.auditOnly,
    memory: spec.resources?.memory ?? null,
    cpus: spec.resources?.cpus ?? null,
    readOnlyRoot: spec.filesystem?.readOnlyRoot !== false,
  }
}

/** Is there a sandbox spec on disk for this run? Used by the resume path's checks. */
export function specFileExists(runId) { return existsSync(specPath(runId)) }

/** The spec document as it was last launched — the audit record, read back. */
export function readSpecFile(runId) {
  try { return JSON.parse(readFileSync(specPath(runId), 'utf8')) } catch { return null }
}
