// cc-hub — find worktree extras for a repo via an LLM (Settings → Worktree extras).
//
// The repo form's "find worktree extras" button asks this endpoint. It is a
// SINGLE structured call, not an agent: no tmux session, no worktree, no flows —
// the question "what should a worktree also carry?" is answered by a model at
// OpenRouter, the same channel the title LLM and the check LLM use.
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

export const DEFAULT_EXTRAS_MODEL = 'deepseek/deepseek-v4-flash'
const MRU_KEY = 'llm_extras_models_mru'
/** How many suggestions may come back — more is noise, not help. */
export const MAX_EXTRAS = 10

export function extrasModel() {
  return (getSetting('llm_extras_model') ?? '').trim() || DEFAULT_EXTRAS_MODEL
}

/** On unless switched off, like the title LLM: a model is preset, the key is the gate. */
export function extrasLlmActive() {
  return (getSetting('llm_extras_on') ?? '1') === '1' && !!process.env.OPENROUTER_API_KEY
}

export function extrasModelsMru() { return mruList(MRU_KEY) }
export function rememberExtrasModel(model) { mruRemember(MRU_KEY, model) }

const SCHEMA = {
  name: 'worktree_extras',
  strict: true,
  schema: {
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
 * entries it confirms against the real directory come back. Returns
 * `{ ok: true, extras, model }` or `{ ok: false, error }` (already translated).
 */
export async function suggestExtras(path, { timeoutMs = 60_000 } = {}) {
  const p = String(path ?? '').trim().replace(/^~/, process.env.HOME ?? '')
  if (!p) return { ok: false, error: t('repos.path_missing') }
  if (!existsSync(p)) return { ok: false, error: t('repos.extras_no_dir', { path: p }) }
  if (!existsSync(join(p, '.git'))) return { ok: false, error: t('repos.no_git', { path: p }) }
  if (!extrasLlmActive()) return { ok: false, error: t('repos.extras_llm_off') }

  const ctx = await gatherContext(p)
  const model = extrasModel()
  const body = {
    model,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: buildPrompt(ctx) },
    ],
    response_format: { type: 'json_schema', json_schema: SCHEMA },
    temperature: 0,
    max_tokens: 1000,
  }
  const orProvider = (getSetting('llm_extras_or_provider') ?? '').trim()
  if (orProvider) body.provider = { order: [orProvider], allow_fallbacks: false }
  const base = process.env.CCHUB_OPENROUTER_BASE ?? 'https://openrouter.ai/api/v1/chat/completions'

  let roh
  try {
    const res = await fetch(base, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'content-type': 'application/json',
        'HTTP-Referer': 'https://github.com/hwalde/cc-hub',
        'X-Title': 'cc-hub worktree extras',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return { ok: false, error: t('repos.extras_http', { code: res.status }) }
    roh = (await res.json())?.choices?.[0]?.message?.content
  } catch (e) {
    return { ok: false, error: t('repos.extras_net', { err: e.message }) }
  }

  let parsed
  try { parsed = JSON.parse(typeof roh === 'string' ? roh : JSON.stringify(roh)) } catch {
    return { ok: false, error: t('repos.extras_parse') }
  }
  const extras = normalizeExtras(parsed, ctx)
  if (!extras.length) return { ok: false, error: t('repos.extras_none') }
  return { ok: true, extras, model }
}
