// cc-hub — SQLite via node:sqlite (zero dependencies; the fallback better-sqlite3
// would be API-compatible enough to swap out this wrapper).
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { harnessIds } from './harnesses/index.mjs'

const DATA_DIR = process.env.CCHUB_DATA_DIR ?? join(homedir(), '.local', 'share', 'cc-hub')
mkdirSync(DATA_DIR, { recursive: true })

export const DB_PATH = join(DATA_DIR, 'cc-hub.db')
export const db = new DatabaseSync(DB_PATH)
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS repos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL,
  base_branch TEXT NOT NULL DEFAULT 'main',
  worktree_extras TEXT NOT NULL DEFAULT '[]',
  prompt TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  name TEXT NOT NULL UNIQUE,
  harness TEXT NOT NULL CHECK(harness IN (${harnessIds().map(id => `'${id}'`).join(',')})),
  model TEXT,
  prompt TEXT NOT NULL,
  branch_mode TEXT NOT NULL CHECK(branch_mode IN ('keiner','neu','fest')),
  branch_pattern TEXT,
  expected_minutes INTEGER NOT NULL DEFAULT 45,
  schedule TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Favoriten: die SETUP-Hälfte einer Laufdefinition unter einem Namen (Coding Agent,
-- Provider, Modell, Effort, Extra-Skills, angehängte Flows). Bewusst OHNE Prompt,
-- Branch-Regel und Dauer — die gehören zur Aufgabe, nicht zur Einstellung.
-- Bewusst auch ohne CHECK auf harness: siehe harnessCheckErweitern() weiter unten,
-- eine CHECK-Regel wäre bei jedem neuen Plugin ein Tabellen-Neubau.
CREATE TABLE IF NOT EXISTS favorites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  harness TEXT NOT NULL,
  model TEXT,
  provider TEXT,
  or_provider TEXT,
  effort TEXT,
  skills TEXT,
  flows TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  agent_id INTEGER REFERENCES agents(id),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK(status IN ('scheduled','deferred','running','waiting_help','done','failed','aborted')),
  -- Definitions-Kopie (der Lauf zeigt später, womit er WIRKLICH gestartet ist)
  harness TEXT NOT NULL,
  model TEXT,
  prompt TEXT NOT NULL,
  prompt_extra TEXT,
  branch_mode TEXT NOT NULL,
  branch_pattern TEXT,
  expected_minutes INTEGER NOT NULL,
  tmux_session TEXT,
  workdir_effective TEXT,
  worktree TEXT,
  branch_expected TEXT,
  branch_reported TEXT,
  branch_observed TEXT,
  pr_url TEXT,
  main_sha_start TEXT,
  exit_code INTEGER,
  report_md TEXT,
  help_text TEXT,
  help_answer TEXT,
  last_activity_at TEXT,
  quota5_start REAL, quota5_end REAL,
  quota7_start REAL, quota7_end REAL,
  cost_eur REAL, cost_usd REAL,
  tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0,
  rate_limit_hits INTEGER DEFAULT 0,
  tmux_closed_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  kind TEXT NOT NULL,
  payload TEXT
);
-- Vorfälle (Rate-Limit, Provider-Ausfall, Auth …): EIN Datensatz je (Lauf, Typ), der
-- offen ist, gelöst wird und bei erneutem Auftreten WIEDER aufgeht — wie ein Autoalarm.
-- events ist dafür ungeeignet: ein Append-Only-Log kennt keinen Zustand.
-- run_id NULL = globaler Vorfall (Provider-Puls), gehört zu keinem Lauf.
CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  typ TEXT NOT NULL,
  quelle TEXT NOT NULL,
  schwere TEXT NOT NULL DEFAULT 'rot' CHECK(schwere IN ('gelb','rot')),
  erst_gesehen TEXT NOT NULL DEFAULT (datetime('now')),
  zuletzt_gesehen TEXT NOT NULL DEFAULT (datetime('now')),
  anzahl INTEGER NOT NULL DEFAULT 1,
  beleg TEXT,
  geloest_am TEXT,
  geloest_von TEXT,
  wieder_geoeffnet INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_incidents_run ON incidents(run_id, geloest_am);
CREATE INDEX IF NOT EXISTS idx_runs_repo ON runs(repo_id, started_at);
CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, id);
`)

// ---- migrations: retrofit columns without recreating existing DBs ----
function addColumn(table, name, definition) {
  const have = db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === name)
  if (!have) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
}
// Schedules beyond cron (weekly with weekdays/time, every n weeks, one-off)
addColumn('agents', 'schedule_kind', `TEXT NOT NULL DEFAULT 'manuell'`)
addColumn('agents', 'schedule_days', 'TEXT')      // "1,2,5" — 0=Sun … 6=Sat
addColumn('agents', 'schedule_time', 'TEXT')      // "06:30"
addColumn('agents', 'schedule_weeks', 'INTEGER')  // 1 = every week, 2 = every second …
addColumn('agents', 'schedule_anchor', 'TEXT')    // "2026-08-23" start week for every-n-weeks
addColumn('agents', 'run_at', 'TEXT')             // "2026-08-24T06:30" for the one-off start
// Per-repo prompt: additional instructions given to EVERY run of this repo
// (agents and single runs alike), read at launch like base_branch/worktree_extras.
addColumn('repos', 'prompt', 'TEXT')
// Provider choice for opencode/hermes. NULL = as before: 'model' is then the complete,
// hand-typed string and goes to the harness unchanged — existing data stays untouched.
addColumn('agents', 'provider', 'TEXT')
addColumn('agents', 'or_provider', 'TEXT')   // fixed OpenRouter serving provider (tag)
addColumn('runs', 'provider', 'TEXT')
addColumn('runs', 'or_provider', 'TEXT')
// Reasoning effort per run. NULL = as before: the harness uses its own default.
addColumn('agents', 'effort', 'TEXT')
addColumn('runs', 'effort', 'TEXT')
// Extra skills (JSON list of folder names under ~/agents/zusaetze) — opt-in per
// agent/run, NEVER loaded automatically. The run carries the definition copy as usual.
addColumn('agents', 'skills', 'TEXT')
addColumn('runs', 'skills', 'TEXT')
// Attached flows (JSON list of { flowId, when }) — part of the run definition,
// see server/flows/attach.mjs. The run carries the definition copy as usual, so
// editing an agent never changes what an already running run will trigger.
addColumn('agents', 'flows', 'TEXT')
addColumn('runs', 'flows', 'TEXT')
// The run's title — what the overview and the detail page name it. An agent run
// takes the agent's name, a single run the operator's input or a title derived
// from the prompt (server/title.mjs). Editable per run at any time, WITHOUT
// touching the agent behind it.
addColumn('runs', 'title', 'TEXT')
// Planned start of a single run: 'at' waits for a point in time (UTC, SQLite
// format), 'idle' for the repo to have no other run going. NULL = start
// immediately, exactly as before.
addColumn('runs', 'start_mode', 'TEXT')
addColumn('runs', 'start_at', 'TEXT')
// Read positions of the detectors: only NEW bytes are scanned. Without the offset the
// same hit is counted again on every pass and an old hit "counts" forever.
addColumn('runs', 'log_offset', 'INTEGER NOT NULL DEFAULT 0')
addColumn('runs', 'transcript_offset', 'INTEGER NOT NULL DEFAULT 0')
// Archived: NULL = visible in the overview, set = hidden from it and only reachable
// under the Archive page. A run is moved there when it is over ('done'/'failed'/'aborted')
// and not needed at a glance any more — the record, its report and its log stay intact.
addColumn('runs', 'archived_at', 'TEXT')
// New harness in the CHECK rule of 'agents'. SQLite cannot change a CHECK (no ALTER
// for that), and 'CREATE TABLE IF NOT EXISTS' no longer takes effect on an existing
// database — the old rule would still be in place there and saving a cursor agent
// would run into a constraint error. So rebuild once.
//
// The new table header is NOT typed in here but fetched from sqlite_master and
// replaced only at that one spot: this guarantees that all retrofitted columns,
// their defaults and the UNIQUE on 'name' survive. Copying is done column-wise
// by name, so the order does not matter.
function harnessCheckErweitern() {
  const sql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='agents'`).get()?.sql
  if (!sql) return
  // Wanted: exactly the ids from the coding agent plugin registry. A new
  // harness therefore only needs its plugin file — the CHECK follows.
  const wanted = harnessIds()
  const m = sql.match(/harness IN \(([^)]*)\)/)
  if (!m) {
    // Unexpected shape: better touch nothing than rebuild a table blindly.
    console.warn('[db] agents.harness: CHECK rule not recognized — no rebuild')
    return
  }
  const have = [...m[1].matchAll(/'([^']*)'/g)].map(x => x[1])
  if (have.length === wanted.length && wanted.every(id => have.includes(id))) return   // already current
  const spalten = db.prepare(`PRAGMA table_info(agents)`).all().map(c => `"${c.name}"`).join(',')
  const neuSql = sql
    .replace(m[0], `harness IN (${wanted.map(id => `'${id}'`).join(',')})`)
    .replace(/CREATE TABLE (IF NOT EXISTS )?["'`]?agents["'`]?/i, 'CREATE TABLE agents_neu')

  // PRAGMA foreign_keys has no effect inside a transaction — set it beforehand.
  // runs.agent_id points to agents(id); without turning it off, the DROP trips over that.
  db.exec('PRAGMA foreign_keys = OFF')
  try {
    db.exec('BEGIN')
    db.exec(neuSql)
    db.exec(`INSERT INTO agents_neu(${spalten}) SELECT ${spalten} FROM agents`)
    db.exec('DROP TABLE agents')
    db.exec('ALTER TABLE agents_neu RENAME TO agents')
    db.exec('COMMIT')
    console.log(`[db] agents.harness: CHECK rebuilt for (${harnessIds().join(', ')})`)
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* already rolled back */ }
    throw err
  } finally {
    db.exec('PRAGMA foreign_keys = ON')
  }
}
harnessCheckErweitern()

// Existing agents with a cron expression keep their behavior.
db.exec(`UPDATE agents SET schedule_kind='cron'
         WHERE schedule_kind='manuell' AND schedule IS NOT NULL AND trim(schedule) <> ''`)

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
  return row ? row.value : fallback
}
export function getSettingInt(key, fallback) {
  const v = getSetting(key)
  const n = Number.parseInt(v ?? '', 10)
  return Number.isFinite(n) ? n : fallback
}
export function setSetting(key, value) {
  db.prepare(
    `INSERT INTO settings(key, value) VALUES(?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, String(value))
}
/**
 * "Most recently used" list behind a settings key (JSON, newest first). Both
 * OpenRouter models the hub picks — the check LLM and the title LLM — offer
 * what was used before instead of making you retype a slug; one implementation,
 * two keys.
 */
export function mruList(key, max = 10) {
  try { return JSON.parse(getSetting(key) || '[]').filter(Boolean).slice(0, max) } catch { return [] }
}
export function mruRemember(key, value, max = 10) {
  const v = String(value ?? '').trim()
  if (!v) return
  setSetting(key, JSON.stringify([v, ...mruList(key, max).filter(x => x !== v)].slice(0, max)))
}

export function allSettings() {
  const out = {}
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value
  return out
}

export function addEvent(runId, kind, payload = null) {
  db.prepare('INSERT INTO events(run_id, kind, payload) VALUES(?, ?, ?)')
    .run(runId, kind, payload === null ? null : JSON.stringify(payload))
}

/** Only create the event if this (run,kind) does not exist yet — Telegram/traffic light dedupe by themselves this way. */
export function addEventOnce(runId, kind, payload = null) {
  const have = db.prepare('SELECT 1 FROM events WHERE run_id = ? AND kind = ? LIMIT 1').get(runId, kind)
  if (!have) addEvent(runId, kind, payload)
}

export function getRepo(id) {
  const r = db.prepare('SELECT * FROM repos WHERE id = ?').get(id)
  if (r) r.extras = JSON.parse(r.worktree_extras || '[]')
  return r
}

export function getRun(id) { return db.prepare('SELECT * FROM runs WHERE id = ?').get(id) }

export default db
