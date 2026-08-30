// Freilauf — detection of rate limits and provider failures from text. Pure
// logic: no database, no filesystem — everything here is testable with fixed
// inputs.
//
// Why this is needed at all: on a rate limit or provider outage the agent
// itself can no longer report — without an API there is no tool call, so no
// fl-report. The platform has to see it from the outside. There are three
// sources, in this order of reliability:
//
//   hook        claude 'StopFailure' (delivers a fixed error enum), opencode
//               plugin 'session.error'. hermes has NO hook for API errors —
//               its 'post_api_request' only fires after a SUCCESSFUL response.
//   transcript  claude transcript (JSONL) with isApiErrorMessage:true + error:<enum>
//   log         pipe-pane capture of the tmux session (all harnesses). Raw,
//               with ANSI control codes, menu text and redraws — hence
//               per-harness patterns (defined in the harness plugins) and an
//               assessment whether the hit is really a problem.
import { HARNESS_PLUGINS } from './harnesses/index.mjs'
import { HTTP_5XX } from './harnesses/patterns.mjs'

/** Incident types. Anything else would be guesswork — better 'unbekannt' than wrong. */
export const TYPEN = ['rate_limit', 'provider_error', 'auth_error', 'billing_error', 'model_error',
  // Not a provider problem at all: the hub could not get a finished run's work
  // onto the base branch (server/integrate.mjs). It sits in the same table
  // because it answers the same question — is anything waiting for me?
  'merge_blocked', 'unbekannt']

/**
 * Claude's StopFailure enum (as of 2.1.241, read from the binary) → our
 * incident type. Exactly the same enum appears in the transcript under 'error'.
 */
const CLAUDE_ENUM = {
  rate_limit: 'rate_limit',
  overloaded: 'provider_error',
  server_error: 'provider_error',
  authentication_failed: 'auth_error',
  oauth_org_not_allowed: 'auth_error',
  account_on_hold: 'billing_error',
  billing_error: 'billing_error',
  model_not_found: 'model_error',
  invalid_request: 'model_error',
  max_output_tokens: null,   // not a provider problem, the agent keeps running
  unknown: 'unbekannt',
}
export function typVonClaudeFehler(enumWert) {
  const v = CLAUDE_ENUM[String(enumWert ?? '')]
  return v === undefined ? 'unbekannt' : v
}

/**
 * Free text (opencode plugin, log line) → type. The order is deliberate: auth
 * and billing before rate limit, otherwise "402 … rate" would be misfiled.
 */
export function typVonText(text) {
  const t = String(text ?? '')
  if (/\b(401|403)\b|authentication|unauthori[sz]ed|invalid (api )?key|api key (is )?(invalid|missing)|please run \/login|oauth/i.test(t)) return 'auth_error'
  if (/\b402\b|billing|insufficient (credits|funds|balance)|credit balance|account (is )?on hold|payment/i.test(t)) return 'billing_error'
  if (/\b429\b|rate.?limit|too many requests|usage limit|hit your (session|usage|weekly|daily)? ?limit|quota exceeded|resource.?exhausted/i.test(t)) return 'rate_limit'
  if (/model (not found|does not exist)|unknown model|no such model|not a valid model/i.test(t)) return 'model_error'
  if (HTTP_5XX.test(t) || /overload|unavailable|no endpoints|stream error|AI_APICallError|ECONNRE|ENOTFOUND|ETIMEDOUT|socket (hang up|connection was closed)|fetch failed|upstream|provider error|temporarily/i.test(t)) return 'provider_error'
  return 'unbekannt'
}

/** Strip ANSI CSI, OSC (window titles) and CR; \r redraws become lines. */
export function terminalText(s) {
  return String(s ?? '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')     // OSC … BEL / ST
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')            // CSI
    .replace(/\x1b[@-Z\\-_]/g, '')                         // single ESC sequences
    .replace(/\r\n?/g, '\n')
}

/**
 * Per-harness patterns come from the coding agent plugins (logPatterns) —
 * adding a harness means adding a plugin file, nothing here. Each pattern set
 * is deliberately NARROW: better one case fewer than a menu line raising an
 * alarm ("Upgrade to Max for higher rate limits" once landed in the DB as a
 * rate limit on a production run).
 */
const MUSTER = Object.fromEntries(
  Object.values(HARNESS_PLUGINS).map(p => [p.id, p.logPatterns ?? []]))

/**
 * Lines that contain hits but are NOT errors. This collects what has already
 * misfired in practice — plus the obvious relatives.
 */
const AUSNAHMEN = [
  /upgrade to max/i,                       // Claude command menu: "/upgrade … higher rate limits"
  /\/(upgrade|usage|usage-credits|status|help)\b/,  // menu lines with slash command
  /^\s*[│|]?\s*(rate|usage) limit(s)?\s*[│|]?\s*$/i, // bare heading (e.g. /usage table)
  /\bgrep\b|\brg\b|\bsed\b|\bawk\b/,        // the agent itself searches for the word
  // Work on exactly this code. Case-insensitive since a capital "Incidents:"
  // (the hub's own section heading, scrolling through the agent's terminal)
  // slipped past the lowercase version and landed in the DB as a rate limit.
  /freilauf|cc-hub|detect\.mjs|incidents?\b|test\/(unit|e2e)/i,
  /\b(describe|it|test|expect)\(/,          // test code
  /retry_after|retryAfter|rateLimit[A-Z]|rate_limit_hits|RATE_LIMIT/, // identifiers in source
  // A call with a quoted/bracketed argument list is source code, not output —
  // the error text sits INSIDE a string literal. This repo's own test lines
  // (`scanneZeilen('cursor', ['API Error: 503', …])`) scrolled through a
  // claude run's terminal and opened two red incidents on it. No real harness
  // error message has this shape: they print `API Error: 529 {…}`,
  // `upstream connection error (503)`, `Retrying in 12.0s (…)`.
  /\w+\(\s*['"`\[]/,
  // A line that REPORTS a detection is not one. The e2e suite's own output
  // ('✓ cursor: … and "Cannot use this model" is detected') opened a
  // "Model unavailable" incident on the run that was executing that suite.
  /^[✓✔✗✘×]\s/,
  /\b(is|are) (detected|recognized|reported)\b/i,
  // cursor's TUI status line: braille spinner, activity, token count. The
  // number is a count, not a status code — '555 tokens' is not a 5xx.
  /^[⠀-⣿\s]*[\w ]{0,24}\s\d[\d.,]*\s*k? ?tokens?\b/i,
]

/**
 * Scans cleaned lines with the patterns of one harness.
 * Returns [{ typ, zeile, index }] — each line at most once (first pattern wins).
 */
export function scanneZeilen(harness, zeilen) {
  const muster = MUSTER[harness] ?? []
  const treffer = []
  zeilen.forEach((roh, index) => {
    const zeile = roh.trim()
    if (!zeile || zeile.length > 2000) return
    if (AUSNAHMEN.some(a => a.test(zeile))) return
    for (const m of muster) {
      if (m.re.test(zeile)) { treffer.push({ typ: m.typ, zeile: zeile.slice(0, 300), index }); break }
    }
  })
  return treffer
}

/**
 * Scan new bytes of a log. 'text' is the chunk starting at the old offset.
 * The last, possibly incomplete line is NOT evaluated and also not "consumed":
 * the new offset points at its start, so it arrives complete on the next pass.
 * Otherwise a line break in the middle of a word would tear the hit apart.
 */
export function scanneNeueBytes(harness, text, altOffset) {
  const sauber = terminalText(text)
  const letzterUmbruch = sauber.lastIndexOf('\n')
  if (letzterUmbruch < 0) return { treffer: [], neuerOffset: altOffset }
  const komplett = sauber.slice(0, letzterUmbruch)
  // The offset counts RAW bytes; the cleanup changes lengths. So the remainder
  // is computed from the raw length of the incomplete trailing line.
  const rohRest = Buffer.byteLength(text.slice(text.lastIndexOf('\n') + 1), 'utf8')
  const neuerOffset = altOffset + Buffer.byteLength(text, 'utf8') - rohRest
  return { treffer: scanneZeilen(harness, komplett.split('\n')), neuerOffset }
}

/**
 * Claude transcript (JSONL): API errors appear as own lines with
 * isApiErrorMessage:true and error:<enum>. Returns [{ typ, ts, text }].
 */
export function transkriptFehler(jsonlText) {
  const out = []
  for (const line of String(jsonlText ?? '').split('\n')) {
    if (!line.includes('"isApiErrorMessage":true')) continue
    try {
      const j = JSON.parse(line)
      if (!j?.isApiErrorMessage) continue
      const typ = typVonClaudeFehler(j.error)
      if (typ === null) continue
      const c = j.message?.content
      const text = typeof c === 'string' ? c
        : Array.isArray(c) ? c.map(x => x?.text ?? '').join(' ') : ''
      out.push({ typ, ts: j.timestamp ?? null, text: text.trim().slice(0, 300), enum: j.error ?? null })
    } catch { /* half a line — next pass */ }
  }
  return out
}

/**
 * Assessment of a LOG hit (hooks and transcript do not need this, they are
 * unambiguous). The criterion: a real limit stands AT THE END — nothing
 * happens after it. A hit after which the agent keeps working was a retry or a
 * menu line.
 *
 *   rot   – several hits in a short time (retry loop) OR silence (no activity)
 *           since the last hit for longer than 'stilleMs'
 *   gelb  – first, single hit: note it, traffic light yellow, NO notification
 *
 * Measurable work AFTER the last hit vetoes BOTH paths. An agent that is still
 * producing output is demonstrably not blocked by an API error, so the hit was
 * text on its screen — source code, a test line, a report it is writing. Without
 * that veto the repetition path fired on an agent that merely scrolled through a
 * file: five hits in two minutes, red, while the run was working normally.
 *
 * This costs nothing where it matters: the two harnesses for which the log is
 * the ONLY source (cursor, hermes) have no activity measurement at all, so the
 * veto never applies to them. The two it does apply to (claude, opencode) each
 * have a hook and a transcript/plugin channel that reports a real API error
 * red immediately and independently of the log.
 *
 * 'letzteAktivitaetMs === null' means UNKNOWN, not silent — and unknown never
 * escalates by silence. measureActivity() returns nothing for cursor and hermes,
 * so treating null as silence turned EVERY yellow log hit on those two into a
 * red alarm exactly stilleMs after it — while the agent was working. Repetition
 * and the check LLM stay as escalation paths there.
 */
export function bewerteLogTreffer({ anzahl, erstGesehenMs, zuletztGesehenMs, letzteAktivitaetMs, jetztMs,
  fensterMs = 10 * 60_000, stilleMs = 5 * 60_000, schwelle = 2 }) {
  if (letzteAktivitaetMs != null && letzteAktivitaetMs > zuletztGesehenMs) return 'gelb'
  if (anzahl >= schwelle && (zuletztGesehenMs - erstGesehenMs) <= fensterMs) return 'rot'
  if (letzteAktivitaetMs != null && (jetztMs - zuletztGesehenMs) >= stilleMs) return 'rot'
  return 'gelb'
}

/**
 * Is this hook report from the run's OWN claude session?
 *
 * The hub launches claude with `--session-id <run id>` (runner.mjs), so the run's
 * own session carries the run id as its session id — and every Claude hook event
 * delivers that id on stdin. A claude process the AGENT spawns (a probe, a test of
 * error handling, a sub-harness) inherits the worktree's hooks AND FL_RUN_ID, but
 * gets its own session id: its failures are the run's subject matter, not the run's
 * provider problems. Measured 2026-08-30: an agent testing a fake model id
 * (`nosuch/model-xyz`) opened a red "Model unavailable" incident on its own,
 * perfectly healthy run. Unknown (no session id, older fl-report) → the run's own —
 * the guard may only ever narrow, never swallow.
 */
export function fremdeClaudeSession(runId, harness, sessionId) {
  if (harness !== 'claude') return false
  const s = String(sessionId ?? '').trim()
  return s !== '' && s !== String(runId ?? '')
}

/**
 * Should an open incident close itself because its condition demonstrably went
 * away? Returns the reason (→ resolve) or null (→ leave open). Pure logic — the
 * caller supplies the run's state, the watcher applies it.
 *
 *   merge_blocked        the integrator's decision (merge now / skip), never time's.
 *   provider_down:*      the pulse has its own recovery loop.
 *   run done             the run answered what the hiccup meant: nothing.
 *                        (A red incident on a failed/aborted run stays — that is
 *                        WHY it did not come through, the operator decides.)
 *   running + red        measurable work AFTER the last occurrence and no
 *                        recurrence since: the error demonstrably did not block
 *                        the agent (the same veto bewerteLogTreffer applies).
 *                        Silence proves nothing here — a genuinely blocked agent
 *                        also produces none — so red resolves only on positive
 *                        evidence.
 *   yellow               the existing rule, generalized: 30 min without recurrence
 *                        was noise. Unknown activity counts as non-recurrence for
 *                        yellow only.
 */
export function vorfallWeggrund({ typ, schwere, runStatus, letzteAktivitaetMs, zuletztGesehenMs, jetztMs,
  arbeitMs = 10 * 60_000, stilleMs = 30 * 60_000 }) {
  if (typ === 'merge_blocked' || String(typ).startsWith('provider_down:')) return null
  const zuletzt = Number(zuletztGesehenMs)
  // Number(null) is 0 AND finite — the trap this repo has been bitten by before.
  // null means "no activity source", never "activity at the epoch".
  const hatAktivitaet = letzteAktivitaetMs != null
  const aktiv = Number(letzteAktivitaetMs)
  if (runStatus === 'done') return 'run finished successfully'
  if (runStatus === 'running' || runStatus === 'waiting_help') {
    if (schwere === 'rot') {
      if (hatAktivitaet && Number.isFinite(aktiv) && aktiv > zuletzt && jetztMs - zuletzt >= arbeitMs)
        return 'agent kept working after it'
      return null
    }
    if (hatAktivitaet && Number.isFinite(aktiv) && aktiv > zuletzt && jetztMs - zuletzt >= stilleMs)
      return 'expired: agent kept working'
    if (!hatAktivitaet && jetztMs - zuletzt >= stilleMs) return 'expired: no recurrence'
    return null
  }
  if (runStatus === 'failed' || runStatus === 'aborted') {
    if (schwere === 'gelb' && jetztMs - zuletzt >= stilleMs) return 'expired: run ended'
    return null
  }
  return null
}

/**
 * Human-readable name per type (overview, notifications). English fallback — the
 * web UI translates via i18n key `incident.<typ>` and only uses this map when
 * a key is missing.
 */
export const TYP_TEXT = {
  rate_limit: 'Rate limit',
  provider_error: 'Provider error',
  auth_error: 'Login/token',
  billing_error: 'Credits/billing',
  model_error: 'Model unavailable',
  provider_down: 'Provider unreachable',
  merge_blocked: 'Not merged',
  unbekannt: 'API error',
}
