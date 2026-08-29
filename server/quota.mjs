// cc-hub — budget gates (planning 4.2): Claude quota and OpenRouter credits.
//
// TWO SOURCES, and the order matters. The live one is the account's own usage
// endpoint (claude-usage.mjs) — that is the truth. `~/.claude/quota.json` is the
// FALLBACK, for when there is no token, no network or no answer.
//
// Where quota.json comes from: claude NEVER writes it itself. It hands the
// windows to the status line only (stdin JSON, 'rate_limits.five_hour' and
// 'rate_limits.seven_day', each used_percentage + resets_at, and only for
// Pro/Max after the first API response) — the status line script mirrors them
// into the file. A window missing there means nobody wrote it, not that it does
// not exist. The per-model week (`seven_day_fable`) is written by a script
// belonging to another project entirely. Which is precisely why the file is no
// longer the first thing asked: it goes stale whenever nobody happens to be
// running a claude session, and it goes stale SILENTLY (see claude-usage.mjs
// for the measurement that started this).
//
// Claude has THREE windows, not two: the 5-hour one, the general 7-day one and
// per-model 7-day ones (currently fable). They are reported separately
// (seven_general / seven_fable / weekly_scoped) so the panel can show which one
// is filling up, and 'seven' is the fullest of them — the account's own worst
// case, which is what the rail draws.
//
// WHICH WEEK BINDS IS A QUESTION ABOUT THE RUN, NOT ABOUT THE ACCOUNT.
// The general week counts for every claude run. A per-model week counts only
// for a run ON that model: a Fable week at 96 % says nothing about a run on
// Sonnet, and until this was split, `seven` — the maximum — deferred that run
// too. So the gate, the cost delta and the "quota full" anomaly ask
// `sevenFor(quota, model)` / `sevenForRun(run)`, and only the display keeps
// asking for the maximum.
//
// The match is on the MODEL IDENTIFIER, because that is the only thing the run
// carries: the account labels its scoped window with a display name ('Fable'),
// and the same model reaches the CLI as the alias `fable` and as
// `claude-fable-5`. A name token of the label appearing in the identifier is
// therefore the whole rule — see windowAppliesToModel().
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { getProvider, providerHasKey } from './providers/index.mjs'
import { providerCtx } from './models.mjs'
import { claudeLimits } from './claude-usage.mjs'

const QUOTA_PATH = process.env.CCHUB_QUOTA_JSON ?? `${homedir()}/.claude/quota.json`

/** What the file knows — the fallback half, unchanged in meaning. */
function quotaFile() {
  try {
    const q = JSON.parse(readFileSync(QUOTA_PATH, 'utf8'))
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)
    // The status line writes what claude hands it — which is sometimes a float
    // artifact (28.000000000000004). Rounding once here, to one decimal like the
    // cursor percentage in usage.mjs, keeps every consumer (header bar, usage
    // panel, gate reason, watcher cost delta, /api/usage) clean.
    const round1 = (v) => (v === null ? null : Math.round(v * 10) / 10)
    // Every window brings its own reset time — or none: claude writes resets_at
    // only where it knows one, and the panel then shows nothing rather than the
    // reset time of a different window.
    const isoTime = (v) => (Number.isFinite(Number(v)) ? new Date(Number(v) * 1000).toISOString() : null)
    const fable = round1(num(q?.seven_day_fable?.used_percentage))
    return {
      five: round1(num(q?.five_hour?.used_percentage)),
      resets_at: isoTime(q?.five_hour?.resets_at),
      seven_general: round1(num(q?.seven_day?.used_percentage)),
      seven_resets_at: isoTime(q?.seven_day?.resets_at),
      // The file has exactly one slot for a per-model week and calls it fable.
      // The live source has a list; this is that list with at most one entry in
      // it, so both sides hand the same shape to everything downstream.
      weekly_scoped: fable === null ? []
        : [{ label: 'Fable', pct: fable, resets_at: isoTime(q?.seven_day_fable?.resets_at) }],
    }
  } catch {
    return { five: null, resets_at: null, seven_general: null, seven_resets_at: null, weekly_scoped: [] }
  }
}

/**
 * The Claude windows: live where the account answered, out of the file for
 * whatever it did not.
 *
 * Merged per FIELD rather than picking one source wholesale — the two do not
 * necessarily know the same things. A token that has expired leaves the live
 * side empty and the file still carries a status line's 5-hour window from
 * minutes ago; there is no reason to throw that away.
 *
 * Stays synchronous. The launch path (runner.mjs), the watcher pass and the
 * cost calculation all call it, and the live half is a cache that somebody else
 * fills — `refreshClaudeLimits()`, from the watcher and from the usage
 * aggregator.
 */
export function claudeQuota() {
  const file = quotaFile()
  const live = claudeLimits()
  const prefer = (a, b) => (a !== null && a !== undefined ? a : b)
  const scoped = live?.weekly_scoped?.length ? live.weekly_scoped : file.weekly_scoped
  // 'fable' keeps its own two fields because the gate, the cost estimate and the
  // e2e suite all name it; it is simply the scoped window that calls itself that.
  const fable = scoped.find(w => /fable/i.test(w.label)) ?? null
  const sevenGeneral = prefer(live?.seven_general, file.seven_general)
  const weeks = [sevenGeneral, ...scoped.map(w => w.pct)].filter(v => v !== null && v !== undefined)
  return {
    five: prefer(live?.five, file.five),
    seven: weeks.length ? Math.max(...weeks) : null,
    seven_general: sevenGeneral,
    seven_fable: fable ? fable.pct : null,
    resets_at: prefer(live?.resets_at, file.resets_at),
    seven_resets_at: prefer(live?.seven_resets_at, file.seven_resets_at),
    seven_fable_resets_at: fable ? fable.resets_at : null,
    // Every per-model week the account reports, each under the vendor's own
    // display name — so a second scoped model reaches the panel without a code
    // change. `live: true` is what lets the panel say where the numbers are from.
    weekly_scoped: scoped,
    live: !!live,
  }
}

// Words a per-model label may carry that name no model. 'claude' is the
// load-bearing one: a window called "Claude Fable 5" would otherwise match
// every claude identifier there is, which is exactly the lumping this split
// exists to end.
const LABEL_NOISE = new Set(['claude', 'anthropic', 'model', 'models', 'weekly', 'week', 'limit'])

/**
 * Does this per-model window concern a run on `model`?
 *
 * The label is the vendor's display name ('Fable'), the model is what the run
 * hands the CLI ('fable', 'claude-fable-5') — so the test is whether a naming
 * token of the label occurs in the identifier. Nothing about fable is
 * hardcoded; an 'Opus' window matches 'claude-opus-5' by the same rule.
 *
 * Two deliberate "yes"es, both conservative — a window that cannot be ruled out
 * still binds, because letting a run into a window that is full costs more than
 * deferring it:
 *   - no model on the run (claude then picks its own default, and the hub does
 *     not know which one that is),
 *   - a label with no naming token in it at all (claude-usage.mjs falls back to
 *     the surface name or a bare '7d' when the account names no model).
 */
export function windowAppliesToModel(label, model) {
  const id = String(model ?? '').toLowerCase()
  if (!id) return true
  const tokens = String(label ?? '').toLowerCase().split(/[^a-z]+/)
    .filter(w => w.length >= 3 && !LABEL_NOISE.has(w))
  if (!tokens.length) return true
  return tokens.some(w => id.includes(w))
}

/**
 * The 7-day window that binds for a run on `model`: the general week and the
 * per-model weeks that concern this model, whichever is fuller. null when the
 * account reports no week at all.
 *
 * An object that carries no window list is taken at its word (`quota.seven`) —
 * that is what the callers who only ever had two numbers pass.
 */
export function sevenFor(quota = claudeQuota(), model = null) {
  const w = weeklyBinding(quota, model)
  return w ? w.pct : null
}

/** The same, with the window's name and reset time — what a gate reason says. */
export function weeklyBinding(quota = claudeQuota(), model = null) {
  if (!Array.isArray(quota?.weekly_scoped)) {
    const pct = quota?.seven ?? null
    return pct === null ? null : { pct, label: null, resets_at: quota?.seven_resets_at ?? null }
  }
  const windows = [
    ...(quota.seven_general === null || quota.seven_general === undefined ? []
      : [{ pct: quota.seven_general, label: null, resets_at: quota.seven_resets_at ?? null }]),
    ...quota.weekly_scoped
      .filter(w => w.pct !== null && w.pct !== undefined && windowAppliesToModel(w.label, model))
      .map(w => ({ pct: w.pct, label: w.label ?? null, resets_at: w.resets_at ?? null })),
  ]
  if (!windows.length) return null
  return windows.reduce((a, b) => (b.pct > a.pct ? b : a))
}

/**
 * The week that concerns THIS run. Only a claude run has a claude model; for
 * every other harness the model says nothing about these windows, so it is not
 * used to filter them and the answer stays the maximum it always was.
 */
export function sevenForRun(run, quota = claudeQuota()) {
  return sevenFor(quota, run?.harness === 'claude' ? run?.model ?? null : null)
}

let creditsCache = { at: 0, value: null }

/**
 * Remaining OpenRouter credit in US dollars — null when there is no key, no
 * answer, and no earlier answer to fall back on.
 *
 * Deliberately asks the provider plugin directly instead of going through
 * balances.mjs: that module reaches the database via coding-agents.mjs, and
 * db.mjs imports the harness registry, which imports THIS file. Routing the
 * gate through the aggregator would close exactly the cycle docs/plugins.md
 * warns about. The gate needs one number from one plugin, so it asks it.
 */
async function openrouterRemaining() {
  const plugin = getProvider('openrouter')
  const ctx = providerCtx()
  if (!plugin?.balance || !providerHasKey('openrouter', ctx.env)) return null
  if (creditsCache.value !== null && Date.now() - creditsCache.at < 120_000) return creditsCache.value
  try {
    const b = await plugin.balance(ctx)
    const usd = (b?.amounts ?? []).find(a => a.currency === 'USD')?.remaining ?? null
    creditsCache = { at: Date.now(), value: usd }
    return usd
  } catch {
    return creditsCache.value
  }
}

/**
 * true = defer the start (planning 4.2: 5 h >= 90 % or 7 days >= 95 %).
 *
 * `model` is the run's model: it decides WHICH 7-day window is asked (see the
 * header). Left out, every window binds — the conservative answer, and the one
 * a caller without a model wants.
 *
 * The reset time is the BLOCKING window's own: a 7-day block used to hand out
 * the 5-hour reset, which then travelled into the deferred event and into
 * Telegram as the moment the run would start again.
 */
export function claudeGateBlocked(quota = claudeQuota(), model = null) {
  const week = weeklyBinding(quota, model)
  const seven = week ? week.pct : null
  const fiveBlocks = (quota.five ?? 0) >= 90
  if (fiveBlocks || (seven ?? 0) >= 95) {
    const name = week?.label ? `7d ${week.label}` : '7d'
    return {
      blocked: true,
      reason: `Claude quota: 5h ${quota.five ?? '?'} % / ${name} ${seven ?? '?'} %`,
      resets_at: fiveBlocks ? quota.resets_at : (week?.resets_at ?? quota.resets_at ?? null),
    }
  }
  return { blocked: false }
}
// The setting behind `minimum` is still called `openrouter_min_eur` (renaming a
// stored key would need a migration for nothing), but OpenRouter denominates
// its credits in DOLLARS — the old reason line printed a euro sign next to a
// dollar figure.
export async function openrouterGateBlocked(minimum = 5) {
  const remaining = await openrouterRemaining()
  if (remaining === null) return { blocked: false }   // no key / no signal → do not block
  if (remaining < minimum) {
    return { blocked: true, reason: `OpenRouter credits low: ${remaining} $` }
  }
  return { blocked: false }
}
