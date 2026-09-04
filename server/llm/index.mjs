// Freilauf — `llmJson()`: the one way the hub asks a model a question.
//
// Four callers ask one — the run title, the incident check, a flow's `extract`
// step and the worktree-extras suggestion. Before this module each of them
// carried its own copy of the same forty lines: OpenRouter's URL, the bearer
// header, `response_format`, `JSON.parse(choices[0].message.content)`. Four
// copies of one call is how a seam like `FREILAUF_OPENROUTER_BASE` ends up
// honoured in exactly one of them (it did), and how a source that is not
// OpenRouter cannot be added at all.
//
// What is left in the callers is what genuinely differs between them and must
// not be unified: their ERROR STYLE (a title fails soft to null, the check
// fails loud, a flow step throws, the extras endpoint returns a translated
// message), their throttles, their context caps and their defaults. The job's
// chain — primary source plus fallbacks — is planned once in job.mjs; only
// the transport is here.
//
// The three strategies, decided by the source plugin's declared `llm.schema`
// (PLAN §3.7) — and the adapters do no coaxing of their own, because two
// places persuading one model is how answers stop being reproducible:
//
//   native        the schema goes over the wire as a schema. Nothing is added
//                 to the prompt.
//   json_object   the vendor can promise valid JSON but takes no schema, so the
//                 adapter gets the schema flag AND the prompt carries the
//                 shape.
//   prompt        the schema is a paragraph of instructions and nothing else.
//
// Whatever comes back is read tolerantly (`extractJson`), measured against the
// schema (`validate`, which COERCES — "true" from a small model is right about
// the answer and wrong about the type), and on failure asked for again exactly
// once with the complaint attached (`repairPrompt`). Then it gives up, and says
// so honestly.
//
// Resilience has two rungs, and they answer two different questions:
//
//   fallback    the PRIMARY source is down (transport: 5xx, rate limit,
//               timeout, network). The next source in the chain takes the
//               question — no backoff, no wait: the fallback exists precisely
//               so the answer does not have to wait for the primary to
//               recover. A `config` problem of one entry (unknown source,
//               missing credential) skips to the next the same way; a chain
//               whose every entry is misconfigured is a config answer, not a
//               failure.
//   retry       the WHOLE chain is down. Then the call waits — exponential
//               backoff with jitter, `backoffDelayMs()` below — and walks the
//               chain again, until `llm_retry_attempts` (default 10, hard cap
//               10) transport attempts have been made in total.
//
// A `parse` or `validate` failure is NEITHER: the answer arrived, the provider
// is demonstrably up, and the repair round on the same source is the answer to
// it (below). Falling back on a model that answers prose would only hide which
// source cannot obey the schema.
import { setTimeout as sleep } from 'node:timers/promises'
import { getSetting } from '../db.mjs'
import { pluginCtx } from '../plugins/context.mjs'
import { extractJson } from './json.mjs'
import { validate, strictPrompt, repairPrompt, formatProblems } from './schema.mjs'
import { llmAlert } from './alerts.mjs'
import { getSource, missingCredential } from './sources.mjs'
import { t } from '../i18n.mjs'

/** One reprompt by default; `0` switches the second attempt off entirely. */
const DEFAULT_RETRIES = 1

/**
 * How much of the model's RAW answer a parse/validate failure carries. The
 * answer itself is the diagnosis — "the schema failed" is not actionable, what
 * the model actually said is. Long enough to show the shape of a wrapped or
 * truncated document, short enough not to flood a notification channel.
 */
const ANSWER_MAX = 1200

/**
 * The hard cap on transport attempts of one `llmJson` call — across the whole
 * chain and every backoff round. The operator can lower it
 * (`llm_retry_attempts`), never raise it past ten: a purpose that is waiting
 * on a dead provider must come back to say so, not hang for an hour.
 */
export const MAX_RETRY_ATTEMPTS = 10

/** The retry budget as the operator set it. */
function retryBudget() {
  const raw = String(getSetting('llm_retries') ?? '').trim()
  if (!raw) return DEFAULT_RETRIES
  const n = Number(raw)
  // `Number('')` is 0 AND finite — the trap alerts.mjs documents; hence the
  // empty check above. An explicit 0 the operator typed is honoured.
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_RETRIES
}

/** A numeric setting that honours an explicit 0 and never trusts `Number('')`. */
function numSetting(key, dflt, max = Infinity) {
  const raw = String(getSetting(key) ?? '').trim()
  if (!raw) return dflt
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return dflt
  return Math.min(max, n)
}

/** The transport-retry policy as the operator set it. */
function retryPolicy() {
  return {
    attempts: Math.floor(numSetting('llm_retry_attempts', MAX_RETRY_ATTEMPTS, MAX_RETRY_ATTEMPTS)),
    baseMs: Math.floor(numSetting('llm_retry_base_ms', 2000, 10 * 60_000)),
    maxMs: Math.floor(numSetting('llm_retry_max_ms', 30_000, 10 * 60_000)),
  }
}

/**
 * The wait before the next walk of the chain: exponential in the round, with
 * full ±50 % jitter. The jitter is the point — a hundred hubs restarting the
 * same service at the same moment would otherwise retry in lockstep and
 * hammer the recovering provider as one client. Exported for the tests.
 */
export function backoffDelayMs(round, { baseMs, maxMs }) {
  const base = baseMs * 2 ** round
  // Jitter FIRST, cap LAST: the ceiling must bound the actual wait, not the
  // pre-jitter value — a bound the wait can exceed by half is no bound.
  return Math.min(maxMs, Math.max(0, Math.round(base * (0.5 + Math.random()))))
}

function fail(stage, error, kind = null) {
  const out = { ok: false, stage, error: String(error) }
  if (kind) out.kind = kind
  return out
}

/**
 * Classify a transport failure into the errorClass the alert deduplicates on.
 *
 * `HTTP <status>` is the ONE error shape every adapter throws (docs/plugins.md,
 * `ctx.json`); the status code is what tells "out of credits" (402) from
 * "rate limit" (429) from "the provider is down" (5xx) apart — which is the
 * question the operator's alert has to answer. The 5xx family shares one class
 * so a failing server that alternates 500/502/503 pages once, not three times.
 * Everything else — a timeout, a network error, a broken adapter — is a plain
 * `transport`.
 *
 * @returns {{ kind: string, code: number|null, error: string }}
 */
export function classifyTransportError(err) {
  const msg = String(err?.message ?? err ?? '')
  const m = /HTTP (\d{3})/.exec(msg)
  if (m) {
    const code = Number(m[1])
    return { kind: code >= 500 ? 'http_5xx' : `http_${code}`, code, error: msg }
  }
  const name = String(err?.name ?? '')
  if (name === 'TimeoutError' || name === 'AbortError' || /time\s*out|timeout/i.test(msg)) {
    return { kind: 'timeout', code: null, error: msg }
  }
  return { kind: 'transport', code: null, error: msg }
}

/**
 * The human-readable, translated sentence for a classified transport failure.
 * A known status gets its own key (`llm.err_http_429` …), any other HTTP code
 * the generic `llm.err_http_other` (which still names the code), a timeout and
 * a bare transport failure their own texts.
 */
function transportText(c) {
  if (c.code == null) {
    if (c.kind === 'timeout') return t('llm.err_timeout')
    return t('llm.err_transport', { error: c.error })
  }
  const specific = t(`llm.err_${c.kind}`)
  if (specific !== `llm.err_${c.kind}`) return specific
  return t('llm.err_http_other', { code: c.code })
}

/**
 * Ask ONE source of the chain. This is the whole per-source strategy of the
 * old `llmJson`: the strict prompt, the schema handing, the repair rounds and
 * the OpenRouter recovery round.
 *
 * Transport failures are classified but NOT alerted here — with a chain, the
 * alert belongs to the exhausted call, not to every entry of every round.
 *
 * @returns the `llmJson` result shape, with `entry` naming what was asked.
 */
async function askOne(entry, req) {
  const { source, model } = entry
  const sourceKey = String(source ?? '').trim()
  const src = getSource(sourceKey)
  if (!src) return { ...fail('config', `no usable model source ${JSON.stringify(sourceKey)} — it is unknown, switched off or does not answer the hub's own questions`), entry }
  // A coding agent can answer WITHOUT a model (claude picks its own default) —
  // that is exactly what makes `agent:claude` (print-only mode) a zero-config
  // fallback. A provider has no such default: its model field is required.
  if (!model && src.kind !== 'agent') return { ...fail('config', `no model configured for ${src.id}`), entry }
  if (!req.schema || typeof req.schema !== 'object') return { ...fail('config', 'no schema — llmJson answers structured questions only'), entry }

  // A missing REQUIRED credential is a configuration answer, not a failed call:
  // without it the adapter would throw and the failure would be filed under
  // "transport", which is the one class that suggests something is broken.
  const missing = missingCredential(src.pluginId, src.plugin)
  if (missing) return { ...fail('config', `${src.label}: no ${missing} configured`), entry }

  const native = src.schema === 'native'
  const strict = native ? '' : strictPrompt(req.schema, { schemaName: req.schemaName ?? '' })
  const base = String(req.prompt ?? '')
  const ctx = pluginCtx(src.pluginId)

  const call = async (userText, auto = false) => src.plugin.llm.complete(ctx, {
    model: model || undefined,
    system: req.system ?? null,
    prompt: userText,
    // The schema is handed over for `native` (a real schema) and for
    // `json_object` (which reads it as "constrain the answer to JSON"). For a
    // `prompt` source it would be a flag no adapter can act on, so it stays out
    // — the shape is in the text.
    schema: src.schema === 'prompt' ? null : req.schema,
    schemaName: req.schemaName ?? '',
    purpose: req.purpose,
    maxTokens: req.maxTokens, temperature: req.temperature, timeoutMs: req.timeoutMs,
    // The OpenRouter recovery round re-selects the serving provider with a
    // FRESH resolve (`orRoutingRefresh`): the operator's own config — free
    // routing, a pin, or auto — was already tried and answered unusably, and
    // the 24 h cache would only hand back the same order that just failed.
    servingProvider: auto ? null : (req.servingProvider || null),
    orRouting: auto ? { mode: 'auto' } : (req.orRouting ?? null),
    orRoutingRefresh: auto ? true : undefined,
  })

  const first = strict ? `${base}\n\n${strict}` : base
  let attempt = 0
  const retries = retryBudget()
  let text = ''
  let stage = 'transport'
  let error = 'no answer'
  let problems = []
  let kind = null
  // OpenRouter has a best-provider selection (the `routing` capability); a
  // source that cannot re-select gets no recovery round, only the budget above.
  const canReselect = src.pluginId === 'openrouter' && typeof src.plugin?.routing?.resolve === 'function'
  let autoRound = false

  while (true) {
    // The ordinary budget is `llm_retries` + 1 calls. When a `parse` or
    // `validate` failure has SPENT it, OpenRouter gets exactly ONE recovery
    // round: the same question again, but through a freshly re-selected best
    // provider — a different serving endpoint is the one thing that can make a
    // model that keeps answering prose actually obey the schema. A transport
    // failure never reprompts (it does not become right by asking again) and
    // never triggers the recovery round — it moves to the next chain entry
    // instead, which is what the fallback is FOR.
    const budgetSpent = attempt > retries
    const needsAuto = canReselect && !autoRound && budgetSpent && (stage === 'parse' || stage === 'validate')
    if (budgetSpent && !needsAuto) break
    if (needsAuto) autoRound = true

    // A repair round quotes the previous answer and the exact complaint back,
    // and repeats BOTH the question and the strict block — the second attempt
    // is a fresh, stateless call, so anything not repeated here is gone.
    //
    // The question used to be the one thing left out, and the failure that
    // caused is the worst kind: the repair round still produced a
    // schema-VALID answer, so the caller could not tell. Measured against a
    // real model on 2026-08-30: asked "what is two plus two", told only that
    // its first answer was not JSON, it came back with `{"answer": 0}` — a
    // run title about nothing, an incident verdict about no incident, an
    // `extract` with the right fields and invented values. A wrong answer that
    // validates is worse than an honest failure, which is what the whole
    // `{ok:false}` half of this module exists to give the caller.
    const userText = attempt === 0
      ? first
      : ['The question was:', base, repairPrompt(text, problems), strict].filter(Boolean).join('\n\n')

    let answer
    try {
      answer = await call(userText, autoRound)
    } catch (err) {
      // Transport failures are NOT reprompted: a 401, a timeout or a missing
      // binary does not become right by asking the same thing again. They are
      // classified and returned, and the chain walk above decides — next
      // source, or backoff, or give up.
      const c = classifyTransportError(err)
      kind = c.kind
      stage = 'transport'
      error = transportText(c)
      break
    }

    text = String(answer?.text ?? '')
    const parsed = extractJson(text)
    if (!parsed.ok) {
      stage = 'parse'
      // The `problems` fed back to the model stay ENGLISH on purpose — a
      // repair prompt must not change with the operator's UI language
      // (schema.mjs, "NOTE ON LANGUAGE"). Only the human-facing `error` is
      // translated.
      problems = [`the answer is not JSON (${parsed.note})`]
      error = autoRound ? t('llm.err_parse_auto', { note: parsed.note }) : t('llm.err_parse', { note: parsed.note })
      attempt++
      continue
    }
    const checked = validate(req.schema, parsed.value)
    if (!checked.ok) {
      stage = 'validate'
      problems = checked.problems
      error = (autoRound ? t('llm.err_validate_auto') : t('llm.err_validate')) +
        (checked.problems.length ? `\n${formatProblems(checked.problems)}` : '')
      attempt++
      continue
    }
    return {
      ok: true,
      // The COERCED value, never the raw parse: that is the whole point of
      // validate() — the caller gets `true`, not `"true"`.
      data: checked.value,
      usage: answer?.usage ?? null,
      source: src.id,
      model: model || '',
      ...(parsed.repaired.length ? { repaired: parsed.repaired } : {}),
    }
  }

  const out = { ...fail(stage, error, kind), entry: { ...entry, label: src.label, id: src.id } }
  // A parse/validate failure carries what the model actually said: the raw
  // answer, trimmed and capped. Without it a schema failure says only THAT it
  // failed — with it, the operator reads the fence, the prose or the wrong
  // shape and knows what to do. A transport failure carries none: `text` there
  // may hold an answer from an EARLIER round that has nothing to do with why
  // the call failed.
  if ((stage === 'parse' || stage === 'validate') && text) {
    const raw = String(text).trim()
    if (raw) out.answer = raw.length > ANSWER_MAX ? `${raw.slice(0, ANSWER_MAX)}\n…` : raw
  }
  return out
}

/**
 * Ask a model a question and get a value back — walking a chain of sources if
 * the first is down, and retrying the chain with exponential backoff when the
 * whole chain is down.
 *
 * @param {object} req
 * @param {string} [req.source]           `provider:<id>` / `agent:<id>`; empty = OpenRouter
 * @param {string} [req.model]            the model identifier for that source
 *                                        (optional for an agent source — claude
 *                                        then picks its own default)
 * @param {Array}  [req.fallbacks]        the rest of the chain, from job.mjs:
 *                                        `[{ source, model? }]`, tried in order
 *                                        on transport failures
 * @param {string} req.prompt             the user half of the question
 * @param {string} [req.system]           the system half
 * @param {object} req.schema             JSON schema the answer must match
 * @param {string} [req.schemaName]       name for it (`run_title`, `flow_extract`, …)
 * @param {string} req.purpose            the caller: title | check | extract | extras
 * @param {string} [req.servingProvider]  OpenRouter's serving-provider pin; ignored elsewhere
 * @param {object} [req.orRouting]        OpenRouter auto-routing config
 *                                        ({mode:'auto', quant_min?, location?, max_in?, max_out?});
 *                                        resolved to a provider order through the plugin's
 *                                        routing capability — cached per model+config
 * @param {number} [req.maxTokens]
 * @param {number} [req.temperature]
 * @param {number} [req.timeoutMs]
 * @returns {Promise<{ok:true, data, usage, source, model, repaired?: string[]}
 *                 | {ok:false, error:string, stage:'config'|'transport'|'parse'|'validate',
 *                    answer?: string}>}
 *   On a `parse`/`validate` failure `answer` carries the model's raw reply,
 *   trimmed and capped — the diagnosis a bare error sentence cannot give.
 *
 * **It never throws.** The four callers have four different error styles and
 * every one of them expects a value — a rejection here would have to be caught
 * in four places, and the one that forgot would take a page down with it.
 */
export async function llmJson({
  source, model, fallbacks = [], prompt, system, schema, schemaName, purpose = 'llm',
  servingProvider = null, orRouting = null, maxTokens, temperature, timeoutMs,
} = {}) {
  // The chain: primary first, then the fallbacks. A fallback that repeats the
  // primary VERBATIM (same source, same model) is dropped — retrying the
  // identical call is the backoff's job, not the chain's. The same source with
  // a DIFFERENT model stays: trying another model on the same provider is a
  // meaningful second attempt.
  const primary = { source: String(source ?? '').trim(), model: (model ?? '').trim() || null }
  const chain = [primary]
  for (const fb of Array.isArray(fallbacks) ? fallbacks : []) {
    const entry = { source: String(fb?.source ?? '').trim(), model: (fb?.model ?? '').trim() || null }
    if (!entry.source) continue
    if (entry.source === primary.source && entry.model === primary.model) continue
    if (chain.some(c => c.source === entry.source && c.model === entry.model)) continue
    chain.push(entry)
  }

  const req = { prompt, system, schema, schemaName, purpose, servingProvider, orRouting, maxTokens, temperature, timeoutMs }
  const policy = retryPolicy()

  let configFail = null        // the PRIMARY entry's config answer, when even the fallbacks cannot rescue the call
  let lastTransport = null     // the newest transport failure — the honest error if the budget runs out
  let transportAttempts = 0    // every transport attempt of this call, across the chain and the rounds
  const tried = []             // one summary line per failed entry, for the alert
  let round = 0

  while (true) {
    for (const entry of chain) {
      // The FIRST walk of the chain always runs to the end — a configured
      // fallback must be tried even at `llm_retry_attempts=0`, or the whole
      // feature would depend on a second setting. Every later walk only runs
      // while the attempt budget lasts.
      if (round > 0 && transportAttempts >= policy.attempts) return finishTransport()
      const r = await askOne(entry, req)
      if (r.ok) return r
      if (r.stage === 'config') {
        // A misconfigured entry is skipped, never counted as an attempt: no
        // amount of waiting makes a missing key appear. The PRIMARY's config
        // answer is the one kept — it names what the operator actually chose.
        if (entry === chain[0]) {
          configFail = r
          console.warn(`[llm] ${purpose}: source ${entry.source} skipped: ${r.error}`)
        } else {
          console.warn(`[llm] ${purpose}: fallback ${entry.source} skipped: ${r.error}`)
        }
        continue
      }
      if (r.stage === 'transport') {
        lastTransport = r
        transportAttempts++
        tried.push(`${r.entry?.id ?? entry.source}: ${r.error}`)
        continue
      }
      // parse/validate terminal: the source answered, the repair budget and
      // the OpenRouter recovery round are spent. This is an answer problem,
      // not an outage — no fallback, no backoff. One throttled alert, as
      // before, naming the source that failed — and quoting the model's raw
      // answer, because that is the diagnosis the operator cannot get from a
      // bare "did not match".
      await llmAlert({ purpose, source: r.entry?.id ?? entry.source, model: r.entry?.model ?? '', errorClass: r.kind ?? r.stage, text: r.error, answer: r.answer })
      return { ...fail(r.stage, r.error, r.kind), ...(r.answer ? { answer: r.answer } : {}) }
    }

    // The whole chain answered config — nothing was ever asked. The primary's
    // own config answer is returned, never alerted (a state the operator
    // chose, see the alert comment below), and no retry can help it.
    if (!lastTransport) {
      if (configFail) return fail(configFail.stage, configFail.error)
      return fail('config', 'no model source in the chain is usable')
    }
    if (transportAttempts >= policy.attempts) return finishTransport()
    await sleep(backoffDelayMs(round, policy))
    round++
  }

  async function finishTransport() {
    // One throttled, deduplicated alert for the WHOLE exhausted call — the
    // signature keys on the primary (that is the job the operator configured),
    // and the text names every source that was tried, in order. Deliberately
    // NOT for a `config` stage: a source nobody configured a key for is a
    // state the operator chose, and alarming about it would be the
    // "channel that cries wolf" alerts.mjs exists to prevent.
    const summary = tried.length > 1
      ? `${tried.length} attempts failed:\n${tried.join('\n')}`
      : (tried[0] ?? lastTransport.error)
    try {
      await llmAlert({ purpose, source: chain[0].source || undefined, model: chain[0].model ?? '', errorClass: lastTransport.kind ?? 'transport', text: summary })
    } catch { /* the alert channel is fail-soft; the answer below is the truth */ }
    return fail('transport', lastTransport.error, lastTransport.kind)
  }
}
