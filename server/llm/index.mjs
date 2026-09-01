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
// message), their throttles, their context caps and their defaults. Only the
// transport is here.
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
import { getSetting } from '../db.mjs'
import { pluginCtx } from '../plugins/context.mjs'
import { extractJson } from './json.mjs'
import { validate, strictPrompt, repairPrompt, formatProblems } from './schema.mjs'
import { llmAlert } from './alerts.mjs'
import { getSource, defaultSource, missingCredential } from './sources.mjs'
import { t } from '../i18n.mjs'

/** One reprompt by default; `0` switches the second attempt off entirely. */
const DEFAULT_RETRIES = 1

/** The retry budget as the operator set it. */
function retryBudget() {
  const raw = String(getSetting('llm_retries') ?? '').trim()
  if (!raw) return DEFAULT_RETRIES
  const n = Number(raw)
  // `Number('')` is 0 AND finite — the trap alerts.mjs documents; hence the
  // empty check above. An explicit 0 the operator typed is honoured.
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_RETRIES
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
 * Ask a model a question and get a value back.
 *
 * @param {object} req
 * @param {string} [req.source]           `provider:<id>` / `agent:<id>`; empty = OpenRouter
 * @param {string} req.model              the model identifier for that source
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
 *                 | {ok:false, error:string, stage:'config'|'transport'|'parse'|'validate'}>}
 *
 * **It never throws.** The four callers have four different error styles and
 * every one of them expects a value — a rejection here would have to be caught
 * in four places, and the one that forgot would take a page down with it.
 */
export async function llmJson({
  source, model, prompt, system, schema, schemaName, purpose = 'llm',
  servingProvider = null, orRouting = null, maxTokens, temperature, timeoutMs,
} = {}) {
  const sourceKey = String(source ?? '').trim() || defaultSource()
  const src = getSource(sourceKey)
  if (!src) return fail('config', `no usable model source ${JSON.stringify(sourceKey)} — it is unknown, switched off or does not answer the hub's own questions`)
  if (!model) return fail('config', `no model configured for ${src.id}`)
  if (!schema || typeof schema !== 'object') return fail('config', 'no schema — llmJson answers structured questions only')

  // A missing REQUIRED credential is a configuration answer, not a failed call:
  // without it the adapter would throw and the failure would be filed under
  // "transport", which is the one class that suggests something is broken.
  const missing = missingCredential(src.pluginId, src.plugin)
  if (missing) return fail('config', `${src.label}: no ${missing} configured`)

  const native = src.schema === 'native'
  const strict = native ? '' : strictPrompt(schema, { schemaName: schemaName ?? '' })
  const base = String(prompt ?? '')
  const ctx = pluginCtx(src.pluginId)

  const call = async (userText, auto = false) => src.plugin.llm.complete(ctx, {
    model,
    system: system ?? null,
    prompt: userText,
    // The schema is handed over for `native` (a real schema) and for
    // `json_object` (which reads it as "constrain the answer to JSON"). For a
    // `prompt` source it would be a flag no adapter can act on, so it stays out
    // — the shape is in the text.
    schema: src.schema === 'prompt' ? null : schema,
    schemaName: schemaName ?? '',
    purpose,
    maxTokens, temperature, timeoutMs,
    // The OpenRouter recovery round re-selects the serving provider with a
    // FRESH resolve (`orRoutingRefresh`): the operator's own config — free
    // routing, a pin, or auto — was already tried and answered unusably, and
    // the 24 h cache would only hand back the same order that just failed.
    servingProvider: auto ? null : (servingProvider || null),
    orRouting: auto ? { mode: 'auto' } : (orRouting ?? null),
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
    // never triggers the recovery round.
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
      // binary does not become right by asking the same thing again, and the
      // retry would double the latency of every broken call. The status code
      // still NAMES the problem — credits, rate limit, outage — in the
      // operator's language (`classifyTransportError` + `transportText`).
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
    const checked = validate(schema, parsed.value)
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
      model,
      ...(parsed.repaired.length ? { repaired: parsed.repaired } : {}),
    }
  }

  // One throttled, deduplicated alert — and deliberately NOT for a
  // `config` stage. A feature that is switched off, a source nobody configured
  // a key for, a model field left empty: none of those are an outage, they are
  // a state the operator chose, and alarming about them would be the "channel
  // that cries wolf" alerts.mjs exists to prevent. Config problems are visible
  // where they are made — in the settings form and in the caller's own answer.
  // The errorClass is the SPECIFIC failure (`http_429`, `parse`), not the broad
  // stage — two status codes are two different problems and must throttle
  // apart.
  await llmAlert({ purpose, source: src.id, model, errorClass: kind ?? stage, text: error })
  return fail(stage, error, kind)
}
