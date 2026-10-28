// Freilauf — the facts about a run that the hub's own LLM texts are built on.
//
// The deputy (server/triage.mjs) and the daily digest (server/digest.mjs) both
// hand a model numbers and comparisons. Models are bad at arithmetic and worse
// at noticing a number in prose, so everything that can be computed is computed
// HERE and handed over as a finished sentence: "3.4 times as long as usual",
// "last told 3 days ago". The prompts then only have to judge.
//
// Also here: quoting untrusted text into a prompt (`escapeData`, `clip`). A
// report is written by an agent; a `</report_short>` inside it must not be able
// to close its tag.
import db from './db.mjs'
import { parseDbUtc, scheduleDue, scheduleText, uiTimezone } from './util.mjs'
import { TYPE_TEXT } from './detect.mjs'

/** `<`, `>` and `&` masked — what every quoted text in a prompt goes through. */
export function escapeData(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Shorten a long text to its beginning and its end, with a note in between —
 * the start of a report says what it is about, the end usually what came of it.
 */
export function clip(text, max) {
  const s = String(text ?? '')
  if (s.length <= max) return s
  const head = Math.floor(max * 0.7)
  const tail = Math.max(0, max - head - 60)
  return `${s.slice(0, head)}\n… [shortened: ${s.length - head - tail} characters left out] …\n${s.slice(s.length - tail)}`
}

/** Cut at the last sentence end before `max`, or at a word, with an ellipsis. */
export function cutSentence(text, max) {
  const s = String(text ?? '').trim()
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '), cut.lastIndexOf('。'))
  if (end > max * 0.5) return cut.slice(0, end + 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.5 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/** 'YYYY-MM-DD HH:MM' in the configured timezone — the stamp prompts carry. */
export function stamp(ms) {
  if (!Number.isFinite(ms)) return ''
  try {
    return new Date(ms).toLocaleString('sv-SE', {
      timeZone: uiTimezone(), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    })
  } catch {
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
  }
}

export function median(values) {
  const v = values.filter(x => Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return null
  const mid = Math.floor(v.length / 2)
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}

/** "3 min", "2 h 5 min", "1 d 4 h". */
export function minutesText(min) {
  if (!Number.isFinite(min)) return 'unknown'
  const m = Math.max(0, Math.round(min))
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} h${m % 60 ? ` ${m % 60} min` : ''}`
  return `${Math.floor(h / 24)} d${h % 24 ? ` ${h % 24} h` : ''}`
}

/** Minutes the run worked: from its start to its end, or to now. */
export function runMinutes(run, nowMs = Date.now()) {
  const start = parseDbUtc(run?.started_at)
  if (!Number.isFinite(start)) return null
  const end = parseDbUtc(run?.ended_at)
  return ((Number.isFinite(end) ? end : nowMs) - start) / 60000
}

/**
 * Token numbers as the run carries them — or null for "unknown". The columns
 * default to 0, and a coding agent that reports no usage leaves them there; a
 * real run with zero tokens does not exist, so 0 means "not measured".
 */
export function tokensOf(run) {
  const tin = Number(run?.tokens_in) || 0
  const tout = Number(run?.tokens_out) || 0
  return tin || tout ? { in: tin, out: tout } : null
}

function kTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

/** What this agent's ended runs usually take: median duration and tokens of the last ten. */
export function agentUsual(agentId, excludeRunId = null) {
  if (!agentId) return null
  const rows = db.prepare(`SELECT * FROM runs WHERE agent_id=? AND id<>? AND status IN ('done','failed')
    AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 10`).all(agentId, excludeRunId ?? '')
  if (!rows.length) return null
  const toks = rows.map(tokensOf).filter(Boolean)
  return {
    n: rows.length,
    minutes: median(rows.map(r => runMinutes(r))),
    tokensIn: toks.length ? median(toks.map(x => x.in)) : null,
    tokensOut: toks.length ? median(toks.map(x => x.out)) : null,
  }
}

function ratioText(value, usual) {
  if (!Number.isFinite(value) || !Number.isFinite(usual) || usual <= 0) return ''
  const r = value / usual
  if (r >= 1.5) return `${r.toFixed(1)} times as long as usual`
  if (r <= 0.5) return `${r.toFixed(1)} of the usual time`
  return 'about as usual'
}

/** The latest `merged` event: what landed on the base branch. */
export function mergedInfo(runId) {
  const ev = db.prepare(`SELECT payload FROM events WHERE run_id=? AND kind='merged' ORDER BY id DESC LIMIT 1`).get(runId)
  if (!ev) return null
  try {
    const p = JSON.parse(ev.payload ?? '{}') ?? {}
    return { sha: p.sha ?? null, files: Array.isArray(p.files) ? p.files.length : null,
      commits: Number.isFinite(p.commits) ? p.commits : null, already: !!p.already }
  } catch { return null }
}

/** One phrase for where the run's work went. */
export function sizeText(run) {
  const merged = mergedInfo(run.id)
  const ms = String(run.merge_status ?? '')
  if (merged) {
    if (merged.already) return 'merged into the base branch (it was already there)'
    return `merged into the base branch${merged.sha ? ` as ${String(merged.sha).slice(0, 7)}` : ''}` +
      (merged.commits != null ? `, ${merged.commits} commit(s)` : '') +
      (merged.files != null ? `, ${merged.files} file(s) changed` : '')
  }
  if (!ms) return 'no merge by the hub (the repository does not integrate, or nothing to merge)'
  const words = {
    nothing: 'nothing to merge (no commits)',
    kept_on_branch: 'kept on its branch, not merged',
    in_review: 'waiting in code review',
    changes_requested: 'code review asked for changes',
    resolving: 'a conflict run is resolving a merge conflict',
    approved: 'approved in review, merge pending',
  }
  if (words[ms]) return words[ms]
  if (ms.startsWith('blocked_')) return `NOT merged: blocked (${ms.slice('blocked_'.length).replace(/_/g, ' ')})`
  return `merge status: ${ms}`
}

/** "provider outage (OpenRouter) ×2, rate limit ×3" — or ''. */
export function incidentsText(runId) {
  const rows = db.prepare(`SELECT typ, quelle, anzahl FROM incidents WHERE run_id=? ORDER BY id`).all(runId)
  return rows.map(r => `${TYPE_TEXT[r.typ] ?? r.typ}${r.quelle ? ` (${r.quelle})` : ''} ×${r.anzahl}`).join(', ')
}

/** Who started the run: a schedule, the operator, or a flow after another run. */
export function startedByText(run) {
  try {
    if (run.flow_run_id) {
      const fr = db.prepare(`SELECT fr.trigger_run_id, f.name FROM flow_runs fr LEFT JOIN flows f ON f.id = fr.flow_id WHERE fr.id=?`).get(run.flow_run_id)
      if (fr) {
        const prev = fr.trigger_run_id ? db.prepare('SELECT * FROM runs WHERE id=?').get(fr.trigger_run_id) : null
        return `flow "${fr.name ?? '?'}"${prev ? ` after a run of ${runName(prev)}` : ''}`
      }
    }
  } catch { /* flows module tables may be missing in a bare test db */ }
  const slot = db.prepare(`SELECT 1 FROM schedule_log WHERE run_id=? LIMIT 1`).get(run.id)
  if (slot) return 'schedule'
  if (!run.agent_id) return 'the operator, by hand (single run)'
  // Before the start protocol existed (or for a slot it did not see) a
  // scheduled start is still recognisable: it began in a minute its agent's
  // schedule names.
  const agent = db.prepare('SELECT * FROM agents WHERE id=?').get(run.agent_id)
  const start = parseDbUtc(run.started_at)
  if (agent && Number.isFinite(start) && scheduleDue(agent, new Date(Math.floor(start / 60000) * 60000))) return 'schedule'
  return 'the operator, by hand (agent started outside its schedule)'
}

/** The project's name. */
export function projectName(run) {
  return db.prepare('SELECT name FROM repos WHERE id=?').get(run.repo_id)?.name ?? '?'
}

/** An agent run is named by its agent, a single run by its title. */
export function runName(run) {
  const a = run.agent_id ? db.prepare('SELECT name FROM agents WHERE id=?').get(run.agent_id)?.name : null
  return a ? `agent "${a}"` : `single run "${run.title ?? '?'}"`
}

/** The plain name for a heading: agent name or run title. */
export function displayName(run) {
  const a = run.agent_id ? db.prepare('SELECT name FROM agents WHERE id=?').get(run.agent_id)?.name : null
  return a ?? run.title ?? String(run.id).slice(0, 8)
}

const RESULT_MARK = { success: '✓', no_change: '○', partial: '◐', failed: '✗', unclear: '?' }

/** The agent's assessed results, oldest first, as a chain of marks. */
export function lastOutcomes(agentId, beforeId = null, limit = 7) {
  if (!agentId) return ''
  const rows = db.prepare(`SELECT n.result FROM report_notes n JOIN runs r ON r.id = n.run_id
    WHERE r.agent_id=? AND n.kind IN ('report','event') AND n.result IS NOT NULL ${beforeId ? 'AND n.id < ?' : ''}
    ORDER BY n.id DESC LIMIT ?`).all(...(beforeId ? [agentId, beforeId, limit] : [agentId, limit]))
  return rows.reverse().map(r => RESULT_MARK[r.result] ?? '?').join(' ')
}

/**
 * When the operator was last told about this agent, per cause — the date, the
 * level and how long ago. The cause of THIS run is what the deputy is about to
 * find out, so every cause the operator heard about is listed (newest first,
 * at most four): what the "remind me after three days" rule needs, without the
 * model digging it out of a history that may be shorter than three days.
 */
export function lastTold(agentId, runId, beforeId = null) {
  const where = agentId ? 'r.agent_id = ?' : 'n.run_id = ?'
  const rows = db.prepare(`SELECT COALESCE(n.cause, 'none') AS cause, MAX(n.sent_at) AS sent_at,
      (SELECT n2.level_sent FROM report_notes n2 JOIN runs r2 ON r2.id = n2.run_id
        WHERE ${where.replace('r.', 'r2.').replace('n.', 'n2.')} AND COALESCE(n2.cause, 'none') = COALESCE(n.cause, 'none')
          AND n2.sent_at IS NOT NULL ${beforeId ? 'AND n2.id < ?' : ''} ORDER BY n2.sent_at DESC LIMIT 1) AS level
    FROM report_notes n JOIN runs r ON r.id = n.run_id
    WHERE ${where} AND n.sent_at IS NOT NULL ${beforeId ? 'AND n.id < ?' : ''}
    GROUP BY COALESCE(n.cause, 'none') ORDER BY MAX(n.sent_at) DESC LIMIT 4`)
    .all(...(beforeId ? [agentId ?? runId, beforeId, agentId ?? runId, beforeId] : [agentId ?? runId, agentId ?? runId]))
  if (!rows.length) return 'never'
  return rows.map(row => {
    const ms = parseDbUtc(row.sent_at)
    const days = Number.isFinite(ms) ? Math.floor((Date.now() - ms) / 86_400_000) : null
    const ago = days == null ? '' : days === 0 ? ' (today)' : ` (${days} day${days === 1 ? '' : 's'} ago)`
    return `cause ${row.cause}: ${stamp(ms).slice(0, 10)}, ${row.level}${ago}`
  }).join('; ')
}

/** The schedule as one sentence, for an agent run. */
export function scheduleLine(run) {
  if (!run.agent_id) return ''
  const agent = db.prepare('SELECT * FROM agents WHERE id=?').get(run.agent_id)
  return agent ? scheduleText(agent) : ''
}

/**
 * The fact lines of one run, in the shape the deputy's <run_facts> holds. The
 * caller adds the lines that depend on the note (report number, outcome).
 */
export function runFactLines(run, { beforeNoteId = null } = {}) {
  const lines = []
  lines.push(`project: ${projectName(run)}`)
  const sched = scheduleLine(run)
  lines.push(run.agent_id ? `agent: ${displayName(run)}${sched ? ` — ${sched}` : ''}` : `single run: ${run.title ?? '?'}`)
  lines.push(`started_by: ${startedByText(run)}`)
  const usual = agentUsual(run.agent_id, run.id)
  const min = runMinutes(run)
  const durParts = [`expected ${minutesText(run.expected_minutes)}`]
  if (usual?.minutes != null) durParts.push(`usual for this agent: ${minutesText(usual.minutes)}`)
  const ratio = ratioText(min, usual?.minutes)
  lines.push(`duration: ${minutesText(min)} (${durParts.join('; ')})${ratio ? ` — ${ratio}` : ''}`)
  lines.push(`size: ${sizeText(run)}`)
  const tok = tokensOf(run)
  const cost = Number.isFinite(run.cost_usd) && run.cost_usd > 0 ? `, $${run.cost_usd.toFixed(2)}` : ''
  if (tok) {
    const u = usual?.tokensIn != null ? ` (usual: in ${kTokens(usual.tokensIn)} / out ${kTokens(usual.tokensOut)})` : ''
    lines.push(`usage: in ${kTokens(tok.in)} / out ${kTokens(tok.out)} tokens${u}${cost}`)
  } else {
    lines.push(`usage: unknown (this coding agent reports no token numbers)${cost}`)
  }
  const inc = incidentsText(run.id)
  if (inc) lines.push(`incidents: ${inc}`)
  if (run.agent_id) {
    const chain = lastOutcomes(run.agent_id, beforeNoteId)
    if (chain) lines.push(`last_outcomes (oldest → newest): ${chain} (then this run)`)
  }
  lines.push(`last_told: ${lastTold(run.agent_id, run.id, beforeNoteId)}`)
  return lines
}
