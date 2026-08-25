// cc-hub — the title of a run.
//
// Every run needs a name one can recognize it by in the overview. An agent run
// has one for free: the agent's. A single run has none — it is not stored
// anywhere, it only exists as a prompt. So the single-run form carries a title
// field, and when that field stays empty a cheap model at OpenRouter derives a
// short title from the prompt (Settings → Title LLM).
//
// Fail-SOFT, deliberately the opposite of the check LLM (pruefer.mjs): a
// missing title is a cosmetic flaw, not a swallowed outage. Without a key,
// without a model or on any error the run keeps the fallback title — the first
// meaningful line of the prompt. A title never holds a start up and never lets
// one fail: generation happens AFTER the run exists and only replaces the
// fallback if it is still there.
import db, { getSetting, mruList, mruRemember } from './db.mjs'

/**
 * The default: DeepSeek V4 Flash at OpenRouter, ~$0.05/$0.10 per million tokens
 * (a title costs roughly a hundredth of a cent), supports structured outputs
 * and needs no reasoning for this. Freely changeable in the settings — the
 * value here is only what applies while nothing is configured.
 */
export const DEFAULT_TITLE_MODEL = 'deepseek/deepseek-v4-flash'

/** Longer than this no overview column carries it, and no title needs it. */
export const TITLE_MAX = 80

const MRU_KEY = 'llm_title_models_mru'

export function titleModel() {
  return (getSetting('llm_title_model') ?? '').trim() || DEFAULT_TITLE_MODEL
}

/**
 * On unless switched off: unlike the check LLM this needs no decision from the
 * operator — a model is preset, and without an OpenRouter key the whole thing
 * silently stays with the fallback anyway.
 */
export function titleLlmActive() {
  return (getSetting('llm_title_on') ?? '1') === '1' && !!titleModel() && !!process.env.OPENROUTER_API_KEY
}

export function titleModelsMru() { return mruList(MRU_KEY) }
export function rememberTitleModel(model) { mruRemember(MRU_KEY, model) }

/** Cut to a whole word, with an ellipsis when something was dropped. */
function shorten(s, max = TITLE_MAX) {
  const text = String(s ?? '').trim()
  if (text.length <= max) return text
  const cut = text.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return (space > max / 2 ? cut.slice(0, space) : cut).trimEnd() + '…'
}

/**
 * The title without an LLM: the first line of the prompt that says something,
 * freed of markdown decoration. Not clever, but always available — and that is
 * the point: this is what the run is called while the model is still answering,
 * and what it keeps if the model never answers.
 */
export function fallbackTitle(prompt, max = TITLE_MAX) {
  for (const raw of String(prompt ?? '').split('\n')) {
    const line = raw
      .replace(/^\s*[#>*\-+]+\s*/, '')      // headings, quotes, list bullets
      .replace(/^\s*\d+[.)]\s+/, '')        // numbered list
      .replace(/[`*_]+/g, '')               // inline markdown
      .replace(/\s+/g, ' ')
      .trim()
    if (line.length >= 3) return shorten(line, max)
  }
  return ''
}

const SCHEMA = {
  name: 'run_title',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['title'],
    properties: {
      title: { type: 'string', description: 'the title, at most 8 words, no final period' },
    },
  },
}

const SYSTEM = `You name programming tasks for a dashboard that lists running coding agents.
You get the task description an agent was given and answer with a SHORT title.
Rules:
- at most 8 words, ideally 3 to 6
- name the subject, not the wording ("Rewrite login form", not "The user wants …")
- no quotes, no final period, no prefix like "Task:"
- same language as the task description
- ignore boilerplate: platform rules, reporting instructions, branch rules
Answer exclusively in the given JSON schema.`

/**
 * Ask for a title. Returns the title or null (off, no key, error, empty answer).
 * The context is capped: a title comes from the first paragraphs, and nothing
 * about that is worth paying for a 50k-token prompt.
 */
export async function generateTitle(prompt, { timeoutMs = 30_000 } = {}) {
  if (!titleLlmActive()) return null
  const text = String(prompt ?? '').trim()
  if (!text) return null
  const model = titleModel()
  const body = {
    model,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: text.length > 6000 ? text.slice(0, 6000) + '\n…' : text },
    ],
    response_format: { type: 'json_schema', json_schema: SCHEMA },
    // A title is not a thinking task; the levy for reasoning tokens would be
    // larger than the whole request.
    reasoning: { enabled: false },
    temperature: 0,
    max_tokens: 200,
  }
  const orProvider = (getSetting('llm_title_or_provider') ?? '').trim()
  if (orProvider) body.provider = { order: [orProvider], allow_fallbacks: false }

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'content-type': 'application/json',
        'HTTP-Referer': 'https://github.com/hwalde/cc-hub',
        'X-Title': 'cc-hub run title',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return null
    const j = await res.json()
    const raw = j?.choices?.[0]?.message?.content
    const parsed = JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw))
    const title = shorten(String(parsed?.title ?? '').replace(/^["'\s]+|["'.\s]+$/g, ''))
    return title.length >= 3 ? title : null
  } catch {
    return null
  }
}

/**
 * Generate the title in the background and write it — but only over the
 * fallback the run started with. If the operator renamed the run in the
 * meantime (inline editing in the overview), their name wins: a model must
 * never overwrite a decision a human already made.
 */
export async function applyGeneratedTitle(runId, prompt) {
  const title = await generateTitle(prompt)
  if (!title) return null
  const before = fallbackTitle(prompt)
  const r = db.prepare(`UPDATE runs SET title=? WHERE id=? AND (title IS NULL OR title='' OR title=?)`)
    .run(title, runId, before)
  return r.changes ? title : null
}

/**
 * What a run is called on screen. The stored title first, then the agent's name
 * (an agent run needs no own title), and only then the generic word — so a row
 * is never nameless.
 */
export function runTitle(run, agentName = null, fallback = '') {
  return (run?.title ?? '').trim() || (agentName ?? '').trim() || fallback
}
