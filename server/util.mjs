// cc-hub — small helpers without external dependencies.
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { t } from './i18n.mjs'

export const HOME = homedir()
export const RUNS_DIR = process.env.CCHUB_RUNS_DIR ?? `${HOME}/agents/runs`
export const WORKTREES_DIR = process.env.CCHUB_WORKTREES_DIR ?? `${HOME}/agents/worktrees`

export function kurzid(uuid) { return uuid.split('-')[0] }

/** Strip ANSI + CR from the pipe-pane log for the HTML log view (planning 7.2). */
export function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r/g, '')
}

export function sh(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeout ?? 30_000, encoding: 'utf8', ...opts },
      (err, stdout, stderr) => resolve({ ok: !err, code: err?.code ?? 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }))
  })
}

export async function tmux(args) { return sh('tmux', args) }

/**
 * Type text into a tmux session as if a human had pasted it: bracketed paste
 * (multi-line without an accidental submit) followed by Enter (planning 7.3).
 * Shared by the run detail page and the flow step "send message".
 */
export async function sendToSession(session, text) {
  const r = await sh('tmux', ['send-keys', '-t', `=${session}:`, '-l', '--', '\x1b[200~' + String(text ?? '') + '\x1b[201~'])
  if (!r.ok) return r
  await new Promise(resolve => setTimeout(resolve, 300))
  return sh('tmux', ['send-keys', '-t', `=${session}:`, 'Enter'])
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

export function fmtDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '–'
  const m = Math.floor(sec / 60), h = Math.floor(m / 60)
  return h > 0 ? `${h} h ${m % 60} min` : `${m} min`
}

// Minimal 5-field cron (minute hour day month weekday): *, *&#47;n, a-b, lists.
const CRON_MAX = [59, 23, 31, 12, 6]
/** Checks whether an expression is understood by cronMatches at all (5 fields). */
export function validCron(expr) {
  const fields = String(expr ?? '').trim().split(/\s+/)
  if (fields.length !== 5) return false
  return fields.every((f, i) => f.split(',').every(part => {
    const [range, step] = part.split('/')
    if (step !== undefined && !/^\d+$/.test(step)) return false
    if (range === '*') return true
    if (range.includes('-')) {
      const [lo, hi] = range.split('-')
      return /^\d+$/.test(lo) && /^\d+$/.test(hi) && +lo <= +hi && +hi <= CRON_MAX[i]
    }
    return /^\d+$/.test(range) && +range <= CRON_MAX[i]
  }))
}

export function cronMatches(expr, date = new Date()) {
  const fields = String(expr).trim().split(/\s+/)
  if (fields.length !== 5) return false
  const values = [date.getMinutes(), date.getHours(), date.getDate(), date.getMonth() + 1, date.getDay()]
  for (let i = 0; i < 5; i++) {
    if (!fieldMatches(fields[i], values[i], CRON_MAX[i], i === 4)) return false
  }
  return true
}
function fieldMatches(field, value, max, dowWrap) {
  for (const part of field.split(',')) {
    const [range, stepRaw] = part.split('/')
    const step = Math.max(1, Number.parseInt(stepRaw ?? '1', 10))
    let lo, hi
    if (range === '*') { lo = 0; hi = max }
    else if (range.includes('-')) { [lo, hi] = range.split('-').map(Number) }
    else { lo = hi = Number(range) }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue
    for (let v = lo; v <= hi; v += step) {
      const vv = dowWrap && v === 7 ? 0 : v
      if (vv === value) return true
    }
  }
  return false
}

// ---------------- schedules beyond cron (planning: graphical selection) ----------------
// Display names are i18n keys, resolved with t() where they are rendered.
export const WOCHENTAGE = [
  { n: 1, key: 'day.mon' }, { n: 2, key: 'day.tue' }, { n: 3, key: 'day.wed' },
  { n: 4, key: 'day.thu' }, { n: 5, key: 'day.fri' }, { n: 6, key: 'day.sat' },
  { n: 0, key: 'day.sun' },
]

const zwei = (n) => String(n).padStart(2, '0')

/** Monday 00:00 of the week the date falls in (local time). */
function wochenstart(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const versatz = (x.getDay() + 6) % 7          // Mon=0 … Sun=6
  x.setDate(x.getDate() - versatz)
  return x
}

/**
 * Is the agent due in this minute? Asked by the scheduler every 30 seconds;
 * the minute itself is debounced there against double starts.
 */
export function scheduleDue(agent, now = new Date()) {
  switch (agent.schedule_kind) {
    case 'cron':
      return !!agent.schedule?.trim() && cronMatches(agent.schedule, now)

    case 'woechentlich': {
      if (!agent.schedule_time || !agent.schedule_days) return false
      if (agent.schedule_time !== `${zwei(now.getHours())}:${zwei(now.getMinutes())}`) return false
      const tage = String(agent.schedule_days).split(',').map(Number)
      if (!tage.includes(now.getDay())) return false
      const n = Number(agent.schedule_weeks) || 1
      if (n <= 1) return true
      // Every-n-weeks counts whole weeks from the anchor week — not from the day.
      if (!agent.schedule_anchor) return true
      const anker = new Date(`${agent.schedule_anchor}T00:00:00`)
      if (Number.isNaN(anker.getTime())) return true
      const wochen = Math.round((wochenstart(now) - wochenstart(anker)) / (7 * 86400000))
      return wochen >= 0 && wochen % n === 0
    }

    case 'einmalig': {
      if (!agent.run_at) return false
      const ziel = new Date(agent.run_at)
      // Due from that point in time — a missed appointment (hub was off) is caught up.
      return !Number.isNaN(ziel.getTime()) && ziel.getTime() <= now.getTime()
    }

    default:
      return false      // 'manuell'
  }
}

/** One-liner for the agent list. */
export function scheduleText(agent) {
  switch (agent.schedule_kind) {
    case 'cron': return `Cron: ${agent.schedule}`
    case 'einmalig': return agent.run_at
      ? t('sched.once_on', { ts: String(agent.run_at).replace('T', ' ') })
      : t('sched.once_none')
    case 'woechentlich': {
      const days = String(agent.schedule_days ?? '').split(',').filter(x => x !== '')
        .map(x => { const w = WOCHENTAGE.find(w => w.n === Number(x)); return w ? t(w.key) : x }).join(', ')
      const n = Number(agent.schedule_weeks) || 1
      const takt = n === 1 ? t('sched.weekly_word') : t('sched.every_n_weeks', { n })
      return t('sched.weekly_line', { takt, days: days || t('sched.no_days'), time: agent.schedule_time ?? '??:??' })
    }
    default: return t('sched.manual')
  }
}
