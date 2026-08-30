// cc-hub flows — structured extraction. Same channel as the check LLM
// (pruefer.mjs): the default model is `llm_check_model` and the default source
// `llm_check_source`, both overridable per step (`model`, `source`). An unset
// source reads as `provider:openrouter` — the call this file used to make
// itself.
import { getSetting } from '../db.mjs'
import { llmJson } from '../llm/index.mjs'
import { defaultSource } from '../llm/sources.mjs'

const MAX_CHARS = 60_000     // context cap for the extraction input (cost + latency)

const TYPE_MAP = {
  string: { type: 'string' },
  number: { type: 'number' },
  boolean: { type: 'boolean' },
  string_list: { type: 'array', items: { type: 'string' } },
}
export const FIELD_TYPES = Object.keys(TYPE_MAP)

/** JSON schema for a list of { name, type, description, enumValues } fields. */
export function schemaFromFields(fields) {
  const properties = {}
  const required = []
  for (const f of fields) {
    const name = String(f.name ?? '').trim().replace(/[^A-Za-z0-9_]/g, '_')
    if (!name) continue
    const base = { ...(TYPE_MAP[f.type] ?? TYPE_MAP.string) }
    if (f.description) base.description = String(f.description)
    const enumValues = String(f.enumValues ?? '').split(',').map(s => s.trim()).filter(Boolean)
    if (enumValues.length && base.type === 'string') base.enum = enumValues
    properties[name] = base
    required.push(name)
  }
  return { type: 'object', additionalProperties: false, required, properties }
}

const SYSTEM = `You read the report (and possibly the terminal log) of an autonomous coding agent run and fill in the requested fields.
Rules: answer only from what the text supports; when something is not stated, use an empty string, 0, false or an empty list.
Never invent branch names, URLs or numbers. Answer exclusively in the given JSON schema.`

/**
 * Ask the model to fill the fields from `text`. Returns the parsed object.
 * Throws with a clear message when the model is missing or the call fails —
 * the flow run then shows exactly why the step failed.
 *
 * `source` here is the MODEL SOURCE (`provider:openrouter`, `agent:claude`, …),
 * not the extract step's own `source` property — that one names where the text
 * comes from (report, log, transcript, custom) and is a different question that
 * happens to share a word. A step field wiring this one through therefore wants
 * a name of its own (`llmSource`), or the two would collide in `props`.
 */
export async function extractStructured({ text, instructions = '', fields, model = null, source = null }) {
  const useModel = model || getSetting('llm_check_model')
  if (!useModel) throw new Error('extract: no model — set one in the step or under Settings → check LLM')
  const useSource = String(source ?? '').trim()
    || (getSetting('llm_check_source') ?? '').trim()
    || defaultSource()
  const schema = schemaFromFields(fields)
  if (!schema.required.length) throw new Error('extract: no valid fields')

  let input = String(text ?? '')
  if (input.length > MAX_CHARS) input = input.slice(0, MAX_CHARS / 2) + '\n…\n' + input.slice(-MAX_CHARS / 2)
  const user = `${instructions ? `Instructions:\n${instructions}\n\n` : ''}Text:\n\`\`\`\n${input}\n\`\`\``

  const r = await llmJson({
    source: useSource,
    model: useModel,
    system: SYSTEM,
    prompt: user,
    schema,
    schemaName: 'flow_extract',
    purpose: 'extract',
    servingProvider: getSetting('llm_check_or_provider') || null,
    maxTokens: 2000,
    temperature: 0,
    timeoutMs: 120_000,
  })
  // This one THROWS, unlike the other three callers — a flow step that could
  // not extract anything has failed, and the flow run must say so in its log
  // rather than carry an empty object into the steps below it. The `extract: `
  // prefix is what makes that log line readable, so it stays on every message.
  if (!r.ok) throw new Error(`extract: ${r.error}`)
  const out = r.data
  if (!out || typeof out !== 'object') throw new Error('extract: model answer is not an object')
  // Fill missing fields so templates downstream never see undefined.
  for (const name of schema.required) if (!(name in out)) out[name] = schema.properties[name].type === 'array' ? [] : schema.properties[name].type === 'number' ? 0 : schema.properties[name].type === 'boolean' ? false : ''
  return out
}
