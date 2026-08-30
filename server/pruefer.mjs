// cc-hub — check LLM (optional): second opinion on the detector's log hits.
//
// The scanner finds lines that look like a rate limit or provider error. But it
// cannot know whether the agent carries on afterwards or whether it was just a menu
// text. When enabled, a model receives the last lines of the cleaned terminal and
// answers STRUCTURED — no free text that would then have to be parsed again.
//
// Which model source answers is `llm_check_source`; unset means
// `provider:openrouter`, which is the call this file used to make itself.
//
// Fail-loud: if the source is unreachable or no credential is present, the scanner
// hit remains unchecked (yellow, turns red by time/count). Better one alarm too
// many than a swallowed outage.
import { getSetting, mruList, mruRemember } from './db.mjs'
import { TYPEN } from './detect.mjs'
import { llmJson } from './llm/index.mjs'
import { getSource, defaultSource, missingCredential } from './llm/sources.mjs'

/**
 * The stored auto-routing config of one of the hub's own LLM jobs — the same
 * requirements widget the run forms carry, saved on the settings page. Tolerant
 * of nulls and junk: no config, a broken blob — all mean "no auto routing",
 * the plain serving-provider setting then decides alone.
 */
function orRoutingAusSetting(key) {
  const v = getSetting(key)
  if (!v) return null
  try {
    const cfg = JSON.parse(v)
    return cfg?.mode === 'auto' ? cfg : null
  } catch { return null }
}


const MIN_ABSTAND_MS = 10 * 60_000    // per run at most one request every 10 min
const MAX_ZEICHEN = 12_000            // context cap: cost and latency
const zuletzt = new Map()             // runId → ms of the last request

/** Which source answers this question. Unset = OpenRouter, as it always was. */
export function pruefSource() {
  return (getSetting('llm_check_source') ?? '').trim() || defaultSource()
}

/**
 * Off unless the operator switched it on AND named a model — unchanged. What
 * used to be "and an OpenRouter key is set" is now "and the chosen source has
 * the credentials it declares as required", which is the same sentence with the
 * vendor taken out of it.
 */
export function pruefLlmAktiv() {
  if (getSetting('llm_check_on') !== '1' || !getSetting('llm_check_model')) return false
  const src = getSource(pruefSource())
  return !!src && missingCredential(src.pluginId, src.plugin) === null
}

/** Most recently used models — "used" means: saved in the settings. */
export function llmModelleMru() { return mruList('llm_check_models_mru') }
export function llmModellMerken(model) { mruRemember('llm_check_models_mru', model) }

const SCHEMA_NAME = 'vorfall_urteil'
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['problem', 'typ', 'blockiert', 'begruendung', 'zitat'],
  properties: {
    problem: { type: 'boolean', description: 'true if the agent is genuinely hindered by a rate limit, a provider outage, an auth or credit problem' },
    typ: { type: 'string', enum: [...TYPEN, 'kein'] },
    blockiert: { type: 'boolean', description: 'true if the agent is currently NOT continuing to work (stalled, waiting, aborted)' },
    begruendung: { type: 'string' },
    zitat: { type: 'string', description: 'the one line from the terminal that proves it (verbatim), or empty' },
  },
}

const SYSTEM = `You are assessing the terminal capture of an autonomous coding agent (claude code, opencode or hermes).
Question: Is the agent currently hindered by a rate limit, a provider outage (5xx, overloaded, unreachable),
a login/token problem or missing credit?
Important:
- Menu texts, help texts, status lines ("Upgrade to Max for higher rate limits") are NOT a problem.
- If the agent itself is reading, writing or searching code or text about rate limits, that is NOT a problem.
- A retry after which the work visibly continues is an indication (problem=true, blockiert=false).
- If an error message stands at the end of the capture and nothing productive follows, that is problem=true, blockiert=true.
Answer exclusively in the given JSON schema.`

/**
 * Request an assessment. Returns the verdict or null (off, throttled, error).
 * 'zeilen' are already cleaned terminal lines, NOT newest-first —
 * chronological, as they appear in the log.
 */
export async function pruefeTreffer({ runId, harness, treffer, zeilen, jetztMs = Date.now(), erzwingen = false }) {
  if (!pruefLlmAktiv()) return null
  const vorher = zuletzt.get(runId) ?? 0
  if (!erzwingen && jetztMs - vorher < MIN_ABSTAND_MS) return { gedrosselt: true }
  zuletzt.set(runId, jetztMs)

  let kontext = zeilen.join('\n')
  if (kontext.length > MAX_ZEICHEN) kontext = '…\n' + kontext.slice(-MAX_ZEICHEN)
  const user = `Harness: ${harness}\nSuspicious line(s) from the scanner:\n${treffer.map(t => `- [${t.typ}] ${t.zeile}`).join('\n')}\n\nLast terminal lines (chronological, cleaned):\n\`\`\`\n${kontext}\n\`\`\``

  const model = getSetting('llm_check_model')
  const r = await llmJson({
    source: pruefSource(),
    model,
    system: SYSTEM,
    prompt: user,
    schema: SCHEMA,
    schemaName: SCHEMA_NAME,
    purpose: 'check',
    servingProvider: getSetting('llm_check_or_provider') || null,
    orRouting: orRoutingAusSetting('llm_check_or_routing'),
    maxTokens: 600,
    temperature: 0,
    timeoutMs: 60_000,
  })
  // Fail-LOUD, unchanged: every failure comes back as `{ fehler }` and the
  // caller leaves the hit unchecked (yellow) instead of quietly clearing it.
  // The text is the transport's own — `HTTP 429`, a CLI's exit line, the list
  // of schema complaints — which is what makes the detector's journal readable
  // afterwards.
  if (!r.ok) return { fehler: r.error }
  // The schema already requires it; the explicit check stays because this
  // verdict decides whether a run goes red, and a `problem` that is not a
  // boolean must never be read as truthy by accident.
  if (typeof r.data?.problem !== 'boolean') return { fehler: 'response without problem field' }
  return { ...r.data, model, usage: r.usage ?? null }
}
