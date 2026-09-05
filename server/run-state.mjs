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
  if (followUpActive(run)) return run.agent_state === 'waiting' ? 'waiting_input' : 'running'
  if (run.status === 'running' && run.agent_state === 'waiting') return 'waiting_input'
  return run.status
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
 * `vorfallWeggrund()` does for incidents ("Gone is gone": a run that reached
 * `done` has answered them). The record stays — the anomaly event is not
 * touched, and the status cell still prints it as the dim history line next to
 * a duration column that says 52/45. What ends is the CALL FOR ATTENTION.
 */
export const IN_FLIGHT_ANOMALIES = [
  'anomaly:no_activity', 'anomaly:soft_overrun', 'anomaly:overrun', 'anomaly:session_gone',
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
      return `((status = 'running' OR ${FOLLOWUP_SQL}) AND COALESCE(agent_state, '') <> 'waiting')`
    case 'waiting_input':
      return `((status = 'running' OR ${FOLLOWUP_SQL}) AND agent_state = 'waiting')`
    default:
      return `(status = '${String(status).replace(/'/g, '')}' AND NOT ${FOLLOWUP_SQL})`
  }
}
