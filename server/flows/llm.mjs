// cc-hub flows — structured extraction via OpenRouter (json_schema response
// format). Same channel as the check LLM (pruefer.mjs): the API key comes from
// OPENROUTER_API_KEY, the default model from the setting `llm_check_model`.
import { getSetting } from '../db.mjs'

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
 * Throws with a clear message when key/model are missing or the call fails —
 * the flow run then shows exactly why the step failed.
 */
export async function extractStructured({ text, instructions = '', fields, model = null }) {
  const key = process.env.OPENROUTER_API_KEY
  if (!key) throw new Error('extract: OPENROUTER_API_KEY is not set')
  const useModel = model || getSetting('llm_check_model')
  if (!useModel) throw new Error('extract: no model — set one in the step or under Settings → check LLM')
  const schema = schemaFromFields(fields)
  if (!schema.required.length) throw new Error('extract: no valid fields')

  let input = String(text ?? '')
  if (input.length > MAX_CHARS) input = input.slice(0, MAX_CHARS / 2) + '\n…\n' + input.slice(-MAX_CHARS / 2)
  const user = `${instructions ? `Instructions:\n${instructions}\n\n` : ''}Text:\n\`\`\`\n${input}\n\`\`\``
  const body = {
    model: useModel,
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
    response_format: { type: 'json_schema', json_schema: { name: 'flow_extract', strict: true, schema } },
    temperature: 0,
    max_tokens: 2000,
  }
  const orProvider = getSetting('llm_check_or_provider')
  if (orProvider) body.provider = { order: [orProvider], allow_fallbacks: false }

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      'HTTP-Referer': 'https://github.com/hwalde/cc-hub',
      'X-Title': 'cc-hub flows',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) throw new Error(`extract: OpenRouter HTTP ${res.status}`)
  const j = await res.json()
  const raw = j?.choices?.[0]?.message?.content
  let out
  try { out = JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw)) } catch { throw new Error('extract: model answer is not JSON') }
  if (!out || typeof out !== 'object') throw new Error('extract: model answer is not an object')
  // Fill missing fields so templates downstream never see undefined.
  for (const name of schema.required) if (!(name in out)) out[name] = schema.properties[name].type === 'array' ? [] : schema.properties[name].type === 'number' ? 0 : schema.properties[name].type === 'boolean' ? false : ''
  return out
}
