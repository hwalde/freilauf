// Freilauf — run creation: run directory, worktree, prompt suffix, start via
// fl-start (the single start path, so CLI and UI produce identical runs —
// planning §5).
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, symlinkSync, existsSync, realpathSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import db, { getRepo, addEvent } from './db.mjs'
import { RUNS_DIR, WORKTREES_DIR, kurzid, sh, parseDbUtc } from './util.mjs'
import { claudeQuota, sevenForRun } from './quota.mjs'
import { skillPromptZusatz, zusaetzeDir } from './zusaetze.mjs'
import { deliverGoal } from './goal.mjs'
import { getHarness } from './harnesses/index.mjs'
import { pluginCtx } from './plugins/context.mjs'
import { isHarnessEnabled } from './coding-agents.mjs'
import { branchRuleText } from './run-def.mjs'
import { t } from './i18n.mjs'
import { env } from './env.mjs'

const PLATFORM_RULES = [
  '---',
  'Platform rules (Freilauf, run {run_id}):',
  '- Working directory: {workdir}. Branch rule: {branch_rule}.',
  '- Expected maximum working time: {expected_minutes} min. If you need considerably longer,',
  '  report it: `fl-report progress "<where you stand, why longer>"`.',
  '- If you create a branch or pull request, report it immediately:',
  '  `fl-report branch <name>` or `fl-report pr <url>`.',
  '- If you need a human decision or discovered a big problem:',
  '  `fl-report help "<question/problem>"` — then WAIT for the answer in this session.',
  '- On failure: `fl-report failed "<reason>"`.',
].join('\n')

/**
 * The one extra rule of a repo the hub integrates for (repos.merge_mode='hub').
 * It says the two things an agent cannot know by itself: that somebody else
 * merges, and that resolving a conflict is ITS job while it still knows what it
 * changed. Inserted after the branch line, because that is where the agent is
 * being told what its work lives on.
 */
const MERGE_RULE = '- Integration: when this run ends, Freilauf merges your work into {base} itself. '
  + 'Never merge into or push to {base} yourself. Before you report done: commit everything, '
  + 'then `git fetch origin && git merge origin/{base}` and resolve conflicts — you know your '
  + 'changes best; later nobody will. Freilauf checks your worktree when you report and tells you '
  + 'if something is left.'

/** …and its counterpart in the finishing instruction: the answer is worth reading. */
const MERGE_FINISH_LINE = '     fl-report prints Freilauf\'s answer. If it says the run is not '
  + 'finished yet, do what it says and report again.'

const FINISH_RULES = [
  'HOW THIS RUN ENDS — two commands, and they are not optional:',
  '  1. Write TWO report files, both in simple language:',
  '     {report_file} — the SHORT report: what the task was and the result,',
  '       compact (a few lines to a short paragraph). This is the message text',
  '       the operator receives.',
  '     {report_detail_file} — the DETAILED report: the full write-up — what',
  '       was done, what is open, what should be reviewed. This is what travels',
  '       as the attached document.',
  '     Both paths are outside the repository on purpose: a report file inside',
  '     the working directory would leave it dirty.',
  '  2. Run: fl-report done --file {report_file} --detail {report_detail_file}',
  '  3. Only then stop. Do not end the session yourself; the platform cleans up.',
  'Printing a summary is NOT a report — nobody reads your terminal. Only step 2 tells',
  'the platform the run is finished; without it a human has to close it by hand.',
].join('\n')

/**
 * What happens AFTER the report: the operator reads it, finds something
 * unfinished and types more into this very session. The agent has to know that
 * the same two steps apply again — the same command, deliberately (see
 * reports.mjs, "follow-up reports"): the hub tells a first report from a
 * follow-up by itself, and a second verb would be a second thing to forget.
 * The one rule that is new is the batching one: several requests in one go
 * are ONE report, not one per request — each report reaches a human's phone.
 */
const FOLLOWUP_RULES = [
  'AFTER YOU HAVE REPORTED DONE — follow-up work:',
  'A human may come back into this session and ask for more (a fix, a change, a question).',
  'Do that work as usual. When it is finished — everything committed{followup_merge} — write a',
  'report about ONLY the follow-up work, again as TWO files to the same paths as the first',
  'report: {report_file} (the SHORT version, overwrite it) and {report_detail_file} (the',
  'DETAILED version, overwrite it), then run',
  '  fl-report done --file {report_file} --detail {report_detail_file}',
  'again. It is the same command on purpose: Freilauf knows this run is already over and',
  'treats it as a FOLLOW-UP REPORT — it reaches the human, and it triggers the same',
  'platform processes as the first report{followup_processes}. If the human asked for',
  'several things at once, do all of them and report ONCE at the end, not once per',
  'request: every report is a message to a person. Do not report a mere answer to a',
  'question that changed nothing unless the human asked for a report of it.',
].join('\n')

/** …and the two half sentences that only hold where the hub integrates. */
const FOLLOWUP_MERGE_CLAUSE = ', and origin/{base} merged into your branch once more'
const FOLLOWUP_PROCESSES_CLAUSE = ' (integration into {base}, the flows that hang on this run)'

/**
 * What a sandboxed run is told about the box it is in (SANDBOX_RESEARCH.md
 * §7.12.1). Two halves, and the second is what the whole escalation path hangs
 * on.
 *
 * The first half is FACTS, and they are read from what the run really launched
 * with — the resolved allow list comes out of the same `resolvedAllow()` the
 * proxy is configured from, so the list the agent is told about and the list
 * that is enforced cannot say different things. An agent that knows its network
 * is an allowlist stops treating a 403 as a flaky server.
 *
 * The second half is one sentence the agent can ACT on: report what it needs and
 * carry on with what it can. Without it the only move a blocked agent has is to
 * hit the same wall five times or to work around the boundary — and working
 * around the boundary is precisely what the sandbox exists to prevent. A
 * sentence it can act on beats a wall it hits five times.
 */
const SANDBOX_RULES = [
  'SANDBOX — this run is not on the operator\'s machine directly:',
  '- You are running inside a container. Working copy: {sandbox_workdir} (read-write).',
  '- Network: {sandbox_network}',
  '- Memory {sandbox_memory}, CPU {sandbox_cpus}. The root filesystem is {sandbox_root};',
  '  write inside your working copy, and in /tmp and your home.',
  '- If you need a host, a path or more resources, do NOT try to work around the sandbox:',
  '  run `fl-report access "<what you need and why>"` and carry on with what you CAN do',
  '  meanwhile. A human decides, and where the change can be applied without a restart it',
  '  reaches you while you keep working — where it cannot, your session is resumed with',
  '  your conversation intact. Guessing at a way around the boundary costs the run;',
  '  one sentence of explanation does not.',
].join('\n')

/** How the network half of that block reads, per mode. */
const SANDBOX_NETWORK_TEXT = {
  none: 'no network at all. Anything that needs the internet will fail — say so instead of retrying.',
  open: 'unrestricted.',
  allowlist: 'an allowlist through a proxy — reachable: {sandbox_allow}. Every other host answers 403.',
}

/**
 * The Sandbox section, rendered from what `prepareSandbox()` really produced, or
 * `''` for an unsandboxed run — which is what keeps the prompt of every run on
 * an installation without a sandbox byte for byte what it was.
 */
export function sandboxPromptSection(facts) {
  if (!facts) return ''
  const mode = SANDBOX_NETWORK_TEXT[facts.mode] ? facts.mode : 'allowlist'
  const allow = (facts.allow ?? []).filter(Boolean)
  let network = SANDBOX_NETWORK_TEXT[mode]
    .replace('{sandbox_allow}', allow.length ? allow.join(', ') : '(nothing — every host answers 403)')
  // Audit-only means the policy is being LEARNED rather than enforced: telling
  // the agent hosts are blocked when they are not would make it report access it
  // already has, which is noise on somebody's phone.
  if (facts.auditOnly && mode === 'allowlist') {
    network = `an allowlist that is currently only being recorded, not enforced — expected: ${allow.join(', ') || '(none yet)'}. Requests still go through; report anything you needed that is not on that list.`
  }
  return SANDBOX_RULES
    .replace('{sandbox_workdir}', facts.workdir ?? '(your working directory)')
    .replace('{sandbox_network}', network)
    .replace('{sandbox_memory}', facts.memory ?? 'as configured')
    .replace('{sandbox_cpus}', facts.cpus == null ? 'as configured' : String(facts.cpus))
    .replace('{sandbox_root}', facts.readOnlyRoot ? 'read-only' : 'writable')
}

/**
 * The prompt block that turns a task into a RUN: where to work, how long it may
 * take, and above all how to report back.
 *
 * Five sections in this order, and the order is the point:
 *
 *   1. the platform rules
 *   2. the sandbox, where there is one — a FACT about the machine the agent is
 *      on, so it stands above advice; §7.12.1 puts it in this slot for that
 *      reason, between the platform rules and the harness's own lines
 *   3. the operator's own addition (Settings → Platform prompt suffix)
 *   4. the harness's own lines (`promptRules`) — cursor has to be told that its
 *      turn ending closes the run
 *   5. how the run ends — LAST, because that is what runs actually fail on
 *
 * The finishing instruction is **not removable**, and that is a lesson, not a
 * design preference: the settings field used to REPLACE this whole block. It is
 * called a suffix, it starts out empty and it looks like a free notepad — so the
 * moment somebody wrote their own working rules into it, every prompt on this
 * hub silently lost the sentence "at the end always `fl-report done`". The runs
 * kept working and kept not reporting; one of them held up the queue for a day.
 * Whatever the operator writes is now an ADDITION, placed where it reads like
 * one.
 */
export function platformSuffix(run, branchRule, settings, repo = null, sandboxFacts = null) {
  const own = String(settings.prompt_suffix ?? '').trim()
  const harnessRules = getHarness(run.harness)?.promptRules
  // Only where the hub really integrates. With merge_mode 'off' the prompt is
  // byte for byte what it was before this feature existed.
  const hubMerges = repo?.merge_mode === 'hub'
  const base = repo?.base_branch || 'main'
  // A run that keeps its work on its branch gets the branch sentence and nothing
  // else: it already says the work stays put and that Freilauf will not merge it,
  // and MERGE_RULE would promise the opposite two lines above. Two rules about
  // the same thing is one too many — that is the lesson the whole branch table
  // was written from.
  const rules = hubMerges && !run.keep_on_branch
    ? PLATFORM_RULES.replace('- Expected maximum working time', `${MERGE_RULE}\n- Expected maximum working time`)
    : PLATFORM_RULES
  const finish = hubMerges
    ? FINISH_RULES.replace('  3. Only then stop.', `${MERGE_FINISH_LINE}\n  3. Only then stop.`)
    : FINISH_RULES
  const followUp = FOLLOWUP_RULES
    .replace('{followup_merge}', hubMerges && !run.keep_on_branch ? FOLLOWUP_MERGE_CLAUSE : '')
    .replace('{followup_processes}', hubMerges ? FOLLOWUP_PROCESSES_CLAUSE : '')
  return [rules,
    sandboxPromptSection(sandboxFacts),
    own && `Operator rules (apply to every run of this hub):\n${own}`,
    harnessRules, finish, followUp]
    .filter(Boolean).join('\n\n')
    .replaceAll('{base}', base)
    .replaceAll('{run_id}', run.id)
    .replaceAll('{workdir}', run.workdir_effective)
    .replaceAll('{report_file}', join(RUNS_DIR, run.id, 'report.md'))
    .replaceAll('{report_detail_file}', join(RUNS_DIR, run.id, 'report-detail.md'))
    .replaceAll('{branch_rule}', branchRule)
    .replaceAll('{expected_minutes}', String(run.expected_minutes))
}

/** Path of fl-report as the hub knows it — hook commands must not depend on PATH. */
export function flReportPath() {
  return env('REPORT_SCRIPT') ?? `${homedir()}/.local/bin/fl-report`
}

/**
 * The coding agents `bin/fl-start` spells out itself, in a `case` per harness.
 *
 * That script has to work with no hub behind it — a human runs `fl-start -H
 * opencode` on the command line — so for these four the command line lives
 * there and is the single source of truth. Every OTHER coding agent has no case
 * in that script and never will: it arrives as a plugin, brings a `launch`
 * declaration, and the hub hands that over as a file (`--spec`).
 *
 * This set is therefore the exact shape of a known limit, not a preference: it
 * disappears the day fl-start reads the declaration for all of them, and until
 * then it is what keeps a claude/opencode/hermes/cursor run byte for byte what
 * it always was.
 */
const FL_START_BUILTIN_HARNESSES = new Set(['claude', 'opencode', 'hermes', 'cursor'])

/**
 * The launch declaration handed to `fl-start --spec`, or `null` when the script
 * already knows this coding agent.
 *
 * Resolved rather than passed through: `bin`, `sessionTag` and `installHint`
 * are ordinary descriptor fields, and a plugin that says nothing about them
 * inside `launch` means the ones it declared next to its id. `sessionTag` in
 * particular used to be read by nobody at all — the tmux prefix lived only in
 * fl-start's own case — which is why an external coding agent's sessions would
 * otherwise all have looked like claude's.
 *
 * Written into the run directory, never into the worktree: everything the hub
 * puts inside a worktree it has to clean up again, and a stray file there
 * counts as uncommitted work at the finish gate.
 */
export function launchSpec(harness) {
  if (FL_START_BUILTIN_HARNESSES.has(harness)) return null
  const plugin = getHarness(harness)
  const launch = plugin?.launch
  if (!launch || !Array.isArray(launch.args) || launch.args.length === 0) return null
  const spec = {
    harness,
    bin: launch.bin || plugin.bin,
    sessionTag: launch.sessionTag ?? plugin.sessionTag ?? '',
    installHint: launch.installHint ?? plugin.installHint ?? '',
    promptMode: launch.promptMode || 'argv',
    args: launch.args,
  }
  if (Array.isArray(launch.interactiveArgs)) spec.interactiveArgs = launch.interactiveArgs
  // The resume form: the argv that continues an interrupted conversation
  // (`{resume_id}` + `{prompt}`), used by fl-start `--resume` instead of `args`.
  if (Array.isArray(launch.resume) && launch.resume.length) spec.resume = launch.resume
  if (typeof launch.stderrLog === 'string' && launch.stderrLog) spec.stderrLog = launch.stderrLog
  // Only the object form: fl-start asks jq for `.submitNudge.waitFor`, and a
  // bare `true` would be an error there rather than a default.
  if (launch.submitNudge && typeof launch.submitNudge === 'object') spec.submitNudge = launch.submitNudge
  return spec
}

/**
 * Can this coding agent be started at all? A harness fl-start has no case for
 * and that declares no `launch` would produce a tmux session running nothing —
 * better to say so before a worktree exists than to read it out of fl-start's
 * stderr afterwards.
 */
export function launchable(harness) {
  return FL_START_BUILTIN_HARNESSES.has(harness) || !!launchSpec(harness)
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
  const files = getHarness(harness)?.hookFiles?.({ flReport: flReportPath() }) ?? []
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
  // TASK_DIR is unconditional: it is written before the CLI starts and belongs
  // to the hub, exactly like a hook file. A run that never needed it simply
  // has no such directory, and naming a path that is not there costs nothing —
  // whereas a task file the finish gate counted as the agent's own work would
  // hold every offloaded run at "commit your changes first".
  return [TASK_DIR, ...(getHarness(harness)?.hookFiles?.({ flReport: 'x' }) ?? [])
    .map(d => String(d.path).split('/')[0])]
}

/**
 * Where the task goes when it is too long to be handed to the CLI as an
 * argument, and the sentence that points the agent at it.
 *
 * `opencode --prompt` puts the text into the editor and only sends it off by
 * itself up to a certain length — measured with 1.18.23: ~2 KB goes, ~20 KB
 * stays put. `fl-start` presses Enter once after the TUI has drawn, and that
 * nudge usually saves it; usually is the problem. Measured 2026-09-04, run
 * 1c0076ec: opencode initialised at 23:32:42 and then never created a session
 * at all — no `created`, no `loop`, no `stream`. The tmux session stood, the
 * pane was alive, the hub said `running`, and nothing whatsoever had been
 * asked of the model. That is the most expensive shape a failure can take,
 * because every layer above it reads as healthy.
 *
 * So above a harness-declared size the TASK is written to a file and the CLI
 * gets a SHORT prompt instead: Freilauf's own framing — the platform rules,
 * which are what the run is steered by — plus one sentence naming the file.
 *
 * The file lives INSIDE the worktree, in a hidden directory, and that is the
 * whole point: a coding agent may sandbox itself to its working directory and
 * ask before leaving it (opencode's `external_directory`, see docs/plugins.md),
 * so anything outside is a permission question waiting to happen. Inside the
 * working directory there is no question to answer. `harnessOwnedPaths()`
 * keeps the finish gate from reading it as uncommitted work, and the agent is
 * asked to delete it once it has read it — so the ordinary case leaves nothing
 * behind at all.
 */
export const TASK_DIR = '.freilauf'
export const TASK_FILE = `${TASK_DIR}/task.md`

/**
 * How much shorter the launch prompt has to get before the indirection is worth
 * it. Offloading is not free — it costs the agent a tool call, puts a file in
 * somebody's worktree and adds a step that can be misread — so it has to buy a
 * real saving, not a byte. 1 KB, because that is the order of the pointer
 * itself: below it the two texts are the same size and the trade is pointless.
 */
const MIN_OFFLOAD_SAVING = 1024

export const TASK_POINTER = `# Your actual task

Your actual task is written in the file \`{task_file}\` (relative to your working directory, and the absolute path is \`{task_abs}\`).

Read that file NOW, in full, and follow what it says. It is the task — everything below this line is only the platform's own rules for how the run is reported.

It is a file the platform wrote for you, not part of the repository: delete it as soon as you have read it (\`rm {task_file}\`), and never commit it.`

/**
 * Splits a composed prompt into "what the agent is asked to do" and "how this
 * platform runs it", and offloads the first half to a file when the harness
 * says the whole thing is too long to hand over as an argument.
 *
 * Returns `{ prompt, taskFile }` — `prompt` is what the CLI is launched with,
 * `taskFile` the absolute path of the file that was written, or null when
 * nothing was offloaded. The caller writes the FULL text to the run directory
 * either way: that file is the record of what this run was asked, and it must
 * not start depending on whether an offload happened.
 */
export function offloadPrompt(harness, workdir, task, platform) {
  const ganz = [task, platform].filter(Boolean).join('\n\n')
  const grenze = getHarness(harness)?.launch?.promptFile?.maxBytes
  if (!grenze || Buffer.byteLength(ganz, 'utf8') <= grenze || !task?.trim()) {
    return { prompt: ganz, taskFile: null }
  }
  const abs = join(workdir, TASK_FILE)
  const zeigerText = TASK_POINTER.replaceAll('{task_file}', TASK_FILE).replaceAll('{task_abs}', abs)
  // Only the TASK can be offloaded — the platform framing has to stay inline,
  // because it is what the run is steered by. So the size that decides is not
  // the whole prompt but what is actually SAVED, and measuring the candidate is
  // the only honest way to know it. Measured 2026-09-04, run 88a012cf: a 4127 B
  // prompt whose task was a single question sat just past the threshold, and
  // offloading it produced a 4215 B launch prompt — BIGGER than the original,
  // for a file in the worktree and a tool call the agent did not need. A rule
  // that can make its own subject worse is not a rule, it is a coin flip.
  const kandidat = [zeigerText, platform].filter(Boolean).join('\n\n')
  if (Buffer.byteLength(kandidat, 'utf8') + MIN_OFFLOAD_SAVING > Buffer.byteLength(ganz, 'utf8')) {
    return { prompt: ganz, taskFile: null }
  }
  mkdirSync(join(workdir, TASK_DIR), { recursive: true })
  // A `.gitignore` of `*` inside the directory ignores everything in it —
  // itself included, so nothing here is ever tracked. It has to be git's own
  // answer and not just ours: `harnessOwnedPaths()` keeps the FINISH GATE from
  // counting the file, but the agent is told to run `git add -A && git commit`,
  // and that would commit the platform's task file into the operator's
  // repository. Self-contained on purpose — `.git/info/exclude` lives in the
  // COMMON directory of a linked worktree and would reach into every other one.
  writeFileSync(join(workdir, TASK_DIR, '.gitignore'), '*\n', { mode: 0o600 })
  writeFileSync(abs, task, { mode: 0o600 })
  return { prompt: kandidat, taskFile: abs }
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
  if (!r.ok) throw new Error(t('run.worktree_failed', { err: r.stderr.trim() }))
  applyExtras(repo, target)
  return target
}

/**
 * Worktree extras (planning 4.0): copy or link what the repo needs but git does
 * not carry — a `.env`, a linked `node_modules`. Idempotent, so it can be
 * applied to a worktree that already stands.
 *
 * Its own function because the INTEGRATION worktree needs the same treatment: a
 * merge check like `node test/unit.mjs` runs on the merged result and wants the
 * linked node_modules just as much as an agent does.
 */
export function applyExtras(repo, target) {
  for (const extra of repo.extras ?? []) {
    const src = resolve(repo.path, extra.path)
    const dst = resolve(target, extra.path)
    if (!existsSync(src) || existsSync(dst)) continue
    mkdirSync(join(dst, '..'), { recursive: true })
    if (extra.mode === 'link') symlinkSync(src, dst)
    else cpSync(src, dst, { recursive: true })
  }
}

/**
 * Every directory OUTSIDE the worktree that Freilauf itself pointed this run's
 * agent at. A coding agent may sandbox itself to its working directory and ask
 * before touching anything else — opencode 1.18.27 does exactly that, with the
 * `external_directory` permission — and under `--auto` that question is not
 * approved but REFUSED. So the agent was blocked precisely where the platform
 * prompt sends it: `~/agents/runs/<id>/report.md` is the file every run must
 * write, and it lies outside the worktree on purpose (a report inside it would
 * leave it dirty for the finish gate). Measured 2026-09-04 on one repository of this machine:
 * fifteen opencode workers stood in their TUI for an hour, `0 tokens`, having
 * never got past their first tool call.
 *
 * The list is a statement of FACT, not a permission grant: these are the paths
 * this hub put in front of this agent. What a harness does with it is the
 * harness's business — `modelArgs()` receives it, and a plugin that sandboxes
 * nothing ignores it.
 *
 * Three sources, and each one is a place the prompt or the worktree really
 * sends the agent:
 *   - the run directory — prompt.md, report.md, report-detail.md, launch.json;
 *   - the extra-skills directory, whose SKILL.md the prompt names by full path;
 *   - every worktree extra linked in, resolved to the target the symlink points
 *     at. `.venv/`, `node_modules/` and a reference checkout are the whole
 *     reason an extra exists, and a link that cannot be followed is an extra
 *     that was never applied.
 * A `copy` extra needs nothing: it IS in the worktree.
 */
export function runExternalDirs(run, repo, runDir) {
  const dirs = [runDir, zusaetzeDir()]
  for (const extra of repo?.extras ?? []) {
    if (extra.mode !== 'link') continue
    const src = resolve(repo.path, extra.path)
    // The link target, not the link: the agent resolves it before it asks.
    // A file (a linked `.env`) admits the directory holding it, nothing wider.
    try {
      const real = realpathSync(src)
      dirs.push(statSync(real).isDirectory() ? real : dirname(real))
    } catch { /* an extra that is not there was not applied either */ }
  }
  // Deduplicated and absolute; an empty or relative entry would widen a
  // pattern to something nobody asked for.
  return [...new Set(dirs.filter(d => typeof d === 'string' && d.startsWith('/')))]
}

/**
 * Claude Code hook format: EVERY event is a list of
 * { matcher?, hooks: [{ type, command }] } — a bare command list is rejected.
 * And not just partially: a faulty settings file is discarded COMPLETELY
 * ("Files with errors are skipped entirely") and the run hangs at an
 * interactive dialog. That would take down the whole reporting chain.
 */
export function claudeSettingsJson() {
  const hook = (cmd, matcher = null) => [{ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: cmd }] }]
  return JSON.stringify({
    hooks: {
      // The agent's attention (reports.mjs, "the agent's attention"), measured
      // with Claude Code 2.1.261 in a tmux session: UserPromptSubmit fires for
      // the launch prompt and for every line typed into the TUI afterwards —
      // including what the hub's send route pastes in — Stop 1–2 s after the
      // last answer, `idle_prompt` 60 s after Stop, PreToolUse before every tool
      // call. SubagentStop fires too (with the MAIN session's id, and even for a
      // background helper nobody asked for) and is deliberately NOT hooked: a
      // subagent's end says nothing about whether the run waits for a human.
      UserPromptSubmit: hook('fl-report _working prompt'),
      // Detached, because claude blocks the tool call until the hook returns:
      // one fork per tool call, and the hub writes nothing unless the state
      // changed. It is the net under the one continuation UserPromptSubmit
      // cannot see — a `/goal` that makes claude take another turn by itself.
      // 'tool', not 'prompt': the two or three calls an agent makes AFTER
      // `fl-report done` arrive here too, and on the then-finished run only a
      // human's line may open a follow-up (reports.mjs, commissionOnWorking).
      PreToolUse: hook('setsid -f fl-report _working tool >/dev/null 2>&1'),
      Stop: hook('fl-report _turn_end'),
      SessionEnd: hook('fl-report _exit'),
      // A prompt the agent cannot pass on its own. `permission_prompt` cannot
      // happen under dontAsk, but a settings file is copied into places where
      // the mode differs. The other notification types (auth_success, the
      // elicitation family, agent_completed …) say nothing about waiting.
      Notification: hook('fl-report _waiting', 'idle_prompt|permission_prompt'),
      // Rate limit, overloaded, auth, billing …: Claude names the reason as a
      // fixed enum on stdin. Verified with Claude Code 2.1.241 (simulated 429
      // with anthropic-ratelimit-unified-status: rejected → error: "rate_limit").
      // NOTE: Claude does NOT wait for this hook — the process is gone within
      // 100 ms and takes the hook with it (measured: 'cat' gets through,
      // 'sleep 0.1' does not). Hence 'setsid -f': fl-report keeps running
      // detached in its own session and reads the event from the inherited
      // stdin pipe.
      StopFailure: hook('setsid -f fl-report _api_error >/dev/null 2>&1'),
    },
  })
}

/**
 * The three variables a SANDBOXED session gets on top of the ordinary ones, and
 * each of them is a boundary crossing rather than a convenience:
 *
 *  - `HOME` is the run's OWN home (§7.7), not the operator's. Everything the CLI
 *    keeps — its conversation, its session store, its auth file — lives there,
 *    which is what makes the run's state part of the run's record rather than a
 *    file in somebody's home directory, and what makes a resume find the
 *    conversation again. It is also why the break-glass keeps this value: a run
 *    continued on the host still has to find what it wrote inside the box.
 *  - `FL_RUN_TOKEN` and `FL_HUB_SOCKET` are the way back to the hub (§7.6). The
 *    token is minted by the INSERT itself, so a run created before that existed
 *    simply has none and reports over loopback as it always did — which is why
 *    the variable is only set when there is one to set.
 */
function sandboxEnvArgs(run, sandbox) {
  const out = ['--env', `HOME=${sandbox.home}`,
    '--env', `FL_HUB_SOCKET=${sandbox.hubSocket}`]
  if (run.report_token) out.push('--env', `FL_RUN_TOKEN=${run.report_token}`)
  return out
}

/**
 * The other half of the sentence above, and it was missing: a run that WAS
 * sandboxed and now runs on the HOST keeps its own home too.
 *
 * That is the break-glass (`continueWithoutSandbox()`, §7.12.4), which
 * deliberately keeps `runs.sandbox_home` for exactly this reason — the harness's
 * conversation lives in there (`~/agents/runs/<id>/home/.claude/projects/…`),
 * and a resumed CLI pointed at the operator's `$HOME` finds nothing to continue.
 * `HOME` was emitted only on the sandboxed branch, so the escape hatch resumed a
 * run into a home it had never written a byte to, which turns a resume back into
 * a fresh start — the one thing the break-glass exists to avoid.
 *
 * A home that is not on disk is not passed on: pointing a CLI at a directory
 * that does not exist is worse than leaving it the host's, and this is a
 * fail-soft convenience, not a boundary.
 */
function hostHomeArgs(run) {
  const home = run?.sandbox_home
  return home && existsSync(home) ? ['--env', `HOME=${home}`] : []
}

/**
 * Split a plugin's launch arguments into its `--env NAME=VALUE` pairs and
 * everything else, so the pairs can be handed to §7.8's secret handling and put
 * back afterwards. Only ever used on the sandboxed path: an unsandboxed run's
 * argument list is passed through exactly as the plugin produced it.
 */
export function splitEnvArgs(args) {
  const rest = [], pairs = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--env' && i + 1 < args.length) {
      const raw = String(args[++i])
      const eq = raw.indexOf('=')
      if (eq > 0) { pairs.push({ name: raw.slice(0, eq), value: raw.slice(eq + 1) }); continue }
      rest.push('--env', raw)
      continue
    }
    rest.push(args[i])
  }
  return { rest, pairs }
}

/**
 * Creates the run record (definition copy) and returns the run ID.
 *
 * The `sandbox*` arguments are what `startRun()` decided BEFORE it got here
 * (server/sandbox/index.mjs, `planSandbox()`), and they are written in the same
 * INSERT as everything else for the same reason `or_routing` is: the row has to
 * say from its very first moment what this run will run as. `worktree_kind`
 * follows from it — a sandboxed run gets a clone (§7.4), and `makeSandboxClone()`
 * writes the column again itself, which is right: the one place that knows a
 * clone was really made should be the one that says so.
 */
export function createRun({ repoId, agentId = null, harness, model = null, provider = null,
  orProvider = null, orRouting = null, effort = null, prompt, promptExtra = null, goal = null, branchMode, branchPattern = null,
  keepOnBranch = 0, expectedMinutes, skills = null, flows = null, title = null,
  sandbox = 0, sandboxProfileId = null, sandboxOverrides = '{}', sandboxSpec = null }) {
  if (!getHarness(harness)) throw new Error(t('run.unknown_harness', { harness }))
  if (!isHarnessEnabled(harness)) throw new Error(t('run.harness_not_configured', { harness }))
  if (!prompt?.trim()) throw new Error(t('run.empty_prompt'))
  const id = randomUUID()
  db.prepare(`INSERT INTO runs(id, repo_id, agent_id, status, harness, model, provider, or_provider, or_routing,
              effort, prompt, prompt_extra, goal, branch_mode, branch_pattern, keep_on_branch,
              expected_minutes, skills, flows, title,
              sandbox, sandbox_profile_id, sandbox_overrides, sandbox_spec, worktree_kind, last_activity_at)
              VALUES(?,?,?, 'running', ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,? , datetime('now'))`)
    .run(id, repoId, agentId, harness, model, provider, orProvider,
      orRouting ? JSON.stringify(orRouting) : null, effort, prompt, promptExtra,
      goal, branchMode, branchPattern, keepOnBranch ? 1 : 0, expectedMinutes, skills, flows, title,
      sandbox ? 1 : 0, sandboxProfileId,
      typeof sandboxOverrides === 'string' ? sandboxOverrides : JSON.stringify(sandboxOverrides ?? {}),
      sandboxSpec ? (typeof sandboxSpec === 'string' ? sandboxSpec : JSON.stringify(sandboxSpec)) : null,
      sandbox ? 'clone' : 'worktree')
  return id
}

/**
 * Model/provider arguments for the chosen harness — delegated to the coding
 * agent plugin. Without a provider (legacy rows) 'model' goes out verbatim as
 * before.
 *
 * The plugin is handed a context so it can resolve the credential the OPERATOR
 * configured — a stored value, or an environment variable they named — instead
 * of only the one the provider declares. The context is built for the PROVIDER
 * where the run names one, because that is whose key travels into the session;
 * a subscription harness (claude, cursor) has no provider and ignores it.
 */
export function harnessModelArgs(run, opts = null) {
  const plugin = getHarness(run.harness)
  if (!plugin) return { args: [], fehlt: [] }
  return plugin.modelArgs(run, pluginCtx(run.provider || run.harness), opts)
}

// ---------------------------------------------------------------- resume
//
// A run whose tmux session vanished without the hub ending it — a reboot, an
// update that took the tmux server, a server that died — used to be ABORTED:
// "tmux session ended", one notification per run, and everything the agent
// had in its head was gone. Yet everything a continuation needs was still on
// disk: the worktree, prompt.md, the log, and for claude the conversation
// itself (the hub launches with `--session-id <run id>`, so `--resume <run
// id>` finds it). What was missing was the code. `resumeRun()` is it: the
// seventh caller of launchRun(), and launchRun() knows a RESUME from a fresh
// start by `runs.resume_pending`.
//
// The one rule: only a session the hub did NOT end is resumed. Every
// deliberate end — the kill route, the sessions page, retention, archiving, a
// flow's kill_run — goes through reconcileClosedSession() and aborts exactly
// as before. The watcher's discovery path is the caller that decides a
// session was LOST; anything else that wants a resume (a future sandbox
// reconfiguration, SANDBOX_RESEARCH.md) calls resumeRun() with a reason of its
// own, which does not count against the cap.

/**
 * How often a run is resumed automatically before the hub gives up and ends
 * it the way it always did (aborted, its work named). A cap against a crash
 * loop — a CLI that dies at every start would otherwise be restarted every
 * watcher pass for ever. `FREILAUF_RESUME_MAX`, default 3.
 */
export const RESUME_MAX = (() => {
  const raw = env('RESUME_MAX')
  if (raw == null || String(raw).trim() === '') return 3
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : 3
})()

/** What resumeRun() writes down for launchRun() to read: why, and with which text. */
const RESUME_FILE = 'resume.json'
/**
 * How long a resume launch may be in flight before a pending run without a
 * session counts as "the last attempt failed" rather than "somebody is
 * launching it right now". fl-start's own timeout is 120 s; this is longer.
 */
export const RESUME_LAUNCH_GRACE_MS = 150_000

/**
 * Is a launch of this pending run still in flight? `retryPendingResumes()`
 * (watcher.mjs) asks before launching again: a run marked pending with no
 * session looks exactly the same during the seconds fl-start needs and after
 * a launch that failed — and two hub processes on one database (the e2e
 * suite drives the watcher in-process next to a running hub) turned that
 * into two sessions for one run. The marker carries when the launch began.
 */
export function resumeLaunchInFlight(runId, nowMs = Date.now()) {
  try {
    const info = JSON.parse(readFileSync(join(RUNS_DIR, runId, RESUME_FILE), 'utf8'))
    const since = Date.parse(info?.launching_at ?? '')
    return Number.isFinite(since) && nowMs - since < RESUME_LAUNCH_GRACE_MS
  } catch { return false }
}
/** The prompt the resumed CLI is launched with — never prompt.md, which is the record of the task. */
const RESUME_PROMPT_FILE = 'resume-prompt.md'

/**
 * The continuation, for a coding agent that gets its old conversation back.
 * Short on purpose: the task and the platform rules are in that conversation
 * already, and repeating them would be a second copy of what the run was
 * asked. `{context}` is what the worktree says happened before the cut.
 */
export const RESUME_PROMPT = `Your session was interrupted: the tmux session it lived in is gone (a server restart, an update, a lost tmux server), and Freilauf has resumed it in a new one. Your conversation up to the interruption is what you see above; the worktree is exactly as you left it.

{context}

Continue the task from where you were. Check \`git status\` and \`git log\` first so you do not redo work that is already committed, then carry on and finish. Everything the platform rules said still applies: commit your work, write the two report files and run \`fl-report done\` exactly as instructed. If you were waiting for a human's answer when the cut came, ask the question again with \`fl-report help\`. If the interruption cost you something you cannot recover, say so in the report.`

/**
 * The header for a coding agent that has NO resume form (a plugin without
 * `launch.resume`; cursor before its transcript exists): it is started afresh
 * with the ORIGINAL prompt, and this stands in front of it so it does not redo
 * the committed half of its own work. All four built-ins resume — hermes too,
 * since 0.21 (measured; see harnesses/hermes.mjs).
 */
export const RESUME_FRESH_HEADER = `# This run was interrupted and is being restarted

The session this run worked in is gone (a server restart, an update, a lost tmux server). This coding agent cannot resume a conversation, so Freilauf starts you afresh with the original task below. The worktree is exactly as the previous session left it: look at \`git status\` and \`git log\` before you begin, and do NOT redo what is already committed.

{context}

The original task follows.`

/**
 * What the worktree and the run's own reports say happened before the cut —
 * the commits since the run's base, uncommitted files, the last progress
 * reports. Prepended to both continuation prompts, because an agent that is
 * told "continue" without being told where it stood redoes work.
 */
export async function resumeContext(run) {
  const lines = []
  if (run.workdir_effective && existsSync(run.workdir_effective)) {
    const range = run.base_sha ? `${run.base_sha}..HEAD` : '-10'
    const log = await sh('git', ['-C', run.workdir_effective, 'log', '--oneline', '--no-decorate', range])
    const commits = log.ok ? log.stdout.trim().split('\n').filter(Boolean) : []
    lines.push(commits.length
      ? `Commits you made before the interruption (newest first):\n${commits.slice(0, 20).map(c => `- ${c}`).join('\n')}`
      : 'You had not committed anything before the interruption.')
    const st = await sh('git', ['-C', run.workdir_effective, '--no-optional-locks', 'status', '--porcelain'])
    if (st.ok && st.stdout.trim()) {
      lines.push(`Uncommitted changes in the worktree (\`git status --porcelain\`):\n${st.stdout.trim().split('\n').slice(0, 30).join('\n')}`)
    }
  }
  const progress = db.prepare(`SELECT payload FROM events WHERE run_id=? AND kind='progress' ORDER BY id DESC LIMIT 3`).all(run.id)
    .map(r => { try { const p = JSON.parse(r.payload); return String(p?.text ?? p?.message ?? '').trim() } catch { return '' } })
    .filter(Boolean)
  if (progress.length) lines.push(`Your last progress reports (newest first):\n${progress.map(p => `- ${p}`).join('\n')}`)
  return lines.join('\n\n')
}

/** The four fl-start knows a resume form for; a plugin says so with `launch.resume`. */
const RESUMABLE_BUILTIN = new Set(['claude', 'cursor', 'opencode', 'hermes'])

/** Can this coding agent continue an interrupted conversation at all? */
export function resumable(harness) {
  if (RESUMABLE_BUILTIN.has(harness)) return true
  const launch = getHarness(harness)?.launch
  return Array.isArray(launch?.resume) && launch.resume.length > 0
}

/**
 * The id the CLI continues with. The plugin answers when it knows better
 * (`resumeId(run)`: cursor reads it out of its transcript, opencode out of its
 * store); otherwise it is the run id, because that is what the hub handed the
 * CLI as its session id at launch. `null` from a plugin means "nothing to
 * resume" — a fresh launch with the original prompt, marked as such.
 */
export async function resumeIdFor(run) {
  const plugin = getHarness(run.harness)
  if (typeof plugin?.resumeId !== 'function') return run.id
  try {
    const id = await plugin.resumeId(run)
    return id ? String(id) : null
  } catch (e) {
    addEvent(run.id, 'warn', { resume_id: e.message })
    return null
  }
}

/**
 * Resume a run whose session is gone: mark it, retract what the silence
 * produced, and launch. Returns launchRun()'s answer, or `{ok:false, error}`
 * when the run cannot be resumed — the caller then ends it the old way.
 *
 * `reason` 'session_lost' is the watcher's; it counts against RESUME_MAX. Any
 * other reason is a deliberate caller's and does not — the cap exists for
 * crash loops, and three operator-driven reconfigurations must not use up a
 * run's crash budget. `text` replaces the fixed continuation prompt.
 *
 * `started_at` is moved forward by the length of the gap (measured from the
 * run's last activity): the expected duration is about the agent's work, and
 * a night the server spent switched off is not work — without the shift every
 * resumed run would be flagged as overrun the moment it came back. The
 * original start is kept in the `session_lost` event.
 *
 * `adoptPending` is for the ONE caller that has already set the mark itself:
 * the sandbox's reconfigure-and-resume (§7.12.4) marks the row BEFORE it stops
 * the container, so that a watcher pass finding the session gone a second later
 * sees a run already on its way instead of starting a second resume with the
 * stale spec. Without this flag the guard below would answer that caller
 * `{pending: true}` and nobody would ever launch. The guard itself stays exactly
 * as strict for everyone else — it is what keeps two watcher passes from
 * launching one run twice.
 */
export async function resumeRun(runId, { reason = 'session_lost', text = null, adoptPending = false } = {}) {
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId)
  if (!run) return { ok: false, error: 'run not found' }
  if (!['running', 'waiting_help'].includes(run.status)) return { ok: false, error: `status is ${run.status}` }
  if (run.resume_pending && !adoptPending) return { ok: true, pending: true }
  // Reported already: the finish gate's `agent_gone` escalation owns this case.
  if (run.finish_state) return { ok: false, error: 'in the finish gate — the integrator escalates' }
  if (!run.workdir_effective || !existsSync(run.workdir_effective)) return { ok: false, error: 'the worktree is gone' }
  if (!launchable(run.harness)) return { ok: false, error: `no launch spec for ${run.harness}` }
  const counted = reason === 'session_lost'
  if (counted && run.resume_attempts >= RESUME_MAX) {
    return { ok: false, error: `resumed ${run.resume_attempts} times already (cap ${RESUME_MAX})` }
  }
  const lastSeen = Math.max(parseDbUtc(run.last_activity_at) || 0, parseDbUtc(run.started_at) || 0)
  const gapSec = lastSeen ? Math.max(0, Math.round((Date.now() - lastSeen) / 1000)) : 0
  const runDir = join(RUNS_DIR, runId)
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, RESUME_FILE),
    JSON.stringify({ reason, text: text || null, counted, at: new Date().toISOString(), session: run.tmux_session }),
    { mode: 0o600 })
  // The goal starts over with the session: a `/goal` typed into the old one
  // went with it, and the watcher's pending-goal pass delivers it again.
  // …and so does the agent's attention: 'waiting' described a process that is gone.
  db.prepare(`UPDATE runs SET tmux_session=NULL, tmux_closed_at=NULL, resume_pending=1, goal_sent_at=NULL,
              agent_state=NULL, agent_state_at=NULL,
              started_at=datetime(started_at, '+' || ? || ' seconds'), last_activity_at=datetime('now') WHERE id=?`)
    .run(gapSec, runId)
  const { clearAnomalies } = await import('./reports.mjs')
  clearAnomalies(runId, ['anomaly:no_activity', 'anomaly:soft_overrun', 'anomaly:overrun', 'anomaly:session_gone'])
  addEvent(runId, 'session_lost', {
    reason, attempt: run.resume_attempts + 1, gap_s: gapSec,
    started_at_before: run.started_at, session: run.tmux_session,
  })
  // The same gate as at any other start: a resume into an exhausted quota
  // dies at the first API call like a fresh start would. A blocked one waits
  // as `deferred` — with `resume_pending` kept, so the watcher's retry resumes
  // rather than starting afresh.
  const { budgetGate } = await import('./scheduler.mjs')
  const gate = await budgetGate(run.harness, run.model ?? null, run.provider ?? null)
  if (gate) {
    db.prepare(`UPDATE runs SET status='deferred' WHERE id=?`).run(runId)
    addEvent(runId, 'deferred', { reason: gate.reason, resets_at: gate.resets_at ?? null, resume: true })
    return { ok: true, deferred: true }
  }
  return launchRun(runId)
}

/**
 * Starts a prepared run: worktree, prompt, fl-start.
 * Returns { ok, session?, error? }.
 *
 * With `runs.resume_pending` set this is a RESUME (see resumeRun above): the
 * worktree is reused as it stands, prompt.md is left alone and the CLI is
 * launched in its resume form with a continuation prompt — or, for a coding
 * agent without one, afresh with the original prompt behind a header that
 * says what already happened. `base_sha` and the quota marks are kept: the
 * run's own commits are still what it wants merged. A launch that fails on a
 * resume leaves the run pending for the next watcher pass instead of failing
 * it, until the cap is reached: right after a reboot the tmux server itself
 * may be a beat behind, and "could not try" is not "tried and died".
 */
/**
 * §8.1's availability rule, applied where the run is actually LAUNCHED — which
 * is not where it was planned, and that gap is the whole defect.
 *
 * `planSandbox()` folds "is a runtime there?" into the decision through
 * `sandboxOutcome()` at CREATE time. Between then and here lie a cached
 * discovery answer and, for a `scheduled` or `deferred` run, hours: a 03:00
 * agent start whose daemon hiccups is the case, and it ended `failed` with "The
 * container runtime did not answer, so fl-… could not be prepared" — an entire
 * night lost to a rule that says the opposite. §8.1: an `available` hub starts
 * unsandboxed and writes it down, a `required` hub refuses readably.
 *
 * The same PURE function decides both times, so plan and launch cannot come to
 * mean different things about one fact — and the answer, whichever way it goes,
 * is never silent: a bypass is `sandbox:bypassed {by: 'unavailable', reason}` on
 * the run's own record, and an operator who believes their runs are contained
 * and learns later that Docker was down is the worst outcome this feature has.
 *
 * `runs.sandbox` goes to 0 with it, because it is the column everything else
 * reads: the reconciliation pass, the sessions page's badge, the finish gate's
 * seams. A row that says 1 while the agent works on the host would make every
 * one of them describe a container that is not there.
 *
 * Returns `{ problem }` (start nothing) or `{ bypass: true }`.
 */
async function sandboxUnavailable(runId, reason) {
  const { sandboxOutcome } = await import('./sandbox/index.mjs')
  const { sandboxHubMode } = await import('./run-def.mjs')
  const outcome = sandboxOutcome({
    decision: { sandbox: true }, hubMode: sandboxHubMode(),
    available: false, unavailableReason: String(reason ?? 'unknown'),
  })
  if (outcome.problems.length) return { problem: outcome.problems.join('\n\n') }
  for (const [kind, payload] of outcome.events) addEvent(runId, kind, payload)
  db.prepare('UPDATE runs SET sandbox=0 WHERE id=?').run(runId)
  return { bypass: true }
}

export async function launchRun(runId) {
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId)
  if (!run) throw new Error(`run ${runId} not found`)
  const repo = getRepo(run.repo_id)
  const agent = run.agent_id ? db.prepare('SELECT * FROM agents WHERE id = ?').get(run.agent_id) : null
  const kurz = kurzid(runId)
  const runDir = join(RUNS_DIR, runId)
  mkdirSync(runDir, { recursive: true })
  const resuming = !!run.resume_pending
  let resumeInfo = null
  if (resuming) {
    try { resumeInfo = JSON.parse(readFileSync(join(runDir, RESUME_FILE), 'utf8')) } catch { resumeInfo = {} }
    if (!resumeInfo || typeof resumeInfo !== 'object') resumeInfo = {}
    if (resumeInfo.counted == null) resumeInfo.counted = true
    // Say that a launch is in flight, so a second pass (or a second process on
    // the same database) does not launch this run a second time meanwhile.
    resumeInfo.launching_at = new Date().toISOString()
    try { writeFileSync(join(runDir, RESUME_FILE), JSON.stringify(resumeInfo), { mode: 0o600 }) } catch { /* best effort */ }
  }

  // Asked BEFORE the worktree: a coding agent nothing can launch produces a
  // clean failure here instead of a worktree, a session and a puzzled operator.
  if (!launchable(run.harness)) {
    const msg = t('run.no_launch_spec', { harness: run.harness })
    failRun(runId, msg)
    return { ok: false, error: msg }
  }

  let workdir = repo.path
  let branchExpected = null
  // What `prepareSandbox()` produced, or null. An unsandboxed run never touches
  // the sandbox module at all — not even an import — which is what makes "the
  // sandbox is optional" a property of the code rather than a promise about it.
  let sandbox = null
  // Did §8.1's availability rule weaken this start into an unsandboxed one? The
  // catch below then must not undo the worktree it just made, nor fail a run
  // that is about to start perfectly well.
  let bypassed = false
  try {
    if (run.branch_mode === 'neu' || run.branch_mode === 'fest') {
      branchExpected = expandPattern(run.branch_pattern, { ...run, agent_name: agent?.name, id: runId })
    }
    if (run.sandbox) {
      // §7.11's start order, all of it idempotent, because a resume walks it
      // again: spec → clone → home → sandbox.json → network → proxy → stop an
      // orphan holding the name. The clone REPLACES the linked worktree (§7.4):
      // a worktree hangs on the operator's `.git`, and a container that could
      // write there could write the operator's hooks.
      //
      // …unless the runtime cannot be reached at all, and THAT is asked here
      // rather than left to prepareSandbox()'s throw, because the two callers
      // want opposite things out of the same fact (see sandboxUnavailable()).
      const { prepareSandbox, refreshSandboxAvailability } = await import('./sandbox/index.mjs')
      const av = resuming ? { available: true } : await refreshSandboxAvailability()
      const weakened = av.available ? null : await sandboxUnavailable(runId, av.reason)
      if (weakened?.problem) {
        failRun(runId, weakened.problem)
        return { ok: false, error: weakened.problem }
      }
      if (weakened?.bypass) {
        run.sandbox = 0
        workdir = await makeWorktree(repo, run, branchExpected)
      } else {
        sandbox = await prepareSandbox(run, repo, { branch: branchExpected })
        workdir = sandbox.workdir
      }
    } else {
      // Every run works in its own worktree — even with expectation "none"
      // (then detached HEAD; throwaway changes; planning 4.0).
      workdir = await makeWorktree(repo, run, branchExpected)
    }
  } catch (err) {
    // "Could not try" is not "tried and died", and here it has a fuse behind it
    // (§11.3): after a reboot the first watcher pass runs at once, and a rootless
    // container daemon's user unit may still be starting. Three passes against a
    // daemon that is merely slow would burn the whole RESUME_MAX cap and end the
    // run — for an infrastructure hiccup, not for a CLI that cannot start. A
    // sandbox failure that means "the runtime could not be ASKED" therefore
    // leaves `resume_pending` standing, counts no attempt (the increment happens
    // further down and is never reached) and asks again next pass.
    if (resuming && err?.sandboxRetry) {
      // The in-flight marker is taken back with it: nothing IS in flight, and
      // leaving it would make the next four passes skip this run for the launch
      // grace period while the daemon it is waiting for comes up in seconds.
      try {
        delete resumeInfo.launching_at
        writeFileSync(join(runDir, RESUME_FILE), JSON.stringify(resumeInfo), { mode: 0o600 })
      } catch { /* the marker is a courtesy */ }
      addEvent(runId, 'resume_failed', { attempt: run.resume_attempts, error: String(err.message).slice(0, 500), waiting: 'sandbox_runtime' })
      return { ok: false, retry: true, error: err.message }
    }
    // The same fact on a FRESH start means the opposite thing (§8.1), so it gets
    // the opposite answer: there is no conversation to preserve and nothing to
    // wait for — the run has never run. `prepareSandbox()` asks the daemon in
    // more places than the availability probe above (an orphan still holding the
    // container name, §7.11 step 7), so this is the belt under that check.
    if (!resuming && err?.sandboxRetry && run.sandbox) {
      const weakened = await sandboxUnavailable(runId, err.message)
      if (weakened?.problem) {
        failRun(runId, weakened.problem)
        return { ok: false, error: weakened.problem }
      }
      try {
        const { teardownSandbox } = await import('./sandbox/index.mjs')
        await teardownSandbox({ ...run, sandbox: 1 }, { reason: 'bypassed', removeNetwork: true, force: true })
      } catch { /* fail-soft: the reaper is the net under this */ }
      run.sandbox = 0
      sandbox = null
      try {
        workdir = await makeWorktree(repo, run, branchExpected)
        bypassed = true
      } catch (e2) {
        failRun(runId, `Start failed:\n\n${e2.message}`)
        return { ok: false, error: e2.message }
      }
    }
    // Whatever the sandbox built before it failed goes again — `prepareSandbox()`
    // tears down its own half-built work, and this is the belt for a failure
    // that happened after it returned. §7.10: a run that hangs because an image
    // is missing is the worst outcome there is, so this ends visibly instead.
    if (!bypassed) {
      if (run.sandbox) {
        try {
          const { teardownSandbox } = await import('./sandbox/index.mjs')
          await teardownSandbox(run, { reason: 'launch_failed', removeNetwork: true })
        } catch { /* a teardown that fails must not hide the reason the start did */ }
      }
      failRun(runId, `Start failed:\n\n${err.message}`)
      return { ok: false, error: err.message }
    }
  }

  const mainSha = await sh('git', ['-C', repo.path, 'rev-parse', 'HEAD'])
  const settings = Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map(r => [r.key, r.value]))
  // What the agent is told about its branch comes out of BRANCH_MODE_INFO
  // (run-def.mjs) — the same table the form's explanations come from, so the
  // two can never say different things about the same choice.
  const branchRule = branchRuleText(run.branch_mode, {
    branch: branchExpected, base: repo.base_branch || 'main',
    hubMerges: repo.merge_mode === 'hub', keepOnBranch: !!run.keep_on_branch,
  })
  // The task and the platform's own framing are composed separately, because
  // they are what `offloadPrompt()` splits on: a CLI that cannot be handed a
  // long argument gets the framing plus a pointer, and the task goes to a file.
  const taskPrompt = [run.prompt, repoPromptZusatz(repo.prompt), run.prompt_extra?.trim(),
    skillPromptZusatz(run.skills)].filter(Boolean).join('\n\n')
  // The Sandbox section of the prompt is rendered from what the launch really
  // produced — the resolved allow list out of the same function the proxy is
  // configured from — never from a profile: an agent told about hosts it does
  // not actually have is worse informed than one told nothing.
  const sandboxFacts = sandbox
    ? (await import('./sandbox/index.mjs')).sandboxPromptFacts(sandbox)
    : null
  const platformPrompt = platformSuffix({ ...run, id: runId, workdir_effective: workdir },
    branchRule, settings, repo, sandboxFacts).trim()
  const fullPrompt = [taskPrompt, platformPrompt].filter(Boolean).join('\n\n')
  let promptFile = join(runDir, 'prompt.md')
  // The resume form's argv, when this launch continues a conversation.
  let resumeArgs = []
  if (resuming) {
    // prompt.md stays what it is — the record of the task. The CLI gets a
    // continuation: its old conversation plus what happened since, or, where
    // nothing can be continued, the whole original task behind a header.
    const rid = resumable(run.harness) ? await resumeIdFor(run) : null
    const context = await resumeContext(run)
    let text
    if (rid) {
      resumeArgs = ['--resume', rid]
      text = String(resumeInfo.text || RESUME_PROMPT).replaceAll('{context}', context)
    } else {
      text = `${RESUME_FRESH_HEADER.replaceAll('{context}', context)}\n\n${fullPrompt}`
    }
    promptFile = join(runDir, RESUME_PROMPT_FILE)
    writeFileSync(promptFile, text, { mode: 0o600 })
  } else {
    // prompt.md is the RECORD — always the whole thing, offload or not. What the
    // CLI is actually launched with is a separate file, so "what was this run
    // asked?" keeps one answer.
    writeFileSync(join(runDir, 'prompt.md'), fullPrompt, { mode: 0o600 })
    const offload = offloadPrompt(run.harness, workdir, taskPrompt, platformPrompt)
    if (offload.taskFile) {
      promptFile = join(runDir, 'launch-prompt.md')
      writeFileSync(promptFile, offload.prompt, { mode: 0o600 })
      addEvent(runId, 'prompt_offloaded', {
        bytes: Buffer.byteLength(fullPrompt, 'utf8'),
        launch_bytes: Buffer.byteLength(offload.prompt, 'utf8'),
        file: offload.taskFile,
      })
    }
  }

  // Hook files into the workspace (cursor: the 'stop' hook that reports the end
  // of a turn). Fail-soft: a run without hooks still works, it just falls back
  // to the transcript for its end detection.
  //
  // WHICH SIDE OF THE BOUNDARY: the HOST side, and unchanged. `.cursor/hooks.json`
  // is written into the working copy, and the working copy is bind-mounted into
  // the container at the SAME absolute path — so one file, written outside, read
  // inside. The command it names (`flReportPath()`, `~/.local/bin/fl-report`) is
  // mounted read-only at that same path too (§7.11), which is what makes an
  // absolute path written on the host resolve inside the box.
  try {
    const hooks = writeHarnessHooks(run.harness, workdir)
    if (hooks.length) addEvent(runId, 'hooks_installed', { files: hooks })
  } catch (err) {
    addEvent(runId, 'warn', { hooks: err.message })
  }

  // Only the claude windows are recorded on the run (quota5_start/quota7_start).
  // An `await openrouterCredits()` used to sit here whose result was never read:
  // a 10-second-timeout HTTP call on the hot path of every single launch.
  // Where this run STARTS from: the worktree's HEAD right after it was created.
  // Everything the run adds sits between this and its tip — which is what makes
  // "did it commit anything?" and "what does it want merged?" answerable without
  // guessing at a branch. Read again on a retry, because the worktree is reused.
  if (resuming) {
    // A resume keeps where the run started FROM: base_sha is what its own
    // commits are measured against, and the quota marks are the cost's start.
    // Re-reading either here would make the interrupted half of the work
    // disappear from "what does this run want merged" and from its bill.
    db.prepare(`UPDATE runs SET status='running', workdir_effective=?, worktree=?,
                branch_expected=COALESCE(branch_expected, ?), resume_attempts=resume_attempts+? WHERE id=?`)
      .run(workdir, workdir !== repo.path ? workdir : null, branchExpected, resumeInfo.counted ? 1 : 0, runId)
  } else {
    const baseSha = await sh('git', ['-C', workdir, 'rev-parse', 'HEAD'])
    const q = claudeQuota()
    // The 7-day window recorded is the one this run draws from — its own model's,
    // plus the general one (quota.mjs). The cost delta at the end reads the same
    // window, so the two ends of that subtraction are about one thing.
    db.prepare(`UPDATE runs SET status='running', workdir_effective=?, worktree=?, branch_expected=?,
                main_sha_start=?, base_sha=?, quota5_start=?, quota7_start=? WHERE id=?`)
      .run(workdir, workdir !== repo.path ? workdir : null, branchExpected,
        mainSha.ok ? mainSha.stdout.trim() : null, baseSha.ok ? baseSha.stdout.trim() : null,
        q.five, sevenForRun(run, q), runId)
    addEvent(runId, 'started', { workdir, harness: run.harness, model: run.model,
      provider: run.provider ?? null, effort: run.effort ?? null,
      // §7.11: the `started` event is the record of what this run was really
      // launched as. A page that wants to answer "was this contained, and how?"
      // reads one event instead of re-resolving a profile that has since moved.
      ...(sandbox ? { sandbox: {
        runtime: sandbox.spec?.runtime ?? null,
        image: sandbox.spec?.image?.ref ?? null,
        digest: sandbox.spec?.image?.digest ?? null,
        network: { mode: sandbox.spec?.network?.mode ?? null, engine: sandbox.spec?.network?.engine ?? null,
          auditOnly: !!sandbox.spec?.network?.auditOnly },
        resolvedAllow: sandbox.resolvedAllow ?? [],
        mounts: sandbox.spec?.filesystem?.extraMounts ?? [],
        resources: sandbox.spec?.resources ?? null,
        secrets: sandbox.spec?.secrets?.mode ?? null,
        user: sandbox.spec?.user ?? null,
        container: sandbox.container, home: sandbox.home,
      } } : {}),
    })
  }

  const hubUrl = `http://127.0.0.1:${env('LOCAL_PORT') ?? '8791'}`
  // A sandboxed run reaches the hub over the unix socket with its own bearer
  // (§7.6), and DELIBERATELY not over the loopback URL: `127.0.0.1` inside the
  // container is the container, so `FL_HUB_URL` would be a variable pointing at
  // nothing — and where it did resolve it would be a second, unauthenticated way
  // in from inside the box. The two old `CC_*` names follow the same rule for
  // the same reason.
  const args = ['--harness', run.harness,
    '--name', (agent?.name ?? 'einzel').toLowerCase().replaceAll(/[^a-z0-9_-]/g, '-'),
    '--id', kurz,
    '--env', `FL_RUN_ID=${runId}`,
    ...(sandbox ? [] : ['--env', `FL_HUB_URL=${hubUrl}`]),
    // The old names travel with them for one transition release. A run started
    // by this hub is fine either way, but the WORKTREE it starts in may still
    // hold a `.cursor/hooks.json` or a claude settings block written before the
    // rename, and those call `cc-report`, which reads `CC_RUN_ID`. Cheap
    // insurance; the next release drops these two lines.
    '--env', `CC_RUN_ID=${runId}`,
    ...(sandbox ? [] : ['--env', `CC_HUB_URL=${hubUrl}`]),
    ...(sandbox ? sandboxEnvArgs(run, sandbox) : hostHomeArgs(run)),
    '--log', join(runDir, 'log.txt'), '--keep',
    '-f', promptFile, workdir]
  const modelArgs = harnessModelArgs(run, { externalDirs: runExternalDirs(run, repo, runDir) })
  if (sandbox) {
    // §7.8: under `secrets.mode: 'inject'` the container must hold a placeholder
    // and nothing else — the real value goes to the proxy, which swaps it in on
    // requests to that credential's own hosts. Everything the plugin produced
    // that is NOT an environment variable (`--model`, `--effort`, a config blob)
    // passes through untouched.
    const { rest, pairs } = splitEnvArgs(modelArgs.args)
    const { applySecrets } = await import('./sandbox/index.mjs')
    let applied
    try {
      applied = await applySecrets(run, sandbox.spec, pairs)
    } catch (err) {
      failRun(runId, `Start failed:\n\n${err.message}`)
      return { ok: false, error: err.message }
    }
    modelArgs.args = [...rest, ...applied.pairs.flatMap(p => ['--env', `${p.name}=${p.value}`])]
    if (applied.injected.length) addEvent(runId, 'sandbox:secrets_injected', { vars: applied.injected })
  }
  args.unshift(...modelArgs.args)
  if (modelArgs.fehlt.length) {
    // Better to start and record it visibly than to walk into the knife
    // silently: without a key the run only dies at the agent's first API call.
    addEvent(runId, 'warn', { fehlender_key: modelArgs.fehlt.join(', ') })
  }
  // A resume continues the old conversation (`--resume <id>`, fl-start knows
  // the form per coding agent); a fresh claude start names the session id so
  // that a later resume can find it. The hooks travel either way.
  if (resumeArgs.length) args.unshift(...resumeArgs)
  else if (run.harness === 'claude') args.unshift('--session-id', runId)
  // WHICH SIDE OF THE BOUNDARY: neither. `--settings` takes the JSON INLINE, so
  // this crosses no filesystem at all — it is argv, and argv is built on the
  // host and executed inside the container. What it names (`fl-report`,
  // `setsid`) is resolved inside, from the read-only mount of `~/.local/bin`
  // (§7.11). That is deliberately not the same as claude's own settings FILE,
  // which the plugin's `seedHome` writes into the run's home.
  if (run.harness === 'claude') args.unshift('--settings', claudeSettingsJson())
  // A coding agent fl-start has no case for is launched from its own
  // declaration. The file lives next to prompt.md in the run directory — NOT in
  // the worktree, which has to stay clean for the finish gate.
  const spec = launchSpec(run.harness)
  if (spec) {
    const specPath = join(runDir, 'launch.json')
    writeFileSync(specPath, JSON.stringify(spec, null, 2), { mode: 0o600 })
    args.unshift('--spec', specPath)
  }
  // …and a sandboxed run hands fl-start the document that says what container to
  // build (§7.11). One file, written by `prepareSandbox()`, read by the wrapper:
  // the hub never assembles a `docker run` command line itself, so a human can
  // reproduce the run from the same file.
  if (sandbox) {
    args.unshift('--sandbox', sandbox.specPath)
    // What the plugin wants changed about its own command line inside the box
    // (§7.9). claude asks for `bypassPermissions`: there is nothing left to ask
    // a human about in there, and its own `sandbox.env` carries the `IS_SANDBOX`
    // hint that lets that mode be accepted. `--setting-sources user` is fl-start's
    // own doing for every sandboxed claude run and is deliberately not repeated
    // here — see harnessLaunchOverrides() in server/sandbox/index.mjs.
    if (sandbox.launchOverrides?.mode) args.unshift('--mode', sandbox.launchOverrides.mode)
  }

  const r = await sh(env('START_SCRIPT') ?? `${homedir()}/.local/bin/fl-start`, args, { timeout: 120_000 })
  // fl-start's success line ("Session '<name>' started …"); the German wording
  // is still accepted for older installed scripts.
  const m = r.stdout.match(/Session '([^']+)' (?:started|gestartet)/)
  const session = m ? m[1] : null
  if (!r.ok || !session) {
    const error = r.stderr || r.stdout
    if (resuming) {
      // "Could not try" is not "tried and died": right after a reboot the tmux
      // server may still be coming up. The run stays pending and the next
      // watcher pass launches again — until the cap says it is a crash loop.
      const attempts = db.prepare('SELECT resume_attempts FROM runs WHERE id=?').get(runId)?.resume_attempts ?? 0
      addEvent(runId, 'resume_failed', { attempt: attempts, error: String(error).slice(0, 500) })
      if (!resumeInfo.counted || attempts < RESUME_MAX) return { ok: false, retry: true, error }
      failRun(runId, `Resume failed ${attempts} times (fl-start):\n\n${error}`)
      return { ok: false, error }
    }
    failRun(runId, `Start failed (fl-start):\n\n${error}`)
    return { ok: false, error }
  }
  db.prepare('UPDATE runs SET tmux_session=?, resume_pending=0 WHERE id=?').run(session, runId)
  addEvent(runId, 'tmux_started', { session })
  if (resuming) {
    try { rmSync(join(runDir, RESUME_FILE), { force: true }) } catch { /* the marker is a courtesy */ }
    addEvent(runId, 'resumed', {
      session, reason: resumeInfo.reason ?? 'session_lost', resume_form: resumeArgs.length ? resumeArgs[1] : 'fresh',
      attempt: db.prepare('SELECT resume_attempts FROM runs WHERE id=?').get(runId)?.resume_attempts ?? null,
    })
  }
  // The goal is the SECOND prompt and exists only inside the session (claude:
  // `/goal <condition>`), so it goes in now that there IS one. Deliberately not
  // awaited: it waits for the TUI to draw, and a start must not hang on that.
  // Whatever does not get through is picked up by the watcher (server/goal.mjs).
  if (run.goal) deliverGoal(runId).catch(err => addEvent(runId, 'warn', { goal: err.message }))
  return { ok: true, session }
}

/**
 * A run that never got off the ground: no worktree, no session, nothing to
 * report from.
 *
 * It says so on the channel too, and that is not decoration. Nobody is
 * necessarily watching: a scheduled agent start has no caller at all, and since
 * Quick Run answers before the launch (scheduler.mjs, `detached`) a failure
 * there can land after the operator has closed the page. A start that silently
 * did not happen is the most expensive shape a fault can take — everything
 * above it reads as "the run is in the list".
 *
 * `notifyRun` is imported lazily and never awaited: this function is
 * synchronous and sits on the launch path, reports.mjs is the far end of the
 * hub's dependency graph, and a channel that is slow or misconfigured must not
 * be able to hold up (or throw out of) the write that records the failure.
 * Muting the run (`telegram_on`) still silences it — notifyRun's own rule.
 */
export function failRun(runId, text) {
  db.prepare(`UPDATE runs SET status='failed', ended_at=datetime('now'), report_md=? WHERE id=?`)
    .run(text, runId)
  addEvent(runId, 'failed', {})
  import('./reports.mjs')
    .then(({ notifyRun }) => notifyRun(runId, 'start_failed', `❌ Start failed\n\n${text}`))
    .catch(err => console.error('[runner] start failure not announced:', err.message))
}
