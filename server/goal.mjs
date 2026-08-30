// Freilauf — the goal: a SECOND prompt, typed into the session after the start.
//
// A run's prompt says what to do. A goal says when it is DONE: claude's
// `/goal <condition>` sets a completion condition, checks it after every turn
// and takes another turn by itself for as long as it does not hold. That is the
// difference to everything else in the run definition — the goal is not a flag
// fl-start could pass on. The command exists only INSIDE the session, so the
// hub types it in, after the initial prompt has gone off.
//
// Hence this module, and hence one delivery function for both ways in:
//
//   - launchRun() fires it right after the session stands (not awaited: it
//     waits for the TUI to draw, and a start must not hang on that)
//   - the watcher pass picks up whatever did not get through — a hub that was
//     restarted between the start and the delivery, a session that had not
//     drawn yet, a run that was still answering a help call
//
// `runs.goal_sent_at` is what keeps the two from typing it twice, and what makes
// "was the goal ever delivered?" a question the detail page can answer.
import db, { addEvent } from './db.mjs'
import { sendToSession, sh } from './util.mjs'
import { goalSpec } from './harnesses/index.mjs'
import { env } from './env.mjs'

/** Milliseconds from an env variable, with a default for anything unusable. */
const ms = (v, fallback) => Number.isFinite(+v) && +v >= 0 ? +v : fallback

/** How long to wait for the TUI to draw before giving up on this attempt. */
const waitMs = () => ms(env('GOAL_WAIT_MS'), 60_000)

/**
 * Grace after the pane has drawn. Output is not the same thing as an editor
 * that accepts input — the first thing every TUI paints is its frame.
 */
const graceMs = () => ms(env('GOAL_DELAY_MS'), 3_000)

const schlafen = (dauer) => new Promise(resolve => setTimeout(resolve, dauer))

/** Does this coding agent know a goal at all? */
export function harnessSupportsGoal(harness) { return !!goalSpec(harness) }

/** The longest condition this coding agent takes, or null when it knows none. */
export function goalMax(harness) { return goalSpec(harness)?.max ?? null }

/**
 * The condition as the line that goes into the session — or null when there is
 * nothing to send. Whitespace is folded: a slash command is one line, and a
 * pasted newline would submit the fragment in front of it as its own message.
 */
export function goalCommand(harness, condition) {
  const spec = goalSpec(harness)
  const text = String(condition ?? '').replace(/\s+/g, ' ').trim()
  if (!spec || !text) return null
  return spec.command(text.slice(0, spec.max))
}

/** Has the pane painted anything yet? The one signal every harness gives. */
async function paneDrawn(session) {
  const r = await sh('tmux', ['capture-pane', '-p', '-t', `=${session}:`])
  return r.ok && r.stdout.trim() !== ''
}

async function warteAufTui(session) {
  const bis = Date.now() + waitMs()
  for (;;) {
    if (await paneDrawn(session)) return true
    if (Date.now() >= bis) return false
    await schlafen(1000)
  }
}

// Both ways in can meet on the same run: the launch path waits for the TUI while
// a watcher pass comes by. Without this the goal would be typed in twice.
const inFlight = new Set()

/**
 * Deliver the goal of ONE run. Returns true when it really went into the
 * session; every other outcome is a "not now", never an exception.
 *
 * `warten: false` is the watcher's way in: a run it looks at has been going for
 * at least one pass, so a pane that has not drawn by then will not draw within
 * the next few seconds either — waiting for it would hold up the whole pass.
 */
export async function deliverGoal(runId, { warten = true } = {}) {
  if (inFlight.has(runId)) return false
  inFlight.add(runId)
  try {
    const run = db.prepare('SELECT * FROM runs WHERE id=?').get(runId)
    if (!run || run.goal_sent_at || !run.tmux_session) return false
    // Only from 'running'. 'waiting_help' means the agent asked a question and
    // is waiting for an answer — a goal typed in there would BE that answer.
    if (run.status !== 'running') return false
    const line = goalCommand(run.harness, run.goal)
    if (!line) return false

    if (warten) {
      if (!await warteAufTui(run.tmux_session)) {
        addEvent(runId, 'goal_deferred', { reason: 'tui not drawn' })
        return false
      }
      await schlafen(graceMs())
    } else if (!await paneDrawn(run.tmux_session)) {
      return false
    }

    // Minutes can have passed in that wait: the run may have ended, been
    // aborted, or asked for help meanwhile.
    const jetzt = db.prepare('SELECT status, goal_sent_at FROM runs WHERE id=?').get(runId)
    if (!jetzt || jetzt.goal_sent_at || jetzt.status !== 'running') return false

    const r = await sendToSession(run.tmux_session, line)
    if (!r.ok) {
      addEvent(runId, 'goal_failed', { error: (r.stderr || '').trim().slice(0, 200) })
      return false
    }
    db.prepare(`UPDATE runs SET goal_sent_at=datetime('now') WHERE id=?`).run(runId)
    addEvent(runId, 'goal_sent', { goal: run.goal })
    return true
  } finally {
    inFlight.delete(runId)
  }
}

/**
 * The watcher's pass: every running run that still owes its session a goal.
 * Covers the hub that was restarted mid-start and the session that had not
 * drawn yet — the launch path is the fast way, this one is the reliable way.
 */
export async function deliverPendingGoals() {
  const rows = db.prepare(`SELECT id FROM runs WHERE status='running'
    AND goal IS NOT NULL AND goal <> '' AND goal_sent_at IS NULL AND tmux_session IS NOT NULL`).all()
  const delivered = []
  for (const row of rows) {
    if (await deliverGoal(row.id, { warten: false })) delivered.push(row.id)
  }
  return delivered
}
