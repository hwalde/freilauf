// cc-hub — find worktree extras for a repo via an LLM (Settings → Worktree extras).
//
// The repo form's "find worktree extras" button asks this endpoint. It is a
// SINGLE structured call, not an agent: no tmux session, no worktree, no flows —
// the question "what should a worktree also carry?" is answered by a model, on
// the same channel the title LLM and the check LLM use (`llm_extras_source`,
// unset = `provider:openrouter`).
//
// Everything that can be decided without a model is decided without one:
//   1. algorithmically: the path exists and is a git project,
//   2. collect the repo's untracked/ignored top-level entries + .gitignore,
//   3. ask which of those a worktree should also have, and how — "copy" for small
//      files (a .env), "link" for large or shared directories (node_modules,
//      reference material),
//   4. validate the answer against the real directory (never trust the model).
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { getSetting, mruList, mruRemember } from './db.mjs'
import { sh } from './util.mjs'
import { t } from './i18n.mjs'
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


export const DEFAULT_EXTRAS_MODEL = 'deepseek/deepseek-v4-flash'
const MRU_KEY = 'llm_extras_models_mru'
/** How many suggestions may come back — more is noise, not help. */
export const MAX_EXTRAS = 10

export function extrasModel() {
  return (getSetting('llm_extras_model') ?? '').trim() || DEFAULT_EXTRAS_MODEL
}

/** Which source answers this question. Unset = OpenRouter, as it always was. */
export function extrasSource() {
  return (getSetting('llm_extras_source') ?? '').trim() || defaultSource()
}

/**
 * On unless switched off, like the title LLM: a model is preset, and the
 * source's credential is the gate — for the default source that is exactly the
 * OpenRouter key this used to read out of the environment.
 */
export function extrasLlmActive() {
  if ((getSetting('llm_extras_on') ?? '1') !== '1') return false
  const src = getSource(extrasSource())
  return !!src && missingCredential(src.pluginId, src.plugin) === null
}

export function extrasModelsMru() { return mruList(MRU_KEY) }
export function rememberExtrasModel(model) { mruRemember(MRU_KEY, model) }

const SCHEMA_NAME = 'worktree_extras'
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['extras'],
  properties: {
    extras: {
      type: 'array',
      description: 'the untracked/ignored top-level entries a worktree should also have',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'mode'],
        properties: {
          path: { type: 'string', description: 'the exact top-level entry name from the listing' },
          mode: { type: 'string', enum: ['copy', 'link'] },
        },
      },
    },
  },
}

const SYSTEM = `You help a dashboard that runs coding agents in git worktrees.
A worktree only contains the files git tracks. "Worktree extras" are files or
directories the worktree should ALSO have, copied or symlinked in from the main
checkout, because the agent needs them but git does not carry them — a .env with
local settings, a linked node_modules, a reference directory.

Which of the UNTRACKED or IGNORED top-level entries should a worktree also have?
For each pick a mode:
- "copy" — the entry is copied in (small files, configs, a .env)
- "link" — a symlink is created (large directories: node_modules, reference material)

Only pick entries listed above that are NOT tracked by git. Never invent paths.
A short, useful list is better than a long one; an empty list is fine.
Answer exclusively in the given JSON schema.`

/** What the model may see — capped, because this is a one-shot glance, not a tree walk. */
async function gatherContext(p) {
  const entries = readdirSync(p, { withFileTypes: true })
    .filter(d => d.name !== '.git')
    .map(d => ({ name: d.name, dir: d.isDirectory() }))
    .slice(0, 60)
  const tracked = new Set()
  const ls = await sh('git', ['-C', p, 'ls-files'])
  if (ls.ok) {
    for (const f of ls.stdout.split('\n')) {
      const seg = f.split('/')[0]
      if (seg) tracked.add(seg)
    }
  }
  const ignored = new Set()
  for (const e of entries) {
    const ig = await sh('git', ['-C', p, 'check-ignore', '-q', '--', e.name])
    if (ig.ok) ignored.add(e.name)
  }
  let gitignore = ''
  try { gitignore = readFileSync(join(p, '.gitignore'), 'utf8').slice(0, 1500) } catch {}
  let project = ''
  try { project = JSON.parse(readFileSync(join(p, 'package.json'), 'utf8')).name ?? '' } catch {}
  return { name: basename(p), project, entries, tracked, ignored, gitignore }
}

/** The listing the model decides on: every top-level entry with type and git status. */
function buildPrompt(ctx) {
  const lines = ctx.entries.map(e => {
    const status = ctx.tracked.has(e.name) ? 'tracked'
      : ctx.ignored.has(e.name) ? 'ignored' : 'untracked'
    return `- ${e.name} [${e.dir ? 'dir' : 'file'}, ${status}]`
  })
  return `Repository: ${ctx.name}${ctx.project ? ` (project: ${ctx.project})` : ''}
Top-level entries:
${lines.join('\n') || '(none)'}

.gitignore:
${ctx.gitignore || '(none)'}`
}

/**
 * Turn the model's answer into the extras the form accepts, and nothing else:
 * each path must be a real, non-tracked top-level entry; mode is copy|link; a
 * directory gets the trailing slash the existing format uses; deduped and capped.
 */
export function normalizeExtras(parsed, ctx) {
  const allowed = new Map(ctx.entries
    .filter(e => !ctx.tracked.has(e.name))
    .map(e => [e.name, e.dir]))
  const list = Array.isArray(parsed) ? parsed : parsed?.extras
  if (!Array.isArray(list)) return []
  const out = []
  const gesehen = new Set()
  for (const x of list.slice(0, 50)) {
    const path = String(x?.path ?? '').trim().replace(/\/+$/, '')
    const mode = x?.mode === 'link' ? 'link' : x?.mode === 'copy' ? 'copy' : null
    if (!path || !mode || !allowed.has(path)) continue
    if (gesehen.has(path)) continue
    gesehen.add(path)
    out.push({ path: allowed.get(path) ? `${path}/` : path, mode })
    if (out.length >= MAX_EXTRAS) break
  }
  return out
}

/**
 * Algorithmic checks first, then the model — and only the untracked/ignored
 * entries it confirms against the real directory come back. An empty list is a
 * valid answer, not an error: the form then gets `[]` like any other result.
 * Returns `{ ok: true, extras, model }` or `{ ok: false, error }` (already
 * translated).
 */
export async function suggestExtras(path, { timeoutMs = 60_000 } = {}) {
  const p = String(path ?? '').trim().replace(/^~/, process.env.HOME ?? '')
  if (!p) return { ok: false, error: t('repos.path_missing') }
  if (!existsSync(p)) return { ok: false, error: t('repos.extras_no_dir', { path: p }) }
  if (!existsSync(join(p, '.git'))) return { ok: false, error: t('repos.no_git', { path: p }) }
  if (!extrasLlmActive()) return { ok: false, error: t('repos.extras_llm_off') }

  const ctx = await gatherContext(p)
  const model = extrasModel()
  const r = await llmJson({
    source: extrasSource(),
    model,
    system: SYSTEM,
    prompt: buildPrompt(ctx),
    schema: SCHEMA,
    schemaName: SCHEMA_NAME,
    purpose: 'extras',
    servingProvider: (getSetting('llm_extras_or_provider') ?? '').trim() || null,
    orRouting: orRoutingAusSetting('llm_extras_or_routing'),
    maxTokens: 1000,
    temperature: 0,
    timeoutMs,
  })
  // The error stays TRANSLATED, and stays split by stage: the form shows the
  // operator a sentence in their own language, and which sentence it is says
  // whether the vendor was unreachable or answered with something unusable.
  // (`CCHUB_OPENROUTER_BASE` still works: it is the OpenRouter plugin that
  //  reads it now, so the stub the unit suite points this call at is reached
  //  through the adapter instead of through a fetch written out here.)
  if (!r.ok) {
    if (r.stage === 'parse' || r.stage === 'validate') return { ok: false, error: t('repos.extras_parse') }
    const detail = String(r.error)
    const http = /HTTP (\d{3})/.exec(detail)
    if (http) return { ok: false, error: t('repos.extras_http', { code: http[1] }) }
    return { ok: false, error: t('repos.extras_net', { err: detail }) }
  }
  // The model is still not trusted: `normalizeExtras` measures every path
  // against the real directory. The schema says the shape is right, never that
  // the paths exist.
  const extras = normalizeExtras(r.data, ctx)
  return { ok: true, extras, model }
}
