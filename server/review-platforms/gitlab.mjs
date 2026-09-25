// Freilauf — review platform plugin: GitLab (API v4; self-managed via base_url).
//
// Import discipline (docs/plugins.md): a built-in plugin file imports nothing
// of the hub's. The token and the API base arrive through `ctx.setting()`.

const ID = 'gitlab'
const DEFAULT_BASE = 'https://gitlab.com/api/v4'

/** The path part of any git remote form (https, ssh://, scp-like), without `.git`. */
function remotePath(url) {
  const s = String(url ?? '').trim()
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.+)$/i.exec(s) ?? /^(?:[^@\s/]+@)?[^:\s/]+:(?!\/)(.+)$/.exec(s)
  if (!m) return null
  return m[1].replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\.git$/, '').replace(/^\/+/, '') || null
}

/** The full project path — GitLab keeps subgroups (`group/sub/app`). */
function parseRemote(url) {
  const path = remotePath(url)
  return path && path.includes('/') ? path : null
}

function projectPath(project) {
  const p = String(project ?? '').trim()
  if (!p.includes('/')) throw new Error(`${ID}: project must be "group/project", got ${JSON.stringify(project)}`)
  return `/projects/${encodeURIComponent(p)}`
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
        'private-token': token,
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    })
  } catch (err) {
    throw new Error(`${ID}: ${base} is not reachable (${err.message})`)
  }
  if (!res.ok) {
    const detail = await res.json().then(j => {
      const msg = j?.message ?? j?.error
      return msg ? ` (${(typeof msg === 'string' ? msg : JSON.stringify(msg)).slice(0, 200)})` : ''
    }, () => '')
    throw new Error(`${ID}: HTTP ${res.status} on ${method} ${path.split('?')[0]}${HINTS[res.status] ?? ''}${detail}`)
  }
  return res.status === 204 ? null : res.json()
}

export default {
  id: ID,
  kind: 'review',
  label: 'GitLab',
  descriptionKey: 'review_platform.gitlab.description',
  settings: [
    { key: 'token', type: 'password', required: true, labelKey: 'review_platform.token', hintKey: 'review_platform.gitlab.token_hint' },
    { key: 'base_url', type: 'text', default: DEFAULT_BASE, labelKey: 'review_platform.base_url', hintKey: 'review_platform.gitlab.base_url_hint' },
  ],

  parseRemote,

  async open(ctx, { project, head, base, title, body }) {
    const prefix = projectPath(project)
    const q = new URLSearchParams({ state: 'opened', source_branch: head, target_branch: base, per_page: '100' })
    const existing = (await call(ctx, 'GET', `${prefix}/merge_requests?${q}`)) ?? []
    const hit = existing.find(mr => mr?.source_branch === head && mr?.target_branch === base) ?? null
    const mr = hit ?? await call(ctx, 'POST', `${prefix}/merge_requests`,
      { source_branch: head, target_branch: base, title, description: body ?? '' })
    return { id: String(mr.iid), url: mr.web_url }
  },

  async status(ctx, { project, id }) {
    const prefix = `${projectPath(project)}/merge_requests/${encodeURIComponent(id)}`
    const [mr, approvals] = await Promise.all([
      call(ctx, 'GET', prefix),
      call(ctx, 'GET', `${prefix}/approvals`),
    ])
    const merged = mr.state === 'merged'
    // With no approval rule (`approvals_required: 0`, GitLab Free) `approved` is
    // true from the start; only a real approver means approved then.
    const by = Array.isArray(approvals?.approved_by) ? approvals.approved_by : []
    const ruled = !(typeof approvals?.approvals_required === 'number' && approvals.approvals_required === 0)
    return {
      state: merged ? 'merged' : mr.state === 'closed' ? 'closed' : 'open',
      approved: by.length > 0 || (ruled && approvals?.approved === true),
      changesRequested: mr.detailed_merge_status === 'requested_changes',
      mergeSha: merged ? (mr.merge_commit_sha || mr.squash_commit_sha || mr.sha || null) : null,
      url: mr.web_url,
    }
  },

  async comments(ctx, { project, id }) {
    const q = new URLSearchParams({ sort: 'asc', order_by: 'created_at', per_page: '100' })
    const notes = (await call(ctx, 'GET', `${projectPath(project)}/merge_requests/${encodeURIComponent(id)}/notes?${q}`)) ?? []
    return notes.filter(n => !n.system).map(n => ({
      author: n.author?.username ?? '',
      body: n.body ?? '',
      path: n.position?.new_path ?? n.position?.old_path ?? null,
      line: n.position?.new_line ?? n.position?.old_line ?? null,
      at: n.created_at ?? null,
    })).sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')))
  },

  async note(ctx, { project, id, body }) {
    await call(ctx, 'POST', `${projectPath(project)}/merge_requests/${encodeURIComponent(id)}/notes`, { body })
    return { ok: true }
  },
}
