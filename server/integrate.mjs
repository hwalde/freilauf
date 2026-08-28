// cc-hub — integration: a run is done when its work is on the base branch.
//
// Before this module a run ended when the agent called `cc-report done`. What it
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
//                     as the last step a human, with an incident and Telegram.
//
// All of it is off unless the repo says `merge_mode='hub'`.
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import db, { getRepo, getRun, addEvent, getSetting } from './db.mjs'
import { RUNS_DIR, kurzid, sh, sendToSession, parseDbUtc } from './util.mjs'
import { harnessOwnedPaths, applyExtras } from './runner.mjs'
import { notifyRun, doneText } from './reports.mjs'
import { vorfallMelden, offeneVorfaelle, vorfallVerwerfen } from './incidents.mjs'
import { getHarness } from './harnesses/index.mjs'
import { fallbackTitle, TITLE_MAX } from './title.mjs'

export const INTEGRATE_DIR = process.env.CCHUB_INTEGRATE_DIR ?? join(homedir(), 'agents', 'integrate')

/** The states the check loop owns. 'merging' belongs to the integrator alone. */
const LOOP_STATES = ['checking', 'awaiting_commit', 'awaiting_merge', 'check_failed']

/** At most two git checks at a time — a repo with ten runs finishing must not fork twenty. */
const CHECK_PARALLEL = Number(process.env.CCHUB_FINISH_PARALLEL ?? 2) || 2

// ---------------------------------------------------------------- the texts
//
// Constants with {placeholders}, like PLATFORM_RULES in runner.mjs: these go to
// an AGENT or to Telegram, not to the UI — they are never translated.

export const M1 = `cc-hub: report received — but the run is NOT finished yet.
Your worktree has uncommitted changes:
{files}
A run is only done when its work is committed. Either commit them (\`git add … && git commit\`) or discard them if they are not part of the work (\`git checkout -- <file>\`, \`git clean -f <file>\`). Do not move files outside the worktree to get around this.
Then run \`cc-report done --file {report_file}\` again. cc-hub re-checks every few seconds and closes the run as soon as the worktree is clean; after {timeout} minutes it escalates to the operator.`

export const M2 = `cc-hub: report received — but the run is NOT finished yet.
Your branch cannot be merged into {base}: origin/{base} has moved, and the merge conflicts in
{files}
Resolve it now, while you still know what you changed and why:
  git fetch origin && git merge origin/{base}
Resolve every conflict so that BOTH intentions survive — yours and what already landed on {base} (listed below). Then run the tests, commit the merge, push if your branch has an upstream, and run \`cc-report done --file {report_file}\` again.
Do NOT merge into or push to {base} yourself: cc-hub merges your branch once it is clean.
Landed on {base} since you started:
{landed_runs}`

export const M3 = `cc-hub: report received. Worktree clean, branch mergeable — cc-hub is merging it into {base} now. Nothing more to do; stay in this session.`

export const M4 = `cc-hub: your branch merges cleanly into {base}, but the merge check failed on the merged result:
  $ {merge_check}
{output_tail}
Fix the cause on your branch (fetch and merge origin/{base} first if you have not), commit, and run \`cc-report done --file {report_file}\` again.`

export const M5A = `cc-hub: {base} has moved — run "{title}" was merged ({sha7}). It changed files you are working on too:
{overlap_files}
Bring the change in now, before you build further on the old state:
  git fetch origin && git merge origin/{base}
Resolve conflicts so that both intentions survive, then continue with your task.`

export const M5B = `cc-hub: FYI — {base} has moved: run "{title}" was merged ({sha7}), {n} file(s) changed, none of them touched by you so far. No action needed now. As usual, merge origin/{base} into your branch before you report done.`

export const P_CONFLICT = `Your task: make the branch \`{branch}\` mergeable into \`{base}\` again.

A previous run — "{orig_title}" (cc-hub run {orig_id}) — did the work on this branch and has ended. The branch cannot be merged into origin/{base}: {reason}. Files involved:
{files}

Do this:
1. \`git fetch origin && git merge origin/{base}\`
2. Resolve every conflict so that BOTH intentions survive: what the previous run wanted (its report is below) and what already landed on {base} (listed below). Do not drop either side just to make the conflict disappear. If the two really cannot coexist, stop and ask: \`cc-report help "<what conflicts and why>"\`.
3. {check_line}
4. Commit the merge. Keep the branch's history: no rebase, no force-push. Push if the branch has an upstream.
5. Report done as described in the platform rules. cc-hub merges the branch into {base} itself — never push to {base} yourself.

--- Report of the previous run ---
{orig_report}

--- Landed on {base} since the branch started ---
{landed_runs}
{resolver_extra}`

/** Telegram, one paragraph per assessment of a run that did NOT end with done. */
export const T_ASSESS = {
  unmerged_commits: 'Not merged — the run did not end with done. The branch has {n} commit(s) and no uncommitted changes, so git could merge them safely. But look first: a failed run\'s work is not automatically wanted. To merge anyway, use "Merge now" on the run\'s detail page.',
  unmerged_both: 'Not merged. The branch has {n} commit(s), BUT the worktree also has {m} uncommitted file(s). Nothing was merged. On the detail page you can commit or discard the leftovers and merge, or leave everything as it is.',
  unmerged_dirty: 'Nothing to merge: no commits, but {m} uncommitted file(s) in the worktree. They stay there until you decide — detail page: commit & merge, or discard.',
  nothing: 'Nothing to merge: no commits and no uncommitted changes.',
}

export const T_BLOCKED_DIRTY = `🔴 Finished with uncommitted changes and did not clean up within {timeout} min:
{files}
Nothing was merged. Decide on the detail page: commit & merge, discard & merge, or skip.
Attach: tmux attach -t ={session}
Resume: {resume_cmd}`

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
  const r = await sh('git', ['-C', run.workdir_effective, 'status', '--porcelain', '--no-optional-locks'])
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
 * to read it: the cc-hub runs whose merge commits sit in that range, newest
 * first. A range with no cc-hub run in it says so instead of staying blank —
 * "nothing changed" and "somebody pushed by hand" are different facts.
 */
export async function landedRuns(repo, run, max = 5) {
  const base = run.base_sha
  if (!base) return '- (no cc-hub runs; changes came from outside)'
  const r = await sh('git', ['-C', repo.path, 'rev-list', `${base}..origin/${repo.base_branch}`])
  if (!r.ok) return '- (no cc-hub runs; changes came from outside)'
  const shas = new Set(r.stdout.split('\n').map(s => s.trim()).filter(Boolean))
  if (!shas.size) return '- (no cc-hub runs; changes came from outside)'
  const rows = db.prepare(`SELECT id, title, merged_sha, report_md FROM runs
    WHERE repo_id=? AND merged_sha IS NOT NULL ORDER BY merged_at DESC LIMIT 50`).all(repo.id)
  const lines = []
  for (const row of rows) {
    if (!shas.has(row.merged_sha)) continue
    const summary = fallbackTitle(row.report_md ?? '', 160) || '(no report)'
    lines.push(`- "${row.title ?? kurzid(row.id)}" (${row.merged_sha.slice(0, 7)}): ${summary}`)
    if (lines.length >= max) break
  }
  return lines.length ? lines.join('\n') : '- (no cc-hub runs; changes came from outside)'
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
 * `via='http'` means the agent is standing in its `cc-report` call right now:
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
 *                             in the Telegram text saying so
 */
export async function finishGate(runId, text, via = 'http') {
  const run = getRun(runId)
  if (!run) return null
  const repo = getRepo(run.repo_id)
  if (!hubMerges(repo) || !run.workdir_effective || !existsSync(run.workdir_effective)) return null

  // The report is safe from this moment on, whatever the agent does next.
  const first = !run.finish_state
  db.prepare(`UPDATE runs SET report_md=COALESCE(?, report_md), finish_state='checking',
              finish_started_at=COALESCE(finish_started_at, datetime('now')) WHERE id=?`)
    .run(text || null, runId)
  if (first) addEvent(runId, 'finish_started', {})

  const fresh = getRun(runId)
  const result = await runFinishCheck(fresh, { force: true })
  return applyCheckResult(fresh, repo, result, via)
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
export function startIntegrator() {
  if (timer) return
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
    '-c', 'user.name=cc-hub', '-c', 'user.email=cc-hub@localhost',
    'merge', '--no-ff', '-m', `Merge run ${kurzid(runId)}: ${title}\n\ncc-hub run ${runId}`, tip])
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
 * point of this module — and only now does Telegram hear about it, the other
 * agents of the repo learn that the base branch moved, and the flows fire.
 */
async function finishMerged(runId, tip, repo, { mergedSha = null, beforeSha = null, dir = null, already = false } = {}) {
  const sha = mergedSha ?? tip
  db.prepare(`UPDATE runs SET merge_status='merged', merged_sha=?, merged_at=datetime('now'),
              finish_state=NULL, status='done', ended_at=COALESCE(ended_at, datetime('now')) WHERE id=?`)
    .run(tip, runId)
  addEvent(runId, 'merged', already ? { already: true, sha: tip } : { sha })
  nextCheckAt.delete(runId)
  lastTip.delete(runId)

  const run = getRun(runId)
  const line = `Merged into ${repo.base_branch}: ${String(tip).slice(0, 7)}`
  await notifyRun(runId, 'done', doneText(run, run.report_md, line),
    { fileName: `report-${runId.slice(0, 8)}.md`, fileContent: run.report_md ?? '' })

  // A conflict run works FOR another run: the result counts for both, and the
  // original — which has been sitting in 'resolving' without a done message —
  // gets its own now.
  if (run.resolves_run_id) {
    const orig = getRun(run.resolves_run_id)
    if (orig) {
      db.prepare(`UPDATE runs SET merge_status='merged', merged_sha=?, merged_at=datetime('now') WHERE id=?`)
        .run(tip, orig.id)
      addEvent(orig.id, 'merged', { sha: tip, by_resolver: runId })
      closeMergeIncidents(orig.id)
      const fresh = getRun(orig.id)
      await notifyRun(orig.id, 'done', doneText(fresh, fresh.report_md,
        `Merged into ${repo.base_branch}: ${String(tip).slice(0, 7)} (by conflict run ${kurzid(runId)})`),
      { fileName: `report-${orig.id.slice(0, 8)}.md`, fileContent: fresh.report_md ?? '' })
    }
  }
  closeMergeIncidents(runId)

  if (!already && mergedSha && dir) await notifyBaseMoved(repo, run, { beforeSha, mergedSha, dir })

  // Flows see a run whose work really is on the base branch.
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
async function notifyBaseMoved(repo, mergedRun, { beforeSha, mergedSha, dir }) {
  if (!repo.notify_running) return
  const changed = new Set()
  if (beforeSha && mergedSha) {
    const r = await sh('git', ['-C', dir, 'diff', '--name-only', `${beforeSha}..${mergedSha}`])
    if (r.ok) for (const f of r.stdout.split('\n').map(s => s.trim()).filter(Boolean)) changed.add(f)
  }
  const targets = db.prepare(`SELECT * FROM runs WHERE repo_id=? AND status='running'
    AND tmux_session IS NOT NULL AND tmux_closed_at IS NULL AND id<>?`).all(repo.id, mergedRun.id)
  const ids = [], urgentIds = []
  for (const other of targets) {
    if (other.id === mergedRun.resolves_run_id) continue
    if (other.resolves_run_id === mergedRun.id) continue
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
  const wasWaiting = !!run.finish_state
  const dirty = await dirtyFiles(run, repo)

  if (wasWaiting) {
    db.prepare(`UPDATE runs SET finish_state=NULL, status='done',
                ended_at=COALESCE(ended_at, datetime('now')) WHERE id=?`).run(runId)
  }
  nextCheckAt.delete(runId)
  addEvent(runId, 'finish_escalated', { reason })

  if (reason === 'blocked_no_remote') {
    return blockRun(runId, repo, 'blocked_no_remote', fill(T_BLOCKED_ERROR, {
      branch: branchOf(run), base: repo.base_branch,
      reason: 'the repository has no origin remote — cc-hub never merges in the operator\'s checkout',
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

/** The whole "needs a human" step: status, incident, Telegram. */
async function blockRun(runId, repo, status, text) {
  db.prepare(`UPDATE runs SET merge_status=? WHERE id=?`).run(status, runId)
  addEvent(runId, 'merge_blocked', { status })
  await vorfallMelden(runId, {
    typ: 'merge_blocked', quelle: 'integrate', schwere: 'rot',
    beleg: `${status}: ${branchOf(getRun(runId))} → ${repo.base_branch}`,
  })
  await notifyRun(runId, 'merge_blocked', text)
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
  db.prepare('UPDATE runs SET resolves_run_id=? WHERE id=?').run(orig.id, r.runId)
  db.prepare(`UPDATE runs SET resolver_run_id=?, merge_attempts=merge_attempts+1,
              merge_status='resolving' WHERE id=?`).run(r.runId, orig.id)
  addEvent(orig.id, 'resolver_started', { run_id: r.runId, branch, attempt })
  await notifyRun(orig.id, 'resolving', fill(T_RESOLVING, {
    title: orig.title ?? kurzid(orig.id), base: repo.base_branch,
    resolver_short: kurzid(r.runId), branch, attempt,
    max: Math.max(0, repo.merge_max_attempts ?? 2),
  }))
}

function checkTail(runId) {
  const ev = db.prepare(`SELECT payload FROM events WHERE run_id=? AND kind='finish_check_failed' ORDER BY id DESC LIMIT 1`).get(runId)
  try { return JSON.parse(ev?.payload ?? '{}').tail ?? '' } catch { return '' }
}

/** The original's report as context — capped, and saying so where it was cut. */
export function truncateReport(run, max = 20 * 1024) {
  const text = String(run.report_md ?? '')
  if (text.length <= max) return text || '(no report)'
  return text.slice(0, max) + `\n[… truncated by cc-hub, full report: ${join(RUNS_DIR, run.id, 'report.md')}]`
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
  if (!hubMerges(repo) || !run.workdir_effective || !existsSync(run.workdir_effective)) return null
  if (!run.base_sha) return null
  const dirty = await dirtyFiles(run, repo)
  const r = await sh('git', ['-C', run.workdir_effective, 'rev-list', '--count', `${run.base_sha}..HEAD`])
  const commits = r.ok ? Number(r.stdout.trim()) || 0 : 0
  const status = classifyUnmerged({ commits, dirty: dirty.length })
  db.prepare('UPDATE runs SET merge_status=? WHERE id=?').run(status, runId)
  addEvent(runId, 'merge_assessed', { status, commits, dirty: dirty.length })
  return { status, commits, dirty: dirty.length }
}

/** The paragraph that belongs under a failed/aborted Telegram message. */
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
  if (!run) return { ok: false, error: 'unknown run' }
  const repo = getRepo(run.repo_id)
  if (!repo) return { ok: false, error: 'unknown repo' }
  addEvent(runId, 'merge_manual', { action: leftovers ? `${leftovers}+merge` : 'merge' })

  if (leftovers === 'commit') {
    await sh('git', ['-C', run.workdir_effective, 'add', '-A'])
    // This is the AGENT's worktree, not the operator's checkout — committing
    // here is the hub tidying up after its own run, which is why it is allowed.
    await sh('git', ['-C', run.workdir_effective,
      '-c', 'user.name=cc-hub', '-c', 'user.email=cc-hub@localhost',
      'commit', '-m', `Leftover changes from run ${kurzid(runId)}, committed by cc-hub on the operator's request`])
  } else if (leftovers === 'discard') {
    await sh('git', ['-C', run.workdir_effective, 'checkout', '--', '.'])
    await sh('git', ['-C', run.workdir_effective, 'clean', '-fd'])
  }

  const dirty = await dirtyFiles(run, repo)
  if (dirty.length) {
    db.prepare(`UPDATE runs SET merge_status='blocked_dirty' WHERE id=?`).run(runId)
    return { ok: false, error: 'worktree still has uncommitted changes' }
  }
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
      return { ok: false, error: 'conflict, and no conflict resolver configured (Settings → Merge)' }
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
              merged_sha=NULL, merged_at=NULL, resolver_run_id=NULL WHERE id=?`).run(runId)
  nextCheckAt.delete(runId)
  lastTip.delete(runId)
  lastMessage.delete(runId)
}

/** Test hook: forget the in-memory schedule so a check happens on the next tick. */
export function _resetState() {
  fetchedAt.clear(); lastTip.clear(); nextCheckAt.clear(); lastMessage.clear()
  chains.clear(); queued.clear(); pushFails.clear()
}
