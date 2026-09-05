// Freilauf — the sandbox a test suite runs a real hub in.
//
// This used to live inside test/e2e.mjs. It moved out when a second suite
// (test/browser.mjs) needed exactly the same thing: a hub of its own, with its
// own database, its own runs/worktrees directories, its own test repo and a
// fl-start stub instead of a real coding agent. Copying those ~150 lines would
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
export function neuerSandkasten({ praefix = 'freilauf-test-', behalten = false } = {}) {
  const SB = mkdtempSync(join(tmpdir(), praefix))
  const REPO = join(SB, 'repo')
  const ORIGIN = join(SB, 'origin.git')
  const STUB = join(SB, 'bin', 'fl-start')
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
  // the list belongs to it. Still no pattern across all `fl-*`: this file holds
  // exactly the sessions THIS sandbox produced, and nothing else is touched.
  const SESSIONSLISTE = join(SB, 'sessions.txt')
  const sessions = new Set()          // what a test registered by hand; killed as well

  // ---- the container runtime, shimmed (SANDBOX_RESEARCH.md §7.13, "Tests") ----
  // The development machine has no Docker, and the sandbox has to be covered
  // there too. `test/shims/docker` answers for it: it logs every argv and reads
  // its answers out of DOCKER_STATE, and its `run` executes the wrapped command
  // on the host — so a sandboxed run really starts a tmux session and every
  // assertion downstream of the launch keeps holding.
  //
  // SHIM_DIR holds the launcher and NOTHING else. It goes first on the hub's
  // PATH, so a bare `docker` (discovery, scanSystem) finds the shim; a directory
  // that also held the fl-start stub would shadow the real fl-* scripts a
  // --echt run needs.
  const SHIM_DIR = join(SB, 'shim')
  const DOCKER_STATE = join(SB, 'docker')
  const DOCKER_BIN = join(SHIM_DIR, 'docker')
  const SANDBOX_DIR = join(SB, 'sandbox')

  const zustand = { hub: null, db: null, port: 0, basis: '', aufgeraeumt: false, sandbox: false }

  async function bauen() {
    for (const d of ['data', 'runs', 'worktrees', 'integrate', 'bin', 'plugins', 'skillhome']) mkdirSync(join(SB, d), { recursive: true })
    for (const d of [SHIM_DIR, DOCKER_STATE, join(DOCKER_STATE, 'answers'),
      SANDBOX_DIR, join(SANDBOX_DIR, 'ca'), join(SANDBOX_DIR, 'sock')]) mkdirSync(d, { recursive: true })
    // The launcher binds the shim to THIS sandbox's state directory. The repo's
    // own test/shims/docker stays generic on purpose — it is also the pane
    // command of a sandboxed run, started by tmux with an environment the hub
    // composed, and a shim that had to inherit its state path would find none.
    writeFileSync(DOCKER_BIN,
      `#!/usr/bin/env bash\nexport FL_DOCKER_STATE=${JSON.stringify(DOCKER_STATE)}\n`
      + `exec ${JSON.stringify(join(PROJEKT, 'test', 'shims', 'docker'))} "$@"\n`)
    chmodSync(DOCKER_BIN, 0o755)
    writeFileSync(join(DOCKER_STATE, 'calls.jsonl'), '')
    writeFileSync(join(DOCKER_STATE, 'created.txt'), '')

    // Extra-skill dummy (planning: opt-in skills outside the skill autoload folders)
    mkdirSync(join(SB, 'zusaetze', 'e2e-fleiss'), { recursive: true })
    writeFileSync(join(SB, 'zusaetze', 'e2e-fleiss', 'SKILL.md'),
      '---\nname: e2e-fleiss\ndescription: Testskill gegen faule Modelle.\n---\n\n# Fleiss\n')

    // Quota fixture: otherwise the real ~/.claude/quota.json would decide the budget
    // gates and the suite would be green or red depending on the day.
    // Both weeks, the way a real account reports them: the general one binds
    // every run, the per-model one only a run on that model (server/quota.mjs).
    writeFileSync(join(SB, 'quota.json'), JSON.stringify({
      five_hour: { used_percentage: 1, resets_at: 1800000000 },
      seven_day: { used_percentage: 0 }, seven_day_fable: { used_percentage: 0 },
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

    // Stub fl-start: creates a real tmux session with a harmless "agent", speaks the
    // same interface as the original and reports the same success line.
    writeFileSync(STUB, `#!/usr/bin/env bash
set -euo pipefail
NAME=e2e; ID=""; ENVS=(); LOG=""; KEEP=""; PROMPTFILE=""; POS=()
ALLE=("$@")
while [[ $# -gt 0 ]]; do
  case "$1" in
    --harness|--model|--session-id|--settings|--spec|--resume) shift 2 ;;
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

# Smoke-test run: pass through to the REAL fl-start (also covers the fl-* scripts).
# Not exec: the session it creates has to be written down too, or --echt would
# leak exactly what the stub path no longer does.
if [[ -n "$PROMPTFILE" && -r "$PROMPTFILE" ]] && grep -q 'E2E-ECHT' "$PROMPTFILE"; then
  AUSGABE=$("${homedir()}/.local/bin/fl-start" "\${ALLE[@]}") || { echo "$AUSGABE"; exit 1; }
  echo "$AUSGABE"
  echo "$AUSGABE" | sed -n "s/^Session '\\([^']*\\)' .*/\\1/p" >> "${SESSIONSLISTE}"
  exit 0
fi

# Deliberate failed start for the retry test.
if [[ -f "${FEHLSTART}" ]]; then
  echo "Fehlstart erzwungen (E2E)" >&2
  exit 1
fi

SESSION="fl-$NAME"; [[ -n "$ID" ]] && SESSION="$SESSION-$ID"
n=2; while tmux has-session -t "=$SESSION" 2>/dev/null; do SESSION="fl-$NAME-$ID-$n"; n=$((n+1)); done
RUNNER="${SB}/runner-$$.sh"
cat > "$RUNNER" <<'INNER'
echo "=== E2E-Agent gestartet ==="
echo "workdir: $PWD"
echo "FL_RUN_ID=\${FL_RUN_ID:-<leer>}"
[[ -n "\${FL_PROMPTFILE:-}" && -r "\$FL_PROMPTFILE" ]] && { echo "--- Prompt ---"; cat "\$FL_PROMPTFILE"; }
echo "bereit fuer Eingaben:"
while IFS= read -r zeile; do echo "[agent sah] $zeile"; done
INNER
echo "$SESSION" >> "${SESSIONSLISTE}"
tmux new-session -d -x 200 -y 50 "\${ENVS[@]}" -e "FL_PROMPTFILE=$PROMPTFILE" -s "$SESSION" -c "$WORKDIR" bash "$RUNNER"
if [[ -n "$LOG" ]]; then mkdir -p "$(dirname "$LOG")"; tmux pipe-pane -o -t "=$SESSION:" "cat >> '$LOG'"; fi
[[ -n "$KEEP" ]] && tmux set-option -t "=$SESSION:" -q remain-on-exit on
echo "Session '$SESSION' started in $WORKDIR (Harness: e2e-stub)"
`)
    chmodSync(STUB, 0o755)
  }

  /**
   * Start the hub on a free port.
   * `echteAgenten` hands the runs to the real ~/.local/bin/fl-start (and needs the
   * provider keys back in the environment); everything else keeps the stub.
   */
  /**
   * Every FREILAUF_* seam the sandbox feature has, pointed into $SB.
   *
   * `sandbox: false` is the DEFAULT and it is a hard off: no runtime binary is
   * named, and FREILAUF_SANDBOX_OFF says so outright, so every test that
   * existed before this takes byte for byte the path it took before — which is
   * the one rule the whole feature is built on.
   *
   * `sandbox: true` names the shim and fences everything the feature writes:
   * the run homes and clones already live under RUNS_DIR/WORKTREES_DIR, but
   * the sandbox directory, the CA and the hub↔agent socket are new places, and
   * FREILAUF_SKILLS_HOME is the precedent for what an unfenced one costs — a
   * suite that installed into, and then deleted from, the operator's own home.
   */
  const SANDBOX_ENV_KEYS = [
    'FREILAUF_SANDBOX_OFF', 'FREILAUF_SANDBOX_RUNTIME_BIN', 'FL_DOCKER_STATE',
    'FREILAUF_SANDBOX_DIR', 'FREILAUF_SANDBOX_CA_DIR', 'FREILAUF_SANDBOX_SOCKET_DIR',
    'FREILAUF_SANDBOX_INFO_CACHE_MS', 'FREILAUF_SANDBOX_PROXY_BIND',
    // The two endpoint seams. See `sandboxSeams()` below for what each says.
    'FREILAUF_SANDBOX_DOCKER_HOST', 'FREILAUF_SANDBOX_RUNTIME_FORCE',
  ]

  /** The PATH without the shim directory — what "no runtime at all" has to mean. */
  function pathOhneShim() {
    return String(process.env.PATH ?? '').split(':').filter(p => p !== SHIM_DIR).join(':')
  }

  function sandboxSeams(sandbox) {
    // Off is a HARD off: the switch says so, no runtime binary is named, the
    // shim is taken off the PATH again — a leftover `docker` there would let a
    // suite that asked for no sandbox find one anyway, which is precisely the
    // premise the "with the sandbox off, nothing calls the runtime" check rests
    // on — and the endpoint seam points at a socket that does not exist, which
    // is the same fence `FREILAUF_CURSOR_AUTH` and `FREILAUF_CLAUDE_CREDENTIALS`
    // are: it makes "there is no runtime here" true on a machine that HAS one.
    // Since rootless Docker was installed on the development host, the two are
    // no longer the same thing, and a suite whose result depends on the hardware
    // is a suite nobody can trust.
    if (!sandbox) {
      return {
        FREILAUF_SANDBOX_OFF: '1',
        FREILAUF_SANDBOX_DOCKER_HOST: join(SB, 'no-such-docker.sock'),
        FREILAUF_SANDBOX_RUNTIME_FORCE: '',
        PATH: pathOhneShim(),
      }
    }
    return {
      FREILAUF_SANDBOX_RUNTIME_BIN: DOCKER_BIN,
      // The shim is a SCRIPT, not a daemon, so there is no socket to probe: the
      // force seam says the reachability question has been answered elsewhere.
      // (A named binary implies it too — this is the seam saying so out loud,
      // so the suite does not depend on that implication.)
      FREILAUF_SANDBOX_RUNTIME_FORCE: '1',
      FREILAUF_SANDBOX_DOCKER_HOST: '',
      FL_DOCKER_STATE: DOCKER_STATE,        // for a bare `docker` off the PATH
      FREILAUF_SANDBOX_DIR: SANDBOX_DIR,
      FREILAUF_SANDBOX_CA_DIR: join(SANDBOX_DIR, 'ca'),
      FREILAUF_SANDBOX_SOCKET_DIR: join(SANDBOX_DIR, 'sock'),
      // The discovery cache is keyed on time as well as on the binary, and a
      // test that switches the shim's mode file expects the next call to ask
      // again rather than to be handed a minute-old answer.
      FREILAUF_SANDBOX_INFO_CACHE_MS: '0',
      // The built-in proxy already defaults to 127.0.0.1:0; naming it is the
      // fence against a later default that binds somewhere a live hub can see.
      FREILAUF_SANDBOX_PROXY_BIND: '127.0.0.1',
      PATH: `${SHIM_DIR}:${pathOhneShim()}`,
    }
  }

  async function hubStarten({ echteAgenten = false, keys = {}, env = {}, willkommen = false, sandbox = false } = {}) {
    zustand.sandbox = !!sandbox
    zustand.port = await freierPort()
    zustand.basis = `http://127.0.0.1:${zustand.port}`
    const umgebung = {
      ...process.env,
      FREILAUF_LOCAL_PORT: String(zustand.port),
      FREILAUF_DATA_DIR: join(SB, 'data'),
      FREILAUF_RUNS_DIR: join(SB, 'runs'),
      FREILAUF_WORKTREES_DIR: join(SB, 'worktrees'),
      FREILAUF_INTEGRATE_DIR: join(SB, 'integrate'),
      // The suite owns the integrator's clock: two processes on one integration
      // worktree is a race nobody wants to debug. The hub still integrates on
      // the report path, which is where it matters.
      FREILAUF_INTEGRATOR_OFF: '1',
      FREILAUF_QUOTA_JSON: join(SB, 'quota.json'),
      // The report socket of §7.6 resolves to $XDG_RUNTIME_DIR/freilauf/hub.sock
      // when nothing names it — a path OUTSIDE the sandbox that a live hub and
      // every parallel suite would bind in turn, each unlinking the last one's
      // socket. Named here rather than in the one group that is about it, so a
      // suite cannot forget: it is the same fence as FREILAUF_SKILLS_HOME, and
      // it is on for every hub because the socket is not a sandbox feature.
      FREILAUF_HUB_SOCKET: join(SB, 'hub.sock'),
      // The report CLI the prompt names and the claude hooks call. Without it
      // the hub points at ~/.local/bin/fl-report — whatever the last deploy
      // installed there, or nothing at all on a machine that has not deployed
      // this release yet. Same fence as FREILAUF_START_SCRIPT below.
      FREILAUF_REPORT_SCRIPT: join(PROJEKT, 'bin', 'fl-report'),
      // No credentials file means no token, and no token means the live usage
      // endpoint (server/claude-usage.mjs) is never asked — the quota fixture
      // above stays the only source, the way the fixture's comment promises.
      // It also keeps the operator's real plan string out of the suite, which
      // the plan lookup in harnesses/claude.mjs used to read straight from $HOME.
      FREILAUF_CLAUDE_CREDENTIALS: join(SB, 'missing-claude-credentials.json'),
      FREILAUF_CLAUDE_PROJECTS: join(SB, 'claude-projects'),
      FREILAUF_ZUSAETZE_DIR: join(SB, 'zusaetze'),
      FREILAUF_PULS_AUS: '1',          // no provider pulse against real endpoints from the suite
      FREILAUF_CURSOR_AUTH: join(SB, 'missing-cursor-auth.json'),   // cursor usage stays silent in the sandbox
      FREILAUF_CURSOR_DIR: join(SB, 'cursor'),      // fake cursor transcripts; the real ~/.cursor is never touched
      // The same fence for opencode's session store: a suite that read
      // ~/.local/share/opencode/opencode.db would measure the operator's own
      // sessions, and on this machine that file is 14 GB.
      FREILAUF_OPENCODE_DB: join(SB, 'missing-opencode.db'),
      // "Fresh installation" tests must not pick up the operator's seed file
      // (~/.config/freilauf/coding-agents.json) — point at a file that does not exist.
      FREILAUF_AGENTS_SEED: join(SB, 'no-seed.json'),
      // The same fence, one layer out: without it the hub would load the
      // OPERATOR's external plugin packages (~/.local/share/freilauf/plugins) and
      // the suite would be green or red depending on what is installed on the
      // machine it runs on. The directory starts empty; the plugin tests
      // install into it themselves.
      FREILAUF_PLUGIN_DIR: join(SB, 'plugins'),
      // The hub's own agent skills resolve their target directories against
      // $HOME (~/.claude/skills and friends), so this is the same fence one
      // layer further out — and here it is not merely about reproducibility:
      // without it a suite run would install into, and later DELETE from, the
      // operator's real skill directories. See server/skills.mjs.
      FREILAUF_SKILLS_HOME: join(SB, 'skillhome'),
      FREILAUF_SKILLS_STATE: join(SB, 'data', 'skills-installed.json'),
      // The goal waits for the TUI to draw before it is typed in (server/goal.mjs).
      // The stub prints immediately, so the suite must not sit through the
      // production grace period for it.
      FREILAUF_GOAL_DELAY_MS: '100',
      FREILAUF_GOAL_WAIT_MS: '10000',
      // The cleanup auto-trigger reads the machine's REAL tmux memory (the
      // sandbox shares the tmux server); a live hub must not start cleanup
      // runs because of THIS suite. The manual path stays fully testable.
      FREILAUF_CLEANUP_AUTO_OFF: '1',
      // Incidents page WITHOUT the production grace period — the suite asserts
      // the alarm immediately after the event; the delay itself has its own test.
      FREILAUF_INCIDENT_NOTIFY_DELAY_MS: '0',
      NODE_OPTIONS: '--disable-warning=ExperimentalWarning',
    }
    // …after `...process.env`, and with the whole set cleared first: this
    // process may itself have been prepared for a sandboxed watcher pass, and a
    // leftover runtime binary in the hub's environment would sandbox a suite
    // that asked for none.
    for (const k of SANDBOX_ENV_KEYS) delete umgebung[k]
    for (const [k, v] of Object.entries(sandboxSeams(sandbox))) umgebung[k] = v
    // A suite may override or add to the hub's environment — e.g. shorten the
    // usage/balance caches so a browser test does not wait a full minute.
    for (const [k, v] of Object.entries(env)) umgebung[k] = v
    if (echteAgenten) {
      // No FREILAUF_START_SCRIPT: the hub uses ~/.local/bin/fl-start and thereby the real
      // harnesses. The provider key must go back into the environment, otherwise
      // opencode/hermes starts and dies only at the first API call.
      delete umgebung.FREILAUF_START_SCRIPT
      for (const [k, v] of Object.entries(keys)) if (v) umgebung[k] = v
    } else {
      umgebung.FREILAUF_START_SCRIPT = STUB
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

    zustand.db = new DatabaseSync(join(SB, 'data', 'freilauf.db'))
    // The hub holds its own connection and writes in the background (scheduler,
    // watcher); a direct write here must WAIT for it instead of failing instantly
    // with "database is locked" (the hub's own connection uses busy_timeout 5000).
    zustand.db.exec('PRAGMA busy_timeout = 10000;')
    // The Welcome wizard is what a FRESH installation meets: `GET /` redirects
    // to /welcome for a browser navigation while `welcome_hide` is unset, and a
    // sandbox is a fresh installation every single time. Every suite here asks
    // for `/` expecting the overview, so the wizard is switched off by default
    // — measured on the day the redirect landed: 29 of the browser suite's 57
    // checks went red, every one of them a `page.goto('/')` on the wizard.
    //
    // The wizard itself is tested by clearing this key again (e2e), which is
    // the honest way round: opting IN to the redirect in the one place that is
    // about it, rather than every other suite opting out of it.
    if (willkommen === false) setzeEinstellung('welcome_hide', '1')
    // The two settings that are paths rather than switches. Set here and not by
    // the test, so a suite cannot forget one: a CA directory outside $SB would
    // be a file written into the operator's own data directory by every run.
    if (sandbox) {
      setzeEinstellung('sandbox_ca_dir', join(SANDBOX_DIR, 'ca'))
      setzeEinstellung('sandbox_runtime', 'docker')
    }
    return zustand.db
  }

  /** Write one settings row into the sandbox database (the hub reads it live). */
  function setzeEinstellung(key, value) {
    zustand.db.prepare(`INSERT INTO settings(key, value) VALUES(?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(key), String(value))
  }

  /**
   * The watcher ticks inside the hub every 30 s. Instead of waiting, a suite also
   * triggers the same pass itself — same database, same code, but immediately.
   * This writes the FREILAUF_* variables into THIS process, so it belongs to the one
   * sandbox a suite works with.
   */
  async function watcherVorbereiten({ sandbox = zustand.sandbox } = {}) {
    // The same seams, in THIS process: a watcher pass triggered from the suite
    // reads server/sandbox/* out of the test process, so an unfenced path here
    // would reach out of the sandbox exactly as it would from the hub. Cleared
    // first — a suite that switches the sandbox on for one group and off again
    // must not leave a runtime binary named behind it.
    for (const k of SANDBOX_ENV_KEYS) delete process.env[k]
    for (const [k, v] of Object.entries(sandboxSeams(sandbox))) process.env[k] = v
    process.env.FREILAUF_DATA_DIR = join(SB, 'data')
    process.env.FREILAUF_RUNS_DIR = join(SB, 'runs')
    process.env.FREILAUF_WORKTREES_DIR = join(SB, 'worktrees')
    process.env.FREILAUF_INTEGRATE_DIR = join(SB, 'integrate')
    process.env.FREILAUF_INTEGRATOR_OFF = '1'
    process.env.FREILAUF_QUOTA_JSON = join(SB, 'quota.json')
    process.env.FREILAUF_HUB_SOCKET = join(SB, 'hub.sock')
    process.env.FREILAUF_REPORT_SCRIPT = join(PROJEKT, 'bin', 'fl-report')
    process.env.FREILAUF_CLAUDE_CREDENTIALS = join(SB, 'missing-claude-credentials.json')
    process.env.FREILAUF_START_SCRIPT = STUB
    process.env.FREILAUF_CLAUDE_PROJECTS = join(SB, 'claude-projects')
    process.env.FREILAUF_ZUSAETZE_DIR = join(SB, 'zusaetze')
    process.env.FREILAUF_PLUGIN_DIR = join(SB, 'plugins')
    process.env.FREILAUF_SKILLS_HOME = join(SB, 'skillhome')
    process.env.FREILAUF_SKILLS_STATE = join(SB, 'data', 'skills-installed.json')
    process.env.FREILAUF_PULS_AUS = '1'
    process.env.FREILAUF_CURSOR_AUTH = join(SB, 'missing-cursor-auth.json')
    process.env.FREILAUF_CURSOR_DIR = join(SB, 'cursor')
    process.env.FREILAUF_OPENCODE_DB = join(SB, 'missing-opencode.db')
    process.env.FREILAUF_GOAL_DELAY_MS = '100'
    process.env.FREILAUF_GOAL_WAIT_MS = '10000'
    process.env.FREILAUF_CLEANUP_AUTO_OFF = '1'
    // Same reason as in the hub environment above: no production grace period
    // in the suite (the delayed-notification test drives notify_at by hand).
    process.env.FREILAUF_INCIDENT_NOTIFY_DELAY_MS = '0'
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

  // ------------------------------------------------- the container runtime shim
  /**
   * How a test talks to the shim: it reads the argv log and dictates the
   * answers. Nothing here starts a container — there are none — so every
   * question is "what did the hub SAY", which is the only question a machine
   * without Docker can answer and, for a command line, the only one worth
   * asking anyway.
   */
  function schreibeShim(datei, text) { writeFileSync(join(DOCKER_STATE, datei), text) }

  const docker = {
    STATE: DOCKER_STATE,
    BIN: DOCKER_BIN,

    /** Every invocation, in order: { at, verb, argv, cwd }. */
    calls() {
      let raw
      try { raw = readFileSync(join(DOCKER_STATE, 'calls.jsonl'), 'utf8') } catch { return [] }
      return raw.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    },
    /** The verbs in the order they were called — the shape an ordering assertion needs. */
    order() { return docker.calls().map(c => c.verb) },
    /** Every argv of one verb. */
    argvFor(verb) { return docker.calls().filter(c => c.verb === verb).map(c => c.argv) },
    /** The most recent argv of one verb, or null. */
    lastArgv(verb) { const a = docker.argvFor(verb); return a.length ? a[a.length - 1] : null },
    /** The `run` whose --name is this container, or null. */
    runFor(name) {
      return docker.argvFor('run').find(a => a[a.indexOf('--name') + 1] === name) ?? null
    },

    /**
     * Dictate what the shim answers for one verb: one line per call, each
     * consumed once, the LAST one repeating — test/deploy.mjs's curl rule, and
     * what makes "unreachable now, fine on the next pass" expressible.
     * Words: ok | out <text> | default | no_daemon | unreachable | notfound |
     * absent | fail <code> <text>.
     */
    say(verb, ...lines) {
      mkdirSync(join(DOCKER_STATE, 'answers'), { recursive: true })
      writeFileSync(join(DOCKER_STATE, 'answers', verb), lines.join('\n') + '\n')
    },
    /** Take the dictation back; the built-in behaviour answers again. */
    clearSay(verb) { try { rmSync(join(DOCKER_STATE, 'answers', verb)) } catch {} },

    /**
     * A witness: a script the shim runs BEFORE it answers that verb, with the
     * whole argv. It is the only way to ask an ordering question that spans two
     * processes — "was the tmux session still standing when the container was
     * stopped?", "did the row already say resume_pending?" — because both facts
     * are gone by the time the test looks. Its exit code is ignored: a witness
     * that could change the answer would stop being one.
     */
    hook(verb, script) {
      mkdirSync(join(DOCKER_STATE, 'hooks'), { recursive: true })
      const p = join(DOCKER_STATE, 'hooks', verb)
      writeFileSync(p, script.startsWith('#!') ? script : `#!/usr/bin/env bash\n${script}\n`)
      chmodSync(p, 0o755)
    },
    clearHook(verb) { try { rmSync(join(DOCKER_STATE, 'hooks', verb)) } catch {} },
    /** What a witness wrote into <state>/witness — text, or null. */
    witness() {
      try { return readFileSync(join(DOCKER_STATE, 'witness'), 'utf8').trim() } catch { return null }
    },
    clearWitness() { try { rmSync(join(DOCKER_STATE, 'witness')) } catch {} },

    /**
     * The whole binary's answer, outranking every verb. 'absent' is the binary
     * that is not on the PATH, 'unreachable' the daemon that does not answer —
     * two of the three verdicts, and both have to be reachable from a test
     * because "the daemon did not answer must not end a run" is the single most
     * important behaviour in the feature.
     */
    mode(m) { schreibeShim('mode', String(m ?? 'ok') + '\n') },

    /** What `docker info --format {{json .}}` answers (rootless, version, runtimes). */
    info(obj) { schreibeShim('info.json', JSON.stringify(obj)) },

    /** Seed or patch one row of the fake daemon's container table. */
    container(name, patch = {}) {
      const t = docker.containers()
      t[name] = { state: 'running', status: 'Up 1 second', labels: {}, ...(t[name] ?? {}), ...patch }
      schreibeShim('containers.json', JSON.stringify(t, null, 2))
      return t[name]
    },
    containers() {
      try { return JSON.parse(readFileSync(join(DOCKER_STATE, 'containers.json'), 'utf8')) } catch { return {} }
    },
    networks() {
      try { return JSON.parse(readFileSync(join(DOCKER_STATE, 'networks.json'), 'utf8')) } catch { return {} }
    },
    /** Every container and network the shim created — the cleanup list. */
    created() {
      try { return readFileSync(join(DOCKER_STATE, 'created.txt'), 'utf8').split('\n').filter(Boolean) } catch { return [] }
    },

    /** Forget the log, every dictation and every witness; the table is left alone. */
    reset() {
      schreibeShim('calls.jsonl', '')
      schreibeShim('mode', 'ok\n')
      for (const d of ['answers', 'hooks']) {
        try { rmSync(join(DOCKER_STATE, d), { recursive: true, force: true }) } catch {}
        mkdirSync(join(DOCKER_STATE, d), { recursive: true })
      }
      try { rmSync(join(DOCKER_STATE, 'witness')) } catch {}
    },
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

  /**
   * The session rule, one layer out: a container is the same problem a tmux
   * session is, and it is answered the same way. The shim writes down every
   * name it created, and only those names are removed — never a filter across
   * `fl-*`, which on a machine that really has Docker would take a live hub's
   * containers with it.
   *
   * On this machine the runtime is the shim, so this removes rows from a JSON
   * file. The rule belongs in the code BEFORE there are real containers, not
   * after — that is the whole lesson of the 157 leaked tmux sessions.
   */
  async function containerAufraeumen() {
    const bin = process.env.FREILAUF_SANDBOX_RUNTIME_BIN || DOCKER_BIN
    let namen
    try { namen = readFileSync(join(DOCKER_STATE, 'created.txt'), 'utf8').split('\n').filter(Boolean) } catch { return }
    if (!namen.length) return
    for (const name of namen) {
      if (name.startsWith('network:')) await sh(bin, ['network', 'rm', name.slice(8)]).catch(() => {})
      else await sh(bin, ['rm', '-f', name]).catch(() => {})
    }
  }

  async function aufraeumen() {
    if (zustand.aufgeraeumt) return
    zustand.aufgeraeumt = true
    await hubStoppen()
    // ONLY the sessions we created ourselves — never a pattern across all fl-*.
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
    await containerAufraeumen()
    if (behalten) console.log(`\nSandbox kept: ${SB}`)
    else {
      // A detached flow command (a `sleep 1; touch` in the run_merged tests) can
      // still land in the sandbox while rmSync sweeps it — retry briefly instead
      // of letting the whole suite die on a leftover it did not cause.
      for (let versuch = 0; versuch < 8; versuch++) {
        try { rmSync(SB, { recursive: true, force: true }); break }
        catch { await new Promise(r => setTimeout(r, 200)) }
      }
    }
  }

  return {
    SB, REPO, ORIGIN, FEHLSTART, sessions, SESSIONSLISTE,
    PLUGINS: join(SB, 'plugins'),
    SANDBOX_DIR, DOCKER_STATE, DOCKER_BIN, SHIM_DIR,
    docker,
    bauen, hubStarten, hubStoppen, watcherVorbereiten, aufraeumen,
    hol, formular, setzeEinstellung,
    get db() { return zustand.db },
    get port() { return zustand.port },
    get basis() { return zustand.basis },
  }
}
