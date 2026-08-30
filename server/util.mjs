// cc-hub — small helpers without external dependencies.
import { homedir } from 'node:os'
import { execFile, execFileSync } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { t, currentLanguage } from './i18n.mjs'

export const HOME = homedir()
export const RUNS_DIR = process.env.CCHUB_RUNS_DIR ?? `${HOME}/agents/runs`
export const WORKTREES_DIR = process.env.CCHUB_WORKTREES_DIR ?? `${HOME}/agents/worktrees`

/**
 * The commit this hub process is running from, as a short sha — and the empty
 * string when that cannot be answered (a tarball instead of a checkout, no git).
 *
 * Since the service runs from its own deploy checkout (bin/cchub-deploy), "which
 * version is live" stopped being a thing one can see by looking at a directory.
 * The sidebar prints this on every page.
 *
 * Asked at the module's OWN directory, never at the process's working directory:
 * a hub started by hand from somewhere else must not report that somewhere else's
 * commit. Computed once and cached — this is a page render, not a git client, and
 * the answer cannot change while the process lives.
 */
let versionCache
export function hubVersion() {
  if (versionCache === undefined) {
    try {
      versionCache = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: dirname(fileURLToPath(import.meta.url)),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      }).trim()
    } catch { versionCache = '' }
  }
  return versionCache
}

export function kurzid(uuid) { return uuid.split('-')[0] }

/**
 * Public base URL for the links the hub puts into a message: the hostname
 * rather than the IP, so the link matches the certificate in the reader's
 * browser.
 *
 * It used to live in `telegram.mjs`, and it never belonged there: `cleanup.mjs`
 * builds a prompt with it and `flows/actions.mjs` fills `{{trigger.run.url}}`
 * with it — neither is a notification. Here it is what it always was, a fact
 * about this installation, and no notifier plugin has to re-export it.
 */
export function publicBase() {
  // Without CCHUB_PUBLIC_URL the links point nowhere — the note is in env.example.
  return (process.env.CCHUB_PUBLIC_URL
    || `https://127.0.0.1:${process.env.CCHUB_VPN_PORT ?? 8790}`).replace(/\/+$/, '')
}

/** The detail page of one run, or the overview when there is no run. */
export function detailUrl(runId) {
  return runId ? `${publicBase()}/runs/${runId}` : `${publicBase()}/`
}

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
  return h > 0 ? t('unit.hours_minutes', { h, m: m % 60 }) : t('unit.minutes', { n: m })
}

/** SQLite `datetime('now')` is UTC without a timezone suffix. */
export function parseDbUtc(ts) {
  if (ts == null || ts === '') return NaN
  const s = String(ts).trim()
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) return Date.parse(s)
  return Date.parse(s.replace(' ', 'T') + 'Z')
}

/**
 * Relative time in the UI language ("4 seconds ago", "in 20 minutes"). Signed
 * on purpose: the overview shows when a run STARTED, but a planned run says
 * when it WILL start — the same cell, once looking back and once forward. The
 * unit ladder judges by distance, the sign only decides the direction. Keep it
 * in sync with the copy in public/hub.js (no bundler to share it).
 */
export function fmtRelativeTime(thenMs, nowMs = Date.now(), locale = currentLanguage()) {
  if (!Number.isFinite(thenMs) || !Number.isFinite(nowMs)) return '–'
  const sec = Math.round((nowMs - thenMs) / 1000)
  const abs = Math.abs(sec)
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const sag = (n, unit) => rtf.format(sec < 0 ? n : -n, unit)
  if (abs < 60) return sag(abs, 'second')
  const min = Math.floor(abs / 60)
  if (min < 60) return sag(min, 'minute')
  const hr = Math.floor(min / 60)
  if (hr < 24) return sag(hr, 'hour')
  const day = Math.floor(hr / 24)
  if (day < 30) return sag(day, 'day')
  const month = Math.floor(day / 30)
  if (month < 12) return sag(month, 'month')
  return sag(Math.floor(day / 365), 'year')
}

/** SQLite-comparable UTC stamp ("YYYY-MM-DD HH:MM:SS"), the format datetime('now') writes. */
export function toDbUtc(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 19).replace('T', ' ') : null
}

// ---------------- central display format: timezone + numbers ----------------
//
// The timezone every time display follows is a setting (`ui_timezone`, injected
// like the language — this module stays free of db.mjs, see i18n.mjs for why).
// An empty value resolves by UI language, then to the server's own zone. The
// default deliberately preserves the pre-settings behaviour (server local time);
// only an operator who wants otherwise touches the setting.
let tzOverride = null

/** Validate an IANA timezone identifier without installing it. */
export function validTz(iana) {
  if (!iana) return false
  try { new Intl.DateTimeFormat('en-US', { timeZone: String(iana) }); return true } catch { return false }
}

/** The zone a UI language implies, or null when it names none (→ server zone). */
export function timezoneForLanguage(lang = currentLanguage()) {
  if (lang === 'de') return 'Europe/Berlin'
  if (lang === 'zh') return 'Asia/Shanghai'
  return null
}

/** Set the configured timezone; an empty/invalid value falls back to auto. */
export function setTimezone(iana) {
  tzOverride = validTz(iana) ? String(iana) : null
}

/** The timezone in effect: explicit setting → per-language → server default. */
export function uiTimezone() {
  if (tzOverride) return tzOverride
  const sprache = timezoneForLanguage()
  if (sprache) return sprache
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' }
}

/** The zone's abbreviation for the configured timezone at the given instant. */
export function tzAbbrev(ms = Date.now(), locale = currentLanguage()) {
  try {
    const tz = uiTimezone()
    return new Intl.DateTimeFormat(locale, { timeZone: tz, timeZoneName: 'short' })
      .formatToParts(new Date(ms)).find(p => p.type === 'timeZoneName')?.value || ''
  } catch { return '' }
}

/** The timezone labels offered in Settings (common working zones, sorted). */
export const TIMEZONE_OPTIONS = [
  'Europe/Berlin', 'Europe/Vienna', 'Europe/Zurich', 'Europe/Paris', 'Europe/London',
  'Europe/Madrid', 'Europe/Amsterdam', 'Europe/Stockholm', 'Europe/Warsaw', 'Europe/Rome',
  'Europe/Prague', 'Europe/Athens', 'Europe/Kyiv', 'Europe/Moscow',
  'Asia/Shanghai', 'Asia/Taipei', 'Asia/Hong_Kong', 'Asia/Tokyo', 'Asia/Seoul',
  'Asia/Singapore', 'Asia/Kolkata', 'Asia/Dubai',
  'America/Los_Angeles', 'America/New_York', 'America/Chicago', 'America/Denver',
  'America/Phoenix', 'America/Toronto', 'America/Mexico_City', 'America/Sao_Paulo',
  'Australia/Sydney', 'Australia/Melbourne', 'Pacific/Auckland', 'Pacific/Honolulu',
].sort()

/** Exact date+time for a title/tooltip, in the configured timezone. */
export function fmtDateTime(ms, locale = currentLanguage()) {
  if (!Number.isFinite(ms)) return ''
  return new Date(ms).toLocaleString(locale, {
    timeZone: uiTimezone(),
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

/** DB UTC string ('YYYY-MM-DD HH:MM:SS') → date+time in the configured zone. */
export function fmtDbUtc(ts, locale = currentLanguage()) {
  return fmtDateTime(parseDbUtc(ts), locale)
}

/** Clock in the configured timezone ('16:30' / '16:30:05'); an invalid ms → ''. */
export function fmtClock(ms, { seconds = false, locale = currentLanguage() } = {}) {
  if (!Number.isFinite(ms)) return ''
  try {
    const f = new Intl.DateTimeFormat(locale, {
      timeZone: uiTimezone(), hour: '2-digit', minute: '2-digit',
      ...(seconds ? { second: '2-digit' } : {}), hourCycle: 'h23',
    })
    return f.format(new Date(ms))
  } catch { return '' }
}

/** 'DD.MM.' date part in the configured timezone, for the compact reset texts. */
export function fmtDatePart(ms, locale = currentLanguage()) {
  if (!Number.isFinite(ms)) return ''
  try {
    const parts = new Intl.DateTimeFormat(locale, {
      timeZone: uiTimezone(), month: '2-digit', day: '2-digit',
    }).formatToParts(new Date(ms))
    const tag = parts.find(p => p.type === 'day')?.value ?? '??'
    const mon = parts.find(p => p.type === 'month')?.value ?? '??'
    return `${tag}.${mon}.`
  } catch { return '' }
}

/**
 * Locale number formatting — the one place a figure's decimal/thousands
 * separators come from. Everything display-facing goes through here (or
 * fmtPercent/fmtMoney) instead of toFixed + string concatenation.
 */
export function fmtNum(n, opts = {}) {
  if (n === null || n === undefined || n === '') return ''
  const num = Number(n)
  if (!Number.isFinite(num)) return String(n)
  try { return new Intl.NumberFormat(currentLanguage(), opts).format(num) } catch { return String(num) }
}

/** A percentage with the UI language's decimal separator ('78,5 %' in German). */
export function fmtPercent(p) {
  if (p === null || p === undefined) return '?'
  const num = Number(p)
  if (!Number.isFinite(num)) return String(p)
  return `${fmtNum(num, { maximumFractionDigits: 1 })} %`
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
    case 'cron': return t('sched.cron_line', { expr: agent.schedule })
    case 'einmalig': return agent.run_at
      ? t('sched.once_on', { ts: String(agent.run_at).replace('T', ' ') })
      : t('sched.once_none')
    case 'woechentlich': {
      const roh = String(agent.schedule_days ?? '').split(',').filter(x => x !== '')
      const n = Number(agent.schedule_weeks) || 1
      // Every weekday at the same time, every week — that is just "daily", and
      // listing all seven days would say the same thing longer. A multi-week
      // cadence is NOT daily, so it keeps its day list.
      const alleWochentage = roh.length >= WOCHENTAGE.length &&
        roh.every(x => WOCHENTAGE.some(w => w.n === Number(x)))
      if (alleWochentage && n === 1) {
        return t('sched.daily_line', { time: agent.schedule_time ?? '??:??' })
      }
      const days = roh.map(x => { const w = WOCHENTAGE.find(w => w.n === Number(x)); return w ? t(w.key) : x }).join(', ')
      const takt = n === 1 ? t('sched.weekly_word') : t('sched.every_n_weeks', { n })
      return t('sched.weekly_line', { takt, days: days || t('sched.no_days'), time: agent.schedule_time ?? '??:??' })
    }
    default: return t('sched.manual')
  }
}
