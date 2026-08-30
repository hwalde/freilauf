// cc-hub — `llmJson()`: the one way the hub asks a model a question.
//
// Four callers ask one — the run title, the incident check, a flow's `extract`
// step and the worktree-extras suggestion. Before this module each of them
// carried its own copy of the same forty lines: OpenRouter's URL, the bearer
// header, `response_format`, `JSON.parse(choices[0].message.content)`. Four
// copies of one call is how a seam like `CCHUB_OPENROUTER_BASE` ends up
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

function fail(stage, error) { return { ok: false, stage, error: String(error) } }

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
  servingProvider = null, maxTokens, temperature, timeoutMs,
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

  const call = async (userText) => src.plugin.llm.complete(ctx, {
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
    servingProvider: servingProvider || null,
  })

  const first = strict ? `${base}\n\n${strict}` : base
  let attempt = 0
  const retries = retryBudget()
  let text = ''
  let stage = 'transport'
  let error = 'no answer'
  let problems = []

  while (attempt <= retries) {
    // A repair round quotes the previous answer and the exact complaint back;
    // the strict block is repeated for a non-native source because the second
    // attempt is a fresh, stateless call — there is no conversation to carry it.
    const userText = attempt === 0
      ? first
      : [repairPrompt(text, problems), strict].filter(Boolean).join('\n\n')

    let answer
    try {
      answer = await call(userText)
    } catch (err) {
      // Transport failures are NOT reprompted: a 401, a timeout or a missing
      // binary does not become right by asking the same thing again, and the
      // retry would double the latency of every broken call.
      stage = 'transport'
      error = err?.message ? String(err.message) : 'the model source did not answer'
      break
    }

    text = String(answer?.text ?? '')
    const parsed = extractJson(text)
    if (!parsed.ok) {
      stage = 'parse'
      error = `the answer is not JSON (${parsed.note})`
      problems = [error]
      attempt++
      continue
    }
    const checked = validate(schema, parsed.value)
    if (!checked.ok) {
      stage = 'validate'
      problems = checked.problems
      error = `the answer does not match the schema:\n${formatProblems(checked.problems)}`
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
  await llmAlert({ purpose, source: src.id, model, errorClass: stage, text: error })
  return fail(stage, error)
}
