// Freilauf — code review: a run's work reaches the base branch only after a
// human approved it.
//
// Optional, like the sandbox, and it only exists where the hub integrates
// (`repos.merge_mode='hub'`). Whether a run is reviewed is decided on three
// levels — Settings → Code review (global), the repo, the agent / single run — and
// frozen into `runs.review_platform` at launch, so the prompt the agent reads
// and what happens at its end cannot disagree.
//
// The finish gate is the same one every hub-integrated run goes through (clean
// worktree, branch mergeable). Where it would enqueue the merge, a reviewed run
// is SUBMITTED instead: its branch is pushed and a review is opened —
//
//   internal   on this hub: the run's detail page shows the diff and three
//              buttons (approve & merge, request changes, reject); the hub's
//              own integrator merges exactly the approved commit.
//   a plugin   (kind 'review': GitHub, GitLab, Bitbucket, …) opens a pull /
//              merge request. The platform owns approval and merge — its
//              branch protection, its approvers — and the hub polls it and
//              records what happened. The platform token stays in the hub
//              process; it never enters a run's session or container.
//
// Change requests travel back into the agent's session as a follow-up
// commission; the agent's next `fl-report done` passes the gate again and
// updates the same review.
import { join } from 'node:path'
import db, { getRepo, getRun, addEvent, getSetting } from './db.mjs'
import { sh, shortId, sendToSession, detailUrl, escapeHtml as e, RUNS_DIR, fmtDbUtc } from './util.mjs'
import { allPlugins, getPlugin, pluginKind } from './plugins/registry.mjs'
import { isPluginEnabled } from './plugins/store.mjs'
import { pluginCtx } from './plugins/context.mjs'
import { t } from './i18n.mjs'

export const REVIEW_TRISTATE = ['inherit', 'on', 'off']
export const INTERNAL = 'internal'
/** merge_status values of a run whose review is still open. */
export const REVIEW_OPEN = ['in_review', 'changes_requested']

/** How often an external review is asked for its state (ms). */
const POLL_MS = Number(process.env.FREILAUF_REVIEW_POLL_MS ?? 60_000) || 60_000

// ------------------------------------------------------------------ texts
//
// Agent-facing and notification texts are English constants, like M1…M5 in
// integrate.mjs — they are never translated.

export const M_REVIEW = `Freilauf: report received. Worktree clean, branch mergeable — your work is now in CODE REVIEW ({where}); it is merged into {base} only after a reviewer approved it. Nothing more to do; stay in this session: if the reviewer asks for changes, the request arrives here.`

export const M_CHANGES = `Freilauf code review — the reviewer asks for changes before your work can be merged into {base}:

{comments}

Address every point on your branch (fetch and merge origin/{base} first if it moved), commit, and run \`fl-report done --file {report_file}\` again with a short report of what you changed. Freilauf re-submits the branch to the same review. Do NOT merge into or push to {base} yourself.`

export const REVIEW_PLATFORM_RULE = 'Code review: your work is NOT merged directly. When you report done, Freilauf opens a code review; a reviewer approves it or sends change requests into this session.'

// ------------------------------------------------------------ configuration

/** The review platforms registered as plugins (kind 'review'), enabled ones only. */
export function reviewPlatforms() {
  return allPlugins().filter(p => p.kind === 'review' && isPluginEnabled(p.id))
    .map(p => ({ id: p.id, label: p.plugin.label ?? p.id }))
}

export function platformLabel(id) {
  if (!id || id === INTERNAL) return t('review.platform_internal')
  return getPlugin(id)?.label ?? id
}

const tri = (v) => (REVIEW_TRISTATE.includes(v) ? v : 'inherit')

/** Settings → Code review: is review on by default, and on which platform. */
export function globalReview() {
  return {
    on: getSetting('review_default') === 'on',
    platform: String(getSetting('review_platform') || '') || INTERNAL,
  }
}

/** The repo's effective answer: on/off and platform, the global value where it says 'inherit'. */
export function repoReview(repo) {
  const g = globalReview()
  const mode = tri(repo?.review_mode)
  return {
    on: mode === 'inherit' ? g.on : mode === 'on',
    platform: String(repo?.review_platform || '') || g.platform,
  }
}

/**
 * The platform a run is reviewed on, or 'none'. The one decision; launchRun()
 * freezes its answer into `runs.review_platform`.
 *
 * Review needs the hub's integration: with `merge_mode='off'` the hub does not
 * merge anything, so there is nothing to hold back. `keep_on_branch` wins over
 * review — nothing is merged there either.
 */
export function decideReview(run, repo) {
  if (repo?.merge_mode !== 'hub') return 'none'
  if (run?.keep_on_branch) return 'none'
  const want = tri(run?.review)
  const r = repoReview(repo)
  const on = want === 'inherit' ? r.on : want === 'on'
  return on ? r.platform : 'none'
}

/** The platform of a run that is reviewed, or null. Legacy rows (NULL) are not reviewed. */
export function reviewPlatformOf(run) {
  const p = run?.review_platform
  return p && p !== 'none' ? p : null
}

/** A review-platform plugin by id — only kind 'review', only enabled. */
function platformPlugin(id) {
  if (pluginKind(id) !== 'review' || !isPluginEnabled(id)) return null
  return getPlugin(id)
}

/**
 * The platform's project path for this repo: the repo's own setting, else what
 * the plugin reads out of `origin`'s URL.
 */
export async function reviewProject(repo, plugin) {
  const own = String(repo?.review_project ?? '').trim()
  if (own) return own
  const r = await sh('git', ['-C', repo.path, 'remote', 'get-url', 'origin'])
  if (!r.ok) return null
  try { return plugin?.parseRemote?.(r.stdout.trim()) ?? null } catch { return null }
}

// ---------------------------------------------------------------- submit

/**
 * Is this clean, mergeable run to be SUBMITTED instead of merged? Yes when it
 * is reviewed and the commit at hand is not the approved one — an approval
 * binds to one commit, and anything after it is reviewed again.
 */
export function wantsReview(run, tip) {
  if (!reviewPlatformOf(run)) return false
  return !run.review_approved_sha || run.review_approved_sha !== tip
}

function reviewBody(run) {
  const report = String(run.followup_md || run.report_md || '').trim()
  return `${report || '(no report)'}\n\n---\nFreilauf run ${run.id}\n${detailUrl(run.id)}`
}

/**
 * Push the branch and open (or update) the review. Called by the finish gate
 * where it would otherwise enqueue the merge. Returns what the gate returns:
 * `{ hold:false, mergeLine, message, review:true }` — the run closes like a kept
 * one — or `{ hold:true, message:null }` after an escalation.
 */
export async function submitForReview(run, repo, tip) {
  const { backupBranch, escalate } = await import('./integrate.mjs')
  const platform = reviewPlatformOf(run)
  const plugin = platform === INTERNAL ? null : platformPlugin(platform)
  const fail = async (reason) => {
    addEvent(run.id, 'merge_error', { reason })
    await escalate(run.id, 'merge_error')
    return { hold: true, message: null }
  }
  if (platform !== INTERNAL && !plugin) {
    return fail(`code review platform "${platform}" is not installed or not enabled (Plugins page)`)
  }
  const head = run.branch_reported || run.branch_expected || `run/${shortId(run.id)}`
  if (head === repo.base_branch) {
    return fail(`the run works on ${repo.base_branch} itself — a review needs a branch of its own`)
  }
  // Every review — internal ones too — reviews a branch that is on origin: the
  // reviewer's platform needs it, and an internal reviewer's approval must not
  // depend on this one disk.
  const ref = await backupBranch(run.id)
  if (!ref) return fail(`could not push branch ${head} to origin for the review`)

  let id = run.review_id
  let url = run.pr_url
  const update = !!run.review_sha
  if (platform === INTERNAL) {
    id = run.id
    url = `${detailUrl(run.id)}#review`
  } else {
    const ctx = pluginCtx(platform)
    const project = await reviewProject(repo, plugin)
    if (!project) return fail(`no ${plugin.label ?? platform} project for this repo — set it in the repo form`)
    try {
      const title = run.title ?? shortId(run.id)
      const opened = await plugin.open(ctx, { project, head: ref, base: repo.base_branch, title, body: reviewBody(run) })
      id = String(opened?.id ?? '')
      url = String(opened?.url ?? '')
      if (!id) throw new Error('the platform returned no review id')
      if (update && plugin.note) {
        await plugin.note(ctx, { project, id, body: `Freilauf: updated to ${String(tip).slice(0, 7)} after the requested changes.\n\n${String(run.followup_md ?? '').trim()}` })
          .catch(() => {})
      }
    } catch (err) {
      return fail(`${plugin.label ?? platform}: ${String(err?.message ?? err).slice(0, 500)}`)
    }
  }
  db.prepare(`UPDATE runs SET merge_status='in_review', review_sha=?, review_id=?, review_state='open',
              review_approved_sha=NULL, pr_url=?, finish_state=NULL WHERE id=?`)
    // pr_url is a PLATFORM's pull request; an internal review has the detail page.
    .run(tip, id, platform === INTERNAL ? (run.pr_url ?? null) : (url || null), run.id)
  addEvent(run.id, update ? 'review_updated' : 'review_opened', { platform, url, sha: tip, branch: ref })
  const where = platform === INTERNAL ? `internal review: ${url}` : `${plugin.label ?? platform}: ${url}`
  // A conflict run is the integrator's tool and its own notifications are
  // silenced (notifyRun), so the operator hears about ITS review through the
  // run it works for.
  if (run.resolves_run_id) {
    const { notifyRun } = await import('./reports.mjs')
    await notifyRun(run.resolves_run_id, 'review_resolver', `🔍 The conflict run for this run waits for code review (${where}).`, { dedupe: false })
  }
  return {
    hold: false, review: true,
    mergeLine: `In code review (${where})`,
    message: M_REVIEW.replace('{where}', where).replace('{base}', repo.base_branch),
  }
}

// ---------------------------------------------------------- the reviewer

function openReviewRun(runId) {
  const run = getRun(runId)
  if (!run) return { error: t('api.unknown_run') }
  if (!reviewPlatformOf(run) || !REVIEW_OPEN.includes(run.merge_status)) return { error: t('review.err_not_open') }
  const repo = getRepo(run.repo_id)
  if (!repo) return { error: t('api.unknown_repo') }
  return { run, repo }
}

/** "Approve & merge" (internal review): the approved commit goes to the integrator. */
export async function approveReview(runId, comment = '') {
  const { run, repo, error } = openReviewRun(runId)
  if (error) return { ok: false, error }
  if (reviewPlatformOf(run) !== INTERNAL) return { ok: false, error: t('review.err_external') }
  if (!run.review_sha) return { ok: false, error: t('review.err_not_open') }
  // Check and write in ONE statement: two quick clicks must not both pass the
  // check and enqueue the merge twice.
  const won = db.prepare(`UPDATE runs SET review_approved_sha=review_sha, review_state='approved', merge_status='approved',
              finish_state='merging', finish_started_at=datetime('now')
              WHERE id=? AND merge_status IN ('in_review','changes_requested') AND review_sha=?`).run(runId, run.review_sha)
  if (won.changes !== 1) return { ok: false, error: t('review.err_not_open') }
  const { enqueueIntegration } = await import('./integrate.mjs')
  addEvent(runId, 'review_approved', { sha: run.review_sha, comment: String(comment).slice(0, 4000) || null })
  enqueueIntegration(runId, { manual: true })
  return { ok: true, repo: repo.id }
}

/** "Reject": nothing is merged; the branch stays on origin. */
export async function rejectReview(runId, comment = '') {
  const { run, error } = openReviewRun(runId)
  if (error) return { ok: false, error }
  if (reviewPlatformOf(run) !== INTERNAL) return { ok: false, error: t('review.err_external') }
  db.prepare(`UPDATE runs SET merge_status='review_rejected', review_state='rejected' WHERE id=?`).run(runId)
  addEvent(runId, 'review_rejected', { comment: String(comment).slice(0, 4000) || null })
  await rejectOriginal(run)
  return { ok: true }
}

/**
 * A rejected conflict run: the reviewer said no to the work it carries, which
 * is the ORIGINAL's work — so that is where the verdict lands, instead of the
 * original waiting in 'resolving' for a run that will never deliver.
 */
async function rejectOriginal(run) {
  if (!run?.resolves_run_id) return
  const r = db.prepare(`UPDATE runs SET merge_status='review_rejected' WHERE id=? AND merge_status='resolving'`).run(run.resolves_run_id)
  if (r.changes !== 1) return
  addEvent(run.resolves_run_id, 'review_rejected', { by_resolver: run.id })
  // The conflict run's own messages are silenced, so the operator hears it here.
  const { notifyRun } = await import('./reports.mjs')
  await notifyRun(run.resolves_run_id, 'review_closed', `❌ The review of this run's conflict run was rejected — nothing was merged.`, { dedupe: false })
}

/**
 * Hand change requests to the agent: typed into its session as a follow-up
 * commission. Without a standing session there is nobody to type to, and the
 * answer says so instead of pretending.
 */
async function deliverChanges(run, repo, comments, via) {
  if (!run.tmux_session || run.tmux_closed_at) return { ok: false, error: t('review.err_no_session') }
  const text = M_CHANGES.replaceAll('{base}', repo.base_branch).replace('{comments}', comments)
    .replace('{report_file}', join(RUNS_DIR, run.id, 'report.md'))
  const r = await sendToSession(run.tmux_session, text)
  if (r && r.ok === false) return { ok: false, error: t('review.err_no_session') }
  const { startFollowUpCommission, noteOperatorInput } = await import('./reports.mjs')
  noteOperatorInput(run.id, via)
  startFollowUpCommission(run.id, comments, via)
  return { ok: true }
}

/** "Request changes" (internal review). */
export async function requestChanges(runId, comment = '') {
  const { run, repo, error } = openReviewRun(runId)
  if (error) return { ok: false, error }
  if (reviewPlatformOf(run) !== INTERNAL) return { ok: false, error: t('review.err_external') }
  const text = String(comment ?? '').trim()
  if (!text) return { ok: false, error: t('review.err_comment_missing') }
  const r = await deliverChanges(run, repo, text, 'review')
  if (!r.ok) return r
  db.prepare(`UPDATE runs SET merge_status='changes_requested', review_state='changes_requested' WHERE id=?`).run(runId)
  addEvent(runId, 'review_changes_requested', { comment: text.slice(0, 4000) })
  return { ok: true }
}

/** A platform's comments as one text block for the agent. */
export function formatComments(list) {
  return (list ?? []).map(c => {
    const where = c.path ? ` (${c.path}${c.line ? `:${c.line}` : ''})` : ''
    return `- ${c.author ?? 'reviewer'}${where}: ${String(c.body ?? '').trim()}`
  }).join('\n')
}

/**
 * "Send review comments to the agent" (external review): the platform's
 * comments since the last forwarding.
 */
export async function forwardComments(runId) {
  const { run, repo, error } = openReviewRun(runId)
  if (error) return { ok: false, error }
  const platform = reviewPlatformOf(run)
  const plugin = platformPlugin(platform)
  if (!plugin?.comments) return { ok: false, error: t('review.err_no_comments_api') }
  let list
  try {
    list = await plugin.comments(pluginCtx(platform), { project: await reviewProject(repo, plugin), id: run.review_id })
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) }
  }
  const last = db.prepare(`SELECT payload FROM events WHERE run_id=? AND kind='review_forwarded' ORDER BY id DESC LIMIT 1`).get(runId)
  let since = ''
  try { since = JSON.parse(last?.payload ?? '{}').at ?? '' } catch {}
  const fresh = (list ?? []).filter(c => !since || !c.at || String(c.at) > since)
  if (!fresh.length) return { ok: false, error: t('review.err_no_new_comments') }
  const r = await deliverChanges(run, repo, formatComments(fresh), 'review')
  if (!r.ok) return r
  const at = fresh.map(c => String(c.at ?? '')).sort().pop() || new Date().toISOString()
  addEvent(runId, 'review_forwarded', { n: fresh.length, at })
  return { ok: true, n: fresh.length }
}

// ------------------------------------------------------------ polling

const lastPoll = new Map()   // runId → ms

/**
 * Ask every open external review for its state — from the integrator's tick,
 * at most once a minute per run. Merged → the run is merged (flows, "main has
 * moved", notification); closed → rejected; changes requested → named once.
 */
export async function pollReviews(nowMs = Date.now(), { force = false } = {}) {
  const rows = db.prepare(`SELECT * FROM runs WHERE merge_status IN ('in_review','changes_requested')
    AND review_platform IS NOT NULL AND review_platform NOT IN ('none','${INTERNAL}') AND review_id IS NOT NULL`).all()
  for (const run of rows) {
    if (!force && nowMs - (lastPoll.get(run.id) ?? 0) < POLL_MS) continue
    lastPoll.set(run.id, nowMs)
    try { await pollOne(run) } catch (err) { console.error('[review]', run.id, err.message) }
  }
}

/** One external review, asked now (also the detail page's "refresh" button). */
export async function pollOne(run) {
  const repo = getRepo(run.repo_id)
  const plugin = platformPlugin(run.review_platform)
  if (!repo || !plugin) return { ok: false, error: t('review.err_platform_missing') }
  let st
  try {
    st = await plugin.status(pluginCtx(run.review_platform), { project: await reviewProject(repo, plugin), id: run.review_id })
  } catch (err) {
    const msg = String(err?.message ?? err).slice(0, 500)
    // One event per distinct failure, not one a minute.
    const prev = db.prepare(`SELECT payload FROM events WHERE run_id=? AND kind='review_poll_failed' ORDER BY id DESC LIMIT 1`).get(run.id)
    if (!prev || !String(prev.payload).includes(JSON.stringify(msg).slice(1, -1))) addEvent(run.id, 'review_poll_failed', { error: msg })
    return { ok: false, error: msg }
  }
  const { notifyRun } = await import('./reports.mjs')
  const url = st?.url || run.pr_url
  if (st?.state === 'merged') {
    await reviewMerged(run, repo, st.mergeSha ?? null)
    return { ok: true, state: 'merged' }
  }
  if (st?.state === 'closed') {
    db.prepare(`UPDATE runs SET merge_status='review_rejected', review_state='closed' WHERE id=?`).run(run.id)
    addEvent(run.id, 'review_closed', { url })
    await rejectOriginal(run)
    await notifyRun(run.id, 'review_closed', `❌ Review closed without merging: ${url}`, { dedupe: false })
    return { ok: true, state: 'closed' }
  }
  const state = st?.changesRequested && !staleChangeRequest(run, st) ? 'changes_requested'
    : st?.approved && !st?.changesRequested ? 'approved' : 'open'
  if (state !== run.review_state) {
    db.prepare(`UPDATE runs SET review_state=?, merge_status=? WHERE id=?`)
      .run(state, state === 'changes_requested' ? 'changes_requested' : 'in_review', run.id)
    addEvent(run.id, `review_${state}`, { url, external: true })
    if (state === 'changes_requested') {
      await notifyRun(run.id, 'review_changes', `✏️ Changes requested in review: ${url}\nDetail page: "Send review comments to the agent".`, { dedupe: false })
    }
  }
  return { ok: true, state }
}

/**
 * Is the platform's change request one the agent has already answered? A
 * platform keeps a request in force until its author approves or dismisses it,
 * so after a re-submission it is still reported — and must not flip the run
 * back and ring again. With a timestamp (`changesRequestedAt`) the request is
 * compared against the re-submission; without one, a re-submission made after
 * the last change request the hub saw counts as the answer until the platform
 * stops reporting it.
 */
export function staleChangeRequest(run, st) {
  const ts = (kind) => db.prepare(`SELECT ts FROM events WHERE run_id=? AND kind=? ORDER BY id DESC LIMIT 1`).get(run.id, kind)?.ts ?? null
  const updated = ts('review_updated')
  if (!updated) return false
  if (st?.changesRequestedAt) return Date.parse(st.changesRequestedAt) <= Date.parse(`${updated.replace(' ', 'T')}Z`)
  const seen = ts('review_changes_requested')
  return !!seen && seen <= updated
}

/**
 * An external review was merged on its platform. The hub never pushed to the
 * base branch here — it records the merge the same way its own integrator
 * would, so flows, "main has moved" and the notification do not care who
 * pressed the button.
 */
async function reviewMerged(run, repo, mergeSha) {
  await sh('git', ['-C', repo.path, 'fetch', 'origin'], { timeout: 120_000 })
  // Only a real object name: a platform answer like "HEAD" would otherwise be
  // resolved in the operator's repository and describe a different commit.
  const hex = /^[0-9a-f]{7,64}$/i.test(String(mergeSha ?? ''))
  const known = hex && (await sh('git', ['-C', repo.path, 'cat-file', '-e', `${mergeSha}^{commit}`])).ok
  const sha = known ? mergeSha : null
  const { finishMergedExternally } = await import('./integrate.mjs')
  await finishMergedExternally(run.id, repo, { tip: run.review_sha, mergedSha: sha })
}

// ------------------------------------------------------------- the diff

const DIFF_MAX = 800_000
const GIT_SAFE = ['-c', 'core.quotepath=off', 'diff', '--no-ext-diff', '--no-textconv', '--no-color']

/**
 * What the reviewer reads: the commits and the diff of the submitted commit
 * against its merge base with origin/{base}. Asked in the operator's
 * repository (`repo.path`) about a commit the gate made reachable there — never
 * in the agent's working copy, whose `.git` belongs to the agent.
 */
export async function reviewDiff(run, repo) {
  const sha = run.review_sha
  if (!sha) return null
  // Once merged, the merge base IS the reviewed commit and the diff would be
  // empty — the run's own start is the base then.
  const mb = run.merge_status === 'merged' ? { ok: false }
    : await sh('git', ['-C', repo.path, 'merge-base', `origin/${repo.base_branch}`, sha])
  const base = mb.ok ? mb.stdout.trim() : (run.base_sha ?? null)
  if (!base) return { error: (mb.stderr || 'no merge base').trim() }
  const log = await sh('git', ['-C', repo.path, 'log', '--no-color', '--format=%h %s', `${base}..${sha}`])
  const numstat = await sh('git', ['-C', repo.path, ...GIT_SAFE, '--numstat', base, sha])
  const patch = await sh('git', ['-C', repo.path, ...GIT_SAFE, '-U3', base, sha], { maxBuffer: 16 * 1024 * 1024 })
  if (!patch.ok) return { error: (patch.stderr || 'git diff failed').trim() }
  const files = numstat.stdout.split('\n').filter(Boolean).map(l => {
    const [add, del, ...p] = l.split('\t')
    return { path: p.join('\t'), add: add === '-' ? null : Number(add), del: del === '-' ? null : Number(del) }
  })
  const truncated = patch.stdout.length > DIFF_MAX
  return {
    base, sha, files, truncated,
    commits: log.stdout.split('\n').filter(Boolean),
    patch: truncated ? patch.stdout.slice(0, DIFF_MAX) : patch.stdout,
  }
}

/** One file's unified diff as HTML lines. */
/** A link target only when it is a web address — `fl-report pr` lets an agent write this field. */
export function safeHref(url) {
  const u = String(url ?? '').trim()
  return /^https?:\/\//i.test(u) ? u : null
}

function patchHtml(chunk) {
  return chunk.split('\n').map(line => {
    const cls = line.startsWith('+') && !line.startsWith('+++') ? 'add'
      : line.startsWith('-') && !line.startsWith('---') ? 'del'
        : line.startsWith('@@') ? 'hunk' : ''
    return `<span${cls ? ` class="${cls}"` : ''}>${e(line) || ' '}</span>`
  }).join('')
}

/** Split a whole diff into per-file chunks, keyed by the b/ path. */
export function splitPatch(patch) {
  const out = []
  for (const part of String(patch ?? '').split(/^(?=diff --git )/m)) {
    if (!part.startsWith('diff --git ')) continue
    const m = part.match(/^diff --git a\/(.*?) b\/(.*)$/m)
    out.push({ path: m ? m[2] : '?', text: part.replace(/\n$/, '') })
  }
  return out
}

// ---------------------------------------------------------------- pages

/** One short line for the integration banner (part of the live fragment). */
export function reviewLine(run) {
  const platform = reviewPlatformOf(run)
  if (!platform) return ''
  const state = run.review_state ? t(`review.state_${run.review_state}`) : t('review.state_pending')
  const link = safeHref(run.pr_url) && platform !== INTERNAL
    ? ` · <a href="${e(safeHref(run.pr_url))}" target="_blank" rel="noopener">${e(t('review.open_platform'))}</a>` : ''
  return `<div class="dim">${e(t('review.label'))}: ${e(platformLabel(platform))} · ${e(state)}${link}</div>`
}

/**
 * The review card on a run's detail page: the diff and the reviewer's
 * buttons. Not part of the live fragment — a comment half typed must not be
 * swapped away by the next refresh.
 */
export async function reviewCard(run, repo) {
  const platform = reviewPlatformOf(run)
  if (!platform || !run.review_sha || !repo) return ''
  const open = REVIEW_OPEN.includes(run.merge_status)
  const history = reviewHistory(run.id)
  const head = `<h3>${e(t('review.title'))} · ${e(platformLabel(platform))} · <code>${e(String(run.review_sha).slice(0, 7))}</code>
    <span class="pill">${e(t(`review.state_${run.review_state || 'open'}`))}</span></h3>`
  if (platform !== INTERNAL) {
    const act = (action, label) => `<form method="post" action="/api/runs/${e(run.id)}/review/${action}" class="inline"><button>${e(t(label))}</button></form>`
    return `<section class="card review" id="review">${head}
      ${safeHref(run.pr_url) ? `<p><a href="${e(safeHref(run.pr_url))}" target="_blank" rel="noopener">${e(run.pr_url)}</a></p>` : ''}
      <p class="dim">${e(t('review.external_hint', { platform: platformLabel(platform) }))}</p>
      ${open ? `<div class="btn-row">${act('refresh', 'review.refresh')}${act('forward', 'review.forward')}</div>` : ''}
      ${history}</section>`
  }
  const d = await reviewDiff(run, repo)
  let diffHtml = ''
  if (!d || d.error) {
    diffHtml = `<p class="warn">${e(t('review.diff_failed'))}: ${e(d?.error ?? '')}</p>`
  } else {
    const add = d.files.reduce((s, f) => s + (f.add ?? 0), 0)
    const del = d.files.reduce((s, f) => s + (f.del ?? 0), 0)
    const chunks = splitPatch(d.patch)
    diffHtml = `
      <p>${e(t('review.summary', { files: d.files.length, commits: d.commits.length }))}
        <span class="diff-add">+${add}</span> <span class="diff-del">−${del}</span></p>
      ${d.commits.length ? `<details><summary>${e(t('review.commits'))}</summary><pre>${e(d.commits.join('\n'))}</pre></details>` : ''}
      <div class="review-files">${chunks.map((c, i) => {
        const f = d.files.find(x => x.path === c.path)
        return `<details class="review-file" ${chunks.length <= 10 || i < 5 ? 'open' : ''}><summary><code>${e(c.path)}</code>
          ${f ? `<span class="diff-add">+${f.add ?? '·'}</span> <span class="diff-del">−${f.del ?? '·'}</span>` : ''}</summary>
          <pre class="diff">${patchHtml(c.text)}</pre></details>`
      }).join('')}</div>
      ${d.truncated ? `<p class="warn">${e(t('review.truncated'))}</p>` : ''}`
  }
  const form = open ? `
    <form method="post" class="review-form" action="/api/runs/${e(run.id)}/review/approve">
      <div><b>${e(t('review.comment'))}</b></div>
      <textarea name="comment" rows="4" aria-label="${e(t('review.comment'))}" placeholder="${e(t('review.comment_ph'))}"></textarea>
      <div class="btn-row">
        <button name="decision" value="approve" formaction="/api/runs/${e(run.id)}/review/approve">${e(t('review.approve'))}</button>
        <button name="decision" value="changes" formaction="/api/runs/${e(run.id)}/review/changes" class="ghost">${e(t('review.request_changes'))}</button>
        <button name="decision" value="reject" formaction="/api/runs/${e(run.id)}/review/reject" class="ghost"
          onclick="return confirm(${e(JSON.stringify(t('review.reject_confirm')))})">${e(t('review.reject'))}</button>
      </div>
      <p class="dim">${e(t('review.approve_hint', { base: repo.base_branch }))}</p>
    </form>` : ''
  return `<section class="card review" id="review">${head}${diffHtml}${form}${history}</section>`
}

/** What happened in this review, oldest first. */
function reviewHistory(runId) {
  const rows = db.prepare(`SELECT ts, kind, payload FROM events WHERE run_id=? AND kind LIKE 'review_%'
    AND kind NOT IN ('review_poll_failed') ORDER BY id`).all(runId)
  if (!rows.length) return ''
  const li = rows.map(r => {
    let p = {}
    try { p = JSON.parse(r.payload ?? '{}') ?? {} } catch {}
    const key = `review.ev_${r.kind.replace(/^review_/, '')}`
    const word = t(key) === key ? r.kind : t(key)
    const extra = p.comment ? `<blockquote>${e(p.comment)}</blockquote>` : p.sha ? ` <code>${e(String(p.sha).slice(0, 7))}</code>` : ''
    return `<li><span class="dim">${e(fmtDbUtc(r.ts))}</span> ${e(word)}${extra}</li>`
  }).join('')
  return `<details class="review-history" open><summary>${e(t('review.history'))}</summary><ul>${li}</ul></details>`
}

/** Is code review in use anywhere — the nav entry and the list only appear then. */
export function reviewInUse() {
  if (globalReview().on) return true
  if (db.prepare(`SELECT 1 FROM repos WHERE review_mode='on' LIMIT 1`).get()) return true
  return !!db.prepare(`SELECT 1 FROM runs WHERE review_platform IS NOT NULL AND review_platform<>'none' LIMIT 1`).get()
}

/** Open reviews, newest first — what the Reviews page lists and the nav counts. */
export function openReviews() {
  return db.prepare(`SELECT r.*, p.name AS repo_name FROM runs r JOIN repos p ON p.id=r.repo_id
    WHERE r.merge_status IN ('in_review','changes_requested','approved') AND r.review_platform IS NOT NULL
      AND r.review_platform<>'none' ORDER BY r.ended_at DESC`).all()
}

export function reviewsPageBody() {
  const rows = openReviews()
  const done = db.prepare(`SELECT r.*, p.name AS repo_name FROM runs r JOIN repos p ON p.id=r.repo_id
    WHERE r.review_sha IS NOT NULL AND r.merge_status NOT IN ('in_review','changes_requested','approved')
    ORDER BY r.ended_at DESC LIMIT 20`).all()
  const table = (list) => `<table class="list"><thead><tr><th>${e(t('review.col_run'))}</th><th>${e(t('layout.repo'))}</th>
    <th>${e(t('review.col_platform'))}</th><th>${e(t('review.col_state'))}</th><th>${e(t('run.end'))}</th></tr></thead><tbody>
    ${list.map(r => `<tr><td><a href="/runs/${e(r.id)}#review">${e(r.title ?? shortId(r.id))}</a></td><td>${e(r.repo_name)}</td>
      <td>${e(platformLabel(r.review_platform))}${safeHref(r.pr_url) && r.review_platform !== INTERNAL ? ` · <a href="${e(safeHref(r.pr_url))}" target="_blank" rel="noopener">↗</a>` : ''}</td>
      <td>${e(t(`merge.${r.merge_status}`) === `merge.${r.merge_status}` ? r.merge_status : t(`merge.${r.merge_status}`))}</td>
      <td class="dim">${e(r.ended_at ? fmtDbUtc(r.ended_at) : '')}</td></tr>`).join('')}</tbody></table>`
  return `<h2>${e(t('review.page_title'))}</h2>
  <p class="dim">${e(t('review.page_intro'))} <a href="/settings/review">${e(t('review.global_link'))}</a></p>
  ${rows.length ? table(rows) : `<p class="dim">${e(t('review.none_open'))}</p>`}
  ${done.length ? `<h3>${e(t('review.recent'))}</h3>${table(done)}` : ''}`
}

// ------------------------------------------------------ settings & forms

function platformOptions(selected, { inherit = null } = {}) {
  const opts = []
  if (inherit) opts.push(`<option value="" ${!selected ? 'selected' : ''}>${e(inherit)}</option>`)
  opts.push(`<option value="${INTERNAL}" ${selected === INTERNAL ? 'selected' : ''}>${e(t('review.platform_internal'))}</option>`)
  for (const p of reviewPlatforms()) {
    opts.push(`<option value="${e(p.id)}" ${selected === p.id ? 'selected' : ''}>${e(p.label)}</option>`)
  }
  // A stored platform whose plugin is gone stays visible instead of silently
  // turning into another one on the next save.
  if (selected && selected !== INTERNAL && !reviewPlatforms().some(p => p.id === selected)) {
    opts.push(`<option value="${e(selected)}" selected>${e(selected)} (${e(t('review.platform_missing'))})</option>`)
  }
  return opts.join('')
}

/** One line for the settings page: what the global default is. */
export function reviewSettingsSummary() {
  const g = globalReview()
  return g.on ? t('review.summary_on', { platform: platformLabel(g.platform) }) : t('review.summary_off')
}

/** Settings → Code review: the global default. */
export function reviewSettingsFields() {
  const g = globalReview()
  // Its own page carries the title; the fields need no second one.
  return `<p class="dim">${e(t('review.settings_intro'))}</p>
    <label>${e(t('review.default'))} <select name="review_default">
      <option value="off" ${g.on ? '' : 'selected'}>${e(t('review.off'))}</option>
      <option value="on" ${g.on ? 'selected' : ''}>${e(t('review.on'))}</option></select></label>
    <label>${e(t('review.platform'))} <select name="review_platform">${platformOptions(g.platform)}</select>
      <span class="dim">${e(t('review.platform_hint'))}</span></label>
  `
}

export function reviewSettingsFromForm(b) {
  const platform = String(b.review_platform ?? '').trim()
  return {
    review_default: b.review_default === 'on' ? 'on' : 'off',
    review_platform: platform === INTERNAL || pluginKind(platform) === 'review' ? platform : INTERNAL,
  }
}

/** The repo form's review block, inside its Integration fieldset. */
export function reviewRepoFields(r = {}) {
  const g = globalReview()
  const mode = tri(r.review_mode)
  const inheritWord = t(g.on ? 'review.inherit_on' : 'review.inherit_off', { platform: platformLabel(g.platform) })
  return `
    <label>${e(t('review.repo_mode'))} <select name="review_mode">
      <option value="inherit" ${mode === 'inherit' ? 'selected' : ''}>${e(inheritWord)}</option>
      <option value="on" ${mode === 'on' ? 'selected' : ''}>${e(t('review.on'))}</option>
      <option value="off" ${mode === 'off' ? 'selected' : ''}>${e(t('review.off'))}</option></select>
      <span class="dim">${e(t('review.repo_mode_hint'))} <a href="/settings/review">${e(t('review.global_link'))}</a></span></label>
    <label>${e(t('review.platform'))} <select name="review_platform">${platformOptions(r.review_platform ?? '', { inherit: t('review.platform_inherit', { platform: platformLabel(g.platform) }) })}</select></label>
    <label>${e(t('review.project'))} <input name="review_project" value="${e(r.review_project ?? '')}" placeholder="acme/app">
      <span class="dim">${e(t('review.project_hint'))}</span></label>`
}

export function reviewRepoFromForm(b) {
  const platform = String(b.review_platform ?? '').trim()
  return {
    review_mode: tri(b.review_mode),
    review_platform: platform === INTERNAL || pluginKind(platform) === 'review' ? platform : null,
    review_project: String(b.review_project ?? '').trim() || null,
  }
}

/**
 * The run / agent form's choice, inside the branch fieldset (hub mode only,
 * like "keep on branch"). `inherit` is whatever the repo decides at launch.
 */
export function reviewRunField(a = {}, { hidden = false } = {}) {
  const value = tri(a.review)
  return `<label data-hub-only data-review-choice ${hidden ? 'hidden' : ''}>${e(t('review.run_choice'))} <select name="review">
      <option value="inherit" ${value === 'inherit' ? 'selected' : ''}>${e(t('review.inherit'))}</option>
      <option value="on" ${value === 'on' ? 'selected' : ''}>${e(t('review.on'))}</option>
      <option value="off" ${value === 'off' ? 'selected' : ''}>${e(t('review.off'))}</option></select>
      <small class="dim">${e(t('review.run_choice_hint'))}</small></label>`
}

export function reviewFromForm(b) { return tri(b?.review) }

export { inOpenReview } from './run-state.mjs'

