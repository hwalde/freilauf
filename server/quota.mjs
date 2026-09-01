// Freilauf — the Claude quota windows, and the meters a budget gate reads.
//
// Two halves. The bottom one is generic — ask a plugin what its account still
// holds or has spent, cache it, compare it against a threshold the plugin
// declared — and names no vendor at all. This one, the top half, is Claude's
// window mathematics, and it is here rather than in the claude plugin because
// four different things read it: the gate, the "quota full" anomaly, the cost
// delta and the usage panel. One of those four disagreeing with the others is
// the bug that split the windows apart in the first place.
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
// And for the per-model week it is not even a straight fallback any more: that
// window has THREE possible sources (the live answer, the last live answer, the
// file) and `mergeScoped()` below picks by age, because all three describe the
// same period and only one of them is current. Rule 5 in AGENTS.md.
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
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
// The registry, not one of the two index files: this module asks about plugins
// of BOTH kinds now (a provider's balance, a coding agent's subscription
// usage), and a gate that had to know which index a plugin lives in would be
// the provider-specific knowledge this file is being emptied of.
import { getPlugin } from './plugins/registry.mjs'
import { pluginCtx } from './plugins/context.mjs'
import { pluginHasCredential } from './plugins/store.mjs'
import { claudeLimits, rememberedGeneral, rememberedScoped } from './claude-usage.mjs'
import { env } from './env.mjs'

const QUOTA_PATH = env('QUOTA_JSON') ?? `${homedir()}/.claude/quota.json`

/** What the file knows — the fallback half, unchanged in meaning. */
function quotaFile() {
  try {
    const q = JSON.parse(readFileSync(QUOTA_PATH, 'utf8'))
    // When the file was last written. For five_hour and seven_day that IS a
    // meaningful date: the status line writes exactly these two windows, and
    // only while an interactive session renders it — so a file untouched for
    // hours carries windows nobody has seen since. (The per-model week is the
    // exception further down: it is written by another project's script, whose
    // own fetched_at is the only honest date for it.)
    let writtenAt = 0
    try { writtenAt = statSync(QUOTA_PATH).mtimeMs } catch { /* no mtime, no date */ }
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
      five_at: writtenAt,
      resets_at: isoTime(q?.five_hour?.resets_at),
      seven_general: round1(num(q?.seven_day?.used_percentage)),
      seven_at: writtenAt,
      seven_resets_at: isoTime(q?.seven_day?.resets_at),
      // The file has exactly one slot for a per-model week and calls it fable.
      // The live source has a list; this is that list with at most one entry in
      // it, so both sides hand the same shape to everything downstream.
      //
      // `at` is what makes the merge below possible: this one window carries its
      // own `fetched_at`, because the script that writes it runs on its own
      // occasions and not with the rest of the file — measured 45 hours behind
      // the neighbouring five_hour block. Without a date we deliberately say 0
      // rather than the file's mtime: the mtime belongs to the status line's
      // write, and dating this window by it would claim a freshness it does not
      // have — which is the jump this whole merge exists to stop.
      weekly_scoped: fable === null ? []
        : [{
          label: 'Fable', pct: fable, resets_at: isoTime(q?.seven_day_fable?.resets_at),
          at: Number.isFinite(Number(q?.seven_day_fable?.fetched_at))
            ? Number(q.seven_day_fable.fetched_at) * 1000 : 0,
        }],
    }
  } catch {
    return { five: null, resets_at: null, seven_general: null, seven_resets_at: null, weekly_scoped: [] }
  }
}

/**
 * The per-model weeks out of three sources: the current live answer, the last
 * live answer (claude-usage.mjs remembers it), and the file.
 *
 * Merged PER LABEL and decided by AGE, because all three describe the same
 * window and only one of them is current. The live answer wins outright; where
 * it says nothing — the endpoint answers 429, the token expired, the TTL ran
 * out, or the account simply reports no scoped window at that moment — the
 * newer of the two remaining readings wins. Before this, the file won that case
 * unconditionally, and the file's per-model window is written by a script from
 * another project on its own occasions: the bar fell from the account's 88 % to
 * a two-day-old 80 % and back on every gap in the live answer.
 *
 * A reading that is not the live one is marked `stale` and carries the time it
 * was taken, so the panel can say so instead of presenting an old number as a
 * current one — the silent staleness this module's whole history is about.
 */
function mergeScoped(live, remembered, file, now) {
  const out = new Map()
  const key = (w) => String(w.label ?? '').toLowerCase()
  for (const w of file ?? []) out.set(key(w), { ...w, at: w.at ?? 0, stale: true })
  for (const w of remembered ?? []) {
    const prev = out.get(key(w))
    if (!prev || (w.at ?? 0) > (prev.at ?? 0)) out.set(key(w), { ...w, stale: true })
  }
  for (const w of live ?? []) out.set(key(w), { ...w, at: now, stale: false })
  return [...out.values()]
}

/**
 * One general window (5 h or the general week) out of the same three sources,
 * decided by the same principle: the newest reading wins.
 *
 * The live answer speaks with `now`, the remembered one with the time it was
 * read, the file with its mtime (the status line writes exactly these two
 * windows, so that date means something — see quotaFile). A 429 stretch no
 * longer drops the bar to whatever the file happened to hold: the last live
 * answer stands until something NEWER says otherwise, and the winner that is
 * not the live one carries its `at` so the panel can print "as of …".
 */
function mergeGeneral(livePct, liveResets, remembered, filePct, fileResets, fileAt, now) {
  const cands = []
  if (livePct !== null && livePct !== undefined) {
    cands.push({ pct: livePct, resets_at: liveResets ?? null, at: now, live: true })
  }
  if (remembered) cands.push({ pct: remembered.pct, resets_at: remembered.resets_at ?? null, at: remembered.at, live: false })
  if (filePct !== null && filePct !== undefined) {
    cands.push({ pct: filePct, resets_at: fileResets ?? null, at: fileAt ?? 0, live: false })
  }
  if (!cands.length) return null
  return cands.reduce((a, b) => (b.at > a.at ? b : a))
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
export function claudeQuota(now = Date.now()) {
  const file = quotaFile()
  const live = claudeLimits()
  const remembered = rememberedGeneral(now)
  const scoped = mergeScoped(live?.weekly_scoped, rememberedScoped(now), file.weekly_scoped, now)
  // 'fable' keeps its own two fields because the gate, the cost estimate and the
  // e2e suite all name it; it is simply the scoped window that calls itself that.
  const fable = scoped.find(w => /fable/i.test(w.label)) ?? null
  const fiveW = mergeGeneral(live?.five, live?.resets_at, remembered.five,
    file.five, file.resets_at, file.five_at, now)
  const sevenW = mergeGeneral(live?.seven_general, live?.seven_resets_at, remembered.seven_general,
    file.seven_general, file.seven_resets_at, file.seven_at, now)
  const sevenGeneral = sevenW?.pct ?? null
  const weeks = [sevenGeneral, ...scoped.map(w => w.pct)].filter(v => v !== null && v !== undefined)
  return {
    five: fiveW?.pct ?? null,
    seven: weeks.length ? Math.max(...weeks) : null,
    seven_general: sevenGeneral,
    seven_fable: fable ? fable.pct : null,
    resets_at: fiveW?.resets_at ?? null,
    seven_resets_at: sevenW?.resets_at ?? null,
    seven_fable_resets_at: fable ? fable.resets_at : null,
    // When a window's value is NOT from the current live answer, the time it
    // was read — the panel prints "as of …" next to it. null = live.
    five_at: fiveW && !fiveW.live ? fiveW.at : null,
    seven_general_at: sevenW && !sevenW.live ? sevenW.at : null,
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
 * The 7-day windows that concern a run on `model`, as a list: the general week
 * and the per-model weeks that concern this model. This is the one place the
 * window set is built — the gate and the display both read it, so they can never
 * disagree about which windows exist for a run.
 *
 * An object that carries no window list is taken at its word (`quota.seven`) —
 * that is what the callers who only ever had two numbers pass.
 */
export function weeklyWindows(quota = claudeQuota(), model = null) {
  if (!Array.isArray(quota?.weekly_scoped)) {
    const pct = quota?.seven ?? null
    return pct === null ? [] : [{ pct, label: null, resets_at: quota?.seven_resets_at ?? null }]
  }
  return [
    ...(quota.seven_general === null || quota.seven_general === undefined ? []
      : [{ pct: quota.seven_general, label: null, resets_at: quota.seven_resets_at ?? null }]),
    ...quota.weekly_scoped
      .filter(w => w.pct !== null && w.pct !== undefined && windowAppliesToModel(w.label, model))
      .map(w => ({ pct: w.pct, label: w.label ?? null, resets_at: w.resets_at ?? null })),
  ]
}

/** The fullest of the windows that concern a run on `model` — null when there is none. */
export function weeklyBinding(quota = claudeQuota(), model = null) {
  const windows = weeklyWindows(quota, model)
  if (!windows.length) return null
  return windows.reduce((a, b) => (b.pct > a.pct ? b : a))
}

/**
 * The 7-day window that binds for a run on `model`, as a percentage. null when
 * the account reports no week at all.
 */
export function sevenFor(quota = claudeQuota(), model = null) {
  const w = weeklyBinding(quota, model)
  return w ? w.pct : null
}

/**
 * The week that concerns THIS run. Only a claude run has a claude model; for
 * every other harness the model says nothing about these windows, so it is not
 * used to filter them and the answer stays the maximum it always was.
 */
export function sevenForRun(run, quota = claudeQuota()) {
  return sevenFor(quota, run?.harness === 'claude' ? run?.model ?? null : null)
}

/**
 * The window that is at 100 % and would bind a run on `model` — the 5-hour
 * window first (every claude run draws from the same one), else the fullest
 * 7-day window that concerns the model. Returns `{ label, pct, resets_at }` or
 * null when nothing that binds the run is full. `label` uses the usage panel's
 * own words ('5h', '7d', '7d Fable'), so the anomaly names the same window the
 * panel shows.
 */
export function quotaFullWindow(quota = claudeQuota(), model = null) {
  if ((quota?.five ?? 0) >= 100) {
    return { label: '5h', pct: quota.five, resets_at: quota.resets_at ?? null }
  }
  const w = weeklyBinding(quota, model)
  if (w && w.pct >= 100) {
    return { label: w.label ? `7d ${w.label}` : '7d', pct: w.pct, resets_at: w.resets_at ?? null }
  }
  return null
}

// ================= the metered sources a budget gate reads =================
//
// Two shapes, and NOTHING in here names a provider or a coding agent any more.
// It used to: `openrouterCredits()` carried one vendor's URL, auth header and
// response shape, and when DeepSeek and cursor followed, the whole thing was
// copied twice. What is left is the part that is genuinely the same for all of
// them — ask the plugin, cache the answer, compare against a threshold — while
// WHICH plugin, WHICH threshold and WHAT the reason says is declared by the
// plugin itself (`gate` in the descriptor, see docs/plugins.md).
//
// Deliberately still asking the plugin DIRECTLY rather than going through
// balances.mjs/usage.mjs: those two reach the database through
// coding-agents.mjs, and the gate sits on the launch path. One number from one
// plugin does not need an aggregator.

/** Two minutes: a balance that moved a cent must not cost a start a round trip. */
const METER_TTL_MS = 120_000

const balanceCache = new Map()   // pluginId -> { at, remaining, available }
const usageCache = new Map()     // pluginId -> { at, pct, cycle_end }

/**
 * What a provider still holds, in one currency — `{ remaining, available }` or
 * null when there is nothing to go on.
 *
 * null is "no signal", never "zero": no plugin, no `balance()` contract, no
 * credential, no answer and no earlier answer all end here, and a gate that
 * blocked on any of them would defer runs over a provider it simply cannot see.
 * A failed refresh keeps the previous reading — it is still the best there is.
 */
export async function providerRemaining(pluginId, currency = 'USD') {
  const plugin = getPlugin(pluginId)
  if (!plugin?.balance) return null
  const cached = balanceCache.get(pluginId)
  if (cached && Date.now() - cached.at < METER_TTL_MS) return cached
  const ctx = pluginCtx(pluginId)
  // The credential, resolved the way the operator configured it — a stored
  // value or a variable they named counts, not only the plugin's own default.
  if (!pluginHasCredential(pluginId, ctx.env)) return cached ?? null
  try {
    const b = await plugin.balance(ctx)
    const entry = {
      at: Date.now(),
      remaining: (b?.amounts ?? []).find(a => a.currency === currency)?.remaining ?? null,
      available: b?.available ?? null,
    }
    balanceCache.set(pluginId, entry)
    return entry
  } catch {
    return cached ?? null
  }
}

/** The name a gate's reason line uses: what the plugin calls its own gate, else its label. */
function gateName(plugin, pluginId, label) {
  return label ?? plugin?.gate?.label ?? plugin?.label ?? pluginId
}

/**
 * A gate on an account BALANCE. `{ blocked: false }` or `{ blocked, reason }`.
 *
 * `unavailableBlocks` is for the one provider that reports a verdict of its
 * own: DeepSeek's `is_available === false` says calls no longer go through, and
 * that outranks the figure next to it — promotional credit expires while the
 * number still looks healthy.
 */
export async function balanceGateBlocked(pluginId, {
  minimum = 0, currency = 'USD', unavailableBlocks = false, label = null,
} = {}) {
  const plugin = getPlugin(pluginId)
  const name = gateName(plugin, pluginId, label)
  const b = await providerRemaining(pluginId, currency)
  if (!b) return { blocked: false }                       // no signal -> do not block
  if (unavailableBlocks && b.available === false) {
    return { blocked: true, reason: `${name} balance unavailable — the account reports calls are blocked` }
  }
  if (b.remaining === null) return { blocked: false }      // no signal -> do not block
  if (b.remaining < minimum) return { blocked: true, reason: `${name} credits low: ${b.remaining} $` }
  return { blocked: false }
}

/**
 * A gate on a SUBSCRIPTION's included usage — spend divided by the included
 * amount of the running period, as the account itself reports it.
 *
 * Three ways the number can be missing, and all three mean "no signal, do not
 * block": no token, no answer from the account, and no included amount with an
 * empty `includedFallback`. The fallback is only ever a fallback: where the
 * account states the amount, that is what the bar and this gate measure against.
 */
export async function usageGateBlocked(pluginId, {
  threshold = 95, includedFallback = 20, label = null,
} = {}) {
  const plugin = getPlugin(pluginId)
  if (!plugin?.usage) return { blocked: false }
  const name = gateName(plugin, pluginId, label)
  let entry = usageCache.get(pluginId)
  if (!entry || entry.pct === null || Date.now() - entry.at >= METER_TTL_MS) {
    try {
      const data = await plugin.usage(pluginCtx(pluginId))
      if (!data) {
        entry = { at: Date.now(), pct: null, cycle_end: null }
      } else {
        const included = data.included_usd != null ? data.included_usd : (Number(includedFallback) || 0)
        entry = {
          at: Date.now(),
          pct: data.spent_usd != null && included ? Math.round((data.spent_usd / included) * 1000) / 10 : null,
          cycle_end: data.cycle_end ?? null,
        }
      }
      usageCache.set(pluginId, entry)
    } catch {
      // keep the old entry — the previous answer is still the best one there is
    }
  }
  if (!entry || entry.pct === null) return { blocked: false }
  if (entry.pct >= threshold) {
    return {
      blocked: true,
      reason: `${name} usage: ${entry.pct} % of the included period`,
      resets_at: entry.cycle_end ?? null,
    }
  }
  return { blocked: false }
}

/**
 * true = defer the start (planning 4.2: 5 h >= 90 % or 7 days >= 95 %).
 *
 * `model` is the run's model: it decides WHICH 7-day window is asked (see the
 * header). Left out, every window binds — the conservative answer, and the one
 * a caller without a model wants.
 *
 * The thresholds are configurable — the settings page owns the numbers
 * (scheduler.mjs reads them and passes them in, because this module must not
 * import the database). Each window is measured against ITS OWN threshold: the
 * 5-hour one against `five`, the general week and every non-fable per-model week
 * against `seven`, a per-model week called "Fable" against `fable`. A window
 * blocks when it reaches its own threshold; the reason names the blocking
 * window(s) and hands out the fullest one's reset time.
 *
 * The reset time is the BLOCKING window's own: a 7-day block used to hand out
 * the 5-hour reset, which then travelled into the deferred event and into
 * into the notification as the moment the run would start again.
 */
export function claudeGateBlocked(quota = claudeQuota(), model = null,
  { five = 90, seven = 95, fable = 95 } = {}) {
  const fiveBlocks = (quota.five ?? 0) >= five
  // Windows that reach their OWN threshold — the general week and any per-model
  // week that concerns this model, each judged against its own number.
  const blocking = weeklyWindows(quota, model)
    .map(w => ({ ...w, threshold: /fable/i.test(String(w.label ?? '')) ? fable : seven }))
    .filter(w => (w.pct ?? 0) >= w.threshold)
    .sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0))
  if (fiveBlocks || blocking.length) {
    const name = (w) => (w.label ? `7d ${w.label}` : '7d')
    const teile = [
      ...(fiveBlocks ? [`5h ${quota.five ?? '?'} %`] : []),
      ...blocking.map(w => `${name(w)} ${w.pct ?? '?'} %`),
    ]
    return {
      blocked: true,
      reason: `Claude quota: ${teile.join(' / ')}`,
      resets_at: fiveBlocks ? quota.resets_at : (blocking[0]?.resets_at ?? quota.resets_at ?? null),
    }
  }
  return { blocked: false }
}

// ================= the named gates, kept for the callers that predate the
// plugin contract =================
//
// The real declaration is each plugin's own `gate` (see docs/plugins.md); these
// three are one line apiece and hold no logic. They exist because the unit
// suite cache-busts THIS module to get a fresh meter cache for each case it
// walks through — a delegation into the plugin would import the un-busted
// module back and hand it the reading from the previous case.
//
// The names in them are plugin IDS, not knowledge about a vendor: what the
// reason says, which threshold applies and whether the account's own verdict
// counts all come from the plugin.
export const openrouterGateBlocked = (minimum = 5) =>
  balanceGateBlocked('openrouter', { minimum })

export const deepseekGateBlocked = (minimum = 2) =>
  balanceGateBlocked('deepseek', { minimum, unavailableBlocks: true })

export const cursorGateBlocked = (threshold = 95, includedFallback = 20) =>
  usageGateBlocked('cursor', { threshold, includedFallback })
