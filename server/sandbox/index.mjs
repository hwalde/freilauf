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
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import db, { addEvent, getSetting, setSetting } from '../db.mjs'
import { RUNS_DIR, kurzid, sh } from '../util.mjs'
import { env } from '../env.mjs'
import { t } from '../i18n.mjs'

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

/** `sandbox_mode`, defaulting to `off` — an empty string is "not set", never a mode. */
export function hubSandboxMode() {
  const v = String(getSetting('sandbox_mode') ?? '').trim()
  return ['off', 'available', 'default_on', 'required'].includes(v) ? v : 'off'
}

/**
 * May a lower layer opt out at all (`sandbox_allow_bypass`)? Unset means yes:
 * an operator who wants opting out to be impossible has `required`, and a
 * default of "no" would turn `default_on` into a second, undocumented `required`
 * for every installation that never saved the field.
 */
function allowBypass() {
  const v = getSetting('sandbox_allow_bypass')
  if (v === undefined || v === null || String(v).trim() === '') return true
  return String(v) === '1'
}

/** The hub's locked paths — junk means "nothing locked", never a crash. */
function hubLock() {
  try {
    const v = JSON.parse(String(getSetting('sandbox_lock') ?? '[]'))
    return Array.isArray(v) ? v.filter(x => typeof x === 'string') : []
  } catch { return [] }
}

/**
 * The two hub settings that are spec fields rather than policy: which runtime
 * and which proxy engine. Read here rather than in the runtime module so the
 * layering sees them like any other statement about the spec — a repo may then
 * still narrow them where the hub locked the path.
 */
function hubSpec() {
  const spec = {}
  const runtime = String(getSetting('sandbox_runtime') ?? '').trim()
  if (runtime) spec.runtime = runtime
  const engine = String(getSetting('sandbox_proxy_engine') ?? '').trim()
  if (engine) spec.network = { ...(spec.network ?? {}), engine }
  return Object.keys(spec).length ? spec : null
}

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
      const info = await rt.runtimeInfo(String(getSetting('sandbox_runtime') ?? '').trim() || null)
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
    hub: { spec: hubSpec(), lock: hubLock() },
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
  const av = await refreshSandboxAvailability()
  if (!av.available) throw retryable(t('sandbox.launch.runtime_unreachable', { container }))
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
      workdir: wc.dir, home, runDir, repoGitDir,
      hubSocket: CONTAINER_HUB_SOCKET,
      binPaths,
      // Two names for one path, deliberately and temporarily: `gitConfigMask`
      // says what it is, `emptyFile` is what `runtime.mjs` reads today and is a
      // name that now says something false. The rename crosses files, so the
      // alias travels until that module has moved over.
      gitConfigMask: maskPath, emptyFile: maskPath,
      resolvedAllow: await resolveAllowList(spec, repo),
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
      proxyUrl: null,
    }
    writeSpecFile(runId, spec, ctx)

    // 5. The network — created only if missing. `internal: true` is what makes
    //    the proxy the only way out: a container on it has no default route.
    if (spec.network?.mode !== 'none' && spec.network?.mode !== 'open') {
      const rt = await sibling('runtime')
      if (rt?.createNetwork) await rt.createNetwork(network, { runtime: spec.runtime, internal: true })
    }

    // 6. The proxy — started only if one is already running for this run. The
    //    handle lives in this process, so "already running" is a question about
    //    this process's memory; a hub that was restarted starts a new one, which
    //    is what makes a resume walk this step again without a second listener.
    const proxy = await ensureProxy(run, spec, { runDir })
    ctx.proxyUrl = proxy?.url ?? null
    ctx.env = { ...ctx.env, ...(opts.env ?? {}) }

    // 7. An orphan holding the name. A retry, a reconfiguration and a resume all
    //    reuse `fl-<id>`, and `docker run --name` refuses a name that is taken —
    //    so the leftover of the previous attempt goes first, and the verdict
    //    decides: "the daemon did not answer" is not "there is no container",
    //    and starting into an unanswered daemon would collide a moment later.
    await stopOrphan(container, spec.runtime)

    writeSpecFile(runId, spec, ctx)
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
      launchOverrides: await harnessLaunchOverrides(run, spec),
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
 *  - `settingSources` is NOT passed on from here, and that is deliberate rather
 *    than an omission: `fl-start` applies `--setting-sources user` by itself for
 *    every sandboxed claude run, because it is a property of being sandboxed at
 *    all. Measured (§11a.3): six committed lines of `"disableAllHooks": true` in
 *    a repository's own `.claude/settings.json` drop every hook the hub hands
 *    over with `--settings`, and the symptom is a run that simply never reports.
 *    Two places passing the same flag is how one of them ends up not passing it.
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
 */
function writeSpecFile(runId, spec, ctx) {
  const appDir = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')
  writeFileSync(specPath(runId), JSON.stringify({ version: 1, appDir, spec, ctx }, null, 2), { mode: 0o600 })
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

/** The allow list the run really got, for the record and for the prompt (§7.12.1). */
async function resolveAllowList(spec, repo) {
  const presets = await sibling('presets')
  if (!presets?.resolvedAllow) return spec?.network?.allow ?? []
  try {
    const originUrl = presets.repoOriginUrl ? await presets.repoOriginUrl(repo?.path) : null
    return presets.resolvedAllow(spec, { originUrl, repo })
  } catch { return spec?.network?.allow ?? [] }
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
 */
async function ensureProxy(run, spec, { runDir }) {
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

  const ctx = {
    runId: run.id, runDir, hubId: hubId(),
    secretsMode: spec.secrets?.mode ?? 'env',
    // The bind is a seam: the built-in proxy runs in the hub process, so a
    // container on an INTERNAL network reaches it only through the daemon's own
    // gateway address. Loopback is the safe default (nothing outside the machine
    // can reach it) and `FREILAUF_SANDBOX_PROXY_BIND` is how an operator running
    // the built-in engine points it at the bridge instead.
    bind: env('SANDBOX_PROXY_BIND') ?? '127.0.0.1',
    onBlocked: (info) => onBlocked(run.id, info),
  }
  let handle = await proxy.startProxy(run, spec, ctx)
  if (!handle || handle.ok === false) {
    const reason = handle?.reason ?? t('sandbox.launch.proxy_unavailable', { mode })
    if (wantsInject) throw new Error(t('sandbox.launch.proxy_failed', { reason }))
    if (engine === 'builtin') throw new Error(t('sandbox.launch.proxy_failed', { reason }))
    handle = await proxy.startProxy(run, { ...spec, network: { ...spec.network, engine: 'builtin' } }, ctx)
    if (!handle || handle.ok === false) throw new Error(t('sandbox.launch.proxy_failed', { reason }))
    addEvent(run.id, 'warn', { proxy_engine_fallback: engine, reason })
  }
  proxies.set(run.id, handle)
  return handle
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
    const key = `${runId}|${info?.host ?? ''}`
    const last = blockedSeen.get(key) ?? 0
    if (Date.now() - last < BLOCK_DEDUPE_MS) return
    blockedSeen.set(key, Date.now())
    addEvent(runId, 'sandbox:blocked', {
      host: info?.host ?? null, method: info?.method ?? null,
      count: info?.count ?? 1, at: info?.at ?? new Date().toISOString(),
    })
  } catch { /* a denial that could not be recorded must not break the proxy */ }
}

// ---------------------------------------------------------------- secrets

/**
 * Which environment variables of this run carry a credential — the plugins'
 * own answer (§7.8, `sandbox.credentials` in the descriptor, falling back to the
 * ordinary `credentials`/`envKeys` declaration). Asked of the run's provider and
 * of its coding agent, because a subscription CLI has no provider and a
 * provider-based one has both.
 */
async function secretEnvNames(run) {
  const names = new Set()
  try {
    const { getPlugin } = await import('../plugins/registry.mjs')
    const { credentialSpec } = await import('../plugins/store.mjs')
    for (const id of [run.provider, run.harness].filter(Boolean)) {
      const plugin = getPlugin(id)?.plugin ?? getPlugin(id)
      if (!plugin) continue
      const declared = Array.isArray(plugin.sandbox?.credentials) ? plugin.sandbox.credentials : credentialSpec(plugin)
      for (const c of declared ?? []) for (const k of c?.envKeys ?? []) names.add(String(k))
    }
  } catch { /* an unanswerable question masks nothing, which is `env` mode */ }
  return names
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
 */
export async function applySecrets(run, spec, pairs) {
  const mode = spec?.secrets?.mode ?? 'env'
  if (mode === 'env') return { pairs, injected: [] }
  const names = await secretEnvNames(run)
  if (!names.size) return { pairs, injected: [] }

  if (mode === 'none') {
    return { pairs: pairs.filter(p => !names.has(p.name)), injected: [] }
  }

  const table = []
  const out = pairs.map(p => {
    if (!names.has(p.name) || !p.value) return p
    const placeholder = `fl-token-${randomUUID().replaceAll('-', '')}`
    table.push({ name: p.name, placeholder, value: p.value })
    return { name: p.name, value: placeholder }
  })
  if (!table.length) return { pairs: out, injected: [] }

  const proxy = await sibling('proxy')
  const handle = proxies.get(run.id)
  if (!proxy?.setSecrets || !handle) throw new Error(t('sandbox.launch.inject_unsupported'))
  await proxy.setSecrets(handle, table)
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
  if (runId) blockedSeen.delete(`${runId}|`)
  return out
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
export async function reconcileContainers(id = hubId()) {
  const out = { verdict: 'ok', stopped: [], gone: [] }
  const rt = await sibling('runtime')
  if (!rt?.listOwned) return { ...out, verdict: 'no_runtime' }
  let listing
  try { listing = await rt.listOwned(id, {}) } catch (err) { return { ...out, verdict: 'unreachable', reason: err.message } }
  const verdict = listing?.verdict ?? 'ok'
  out.verdict = verdict
  if (verdict !== 'ok') return out

  const seen = new Set()
  for (const c of listing.containers ?? []) {
    seen.add(c.runId ?? '')
    const run = c.runId ? db.prepare('SELECT * FROM runs WHERE id=?').get(c.runId) : null
    const terminal = run && ['done', 'failed', 'aborted'].includes(run.status)
    // "Its session is closed" is `tmux_closed_at`, NOT an empty `tmux_session`:
    // nothing in this hub ever NULLs that column — `reconcileClosedSession()`
    // and the kill route both write the timestamp and leave the NAME standing,
    // because the name is how a human finds the session in the log afterwards.
    // A reaper that asked `!run.tmux_session` would therefore never fire on a
    // real installation, and every orphan would sit there for ever.
    const sessionClosed = !run?.tmux_session || !!run?.tmux_closed_at
    // A container with no run at all is a leftover of a database that was
    // replaced (a test sandbox, a restored backup): the label says it is ours.
    if (!run || (terminal && sessionClosed)) {
      try {
        await rt.stopContainer(c.name, { runtime: c.runtime, timeoutSec: 30 })
        await rt.removeContainer?.(c.name, { runtime: c.runtime, force: true })
        out.stopped.push(c.name)
        if (run) await teardownSandbox(run, { reason: 'reconcile' })
      } catch { /* the next pass tries again */ }
    }
  }

  // The other direction: a live sandboxed run whose container the listing did
  // not name. Only from a verdict of `ok` — that is the whole point of asking.
  const live = db.prepare(`SELECT * FROM runs WHERE sandbox=1 AND status IN ('running','waiting_help')`).all()
  for (const run of live) {
    if (seen.has(run.id)) continue
    if (!run.sandbox_container) continue
    addEvent(run.id, 'sandbox:container_gone', { container: run.sandbox_container })
    out.gone.push(run.id)
  }
  return out
}

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
 */
export async function changePolicy(run, patch, by = 'user') {
  const row = typeof run === 'string' ? db.prepare('SELECT * FROM runs WHERE id=?').get(run) : run
  if (!row) return { ok: false, error: 'run not found' }
  if (!row.sandbox) return { ok: false, error: t('sandbox.launch.not_sandboxed') }
  const spec = await sibling('spec')
  if (!spec) return { ok: false, error: t('sandbox.launch.module_missing', { module: 'spec.mjs' }) }

  const before = await runSpec(row)
  const kind = classifyPolicyPatch(patch)
  const after = spec.normalizeSpec(mergeDeep(before, patch ?? {}))
  const diff = { paths: [...kind.live, ...kind.restart], live: kind.live, restart: kind.restart }

  if (kind.needsRestart) return reconfigureAndResume(row, after, { by, reason: 'policy_change', diff })

  // Live. The row is written FIRST — a resume a second later (a lost session, a
  // reboot) has to come back with the policy the operator just asked for, not
  // with the one they just replaced.
  db.prepare('UPDATE runs SET sandbox_spec=? WHERE id=?').run(JSON.stringify(after), row.id)
  const applied = { proxy: false, limits: false }
  if (kind.proxy) {
    const handle = proxies.get(row.id)
    const proxy = await sibling('proxy')
    if (handle && proxy?.reloadProxy) { await proxy.reloadProxy(handle, after); applied.proxy = true }
  }
  if (kind.limits) {
    const rt = await sibling('runtime')
    if (rt?.updateLimits && row.sandbox_container) {
      try {
        await rt.updateLimits(row.sandbox_container, after.resources, { runtime: after.runtime })
        applied.limits = true
      } catch (err) { addEvent(row.id, 'warn', { docker_update: err.message }) }
    }
  }
  addEvent(row.id, 'sandbox:policy_changed', { by, diff, applied, live: true })
  return { ok: true, live: true, applied, spec: after }
}

/**
 * §7.12.4, in the order the section spells out — and the order is not cosmetic,
 * it is what stops a watcher pass one second later from starting a second resume
 * with the OLD spec:
 *
 *   1. the new spec into `runs.sandbox_spec`,
 *   2. `sandbox:restarting {reason, diff}`,
 *   3. stop the container,
 *   4. close the tmux session,
 *   5. `resumeRun()` — a DIRECT call, because "the hub does not resume a session
 *      it ended itself" is a rule about the watcher not undoing a deliberate
 *      kill, and a caller that closed the session in order to resume it is the
 *      opposite case.
 *
 * One deviation from the section's literal wording, and it is worth stating:
 * §7.12.4 marks the row `resume_pending` in step 1. `resumeRun()` REFUSES a run
 * that is already marked pending — the mark is its own — so pre-marking here
 * would turn the direct call in step 5 into a no-op and the run would sit down
 * until a watcher pass picked it up. Writing the SPEC first buys the same thing
 * the mark was there to buy: whoever resumes this run, us or the watcher,
 * resumes it with the new spec. The watcher winning that race is a correct
 * outcome, not a bug, and step 5 then answers `{ pending: true }`.
 */
async function reconfigureAndResume(row, spec, { by, reason, diff, resumeText = null }) {
  db.prepare('UPDATE runs SET sandbox_spec=? WHERE id=?').run(JSON.stringify(spec), row.id)
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
  const r = await resumeRun(row.id, { reason: reason === 'bypass' ? 'sandbox_bypass' : 'sandbox_reconfigure', text })
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

/** Close the run's tmux session, the way every deliberate end does. Fail-soft. */
async function closeSession(row) {
  if (!row.tmux_session) return
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

  await teardownSandbox({ ...row, sandbox: 1 }, { reason: 'bypass', removeNetwork: true })
  await closeSession(row)
  const { resumeRun } = await import('../runner.mjs')
  const r = await resumeRun(runId, {
    reason: 'sandbox_bypass',
    text: BYPASS_PROMPT.replace('{reason}', String(reason ?? '').trim() || 'a human decided the sandbox was in the way'),
  })
  return { ok: !!r?.ok, resumed: r }
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
        hub: { spec: hubSpec(), lock: hubLock() },
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
