// cc-hub — run creation: run directory, worktree, prompt suffix, start via
// cc-start (the single start path, so CLI and UI produce identical runs —
// planning §5).
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, cpSync, symlinkSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import db, { getRepo, addEvent } from './db.mjs'
import { RUNS_DIR, WORKTREES_DIR, kurzid, sh } from './util.mjs'
import { claudeQuota, openrouterCredits } from './quota.mjs'
import { skillPromptZusatz } from './zusaetze.mjs'
import { getHarness } from './harnesses/index.mjs'
import { isHarnessEnabled } from './coding-agents.mjs'
import { t } from './i18n.mjs'

const DEFAULT_SUFFIX = [
  '---',
  'Platform rules (cc-hub, run {run_id}):',
  '- Working directory: {workdir}. Branch rule: {branch_rule}.',
  '- Expected maximum working time: {expected_minutes} min. If you need considerably longer,',
  '  report it: `cc-report progress "<where you stand, why longer>"`.',
  '- If you create a branch or pull request, report it immediately:',
  '  `cc-report branch <name>` or `cc-report pr <url>`.',
  '- If you need a human decision or discovered a big problem:',
  '  `cc-report help "<question/problem>"` — then WAIT for the answer in this session.',
  '- On failure: `cc-report failed "<reason>"`.',
  '',
  'HOW THIS RUN ENDS — two commands, and they are not optional:',
  '  1. Write your report to {report_file} — what was done, what is open,',
  '     what should be reviewed. That path is outside the repository on purpose:',
  '     a report file inside the working directory would leave it dirty.',
  '  2. Run: cc-report done --file {report_file}',
  '  3. Only then stop. Do not end the session yourself; the platform cleans up.',
  'Printing a summary is NOT a report — nobody reads your terminal. Only step 2 tells',
  'the platform the run is finished; without it a human has to close it by hand.',
].join('\n')

/**
 * The prompt block that turns a task into a RUN: where to work, how long it may
 * take, and above all how to report back. The reporting contract stands at the
 * end and on its own, because that is the part runs actually fail on — a
 * forgotten `cc-report done` leaves the run on 'running' forever and blocks
 * everything queued behind it.
 *
 * `settings.prompt_suffix` REPLACES this template (that is what the field under
 * Settings is for). The harness's own lines are appended afterwards either way:
 * they describe the machine the agent is running on, not the operator's house
 * rules, and cursor in particular needs them (harnesses/cursor.mjs).
 */
export function platformSuffix(run, branchRule, settings) {
  const tpl = settings.prompt_suffix || DEFAULT_SUFFIX
  const rules = getHarness(run.harness)?.promptRules
  return [tpl, rules].filter(Boolean).join('\n\n')
    .replaceAll('{run_id}', run.id)
    .replaceAll('{workdir}', run.workdir_effective)
    .replaceAll('{report_file}', join(RUNS_DIR, run.id, 'report.md'))
    .replaceAll('{branch_rule}', branchRule)
    .replaceAll('{expected_minutes}', String(run.expected_minutes))
}

/** Path of cc-report as the hub knows it — hook commands must not depend on PATH. */
export function ccReportPath() {
  return process.env.CCHUB_CC_REPORT ?? `${homedir()}/.local/bin/cc-report`
}

/**
 * Hook files a harness needs inside its workspace (cursor: `.cursor/hooks.json`,
 * the only way it reports the end of a turn). Written before the start and never
 * over an existing file: a repository may bring its own hooks, and overwriting
 * them would be the hub silently disabling somebody else's tooling. The run then
 * loses the hook channel but not the end detection — the cursor transcript
 * (server/cursor-transcript.mjs) reports it too.
 *
 * Returns the paths actually written, relative to the workdir.
 */
export function writeHarnessHooks(harness, workdir) {
  const files = getHarness(harness)?.hookFiles?.({ ccReport: ccReportPath() }) ?? []
  const written = []
  for (const f of files) {
    const target = join(workdir, f.path)
    if (existsSync(target)) continue
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, f.content, { mode: 0o600 })
    written.push(f.path)
  }
  return written
}

/**
 * Top-level entries the hub itself put into a worktree. The cleanup has to know
 * them: `.cursor/hooks.json` is ours, not the agent's work, and counting it as
 * "uncommitted changes" would keep the worktree from ever being removed (the
 * same trap the worktree extras once fell into).
 */
export function harnessOwnedPaths(harness) {
  return (getHarness(harness)?.hookFiles?.({ ccReport: 'x' }) ?? [])
    .map(d => String(d.path).split('/')[0])
}

/**
 * Prompt addition for the repo's per-repo prompt (repos.prompt): instructions
 * that apply to EVERY run of this repo — agents and single runs alike. Kept as
 * its own labeled section so the agent can tell repo-wide context from the task
 * and the platform rules. Read live at launch, like base_branch and
 * worktree_extras: repo config is not snapshotted into the run.
 */
export function repoPromptZusatz(prompt) {
  const text = String(prompt ?? '').trim()
  if (!text) return ''
  return `Repository context (applies to every run of this repo):\n${text}`
}

function expandPattern(pattern, run) {
  return String(pattern || '')
    .replaceAll('{date}', new Date().toISOString().slice(0, 10).replaceAll('-', ''))
    .replaceAll('{agent}', run.agent_name || 'single')
    .replaceAll('{kurz}', kurzid(run.id))
}

/**
 * Which worktree holds a branch? git grants a branch to exactly ONE worktree; a
 * second 'worktree add' on it dies with "'main' is already used by worktree at
 * …". The classic case: expectation "fixed branch" with the base branch, which
 * the main repo itself has checked out — the run then failed with git's raw
 * message. One git call beforehand turns that into a sentence the operator can
 * act on (and the forms use the same check, see pages.mjs).
 * Returns the path of the occupying worktree, otherwise null.
 */
export async function branchWorktree(repoPath, branch) {
  if (!branch) return null
  const r = await sh('git', ['-C', repoPath, 'worktree', 'list', '--porcelain'])
  if (!r.ok) return null
  let current = null
  for (const line of r.stdout.split('\n')) {
    // Porcelain: a block per worktree, 'worktree <path>' first, then optionally
    // 'branch refs/heads/<name>' (missing when the worktree is detached).
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length).trim()
    else if (line.trim() === `branch refs/heads/${branch}`) return current
  }
  return null
}

async function makeWorktree(repo, run, branchName) {
  const wtRoot = join(WORKTREES_DIR, repo.name)
  mkdirSync(wtRoot, { recursive: true })
  await sh('git', ['-C', repo.path, 'worktree', 'prune'])
  await sh('git', ['-C', repo.path, 'fetch', 'origin'])
  const base = repo.base_branch
  const target = join(wtRoot, `${kurzid(run.id)}-${(branchName || 'detached').replace(/\//g, '-')}`)
  // Retry of a failed run: the worktree from before is still there.
  // 'git worktree add' would fail on it — so reuse what already stands.
  if (existsSync(target)) return target
  // Checked AFTER 'worktree prune': a leftover registration of a long-deleted
  // worktree must not block the branch.
  const occupied = await branchWorktree(repo.path, branchName)
  if (occupied) throw new Error(t('run.branch_in_use', { branch: branchName, worktree: occupied }))
  let r
  if (run.branch_mode === 'keiner') {
    r = await sh('git', ['-C', repo.path, 'worktree', 'add', '--detach', target, `origin/${base}`])
  } else {
    // Use an existing local branch — for "fixed" that is the point, for "new"
    // it makes the retry of a run whose worktree was already cleaned up work.
    const have = await sh('git', ['-C', repo.path, 'show-ref', '--verify', '--quiet', `refs/heads/${branchName}`])
    if (have.ok) {
      r = await sh('git', ['-C', repo.path, 'worktree', 'add', target, branchName])
    } else {
      // A branch that so far only exists on origin starts from THERE, not from
      // the base branch — otherwise the run would build on a foreign history
      // and the first push would bounce off as non-fast-forward.
      const remote = await sh('git', ['-C', repo.path, 'show-ref', '--verify', '--quiet', `refs/remotes/origin/${branchName}`])
      const start = remote.ok ? `origin/${branchName}` : `origin/${base}`
      r = await sh('git', ['-C', repo.path, 'worktree', 'add', '-b', branchName, target, start])
    }
  }
  if (!r.ok) throw new Error(`git worktree failed: ${r.stderr.trim()}`)
  // Worktree extras (planning 4.0): copy or link.
  for (const extra of repo.extras ?? []) {
    const src = resolve(repo.path, extra.path)
    const dst = resolve(target, extra.path)
    if (!existsSync(src) || existsSync(dst)) continue
    mkdirSync(join(dst, '..'), { recursive: true })
    if (extra.mode === 'link') symlinkSync(src, dst)
    else cpSync(src, dst, { recursive: true })
  }
  return target
}

/**
 * Claude Code hook format: EVERY event is a list of
 * { matcher?, hooks: [{ type, command }] } — a bare command list is rejected.
 * And not just partially: a faulty settings file is discarded COMPLETELY
 * ("Files with errors are skipped entirely") and the run hangs at an
 * interactive dialog. That would take down the whole reporting chain.
 */
export function claudeSettingsJson() {
  const hook = (cmd) => [{ hooks: [{ type: 'command', command: cmd }] }]
  return JSON.stringify({
    hooks: {
      Stop: hook('cc-report _turn_end'),
      SessionEnd: hook('cc-report _exit'),
      Notification: hook('cc-report _idle'),
      // Rate limit, overloaded, auth, billing …: Claude names the reason as a
      // fixed enum on stdin. Verified with Claude Code 2.1.241 (simulated 429
      // with anthropic-ratelimit-unified-status: rejected → error: "rate_limit").
      // NOTE: Claude does NOT wait for this hook — the process is gone within
      // 100 ms and takes the hook with it (measured: 'cat' gets through,
      // 'sleep 0.1' does not). Hence 'setsid -f': cc-report keeps running
      // detached in its own session and reads the event from the inherited
      // stdin pipe.
      StopFailure: hook('setsid -f cc-report _api_error >/dev/null 2>&1'),
    },
  })
}

/** Creates the run record (definition copy) and returns the run ID. */
export function createRun({ repoId, agentId = null, harness, model = null, provider = null,
  orProvider = null, effort = null, prompt, promptExtra = null, branchMode, branchPattern = null,
  expectedMinutes, skills = null, flows = null, title = null }) {
  if (!getHarness(harness)) throw new Error(t('run.unknown_harness', { harness }))
  if (!isHarnessEnabled(harness)) throw new Error(t('run.harness_not_configured', { harness }))
  if (!prompt?.trim()) throw new Error(t('run.empty_prompt'))
  const id = randomUUID()
  db.prepare(`INSERT INTO runs(id, repo_id, agent_id, status, harness, model, provider, or_provider,
              effort, prompt, prompt_extra, branch_mode, branch_pattern, expected_minutes, skills, flows,
              title, last_activity_at)
              VALUES(?,?,?, 'running', ?,?,?,?,?,?,?,?,?,?,?,?,? , datetime('now'))`)
    .run(id, repoId, agentId, harness, model, provider, orProvider, effort, prompt, promptExtra,
      branchMode, branchPattern, expectedMinutes, skills, flows, title)
  return id
}

/**
 * Model/provider arguments for the chosen harness — delegated to the coding
 * agent plugin. Without a provider (legacy rows) 'model' goes out verbatim as
 * before.
 */
export function harnessModelArgs(run) {
  const plugin = getHarness(run.harness)
  return plugin ? plugin.modelArgs(run) : { args: [], fehlt: [] }
}

/**
 * Starts a prepared run: worktree, prompt, cc-start.
 * Returns { ok, session?, error? }.
 */
export async function launchRun(runId) {
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId)
  if (!run) throw new Error(`run ${runId} not found`)
  const repo = getRepo(run.repo_id)
  const agent = run.agent_id ? db.prepare('SELECT * FROM agents WHERE id = ?').get(run.agent_id) : null
  const kurz = kurzid(runId)
  const runDir = join(RUNS_DIR, runId)
  mkdirSync(runDir, { recursive: true })

  let workdir = repo.path
  let branchExpected = null
  try {
    if (run.branch_mode === 'neu' || run.branch_mode === 'fest') {
      branchExpected = expandPattern(run.branch_pattern, { ...run, agent_name: agent?.name, id: runId })
    }
    // Every run works in its own worktree — even with expectation "none"
    // (then detached HEAD; throwaway changes; planning 4.0).
    workdir = await makeWorktree(repo, run, branchExpected)
  } catch (err) {
    failRun(runId, `Start failed:\n\n${err.message}`)
    return { ok: false, error: err.message }
  }

  const mainSha = await sh('git', ['-C', repo.path, 'rev-parse', 'HEAD'])
  const settings = Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map(r => [r.key, r.value]))
  const branchRule = run.branch_mode === 'neu'
    ? `Create a new branch, name following the pattern ${branchExpected}.`
    : run.branch_mode === 'fest'
      ? `Work on the existing branch ${branchExpected}.`
      : 'No branch — the worktree is detached; changes are throwaway changes.'
  const fullPrompt = [run.prompt, repoPromptZusatz(repo.prompt), run.prompt_extra?.trim(),
    skillPromptZusatz(run.skills),
    platformSuffix({ ...run, id: runId, workdir_effective: workdir }, branchRule, settings).trim()]
    .filter(Boolean).join('\n\n')
  writeFileSync(join(runDir, 'prompt.md'), fullPrompt, { mode: 0o600 })

  // Hook files into the workspace (cursor: the 'stop' hook that reports the end
  // of a turn). Fail-soft: a run without hooks still works, it just falls back
  // to the transcript for its end detection.
  try {
    const hooks = writeHarnessHooks(run.harness, workdir)
    if (hooks.length) addEvent(runId, 'hooks_installed', { files: hooks })
  } catch (err) {
    addEvent(runId, 'warn', { hooks: err.message })
  }

  const q = claudeQuota()
  const credits = await openrouterCredits()
  db.prepare(`UPDATE runs SET status='running', workdir_effective=?, worktree=?, branch_expected=?,
              main_sha_start=?, quota5_start=?, quota7_start=? WHERE id=?`)
    .run(workdir, workdir !== repo.path ? workdir : null, branchExpected,
      mainSha.ok ? mainSha.stdout.trim() : null, q.five, q.seven, runId)
  addEvent(runId, 'started', { workdir, harness: run.harness, model: run.model,
    provider: run.provider ?? null, effort: run.effort ?? null })

  const args = ['--harness', run.harness,
    '--name', (agent?.name ?? 'einzel').toLowerCase().replaceAll(/[^a-z0-9_-]/g, '-'),
    '--id', kurz,
    '--env', `CC_RUN_ID=${runId}`,
    '--env', 'CC_HUB_URL=http://127.0.0.1:' + (process.env.CCHUB_LOCAL_PORT ?? '8791'),
    '--log', join(runDir, 'log.txt'), '--keep',
    '-f', join(runDir, 'prompt.md'), workdir]
  const modelArgs = harnessModelArgs(run)
  args.unshift(...modelArgs.args)
  if (modelArgs.fehlt.length) {
    // Better to start and record it visibly than to walk into the knife
    // silently: without a key the run only dies at the agent's first API call.
    addEvent(runId, 'warn', { fehlender_key: modelArgs.fehlt.join(', ') })
  }
  if (run.harness === 'claude') args.unshift('--session-id', runId, '--settings', claudeSettingsJson())

  const r = await sh(process.env.CCHUB_CC_START ?? `${homedir()}/.local/bin/cc-start`, args, { timeout: 120_000 })
  // cc-start's success line ("Session '<name>' started …"); the German wording
  // is still accepted for older installed scripts.
  const m = r.stdout.match(/Session '([^']+)' (?:started|gestartet)/)
  const session = m ? m[1] : null
  if (!r.ok || !session) {
    failRun(runId, `Start failed (cc-start):\n\n${r.stderr || r.stdout}`)
    return { ok: false, error: r.stderr || r.stdout }
  }
  db.prepare('UPDATE runs SET tmux_session=? WHERE id=?').run(session, runId)
  addEvent(runId, 'tmux_started', { session })
  return { ok: true, session }
}

export function failRun(runId, text) {
  db.prepare(`UPDATE runs SET status='failed', ended_at=datetime('now'), report_md=? WHERE id=?`)
    .run(text, runId)
  addEvent(runId, 'failed', {})
}
