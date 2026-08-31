#!/usr/bin/env node
// Freilauf — verification for the agent lifecycle gates (GATES.md G1/G2):
//   node test/verify-agent-lifecycle.mjs --migration   old agents table → UNIQUE(repo_id, name)
//   node test/verify-agent-lifecycle.mjs --lifecycle   uniqueness, move suffix, delete keeps runs
// Runs against throwaway data directories; the real hub database is never touched.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const MODUS = process.argv[2] ?? '--migration'
const sandkasten = mkdtempSync(join(tmpdir(), 'Freilauf-agentver-'))

async function migration() {
  const dataDir = join(sandkasten, 'migration')
  mkdirSync(dataDir, { recursive: true })
  const dbPath = join(dataDir, 'freilauf.db')

  // Old schema, exactly as the hub shipped it before this feature: a globally
  // UNIQUE name (column-level) AND the CHECK on `harness` that listed the four
  // built-in coding agents. Both are gone now and both are checked below — the
  // CHECK because it was the import cycle that blocked dynamic plugin loading
  // (db.mjs had to ask the harness registry to write the rule), so a plugin
  // read from disk could not have been named in it at schema time at all.
  // The runs table is NOT pre-created here — db.mjs builds it fresh, and the
  // test proves the rebuild preserved the agents and their ids by inserting a
  // run against the migrated agent afterwards.
  const alt = new DatabaseSync(dbPath)
  alt.exec(`
    CREATE TABLE agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id INTEGER NOT NULL,
      name TEXT NOT NULL UNIQUE,
      harness TEXT NOT NULL CHECK(harness IN ('claude','cursor','hermes','opencode')),
      model TEXT,
      prompt TEXT NOT NULL,
      branch_mode TEXT NOT NULL DEFAULT 'keiner',
      branch_pattern TEXT,
      expected_minutes INTEGER NOT NULL DEFAULT 45,
      schedule TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE repos (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, path TEXT NOT NULL);
    INSERT INTO repos(name, path) VALUES('r1','/x/r1'),('r2','/x/r2');
    INSERT INTO agents(repo_id, name, harness, prompt) VALUES(1,'nightly','claude','x'),(2,'weekly','claude','y');
  `)
  alt.close()

  process.env.FREILAUF_DATA_DIR = dataDir
  await import('../server/db.mjs')   // runs all migrations on the old database

  const dbs = new DatabaseSync(dbPath)
  const sql = dbs.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='agents'`).get().sql
  assert.match(sql, /UNIQUE\s*\(\s*repo_id\s*,\s*name\s*\)/, 'table-level UNIQUE(repo_id, name) in place')
  assert.doesNotMatch(sql, /name\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i, 'column-level global UNIQUE gone')
  // The CHECK is REMOVED, not merely survived: the fixture above shipped with
  // it, so a green assertion here can only mean the migration ran.
  assert.doesNotMatch(sql, /CHECK\s*\(\s*harness\b/i, 'CHECK(harness IN (…)) removed by the migration')
  assert.equal(dbs.prepare('SELECT count(*) c FROM agents').get().c, 2, 'agents survived the rebuild')
  assert.equal(dbs.prepare('SELECT name FROM agents WHERE id=?').get(1).name, 'nightly', 'agent ids stable')
  // …and that is what it is for: a coding agent the hub does not ship can be
  // stored. Under the old rule this INSERT died with a CHECK constraint
  // failure, which is exactly why an external harness plugin was impossible.
  dbs.prepare(`INSERT INTO agents(repo_id, name, harness, prompt) VALUES(1,'external','mistral-cli','x')`).run()
  assert.equal(dbs.prepare(`SELECT harness FROM agents WHERE name='external'`).get().harness, 'mistral-cli',
    'a harness id no built-in declares is accepted')
  // A run can still be created against the migrated agent — the reference holds.
  dbs.prepare(`INSERT INTO runs(id, repo_id, agent_id, title, harness, prompt, branch_mode, expected_minutes)
               VALUES('run-old', 1, 1, 'nightly run', 'claude', 'p', 'keiner', 45)`).run()
  assert.equal(dbs.prepare('SELECT title FROM runs WHERE id=?').get('run-old').title, 'nightly run', 'run against migrated agent works')
  dbs.close()
  console.log('migration verification passed')
}

async function lifecycle() {
  const dataDir = join(sandkasten, 'lifecycle')
  mkdirSync(dataDir, { recursive: true })
  process.env.FREILAUF_DATA_DIR = dataDir
  const { default: db } = await import('../server/db.mjs')
  const { saveAgent, agentNameTaken, moveAgent, deleteAgent } = await import('../server/run-def.mjs')

  db.prepare(`INSERT INTO repos(name, path) VALUES('r1','/x/r1'),('r2','/x/r2')`).run()
  const [r1, r2] = db.prepare('SELECT id FROM repos ORDER BY id').all()
  const def = {
    harness: 'claude', model: null, provider: null, orProvider: null, effort: null,
    prompt: 'x', branchMode: 'keiner', branchPattern: null, expectedMinutes: 45, skills: null, flows: null,
  }

  // Per-repo uniqueness: same name in two repos is fine, a second one in the
  // same repo is not (agentNameTaken mirrors the UNIQUE constraint).
  const a1 = saveAgent({ repoId: r1.id, name: 'nightly', def })
  assert.equal(agentNameTaken(r1.id, 'nightly'), true, 'name taken inside the same repo')
  assert.equal(agentNameTaken(r2.id, 'nightly'), false, 'same name free in the other repo')
  const a2 = saveAgent({ repoId: r2.id, name: 'nightly', def })
  assert.ok(a2 > 0, 'same name, other repo → allowed')
  assert.throws(() => saveAgent({ repoId: r1.id, name: 'nightly', def }), /UNIQUE/, 'same repo duplicate throws')

  // Move with a collision → datetime suffix. The suffix format is machine-
  // friendly and free of the current date: it only has to be distinct and readable.
  const moved = moveAgent(a1, r2.id)
  assert.equal(moved.ok, true, 'move succeeds')
  assert.match(moved.name, /^nightly-\d{4}-\d{2}-\d{2}-\d{6}$/, `suffix on collision (got "${moved.name}")`)
  const row = db.prepare('SELECT repo_id, name FROM agents WHERE id=?').get(a1)
  assert.equal(row.repo_id, r2.id, 'repo changed')
  assert.equal(row.name, moved.name, 'new name persisted')

  // Move without a collision keeps the name.
  const moved2 = moveAgent(a2, r1.id)
  assert.equal(moved2.ok, true, 'second move succeeds')
  assert.equal(moved2.name, 'nightly', 'free name is kept')
  assert.equal(moveAgent(a2, r1.id).ok, false, 'already-in-target move is refused')

  // Delete keeps the runs: the reference is cut, the run row and its title stay.
  db.prepare(`INSERT INTO runs(id, repo_id, agent_id, title, harness, prompt, branch_mode, expected_minutes)
              VALUES('run-1', ?, ?, 'nightly run', 'claude', 'p', 'keiner', 45)`).run(r1.id, a2)
  deleteAgent(a2)
  assert.equal(db.prepare('SELECT count(*) c FROM agents WHERE id=?').get(a2).c, 0, 'agent row gone')
  const run = db.prepare('SELECT * FROM runs WHERE id=?').get('run-1')
  assert.ok(run, 'run survives')
  assert.equal(run.agent_id, null, 'reference cut')
  assert.equal(run.title, 'nightly run', 'title snapshot survives')
  console.log('lifecycle verification passed')
}

try {
  if (MODUS === '--migration') await migration()
  else if (MODUS === '--lifecycle') await lifecycle()
  else { console.error('unknown mode', MODUS); process.exit(2) }
} finally {
  rmSync(sandkasten, { recursive: true, force: true })
}
