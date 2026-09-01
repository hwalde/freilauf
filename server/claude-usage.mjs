// Freilauf — Claude's subscription windows, asked of the account instead of read
// off the floor.
//
// WHY THIS FILE EXISTS. `~/.claude/quota.json` is not Freilauf's file, and it is
// not claude's either: claude NEVER writes it (see quota.mjs). It hands the
// windows to the STATUS LINE, and a status line only renders while an
// interactive session is open. A third window — the per-model weekly one — is
// put there by a helper script belonging to an entirely different project on
// the same machine, which runs when that project's own quota gate runs and not
// otherwise.
//
// So the panel's freshness depended on two things Freilauf does not control, and
// the failure was silent in the worst way: the numbers looked current. Measured
// on 2026-08-28, with the sidebar's own 30 s refresh working perfectly — it was
// re-fetching a fragment rendered from a seven-hour-old file:
//
//     window        shown     real
//     5 h            3 %       5 %
//     7 d           77 %      78 %
//     7 d Fable     80 %      88 %      ← written at 02:26, read at 11:10
//
// Eight points of drift on the window that BINDS: `seven` is the maximum of the
// weekly values, and the budget gate defers a start at 95 %. A gate reading a
// stale 80 lets runs into a quota that is nearly gone.
//
// The authoritative source is the account's own usage endpoint:
//
//     GET https://api.anthropic.com/api/oauth/usage
//     Authorization: Bearer <claudeAiOauth.accessToken from ~/.claude/.credentials.json>
//
// Its `limits[]` array is self-describing, which is why it is preferred over the
// flat `five_hour`/`seven_day` keys sitting next to it: every entry carries its
// own `group` ('session' | 'weekly'), its own `percent`, its own `resets_at` and,
// for a per-model window, the model's display name. Nothing about "Fable" is
// hardcoded here — the day the account grows a second scoped window, it appears
// in the panel by itself.
//
// FOUR RULES, each of them load-bearing:
//
//   1. **Never write quota.json.** It belongs to the status line and to that
//      other project's script. Freilauf reads it, as a fallback, and nothing else.
//   2. **Never refresh the OAuth token.** An expired token is a reason to stay
//      silent, not to go and mint a new one: racing claude for its own
//      credentials file could invalidate the operator's live session, and no
//      panel is worth that. `expiresAt` is checked, and that is all.
//   3. **Fail soft in every direction.** No credentials file, no token, no
//      network, a changed field name, an HTTP error — every one of them means
//      "no live answer", and `claudeQuota()` falls back to the file exactly as
//      it did before. This module can never be the reason a page does not render
//      or a run does not start.
//   4. **The gate is synchronous.** `claudeQuota()` sits on the launch path,
//      in the watcher pass and in the cost calculation, and it cannot become
//      async without dragging four call sites with it. So the refresh is
//      async and the READ is not: `refreshClaudeLimits()` fills a module-level
//      cache, `claudeLimits()` hands out what is in it while it is fresh.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { env } from './env.mjs'
import { dataDir } from './paths.mjs'

// Both read at CALL time, not at module load: the suites point them at a stub
// and a fixture after this module is already in the graph.
const USAGE_URL = () => env('CLAUDE_USAGE_URL')
  ?? 'https://api.anthropic.com/api/oauth/usage'
const CREDENTIALS = () => env('CLAUDE_CREDENTIALS')
  ?? `${homedir()}/.claude/.credentials.json`

// How long a fetched answer counts as the truth. Two minutes, not one: the
// account rate-limits this endpoint (measured 2026-09-01, a sustained 429 with
// the hub polling once a minute), and a usage panel does not get more truthful
// by being a minute fresher — the sidebar's own numbers move slowly. The suite
// shortens both windows via the env overrides.
const TTL_MS = Number(env('CLAUDE_USAGE_TTL_MS') ?? 120_000)
const TIMEOUT_MS = Number(env('CLAUDE_USAGE_TIMEOUT_MS') ?? 8_000)

// Backoff after a FAILED refresh. A 429 answered with another request 30 s
// later is how a polite poller becomes a hammer: the failure left the cache
// empty, so every watcher pass fired again. Now each failure doubles the wait
// (2 min, 4, 8 … capped at 30 min), the vendor's own Retry-After overrides
// when it is longer, and a success clears the whole thing. One failed minute
// must never cost the account a steady stream of rejected requests.
const BACKOFF_MS = Number(env('CLAUDE_USAGE_BACKOFF_MS') ?? 120_000)
const BACKOFF_MAX_MS = Number(env('CLAUDE_USAGE_BACKOFF_MAX_MS') ?? 30 * 60_000)

let cache = { at: 0, value: null }
let inflight = null
let backoffUntil = 0
let failures = 0

/**
 * Round like quota.mjs does — the vendor sends floats, every consumer wants one
 * decimal.
 *
 * The null/'' guard is not defensive noise: `Number(null)` is 0, and 0 is
 * finite. The endpoint really does send nulls for windows the account does not
 * have (`seven_day_opus: null` sits in the same response), so without this a
 * missing window would arrive as a confident 0 % — and worse, a 0 counts as an
 * answer and would shut out the file fallback for a whole TTL.
 */
const round1 = (v) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null
}

/** ISO string or null; the endpoint sends ISO already, but a changed field must not throw. */
const isoTime = (v) => {
  const ms = Date.parse(v)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

// ---------------- the last live answer is REMEMBERED ----------------
//
// WHY. The account does not report a per-model week the way it reports the other
// two. `limits[]` carries the scoped entry while the account has one to report;
// when it does not — and equally when the endpoint answers 429, or the token has
// expired, or the TTL simply ran out — the live side hands over no scoped window
// at all. quota.mjs then fell back to `~/.claude/quota.json`, whose
// `seven_day_fable` is written by that other project's script and by nobody
// else: measured 2026-08-29, 80 % with a `fetched_at` 45 hours old while the
// account had said 88 % minutes before. So the bar JUMPED — 88, 80, 88, 80 —
// with every gap in the live answer, and the number it jumped to was the older
// of the two.
//
// The same jump existed for the 5-hour and the general 7-day window, just with
// the roles swapped: there the file IS written by a running status line and can
// be fresher than the account — but a 429 stretch made claudeQuota() drop to
// whatever the file last held (measured 2026-09-01: five 0 % out of the file
// against the account's real number) and back the moment the endpoint answered
// again. One gap, one visible jump, per minute if the endpoint rate-limits.
//
// A window is not a live measurement one can re-take at will: it belongs to a
// period, and between two live answers the best knowledge about it is the last
// live answer. So EVERY window of the last successful answer is kept — the
// general ones per field, the scoped ones per label — each with the time it was
// read, and quota.mjs merges by that time (see `mergeScoped` / the field merge
// there), newest reading winning. The bars then stand still instead of
// flipping to a source that happens to answer.
//
// On disk, because this hub deploys often and a restart would otherwise drop
// straight back to older knowledge. Own file, never quota.json — rule 1 above
// stands. The path is derived rather than imported from db.mjs: db.mjs imports
// the harness registry, which imports this module.
const MEMORY_PATH = () => env('CLAUDE_WINDOWS_JSON')
  ?? join(dataDir(), 'claude-windows.json')

// How long a remembered window counts for when it carries no reset time of its
// own. With one, that time decides: knowledge from before a window rolled over
// is worthless, and a memory that could never expire would keep the budget gate
// deferring runs against a quota that has long since been refilled.
const MEMORY_TTL_MS = Number(env('CLAUDE_WINDOW_MEMORY_MS') ?? 24 * 3600_000)

let memory = null   // { scoped: Map<label, window>, general: { five, seven_general } }

function loadMemory() {
  if (memory) return memory
  const m = { scoped: new Map(), general: { five: null, seven_general: null } }
  try {
    const raw = JSON.parse(readFileSync(MEMORY_PATH(), 'utf8'))
    for (const w of Array.isArray(raw?.weekly_scoped) ? raw.weekly_scoped : []) {
      const pct = round1(w?.pct)
      const at = Number(w?.at)
      if (!w?.label || pct === null || !Number.isFinite(at)) continue
      m.scoped.set(String(w.label), { label: String(w.label), pct, resets_at: isoTime(w?.resets_at), at })
    }
    for (const key of ['five', 'seven_general']) {
      const w = raw?.general?.[key]
      const pct = round1(w?.pct)
      const at = Number(w?.at)
      if (pct === null || !Number.isFinite(at)) continue
      m.general[key] = { pct, resets_at: isoTime(w?.resets_at), at }
    }
  } catch { /* no memory yet, a broken file, no read access — all the same */ }
  memory = m
  return m
}

/** Keep what a live answer said about every window. Never throws. */
function rememberWindows(list, at) {
  const mem = loadMemory()
  let changed = false
  // The general windows, per field. `at` is when THIS answer was read, so a
  // source that last spoke hours ago loses to the file a status line has just
  // rewritten — the merge in quota.mjs decides by age.
  for (const [key, pct, resets] of [
    ['five', list?.five, list?.resets_at],
    ['seven_general', list?.seven_general, list?.seven_resets_at],
  ]) {
    if (pct === null || pct === undefined) continue
    const prev = mem.general[key]
    if (prev && prev.at >= at) continue
    mem.general[key] = { pct, resets_at: resets ?? null, at }
    changed = true
  }
  // The per-model windows, per label.
  for (const w of list?.weekly_scoped ?? []) {
    const prev = mem.scoped.get(w.label)
    if (prev && prev.at >= at) continue
    mem.scoped.set(w.label, { label: w.label, pct: w.pct, resets_at: w.resets_at ?? null, at })
    changed = true
  }
  if (!changed) return
  try {
    mkdirSync(dirname(MEMORY_PATH()), { recursive: true })
    writeFileSync(MEMORY_PATH(), JSON.stringify({
      general: mem.general,
      weekly_scoped: [...mem.scoped.values()],
    }))
  } catch { /* a panel is not worth an exception on the refresh path */ }
}

/**
 * Whether a remembered window still counts. One rule for both kinds: a window
 * WITH a reset time dies at that time (knowledge from before a window rolled
 * over is worthless), one without dies of age.
 */
function rememberedAlive(w, now) {
  const reset = Date.parse(w.resets_at)
  return Number.isFinite(reset) ? reset > now : now - w.at < MEMORY_TTL_MS
}

/**
 * The last live reading of the two general windows, each with the time it was
 * read — or null where there is none or it has rolled over. quota.mjs treats
 * these as one more source with a date on it: older than a live answer, and
 * against the file a question of who spoke last.
 */
export function rememberedGeneral(now = Date.now()) {
  const mem = loadMemory()
  const win = (w) => (w && rememberedAlive(w, now) ? { ...w } : null)
  return { five: win(mem.general.five), seven_general: win(mem.general.seven_general) }
}

/**
 * The last live reading of every per-model week that has not rolled over yet,
 * each with the time it was read. quota.mjs treats these as one more source with
 * a date on it — older than a live answer, newer than a file written days ago.
 */
export function rememberedScoped(now = Date.now()) {
  const out = []
  for (const w of loadMemory().scoped.values()) {
    if (!rememberedAlive(w, now)) continue
    out.push({ ...w })
  }
  return out
}

/**
 * The OAuth access token, or null. Only the token and its expiry are read —
 * never the refresh token, and nothing is ever written back.
 */
function accessToken() {
  try {
    const o = JSON.parse(readFileSync(CREDENTIALS(), 'utf8'))?.claudeAiOauth
    if (!o?.accessToken) return null
    // An expired token would answer 401. Skipping is the same outcome one HTTP
    // round trip earlier, and it keeps a dead credentials file from producing a
    // request every minute for as long as the hub runs.
    if (Number.isFinite(Number(o.expiresAt)) && Number(o.expiresAt) <= Date.now()) return null
    return o.accessToken
  } catch { return null }
}

/**
 * `limits[]` → the shape quota.mjs merges. Tolerant on purpose: the endpoint is
 * undocumented, so an entry that does not carry what is expected is skipped
 * rather than allowed to poison the whole answer.
 */
function parseLimits(json) {
  const limits = Array.isArray(json?.limits) ? json.limits : null
  if (!limits) return null
  const out = {
    five: null, resets_at: null,
    seven_general: null, seven_resets_at: null,
    weekly_scoped: [],
  }
  for (const l of limits) {
    const pct = round1(l?.percent)
    if (pct === null) continue
    const iso = isoTime(l?.resets_at)
    if (l?.group === 'session' || l?.kind === 'session') {
      out.five = pct; out.resets_at = iso
    } else if (l?.kind === 'weekly_all') {
      out.seven_general = pct; out.seven_resets_at = iso
    } else if (l?.group === 'weekly') {
      // A per-model window. Its label is the vendor's own display name, so a
      // new scoped model shows up named correctly without a code change; an
      // entry that names no model still counts towards `seven` (quota.mjs takes
      // the maximum) and is simply labelled generically.
      const label = l?.scope?.model?.display_name || l?.scope?.surface || '7d'
      out.weekly_scoped.push({ label: String(label), pct, resets_at: iso })
    }
  }
  // An answer that carried no window at all is not an answer. Returning it would
  // let an empty success shadow the file fallback for a whole TTL.
  if (out.five === null && out.seven_general === null && !out.weekly_scoped.length) return null
  return out
}

/**
 * Fetch the account's windows and cache them. Returns the snapshot, or null when
 * there is no live answer to be had — the caller then simply keeps whatever
 * `claudeQuota()` reads out of the file and out of the remembered last answer.
 *
 * Never throws, never waits on a second caller: one request is in flight at a
 * time, and the release hangs on the PROMISE rather than standing at the end of
 * the body — the same trap usage.mjs documents, and for the same reason.
 *
 * A failed answer starts the backoff (see the constants above): while it runs,
 * no request is made at all — the account said "later", and asking again every
 * watcher pass is how a poller becomes a hammer. `force` bypasses it; that is
 * for tests and for the one caller that explicitly wants a fresh answer.
 */
export async function refreshClaudeLimits({ force = false } = {}) {
  if (!force && cache.value && Date.now() - cache.at < TTL_MS) return cache.value
  if (!force && Date.now() < backoffUntil) return cache.value ?? null
  if (inflight) return inflight
  const task = (async () => {
    const token = accessToken()
    if (!token) return null
    try {
      const res = await fetch(USAGE_URL(), {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok) {
        failures++
        // The vendor's own Retry-After wins when it is the longer wait. It may
        // arrive as seconds or as a date; anything unparsable is ignored.
        let wait = Math.min(BACKOFF_MS * 2 ** (failures - 1), BACKOFF_MAX_MS)
        const ra = res.headers?.get?.('retry-after')
        const raSec = Number(ra)
        const raMs = Number.isFinite(raSec) && ra > 0 ? raSec * 1000
          : Number.isFinite(Date.parse(ra)) ? Date.parse(ra) - Date.now() : 0
        if (raMs > wait) wait = raMs
        backoffUntil = Date.now() + wait
        return null
      }
      const parsed = parseLimits(await res.json())
      if (parsed) {
        const at = Date.now()
        cache = { at, value: parsed }
        rememberWindows(parsed, at)
      }
      failures = 0
      backoffUntil = 0
      return parsed
    } catch {
      failures++
      backoffUntil = Date.now()
        + Math.min(BACKOFF_MS * 2 ** (failures - 1), BACKOFF_MAX_MS)
      return null   // network, timeout, parse — all the same answer
    }
  })()
  inflight = task
  const release = () => { if (inflight === task) inflight = null }
  task.then(release, release)
  return task
}

/**
 * The cached snapshot while it is fresh, else null. Synchronous, because the
 * budget gate and the cost calculation are.
 *
 * Deliberately expires: a live number an hour old is worse than the file, which
 * at least a running claude session keeps moving. When this returns null,
 * `claudeQuota()` is exactly the function it was before this module existed.
 */
export function claudeLimits() {
  if (!cache.value || Date.now() - cache.at >= TTL_MS) return null
  return cache.value
}

/** Test hook: drop the cache, the remembered windows and any in-flight claim. */
export function _claudeLimitsReset() {
  cache = { at: 0, value: null }
  inflight = null
  backoffUntil = 0
  failures = 0
  memory = { scoped: new Map(), general: { five: null, seven_general: null } }
  try { writeFileSync(MEMORY_PATH(), JSON.stringify({ general: {}, weekly_scoped: [] })) } catch { /* nothing to clear */ }
}

/** Test hook: plant a snapshot without a network round trip — remembered like a real one. */
export function _claudeLimitsSet(value, at = Date.now()) {
  cache = { at, value }
  if (value) rememberWindows(value, at)
}

/** Test hook: exposed so the parser can be tested against a recorded response. */
export { parseLimits as _parseLimits }
