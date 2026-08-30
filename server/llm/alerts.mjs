// cc-hub — throttled, deduplicated Telegram alerts for the hub's own LLM calls.
//
// The problem this exists for: a provider that fails does not fail once. A
// wrong key fails on EVERY call, and the hub makes one per run title, one per
// log hit, one per flow `extract` step. Without a throttle the first bad
// credential turns the operator's phone into a log tail — and a channel that
// cries wolf is a channel nobody reads, which costs exactly the alarms that
// mattered.
//
// The rules, all configurable, all fail-soft:
//
//   * a *signature* is `purpose|source|model|errorClass` — the four things that
//     make two failures the same failure;
//   * at most one message per signature per `llm_alert_window_min` (30);
//   * what was suppressed in between is COUNTED and named in the next message
//     for that signature. Silence about 47 swallowed failures would be a worse
//     lie than the 47 messages;
//   * a global ceiling of `llm_alert_max_per_hour` (6) across all signatures,
//     because five broken providers must not add up to five times the window;
//   * master switch `llm_alert_on` (1).
//
// State lives in a module-level Map, no table. HTTP, scheduler and watcher are
// one process (see AGENTS.md on events.mjs), so there is nobody to share it
// with — and a throttle that survives a restart would be wrong anyway: after a
// deploy the operator wants to hear whether it is still broken.
import { getSetting } from '../db.mjs'
import { notify, detailUrl } from '../telegram.mjs'
import { t } from '../i18n.mjs'

const HOUR_MS = 3_600_000
const DEFAULTS = { window_min: 30, max_per_hour: 6 }

/** signature → { lastAttemptAt, suppressed, suppressedSince } */
const signatures = new Map()
/** timestamps of the messages we actually put on the wire, last hour only. */
let attempts = []
/** how many alerts the hourly ceiling swallowed since it last let one through. */
let ceilingSuppressed = 0

/**
 * A setting as a non-negative number, falling back when it is unset or empty.
 * The empty check is load-bearing: `Number('')` is `0` AND finite, so without
 * it an unconfigured installation reads every default as zero — a window of
 * zero minutes and a ceiling of zero messages, which is silence dressed up as
 * a configuration. (The same trap the claude quota panel was already caught on
 * with `Number(null)`; see AGENTS.md.) An explicit `0` the operator typed is
 * still honoured.
 */
function num(value, fallback) {
  const raw = String(value ?? '').trim()
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/** Local HH:MM — the reader wants "since 14:12", not an ISO timestamp. */
function clock(ms) {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** The four facts that make two failures the same failure. */
export function alertSignature({ purpose, source, model, errorClass }) {
  return [purpose, source, model, errorClass].map(v => String(v ?? '')).join('|')
}

/**
 * Report one failed LLM call. Never throws, never rejects — a caller on the
 * request path (a title, a flow step) must not be able to fail because the
 * alarm channel is having a bad day.
 *
 * @param {object} a
 * @param {string} a.purpose     the caller: title | check | extract | extras
 * @param {string} a.source      the model source, e.g. `provider:openrouter`
 * @param {string} a.model       the model identifier
 * @param {string} a.errorClass  a short code: http_401, no_json, schema, transport…
 * @param {string} [a.text]      one line of detail, verbatim from the failure
 * @param {number} [a.nowMs]     injectable clock (tests advance it, like integrateTick)
 * @returns {Promise<{sent: boolean, reason: string, suppressed?: number}>}
 */
export async function llmAlert({ purpose, source, model, errorClass, text, nowMs = Date.now() } = {}) {
  try {
    if ((getSetting('llm_alert_on') ?? '1') !== '1') return { sent: false, reason: 'off' }

    const windowMs = num(getSetting('llm_alert_window_min'), DEFAULTS.window_min) * 60_000
    const maxPerHour = num(getSetting('llm_alert_max_per_hour'), DEFAULTS.max_per_hour)

    const sig = alertSignature({ purpose, source, model, errorClass })
    const st = signatures.get(sig) ?? { lastAttemptAt: 0, suppressed: 0, suppressedSince: 0 }
    signatures.set(sig, st)

    const suppress = reason => {
      st.suppressed++
      if (!st.suppressedSince) st.suppressedSince = nowMs
      return { sent: false, reason, suppressed: st.suppressed }
    }

    if (st.lastAttemptAt && nowMs - st.lastAttemptAt < windowMs) return suppress('throttled')

    attempts = attempts.filter(ts => nowMs - ts < HOUR_MS)
    if (attempts.length >= maxPerHour) { ceilingSuppressed++; return suppress('ceiling') }

    // The window is spent on the ATTEMPT, not on the delivery: notify() retries
    // a network failure three times with sleeps in between, and doing that on
    // every failed model call would be its own outage.
    st.lastAttemptAt = nowMs
    attempts.push(nowMs)

    const lines = [
      t('llm.alert_title', { purpose: String(purpose ?? '?') }),
      t('llm.alert_where', { source: String(source ?? '?'), model: String(model ?? '?') }),
      t('llm.alert_kind', { kind: String(errorClass ?? '?') }),
    ]
    if (text) lines.push(t('llm.alert_detail', { text: String(text).slice(0, 600) }))
    if (st.suppressed > 0) {
      lines.push(t('llm.alert_more', { count: st.suppressed, since: clock(st.suppressedSince || nowMs) }))
    }
    if (ceilingSuppressed > 0) lines.push(t('llm.alert_ceiling', { count: ceilingSuppressed }))

    const ok = await notify(lines.join('\n'), detailUrl(null))
    if (ok) {
      // Only a delivered message may forget what it reported. A failed send
      // keeps the count so the NEXT message still names those failures.
      st.suppressed = 0
      st.suppressedSince = 0
      ceilingSuppressed = 0
    }
    return { sent: !!ok, reason: ok ? 'sent' : 'unreachable' }
  } catch {
    // No token, no chat, no network, a renamed field — all of them mean the
    // alarm did not go out, and none of them mean the caller failed.
    return { sent: false, reason: 'error' }
  }
}

/** Test hook — mirrors _balanceCacheReset()/_usageCacheReset() in usage.mjs and balances.mjs. */
export function _alertReset() {
  signatures.clear()
  attempts = []
  ceilingSuppressed = 0
}

/** Test hook: what the throttle currently remembers. */
export function _alertState() {
  return {
    signatures: Object.fromEntries([...signatures].map(([k, v]) => [k, { ...v }])),
    attempts: [...attempts],
    ceilingSuppressed,
  }
}
