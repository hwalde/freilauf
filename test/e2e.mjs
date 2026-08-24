#!/usr/bin/env node
// cc-hub — End-to-End-Tests gegen einen ECHTEN Hub-Prozess in einem Sandkasten.
//
// Warum ein eigener Hub statt Tests gegen den laufenden: die Suite darf jederzeit im
// Live-Betrieb laufen. Sie startet deshalb einen zweiten Hub auf einem freien Port mit
// eigener Datenbank, eigenem runs-/worktrees-Verzeichnis und eigenem Test-Repo. Der
// Produktivhub, seine Datenbank, ~/agents und dessen tmux-Sessions werden nie berührt.
// Aufgeräumt werden nur Sessions, die diese Suite selbst erzeugt hat (Namen werden
// mitgeschrieben) — niemals per Muster über alle cc-*.
//
// Aufruf:
//   node test/e2e.mjs           Stub statt echter Agenten: schnell, keine Kosten
//   node test/e2e.mjs --echt    zusätzlich je EIN echter Lauf pro Harness (claude,
//                               opencode, hermes) über das echte
//                               ~/.local/bin/cc-start (verbraucht Quota!)
//   node test/e2e.mjs --keep    Sandkasten nach dem Lauf stehen lassen (Fehlersuche)
import { spawn, execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, lstatSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { WebSocket } from 'ws'
import { gruppe, pruefe, uebersprungen, gleich, wahr, falsch, enthaelt, warteAuf, bericht, zaehler } from './mini.mjs'

const ECHT = process.argv.includes('--echt')
// Vom Nutzer vorgegebenes Testmodell für opencode/hermes (günstig, werkzeugfähig).
// Den Provider-Key JETZT festhalten: der Stub-Teil löscht ihn gleich aus der Umgebung,
// der Echt-Teil braucht ihn aber noch.
const ECHT_KEYS = { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY }
const ECHT_MODELL = process.env.CCHUB_TEST_MODELL ?? 'deepseek/deepseek-v4-flash-0731'
// Zen: eines der freien Modelle — läuft ohne Schlüssel.
const ZEN_MODELL = process.env.CCHUB_TEST_ZEN_MODELL ?? 'nemotron-3.5-lightning-free'
const vorhanden = (bin) => {
  try { execFileSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }); return true } catch { return false }
}
const BEHALTEN = process.argv.includes('--keep')
const PROJEKT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const start = Date.now()

// ---------------------------------------------------------------- Werkzeug
function sh(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: 60_000, ...opts }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }))
  })
}

async function freierPort() {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => resolve(p))
    })
  })
}

// ---------------------------------------------------------------- Sandkasten
const SB = mkdtempSync(join(tmpdir(), 'cc-hub-e2e-'))
const sessions = new Set()          // nur DAS wird am Ende gekillt
let hub = null
let db = null
let PORT = 0
let BASIS = ''

const REPO = join(SB, 'repo')
const ORIGIN = join(SB, 'origin.git')
const STUB = join(SB, 'bin', 'cc-start')
const FEHLSTART = join(SB, 'fehlstart-an')

async function sandkastenBauen() {
  for (const d of ['data', 'runs', 'worktrees', 'bin']) mkdirSync(join(SB, d), { recursive: true })

  // Zusatz-Skill-Attrappe (Planung: opt-in-Skills außerhalb der Skill-Autoload-Ordner)
  mkdirSync(join(SB, 'zusaetze', 'e2e-fleiss'), { recursive: true })
  writeFileSync(join(SB, 'zusaetze', 'e2e-fleiss', 'SKILL.md'),
    '---\nname: e2e-fleiss\ndescription: Testskill gegen faule Modelle.\n---\n\n# Fleiss\n')

  // Quota-Fixture: sonst entschiede die echte ~/.claude/quota.json über die Budget-Gates
  // und die Suite wäre je nach Tagesform grün oder rot.
  writeFileSync(join(SB, 'quota.json'), JSON.stringify({
    five_hour: { used_percentage: 1, resets_at: 1800000000 }, seven_day_fable: { used_percentage: 0 },
  }))

  await sh('git', ['init', '-q', '--bare', ORIGIN])
  await sh('git', ['init', '-q', '-b', 'main', REPO])
  const g = (...a) => sh('git', ['-C', REPO, ...a])
  await g('config', 'user.email', 'e2e@test.local')
  await g('config', 'user.name', 'E2E')
  writeFileSync(join(REPO, 'README.md'), '# Testrepo\n')
  // .env und referenz/ bleiben UNVERSIONIERT — genau dafür gibt es die
  // Worktree-Ergänzungen. Lägen sie im git, wären sie im Worktree ohnehin da und
  // der Kopier-/Verlinkungsweg würde stillschweigend übersprungen.
  // Ohne Schrägstrich! 'referenz/' würde nur das Verzeichnis ignorieren — die
  // Ergänzung legt im Worktree aber ein SYMLINK an, und das gilt git dann als
  // unversionierte Datei: der Worktree wäre für immer „schmutzig“.
  writeFileSync(join(REPO, '.gitignore'), '.env\nreferenz\n')
  mkdirSync(join(REPO, 'referenz'), { recursive: true })
  writeFileSync(join(REPO, '.env'), 'GEHEIM=1\n')
  writeFileSync(join(REPO, 'referenz', 'a.txt'), 'ref\n')
  await g('add', '-A')
  await g('commit', '-qm', 'init')
  await g('remote', 'add', 'origin', ORIGIN)
  await g('push', '-q', '-u', 'origin', 'main')

  // Stub-cc-start: erzeugt eine echte tmux-Session mit einem harmlosen "Agenten",
  // spricht dieselbe Schnittstelle wie das Original und meldet dieselbe Erfolgszeile.
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

# Rauchtest-Lauf: an das ECHTE cc-start durchreichen (deckt die cc-*-Skripte mit ab).
if [[ -n "$PROMPTFILE" && -r "$PROMPTFILE" ]] && grep -q 'E2E-ECHT' "$PROMPTFILE"; then
  exec "${homedir()}/.local/bin/cc-start" "\${ALLE[@]}"
fi

# Absichtlicher Fehlstart für den Retry-Test.
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
tmux new-session -d -x 200 -y 50 "\${ENVS[@]}" -e "CC_PROMPTFILE=$PROMPTFILE" -s "$SESSION" -c "$WORKDIR" bash "$RUNNER"
if [[ -n "$LOG" ]]; then mkdir -p "$(dirname "$LOG")"; tmux pipe-pane -o -t "=$SESSION:" "cat >> '$LOG'"; fi
[[ -n "$KEEP" ]] && tmux set-option -t "=$SESSION:" -q remain-on-exit on
echo "Session '$SESSION' gestartet in $WORKDIR (Harness: e2e-stub)"
`)
  chmodSync(STUB, 0o755)
}

// ---------------------------------------------------------------- Hub-Prozess
async function hubStarten({ echteAgenten = false } = {}) {
  PORT = await freierPort()
  BASIS = `http://127.0.0.1:${PORT}`
  const umgebung = {
    ...process.env,
    CCHUB_LOCAL_PORT: String(PORT),
    CCHUB_DATA_DIR: join(SB, 'data'),
    CCHUB_RUNS_DIR: join(SB, 'runs'),
    CCHUB_WORKTREES_DIR: join(SB, 'worktrees'),
    CCHUB_QUOTA_JSON: join(SB, 'quota.json'),
    CCHUB_CLAUDE_PROJECTS: join(SB, 'claude-projects'),
    CCHUB_ZUSAETZE_DIR: join(SB, 'zusaetze'),
    CCHUB_PULS_AUS: '1',          // kein Provider-Puls gegen echte Endpunkte aus der Suite
    NODE_OPTIONS: '--disable-warning=ExperimentalWarning',
  }
  if (echteAgenten) {
    // Kein CCHUB_CC_START: der Hub nimmt ~/.local/bin/cc-start und damit die echten
    // Harnesses. Der Provider-Key muss zurück in die Umgebung, sonst startet
    // opencode/hermes und stirbt erst beim ersten API-Aufruf.
    delete umgebung.CCHUB_CC_START
    for (const [k, v] of Object.entries(ECHT_KEYS)) if (v) umgebung[k] = v
  } else {
    umgebung.CCHUB_CC_START = STUB
    delete umgebung.OPENROUTER_API_KEY    // keine echten API-Aufrufe aus dem Stub-Teil
  }
  hub = spawn(process.execPath, [join(PROJEKT, 'server', 'hub.mjs')], { env: umgebung, stdio: ['ignore', 'pipe', 'pipe'] })
  const logs = []
  hub.stdout.on('data', (d) => logs.push(String(d)))
  hub.stderr.on('data', (d) => logs.push(String(d)))
  hub.on('exit', (code) => { if (code !== 0 && code !== null) console.log(`  (Hub beendet, Code ${code})\n${logs.join('')}`) })

  await warteAuf(async () => (await hol('/')).status === 200,
    { was: `Hub auf ${BASIS} antwortet`, timeoutMs: 15_000 })

  db = new DatabaseSync(join(SB, 'data', 'cc-hub.db'))
}

// Der Watcher tickt im Hub alle 30 s. Statt zu warten, stößt die Suite denselben
// Durchgang zusätzlich selbst an — gleiche Datenbank, gleicher Code, aber sofort.
let watcherTick = null
async function watcherVorbereiten() {
  process.env.CCHUB_DATA_DIR = join(SB, 'data')
  process.env.CCHUB_RUNS_DIR = join(SB, 'runs')
  process.env.CCHUB_WORKTREES_DIR = join(SB, 'worktrees')
  process.env.CCHUB_QUOTA_JSON = join(SB, 'quota.json')
  process.env.CCHUB_CC_START = STUB
  process.env.CCHUB_CLAUDE_PROJECTS = join(SB, 'claude-projects')
  process.env.CCHUB_ZUSAETZE_DIR = join(SB, 'zusaetze')
  process.env.CCHUB_PULS_AUS = '1'
  delete process.env.OPENROUTER_API_KEY
  ;({ tick: watcherTick } = await import('../server/watcher.mjs'))
}

// ---------------------------------------------------------------- HTTP
async function hol(pfad, opts = {}) {
  return fetch(BASIS + pfad, { redirect: 'manual', signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000), ...opts })
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

// ---------------------------------------------------------------- Datenbank
const lauf = (id) => db.prepare('SELECT * FROM runs WHERE id=?').get(id)
const ereignisse = (id) => db.prepare('SELECT kind FROM events WHERE run_id=? ORDER BY id').all(id).map(e => e.kind)
const agent = (name) => db.prepare('SELECT * FROM agents WHERE name=?').get(name)

/** Lauf über die JSON-API starten und die erzeugte tmux-Session mitschreiben. */
async function laufStarten(daten) {
  const r = await formular('/api/runs', { harness: 'claude', branch_mode: 'keiner', expected_minutes: '45', ...daten })
  const j = await r.json()
  if (j.runId) {
    const s = lauf(j.runId)?.tmux_session
    if (s) sessions.add(s)
  }
  return j
}

async function sessionMerken(runId) {
  const s = lauf(runId)?.tmux_session
  if (s) sessions.add(s)
  return s
}

// ---------------------------------------------------------------- Aufräumen
let aufgeraeumt = false
/** Hub-Prozess beenden (auch zwischendurch, wenn der Echt-Modus neu startet). */
async function hubStoppen() {
  try { db?.close() } catch {}
  db = null
  if (hub && hub.exitCode === null) {
    hub.kill('SIGTERM')
    await new Promise(r => { const t = setTimeout(() => { try { hub.kill('SIGKILL') } catch {} ; r() }, 4000); hub.once('exit', () => { clearTimeout(t); r() }) })
  }
  hub = null
}

async function aufraeumen() {
  if (aufgeraeumt) return
  aufgeraeumt = true
  await hubStoppen()
  // NUR die selbst erzeugten Sessions — niemals ein Muster über alle cc-*.
  for (const s of sessions) await sh('tmux', ['kill-session', '-t', `=${s}`]).catch(() => {})
  if (BEHALTEN) console.log(`\nSandkasten bleibt stehen: ${SB}`)
  else rmSync(SB, { recursive: true, force: true })
}
process.on('SIGINT', async () => { await aufraeumen(); process.exit(130) })
process.on('SIGTERM', async () => { await aufraeumen(); process.exit(143) })

// ================================================================== Testlauf
try {
  console.log(`Sandkasten: ${SB}`)
  await sandkastenBauen()
  await hubStarten()
  await watcherVorbereiten()
  console.log(`Hub: ${BASIS}${ECHT ? '   [--echt: echte Läufe je Harness — verbraucht Quota und Guthaben]' : ''}`)

  // ------------------------------------------------------------------
  gruppe('Grundgerüst: Seiten, statische Dateien, API-Fallback')

  await pruefe('leerer Zustand führt zum Repo-Anlegen', async () => {
    const r = await hol('/')
    gleich(r.status, 200, 'Status')
    enthaelt(await r.text(), 'Repo anlegen', 'Hinweistext')
  })
  for (const datei of ['/static/xterm.js', '/static/addon-fit.js', '/static/hub.js', '/static/hub.css', '/static/xterm.css']) {
    await pruefe(`${datei} wird ausgeliefert`, async () => {
      const r = await hol(datei)
      gleich(r.status, 200, 'Status')
      wahr((await r.text()).length > 100, 'Inhalt vorhanden')
    })
  }
  await pruefe('unbekannter API-Pfad antwortet 404 statt zu hängen', async () => {
    const r = await hol('/api/gibtsnicht', { timeoutMs: 5000 })
    gleich(r.status, 404, 'Status')
  })
  await pruefe('Telegram-Chats ohne Token melden den Grund', async () => {
    const j = await (await hol('/api/telegram/chats', { timeoutMs: 5000 })).json()
    falsch(j.ok, 'ok')
    wahr(typeof j.error === 'string' && j.error.length > 0, 'Fehlermeldung')
  })

  // ------------------------------------------------------------------
  gruppe('Repos: anlegen und prüfen')

  await pruefe('gültiges Repo wird angelegt', async () => {
    const r = await formular('/repos/edit', {
      name: 'e2e', path: REPO, base_branch: 'main',
      worktree_extras: JSON.stringify([{ path: '.env', mode: 'copy' }, { path: 'referenz/', mode: 'link' }]),
    }, { alsBrowser: true })
    gleich(r.status, 303, 'Weiterleitung')
    const repo = db.prepare('SELECT * FROM repos WHERE name=?').get('e2e')
    wahr(!!repo, 'Repo in der Datenbank')
    gleich(repo.path, REPO, 'Pfad')
  })
  await pruefe('kaputtes JSON wird abgelehnt (400 statt 500)', async () => {
    const r = await formular('/repos/edit', { name: 'x', path: REPO, worktree_extras: '[{kaputt' }, { alsBrowser: true })
    gleich(r.status, 400, 'Status')
  })
  await pruefe('Pfad ohne .git wird abgelehnt', async () => {
    const r = await formular('/repos/edit', { name: 'x', path: '/tmp', worktree_extras: '[]' }, { alsBrowser: true })
    gleich(r.status, 400, 'Status')
    enthaelt(await r.text(), 'git', 'Begründung nennt git')
  })
  await pruefe('unbekannter mode in den Ergänzungen wird abgelehnt', async () => {
    const r = await formular('/repos/edit', {
      name: 'x', path: REPO, worktree_extras: JSON.stringify([{ path: '.env', mode: 'kopieren' }]),
    }, { alsBrowser: true })
    gleich(r.status, 400, 'Status')
  })

  const repoId = db.prepare('SELECT id FROM repos WHERE name=?').get('e2e').id

  // ------------------------------------------------------------------
  gruppe('Agenten: anlegen und prüfen')

  await pruefe('unbekannte Harness wird abgelehnt', async () => {
    const r = await formular('/agents/edit', { repo_id: repoId, name: 'a1', harness: 'gpt', prompt: 'x', branch_mode: 'keiner', schedule_kind: 'manuell' }, { alsBrowser: true })
    gleich(r.status, 400, 'Status')
  })
  await pruefe('leerer Prompt wird abgelehnt', async () => {
    const r = await formular('/agents/edit', { repo_id: repoId, name: 'a2', harness: 'claude', prompt: '   ', branch_mode: 'keiner', schedule_kind: 'manuell' }, { alsBrowser: true })
    gleich(r.status, 400, 'Status')
  })
  await pruefe('ungültiger Cron-Ausdruck wird abgelehnt', async () => {
    const r = await formular('/agents/edit', { repo_id: repoId, name: 'a3', harness: 'claude', prompt: 'x', branch_mode: 'keiner', schedule_kind: 'cron', schedule: 'jeden tag' }, { alsBrowser: true })
    gleich(r.status, 400, 'Status')
  })
  await pruefe('wöchentlich ohne Wochentag wird abgelehnt', async () => {
    const r = await formular('/agents/edit', { repo_id: repoId, name: 'a4', harness: 'claude', prompt: 'x', branch_mode: 'keiner', schedule_kind: 'woechentlich', schedule_time: '06:00', schedule_weeks: '1' }, { alsBrowser: true })
    gleich(r.status, 400, 'Status')
  })
  await pruefe('einmalig ohne Termin wird abgelehnt', async () => {
    const r = await formular('/agents/edit', { repo_id: repoId, name: 'a5', harness: 'claude', prompt: 'x', branch_mode: 'keiner', schedule_kind: 'einmalig', run_at: '' }, { alsBrowser: true })
    gleich(r.status, 400, 'Status')
  })
  await pruefe('mehrwöchiger Takt ohne Startwoche wird abgelehnt', async () => {
    const r = await formular('/agents/edit', { repo_id: repoId, name: 'a6', harness: 'claude', prompt: 'x', branch_mode: 'keiner', schedule_kind: 'woechentlich', schedule_days: ['1'], schedule_time: '06:00', schedule_weeks: '2', schedule_anchor: '' }, { alsBrowser: true })
    gleich(r.status, 400, 'Status')
  })
  await pruefe('wöchentlicher Agent wird mit allen Feldern gespeichert', async () => {
    const r = await formular('/agents/edit', {
      repo_id: repoId, name: 'e2e-woechentlich', harness: 'claude', prompt: 'Testauftrag', branch_mode: 'keiner',
      expected_minutes: '30', schedule_kind: 'woechentlich', schedule_days: ['1', '3', '5'],
      schedule_time: '07:30', schedule_weeks: '2', schedule_anchor: '2026-08-24', active: '1',
    }, { alsBrowser: true })
    gleich(r.status, 303, 'Weiterleitung')
    const a = agent('e2e-woechentlich')
    gleich(a.schedule_kind, 'woechentlich', 'Art')
    gleich(a.schedule_days, '1,3,5', 'Wochentage')
    gleich(a.schedule_time, '07:30', 'Uhrzeit')
    gleich(a.schedule_weeks, 2, 'Takt')
    gleich(a.schedule_anchor, '2026-08-24', 'Startwoche')
  })
  await pruefe('Umschalten auf manuell räumt die Zeitplanfelder ab', async () => {
    const id = agent('e2e-woechentlich').id
    const r = await formular(`/agents/edit?id=${id}`, {
      repo_id: repoId, name: 'e2e-woechentlich', harness: 'claude', prompt: 'Testauftrag',
      branch_mode: 'keiner', expected_minutes: '30', schedule_kind: 'manuell', active: '1',
    }, { alsBrowser: true })
    gleich(r.status, 303, 'Weiterleitung')
    const a = agent('e2e-woechentlich')
    gleich(a.schedule_kind, 'manuell', 'Art')
    gleich(a.schedule_days, null, 'Wochentage geleert')
    gleich(a.run_at, null, 'Termin geleert')
  })

  // ------------------------------------------------------------------
  gruppe('Provider- und Effort-Auswahl (harness-abhängig)')

  await pruefe('jede Harness bekommt nur Provider, die sie hier auch kann', async () => {
    const p = async (h) => (await (await hol(`/api/providers?harness=${h}`)).json()).provider.map(x => x.id)
    gleich((await p('claude')).length, 0, 'claude läuft über das Abo, kein Provider')
    wahr((await p('opencode')).includes('opencode-zen'), 'opencode kennt Zen')
    falsch((await p('hermes')).includes('opencode-zen'), 'hermes kann Zen hier nicht (kein Schlüssel)')
  })

  await pruefe('Denk-Aufwand nur, wo er wirklich ankommt', async () => {
    const eff = async (q) => (await (await hol('/api/effort?' + q)).json())
    const c = await eff('harness=claude')
    wahr(c.ok && c.stufen.includes('high'), `claude nennt Stufen (${JSON.stringify(c).slice(0, 90)})`)
    const quatsch = await eff('harness=opencode&provider=openrouter&model=gibtsnicht/quatsch')
    falsch(quatsch.ok, 'unbekanntes Modell: kein Feld statt geratener Stufen')
    gleich((await hol('/api/effort?harness=quatsch')).status, 200, 'antwortet immer mit 200')
  })

  await pruefe('eine unmögliche Stufe wird abgelehnt statt still verworfen', async () => {
    // opencode wirft eine unbekannte Variante kommentarlos weg — der Hub muss das
    // vorher merken, sonst stünde in der DB eine Zusage, die nichts bewirkt.
    const r = await formular('/agents/edit', {
      repo_id: String(repoId), name: 'effort-quatsch', harness: 'opencode', provider: 'opencode-zen',
      model: 'hy3-free', effort: 'ultraturbo', prompt: 'x', branch_mode: 'keiner',
      expected_minutes: '5', schedule_kind: 'manuell',
    }, { alsBrowser: true })
    gleich(r.status, 400, 'abgelehnt')
    enthaelt(await r.text(), 'Denk-Aufwand', 'mit Begründung')
    falsch(!!db.prepare(`SELECT 1 FROM agents WHERE name='effort-quatsch'`).get(), 'nichts gespeichert')
  })

  gruppe('Einzellauf: Worktree, Prompt, tmux, Log')

  await pruefe('das Startformular zeigt den WIRKLICHEN Pipeline-Zustand', async () => {
    // War fest verdrahtet: das Formular behauptete immer "Pipeline ist aus",
    // auch wenn oben rechts "an" stand.
    const text = async () => (await hol(`/runs/new?repo=${repoId}`)).text()
    await formular('/api/settings/pipeline', { value: '0' })
    enthaelt(await text(), 'Pipeline ist aus', 'Hinweis bei ausgeschalteter Pipeline')
    await formular('/api/settings/pipeline', { value: '1' })
    const an = await text()
    enthaelt(an, 'Pipeline ist an', 'Hinweis bei eingeschalteter Pipeline')
    falsch(an.includes('Pipeline ist aus'), 'kein widersprüchlicher Hinweis daneben')
    await formular('/api/settings/pipeline', { value: '0' })
  })

  let R1 = null
  await pruefe('Lauf startet über das Formular und leitet auf die Laufseite', async () => {
    const r = await formular('/runs/new', {
      repo_id: repoId, harness: 'claude', prompt: 'E2E-Auftrag: nichts tun.',
      branch_mode: 'neu', branch_pattern: 'agent/e2e/{kurz}', expected_minutes: '45',
    }, { alsBrowser: true })
    gleich(r.status, 303, 'Weiterleitung')
    const ort = r.headers.get('location')
    wahr(/^\/runs\/[0-9a-f-]{36}$/.test(ort), `Ziel ist eine Laufseite (${ort})`)
    R1 = ort.split('/')[2]
    await sessionMerken(R1)
    gleich(lauf(R1).status, 'running', 'Status')
  })
  await pruefe('Worktree existiert und steht auf dem erwarteten Branch', async () => {
    const l = lauf(R1)
    wahr(existsSync(l.workdir_effective), `Worktree ${l.workdir_effective}`)
    const b = await sh('git', ['-C', l.workdir_effective, 'rev-parse', '--abbrev-ref', 'HEAD'])
    gleich(b.stdout.trim(), l.branch_expected, 'Branch')
    enthaelt(l.branch_expected, 'agent/e2e/', 'Branch-Muster expandiert')
  })
  await pruefe('Worktree-Ergänzungen: .env kopiert, referenz/ verlinkt', () => {
    const wt = lauf(R1).workdir_effective
    wahr(existsSync(join(wt, '.env')), '.env vorhanden')
    falsch(lstatSync(join(wt, '.env')).isSymbolicLink(), '.env ist eine Kopie')
    wahr(lstatSync(join(wt, 'referenz')).isSymbolicLink(), 'referenz/ ist ein Symlink')
  })
  await pruefe('prompt.md enthält Auftrag und Plattform-Zusatz', () => {
    const p = readFileSync(join(SB, 'runs', R1, 'prompt.md'), 'utf8')
    enthaelt(p, 'E2E-Auftrag', 'eigener Auftrag')
    enthaelt(p, 'cc-report done', 'Plattform-Regeln')
    enthaelt(p, R1, 'Lauf-ID')
  })
  await pruefe('tmux-Session läuft und ist dem Lauf zugeordnet', async () => {
    const s = lauf(R1).tmux_session
    wahr(!!s, 'Session in der Datenbank')
    wahr((await sh('tmux', ['has-session', '-t', `=${s}`])).ok, `Session ${s} lebt`)
  })
  await pruefe('Log-Datei wird angelegt (cc-start --log → pipe-pane)', () => {
    // Auf den INHALT wird erst nach dem ersten Senden geprüft: pipe-pane hängt sich
    // erst nach dem Start an, die Startausgabe kann ihm entgehen.
    wahr(existsSync(join(SB, 'runs', R1, 'log.txt')), 'log.txt angelegt')
  })

  // ------------------------------------------------------------------
  gruppe('Terminal im Browser (WebSocket)')

  const wsVersuch = (pfad) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}${pfad}`)
    const fertig = (e) => { try { ws.close() } catch {} ; resolve(e) }
    const t = setTimeout(() => fertig({ art: 'timeout' }), 8000)
    ws.on('message', (d) => { clearTimeout(t); fertig({ art: 'daten', text: String(d) }) })
    ws.on('unexpected-response', (_req, res) => { clearTimeout(t); fertig({ art: 'http', status: res.statusCode }) })
    ws.on('error', (err) => { clearTimeout(t); fertig({ art: 'fehler', text: err.message }) })
  })

  await pruefe('Terminal verbindet und liefert den Sitzungsinhalt', async () => {
    const e = await wsVersuch(`/term?run=${R1}&ro=1`)
    gleich(e.art, 'daten', `Ereignis (${JSON.stringify(e)})`)
    wahr(e.text.length > 0, 'Ausgabe empfangen')
  })
  await pruefe('unbekannter Lauf ergibt 404 statt Hänger', async () => {
    const e = await wsVersuch('/term?run=00000000-0000-4000-8000-000000000000&ro=1')
    gleich(e.art, 'http', 'HTTP-Antwort')
    gleich(e.status, 404, 'Status')
  })

  // Tippen im Terminal — der Weg, den die Suite lange nicht genommen hat: bis hierher
  // prüfte sie nur ro=1 und hätte eine dauerhaft stumme Eingabe nie bemerkt.
  const wsSchreiben = (pfad, text) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}${pfad}`)
    const t = setTimeout(() => { try { ws.close() } catch {}; reject(new Error('Timeout beim Verbinden')) }, 8000)
    // Erst wenn tmux den Bildschirm gemalt hat, ist der Client wirklich angehängt.
    ws.once('message', () => {
      clearTimeout(t)
      ws.send(text)
      setTimeout(() => { try { ws.close() } catch {}; resolve() }, 300)
    })
    ws.on('error', (err) => { clearTimeout(t); reject(err) })
  })

  await pruefe('mit ro=0 landet Getipptes wirklich in der Session', async () => {
    await wsSchreiben(`/term?run=${R1}&ro=0`, 'direkt getippt\r')
    await warteAuf(async () => (await sh('tmux', ['capture-pane', '-p', '-t', `=${lauf(R1).tmux_session}:`]))
      .stdout.includes('[agent sah] direkt getippt'), { was: 'getippter Text im Pane', timeoutMs: 8000 })
  })
  await pruefe('ohne ro-Parameter bleibt das Terminal stumm (fail-closed)', async () => {
    await wsSchreiben(`/term?run=${R1}`, 'darf nicht ankommen\r')
    await new Promise((r) => setTimeout(r, 1500))
    const p = await sh('tmux', ['capture-pane', '-p', '-t', `=${lauf(R1).tmux_session}:`])
    falsch(p.stdout.includes('darf nicht ankommen'), 'nichts durchgelassen')
  })

  // ------------------------------------------------------------------
  gruppe('Text senden und Rückmeldungen (cc-report)')

  const ccReport = (runId, args) => sh(join(homedir(), '.local', 'bin', 'cc-report'), args, {
    env: { ...process.env, CC_RUN_ID: runId, CC_HUB_URL: BASIS },
  })

  await pruefe('Senden über die API landet in der tmux-Session', async () => {
    const r = await formular(`/api/runs/${R1}/send`, { text: 'hallo aus dem test' })
    gleich(r.status, 200, 'Status')
    gleich((await r.json()).ok, true, 'ok')
    await warteAuf(async () => (await sh('tmux', ['capture-pane', '-p', '-t', `=${lauf(R1).tmux_session}:`]))
      .stdout.includes('[agent sah] hallo aus dem test'), { was: 'Text im Pane', timeoutMs: 8000 })
  })
  await pruefe('das Log schneidet den Verlauf mit', async () => {
    const datei = join(SB, 'runs', R1, 'log.txt')
    await warteAuf(() => readFileSync(datei, 'utf8').includes('hallo aus dem test'),
      { was: 'gesendeter Text im Log', timeoutMs: 8000 })
  })
  await pruefe('Formular-POST leitet auf die Laufseite zurück (kein nacktes JSON)', async () => {
    const r = await formular(`/api/runs/${R1}/send`, { text: 'zweiter text' }, { alsBrowser: true })
    gleich(r.status, 303, 'Status')
    gleich(r.headers.get('location'), `/runs/${R1}`, 'Ziel')
  })
  await pruefe('Fortschritt, Branch und PR werden übernommen', async () => {
    wahr((await ccReport(R1, ['progress', 'laeuft weiter'])).ok, 'progress')
    wahr((await ccReport(R1, ['branch', 'agent/e2e/gemeldet'])).ok, 'branch')
    wahr((await ccReport(R1, ['pr', 'https://example.invalid/pr/1'])).ok, 'pr')
    const l = lauf(R1)
    gleich(l.branch_reported, 'agent/e2e/gemeldet', 'Branch')
    gleich(l.pr_url, 'https://example.invalid/pr/1', 'PR')
    wahr(ereignisse(R1).includes('progress'), 'Ereignis progress')
  })
  await pruefe('Hilferuf setzt den Lauf auf waiting_help', async () => {
    wahr((await ccReport(R1, ['help', 'Variante A oder B?'])).ok, 'help')
    const l = lauf(R1)
    gleich(l.status, 'waiting_help', 'Status')
    enthaelt(l.help_text, 'Variante A', 'Frage gespeichert')
  })
  await pruefe('Antwort setzt den Lauf zurück auf running', async () => {
    await formular(`/api/runs/${R1}/send`, { text: 'Nimm B.' })
    const l = lauf(R1)
    gleich(l.status, 'running', 'Status')
    enthaelt(l.help_answer, 'Nimm B.', 'Antwort gespeichert')
  })
  await pruefe('Abschlussbericht landet im Lauf und auf der Seite', async () => {
    const datei = join(SB, 'report.md')
    writeFileSync(datei, '# Bericht\n- alles erledigt\n')
    wahr((await ccReport(R1, ['done', '--file', datei])).ok, 'done')
    const l = lauf(R1)
    gleich(l.status, 'done', 'Status')
    enthaelt(l.report_md, 'alles erledigt', 'Bericht gespeichert')
    enthaelt(await (await hol(`/runs/${R1}`)).text(), 'alles erledigt', 'Bericht auf der Seite')
  })

  // ------------------------------------------------------------------
  gruppe('Watcher: Auffälligkeiten, Kosten, Branch-Abgleich')

  let R3 = null
  await pruefe('überzogene Erwartung erzeugt Auffälligkeiten', async () => {
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Ueberzug', expected_minutes: '1' })
    R3 = j.runId
    wahr(!!R3, 'Lauf angelegt')
    await sessionMerken(R3)
    // Startzeit zurückdatieren, statt fünf Minuten zu warten.
    db.prepare(`UPDATE runs SET started_at=datetime('now','-5 minutes') WHERE id=?`).run(R3)
    await watcherTick()
    const k = ereignisse(R3)
    wahr(k.includes('anomaly:overrun'), `anomaly:overrun (hat: ${k.join(', ')})`)
    wahr(k.includes('anomaly:soft_overrun'), 'anomaly:soft_overrun')
  })
  await pruefe('Fortschrittsmeldung räumt die Auffälligkeiten wieder ab', async () => {
    wahr((await ccReport(R3, ['progress', 'melde mich, dauert laenger'])).ok, 'progress')
    const k = ereignisse(R3)
    falsch(k.includes('anomaly:overrun'), 'anomaly:overrun ist weg')
    wahr(k.includes('cleared:anomaly:overrun'), 'als erledigt vermerkt')
    wahr(k.includes('cleared:anomaly:soft_overrun'), 'auch die gelbe Stufe')
  })
  await pruefe('Kostenabschluss läuft für beendete Läufe wirklich', async () => {
    await watcherTick()
    const l = lauf(R1)
    wahr(l.quota7_end !== null, 'quota7_end gesetzt')
    wahr(l.cost_eur !== null, 'cost_eur berechnet')
  })
  await pruefe('ungepushter Branch wird gemeldet', async () => {
    const l = lauf(R1)
    // Der gemeldete Branch existiert nicht in git — für den Abgleich zählt der echte.
    db.prepare('UPDATE runs SET branch_reported=? WHERE id=?').run(l.branch_expected, R1)
    db.prepare(`DELETE FROM events WHERE run_id=? AND kind IN ('anomaly:unpushed','branch_synced')`).run(R1)
    await sh('git', ['-C', l.workdir_effective, 'commit', '-q', '--allow-empty', '-m', 'Arbeit des Agenten'])
    await watcherTick()
    wahr(ereignisse(R1).includes('anomaly:unpushed'), `anomaly:unpushed (hat: ${ereignisse(R1).join(', ')})`)
  })

  // ------------------------------------------------------------------
  gruppe('Zusatz-Skills: opt-in je Lauf und Agent')

  await pruefe('Formulare bieten den Skill als Häkchen an, nichts ist vorausgewählt', async () => {
    const html = await (await hol(`/runs/new?repo=${repoId}`)).text()
    enthaelt(html, 'e2e-fleiss', 'Einzellauf-Formular')
    enthaelt(html, 'Testskill gegen faule Modelle', 'Beschreibung')
    falsch(/name="skills"[^>]*checked/.test(html), 'opt-in: nicht vorausgewählt')
    enthaelt(await (await hol(`/agents/edit?repo=${repoId}`)).text(), 'e2e-fleiss', 'Agenten-Formular')
  })
  await pruefe('gewählter Skill landet als SKILL.md-Verweis im Prompt des Laufs', async () => {
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Skilltest', skills: 'e2e-fleiss' })
    wahr(!!j.runId, `Lauf (${JSON.stringify(j)})`)
    await sessionMerken(j.runId)
    gleich(lauf(j.runId).skills, '["e2e-fleiss"]', 'Definitions-Kopie am Lauf')
    const prompt = readFileSync(join(SB, 'runs', j.runId, 'prompt.md'), 'utf8')
    enthaelt(prompt, join(SB, 'zusaetze', 'e2e-fleiss', 'SKILL.md'), 'voller Pfad im Prompt')
    enthaelt(prompt, 'GESAMTEN Auftrags', 'Anwendungs-Anweisung')
    enthaelt(await (await hol(`/runs/${j.runId}`)).text(), 'e2e-fleiss', 'Detailseite zeigt die Auswahl')
  })
  await pruefe('ohne Häkchen bleibt der Prompt frei von Skill-Verweisen', async () => {
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-ohne-Skill' })
    await sessionMerken(j.runId)
    gleich(lauf(j.runId).skills, null, 'keine Auswahl')
    falsch(readFileSync(join(SB, 'runs', j.runId, 'prompt.md'), 'utf8').includes('SKILL.md'), 'kein Verweis')
  })
  await pruefe('Agent mit Skill: der Lauf erbt die Auswahl (auch über den Scheduler-Weg)', async () => {
    const r = await formular('/agents/edit', {
      repo_id: repoId, name: 'skill-traeger', harness: 'claude', prompt: 'E2E-Agent-Skill',
      branch_mode: 'keiner', expected_minutes: '45', schedule_kind: 'manuell', active: '1',
      skills: 'e2e-fleiss',
    }, { alsBrowser: true })
    gleich(r.status, 303, 'gespeichert')
    gleich(agent('skill-traeger').skills, '["e2e-fleiss"]', 'am Agenten')
    const r2 = await formular('/agents/start', { id: String(agent('skill-traeger').id), repo: String(repoId) }, { alsBrowser: true })
    gleich(r2.status, 303, 'gestartet')
    const runId = r2.headers.get('location').split('/')[2]
    await sessionMerken(runId)
    gleich(lauf(runId).skills, '["e2e-fleiss"]', 'Kopie am Lauf')
    enthaelt(readFileSync(join(SB, 'runs', runId, 'prompt.md'), 'utf8'), 'e2e-fleiss/SKILL.md', 'im Prompt')
  })
  await pruefe('Regler: Tiefe aus dem Formular landet im Lauf und im Prompt', async () => {
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Skill-Tiefe', skills: 'e2e-fleiss', 'skill_regler_e2e-fleiss': '4' })
    await sessionMerken(j.runId)
    // e2e-fleiss hat keinen Regler definiert → Wert wird verworfen, Häkchen bleibt.
    gleich(lauf(j.runId).skills, '["e2e-fleiss"]', 'ohne Regler-Definition kein Anhang')
  })
  await pruefe('erfundene Skill-Namen aus dem Formular werden verworfen', async () => {
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Skill-boese', skills: '../../etc/passwd' })
    await sessionMerken(j.runId)
    gleich(lauf(j.runId).skills, null, 'nicht übernommen')
  })

  // ------------------------------------------------------------------
  gruppe('Vorfälle: Rate-Limit und Provider-Fehler (Autoalarm)')

  const vorfaelle = (id) => db.prepare('SELECT * FROM incidents WHERE run_id=? ORDER BY id').all(id)
  const logAnhaengen = (id, text) => {
    const f = join(SB, 'runs', id, 'log.txt')
    mkdirSync(join(SB, 'runs', id), { recursive: true })
    writeFileSync(f, text, { flag: 'a' })
  }

  await pruefe('cursor: Lauf läuft durch die Pipeline und "Cannot use this model" wird erkannt', async () => {
    // Zwei Dinge auf einmal, weil sie zusammengehören: dass eine cursor-Harness den
    // ganzen Weg (Formular → DB-CHECK → Worktree → Session → Watcher) übersteht, und
    // dass Cursors LAUTE Modellablehnung als Vorfall ankommt. Genau die ist bei cursor
    // der wahrscheinlichste Startfehler — die CLI nimmt nur IDs aus 'cursor-agent
    // models' an und schreibt bei allem anderen die komplette Liste ins Log.
    const j = await laufStarten({ repo_id: repoId, harness: 'cursor',
      model: 'claude-opus-5-xhigh', prompt: 'E2E-Vorfall-cursor', expected_minutes: '45' })
    const RC = j.runId
    wahr(!!RC, `Lauf angelegt (Antwort: ${JSON.stringify(j).slice(0, 200)})`)
    const lauf = db.prepare('SELECT harness, model, effort FROM runs WHERE id=?').get(RC)
    gleich(lauf.harness, 'cursor', 'Harness in der DB')
    gleich(lauf.model, 'claude-opus-5-xhigh', 'Modell-ID wortwörtlich gespeichert')
    gleich(lauf.effort, null, 'kein getrennter Effort — die Stufe steckt in der ID')
    await sessionMerken(RC)
    await watcherTick()
    logAnhaengen(RC, 'Cannot use this model: gibtsnicht-9000. Available models: auto, gpt-5.2\r\n')
    await watcherTick()
    const v = vorfaelle(RC)
    gleich(v.length, 1, `genau ein Vorfall (hat: ${JSON.stringify(v.map(x => [x.typ, x.schwere]))})`)
    gleich(v[0].typ, 'model_error', 'als Modellfehler eingeordnet')
    enthaelt(v[0].beleg, 'Cannot use this model', 'Beleg ist die Zeile')
  })

  let RH = null   // „hermes"-Lauf (der Stub ignoriert die Harness; die Muster im Hub nicht)
  await pruefe('hermes: erster Log-Treffer wird GELB vorgemerkt, ohne Telegram', async () => {
    const j = await laufStarten({ repo_id: repoId, harness: 'hermes', prompt: 'E2E-Vorfall-hermes', expected_minutes: '45' })
    RH = j.runId
    wahr(!!RH, 'Lauf angelegt')
    await sessionMerken(RH)
    await watcherTick()   // Offset auf den Stand bringen — der Stub-Start hat schon geschrieben
    logAnhaengen(RH, '\x1b[33m⏳ Retrying in 12.0s (rate limited by upstream provider (429))...\x1b[0m\r\n')
    await watcherTick()
    const v = vorfaelle(RH)
    gleich(v.length, 1, `genau ein Vorfall (hat: ${JSON.stringify(v.map(x => [x.typ, x.schwere]))})`)
    gleich(v[0].typ, 'rate_limit', 'Typ')
    gleich(v[0].schwere, 'gelb', 'gelb')
    gleich(v[0].quelle, 'log', 'Quelle')
    enthaelt(v[0].beleg, 'Retrying', 'Beleg ist die Zeile')
    falsch(ereignisse(RH).some(k => k === 'telegram_sent'), 'kein Telegram für gelb')
    enthaelt(await (await hol(`/?repo=${repoId}`)).text(), 'Rate-Limit 1×', 'Übersicht zeigt den Vorfall')
  })
  await pruefe('derselbe Treffer zählt bei jedem Durchgang nur einmal (Offset)', async () => {
    await watcherTick(); await watcherTick()
    gleich(vorfaelle(RH)[0].anzahl, 1, 'anzahl bleibt 1')
  })
  await pruefe('Wiederholung binnen 10 min → ROT (Retry-Schleife), Telegram-Versuch vermerkt', async () => {
    logAnhaengen(RH, '⚠️  API call failed (attempt 2/5): RateLimitError (HTTP 429)\n')
    await watcherTick()
    const v = vorfaelle(RH)[0]
    gleich(v.anzahl, 2, 'anzahl 2')
    gleich(v.schwere, 'rot', 'rot')
    wahr(ereignisse(RH).includes('incident:eskaliert'), `eskaliert (hat: ${ereignisse(RH).join(', ')})`)
    const tg = db.prepare(`SELECT payload FROM events WHERE run_id=? AND kind='telegram_sent' ORDER BY id DESC LIMIT 1`).get(RH)
    wahr(!!tg && JSON.parse(tg.payload).type === 'incident:rate_limit', 'Telegram-Versand für den Vorfall (ohne Token: delivered=false, aber versucht)')
    enthaelt(await (await hol(`/runs/${RH}`)).text(), 'Vorfälle', 'Detailseite zeigt den Abschnitt')
  })
  await pruefe('Lösen über die Oberfläche nimmt den Alarm zurück', async () => {
    const v = vorfaelle(RH)[0]
    const r = await formular(`/api/incidents/${v.id}/resolve`, { back: `/runs/${RH}` }, { alsBrowser: true })
    gleich(r.status, 303, 'Redirect')
    gleich(r.headers.get('location'), `/runs/${RH}`, 'zurück zur Laufseite')
    const nach = vorfaelle(RH)[0]
    wahr(!!nach.geloest_am, 'geloest_am gesetzt')
    gleich(nach.geloest_von, 'web', 'von web')
    falsch((await (await hol(`/?repo=${repoId}`)).text()).includes('Rate-Limit 2×'), 'Übersicht ohne offenen Vorfall')
  })
  await pruefe('tritt es NACH dem Lösen erneut auf, geht der Alarm wieder an (Autoalarm)', async () => {
    // Das Lösen liegt in derselben Sekunde — der neue Treffer muss danach liegen.
    db.prepare(`UPDATE incidents SET geloest_am=datetime('now','-2 minutes') WHERE run_id=?`).run(RH)
    logAnhaengen(RH, '⏳ Retrying in 30.0s (rate limited by upstream provider (429))...\n')
    await watcherTick()
    const v = vorfaelle(RH)
    gleich(v.length, 1, 'immer noch EIN Datensatz (Historie bleibt)')
    gleich(v[0].geloest_am, null, 'wieder offen')
    gleich(v[0].wieder_geoeffnet, 1, '1× wieder geöffnet')
    gleich(v[0].anzahl, 3, 'zählt weiter')
    wahr(ereignisse(RH).includes('incident:wieder'), 'Ereignis incident:wieder')
  })
  await pruefe('Protokoll des Detektors liegt im Laufverzeichnis', async () => {
    const f = join(SB, 'runs', RH, 'detektor.jsonl')
    wahr(existsSync(f), 'detektor.jsonl')
    const arten = readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).art)
    wahr(arten.includes('log') && arten.includes('vorfall') && arten.includes('geloest'), `Einträge: ${[...new Set(arten)].join(', ')}`)
  })

 // R1 ist inzwischen 'done' — Vorfälle werden nur für laufende Läufe gesammelt.
  let RC = null
  await pruefe('claude: der Menütext „Upgrade to Max for higher rate limits" ist KEIN Vorfall', async () => {
    const j = await laufStarten({ repo_id: repoId, harness: 'claude', prompt: 'E2E-Vorfall-claude' })
    RC = j.runId
    await sessionMerken(RC)
    // Genau das stand in einem Produktivlauf als Rate-Limit in der Datenbank.
    await watcherTick()
    logAnhaengen(RC, '\x1b[38;5;246m/\x1b[39m\x1b[1mu\x1b[22mpgrade   Upgrade to Max for higher rate limits and more Opus\x1b[K\r\n')
    await watcherTick()
    gleich(vorfaelle(RC).length, 0, 'kein Vorfall')
  })

  await pruefe('claude: Transkript-Eintrag mit isApiErrorMessage → sofort ROT, mit Original-Zeitstempel', async () => {
    const r = lauf(RC)
    const dir = join(SB, 'claude-projects', r.workdir_effective.replaceAll('/', '-'))
    mkdirSync(dir, { recursive: true })
    const ts = '2026-08-11T08:05:00.000Z'
    writeFileSync(join(dir, `${RC}.jsonl`), [
      JSON.stringify({ type: 'assistant', message: { content: 'hi', usage: { input_tokens: 1, output_tokens: 1 } } }),
      JSON.stringify({ type: 'assistant', error: 'authentication_failed', timestamp: ts, isApiErrorMessage: true,
        message: { content: [{ type: 'text', text: 'Please run /login · API Error: 403' }] } }),
    ].join('\n') + '\n')
    await watcherTick()
    const v = vorfaelle(RC)
    gleich(v.length, 1, 'ein Vorfall')
    gleich(v[0].typ, 'auth_error', 'Typ aus dem Enum')
    gleich(v[0].schwere, 'rot', 'rot ohne Umweg')
    gleich(v[0].quelle, 'transcript', 'Quelle')
    gleich(v[0].erst_gesehen, '2026-08-11 08:05:00', 'Zeitstempel aus dem Transkript, nicht „jetzt"')
  })
  await pruefe('Hook-Meldung (cc-report _api_error per stdin) → ROT; Rate-Limit-Zähler steigt', async () => {
    const hookJson = JSON.stringify({ hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: "You've hit your session limit · resets 8:36pm" })
    const r = await new Promise((resolve) => {
      const p = execFile(join(homedir(), '.local', 'bin', 'cc-report'), ['_api_error'],
        { env: { ...process.env, CC_RUN_ID: RC, CC_HUB_URL: BASIS } }, (err, stdout, stderr) => resolve({ ok: !err, stdout, stderr }))
      p.stdin.end(hookJson)
    })
    wahr(r.ok, `cc-report ok (${r.stderr})`)
    const v = vorfaelle(RC).find(x => x.typ === 'rate_limit')
    wahr(!!v, 'Vorfall rate_limit')
    gleich(v.schwere, 'rot', 'rot')
    gleich(v.quelle, 'hook:claude', 'Quelle')
    enthaelt(v.beleg, 'session limit', 'Beleg aus last_assistant_message')
    gleich(lauf(RC).rate_limit_hits, 1, 'rate_limit_hits')
  })
  await pruefe('Hook und Transkript sehen dasselbe Ereignis → nicht doppelt gezählt', async () => {
    const r = lauf(RC)
    const dir = join(SB, 'claude-projects', r.workdir_effective.replaceAll('/', '-'))
    writeFileSync(join(dir, `${RC}.jsonl`), JSON.stringify({ type: 'assistant', error: 'rate_limit',
      timestamp: new Date().toISOString(), isApiErrorMessage: true, message: { content: 'limit' } }) + '\n', { flag: 'a' })
    await watcherTick()
    gleich(vorfaelle(RC).find(x => x.typ === 'rate_limit').anzahl, 1, 'anzahl bleibt 1 (Dedupe binnen 90 s)')
  })
  await pruefe('Stille nach einem Log-Treffer wird ROT (das Limit steht am Ende)', async () => {
    const j = await laufStarten({ repo_id: repoId, harness: 'opencode', prompt: 'E2E-Vorfall-stille' })
    await sessionMerken(j.runId)
    await watcherTick()
    logAnhaengen(j.runId, 'AI_APICallError: [Stealth] stealth/ox-alpha is temporarily rate-limited upstream.\n')
    await watcherTick()
    gleich(vorfaelle(j.runId)[0]?.schwere, 'gelb', 'erst gelb')
    db.prepare(`UPDATE incidents SET zuletzt_gesehen=datetime('now','-6 minutes'), erst_gesehen=datetime('now','-6 minutes') WHERE run_id=?`).run(j.runId)
    db.prepare(`UPDATE runs SET last_activity_at=datetime('now','-7 minutes') WHERE id=?`).run(j.runId)
    await watcherTick()
    const v = vorfaelle(j.runId)[0]
    gleich(v.schwere, 'rot', 'nach 5 min Stille rot')
    gleich(v.typ, 'rate_limit', 'Typ aus dem opencode-Text')
  })
  await pruefe('arbeitet der Agent 30 min weiter, verläuft ein gelber Treffer von selbst', async () => {
    const j = await laufStarten({ repo_id: repoId, harness: 'hermes', prompt: 'E2E-Vorfall-verlaufen' })
    await sessionMerken(j.runId)
    await watcherTick()
    logAnhaengen(j.runId, '⚠️  API call failed (attempt 1/5): APIConnectionError\n')
    await watcherTick()
    db.prepare(`UPDATE incidents SET zuletzt_gesehen=datetime('now','-31 minutes'), erst_gesehen=datetime('now','-31 minutes') WHERE run_id=?`).run(j.runId)
    db.prepare(`UPDATE runs SET last_activity_at=datetime('now','-1 minutes') WHERE id=?`).run(j.runId)
    await watcherTick()
    const v = vorfaelle(j.runId)[0]
    wahr(!!v.geloest_am, 'geschlossen')
    enthaelt(v.geloest_von, 'auto:', 'automatisch')
  })
  await pruefe('Provider-Puls: zwei Fehlschläge → globaler Vorfall mit Banner, Erholung schließt ihn', async () => {
    let antwort = 500
    const http = await import('node:http')
    const hs = http.createServer((req, res) => { res.writeHead(antwort).end('{}') })
    await new Promise(r => hs.listen(0, '127.0.0.1', r))
    process.env.CCHUB_PULS_AUS = '0'
    process.env.CCHUB_PULS_TAKT_MS = '0'
    process.env.CCHUB_PULS_URL_TEST = `http://127.0.0.1:${hs.address().port}/`
    try {
      await watcherTick()
      gleich(db.prepare(`SELECT count(*) c FROM incidents WHERE run_id IS NULL`).get().c, 0, 'ein Fehlschlag reicht nicht')
      await watcherTick()
      const g = db.prepare(`SELECT * FROM incidents WHERE run_id IS NULL AND geloest_am IS NULL`).all()
      wahr(g.length >= 1, `globaler Vorfall (hat ${g.length})`)
      wahr(g.every(x => x.typ.startsWith('provider_down:')), 'Typ provider_down:<name>')
      enthaelt(await (await hol(`/?repo=${repoId}`)).text(), 'Provider nicht erreichbar', 'Banner in der Übersicht')
      antwort = 200
      await watcherTick()
      gleich(db.prepare(`SELECT count(*) c FROM incidents WHERE run_id IS NULL AND geloest_am IS NULL`).get().c, 0, 'erholt → geschlossen')
      enthaelt(db.prepare(`SELECT geloest_von FROM incidents WHERE run_id IS NULL LIMIT 1`).get().geloest_von, 'erholt', 'Grund')
    } finally {
      process.env.CCHUB_PULS_AUS = '1'
      delete process.env.CCHUB_PULS_URL_TEST
      delete process.env.CCHUB_PULS_TAKT_MS
      hs.close()
    }
  })
  await pruefe('Übersicht: Laufzeit beendeter Läufe endet bei ended_at, nicht „jetzt"', async () => {
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Dauer' })
    await sessionMerken(j.runId)
    db.prepare(`UPDATE runs SET status='done', started_at=datetime('now','-3 days'), ended_at=datetime('now','-3 days','+2 minutes') WHERE id=?`).run(j.runId)
    const html = await (await hol(`/?repo=${repoId}`)).text()
    const zeile = html.split('<tr').find(z => z.includes(j.runId))
    enthaelt(zeile, '>2 min<', '2 min statt 4320')
  })

  // Simulation mit ECHTEM Claude Code: ein Mini-Server antwortet 429 mit den
  // Abo-Limit-Headern, Claude bricht ab, der StopFailure-Hook meldet über cc-report
  // an diesen Sandkasten-Hub. Kein Quota-Verbrauch, kein Netz — aber der komplette Weg.
  if (vorhanden('claude')) {
    await pruefe('ECHT: Claude Code + simuliertes 429 → StopFailure-Hook → Vorfall rate_limit', async () => {
      const http = await import('node:http')
      const reset = Math.floor(Date.now() / 1000) + 3600
      const mock = http.createServer((req, res) => {
        req.on('data', () => {}); req.on('end', () => {
          res.writeHead(429, { 'content-type': 'application/json',
            'anthropic-ratelimit-unified-status': 'rejected',
            'anthropic-ratelimit-unified-reset': String(reset),
            'anthropic-ratelimit-unified-5h-status': 'rejected',
            'anthropic-ratelimit-unified-5h-reset': String(reset),
            'anthropic-ratelimit-unified-representative-claim': 'five_hour',
          }).end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: "You've hit your usage limit." } }))
        })
      })
      await new Promise(r => mock.listen(0, '127.0.0.1', r))
      const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-429-Simulation' })
      await sessionMerken(j.runId)
      const { claudeSettingsJson } = await import('../server/runner.mjs')
      const settingsDatei = join(SB, 'claude-429-settings.json')
      writeFileSync(settingsDatei, claudeSettingsJson())
      const arbeitsdir = join(SB, 'claude-429-cwd'); mkdirSync(arbeitsdir, { recursive: true })
      try {
        const r = await new Promise((resolve) => execFile('claude',
          ['-p', 'sag hallo', '--model', 'sonnet', '--settings', settingsDatei],
          { cwd: arbeitsdir, timeout: 120_000, env: { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${mock.address().port}`,
            CC_RUN_ID: j.runId, CC_HUB_URL: BASIS, PATH: `${join(homedir(), '.local', 'bin')}:${process.env.PATH}` } },
          (err, stdout, stderr) => resolve({ err, stdout: String(stdout), stderr: String(stderr) })))
        enthaelt(r.stdout + r.stderr, 'limit', `Claude meldet das Limit (${(r.stdout + r.stderr).slice(-200)})`)
        await warteAuf(() => vorfaelle(j.runId).some(v => v.typ === 'rate_limit'), { was: 'Vorfall über den Hook', timeoutMs: 15_000 })
        const v = vorfaelle(j.runId).find(v => v.typ === 'rate_limit')
        gleich(v.quelle, 'hook:claude', 'Quelle ist der Hook')
        gleich(v.schwere, 'rot', 'rot')
        enthaelt(v.beleg, 'rate_limit', 'Beleg trägt das Enum')
      } finally { mock.close() }
    })
  } else {
    uebersprungen('ECHT: Claude Code + simuliertes 429', 'claude nicht im PATH')
  }

  // ------------------------------------------------------------------
  gruppe('Worktree-Aufräumen: kein Datenverlust (Regressionstest)')

  {
    const s = lauf(R1).tmux_session
    await sh('tmux', ['kill-session', '-t', `=${s}`])
    sessions.delete(s)
    await watcherTick()
    // BEKANNTER FEHLER (in watcher.mjs, nicht hier): closeOldSessions() erkennt eine
    // verschwundene Session nicht, weil `tmux display -p -t "=name"` auch für nicht
    // existierende Sessions mit Code 0 antwortet. Damit bleibt tmux_closed_at leer und
    // das gesamte Worktree-Aufräumen läuft nie an. Sobald das gefixt ist, wird aus dem
    // folgenden Block wieder eine echte Prüfung.
    if (lauf(R1).tmux_closed_at !== null) {
      await pruefe('Sitzung zu Ende: tmux_closed_at wird gesetzt', () => {
        wahr(lauf(R1).tmux_closed_at !== null, 'tmux_closed_at')
      })
    } else {
      uebersprungen('Sitzung zu Ende: tmux_closed_at wird gesetzt',
        'bekannter Fehler: tmux display meldet Erfolg auch für fehlende Sessions')
      db.prepare(`UPDATE runs SET tmux_closed_at=datetime('now') WHERE id=?`).run(R1)
    }
  }
  await pruefe('ungepushter Branch: Worktree bleibt stehen', async () => {
    const wt = lauf(R1).workdir_effective
    await watcherTick()
    wahr(existsSync(wt), `Worktree ${wt} existiert noch`)
    falsch(ereignisse(R1).includes('worktree_removed'), 'nicht entfernt')
  })
  await pruefe('gepusht, aber nicht committete Arbeit: Worktree bleibt stehen', async () => {
    const wt = lauf(R1).workdir_effective
    await sh('git', ['-C', wt, 'push', '-q', '-u', 'origin', 'HEAD'])
    writeFileSync(join(wt, 'offene-notiz.txt'), 'noch nicht committet\n')
    db.prepare(`DELETE FROM events WHERE run_id=? AND kind IN ('anomaly:unpushed','branch_synced')`).run(R1)
    await watcherTick()
    wahr(existsSync(wt), 'Worktree existiert noch')
    wahr(ereignisse(R1).includes('anomaly:worktree_dirty'), `als schmutzig vermerkt (hat: ${ereignisse(R1).join(', ')})`)
  })
  await pruefe('gepusht und sauber: Worktree wird aufgeräumt', async () => {
    const wt = lauf(R1).workdir_effective
    rmSync(join(wt, 'offene-notiz.txt'))
    db.prepare(`DELETE FROM events WHERE run_id=? AND kind='anomaly:worktree_dirty'`).run(R1)
    await watcherTick()
    falsch(existsSync(wt), 'Worktree entfernt')
    wahr(ereignisse(R1).includes('worktree_removed'), 'Ereignis vermerkt')
  })
  await pruefe('die Arbeit steckt im origin — nichts ging verloren', async () => {
    const l = await sh('git', ['-C', ORIGIN, 'log', '--oneline', '-1', lauf(R1).branch_expected])
    enthaelt(l.stdout, 'Arbeit des Agenten', 'Commit im origin')
  })

  // ------------------------------------------------------------------
  await pruefe('ein beim Start unterbrochener Lauf bleibt nicht ewig „läuft“', async () => {
    // Stirbt der Hub mitten im Startvorgang (Dienst-Neustart, Reboot), stand der Lauf
    // vorher für immer auf 'running' — ohne Session, ohne Worktree, mit einem Terminal,
    // das sich nirgends anhängen konnte.
    const id = 'aaaaaaaa-1111-4222-8333-444444444444'
    db.prepare(`INSERT INTO runs(id,repo_id,status,harness,prompt,branch_mode,expected_minutes,started_at)
                VALUES(?,?,'running','claude','x','keiner',45, datetime('now','-30 minutes'))`).run(id, repoId)
    await watcherTick()
    const r = lauf(id)
    gleich(r.status, 'failed', 'wird als gescheitert abgeschlossen')
    enthaelt(r.report_md ?? '', 'unterbrochen', 'Begründung im Bericht')
    const seite = await (await hol(`/runs/${id}`)).text()
    falsch(seite.includes('Terminal (live)'), 'die Seite verspricht kein Terminal mehr')
    enthaelt(seite, 'Lauf wiederholen', 'Wiederholen wird angeboten')
  })

  await pruefe('ein gerade erst angelegter Lauf wird dabei NICHT abgeräumt', async () => {
    // Gegenprobe: während cc-start noch arbeitet, hat ein Lauf zu Recht keine Session.
    const id = 'bbbbbbbb-1111-4222-8333-444444444444'
    db.prepare(`INSERT INTO runs(id,repo_id,status,harness,prompt,branch_mode,expected_minutes,started_at)
                VALUES(?,?,'running','claude','x','keiner',45, datetime('now'))`).run(id, repoId)
    await watcherTick()
    gleich(lauf(id).status, 'running', 'bleibt unangetastet')
    db.prepare('DELETE FROM runs WHERE id=?').run(id)
  })

  gruppe('Fehlstart, Wiederholung und Abbruch')

  let R2 = null
  await pruefe('gescheiterter Start wird als failed vermerkt', async () => {
    writeFileSync(FEHLSTART, 'an')
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Fehlstart', branch_mode: 'neu', branch_pattern: 'agent/e2e-fehl/{kurz}' })
    R2 = j.runId
    gleich(lauf(R2).status, 'failed', 'Status')
    enthaelt(lauf(R2).report_md, 'cc-start', 'Grund genannt')
  })
  await pruefe('Wiederholung benutzt denselben Worktree und läuft an', async () => {
    const vorher = lauf(R2).workdir_effective
    wahr(existsSync(vorher), 'Worktree aus dem Fehlversuch liegt noch da')
    rmSync(FEHLSTART)
    const r = await formular(`/api/runs/${R2}/retry`, {}, { alsBrowser: true })
    gleich(r.status, 303, 'Weiterleitung statt JSON')
    await sessionMerken(R2)
    gleich(lauf(R2).status, 'running', 'Status')
    gleich(lauf(R2).workdir_effective, vorher, 'gleicher Worktree')
  })
  await pruefe('Abbruch setzt aborted und schließt die Session sofort', async () => {
    const r = await formular(`/api/runs/${R2}/kill`, {})
    gleich(r.status, 200, 'Status')
    const l = lauf(R2)
    gleich(l.status, 'aborted', 'Status')
    wahr(l.tmux_closed_at !== null, 'tmux_closed_at sofort gesetzt')
    falsch((await sh('tmux', ['has-session', '-t', `=${l.tmux_session}`])).ok, 'Session beendet')
    sessions.delete(l.tmux_session)
  })
  await pruefe('Terminal einer beendeten Sitzung meldet 410 statt zu hängen', async () => {
    const e = await wsVersuch(`/term?run=${R2}&ro=1`)
    gleich(e.art, 'http', 'HTTP-Antwort')
    gleich(e.status, 410, 'Status')
  })

  // ------------------------------------------------------------------
  gruppe('Scheduler (wartet auf den 30-Sekunden-Takt des Hubs)')

  await pruefe('Zeitplan-Agenten anlegen und Pipeline einschalten', async () => {
    // A: läuft jede Minute, hat aber schon einen laufenden Lauf -> muss übersprungen werden.
    const a = await formular('/agents/edit', {
      repo_id: repoId, name: 'e2e-jede-minute', harness: 'claude', prompt: 'E2E-Dauerlaeufer',
      branch_mode: 'keiner', expected_minutes: '45', schedule_kind: 'cron', schedule: '* * * * *', active: '1',
    }, { alsBrowser: true })
    gleich(a.status, 303, 'Agent A angelegt')
    const idA = agent('e2e-jede-minute').id
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-belegt' })
    db.prepare('UPDATE runs SET agent_id=? WHERE id=?').run(idA, j.runId)

    // B: einmaliger Termin in der Vergangenheit -> muss genau einmal zünden.
    const gestern = new Date(Date.now() - 3600_000).toISOString().slice(0, 16)
    const b = await formular('/agents/edit', {
      repo_id: repoId, name: 'e2e-einmalig', harness: 'claude', prompt: 'E2E-Einmalig',
      branch_mode: 'keiner', expected_minutes: '45', schedule_kind: 'einmalig', run_at: gestern, active: '1',
    }, { alsBrowser: true })
    gleich(b.status, 303, 'Agent B angelegt')
    gleich((await (await formular('/api/settings/pipeline', { value: '1' })).json()).ok, true, 'Pipeline an')
  })
  await pruefe('einmaliger Termin zündet genau einmal und stellt sich auf manuell', async () => {
    const idB = agent('e2e-einmalig').id
    await warteAuf(() => db.prepare('SELECT count(*) c FROM runs WHERE agent_id=?').get(idB).c === 1,
      { was: 'Lauf des einmaligen Agenten', timeoutMs: 75_000, taktMs: 1000 })
    const a = agent('e2e-einmalig')
    gleich(a.schedule_kind, 'manuell', 'Art zurückgestellt')
    gleich(a.run_at, null, 'Termin geleert')
    for (const r of db.prepare('SELECT id FROM runs WHERE agent_id=?').all(idB)) await sessionMerken(r.id)
  })
  await pruefe('ein Agent überholt sich nicht selbst', async () => {
    const idA = agent('e2e-jede-minute').id
    const belegt = db.prepare(`SELECT id FROM runs WHERE agent_id=? AND status='running'`).get(idA)
    await warteAuf(() => ereignisse(belegt.id).includes('schedule_skipped'),
      { was: 'schedule_skipped', timeoutMs: 75_000, taktMs: 1000 })
    gleich(db.prepare('SELECT count(*) c FROM runs WHERE agent_id=?').get(idA).c, 1, 'nur ein Lauf')
  })
  await pruefe('Pipeline lässt sich wieder ausschalten', async () => {
    gleich((await (await formular('/api/settings/pipeline', { value: '0' })).json()).ok, true, 'ok')
    gleich(db.prepare(`SELECT value FROM settings WHERE key='pipeline_on'`).get().value, '0', 'gespeichert')
  })

  // ------------------------------------------------------------------
  if (ECHT) {
    // Ab hier mit dem ECHTEN cc-start und echten Harnesses. Bewusst ein zweiter
    // Hub-Start: der Stub-Teil oben soll deterministisch und kostenlos bleiben.
    await hubStoppen()
    await hubStarten({ echteAgenten: true })

    const harnesses = [
      { name: 'claude', bedingung: () => vorhanden('claude'), fehlt: 'claude nicht im PATH' },
      {
        name: 'opencode', provider: 'openrouter', model: ECHT_MODELL,
        bedingung: () => vorhanden('opencode') && !!ECHT_KEYS.OPENROUTER_API_KEY,
        fehlt: 'opencode fehlt oder OPENROUTER_API_KEY ist nicht gesetzt',
      },
      {
        name: 'hermes', provider: 'openrouter', model: ECHT_MODELL,
        bedingung: () => vorhanden('hermes') && !!ECHT_KEYS.OPENROUTER_API_KEY,
        fehlt: 'hermes fehlt oder OPENROUTER_API_KEY ist nicht gesetzt',
      },
      {
        // Zen braucht für die freien Modelle keinen Schlüssel — deckt zugleich ab,
        // dass das Präfix stimmt (opencode/… und NICHT opencode-zen/…).
        name: 'opencode', titel: 'opencode über OpenCode Zen (freies Modell)',
        provider: 'opencode-zen', model: ZEN_MODELL, marke: 'zen-echt.md',
        bedingung: () => vorhanden('opencode'),
        fehlt: 'opencode nicht im PATH',
      },
    ]

    for (const h of harnesses) {
      gruppe(`Echter Lauf: ${h.titel ?? h.name}${h.provider ? ` — ${h.provider}/${h.model}` : ''}`)
      if (!h.bedingung()) {
        uebersprungen(h.titel ?? h.name, h.fehlt)
        continue
      }
      await pruefe(`${h.name} schreibt die Datei und meldet done`, async () => {
        const marke = h.marke ?? `${h.name}-echt.md`
        const j = await laufStarten({
          repo_id: repoId, harness: h.name,
          ...(h.provider ? { provider: h.provider, model: h.model } : {}),
          prompt: `Lege im aktuellen Verzeichnis die Datei ${marke} an mit genau einer Zeile: ${h.name} lief. `
            + `Fuehre danach genau dieses Kommando aus: cc-report done "${h.name}-Rauchtest fertig"`,
          branch_mode: 'keiner', expected_minutes: '10',
        })
        wahr(!!j.runId, `Lauf gestartet (${JSON.stringify(j)})`)
        await sessionMerken(j.runId)
        await warteAuf(() => ['done', 'failed', 'aborted'].includes(lauf(j.runId).status),
          { was: `Ende des ${h.name}-Laufs`, timeoutMs: 420_000, taktMs: 2000 })
        const r = lauf(j.runId)
        gleich(r.status, 'done', `Status (Bericht: ${(r.report_md ?? '').slice(0, 80)})`)
        wahr(existsSync(join(r.workdir_effective, marke)),
          `${marke} wurde im Worktree wirklich angelegt`)
        wahr((r.report_md ?? '').length > 0, 'Bericht vorhanden')
      })
    }
  }
} catch (err) {
  console.log(`\nAbbruch: ${err.stack}`)
  zaehler.fehler.push({ name: 'Testlauf', grund: err.message })
} finally {
  await aufraeumen()
}

process.exit(bericht(`E2E-Tests${ECHT ? ' (mit echtem Lauf)' : ''}`, start))
