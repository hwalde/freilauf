// cc-hub — the notification facade.
//
// Everything the hub has to say to a human goes through `notify()`: a run that
// finished, an incident, a blocked merge, a failed LLM call, a flow's own
// message, a deploy that rolled back. Until this module existed all of it went
// through `server/telegram.mjs`, imported directly by seven files — so "which
// channel" was not a question anybody could answer differently, and an
// installation that wanted none had to leave a token unset and hope every
// caller checked.
//
// Two rules, and this module is them:
//
//   1. **Notifications are optional.** Nothing configured means `notify()` is a
//      silent no-op — no error, no warning, no banner, no half-sent message.
//      `notifiersConfigured()` is the question, and the hub schedules, watches,
//      merges and reports perfectly well while the answer is no.
//   2. **A channel never becomes the caller's problem.** `notify()` does not
//      throw, does not reject, and does not make one dead channel wait for
//      another: every notifier is asked in parallel, every failure is caught
//      and logged through a throttle, and what comes back is a summary the
//      caller may ignore.
//
// What is deliberately NOT here: the per-run dedupe. `notifyRun()` in
// reports.mjs owns that, because it is a fact about the RUN ("has the operator
// been told this once?") and not about the channel. And no rendering knowledge
// at all — the hub composes one normalized message, Telegram makes HTML of it,
// a webhook makes JSON, and neither has to know about the other.
import db from './db.mjs'
import { t } from './i18n.mjs'
import { detailUrl, publicBase } from './util.mjs'
import { allPlugins } from './plugins/registry.mjs'
import { isPluginEnabled, credentialSpec, credentialValue } from './plugins/store.mjs'
import { pluginFields, pluginSettingValue } from './plugins/settings.mjs'
import { pluginCtx } from './plugins/context.mjs'

// Where a link points is a fact about this installation, not about a channel,
// so it lives in util.mjs. Re-exported because most callers that build a
// message also build its link, and one import is friendlier than two.
export { detailUrl, publicBase }

// ---------------------------------------------------------------------------
// who is listening
// ---------------------------------------------------------------------------

/** Every registered notifier plugin, configured or not, in registration order. */
export function notifierPlugins() {
  try { return allPlugins().filter(p => p.kind === 'notifier') } catch { return [] }
}

/** One registered notifier with its metadata, or null. */
export function notifierEntry(id) {
  return notifierPlugins().find(p => p.id === String(id)) ?? null
}

/**
 * Is this notifier ready to send anything?
 *
 * A plugin may answer for itself (`configured(ctx)`) — a channel whose
 * readiness is not a matter of filled-in fields needs that. Otherwise the
 * default rule reads the declaration: every `required` setting must hold a
 * non-empty value, and every `required` credential must resolve. A notifier
 * that declares nothing required is ready the moment it is registered, which is
 * the right answer for a channel that needs no configuration at all (a local
 * command, a file sink).
 *
 * Never throws: a plugin that blows up while being asked is not configured, and
 * that is the whole consequence.
 */
export function notifierConfigured(id) {
  try {
    const plugin = notifierEntry(id)?.plugin
    if (!plugin) return false
    if (typeof plugin.configured === 'function') return !!plugin.configured(pluginCtx(id))
    for (const field of pluginFields(plugin, 'settings')) {
      if (!field.required) continue
      const v = pluginSettingValue(id, field)
      if (v === null || v === undefined || String(v).trim() === '') return false
    }
    for (const spec of credentialSpec(plugin)) {
      if (!spec.required) continue
      if (!credentialValue(id, spec.key)) return false
    }
    return true
  } catch {
    return false
  }
}

/**
 * The notifiers a message would actually reach: registered, switched on, and
 * configured. This is the list `notify()` walks; `notifiersConfigured()` is
 * only the question of whether it is empty.
 */
export function configuredNotifiers() {
  return notifierPlugins().filter(p => isPluginEnabled(p.id) && notifierConfigured(p.id))
}

/**
 * Would a message go anywhere at all?
 *
 * The one question the rest of the hub asks about notifications, and `false` is
 * a perfectly ordinary answer: a hub with no channel configured does everything
 * it always did, it simply says nothing out loud. Nothing may treat it as a
 * problem to be fixed — no banner, no warning, no required step in the wizard.
 */
export function notifiersConfigured() {
  return configuredNotifiers().length > 0
}

// ---------------------------------------------------------------------------
// the per-run switch
// ---------------------------------------------------------------------------

/**
 * Is the channel on for THIS run? — the checkbox under its terminal, read at
 * the moment a message would go out, so unticking it silences everything that
 * comes AFTER the click (the follow-up reports first of all).
 *
 * The column is still called `telegram_on`. Renaming a stored column means
 * rebuilding the table, and this project's own rule about `openrouter_min_eur`
 * applies unchanged: a stored name is not worth a migration. What the operator
 * reads says "notifications", which is what the flag has always meant — every
 * message about this run, whichever channel would have carried it.
 *
 * It lives here rather than in reports.mjs because it was implemented TWICE:
 * `telegramOnFor()` there and `telegramMuted()` in incidents.mjs, with inverted
 * polarity, because reports.mjs imports incidents.mjs and the cycle forbade
 * sharing. This module imports neither, so there is one copy again.
 *
 * A run that does not exist answers "on": the caller knows nothing about it and
 * should not lose a message over a lookup.
 */
export function notifyOnFor(runId) {
  if (!runId) return true
  try {
    const row = db.prepare('SELECT telegram_on FROM runs WHERE id=?').get(runId)
    return !row || row.telegram_on !== 0
  } catch { return true }
}

/** The inverse, for the callers that read it that way round. */
export function notifyMuted(runId) { return !notifyOnFor(runId) }

// ---------------------------------------------------------------------------
// the failure log, throttled
// ---------------------------------------------------------------------------

// A channel that fails does not fail once: a wrong token fails on every message
// the hub sends, and the hub sends one per run, per incident, per flow step.
// Writing that to the journal each time is how a log stops being readable — the
// same argument `llm/alerts.mjs` is built on, one layer further out. One line
// per (notifier, reason) per window, with what was suppressed named in the next
// one, because silence about 47 swallowed failures would be the worse lie.
const LOG_WINDOW_MS = 10 * 60_000
const logged = new Map()   // `${id}|${reason}` -> { at, suppressed }

function logFailure(id, reason, nowMs = Date.now()) {
  try {
    const key = `${id}|${reason}`
    const st = logged.get(key) ?? { at: 0, suppressed: 0 }
    logged.set(key, st)
    if (st.at && nowMs - st.at < LOG_WINDOW_MS) { st.suppressed++; return false }
    const more = st.suppressed ? ` (and ${st.suppressed} more since)` : ''
    console.warn(`[notify] ${id}: ${reason}${more}`)
    st.at = nowMs
    st.suppressed = 0
    return true
  } catch {
    return false
  }
}

/** Test hook — mirrors `_alertReset()` in llm/alerts.mjs. */
export function _notifyLogReset() { logged.clear() }

// ---------------------------------------------------------------------------
// the message
// ---------------------------------------------------------------------------

/** A translated string that cannot cost a message. */
function safeT(key, fallback) {
  try {
    const s = t(key)
    return s && s !== key ? s : fallback
  } catch { return fallback }
}

/**
 * Normalize whatever a caller passed into the shape a notifier is promised
 * (docs/plugins.md, "The message"). A bare string is accepted because half the
 * call sites have one and nothing is gained by making them build an object.
 */
export function normalizeMessage(message) {
  const m = typeof message === 'string' ? { text: message } : (message ?? {})
  const content = String(m.attachment?.content ?? '')
  return {
    kind: String(m.kind ?? 'system'),
    text: String(m.text ?? ''),
    // Optional pre-rendered HTML. The hub itself never sets it — it composes
    // plain text and lets each channel render — but a caller that has HTML may
    // pass it, and a channel that can use it may prefer it over `text`.
    html: typeof m.html === 'string' ? m.html : null,
    url: m.url ?? null,
    linkLabel: m.linkLabel || safeT('notify.open_detail', 'Open detail page'),
    runId: m.runId ?? null,
    attachment: content ? { fileName: String(m.attachment.fileName || 'report.md'), content } : null,
  }
}

// ---------------------------------------------------------------------------
// sending
// ---------------------------------------------------------------------------

/**
 * Send one message to every configured notifier.
 *
 * Returns `{ sent, delivered, results }`: `sent` is true when at least one
 * channel took it, `results` is one `{ id, ok, error }` per channel asked. With
 * nothing configured the answer is `{ sent: false, results: [] }` and NOT an
 * error — that is the quiet installation, not a broken one.
 */
export async function notify(message) {
  const msg = normalizeMessage(message)
  if (!msg.text && !msg.html) return { sent: false, delivered: 0, results: [] }
  let targets = []
  try { targets = configuredNotifiers() } catch { targets = [] }
  if (!targets.length) return { sent: false, delivered: 0, results: [] }

  const results = await Promise.all(targets.map(async ({ id, plugin }) => {
    try {
      const r = await plugin.send(msg, pluginCtx(id))
      if (r && r.ok) return { id, ok: true, error: null }
      const error = String(r?.error ?? 'not delivered')
      logFailure(id, error)
      return { id, ok: false, error }
    } catch (err) {
      const error = err?.message ? String(err.message) : String(err)
      logFailure(id, error)
      return { id, ok: false, error }
    }
  }))

  const delivered = results.filter(r => r.ok).length
  return { sent: delivered > 0, delivered, results }
}

/**
 * Text plus an optional file — the shape `notifyLong()` had, kept because four
 * callers think in it: a report goes out as a message AND, when it does not
 * fit, as the complete file. Whether that second half happens at all is the
 * channel's decision now, not the hub's.
 */
export async function notifyLong(text, { fileName = 'report.md', fileContent = null, url = null, kind = 'system', runId = null } = {}) {
  return notify({ kind, text, url, runId, attachment: fileContent ? { fileName, content: fileContent } : null })
}

/**
 * The "send test message" button of one notifier card. Answers `{ ok, error? }`;
 * a switched-off or unconfigured channel says which of the two it is rather
 * than quietly reporting success.
 */
export async function sendTest(id) {
  const entry = notifierEntry(id)
  if (!entry) return { ok: false, errorKey: 'notify.err_unknown' }
  if (!isPluginEnabled(entry.id)) return { ok: false, errorKey: 'notify.err_disabled' }
  if (!notifierConfigured(entry.id)) return { ok: false, errorKey: 'notify.err_not_configured' }
  const msg = normalizeMessage({
    kind: 'test',
    text: safeT('notify.test_message', 'cc-hub: test message. The channel works.'),
    url: detailUrl(null),
  })
  try {
    // `test()` and `send()` take the SAME arguments — `(message, ctx)`. A plugin
    // declaring them the other way round would hand the message to the context
    // parameter and nothing would notice; a unit test pins it.
    const fn = typeof entry.plugin.test === 'function' ? entry.plugin.test : entry.plugin.send
    const r = await fn.call(entry.plugin, msg, pluginCtx(entry.id))
    if (r?.ok) return { ok: true }
    // `errorKey` is what a plugin says when its failure has a NAME the operator
    // should read in their own language ("no bot token saved"); `error` is the
    // developer-facing fallback every other plugin gives. The page prefers the
    // key and falls back to the text, so an external package that knows nothing
    // about i18n still produces something readable.
    return { ok: false, errorKey: r?.errorKey ?? null, error: r?.error ? String(r.error) : null }
  } catch (err) {
    return { ok: false, error: err?.message ? String(err.message) : String(err) }
  }
}
