#!/usr/bin/env node
// Freilauf — bin/freilauf-deploy in a sandbox of its own.
//
// Why a file of its own, next to test/proxy.mjs: what is tested here is not the
// hub but the SHELL SCRIPT that brings a commit of it live — a bare origin, a
// clone, a checkout that moves, a rollback. The e2e suite starts a hub; this one
// must never start one, because the thing under test restarts services and
// installs scripts into ~/.local/bin.
//
// Which is exactly why nothing here may reach outside the sandbox:
//
//   HOME             → the sandbox, so setup/02-install-scripts.sh writes its
//                      fl-* scripts, the opencode plugin and the systemd units
//                      into the sandbox and never into the operator's ~/.local/bin
//   FREILAUF_DEPLOY_DIR → the sandbox
//   PATH             → a shim directory FIRST, holding systemctl, curl, npm,
//                      journalctl and fl-notify. They log every call and answer
//                      what the test tells them to: `curl` prints the HTTP status
//                      from a file (that is how the unhealthy deploy is
//                      provoked), `npm` creates node_modules instead of
//                      installing anything, and `fl-notify` is only counted —
//                      the deploy script must not need a configured channel, or
//                      a hub nobody set one up for could not be deployed.
//
// The git commands, the flock and the checkout are REAL — that is the half of the
// script a stub could not test.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, cpSync, existsSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { group, check, skipped, equal, isTrue, isFalse, contains, summary, counter } from './mini.mjs'

const start = Date.now()
const PROJEKT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const SKRIPT = join(PROJEKT, 'bin', 'freilauf-deploy')

const SB = mkdtempSync(join(tmpdir(), 'freilauf-deploy-'))
const HOME = join(SB, 'home')
const ORIGIN = join(SB, 'origin.git')
const WORK = join(SB, 'work')
const DEPLOY = join(SB, 'deploy', 'freilauf')
const SHIM = join(SB, 'shim')
const CALLS = join(SB, 'calls.log')
const STATUS_FILE = join(SB, 'http-status')
// Which systemd unit the shim reports as ACTIVE. That is the whole input to the
// unit-name resolver in bin/fl-paths.sh: an installation that has not been
// migrated yet is still run by cchub.service, and a deploy that restarted
// anything else would leave the hub down.
const ACTIVE_FILE = join(SB, 'active-unit')
const setActiveUnit = (name) => writeFileSync(ACTIVE_FILE, name + '\n')

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts })
  return { code: r.status, out: String(r.stdout ?? ''), err: String(r.stderr ?? '') }
}

const git = (dir, ...args) => sh('git', ['-C', dir, '-c', 'user.email=t@example.invalid', '-c', 'user.name=test',
  '-c', 'commit.gpgsign=false', ...args])

/** freilauf-deploy, with everything pointed at the sandbox. */
function deploy(...args) {
  return sh('bash', [SKRIPT, ...args], {
    cwd: SB,
    env: {
      ...process.env,
      HOME,
      PATH: `${SHIM}:${process.env.PATH}`,
      FREILAUF_ENV_FILE: join(SB, 'no-such-env'),   // never read the operator's config
      FREILAUF_DEPLOY_DIR: DEPLOY,
      FREILAUF_DEPLOY_BASE: 'main',
      FREILAUF_DATA_DIR: join(SB, 'data'),          // no database → nothing to notify, base falls back
      FREILAUF_LOCAL_PORT: '9999',
      FREILAUF_DEPLOY_HEALTH_SECONDS: '2',          // 20 s of retrying would make the suite crawl
      FREILAUF_SKIP_EXTRAS: '1',                    // setup/02 must not clone from GitHub here
      FREILAUF_TEST_CALLS: CALLS,
      FREILAUF_TEST_STATUS: STATUS_FILE,
      FREILAUF_TEST_ACTIVE: ACTIVE_FILE,
      // Explicit, so a machine that has these set in its own environment cannot
      // send the script outside the sandbox: everything here resolves through
      // ${XDG_CONFIG_HOME:-$HOME/.config}.
      XDG_CONFIG_HOME: join(HOME, '.config'),
      XDG_DATA_HOME: join(HOME, '.local', 'share'),
    },
  })
}

/** setup/migrate-from-cc-hub.sh, with the same sandbox fences. */
function migrate(...args) {
  return sh('bash', [join(PROJEKT, 'setup', 'migrate-from-cc-hub.sh'), ...args], {
    cwd: SB,
    env: {
      ...process.env,
      HOME,
      PATH: `${SHIM}:${process.env.PATH}`,
      XDG_CONFIG_HOME: join(HOME, '.config'),
      XDG_DATA_HOME: join(HOME, '.local', 'share'),
      FREILAUF_TEST_CALLS: CALLS,
      FREILAUF_TEST_ACTIVE: ACTIVE_FILE,
      FREILAUF_SKIP_EXTRAS: '1',   // setup/02 must not clone from GitHub here
    },
  })
}

const calls = () => (existsSync(CALLS) ? readFileSync(CALLS, 'utf8') : '')
const callCount = (needle) => calls().split('\n').filter(l => l.includes(needle)).length
const resetCalls = () => writeFileSync(CALLS, '')
/** The HTTP statuses the curl shim will answer, in order; the last one repeats. */
const setStatus = (...codes) => writeFileSync(STATUS_FILE, codes.join('\n') + '\n')
const head = () => git(DEPLOY, 'rev-parse', 'HEAD').out.trim()
const deployLog = () => readFileSync(join(SB, 'deploy', 'freilauf-deploy.log'), 'utf8')

function shim(name, body) {
  const p = join(SHIM, name)
  writeFileSync(p, `#!/usr/bin/env bash\nprintf '${name} %s\\n' "$*" >> "$FREILAUF_TEST_CALLS"\n${body}\n`)
  chmodSync(p, 0o755)
}

// ------------------------------------------------------------------ the sandbox
function buildSandbox() {
  mkdirSync(HOME, { recursive: true })
  mkdirSync(SHIM, { recursive: true })
  writeFileSync(CALLS, '')
  setStatus('200')

  // systemd: is-active answers for whichever unit the test declared active (that
  // is what the unit-name resolver reads), is-enabled says "disabled" for
  // everything, and every other verb simply succeeds. Both VPN units are
  // inactive, as after a reboot.
  setActiveUnit('freilauf.service')
  shim('systemctl', `
aktiv="$(cat "$FREILAUF_TEST_ACTIVE" 2>/dev/null || echo freilauf.service)"
case "$*" in
  *"is-active $aktiv"*) echo active; exit 0 ;;
  *is-active*)          echo inactive; exit 3 ;;
  *is-enabled*)         echo disabled; exit 1 ;;
esac
exit 0`)
  // curl: the health check reads its status from a file the test writes — one
  // status per line, each consumed once, the last one staying forever. That is
  // what makes "the deploy is unhealthy but the rollback is fine" expressible at
  // all.
  shim('curl', `
s="$(head -1 "$FREILAUF_TEST_STATUS")"
rest="$(tail -n +2 "$FREILAUF_TEST_STATUS")"
if [[ -n "$rest" ]]; then printf '%s\\n' "$rest" > "$FREILAUF_TEST_STATUS"; fi
printf '%s' "$s"
exit 0`)
  // fl-notify: counted, never run. The real one loads the hub's plugins and
  // calls the notification facade; here the only question is whether the deploy
  // script reaches for it at all, and that it survives it not being there (the
  // `command -v` guard, exercised by the deploys that do not fail).
  shim('fl-notify', 'exit 0')
  // npm: creates what npm ci would leave behind, and nothing else. Compiling
  // node-pty in a test is exactly the cost the lockfile-hash check exists to avoid.
  shim('npm', 'mkdir -p node_modules; exit 0')
  shim('journalctl', 'exit 0')

  sh('git', ['init', '--quiet', '--bare', '-b', 'main', ORIGIN])
  sh('git', ['clone', '--quiet', ORIGIN, WORK])
  // Only what a deploy really touches: the scripts it installs, the units it
  // syncs, and the two files the dependency check reads.
  for (const p of ['bin', 'setup', 'deploy', 'package.json', 'package-lock.json']) {
    cpSync(join(PROJEKT, p), join(WORK, p), { recursive: true })
  }
  writeFileSync(join(WORK, 'marker.txt'), 'one\n')
  git(WORK, 'add', '-A')
  git(WORK, 'commit', '--quiet', '-m', 'first commit')
  git(WORK, 'push', '--quiet', '-u', 'origin', 'main')
}

/** A new commit on origin/main; returns its sha. */
function newCommit(message, file = 'marker.txt', content = String(Date.now())) {
  writeFileSync(join(WORK, file), content + '\n')
  git(WORK, 'add', '-A')
  git(WORK, 'commit', '--quiet', '-m', message)
  git(WORK, 'push', '--quiet', 'origin', 'main')
  return git(WORK, 'rev-parse', 'HEAD').out.trim()
}

// ------------------------------------------------------------------ run
try {
  if (sh('git', ['--version']).code !== 0) {
    group('freilauf-deploy')
    skipped('the whole suite', 'git is missing')
  } else {
    buildSandbox()

    // ------------------------------------------------------------------
    group('freilauf-deploy --init: the deploy checkout comes into being')

    const c1 = git(WORK, 'rev-parse', 'HEAD').out.trim()

    await check('--init clones, checks out detached on origin/main and installs the deps once', () => {
      const r = deploy('--init', '--url', ORIGIN)
      equal(r.code, 0, `exit code (${r.out}${r.err})`)
      isTrue(existsSync(join(DEPLOY, '.git')), 'the checkout exists')
      equal(head(), c1, 'it stands on the first commit')
      isFalse(git(DEPLOY, 'symbolic-ref', '-q', 'HEAD').code === 0,
        'and DETACHED — nobody commits here, and git status stays empty')
      equal(callCount('npm ci'), 1, 'npm ci ran exactly once')
      isTrue(existsSync(join(DEPLOY, '.deploy-lock-hash')), 'the lockfile hash is written down')
      isTrue(existsSync(join(HOME, '.local/bin/fl-report')), 'the fl-* scripts went into ~/.local/bin')
      isTrue(existsSync(join(HOME, '.local/bin/freilauf-deploy')), 'including the deploy script itself')
      isTrue(existsSync(join(HOME, '.config/systemd/user/freilauf.service')), 'and the units are in place')
      equal(callCount('restart freilauf.service'), 1, 'the hub was restarted once')
    })

    // ------------------------------------------------------------------
    group('Nothing new: nothing happens')

    await check('a second deploy without a new commit restarts nothing', () => {
      resetCalls()
      const r = deploy()
      equal(r.code, 0, 'exit code')
      contains(r.out, 'already deployed', 'it says so')
      equal(callCount('systemctl'), 0, 'and did not touch systemd — a restart is not free')
      equal(callCount('npm ci'), 0, 'nor npm')
    })

    // ------------------------------------------------------------------
    group('A new commit: the checkout moves, the hub restarts')

    const c2 = newCommit('second commit')

    await check('deploy follows origin/main and records what it replaced', () => {
      resetCalls()
      const r = deploy()
      equal(r.code, 0, `exit code (${r.out}${r.err})`)
      equal(head(), c2, 'the checkout stands on the new commit')
      equal(callCount('restart freilauf.service'), 1, 'restarted once')
      equal(readFileSync(join(SB, 'deploy', 'previous-sha'), 'utf8').trim(), c1,
        'previous-sha is what was running before — that IS the rollback')
      contains(r.out, 'deployed', 'and it says what it deployed')
    })

    await check('the dependencies are not reinstalled for an unchanged lockfile', () => {
      equal(callCount('npm ci'), 0, 'node-pty compiles for minutes — not on every deploy')
    })

    // ------------------------------------------------------------------
    group('The hub does not come up: rollback')

    const c3 = newCommit('third commit, and the hub will not answer')

    await check('an unhealthy hub sends the checkout back and exits 1', () => {
      resetCalls()
      // Two 000 for the health check of the new commit (FREILAUF_DEPLOY_HEALTH_SECONDS=2),
      // then 200: the rollback has to come up, otherwise this is the exit-2 case.
      setStatus('000', '000', '200')
      const r = deploy()
      equal(r.code, 1, `exit code (${r.out}${r.err})`)
      equal(head(), c2, 'the checkout is back on the commit that was running')
      isTrue(callCount('restart freilauf.service') >= 2, 'restarted a second time, for the rollback')
      contains(r.out, 'rolled back', 'the reason is in the output')
      contains(deployLog(), 'rolled back', 'and in the deploy log')
      contains(deployLog(), c3.slice(0, 7), 'naming the commit that failed')
      // A FAILURE always notifies — through fl-notify, so it reaches whatever
      // channel the operator configured, and nothing at all when they
      // configured none. It used to be a second Telegram implementation in
      // bash, reading the bot token out of the database with a curl behind it.
      isTrue(callCount('fl-notify') >= 1, 'and the operator was told, through the notification CLI')
      contains(calls(), '--kind deploy', 'the message says what it is about')
    })

    // ------------------------------------------------------------------
    group('The lockfile decides whether npm runs')

    await check('a changed package-lock.json means npm ci, an unchanged one does not', () => {
      setStatus('200')
      const lock = JSON.parse(readFileSync(join(WORK, 'package-lock.json'), 'utf8'))
      lock.freilaufTestMarker = 'changed'
      newCommit('fourth commit: lockfile changed', 'package-lock.json', JSON.stringify(lock, null, 2))
      resetCalls()
      let r = deploy()
      equal(r.code, 0, `exit code (${r.out}${r.err})`)
      equal(callCount('npm ci'), 1, 'the lockfile changed → npm ci')

      newCommit('fifth commit: only the marker')
      resetCalls()
      r = deploy()
      equal(r.code, 0, `exit code (${r.out}${r.err})`)
      equal(callCount('npm ci'), 0, 'the lockfile did not → no npm ci')
    })

    // ------------------------------------------------------------------
    group('--status and --rollback')

    await check('--status names the deployed commit and the one on origin', () => {
      const c6 = newCommit('sixth commit, deliberately not deployed')
      resetCalls()
      const r = deploy('--status')
      equal(r.code, 0, 'exit code')
      contains(r.out, head().slice(0, 7), 'the deployed sha')
      contains(r.out, c6.slice(0, 7), 'the sha on origin/main')
      contains(r.out, 'Ahead:', 'and how far behind the deployment is')
      equal(callCount('systemctl'), 0, 'a status question restarts nothing')
    })

    await check('--rollback puts the previously deployed commit back', () => {
      const before = readFileSync(join(SB, 'deploy', 'previous-sha'), 'utf8').trim()
      resetCalls()
      const r = deploy('--rollback')
      equal(r.code, 0, `exit code (${r.out}${r.err})`)
      equal(head(), before, 'the checkout stands on the previous commit again')
      equal(callCount('restart freilauf.service'), 1, 'and the hub was restarted for it')
    })

    // ------------------------------------------------------------------
    group('Notifying is best effort, and optional')

    await check('a successful deploy stays quiet unless --notify says otherwise', () => {
      const c = newCommit('a commit worth announcing')
      resetCalls()
      let r = deploy()
      equal(r.code, 0, `exit code (${r.out}${r.err})`)
      equal(head(), c, 'deployed')
      equal(callCount('fl-notify'), 0, 'an ordinary success says nothing')

      const c2b = newCommit('and this one is announced')
      resetCalls()
      r = deploy('--notify')
      equal(r.code, 0, `exit code (${r.out}${r.err})`)
      equal(head(), c2b, 'deployed')
      equal(callCount('fl-notify'), 1, 'with --notify it announces itself once')
      contains(calls(), '--kind deploy', 'and says what the message is about')
    })

    // ------------------------------------------------------------------
    group('The old names keep working (transition shims)')

    await check('every old script name is installed as a shim next to the new one', () => {
      const bin = join(HOME, '.local', 'bin')
      for (const [alt, neu] of [['cc-start', 'fl-start'], ['cc-attach', 'fl-attach'], ['cc-kill', 'fl-kill'],
        ['cc-help', 'fl-help'], ['cc-report', 'fl-report'], ['cc-notify', 'fl-notify'],
        ['cc-oc-sync-agents', 'fl-oc-sync-agents'], ['cc-session-cleanup', 'fl-session-cleanup'],
        ['cchub', 'freilauf'], ['cchub-deploy', 'freilauf-deploy']]) {
        isTrue(existsSync(join(bin, alt)), `${alt} exists`)
        contains(readFileSync(join(bin, alt), 'utf8'), `/${neu}" "$@"`, `${alt} execs ${neu}`)
      }
      // The two sourced libraries have to land there as well: fl-attach, fl-kill,
      // fl-help, freilauf and freilauf-deploy all look for them next to themselves.
      isTrue(existsSync(join(bin, 'fl-harness-tags.sh')), 'fl-harness-tags.sh')
      isTrue(existsSync(join(bin, 'fl-paths.sh')), 'fl-paths.sh')
    })

    await check('a shim really reaches the new script — this is what an in-flight run calls', () => {
      // The prompt of a run that started before the rename says `cc-report`, and
      // its claude hooks and .cursor/hooks.json say it too. None of those can be
      // rewritten from here, so the name has to keep working.
      const r = sh('bash', [join(HOME, '.local', 'bin', 'cc-report'), 'progress', 'hallo'], {
        env: { ...process.env, FL_RUN_ID: '', CC_RUN_ID: '' },
      })
      contains(r.err, 'fl-report:', 'the shim landed in fl-report (which then says it has no run id)')
      equal(r.code, 3, 'and exits with fl-report\'s own code, not the shell\'s')
    })

    await check('and fl-report still answers to the OLD environment variable', () => {
      // A tmux session that is running right now carries CC_RUN_ID, set at a
      // start that happened before this release existed.
      // Fenced against the CALLER's own run environment: a suite started by an
      // agent inside a Freilauf worktree inherits FL_RUN_ID/FL_HUB_URL, and the
      // new names win — without the fence the check would report to the real
      // hub (or nothing) instead of proving what it is here to prove.
      const { FL_RUN_ID: _r, FL_HUB_URL: _h, ...uebrig } = process.env
      const r = sh('bash', [join(HOME, '.local', 'bin', 'cc-report'), 'progress', 'hallo'], {
        env: { ...uebrig, CC_RUN_ID: 'r1', CC_HUB_URL: 'http://127.0.0.1:1' },
      })
      // No hub on that port, so it files the report in the inbox instead — which
      // is exactly the proof that it got as far as having a run id.
      contains(r.err, 'hub not reachable', 'it got a run id from CC_RUN_ID and tried')
    })

    await check('the opencode plugin is renamed, and the old file is REMOVED', () => {
      const dir = join(HOME, '.config', 'opencode', 'plugins')
      // opencode loads every file in that directory: leaving the old one there
      // would report every idle and every API error twice.
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'cc-hub.js'), '// the old one\n')
      sh('bash', [join(PROJEKT, 'setup', '02-install-scripts.sh')], {
        env: { ...process.env, HOME, PATH: `${SHIM}:${process.env.PATH}`, FREILAUF_SKIP_EXTRAS: '1' },
      })
      isFalse(existsSync(join(dir, 'cc-hub.js')), 'the old plugin file is gone')
      isTrue(existsSync(join(dir, 'freilauf.js')), 'and the new one is there')
      const js = readFileSync(join(dir, 'freilauf.js'), 'utf8')
      contains(js, 'export const Freilauf', 'exported under the new name')
      contains(js, 'process.env.CC_RUN_ID', 'and it still reads the old run-id variable')
    })

    // ------------------------------------------------------------------
    group('Which unit runs this hub')

    await check('an installation still run by cchub.service is restarted as cchub.service', () => {
      // This is the case the whole transition hangs on: the first deploy of the
      // renamed code lands on a machine whose hub is still the old unit. A
      // resolver that went by "is the new unit file installed?" would restart a
      // unit that is neither enabled nor started — and the hub would stay down.
      setActiveUnit('cchub.service')
      const c = newCommit('a commit deployed onto an un-migrated installation')
      resetCalls()
      const r = deploy()
      equal(r.code, 0, `exit code (${r.out}${r.err})`)
      equal(head(), c, 'deployed')
      equal(callCount('restart cchub.service'), 1, 'the OLD unit was restarted')
      equal(callCount('restart freilauf.service'), 0, 'and the new one was left alone')
    })

    await check('once freilauf.service is the one running, that is the one restarted', () => {
      setActiveUnit('freilauf.service')
      const c = newCommit('a commit deployed onto a migrated installation')
      resetCalls()
      const r = deploy()
      equal(r.code, 0, `exit code (${r.out}${r.err})`)
      equal(head(), c, 'deployed')
      equal(callCount('restart freilauf.service'), 1, 'the new unit')
      equal(callCount('restart cchub.service'), 0, 'and never the old one again')
    })

    // ------------------------------------------------------------------
    group('setup/migrate-from-cc-hub.sh: the one explicit step')

    // A whole installation as it looks before the migration: old config
    // directory, old data directory with the old database name, old deploy
    // checkout with the old remote, old units, old opencode plugin.
    const ALT_CFG = join(HOME, '.config', 'cc-hub')
    const ALT_DAT = join(HOME, '.local', 'share', 'cc-hub')
    const ALT_DEP = join(HOME, 'agents', 'deploy', 'cc-hub')
    const NEU_CFG = join(HOME, '.config', 'freilauf')
    const NEU_DAT = join(HOME, '.local', 'share', 'freilauf')
    const NEU_DEP = join(HOME, 'agents', 'deploy', 'freilauf')
    const SYSD = join(HOME, '.config', 'systemd', 'user')

    function alteInstallation() {
      for (const d of [ALT_CFG, ALT_DAT, join(HOME, 'agents', 'deploy'), SYSD,
        join(HOME, '.config', 'opencode', 'plugins')]) mkdirSync(d, { recursive: true })
      writeFileSync(join(ALT_CFG, 'env'),
        '# comment stays\nCCHUB_LOCAL_PORT=9999\nCCHUB_CC_START=/x/cc-start\nOPENROUTER_API_KEY=geheim\n')
      writeFileSync(join(ALT_CFG, 'verbotene-muster'), 'nichts\n')
      // A real database, with a flow whose command still says cchub-deploy.
      const db = new DatabaseSync(join(ALT_DAT, 'cc-hub.db'))
      db.exec('CREATE TABLE IF NOT EXISTS flows (id INTEGER PRIMARY KEY, name TEXT UNIQUE, definition TEXT)')
      db.prepare('INSERT OR REPLACE INTO flows(id, name, definition) VALUES(1, ?, ?)')
        .run('Restart cc-hub after merge', JSON.stringify({ sequence: [{ command: 'sleep 3; cchub-deploy' }] }))
      db.close()
      writeFileSync(join(HOME, 'agents', 'deploy', 'cc-hub-deploy.log'), '[old] deployed abc1234\n')
      sh('git', ['clone', '--quiet', ORIGIN, ALT_DEP])
      git(ALT_DEP, 'remote', 'set-url', 'origin', 'https://github.com/hwalde/cc-hub.git')
      writeFileSync(join(SYSD, 'cchub.service'), '[Service]\nExecStart=/bin/true\n')
      writeFileSync(join(SYSD, 'cchub-vpn.service'), '[Service]\nExecStart=/bin/true\n')
      writeFileSync(join(HOME, '.config', 'opencode', 'plugins', 'cc-hub.js'), '// old\n')
      setActiveUnit('cchub.service')
    }

    await check('--dry-run prints every step and changes nothing', () => {
      alteInstallation()
      resetCalls()
      const r = migrate('--dry-run')
      equal(r.code, 0, `exit code (${r.out}${r.err})`)
      contains(r.out, 'DRY RUN', 'it says so')
      contains(r.out, ALT_CFG, 'and names the configuration directory it would move')
      contains(r.out, 'would:', 'every action is only printed')
      isTrue(existsSync(join(ALT_CFG, 'env')), 'the old config is untouched')
      isTrue(existsSync(join(ALT_DAT, 'cc-hub.db')), 'the old database is untouched')
      isTrue(existsSync(ALT_DEP), 'the old deploy checkout is untouched')
      isFalse(existsSync(NEU_CFG), 'and nothing new was created')
      // Asking is not changing: the dry run still wants to know whether the VPN
      // was on, so `is-active` is fair game. Nothing that MOVES systemd is.
      for (const verb of ['stop', 'start', 'enable', 'disable', 'daemon-reload']) {
        equal(callCount(`systemctl ${verb}`) + callCount(`systemctl --user ${verb}`), 0,
          `no systemctl ${verb}`)
      }
    })

    await check('the migration moves configuration, data, deploy checkout and units', () => {
      resetCalls()
      const r = migrate()
      equal(r.code, 0, `exit code (${r.out}${r.err})`)

      isFalse(existsSync(ALT_CFG), 'the old configuration directory is gone')
      isTrue(existsSync(join(NEU_CFG, 'env')), 'the env file moved')
      const env = readFileSync(join(NEU_CFG, 'env'), 'utf8')
      contains(env, 'FREILAUF_LOCAL_PORT=9999', 'CCHUB_ became FREILAUF_')
      contains(env, 'FREILAUF_START_SCRIPT=/x/cc-start', 'and the one variable that changed its whole name')
      contains(env, 'OPENROUTER_API_KEY=geheim', 'everything else is byte for byte what it was')
      contains(env, '# comment stays', 'comments included')
      isTrue(existsSync(join(NEU_CFG, 'env.bak-cc-hub')), 'with a backup of the original')
      isTrue(existsSync(join(NEU_CFG, 'verbotene-muster')), 'the private pattern file came along')

      isFalse(existsSync(ALT_DAT), 'the old data directory is gone')
      isTrue(existsSync(join(NEU_DAT, 'freilauf.db')), 'the database is renamed')
      isFalse(existsSync(join(NEU_DAT, 'cc-hub.db')), 'and not left behind under the old name')

      isFalse(existsSync(ALT_DEP), 'the old deploy checkout is gone')
      isTrue(existsSync(join(NEU_DEP, '.git')), 'and it is a checkout at the new path')
      contains(git(NEU_DEP, 'remote', 'get-url', 'origin').out, 'hwalde/freilauf',
        'its remote follows the renamed GitHub repository')
      isTrue(existsSync(join(HOME, 'agents', 'deploy', 'freilauf-deploy.log')), 'the deploy log is renamed')
      contains(readFileSync(join(HOME, 'agents', 'deploy', 'freilauf-deploy.log'), 'utf8'), 'abc1234',
        'and it still holds what it held')

      isFalse(existsSync(join(SYSD, 'cchub.service')), 'the old unit file is removed')
      isFalse(existsSync(join(SYSD, 'cchub-vpn.service')), 'the old VPN unit too')
      isTrue(existsSync(join(SYSD, 'freilauf.service')), 'the new unit is installed')
      contains(calls(), 'disable cchub.service', 'the old unit was disabled')
      contains(calls(), 'enable freilauf.service', 'the new one enabled')
      contains(calls(), 'start freilauf.service', 'and started')
      isFalse(existsSync(join(HOME, '.config', 'opencode', 'plugins', 'cc-hub.js')),
        'the old opencode plugin is removed — two of them would report everything twice')
    })

    await check('a stored flow stops calling a command that no longer exists', () => {
      const db = new DatabaseSync(join(NEU_DAT, 'freilauf.db'))
      const row = db.prepare('SELECT name, definition FROM flows WHERE id=1').get()
      db.close()
      contains(row.definition, 'freilauf-deploy', 'the command was rewritten')
      isFalse(row.definition.includes('cchub-deploy'), 'and the old one is gone')
      equal(row.name, 'Restart Freilauf after merge', 'the flow is called what it does')
    })

    await check('the VPN stays as it was — off is off (fail-closed)', () => {
      // cchub-vpn.service was inactive before the migration, so nothing may
      // switch access on behind the operator's back.
      isFalse(calls().includes('start freilauf-vpn.service'), 'access was not switched on')
    })

    await check('running it a second time is a no-op, not a mess', () => {
      resetCalls()
      const r = migrate()
      equal(r.code, 0, `exit code (${r.out}${r.err})`)
      contains(r.out, 'already at', 'it says the directories are already where they belong')
      isTrue(existsSync(join(NEU_CFG, 'env')), 'the configuration is still there')
      isTrue(existsSync(join(NEU_DAT, 'freilauf.db')), 'the database is still there')
      isTrue(existsSync(join(NEU_DEP, '.git')), 'the deploy checkout is still there')
      const env = readFileSync(join(NEU_CFG, 'env'), 'utf8')
      isFalse(env.includes('CCHUB_'), 'and the env file was not rewritten into nonsense')
      contains(env, 'FREILAUF_LOCAL_PORT=9999', 'it still says what it said')
    })

    await check('two config directories are refused, never merged', () => {
      // The one state a script must not resolve on the operator's behalf.
      mkdirSync(ALT_CFG, { recursive: true })
      writeFileSync(join(ALT_CFG, 'env'), 'CCHUB_LOCAL_PORT=1\n')
      const r = migrate()
      equal(r.code, 0, 'it does not fail — it says what it found')
      contains(r.out, 'BOTH', 'and names the problem')
      isTrue(existsSync(join(ALT_CFG, 'env')), 'the old one is untouched')
      isTrue(existsSync(join(NEU_CFG, 'env')), 'and so is the new one')
      rmSync(ALT_CFG, { recursive: true, force: true })
    })

    // ------------------------------------------------------------------
    group('The operator\'s own checkout is none of its business')

    await check('nothing outside the sandbox was written', () => {
      const real = join(process.env.HOME ?? '', '.local/bin')
      isTrue(!DEPLOY.startsWith(real), 'the deploy dir is the sandbox one')
      contains(calls() + deployLog(), DEPLOY, 'every path in the log is a sandbox path')
      isFalse(deployLog().includes('/projects/'), 'and no working copy is mentioned anywhere')
    })
  }
} catch (err) {
  counter.failures.push({ name: 'suite', reason: err.stack ?? String(err) })
  console.error(err)
} finally {
  rmSync(SB, { recursive: true, force: true })
}

process.exit(summary('deploy', start))
