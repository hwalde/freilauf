// Freilauf — tmux sessions: what is running on this machine, what it costs and
// how it is ended.
//
// A run works in its own tmux session, and `fl-start --keep` sets
// remain-on-exit: the session therefore OUTLIVES the agent on purpose — the
// screen stays readable afterwards. The price is a process that keeps its
// memory for as long as the session stands, and with a retention measured in
// days that adds up to dozens of them.
//
// This module is the one place that knows about sessions:
//   - listSessions()           what tmux has, enriched with the run behind it
//   - sessionMemory()          what all of them cost together, cached
//   - killSessions()           end them, and keep the run records honest
//   - reconcileClosedSession() what an ended session means for its run
//   - sessionKeepMs()          how long a finished session may stay
//
// The parsing and deciding parts are pure functions (parseSessions, mergePanes,
// parsePs, processTree, finishedAtMs, shouldAutoClose, sessionState,
// tmuxVerdict, sessionGoneFrom) so they can be tested without a tmux server.
import db, { getRun, addEvent, allSettings } from './db.mjs'
import { sh, parseDbUtc } from './util.mjs'
import { specOf } from './sandbox/exec.mjs'
import { t } from './i18n.mjs'
import { env } from './env.mjs'

// session_path is free text and comes LAST, so a tab inside it cannot shift
// any other field (the parser rejoins the remainder).
const SESSION_FIELDS = [
  '#{session_name}', '#{session_created}', '#{session_attached}',
  '#{session_windows}', '#{session_activity}', '#{session_path}',
].join('\t')
// Same rule: pane_current_command last.
const PANE_FIELDS = [
  '#{session_name}', '#{pane_dead}', '#{pane_pid}',
  '#{pane_dead_status}', '#{pane_dead_time}', '#{pane_current_command}',
].join('\t')

const num = (s) => { const n = Number(s); return Number.isFinite(n) ? n : null }

/** `tmux list-sessions -F SESSION_FIELDS` → one object per session. */
export function parseSessions(text) {
  const out = []
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue
    const f = line.split('\t')
    if (f.length < 6) continue
    const createdSec = num(f[1])
    const activitySec = num(f[4])
    out.push({
      name: f[0],
      createdMs: createdSec != null ? createdSec * 1000 : null,
      attached: f[2] === '1',
      windows: num(f[3]) ?? 1,
      activityMs: activitySec != null ? activitySec * 1000 : null,
      // A path may contain tabs — everything from field 6 on belongs to it.
      path: f.slice(5).join('\t'),
      panes: [],
    })
  }
  return out
}

/** `tmux list-panes -a -F PANE_FIELDS` → panes attached to their sessions. */
export function mergePanes(sessions, text) {
  const bySession = new Map(sessions.map(s => [s.name, s]))
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue
    const f = line.split('\t')
    if (f.length < 6) continue
    const session = bySession.get(f[0])
    if (!session) continue
    const deadSec = num(f[4])
    session.panes.push({
      dead: f[1] === '1',
      pid: num(f[2]),
      deadStatus: f[3] || null,
      deadMs: deadSec != null ? deadSec * 1000 : null,
      command: f.slice(5).join('\t'),
    })
  }
  // A session with no live pane left is finished, whatever it once ran.
  for (const session of sessions) {
    session.paneCount = session.panes.length
    session.dead = session.panes.length > 0 && session.panes.every(p => p.dead)
    // The earliest death among the panes is when the session stopped working.
    const deadTimes = session.panes.filter(p => p.dead && p.deadMs != null).map(p => p.deadMs)
    session.deadMs = session.dead && deadTimes.length ? Math.min(...deadTimes) : null
    session.command = session.panes.find(p => !p.dead)?.command ?? session.panes[0]?.command ?? ''
    session.deadStatus = session.panes.find(p => p.dead && p.deadStatus)?.deadStatus ?? null
  }
  return sessions
}

/**
 * `ps -eo pid=,ppid=,rss=,pcpu=` → resources of a whole process tree. The pane
 * PID is the shell; what actually eats the memory are its children (the agent
 * and everything it spawned), so a single ps line would understate it by an
 * order of magnitude.
 */
export function parsePs(text) {
  const procs = new Map()      // pid → { ppid, rssKb, cpu }
  const children = new Map()   // ppid → [pid]
  for (const line of String(text ?? '').split('\n')) {
    const f = line.trim().split(/\s+/)
    if (f.length < 4) continue
    const pid = num(f[0]), ppid = num(f[1])
    if (pid == null || ppid == null) continue
    procs.set(pid, { ppid, rssKb: num(f[2]) ?? 0, cpu: num(f[3]) ?? 0 })
    if (!children.has(ppid)) children.set(ppid, [])
    children.get(ppid).push(pid)
  }
  return { procs, children }
}

/** Sum of RSS (KiB), CPU percentage and process count below and including `pid`. */
export function processTree({ procs, children }, pid) {
  const out = { rssKb: 0, cpu: 0, count: 0 }
  if (pid == null || !procs.has(pid)) return out
  const queue = [pid]
  const seen = new Set()
  while (queue.length) {
    const current = queue.pop()
    if (seen.has(current)) continue     // a ppid cycle would otherwise loop forever
    seen.add(current)
    const info = procs.get(current)
    if (!info) continue
    out.rssKb += info.rssKb
    out.cpu += info.cpu
    out.count += 1
    for (const child of children.get(current) ?? []) queue.push(child)
  }
  return out
}

/**
 * When did this session finish its work? The EARLIEST of the two signals wins,
 * because that is the moment the operator means by "the agent is done":
 *   - the run reported a result (ended_at), or
 *   - the pane's process exited (remain-on-exit keeps the session standing).
 * Returns null while it is still working — such a session is never closed
 * automatically.
 */
export function finishedAtMs(session, run) {
  const candidates = []
  if (session?.deadMs != null) candidates.push(session.deadMs)
  if (run?.ended_at) {
    const ms = parseDbUtc(run.ended_at)
    if (Number.isFinite(ms)) candidates.push(ms)
  }
  // A dead pane without a usable timestamp still counts as finished; without a
  // reference point it would otherwise stand forever.
  if (!candidates.length && session?.dead) return session.createdMs ?? null
  return candidates.length ? Math.min(...candidates) : null
}

/**
 * How long a finished session may stay open. The setting is in hours (0 =
 * close right away); the older `retention_days` is read as a fallback so an
 * existing installation keeps its behavior until it is saved once.
 */
export function sessionKeepMs(settings = {}) {
  const hours = settings.session_keep_hours
  if (hours != null && String(hours).trim() !== '') {
    const n = Number(hours)
    if (Number.isFinite(n) && n >= 0) return n * 3_600_000
  }
  const days = Number(settings.retention_days)
  return (Number.isFinite(days) && days >= 0 ? days : 3) * 86_400_000
}

/** Default for the settings form, in hours. */
export function sessionKeepHours(settings = {}) {
  return Math.round(sessionKeepMs(settings) / 3_600_000 * 10) / 10
}

/**
 * How long a session of an ARCHIVED run may stay open after the archive. The
 * setting is in hours (0 = close right away, the default); the whole rule is
 * off when `archive_session_on` is not '1'. Returns null when off — such a
 * session then follows the ordinary retention like any other finished one.
 */
export function archiveSessionKeepMs(settings = {}) {
  if (String(settings.archive_session_on ?? '1') !== '1') return null
  const hours = settings.archive_session_keep_hours
  if (hours != null && String(hours).trim() !== '') {
    const n = Number(hours)
    if (Number.isFinite(n) && n >= 0) return n * 3_600_000
  }
  return 0
}

/** Hours, for the settings form — the value survives a switch-off, so it is not lost. */
export function archiveSessionKeepHours(settings = {}) {
  const hours = settings.archive_session_keep_hours
  if (hours != null && String(hours).trim() !== '') {
    const n = Number(hours)
    if (Number.isFinite(n) && n >= 0) return n
  }
  return 0
}

/**
 * Is this ARCHIVED run's session over its keep time? `keepMs` comes from
 * archiveSessionKeepMs() and is null when the rule is off.
 */
export function shouldCloseArchived(run, keepMs, nowMs = Date.now()) {
  if (keepMs == null || !run?.archived_at) return false
  const archivedMs = parseDbUtc(run.archived_at)
  if (!Number.isFinite(archivedMs)) return false
  return nowMs - archivedMs >= keepMs
}

/** Is this session over its keep time? */
export function shouldAutoClose(session, run, keepMs, nowMs = Date.now()) {
  const finished = finishedAtMs(session, run)
  if (finished == null) return false
  return nowMs - finished >= keepMs
}

/**
 * State of a session, as the page shows it:
 *   'agent_running' — a run of this hub is going in it (hidden by default)
 *   'run_ended'     — the run is over, the session is still standing
 *   'dead'          — the process exited, only the screen is left
 *   'unknown'       — no run of this hub belongs to it (foreign or leftover)
 */
export function sessionState(session, run) {
  if (!run) return session?.dead ? 'dead' : 'unknown'
  if (['running', 'waiting_help'].includes(run.status) && !session?.dead) return 'agent_running'
  return session?.dead ? 'dead' : 'run_ended'
}

// ---------------------------------------------------------------- tmux access

/**
 * tmux says "no server" and "I could not answer you" through the SAME exit
 * code, and reading the second one as the first is how a single bad moment
 * ends every run on the machine.
 *
 *   'ok'          the command answered; its output is the truth.
 *   'no_server'   there is demonstrably no tmux server — so there are no
 *                 sessions. Also the truth, just the empty one.
 *   'unreachable' anything else: a server too busy to answer, a fork that
 *                 failed under memory pressure, the 30 s timeout in sh(), a
 *                 missing binary, a socket in a broken state. The hub learned
 *                 NOTHING here, and "nothing" must never be spent as "gone" —
 *                 the callers that end runs act only on 'ok'/'no_server'.
 *
 * Measured against tmux 3.4: a missing server answers `error connecting to
 * <socket> (No such file or directory)` on stderr, exit 1; older paths say
 * `no server running on <socket>`. Both are matched, everything else is not.
 * Pure over sh()'s result so the classification is testable without tmux.
 */
const NO_SERVER_RE = /no server running on|no current server|error connecting to .*\((No such file or directory|Connection refused)\)/i

export function tmuxVerdict(r) {
  if (r?.ok) return 'ok'
  return NO_SERVER_RE.test(String(r?.stderr ?? '') + String(r?.stdout ?? '')) ? 'no_server' : 'unreachable'
}

/**
 * What `tmux has-session` really said about one name:
 *   true   it is demonstrably gone (tmux named the session, or there is no
 *          server at all)
 *   false  it is there
 *   null   tmux gave no answer — the caller must not act on that
 * Pure, for the same reason as tmuxVerdict.
 */
export function sessionGoneFrom(r) {
  const verdict = tmuxVerdict(r)
  if (verdict === 'ok') return false
  if (verdict === 'no_server') return true
  return /can't find session|session not found|no such session/i.test(
    String(r?.stderr ?? '') + String(r?.stdout ?? '')) ? true : null
}

/**
 * The session list together with the verdict on whether it can be believed.
 * `ok: false` means "no answer", NEVER "empty" — see tmuxVerdict.
 */
export async function tmuxSnapshot() {
  const list = await sh('tmux', ['list-sessions', '-F', SESSION_FIELDS])
  const verdict = tmuxVerdict(list)
  if (verdict === 'unreachable') {
    return { ok: false, sessions: [], reason: (list.stderr || list.stdout).trim() || `tmux list-sessions failed (${list.code})` }
  }
  if (verdict === 'no_server') return { ok: true, sessions: [], reason: 'no_server' }
  const sessions = parseSessions(list.stdout)
  if (!sessions.length) return { ok: true, sessions, reason: 'ok' }
  const panes = await sh('tmux', ['list-panes', '-a', '-F', PANE_FIELDS])
  return { ok: true, sessions: mergePanes(sessions, panes.ok ? panes.stdout : ''), reason: 'ok' }
}

/**
 * Raw session list including panes. Empty when tmux is not reachable — which is
 * right for the DISPLAY callers (the sessions page, the memory block): showing
 * nothing is the honest rendering of an unanswered question. Anything that ENDS
 * a run asks tmuxSnapshot() instead and reads its verdict.
 */
export async function tmuxSessions() {
  return (await tmuxSnapshot()).sessions
}

// Deliberately no tmuxSessionMap() any more. The watcher used to build its
// name → session map from tmuxSessions(), and a Map cannot carry the verdict:
// an unreachable tmux arrived as a map with nothing in it, and every run in the
// pass then looked session-less at once. Whoever needs the map builds it from
// tmuxSnapshot().sessions AFTER reading snapshot.ok.

export async function sessionAlive(name) {
  return (await sh('tmux', ['has-session', '-t', `=${name}`])).ok
}

/**
 * Is this session demonstrably gone? true / false / null (no answer) — the
 * tri-state sessionAlive() cannot express. Every caller that would END a run
 * on the answer uses this one.
 */
export async function sessionGone(name) {
  if (!name) return null
  return sessionGoneFrom(await sh('tmux', ['has-session', '-t', `=${name}`]))
}

/**
 * Is there still a PROCESS in this session one could type to?
 *
 * A standing session is not the same thing as a reachable agent: `fl-start
 * --keep` sets remain-on-exit, so the session outlives its process on purpose
 * — the screen stays readable, but there is nobody left to answer. That is
 * exactly where the coding agents differed: claude, opencode and cursor stay
 * in their TUI when the work is done (the pane lives on, a follow-up can be
 * typed into it), and hermes used to run `chat -q` as a single non-interactive
 * query and exit — what remained there was a screenshot, not an agent. Since
 * hermes 0.21 `-q` seeds an interactive session on a TTY and stays too
 * (measured 2026-09-05), so today all four leave a live pane; a dead one is
 * a crash, an older hermes, or a plugin harness that exits by design.
 *
 * One `tmux list-panes` for one session; the detail page asks this once per
 * render. `null` means tmux gave no answer at all (session gone, no server) —
 * the caller decides what to make of not knowing.
 */
export async function paneAlive(name) {
  if (!name) return null
  const r = await sh('tmux', ['list-panes', '-t', `=${name}`, '-F', '#{pane_dead}'])
  if (!r.ok) return null
  const flags = r.stdout.split('\n').map(s => s.trim()).filter(Boolean)
  return flags.length ? flags.some(v => v === '0') : null
}

// ------------------------------------------------------- the run's container
//
// A sandboxed run works inside a container while its tmux session holds the
// container CLIENT (SANDBOX_RESEARCH.md §7.1). Everything below is what the
// session side of the hub has to know about that, and all of it is fail-soft in
// the same direction: an installation without a container runtime, or a daemon
// that does not answer, must behave exactly as this file behaved before any of
// it existed.

/**
 * The runtime module, or null. Imported LAZILY and cached — a static import
 * would tie the sessions page, the sidebar's memory block and the watcher to a
 * module that talks to a container daemon, on machines that have none. The same
 * rule server/sandbox/exec.mjs states for its own runtime import.
 */
let runtimeMod = null
export async function sandboxRuntime() {
  if (runtimeMod !== null) return runtimeMod || null
  try { runtimeMod = await import('./sandbox/runtime.mjs') } catch { runtimeMod = false }
  return runtimeMod || null
}
const runtimeModule = sandboxRuntime

/**
 * Which hub a container belongs to — the value of the `freilauf.hub` label the
 * launcher stamps on and the reconciliation pass filters by. There is exactly
 * ONE definition of it, `hubId()` in server/sandbox/index.mjs, and this is a
 * lazy reader of it rather than a second answer: reaping another installation's
 * containers is the same mistake as killing its tmux sessions, and two functions
 * that both claim to know the id is how the two come to disagree. `null` where
 * the sandbox modules are not loadable at all — the caller then does nothing,
 * which is the right answer on a machine with no containers.
 */
export async function sandboxHubId() {
  try { return (await import('./sandbox/index.mjs')).hubId() } catch { return null }
}

/** Test hook: forget the cached runtime module (a suite may install a stub). */
export function _resetRuntimeModule() { runtimeMod = null }

/**
 * The container this run really got, or null. `runs.sandbox_container` is
 * written when one was created, so a NULL there means "nothing to stop" — never
 * a name to guess at: stopping `fl-<id>` on a hunch could hit a container of
 * another hub that reused the id.
 */
export function containerName(run) {
  return (run?.sandbox && run?.sandbox_container) ? String(run.sandbox_container) : null
}

/** Which runtime this run was started with (its frozen spec knows). */
function runtimeOf(run) {
  return env('SANDBOX_RUNTIME') ?? specOf(run)?.runtime ?? undefined
}

/**
 * Is this run's container demonstrably gone? true / false / null — the same
 * tri-state `sessionGone()` has, and for the same reason: "the daemon did not
 * answer" is not "the container is gone", and a caller that spends the one as
 * the other ends somebody's work over a restarted daemon.
 */
export async function containerGone(run) {
  const name = containerName(run)
  if (!name) return null
  const rt = await runtimeModule()
  if (typeof rt?.containerState !== 'function') return null
  try {
    const state = await rt.containerState(name, { runtime: runtimeOf(run) })
    if (!state || state.verdict !== 'ok') return null
    return !state.running
  } catch { return null }
}

/**
 * Stop a run's container — SIGTERM, then SIGKILL after the grace period (§7.11).
 * `--rm` removes the container with it and the proxy goes with the network.
 *
 * Returns `{ stopped, name }`: `stopped` is true only when a container that was
 * demonstrably RUNNING was stopped by this call, so a caller can tell "I ended
 * it" from "it was over anyway" without asking twice.
 */
export async function stopRunContainer(run, { timeoutSec = 30 } = {}) {
  const name = containerName(run)
  if (!name) return { stopped: false, name: null }
  const rt = await runtimeModule()
  if (typeof rt?.stopContainer !== 'function') return { stopped: false, name }
  const runtime = runtimeOf(run)
  let running = true
  try {
    if (typeof rt.containerState === 'function') {
      const state = await rt.containerState(name, { runtime })
      // Not answering is not "gone": stop it anyway, the command is idempotent.
      if (state && state.verdict === 'ok') running = !!state.running
    }
    await rt.stopContainer(name, { runtime, timeoutSec })
    // The network outlives `--rm` (the daemon persists it), so it goes here too
    // — and its NAME comes from the module that owns it, never from a template
    // typed out a second time here. Two authors of `fl-net-<id>` is the drift
    // run-def.mjs exists to prevent, with the twist that the disagreement would
    // be silent: a `network rm` of a name nobody created answers "not found",
    // which reads exactly like a network that was already gone.
    if (typeof rt.removeNetwork === 'function' && typeof rt.networkName === 'function') {
      await rt.removeNetwork(rt.networkName(run.id), { runtime }).catch?.(() => {})
    }
  } catch { return { stopped: false, name } }
  return { stopped: running, name }
}

/**
 * What a sandboxed session really costs — and the reason this is a correctness
 * fix rather than a refinement.
 *
 * The pane's process tree is the container CLIENT. The agent's processes are
 * children of the daemon's shim, not of anything under the pane, so summing the
 * tree measures the transport and calls it the workload: measured against a PTY
 * relay of the container's shape, the pane tree came to **10.4 MB while the
 * workload held 210.3 MB** (SANDBOX_RESEARCH.md §11a.5) — a twenty-fold
 * under-report in the one number the status sidebar exists to print and the
 * memory-cleanup agent acts on.
 *
 * Which is why a null here must NOT fall back to the tree walk: 10 MB that looks
 * like a measurement is worse than no measurement, and this repo has a rule
 * about a number that presents itself as current and is not. The caller marks
 * such a session unknown instead.
 */
async function containerResources(run) {
  const name = containerName(run)
  if (!name) return null
  const rt = await runtimeModule()
  if (typeof rt?.containerStats !== 'function') return null
  try {
    const stats = await rt.containerStats(name, { runtime: runtimeOf(run) })
    if (!stats || !Number.isFinite(Number(stats.memBytes))) return null
    return { rssKb: Math.round(Number(stats.memBytes) / 1024), cpu: Number(stats.cpuPct) || 0, count: 1 }
  } catch { return null }
}

/**
 * Every session with everything known about it: the run behind it, the agent,
 * the repo and what the process tree costs. Oldest first — that is the order
 * one wants when cleaning up.
 */
export async function listSessions() {
  const sessions = await tmuxSessions()
  if (!sessions.length) return []
  const ps = await sh('ps', ['-eo', 'pid=,ppid=,rss=,pcpu='])
  const tree = parsePs(ps.ok ? ps.stdout : '')
  // One query instead of one per session: there are few runs with a session.
  const runs = new Map()
  for (const run of db.prepare(`SELECT r.*, a.name AS agent_name, p.name AS repo_name
                                FROM runs r
                                LEFT JOIN agents a ON a.id = r.agent_id
                                LEFT JOIN repos p ON p.id = r.repo_id
                                WHERE r.tmux_session IS NOT NULL
                                ORDER BY r.started_at`).all()) {
    runs.set(run.tmux_session, run)   // a name is reused at most after a kill: the newest wins
  }
  const out = await Promise.all(sessions.map(async (session) => {
    const run = runs.get(session.name) ?? null
    const pid = session.panes.find(p => !p.dead)?.pid ?? session.panes[0]?.pid ?? null
    const hostTree = processTree(tree, pid)
    // Whether this is a sandboxed session is asked of the RUN, never of
    // `pane_current_command`: that field names the transport (`docker`, or a
    // relay's `python3`), so matching on the string would misread an operator's
    // own container session and would stop being true the day the runtime is
    // podman. The tmux name prefix and the run row are the answers this hub
    // already trusts for "what is in this session".
    const container = containerName(run)
    const inContainer = container ? await containerResources(run) : null
    // UNKNOWN, not the pane tree. See containerResources(): the tree is the
    // client, and 10 MB in place of 210 MB is the quiet kind of wrong.
    const unknown = { rssKb: null, cpu: null, count: null, unknown: true }
    return {
      ...session,
      run,
      state: sessionState(session, run),
      resources: container ? (inContainer ?? unknown) : hostTree,
      // What the page renders as the "sandboxed" badge. `measured: false` is the
      // instruction to print "unknown" rather than a number.
      sandbox: container ? { container, image: specOf(run)?.image?.ref ?? null, measured: !!inContainer } : null,
      finishedAtMs: finishedAtMs(session, run),
    }
  }))
  out.sort((a, b) => (a.createdMs ?? 0) - (b.createdMs ?? 0))
  return out
}

// -------------------------------------------------- what they cost together

/**
 * The memory of ALL tmux sessions on this machine, as the status sidebar shows
 * it — total RSS of every session's process tree, how many sessions there are
 * and how many of them still carry a working agent. Foreign sessions count too:
 * the question the panel answers is what the MACHINE is holding, not what this
 * hub booked.
 *
 * It goes through listSessions(), so the sidebar's total and the sessions
 * page's own summary are the same number by construction — the panel exists to
 * make the page's reading visible everywhere, not to compute a second one.
 *
 * Cached for eight minutes, and that TTL is the update interval: the sidebar
 * re-fetches its fragment every 30 s (hub.js), and this cache decides how often
 * `tmux list-sessions`/`list-panes`/`ps` are really run behind it — the same
 * division of labour usage.mjs and balances.mjs have with the vendor APIs. A
 * `ps -eo` over every process on the machine is not something a page render
 * should pay for more often than the number can meaningfully change.
 */
const MEM_CACHE_MS = Number(env('SESSION_MEM_CACHE_MS') ?? 8 * 60_000)
let memCache = { at: 0, value: null }
// One measurement in flight, released by the promise and not at the end of the
// body — with no tmux server the body has an `await` but could still resolve
// before the assignment below; see usage.mjs for what that cost there.
let memInflight = null

export async function sessionMemory({ force = false } = {}) {
  const cached = memCache.value
  if (!force && cached && Date.now() - memCache.at < MEM_CACHE_MS) return cached
  if (memInflight) return !force && cached ? cached : memInflight
  const task = (async () => {
    const sessions = await listSessions()
    const value = {
      sessions: sessions.length,
      running: sessions.filter(s => s.state === 'agent_running').length,
      // listSessions() already substitutes the container's memory for a
      // sandboxed session's pane tree, so this sum includes the containers by
      // construction — the same "one reading, rendered in two places" rule the
      // sidebar and the sessions page have always shared.
      sandboxed: sessions.filter(s => s.sandbox).length,
      // How many sessions could not be measured at all — a sandboxed one whose
      // runtime did not answer. The total below is then INCOMPLETE, and the
      // panel has to say so: a machine total that quietly leaves out a 200 MB
      // container is the same lie as a quota bar that is two days old.
      unmeasured: sessions.filter(s => s.resources?.unknown).length,
      rssKb: sessions.reduce((sum, s) => sum + (s.resources?.rssKb ?? 0), 0),
      measuredAtMs: Date.now(),
      // The panel says how often this is taken, so a reading up to eight
      // minutes old cannot pass itself off as live. It travels WITH the value
      // because the TTL is configurable — a hardcoded "8" in a translation
      // would be a lie the moment someone sets the variable.
      intervalMs: MEM_CACHE_MS,
    }
    memCache = { at: Date.now(), value }
    return value
  })()
  memInflight = task
  const release = () => { if (memInflight === task) memInflight = null }
  task.then(release, release)
  // Stale-while-revalidate, for the reason every panel on this sidebar is:
  // statusSidebar() awaits this on EVERY page, and the measurement shells out
  // three times. An expired entry is handed back as it stands while the fresh
  // one is measured behind it; the sidebar's own timer brings it in.
  if (!force && cached) return cached
  return task
}

/** Test hook: let the cache age by `ms`, so staleness can be tested without waiting. */
export function _sessionMemoryAge(ms) { memCache.at -= ms }

/** Test hook: drop the cache. */
export function _sessionMemoryReset() { memCache = { at: 0, value: null }; memInflight = null }

/**
 * The work of a CLEANUP run is already done when it reports: it ends tmux
 * sessions while it works, so once it is over the sidebar's memory block must
 * not go on serving a number measured up to eight minutes earlier. The cache is
 * dropped here and a fresh measurement started right away — the run's own
 * end event brings the sidebar back within ~2 s (hub.js), and the fragment then
 * renders the fresh value instead of the stale one. The measurement is warmed
 * fire-and-forget so the fragment render does not have to wait on the three
 * subprocesses; it would only do so if it beat the warm call, and one bounded
 * wait is exactly what a deliberate invalidation is for.
 *
 * Any other run touches nothing and returns false: a session still standing
 * after an ordinary run is precisely what the retention measures, and the
 * eight-minute clock is what keeps a `ps -eo` over every process off every page
 * render.
 */
export function refreshSessionMemoryAfterRun(runId) {
  if (!runId) return false
  const isCleanup = db.prepare(`SELECT 1 FROM events WHERE run_id=? AND kind='cleanup_run' LIMIT 1`).get(runId)
  if (!isCleanup) return false
  memCache = { at: 0, value: null }
  sessionMemory().catch(() => {})
  return true
}

// ---------------------------------------------------------------- ending

/**
 * Bring the run record in line with a session that is gone. Without this the
 * overview keeps a run on 'running' forever — there is nothing left that could
 * ever report a result for it.
 *
 * A run in the FINISH GATE is the one exception, and only for an UNASKED-FOR end
 * (`source` 'watcher'/'retention'): it has already reported, so its agent
 * disappearing is not "ended without a report" — it is the moment the hub has to
 * take over (server/integrate.mjs, escalate 'agent_gone'). When a human or a
 * flow ends it on purpose (the kill route, the sessions page: source 'web') it
 * becomes 'aborted' exactly as before and is assessed like any other unfinished
 * run.
 *
 * Returns 'aborted' when the run was still open, 'escalated' when the finish
 * gate took it over, 'resuming' when the session was closed in order to bring
 * the run back, 'closed' when it had already finished, null when there is no
 * run.
 */
export function reconcileClosedSession(runId, source = 'session') {
  const run = getRun(runId)
  if (!run) return null
  db.prepare(`UPDATE runs SET tmux_closed_at=COALESCE(tmux_closed_at, datetime('now')),
              agent_state=NULL, agent_state_at=NULL WHERE id=?`).run(runId)
  // THE THIRD CASE, and it is neither of the two the rule above names. "A
  // session the hub closed on purpose is an end; a session that went away by
  // itself is resumed" — but a caller that closed this session IN ORDER TO
  // bring the run back is the opposite of an end. `runs.resume_pending` is
  // exactly the mark that says so, and §7.12.4 sets it BEFORE the container is
  // stopped precisely so that whoever sees the session go — a watcher pass, or
  // this function — finds a run already on its way.
  //
  // Without this guard the two paths that exist to SAVE a run were the two that
  // killed it: the sandbox's reconfigure-and-resume and the break-glass both
  // close the session through killSessions(), which lands here, and a `running`
  // run became `aborted` — after which resumeRun() refuses it with `status is
  // aborted` and the agent's conversation is lost. Measured on two sandboxes,
  // both times, and it is the whole point of §7.12.4.
  //
  // It cannot swallow a genuine abort, and that is why the mark is the key
  // rather than the source: nothing that ends a run on purpose — the kill
  // route, the sessions page, retention, archiving, a flow's `kill_run`,
  // enforceMaxRuntime — sets `resume_pending`, and `runs.retry` clears it.
  // Nothing is stopped or released here either: the resume walks §7.11's
  // idempotent start order again and wants the clone, the home, the network and
  // (through `stopOrphan`) the container name back.
  if (run.resume_pending && ['running', 'waiting_help'].includes(run.status)) {
    addEvent(runId, 'tmux_closed', { source, resuming: true })
    return 'resuming'
  }
  // The second question a sandboxed run brings (§7.11, §8.18): a session that is
  // gone while the container still stands is the client-died case — the operator
  // hit the detach chord, or the `docker` client was killed — and the agent in
  // there would otherwise go on working with nobody watching. Fire and forget,
  // like the escalations below: WHICH of the two ends the run is decided by the
  // rules of this function and is not the sandbox's to change; all this does is
  // make sure nothing of the sandbox outlives the session that held it.
  releaseSandbox(runId, source)
  // A session is gone — whatever ended it. If its run was a cleanup run, the
  // memory it freed must reach the sidebar now, not on the next cache expiry.
  refreshSessionMemoryAfterRun(runId)
  if (!['running', 'waiting_help'].includes(run.status)) {
    if (!run.tmux_closed_at) addEvent(runId, 'tmux_closed', { source })
    // A session is the only way a follow-up can report — with it gone, an open
    // follow-up commission (web.mjs /send) can never be answered. The run
    // falls back to displaying as finished; an escalation below takes care of
    // a follow-up that was already in the gate.
    if (run.followup_since) db.prepare('UPDATE runs SET followup_since=NULL WHERE id=?').run(runId)
    // A finished run whose FOLLOW-UP is in the finish gate (reports.mjs): its
    // agent is gone mid-report, and that is the same escalation as for a first
    // report — not a silent wait for the gate's deadline.
    if (run.finish_state && source !== 'web') {
      import('./integrate.mjs')
        .then(m => m.escalate(runId, 'agent_gone'))
        .catch(err => console.error('[integrate]', err.message))
      return 'escalated'
    }
    return 'closed'
  }
  if (run.finish_state && source !== 'web') {
    import('./integrate.mjs')
      .then(m => m.escalate(runId, 'agent_gone'))
      .catch(err => console.error('[integrate]', err.message))
    return 'escalated'
  }
  db.prepare(`UPDATE runs SET status='aborted', ended_at=COALESCE(ended_at, datetime('now')),
              report_md=COALESCE(report_md, ?) WHERE id=?`)
    .run(t('sessions.aborted_note'), runId)
  addEvent(runId, 'aborted', { reason: 'tmux session ended', source })
  assessLater(runId, source !== 'web')
  return 'aborted'
}

/**
 * A session ended, so everything the sandbox was holding for it goes — this is
 * `teardownSandbox()` on the ORDINARY end paths, which it was on none of before:
 * its only callers were a failed launch and the facade itself, so a normally
 * finished run left its built-in proxy listener standing inside the hub process
 * (with that finished run's allow policy) and its `docker events` tail child
 * running, for the life of the hub. Measured with `ss -ltnp` against the hub
 * pid: the listener was still there after the run had been aborted and a watcher
 * pass had run.
 *
 * Two steps, and the order is §7.11's:
 *
 *  1. `containerGone(run)` — the second question a sandboxed run brings. A
 *     container that is still RUNNING while its session is gone is the
 *     client-died case (§8.18: the detach chord, a killed `docker` client), and
 *     the agent in there would otherwise work on with nobody watching, so it is
 *     recorded as `sandbox:container_gone`. `null` is the daemon giving no
 *     answer and writes NOTHING — not knowing is a reason to ask again next
 *     pass, never to state that something happened.
 *  2. the teardown itself: the container down, the in-process proxy stopped, the
 *     events tail killed, the per-run network removed. Idempotent by design and
 *     safe on a run that was never sandboxed, which is why the ordinary case —
 *     `killSessions()` and the kill route stop the container BEFORE they touch
 *     tmux, `--rm` takes it with the agent's own exit — costs nothing here.
 *
 * The `sandbox` guard is what keeps the promise that an installation without a
 * container runtime never loads a line of the sandbox: an unsandboxed run does
 * not even import the module. Never throws, never blocks the caller.
 */
function releaseSandbox(runId, source) {
  const run = getRun(runId)
  if (!run?.sandbox) return
  ;(async () => {
    const gone = await containerGone(run)
    if (gone === false) {
      addEvent(runId, 'sandbox:container_gone',
        { reason: 'session ended, container still running', source, container: containerName(run) })
    }
    // Read again: the guard in reconcileClosedSession() is one thing, a mark set
    // while this promise was in flight is another. A run on its way back keeps
    // what §7.11's start order walks through again.
    if (getRun(runId)?.resume_pending) return
    const { teardownSandbox } = await import('./sandbox/index.mjs')
    await teardownSandbox(run, { reason: `session_${source}`, removeNetwork: true })
  })().catch(err => console.error('[sandbox]', err.message))
}

/**
 * An aborted run leaves work behind too. The assessment always happens (the
 * detail page shows it); only the run the WATCHER aborted — a session that
 * vanished on its own, which nobody was watching for — also says so to the operator.
 * An operator who just clicked "end session" does not need a message about it.
 */
export function assessLater(runId, announce = false) {
  import('./integrate.mjs')
    .then(async (m) => {
      const assessment = await m.assessUnmerged(runId)
      if (!announce || !assessment || (!assessment.commits && !assessment.dirty)) return
      const { notifyRun } = await import('./reports.mjs')
      const run = getRun(runId)
      await notifyRun(runId, 'aborted_unmerged',
        `🟡 Run aborted — its work is not merged.\n${m.assessText(run, assessment)}`)
    })
    .catch(err => console.error('[integrate]', err.message))
}

/**
 * End sessions. Every name is treated on its own: one that is already gone
 * counts as done (the point is the end state, not who caused it), and one that
 * refuses reports its error instead of taking the whole batch down.
 *
 * The kills run concurrently — the page fires a dozen at once and must not wait
 * for them one after another.
 */
export async function killSessions(names, source = 'web') {
  const unique = [...new Set((names ?? []).map(n => String(n ?? '').trim()).filter(Boolean))]
  const results = await Promise.all(unique.map(async (name) => {
    // The run is looked up BEFORE the kill, not after, because a sandboxed run's
    // container has to be stopped first (§7.11): killing the session kills the
    // client, and a container whose client is gone goes on working. SIGTERM,
    // 30 s, then SIGKILL — the agent gets the chance to write out what it has.
    const row = db.prepare(`SELECT * FROM runs WHERE tmux_session=? ORDER BY started_at DESC LIMIT 1`).get(name)
    if (containerName(row)) await stopRunContainer(row)
    const r = await sh('tmux', ['kill-session', '-t', `=${name}`])
    // kill-session on a session that no longer exists is an error to tmux, but
    // not to us: the wish "this must be gone" is fulfilled.
    const gone = r.ok || !(await sessionAlive(name))
    return { session: name, ok: gone, runId: row?.id ?? null, error: gone ? null : (r.stderr || r.stdout).trim() || 'kill-session failed' }
  }))
  let aborted = 0
  for (const result of results) {
    if (!result.ok || !result.runId) continue
    result.run = reconcileClosedSession(result.runId, source)
    if (result.run === 'aborted') aborted++
  }
  if (aborted) {
    // "Run finished" is a flow trigger — an ended session is exactly that, and
    // waiting for the next watcher pass would delay it by up to 30 seconds.
    const { flowsTick } = await import('./flows/triggers.mjs')
    flowsTick().catch(err => console.error('[flows]', err.message))
  }
  return results
}

/**
 * Sessions the watcher may close by itself. Deliberately only those carrying a
 * run of THIS hub: the e2e suite and other instances share the same tmux
 * server, and a pattern across every `fl-` and `cc-` session would kill theirs.
 */
export function autoCloseCandidates(sessions, keepMs, nowMs = Date.now()) {
  return sessions.filter(s => s.run && shouldAutoClose(s, s.run, keepMs, nowMs))
}

/** The keep time in force right now (watcher and settings page read the same value). */
export function currentKeepMs() { return sessionKeepMs(allSettings()) }
