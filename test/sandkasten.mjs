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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync, readdirSync, statSync } from 'node:fs'
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

// ---------- leftovers of a suite that was killed ----------
// aufraeumen() below kills exactly the sessions this sandbox created, and it is
// wired to SIGINT/SIGTERM/SIGHUP. None of that runs when the process is SIGKILLed
// — a tool timeout, an OOM kill, an agent's run being aborted. The suite then
// leaves its whole tmux fleet standing, and nothing on the machine knows those
// sessions are garbage. Measured on the development machine on 2026-09-05: 294
// live stub sessions from SIX dead sandboxes, ~1 GB of RSS, and — worse than the
// memory — the hub's own Sessions page and its memory block buried under 300 rows
// of test leftovers, so the one page that exists to find a real session by age
// could not be used for that any more.
//
// So a starting sandbox sweeps what a dead one left: it reads THAT sandbox's own
// sessions.txt and kills exactly those names. Still no pattern across all `fl-*` —
// the list is the proof of ownership, exactly as it is on the way out.
const SANDKASTEN_PRAEFIXE = ['freilauf-test-', 'Freilauf-e2e-', 'Freilauf-browser-']
/** A sandbox with no owner marker is from before this existed; only age says it is dead. */
export const VERWAIST_ALTER_MS = 6 * 3_600_000

/**
 * May this leftover sandbox directory be swept?
 *
 * Pure, so the decision is testable without killing anything. `pid` is what the
 * directory's own owner.pid says (null when it carries none), `lebt` answers
 * whether that process is still running.
 *
 * A LIVE owner is the one answer that must never be got wrong: sweeping a running
 * suite would kill the sessions it is asserting on, from another suite's process,
 * with no error anybody could trace back to here.
 */
export function sandkastenVerwaist(eintrag, { nowMs = Date.now(), eigenerPfad = null, lebt = () => true, altersgrenzeMs = VERWAIST_ALTER_MS } = {}) {
  if (!eintrag?.pfad) return false
  if (eintrag.pfad === eigenerPfad) return false          // never our own
  // `--keep` says a human wants to read this sandbox. Its owner is dead by
  // definition (the suite finished), and its sessions were killed on the way out
  // anyway — so it is the one abandoned directory that is not garbage.
  if (eintrag.behalten) return false
  if (eintrag.pid != null) return !lebt(eintrag.pid)      // the marker answers outright
  // No marker: written by a version before this, or killed between mkdtemp and the
  // first write. Age is the only evidence left — a live suite touches its directory
  // constantly, so anything untouched for hours is over.
  if (!Number.isFinite(eintrag.mtimeMs)) return false
  return nowMs - eintrag.mtimeMs >= altersgrenzeMs
}

/** Is this pid still running? A pid we may not signal is still a pid that exists. */
function pidLebt(pid) {
  try { process.kill(pid, 0); return true } catch (err) { return err?.code === 'EPERM' }
}

/** Every sandbox directory in tmpdir, with the two facts sandkastenVerwaist() judges. */
function sandkastenListe(wurzel = tmpdir()) {
  let namen = []
  try { namen = readdirSync(wurzel) } catch { return [] }
  const out = []
  for (const name of namen) {
    if (!SANDKASTEN_PRAEFIXE.some(p => name.startsWith(p))) continue
    const pfad = join(wurzel, name)
    // A Freilauf sandbox and nothing else: one of the two files it writes itself.
    // Without this a directory that merely shares the prefix could be removed.
    if (!existsSync(join(pfad, 'sessions.txt')) && !existsSync(join(pfad, 'owner.pid'))) continue
    let pid = null
    try { pid = Number(readFileSync(join(pfad, 'owner.pid'), 'utf8').trim()) || null } catch { /* none */ }
    let mtimeMs = NaN
    try { mtimeMs = statSync(pfad).mtimeMs } catch { /* gone while we looked */ }
    out.push({ pfad, pid, mtimeMs, behalten: existsSync(join(pfad, 'behalten')) })
  }
  return out
}

/** Kill the sessions a dead sandbox left behind, then remove its directory. */
async function verwaisteAufraeumen(eigenerPfad) {
  let getoetet = 0
  for (const eintrag of sandkastenListe()) {
    if (!sandkastenVerwaist(eintrag, { eigenerPfad, lebt: pidLebt })) continue
    let namen = []
    try { namen = readFileSync(join(eintrag.pfad, 'sessions.txt'), 'utf8').split('\n').map(z => z.trim()).filter(Boolean) }
    catch { /* a sandbox that never started a run */ }
    // In PARALLEL, and that is not a micro-optimisation. Serially this is one
    // process per session against a tmux server that is busy with everybody
    // else's agents; on a machine holding 300 leftovers it put seconds between
    // the suite's start and its first tmux call, which is exactly the kind of
    // latency the timing-sensitive parts of e2e.mjs trip over. A sweep must
    // cost the suite that performs it as close to nothing as possible.
    //
    // Two suites may sweep the same leftover at once, and a session may be long
    // gone: a failed kill is the normal case here, never a reason to stop.
    const ergebnisse = await Promise.all([...new Set(namen)].map(s =>
      sh('tmux', ['kill-session', '-t', `=${s}`]).catch(() => ({ ok: false }))))
    getoetet += ergebnisse.filter(r => r.ok).length
    try { rmSync(eintrag.pfad, { recursive: true, force: true }) } catch { /* next run gets it */ }
  }
  if (getoetet) console.log(`  (${getoetet} tmux sessions of an earlier, killed suite cleaned up)`)
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

  // Who owns this directory. Written before anything else, so a sandbox is
  // identifiable as abandoned from the moment it exists — see sandkastenVerwaist().
  try { writeFileSync(join(SB, 'owner.pid'), `${process.pid}\n`) } catch { /* the age rule still covers us */ }
  // A kept sandbox is somebody's debugging state, not a leftover — say so on disk,
  // because after the suite exits nothing else distinguishes the two.
  if (behalten) { try { writeFileSync(join(SB, 'behalten'), 'kept for debugging\n') } catch { /* best effort */ } }

  const zustand = { hub: null, db: null, port: 0, basis: '', aufgeraeumt: false }

  async function bauen() {
    // Before anything of our own: take back what a killed suite left standing.
    await verwaisteAufraeumen(SB)
    for (const d of ['data', 'runs', 'worktrees', 'integrate', 'bin', 'plugins', 'skillhome']) mkdirSync(join(SB, d), { recursive: true })

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
  async function hubStarten({ echteAgenten = false, keys = {}, env = {}, willkommen = false } = {}) {
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
  async function watcherVorbereiten() {
    process.env.FREILAUF_DATA_DIR = join(SB, 'data')
    process.env.FREILAUF_RUNS_DIR = join(SB, 'runs')
    process.env.FREILAUF_WORKTREES_DIR = join(SB, 'worktrees')
    process.env.FREILAUF_INTEGRATE_DIR = join(SB, 'integrate')
    process.env.FREILAUF_INTEGRATOR_OFF = '1'
    process.env.FREILAUF_QUOTA_JSON = join(SB, 'quota.json')
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
    bauen, hubStarten, hubStoppen, watcherVorbereiten, aufraeumen,
    hol, formular, setzeEinstellung,
    get db() { return zustand.db },
    get port() { return zustand.port },
    get basis() { return zustand.basis },
  }
}
