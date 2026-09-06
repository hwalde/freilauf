// Freilauf — the sandbox spec: one document, four layers, and one rule about
// who may loosen what (SANDBOX_RESEARCH.md §7.2 and §7.3).
//
// A sandbox profile is a single JSON document. It is stored under a name
// (`sandbox_profiles`), a repo names one as its default, and the agent or the
// single run may overlay it. Every field has a default, so `{}` is a valid
// profile and no consumer ever has to ask whether a field is there:
// `normalizeSpec()` fills the whole document, and nothing downstream may read a
// field it could have left undefined.
//
// ## The one rule
//
// A lower layer may only ever NARROW what a higher one locked. That is the rule
// Claude Code, Cursor and Docker all ship, and it is the only rule that makes a
// hub-wide policy worth writing down: without it, "the operator locked the
// network" means "until somebody's agent overrides it". So for a locked path a
// lower layer may
//
//   - append to a deny-shaped list,
//   - remove entries from an allow-shaped list,
//   - lower a numeric limit,
//   - switch `auditOnly` from true to false,
//   - tighten a mode (open → allowlist → none, rw → ro, weak → off),
//
// and never the reverse. Everything else is REFUSED: the higher layer's value
// stands and the attempt is reported in `refused`, which becomes a
// `sandbox:override_refused` event on the run and a warning in the form. Never
// silently — Codex's rule, and the right one: fall back to a compatible value
// and SAY so. A path that is not locked is simply overwritten by the lower
// layer, because that is what layers are for.
//
// The refusal is all-or-nothing per path. A half-honoured list ("we kept the
// three entries you were allowed to remove and put back the two you added")
// would be a fourth value that neither layer wrote, and neither the form nor
// the event could name it.
//
// Nothing in this file imports the database, the registry or a runtime. It is
// pure, it is unit-tested, and it answers the same on a machine that has never
// heard of Docker — which is the promise the whole sandbox rests on.

/**
 * The document of §7.2, with every field defaulted.
 *
 * `network.engine` is `builtin` and `secrets.mode` is `env` because those are
 * the answers that need nothing beyond a container: the built-in CONNECT proxy
 * and the environment variable `fl-start` already passes today. iron-proxy and
 * secret injection are a profile away, not a precondition.
 */
export const DEFAULT_SPEC = {
  runtime: 'docker',                    // docker | podman | runsc | srt
  image: { ref: null, digest: null, pull: 'if-missing' },
  // `user: 'hub'` USED TO SIT HERE, and it is gone rather than corrected.
  //
  // It was a POLICY word — "run as the hub's identity" — and never a login name,
  // which is why `buildRunArgv()` deliberately ignored it and resolved the
  // identity from the daemon's posture instead (§7.7). But a field on the
  // document is a field somebody reads, and one did: `execInContainer()` handed
  // it into `docker exec -u`, where `hub` is an account that exists on no image
  // this hub starts. The result was a finish gate that could not read the
  // working copy and looped for ever on a run that looked perfectly healthy
  // (the entry in exec.mjs has the measured output).
  //
  // The rule the removal states: the identity is not a profile field at all. It
  // is `containerIdentity()` in runtime.mjs, asked by the run and by every exec,
  // and there is nothing here for an operator to set that could make the two
  // disagree again. A profile stored before this simply loses the key —
  // `normalizeSpec()` drops what DEFAULT_SPEC does not name — and the overrides
  // form refuses a new one as an unknown key, which is the loud half.
  network: {
    mode: 'allowlist',                  // open | none | allowlist
    engine: 'builtin',                  // builtin | iron-proxy
    allow: [], deny: [],
    presets: ['harness', 'provider', 'git-host', 'package-registries'],
    auditOnly: false,
    methods: null,                      // null = every method; a list restricts
    denyUpstreamCidrs: 'default',
    tlsTerminate: false,
  },
  // `filesystem.protected` used to sit here — `['.git/hooks', '.git/config']`,
  // "always read-only inside the clone, like Claude Code / Cursor" (§7.2). It is
  // GONE, and the reason is the clone design rather than an oversight: those two
  // paths are only worth protecting where the agent shares a `.git` with
  // somebody, and a sandboxed run does not. Its working copy is a private clone
  // whose hooks and config are its own by construction (§7.4.1), the operator's
  // `.git` is mounted read-only with a generated mask over its `config`, and the
  // one place the agent's own hooks and config could ever reach the HOST — the
  // rescue path when the container is gone — neutralises them by replacing the
  // config and sending `core.hooksPath` to `/dev/null` (exec.mjs), not by a list
  // in a profile. So the field named a rule that was already kept elsewhere and
  // was itself read by NOBODY: validated, narrowed, stored, inert. A field that
  // looks like it saved and does nothing is the failure this file exists against.
  // A stored profile from before this may still carry it; the layering keeps its
  // deny-shape (see SHAPES) so such a profile resolves as it always did, and
  // `validateSandboxOverrides()` now refuses it as an unknown field so nobody
  // writes a new one.
  filesystem: {
    worktree: 'rw', repoGit: 'ro', extras: 'ro',
    readOnlyRoot: true,
    tmpfsSizes: { '/tmp': '2g', '$HOME/.cache': '2g' },
    extraMounts: [],
  },
  resources: {
    memory: '8g', memorySwap: '8g', cpus: 4, pidsLimit: 4096,
    shmSize: '1g', diskTmpfs: '2g', maxRuntimeMinutes: null,
  },
  // `secrets.gitFetch` used to sit here too — `mirror` ("fetch from the mounted
  // read-only .git; no credential at all") vs `none` ("no fetch at all"). Also
  // read by nobody, and `none` could not have been delivered from this document
  // even if somebody had wired it: what makes the fetch possible is the mount of
  // the operator's `.git` (runtime.mjs), and a spec value cannot take a mount
  // away. A field promising "no fetch at all" while the mount stands is the lie,
  // not the missing code. If it comes back, it comes back together with the
  // runtime dropping `ctx.repoGitDir` — and then it will be one statement rather
  // than two. `MODE_ORDERS` keeps its ordering for the same reason
  // `filesystem.protected` keeps its shape: an older stored profile still names
  // it, and a leftover must layer the way it used to rather than freeze.
  secrets: { mode: 'env' },                       // env | inject | none
  innerSandbox: 'off',                            // off | weak | full
  harness: {},                                    // { claude: {...}, cursor: {...} } — plugin knobs
  retention: 'run',                               // run | keep
  audit: { proxyLog: true, dockerEvents: true, export: 'jsonl' },
}

/**
 * WHAT A FRESH INSTALLATION LOCKS, and why a default was needed at all.
 *
 * The narrowing rule below is only worth as much as the list it is applied to,
 * and that list — `sandbox_lock` — used to ship EMPTY. Every path was therefore
 * an unconditional overwrite: out of the box a repo, an agent or a run could
 * hand its container `filesystem.repoGit: 'rw'` (the operator's real object
 * store, writable), turn `network.mode` back to `open`, or put the real API key
 * back inside the container with `secrets.mode: 'env'`. "The operator locked the
 * network" meant "until somebody's agent overrides it" — the exact sentence the
 * header of this file says the rule exists against.
 *
 * The alternative considered and rejected was inverting the rule (locked unless
 * the hub unlocks). It cannot be right here: `shapeOf()` answers `fixed` for
 * every path this module cannot order by strictness, so an inverted default
 * would freeze `image.ref`, `image.pull` and `audit.export` as well — a repo
 * could no longer name its own image, which is the layering's most ordinary use.
 * A layer that may change nothing is not a layer.
 *
 * So: a seeded list, which the operator sees and may change (`sandboxLock()` in
 * run-def.mjs writes it once, Settings → Sandbox prints it). The line it draws
 * is **the lock owns the WALL, the lower layers own what passes through it**:
 *
 *   runtime                      a lower layer must not swap `runsc` for
 *                                `docker` — that is the kernel the whole
 *                                posture rests on, and it is a hub setting.
 *   network.mode                 `open` is not a narrower allowlist, it is no
 *                                allowlist.
 *   network.auditOnly            `true` allows everything and only writes down
 *                                what it WOULD have blocked, so as egress it is
 *                                `network.mode: 'open'` under another name.
 *                                Locking one without the other would be a lock
 *                                with a window beside the door.
 *   network.deny                 the hosts the operator named as never; a lower
 *                                layer may still APPEND (deny-shaped).
 *   network.denyUpstreamCidrs    the proxy's SSRF fence — loopback, RFC 1918,
 *                                link-local, the cloud metadata address. While
 *                                the hub leaves it at the string `'default'` a
 *                                lower layer may not touch it at all (a string
 *                                and a list cannot be ordered, so `narrow()`
 *                                refuses both directions); the hub writing an
 *                                explicit list makes appending work normally.
 *   filesystem.repoGit           `rw` hands the container the operator's own
 *                                object store. The single worst path in the
 *                                document, and the one the removed `copy` enum
 *                                had already opened once.
 *   filesystem.extras            `rw` lets the container write the HOST's linked
 *                                extras — a shared `.venv`, a reference
 *                                checkout — outside the run's own directory.
 *   filesystem.extraMounts       every entry is a host path crossing the wall.
 *                                Allow-shaped, so under the lock a lower layer
 *                                may only drop what the hub granted.
 *   filesystem.readOnlyRoot      `false` makes the container's whole root
 *                                writable, which is where tampering and
 *                                persistence live.
 *   secrets.mode                 back to `env` puts the real credential inside
 *                                the very container a profile promised held only
 *                                a placeholder — "the worst lie this feature
 *                                could tell" (index.mjs).
 *   innerSandbox                 `weak`/`full` needs `CLONE_NEWUSER` and `mount`
 *                                INSIDE the container, i.e. a custom seccomp
 *                                profile and `apparmor=unconfined` — it opens
 *                                the outer wall, which is the one this hub bets
 *                                on (§4.3).
 *
 * WHAT THIS COSTS, said plainly rather than discovered: two of the four shipped
 * profiles exist in order to loosen — "Open network" (`network.mode: 'open'`)
 * and "Audit" (`network.auditOnly: true`) — and the repo and run forms ship an
 * audit-only checkbox. Under this default all three are refused until the
 * operator takes the path out of the lock. That is the decision and not an
 * oversight: the hub ships ENFORCING and looseness is opted into by name. The
 * refusal is loud in both places it can happen (a problem next to the field
 * where a document is typed, `sandbox:override_refused` on the run where a
 * stored profile is resolved), and Settings → Sandbox now PRINTS the list, so
 * the sentence and the place it is changed are one click apart.
 *
 * Deliberately NOT locked, and each for a stated reason:
 *
 *   network.allow, .presets      allow-shaped, and they default to an EMPTY
 *                                list plus the hub's four presets — locking
 *                                them would mean no repo could ever name a host
 *                                of its own, which is what an allowlist is for.
 *   filesystem.worktree          the run's own private clone: writing it is the
 *                                job, `rw` is already the loosest value, and
 *                                nothing there is host state.
 *   image.*, resources.*,        budget and convenience. `resources` narrows on
 *   harness.*, retention,        its own numbers anyway, and `image.ref` is the
 *   audit.*                      per-repo field the inversion above would have
 *                                frozen.
 */
export const DEFAULT_SANDBOX_LOCK = [
  'runtime',
  'network.mode',
  'network.auditOnly',
  'network.deny',
  'network.denyUpstreamCidrs',
  'filesystem.repoGit',
  'filesystem.extras',
  'filesystem.extraMounts',
  'filesystem.readOnlyRoot',
  'secrets.mode',
  'innerSandbox',
]

/** What a repo, an agent or a single run may say about being sandboxed. */
export const SANDBOX_TRISTATE = ['inherit', 'on', 'off']

/**
 * The hub's own policy. `off` hides the feature entirely — an installation
 * without a container runtime, which is every installation until somebody
 * decides otherwise.
 */
export const HUB_MODES = ['off', 'available', 'default_on', 'required']

/** The value sets a spec field may hold. Also what the form validates against. */
export const SPEC_VALUES = {
  runtime: ['docker', 'podman', 'runsc', 'srt'],
  'image.pull': ['if-missing', 'always', 'never'],
  'network.mode': ['open', 'allowlist', 'none'],
  'network.engine': ['builtin', 'iron-proxy'],
  // `copy` is gone from all three, and that was a security defect rather than
  // tidying: NOTHING in the tree implements it. `addMount()` treats every mode
  // that is not exactly `'ro'` as a writable bind mount, so a repo owner who
  // narrowed a hub profile from `rw` to `copy` — believing the comment on
  // MODE_ORDERS, which described "the agent writes, the host's original does not
  // change" — passed the lock check and got the operator's `.git` mounted
  // READ-WRITE. An enum value that validates, ranks as a tightening and then
  // loosens is worse than no value at all.
  'filesystem.worktree': ['rw', 'ro'],
  'filesystem.repoGit': ['rw', 'ro'],
  'filesystem.extras': ['rw', 'ro'],
  'secrets.mode': ['env', 'inject', 'none'],
  innerSandbox: ['off', 'weak', 'full'],
  retention: ['run', 'keep'],
  'audit.export': ['jsonl', 'none'],
}

// Objects the layering treats as ONE value rather than recursing into: a map of
// tmpfs sizes whose keys contain dots and slashes ('$HOME/.cache'), and the
// per-harness knob bag whose shape belongs to a plugin and not to this file. A
// dotted path through either of them could not be split back apart.
const OPAQUE = new Set(['filesystem.tmpfsSizes', 'harness'])

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

function clone(v) {
  if (Array.isArray(v)) return v.map(clone)
  if (isPlain(v)) { const out = {}; for (const [k, x] of Object.entries(v)) out[k] = clone(x); return out }
  return v
}

/**
 * Deep-fill a partial spec against DEFAULT_SPEC. Never mutates its input.
 *
 * Unknown keys survive on purpose: a harness plugin's knobs live in this
 * document, and a normalisation that dropped what it did not recognise would be
 * the "form field that looks like it saved and did not" failure one layer down.
 * Rejecting the unknown is `validateSandboxOverrides()`'s job, at the moment a
 * human typed it — not here, where a stored profile is read back.
 */
export function normalizeSpec(partial) {
  return fill(DEFAULT_SPEC, partial)
}

function fill(base, over) {
  if (over === undefined) return clone(base)
  if (!isPlain(base) || !isPlain(over)) return clone(over)
  const out = clone(base)
  for (const [k, v] of Object.entries(over)) out[k] = k in base ? fill(base[k], v) : clone(v)
  return out
}

// ---------------------------------------------------------------- paths ----

function getPath(obj, path) {
  let cur = obj
  for (const part of path.split('.')) {
    if (!isPlain(cur)) return undefined
    cur = cur[part]
  }
  return cur
}

function setPath(obj, path, value) {
  const parts = path.split('.')
  let cur = obj
  for (const part of parts.slice(0, -1)) {
    if (!isPlain(cur[part])) cur[part] = {}
    cur = cur[part]
  }
  cur[parts.at(-1)] = value
}

/** Every leaf a layer actually SET, as dotted paths. Opaque maps count as leaves. */
export function specPaths(spec, prefix = '') {
  const out = []
  for (const [k, v] of Object.entries(spec ?? {})) {
    const path = prefix ? `${prefix}.${k}` : k
    if (isPlain(v) && !OPAQUE.has(path)) out.push(...specPaths(v, path))
    else out.push(path)
  }
  return out
}

/**
 * Is `path` covered by the lock list? A lock entry locks itself and everything
 * under it, so `network` locks `network.allow` — an operator who writes down
 * one word should not have to enumerate a subtree.
 */
export function pathLocked(path, lock) {
  for (const entry of lock ?? []) {
    if (!entry) continue
    if (path === entry || path.startsWith(`${entry}.`)) return true
  }
  return false
}

// ------------------------------------------------------------ narrowing ----

/**
 * Which direction is stricter, per path. The orders read LOOSEST → STRICTEST,
 * and a lower layer may only move forward in them.
 *
 *  - `network.mode`: open (everything) → allowlist (what the policy names) →
 *    none (no network at all).
 *  - the three filesystem modes: rw (the host's file is writable) → ro (nothing
 *    is written at all). There is no third value: a `copy` mode was offered
 *    here and ranked BETWEEN the two, and no code anywhere implemented it — the
 *    runtime binds anything that is not `'ro'` writable, so narrowing `rw` to
 *    `copy` was a loosening dressed as a tightening. It is gone from
 *    `SPEC_VALUES` too; if a real copy-on-write mode is ever built, it is added
 *    back in both places on the same day.
 *  - `secrets.mode`: env (the real key sits in the container) → inject (only a
 *    placeholder does; the proxy holds the real one) → none (no credential
 *    reaches the container at all).
 *  - `innerSandbox`: full → weak → off, and that direction is the one that
 *    surprises people. §4.3: the harness's own sandbox wants
 *    `clone(CLONE_NEWUSER)` and `mount` INSIDE the container, which Docker's
 *    seccomp and AppArmor profiles deny — so running it means opening the
 *    container up (custom seccomp, `apparmor=unconfined`), taking away exactly
 *    the syscalls that break out of containers. `off` is therefore the choice
 *    that keeps the OUTER wall intact, and the outer wall is the one this hub
 *    is betting on.
 *  - `retention`: keep (the container outlives the run) → run (it is removed
 *    with the session). Nothing left standing is the stricter answer.
 */
const MODE_ORDERS = {
  'network.mode': ['open', 'allowlist', 'none'],
  'filesystem.worktree': ['rw', 'ro'],
  'filesystem.repoGit': ['rw', 'ro'],
  'filesystem.extras': ['rw', 'ro'],
  'secrets.mode': ['env', 'inject', 'none'],
  // Removed from DEFAULT_SPEC (see there). The ordering stays so a profile
  // stored before the removal still layers as it did instead of freezing as
  // 'fixed'; nothing reads the value, and the form refuses a new one.
  'secrets.gitFetch': ['mirror', 'none'],
  innerSandbox: ['full', 'weak', 'off'],
  retention: ['keep', 'run'],
}

/**
 * The shape of every path, which is what decides how it narrows. A path that
 * is not in here is `fixed`: a value this module cannot order by strictness
 * must not be loosened by accident, so under a lock it may not change at all.
 * That is deliberately the DEFAULT, not an omission — a future field is locked
 * tight until somebody states which direction is stricter.
 */
const SHAPES = {
  'network.allow': 'allowList',
  'network.presets': 'allowList',
  'network.methods': 'methods',
  'network.deny': 'denyList',
  'network.denyUpstreamCidrs': 'denyList',
  // Removed from DEFAULT_SPEC (see there). Kept for the same reason
  // `secrets.gitFetch` keeps its ordering: a profile stored before the removal
  // still carries the path, and it must layer as it always did.
  'filesystem.protected': 'denyList',
  'filesystem.extraMounts': 'allowList',
  'filesystem.tmpfsSizes': 'sizeMap',
  // `auditOnly: true` allows everything and only writes down what it would have
  // blocked — the rollout mode. `false` is therefore the strict value.
  'network.auditOnly': 'strictFalse',
  // Terminating TLS is what lets the proxy see method and path at all; more
  // inspection is stricter, and a lower layer may switch it on but not off.
  'network.tlsTerminate': 'strictTrue',
  'filesystem.readOnlyRoot': 'strictTrue',
  'audit.proxyLog': 'strictTrue',
  'audit.dockerEvents': 'strictTrue',
  'resources.memory': 'size',
  'resources.memorySwap': 'size',
  'resources.shmSize': 'size',
  'resources.diskTmpfs': 'size',
  'resources.cpus': 'number',
  'resources.pidsLimit': 'number',
  // null = no hard kill at all, so ANY number narrows it; a lower number
  // narrows further.
  'resources.maxRuntimeMinutes': 'numberOrNull',
}

export const shapeOf = (path) => SHAPES[path] ?? (MODE_ORDERS[path] ? 'mode' : 'fixed')

/**
 * Can this path be ordered from stricter to looser at all?
 *
 * Exported because the audit needs the same answer: `sandbox:policy_weakened`
 * may only be written where "weaker" means something, and `narrow()` cannot
 * distinguish "this did not get looser" from "there is no looser here" — a
 * `fixed` path (the runtime, the image, the engine) answers `refused` for every
 * change, so an audit that trusted it alone would report the image being
 * resolved as the policy getting weaker.
 *
 * The alternative was a second list of unordered paths kept next to the first,
 * which is how the two come to disagree the day somebody adds a field. This way
 * a new path classifies itself: give it a shape and it is ordered, give it none
 * and it is not.
 */
export const isOrdered = (path) => shapeOf(path) !== 'fixed'

const SIZE_UNITS = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }

/**
 * '8g' → bytes. Returns null for anything that is not a size, and the caller
 * then refuses rather than guessing — `Number('')` is 0 and finite, and a
 * memory limit that silently became zero is the worst shape this trap takes.
 */
export function parseSize(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null
  if (typeof v !== 'string') return null
  const m = /^\s*(\d+(?:\.\d+)?)\s*([bkmgt])?[b]?\s*$/i.exec(v)
  if (!m) return null
  return Number(m[1]) * (m[2] ? SIZE_UNITS[m[2].toLowerCase()] : 1)
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const listOf = (v) => (Array.isArray(v) ? v.map(x => JSON.stringify(x)) : null)
const subset = (a, b) => a.every(x => b.includes(x))

/**
 * The narrowing rule for ONE path, exported because the form judges an override
 * with the same code the resolver applies — two readings of "may I do this"
 * is how a form comes to promise something the launch refuses.
 *
 * Returns `{ value, refused }`: `value` is what stands afterwards (the wanted
 * one when it narrows, the current one when it does not), `refused` says which
 * of the two it was.
 */
export function narrow(path, current, wanted) {
  const keep = { value: current, refused: true }
  const take = { value: wanted, refused: false }
  if (wanted === undefined) return { value: current, refused: false }
  if (same(current, wanted)) return { value: current, refused: false }

  switch (shapeOf(path)) {
    case 'mode': {
      const order = MODE_ORDERS[path]
      const from = order.indexOf(current), to = order.indexOf(wanted)
      if (to < 0 || from < 0) return keep       // an unknown value is not a narrowing
      return to >= from ? take : keep
    }
    case 'allowList': {
      // Fewer entries is stricter. Removing is allowed, adding is not.
      const cur = listOf(current), wish = listOf(wanted)
      if (!cur || !wish) return keep
      return subset(wish, cur) ? take : keep
    }
    case 'denyList': {
      // More entries is stricter — a lower layer may append but not drop.
      // `denyUpstreamCidrs` may also be the string 'default' (the proxy's own
      // set); a string against a list cannot be ordered, so it is refused.
      const cur = listOf(current), wish = listOf(wanted)
      if (!cur || !wish) return keep
      return subset(cur, wish) ? take : keep
    }
    case 'methods': {
      // null = every method is allowed, which is the loosest. A list restricts,
      // and a shorter list restricts further.
      if (current === null || current === undefined) return Array.isArray(wanted) ? take : keep
      const cur = listOf(current), wish = listOf(wanted)
      if (!cur || !wish) return keep
      return subset(wish, cur) ? take : keep
    }
    case 'strictFalse': return wanted === false ? take : keep
    case 'strictTrue': return wanted === true ? take : keep
    case 'size': {
      const a = parseSize(current), b = parseSize(wanted)
      if (a === null || b === null) return keep
      return b <= a ? take : keep
    }
    case 'number': {
      const a = Number(current), b = Number(wanted)
      if (!Number.isFinite(a) || !Number.isFinite(b)) return keep
      return b <= a ? take : keep
    }
    case 'numberOrNull': {
      if (wanted === null) return keep          // "no limit" never narrows a limit
      const b = Number(wanted)
      if (!Number.isFinite(b)) return keep
      if (current === null || current === undefined) return take
      const a = Number(current)
      return Number.isFinite(a) && b <= a ? take : keep
    }
    case 'sizeMap': {
      // Per key: a lower size narrows. A key the higher layer did not name is
      // refused — a tmpfs this policy never granted is not a narrowing of it.
      if (!isPlain(wanted)) return keep
      const cur = isPlain(current) ? current : {}
      for (const [k, v] of Object.entries(wanted)) {
        if (!(k in cur)) return keep
        const a = parseSize(cur[k]), b = parseSize(v)
        if (a === null || b === null || b > a) return keep
      }
      return { value: { ...cur, ...wanted }, refused: false }
    }
    default:
      return keep                               // 'fixed': locked means locked
  }
}

// -------------------------------------------------------------- layering ----

/**
 * A layer's own effective document: its profile, then whatever it overrides.
 * Both are the SAME layer, so no lock stands between them — a repo's overrides
 * narrow the hub, not the profile the repo itself chose.
 */
function layerSpec(layer) {
  const parts = [layer?.profile, layer?.spec, layer?.overrides].filter(isPlain)
  if (!parts.length) return null
  return parts.reduce((acc, p) => fill(acc, p))
}

/**
 * The layering of §7.3: hub → repo → agent → run, the first being the authority.
 *
 * Each layer is `{ name, spec, lock }` — `spec` its own (partial) document,
 * `lock` the dotted paths that layers BELOW it may only narrow. Locks
 * accumulate downwards: what the hub locked stays locked for the run, and a
 * repo may lock more on top.
 *
 * THE AGENT AND THE RUN ARE TWO LAYERS, not one. They used to be a single
 * `agentOrRun`, which the caller filled with `def.sandboxOverrides ??
 * agent.sandbox_overrides` — so a run's overrides document REPLACED its agent's
 * rather than narrowing under it. An agent whose profile the operator had
 * narrowed (say `resources.memory: '2g'`) handed a run that named one unrelated
 * field the FULL hub document back, silently, because the `??` had thrown the
 * agent's half away. §7.3's table lists them separately and each may narrow the
 * one above; that is now what the code does.
 *
 * `agentOrRun` is still accepted, and means "there is one layer below the repo"
 * — the shape every caller had before the split, and the shape a caller that
 * genuinely has only one document (a dry run, a form judging a single
 * override) still wants. It is used ONLY when neither `agent` nor `run` is
 * given, so a caller that passes the two cannot also be surprised by a third.
 *
 * Returns `{ spec, refused: [{ path, by, wanted, kept }] }`. A non-empty
 * `refused` is not an error — the run starts, on the higher layer's value — but
 * it is never silent: the caller writes `sandbox:override_refused` and the form
 * says so next to the field. `by` is now `'agent'` or `'run'` where it used to
 * be `'run'` for both, which is the point: the operator learns WHICH of the two
 * documents asked for something it may not have.
 */
export function resolveSandboxSpec({ hub, repo, agent, run, agentOrRun } = {}) {
  const split = agent !== undefined || run !== undefined
  const layers = [
    { name: 'hub', ...(hub ?? {}) },
    { name: 'repo', ...(repo ?? {}) },
    { name: 'agent', ...((split ? agent : null) ?? {}) },
    { name: 'run', ...((split ? run : agentOrRun) ?? {}) },
  ]
  const refused = []
  let spec = clone(DEFAULT_SPEC)
  let lock = []

  for (const [i, layer] of layers.entries()) {
    const own = layerSpec(layer)
    if (own) {
      for (const path of specPaths(own)) {
        const wanted = getPath(own, path)
        const current = getPath(spec, path)
        if (i > 0 && pathLocked(path, lock)) {
          const r = narrow(path, current, wanted)
          if (r.refused) { refused.push({ path, by: layer.name, wanted: clone(wanted), kept: clone(current) }); continue }
          setPath(spec, path, clone(r.value))
        } else if (OPAQUE.has(path) && isPlain(wanted) && isPlain(current)) {
          // An unlocked opaque map MERGES: naming one tmpfs size or one harness
          // knob must not silently drop the others the layer above set.
          setPath(spec, path, { ...clone(current), ...clone(wanted) })
        } else {
          setPath(spec, path, clone(wanted))
        }
      }
    }
    lock = lock.concat(layer.lock ?? [])
  }
  return { spec: normalizeSpec(spec), refused }
}

// ------------------------------------------------------- the tri-states ----

const triState = (v) => (SANDBOX_TRISTATE.includes(v) ? v : 'inherit')

/**
 * Which of the three tri-states, plus the hub's mode, produce a sandboxed run.
 *
 * The lowest layer that says something other than `inherit` decides — run
 * before agent before repo — and the hub's mode is the frame all three sit in:
 *
 *   `off`        the feature does not exist here; the answer is always 0.
 *   `available`  nothing is sandboxed unless a layer asks for it.
 *   `default_on` everything is, unless a layer opts out — and opting out is a
 *                break-glass event: the run starts unsandboxed and carries
 *                `sandbox:bypassed {by}` so the overview and the notification
 *                say so.
 *   `required`   opting out is REFUSED, at the form, like a branch rule the
 *                worktree cannot satisfy. Never a silent downgrade: a policy
 *                that quietly gives way is not a policy.
 *
 * `sandboxable` is the harness plugin's answer (§7.9): a coding agent whose
 * plugin declares no `sandbox` block cannot be run in one. Under `required`
 * that is a refusal — the operator said every run is sandboxed, and this one
 * cannot be. Otherwise it is simply a 0 with a reason the form can print,
 * because "nothing happened and nobody said why" is the failure this whole
 * module is written against.
 *
 * Returns `{ sandbox: 0|1, refused, bypass, reason, by }` — `refused` and
 * `reason` carry i18n keys, never sentences.
 */
export function decideSandbox({ hubMode, allowBypass = true, repo, agent, run, sandboxable = true } = {}) {
  const mode = HUB_MODES.includes(hubMode) ? hubMode : 'off'
  const answer = (sandbox, extra = {}) => ({ sandbox, refused: null, bypass: null, reason: null, by: null, ...extra })

  if (mode === 'off') return answer(0, { reason: 'sandbox.problem.hub_off' })

  // Authority runs upwards from the run: the nearest layer that has an opinion.
  const chain = [{ by: 'run', v: triState(run) }, { by: 'agent', v: triState(agent) }, { by: 'repo', v: triState(repo) }]
  const idx = chain.findIndex(c => c.v !== 'inherit')
  const said = idx >= 0 ? chain[idx] : null

  if (mode === 'required') {
    if (!sandboxable) return answer(1, { refused: { reason: 'sandbox.problem.harness_unsupported', layer: 'harness' } })
    if (said?.v === 'off') return answer(1, { refused: { reason: 'sandbox.problem.required', layer: said.by }, by: said.by })
    return answer(1, { by: said?.by ?? 'hub' })
  }

  if (!sandboxable) return answer(0, { reason: 'sandbox.problem.harness_unsupported' })

  const base = mode === 'default_on' ? 1 : 0
  if (!said) return answer(base, { by: 'hub' })
  if (said.v === 'on') return answer(1, { by: said.by })

  // `off`. What would have happened without this layer decides whether this is
  // a bypass at all: opting out of something that was not going to be
  // sandboxed is not break-glass, it is a no-op.
  const below = chain.slice(idx + 1).find(c => c.v !== 'inherit')
  const without = below ? (below.v === 'on' ? 1 : 0) : base
  if (without === 1 && !allowBypass) {
    return answer(1, { refused: { reason: 'sandbox.problem.bypass_not_allowed', layer: said.by }, by: said.by })
  }
  return answer(0, { bypass: without === 1 ? { by: said.by } : null, by: said.by })
}

// ------------------------------------------------------ form validation ----

const TYPE_OF = {
  boolean: (v) => typeof v === 'boolean',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  string: (v) => typeof v === 'string',
  strings: (v) => Array.isArray(v) && v.every(x => typeof x === 'string'),
}

// What a value must look like, per path. Everything not named here is checked
// against the shape of DEFAULT_SPEC (same JavaScript type as the default), so a
// new field is type-checked the moment it has a default.
const FIELD_TYPES = {
  'image.ref': 'stringOrNull', 'image.digest': 'stringOrNull',
  'network.allow': 'strings', 'network.deny': 'strings', 'network.presets': 'strings',
  'network.methods': 'stringsOrNull',
  'network.denyUpstreamCidrs': 'stringOrStrings',
  'filesystem.extraMounts': 'mounts',
  'filesystem.tmpfsSizes': 'sizeMap',
  'resources.memory': 'size', 'resources.memorySwap': 'size',
  'resources.shmSize': 'size', 'resources.diskTmpfs': 'size',
  'resources.cpus': 'number', 'resources.pidsLimit': 'number',
  'resources.maxRuntimeMinutes': 'numberOrNull',
  harness: 'object',
}

function expandHome(p) {
  const home = process.env.HOME || ''
  if (p === '~') return home
  return p.startsWith('~/') ? `${home}/${p.slice(2)}` : p
}

/** Is `source` inside one of the roots the operator allowed? */
function underRoot(source, roots) {
  const s = expandHome(String(source)).replace(/\/+$/, '')
  return roots.some(r => {
    const root = expandHome(String(r)).replace(/\/+$/, '')
    return root !== '' && (s === root || s.startsWith(`${root}/`))
  })
}

/**
 * Validate an overrides JSON as it was typed into a form.
 *
 * Unknown keys are REFUSED rather than ignored. An overrides document that
 * silently drops a typo is exactly the "field that looks like it saved and did
 * not" failure AGENTS.md has a rule about — and here the typo would be a
 * network rule somebody believes is in force.
 *
 * `problems` are i18n keys with params (`{ key, params }`), never sentences:
 * the caller renders them with `t()` in the reader's language.
 *
 * `lock` is only judged when the caller also hands over `against` — the
 * resolved spec of the layers above. Without it there is nothing to narrow
 * from, and reporting every touch of a locked path would flag a perfectly
 * legitimate narrowing as an error.
 */
export function validateSandboxOverrides(text, { lock = [], allowedMountRoots = [], against = null } = {}) {
  const problems = []
  const raw = typeof text === 'string' ? text.trim() : ''
  if (raw === '' || raw === '{}') return { overrides: {}, problems }

  let doc
  try {
    doc = JSON.parse(raw)
  } catch (err) {
    return { overrides: {}, problems: [{ key: 'sandbox.problem.json', params: { error: String(err.message) } }] }
  }
  if (!isPlain(doc)) return { overrides: {}, problems: [{ key: 'sandbox.problem.not_object', params: {} }] }

  for (const key of Object.keys(doc)) {
    if (!(key in DEFAULT_SPEC)) problems.push({ key: 'sandbox.problem.unknown_key', params: { key } })
  }
  checkNode(doc, DEFAULT_SPEC, '', problems, allowedMountRoots)

  if (against && lock.length) {
    for (const path of specPaths(doc)) {
      if (!pathLocked(path, lock)) continue
      const r = narrow(path, getPath(against, path), getPath(doc, path))
      if (r.refused) {
        problems.push({ key: 'sandbox.problem.locked', params: { path, kept: JSON.stringify(getPath(against, path)) } })
      }
    }
  }
  return { overrides: doc, problems }
}

function checkNode(node, base, prefix, problems, roots) {
  for (const [k, v] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (!(k in base)) {
      if (prefix) problems.push({ key: 'sandbox.problem.unknown_field', params: { path } })
      continue                                   // the top level is reported by the caller
    }
    if (isPlain(base[k]) && !OPAQUE.has(path)) {
      if (!isPlain(v)) { problems.push({ key: 'sandbox.problem.bad_type', params: { path, expected: 'object' } }); continue }
      checkNode(v, base[k], path, problems, roots)
      continue
    }
    checkLeaf(path, v, base[k], problems, roots)
  }
}

function checkLeaf(path, v, def, problems, roots) {
  const bad = (expected) => problems.push({ key: 'sandbox.problem.bad_type', params: { path, expected } })

  if (SPEC_VALUES[path]) {
    if (!SPEC_VALUES[path].includes(v)) {
      problems.push({ key: 'sandbox.problem.bad_value', params: { path, allowed: SPEC_VALUES[path].join(', ') } })
    }
    return
  }
  switch (FIELD_TYPES[path]) {
    case 'strings': if (!TYPE_OF.strings(v)) bad('string[]'); return
    case 'stringsOrNull': if (v !== null && !TYPE_OF.strings(v)) bad('string[] | null'); return
    case 'stringOrNull': if (v !== null && !TYPE_OF.string(v)) bad('string | null'); return
    case 'stringOrStrings': if (!TYPE_OF.string(v) && !TYPE_OF.strings(v)) bad('string | string[]'); return
    case 'number': if (!TYPE_OF.number(v) || v <= 0) bad('number > 0'); return
    case 'numberOrNull': if (v !== null && (!TYPE_OF.number(v) || v <= 0)) bad('number > 0 | null'); return
    case 'object': if (!isPlain(v)) bad('object'); return
    case 'size':
      if (parseSize(v) === null) problems.push({ key: 'sandbox.problem.bad_size', params: { path, value: String(v) } })
      return
    case 'sizeMap': {
      if (!isPlain(v)) { bad('object'); return }
      for (const [mount, size] of Object.entries(v)) {
        if (parseSize(size) === null) problems.push({ key: 'sandbox.problem.bad_size', params: { path: `${path}.${mount}`, value: String(size) } })
      }
      return
    }
    case 'mounts': {
      if (!Array.isArray(v)) { bad('object[]'); return }
      for (const m of v) checkMount(m, problems, roots)
      return
    }
    default: break
  }
  // No rule of its own: the default's own type is the contract.
  if (def === null || def === undefined) return
  if (Array.isArray(def)) { if (!Array.isArray(v)) bad('array'); return }
  if (typeof def === 'boolean' && !TYPE_OF.boolean(v)) bad('boolean')
  else if (typeof def === 'number' && !TYPE_OF.number(v)) bad('number')
  else if (typeof def === 'string' && !TYPE_OF.string(v)) bad('string')
}

function checkMount(m, problems, roots) {
  if (!isPlain(m) || typeof m.source !== 'string' || typeof m.target !== 'string') {
    problems.push({ key: 'sandbox.problem.mount_shape', params: { mount: JSON.stringify(m) } })
    return
  }
  if (m.mode !== undefined && !['ro', 'rw'].includes(m.mode)) {
    problems.push({ key: 'sandbox.problem.bad_value', params: { path: 'filesystem.extraMounts[].mode', allowed: 'ro, rw' } })
  }
  // `..` never travels: a mount that walks out of its root is a mount outside
  // the roots, however the string was written.
  if (m.source.split('/').includes('..')) {
    problems.push({ key: 'sandbox.problem.mount_traversal', params: { source: m.source } })
    return
  }
  if (!roots.length) { problems.push({ key: 'sandbox.problem.mount_none', params: { source: m.source } }); return }
  if (!underRoot(m.source, roots)) {
    problems.push({ key: 'sandbox.problem.mount_root', params: { source: m.source, roots: roots.join(', ') } })
  }
}
