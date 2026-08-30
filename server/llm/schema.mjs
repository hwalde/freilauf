// Freilauf — the minimal JSON-Schema subset the hub's own LLM calls need.
//
// There is no Ajv here and there must not be one: this project has zero runtime
// dependencies, and the schemas it actually uses are small and known. Four
// callers describe their answers — `run_title` (title.mjs), `vorfall_urteil`
// (pruefer.mjs), `flow_extract` (flows/llm.mjs, built at runtime by
// `schemaFromFields`) and `worktree_extras` (extras-suggest.mjs) — and between
// them they use exactly these keywords:
//
//   type: object | string | number | integer | boolean | array
//   properties, required, items, enum, additionalProperties, description
//
// Anything else in a schema is ignored rather than rejected: a plugin author
// who copies a richer schema in gets the parts we can enforce, not a 500.
//
// The module does two jobs that look unrelated and are not:
//
//   * `validate()` is what a model's answer is measured against when the source
//     could not enforce the schema itself (`schema: 'prompt'` or
//     `'json_object'`) — and it COERCES, because a small model answering "true"
//     instead of true is right about the answer and wrong about the type.
//   * `describeForPrompt()` / `strictPrompt()` are how that same schema is
//     explained to such a model in the first place.
//
// NOTE ON LANGUAGE: every English string in this file is sent to a MODEL, not
// shown in the UI. They are deliberately plain literals and must NOT be routed
// through `t()` — a prompt that changes with the operator's UI language would
// change the model's answer with it. This is not an i18n oversight.

/** The keywords we understand; everything else is dropped before a schema is shown to a model. */
const KEYWORDS = ['type', 'properties', 'required', 'items', 'enum', 'additionalProperties', 'description']

/** How much of a previous answer the repair prompt quotes back. */
const PREVIOUS_MAX = 1200

const NUMERIC = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/
const TRUE_WORDS = ['true', 'yes', 'y', 'on', '1']
const FALSE_WORDS = ['false', 'no', 'n', 'off', '0']

// ---------------------------------------------------------------------------
// validation and coercion
// ---------------------------------------------------------------------------

/**
 * The declared type of a schema node, tolerating the two shapes that occur:
 * a plain string, and a `["string","null"]` union some generators emit.
 * A node with `properties` but no `type` is an object, one with `items` an
 * array — that is what every model and every generator means by it.
 */
function typeOf(schema) {
  const t = schema?.type
  if (typeof t === 'string') return t
  if (Array.isArray(t)) return t.find(x => x !== 'null') ?? null
  if (schema?.properties) return 'object'
  if (schema?.items) return 'array'
  return null
}

function describeValue(v) {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'an array'
  switch (typeof v) {
    case 'undefined': return 'nothing'
    case 'object': return 'an object'
    case 'string': return 'a string'
    case 'number': return 'a number'
    case 'boolean': return 'a boolean'
    default: return typeof v
  }
}

function nullable(schema) {
  return Array.isArray(schema?.type) && schema.type.includes('null')
}

/**
 * Validate and coerce `value` against `schema`.
 *
 * @returns {{ ok: boolean, value: any, problems: {path: string, message: string}[] }}
 *   `value` is the COERCED value and is always usable — a failed validation
 *   still returns the best reading of the answer, so a caller that wants to log
 *   what it got does not have to hold on to the raw one. `problems` carries the
 *   JSON path (`data.extras[0].mode`) and what was wrong, which is exactly what
 *   `repairPrompt()` hands back to the model.
 */
export function validate(schema, value) {
  const problems = []
  const out = coerce(schema, value, 'data', problems, true)
  return { ok: problems.length === 0, value: out, problems }
}

function coerce(schema, value, path, problems, required) {
  if (!schema || typeof schema !== 'object') return value

  if (value === undefined) {
    if (required) problems.push({ path, message: 'required, but missing from the answer' })
    // A missing optional becomes null so nothing downstream ever sees undefined.
    return null
  }
  if (value === null) {
    if (required && !nullable(schema)) problems.push({ path, message: 'required, but null' })
    return null
  }

  const before = problems.length
  let out
  switch (typeOf(schema)) {
    case 'object': out = coerceObject(schema, value, path, problems); break
    case 'array': out = coerceArray(schema, value, path, problems); break
    case 'string': out = coerceString(value, path, problems); break
    case 'number': out = coerceNumber(value, path, problems, false); break
    case 'integer': out = coerceNumber(value, path, problems, true); break
    case 'boolean': out = coerceBoolean(value, path, problems); break
    default: out = value
  }

  // Only judge the enum when the type was not already the complaint —
  // "expected a string, got an object" plus "not one of a, b" about the same
  // spot is one problem described twice, and a small model reads it as two.
  if (problems.length === before && Array.isArray(schema.enum) && schema.enum.length) {
    if (!schema.enum.some(e => e === out)) {
      // A near miss is a coercion, not a failure: models answer "Copy" for
      // "copy" and " link" for "link" often enough to be worth catching.
      const near = typeof out === 'string'
        ? schema.enum.find(e => typeof e === 'string' && e.toLowerCase() === out.trim().toLowerCase())
        : undefined
      if (near !== undefined) out = near
      else problems.push({
        path,
        message: `${JSON.stringify(out)} is not one of: ${schema.enum.map(e => JSON.stringify(e)).join(', ')}`,
      })
    }
  }
  return out
}

function coerceObject(schema, value, path, problems) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    problems.push({ path, message: `expected an object, got ${describeValue(value)}` })
    return {}
  }
  const props = (schema.properties && typeof schema.properties === 'object') ? schema.properties : {}
  const req = new Set(Array.isArray(schema.required) ? schema.required : [])
  const out = {}

  for (const [k, sub] of Object.entries(props)) {
    const has = Object.prototype.hasOwnProperty.call(value, k)
    out[k] = coerce(sub, has ? value[k] : undefined, `${path}.${k}`, problems, req.has(k))
  }
  // `additionalProperties: false` means the caller asked for exactly these
  // fields — an extra one is dropped, not an error: a model volunteering a
  // "reasoning" field alongside a correct answer has still answered correctly.
  if (schema.additionalProperties !== false) {
    for (const k of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(props, k)) out[k] = value[k]
    }
  }
  // A required name that the schema never described: still required.
  for (const k of req) {
    if (Object.prototype.hasOwnProperty.call(props, k)) continue
    if (!Object.prototype.hasOwnProperty.call(out, k)) {
      problems.push({ path: `${path}.${k}`, message: 'required, but missing from the answer' })
    }
  }
  return out
}

function coerceArray(schema, value, path, problems) {
  // One value where a list was asked for is the single most common shape error
  // a small model makes, and the intent is never in doubt.
  const list = Array.isArray(value) ? value : [value]
  const items = schema.items && typeof schema.items === 'object' ? schema.items : null
  if (!items) return list
  return list.map((v, i) => coerce(items, v, `${path}[${i}]`, problems, true))
}

function coerceString(value, path, problems) {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  problems.push({ path, message: `expected a string, got ${describeValue(value)}` })
  return ''
}

function coerceNumber(value, path, problems, integer) {
  let n = null
  if (typeof value === 'number' && Number.isFinite(value)) n = value
  else if (typeof value === 'string' && NUMERIC.test(value.trim())) n = Number(value.trim())
  if (n === null) {
    problems.push({ path, message: `expected ${integer ? 'an integer' : 'a number'}, got ${describeValue(value)}` })
    return 0
  }
  if (integer && !Number.isInteger(n)) {
    problems.push({ path, message: `expected an integer, got ${n}` })
    return Math.trunc(n)
  }
  return n
}

function coerceBoolean(value, path, problems) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const w = value.trim().toLowerCase()
    if (TRUE_WORDS.includes(w)) return true
    if (FALSE_WORDS.includes(w)) return false
  }
  if (value === 1) return true
  if (value === 0) return false
  problems.push({ path, message: `expected a boolean, got ${describeValue(value)}` })
  return false
}

// ---------------------------------------------------------------------------
// explaining a schema to a model that cannot be handed one
// ---------------------------------------------------------------------------

/** The schema with every keyword we do not enforce removed, recursively. */
function prune(schema) {
  if (!schema || typeof schema !== 'object') return schema
  const out = {}
  for (const k of KEYWORDS) {
    if (!Object.prototype.hasOwnProperty.call(schema, k)) continue
    if (k === 'properties' && schema.properties && typeof schema.properties === 'object') {
      out.properties = {}
      for (const [name, sub] of Object.entries(schema.properties)) out.properties[name] = prune(sub)
    } else if (k === 'items') {
      out.items = prune(schema.items)
    } else {
      out[k] = schema[k]
    }
  }
  return out
}

/**
 * A minimal instance that satisfies `schema` — the shape, never the content.
 * An enum contributes its first value, which is the one case where showing a
 * real value teaches the model something instead of tempting it to copy.
 */
export function exampleFor(schema) {
  if (!schema || typeof schema !== 'object') return null
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0]
  switch (typeOf(schema)) {
    case 'object': {
      const out = {}
      for (const [k, sub] of Object.entries(schema.properties ?? {})) out[k] = exampleFor(sub)
      return out
    }
    case 'array': return [exampleFor(schema.items ?? { type: 'string' })]
    case 'string': return 'text'
    case 'number': return 0
    case 'integer': return 0
    case 'boolean': return false
    default: return null
  }
}

/**
 * The schema written out for a model that has no native schema support:
 * the schema itself, pretty-printed, plus one minimal example instance.
 *
 * Both halves earn their tokens. The schema alone leaves a small model guessing
 * at nesting; the example alone leaves it guessing at what is optional.
 */
export function describeForPrompt(schema) {
  return [
    'Schema:',
    JSON.stringify(prune(schema), null, 2),
    '',
    'Shape of a valid answer (the values are placeholders, not the answer):',
    JSON.stringify(exampleFor(schema), null, 2),
  ].join('\n')
}

/**
 * The instruction block appended to a user prompt for a `prompt`-mode source.
 *
 * Short and imperative on purpose: long instructions make small models worse,
 * and every sentence here was measured against a failure mode — the fence, the
 * "Sure, here is…", the trailing explanation.
 */
export function strictPrompt(schema, { schemaName = '' } = {}) {
  return [
    'Answer with exactly one JSON document and nothing else.',
    'No text before it. No explanation after it. No markdown code fences, no ``` marks.',
    `It must match this schema${schemaName ? ` (${schemaName})` : ''} exactly.`,
    '',
    describeForPrompt(schema),
  ].join('\n')
}

/** Problems as a bullet list a model can act on. Accepts objects or plain strings. */
export function formatProblems(problems) {
  return (Array.isArray(problems) ? problems : [problems])
    .filter(Boolean)
    .map(p => (typeof p === 'string' ? `- ${p}` : `- ${p.path ?? 'data'}: ${p.message ?? 'invalid'}`))
    .join('\n')
}

/**
 * The one retry. It quotes the model's own answer back at it (truncated, so a
 * runaway answer cannot double the cost of the retry), names the exact
 * problems, and repeats the only demand that matters.
 */
export function repairPrompt(previousText, problems = []) {
  const prev = String(previousText ?? '')
  const shown = prev.length > PREVIOUS_MAX ? `${prev.slice(0, PREVIOUS_MAX)}\n…` : prev
  const list = formatProblems(problems) || '- it was not one valid JSON document'
  return [
    'Your previous answer could not be used.',
    '',
    'You answered:',
    shown,
    '',
    'What is wrong with it:',
    list,
    '',
    'Answer again with exactly one JSON document matching the schema.',
    'Only the JSON: no text before it, no explanation after it, no markdown code fences.',
  ].join('\n')
}
