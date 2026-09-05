#!/usr/bin/env node
// Freilauf — deploy-after-merge.sh in a sandbox of its own.
//
// What is tested here is the post-merge hook: the decision whether a merge may be
// brought live right now. It is a decision with three answers and four ways to say
// "not now", and every one of them is reached through a real merge in a real
// repository — a fixture that only pretended to merge would not exercise
// ORIG_HEAD, the diff, or the origin check, which is most of the script.
//
// Nothing here may reach outside the sandbox, for the same reason test/deploy.mjs
// spells out: the thing under test restarts services.
//
//   HOME                → the sandbox
//   FREILAUF_DEPLOY_DIR → the sandbox (its parent holds the marker and the log)
//   FREILAUF_DATA_DIR   → the sandbox (its database is the run state)
//   PATH                → a shim directory FIRST, holding `systemctl` (it answers
//                         the KillMode question) and `freilauf-deploy` (it only
//                         records that it was called — a test that really deployed
//                         would restart the operator's hub).
//
// The git commands, the merges and the diffs are REAL. `node` is real too: the
// run-state query is `node:sqlite` against a real database file, because a stub
// there would test the stub and not the query, and that query is the whole guard.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, chmodSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { group, check, equal, isTrue, isFalse, contains, waitFor, summary, counter } from './mini.mjs'

const start = Date.now()
const PROJECT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const SKRIPT = join(PROJECT, 'deploy-after-merge.sh')

const SB = mkdtempSync(join(tmpdir(), 'freilauf-post-merge-'))
const HOME = join(SB, 'home')
const ORIGIN = join(SB, 'origin.git')
const WORK = join(SB, 'work')
const STATE = join(SB, 'agents')
const DEPLOY = join(STATE, 'freilauf')
const DATA = join(SB, 'data')
const DB = join(DATA, 'freilauf.db')
const SHIM = join(SB, 'shim')
const CALLS = join(SB, 'calls.log')
const KILLMODE = join(SB, 'killmode')
const MARKER = join(STATE, 'deploy-pending')

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts })
  return { code: r.status, out: String(r.stdout ?? ''), err: String(r.stderr ?? '') }
}

const git = (dir, ...args) => sh('git', ['-C', dir, '-c', 'user.email=t@example.invalid', '-c', 'user.name=test',
  '-c', 'commit.gpgsign=false', ...args])

/** The hook, run the way git runs it: cwd is the merged worktree. */
function hook(...args) {
  return sh('bash', [SKRIPT, ...args], {
    cwd: WORK,
    env: {
      ...process.env,
      HOME,
      PATH: `${SHIM}:${process.env.PATH}`,
      FREILAUF_ENV_FILE: join(SB, 'no-such-env'),
      FREILAUF_DEPLOY_DIR: DEPLOY,
      FREILAUF_DATA_DIR: DATA,
      FREILAUF_DEPLOY_BASE: 'main',
      FREILAUF_TEST_KILLMODE: KILLMODE,
      FREILAUF_TEST_CALLS: CALLS,
      // Explicit, so a machine that has these set cannot send the script out of
      // the sandbox through the old name.
      CCHUB_DEPLOY_DIR: DEPLOY,
      CCHUB_DATA_DIR: DATA,
      XDG_CONFIG_HOME: join(HOME, '.config'),
      XDG_DATA_HOME: join(HOME, '.local', 'share'),
    },
  })
}

/** The machine-readable last line, split into a plain object. */
function schluss(r) {
  const zeile = r.out.trim().split('\n').filter(l => l.startsWith('deploy-after-merge ')).pop() ?? ''
  const feld = {}
  for (const teil of zeile.split(/\s+/).slice(1)) {
    const i = teil.indexOf('=')
    if (i > 0) feld[teil.slice(0, i)] = teil.slice(i + 1)
  }
  return feld
}

const calls = () => (existsSync(CALLS) ? readFileSync(CALLS, 'utf8') : '')
const resetCalls = () => writeFileSync(CALLS, '')
const marker = () => (existsSync(MARKER) ? readFileSync(MARKER, 'utf8') : '')
const clearMarker = () => rmSync(MARKER, { force: true })
const setKillMode = (v) => writeFileSync(KILLMODE, v + '\n')

function shim(name, body) {
  const p = join(SHIM, name)
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`)
  chmodSync(p, 0o755)
}

// ---------------------------------------------------------------- the sandbox
function buildSandbox() {
  for (const d of [HOME, SHIM, STATE, DATA, join(HOME, '.config'), join(HOME, '.local', 'share')]) {
    mkdirSync(d, { recursive: true })
  }

  // systemd is never really asked: the hook wants one property, and the answer is
  // whatever the test wrote into a file.
  shim('systemctl', `
echo "systemctl $*" >> "\${FREILAUF_TEST_CALLS:-/dev/null}"
for a in "$@"; do [[ "$a" == "KillMode" || "$a" == "-p" ]] && found=1; done
if [[ "\${found:-}" == 1 ]]; then cat "\${FREILAUF_TEST_KILLMODE}"; exit 0; fi
# is-active / is-enabled — fl-paths.sh asks this to resolve the unit name.
echo active
`)
  // A deploy that only says it happened. The real one restarts the hub.
  shim('freilauf-deploy', `
echo "freilauf-deploy $*" >> "\${FREILAUF_TEST_CALLS:-/dev/null}"
`)
  resetCalls()
  setKillMode('process')

  // origin + a working clone
  sh('git', ['init', '--quiet', '--bare', '-b', 'main', ORIGIN])
  sh('git', ['clone', '--quiet', ORIGIN, WORK])
  mkdirSync(join(WORK, 'server'), { recursive: true })
  mkdirSync(join(WORK, 'docs'), { recursive: true })
  writeFileSync(join(WORK, 'server', 'hub.mjs'), '// hub\n')
  writeFileSync(join(WORK, 'docs', 'plugins.md'), '# docs\n')
  git(WORK, 'add', '-A')
  git(WORK, 'commit', '--quiet', '-m', 'base')
  git(WORK, 'push', '--quiet', '-u', 'origin', 'main')

  freshDb()
}

/** A database with the two tables the guard reads, and nothing in them. */
function freshDb() {
  rmSync(DB, { force: true })
  const db = new DatabaseSync(DB)
  db.exec(`CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'running'
      CHECK(status IN ('scheduled','deferred','running','waiting_help','done','failed','aborted')),
    finish_state TEXT)`)
  db.exec(`CREATE TABLE flow_runs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'running'
      CHECK(status IN ('running','waiting','done','failed','stopped')))`)
  db.close()
}

const addRun = (id, status, finishState = null) => {
  const db = new DatabaseSync(DB)
  db.prepare('INSERT INTO runs (id, status, finish_state) VALUES (?,?,?)').run(id, status, finishState)
  db.close()
}
const addFlowRun = (id, status) => {
  const db = new DatabaseSync(DB)
  db.prepare('INSERT INTO flow_runs (id, status) VALUES (?,?)').run(id, status)
  db.close()
}
const clearRuns = () => {
  const db = new DatabaseSync(DB)
  db.exec('DELETE FROM runs'); db.exec('DELETE FROM flow_runs')
  db.close()
}

/**
 * A real merge of a real branch, so ORIG_HEAD, the diff and the parents are what
 * git actually produces. `push` decides whether origin already has the result —
 * that is the difference between "on origin" and "the hub has merged but not
 * pushed yet", which is a state the hook has to recognise.
 */
function mergeBranch(name, files, { push = true } = {}) {
  git(WORK, 'checkout', '--quiet', '-b', name)
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(WORK, p, '..'), { recursive: true })
    writeFileSync(join(WORK, p), c)
  }
  git(WORK, 'add', '-A')
  git(WORK, 'commit', '--quiet', '-m', `work on ${name}`)
  git(WORK, 'checkout', '--quiet', 'main')
  git(WORK, 'merge', '--quiet', '--no-ff', '-m', `Merge ${name}`, name)
  if (push) git(WORK, 'push', '--quiet', 'origin', 'main')
  git(WORK, 'fetch', '--quiet', 'origin')
}

// ---------------------------------------------------------------- the suite
try {
  buildSandbox()

  // ------------------------------------------------------------------
  group('Nothing that ships changed — the hook stays out of the way')

  await check('a documentation-only merge deploys nothing and marks nothing', async () => {
    resetCalls(); clearMarker(); clearRuns()
    mergeBranch('docs-only', { 'docs/plugins.md': '# docs, but longer\n' })
    const r = hook('0')
    const s = schluss(r)
    equal(r.code, 0, 'exit code')
    equal(s.result, 'skipped', 'result')
    equal(s.reason, 'no-shipping-change', 'reason')
    isFalse(calls().includes('freilauf-deploy'), 'no deploy was started')
    equal(marker(), '', 'and nothing was left pending')
  })

  await check('a README the hub never reads is not a reason to restart', async () => {
    resetCalls(); clearMarker()
    mergeBranch('readme', { 'README.md': '# Freilauf\n', 'GATES.md': '# gates\n' })
    const s = schluss(hook('0'))
    equal(s.result, 'skipped', 'result')
    equal(s.relevant, '0', 'no shipping file among them')
    isFalse(calls().includes('freilauf-deploy'), 'no deploy was started')
  })

  // ------------------------------------------------------------------
  group('It ships, it is on origin, nothing is running — deploy')

  await check('a server change with no active run deploys', async () => {
    resetCalls(); clearMarker(); clearRuns()
    mergeBranch('server-change', { 'server/hub.mjs': '// hub, changed\n' })
    const r = hook('0')
    const s = schluss(r)
    equal(r.code, 0, 'exit code')
    equal(s.result, 'deployed', 'result')
    equal(s.reason, 'started', 'reason')
    equal(s.active, '0', 'no run was active')
    await waitFor(() => calls().includes('freilauf-deploy'), { what: 'the detached deploy to be called' })
    equal(marker(), '', 'nothing is pending — it is being deployed')
  })

  await check('a translation counts as shipping code (i18n is read at startup)', async () => {
    resetCalls(); clearMarker()
    mergeBranch('lang', { 'lang/de.json': '{"a":"b"}\n' })
    const s = schluss(hook('0'))
    equal(s.result, 'deployed', 'result')
    await waitFor(() => calls().includes('freilauf-deploy'), { what: 'the deploy call' })
  })

  await check('--dry-run decides but changes nothing', async () => {
    resetCalls(); clearMarker()
    mergeBranch('dry', { 'server/web.mjs': '// web\n' })
    const s = schluss(hook('--dry-run'))
    equal(s.result, 'deployed', 'result')
    equal(s.reason, 'dry-run', 'reason')
    isFalse(calls().includes('freilauf-deploy'), 'but no deploy was started')
    equal(marker(), '', 'and no marker was written')
  })

  // ------------------------------------------------------------------
  group('It ships, but not now — pending, and visibly so')

  await check('a running run stops the deploy and leaves a marker', async () => {
    resetCalls(); clearMarker(); clearRuns()
    addRun('r1', 'running')
    mergeBranch('while-busy', { 'server/hub.mjs': '// hub, again\n' })
    const r = hook('0')
    const s = schluss(r)
    equal(r.code, 0, 'exit code is still 0')
    equal(s.result, 'pending', 'result')
    equal(s.reason, 'runs-active', 'reason')
    equal(s.active, '1', 'one active run was counted')
    isFalse(calls().includes('freilauf-deploy'), 'nothing was deployed')
    contains(marker(), 'reason=runs-active', 'the marker says why')
    contains(marker(), 'sha=', 'and which commit is waiting')
  })

  await check('a scheduled run counts as active — it is about to start', async () => {
    clearMarker(); clearRuns(); addRun('r2', 'scheduled')
    mergeBranch('scheduled', { 'server/hub.mjs': '// s\n' })
    const s = schluss(hook('0'))
    equal(s.result, 'pending', 'result')
    equal(s.active, '1', 'counted')
  })

  await check('a DONE run that is still integrating counts as active', async () => {
    clearMarker(); clearRuns()
    // The subtle one: status says done, the integration is mid-merge. Restarting
    // here restarts into a running `git merge`.
    addRun('r3', 'done', 'merging')
    mergeBranch('mid-merge', { 'server/hub.mjs': '// m\n' })
    const s = schluss(hook('0'))
    equal(s.result, 'pending', 'result')
    equal(s.reason, 'runs-active', 'reason')
    equal(s.active, '1', 'finish_state was taken into account')
  })

  await check('a waiting flow run counts as active too', async () => {
    clearMarker(); clearRuns(); addFlowRun('f1', 'waiting')
    mergeBranch('flow', { 'server/flows/engine.mjs': '// e\n' })
    const s = schluss(hook('0'))
    equal(s.result, 'pending', 'result')
    equal(s.active, '1', 'the flow run was counted')
  })

  await check('a merge that is not on origin yet is never deployed', async () => {
    clearMarker(); clearRuns(); resetCalls()
    // Exactly the hub's integration worktree between `git merge` and `git push`.
    // That merge may still be thrown away, so deploying it would publish a commit
    // that is about to disappear.
    mergeBranch('unpushed', { 'server/hub.mjs': '// not pushed\n' }, { push: false })
    const s = schluss(hook('0'))
    equal(s.result, 'pending', 'result')
    equal(s.reason, 'not-on-origin', 'reason')
    isFalse(calls().includes('freilauf-deploy'), 'nothing was deployed')
    contains(marker(), 'reason=not-on-origin', 'the marker says why')
    git(WORK, 'push', '--quiet', 'origin', 'main')   // tidy up for the tests below
    git(WORK, 'fetch', '--quiet', 'origin')
  })

  await check('KillMode other than process refuses the restart', async () => {
    clearMarker(); clearRuns(); resetCalls()
    // The one hard guard: the tmux server and the pipe-pane loggers of every run
    // sit in this unit's cgroup, so with the systemd default a restart takes every
    // agent session down with it.
    setKillMode('control-group')
    mergeBranch('killmode', { 'server/hub.mjs': '// k\n' })
    const s = schluss(hook('0'))
    equal(s.result, 'pending', 'result')
    equal(s.reason, 'killmode', 'reason')
    isFalse(calls().includes('freilauf-deploy'), 'nothing was deployed')
    contains(marker(), 'control-group', 'the marker names what it found')
    setKillMode('process')
  })

  await check('an unreadable run state is treated as busy, not as free', async () => {
    clearMarker(); clearRuns(); resetCalls()
    const gesichert = readFileSync(DB)
    writeFileSync(DB, 'this is not a database')
    mergeBranch('broken-db', { 'server/hub.mjs': '// b\n' })
    const s = schluss(hook('0'))
    equal(s.result, 'pending', 'result')
    equal(s.reason, 'state-unreadable', 'reason')
    isFalse(calls().includes('freilauf-deploy'), 'a guard that cannot measure does not wave through')
    writeFileSync(DB, gesichert)
  })

  // ------------------------------------------------------------------
  group('It can never be the reason a merge fails')

  await check('a broken environment still exits 0 and still says why', async () => {
    clearMarker(); clearRuns()
    const r = sh('bash', [SKRIPT, '0'], {
      cwd: SB,                                  // not a git worktree at all
      env: { ...process.env, HOME, PATH: `${SHIM}:${process.env.PATH}`, FREILAUF_DEPLOY_DIR: DEPLOY, FREILAUF_DATA_DIR: DATA },
    })
    equal(r.code, 0, 'exit code')
    contains(r.out, 'deploy-after-merge result=', 'the last line is there anyway')
  })

  await check('FREILAUF_POST_MERGE=off switches it off entirely', async () => {
    resetCalls(); clearMarker(); clearRuns()
    mergeBranch('switched-off', { 'server/hub.mjs': '// off\n' })
    const r = sh('bash', [SKRIPT, '0'], {
      cwd: WORK,
      env: { ...process.env, HOME, PATH: `${SHIM}:${process.env.PATH}`, FREILAUF_DEPLOY_DIR: DEPLOY,
        FREILAUF_DATA_DIR: DATA, FREILAUF_POST_MERGE: 'off' },
    })
    const s = schluss(r)
    equal(s.result, 'skipped', 'result')
    equal(s.reason, 'disabled', 'reason')
    isFalse(calls().includes('freilauf-deploy'), 'nothing was deployed')
  })

  await check('--help explains itself and deploys nothing', async () => {
    resetCalls()
    const r = sh('bash', [SKRIPT, '--help'], { cwd: WORK, env: { ...process.env, HOME, PATH: `${SHIM}:${process.env.PATH}` } })
    equal(r.code, 0, 'exit code')
    contains(r.out, 'WHY THIS IS NOT', 'it says why it is not a restart')
    isFalse(calls().includes('freilauf-deploy'), 'nothing was deployed')
  })

  // ------------------------------------------------------------------
  group('Backout counter-check: the guards are what produce the result')

  /**
   * A test that passes with the check removed is not testing the check. So the
   * check is really removed — from a copy — and the fixture that depends on it
   * has to go red. If it does not, the assertion above is decoration.
   */
  function ohne(regex, was) {
    const quelle = readFileSync(SKRIPT, 'utf8')
    const kaputt = quelle.replace(regex, '')
    if (kaputt === quelle) throw new Error(`the backout for "${was}" matched nothing — the script has changed shape, fix this test`)
    // The copy has to keep its bearings: the script finds bin/fl-paths.sh next to
    // itself, so the mutant needs a root that looks like the repository's.
    const wurzel = join(SB, `backout-${was}`)
    mkdirSync(join(wurzel, 'bin'), { recursive: true })
    cpSync(join(PROJECT, 'bin', 'fl-paths.sh'), join(wurzel, 'bin', 'fl-paths.sh'))
    const p = join(wurzel, 'deploy-after-merge.sh')
    writeFileSync(p, kaputt)
    return p
  }

  await check('removing the active-run check makes the busy fixture deploy', async () => {
    clearMarker(); clearRuns(); resetCalls()
    addRun('r9', 'running')
    mergeBranch('backout-active', { 'server/hub.mjs': '// ba\n' })

    // With the guard in place: pending.
    equal(schluss(hook('0')).reason, 'runs-active', 'the guard holds first')
    isFalse(calls().includes('freilauf-deploy'), 'and nothing was deployed')

    // Guard cut out: the very same fixture now deploys into a running run.
    const kaputt = ohne(/if \[\[ "\$ACTIVE" != 0 \]\]; then[\s\S]*?\nfi\n/, 'active')
    resetCalls(); clearMarker()
    const r = sh('bash', [kaputt, '0'], {
      cwd: WORK,
      env: { ...process.env, HOME, PATH: `${SHIM}:${process.env.PATH}`, FREILAUF_DEPLOY_DIR: DEPLOY,
        FREILAUF_DATA_DIR: DATA, FREILAUF_TEST_KILLMODE: KILLMODE, FREILAUF_TEST_CALLS: CALLS },
    })
    equal(schluss(r).result, 'deployed', 'without the guard it deploys')
    await waitFor(() => calls().includes('freilauf-deploy'), { what: 'the deploy the guard was preventing' })
  })

  await check('removing the origin check makes the unpushed fixture deploy', async () => {
    clearMarker(); clearRuns(); resetCalls()
    mergeBranch('backout-origin', { 'server/hub.mjs': '// bo\n' }, { push: false })

    equal(schluss(hook('0')).reason, 'not-on-origin', 'the guard holds first')

    const kaputt = ohne(/if ! git merge-base --is-ancestor[\s\S]*?\nfi\n/, 'origin')
    resetCalls(); clearMarker()
    const r = sh('bash', [kaputt, '0'], {
      cwd: WORK,
      env: { ...process.env, HOME, PATH: `${SHIM}:${process.env.PATH}`, FREILAUF_DEPLOY_DIR: DEPLOY,
        FREILAUF_DATA_DIR: DATA, FREILAUF_TEST_KILLMODE: KILLMODE, FREILAUF_TEST_CALLS: CALLS },
    })
    equal(schluss(r).result, 'deployed', 'without the guard it deploys an unpushed merge')
    git(WORK, 'push', '--quiet', 'origin', 'main')
  })

  await check('removing the path filter makes a docs-only merge deploy', async () => {
    clearMarker(); clearRuns(); resetCalls()
    mergeBranch('backout-paths', { 'docs/plugins.md': '# docs again\n' })

    equal(schluss(hook('0')).reason, 'no-shipping-change', 'the filter holds first')

    const kaputt = ohne(/if \[\[ "\$RELEVANT" == 0 \]\]; then[\s\S]*?\nfi\n/, 'paths')
    resetCalls(); clearMarker()
    const r = sh('bash', [kaputt, '0'], {
      cwd: WORK,
      env: { ...process.env, HOME, PATH: `${SHIM}:${process.env.PATH}`, FREILAUF_DEPLOY_DIR: DEPLOY,
        FREILAUF_DATA_DIR: DATA, FREILAUF_TEST_KILLMODE: KILLMODE, FREILAUF_TEST_CALLS: CALLS },
    })
    equal(schluss(r).result, 'deployed', 'without the filter even documentation restarts the hub')
  })

  // ------------------------------------------------------------------
  group('The operator\'s own machine is none of its business')

  await check('nothing outside the sandbox was written', () => {
    const echt = join(process.env.HOME ?? '', '.local/share')
    isFalse(DATA.startsWith(echt), 'the data dir is the sandbox one')
    isFalse(calls().includes('/projects/'), 'no working copy was touched')
    isTrue(existsSync(join(STATE, 'post-merge.log')), 'the log went into the sandbox state dir')
  })
} catch (err) {
  counter.failures.push({ name: 'suite', reason: err.stack ?? String(err) })
  console.error(err)
} finally {
  // The deploys this suite starts are DETACHED — that is the point of them — so a
  // shim may still be writing into the sandbox while it is being removed. Let them
  // finish, then remove; and if one is still going, leave the mkdtemp directory to
  // the operating system rather than failing a suite that has already passed.
  await new Promise(r => setTimeout(r, 500))
  try {
    rmSync(SB, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch { /* /tmp cleans itself; a green suite must not go red over housekeeping */ }
}

process.exit(summary('post-merge', start))
