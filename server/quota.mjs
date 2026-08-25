// cc-hub — budget gates (planning 4.2): Claude quota (quota.json, seven_day_fable via
// fable_weekly_refresh.py) and OpenRouter credits.
//
// Where quota.json comes from: claude NEVER writes it itself. It hands the
// windows to the status line only (stdin JSON, 'rate_limits.five_hour' and
// 'rate_limits.seven_day', each used_percentage + resets_at, and only for
// Pro/Max after the first API response) — the status line script mirrors them
// into the file. A window missing there means nobody wrote it, not that it does
// not exist.
//
// Claude has THREE windows, not two: the 5-hour one, the general 7-day one and
// a separate 7-day one for fable. They are reported separately (seven_general /
// seven_fable) so the panel can show which one is filling up; 'seven' is the
// binding value for the gate and the cost estimate — the HIGHER of the two,
// because a weekly window that is full blocks regardless of which one it is.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const QUOTA_PATH = process.env.CCHUB_QUOTA_JSON ?? `${homedir()}/.claude/quota.json`

export function claudeQuota() {
  try {
    const q = JSON.parse(readFileSync(QUOTA_PATH, 'utf8'))
    const zahl = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)
    // The status line writes what claude hands it — which is sometimes a float
    // artifact (28.000000000000004). Rounding once here, to one decimal like the
    // cursor percentage in usage.mjs, keeps every consumer (header bar, usage
    // panel, gate reason, watcher cost delta, /api/usage) clean.
    const runden = (v) => (v === null ? null : Math.round(v * 10) / 10)
    const five = runden(zahl(q?.five_hour?.used_percentage))
    const sevenGeneral = runden(zahl(q?.seven_day?.used_percentage))
    const sevenFable = runden(zahl(q?.seven_day_fable?.used_percentage))
    const wochen = [sevenGeneral, sevenFable].filter(v => v !== null)
    // Every window brings its own reset time — or none: claude writes resets_at
    // only where it knows one, and the panel then shows nothing rather than the
    // reset time of a different window.
    const zeit = (v) => (Number.isFinite(Number(v)) ? new Date(Number(v) * 1000).toISOString() : null)
    return {
      five,
      seven: wochen.length ? Math.max(...wochen) : null,
      seven_general: sevenGeneral,
      seven_fable: sevenFable,
      resets_at: zeit(q?.five_hour?.resets_at),
      seven_resets_at: zeit(q?.seven_day?.resets_at),
      seven_fable_resets_at: zeit(q?.seven_day_fable?.resets_at),
    }
  } catch {
    return {
      five: null, seven: null, seven_general: null, seven_fable: null,
      resets_at: null, seven_resets_at: null, seven_fable_resets_at: null,
    }
  }
}

let creditsCache = { at: 0, value: null }
export async function openrouterCredits() {
  if (!process.env.OPENROUTER_API_KEY) return null
  if (creditsCache.value !== null && Date.now() - creditsCache.at < 120_000) return creditsCache.value
  try {
    const res = await fetch('https://openrouter.ai/api/v1/credits', {
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const j = await res.json()
    const d = j?.data ?? {}
    const value = { total_credits: d.total_credits ?? null, total_usage: d.total_usage ?? null }
    value.remaining = value.total_credits != null && value.total_usage != null
      ? Math.round((value.total_credits - value.total_usage) * 100) / 100
      : null
    creditsCache = { at: Date.now(), value }
    return value
  } catch {
    return creditsCache.value
  }
}

/** true = defer the start (planning 4.2: 5 h >= 90 % or 7 days >= 95 %). */
export function claudeGateBlocked(quota = claudeQuota()) {
  if ((quota.five ?? 0) >= 90 || (quota.seven ?? 0) >= 95) {
    return { blocked: true, reason: `Claude quota: 5h ${quota.five ?? '?'} % / 7d ${quota.seven ?? '?'} %`, resets_at: quota.resets_at }
  }
  return { blocked: false }
}
export async function openrouterGateBlocked(minimumEur = 5) {
  const c = await openrouterCredits()
  if (!c) return { blocked: false }   // no key / no signal → do not block
  if (c.remaining != null && c.remaining < minimumEur) {
    return { blocked: true, reason: `OpenRouter credits low: ${c.remaining} €` }
  }
  return { blocked: false }
}
