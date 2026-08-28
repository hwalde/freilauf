// cc-hub — the sandbox a test suite runs a real hub in.
//
// This used to live inside test/e2e.mjs. It moved out when a second suite
// (test/browser.mjs) needed exactly the same thing: a hub of its own, with its
// own database, its own runs/worktrees directories, its own test repo and a
// cc-start stub instead of a real coding agent. Copying those ~150 lines would
// have been the same drift AGENTS.md describes for run-def.mjs — two sandboxes
// that slowly stop being the same sandbox.
//
// Everything is per instance: every call to neuerSandkasten() makes its own
// temporary directory and every hubStarten() takes a free port. Two suites can
// therefore run at the same time, and both stay safe next to a live hub: the
// production database, ~/agents and foreign tmux sessions are never touched,
// and only the sessions an instance created itself are killed on the way out.
import { spawn, execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { warteAuf } from './mini.mjs'

export const PROJEKT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')

/** execFile as a promise that never rejects — a failed command is a result, not an exception. */
export function sh(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: 60_000, ...opts }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }))
  })
}

/** Is this binary in PATH? Used to skip what cannot be tested here. */
export function vorhanden(bin) {
  try { execFileSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }); return true } catch { return false }
}

/** A port nobody listens on — asked of the kernel, not guessed. */
export async function freierPort() {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => resolve(p))
    })
  })
}

/**
 * A sandbox plus the hub process that runs in it.
 *
 * @param praefix   name prefix of the temporary directory — one per suite, so a
 *                  kept sandbox says which run it belongs to
 * @param behalten  keep the directory instead of deleting it (debugging)
 */
export function neuerSandkasten({ praefix = 'cc-hub-test-', behalten = false } = {}) {
  const SB = mkdtempSync(join(tmpdir(), praefix))
  const REPO = join(SB, 'repo')
  const ORIGIN = join(SB, 'origin.git')
  const STUB = join(SB, 'bin', 'cc-start')
  const FEHLSTART = join(SB, 'fehlstart-an')
  // Every session the stub below created, written by the stub itself. The `sessions`
  // set next to it is what individual tests register by hand — and THAT is what used
  // to leak: only two helpers ever called `sessions.add`, so every run started along
  // another path (the scheduler, a flow, a conflict run, a retry) created a tmux
  // session nothing would ever kill. Measured on the development machine: 157 live
  // sessions, 11 of them belonging to the running hub, together holding gigabytes of
  // RSS while the machine sat in swap.
  //
  // The stub knows the name it just created and cannot forget to write it down, so
  // the list belongs to it. Still no pattern across all `cc-*`: this file holds
  // exactly the sessions THIS sandbox produced, and nothing else is touched.
  const SESSIONSLISTE = join(SB, 'sessions.txt')
  const sessions = new Set()          // what a test registered by hand; killed as well

  const zustand = { hub: null, db: null, port: 0, basis: '', aufgeraeumt: false }

  async function bauen() {
    for (const d of ['data', 'runs', 'worktrees', 'integrate', 'bin']) mkdirSync(join(SB, d), { recursive: true })

    // Extra-skill dummy (planning: opt-in skills outside the skill autoload folders)
    mkdirSync(join(SB, 'zusaetze', 'e2e-fleiss'), { recursive: true })
    writeFileSync(join(SB, 'zusaetze', 'e2e-fleiss', 'SKILL.md'),
      '---\nname: e2e-fleiss\ndescription: Testskill gegen faule Modelle.\n---\n\n# Fleiss\n')

    // Quota fixture: otherwise the real ~/.claude/quota.json would decide the budget
    // gates and the suite would be green or red depending on the day.
    writeFileSync(join(SB, 'quota.json'), JSON.stringify({
      five_hour: { used_percentage: 1, resets_at: 1800000000 }, seven_day_fable: { used_percentage: 0 },
    }))

    await sh('git', ['init', '-q', '--bare', ORIGIN])
    await sh('git', ['init', '-q', '-b', 'main', REPO])
    const g = (...a) => sh('git', ['-C', REPO, ...a])
    await g('config', 'user.email', 'e2e@test.local')
    await g('config', 'user.name', 'E2E')
    writeFileSync(join(REPO, 'README.md'), '# Testrepo\n')
    // .env and referenz/ stay UNVERSIONED — that is exactly what the worktree extras
    // are for. If they were in git, they would already be in the worktree and the
    // copy/link path would be skipped silently.
    // No trailing slash! 'referenz/' would only ignore the directory — but the extra
    // creates a SYMLINK in the worktree, which git then treats as an unversioned
    // file: the worktree would be "dirty" forever.
    writeFileSync(join(REPO, '.gitignore'), '.env\nreferenz\n')
    mkdirSync(join(REPO, 'referenz'), { recursive: true })
    writeFileSync(join(REPO, '.env'), 'GEHEIM=1\n')
    writeFileSync(join(REPO, 'referenz', 'a.txt'), 'ref\n')
    await g('add', '-A')
    await g('commit', '-qm', 'init')
    await g('remote', 'add', 'origin', ORIGIN)
    await g('push', '-q', '-u', 'origin', 'main')

    // Stub cc-start: creates a real tmux session with a harmless "agent", speaks the
    // same interface as the original and reports the same success line.
    writeFileSync(STUB, `#!/usr/bin/env bash
set -euo pipefail
NAME=e2e; ID=""; ENVS=(); LOG=""; KEEP=""; PROMPTFILE=""; POS=()
ALLE=("$@")
while [[ $# -gt 0 ]]; do
  case "$1" in
    --harness|--model|--session-id|--settings) shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --id)   ID="$2";   shift 2 ;;
    --env)  ENVS+=("-e" "$2"); shift 2 ;;
    --log)  LOG="$2";  shift 2 ;;
    --keep) KEEP=1; shift ;;
    -f|--prompt-file) PROMPTFILE="$2"; shift 2 ;;
    --no-trust|--keep) shift ;;
    *) POS+=("$1"); shift ;;
  esac
done
WORKDIR="\${POS[0]:-$PWD}"

# Smoke-test run: pass through to the REAL cc-start (also covers the cc-* scripts).
# Not exec: the session it creates has to be written down too, or --echt would
# leak exactly what the stub path no longer does.
if [[ -n "$PROMPTFILE" && -r "$PROMPTFILE" ]] && grep -q 'E2E-ECHT' "$PROMPTFILE"; then
  AUSGABE=$("${homedir()}/.local/bin/cc-start" "\${ALLE[@]}") || { echo "$AUSGABE"; exit 1; }
  echo "$AUSGABE"
  echo "$AUSGABE" | sed -n "s/^Session '\\([^']*\\)' .*/\\1/p" >> "${SESSIONSLISTE}"
  exit 0
fi

# Deliberate failed start for the retry test.
if [[ -f "${FEHLSTART}" ]]; then
  echo "Fehlstart erzwungen (E2E)" >&2
  exit 1
fi

SESSION="cc-$NAME"; [[ -n "$ID" ]] && SESSION="$SESSION-$ID"
n=2; while tmux has-session -t "=$SESSION" 2>/dev/null; do SESSION="cc-$NAME-$ID-$n"; n=$((n+1)); done
RUNNER="${SB}/runner-$$.sh"
cat > "$RUNNER" <<'INNER'
echo "=== E2E-Agent gestartet ==="
echo "workdir: $PWD"
echo "CC_RUN_ID=\${CC_RUN_ID:-<leer>}"
[[ -n "\${CC_PROMPTFILE:-}" && -r "\$CC_PROMPTFILE" ]] && { echo "--- Prompt ---"; cat "\$CC_PROMPTFILE"; }
echo "bereit fuer Eingaben:"
while IFS= read -r zeile; do echo "[agent sah] $zeile"; done
INNER
echo "$SESSION" >> "${SESSIONSLISTE}"
tmux new-session -d -x 200 -y 50 "\${ENVS[@]}" -e "CC_PROMPTFILE=$PROMPTFILE" -s "$SESSION" -c "$WORKDIR" bash "$RUNNER"
if [[ -n "$LOG" ]]; then mkdir -p "$(dirname "$LOG")"; tmux pipe-pane -o -t "=$SESSION:" "cat >> '$LOG'"; fi
[[ -n "$KEEP" ]] && tmux set-option -t "=$SESSION:" -q remain-on-exit on
echo "Session '$SESSION' started in $WORKDIR (Harness: e2e-stub)"
`)
    chmodSync(STUB, 0o755)
  }

  /**
   * Start the hub on a free port.
   * `echteAgenten` hands the runs to the real ~/.local/bin/cc-start (and needs the
   * provider keys back in the environment); everything else keeps the stub.
   */
  async function hubStarten({ echteAgenten = false, keys = {}, env = {} } = {}) {
    zustand.port = await freierPort()
    zustand.basis = `http://127.0.0.1:${zustand.port}`
    const umgebung = {
      ...process.env,
      CCHUB_LOCAL_PORT: String(zustand.port),
      CCHUB_DATA_DIR: join(SB, 'data'),
      CCHUB_RUNS_DIR: join(SB, 'runs'),
      CCHUB_WORKTREES_DIR: join(SB, 'worktrees'),
      CCHUB_INTEGRATE_DIR: join(SB, 'integrate'),
      // The suite owns the integrator's clock: two processes on one integration
      // worktree is a race nobody wants to debug. The hub still integrates on
      // the report path, which is where it matters.
      CCHUB_INTEGRATOR_OFF: '1',
      CCHUB_QUOTA_JSON: join(SB, 'quota.json'),
      // No credentials file means no token, and no token means the live usage
      // endpoint (server/claude-usage.mjs) is never asked — the quota fixture
      // above stays the only source, the way the fixture's comment promises.
      // It also keeps the operator's real plan string out of the suite, which
      // the plan lookup in harnesses/claude.mjs used to read straight from $HOME.
      CCHUB_CLAUDE_CREDENTIALS: join(SB, 'missing-claude-credentials.json'),
      CCHUB_CLAUDE_PROJECTS: join(SB, 'claude-projects'),
      CCHUB_ZUSAETZE_DIR: join(SB, 'zusaetze'),
      CCHUB_PULS_AUS: '1',          // no provider pulse against real endpoints from the suite
      CCHUB_CURSOR_AUTH: join(SB, 'missing-cursor-auth.json'),   // cursor usage stays silent in the sandbox
      CCHUB_CURSOR_DIR: join(SB, 'cursor'),      // fake cursor transcripts; the real ~/.cursor is never touched
      // "Fresh installation" tests must not pick up the operator's seed file
      // (~/.config/cc-hub/coding-agents.json) — point at a file that does not exist.
      CCHUB_AGENTS_SEED: join(SB, 'no-seed.json'),
      // The goal waits for the TUI to draw before it is typed in (server/goal.mjs).
      // The stub prints immediately, so the suite must not sit through the
      // production grace period for it.
      CCHUB_GOAL_DELAY_MS: '100',
      CCHUB_GOAL_WAIT_MS: '10000',
      NODE_OPTIONS: '--disable-warning=ExperimentalWarning',
    }
    // A suite may override or add to the hub's environment — e.g. shorten the
    // usage/balance caches so a browser test does not wait a full minute.
    for (const [k, v] of Object.entries(env)) umgebung[k] = v
    if (echteAgenten) {
      // No CCHUB_CC_START: the hub uses ~/.local/bin/cc-start and thereby the real
      // harnesses. The provider key must go back into the environment, otherwise
      // opencode/hermes starts and dies only at the first API call.
      delete umgebung.CCHUB_CC_START
      for (const [k, v] of Object.entries(keys)) if (v) umgebung[k] = v
    } else {
      umgebung.CCHUB_CC_START = STUB
      delete umgebung.OPENROUTER_API_KEY    // no real API calls from the stub part
    }
    const hub = spawn(process.execPath, [join(PROJEKT, 'server', 'hub.mjs')], { env: umgebung, stdio: ['ignore', 'pipe', 'pipe'] })
    zustand.hub = hub
    const logs = []
    hub.stdout.on('data', (d) => logs.push(String(d)))
    hub.stderr.on('data', (d) => logs.push(String(d)))
    hub.on('exit', (code) => { if (code !== 0 && code !== null) console.log(`  (hub exited, code ${code})\n${logs.join('')}`) })

    await warteAuf(async () => (await hol('/')).status === 200,
      { was: `hub at ${zustand.basis} responds`, timeoutMs: 15_000 })

    zustand.db = new DatabaseSync(join(SB, 'data', 'cc-hub.db'))
    // The hub holds its own connection and writes in the background (scheduler,
    // watcher); a direct write here must WAIT for it instead of failing instantly
    // with "database is locked" (the hub's own connection uses busy_timeout 5000).
    zustand.db.exec('PRAGMA busy_timeout = 10000;')
    return zustand.db
  }

  /**
   * The watcher ticks inside the hub every 30 s. Instead of waiting, a suite also
   * triggers the same pass itself — same database, same code, but immediately.
   * This writes the CCHUB_* variables into THIS process, so it belongs to the one
   * sandbox a suite works with.
   */
  async function watcherVorbereiten() {
    process.env.CCHUB_DATA_DIR = join(SB, 'data')
    process.env.CCHUB_RUNS_DIR = join(SB, 'runs')
    process.env.CCHUB_WORKTREES_DIR = join(SB, 'worktrees')
    process.env.CCHUB_INTEGRATE_DIR = join(SB, 'integrate')
    process.env.CCHUB_INTEGRATOR_OFF = '1'
    process.env.CCHUB_QUOTA_JSON = join(SB, 'quota.json')
    process.env.CCHUB_CLAUDE_CREDENTIALS = join(SB, 'missing-claude-credentials.json')
    process.env.CCHUB_CC_START = STUB
    process.env.CCHUB_CLAUDE_PROJECTS = join(SB, 'claude-projects')
    process.env.CCHUB_ZUSAETZE_DIR = join(SB, 'zusaetze')
    process.env.CCHUB_PULS_AUS = '1'
    process.env.CCHUB_CURSOR_AUTH = join(SB, 'missing-cursor-auth.json')
    process.env.CCHUB_CURSOR_DIR = join(SB, 'cursor')
    process.env.CCHUB_GOAL_DELAY_MS = '100'
    process.env.CCHUB_GOAL_WAIT_MS = '10000'
    delete process.env.OPENROUTER_API_KEY
    const { tick } = await import('../server/watcher.mjs')
    return tick
  }

  // ---------------------------------------------------------------- HTTP
  async function hol(pfad, opts = {}) {
    return fetch(zustand.basis + pfad, { redirect: 'manual', signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000), ...opts })
  }
  async function formular(pfad, daten, { alsBrowser = false } = {}) {
    const body = new URLSearchParams()
    for (const [k, v] of Object.entries(daten)) Array.isArray(v) ? v.forEach(x => body.append(k, x)) : body.append(k, v)
    return hol(pfad, {
      method: 'POST', body,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: alsBrowser ? 'text/html,application/xhtml+xml' : 'application/json',
      },
    })
  }

  // ---------------------------------------------------------------- Cleanup
  /** Stop the hub process (also mid-suite, when the real-run mode restarts it). */
  async function hubStoppen() {
    try { zustand.db?.close() } catch {}
    zustand.db = null
    const hub = zustand.hub
    if (hub && hub.exitCode === null) {
      hub.kill('SIGTERM')
      await new Promise(r => { const t = setTimeout(() => { try { hub.kill('SIGKILL') } catch {} ; r() }, 4000); hub.once('exit', () => { clearTimeout(t); r() }) })
    }
    zustand.hub = null
  }

  async function aufraeumen() {
    if (zustand.aufgeraeumt) return
    zustand.aufgeraeumt = true
    await hubStoppen()
    // ONLY the sessions we created ourselves — never a pattern across all cc-*.
    // The stub's own list first (it cannot forget one), then whatever a test
    // registered by hand; a Set, so a name in both is killed once.
    const alle = new Set(sessions)
    try {
      for (const zeile of readFileSync(SESSIONSLISTE, 'utf8').split('\n')) {
        const name = zeile.trim()
        if (name) alle.add(name)
      }
    } catch { /* no run ever started: nothing to clean up */ }
    for (const s of alle) await sh('tmux', ['kill-session', '-t', `=${s}`]).catch(() => {})
    if (behalten) console.log(`\nSandbox kept: ${SB}`)
    else rmSync(SB, { recursive: true, force: true })
  }

  return {
    SB, REPO, ORIGIN, FEHLSTART, sessions, SESSIONSLISTE,
    bauen, hubStarten, hubStoppen, watcherVorbereiten, aufraeumen,
    hol, formular,
    get db() { return zustand.db },
    get port() { return zustand.port },
    get basis() { return zustand.basis },
  }
}
