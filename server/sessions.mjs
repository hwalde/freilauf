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
// parsePs, processTree, finishedAtMs, shouldAutoClose, sessionState) so they can
// be tested without a tmux server.
import db, { getRun, addEvent, allSettings } from './db.mjs'
import { sh, parseDbUtc } from './util.mjs'
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

/** The archive keep time in force right now (watcher and archive route read the same value). */
export function currentArchiveKeepMs() { return archiveSessionKeepMs(allSettings()) }

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

/** Raw session list including panes. Empty when tmux is not reachable. */
export async function tmuxSessions() {
  const list = await sh('tmux', ['list-sessions', '-F', SESSION_FIELDS])
  if (!list.ok) return []                   // "no server running on …" is not an error here
  const sessions = parseSessions(list.stdout)
  if (!sessions.length) return sessions
  const panes = await sh('tmux', ['list-panes', '-a', '-F', PANE_FIELDS])
  return mergePanes(sessions, panes.ok ? panes.stdout : '')
}

/** name → session, for the watcher (one listing instead of one call per run). */
export async function tmuxSessionMap() {
  return new Map((await tmuxSessions()).map(s => [s.name, s]))
}

export async function sessionAlive(name) {
  return (await sh('tmux', ['has-session', '-t', `=${name}`])).ok
}

/**
 * Is there still a PROCESS in this session one could type to?
 *
 * A standing session is not the same thing as a reachable agent: `fl-start
 * --keep` sets remain-on-exit, so the session outlives its process on purpose
 * — the screen stays readable, but there is nobody left to answer. That is
 * exactly where the coding agents differ: claude, opencode and cursor stay in
 * their TUI when the work is done (the pane lives on, a follow-up can be typed
 * into it), hermes runs `chat -q`, a single non-interactive query, and exits —
 * what remains there is a screenshot, not an agent.
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
  const out = sessions.map(session => {
    const run = runs.get(session.name) ?? null
    const pid = session.panes.find(p => !p.dead)?.pid ?? session.panes[0]?.pid ?? null
    return {
      ...session,
      run,
      state: sessionState(session, run),
      resources: processTree(tree, pid),
      finishedAtMs: finishedAtMs(session, run),
    }
  })
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
 * gate took it over, 'closed' when it had already finished, null when there is
 * no run.
 */
export function reconcileClosedSession(runId, source = 'session') {
  const run = getRun(runId)
  if (!run) return null
  db.prepare(`UPDATE runs SET tmux_closed_at=COALESCE(tmux_closed_at, datetime('now')) WHERE id=?`).run(runId)
  // A session is gone — whatever ended it. If its run was a cleanup run, the
  // memory it freed must reach the sidebar now, not on the next cache expiry.
  refreshSessionMemoryAfterRun(runId)
  if (!['running', 'waiting_help'].includes(run.status)) {
    if (!run.tmux_closed_at) addEvent(runId, 'tmux_closed', { source })
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
    const r = await sh('tmux', ['kill-session', '-t', `=${name}`])
    // kill-session on a session that no longer exists is an error to tmux, but
    // not to us: the wish "this must be gone" is fulfilled.
    const gone = r.ok || !(await sessionAlive(name))
    return { session: name, ok: gone, error: gone ? null : (r.stderr || r.stdout).trim() || 'kill-session failed' }
  }))
  let aborted = 0
  for (const result of results) {
    if (!result.ok) continue
    const run = db.prepare(`SELECT id FROM runs WHERE tmux_session=? ORDER BY started_at DESC LIMIT 1`).get(result.session)
    if (!run) continue
    result.runId = run.id
    result.run = reconcileClosedSession(run.id, source)
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
