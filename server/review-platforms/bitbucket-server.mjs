// Freilauf — review platform plugin: Bitbucket Data Center / Server (REST 1.0).
//
// There is no public instance, so `base_url` (the server root, e.g.
// https://bitbucket.example.com) is required. Auth: an HTTP access token as Bearer.
// Import discipline (docs/plugins.md): nothing of the hub's is imported.

const ID = 'bitbucket-server'

/** The path part of any git remote form (https, ssh://, scp-like), without `.git`. */
function remotePath(url) {
  const s = String(url ?? '').trim()
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.+)$/i.exec(s) ?? /^(?:[^@\s/]+@)?[^:\s/]+:(?!\/)(.+)$/.exec(s)
  if (!m) return null
  return m[1].replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\.git$/, '').replace(/^\/+/, '') || null
}

/**
 * `PROJECTKEY/repo_slug`: ssh clones are `/<key>/<slug>.git`, https clones
 * `/scm/<key>/<slug>.git` (behind an optional context path). The key is upper case.
 */
function parseRemote(url) {
  let segs = (remotePath(url) ?? '').split('/').filter(Boolean)
  const scm = segs.lastIndexOf('scm')
  if (scm >= 0) segs = segs.slice(scm + 1)
  if (segs.length < 2) return null
  const [key, slug] = segs.slice(-2)
  return `${key.toUpperCase()}/${slug}`
}

function repoPath(project) {
  const [key, slug] = String(project ?? '').split('/')
  if (!key || !slug) throw new Error(`${ID}: project must be "PROJECTKEY/repo", got ${JSON.stringify(project)}`)
  return { key, slug, prefix: `/projects/${encodeURIComponent(key)}/repos/${encodeURIComponent(slug)}` }
}

const HINTS = { 401: ' — check the token', 403: ' — the token lacks permission', 404: ' — not found, or the token cannot see it' }

async function call(ctx, method, path, body) {
  const token = String(ctx?.setting?.('token') ?? '').trim()
  if (!token) throw new Error(`${ID}: no token configured`)
  const root = String(ctx?.setting?.('base_url') ?? '').trim().replace(/\/+$/, '')
  if (!root) throw new Error(`${ID}: no base URL configured — set the server address`)
  const base = /\/rest\/api\/1\.0$/.test(root) ? root : `${root}/rest/api/1.0`
  let res
  try {
    res = await fetch(base + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    })
  } catch (err) {
    throw new Error(`${ID}: ${root} is not reachable (${err.message})`)
  }
  if (!res.ok) {
    const detail = await res.json().then(j => j?.errors?.[0]?.message ? ` (${String(j.errors[0].message).slice(0, 200)})` : '', () => '')
    throw new Error(`${ID}: HTTP ${res.status} on ${method} ${path.split('?')[0]}${HINTS[res.status] ?? ''}${detail}`)
  }
  return res.status === 204 ? null : res.json()
}

/** Every comment of an activity, replies included (they nest under `comments`). */
function flatten(comment, anchor, out) {
  if (!comment) return
  out.push({
    author: comment.author?.name ?? comment.author?.displayName ?? '',
    body: comment.text ?? '',
    path: anchor?.path ?? null,
    line: anchor?.line ?? null,
    at: typeof comment.createdDate === 'number' ? new Date(comment.createdDate).toISOString() : null,
  })
  for (const reply of comment.comments ?? []) flatten(reply, anchor, out)
}

export default {
  id: ID,
  kind: 'review',
  label: 'Bitbucket Data Center',
  descriptionKey: 'review_platform.bitbucket_server.description',
  settings: [
    { key: 'token', type: 'password', required: true, labelKey: 'review_platform.token', hintKey: 'review_platform.bitbucket_server.token_hint' },
    { key: 'base_url', type: 'text', required: true, default: '', labelKey: 'review_platform.base_url', hintKey: 'review_platform.bitbucket_server.base_url_hint' },
  ],

  parseRemote,

  async open(ctx, { project, head, base, title, body }) {
    const { key, slug, prefix } = repoPath(project)
    const from = `refs/heads/${head}`, to = `refs/heads/${base}`
    const q = new URLSearchParams({ state: 'OPEN', direction: 'OUTGOING', at: from, limit: '100' })
    const page = await call(ctx, 'GET', `${prefix}/pull-requests?${q}`)
    const hit = (page?.values ?? []).find(p => p?.fromRef?.id === from && p?.toRef?.id === to) ?? null
    const repository = { slug, project: { key } }
    const pr = hit ?? await call(ctx, 'POST', `${prefix}/pull-requests`, {
      title, description: body ?? '',
      fromRef: { id: from, repository },
      toRef: { id: to, repository },
    })
    return { id: String(pr.id), url: pr.links?.self?.[0]?.href ?? '' }
  },

  async status(ctx, { project, id }) {
    const pr = await call(ctx, 'GET', `${repoPath(project).prefix}/pull-requests/${encodeURIComponent(id)}`)
    const reviewers = Array.isArray(pr.reviewers) ? pr.reviewers : []
    const changesRequested = reviewers.some(r => r?.status === 'NEEDS_WORK')
    const state = pr.state === 'MERGED' ? 'merged' : pr.state === 'DECLINED' ? 'closed' : 'open'
    return {
      state,
      approved: reviewers.some(r => r?.status === 'APPROVED') && !changesRequested,
      changesRequested,
      mergeSha: state === 'merged' ? (pr.properties?.mergeCommit?.id ?? null) : null,
      url: pr.links?.self?.[0]?.href ?? '',
    }
  },

  async comments(ctx, { project, id }) {
    const page = await call(ctx, 'GET', `${repoPath(project).prefix}/pull-requests/${encodeURIComponent(id)}/activities?limit=100`)
    const out = []
    for (const a of page?.values ?? []) {
      if (a?.action === 'COMMENTED') flatten(a.comment, a.commentAnchor, out)
    }
    return out.sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')))
  },

  async note(ctx, { project, id, body }) {
    await call(ctx, 'POST', `${repoPath(project).prefix}/pull-requests/${encodeURIComponent(id)}/comments`, { text: body })
    return { ok: true }
  },
}
