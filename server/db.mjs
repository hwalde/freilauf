// cc-hub — SQLite via node:sqlite (Null Dependencies; Fallback better-sqlite3 wäre
// API-kompatibel genug, um diesen Wrapper auszutauschen).
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

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
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  name TEXT NOT NULL UNIQUE,
  harness TEXT NOT NULL CHECK(harness IN ('claude','opencode','hermes','cursor')),
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

// ---- Migrationen: Spalten nachrüsten, ohne bestehende DBs neu anzulegen ----
function addColumn(table, name, definition) {
  const have = db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === name)
  if (!have) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
}
// Zeitplan über Cron hinaus (wöchentlich mit Wochentagen/Uhrzeit, n-wöchentlich, einmalig)
addColumn('agents', 'schedule_kind', `TEXT NOT NULL DEFAULT 'manuell'`)
addColumn('agents', 'schedule_days', 'TEXT')      // "1,2,5" — 0=So … 6=Sa
addColumn('agents', 'schedule_time', 'TEXT')      // "06:30"
addColumn('agents', 'schedule_weeks', 'INTEGER')  // 1 = jede Woche, 2 = jede zweite …
addColumn('agents', 'schedule_anchor', 'TEXT')    // "2026-08-23" Startwoche für n-wöchentlich
addColumn('agents', 'run_at', 'TEXT')             // "2026-08-24T06:30" für den einmaligen Start
// Provider-Wahl für opencode/hermes. NULL = wie bisher: 'model' ist dann der komplette,
// selbst getippte String und geht unverändert an die Harness — Bestand bleibt unberührt.
addColumn('agents', 'provider', 'TEXT')
addColumn('agents', 'or_provider', 'TEXT')   // fester OpenRouter-Serving-Provider (tag)
addColumn('runs', 'provider', 'TEXT')
addColumn('runs', 'or_provider', 'TEXT')
// Denk-Aufwand pro Lauf. NULL = wie bisher: die Harness nimmt ihren eigenen Default.
addColumn('agents', 'effort', 'TEXT')
addColumn('runs', 'effort', 'TEXT')
// Zusatz-Skills (JSON-Liste von Ordnernamen unter ~/agents/zusaetze) — opt-in je
// Agent/Lauf, NIE automatisch geladen. Der Lauf trägt wie üblich die Definitions-Kopie.
addColumn('agents', 'skills', 'TEXT')
addColumn('runs', 'skills', 'TEXT')
// Lese-Positionen der Detektoren: nur NEUE Bytes werden gescannt. Ohne Offset zählt
// derselbe Treffer bei jedem Durchgang erneut und ein alter Treffer „gilt" ewig.
addColumn('runs', 'log_offset', 'INTEGER NOT NULL DEFAULT 0')
addColumn('runs', 'transcript_offset', 'INTEGER NOT NULL DEFAULT 0')
// Neue Harness in der CHECK-Regel von 'agents'. SQLite kann einen CHECK nicht ändern
// (kein ALTER dafür), und 'CREATE TABLE IF NOT EXISTS' greift bei einer bestehenden
// Datenbank nicht mehr — dort stünde weiter die alte Regel und das Speichern eines
// cursor-Agenten liefe in einen Constraint-Fehler. Also einmalig umbauen.
//
// Der neue Tabellenkopf wird NICHT hier eingetippt, sondern aus sqlite_master geholt
// und nur an der einen Stelle ersetzt: so bleiben alle nachgerüsteten Spalten, ihre
// Defaults und das UNIQUE auf 'name' garantiert erhalten. Kopiert wird spaltenweise
// nach Namen, damit die Reihenfolge egal ist.
function harnessCheckErweitern() {
  const sql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='agents'`).get()?.sql
  if (!sql || sql.includes("'cursor'")) return          // frisch angelegt oder schon umgebaut
  const alt = "harness IN ('claude','opencode','hermes')"
  if (!sql.includes(alt)) {
    // Unerwartete Form: lieber nichts anfassen als eine Tabelle blind neu bauen.
    console.warn('[db] agents.harness: CHECK-Regel nicht wiedererkannt — kein Umbau')
    return
  }
  const spalten = db.prepare(`PRAGMA table_info(agents)`).all().map(c => `"${c.name}"`).join(',')
  const neuSql = sql
    .replace(alt, "harness IN ('claude','opencode','hermes','cursor')")
    .replace(/CREATE TABLE (IF NOT EXISTS )?["'`]?agents["'`]?/i, 'CREATE TABLE agents_neu')

  // PRAGMA foreign_keys wirkt innerhalb einer Transaktion nicht — vorher setzen.
  // runs.agent_id zeigt auf agents(id); ohne das Abschalten stolpert das DROP darüber.
  db.exec('PRAGMA foreign_keys = OFF')
  try {
    db.exec('BEGIN')
    db.exec(neuSql)
    db.exec(`INSERT INTO agents_neu(${spalten}) SELECT ${spalten} FROM agents`)
    db.exec('DROP TABLE agents')
    db.exec('ALTER TABLE agents_neu RENAME TO agents')
    db.exec('COMMIT')
    console.log('[db] agents.harness: CHECK um cursor erweitert')
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* schon zurückgerollt */ }
    throw err
  } finally {
    db.exec('PRAGMA foreign_keys = ON')
  }
}
harnessCheckErweitern()

// Bestandsagenten mit Cron-Ausdruck behalten ihr Verhalten.
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
export function allSettings() {
  const out = {}
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value
  return out
}

export function addEvent(runId, kind, payload = null) {
  db.prepare('INSERT INTO events(run_id, kind, payload) VALUES(?, ?, ?)')
    .run(runId, kind, payload === null ? null : JSON.stringify(payload))
}

/** Event nur anlegen, wenn dieser (run,kind) noch nicht existiert — Telegram/Ampel dedupen so von selbst. */
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
