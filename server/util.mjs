// cc-hub — kleine Helfer ohne externe Abhängigkeiten.
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'

export const HOME = homedir()
export const RUNS_DIR = process.env.CCHUB_RUNS_DIR ?? `${HOME}/agents/runs`
export const WORKTREES_DIR = process.env.CCHUB_WORKTREES_DIR ?? `${HOME}/agents/worktrees`

export function kurzid(uuid) { return uuid.split('-')[0] }

/** ANSI + CR aus pipe-pane-Log für die HTML-Loganzeige (Planung 7.2). */
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

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

export function fmtDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '–'
  const m = Math.floor(sec / 60), h = Math.floor(m / 60)
  return h > 0 ? `${h} h ${m % 60} min` : `${m} min`
}

// Minimaler 5-Feld-Cron (Minute Stunde Tag Monat Wochentag): *, *&#47;n, a-b, Listen.
const CRON_MAX = [59, 23, 31, 12, 6]
/** Prüft, ob ein Ausdruck von cronMatches überhaupt verstanden wird (5 Felder). */
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

// ---------------- Zeitpläne jenseits von Cron (Planung: grafische Auswahl) ----------------
export const WOCHENTAGE = [
  { n: 1, kurz: 'Mo', lang: 'Montag' }, { n: 2, kurz: 'Di', lang: 'Dienstag' },
  { n: 3, kurz: 'Mi', lang: 'Mittwoch' }, { n: 4, kurz: 'Do', lang: 'Donnerstag' },
  { n: 5, kurz: 'Fr', lang: 'Freitag' }, { n: 6, kurz: 'Sa', lang: 'Samstag' },
  { n: 0, kurz: 'So', lang: 'Sonntag' },
]

const zwei = (n) => String(n).padStart(2, '0')

/** Montag 00:00 der Woche, in der das Datum liegt (lokale Zeit). */
function wochenstart(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const versatz = (x.getDay() + 6) % 7          // Mo=0 … So=6
  x.setDate(x.getDate() - versatz)
  return x
}

/**
 * Ist der Agent in dieser Minute fällig? Wird vom Scheduler im 30-Sekunden-Takt
 * gefragt; die Minute selbst wird dort gegen Doppelstarts entprellt.
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
      // n-wöchentlich zählt ganze Wochen ab der Ankerwoche — nicht ab dem Tag.
      if (!agent.schedule_anchor) return true
      const anker = new Date(`${agent.schedule_anchor}T00:00:00`)
      if (Number.isNaN(anker.getTime())) return true
      const wochen = Math.round((wochenstart(now) - wochenstart(anker)) / (7 * 86400000))
      return wochen >= 0 && wochen % n === 0
    }

    case 'einmalig': {
      if (!agent.run_at) return false
      const ziel = new Date(agent.run_at)
      // Fällig ab dem Zeitpunkt — ein verpasster Termin (Hub war aus) wird nachgeholt.
      return !Number.isNaN(ziel.getTime()) && ziel.getTime() <= now.getTime()
    }

    default:
      return false      // 'manuell'
  }
}

/** Einzeiler für die Agentenliste. */
export function scheduleText(agent) {
  switch (agent.schedule_kind) {
    case 'cron': return `Cron: ${agent.schedule}`
    case 'einmalig': return agent.run_at ? `einmalig am ${String(agent.run_at).replace('T', ' um ')}` : 'einmalig (kein Termin)'
    case 'woechentlich': {
      const tage = String(agent.schedule_days ?? '').split(',').filter(t => t !== '')
        .map(t => WOCHENTAGE.find(w => w.n === Number(t))?.kurz ?? t).join(', ')
      const n = Number(agent.schedule_weeks) || 1
      const takt = n === 1 ? 'wöchentlich' : `alle ${n} Wochen`
      return `${takt}: ${tage || '(keine Tage)'} um ${agent.schedule_time ?? '??:??'}`
    }
    default: return 'manuell'
  }
}
