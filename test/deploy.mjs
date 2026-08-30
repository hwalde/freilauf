#!/usr/bin/env node
// cc-hub — bin/cchub-deploy in a sandbox of its own.
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
//                      cc-* scripts, the opencode plugin and the systemd units
//                      into the sandbox and never into the operator's ~/.local/bin
//   CCHUB_DEPLOY_DIR → the sandbox
//   PATH             → a shim directory FIRST, holding systemctl, curl, npm,
//                      journalctl and cc-notify. They log every call and answer
//                      what the test tells them to: `curl` prints the HTTP status
//                      from a file (that is how the unhealthy deploy is
//                      provoked), `npm` creates node_modules instead of
//                      installing anything, and `cc-notify` is only counted —
//                      the deploy script must not need a configured channel, or
//                      a hub nobody set one up for could not be deployed.
//
// The git commands, the flock and the checkout are REAL — that is the half of the
// script a stub could not test.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, cpSync, existsSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gruppe, pruefe, uebersprungen, gleich, wahr, falsch, enthaelt, bericht, zaehler } from './mini.mjs'

const start = Date.now()
const PROJEKT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const SKRIPT = join(PROJEKT, 'bin', 'cchub-deploy')

const SB = mkdtempSync(join(tmpdir(), 'cc-hub-deploy-'))
const HOME = join(SB, 'home')
const ORIGIN = join(SB, 'origin.git')
const WORK = join(SB, 'work')
const DEPLOY = join(SB, 'deploy', 'cc-hub')
const SHIM = join(SB, 'shim')
const CALLS = join(SB, 'calls.log')
const STATUS_FILE = join(SB, 'http-status')

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts })
  return { code: r.status, out: String(r.stdout ?? ''), err: String(r.stderr ?? '') }
}

const git = (dir, ...args) => sh('git', ['-C', dir, '-c', 'user.email=t@example.invalid', '-c', 'user.name=test',
  '-c', 'commit.gpgsign=false', ...args])

/** cchub-deploy, with everything pointed at the sandbox. */
function deploy(...args) {
  return sh('bash', [SKRIPT, ...args], {
    cwd: SB,
    env: {
      ...process.env,
      HOME,
      PATH: `${SHIM}:${process.env.PATH}`,
      CCHUB_ENV_FILE: join(SB, 'no-such-env'),   // never read the operator's config
      CCHUB_DEPLOY_DIR: DEPLOY,
      CCHUB_DEPLOY_BASE: 'main',
      CCHUB_DATA_DIR: join(SB, 'data'),          // no database → nothing to notify, base falls back
      CCHUB_LOCAL_PORT: '9999',
      CCHUB_DEPLOY_HEALTH_SECONDS: '2',          // 20 s of retrying would make the suite crawl
      CCHUB_SKIP_EXTRAS: '1',                    // setup/02 must not clone from GitHub here
      CCHUB_TEST_CALLS: CALLS,
      CCHUB_TEST_STATUS: STATUS_FILE,
    },
  })
}

const calls = () => (existsSync(CALLS) ? readFileSync(CALLS, 'utf8') : '')
const callCount = (needle) => calls().split('\n').filter(l => l.includes(needle)).length
const resetCalls = () => writeFileSync(CALLS, '')
/** The HTTP statuses the curl shim will answer, in order; the last one repeats. */
const setStatus = (...codes) => writeFileSync(STATUS_FILE, codes.join('\n') + '\n')
const head = () => git(DEPLOY, 'rev-parse', 'HEAD').out.trim()
const deployLog = () => readFileSync(join(SB, 'deploy', 'cc-hub-deploy.log'), 'utf8')

function shim(name, body) {
  const p = join(SHIM, name)
  writeFileSync(p, `#!/usr/bin/env bash\nprintf '${name} %s\\n' "$*" >> "$CCHUB_TEST_CALLS"\n${body}\n`)
  chmodSync(p, 0o755)
}

// ------------------------------------------------------------------ the sandbox
function buildSandbox() {
  mkdirSync(HOME, { recursive: true })
  mkdirSync(SHIM, { recursive: true })
  writeFileSync(CALLS, '')
  setStatus('200')

  // systemd: is-active answers for the two units the script asks about; every
  // other verb simply succeeds. The vpn unit is inactive, as after a reboot.
  shim('systemctl', `
case "$*" in
  *"is-active cchub-vpn.service"*) echo inactive; exit 3 ;;
  *"is-active cchub.service"*)     echo active;   exit 0 ;;
esac
exit 0`)
  // curl: the health check reads its status from a file the test writes — one
  // status per line, each consumed once, the last one staying forever. That is
  // what makes "the deploy is unhealthy but the rollback is fine" expressible at
  // all.
  shim('curl', `
s="$(head -1 "$CCHUB_TEST_STATUS")"
rest="$(tail -n +2 "$CCHUB_TEST_STATUS")"
if [[ -n "$rest" ]]; then printf '%s\\n' "$rest" > "$CCHUB_TEST_STATUS"; fi
printf '%s' "$s"
exit 0`)
  // cc-notify: counted, never run. The real one loads the hub's plugins and
  // calls the notification facade; here the only question is whether the deploy
  // script reaches for it at all, and that it survives it not being there (the
  // `command -v` guard, exercised by the deploys that do not fail).
  shim('cc-notify', 'exit 0')
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
    gruppe('cchub-deploy')
    uebersprungen('the whole suite', 'git is missing')
  } else {
    buildSandbox()

    // ------------------------------------------------------------------
    gruppe('cchub-deploy --init: the deploy checkout comes into being')

    const c1 = git(WORK, 'rev-parse', 'HEAD').out.trim()

    await pruefe('--init clones, checks out detached on origin/main and installs the deps once', () => {
      const r = deploy('--init', '--url', ORIGIN)
      gleich(r.code, 0, `exit code (${r.out}${r.err})`)
      wahr(existsSync(join(DEPLOY, '.git')), 'the checkout exists')
      gleich(head(), c1, 'it stands on the first commit')
      falsch(git(DEPLOY, 'symbolic-ref', '-q', 'HEAD').code === 0,
        'and DETACHED — nobody commits here, and git status stays empty')
      gleich(callCount('npm ci'), 1, 'npm ci ran exactly once')
      wahr(existsSync(join(DEPLOY, '.deploy-lock-hash')), 'the lockfile hash is written down')
      wahr(existsSync(join(HOME, '.local/bin/cc-report')), 'the cc-* scripts went into ~/.local/bin')
      wahr(existsSync(join(HOME, '.local/bin/cchub-deploy')), 'including the deploy script itself')
      wahr(existsSync(join(HOME, '.config/systemd/user/cchub.service')), 'and the units are in place')
      gleich(callCount('restart cchub.service'), 1, 'the hub was restarted once')
    })

    // ------------------------------------------------------------------
    gruppe('Nothing new: nothing happens')

    await pruefe('a second deploy without a new commit restarts nothing', () => {
      resetCalls()
      const r = deploy()
      gleich(r.code, 0, 'exit code')
      enthaelt(r.out, 'already deployed', 'it says so')
      gleich(callCount('systemctl'), 0, 'and did not touch systemd — a restart is not free')
      gleich(callCount('npm ci'), 0, 'nor npm')
    })

    // ------------------------------------------------------------------
    gruppe('A new commit: the checkout moves, the hub restarts')

    const c2 = newCommit('second commit')

    await pruefe('deploy follows origin/main and records what it replaced', () => {
      resetCalls()
      const r = deploy()
      gleich(r.code, 0, `exit code (${r.out}${r.err})`)
      gleich(head(), c2, 'the checkout stands on the new commit')
      gleich(callCount('restart cchub.service'), 1, 'restarted once')
      gleich(readFileSync(join(SB, 'deploy', 'previous-sha'), 'utf8').trim(), c1,
        'previous-sha is what was running before — that IS the rollback')
      enthaelt(r.out, 'deployed', 'and it says what it deployed')
    })

    await pruefe('the dependencies are not reinstalled for an unchanged lockfile', () => {
      gleich(callCount('npm ci'), 0, 'node-pty compiles for minutes — not on every deploy')
    })

    // ------------------------------------------------------------------
    gruppe('The hub does not come up: rollback')

    const c3 = newCommit('third commit, and the hub will not answer')

    await pruefe('an unhealthy hub sends the checkout back and exits 1', () => {
      resetCalls()
      // Two 000 for the health check of the new commit (CCHUB_DEPLOY_HEALTH_SECONDS=2),
      // then 200: the rollback has to come up, otherwise this is the exit-2 case.
      setStatus('000', '000', '200')
      const r = deploy()
      gleich(r.code, 1, `exit code (${r.out}${r.err})`)
      gleich(head(), c2, 'the checkout is back on the commit that was running')
      wahr(callCount('restart cchub.service') >= 2, 'restarted a second time, for the rollback')
      enthaelt(r.out, 'rolled back', 'the reason is in the output')
      enthaelt(deployLog(), 'rolled back', 'and in the deploy log')
      enthaelt(deployLog(), c3.slice(0, 7), 'naming the commit that failed')
      // A FAILURE always notifies — through cc-notify, so it reaches whatever
      // channel the operator configured, and nothing at all when they
      // configured none. It used to be a second Telegram implementation in
      // bash, reading the bot token out of the database with a curl behind it.
      wahr(callCount('cc-notify') >= 1, 'and the operator was told, through the notification CLI')
      enthaelt(calls(), '--kind deploy', 'the message says what it is about')
    })

    // ------------------------------------------------------------------
    gruppe('The lockfile decides whether npm runs')

    await pruefe('a changed package-lock.json means npm ci, an unchanged one does not', () => {
      setStatus('200')
      const lock = JSON.parse(readFileSync(join(WORK, 'package-lock.json'), 'utf8'))
      lock.cchubTestMarker = 'changed'
      newCommit('fourth commit: lockfile changed', 'package-lock.json', JSON.stringify(lock, null, 2))
      resetCalls()
      let r = deploy()
      gleich(r.code, 0, `exit code (${r.out}${r.err})`)
      gleich(callCount('npm ci'), 1, 'the lockfile changed → npm ci')

      newCommit('fifth commit: only the marker')
      resetCalls()
      r = deploy()
      gleich(r.code, 0, `exit code (${r.out}${r.err})`)
      gleich(callCount('npm ci'), 0, 'the lockfile did not → no npm ci')
    })

    // ------------------------------------------------------------------
    gruppe('--status and --rollback')

    await pruefe('--status names the deployed commit and the one on origin', () => {
      const c6 = newCommit('sixth commit, deliberately not deployed')
      resetCalls()
      const r = deploy('--status')
      gleich(r.code, 0, 'exit code')
      enthaelt(r.out, head().slice(0, 7), 'the deployed sha')
      enthaelt(r.out, c6.slice(0, 7), 'the sha on origin/main')
      enthaelt(r.out, 'Ahead:', 'and how far behind the deployment is')
      gleich(callCount('systemctl'), 0, 'a status question restarts nothing')
    })

    await pruefe('--rollback puts the previously deployed commit back', () => {
      const before = readFileSync(join(SB, 'deploy', 'previous-sha'), 'utf8').trim()
      resetCalls()
      const r = deploy('--rollback')
      gleich(r.code, 0, `exit code (${r.out}${r.err})`)
      gleich(head(), before, 'the checkout stands on the previous commit again')
      gleich(callCount('restart cchub.service'), 1, 'and the hub was restarted for it')
    })

    // ------------------------------------------------------------------
    gruppe('Notifying is best effort, and optional')

    await pruefe('a successful deploy stays quiet unless --notify says otherwise', () => {
      const c = newCommit('a commit worth announcing')
      resetCalls()
      let r = deploy()
      gleich(r.code, 0, `exit code (${r.out}${r.err})`)
      gleich(head(), c, 'deployed')
      gleich(callCount('cc-notify'), 0, 'an ordinary success says nothing')

      const c2b = newCommit('and this one is announced')
      resetCalls()
      r = deploy('--notify')
      gleich(r.code, 0, `exit code (${r.out}${r.err})`)
      gleich(head(), c2b, 'deployed')
      gleich(callCount('cc-notify'), 1, 'with --notify it announces itself once')
      enthaelt(calls(), '--kind deploy', 'and says what the message is about')
    })

    // ------------------------------------------------------------------
    gruppe('The operator\'s own checkout is none of its business')

    await pruefe('nothing outside the sandbox was written', () => {
      const real = join(process.env.HOME ?? '', '.local/bin')
      wahr(!DEPLOY.startsWith(real), 'the deploy dir is the sandbox one')
      enthaelt(calls() + deployLog(), DEPLOY, 'every path in the log is a sandbox path')
      falsch(deployLog().includes('/projects/'), 'and no working copy is mentioned anywhere')
    })
  }
} catch (err) {
  zaehler.fehler.push({ name: 'suite', grund: err.stack ?? String(err) })
  console.error(err)
} finally {
  rmSync(SB, { recursive: true, force: true })
}

process.exit(bericht('deploy', start))
