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
  '- At the end ALWAYS: `cc-report done --file <report.md>` (what was done, what is open, what',
  '  should be reviewed). Without this call the run counts as not finished.',
  '- On failure: `cc-report failed "<reason>"`.',
  'Do not end the session yourself after the report; the platform cleans up.',
].join('\n')

export function platformSuffix(run, branchRule, settings) {
  const tpl = settings.prompt_suffix || DEFAULT_SUFFIX
  return tpl
    .replaceAll('{run_id}', run.id)
    .replaceAll('{workdir}', run.workdir_effective)
    .replaceAll('{branch_rule}', branchRule)
    .replaceAll('{expected_minutes}', String(run.expected_minutes))
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
  expectedMinutes, skills = null }) {
  if (!getHarness(harness)) throw new Error(t('run.unknown_harness', { harness }))
  if (!isHarnessEnabled(harness)) throw new Error(t('run.harness_not_configured', { harness }))
  if (!prompt?.trim()) throw new Error(t('run.empty_prompt'))
  const id = randomUUID()
  db.prepare(`INSERT INTO runs(id, repo_id, agent_id, status, harness, model, provider, or_provider,
              effort, prompt, prompt_extra, branch_mode, branch_pattern, expected_minutes, skills, last_activity_at)
              VALUES(?,?,?, 'running', ?,?,?,?,?,?,?,?,?,?,? , datetime('now'))`)
    .run(id, repoId, agentId, harness, model, provider, orProvider, effort, prompt, promptExtra,
      branchMode, branchPattern, expectedMinutes, skills)
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
  const fullPrompt = [run.prompt, run.prompt_extra?.trim(),
    skillPromptZusatz(run.skills),
    platformSuffix({ ...run, id: runId, workdir_effective: workdir }, branchRule, settings).trim()]
    .filter(Boolean).join('\n\n')
  writeFileSync(join(runDir, 'prompt.md'), fullPrompt, { mode: 0o600 })

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
