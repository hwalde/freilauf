// Freilauf — the title of a run.
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
//
// The transport moved into `server/llm` (`llmJson`): which source answers is
// `llm_title_source`, and an installation that never sets it reads
// `provider:openrouter` — exactly the call this file used to make itself.
import db, { getSetting, mruList, mruRemember, announceRun } from './db.mjs'
import { llmJson } from './llm/index.mjs'
import { getSource, defaultSource, missingCredential } from './llm/sources.mjs'

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

/** Which source answers this question. Unset = OpenRouter, as it always was. */
export function titleSource() {
  return (getSetting('llm_title_source') ?? '').trim() || defaultSource()
}

/**
 * On unless switched off: unlike the check LLM this needs no decision from the
 * operator — a model is preset, and without a usable source the whole thing
 * silently stays with the fallback anyway.
 *
 * "Usable" is what the OpenRouter key check was a special case of: the source
 * exists, is switched on, and has every credential it declares as required.
 * A coding-agent source declares none, so picking one is enough to make this
 * true — which is the point of offering them.
 */
export function titleLlmActive() {
  if ((getSetting('llm_title_on') ?? '1') !== '1' || !titleModel()) return false
  const src = getSource(titleSource())
  return !!src && missingCredential(src.pluginId, src.plugin) === null
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

const SCHEMA_NAME = 'run_title'
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title'],
  properties: {
    title: { type: 'string', description: 'the title, at most 8 words, no final period' },
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
 *
 * One thing this call used to carry and no longer can: OpenRouter's
 * `reasoning: { enabled: false }`. A title is not a thinking task and the levy
 * for reasoning tokens is larger than the whole request — but that field is
 * OpenRouter's alone, and the completion contract (`llm.complete`, see
 * docs/plugins.md) has no place for it. The knob belongs in the OpenRouter
 * plugin, not in a caller that must work against three other sources; keeping a
 * private fetch here to save it would put the copy back that this whole layer
 * exists to remove. Preset model, small prompt, `max_tokens: 200`: the cost
 * stays a fraction of a cent either way.
 */
export async function generateTitle(prompt, { timeoutMs = 30_000 } = {}) {
  if (!titleLlmActive()) return null
  const text = String(prompt ?? '').trim()
  if (!text) return null
  const model = titleModel()

  const r = await llmJson({
    source: titleSource(),
    model,
    system: SYSTEM,
    prompt: text.length > 6000 ? text.slice(0, 6000) + '\n…' : text,
    schema: SCHEMA,
    schemaName: SCHEMA_NAME,
    purpose: 'title',
    servingProvider: (getSetting('llm_title_or_provider') ?? '').trim() || null,
    maxTokens: 200,
    temperature: 0,
    timeoutMs,
  })
  // Fail-soft, unchanged: every reason to have no title — off, no credential,
  // a broken vendor, an answer that is not a title — is the same reason to keep
  // the fallback, and none of them is worth a thrown error on the launch path.
  if (!r.ok) return null
  const title = shorten(String(r.data?.title ?? '').replace(/^["'\s]+|["'.\s]+$/g, ''))
  return title.length >= 3 ? title : null
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
  // A title change writes no event, so the live channel has to be told here.
  // This is the case the whole live channel started from: the title arrives
  // seconds after the run does, and the page is already open by then.
  if (r.changes) announceRun(runId, 'title')
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
