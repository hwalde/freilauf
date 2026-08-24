// cc-hub — Budget-Gates (Planung 4.2): Claude-Quota (quota.json, seven_day_fable via
// fable_weekly_refresh.py) und OpenRouter-Guthaben.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const QUOTA_PATH = process.env.CCHUB_QUOTA_JSON ?? `${homedir()}/.claude/quota.json`

export function claudeQuota() {
  try {
    const q = JSON.parse(readFileSync(QUOTA_PATH, 'utf8'))
    const five = Number(q?.five_hour?.used_percentage)
    const seven = Number(q?.seven_day_fable?.used_percentage ?? q?.seven_day?.used_percentage)
    const resetAt = q?.five_hour?.resets_at
    return {
      five: Number.isFinite(five) ? five : null,
      seven: Number.isFinite(seven) ? seven : null,
      resets_at: Number.isFinite(resetAt) ? new Date(resetAt * 1000).toISOString() : null,
    }
  } catch {
    return { five: null, seven: null, resets_at: null }
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

/** true = Start verschieben (Planung 4.2: 5 h >= 90 % bzw. 7 Tage >= 95 %). */
export function claudeGateBlocked(quota = claudeQuota()) {
  if ((quota.five ?? 0) >= 90 || (quota.seven ?? 0) >= 95) {
    return { blocked: true, reason: `Claude-Quota: 5h ${quota.five ?? '?'} % / 7d ${quota.seven ?? '?'} %`, resets_at: quota.resets_at }
  }
  return { blocked: false }
}
export async function openrouterGateBlocked(minimumEur = 5) {
  const c = await openrouterCredits()
  if (!c) return { blocked: false }   // kein Key / kein Signal → nicht blocken
  if (c.remaining != null && c.remaining < minimumEur) {
    return { blocked: true, reason: `OpenRouter-Guthaben niedrig: ${c.remaining} €` }
  }
  return { blocked: false }
}
