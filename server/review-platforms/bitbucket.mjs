// Freilauf — review platform plugin: Bitbucket Cloud (API 2.0).
//
// Auth: the token as a Bearer (repository/workspace access token), or — when a
// username is set — Basic auth with the token as that user's app password.
// Import discipline (docs/plugins.md): nothing of the hub's is imported.

const ID = 'bitbucket'
const DEFAULT_BASE = 'https://api.bitbucket.org/2.0'

/** The path part of any git remote form (https, ssh://, scp-like), without `.git`. */
function remotePath(url) {
  const s = String(url ?? '').trim()
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.+)$/i.exec(s) ?? /^(?:[^@\s/]+@)?[^:\s/]+:(?!\/)(.+)$/.exec(s)
  if (!m) return null
  return m[1].replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\.git$/, '').replace(/^\/+/, '') || null
}

/** `workspace/repo_slug` of a remote: the last two path segments. */
function parseRemote(url) {
  const segs = (remotePath(url) ?? '').split('/').filter(Boolean)
  return segs.length >= 2 ? segs.slice(-2).join('/') : null
}

function repoPath(project) {
  const [ws, slug] = String(project ?? '').split('/')
  if (!ws || !slug) throw new Error(`${ID}: project must be "workspace/repo", got ${JSON.stringify(project)}`)
  return `/repositories/${encodeURIComponent(ws)}/${encodeURIComponent(slug)}`
}

const HINTS = { 401: ' — check the token (and the username for an app password)', 403: ' — the token lacks permission', 404: ' — not found, or the token cannot see it' }

async function call(ctx, method, path, body) {
  const token = String(ctx?.setting?.('token') ?? '').trim()
  if (!token) throw new Error(`${ID}: no token configured`)
  const user = String(ctx?.setting?.('username') ?? '').trim()
  const base = String(ctx?.setting?.('base_url') ?? '').trim().replace(/\/+$/, '') || DEFAULT_BASE
  const authorization = user
    ? `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`
    : `Bearer ${token}`
  let res
  try {
    res = await fetch(base + path, {
      method,
      headers: { authorization, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    })
  } catch (err) {
    throw new Error(`${ID}: ${base} is not reachable (${err.message})`)
  }
  if (!res.ok) {
    const detail = await res.json().then(j => j?.error?.message ? ` (${String(j.error.message).slice(0, 200)})` : '', () => '')
    throw new Error(`${ID}: HTTP ${res.status} on ${method} ${path.split('?')[0]}${HINTS[res.status] ?? ''}${detail}`)
  }
  return res.status === 204 ? null : res.json()
}

const STATES = { OPEN: 'open', MERGED: 'merged', DECLINED: 'closed', SUPERSEDED: 'closed' }

export default {
  id: ID,
  kind: 'review',
  label: 'Bitbucket Cloud',
  descriptionKey: 'review_platform.bitbucket.description',
  settings: [
    { key: 'token', type: 'password', required: true, labelKey: 'review_platform.token', hintKey: 'review_platform.bitbucket.token_hint' },
    { key: 'username', type: 'text', default: '', labelKey: 'review_platform.bitbucket.username', hintKey: 'review_platform.bitbucket.username_hint' },
    { key: 'base_url', type: 'text', default: DEFAULT_BASE, labelKey: 'review_platform.base_url', hintKey: 'review_platform.bitbucket.base_url_hint' },
  ],

  parseRemote,

  async open(ctx, { project, head, base, title, body }) {
    const prefix = repoPath(project)
    const q = new URLSearchParams({
      state: 'OPEN', pagelen: '50',
      q: `source.branch.name="${head}" AND destination.branch.name="${base}"`,
    })
    const page = await call(ctx, 'GET', `${prefix}/pullrequests?${q}`)
    const hit = (page?.values ?? []).find(p =>
      p?.source?.branch?.name === head && p?.destination?.branch?.name === base) ?? null
    const pr = hit ?? await call(ctx, 'POST', `${prefix}/pullrequests`, {
      title, description: body ?? '',
      source: { branch: { name: head } },
      destination: { branch: { name: base } },
    })
    return { id: String(pr.id), url: pr.links?.html?.href ?? '' }
  },

  async status(ctx, { project, id }) {
    const pr = await call(ctx, 'GET', `${repoPath(project)}/pullrequests/${encodeURIComponent(id)}`)
    const people = Array.isArray(pr.participants) ? pr.participants : []
    const changesRequested = people.some(p => p?.state === 'changes_requested')
    const state = STATES[pr.state] ?? 'open'
    return {
      state,
      approved: people.some(p => p?.approved === true || p?.state === 'approved') && !changesRequested,
      changesRequested,
      mergeSha: state === 'merged' ? (pr.merge_commit?.hash ?? null) : null,
      url: pr.links?.html?.href ?? '',
    }
  },

  async comments(ctx, { project, id }) {
    const page = await call(ctx, 'GET', `${repoPath(project)}/pullrequests/${encodeURIComponent(id)}/comments?pagelen=100`)
    return (page?.values ?? []).filter(c => !c.deleted).map(c => ({
      author: c.user?.nickname ?? c.user?.display_name ?? '',
      body: c.content?.raw ?? '',
      path: c.inline?.path ?? null,
      line: c.inline?.to ?? c.inline?.from ?? null,
      at: c.created_on ?? null,
    })).sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')))
  },

  async note(ctx, { project, id, body }) {
    await call(ctx, 'POST', `${repoPath(project)}/pullrequests/${encodeURIComponent(id)}/comments`, { content: { raw: body } })
    return { ok: true }
  },
}
