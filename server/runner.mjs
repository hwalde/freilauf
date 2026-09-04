// Freilauf — run creation: run directory, worktree, prompt suffix, start via
// fl-start (the single start path, so CLI and UI produce identical runs —
// planning §5).
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, cpSync, symlinkSync, existsSync, realpathSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import db, { getRepo, addEvent } from './db.mjs'
import { RUNS_DIR, WORKTREES_DIR, kurzid, sh } from './util.mjs'
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
 * The prompt block that turns a task into a RUN: where to work, how long it may
 * take, and above all how to report back.
 *
 * Four sections in this order, and the order is the point:
 *
 *   1. the platform rules
 *   2. the operator's own addition (Settings → Platform prompt suffix)
 *   3. the harness's own lines (`promptRules`) — cursor has to be told that its
 *      turn ending closes the run
 *   4. how the run ends — LAST, because that is what runs actually fail on
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
export function platformSuffix(run, branchRule, settings, repo = null) {
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
  const zeiger = TASK_POINTER.replaceAll('{task_file}', TASK_FILE).replaceAll('{task_abs}', abs)
  return { prompt: [zeiger, platform].filter(Boolean).join('\n\n'), taskFile: abs }
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
 * leave it dirty for the finish gate). Measured 2026-09-04 on video-production:
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
  const hook = (cmd) => [{ hooks: [{ type: 'command', command: cmd }] }]
  return JSON.stringify({
    hooks: {
      Stop: hook('fl-report _turn_end'),
      SessionEnd: hook('fl-report _exit'),
      Notification: hook('fl-report _idle'),
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

/** Creates the run record (definition copy) and returns the run ID. */
export function createRun({ repoId, agentId = null, harness, model = null, provider = null,
  orProvider = null, orRouting = null, effort = null, prompt, promptExtra = null, goal = null, branchMode, branchPattern = null,
  keepOnBranch = 0, expectedMinutes, skills = null, flows = null, title = null }) {
  if (!getHarness(harness)) throw new Error(t('run.unknown_harness', { harness }))
  if (!isHarnessEnabled(harness)) throw new Error(t('run.harness_not_configured', { harness }))
  if (!prompt?.trim()) throw new Error(t('run.empty_prompt'))
  const id = randomUUID()
  db.prepare(`INSERT INTO runs(id, repo_id, agent_id, status, harness, model, provider, or_provider, or_routing,
              effort, prompt, prompt_extra, goal, branch_mode, branch_pattern, keep_on_branch,
              expected_minutes, skills, flows, title, last_activity_at)
              VALUES(?,?,?, 'running', ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? , datetime('now'))`)
    .run(id, repoId, agentId, harness, model, provider, orProvider,
      orRouting ? JSON.stringify(orRouting) : null, effort, prompt, promptExtra,
      goal, branchMode, branchPattern, keepOnBranch ? 1 : 0, expectedMinutes, skills, flows, title)
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

/**
 * Starts a prepared run: worktree, prompt, fl-start.
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

  // Asked BEFORE the worktree: a coding agent nothing can launch produces a
  // clean failure here instead of a worktree, a session and a puzzled operator.
  if (!launchable(run.harness)) {
    const msg = t('run.no_launch_spec', { harness: run.harness })
    failRun(runId, msg)
    return { ok: false, error: msg }
  }

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
  const platformPrompt = platformSuffix({ ...run, id: runId, workdir_effective: workdir },
    branchRule, settings, repo).trim()
  const fullPrompt = [taskPrompt, platformPrompt].filter(Boolean).join('\n\n')
  // prompt.md is the RECORD — always the whole thing, offload or not. What the
  // CLI is actually launched with is a separate file, so "what was this run
  // asked?" keeps one answer.
  writeFileSync(join(runDir, 'prompt.md'), fullPrompt, { mode: 0o600 })
  const offload = offloadPrompt(run.harness, workdir, taskPrompt, platformPrompt)
  let promptFile = join(runDir, 'prompt.md')
  if (offload.taskFile) {
    promptFile = join(runDir, 'launch-prompt.md')
    writeFileSync(promptFile, offload.prompt, { mode: 0o600 })
    addEvent(runId, 'prompt_offloaded', {
      bytes: Buffer.byteLength(fullPrompt, 'utf8'),
      launch_bytes: Buffer.byteLength(offload.prompt, 'utf8'),
      file: offload.taskFile,
    })
  }

  // Hook files into the workspace (cursor: the 'stop' hook that reports the end
  // of a turn). Fail-soft: a run without hooks still works, it just falls back
  // to the transcript for its end detection.
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
    provider: run.provider ?? null, effort: run.effort ?? null })

  const args = ['--harness', run.harness,
    '--name', (agent?.name ?? 'einzel').toLowerCase().replaceAll(/[^a-z0-9_-]/g, '-'),
    '--id', kurz,
    '--env', `FL_RUN_ID=${runId}`,
    '--env', `FL_HUB_URL=http://127.0.0.1:${env('LOCAL_PORT') ?? '8791'}`,
    // The old names travel with them for one transition release. A run started
    // by this hub is fine either way, but the WORKTREE it starts in may still
    // hold a `.cursor/hooks.json` or a claude settings block written before the
    // rename, and those call `cc-report`, which reads `CC_RUN_ID`. Cheap
    // insurance; the next release drops these two lines.
    '--env', `CC_RUN_ID=${runId}`,
    '--env', `CC_HUB_URL=http://127.0.0.1:${env('LOCAL_PORT') ?? '8791'}`,
    '--log', join(runDir, 'log.txt'), '--keep',
    '-f', promptFile, workdir]
  const modelArgs = harnessModelArgs(run, { externalDirs: runExternalDirs(run, repo, runDir) })
  args.unshift(...modelArgs.args)
  if (modelArgs.fehlt.length) {
    // Better to start and record it visibly than to walk into the knife
    // silently: without a key the run only dies at the agent's first API call.
    addEvent(runId, 'warn', { fehlender_key: modelArgs.fehlt.join(', ') })
  }
  if (run.harness === 'claude') args.unshift('--session-id', runId, '--settings', claudeSettingsJson())
  // A coding agent fl-start has no case for is launched from its own
  // declaration. The file lives next to prompt.md in the run directory — NOT in
  // the worktree, which has to stay clean for the finish gate.
  const spec = launchSpec(run.harness)
  if (spec) {
    const specPath = join(runDir, 'launch.json')
    writeFileSync(specPath, JSON.stringify(spec, null, 2), { mode: 0o600 })
    args.unshift('--spec', specPath)
  }

  const r = await sh(env('START_SCRIPT') ?? `${homedir()}/.local/bin/fl-start`, args, { timeout: 120_000 })
  // fl-start's success line ("Session '<name>' started …"); the German wording
  // is still accepted for older installed scripts.
  const m = r.stdout.match(/Session '([^']+)' (?:started|gestartet)/)
  const session = m ? m[1] : null
  if (!r.ok || !session) {
    failRun(runId, `Start failed (fl-start):\n\n${r.stderr || r.stdout}`)
    return { ok: false, error: r.stderr || r.stdout }
  }
  db.prepare('UPDATE runs SET tmux_session=? WHERE id=?').run(session, runId)
  addEvent(runId, 'tmux_started', { session })
  // The goal is the SECOND prompt and exists only inside the session (claude:
  // `/goal <condition>`), so it goes in now that there IS one. Deliberately not
  // awaited: it waits for the TUI to draw, and a start must not hang on that.
  // Whatever does not get through is picked up by the watcher (server/goal.mjs).
  if (run.goal) deliverGoal(runId).catch(err => addEvent(runId, 'warn', { goal: err.message }))
  return { ok: true, session }
}

export function failRun(runId, text) {
  db.prepare(`UPDATE runs SET status='failed', ended_at=datetime('now'), report_md=? WHERE id=?`)
    .run(text, runId)
  addEvent(runId, 'failed', {})
}
