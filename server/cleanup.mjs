// Freilauf — the tmux-cleanup agent: a special single run that ends the oldest
// inactive tmux sessions until the machine's tmux memory is below a target GB.
//
// It is configured under Settings → tmux cleanup (server/pages.mjs), reusing
// the same agent+provider+model block as every run form (runSetupFields), and
// started three ways:
//   - automatically by the watcher when `cleanup_on` and memory >= threshold
//     (maybeAutoCleanup), with a cooldown so a run that cannot reach its target
//     does not fire again every 30 s;
//   - from the sidebar's tmux memory block (small button + target input);
//   - from the Sessions page (prominent box + target input + keep-runs field).
//
// A cleanup run is an ORDINARY single run through startRun(): budget gate,
// overview, watcher, finish gate and the report notification all apply. It works in
// a detached worktree and is told never to commit, so under merge_mode='hub'
// the finish gate finds nothing to merge and closes it cleanly. It carries no
// flows (nothing the operator started should cascade into them).
import db, { addEvent, allSettings, DB_PATH } from './db.mjs'
import { t } from './i18n.mjs'
import { publicBase } from './util.mjs'
import { env } from './env.mjs'

/**
 * The prompt template behind the cleanup agent — the memory-driven successor of
 * the "remove-old-inactive-tmux-sessions" agent (id 7): instead of a fixed 40
 * sessions the target is a memory budget. What may be edited in Settings is this
 * template; the placeholders are filled at start time.
 *
 * `{target_gb}`, `{sessions_url}` and `{db}` are always replaced by the hub;
 * `{keep_line}` by the optional keep list; `{freed_gb}` / `{current_gb}` are the
 * numbers the AGENT measures and must write into its report.
 */
export const CLEANUP_PROMPT_DEFAULT = [
'End tmux sessions to free memory. Goal: the memory held by ALL tmux sessions is to be reduced to at most {target_gb} GB.',
'',
'{keep_line}',
'',
'## Activity age, not creation age — and the right tmux field',
'',
'What counts is when something last happened in the session, NOT when it was created. `#{session_activity}` is NOT the right field for that — pane output barely moves it, only a client attach does. The right field is `#{window_activity}`, the time of the last pane output (the newest window when there are several):',
'',
'```bash',
'now=$(date +%s)',
"tmux list-windows -a -F '#{session_name}|#{window_activity}' \\",
"  | awk -F'|' '{ if ($2 > m[$1]) m[$1]=$2 } END { for (s in m) print m[s]\"|\"s }' \\",
"  | sort -n \\",
"  | awk -F'|' -v now=\"$now\" '{printf \"act_h=%7.2f  %s\\n\", (now-$1)/3600, $2}'",
'```',
'',
'## Measuring memory',
'',
'A session\'s memory is the sum of the RSS of its whole process tree (pane shell + agent + everything it started) — the pane shell alone underestimates it by an order of magnitude. Determine the current total BEFORE ending anything (the sum over all sessions).',
'',
'## Deletion order: only the most inactive and oldest',
'',
'Sort by activity age and start with the longest-inactive session. End sessions in that order until total memory is below {target_gb} GB. If the inactive sessions alone are not enough, continue with the next oldest — younger ones too if necessary. If total memory is already below {target_gb} GB, end nothing.',
'',
'## What must NOT be touched',
'',
'- **Running runs.** Query them first and except them:',
'```bash',
'sqlite3 "{db}" "SELECT tmux_session FROM runs WHERE status IN (\'running\',\'waiting_help\') AND tmux_session IS NOT NULL;"',
'```',
'This run\'s own session is in that list and is therefore protected.',
'- **Running e2e suites.** Sessions with `fl-e2e-`/`cc-e2e-`, freshly created `fl-einzel-…`/`cc-einzel-…` within minutes, and `fl-skill-traeger-…`/`cc-skill-traeger-…`.',
'- **The runs themselves.** Only the tmux session is deleted. No row in `runs`, no directory under `~/agents/runs`, no worktree.',
'- **Commits.** Make NO commits in this working directory and change no files — it is only an empty shell.',
'',
'Delete by exact name match: `tmux kill-session -t "=<name>"`.',
'',
'## The helper script `fl-session-cleanup`',
'',
'Freilauf installs a script on `~/.local/bin` that makes measuring and deciding reliable — use it first:',
'',
'- `fl-session-cleanup` — lists all sessions with activity age and memory',
'- `fl-session-cleanup --target-gb N` — shows which ones must be ended to get to ≤ N GB (oldest inactive first)',
'- `fl-session-cleanup --target-gb N --kill` — really ends them',
'- `fl-session-cleanup --keep "name1 name2"` — never touches these sessions',
'',
'Check with the script (or the commands above) whether the target is reached.',
'',
'## Report (sent as a notification when a channel is configured)',
'',
'Write one sentence of EXACTLY this form into your final report — the URLs are already in place, only replace the two numbers with the GB values you measured (one decimal place):',
'',
'"{freed_gb} GB of memory was freed. {current_gb} GB of memory is now in use. Do you want to free more memory? {sessions_url}"',
'',
'Also state: the number of sessions before / deleted / remaining, and what you used to check the activity age (script or command).',
].join('\n')

/** Fallbacks for the numeric settings — an empty or broken value keeps the hub usable. */
function num(settings, key, fallback) {
  const n = Number(settings[key])
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/** The cleanup configuration, read from the settings table. */
export function cleanupSettings(settings = null) {
  const s = settings ?? allSettings()
  return {
    on: s.cleanup_on === '1',
    thresholdGb: num(s, 'cleanup_threshold_gb', 5),
    targetGb: num(s, 'cleanup_target_gb', 2),
    cooldownMin: num(s, 'cleanup_cooldown_min', 60),
    repoId: Number(s.cleanup_repo_id) || null,
    harness: s.cleanup_harness || '',
    provider: s.cleanup_provider || '',
    orProvider: s.cleanup_or_provider || '',
    orRouting: parseRoutingSetting(s.cleanup_or_routing),
    model: s.cleanup_model || '',
    effort: s.cleanup_effort || '',
    prompt: s.cleanup_prompt || '',
  }
}

/** The routing config blob out of the settings table — tolerant of nulls and junk. */
function parseRoutingSetting(v) {
  try { return JSON.parse(v || '') ?? null } catch { return null }
}

/** Is a cleanup agent configured at all (the manual buttons need one)? */
export function cleanupConfigured(c = null) {
  return !!(c ?? cleanupSettings()).harness
}

/**
 * Turn the "keep these runs" input into the tmux session names that must survive.
 * The operator types run ids on the Sessions page; what the agent and its script
 * understand are session names. Unknown ids and runs without a session are simply
 * skipped.
 */
export function keepSessionsForRuns(ids) {
  const names = []
  for (const raw of String(ids ?? '').split(/[\s,]+/)) {
    const id = raw.trim()
    if (!id) continue
    const run = db.prepare('SELECT tmux_session FROM runs WHERE id=?').get(id)
    if (run?.tmux_session) names.push(run.tmux_session)
  }
  return [...new Set(names)]
}

/** The prompt the agent receives, with the live values filled in.
 * `settings` is a CLEANED cleanup config (see cleanupSettings), not the raw table. */
export function cleanupPrompt({ targetGb = null, keepSessions = [], thresholdGb = null, settings = null } = {}) {
  const s = settings ?? cleanupSettings()
  const keepLine = keepSessions.length
    ? `These sessions are kept no matter what (even when inactive) and must NOT be ended:\n${keepSessions.join(', ')}`
    : 'No exceptions — what is inactive may go, oldest first.'
  const target = targetGb == null ? s.targetGb : Number(targetGb)
  const tpl = String(s.prompt?.trim() || CLEANUP_PROMPT_DEFAULT)
  return tpl
    .replaceAll('{target_gb}', String(target))
    .replaceAll('{threshold_gb}', thresholdGb == null ? String(s.thresholdGb) : String(thresholdGb))
    .replaceAll('{keep_line}', keepLine)
    .replaceAll('{sessions_url}', `${publicBase()}/sessions`)
    // The database path, and NOT a decoration: the query above is what protects
    // the sessions of running runs. Pointed at a file that does not exist,
    // sqlite3 creates an empty one and answers with no rows — the agent would
    // then see nothing to protect and kill live runs. So a template stored
    // before the rename gets its literal old path rewritten too, rather than
    // being left to fail in exactly that direction.
    .replaceAll('$HOME/.local/share/cc-hub/cc-hub.db', DB_PATH)
    .replaceAll('{db}', DB_PATH)
}

/** Is a cleanup run already going (running, waiting or deferred)? */
export function cleanupRunInFlight() {
  return !!db.prepare(`SELECT 1 FROM runs r
    WHERE r.status IN ('running','waiting_help','deferred')
      AND EXISTS (SELECT 1 FROM events e WHERE e.run_id=r.id AND e.kind='cleanup_run') LIMIT 1`).get()
}

/** The most recent cleanup run, for the auto-trigger's cooldown. */
export function lastCleanupRun() {
  return db.prepare(`SELECT ended_at, status FROM runs r
    WHERE EXISTS (SELECT 1 FROM events e WHERE e.run_id=r.id AND e.kind='cleanup_run')
    ORDER BY r.started_at DESC LIMIT 1`).get() ?? null
}

/**
 * Start the cleanup agent as an ordinary single run — the one place that does.
 * `source` is 'auto', 'sidebar' or 'sessions' and lands in the run's event, so
 * the overview and the report say where a cleanup came from.
 *
 * Returns {ok, runId?, deferred?, targetGb?, error?}.
 */
export async function startCleanupRun({ targetGb = null, keep = null, source = 'manual', settings = null } = {}) {
  const s = settings ?? cleanupSettings()
  if (!s.harness) return { ok: false, error: t('cleanup.not_configured') }
  if (cleanupRunInFlight()) return { ok: false, error: t('cleanup.in_flight') }
  const target = targetGb == null ? s.targetGb : Number(targetGb)
  if (!Number.isFinite(target) || target < 0) return { ok: false, error: t('cleanup.bad_target') }
  const repoId = s.repoId ?? db.prepare('SELECT id FROM repos WHERE active=1 ORDER BY name LIMIT 1').get()?.id ?? null
  if (!repoId) return { ok: false, error: t('cleanup.no_repo') }

  const keepNames = keepSessionsForRuns(keep)
  const prompt = cleanupPrompt({ targetGb: target, keepSessions: keepNames, thresholdGb: source === 'auto' ? s.thresholdGb : null, settings: s })

  const { runDefFromForm, setupToFormBody } = await import('./run-def.mjs')
  const { startRun } = await import('./scheduler.mjs')
  const problems = []
  const def = await runDefFromForm({
    ...setupToFormBody({ harness: s.harness, provider: s.provider, orProvider: s.orProvider, model: s.model, effort: s.effort }),
    prompt,
    branch_mode: 'keiner',
    expected_minutes: '30',
    repo_id: String(repoId),
  }, problems)
  if (problems.length) return { ok: false, error: `cleanup setup: ${problems.join(' · ')}` }
  def.flows = null

  const r = await startRun(def, { repoId, title: t('cleanup.title') })
  if (!r.ok || !r.runId) return { ok: false, error: r.error ?? t('run.start_failed') }
  addEvent(r.runId, 'cleanup_run', { source, targetGb: target, keep: keepNames })
  return { ok: true, runId: r.runId, deferred: !!r.deferred, targetGb: target }
}

/**
 * The watcher's gate: when the feature is on, a cleanup agent is configured,
 * no cleanup run is already going, the cooldown after the last one has passed,
 * and the machine's tmux memory is at or above the threshold — then start one.
 * Returns the start result or null when nothing is due.
 *
 * `memGb` is the measured total in GB; a test passes it directly instead of
 * asking sessionMemory() (which reads the machine's real tmux). `FREILAUF_CLEANUP_AUTO_OFF=1`
 * disables the gate entirely (the test suites run next to a live hub and must
 * not start cleanup runs against its memory).
 */
export async function maybeAutoCleanup(nowMs = Date.now(), memGb = null) {
  if (env('CLEANUP_AUTO_OFF') === '1') return null
  const s = cleanupSettings()
  if (!s.on || !s.harness) return null
  if (cleanupRunInFlight()) return null
  let gb = memGb
  if (gb == null) {
    const { sessionMemory } = await import('./sessions.mjs')
    let mem
    try { mem = await sessionMemory() } catch { return null }
    gb = (mem?.rssKb ?? 0) / 1024 / 1024
  }
  if (gb < s.thresholdGb) return null
  const last = lastCleanupRun()
  if (last) {
    if (!last.ended_at) return null                 // still going — in-flight already covered it
    const endedMs = Date.parse(last.ended_at.replace(' ', 'T') + 'Z')
    if (Number.isFinite(endedMs) && nowMs - endedMs < s.cooldownMin * 60_000) return null
  }
  return startCleanupRun({ source: 'auto', settings: s })
}
