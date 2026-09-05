// Freilauf — opencode's session store: what a run is really doing right now.
//
// opencode keeps every conversation in one SQLite database
// (~/.local/share/opencode/opencode.db, `FREILAUF_OPENCODE_DB` for the suite),
// and that store is the hub's only source for an opencode run's activity, its
// tokens and its cost. This module is what reads it — split off from
// watcher.mjs the way cursor-transcript.mjs is, and for the same reason: a
// harness's activity source is its own subject, and the half that decides
// something has to be testable against a fixture instead of against the
// operator's live store.
//
// THE RUN IS A TREE, NOT A SESSION. opencode's task tool opens a CHILD session
// per subagent, in the same directory as its parent. So "the newest session of
// this worktree" — which is what the hub asked for — lands on whichever
// subagent started last, and reads the run's activity off a session that has
// usually already finished.
//
// Measured on run f2d4af1d (2026-09-04, opencode 1.18, glm-5.3-flash): the
// run's own session wrote messages continuously from 15:16 to 15:36, and the
// hub had `last_activity_at` standing at 15:13:17 — the end of a subagent that
// had run for 71 seconds. At 15:28:37 the watcher therefore wrote
// `anomaly:no_activity`, and the overview said "no activity" under a run whose
// agent was demonstrably working. The tokens went the same way: the run's row
// carried 49 133 in / 5 049 out, which was that one subagent's tally, while the
// tree had spent ~264 000 / ~16 800.
//
// Hence: the ROOT is the newest parentless session of the worktree that was
// created with this run, the descendants come off the `parent_id` index rather
// than off the directory (a subagent may work somewhere else), activity is the
// newest timestamp anywhere in the tree, and tokens and cost are SUMMED over
// it — a subagent's tokens are the operator's tokens.
//
// AND THE TIMESTAMP COMES FROM THREE TABLES, not one. `session.time_updated`
// moves once per completed message, so a single long turn reads as silence:
// measured in the same run, one message ran from 15:32:31 to 15:36:38 — four
// minutes in which the session row said nothing at all. `part` rows move while
// the turn is still running (a tool call changing state, streamed text), and
// they are the finest signal this store has.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { env } from './env.mjs'

/** The store's path — overridable, because a test must never read the operator's. */
export function storePath() {
  return env('OPENCODE_DB') ?? `${homedir()}/.local/share/opencode/opencode.db`
}

/** Does this table carry that column? opencode's schema moves between versions. */
function hasColumn(d, table, column) {
  try {
    return d.prepare(`SELECT name FROM pragma_table_info(?)`).all(table).some(c => c.name === column)
  } catch { return false }
}

/**
 * The session ids belonging to ONE run: the root plus everything hanging under
 * it. `sinceMs` is the run's start (minus a small tolerance) — a worktree can
 * hold several sessions over time (a retry, an operator attaching by hand), so
 * a session older than the run is never the run's.
 *
 * Two fallbacks, both of which only ever return what the old code returned:
 * a store without `parent_id`, and a directory in which no parentless session
 * matches (an opencode that stopped writing the worktree into the root row).
 * Better the single newest session than nothing at all.
 */
export function sessionTree(d, directory, sinceMs) {
  const newest = () => {
    const r = d.prepare(`SELECT id FROM session WHERE directory = ? AND time_created >= ?
                         ORDER BY time_created DESC LIMIT 1`).get(directory, sinceMs)
    return r ? [r.id] : []
  }
  if (!hasColumn(d, 'session', 'parent_id')) return newest()

  const root = d.prepare(`SELECT id FROM session WHERE directory = ? AND time_created >= ?
                          AND parent_id IS NULL ORDER BY time_created DESC LIMIT 1`).get(directory, sinceMs)
  if (!root) return newest()

  // Breadth first over the parent_id index. The cap is a fence, not a limit:
  // a subagent that spawns subagents is normal, a tree of 500 is a bug
  // somewhere else and must not turn one watcher pass into a table scan.
  const ids = [root.id]
  const seen = new Set(ids)
  const children = d.prepare(`SELECT id FROM session WHERE parent_id = ?`)
  for (let i = 0; i < ids.length && ids.length < 200; i++) {
    for (const k of children.all(ids[i])) {
      if (seen.has(k.id)) continue
      seen.add(k.id)
      ids.push(k.id)
    }
  }
  return ids
}

/** The newest `time_updated` in message/part for one session — 0 when there is none. */
function touchedAt(d, sessionId) {
  let t = 0
  for (const table of ['message', 'part']) {
    try {
      const r = d.prepare(`SELECT MAX(time_updated) AS t FROM ${table} WHERE session_id = ?`).get(sessionId)
      if (r?.t) t = Math.max(t, Number(r.t))
    } catch { /* a table this opencode does not have says nothing */ }
  }
  return t
}

/**
 * Read one run out of an OPEN store. Separate from the file access so the suite
 * can hand it a fixture database.
 *
 * Returns `{ lastActivityMs, tokensIn, tokensOut, costUsd, sessions }`;
 * `lastActivityMs` is null when the store knows nothing about this run — which
 * is "no answer", never "idle since the start".
 */
export function readRun(d, directory, sinceMs) {
  const ids = sessionTree(d, directory, sinceMs)
  const out = { lastActivityMs: null, tokensIn: 0, tokensOut: 0, costUsd: null, sessions: ids.length }
  if (!ids.length) return out
  const row = d.prepare(`SELECT cost, tokens_input, tokens_output, time_updated FROM session WHERE id = ?`)
  let newest = 0
  for (const id of ids) {
    const s = row.get(id)
    if (!s) continue
    out.tokensIn += Number(s.tokens_input ?? 0)
    out.tokensOut += Number(s.tokens_output ?? 0)
    if (s.cost != null) out.costUsd = (out.costUsd ?? 0) + Number(s.cost)
    newest = Math.max(newest, Number(s.time_updated ?? 0), touchedAt(d, id))
  }
  if (newest > 0) out.lastActivityMs = newest
  return out
}

/**
 * The run's ROOT session id — the one `opencode --session <id>` continues
 * (runner.mjs, resumeRun). Only a parentless session created with this run
 * counts: a subagent's id would resume the subagent. `null` on every failure
 * and when the store knows nothing; the caller then falls back to
 * `--continue`.
 */
export async function rootSessionId(run) {
  if (!run?.workdir_effective || !run.started_at) return null
  const path = storePath()
  if (!existsSync(path)) return null
  const since = Date.parse(run.started_at.replace(' ', 'T') + 'Z') - 5000
  if (!Number.isFinite(since)) return null
  let d = null
  try {
    const { DatabaseSync } = await import('node:sqlite')
    d = new DatabaseSync(path, { readOnly: true })
    if (!hasColumn(d, 'session', 'parent_id')) return null
    const root = d.prepare(`SELECT id FROM session WHERE directory = ? AND time_created >= ?
                            AND parent_id IS NULL ORDER BY time_created DESC LIMIT 1`).get(run.workdir_effective, since)
    return root?.id ?? null
  } catch {
    return null
  } finally {
    try { d?.close() } catch {}
  }
}

/**
 * The file version: open the store read-only, read the run, close again.
 * Answers null on every failure — a store that is not there, a schema that
 * moved, a locked database. The caller then knows nothing about this run's
 * activity, and knowing nothing must never be spent as "the agent is idle".
 */
export async function storeActivity(run) {
  if (!run?.workdir_effective || !run.started_at) return null
  const path = storePath()
  if (!existsSync(path)) return null
  const since = Date.parse(run.started_at.replace(' ', 'T') + 'Z') - 5000
  if (!Number.isFinite(since)) return null
  let d = null
  try {
    const { DatabaseSync } = await import('node:sqlite')
    d = new DatabaseSync(path, { readOnly: true })
    return readRun(d, run.workdir_effective, since)
  } catch {
    return null
  } finally {
    try { d?.close() } catch {}
  }
}
