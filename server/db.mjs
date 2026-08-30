// Freilauf — SQLite via node:sqlite (zero dependencies; the fallback better-sqlite3
// would be API-compatible enough to swap out this wrapper).
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
// events.mjs imports nothing at all — deliberately, so that the module which
// everything writes through can be imported from anywhere without a cycle.
import { publish } from './events.mjs'
import { env } from './env.mjs'
import { dataDir, dbPath } from './paths.mjs'

const DATA_DIR = dataDir()
mkdirSync(DATA_DIR, { recursive: true })

// `dbPath()` answers both halves of the question at once: the directory may
// still be the one from before the rename, and inside it the file may still be
// called `cc-hub.db`. A database that exists is never left behind.
export const DB_PATH = dbPath()
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
  -- Unique per REPO, not per hub: two repos may each carry an agent called
  -- "nightly". The one-time migration in agentNameUniquePerRepo() rebuilds
  -- existing databases, which still carry the old global UNIQUE on name.
  name TEXT NOT NULL,
  -- No CHECK on the harness: coding agents are PLUGINS, and one may be loaded
  -- from disk after this file ran (see harnessCheckAufloesen() below).
  harness TEXT NOT NULL,
  model TEXT,
  prompt TEXT NOT NULL,
  branch_mode TEXT NOT NULL CHECK(branch_mode IN ('keiner','neu','fest')),
  branch_pattern TEXT,
  expected_minutes INTEGER NOT NULL DEFAULT 45,
  schedule TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(repo_id, name)
);
-- Favoriten: die SETUP-Hälfte einer Laufdefinition unter einem Namen (Coding Agent,
-- Provider, Modell, Effort, Extra-Skills, angehängte Flows). Bewusst OHNE Prompt,
-- Branch-Regel und Dauer — die gehören zur Aufgabe, nicht zur Einstellung.
-- Deliberately without a CHECK on harness: see harnessCheckAufloesen() below —
-- a CHECK rule would be a table rebuild for every new plugin, and since coding
-- agents can be loaded from disk it could not be written at schema time at all.
CREATE TABLE IF NOT EXISTS favorites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  harness TEXT NOT NULL,
  model TEXT,
  provider TEXT,
  or_provider TEXT,
  or_routing TEXT,
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
  wieder_geoeffnet INTEGER NOT NULL DEFAULT 0,
  notify_at TEXT,
  gemeldet_am TEXT
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
// OpenRouter serving-provider routing config (JSON): { mode:'auto', quant_min?,
// location?, max_in?, max_out? } — the pin's tag stays in or_provider, the auto
// config lives here and resolves to a provider order at start (scheduler.mjs).
addColumn('agents', 'or_routing', 'TEXT')
addColumn('runs', 'or_routing', 'TEXT')
addColumn('favorites', 'or_routing', 'TEXT')
// Reasoning effort per run. NULL = as before: the harness uses its own default.
addColumn('agents', 'effort', 'TEXT')
addColumn('runs', 'effort', 'TEXT')
// Extra skills (JSON list of folder names under ~/agents/zusaetze) — opt-in per
// agent/run, NEVER loaded automatically. The run carries the definition copy as usual.
addColumn('agents', 'skills', 'TEXT')
addColumn('runs', 'skills', 'TEXT')
// The goal: a SECOND prompt, part of the run definition (server/goal.mjs). Only
// coding agents whose plugin carries a `goal` spec know one — claude does, as
// `/goal <condition>`. 'goal_sent_at' is the run's own bookkeeping: the command
// exists only inside the session, so it is typed in AFTER the start, and exactly
// once.
addColumn('agents', 'goal', 'TEXT')
addColumn('runs', 'goal', 'TEXT')
addColumn('runs', 'goal_sent_at', 'TEXT')
// Attached flows (JSON list of { flowId, when }) — part of the run definition,
// see server/flows/attach.mjs. The run carries the definition copy as usual, so
// editing an agent never changes what an already running run will trigger.
addColumn('agents', 'flows', 'TEXT')
// Keep the work on its branch instead of merging it into the base branch — only
// meaningful while the repo integrates (repos.merge_mode='hub'), stored either
// way, like every other field of the run definition.
addColumn('agents', 'keep_on_branch', 'INTEGER NOT NULL DEFAULT 0')
addColumn('runs', 'keep_on_branch', 'INTEGER NOT NULL DEFAULT 0')
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
// ---- integration: a run is done when its work is on the base branch ----
// Per repo, because a repo decides whether the hub integrates at all
// ('off' = exactly the behaviour before this existed).
addColumn('repos', 'merge_mode', `TEXT NOT NULL DEFAULT 'off'`)   // 'off' | 'hub'
addColumn('repos', 'merge_check', 'TEXT')                          // shell command, empty = none
addColumn('repos', 'finish_timeout_min', 'INTEGER NOT NULL DEFAULT 15')
addColumn('repos', 'merge_max_attempts', 'INTEGER NOT NULL DEFAULT 2')
addColumn('repos', 'conflict_parallel', 'INTEGER NOT NULL DEFAULT 1')
addColumn('repos', 'notify_running', 'INTEGER NOT NULL DEFAULT 1')
addColumn('repos', 'max_parallel', 'INTEGER NOT NULL DEFAULT 0')   // 0 = unlimited
// When the hub last pushed the operator's own base-branch commits to origin.
// The remote is the backup: nothing may exist only on this machine.
addColumn('repos', 'last_push_at', 'TEXT')
// Per run: where it started from, where it stands in the finish gate, and what
// became of its commits. finish_state is a SUB-state of 'running' on purpose —
// runs.status carries a CHECK, and a new value there would be a table rebuild
// (see tabelleUmziehen); besides, the run really is still running: its
// terminal is writable, messages reach it, a human can step in.
addColumn('runs', 'base_sha', 'TEXT')            // HEAD of the worktree right after creation
addColumn('runs', 'finish_state', 'TEXT')        // NULL|checking|awaiting_commit|awaiting_merge|merging|check_failed
addColumn('runs', 'finish_started_at', 'TEXT')
addColumn('runs', 'merge_status', 'TEXT')
addColumn('runs', 'merged_sha', 'TEXT')
addColumn('runs', 'merged_at', 'TEXT')
addColumn('runs', 'merge_attempts', 'INTEGER NOT NULL DEFAULT 0')
addColumn('runs', 'resolver_run_id', 'TEXT')     // the conflict run working for this run
addColumn('runs', 'resolves_run_id', 'TEXT')     // set on a conflict run: the run it works for
// ---- follow-up reports: a finished run can report again ----
// After `done` the coding agent is still sitting in its session, and the
// operator often types more work into it. `fl-report done` from a finished run
// is a FOLLOW-UP report (server/reports.mjs, handleFollowUp): same finish gate,
// same integration, same flows — announced as "FOLLOW-UP REPORT #n".
addColumn('runs', 'followups', 'INTEGER NOT NULL DEFAULT 0')      // follow-up reports accepted so far
addColumn('runs', 'followup_md', 'TEXT')                           // the latest follow-up's own text
addColumn('runs', 'followup_open', 'INTEGER NOT NULL DEFAULT 0')  // 1 while a follow-up is in the gate / being merged
// Notifications per run: the checkbox under the terminal. 0 silences every
// message ABOUT this run (reports, alarms, incidents), on every configured
// channel — nothing else changes: the integration, the flows and the events
// happen exactly as before. The column keeps its original name: renaming one
// means rebuilding the table, and a stored name is not worth a migration (the
// same rule that leaves `openrouter_min_eur` holding dollars).
addColumn('runs', 'telegram_on', 'INTEGER NOT NULL DEFAULT 1')
// Incidents: the delayed notification (notify_at = when the grace period ends and the
// alarm becomes due) and whether it was EVER announced (gemeldet_am) — the latter
// decides whether an auto-resolve also announces the recovery (server/incidents.mjs).
addColumn('incidents', 'notify_at', 'TEXT')
addColumn('incidents', 'gemeldet_am', 'TEXT')
/**
 * Drop the CHECK rule on `agents.harness` — once, idempotently.
 *
 * WHY: that CHECK was generated from the harness plugin registry, so db.mjs had
 * to `import { harnessIds }` from it. THAT import is the cycle which made
 * dynamic plugin loading impossible: a plugin loaded from disk arrives long
 * after this file ran, plugins were forbidden to import db.mjs (they would
 * close the cycle), quota.mjs needed a dynamic import to get at a harness, and
 * the budget gate could not go through the aggregators. A coding agent that is
 * only known at runtime cannot be written into a constraint that is written at
 * schema time — so the constraint goes.
 *
 * Nothing is lost by that: which harness is acceptable was NEVER decided by the
 * database. `runDefFromForm()`, `saveAgent()`, `createRun()` and
 * `saveCodingAgent()` all validate against the registry and always did; the
 * CHECK only ever turned a bug into a 500 one layer further down. `runs.harness`
 * has carried no CHECK for exactly this reason since the beginning.
 *
 * The new table header is NOT typed in here but fetched from sqlite_master and
 * edited at that one spot: this guarantees that all retrofitted columns, their
 * defaults and the UNIQUE survive. Copying is done column-wise by name, so the
 * order does not matter.
 */
function harnessCheckAufloesen() {
  const sql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='agents'`).get()?.sql
  if (!sql) return
  if (!/CHECK\s*\(\s*harness\b/i.test(sql)) return   // fresh database, or already resolved
  const m = sql.match(/,?\s*CHECK\s*\(\s*harness\s+IN\s*\([^)]*\)\s*\)/i)
  if (!m) {
    // Unexpected shape: better touch nothing than rebuild a table blindly.
    console.warn('[db] agents.harness: CHECK rule not recognized — no rebuild')
    return
  }
  // The clause sits inline behind the column type ("harness TEXT NOT NULL
  // CHECK(...)"), so removing it leaves a valid column definition; a leading
  // comma is only swallowed when the match really started with one.
  const neuSql = sql
    .replace(m[0], m[0].trimStart().startsWith(',') ? ',' : '')
    .replace(/CREATE TABLE (IF NOT EXISTS )?["'`]?agents["'`]?/i, 'CREATE TABLE agents_neu')

  tabelleUmziehen(neuSql)
  console.log('[db] agents.harness: CHECK removed — coding agents are plugins now')
}

/**
 * The table-rebuild dance both migrations below share. PRAGMA foreign_keys has
 * no effect inside a transaction — set it beforehand. runs.agent_id points to
 * agents(id); without turning it off, the DROP trips over that. Copying goes
 * column-wise by NAME from the live table, so the column order does not matter.
 */
function tabelleUmziehen(neuSql) {
  db.exec('PRAGMA foreign_keys = OFF')
  try {
    db.exec('BEGIN')
    db.exec(neuSql)
    const spalten = db.prepare(`PRAGMA table_info(agents)`).all().map(c => `"${c.name}"`).join(',')
    db.exec(`INSERT INTO agents_neu(${spalten}) SELECT ${spalten} FROM agents`)
    db.exec('DROP TABLE agents')
    db.exec('ALTER TABLE agents_neu RENAME TO agents')
    db.exec('COMMIT')
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* already rolled back */ }
    throw err
  } finally {
    db.exec('PRAGMA foreign_keys = ON')
  }
}

/**
 * Agent names are unique per REPO, not per hub (the CREATE TABLE above carries
 * UNIQUE(repo_id, name)); databases created before that change still hold a
 * column-level UNIQUE on name. SQLite cannot drop such a UNIQUE — so rebuild
 * once, with the same care as harnessCheckAufloesen(). Idempotent: a fresh
 * database already has the new rule and nothing happens.
 */
function agentNameUniquePerRepo() {
  const sql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='agents'`).get()?.sql
  if (!sql) return
  if (/UNIQUE\s*\(\s*repo_id\s*,\s*name\s*\)/i.test(sql)) return   // already per-repo
  const columnLevel = /name\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(sql)
  const tableLevel = /UNIQUE\s*\(\s*name\s*\)/i.test(sql)
  if (!columnLevel && !tableLevel) {
    // Unexpected shape: better touch nothing than rebuild a table blindly.
    console.warn('[db] agents.name: UNIQUE rule not recognized — no rebuild')
    return
  }
  let neu = sql
    .replace(/name\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i, 'name TEXT NOT NULL')
    .replace(/UNIQUE\s*\(\s*name\s*\)/i, 'UNIQUE(repo_id, name)')
  // The column-level case leaves no table-level constraint behind — add one
  // in front of the closing parenthesis (keeping any trailing semicolon).
  if (!/UNIQUE\s*\(\s*repo_id\s*,\s*name\s*\)/i.test(neu)) {
    neu = neu.replace(/\)(\s*;?\s*)$/, ', UNIQUE(repo_id, name))$1')
  }
  neu = neu.replace(/CREATE TABLE (IF NOT EXISTS )?["'`]?agents["'`]?/i, 'CREATE TABLE agents_neu')

  tabelleUmziehen(neu)
  console.log('[db] agents.name: UNIQUE rebuilt per repo (repo_id, name)')
}
harnessCheckAufloesen()
agentNameUniquePerRepo()

// Existing agents with a cron expression keep their behavior.
db.exec(`UPDATE agents SET schedule_kind='cron'
         WHERE schedule_kind='manuell' AND schedule IS NOT NULL AND trim(schedule) <> ''`)

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
  return row ? row.value : fallback
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
  announceRun(runId, kind)
}

/**
 * Tell the live channel that a run changed.
 *
 * It hangs on addEvent() rather than on the 39 `UPDATE runs SET` sites because
 * a run's meaningful transitions are recorded as events — measured, not assumed:
 * of the 18 places that write `status=`, 13 already added an event and the five
 * that did not (kill by hand, answering a help call, retry, and the two flow
 * equivalents) were a gap in the event list itself. They add one now.
 *
 * The payload's `status` is a HINT, not the truth: whether the UPDATE runs
 * before or after the addEvent() differs per call site. That is harmless here
 * because the browser answers a signal by re-fetching the fragment, which the
 * server renders fresh — so there stays exactly one source for what a row says.
 *
 * Never throws: the live channel must not be able to break a database write.
 */
export function announceRun(runId, kind = 'changed') {
  try {
    const row = db.prepare('SELECT repo_id, status FROM runs WHERE id = ?').get(runId)
    if (row) publish('run', { runId, repoId: row.repo_id, status: row.status, kind })
  } catch { /* a silent live channel beats a failed write */ }
}

// The deduplicating variant, addEventOnce(), lives in reports.mjs — next to the
// anomaly handling every one of its callers belongs to.

export function getRepo(id) {
  const r = db.prepare('SELECT * FROM repos WHERE id = ?').get(id)
  if (r) r.extras = JSON.parse(r.worktree_extras || '[]')
  return r
}

export function getRun(id) { return db.prepare('SELECT * FROM runs WHERE id = ?').get(id) }

export default db
