// cc-hub — detection of rate limits and provider failures from text. Pure
// logic: no database, no filesystem — everything here is testable with fixed
// inputs.
//
// Why this is needed at all: on a rate limit or provider outage the agent
// itself can no longer report — without an API there is no tool call, so no
// cc-report. The platform has to see it from the outside. There are three
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

/** Incident types. Anything else would be guesswork — better 'unbekannt' than wrong. */
export const TYPEN = ['rate_limit', 'provider_error', 'auth_error', 'billing_error', 'model_error', 'unbekannt']

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
  if (/\b(5\d\d)\b|overload|unavailable|no endpoints|stream error|AI_APICallError|ECONNRE|ENOTFOUND|ETIMEDOUT|socket (hang up|connection was closed)|fetch failed|upstream|provider error|temporarily/i.test(t)) return 'provider_error'
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
  /cc-hub|detect\.mjs|incidents|test\/(unit|e2e)/, // work on exactly this code
  /\b(describe|it|test|expect)\(/,          // test code
  /retry_after|retryAfter|rateLimit[A-Z]|rate_limit_hits|RATE_LIMIT/, // identifiers in source
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
 *   gelb  – first, single hit: note it, traffic light yellow, NO Telegram
 */
export function bewerteLogTreffer({ anzahl, erstGesehenMs, zuletztGesehenMs, letzteAktivitaetMs, jetztMs,
  fensterMs = 10 * 60_000, stilleMs = 5 * 60_000, schwelle = 2 }) {
  if (anzahl >= schwelle && (zuletztGesehenMs - erstGesehenMs) <= fensterMs) return 'rot'
  const still = letzteAktivitaetMs == null || letzteAktivitaetMs <= zuletztGesehenMs
  if (still && (jetztMs - zuletztGesehenMs) >= stilleMs) return 'rot'
  return 'gelb'
}

/**
 * Human-readable name per type (overview, Telegram). English fallback — the
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
  llm_warnung: 'Check-LLM warning',
  unbekannt: 'API error',
}
