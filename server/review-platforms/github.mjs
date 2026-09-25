// Freilauf — review platform plugin: GitHub (REST v3; GitHub Enterprise via base_url).
//
// Import discipline (docs/plugins.md): a built-in plugin file imports nothing
// of the hub's. The token and the API base arrive through `ctx.setting()`.

const ID = 'github'
const DEFAULT_BASE = 'https://api.github.com'

/** The path part of any git remote form (https, ssh://, scp-like), without `.git`. */
function remotePath(url) {
  const s = String(url ?? '').trim()
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.+)$/i.exec(s) ?? /^(?:[^@\s/]+@)?[^:\s/]+:(?!\/)(.+)$/.exec(s)
  if (!m) return null
  return m[1].replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\.git$/, '').replace(/^\/+/, '') || null
}

/** `owner/repo` of a remote: the last two path segments. */
function parseRemote(url) {
  const segs = (remotePath(url) ?? '').split('/').filter(Boolean)
  return segs.length >= 2 ? segs.slice(-2).join('/') : null
}

function repoPath(project) {
  const [owner, repo] = String(project ?? '').split('/')
  if (!owner || !repo) throw new Error(`${ID}: project must be "owner/repo", got ${JSON.stringify(project)}`)
  return { owner, prefix: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` }
}

const HINTS = { 401: ' — check the token', 403: ' — the token lacks permission', 404: ' — not found, or the token cannot see it' }

async function call(ctx, method, path, body) {
  const token = String(ctx?.setting?.('token') ?? '').trim()
  if (!token) throw new Error(`${ID}: no token configured`)
  const base = String(ctx?.setting?.('base_url') ?? '').trim().replace(/\/+$/, '') || DEFAULT_BASE
  let res
  try {
    res = await fetch(base + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'freilauf',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    })
  } catch (err) {
    throw new Error(`${ID}: ${base} is not reachable (${err.message})`)
  }
  if (!res.ok) {
    const detail = await res.json().then(j => j?.message ? ` (${String(j.message).slice(0, 200)})` : '', () => '')
    throw new Error(`${ID}: HTTP ${res.status} on ${method} ${path.split('?')[0]}${HINTS[res.status] ?? ''}${detail}`)
  }
  return res.status === 204 ? null : res.json()
}

export default {
  id: ID,
  kind: 'review',
  label: 'GitHub',
  descriptionKey: 'review_platform.github.description',
  settings: [
    { key: 'token', type: 'password', required: true, labelKey: 'review_platform.token', hintKey: 'review_platform.github.token_hint' },
    { key: 'base_url', type: 'text', default: DEFAULT_BASE, labelKey: 'review_platform.base_url', hintKey: 'review_platform.github.base_url_hint' },
  ],

  parseRemote,

  async open(ctx, { project, head, base, title, body }) {
    const { owner, prefix } = repoPath(project)
    const q = new URLSearchParams({ head: `${owner}:${head}`, base, state: 'open', per_page: '100' })
    const existing = (await call(ctx, 'GET', `${prefix}/pulls?${q}`)) ?? []
    const hit = existing.find(p => p?.head?.ref === head && p?.base?.ref === base) ?? null
    const pr = hit ?? await call(ctx, 'POST', `${prefix}/pulls`, { title, head, base, body: body ?? '' })
    return { id: String(pr.number), url: pr.html_url }
  },

  async status(ctx, { project, id }) {
    const { prefix } = repoPath(project)
    const pr = await call(ctx, 'GET', `${prefix}/pulls/${encodeURIComponent(id)}`)
    const reviews = (await call(ctx, 'GET', `${prefix}/pulls/${encodeURIComponent(id)}/reviews?per_page=100`)) ?? []
    // The latest deciding review per reviewer: a COMMENTED review decides nothing.
    const latest = new Map()
    for (const r of reviews) {
      if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r?.state)) latest.set(r.user?.login ?? '?', r)
    }
    const states = [...latest.values()].map(r => r.state)
    const changesRequested = states.includes('CHANGES_REQUESTED')
    // A change request stays in force until its author approves or dismisses
    // it; its time is what lets the hub tell an old request from a new one.
    const changesRequestedAt = [...latest.values()].filter(r => r.state === 'CHANGES_REQUESTED')
      .map(r => r.submitted_at ?? '').sort().pop() || null
    const merged = !!pr.merged || !!pr.merged_at
    return {
      state: merged ? 'merged' : pr.state === 'closed' ? 'closed' : 'open',
      approved: states.includes('APPROVED') && !changesRequested,
      changesRequested,
      changesRequestedAt,
      mergeSha: merged ? (pr.merge_commit_sha ?? null) : null,
      url: pr.html_url,
    }
  },

  async comments(ctx, { project, id }) {
    const { prefix } = repoPath(project)
    const n = encodeURIComponent(id)
    const [general, inline, reviews] = await Promise.all([
      call(ctx, 'GET', `${prefix}/issues/${n}/comments?per_page=100`),
      call(ctx, 'GET', `${prefix}/pulls/${n}/comments?per_page=100`),
      call(ctx, 'GET', `${prefix}/pulls/${n}/reviews?per_page=100`),
    ])
    const out = [
      ...(general ?? []).map(c => ({ author: c.user?.login ?? '', body: c.body ?? '', path: null, line: null, at: c.created_at ?? null })),
      ...(inline ?? []).map(c => ({ author: c.user?.login ?? '', body: c.body ?? '', path: c.path ?? null, line: c.line ?? c.original_line ?? null, at: c.created_at ?? null })),
      ...(reviews ?? []).filter(r => String(r.body ?? '').trim())
        .map(r => ({ author: r.user?.login ?? '', body: r.body, path: null, line: null, at: r.submitted_at ?? null })),
    ]
    return out.sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')))
  },

  async note(ctx, { project, id, body }) {
    const { prefix } = repoPath(project)
    await call(ctx, 'POST', `${prefix}/issues/${encodeURIComponent(id)}/comments`, { body })
    return { ok: true }
  },
}
