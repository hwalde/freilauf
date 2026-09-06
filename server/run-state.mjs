// Freilauf — what a run DISPLAYS as, derived from what the database holds.
//
// Pure: no imports, no database. `runs.status` is the record of the attempt
// (scheduled … done/failed/aborted) and never lies about it; this module
// answers the question the operator actually asks — "is somebody working on
// this right now, and if not, what is it waiting for?" — out of three columns:
//
//   status            the attempt's own state
//   followup_since /  a finished run the operator typed new work into
//   followup_open     (web.mjs /send, or the agent's own `_working` hook)
//   agent_state       what the coding agent's hooks last said about ITSELF:
//                     'working' (it is processing input) or 'waiting' (its
//                     turn ended and it sits at its prompt waiting for a
//                     human). NULL = the harness has not said anything, which
//                     is the state of every run before the first hook fires
//                     and of every harness that reports no attention at all.
//
// The same rule has to hold in SQL — the overview's status filter and the
// sidebar's counts select rows — so the WHERE fragments live next to the
// JavaScript and a unit test holds the two to be the same statement.

export const FINISHED = ['done', 'failed', 'aborted']

/**
 * Is a FINISHED run working again? True while a follow-up commission is open:
 * the operator typed new work into the session (`followup_since`, cleared when
 * the follow-up reports or its session ends), or a follow-up is in the gate /
 * being merged (`followup_open`). The run's `status` keeps telling the truth
 * about the first attempt — what changed is displayed.
 */
export function followUpActive(run) {
  return !!run && FINISHED.includes(run.status) && !!(run.followup_since || run.followup_open)
}

/**
 * How far `last_activity_at` may run past the moment the agent said it waits
 * before the hub stops believing the word.
 *
 * A `waiting` mark is set by the agent's OWN hook and cleared by its own
 * `_working` hook — so where only half of that pair arrives, the mark latches
 * and never comes off. That is not hypothetical: the `_working` hooks
 * (UserPromptSubmit, PreToolUse) are younger than the `_turn_end`/`_waiting`
 * ones, `--settings` is passed INLINE at launch, and a claude started before
 * they existed goes on emitting `turn_end` and `idle` for days with nothing in
 * between. `PreToolUse` is also fired detached (`setsid -f … >/dev/null 2>&1`),
 * so a hook that cannot run says so to nobody. Measured on run 4eeaa0bc:
 * `agent_state='waiting'` since 03:49, `turn_end` events every few minutes
 * after it, and the run's own transcript still growing four and a half hours
 * later — while every page read "waiting for input" and the `no_activity`
 * watchdog stayed switched off for it.
 *
 * `last_activity_at` is the only independent witness there is, and it is the
 * harness's own file MTIME (watcher.mjs `measureActivity()`), never the time of
 * the measurement — so it moves when, and only when, the agent writes. The
 * margin exists because the two are legitimately near-simultaneous at a real
 * turn end: claude writes its transcript ~20 ms AFTER the Stop hook has run.
 * Two minutes is four orders of magnitude above that measurement and four
 * orders below the failure it catches, so it can be a constant rather than a
 * setting nobody would ever tune.
 */
export const ATTENTION_STALE_MS = 120_000

/** A database timestamp (`YYYY-MM-DD HH:MM:SS`, UTC) as epoch ms, or NaN. */
function dbMs(s) {
  return typeof s === 'string' && s ? Date.parse(s.replace(' ', 'T') + 'Z') : NaN
}

/**
 * Does the agent really wait for a human?
 *
 * Its own word, unless measured activity contradicts it — see
 * `ATTENTION_STALE_MS`. Only a CONTRADICTION counts: no activity source (hermes
 * measures none, so `last_activity_at` never moves) and no mark are both silence,
 * and silence never overrules the hook. The SQL twin below has to say the same,
 * because the overview's filter and the sidebar's counts select rows.
 */
export function agentWaiting(run) {
  if (!run || run.agent_state !== 'waiting') return false
  const said = dbMs(run.agent_state_at)
  const acted = dbMs(run.last_activity_at)
  if (!Number.isFinite(said) || !Number.isFinite(acted)) return true
  return acted - said <= ATTENTION_STALE_MS
}

/**
 * …the same sentence in SQL. `julianday` gives days, so the margin is scaled.
 *
 * Both COALESCEs are load-bearing, and the parity test found them: SQL's third
 * truth value is not `false`. `agent_state = 'waiting'` on a NULL column is
 * NULL, so a bare `NOT (…)` around it selects NOTHING — which is why the rule
 * this replaced was already written as `COALESCE(agent_state,'') <> 'waiting'`.
 * The inner comparison can go NULL too (`julianday` of anything it cannot
 * parse), and a witness the database cannot read is no contradiction.
 */
const WAITING_SQL = `(COALESCE(agent_state, '') = 'waiting' AND NOT COALESCE(
  julianday(last_activity_at) - julianday(agent_state_at) > ${ATTENTION_STALE_MS / 86_400_000}, 0))`

/**
 * The status word a run displays under.
 *
 *   waiting_input   the agent's turn is over and it waits for a human — on a
 *                   running run (the agent stopped without reporting, or
 *                   stopped inside the finish gate) and on a finished one with
 *                   an open follow-up (it answered and waits for the next
 *                   instruction). Deliberately NOT for `waiting_help`: that
 *                   run asked a question through `fl-report help`, and the
 *                   question is what the operator has to see, not the idle.
 *   running         a running run whose agent is working or has said nothing,
 *                   and a finished run with an open follow-up whose agent works
 *   everything else the record itself
 */
export function displayStatus(run) {
  if (!run) return null
  if (followUpActive(run)) return agentWaiting(run) ? 'waiting_input' : 'running'
  if (run.status === 'running' && agentWaiting(run)) return 'waiting_input'
  return run.status
}

/**
 * May this run be put into the archive?
 *
 * Archiving is the operator's "put this finished work away", and it CLOSES the
 * run's tmux session (web.mjs, closeArchivedSessions). So the question is not
 * only whether the RECORD is terminal but whether anybody is still working in
 * that session — and a finished run with an open follow-up commission is
 * exactly such a run: `displayStatus()` puts it back under `running`, the
 * overview row and the detail page say so, and the operator is typing into its
 * terminal right now. Measured on run 49a26807: the row read "running —
 * follow-up in progress" and offered the archive button in the very same row,
 * where one click would have killed a live session mid-conversation.
 *
 * The rule lives here, next to `displayStatus()`, because it is the same kind
 * of question — what does this run's state MEAN now — and because three places
 * carried their own copy of it (the row's button, the row's bulk checkbox, the
 * detail page) next to the one the server enforces in `archiveRecord()`. Two
 * copies of the "only finished runs" rule is how one of them eventually
 * archives a run that is still being worked on.
 */
export function archivable(run) {
  return !!run && FINISHED.includes(run.status) && !followUpActive(run)
}

/**
 * The anomalies that are statements about a run IN FLIGHT — "nothing is
 * happening", "this is taking longer than planned", "its session vanished".
 *
 * Every one of them is already retracted (`clearAnomalies()` renames the event
 * to `cleared:*`) somewhere in the hub the moment it is overtaken: by a
 * progress report, by a raised expected duration, by a resume, by activity
 * coming back. Which is the whole point — a statement about a run that has
 * been overtaken must not go on colouring the run's traffic light.
 *
 * The run REACHING ITS END is the last and most complete of those overtaking
 * events, and it was the one nobody had wired up. Measured on this
 * installation: run 9b6bfee6 ran 52 minutes against an expectation of 45,
 * reported done and had its work merged into `main` — and sat in the overview
 * with a RED dot titled "needs attention", next to a run that had genuinely
 * called for help and was green. `12c30c75`, `f2d4af1d` and `01c8a3b9` wore
 * the same yellow for the same reason, all three done and merged.
 *
 * `settledAnomalies()` is therefore the anomaly half of what
 * `incidentGoneReason()` does for incidents ("Gone is gone": a run that reached
 * `done` has answered them). The record stays — the anomaly event is not
 * touched, and the status cell still prints it as the dim history line next to
 * a duration column that says 52/45. What ends is the CALL FOR ATTENTION.
 */
export const IN_FLIGHT_ANOMALIES = [
  'anomaly:no_activity', 'anomaly:soft_overrun', 'anomaly:overrun', 'anomaly:session_gone',
  // A sandbox denial belongs here for the same reason the four above do: it is a
  // statement about a run IN FLIGHT ("the boundary refused something"), and a run
  // that reached `done` has answered it — whatever was blocked, the work came
  // through. The watcher already retracts it while the run lives (work after the
  // hit, then a settle window); without this entry a run that never had to cope
  // would carry a yellow dot for ever, which is exactly the "it spends the
  // colour" failure the section above this list exists to prevent.
  'anomaly:sandbox_denied',
]

/**
 * Has this run come through, so that the statements above are history?
 *
 * `done` only. A `failed` or `aborted` run KEEPS its anomalies and their
 * colour, because there the anomaly is the explanation of why it did not come
 * through. A `done` run whose work is stuck off the base branch is red through
 * its `merge_blocked` incident, which is the integrator's ladder and not
 * this. And a run with an open follow-up commission is working right now — its
 * `followup_*` anomalies are not in the list above anyway, but its status says
 * `done` while a human waits on it, so it is not settled either.
 */
export function anomaliesSettled(run) {
  return !!run && run.status === 'done' && !followUpActive(run)
}

/**
 * The merge statuses that mean: the hub ITSELF put this run's work on `origin`.
 * `merged` pushed it into the base branch, `kept_on_branch` pushed the branch —
 * integrate.mjs knows no purely local merge, so either word is proof that
 * nothing of this run lives only on this machine.
 */
export const WORK_ON_ORIGIN = ['merged', 'kept_on_branch']

/** …as a question about one run. */
export function workOnOrigin(run) {
  return !!run && WORK_ON_ORIGIN.includes(String(run.merge_status ?? ''))
}

/**
 * The anomaly kinds this run's own state has ANSWERED — the WHERE fragment in
 * pages.mjs subtracts exactly these, so they stop colouring the traffic light.
 *
 * Two rules, and they are independent because they answer different statements:
 *
 *   the run came through   → `IN_FLIGHT_ANOMALIES` (see above)
 *   its work is on origin  → `anomaly:unpushed`
 *
 * The second one is the writer's own rule, read back. `checkFinishedBranches()`
 * never ASKS whether a merged run's branch is pushed — the hub put the work on
 * origin itself — but that fence only stops NEW events; one already on the run
 * went on speaking for ever, because `unpushed` is deliberately not an
 * in-flight anomaly (for an unmerged run it stays true after the end, which is
 * the whole point of it). Measured on run d4ee07d2: `merged` into main at
 * 16:47:56, `anomaly:unpushed` two seconds later, and a day afterwards the
 * overview still showed a YELLOW dot titled "worth a look" over the dim line
 * "branch not pushed" — about work that was on `origin/main`. Same family as
 * the false alarm reports.mjs fixed, one layer further out: the writer learned
 * the rule and the reader did not.
 *
 * It is NOT tied to `done`. `checkFinishedBranches()` asks about `failed` runs
 * too, and a failed run's leftovers can be merged by hand from the detail page
 * — once they are on origin, "not pushed" is just as false there.
 */
export function settledAnomalies(run) {
  if (!run) return []
  const settled = anomaliesSettled(run) ? [...IN_FLIGHT_ANOMALIES] : []
  if (workOnOrigin(run) && !settled.includes('anomaly:unpushed')) settled.push('anomaly:unpushed')
  return settled
}

/**
 * Is what the browser terminal just sent into the session a HUMAN doing
 * something — a key, a pasted line, Ctrl-C — as opposed to the terminal
 * talking to the application by itself?
 *
 * "Waiting for input" is a call for the operator's attention, and the moment
 * the operator types into the terminal that call is answered, whatever the
 * coding agent's own hooks say and however long before they say it (claude's
 * UserPromptSubmit fires on Enter, opencode's busy on the first token — a
 * half-typed line, a menu, a permission dialog answered with one key fire
 * nothing at all). The WebSocket in server/terminal.mjs is the one place
 * every keystroke passes through, for every harness alike, so it says so —
 * but only for bytes a person produced. xterm.js also sends what the
 * application asked it for: mouse reports (SGR `CSI < b;x;y M/m`, X10
 * `CSI M` + three bytes) while a TUI has mouse reporting on, focus reports
 * (`CSI I` / `CSI O`) when mode 1004 is set. A click to focus the tab, the
 * wheel over the pane or the window coming to the front are not "the
 * operator is talking to the agent". Pure, so the rule can be stated in a test.
 */
const TERMINAL_REPORTS = /\x1b\[<\d+;\d+;\d+[mM]|\x1b\[M[\s\S]{3}|\x1b\[[IO]/g

export function isOperatorInput(s) {
  if (typeof s !== 'string' || !s) return false
  return s.replace(TERMINAL_REPORTS, '').length > 0
}

/** The statuses the overview can be filtered by and the sidebar counts, in reading order. */
export const WORK_STATUSES = ['running', 'waiting_input', 'waiting_help', 'scheduled', 'deferred']

const FOLLOWUP_SQL = `(status IN ('done','failed','aborted') AND followup_since IS NOT NULL)`

/**
 * The WHERE fragment that selects the rows `displayStatus()` would put under
 * `status`. No parameters: every value is a literal, so it can be inlined into
 * the overview query and the sidebar's counts alike.
 */
export function displayStatusSql(status) {
  switch (status) {
    case 'running':
      return `((status = 'running' OR ${FOLLOWUP_SQL}) AND NOT ${WAITING_SQL})`
    case 'waiting_input':
      return `((status = 'running' OR ${FOLLOWUP_SQL}) AND ${WAITING_SQL})`
    default:
      return `(status = '${String(status).replace(/'/g, '')}' AND NOT ${FOLLOWUP_SQL})`
  }
}
