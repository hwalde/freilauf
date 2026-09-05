// Freilauf — small helpers without external dependencies.
import { homedir } from 'node:os'
import { execFile, execFileSync } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { t, currentLanguage } from './i18n.mjs'
import { env } from './env.mjs'

export const HOME = homedir()
export const RUNS_DIR = env('RUNS_DIR') ?? `${HOME}/agents/runs`
export const WORKTREES_DIR = env('WORKTREES_DIR') ?? `${HOME}/agents/worktrees`

/**
 * The commit this hub process is running from, as a short sha — and the empty
 * string when that cannot be answered (a tarball instead of a checkout, no git).
 *
 * Since the service runs from its own deploy checkout (bin/freilauf-deploy), "which
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
 *
 * Which host answers is the operator's call, not a constant in the code:
 * Settings → "Public host" names the hostname the certificate belongs to
 * (e.g. `hub.example.internal`), and the PORT is always the live VPN port —
 * a port change therefore needs no settings edit. Without a hostname the
 * historic seam `FREILAUF_PUBLIC_URL` (a full URL) answers, then the IP
 * fallback. The value is injected like the timezone (this module stays free of
 * db.mjs, see i18n.mjs for why): `setPublicHost()` is called by the hub at
 * startup and again when the setting is saved.
 */
let publicHost = ''
export function setPublicHost(v) { publicHost = String(v ?? '').trim() }

export function publicBase() {
  if (publicHost) return `https://${publicHost}:${env('VPN_PORT') ?? 8790}`
  // Without FREILAUF_PUBLIC_URL the links point nowhere — the note is in env.example.
  return (env('PUBLIC_URL')
    || `https://127.0.0.1:${env('VPN_PORT') ?? 8790}`).replace(/\/+$/, '')
}

/** The detail page of one run, or the overview when there is no run. */
export function detailUrl(runId) {
  return runId ? `${publicBase()}/runs/${runId}` : `${publicBase()}/`
}

/** Strip ANSI + CR from the pipe-pane log for the HTML log view (planning 7.2). */
export function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r/g, '')
}

/**
 * Progress noise git writes to stderr while it checks out or transfers: a
 * large repository under load produces megabytes of it, and it buries the one
 * line that says WHY a command failed — a stored error that ends mid-progress
 * carries no reason at all. Strips the progress families and collapses the
 * blank lines they leave behind. Also used on the pipe-pane's CR-only line
 * ends, so carriage returns become newlines first.
 */
export function stripGitProgress(stderr) {
  return String(stderr ?? '')
    .replace(/\r/g, '\n')
    .replace(/^\s*(Updating files|Enumerating objects|Counting objects|Compressing objects|Receiving objects|Resolving deltas|Checking out files|Checking objects):.*$/gm, '')
    .replace(/\n{2,}/g, '\n')
    .trim()
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
  return sendCommandToSession(session, '', text)
}

/**
 * The same, but with a leading part that is TYPED rather than pasted.
 *
 * A TUI does not treat a paste like keystrokes. Claude Code collapses a
 * bracketed paste of more than 800 characters into a `[Pasted text #n]`
 * placeholder (measured on 2.1.261: 800 literal, 801 placeholder) — and a
 * placeholder is never read as a slash command. So `/goal <long condition>`
 * pasted in one piece was submitted as an ordinary message: the condition
 * arrived at the agent as a wall of text and no goal was ever set. Typed by a
 * human the very same text works, because the human types `/goal` and only
 * pastes the argument.
 *
 * `typed` is therefore sent as literal KEYSTROKES first (no paste markers
 * around it, so the TUI reads it as a command), and only `text` is pasted.
 * Measured: the two never coalesce, not even with no pause between them — the
 * 300 ms below is the same deliberate beat that already sits before Enter.
 * An empty `typed` is the ordinary paste and does exactly what it always did.
 */
export async function sendCommandToSession(session, typed, text) {
  const target = `=${session}:`
  if (typed) {
    const r = await sh('tmux', ['send-keys', '-t', target, '-l', '--', String(typed)])
    if (!r.ok) return r
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  const r = await sh('tmux', ['send-keys', '-t', target, '-l', '--', '\x1b[200~' + String(text ?? '') + '\x1b[201~'])
  if (!r.ok) return r
  await new Promise(resolve => setTimeout(resolve, 300))
  return sh('tmux', ['send-keys', '-t', target, 'Enter'])
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

/** Weekday numbers in the order a week is read: Monday first, Sunday last. */
const WEEK_ORDER = WOCHENTAGE.map(w => w.n)

/** "07:30,11:00" → ['07:30','11:00'] — trimmed, validated, deduplicated, sorted. */
export function splitTimes(value) {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(',')
  const out = []
  for (const item of raw) {
    const time = String(item ?? '').trim()
    if (/^\d{2}:\d{2}$/.test(time) && +time.slice(0, 2) <= 23 && +time.slice(3) <= 59 && !out.includes(time)) {
      out.push(time)
    }
  }
  return out.sort()
}

/** `schedule_slots` JSON → [{day, times}] — null when it says nothing usable. */
function parseSlots(json) {
  if (!json) return null
  let obj
  try { obj = JSON.parse(json) } catch { return null }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  const out = []
  for (const [key, times] of Object.entries(obj)) {
    const day = Number(key)
    if (!Number.isInteger(day) || day < 0 || day > 6) continue
    const liste = splitTimes(times)
    if (liste.length) out.push({ day, times: liste })
  }
  return out.length ? sortWeek(out) : null
}

const sortWeek = (slots) => slots.sort((a, b) => WEEK_ORDER.indexOf(a.day) - WEEK_ORDER.indexOf(b.day))

/**
 * A weekly schedule as ONE shape: per weekday the times it runs at, in the
 * order a week is read.
 *
 * Two storages meet here and nowhere else. The flat columns
 * (`schedule_days` + `schedule_time`) say "the same times on every chosen day"
 * — which is what almost every schedule is, and what every agent written
 * before this existed says. `schedule_slots` is the escalation: a time list
 * per weekday, for "Tuesday at 08:00 and 11:00, Wednesday at 14:17". Whoever
 * reads a schedule asks this function and never has to know which of the two
 * an agent carries.
 */
export function weeklySlots(agent) {
  const slots = parseSlots(agent?.schedule_slots)
  if (slots) return slots
  // The empty string has to be thrown out BEFORE the conversion: Number('') is
  // 0 and a valid weekday, so an agent with no days at all would run on Sundays.
  const days = String(agent?.schedule_days ?? '').split(',')
    .map(x => String(x).trim()).filter(x => x !== '')
    .map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6)
  const times = splitTimes(agent?.schedule_time)
  if (!days.length || !times.length) return []
  return sortWeek([...new Set(days)].map(day => ({ day, times })))
}

/** Do all days of a weekly schedule run at the same times? */
export function slotsUniform(slots) {
  return slots.length > 0 && slots.every(s => s.times.join(',') === slots[0].times.join(','))
}

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
      // Per weekday its own times — the flat columns and `schedule_slots` are
      // both read through weeklySlots(), so this asks one question either way.
      const heute = weeklySlots(agent).find(s => s.day === now.getDay())
      if (!heute) return false
      if (!heute.times.includes(`${zwei(now.getHours())}:${zwei(now.getMinutes())}`)) return false
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

/**
 * The newest minute in (fromMs, toMs) at which this agent's schedule would
 * have fired — the slot a hub that was down for that stretch missed.
 *
 * Whole minutes on both ends: the tick debounces on the minute, so a slot IS
 * a minute. The minute of `fromMs` belongs to the last tick that ran, the
 * minute of `toMs` to the tick that is running now — both are excluded, or a
 * slot would fire twice. Newest first, because one catch-up is enough: an
 * agent that missed three nightly slots is started once, not three times.
 * It asks scheduleDue() itself, so a catch-up can never disagree with the
 * tick about what "due" means. `null` for the kinds that need none:
 * 'einmalig' is due from its moment on anyway, 'manuell' has no moment.
 */
/**
 * How far back a hub that was down looks for schedule slots it missed
 * (Settings → `schedule_catchup_hours`, default 6, `0` = never). The empty
 * string has to mean "not set" and never `0`: the settings page writes every
 * input as a string, and `Number('')` is a configured zero.
 */
export function catchupHours(settings = {}) {
  const raw = settings.schedule_catchup_hours
  if (raw == null || String(raw).trim() === '') return 6
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : 6
}

export function lastMissedSlot(agent, fromMs, toMs) {
  if (!['cron', 'woechentlich'].includes(agent?.schedule_kind)) return null
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return null
  const start = Math.floor(fromMs / 60000) * 60000 + 60000
  const end = Math.floor(toMs / 60000) * 60000 - 60000
  for (let ms = end; ms >= start; ms -= 60000) {
    if (scheduleDue(agent, new Date(ms))) return new Date(ms)
  }
  return null
}

/** One-liner for the agent list. */
export function scheduleText(agent) {
  switch (agent.schedule_kind) {
    case 'cron': return t('sched.cron_line', { expr: agent.schedule })
    case 'einmalig': return agent.run_at
      ? t('sched.once_on', { ts: String(agent.run_at).replace('T', ' ') })
      : t('sched.once_none')
    case 'woechentlich': {
      const slots = weeklySlots(agent)
      const n = Number(agent.schedule_weeks) || 1
      const takt = n === 1 ? t('sched.weekly_word') : t('sched.every_n_weeks', { n })
      const dayName = (d) => { const w = WOCHENTAGE.find(w => w.n === d); return w ? t(w.key) : String(d) }
      if (!slots.length) {
        return t('sched.weekly_line', { takt, days: t('sched.no_days'), time: '??:??' })
      }
      // Different times per day cannot be folded into one "at <time>" — each
      // day is named with its own list instead.
      if (!slotsUniform(slots)) {
        const liste = slots.map(s => t('sched.day_times', { day: dayName(s.day), times: s.times.join(', ') }))
        return t('sched.weekly_days_line', { takt, list: liste.join(' · ') })
      }
      const time = slots[0].times.join(', ')
      // Every weekday at the same time, every week — that is just "daily", and
      // listing all seven days would say the same thing longer. A multi-week
      // cadence is NOT daily, so it keeps its day list.
      if (slots.length >= WOCHENTAGE.length && n === 1) return t('sched.daily_line', { time })
      return t('sched.weekly_line', { takt, days: slots.map(s => dayName(s.day)).join(', '), time })
    }
    default: return t('sched.manual')
  }
}
