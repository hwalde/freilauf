// Freilauf flows — the production `api` object the steps run against. This is the
// ONLY file in the flow module that touches the rest of the hub for side effects
// (tmux, notifications, run creation). Tests pass a stub with the same shape.
import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import db, { addEvent } from '../db.mjs'
import { RUNS_DIR, sh, sendToSession, kurzid } from '../util.mjs'
import { terminalText } from '../detect.mjs'
// Imported under a different name: the api object below has a method called
// `notify` too, and one of the two reading as the other is a trap worth a line.
import { notify as notifyChannels } from '../notify.mjs'
import { detailUrl, publicBase } from '../util.mjs'
import { startForAgent, startRun } from '../scheduler.mjs'
import { extractStructured } from './llm.mjs'
import { markStartedByFlow } from './db.mjs'

const LOG_TAIL_BYTES = 48 * 1024
const TRANSCRIPT_TAIL_BYTES = 256 * 1024   // JSONL is verbose — more bytes than the log for the same amount of text
const SHELL_OUTPUT_BYTES = 20 * 1024       // what a flow variable carries of a command's output
const SHELL_MAX_BUFFER = 8 * 1024 * 1024   // what the command may print at all before it counts as broken

const iso = (s) => (s ? s.replace(' ', 'T') + 'Z' : null)

/** The end of a command's output — that is where the interesting part of a build or a test run is. */
const lastBytes = (text) => {
  const s = String(text ?? '')
  return s.length <= SHELL_OUTPUT_BYTES ? s : s.slice(-SHELL_OUTPUT_BYTES)
}

/**
 * Everything a flow may know about a run — the shape behind `trigger.run` and
 * the output of "start agent"/"start single run" with wait. Only the report is
 * included verbatim; the terminal log is fetched on demand (runText).
 */
export function runInfo(runId) {
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId)
  if (!run) return null
  const agent = run.agent_id ? db.prepare('SELECT name FROM agents WHERE id = ?').get(run.agent_id) : null
  const repo = db.prepare('SELECT name, path FROM repos WHERE id = ?').get(run.repo_id)
  const incidents = db.prepare('SELECT COUNT(*) AS n FROM incidents WHERE run_id = ?').get(runId)?.n ?? 0
  const startMs = Date.parse(iso(run.started_at))
  const endMs = run.ended_at ? Date.parse(iso(run.ended_at)) : Date.now()
  const finished = ['done', 'failed', 'aborted'].includes(run.status)
  return {
    id: run.id,
    short_id: kurzid(run.id),
    status: run.status,
    // 'done' | 'failed' | 'aborted' for finished runs, '' while still going
    outcome: finished ? run.status : '',
    ended_normally: run.status === 'done',
    agent_id: run.agent_id ?? null,
    agent_name: agent?.name ?? '',
    repo_id: run.repo_id,
    repo_name: repo?.name ?? '',
    repo_path: repo?.path ?? '',
    harness: run.harness,
    model: run.model ?? '',
    provider: run.provider ?? '',
    branch: run.branch_reported || run.branch_expected || '',
    pr_url: run.pr_url ?? '',
    report: run.report_md ?? '',
    // A finished run can report AGAIN (server/reports.mjs, follow-up reports):
    // `report` then carries all of it, `last_report` only the latest text — the
    // one a flow that fires on the follow-up usually wants — and `followups`
    // says how many there were (0 for a run that reported once).
    followups: run.followups ?? 0,
    last_report: run.followup_md ?? run.report_md ?? '',
    help_text: run.help_text ?? '',
    exit_code: run.exit_code ?? null,
    duration_min: Number.isFinite(startMs) ? Math.round((endMs - startMs) / 60000) : 0,
    started_at: run.started_at,
    ended_at: run.ended_at ?? '',
    incidents,
    worktree: run.worktree ?? '',
    // Where the work ended up. Owned by the merge integrator and only read here;
    // a run whose integration has not said anything yet — and every run of an
    // installation that does not integrate at all — reports '' rather than
    // making a flow blind. Same answer `outcome` gives while a run is going.
    merge_status: run.merge_status ?? '',
    merged_sha: run.merged_sha ?? '',
    url: detailUrl(run.id),
    flow_run_id: run.flow_run_id ?? null,
  }
}

/** Last `max` bytes of a file as UTF-8 (whole file when it is smaller). */
function tailBytes(file, max) {
  const size = statSync(file).size
  const len = Math.min(size, max)
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, size - len)
    return { text: buf.toString('utf8'), truncated: size > len }
  } finally { closeSync(fd) }
}

/**
 * Claude transcript (JSONL) as readable text: what the agent actually said and
 * did, not what the terminal drew. Only claude keeps one (path from --session-id,
 * see watcher.mjs); every other harness falls back to the log tail in runText().
 * Tool calls and results are flattened to one line each — the model needs the
 * gist, not the payloads.
 */
async function transcriptText(runId) {
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId)
  if (!run || run.harness !== 'claude' || !run.workdir_effective) return ''
  // Dynamic import: watcher.mjs imports the flow module — a static import would close the cycle.
  const { claudeTranskriptPfad } = await import('../watcher.mjs')
  const f = claudeTranskriptPfad(run)
  if (!existsSync(f)) return ''
  const { text, truncated } = tailBytes(f, TRANSCRIPT_TAIL_BYTES)
  const out = []
  // A truncated tail starts mid-line — that first fragment is not valid JSON anyway.
  for (const line of text.split('\n').slice(truncated ? 1 : 0)) {
    let j
    try { j = JSON.parse(line) } catch { continue }
    const role = j.message?.role ?? j.type
    if (!['user', 'assistant'].includes(role)) continue
    const content = j.message?.content
    const parts = []
    for (const c of Array.isArray(content) ? content : [content]) {
      if (typeof c === 'string') { parts.push(c); continue }
      if (c?.type === 'text' && c.text) parts.push(c.text)
      else if (c?.type === 'thinking' && c.thinking) parts.push(`(thinking) ${c.thinking}`)
      else if (c?.type === 'tool_use') parts.push(`[tool ${c.name}] ${JSON.stringify(c.input ?? {}).slice(0, 400)}`)
      else if (c?.type === 'tool_result') {
        const t = typeof c.content === 'string' ? c.content : JSON.stringify(c.content ?? '')
        parts.push(`[result] ${t.slice(0, 400)}`)
      }
    }
    const body = parts.join('\n').trim()
    if (body) out.push(`### ${role}\n${body}`)
  }
  return out.join('\n\n')
}

/** Last bytes of the pipe-pane log, cleaned of escape sequences and redraw noise. */
function logTail(runId) {
  const f = join(RUNS_DIR, runId, 'log.txt')
  if (!existsSync(f)) return ''
  const lines = terminalText(tailBytes(f, LOG_TAIL_BYTES).text).split('\n').map(l => l.trimEnd())
  const out = []
  for (const l of lines) if (l && l !== out[out.length - 1]) out.push(l)
  return out.join('\n')
}

export const actions = {
  now: () => Date.now(),
  runInfo: async (runId) => runInfo(runId),

  /** Runs matching a selector: { runId } | { agentId } | { repoId } | {} (+ statuses). */
  async findRuns({ runId = null, agentId = null, repoId = null, statuses = ['running', 'waiting_help'] }) {
    const where = [], args = []
    if (runId) { where.push('id = ?'); args.push(runId) }
    if (agentId) { where.push('agent_id = ?'); args.push(agentId) }
    if (repoId) { where.push('repo_id = ?'); args.push(repoId) }
    if (statuses?.length) { where.push(`status IN (${statuses.map(() => '?').join(',')})`); args.push(...statuses) }
    return db.prepare(`SELECT * FROM runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY started_at DESC LIMIT 50`).all(...args)
  },

  /**
   * Runs for COUNTING — `{ id, title, status, repo_id, agent_id }` each, newest
   * first, and deliberately **without a LIMIT**.
   *
   * `findRuns` above answers the other question: "which live runs do I act on
   * now?", where fifty is a sane ceiling and the full row is what `sendToRun`
   * and `killRun` need. A count that silently stops at fifty is not a count —
   * it is a number that agrees with reality right up to the moment the answer
   * starts to matter. So this one stays narrow in columns instead of in rows.
   */
  async listRuns({ repoId = null, agentId = null, statuses = null } = {}) {
    const where = [], args = []
    if (repoId) { where.push('repo_id = ?'); args.push(repoId) }
    if (agentId) { where.push('agent_id = ?'); args.push(agentId) }
    if (statuses?.length) { where.push(`status IN (${statuses.map(() => '?').join(',')})`); args.push(...statuses) }
    return db.prepare(`SELECT id, title, status, repo_id, agent_id FROM runs
                       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                       ORDER BY started_at DESC`).all(...args)
  },

  async sendToRun(run, text) {
    if (!run.tmux_session) return { ok: false }
    const r = await sendToSession(run.tmux_session, text)
    if (r.ok) {
      db.prepare(`UPDATE runs SET last_activity_at=datetime('now') WHERE id=?`).run(run.id)
      if (run.status === 'waiting_help') {
        // Same rule as the send route (and as the agent's own `_working`
        // hook): the finish gate's deadline is paused while a run waits for an
        // answer and starts again when it gets one — reports.mjs, answerHelpCall.
        const { answerHelpCall } = await import('../reports.mjs')
        answerHelpCall(run.id, text, 'flow')
      }
      // Through addEvent() like everywhere else — a hand-rolled INSERT here
      // bypasses the one place that knows a run has changed.
      addEvent(run.id, 'flow_message', { text: text.slice(0, 500) })
    }
    return r
  },

  async killRun(run) {
    if (run.tmux_session) await sh('tmux', ['kill-session', '-t', `=${run.tmux_session}`])
    const r = db.prepare(`UPDATE runs SET status='aborted', ended_at=COALESCE(ended_at, datetime('now')),
                tmux_closed_at=COALESCE(tmux_closed_at, datetime('now')), agent_state=NULL, agent_state_at=NULL
                WHERE id=? AND status IN ('running','waiting_help','deferred')`).run(run.id)
    // Only when a row really changed: the status guard above means a run that
    // was already over is left alone, and an 'aborted' event for it would lie.
    if (r.changes) addEvent(run.id, 'aborted', { by: 'flow' })
    return true
  },

  async startAgent(agentId, promptExtra, flowRunId) {
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId)
    if (!agent) return { ok: false, error: `agent ${agentId} does not exist` }
    const r = await startForAgent(agent, promptExtra)
    if (r.runId) markStartedByFlow(r.runId, flowRunId)
    return r
  },

  /**
   * The stored agent as a flow may see it: `{ id, name, repo_id, active }`, or
   * `null` for an id nobody has. Its one caller is `toggle_agent` in "toggle"
   * mode, which cannot name the state it wants without reading the one it has —
   * and a step reads state through here, never off the database itself.
   */
  async agentInfo(agentId) {
    const a = db.prepare('SELECT id, name, repo_id, active FROM agents WHERE id = ?').get(agentId)
    return a ? { id: a.id, name: a.name, repo_id: a.repo_id, active: a.active === 1 } : null
  },

  /**
   * Switch an agent's schedule on or off — the row behind the toggle on the
   * agents page. Answers `{ ok, id, name, active_before, active_after }`, and
   * `{ ok: false, error }` for an id that does not exist.
   *
   * `active = 0` gates the SCHEDULED starts only (the `WHERE active = 1` in
   * `scheduler.mjs`'s tick). A manual start, a flow start and an API start all
   * walk past it, deliberately — the switch means "stop firing by yourself",
   * not "this agent is forbidden".
   */
  async setAgentActive(agentId, on) {
    const agent = db.prepare('SELECT id, name, active FROM agents WHERE id = ?').get(agentId)
    if (!agent) return { ok: false, error: `agent ${agentId} does not exist` }
    const after = on ? 1 : 0
    // Written even when the value does not change: `updated_at` is what the
    // agents page reports on, and "somebody confirmed this state" is a fact.
    db.prepare(`UPDATE agents SET active = ?, updated_at = datetime('now') WHERE id = ?`).run(after, agentId)
    return { ok: true, id: agent.id, name: agent.name, active_before: agent.active === 1, active_after: after === 1 }
  },

  /**
   * Start this agent, but only if it is not busy already — the same
   * `startForAgent()` the "start now" button uses, with one query in front.
   * Answers `{ ok: true, runId: null, busy: true }` when a run of this agent is
   * still going.
   *
   * Busy is `running`, `waiting_help` **and `deferred`**: a deferred run has not
   * started yet, but it is queued and it WILL start, so letting a second one
   * through would put two runs of the same agent on the same repository — the
   * very thing the caller asked to prevent, only later and harder to see.
   */
  async startAgentIfIdle(agentId, flowRunId) {
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId)
    if (!agent) return { ok: false, error: `agent ${agentId} does not exist` }
    const busy = db.prepare(`SELECT id FROM runs WHERE agent_id = ?
                             AND status IN ('running','waiting_help','deferred') LIMIT 1`).get(agentId)
    if (busy) return { ok: true, runId: null, busy: true }
    const r = await startForAgent(agent)
    if (r.runId) markStartedByFlow(r.runId, flowRunId)
    return r
  },

  /** A run definition without an agent — same start path as the run form. */
  async startSingle(def, repoId, flowRunId) {
    const r = await startRun(def, { repoId })
    if (r.runId) markStartedByFlow(r.runId, flowRunId)
    return r
  },

  /**
   * A message from a flow to whatever channels are configured. The link points
   * where the reader wants to go: the run the flow is about, otherwise the flow
   * run itself. Deliberately NOT through notifyRun() — its dedupe is meant for
   * the watcher's own alarms and would swallow a second flow message about the
   * same run.
   *
   * With nothing configured this answers `false` and the step says so in its
   * log line; it is not an error, and the flow carries on.
   */
  async notify(text, attachment = '', link = {}) {
    const url = link.runId ? detailUrl(link.runId)
      : link.flowRunId ? `${publicBase()}/flows/runs/${link.flowRunId}`
        : `${publicBase()}/flows`
    const full = `${text}\n\n${url}`
    const r = await notifyChannels({
      kind: 'flow',
      runId: link.runId ?? null,
      text: full,
      url,
      attachment: attachment?.trim() ? { fileName: 'flow-attachment.md', content: attachment } : null,
    })
    return r.sent
  },

  /** Text of a run for extraction: report, terminal log tail, or both. */
  async runText(runId, source) {
    const info = runInfo(runId)
    if (!info) throw new Error(`run ${runId} does not exist`)
    const head = `Run ${info.id} — ${info.agent_name || 'single run'} @ ${info.repo_name} (${info.harness}${info.model ? '/' + info.model : ''}), status ${info.status}, branch ${info.branch || '-'}, PR ${info.pr_url || '-'}\n\n`
    if (source === 'transcript') {
      const tr = await transcriptText(runId)
      return tr ? head + '## Transcript (tail)\n' + tr
        : head + '## Transcript\n(none — only claude runs keep one, terminal log instead)\n\n## Terminal log (tail)\n' + logTail(runId)
    }
    if (source === 'log') return head + '## Terminal log (tail)\n' + logTail(runId)
    if (source === 'report_and_log') return head + '## Report\n' + (info.report || '(none)') + '\n\n## Terminal log (tail)\n' + logTail(runId)
    return head + '## Report\n' + (info.report || '(none)')
  },

  extract: (args) => extractStructured(args),

  /**
   * A shell command on the hub machine, as the hub's user.
   *
   * Two things it does deliberately differently from every other action here.
   *
   * A non-zero exit is a RESULT, not a failure of the step: the flow is meant
   * to branch on `{{vars.shell.ok}}`. Only a command that never ran to its own
   * end throws — a missing working directory, a spawn error, the timeout.
   * util.sh() flattens execFile's error, so those are told apart by the code it
   * reports: a string is a spawn failure (ENOENT …), and a killed process
   * carries no code at all, which `?? 0` turns into a 0 that `ok:false` proves
   * cannot be an exit code.
   *
   * `detach` runs the command in its own session and returns at once — the same
   * `setsid -f` the StopFailure hook uses in runner.mjs, and for the same
   * reason: the command must survive the process that started it. Here that is
   * the point rather than a detail, because the command may be the one that
   * restarts this very hub. The redirections are done by the shell itself
   * (`exec` before the command), so the detached child holds no pipe of ours
   * open — otherwise execFile would sit and wait for it after all, whatever the
   * command looks like.
   */
  /*
   * And what this function must never be handed: a command line an AGENT wrote.
   * `bash -lc` here is the host, as the operator, outside every sandbox — so a
   * template that interpolates a run's report, help text, branch, PR or merged
   * file names is agent-authored host code. The refusal lives in the STEP
   * (`agentWrittenVars()` in steps.mjs, an opt-in per step), not here, because
   * this function also serves callers with no template at all; what belongs
   * here is the reason it is refused up there.
   */
  async shell({ command, cwd, timeoutMs, detach }) {
    const dir = String(cwd ?? '').trim() || homedir()
    if (!existsSync(dir)) throw new Error(`working directory does not exist: ${dir}`)
    if (detach) {
      const r = await sh('setsid', ['-f', 'bash', '-lc', `exec </dev/null >/dev/null 2>&1\n${command}`],
        { cwd: dir, timeout: 15_000 })
      if (!r.ok) throw new Error(`command could not be detached: ${r.stderr.trim() || r.code}`)
      return { ok: true, detached: true }
    }
    const r = await sh('bash', ['-lc', command], { cwd: dir, timeout: timeoutMs, maxBuffer: SHELL_MAX_BUFFER })
    if (!r.ok && typeof r.code !== 'number') throw new Error(`command could not be started: ${r.stderr.trim() || r.code}`)
    if (!r.ok && r.code === 0) throw new Error(`command did not finish within ${Math.round(timeoutMs / 60_000)} min`)
    return { ok: r.code === 0, exit_code: r.code, stdout: lastBytes(r.stdout), stderr: lastBytes(r.stderr) }
  },

  async http({ url, method, headers, body }) {
    const init = { method, headers: { ...headers }, signal: AbortSignal.timeout(60_000) }
    if (!['GET', 'HEAD'].includes(method) && body) {
      init.body = body
      if (!Object.keys(init.headers).some(h => h.toLowerCase() === 'content-type')) init.headers['content-type'] = 'application/json'
    }
    const res = await fetch(url, init)
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* not JSON */ }
    return { status: res.status, ok: res.ok, body: text.slice(0, 20_000), json }
  },
}

