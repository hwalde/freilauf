// cc-hub — check LLM (optional): second opinion on the detector's log hits.
//
// The scanner finds lines that look like a rate limit or provider error. But it
// cannot know whether the agent carries on afterwards or whether it was just a menu
// text. When enabled, a model via OpenRouter receives the last lines of the cleaned
// terminal and answers STRUCTURED (json_schema) — no free text that would then have
// to be parsed again.
//
// Fail-loud: if OpenRouter itself is unreachable or no key is present, the scanner
// hit remains unchecked (yellow, turns red by time/count). Better one alarm too
// many than a swallowed outage.
import { getSetting, mruList, mruRemember } from './db.mjs'
import { TYPEN } from './detect.mjs'

const MIN_ABSTAND_MS = 10 * 60_000    // per run at most one request every 10 min
const MAX_ZEICHEN = 12_000            // context cap: cost and latency
const zuletzt = new Map()             // runId → ms of the last request

export function pruefLlmAktiv() {
  return getSetting('llm_check_on') === '1' && !!getSetting('llm_check_model') && !!process.env.OPENROUTER_API_KEY
}

/** Most recently used models — "used" means: saved in the settings. */
export function llmModelleMru() { return mruList('llm_check_models_mru') }
export function llmModellMerken(model) { mruRemember('llm_check_models_mru', model) }

const SCHEMA = {
  name: 'vorfall_urteil',
  strict: true,
  schema: {
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
  const body = {
    model,
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
    response_format: { type: 'json_schema', json_schema: SCHEMA },
    temperature: 0,
    max_tokens: 600,
  }
  const orProvider = getSetting('llm_check_or_provider')
  if (orProvider) body.provider = { order: [orProvider], allow_fallbacks: false }

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'content-type': 'application/json',
        'HTTP-Referer': 'https://github.com/hwalde/cc-hub',
        'X-Title': 'cc-hub Prüf-LLM',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) return { fehler: `HTTP ${res.status}` }
    const j = await res.json()
    const roh = j?.choices?.[0]?.message?.content
    const urteil = JSON.parse(typeof roh === 'string' ? roh : JSON.stringify(roh))
    if (typeof urteil?.problem !== 'boolean') return { fehler: 'response without problem field' }
    return { ...urteil, model, usage: j?.usage ?? null }
  } catch (e) {
    return { fehler: e.message }
  }
}

/** For tests only: reset the throttle. */
export function _drosselZuruecksetzen() { zuletzt.clear() }
