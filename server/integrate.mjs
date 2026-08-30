// Freilauf — integration: a run is done when its work is on the base branch.
//
// Before this module a run ended when the agent called `fl-report done`. What it
// had committed then sat in its worktree and its branch, and whether it ever
// reached `main` depended on whether the agent did it itself — which is how a
// repository's reflog came to hold two resets on main, a cherry-pick duplicate
// and a finished branch lying unmerged for days.
//
// The ground rule now, and it holds everywhere: NO AGENT MERGES OR PUSHES TO THE
// BASE BRANCH. Agents make branches mergeable; the hub integrates. It does that
// in a worktree of its own (~/agents/integrate/<repo>) and pushes to origin —
// never in the operator's checkout, where git refuses to push into the branch
// that is checked out there anyway.
//
// Three things happen here, in this order:
//
//   the finish gate   the `done` report is checked instead of believed: is the
//                     worktree clean, does the branch still merge? If not, the
//                     agent — which is still alive at that moment, and the only
//                     one that knows what it changed — is told what is missing
//                     and reports again. `runs.finish_state` carries that as a
//                     SUB-state of 'running': runs.status has a CHECK, and a new
//                     value there would be a table rebuild.
//   the integrator    one serial queue per repo. Hub, scheduler and watcher share
//                     one process, so a queue is a promise chain — the same
//                     argument events.mjs is built on.
//   the escalation    when the agent does not deliver: a fresh conflict run, and
//                     as the last step a human, with an incident and a notification.
//
// All of it is off unless the repo says `merge_mode='hub'`.
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import db, { getRepo, getRun, addEvent, getSetting } from './db.mjs'
import { RUNS_DIR, kurzid, sh, sendToSession, parseDbUtc } from './util.mjs'
import { harnessOwnedPaths, applyExtras } from './runner.mjs'
import { notifyRun, doneText, completeFollowUp } from './reports.mjs'
import { vorfallMelden, offeneVorfaelle, vorfallVerwerfen } from './incidents.mjs'
import { getHarness } from './harnesses/index.mjs'
import { fallbackTitle, TITLE_MAX } from './title.mjs'
import { t } from './i18n.mjs'
import { env } from './env.mjs'

export const INTEGRATE_DIR = env('INTEGRATE_DIR') ?? join(homedir(), 'agents', 'integrate')

/** The states the check loop owns. 'merging' belongs to the integrator alone. */
const LOOP_STATES = ['checking', 'awaiting_commit', 'awaiting_merge', 'check_failed']

/** At most two git checks at a time — a repo with ten runs finishing must not fork twenty. */
const CHECK_PARALLEL = Number(env('FINISH_PARALLEL') ?? 2) || 2

// ---------------------------------------------------------------- the texts
//
// Constants with {placeholders}, like PLATFORM_RULES in runner.mjs: these go to
// an AGENT or into a notification, not to the UI — they are never translated.

export const M1 = `Freilauf: report received — but the run is NOT finished yet.
Your worktree has uncommitted changes:
{files}
A run is only done when its work is committed. Either commit them (\`git add … && git commit\`) or discard them if they are not part of the work (\`git checkout -- <file>\`, \`git clean -f <file>\`). Do not move files outside the worktree to get around this.
Then run \`fl-report done --file {report_file}\` again. Freilauf re-checks every few seconds and closes the run as soon as the worktree is clean; after {timeout} minutes it escalates to the operator.`

export const M2 = `Freilauf: report received — but the run is NOT finished yet.
Your branch cannot be merged into {base}: origin/{base} has moved, and the merge conflicts in
{files}
Resolve it now, while you still know what you changed and why:
  git fetch origin && git merge origin/{base}
Resolve every conflict so that BOTH intentions survive — yours and what already landed on {base} (listed below). Then run the tests, commit the merge, push if your branch has an upstream, and run \`fl-report done --file {report_file}\` again.
Do NOT merge into or push to {base} yourself: Freilauf merges your branch once it is clean.
Landed on {base} since you started:
{landed_runs}`

export const M3 = `Freilauf: report received. Worktree clean, branch mergeable — Freilauf is merging it into {base} now. Nothing more to do; stay in this session.`

export const M4 = `Freilauf: your branch merges cleanly into {base}, but the merge check failed on the merged result:
  $ {merge_check}
{output_tail}
Fix the cause on your branch (fetch and merge origin/{base} first if you have not), commit, and run \`fl-report done --file {report_file}\` again.`

export const M5A = `Freilauf: {base} has moved — run "{title}" was merged ({sha7}). It changed files you are working on too:
{overlap_files}
Bring the change in now, before you build further on the old state:
  git fetch origin && git merge origin/{base}
Resolve conflicts so that both intentions survive, then continue with your task.`

export const M5B = `Freilauf: FYI — {base} has moved: run "{title}" was merged ({sha7}), {n} file(s) changed, none of them touched by you so far. No action needed now. As usual, merge origin/{base} into your branch before you report done.`

export const P_CONFLICT = `Your task: make the branch \`{branch}\` mergeable into \`{base}\` again.

A previous run — "{orig_title}" (Freilauf run {orig_id}) — did the work on this branch and has ended. The branch cannot be merged into origin/{base}: {reason}. Files involved:
{files}

Do this:
1. \`git fetch origin && git merge origin/{base}\`
2. Resolve every conflict so that BOTH intentions survive: what the previous run wanted (its report is below) and what already landed on {base} (listed below). Do not drop either side just to make the conflict disappear. If the two really cannot coexist, stop and ask: \`fl-report help "<what conflicts and why>"\`.
3. {check_line}
4. Commit the merge. Keep the branch's history: no rebase, no force-push. Push if the branch has an upstream.
5. Report done as described in the platform rules. Freilauf merges the branch into {base} itself — never push to {base} yourself.

--- Report of the previous run ---
{orig_report}

--- Landed on {base} since the branch started ---
{landed_runs}
{resolver_extra}`

/** One paragraph per assessment of a run that did NOT end with done. */
export const T_ASSESS = {
  unmerged_commits: 'Not merged — the run did not end with done. The branch has {n} commit(s) and no uncommitted changes, so git could merge them safely. But look first: a failed run\'s work is not automatically wanted. To merge anyway, use "Merge now" on the run\'s detail page.',
  unmerged_both: 'Not merged. The branch has {n} commit(s), BUT the worktree also has {m} uncommitted file(s). Nothing was merged. On the detail page you can commit or discard the leftovers and merge, or leave everything as it is.',
  unmerged_dirty: 'Nothing to merge: no commits, but {m} uncommitted file(s) in the worktree. They stay there until you decide — detail page: commit & merge, or discard.',
  nothing: 'Nothing to merge: no commits and no uncommitted changes.',
}

export const T_BLOCKED_DIRTY = `🔴 Finished with uncommitted changes and did not clean up within {timeout} min:
{files}
Nothing was merged. Decide on the detail page: commit & merge, discard & merge, or skip.{backup}
Attach: tmux attach -t ={session}
Resume: {resume_cmd}`

export const T_DIVERGED = `🔴 {repo}: local {base} has diverged from origin/{base} ({n} local, {m} remote commits). Freilauf never force-pushes — please reconcile by hand in {path}. Until then those local commits are not backed up; Freilauf's own merges land on origin only.`

export const T_BLOCKED_CONFLICT = `🔴 Branch {branch} could not be merged into {base}: {attempts} conflict run(s) did not get it clean. Files:
{files}
Detail page: retry the resolver, merge by hand, or skip.
Resume: {resume_cmd}`

export const T_BLOCKED_ERROR = `🔴 Could not integrate branch {branch} into {base}: {reason}. Nothing was merged. Detail page: "Merge now" retries.`

export const T_RESOLVING = `🟡 "{title}" conflicts with {base} and its agent is gone — started conflict run {resolver_short} on branch {branch} (attempt {attempt}/{max}).`

/** {placeholder} substitution, like platformSuffix does it. */
export function fill(template, vars = {}) {
  let out = String(template)
  for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, String(v ?? ''))
  return out
}

/**
 * A file list as the agent sees it: indented, capped. Thirty paths are already
 * more than anybody reads, and a run that touched four hundred would otherwise
 * push the actual instruction off the screen.
 */
export function formatFiles(files, max = 30) {
  const list = (files ?? []).filter(Boolean)
  if (!list.length) return '  (none)'
  const shown = list.slice(0, max).map(f => `  ${f}`)
  if (list.length > max) shown.push(`  … and ${list.length - max} more`)
  return shown.join('\n')
}

// ---------------------------------------------------------------- pure logic

/**
 * How long until the next check of a waiting run.
 *
 * Dense at the start, because an agent that is told "commit first" usually does
 * it within seconds and should not then sit around for half a minute; slower
 * afterwards, because a run that has not moved in five minutes will not move in
 * the next five either. A pure function of the elapsed time, so the tests can
 * state the ladder instead of measuring it.
 */
export function nextCheckDelayMs(elapsedMs) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 60_000) return 5_000
  if (elapsedMs < 5 * 60_000) return 15_000
  return 30_000
}

/**
 * `git status --porcelain` minus what the HUB itself put into the worktree —
 * the worktree extras and the harness's hook files. Without this filter a
 * symlinked `referenz` or a `.cursor/hooks.json` makes every worktree dirty
 * forever: the cleanup never removes one, and the finish gate would never let a
 * cursor run through.
 *
 * git names the DIRECTORY ('?? .cursor/') when everything below it is untracked
 * and the single file ('?? .cursor/hooks.json') when it is not, so both forms
 * have to be covered. Lifted out of cleanupWorktrees() in watcher.mjs, which was
 * its only home; both callers use this one now.
 */
export function foreignChanges(porcelain, ownPaths = []) {
  const own = (ownPaths ?? []).map(p => String(p).replace(/\/+$/, ''))
  return String(porcelain ?? '').split('\n').filter(Boolean)
    .map(z => z.slice(3).trim().replace(/\/+$/, ''))
    .filter(p => p && !own.some(e => p === e || p.startsWith(`${e}/`)))
}

/** The paths of a worktree that belong to the hub rather than to the agent. */
export function ownWorktreePaths(repo, harness) {
  return [...(repo?.extras ?? []).map(x => String(x.path)), ...harnessOwnedPaths(harness)]
}

/**
 * The finish gate's verdict, as a pure decision. The order is the point:
 * uncommitted work outranks everything (nothing gets merged while the worktree
 * is dirty — half a run's work on the base branch is the more expensive
 * mistake), then "did it commit at all", then "does it still merge".
 */
export function decideFinish({ dirty, commits, conflict }) {
  if (dirty) return 'awaiting_commit'
  if (!commits) return 'nothing'
  if (conflict) return 'awaiting_merge'
  return 'merging'
}

/**
 * What a run that did NOT end with 'done' leaves behind. Never merged
 * automatically — a failed run's work is not automatically wanted — but named,
 * so the operator can decide with one click instead of going looking.
 */
export function classifyUnmerged({ commits, dirty }) {
  if (commits > 0 && dirty > 0) return 'unmerged_both'
  if (commits > 0) return 'unmerged_commits'
  if (dirty > 0) return 'unmerged_dirty'
  return 'nothing'
}

/**
 * The conflicting paths out of `git merge-tree --write-tree --name-only`: the
 * first line is the tree oid, then one path per line, then a blank line and
 * git's own prose about what it auto-merged.
 */
export function conflictFilesFromMergeTree(stdout) {
  const lines = String(stdout ?? '').split('\n')
  const out = []
  for (const line of lines.slice(1)) {
    if (!line.trim()) break
    out.push(line.trim())
  }
  return out
}

/** Does this repo want the hub to integrate? Everything here hangs on it. */
export function hubMerges(repo) {
  return repo?.merge_mode === 'hub'
}

/**
 * Is this run a tool of the integrator rather than a piece of work in its own
 * right?
 *
 * A conflict run shares a lot with a normal run — the start path, a worktree, a
 * session, the watcher's activity and incident handling, and its row in the
 * overview. Everything else is switched OFF, and this predicate is the single
 * place that says so, because the alternative is nine scattered conditions that
 * drift.
 *
 * Two reasons, and the second is the load-bearing one. The operator did not ask
 * for this run and must not be told about it: he hears about the ORIGINAL run —
 * T-RESOLVING when a resolver starts, the done line naming the resolver when it
 * lands, T-BLOCKED-CONFLICT when it does not. And a conflict run must never
 * produce a conflict run: everything that goes wrong here is mapped onto the
 * original (`escalate(original, 'resolver_failed')`), which is where the attempt
 * counter lives. Without that, a failing resolver would spawn a resolver for
 * itself, forever.
 */
export function isResolverRun(run) {
  return !!run?.resolves_run_id
}

/**
 * What to do with the operator's own commits on the base branch of the main
 * checkout. The remote is the backup: a commit that exists only on this machine
 * is one power supply away from gone.
 *
 *   'skip'      nothing local that origin does not have
 *   'push'      local is ahead and origin has nothing new — a fast-forward
 *   'diverged'  both sides moved. NEVER --force: that would drop somebody's
 *               commits. A human reconciles this, and hears about it.
 */
export function decidePush({ ahead, behind }) {
  if (!ahead) return 'skip'
  return behind ? 'diverged' : 'push'
}

// ---------------------------------------------------------------- git access

const fetchedAt = new Map()      // repoId → ms of the last `git fetch origin`
const lastTip = new Map()        // runId → the tip the conflict dry run last saw
const nextCheckAt = new Map()    // runId → ms
const lastMessage = new Map()    // runId → { key, ms } — the cursor loop guard
const chains = new Map()         // repoId → Promise (the serial integration queue)
const queued = new Set()         // runIds currently in a chain
const pushFails = new Map()      // runId → consecutive non-conflict push failures

/** `git fetch origin`, at most once per repo every 10 s. */
async function fetchThrottled(repo, nowMs = Date.now()) {
  const last = fetchedAt.get(repo.id) ?? 0
  if (nowMs - last < 10_000) return
  fetchedAt.set(repo.id, nowMs)
  await sh('git', ['-C', repo.path, 'fetch', 'origin'], { timeout: 120_000 })
}

async function hasOrigin(repo) {
  return (await sh('git', ['-C', repo.path, 'remote', 'get-url', 'origin'])).ok
}

/** The commit a run delivers. */
async function tipOf(run) {
  if (!run.workdir_effective || !existsSync(run.workdir_effective)) return null
  const r = await sh('git', ['-C', run.workdir_effective, 'rev-parse', 'HEAD'])
  return r.ok ? r.stdout.trim() : null
}
/** The same, for reports.mjs: "has the worktree moved past what was merged?" */
export const tipOfRun = tipOf

/**
 * Where the run started. Normally recorded at launch; a run from before that
 * column existed falls back to the merge base with the base branch, which is the
 * same commit in every case that matters.
 */
async function baseShaOf(run, repo, tip) {
  if (run.base_sha) return run.base_sha
  if (!tip) return null
  const r = await sh('git', ['-C', repo.path, 'merge-base', tip, `origin/${repo.base_branch}`])
  return r.ok ? r.stdout.trim() : null
}

/** Uncommitted work that is the AGENT's, as a list of paths. */
async function dirtyFiles(run, repo) {
  if (!run.workdir_effective || !existsSync(run.workdir_effective)) return []
  // --no-optional-locks so the hub does not fight the agent's own git commands
  // over the index lock: a status that refreshes the index can block one.
  // --no-optional-locks is a GIT-level option and has to stand before the
  // subcommand; after it, git rejects it as unknown and the status comes back
  // empty — which reads as "clean" and would let every dirty worktree through.
  const r = await sh('git', ['-C', run.workdir_effective, '--no-optional-locks', 'status', '--porcelain'])
  if (!r.ok) return []
  return foreignChanges(r.stdout, ownWorktreePaths(repo, run.harness))
}

/**
 * Would this tip merge into origin/{base}? `git merge-tree --write-tree` answers
 * that WITHOUT touching a worktree — measured with git 2.43: exit 1 on conflict,
 * the conflicting paths on stdout, `git status` afterwards empty. Anything that
 * checked out a branch here would fight the agent for its own worktree.
 */
async function mergeDryRun(repo, tip) {
  const r = await sh('git', ['-C', repo.path, 'merge-tree', '--write-tree', '--name-only',
    `origin/${repo.base_branch}`, tip])
  if (r.ok) return { conflict: false, files: [] }
  if (r.code === 1) return { conflict: true, files: conflictFilesFromMergeTree(r.stdout) }
  return { error: (r.stderr || r.stdout).trim() || 'merge-tree failed' }
}

// ------------------------------------------------- origin is the backup
//
// The operator runs the remote as his backup, and that is a rule beyond the
// integrator: nothing may exist only on this machine. Three consequences, and
// the first one is already how integrateOne() works — the integrator knows no
// local merge. Its only way out is `push origin HEAD:{base}`; a merge that
// cannot be pushed is not a merge, it is thrown away and escalated. There is no
// state "merged, but only locally".

const pushedAt = new Map()   // repoId → ms of the last operator-commit push

/**
 * Push what the OPERATOR committed on the base branch of the main checkout.
 *
 * A push does not touch a working tree, which is why it is the one git command
 * the hub is allowed to run in the operator's checkout — merge, checkout and
 * reset stay forbidden there, and for good reason (a branch belongs to exactly
 * one worktree, and that one has files in it somebody is editing).
 *
 * Never --force. A diverged base branch is a human's problem, and the hub says
 * so once (global incident + notification) instead of picking a winner.
 */
export async function pushOperatorBase(nowMs = Date.now()) {
  const repos = db.prepare(`SELECT * FROM repos WHERE merge_mode='hub'`).all()
  for (const row of repos) {
    const repo = getRepo(row.id)
    if (!repo) continue
    if (nowMs - (pushedAt.get(repo.id) ?? 0) < 60_000) continue
    pushedAt.set(repo.id, nowMs)
    try { await pushOneRepo(repo) } catch (err) { console.error('[integrate]', err.message) }
  }
}

async function pushOneRepo(repo) {
  if (!await hasOrigin(repo)) return
  await fetchThrottled(repo)
  const base = repo.base_branch
  const counts = await sh('git', ['-C', repo.path, 'rev-list', '--left-right', '--count',
    `${base}...origin/${base}`])
  if (!counts.ok) return
  const [ahead = 0, behind = 0] = counts.stdout.trim().split(/\s+/).map(Number)
  const typ = `merge_blocked:${repo.name}`
  const decision = decidePush({ ahead, behind })
  if (decision === 'skip') {
    for (const v of offeneVorfaelle(null)) if (v.typ === typ) vorfallVerwerfen(v.id, 'base branch back in sync')
    return
  }
  if (decision === 'diverged') {
    const { ereignis } = await vorfallMelden(null, {
      typ, quelle: 'integrate', schwere: 'rot', stillMelden: true,
      beleg: `${base} has diverged from origin/${base}: ${ahead} local, ${behind} remote commits`,
    })
    if (['neu', 'wieder'].includes(ereignis)) {
      const { notify } = await import('./notify.mjs')
      await notify({ kind: 'repo', text: fill(T_DIVERGED, { repo: repo.name, base, n: ahead, m: behind, path: repo.path }) })
    }
    return
  }
  const r = await sh('git', ['-C', repo.path, 'push', 'origin', `${base}:${base}`], { timeout: 180_000 })
  if (!r.ok) return
  db.prepare(`UPDATE repos SET last_push_at=datetime('now') WHERE id=?`).run(repo.id)
  fetchedAt.delete(repo.id)
  console.log(`[integrate] pushed ${ahead} operator commit(s) on ${repo.name}/${base}`)
}

/**
 * Put a blocked or unmerged run's commits on origin. Same intention as the
 * existing `anomaly:unpushed` — only carried out instead of reported: work that
 * nobody merged is exactly the work that must not sit on one disk.
 *
 * The run's own branch where it has one, `run/<short id>` for a detached
 * worktree. Returns the ref, or null when there was nothing to save.
 */
export async function backupBranch(runId) {
  const run = getRun(runId)
  if (!run) return null
  const repo = getRepo(run.repo_id)
  if (!hubMerges(repo) || !await hasOrigin(repo)) return null
  const tip = await tipOf(run)
  if (!tip || !run.base_sha || tip === run.base_sha) return null
  const branch = run.branch_reported || run.branch_expected
  const ref = branch || `run/${kurzid(runId)}`
  const r = branch
    ? await sh('git', ['-C', run.workdir_effective, 'push', '-u', 'origin', branch], { timeout: 180_000 })
    : await sh('git', ['-C', repo.path, 'push', 'origin', `${tip}:refs/heads/${ref}`], { timeout: 180_000 })
  if (!r.ok) return null
  addEvent(runId, 'branch_backed_up', { ref })
  return ref
}

// ---------------------------------------------------------------- the check

/**
 * One pass of the finish gate. Returns
 *   { state, files, error? } with state ∈ decideFinish() ∪ {'error'}.
 * Cheap on purpose: the conflict dry run only happens when the tip has MOVED
 * since the last one — `rev-parse HEAD` costs nothing, merge-tree does not.
 */
export async function runFinishCheck(run, { force = false } = {}) {
  const repo = getRepo(run.repo_id)
  if (!repo) return { state: 'error', files: [], error: 'repo gone' }
  const dirty = await dirtyFiles(run, repo)
  if (dirty.length) return { state: 'awaiting_commit', files: dirty }

  const tip = await tipOf(run)
  if (!tip) return { state: 'error', files: [], error: 'worktree gone' }
  const base = await baseShaOf(run, repo, tip)
  if (base && tip === base) return { state: 'nothing', files: [], tip }
  // A follow-up report (reports.mjs) whose worktree still stands where the last
  // integration left it: nothing new to merge. Without this the tip would be
  // dry-run, found mergeable and "merged" a second time as an ancestor.
  if (run.merged_sha && tip === run.merged_sha) return { state: 'nothing', files: [], tip }

  const unchanged = !force && lastTip.get(run.id) === tip
  if (unchanged && run.finish_state === 'awaiting_merge') return { state: 'awaiting_merge', files: [], tip, stale: true }
  if (unchanged && run.finish_state === 'check_failed') return { state: 'check_failed', files: [], tip, stale: true }

  await fetchThrottled(repo)
  const dry = await mergeDryRun(repo, tip)
  lastTip.set(run.id, tip)
  if (dry.error) return { state: 'error', files: [], error: dry.error, tip }
  return { state: decideFinish({ dirty: false, commits: true, conflict: dry.conflict }), files: dry.files, tip }
}

// ---------------------------------------------------------------- messages

function reportFile(runId) { return join(RUNS_DIR, runId, 'report.md') }

/**
 * What has landed on the base branch since this run started, as the agent needs
 * to read it: the Freilauf runs whose merge commits sit in that range, newest
 * first. A range with no Freilauf run in it says so instead of staying blank —
 * "nothing changed" and "somebody pushed by hand" are different facts.
 */
export async function landedRuns(repo, run, max = 5) {
  const base = run.base_sha
  if (!base) return '- (no Freilauf runs; changes came from outside)'
  const r = await sh('git', ['-C', repo.path, 'rev-list', `${base}..origin/${repo.base_branch}`])
  if (!r.ok) return '- (no Freilauf runs; changes came from outside)'
  const shas = new Set(r.stdout.split('\n').map(s => s.trim()).filter(Boolean))
  if (!shas.size) return '- (no Freilauf runs; changes came from outside)'
  const rows = db.prepare(`SELECT id, title, merged_sha, report_md FROM runs
    WHERE repo_id=? AND merged_sha IS NOT NULL ORDER BY merged_at DESC LIMIT 50`).all(repo.id)
  const lines = []
  for (const row of rows) {
    if (!shas.has(row.merged_sha)) continue
    const summary = fallbackTitle(row.report_md ?? '', 160) || '(no report)'
    lines.push(`- "${row.title ?? kurzid(row.id)}" (${row.merged_sha.slice(0, 7)}): ${summary}`)
    if (lines.length >= max) break
  }
  return lines.length ? lines.join('\n') : '- (no Freilauf runs; changes came from outside)'
}

/** The message that belongs to a check result. */
async function messageFor(run, repo, result) {
  const timeout = repo.finish_timeout_min ?? 15
  switch (result.state) {
    case 'awaiting_commit':
      return fill(M1, { files: formatFiles(result.files), report_file: reportFile(run.id), timeout })
    case 'awaiting_merge':
      return fill(M2, {
        base: repo.base_branch, files: formatFiles(result.files),
        report_file: reportFile(run.id), landed_runs: await landedRuns(repo, run),
      })
    case 'merging':
      return fill(M3, { base: repo.base_branch })
    default:
      return null
  }
}

/**
 * Deliver a message to the agent.
 *
 * `via='http'` means the agent is standing in its `fl-report` call right now:
 * the answer travels back as the tool's own output, which is the cheapest moment
 * there is. Every other channel (the inbox fallback, cursor's turn-end
 * detection) has no such call to answer, so the text is typed into the tmux
 * session instead.
 *
 * The guard is for cursor: `finishByTurnEnd()` fires at EVERY turn end of a
 * running cursor run, so an injected M1 would be answered by cursor working,
 * ending its turn, and the hub injecting M1 again — forever. The same message
 * therefore only goes out again when the state changed or two minutes passed.
 */
async function deliver(run, message, via, key) {
  if (!message) return false
  if (via === 'http') return false                    // the caller returns it
  if (!run.tmux_session || run.tmux_closed_at) return false
  if (via === 'internal') {
    const last = lastMessage.get(run.id)
    if (last && last.key === key && Date.now() - last.ms < 120_000) return false
  }
  lastMessage.set(run.id, { key, ms: Date.now() })
  await sendToSession(run.tmux_session, message)
  addEvent(run.id, 'finish_message_sent', { via })
  return true
}

// ------------------------------------------------------------- the finish gate

/**
 * The `done` report, checked instead of believed.
 *
 * Returns null when this repo does not want the hub to integrate (or the run has
 * no worktree) — the caller then does exactly what it always did. Otherwise:
 *   { hold: true, message }   the run stays 'running', the agent has work left
 *   { hold: false, mergeLine} nothing to merge: close it as before, with a line
 *                             in the notification text saying so
 */
export async function finishGate(runId, text, via = 'http') {
  const run = getRun(runId)
  if (!run) return null
  const repo = getRepo(run.repo_id)
  // `runs.worktree` is NULL when the run worked in the repo itself (legacy rows).
  // The hub never runs the gate against the operator's checkout: a dirty file
  // there is HIS, and a merge there is the thing this whole module avoids.
  if (!hubMerges(repo) || !run.worktree || !existsSync(run.worktree)) return null

  // The report is safe from this moment on, whatever the agent does next.
  const first = !run.finish_state
  db.prepare(`UPDATE runs SET report_md=COALESCE(?, report_md), finish_state='checking',
              finish_started_at=COALESCE(finish_started_at, datetime('now')) WHERE id=?`)
    .run(text || null, runId)
  if (first) addEvent(runId, 'finish_started', {})

  const fresh = getRun(runId)
  if (fresh.keep_on_branch) return finishKept(fresh, repo, via)
  const result = await runFinishCheck(fresh, { force: true })
  return applyCheckResult(fresh, repo, result, via)
}

/**
 * "Keep the work on its branch": everything the gate does about DIRT still
 * applies — a run is only over when its work is committed — but nothing after
 * it. No dry run, no merge, and the branch is pushed to origin instead, because
 * work that nobody merges is exactly the work that must not live on one disk.
 */
async function finishKept(run, repo, via) {
  const dirty = await dirtyFiles(run, repo)
  if (dirty.length) {
    setFinishState(run.id, 'awaiting_commit')
    if (run.finish_state !== 'awaiting_commit' || via === 'http') {
      addEvent(run.id, 'finish_dirty', { files: dirty.slice(0, 30) })
    }
    const message = fill(M1, {
      files: formatFiles(dirty), report_file: reportFile(run.id),
      timeout: repo.finish_timeout_min ?? 15,
    })
    await deliver(run, message, via, `awaiting_commit:${dirty.join(',')}`)
    scheduleNext(run)
    return { hold: true, message }
  }
  const branch = run.branch_reported || run.branch_expected
  const ref = await backupBranch(run.id)
  if (!ref) {
    // The operator wants nothing living only here, so a branch that cannot be
    // pushed is an escalation, exactly like a merge that cannot be pushed.
    addEvent(run.id, 'merge_error', { reason: `could not push branch ${branch ?? '?'} to origin` })
    await escalate(run.id, 'merge_error')
    return { hold: true, message: null }
  }
  db.prepare(`UPDATE runs SET merge_status='kept_on_branch', finish_state=NULL WHERE id=?`).run(run.id)
  addEvent(run.id, 'branch_kept', { branch: ref })
  return { hold: false, mergeLine: `Kept on branch ${ref} — not merged, as configured` }
}

/**
 * Write down what a check found and answer accordingly. The single place a
 * finish_state is written, so every transition carries an event — there is no
 * silent `UPDATE runs` on this path.
 */
async function applyCheckResult(run, repo, result, via) {
  const changed = result.state !== run.finish_state
  switch (result.state) {
    case 'error': {
      if (changed) addEvent(run.id, 'finish_error', { error: result.error })
      setFinishState(run.id, 'checking')
      scheduleNext(run)
      return { hold: true, message: null }
    }
    case 'awaiting_commit': {
      setFinishState(run.id, 'awaiting_commit')
      if (changed || via === 'http') addEvent(run.id, 'finish_dirty', { files: result.files.slice(0, 30) })
      const message = await messageFor(run, repo, result)
      await deliver(run, message, via, `awaiting_commit:${result.files.join(',')}`)
      scheduleNext(run)
      return { hold: true, message }
    }
    case 'awaiting_merge': {
      setFinishState(run.id, 'awaiting_merge')
      if (changed || via === 'http') addEvent(run.id, 'finish_conflict', { files: result.files.slice(0, 30) })
      const message = result.stale ? null : await messageFor(run, repo, result)
      await deliver(run, message, via, `awaiting_merge:${result.files.join(',')}`)
      scheduleNext(run)
      return { hold: true, message }
    }
    case 'check_failed': {
      // The merge check is still red and nothing moved — keep waiting quietly.
      scheduleNext(run)
      return { hold: true, message: null }
    }
    case 'nothing': {
      setFinishState(run.id, null)
      // A follow-up that brought no commits leaves the run's merge status as it
      // is: its earlier work IS merged, and "nothing" would say the opposite.
      if (run.followup_open) {
        addEvent(run.id, 'merge_nothing', { followup: true })
        return { hold: false, mergeLine: 'Nothing to merge (no new commits)' }
      }
      db.prepare(`UPDATE runs SET merge_status='nothing' WHERE id=?`).run(run.id)
      addEvent(run.id, 'merge_nothing', {})
      return { hold: false, mergeLine: 'Nothing to merge (no commits)' }
    }
    default: {
      setFinishState(run.id, 'merging')
      addEvent(run.id, 'finish_clean', {})
      const message = await messageFor(run, repo, result)
      await deliver(run, message, via, 'merging')
      enqueueIntegration(run.id)
      return { hold: true, message }
    }
  }
}

/**
 * A kept run that became clean while the loop was watching. The report path
 * closes such a run in reports.mjs (that is where a `done` becomes a `done`);
 * reached from the loop, the same three things have to happen here.
 */
async function closeKept(runId, repo, mergeLine) {
  nextCheckAt.delete(runId)
  // A follow-up that kept its work on the branch: the run was done already —
  // only the follow-up is closed, announced as such (reports.mjs).
  if (getRun(runId)?.followup_open) return completeFollowUp(runId, { mergeLine, merged: false })
  db.prepare(`UPDATE runs SET status='done', ended_at=COALESCE(ended_at, datetime('now')) WHERE id=?`).run(runId)
  addEvent(runId, 'done')
  const run = getRun(runId)
  await notifyRun(runId, 'done', doneText(run, run.report_md, mergeLine),
    { fileName: `report-${runId.slice(0, 8)}.md`, fileContent: run.report_md ?? '' })
  import('./flows/triggers.mjs').then(m => m.flowsTick()).catch(e => console.error('[flows]', e.message))
}

function setFinishState(runId, state) {
  db.prepare('UPDATE runs SET finish_state=? WHERE id=?').run(state, runId)
}

function scheduleNext(run, nowMs = Date.now()) {
  const started = parseDbUtc(run.finish_started_at)
  const elapsed = Number.isFinite(started) ? nowMs - started : 0
  nextCheckAt.set(run.id, nowMs + nextCheckDelayMs(elapsed))
}

// ---------------------------------------------------------------- the loop

/**
 * One pass of the check loop AND the safety net the watcher calls.
 *
 * Takes the time as a parameter for the same reason pickUpScheduled() does: a
 * test advances the clock instead of waiting fifteen minutes for a deadline.
 */
export async function integrateTick(nowMs = Date.now()) {
  const rows = db.prepare(`SELECT * FROM runs WHERE finish_state IN (${LOOP_STATES.map(() => '?').join(',')})`)
    .all(...LOOP_STATES)
  // Deadlines first: a run that is out of time must not be checked again, it
  // must be escalated. While it is waiting_help the clock does not run — the
  // agent is waiting for a HUMAN there, not the other way round.
  const due = []
  for (const run of rows) {
    if (run.status === 'waiting_help') continue
    const started = parseDbUtc(run.finish_started_at)
    const repo = getRepo(run.repo_id)
    const timeout = Math.max(1, repo?.finish_timeout_min ?? 15) * 60_000
    if (Number.isFinite(started) && nowMs - started > timeout) {
      await escalate(run.id, 'timeout')
      continue
    }
    if ((nextCheckAt.get(run.id) ?? 0) <= nowMs) due.push(run)
  }
  due.sort((a, b) => (nextCheckAt.get(a.id) ?? 0) - (nextCheckAt.get(b.id) ?? 0))

  // At most CHECK_PARALLEL git checks at once; whatever does not get a turn
  // stays due and is at the front of the next pass, so nothing starves.
  for (let i = 0; i < due.length; i += CHECK_PARALLEL) {
    await Promise.all(due.slice(i, i + CHECK_PARALLEL).map(async (run) => {
      try {
        const repo = getRepo(run.repo_id)
        if (!repo) return
        if (run.keep_on_branch) {
          const r = await finishKept(run, repo, 'internal')
          // Nothing left to merge — close it the way the report path would have.
          if (!r.hold) await closeKept(run.id, repo, r.mergeLine)
          return
        }
        const result = await runFinishCheck(run)
        await applyCheckResult(run, repo, result, 'internal')
      } catch (err) {
        console.error('[integrate]', run.id, err.message)
      }
    }))
  }

  // Runs that were merging when the hub went down: the queue is in memory, the
  // state is in the database — so put them back.
  for (const run of db.prepare(`SELECT id FROM runs WHERE finish_state='merging'`).all()) {
    if (!queued.has(run.id)) enqueueIntegration(run.id)
  }

  // Conflict runs that ended without delivering — done without commits, failed,
  // aborted. Asked here rather than hooked into the five places a run can end:
  // one place cannot be forgotten, and the original would otherwise sit in
  // 'resolving' forever.
  const stranded = db.prepare(`SELECT r.* FROM runs r JOIN runs o ON o.id = r.resolves_run_id
    WHERE r.resolves_run_id IS NOT NULL AND r.status IN ('done','failed','aborted')
      AND r.finish_state IS NULL AND o.merge_status='resolving' AND o.resolver_run_id = r.id`).all()
  for (const r of stranded) {
    if (r.merge_status === 'merged') continue
    await resolverEnded(r)
  }
  await startWaitingResolvers()
}

let timer = null
/**
 * Off switch for the test suites: with two processes (the hub and the suite)
 * driving the same integration worktree, a timer in the background is a race
 * nobody wants to debug. The hub still integrates on the report path — the
 * suite simply owns the clock.
 */
export function integratorTimerOff() { return env('INTEGRATOR_OFF') === '1' }

export function startIntegrator() {
  if (timer || integratorTimerOff()) return
  timer = setInterval(() => integrateTick().catch(e => console.error('[integrate]', e.message)), 5_000)
  // Nothing is lost across a restart: every waiting run is checked right away.
  for (const run of db.prepare(`SELECT id FROM runs WHERE finish_state IS NOT NULL`).all()) {
    nextCheckAt.set(run.id, 0)
  }
}
export function stopIntegrator() { clearInterval(timer); timer = null }

// ---------------------------------------------------------------- integrator

/**
 * The serial merge queue, one chain per repo. Hub, scheduler and watcher run in
 * ONE process, which is why this needs neither a broker nor a database lock —
 * the same argument events.mjs is built on. Errors are caught inside the chain
 * so it can never tear.
 */
export function enqueueIntegration(runId, opts = {}) {
  const run = getRun(runId)
  if (!run) return
  queued.add(runId)
  const repoId = run.repo_id
  const chain = (chains.get(repoId) ?? Promise.resolve())
    .then(() => integrateOne(runId, opts))
    .catch(err => console.error('[integrate]', runId, err.message))
    .finally(() => queued.delete(runId))
  chains.set(repoId, chain)
  return chain
}

/** The hub's own worktree for this repo — detached, disposable, never the operator's checkout. */
async function integrationWorktree(repo) {
  const dir = join(INTEGRATE_DIR, repo.name)
  if (existsSync(dir)) {
    await sh('git', ['-C', dir, 'merge', '--abort'])
    await sh('git', ['-C', dir, 'reset', '--hard'])
    await sh('git', ['-C', dir, 'clean', '-fd'])
  } else {
    mkdirSync(INTEGRATE_DIR, { recursive: true })
    await sh('git', ['-C', repo.path, 'worktree', 'prune'])
    const r = await sh('git', ['-C', repo.path, 'worktree', 'add', '--detach', dir,
      `origin/${repo.base_branch}`])
    if (!r.ok) return { error: (r.stderr || r.stdout).trim() }
  }
  // A merge check like `node test/unit.mjs` needs the linked node_modules just
  // as much as an agent does — the same extras, the same function.
  try { applyExtras(repo, dir) } catch { /* an extra is convenience, never a blocker */ }
  return { dir }
}

async function integrateOne(runId, opts = {}) {
  const run = getRun(runId)
  if (!run) return
  const repo = getRepo(run.repo_id)
  if (!hubMerges(repo) && !opts.manual) return

  if (!await hasOrigin(repo)) {
    db.prepare(`UPDATE runs SET merge_status='blocked_no_remote' WHERE id=?`).run(runId)
    addEvent(runId, 'merge_error', { reason: 'no origin remote' })
    return escalate(runId, 'blocked_no_remote')
  }

  const tip = await tipOf(run)
  if (!tip) {
    addEvent(runId, 'merge_error', { reason: 'worktree gone' })
    return escalate(runId, 'merge_error')
  }

  const wt = await integrationWorktree(repo)
  if (wt.error) {
    addEvent(runId, 'merge_error', { reason: wt.error })
    return escalate(runId, 'merge_error')
  }
  const dir = wt.dir

  await fetchThrottled(repo, Date.now())
  const co = await sh('git', ['-C', dir, 'checkout', '--detach', `origin/${repo.base_branch}`])
  if (!co.ok) {
    addEvent(runId, 'merge_error', { reason: (co.stderr || co.stdout).trim() })
    return escalate(runId, 'merge_error')
  }

  // Somebody merged this branch outside the hub: nothing to do, and saying so is
  // more honest than a second, empty merge commit.
  const already = await sh('git', ['-C', repo.path, 'merge-base', '--is-ancestor', tip,
    `origin/${repo.base_branch}`])
  if (already.ok) {
    await finishMerged(runId, tip, repo, { already: true })
    return
  }

  const beforeSha = (await sh('git', ['-C', dir, 'rev-parse', 'HEAD'])).stdout.trim()
  const title = run.title ?? kurzid(runId)
  const merged = await sh('git', ['-C', dir,
    '-c', 'user.name=Freilauf', '-c', 'user.email=Freilauf@localhost',
    'merge', '--no-ff', '-m', `Merge run ${kurzid(runId)}: ${title}\n\nFreilauf run ${runId}`, tip])
  if (!merged.ok) {
    await sh('git', ['-C', dir, 'merge', '--abort'])
    return backToConflict(runId, repo, 'merge conflict')
  }

  // The merge check runs on the MERGED result — that is the state that would
  // land, and the only one worth testing.
  const check = String(repo.merge_check ?? '').trim()
  if (check) {
    const r = await sh('bash', ['-lc', check], { cwd: dir, timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024 })
    if (!r.ok) {
      const tail = [r.stdout, r.stderr].filter(Boolean).join('\n').split('\n').slice(-60).join('\n')
      await sh('git', ['-C', dir, 'reset', '--hard', `origin/${repo.base_branch}`])
      setFinishState(runId, 'check_failed')
      addEvent(runId, 'finish_check_failed', { tail: tail.slice(-4000) })
      lastTip.set(runId, tip)
      const fresh = getRun(runId)
      await deliver(fresh, fill(M4, {
        base: repo.base_branch, merge_check: check, output_tail: tail,
        report_file: reportFile(runId),
      }), 'internal', `check_failed:${tip}`)
      scheduleNext(fresh)
      return
    }
  }

  const push = await sh('git', ['-C', dir, 'push', 'origin', `HEAD:${repo.base_branch}`], { timeout: 180_000 })
  if (!push.ok) {
    const err = (push.stderr || push.stdout).trim()
    // Somebody was faster: fetch and try once more from the top. A second
    // rejection is treated as a conflict — the branch really does need work.
    if (/non-fast-forward|fetch first|rejected/i.test(err)) {
      if (!opts.retriedPush) {
        fetchedAt.delete(repo.id)
        return integrateOne(runId, { ...opts, retriedPush: true })
      }
      return backToConflict(runId, repo, 'merge conflict')
    }
    const n = (pushFails.get(runId) ?? 0) + 1
    pushFails.set(runId, n)
    addEvent(runId, 'merge_error', { reason: err.slice(0, 300), attempt: n })
    // A merge that cannot be pushed is not a merge. Throw it away rather than
    // leave a "merged, but only locally" state behind — origin is the truth.
    await sh('git', ['-C', dir, 'reset', '--hard', `origin/${repo.base_branch}`])
    if (n >= 5) { pushFails.delete(runId); return escalate(runId, 'merge_error') }
    setTimeout(() => enqueueIntegration(runId, opts), 60_000).unref?.()
    return
  }
  pushFails.delete(runId)

  const mergedSha = (await sh('git', ['-C', dir, 'rev-parse', 'HEAD'])).stdout.trim()
  await finishMerged(runId, tip, repo, { mergedSha, beforeSha, dir })
}

/** A conflict found by the integrator puts the run back in front of its agent. */
async function backToConflict(runId, repo, reason) {
  const run = getRun(runId)
  setFinishState(runId, 'awaiting_merge')
  const tip = await tipOf(run)
  const dry = tip ? await mergeDryRun(repo, tip) : { files: [] }
  addEvent(runId, 'finish_conflict', { files: (dry.files ?? []).slice(0, 30), reason })
  const fresh = getRun(runId)
  await deliver(fresh, fill(M2, {
    base: repo.base_branch, files: formatFiles(dry.files ?? []),
    report_file: reportFile(runId), landed_runs: await landedRuns(repo, fresh),
  }), 'internal', `awaiting_merge:${(dry.files ?? []).join(',')}`)
  scheduleNext(fresh)
}

/**
 * The run's work is on the base branch. ONLY now is it done — that is the whole
 * point of this module — and only now does the operator hear about it, the other
 * agents of the repo learn that the base branch moved, and the flows fire.
 */
async function finishMerged(runId, tip, repo, { mergedSha = null, beforeSha = null, dir = null, already = false } = {}) {
  const sha = mergedSha ?? tip
  // What this merge actually changed on the base branch. Computed once and
  // carried in the event: "main has moved" needs it to judge urgency, and the
  // flow trigger that reacts to a merge reads it from there.
  const files = (!already && dir && beforeSha && mergedSha)
    ? (await sh('git', ['-C', dir, 'diff', '--name-only', `${beforeSha}..${mergedSha}`]))
      .stdout.split('\n').map(x => x.trim()).filter(Boolean)
    : []
  // Read BEFORE the update: whether this integration belongs to a follow-up
  // report is a fact about the run as it stood when the merge started, and a
  // follow-up's run is 'done' on both sides of the update. A failed run whose
  // work is merged by hand ("Merge now") is deliberately NOT a follow-up — that
  // is why the column exists instead of a guess from the status.
  const followUp = !!getRun(runId)?.followup_open
  db.prepare(`UPDATE runs SET merge_status='merged', merged_sha=?, merged_at=datetime('now'),
              finish_state=NULL, status=CASE WHEN followup_open=1 THEN status ELSE 'done' END,
              ended_at=COALESCE(ended_at, datetime('now')) WHERE id=?`)
    .run(tip, runId)
  addEvent(runId, 'merged', already ? { already: true, sha: tip, files, followup: followUp } : { sha, files, followup: followUp })
  nextCheckAt.delete(runId)
  lastTip.delete(runId)

  const run = getRun(runId)
  const line = `Merged into ${repo.base_branch}: ${String(tip).slice(0, 7)}`
  if (followUp) {
    // "FOLLOW-UP REPORT #n" instead of a second "Done" — and the flows fire
    // again, the merged ones included (reports.mjs, completeFollowUp).
    await completeFollowUp(runId, { mergeLine: line, merged: true })
  } else {
    await notifyRun(runId, 'done', doneText(run, run.report_md, line),
      { fileName: `report-${runId.slice(0, 8)}.md`, fileContent: run.report_md ?? '' })
  }

  // A conflict run works FOR another run: the result counts for both, and the
  // original — which has been sitting in 'resolving' without a done message —
  // gets its own now.
  if (run.resolves_run_id) {
    const orig = getRun(run.resolves_run_id)
    if (orig) {
      db.prepare(`UPDATE runs SET merge_status='merged', merged_sha=?, merged_at=datetime('now') WHERE id=?`)
        .run(tip, orig.id)
      // The same payload the original would have carried had it merged itself:
      // whatever reads a merge — "main has moved", the flow trigger — must not
      // have to care which run happened to carry it over the line.
      addEvent(orig.id, 'merged', { sha: tip, files, by_resolver: runId, followup: !!orig.followup_open })
      closeMergeIncidents(orig.id)
      const fresh = getRun(orig.id)
      const origLine = `Merged into ${repo.base_branch}: ${String(tip).slice(0, 7)} (by conflict run ${kurzid(runId)})`
      if (orig.followup_open) {
        await completeFollowUp(orig.id, { mergeLine: origLine, merged: true })
      } else {
        await notifyRun(orig.id, 'done', doneText(fresh, fresh.report_md, origLine),
          { fileName: `report-${orig.id.slice(0, 8)}.md`, fileContent: fresh.report_md ?? '' })
      }
    }
  }
  closeMergeIncidents(runId)

  if (!already && mergedSha && dir) await notifyBaseMoved(repo, run, { files, mergedSha })

  // Flows see a run whose work really is on the base branch. (A follow-up's
  // merge was already dispatched by completeFollowUp; a second tick is idle.)
  import('./flows/triggers.mjs').then(m => m.flowsTick()).catch(e => console.error('[flows]', e.message))
}

function closeMergeIncidents(runId) {
  for (const v of offeneVorfaelle(runId)) {
    if (v.typ === 'merge_blocked') vorfallVerwerfen(v.id, 'merged after all')
  }
}

// ------------------------------------------------------- "the base has moved"

/**
 * After every merge, tell the OTHER running agents of this repo — urgently when
 * the merge touched files they are working on too.
 *
 * Built into the hub rather than offered as a flow, deliberately: a flow would
 * have to be attached to every agent, and a forgotten attachment is invisible.
 *
 * Not to a run in 'waiting_help': a text typed into a session that is waiting for
 * a human's answer is read by the agent AS that answer — which is exactly why
 * the send route and the flow step switch such a run back to 'running' first.
 * Runs in the finish gate DO get it; an 'awaiting_merge' one needs it most.
 */
async function notifyBaseMoved(repo, mergedRun, { files, mergedSha }) {
  if (!repo.notify_running) return
  const changed = new Set(files ?? [])
  const targets = db.prepare(`SELECT * FROM runs WHERE repo_id=? AND status='running'
    AND tmux_session IS NOT NULL AND tmux_closed_at IS NULL AND id<>?`).all(repo.id, mergedRun.id)
  const ids = [], urgentIds = []
  for (const other of targets) {
    if (other.id === mergedRun.resolves_run_id) continue
    // A conflict run is a tool, not a colleague — it has exactly one job and a
    // notice about a moving base branch is noise inside it.
    if (isResolverRun(other)) continue
    const mine = await filesOfRun(other, repo)
    const overlap = [...changed].filter(f => mine.has(f))
    const text = overlap.length
      ? fill(M5A, {
        base: repo.base_branch, title: mergedRun.title ?? kurzid(mergedRun.id),
        sha7: String(mergedSha).slice(0, 7), overlap_files: formatFiles(overlap),
      })
      : fill(M5B, {
        base: repo.base_branch, title: mergedRun.title ?? kurzid(mergedRun.id),
        sha7: String(mergedSha).slice(0, 7), n: changed.size,
      })
    // sendToSession() directly and NOT actions.sendToRun(): the latter switches
    // a help call back to 'running', and this message is not an answer.
    const r = await sendToSession(other.tmux_session, text)
    if (!r.ok) continue
    ids.push(other.id)
    if (overlap.length) urgentIds.push(other.id)
    addEvent(other.id, 'main_moved', { sha: String(mergedSha).slice(0, 7), urgent: overlap.length > 0 })
  }
  if (ids.length) addEvent(mergedRun.id, 'main_moved_notified', { run_ids: ids, urgent_ids: urgentIds })
}

/** Which files a run has touched so far — committed since its base, plus uncommitted. */
async function filesOfRun(run, repo) {
  const out = new Set()
  if (!run.workdir_effective || !existsSync(run.workdir_effective)) return out
  if (run.base_sha) {
    const r = await sh('git', ['-C', run.workdir_effective, 'diff', '--name-only', run.base_sha])
    if (r.ok) for (const f of r.stdout.split('\n').map(s => s.trim()).filter(Boolean)) out.add(f)
  }
  for (const f of await dirtyFiles(run, repo)) out.add(f)
  return out
}

// ---------------------------------------------------------------- escalation

/**
 * The agent did not deliver. The run leaves the finish gate — its agent will not
 * do anything more — and what is still missing hangs on the merge_status from
 * here on.
 *
 * `resolver_failed` is the one reason that arrives for a run which is already
 * 'done': a conflict run worked for it and did not get there. The status steps
 * are skipped then, only the situation is judged again.
 */
export async function escalate(runId, reason) {
  const run = getRun(runId)
  if (!run) return
  const repo = getRepo(run.repo_id)
  if (!repo) return
  // 'merging' belongs to the integrator, and only to it: the agent's session
  // going away while the hub is pushing says nothing about the merge, and
  // pulling the run out from under the job would leave it half done.
  if (run.finish_state === 'merging' && reason === 'agent_gone') return
  // A conflict run never gets a merge_status of its own beyond 'merged', never
  // an incident and above all never a conflict run: whatever went wrong here
  // counts against the ORIGINAL run's attempts.
  if (isResolverRun(run) && reason !== 'resolver_failed') {
    if (run.finish_state) {
      db.prepare(`UPDATE runs SET finish_state=NULL, status='done',
                  ended_at=COALESCE(ended_at, datetime('now')) WHERE id=?`).run(runId)
      addEvent(runId, 'finish_escalated', { reason })
    }
    nextCheckAt.delete(runId)
    return escalate(run.resolves_run_id, 'resolver_failed')
  }
  const wasWaiting = !!run.finish_state
  const dirty = await dirtyFiles(run, repo)

  if (wasWaiting) {
    // A follow-up keeps the status the run already had: a 'failed' run whose
    // follow-up got stuck must not come out of it as 'done'.
    db.prepare(`UPDATE runs SET finish_state=NULL,
                status=CASE WHEN followup_open=1 THEN status ELSE 'done' END,
                ended_at=COALESCE(ended_at, datetime('now')) WHERE id=?`).run(runId)
    // The run really ended here, so what hangs on its end has to fire — the
    // ordinary 'done' path does this too.
    import('./flows/triggers.mjs').then(m => m.flowsTick()).catch(e => console.error('[flows]', e.message))
  }
  nextCheckAt.delete(runId)
  addEvent(runId, 'finish_escalated', { reason })

  if (reason === 'blocked_no_remote') {
    return blockRun(runId, repo, 'blocked_no_remote', fill(T_BLOCKED_ERROR, {
      branch: branchOf(run), base: repo.base_branch,
      reason: 'the repository has no origin remote — Freilauf never merges in the operator\'s checkout',
    }))
  }
  if (reason === 'merge_error') {
    const last = db.prepare(`SELECT payload FROM events WHERE run_id=? AND kind='merge_error' ORDER BY id DESC LIMIT 1`).get(runId)
    let why = 'git error'
    try { why = JSON.parse(last?.payload ?? '{}').reason ?? why } catch {}
    return blockRun(runId, repo, 'blocked_error', fill(T_BLOCKED_ERROR, {
      branch: branchOf(run), base: repo.base_branch, reason: String(why).slice(0, 300),
    }))
  }
  // A run that was told to keep its work on its branch is not merged because
  // its agent vanished: the setting says what happens to this branch, and an
  // escalation is not a licence to overrule it. Push it and be done.
  if (run.keep_on_branch && !dirty.length && reason !== 'resolver_failed') {
    const ref = await backupBranch(runId)
    if (ref) {
      db.prepare(`UPDATE runs SET merge_status='kept_on_branch' WHERE id=?`).run(runId)
      addEvent(runId, 'branch_kept', { branch: ref })
      return
    }
    return blockRun(runId, repo, 'blocked_error', fill(T_BLOCKED_ERROR, {
      branch: branchOf(run), base: repo.base_branch, reason: 'the branch could not be pushed to origin',
    }))
  }
  if (dirty.length && reason !== 'resolver_failed') {
    // NOTHING is merged, not even the committed part: half a run's work on the
    // base branch is the more expensive mistake, and the operator has three
    // one-click answers on the detail page.
    return blockRun(runId, repo, 'blocked_dirty', fill(T_BLOCKED_DIRTY, {
      timeout: repo.finish_timeout_min ?? 15, files: formatFiles(dirty),
      session: run.tmux_session ?? '?', resume_cmd: resumeCommand(run) ?? worktreeHint(run),
    }))
  }
  return tryResolver(runId, repo, reason)
}

function branchOf(run) {
  return run.branch_reported || run.branch_expected || `run ${kurzid(run.id)}`
}
function worktreeHint(run) {
  return `no resume for this coding agent; the worktree is at ${run.workdir_effective ?? '?'}`
}

/**
 * A conflict (or a red merge check) gets a conflict run — up to
 * repos.merge_max_attempts of them. The loop guard sits here and nowhere else:
 * a conflict run that fails itself counts against the ORIGINAL run's attempts,
 * so no conflict run can ever start a conflict run.
 */
async function tryResolver(runId, repo, reason) {
  const run = getRun(runId)
  const origId = run.resolves_run_id ?? runId
  const orig = getRun(origId)
  if (!orig) return

  // Maybe it merges by itself now: the base branch may have moved on in a way
  // that dissolves the conflict, and asking is two git calls.
  const tip = await tipOf(run)
  if (tip) {
    await fetchThrottled(repo, Date.now())
    const dry = await mergeDryRun(repo, tip)
    if (!dry.error && !dry.conflict) {
      db.prepare(`UPDATE runs SET merge_status='merging' WHERE id=?`).run(runId)
      setFinishState(runId, 'merging')
      addEvent(runId, 'finish_clean', { after: reason })
      enqueueIntegration(runId)
      return
    }
  }

  const setup = resolverSetup()
  const attempts = (orig.merge_attempts ?? 0)
  const max = Math.max(0, repo.merge_max_attempts ?? 2)
  if (!setup.harness) {
    return blockRun(origId, repo, 'blocked_conflict', fill(T_BLOCKED_CONFLICT, {
      branch: branchOf(orig), base: repo.base_branch, attempts,
      files: formatFiles(await conflictFilesOf(repo, run)),
      resume_cmd: resumeCommand(orig) ?? worktreeHint(orig),
    }) + '\nNo conflict resolver configured (Settings → Merge).')
  }
  if (attempts >= max) {
    return blockRun(origId, repo, 'blocked_conflict', fill(T_BLOCKED_CONFLICT, {
      branch: branchOf(orig), base: repo.base_branch, attempts,
      files: formatFiles(await conflictFilesOf(repo, run)),
      resume_cmd: resumeCommand(orig) ?? worktreeHint(orig),
    }))
  }

  db.prepare(`UPDATE runs SET merge_status='resolving', resolver_run_id=NULL WHERE id=?`).run(origId)
  addEvent(origId, 'resolver_pending', { reason })
  await startWaitingResolvers()
}

async function conflictFilesOf(repo, run) {
  const tip = await tipOf(run)
  if (!tip) return []
  const dry = await mergeDryRun(repo, tip)
  return dry.files ?? []
}

/**
 * The whole "needs a human" step: status, backup, incident, notification.
 *
 * The backup comes first and on purpose: a run whose work did not reach the base
 * branch is exactly the run whose commits would otherwise live on this disk
 * alone. Uncommitted files cannot be saved this way, and the message says so
 * rather than letting the word "backed up" cover more than it does.
 */
async function blockRun(runId, repo, status, text) {
  db.prepare(`UPDATE runs SET merge_status=? WHERE id=?`).run(status, runId)
  addEvent(runId, 'merge_blocked', { status })
  const ref = await backupBranch(runId)
  await vorfallMelden(runId, {
    typ: 'merge_blocked', quelle: 'integrate', schwere: 'rot',
    beleg: `${status}: ${branchOf(getRun(runId))} → ${repo.base_branch}`,
  })
  // Never deduplicated: a run blocked once, merged by hand, and blocked again
  // on a FOLLOW-UP is blocked twice, and the second time is news too.
  await notifyRun(runId, 'merge_blocked', fill(text, {
    backup: ref ? `\nCommitted part backed up as origin/${ref}; the uncommitted files exist only in the worktree.` : '',
  }), { dedupe: false })
  // A blocked follow-up leaves the gate here. The block was just announced, so
  // the follow-up itself stays quiet — but its flows fire, like at any end.
  if (getRun(runId)?.followup_open) {
    await completeFollowUp(runId, { mergeLine: `Not merged (${status})`, merged: false, notify: false })
  }
}

// ------------------------------------------------------------- conflict runs

/** The saved setup of the conflict resolver (Settings → Merge). */
export function resolverSetup() {
  return {
    harness: getSetting('merge_resolver_harness') || '',
    provider: getSetting('merge_resolver_provider') || '',
    orProvider: getSetting('merge_resolver_or_provider') || '',
    model: getSetting('merge_resolver_model') || '',
    effort: getSetting('merge_resolver_effort') || '',
    skills: getSetting('merge_resolver_skills') || null,
    prompt: getSetting('merge_resolver_prompt') || '',
  }
}

/**
 * Start the conflict runs that are waiting for a slot — oldest first, at most
 * repos.conflict_parallel per repo at a time. One is the sensible default for a
 * small repository where every task touches the same files: parallel resolvers
 * there invalidate each other and only the first one's work survives.
 */
async function startWaitingResolvers() {
  const waiting = db.prepare(`SELECT * FROM runs WHERE merge_status='resolving' AND resolver_run_id IS NULL
    ORDER BY started_at`).all()
  for (const orig of waiting) {
    const repo = getRepo(orig.repo_id)
    if (!repo) continue
    const busy = db.prepare(`SELECT count(*) c FROM runs WHERE repo_id=? AND resolves_run_id IS NOT NULL
      AND status IN ('running','waiting_help')`).get(repo.id).c
    if (busy >= Math.max(1, repo.conflict_parallel ?? 1)) continue
    await startResolver(orig, repo)
  }
}

/**
 * A conflict run is a NORMAL single run: same start path, same budget gate, same
 * watcher, same finish gate. The only thing special about it is where it works.
 *
 * It gets a branch of its OWN (`resolve/<short id of the original>`), never the
 * original's: git grants a branch to exactly one worktree, and the original's
 * worktree holds it — taking it away under a session that may still be standing
 * is the trap AGENTS.md warns about. A fresh branch at the same tip has the same
 * content and costs nothing.
 */
async function startResolver(orig, repo) {
  const setup = resolverSetup()
  if (!setup.harness) return
  const { runDefFromForm } = await import('./run-def.mjs')
  const { setupToFormBody } = await import('./run-def.mjs')
  const { startRun } = await import('./scheduler.mjs')

  const source = orig.resolver_run_id ? getRun(orig.resolver_run_id) : null
  const tipRun = source && await tipOf(source) ? source : orig
  const tip = await tipOf(tipRun) ?? orig.merged_sha
  if (!tip) return

  const attempt = (orig.merge_attempts ?? 0) + 1
  const branch = `resolve/${kurzid(orig.id)}${attempt > 1 ? `-${attempt}` : ''}`
  const made = await sh('git', ['-C', repo.path, 'branch', branch, tip])
  if (!made.ok && !/already exists/i.test(made.stderr)) {
    addEvent(orig.id, 'merge_error', { reason: `branch ${branch}: ${made.stderr.trim()}` })
    return blockRun(orig.id, repo, 'blocked_error', fill(T_BLOCKED_ERROR, {
      branch, base: repo.base_branch, reason: made.stderr.trim().slice(0, 300),
    }))
  }

  const files = await conflictFilesOf(repo, tipRun)
  const check = String(repo.merge_check ?? '').trim()
  const failed = orig.finish_state === 'check_failed' || tipRun.finish_state === 'check_failed'
  const prompt = fill(P_CONFLICT, {
    branch, base: repo.base_branch,
    orig_title: orig.title ?? kurzid(orig.id), orig_id: orig.id,
    reason: failed && check
      ? `the merge check "${check}" failed on the merged result (output below)`
      : 'merge conflict',
    files: formatFiles(files) + (failed && check ? `\n${checkTail(tipRun.id)}` : ''),
    check_line: check ? `Run the merge check and make it pass: \`${check}\`` : 'Run the project\'s tests if it has any.',
    orig_report: truncateReport(orig),
    landed_runs: await landedRuns(repo, orig),
    resolver_extra: setup.prompt.trim()
      ? `\n--- Operator's instructions for conflict runs ---\n${setup.prompt.trim()}` : '',
  })

  const problems = []
  const def = await runDefFromForm({
    ...setupToFormBody(setup),
    prompt,
    branch_mode: 'fest',
    branch_pattern: branch,
    expected_minutes: '30',
    repo_id: String(repo.id),
  }, problems)
  if (problems.length) {
    // A stored setup the run form would refuse is not a resolver — say so once
    // instead of retrying it on every tick.
    addEvent(orig.id, 'merge_error', { reason: `resolver setup: ${problems.join(' · ')}` })
    return blockRun(orig.id, repo, 'blocked_conflict', fill(T_BLOCKED_CONFLICT, {
      branch: branchOf(orig), base: repo.base_branch, attempts: orig.merge_attempts ?? 0,
      files: formatFiles(files), resume_cmd: resumeCommand(orig) ?? worktreeHint(orig),
    }) + `\nThe conflict resolver's setup is not usable: ${problems.join(' · ')}`)
  }
  def.flows = null

  const title = `Resolve conflicts: ${orig.title ?? kurzid(orig.id)}`.slice(0, TITLE_MAX)
  const r = await startRun(def, { repoId: repo.id, title })
  if (!r.ok || !r.runId) {
    addEvent(orig.id, 'merge_error', { reason: r.error ?? 'resolver start failed' })
    return blockRun(orig.id, repo, 'blocked_error', fill(T_BLOCKED_ERROR, {
      branch, base: repo.base_branch, reason: String(r.error ?? 'resolver start failed').slice(0, 300),
    }))
  }
  markAsResolver(r.runId, orig.id)
  db.prepare(`UPDATE runs SET resolver_run_id=?, merge_attempts=merge_attempts+1,
              merge_status='resolving' WHERE id=?`).run(r.runId, orig.id)
  addEvent(orig.id, 'resolver_started', { run_id: r.runId, branch, attempt })
  await notifyRun(orig.id, 'resolving', fill(T_RESOLVING, {
    title: orig.title ?? kurzid(orig.id), base: repo.base_branch,
    resolver_short: kurzid(r.runId), branch, attempt,
    max: Math.max(0, repo.merge_max_attempts ?? 2),
  }))
}

/**
 * Stamp a fresh run as the integrator's tool. Both dispatch flags are set HERE
 * and not when it ends: a flow must not fire for a run nobody asked for, and
 * those flags are exactly what the triggers poll on. The merge of a conflict run
 * belongs to the run it worked FOR — `dispatchMerges()` skips it for the same
 * reason, so the two sides agree rather than depend on each other.
 */
function markAsResolver(runId, origId) {
  db.prepare(`UPDATE runs SET resolves_run_id=?, flows=NULL,
              flow_dispatched=1, merge_dispatched=1 WHERE id=?`).run(origId, runId)
}

function checkTail(runId) {
  const ev = db.prepare(`SELECT payload FROM events WHERE run_id=? AND kind='finish_check_failed' ORDER BY id DESC LIMIT 1`).get(runId)
  try { return JSON.parse(ev?.payload ?? '{}').tail ?? '' } catch { return '' }
}

/** The original's report as context — capped, and saying so where it was cut. */
export function truncateReport(run, max = 20 * 1024) {
  const text = String(run.report_md ?? '')
  if (text.length <= max) return text || '(no report)'
  return text.slice(0, max) + `\n[… truncated by Freilauf, full report: ${join(RUNS_DIR, run.id, 'report.md')}]`
}

/**
 * A conflict run that ended without delivering. Not silently 'nothing': the
 * original would then hang in 'resolving' forever. Either the branch merges by
 * itself by now, or the next attempt is due.
 */
export async function resolverEnded(resolverRun) {
  const origId = resolverRun.resolves_run_id
  if (!origId) return
  const orig = getRun(origId)
  if (!orig || orig.merge_status === 'merged') return
  await escalate(origId, 'resolver_failed')
}

// ------------------------------------------------- failed / aborted: assess

/**
 * What a run that did NOT end with 'done' left behind. Two git calls, and no
 * merge under any circumstance: whether a failed run's work is wanted is a
 * human's decision, and the detail page has the buttons for it.
 * Returns the status, or null when there is nothing to judge.
 */
export async function assessUnmerged(runId) {
  const run = getRun(runId)
  if (!run) return null
  const repo = getRepo(run.repo_id)
  if (!hubMerges(repo) || !run.worktree || !existsSync(run.worktree)) return null
  // A conflict run leaves nothing behind that is anybody's decision: it either
  // delivered or the original needs another answer.
  if (isResolverRun(run)) { await resolverEnded(run); return null }
  if (!run.base_sha) return null
  const dirty = await dirtyFiles(run, repo)
  const r = await sh('git', ['-C', run.workdir_effective, 'rev-list', '--count', `${run.base_sha}..HEAD`])
  const commits = r.ok ? Number(r.stdout.trim()) || 0 : 0
  const status = classifyUnmerged({ commits, dirty: dirty.length })
  db.prepare('UPDATE runs SET merge_status=? WHERE id=?').run(status, runId)
  addEvent(runId, 'merge_assessed', { status, commits, dirty: dirty.length })
  // Commits nobody merged are commits that must not live on one disk alone.
  if (['unmerged_commits', 'unmerged_both'].includes(status)) await backupBranch(runId)
  return { status, commits, dirty: dirty.length }
}

/** The paragraph that belongs under a failed/aborted notification. */
export function assessText(run, assessment) {
  if (!assessment) return ''
  const body = fill(T_ASSESS[assessment.status] ?? '', { n: assessment.commits, m: assessment.dirty })
  const resume = resumeCommand(run)
  const tail = resume
    ? `Resume the session: ${resume}`
    : `This coding agent's session cannot be resumed; the worktree is at ${run.workdir_effective ?? '?'}.`
  return `${body}\n${tail}`
}

// ---------------------------------------------------------------- resume

/**
 * The shell command a human continues this run's session with — a plugin
 * capability (`resumeCommand(run)`), because only the plugin knows how its CLI
 * names a session. null where the CLI has no answer.
 */
export function resumeCommand(run) {
  try { return getHarness(run?.harness)?.resumeCommand?.(run) ?? null } catch { return null }
}

// ------------------------------------------------------------- manual actions

/**
 * "Merge now" / "Commit leftovers & merge" / "Discard leftovers & merge" from the
 * detail page. An explicit click bypasses the attempt limit — the operator has
 * decided — but still counts, so the history stays honest.
 */
export async function mergeByHand(runId, leftovers = null) {
  const run = getRun(runId)
  if (!run) return { ok: false, error: t('api.unknown_run') }
  const repo = getRepo(run.repo_id)
  if (!repo) return { ok: false, error: t('api.unknown_repo') }
  addEvent(runId, 'merge_manual', { action: leftovers ? `${leftovers}+merge` : 'merge' })

  if (leftovers === 'commit') {
    await sh('git', ['-C', run.workdir_effective, 'add', '-A'])
    // This is the AGENT's worktree, not the operator's checkout — committing
    // here is the hub tidying up after its own run, which is why it is allowed.
    await sh('git', ['-C', run.workdir_effective,
      '-c', 'user.name=Freilauf', '-c', 'user.email=Freilauf@localhost',
      'commit', '-m', `Leftover changes from run ${kurzid(runId)}, committed by Freilauf on the operator's request`])
  } else if (leftovers === 'discard') {
    await sh('git', ['-C', run.workdir_effective, 'checkout', '--', '.'])
    await sh('git', ['-C', run.workdir_effective, 'clean', '-fd'])
  }

  const dirty = await dirtyFiles(run, repo)
  if (dirty.length) {
    db.prepare(`UPDATE runs SET merge_status='blocked_dirty' WHERE id=?`).run(runId)
    return { ok: false, error: t('merge.err_still_dirty') }
  }
  // A branch that was deliberately kept can still be integrated later — the
  // ordinary way, dry run and all. `keep_on_branch` describes what happened
  // automatically at the end of the run, not a verdict for all time.
  db.prepare('UPDATE runs SET keep_on_branch=0 WHERE id=?').run(runId)
  const tip = await tipOf(run)
  if (!tip || tip === run.base_sha) {
    db.prepare(`UPDATE runs SET merge_status='nothing' WHERE id=?`).run(runId)
    return { ok: true, nothing: true }
  }
  await fetchThrottled(repo, Date.now())
  const dry = await mergeDryRun(repo, tip)
  if (dry.conflict) {
    db.prepare(`UPDATE runs SET merge_status='resolving', resolver_run_id=NULL WHERE id=?`).run(runId)
    const setup = resolverSetup()
    if (!setup.harness) {
      db.prepare(`UPDATE runs SET merge_status='blocked_conflict' WHERE id=?`).run(runId)
      return { ok: false, error: t('merge.err_no_resolver') }
    }
    await startResolver(getRun(runId), repo)
    return { ok: true, resolving: true }
  }
  if (dry.error) return { ok: false, error: dry.error }
  enqueueIntegration(runId, { manual: true })
  return { ok: true, merging: true }
}

/** "Skip merge": the operator has decided this one stays where it is. */
export function skipMerge(runId) {
  db.prepare(`UPDATE runs SET merge_status='skipped_by_operator' WHERE id=?`).run(runId)
  addEvent(runId, 'merge_manual', { action: 'skip' })
  for (const v of offeneVorfaelle(runId)) {
    if (v.typ === 'merge_blocked') vorfallVerwerfen(v.id, 'skipped by the operator')
  }
}

/** Retry clears every trace of the integration — the run starts over. */
export function resetIntegration(runId) {
  db.prepare(`UPDATE runs SET finish_state=NULL, finish_started_at=NULL, merge_status=NULL,
              merged_sha=NULL, merged_at=NULL, resolver_run_id=NULL, followup_open=0 WHERE id=?`).run(runId)
  nextCheckAt.delete(runId)
  lastTip.delete(runId)
  lastMessage.delete(runId)
}

/** Test hook: forget the in-memory schedule so a check happens on the next tick. */
export function _resetState() {
  fetchedAt.clear(); lastTip.clear(); nextCheckAt.clear(); lastMessage.clear()
  chains.clear(); queued.clear(); pushFails.clear()
}
