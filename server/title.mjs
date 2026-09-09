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
import db, { getSetting, mruList, mruRemember, announceRun, addEvent } from './db.mjs'
import { env } from './env.mjs'
import { llmJson } from './llm/index.mjs'
import { chainUsable, jobFallbacks, jobRouting, jobSource } from './llm/job.mjs'

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
  return jobSource('title')
}

/**
 * On unless switched off: unlike the check LLM this needs no decision from the
 * operator — a model is preset, and without a usable source the whole thing
 * silently stays with the fallback anyway.
 *
 * "Usable" is what the OpenRouter key check was a special case of — asked once
 * for the whole chain now (`chainUsable` in llm/job.mjs): the primary source
 * OR any configured fallback must exist, be switched on, and have every
 * credential it declares as required. A coding-agent source declares none, so
 * picking one is enough to make this true — which is the point of offering
 * them.
 */
export function titleLlmActive() {
  if ((getSetting('llm_title_on') ?? '1') !== '1' || !titleModel()) return false
  return chainUsable('title', titleModel())
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
  const r = await askTitle(prompt, { timeoutMs })
  return r.ok ? r.title : null
}

/**
 * The same question, with the REASON kept.
 *
 * `generateTitle()` answers a string or `null`, which is exactly right for its
 * callers and exactly wrong for the one that has to decide whether to ask
 * again: "switched off" and "the vendor timed out" arrive as the same `null`,
 * and retrying the first for ever would be as wrong as never retrying the
 * second. So the reason stays here — `off` (nothing to retry), `empty` (no
 * prompt, likewise), or the failing `stage` llmJson names.
 *
 * @returns {Promise<{ok:true, title:string} | {ok:false, reason:string, error?:string}>}
 */
export async function askTitle(prompt, { timeoutMs = 30_000 } = {}) {
  if (!titleLlmActive()) return { ok: false, reason: 'off' }
  const text = String(prompt ?? '').trim()
  if (!text) return { ok: false, reason: 'empty' }
  const model = titleModel()

  const r = await llmJson({
    source: titleSource(),
    model,
    fallbacks: jobFallbacks('title', model),
    ...jobRouting('title'),
    system: SYSTEM,
    prompt: text.length > 6000 ? text.slice(0, 6000) + '\n…' : text,
    schema: SCHEMA,
    schemaName: SCHEMA_NAME,
    purpose: 'title',
    maxTokens: 200,
    temperature: 0,
    timeoutMs,
  })
  // Fail-soft, unchanged: every reason to have no title — off, no credential,
  // a broken vendor, an answer that is not a title — is the same reason to keep
  // the fallback, and none of them is worth a thrown error on the launch path.
  if (!r.ok) return { ok: false, reason: r.stage ?? 'transport', error: String(r.error ?? '') }
  const title = shorten(String(r.data?.title ?? '').replace(/^["'\s]+|["'.\s]+$/g, ''))
  // An answer that arrived and is not a title is a failure like any other: the
  // provider was up, so it is worth asking again, and it must not be filed as
  // "the feature is switched off".
  if (title.length < 3) return { ok: false, reason: 'no_title', error: String(r.data?.title ?? '') }
  return { ok: true, title }
}

/**
 * How often the hub asks for one run's title before it gives up. Three, which
 * is roughly a minute and a half of watcher passes — long enough to sit out a
 * rate limit or a vendor hiccup, short enough that a provider which is really
 * down costs a handful of calls per run and not one every thirty seconds for
 * the life of the run.
 */
export const TITLE_ATTEMPTS_MAX = Math.max(1, Number(env('TITLE_ATTEMPTS') ?? 3) || 3)

/**
 * Generate the title in the background and write it — but only over the
 * fallback the run started with. If the operator renamed the run in the
 * meantime (inline editing in the overview), their name wins: a model must
 * never overwrite a decision a human already made.
 *
 * Two things beyond that, and both exist because this used to be a single
 * fire-and-forget call whose failure was invisible:
 *
 *  - **the attempt is counted, before the question is asked.** `title_attempts`
 *    is what `retryMissingTitles()` reads, and counting it first is what makes
 *    a hub restarted mid-question spend one attempt rather than none (a crash
 *    on this path would otherwise be retried for ever) — the same instinct
 *    `resume_attempts` is written with.
 *  - **a failure is written down.** `title_failed` names the stage and the
 *    vendor's own sentence. It costs at most three events on a run and it is
 *    the difference between "the title never came" and an answer to why: a
 *    silent failure that every layer above reads as healthy is the shape this
 *    project keeps paying for.
 *
 * A run whose title generation is switched off or has no prompt is neither
 * counted nor recorded — nothing was asked, and there is nothing to retry.
 */
export async function applyGeneratedTitle(runId, prompt) {
  if (!titleLlmActive() || !String(prompt ?? '').trim()) return null
  db.prepare('UPDATE runs SET title_attempts = title_attempts + 1 WHERE id=?').run(runId)
  const attempt = db.prepare('SELECT title_attempts FROM runs WHERE id=?').get(runId)?.title_attempts ?? 0
  const answer = await askTitle(prompt)
  if (!answer.ok) {
    // 'off' and 'empty' cannot happen here (both are refused above), so
    // whatever arrives is a real failure and belongs in the run's history.
    addEvent(runId, 'title_failed', {
      reason: answer.reason, attempt, of: TITLE_ATTEMPTS_MAX,
      error: String(answer.error ?? '').slice(0, 300),
    })
    return null
  }
  const before = fallbackTitle(prompt)
  const r = db.prepare(`UPDATE runs SET title=? WHERE id=? AND (title IS NULL OR title='' OR title=?)`)
    .run(answer.title, runId, before)
  // A title change writes no event, so the live channel has to be told here.
  // This is the case the whole live channel started from: the title arrives
  // seconds after the run does, and the page is already open by then.
  if (r.changes) announceRun(runId, 'title')
  return r.changes ? answer.title : null
}

/** How far back this repair reaches, and how many titles one pass may ask for. */
export const RETRY_WINDOW_MIN = 60
const RETRY_PER_PASS = 3

/**
 * Does this run still want a title? The rule, pure, so the SQL below only ever
 * NARROWS the candidates and never decides.
 *
 * Four refusals, and each of them is a way asking again would be wrong:
 *
 *  - **the title is not the fallback any more.** Either the model already
 *    answered or a human renamed the run — the same guard
 *    `applyGeneratedTitle()`'s UPDATE uses, so the two cannot come to disagree
 *    about what "still nameless" means.
 *  - **nothing was ever asked** (`title_attempts` 0). An agent run is called by
 *    its agent, a run started with a typed title keeps it, and a run made while
 *    the title LLM was off was a deliberate state — none of those is a failure
 *    to repair, and retitling them would be this pass rewriting history it was
 *    never part of.
 *  - **the budget is spent.** A provider that is really down must cost a
 *    handful of calls per run, not one every thirty seconds for its whole life.
 *  - **an archived run.** It was put away; its name is what the operator last
 *    saw it under.
 */
export function titleRetryDue(run, max = TITLE_ATTEMPTS_MAX) {
  if (!run || run.agent_id || run.archived_at) return false
  const attempts = Number(run.title_attempts ?? 0)
  if (!(attempts > 0 && attempts < max)) return false
  const title = String(run.title ?? '')
  return !!title && title === fallbackTitle(run.prompt)
}

/**
 * Ask again for the titles that never arrived — one watcher pass, no state of
 * its own.
 *
 * The generated title was a single call on the launch path, and everything
 * about it was fail-soft except the one part that mattered: a failure was
 * final. A timeout under load, a rate limit, a hub restarted in those two
 * seconds — and the run kept its prompt's first line for good, with nothing
 * anywhere saying why. Measured on this installation 2026-09-09: two single
 * runs started six minutes apart, one titled and one not, same process, same
 * key, same model, and the model answered both of those prompts correctly when
 * asked by hand afterwards.
 *
 * `titleRetryDue()` above is the rule; the SQL only NARROWS — the window is
 * what keeps this a repair of the recent past rather than a mass-retitling of
 * the archive, and the per-pass cap keeps a broken provider from costing three
 * calls a second.
 *
 * Fire-and-forget per run: a title holds a watcher pass up no more than it
 * holds a start up. The attempt counter is written before the question, so the
 * next pass cannot pick up a run this one is still asking about.
 */
export function retryMissingTitles() {
  if (!titleLlmActive()) return 0
  // The window is what keeps this a repair of the recent past: without it the
  // first pass after a deploy would walk every untitled run in the archive.
  const rows = db.prepare(`
    SELECT id, prompt, title, title_attempts, agent_id, archived_at FROM runs
     WHERE agent_id IS NULL AND archived_at IS NULL
       AND title_attempts > 0 AND title_attempts < ?
       AND started_at > datetime('now', ?)
     ORDER BY started_at DESC LIMIT 20
  `).all(TITLE_ATTEMPTS_MAX, `-${RETRY_WINDOW_MIN} minutes`)
  let started = 0
  for (const row of rows) {
    if (started >= RETRY_PER_PASS) break
    if (!titleRetryDue(row)) continue
    started++
    applyGeneratedTitle(row.id, row.prompt).catch(() => {})
  }
  return started
}

/**
 * What a run is called on screen. The stored title first, then the agent's name
 * (an agent run needs no own title), and only then the generic word — so a row
 * is never nameless.
 */
export function runTitle(run, agentName = null, fallback = '') {
  return (run?.title ?? '').trim() || (agentName ?? '').trim() || fallback
}
