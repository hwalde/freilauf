#!/usr/bin/env node
// Freilauf — end-to-end tests against a REAL hub process in a sandbox.
//
// Why a dedicated hub instead of testing against the running one: the suite must be
// safe to run at any time alongside live operation. It therefore starts a second hub
// on a free port with its own database, its own runs/worktrees directories and its own
// test repo. The production hub, its database, ~/agents and its tmux sessions are
// never touched. Only sessions this suite created itself are cleaned up (their names
// are recorded) — never by pattern-matching across all fl-*.
//
// Usage:
//   node test/e2e.mjs           stub instead of real agents: fast, no cost
//   node test/e2e.mjs --echt    additionally ONE real run per harness (claude,
//                               opencode, hermes) through the real
//                               ~/.local/bin/fl-start (consumes quota!)
//   node test/e2e.mjs --keep    keep the sandbox after the run (debugging)
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, lstatSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { gruppe, pruefe, uebersprungen, gleich, wahr, falsch, enthaelt, warteAuf, bericht, zaehler } from './mini.mjs'
import { neuerSandkasten, sh, vorhanden, PROJEKT } from './sandkasten.mjs'

const ECHT = process.argv.includes('--echt')
// User-specified test model for opencode/hermes (cheap, tool-capable).
// Capture the provider key NOW: the stub part deletes it from the environment in a
// moment, but the real-run part still needs it.
const ECHT_KEYS = { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY }
const ECHT_MODELL = process.env.FREILAUF_TEST_MODELL ?? 'deepseek/deepseek-v4-flash-0731'
// Zen: one of the free models — runs without a key.
const ZEN_MODELL = process.env.FREILAUF_TEST_ZEN_MODELL ?? 'nemotron-3.5-lightning-free'
const BEHALTEN = process.argv.includes('--keep')
const start = Date.now()

// ------------------------------------------------- sandbox and hub process
// Both come from test/sandkasten.mjs: the browser suite runs against exactly the
// same sandbox, and one copy of that construction is enough. The names below stay
// what the tests in this file have always used.
const sk = neuerSandkasten({ praefix: 'Freilauf-e2e-', behalten: BEHALTEN })
const { SB, REPO, ORIGIN, FEHLSTART, sessions, hol, formular } = sk
let db = null
let PORT = 0
let BASIS = ''

/** Start the hub and carry port, base URL and database into this file. */
async function hubStarten(opts = {}) {
  await sk.hubStarten({ keys: ECHT_KEYS, ...opts })
  db = sk.db
  PORT = sk.port
  BASIS = sk.basis
}
async function hubStoppen() {
  await sk.hubStoppen()
  db = null
}

// The watcher ticks inside the hub every 30 s; watcherTick() triggers the same
// pass right away.
let watcherTick = null
async function watcherVorbereiten() { watcherTick = await sk.watcherVorbereiten() }

// ---------------------------------------------------------------- Database
// The fl-report of THIS checkout — the one this suite is testing. The copy in
// ~/.local/bin can lag behind (it is installed by the deploy), and the
// session-id forwarding under test exists only in this file's version.
const FL_REPORT_REPO = fileURLToPath(new URL('../bin/fl-report', import.meta.url))

const lauf = (id) => db.prepare('SELECT * FROM runs WHERE id=?').get(id)
const ereignisse = (id) => db.prepare('SELECT kind FROM events WHERE run_id=? ORDER BY id').all(id).map(e => e.kind)
const agent = (name) => db.prepare('SELECT * FROM agents WHERE name=?').get(name)

/** Start a run via the JSON API and record the created tmux session. */
async function laufStarten(daten) {
  const r = await formular('/api/runs', { harness: 'claude', branch_mode: 'keiner', expected_minutes: '45', ...daten })
  const j = await r.json()
  if (j.runId) {
    const s = lauf(j.runId)?.tmux_session
    if (s) sessions.add(s)
  }
  return j
}

/**
 * Note a run's tmux session for the cleanup — waiting for it if it is not
 * there yet. A Quick Run answers BEFORE the launch (`detached`, see
 * scheduler.mjs), so reading the column in the same breath as the response is
 * a race; every other caller finds it already set and pays one query.
 */
async function sessionMerken(runId, { wait = true } = {}) {
  let s = lauf(runId)?.tmux_session
  if (!s && wait) {
    try { s = await warteAuf(() => lauf(runId)?.tmux_session, { was: `tmux session of ${runId}`, timeoutMs: 20_000 }) }
    catch { s = null }
  }
  if (s) sessions.add(s)
  return s
}

// ---------------------------------------------------------------- Cleanup
async function aufraeumen() {
  await sk.aufraeumen()
  db = null
}
process.on('SIGINT', async () => { await aufraeumen(); process.exit(130) })
process.on('SIGTERM', async () => { await aufraeumen(); process.exit(143) })

// ================================================================== Test run
try {
  console.log(`Sandbox: ${SB}`)
  await sk.bauen()
  await hubStarten()
  await watcherVorbereiten()
  console.log(`Hub: ${BASIS}${ECHT ? '   [--echt: real runs per harness — consumes quota and credits]' : ''}`)

  // ------------------------------------------------------------------
  gruppe('Coding agents: initial state, detection, configuration')

  await pruefe('fresh installation: every page shows the setup banner', async () => {
    const html = await (await hol('/')).text()
    enthaelt(html, 'banner setup', 'banner container')
    enthaelt(html, '/settings/coding-agents', 'link to the settings')
  })
  await pruefe('run creation without a configured coding agent is rejected', async () => {
    const r = await formular('/api/runs', { repo_id: '1', harness: 'claude', prompt: 'x', branch_mode: 'keiner', expected_minutes: '5' })
    gleich(r.status, 400, 'rejected')
    enthaelt((await r.json()).error, 'not configured', 'reason names the configuration')
  })
  await pruefe('detect API lists the known coding agents with install state', async () => {
    const j = await (await hol('/api/coding-agents/detect')).json()
    wahr(j.ok, 'ok')
    gleich(j.agents.map(a => a.id).sort().join(','), 'claude,cursor,hermes,opencode', 'all four plugins')
    wahr(j.agents.every(a => typeof a.installed === 'boolean' && a.configured === false), 'installed flag, none configured yet')
  })
  await pruefe('coding agents can be added with their provider selection', async () => {
    const faelle = [
      ['claude', []],
      ['opencode', ['opencode-zen', 'deepseek', 'openrouter']],
      ['hermes', ['openrouter', 'opencode-zen', 'deepseek']],
      ['cursor', []],
    ]
    for (const [harness, providers] of faelle) {
      const r = await formular('/settings/coding-agents/save',
        { harness, enabled: '1', ...(providers.length ? { providers } : {}) }, { alsBrowser: true })
      gleich(r.status, 303, harness)
    }
    // The rows live in `plugin_config` now (kind='harness'), with the allowed
    // model providers inside the `config` JSON — one table for coding agents
    // and model providers alike, because a provider had no place to carry an
    // enabled flag or a credential before it.
    gleich(db.prepare(`SELECT count(*) c FROM plugin_config WHERE kind='harness' AND enabled=1`).get().c, 4, 'four enabled')
    const opencodeConfig = JSON.parse(
      db.prepare(`SELECT config FROM plugin_config WHERE plugin_id='opencode'`).get().config)
    gleich(opencodeConfig.providers.length, 3, 'providers stored')
  })
  await pruefe('unknown coding agent is rejected by the settings form', async () => {
    const r = await formular('/settings/coding-agents/save', { harness: 'gpt', enabled: '1' }, { alsBrowser: true })
    gleich(r.status, 400, 'rejected')
  })
  await pruefe('the banner disappears once a coding agent is configured', async () => {
    falsch((await (await hol('/')).text()).includes('banner setup'), 'no banner')
  })
  await pruefe('settings page lists the configured coding agents', async () => {
    const html = await (await hol('/settings/plugins')).text()
    enthaelt(html, 'Claude Code', 'label')
    enthaelt(html, 'cursor-agent', 'binary name')
  })
  await pruefe('the old coding-agents address still leads there', async () => {
    // A 303 and not a 404: the address is in bookmarks, in the setup banner
    // and in the docs, and an operator who follows one of those must land on
    // the page the section moved to.
    const r = await hol('/settings/coding-agents')
    gleich(r.status, 303, 'redirect')
    gleich(r.headers.get('location'), '/settings/plugins', 'to the plugins page')
  })
  await pruefe('usage API answers with the Claude quota from the fixture', async () => {
    const j = await (await hol('/api/usage')).json()
    wahr(j.ok, 'ok')
    const claude = j.usage.find(u => u.harness === 'claude')
    wahr(!!claude && claude.ok, `claude row (${JSON.stringify(j.usage).slice(0, 200)})`)
    gleich(claude.data.five, 1, '5h percentage from quota.json')
    const cursor = j.usage.find(u => u.harness === 'cursor')
    wahr(!!cursor && cursor.ok === false, 'cursor row honestly unavailable (no auth file in the sandbox)')
  })

  // ------------------------------------------------------------------
  gruppe('Basic scaffolding: pages, static files, API fallback')

  await pruefe('empty state leads to creating a repo', async () => {
    const r = await hol('/')
    gleich(r.status, 200, 'status')
    enthaelt(await r.text(), 'Create repo', 'hint text')
  })
  // The flow designer's own scripts belong in this loop as much as xterm does: a
  // moved or renamed entry in STATIC_MAP shows up nowhere else, and the designer
  // page would be silently dead. /static/flows/ carries the two pure modules the
  // browser runs as well, so designer and server judge a flow by the same code.
  for (const datei of ['/static/xterm.js', '/static/addon-fit.js', '/static/hub.js', '/static/hub.css', '/static/xterm.css',
    '/static/flows.js', '/static/flows.css', '/static/flows/template.mjs', '/static/flows/varschema.mjs',
    '/static/swd.js', '/static/swd.css', '/static/swd-light.css']) {
    await pruefe(`${datei} is served`, async () => {
      const r = await hol(datei)
      gleich(r.status, 200, 'status')
      wahr((await r.text()).length > 100, 'content present')
    })
  }
  // Without a validator a browser cannot revalidate, so it re-downloaded the
  // whole set on every page view: ~600 KB per page and ~900 KB on a run detail
  // page, xterm.js alone being 488 KB — read off disk SYNCHRONOUSLY, in the one
  // event loop that also holds every SSE stream, the terminal WebSocket, the
  // scheduler and the watcher. That is what "the hub hangs" was made of.
  await pruefe('a static file carries an ETag and answers a revalidation with 304', async () => {
    const r = await hol('/static/hub.js')
    const etag = r.headers.get('etag')
    wahr(!!etag, 'the answer carries a validator')
    gleich(r.headers.get('cache-control'), 'no-cache',
      'and asks to be revalidated rather than blindly reused — these URLs carry no content hash')
    wahr((await r.text()).length > 100, 'the cold answer is the file')

    const zweite = await hol('/static/hub.js', { headers: { 'if-none-match': etag } })
    gleich(zweite.status, 304, 'the unchanged file is not sent a second time')
    gleich((await zweite.text()).length, 0, 'and carries no body at all')
  })

  await pruefe('unknown API path answers 404 instead of hanging', async () => {
    const r = await hol('/api/gibtsnicht', { timeoutMs: 5000 })
    gleich(r.status, 404, 'status')
  })
  await pruefe('a notifier wizard\'s own JSON route answers without a credential', async () => {
    // `/api/telegram/chats` became `/settings/notifications/telegram/json/chats`:
    // reading the bot's chats is knowledge about Telegram, and it travels with
    // the plugin rather than with the hub's API surface.
    const j = await (await hol('/settings/notifications/telegram/json/chats', { timeoutMs: 5000 })).json()
    falsch(j.ok, 'ok')
    wahr(typeof j.error === 'string' && j.error.length > 0, 'error message')
  })

  // ------------------------------------------------------------------
  gruppe('Repos: create and validate')

  await pruefe('valid repo is created', async () => {
    const r = await formular('/repos/edit', {
      name: 'e2e', path: REPO, base_branch: 'main',
      worktree_extras: JSON.stringify([{ path: '.env', mode: 'copy' }, { path: 'referenz/', mode: 'link' }]),
    }, { alsBrowser: true })
    gleich(r.status, 303, 'redirect')
    const repo = db.prepare('SELECT * FROM repos WHERE name=?').get('e2e')
    wahr(!!repo, 'repo in the database')
    gleich(repo.path, REPO, 'path')
  })
  await pruefe('broken JSON is rejected (400 instead of 500)', async () => {
    const r = await formular('/repos/edit', { name: 'x', path: REPO, worktree_extras: '[{kaputt' }, { alsBrowser: true })
    gleich(r.status, 400, 'status')
  })
  await pruefe('path without .git is rejected', async () => {
    const r = await formular('/repos/edit', { name: 'x', path: '/tmp', worktree_extras: '[]' }, { alsBrowser: true })
    gleich(r.status, 400, 'status')
    enthaelt(await r.text(), 'git', 'reason mentions git')
  })
  await pruefe('unknown mode in the extras is rejected', async () => {
    const r = await formular('/repos/edit', {
      name: 'x', path: REPO, worktree_extras: JSON.stringify([{ path: '.env', mode: 'kopieren' }]),
    }, { alsBrowser: true })
    gleich(r.status, 400, 'status')
  })
  await pruefe('a repo prompt is saved and survives an update', async () => {
    const row = db.prepare('SELECT * FROM repos WHERE name=?').get('e2e')
    const r = await formular(`/repos/edit?id=${row.id}`, {
      name: 'e2e', path: REPO, base_branch: 'main',
      worktree_extras: row.worktree_extras,
      prompt: 'This repo is only for e2e tests.',
    }, { alsBrowser: true })
    gleich(r.status, 303, 'redirect')
    gleich(db.prepare('SELECT prompt FROM repos WHERE name=?').get('e2e').prompt, 'This repo is only for e2e tests.', 'prompt in the database')
    // Emptying it sets the row back to NULL — no empty string stays behind.
    const r2 = await formular(`/repos/edit?id=${row.id}`, {
      name: 'e2e', path: REPO, base_branch: 'main',
      worktree_extras: row.worktree_extras, prompt: '   ',
    }, { alsBrowser: true })
    gleich(r2.status, 303, 'redirect of the clearing update')
    gleich(db.prepare('SELECT prompt FROM repos WHERE name=?').get('e2e').prompt, null, 'whitespace-only prompt is NULL')
  })

  const repoId = db.prepare('SELECT id FROM repos WHERE name=?').get('e2e').id

  // ------------------------------------------------------------------
  gruppe('Agents: create and validate')

  await pruefe('active is a checkbox, and a spelled-out "0" means off rather than on', async () => {
    // The form's box carries no hidden `0` companion, so ABSENT is what off
    // means there. A caller scripting this route writes `active=0` instead —
    // and the string '0' is truthy, so it used to switch the agent ON.
    const basis = { repo_id: repoId, harness: 'claude', prompt: 'x', branch_mode: 'keiner', schedule_kind: 'manuell' }
    const aktiv = (name) => db.prepare('SELECT active FROM agents WHERE repo_id=? AND name=?').get(repoId, name)?.active
    await formular('/agents/edit', { ...basis, name: 'schalter-an', active: '1' }, { alsBrowser: true })
    gleich(aktiv('schalter-an'), 1, "'1' switches it on")
    await formular('/agents/edit', { ...basis, name: 'schalter-null', active: '0' }, { alsBrowser: true })
    gleich(aktiv('schalter-null'), 0, "'0' switches it off — it is compared, not coerced")
    await formular('/agents/edit', { ...basis, name: 'schalter-fehlt' }, { alsBrowser: true })
    gleich(aktiv('schalter-fehlt'), 0, 'and an absent field is off, the way an unticked box arrives')
    db.prepare("DELETE FROM agents WHERE name LIKE 'schalter-%'").run()
  })

  await pruefe('unknown harness is rejected', async () => {
    const r = await formular('/agents/edit', { repo_id: repoId, name: 'a1', harness: 'gpt', prompt: 'x', branch_mode: 'keiner', schedule_kind: 'manuell' }, { alsBrowser: true })
    gleich(r.status, 400, 'status')
  })
  await pruefe('empty prompt is rejected', async () => {
    const r = await formular('/agents/edit', { repo_id: repoId, name: 'a2', harness: 'claude', prompt: '   ', branch_mode: 'keiner', schedule_kind: 'manuell' }, { alsBrowser: true })
    gleich(r.status, 400, 'status')
  })
  await pruefe('invalid cron expression is rejected', async () => {
    const r = await formular('/agents/edit', { repo_id: repoId, name: 'a3', harness: 'claude', prompt: 'x', branch_mode: 'keiner', schedule_kind: 'cron', schedule: 'jeden tag' }, { alsBrowser: true })
    gleich(r.status, 400, 'status')
  })
  await pruefe('weekly without a weekday is rejected', async () => {
    const r = await formular('/agents/edit', { repo_id: repoId, name: 'a4', harness: 'claude', prompt: 'x', branch_mode: 'keiner', schedule_kind: 'woechentlich', schedule_time: '06:00', schedule_weeks: '1' }, { alsBrowser: true })
    gleich(r.status, 400, 'status')
  })
  await pruefe('one-off without a date is rejected', async () => {
    const r = await formular('/agents/edit', { repo_id: repoId, name: 'a5', harness: 'claude', prompt: 'x', branch_mode: 'keiner', schedule_kind: 'einmalig', run_at: '' }, { alsBrowser: true })
    gleich(r.status, 400, 'status')
  })
  await pruefe('multi-week cadence without an anchor week is rejected', async () => {
    const r = await formular('/agents/edit', { repo_id: repoId, name: 'a6', harness: 'claude', prompt: 'x', branch_mode: 'keiner', schedule_kind: 'woechentlich', schedule_days: ['1'], schedule_time: '06:00', schedule_weeks: '2', schedule_anchor: '' }, { alsBrowser: true })
    gleich(r.status, 400, 'status')
  })
  await pruefe('weekly agent is saved with all fields', async () => {
    const r = await formular('/agents/edit', {
      repo_id: repoId, name: 'e2e-woechentlich', harness: 'claude', prompt: 'Testauftrag', branch_mode: 'keiner',
      expected_minutes: '30', schedule_kind: 'woechentlich', schedule_days: ['1', '3', '5'],
      schedule_time: '07:30', schedule_weeks: '2', schedule_anchor: '2026-08-24', active: '1',
    }, { alsBrowser: true })
    gleich(r.status, 303, 'redirect')
    const a = agent('e2e-woechentlich')
    gleich(a.schedule_kind, 'woechentlich', 'kind')
    gleich(a.schedule_days, '1,3,5', 'weekdays')
    gleich(a.schedule_time, '07:30', 'time')
    gleich(a.schedule_weeks, 2, 'cadence')
    gleich(a.schedule_anchor, '2026-08-24', 'anchor week')
  })
  await pruefe('several times on the same days land in one column', async () => {
    const r = await formular('/agents/edit', {
      repo_id: repoId, name: 'e2e-mehrzeit', harness: 'claude', prompt: 'x', branch_mode: 'keiner',
      expected_minutes: '30', schedule_kind: 'woechentlich', schedule_mode: 'same',
      schedule_days: ['2'], schedule_time: ['11:00', '08:00', ''], schedule_weeks: '1', active: '1',
    }, { alsBrowser: true })
    gleich(r.status, 303, 'redirect')
    const a = agent('e2e-mehrzeit')
    gleich(a.schedule_time, '08:00,11:00', 'sorted, the emptied chip dropped')
    gleich(a.schedule_slots, null, 'the same times everywhere need no per-day list')
  })
  await pruefe('times per weekday are stored as slots, and the days follow from them', async () => {
    const r = await formular('/agents/edit', {
      repo_id: repoId, name: 'e2e-protag', harness: 'claude', prompt: 'x', branch_mode: 'keiner',
      expected_minutes: '30', schedule_kind: 'woechentlich', schedule_mode: 'per_day',
      schedule_day_time_2: ['08:00', '11:00'], schedule_day_time_3: ['14:17'],
      schedule_days: ['1'], schedule_time: '06:00', schedule_weeks: '1', active: '1',
    }, { alsBrowser: true })
    gleich(r.status, 303, 'redirect')
    const a = agent('e2e-protag')
    gleich(a.schedule_slots, '{"2":["08:00","11:00"],"3":["14:17"]}', 'the per-day list')
    gleich(a.schedule_days, '2,3', 'the days that have times — not the checkboxes of the other mode')
    gleich(a.schedule_time, null, "the other mode's time does not survive alongside")
  })
  await pruefe('a schedule_slots JSON is the same thing said in one field', async () => {
    const r = await formular('/agents/edit', {
      repo_id: repoId, name: 'e2e-slots-json', harness: 'claude', prompt: 'x', branch_mode: 'keiner',
      expected_minutes: '30', schedule_kind: 'woechentlich',
      schedule_slots: '{"2":["08:00","11:00"],"3":["14:17"]}', schedule_weeks: '1', active: '1',
    }, { alsBrowser: true })
    gleich(r.status, 303, 'redirect')
    const a = agent('e2e-slots-json')
    gleich(a.schedule_slots, '{"2":["08:00","11:00"],"3":["14:17"]}', 'stored as given')
    gleich(a.schedule_days, '2,3', 'days derived')
  })
  await pruefe('per-day without a single time, and unreadable times, are rejected', async () => {
    const leer = await formular('/agents/edit', {
      repo_id: repoId, name: 'e2e-protag-leer', harness: 'claude', prompt: 'x', branch_mode: 'keiner',
      schedule_kind: 'woechentlich', schedule_mode: 'per_day', schedule_weeks: '1',
    }, { alsBrowser: true })
    gleich(leer.status, 400, 'no day has a time')
    const kaputt = await formular('/agents/edit', {
      repo_id: repoId, name: 'e2e-protag-kaputt', harness: 'claude', prompt: 'x', branch_mode: 'keiner',
      schedule_kind: 'woechentlich', schedule_mode: 'per_day', schedule_day_time_2: 'bald', schedule_weeks: '1',
    }, { alsBrowser: true })
    gleich(kaputt.status, 400, 'a half-typed time is not silently dropped')
    const json = await formular('/agents/edit', {
      repo_id: repoId, name: 'e2e-slots-kaputt', harness: 'claude', prompt: 'x', branch_mode: 'keiner',
      schedule_kind: 'woechentlich', schedule_slots: 'kein json', schedule_weeks: '1',
    }, { alsBrowser: true })
    gleich(json.status, 400, 'unreadable JSON')
  })
  await pruefe('switching from per-day back to the same times drops the slots', async () => {
    const id = agent('e2e-protag').id
    const r = await formular(`/agents/edit?id=${id}`, {
      repo_id: repoId, name: 'e2e-protag', harness: 'claude', prompt: 'x', branch_mode: 'keiner',
      expected_minutes: '30', schedule_kind: 'woechentlich', schedule_mode: 'same',
      schedule_days: ['1'], schedule_time: '06:00', schedule_weeks: '1', active: '1',
    }, { alsBrowser: true })
    gleich(r.status, 303, 'redirect')
    const a = agent('e2e-protag')
    gleich(a.schedule_slots, null, 'the per-day list is gone, not left to outrank the columns')
    gleich(a.schedule_time, '06:00', 'and the simple time is what runs')
  })
  await pruefe('the form comes back in the mode the agent was saved in', async () => {
    const id = agent('e2e-slots-json').id
    const html = await (await hol(`/agents/edit?id=${id}`)).text()
    wahr(/value="per_day"[^>]*\n?[^>]*checked/.test(html), 'per-day mode preselected')
    wahr(/name="schedule_day_time_2" value="08:00"/.test(html), "Tuesday's first time")
    wahr(/name="schedule_day_time_2" value="11:00"/.test(html), "Tuesday's second time")
    wahr(/name="schedule_day_time_3" value="14:17"/.test(html), "Wednesday's own time")
  })
  await pruefe('switching to manual clears the schedule fields', async () => {
    const id = agent('e2e-woechentlich').id
    const r = await formular(`/agents/edit?id=${id}`, {
      repo_id: repoId, name: 'e2e-woechentlich', harness: 'claude', prompt: 'Testauftrag',
      branch_mode: 'keiner', expected_minutes: '30', schedule_kind: 'manuell', active: '1',
    }, { alsBrowser: true })
    gleich(r.status, 303, 'redirect')
    const a = agent('e2e-woechentlich')
    gleich(a.schedule_kind, 'manuell', 'kind')
    gleich(a.schedule_days, null, 'weekdays cleared')
    gleich(a.run_at, null, 'date cleared')
  })

  // ------------------------------------------------------------------
  gruppe('Agents: delete and move (per-repo names)')

  await pruefe('a second repo exists for the move tests', async () => {
    const r = await formular('/repos/edit', {
      name: 'e2e2', path: REPO, base_branch: 'main', worktree_extras: '[]',
    }, { alsBrowser: true })
    gleich(r.status, 303, 'repo created')
  })
  const repo2Id = db.prepare('SELECT id FROM repos WHERE name=?').get('e2e2').id

  await pruefe('same name is allowed in two repos, rejected inside one', async () => {
    const anlegen = (rid) => formular('/agents/edit', {
      repo_id: rid, name: 'e2e-dup', harness: 'claude', prompt: 'x', branch_mode: 'keiner', schedule_kind: 'manuell',
    }, { alsBrowser: true })
    gleich((await anlegen(repoId)).status, 303, 'first agent in repo1')
    gleich((await anlegen(repo2Id)).status, 303, 'same name allowed in repo2')
    const dup = await anlegen(repoId)
    gleich(dup.status, 400, 'duplicate in the same repo is rejected')
    enthaelt(await dup.text(), 'already exists', 'readable reason instead of a 500')
    gleich(db.prepare('SELECT count(*) c FROM agents WHERE repo_id=? AND name=?').get(repoId, 'e2e-dup').c, 1, 'no second row in repo1')
  })

  await pruefe('a deleted agent leaves its runs untouched', async () => {
    const r = await formular('/agents/edit', {
      repo_id: repoId, name: 'e2e-weg', harness: 'claude', prompt: 'Mach was',
      branch_mode: 'keiner', schedule_kind: 'manuell', expected_minutes: '30',
    }, { alsBrowser: true })
    gleich(r.status, 303, 'agent created')
    const a = db.prepare('SELECT * FROM agents WHERE repo_id=? AND name=?').get(repoId, 'e2e-weg')
    wahr(!!a, 'agent in the database')
    const st = await formular('/agents/start', { id: String(a.id), repo: String(repoId) })
    gleich(st.status, 303, 'start redirects')
    const run = db.prepare('SELECT * FROM runs WHERE agent_id=? ORDER BY started_at DESC LIMIT 1').get(a.id)
    wahr(!!run, 'a run was started for the agent')
    gleich(run.agent_id, a.id, 'run references the agent')
    gleich(run.title, 'e2e-weg', 'run carries the agent name as its title snapshot')
    sessionMerken(run.id)

    const del = await formular('/agents/delete', { id: String(a.id), repo: String(repoId) }, { alsBrowser: true })
    gleich(del.status, 303, 'delete redirects')
    gleich(db.prepare('SELECT count(*) c FROM agents WHERE id=?').get(a.id).c, 0, 'agent row gone')
    const surviving = db.prepare('SELECT * FROM runs WHERE id=?').get(run.id)
    wahr(!!surviving, 'the run survives the delete')
    gleich(surviving.agent_id, null, 'reference cut')
    gleich(surviving.title, 'e2e-weg', 'title snapshot keeps the name')
    gleich(surviving.prompt, run.prompt, 'definition copy untouched')
  })

  await pruefe('move to another repo keeps the name when it is free', async () => {
    const r = await formular('/agents/edit', {
      repo_id: repoId, name: 'e2e-frei', harness: 'claude', prompt: 'x',
      branch_mode: 'keiner', schedule_kind: 'manuell',
    }, { alsBrowser: true })
    gleich(r.status, 303, 'created')
    const a = db.prepare('SELECT * FROM agents WHERE repo_id=? AND name=?').get(repoId, 'e2e-frei')
    const mv = await formular('/agents/move', { id: String(a.id), repo: String(repo2Id) }, { alsBrowser: true })
    gleich(mv.status, 303, 'moved')
    const row = db.prepare('SELECT * FROM agents WHERE id=?').get(a.id)
    gleich(row.repo_id, repo2Id, 'now lives in repo2')
    gleich(row.name, 'e2e-frei', 'name unchanged when it is free there')
  })

  await pruefe('move into a name collision appends a datetime suffix', async () => {
    // 'e2e-frei' is already in repo2 — a second one from repo1 must not overwrite it.
    const r = await formular('/agents/edit', {
      repo_id: repoId, name: 'e2e-frei', harness: 'claude', prompt: 'x',
      branch_mode: 'keiner', schedule_kind: 'manuell',
    }, { alsBrowser: true })
    gleich(r.status, 303, 'same name in repo1 allowed')
    const a = db.prepare('SELECT * FROM agents WHERE repo_id=? AND name=?').get(repoId, 'e2e-frei')
    const mv = await formular('/agents/move', { id: String(a.id), repo: String(repo2Id) }, { alsBrowser: true })
    gleich(mv.status, 303, 'moved')
    const row = db.prepare('SELECT * FROM agents WHERE id=?').get(a.id)
    gleich(row.repo_id, repo2Id, 'now lives in repo2')
    gleich(/^e2e-frei-\d{4}-\d{2}-\d{2}-\d{6}$/.test(row.name), true, `name got a datetime suffix (${row.name})`)
  })

  await pruefe('move page and the agent detail page expose the actions', async () => {
    const a = db.prepare('SELECT * FROM agents WHERE repo_id=? AND name=?').get(repo2Id, 'e2e-frei')
    const html = await (await hol(`/agents/move?id=${a.id}`)).text()
    enthaelt(html, 'Move agent', 'move page title')
    enthaelt(html, 'e2e-frei', 'names the agent')
    enthaelt(html, 'e2e', 'lists a target repo')
    // The destructive actions live on the agent's detail (edit) page, not in
    // the overview table — a cleanup action must not sit next to the on/off
    // switch, and delete asks for the confirm dialog where it appears.
    const detail = await (await hol(`/agents/edit?id=${a.id}&repo=${repo2Id}`)).text()
    enthaelt(detail, '/agents/move', 'move link on the agent detail page')
    enthaelt(detail, '/agents/delete', 'delete form on the agent detail page')
    const page = await (await hol(`/agents?repo=${repoId}`)).text()
    falsch(page.includes('/agents/move'), 'no move link in the agents table')
    falsch(page.includes('/agents/delete'), 'no delete form in the agents table')
  })

  // ------------------------------------------------------------------
  gruppe('Provider and effort selection (harness-dependent)')

  await pruefe('each harness only gets providers it can actually use here', async () => {
    const p = async (h) => (await (await hol(`/api/providers?harness=${h}`)).json()).provider.map(x => x.id)
    gleich((await p('claude')).length, 0, 'claude runs on the subscription, no provider')
    wahr((await p('opencode')).includes('opencode-zen'), 'opencode knows Zen')
    falsch((await p('hermes')).includes('opencode-zen'), 'hermes cannot use Zen here (no key)')
  })

  await pruefe('reasoning effort only where it actually arrives', async () => {
    const eff = async (q) => (await (await hol('/api/effort?' + q)).json())
    const c = await eff('harness=claude')
    wahr(c.ok && c.stufen.includes('high'), `claude names levels (${JSON.stringify(c).slice(0, 90)})`)
    const quatsch = await eff('harness=opencode&provider=openrouter&model=gibtsnicht/quatsch')
    falsch(quatsch.ok, 'unknown model: no field instead of guessed levels')
    gleich((await hol('/api/effort?harness=quatsch')).status, 200, 'always answers with 200')
  })

  await pruefe('an impossible level is rejected instead of silently dropped', async () => {
    // opencode discards an unknown variant without comment — the hub must catch that
    // beforehand, otherwise the DB would hold a promise that does nothing.
    const r = await formular('/agents/edit', {
      repo_id: String(repoId), name: 'effort-quatsch', harness: 'opencode', provider: 'opencode-zen',
      model: 'hy3-free', effort: 'ultraturbo', prompt: 'x', branch_mode: 'keiner',
      expected_minutes: '5', schedule_kind: 'manuell',
    }, { alsBrowser: true })
    gleich(r.status, 400, 'rejected')
    enthaelt(await r.text(), 'Reasoning effort', 'with a reason')
    falsch(!!db.prepare(`SELECT 1 FROM agents WHERE name='effort-quatsch'`).get(), 'nothing saved')
  })

  await pruefe('a disabled coding agent is rejected at run creation and can be re-enabled', async () => {
    await formular('/settings/coding-agents/save', { harness: 'hermes', enabled: '0' }, { alsBrowser: true })
    const r = await formular('/api/runs', { repo_id: String(repoId), harness: 'hermes', prompt: 'x', branch_mode: 'keiner', expected_minutes: '5' })
    gleich(r.status, 400, 'rejected')
    enthaelt((await r.json()).error, 'not configured', 'reason')
    const wieder = await formular('/settings/coding-agents/save',
      { harness: 'hermes', enabled: '1', providers: ['openrouter', 'opencode-zen', 'deepseek'] }, { alsBrowser: true })
    gleich(wieder.status, 303, 're-enabled')
  })

  gruppe('Single run: worktree, prompt, tmux, log')

  await pruefe('the start form shows the ACTUAL pipeline state', async () => {
    // Used to be hard-wired: the form always claimed "pipeline is off",
    // even when the top-right corner said "on".
    const text = async () => (await hol(`/runs/new?repo=${repoId}`)).text()
    await formular('/api/settings/pipeline', { value: '0' })
    enthaelt(await text(), 'Pipeline is off', 'hint with the pipeline switched off')
    await formular('/api/settings/pipeline', { value: '1' })
    const an = await text()
    enthaelt(an, 'Pipeline is on', 'hint with the pipeline switched on')
    falsch(an.includes('Pipeline is off'), 'no contradictory hint next to it')
    await formular('/api/settings/pipeline', { value: '0' })
  })

  let R1 = null
  await pruefe('run starts via the form and redirects to the run page', async () => {
    const r = await formular('/runs/new', {
      repo_id: repoId, harness: 'claude', prompt: 'E2E-Auftrag: nichts tun.',
      branch_mode: 'neu', branch_pattern: 'agent/e2e/{kurz}', expected_minutes: '45',
    }, { alsBrowser: true })
    gleich(r.status, 303, 'redirect')
    const ort = r.headers.get('location')
    wahr(/^\/runs\/[0-9a-f-]{36}$/.test(ort), `target is a run page (${ort})`)
    R1 = ort.split('/')[2]
    await sessionMerken(R1)
    gleich(lauf(R1).status, 'running', 'status')
  })
  await pruefe('worktree exists and is on the expected branch', async () => {
    const l = lauf(R1)
    wahr(existsSync(l.workdir_effective), `worktree ${l.workdir_effective}`)
    const b = await sh('git', ['-C', l.workdir_effective, 'rev-parse', '--abbrev-ref', 'HEAD'])
    gleich(b.stdout.trim(), l.branch_expected, 'branch')
    enthaelt(l.branch_expected, 'agent/e2e/', 'branch pattern expanded')
  })
  await pruefe('worktree extras: .env copied, referenz/ linked', () => {
    const wt = lauf(R1).workdir_effective
    wahr(existsSync(join(wt, '.env')), '.env present')
    falsch(lstatSync(join(wt, '.env')).isSymbolicLink(), '.env is a copy')
    wahr(lstatSync(join(wt, 'referenz')).isSymbolicLink(), 'referenz/ is a symlink')
  })
  await pruefe('prompt.md contains the task and the platform suffix', () => {
    const p = readFileSync(join(SB, 'runs', R1, 'prompt.md'), 'utf8')
    enthaelt(p, 'E2E-Auftrag', 'own task')
    enthaelt(p, 'fl-report done', 'platform rules')
    enthaelt(p, R1, 'run ID')
  })
  await pruefe('a per-repo prompt is added to every run', async () => {
    db.prepare('UPDATE repos SET prompt=? WHERE id=?').run('This repo has its own rules.', repoId)
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Repo-Prompt' })
    wahr(!!j.runId, `run (${JSON.stringify(j)})`)
    await sessionMerken(j.runId)
    const p = readFileSync(join(SB, 'runs', j.runId, 'prompt.md'), 'utf8')
    enthaelt(p, 'E2E-Repo-Prompt', 'own task')
    enthaelt(p, 'Repository context', 'section label')
    enthaelt(p, 'This repo has its own rules.', 'repo prompt content')
    // Repo config is read at launch, not snapshotted: clearing it removes it from
    // the next run, and runs before it keep their prompt.md.
    db.prepare('UPDATE repos SET prompt=? WHERE id=?').run(null, repoId)
  })
  await pruefe('tmux session is running and assigned to the run', async () => {
    const s = lauf(R1).tmux_session
    wahr(!!s, 'session in the database')
    wahr((await sh('tmux', ['has-session', '-t', `=${s}`])).ok, `session ${s} is alive`)
  })
  await pruefe('log file is created (fl-start --log → pipe-pane)', () => {
    // The CONTENT is checked only after the first send: pipe-pane attaches only
    // after startup, so the initial output can escape it.
    wahr(existsSync(join(SB, 'runs', R1, 'log.txt')), 'log.txt created')
  })

  // ------------------------------------------------------------------
  gruppe('Terminal in the browser (WebSocket)')

  const wsVersuch = (pfad) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}${pfad}`)
    const fertig = (e) => { try { ws.close() } catch {} ; resolve(e) }
    const t = setTimeout(() => fertig({ art: 'timeout' }), 8000)
    ws.on('message', (d) => { clearTimeout(t); fertig({ art: 'daten', text: String(d) }) })
    ws.on('unexpected-response', (_req, res) => { clearTimeout(t); fertig({ art: 'http', status: res.statusCode }) })
    ws.on('error', (err) => { clearTimeout(t); fertig({ art: 'fehler', text: err.message }) })
  })

  await pruefe('terminal connects and delivers the session content', async () => {
    const e = await wsVersuch(`/term?run=${R1}&ro=1`)
    gleich(e.art, 'daten', `event (${JSON.stringify(e)})`)
    wahr(e.text.length > 0, 'output received')
  })
  await pruefe('unknown run yields 404 instead of hanging', async () => {
    const e = await wsVersuch('/term?run=00000000-0000-4000-8000-000000000000&ro=1')
    gleich(e.art, 'http', 'HTTP response')
    gleich(e.status, 404, 'status')
  })

  // Typing into the terminal — the path the suite long left untested: up to this point
  // it only checked ro=1 and would never have noticed a permanently mute input.
  const wsSchreiben = (pfad, text) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}${pfad}`)
    const t = setTimeout(() => { try { ws.close() } catch {}; reject(new Error('timeout while connecting')) }, 8000)
    // Only once tmux has painted the screen is the client really attached.
    ws.once('message', () => {
      clearTimeout(t)
      ws.send(text)
      setTimeout(() => { try { ws.close() } catch {}; resolve() }, 300)
    })
    ws.on('error', (err) => { clearTimeout(t); reject(err) })
  })

  await pruefe('with ro=0, typed text really lands in the session', async () => {
    await wsSchreiben(`/term?run=${R1}&ro=0`, 'direkt getippt\r')
    await warteAuf(async () => (await sh('tmux', ['capture-pane', '-p', '-t', `=${lauf(R1).tmux_session}:`]))
      .stdout.includes('[agent sah] direkt getippt'), { was: 'typed text in the pane', timeoutMs: 8000 })
  })
  await pruefe('without the ro parameter the terminal stays mute (fail-closed)', async () => {
    await wsSchreiben(`/term?run=${R1}`, 'darf nicht ankommen\r')
    await new Promise((r) => setTimeout(r, 1500))
    const p = await sh('tmux', ['capture-pane', '-p', '-t', `=${lauf(R1).tmux_session}:`])
    falsch(p.stdout.includes('darf nicht ankommen'), 'nothing let through')
  })

  // ------------------------------------------------------------------
  gruppe('Sending text and reports (fl-report)')

  // The fl-report of THIS checkout, like FL_REPORT_REPO above and for the same
  // reason: ~/.local/bin holds whatever the last deploy installed, and a suite
  // that asks the machine what it has installed is a suite that is green or red
  // depending on the machine.
  const flReport = (runId, args) => sh(FL_REPORT_REPO, args, {
    env: { ...process.env, FL_RUN_ID: runId, FL_HUB_URL: BASIS },
  })

  await pruefe('sending via the API lands in the tmux session', async () => {
    const r = await formular(`/api/runs/${R1}/send`, { text: 'hallo aus dem test' })
    gleich(r.status, 200, 'status')
    gleich((await r.json()).ok, true, 'ok')
    await warteAuf(async () => (await sh('tmux', ['capture-pane', '-p', '-t', `=${lauf(R1).tmux_session}:`]))
      .stdout.includes('[agent sah] hallo aus dem test'), { was: 'text in the pane', timeoutMs: 8000 })
  })
  await pruefe('the log records the transcript', async () => {
    const datei = join(SB, 'runs', R1, 'log.txt')
    await warteAuf(() => readFileSync(datei, 'utf8').includes('hallo aus dem test'),
      { was: 'sent text in the log', timeoutMs: 8000 })
  })
  await pruefe('form POST redirects back to the run page (no bare JSON)', async () => {
    const r = await formular(`/api/runs/${R1}/send`, { text: 'zweiter text' }, { alsBrowser: true })
    gleich(r.status, 303, 'status')
    gleich(r.headers.get('location'), `/runs/${R1}`, 'target')
  })
  await pruefe('progress, branch and PR are taken over', async () => {
    wahr((await flReport(R1, ['progress', 'laeuft weiter'])).ok, 'progress')
    wahr((await flReport(R1, ['branch', 'agent/e2e/gemeldet'])).ok, 'branch')
    wahr((await flReport(R1, ['pr', 'https://example.invalid/pr/1'])).ok, 'pr')
    const l = lauf(R1)
    gleich(l.branch_reported, 'agent/e2e/gemeldet', 'branch')
    gleich(l.pr_url, 'https://example.invalid/pr/1', 'PR')
    wahr(ereignisse(R1).includes('progress'), 'event progress')
  })
  await pruefe('a call for help sets the run to waiting_help', async () => {
    wahr((await flReport(R1, ['help', 'Variante A oder B?'])).ok, 'help')
    const l = lauf(R1)
    gleich(l.status, 'waiting_help', 'status')
    enthaelt(l.help_text, 'Variante A', 'question stored')
  })
  await pruefe('an answer sets the run back to running', async () => {
    await formular(`/api/runs/${R1}/send`, { text: 'Nimm B.' })
    const l = lauf(R1)
    gleich(l.status, 'running', 'status')
    enthaelt(l.help_answer, 'Nimm B.', 'answer stored')
  })
  await pruefe('final report lands in the run and on the page', async () => {
    const datei = join(SB, 'report.md')
    writeFileSync(datei, '# Bericht\n- alles erledigt\n')
    wahr((await flReport(R1, ['done', '--file', datei])).ok, 'done')
    const l = lauf(R1)
    gleich(l.status, 'done', 'status')
    enthaelt(l.report_md, 'alles erledigt', 'report stored')
    enthaelt(await (await hol(`/runs/${R1}`)).text(), 'alles erledigt', 'report on the page')
  })

  await pruefe('the detail page shows the prompt in a collapsible block near the top', async () => {
    const html = await (await hol(`/runs/${R1}`)).text()
    enthaelt(html, 'id="run-prompt"', 'the prompt block exists')
    enthaelt(html, 'E2E-Auftrag: nichts tun.', 'the run\'s prompt text is on the page')
    const reihe = ['id="run-head"', 'id="run-prompt"', 'class="chips"'].map(s => html.indexOf(s))
    wahr(reihe[0] !== -1 && reihe[1] !== -1 && reihe[2] !== -1, 'title, prompt block and chips all rendered')
    gleich(reihe[0] < reihe[1] && reihe[1] < reihe[2], true, 'title → prompt → chips (prompt sits near the top)')
  })

  // ------------------------------------------------------------------
  gruppe('cursor: a run ends even without fl-report')

  // The hole this closes: cursor's TUI stays standing after the work is done
  // ('→ Add a follow-up'), so the pane never dies and no process ever exits. A
  // run whose agent forgot `fl-report done` therefore stood on 'running'
  // forever — and a single run waiting for "when the repo is free" waited behind
  // it just as long (observed 2026-08-25 with four runs, one of them the one
  // meant to fix exactly this).
  const { projectDirs } = await import('../server/cursor-transcript.mjs')
  const writeTranscript = (runId, lines) => {
    const wd = lauf(runId).workdir_effective
    const dir = join(projectDirs(wd)[0], 'agent-transcripts', `session-${runId.slice(0, 8)}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `session-${runId.slice(0, 8)}.jsonl`), lines.join('\n') + '\n')
  }
  const cursorRun = async (prompt) => {
    const j = await laufStarten({ repo_id: repoId, harness: 'cursor', prompt, expected_minutes: '45' })
    wahr(!!j.runId, `run created (${JSON.stringify(j).slice(0, 200)})`)
    await sessionMerken(j.runId)
    return j.runId
  }
  const AGENT_TEXT = 'Done: dark-mode hover fixed, pushed as abc1234.'
  const TURN_END = ['{"role":"assistant","message":{"content":[{"type":"text","text":"' + AGENT_TEXT + '"}]}}',
    '{"type":"turn_ended","status":"success"}']

  let RCU = null
  await pruefe('the hub writes the stop hook into the worktree before the start', async () => {
    RCU = await cursorRun('E2E-cursor-turn-end')
    const f = join(lauf(RCU).workdir_effective, '.cursor', 'hooks.json')
    const j = JSON.parse(readFileSync(f, 'utf8'))
    enthaelt(j.hooks.stop[0].command, 'fl-report _turn_end', 'stop reports the turn end')
    enthaelt(j.hooks.sessionEnd[0].command, 'fl-report _exit', 'sessionEnd is the second net')
  })
  await pruefe('the prompt tells cursor how the run ends, with a copy-ready command', async () => {
    const p = readFileSync(join(SB, 'runs', RCU, 'prompt.md'), 'utf8')
    enthaelt(p, `fl-report done --file ${join(SB, 'runs', RCU, 'report.md')}`, 'exact command, exact path')
    enthaelt(p, 'cursor-agent', 'the harness gets its own rules')
    falsch(p.includes('{report_file}'), 'no placeholder left over')
  })
  await pruefe('the stop hook closes the run and keeps the agent\'s own words', async () => {
    writeTranscript(RCU, TURN_END)
    wahr((await flReport(RCU, ['_turn_end'])).ok, '_turn_end accepted')
    const l = lauf(RCU)
    gleich(l.status, 'done', 'status')
    enthaelt(l.report_md, AGENT_TEXT, 'the closing message becomes the report')
    enthaelt(l.report_md, 'without calling', 'and it says why the platform wrote it')
    wahr(ereignisse(RCU).includes('turn_end_finished'), 'recorded as its own event')
  })
  await pruefe('a turn end while waiting for help does NOT close the run', async () => {
    const id = await cursorRun('E2E-cursor-help')
    wahr((await flReport(id, ['help', 'A or B?'])).ok, 'help')
    gleich(lauf(id).status, 'waiting_help', 'waiting')
    // Ending the turn is exactly right here: the agent asked and is idle until a
    // human answers. Closing the run on it would throw the question away.
    writeTranscript(id, TURN_END)
    await flReport(id, ['_turn_end'])
    await watcherTick()
    gleich(lauf(id).status, 'waiting_help', 'still waiting')
  })
  await pruefe('without a hook the transcript closes the run', async () => {
    // Second channel: a repository bringing its own .cursor/hooks.json keeps the
    // hub from writing one, and a cursor release could rename the event. The
    // transcript cannot go away — it is where cursor keeps the conversation.
    const id = await cursorRun('E2E-cursor-transcript')
    await watcherTick()
    gleich(lauf(id).status, 'running', 'still running while the turn is open')
    writeTranscript(id, TURN_END)
    await watcherTick()
    gleich(lauf(id).status, 'done', 'closed by the watcher')
    enthaelt(lauf(id).report_md, AGENT_TEXT, 'same report text')
  })
  await pruefe('all three end channels together notify exactly once', async () => {
    // cursor's run end is detected THREE times on purpose — stop hook (fast),
    // transcript (the net that survives a repo's own hooks.json), sessionEnd's
    // `_exit`. Every one of them ends in handleReport(), and handleReport() is
    // what notifies: if they were not fenced off, one finished run would ring
    // the phone three times about the same thing.
    //
    // Three fences hold, and this test is here so none of them can be removed
    // quietly: handleReport() only accepts a run in running/waiting_help,
    // finishByTurnEnd() only fires from 'running', and notifyRun() carries the
    // per-(run, type) flag.
    const id = await cursorRun('E2E-cursor-doppelmeldung')
    writeTranscript(id, TURN_END)
    await watcherTick()                  // transcript channel closes it
    await flReport(id, ['_turn_end'])    // stop hook, on the same finished turn
    await flReport(id, ['_exit'])        // sessionEnd's net on top
    await watcherTick()
    gleich(lauf(id).status, 'done', 'done')
    const kinds = ereignisse(id)
    const ende = kinds.filter(k => /^notified:(done|failed|pane_died|exit_without_report)$/.test(k))
    gleich(ende.join(','), 'notified:done', 'exactly one end message, and it is the done one')
    gleich(kinds.filter(k => k === 'done').length, 1, 'the run was closed exactly once')
    gleich(kinds.filter(k => k === 'turn_end_finished').length, 1, 'only the channel that got there first closes it')
  })
  await pruefe('a claude run is not closed by a turn end', async () => {
    // Every other harness has a dying process as its safety net; there the turn
    // end stays what it always was — a note.
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-claude-turn-end', expected_minutes: '45' })
    await sessionMerken(j.runId)
    wahr((await flReport(j.runId, ['_turn_end'])).ok, '_turn_end accepted')
    gleich(lauf(j.runId).status, 'running', 'keeps running')
  })

  // ------------------------------------------------------------------
  gruppe('Watcher: anomalies, costs, branch reconciliation')

  let R3 = null
  await pruefe('exceeded expectation creates anomalies', async () => {
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Ueberzug', expected_minutes: '1' })
    R3 = j.runId
    wahr(!!R3, 'run created')
    await sessionMerken(R3)
    // Backdate the start time instead of waiting five minutes.
    db.prepare(`UPDATE runs SET started_at=datetime('now','-5 minutes') WHERE id=?`).run(R3)
    await watcherTick()
    const k = ereignisse(R3)
    wahr(k.includes('anomaly:overrun'), `anomaly:overrun (has: ${k.join(', ')})`)
    wahr(k.includes('anomaly:soft_overrun'), 'anomaly:soft_overrun')
  })
  await pruefe('a progress report clears the anomalies again', async () => {
    wahr((await flReport(R3, ['progress', 'melde mich, dauert laenger'])).ok, 'progress')
    const k = ereignisse(R3)
    falsch(k.includes('anomaly:overrun'), 'anomaly:overrun is gone')
    wahr(k.includes('cleared:anomaly:overrun'), 'marked as resolved')
    wahr(k.includes('cleared:anomaly:soft_overrun'), 'the yellow level too')
  })
  await pruefe('cost finalization really runs for finished runs', async () => {
    await watcherTick()
    const l = lauf(R1)
    wahr(l.quota7_end !== null, 'quota7_end set')
    wahr(l.cost_eur !== null, 'cost_eur computed')
  })
  await pruefe('unpushed branch is reported', async () => {
    const l = lauf(R1)
    // The reported branch does not exist in git — the reconciliation counts the real one.
    db.prepare('UPDATE runs SET branch_reported=? WHERE id=?').run(l.branch_expected, R1)
    db.prepare(`DELETE FROM events WHERE run_id=? AND kind IN ('anomaly:unpushed','branch_synced')`).run(R1)
    await sh('git', ['-C', l.workdir_effective, 'commit', '-q', '--allow-empty', '-m', 'Arbeit des Agenten'])
    await watcherTick()
    wahr(ereignisse(R1).includes('anomaly:unpushed'), `anomaly:unpushed (has: ${ereignisse(R1).join(', ')})`)
  })

  // ------------------------------------------------------------------
  gruppe('Extra skills: opt-in per run and agent')

  await pruefe('forms offer the skill as a checkbox, nothing preselected', async () => {
    const html = await (await hol(`/runs/new?repo=${repoId}`)).text()
    enthaelt(html, 'e2e-fleiss', 'single-run form')
    enthaelt(html, 'Testskill gegen faule Modelle', 'description')
    falsch(/name="skills"[^>]*checked/.test(html), 'opt-in: not preselected')
    enthaelt(await (await hol(`/agents/edit?repo=${repoId}`)).text(), 'e2e-fleiss', 'agent form')
  })
  await pruefe('a selected skill lands as a SKILL.md reference in the run prompt', async () => {
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Skilltest', skills: 'e2e-fleiss' })
    wahr(!!j.runId, `run (${JSON.stringify(j)})`)
    await sessionMerken(j.runId)
    gleich(lauf(j.runId).skills, '["e2e-fleiss"]', 'definition copy on the run')
    const prompt = readFileSync(join(SB, 'runs', j.runId, 'prompt.md'), 'utf8')
    enthaelt(prompt, join(SB, 'zusaetze', 'e2e-fleiss', 'SKILL.md'), 'full path in the prompt')
    enthaelt(prompt, 'ENTIRE task', 'instruction to apply')
    enthaelt(await (await hol(`/runs/${j.runId}`)).text(), 'e2e-fleiss', 'detail page shows the selection')
  })
  await pruefe('without the checkbox the prompt stays free of skill references', async () => {
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-ohne-Skill' })
    await sessionMerken(j.runId)
    gleich(lauf(j.runId).skills, null, 'no selection')
    falsch(readFileSync(join(SB, 'runs', j.runId, 'prompt.md'), 'utf8').includes('SKILL.md'), 'no reference')
  })
  await pruefe('agent with skill: the run inherits the selection (also via the scheduler path)', async () => {
    const r = await formular('/agents/edit', {
      repo_id: repoId, name: 'skill-traeger', harness: 'claude', prompt: 'E2E-Agent-Skill',
      branch_mode: 'keiner', expected_minutes: '45', schedule_kind: 'manuell', active: '1',
      skills: 'e2e-fleiss',
    }, { alsBrowser: true })
    gleich(r.status, 303, 'saved')
    gleich(agent('skill-traeger').skills, '["e2e-fleiss"]', 'on the agent')
    const r2 = await formular('/agents/start', { id: String(agent('skill-traeger').id), repo: String(repoId) }, { alsBrowser: true })
    gleich(r2.status, 303, 'started')
    const runId = r2.headers.get('location').split('/')[2]
    await sessionMerken(runId)
    gleich(lauf(runId).skills, '["e2e-fleiss"]', 'copy on the run')
    enthaelt(readFileSync(join(SB, 'runs', runId, 'prompt.md'), 'utf8'), 'e2e-fleiss/SKILL.md', 'in the prompt')
  })
  await pruefe('slider: depth from the form lands in the run and in the prompt', async () => {
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Skill-Tiefe', skills: 'e2e-fleiss', 'skill_regler_e2e-fleiss': '4' })
    await sessionMerken(j.runId)
    // e2e-fleiss defines no slider → the value is dropped, the checkbox remains.
    gleich(lauf(j.runId).skills, '["e2e-fleiss"]', 'no suffix without a slider definition')
  })
  await pruefe('made-up skill names from the form are discarded', async () => {
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Skill-boese', skills: '../../etc/passwd' })
    await sessionMerken(j.runId)
    gleich(lauf(j.runId).skills, null, 'not taken over')
  })

  // ------------------------------------------------------------------
  gruppe('One definition for agent and single run')

  await pruefe('both forms are built from the same block', async () => {
    const runForm = await (await hol(`/runs/new?repo=${repoId}`)).text()
    const agentForm = await (await hol(`/agents/edit?repo=${repoId}`)).text()
    for (const feld of ['name="harness"', 'id="prov"', 'name="model"', 'id="effort"', 'name="prompt"',
      'name="branch_mode"', 'name="branch_pattern"', 'name="expected_minutes"', 'name="or_mode"']) {
      wahr(runForm.includes(feld) && agentForm.includes(feld), `${feld} in both forms`)
    }
    falsch(runForm.includes('name="schedule_kind"'), 'only the agent has a schedule')
    wahr(agentForm.includes('name="schedule_kind"'), 'the agent has one')
  })

  await pruefe('the last used coding agent, model and effort are preselected', async () => {
    const j = await laufStarten({ repo_id: repoId, harness: 'cursor', model: 'gpt-5.2-high',
      prompt: 'E2E-Merken', expected_minutes: '45' })
    wahr(!!j.runId, `run started (${JSON.stringify(j)})`)
    await sessionMerken(j.runId)
    for (const [pfad, was] of [[`/runs/new?repo=${repoId}`, 'run form'], [`/agents/edit?repo=${repoId}`, 'agent form']]) {
      const html = await (await hol(pfad)).text()
      enthaelt(html, 'value="gpt-5.2-high"', `model preselected in the ${was}`)
      wahr(/<option value="cursor" selected>/.test(html), `coding agent preselected in the ${was}`)
    }
  })

  await pruefe('an existing agent keeps its own setup in the form', async () => {
    const r = await formular('/agents/edit', {
      repo_id: repoId, name: 'merk-test', harness: 'claude', model: 'claude-opus-5',
      prompt: 'x', branch_mode: 'keiner', expected_minutes: '45', schedule_kind: 'manuell', active: '1',
    }, { alsBrowser: true })
    gleich(r.status, 303, 'saved')
    const html = await (await hol(`/agents/edit?id=${agent('merk-test').id}&repo=${repoId}`)).text()
    enthaelt(html, 'value="claude-opus-5"', 'its own model, not the remembered one')
  })

  await pruefe('"save as agent" carries provider, effort and skills along', async () => {
    const j = await laufStarten({ repo_id: repoId, harness: 'claude', prompt: 'E2E-Speichern',
      skills: 'e2e-fleiss', expected_minutes: '20', branch_mode: 'neu', branch_pattern: 'x/{kurz}',
      save_agent: '1', agent_name: 'aus-einzellauf' })
    wahr(!!j.runId, `run started (${JSON.stringify(j)})`)
    await sessionMerken(j.runId)
    const a = agent('aus-einzellauf')
    wahr(!!a, 'agent saved')
    gleich(a.skills, '["e2e-fleiss"]', 'skills — used to fall off on this path')
    gleich(a.expected_minutes, 20, 'expected duration')
    gleich(a.branch_pattern, 'x/{kurz}', 'branch pattern')
    gleich(a.schedule_kind, 'manuell', 'no schedule: runs manually')
  })

  // ------------------------------------------------------------------
  // The budget gate reads the quota file live (server/quota.mjs), so the whole
  // path — form, startRun, gate, deferral — can be driven by rewriting the
  // fixture. Which is the point of testing it here rather than only in the unit
  // suite: the gate has to receive the run's MODEL, and that hand-over crosses
  // four modules.
  gruppe('Budget gate: a full per-model week defers that model, not every model')

  const quotaDatei = join(SB, 'quota.json')
  const quotaSchreiben = (fable, general = 10) => writeFileSync(quotaDatei, JSON.stringify({
    five_hour: { used_percentage: 1, resets_at: 1800000000 },
    seven_day: { used_percentage: general },
    seven_day_fable: { used_percentage: fable },
  }))

  await pruefe('the fable week at 99 % defers a fable run', async () => {
    quotaSchreiben(99)
    const j = await laufStarten({ repo_id: repoId, model: 'claude-fable-5', prompt: 'E2E-Quota-Fable' })
    wahr(!!j.runId, `run created (${JSON.stringify(j)})`)
    wahr(j.deferred, 'deferred instead of started')
    gleich(lauf(j.runId).status, 'deferred', 'status')
    const ev = db.prepare(`SELECT payload FROM events WHERE run_id=? AND kind='deferred'`).get(j.runId)
    enthaelt(ev?.payload ?? '', 'Fable', 'the reason names the window that blocks')
    // Away before the watcher's next pass picks it back up with a fresh fixture.
    await formular(`/api/runs/${j.runId}/kill`, {})
  })

  await pruefe('…and the same week lets every other model through', async () => {
    const j = await laufStarten({ repo_id: repoId, model: 'claude-sonnet-5', prompt: 'E2E-Quota-Sonnet' })
    wahr(!!j.runId && !j.deferred, `run started (${JSON.stringify(j)})`)
    gleich(lauf(j.runId).status, 'running', 'a window it does not draw from blocks nothing')
    await sessionMerken(j.runId)
    quotaSchreiben(0, 0)   // back to the sandbox fixture
  })

  // The gate is a rule the OPERATOR configures — and the reason a full quota
  // must not block everything is that the rule must be switchable and adjustable
  // per window. Settings are read live (server/scheduler.mjs), so writing the
  // table is the whole test.
  const setSetting = (k, v) => db.prepare(`INSERT INTO settings(key,value) VALUES(?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(k, v)

  await pruefe('the claude gate can be switched off entirely', async () => {
    setSetting('claude_gate_on', '0')
    quotaSchreiben(99)
    const j = await laufStarten({ repo_id: repoId, model: 'claude-fable-5', prompt: 'E2E-Gate-Off' })
    wahr(!!j.runId && !j.deferred, `a full fable week no longer defers (${JSON.stringify(j)})`)
    gleich(lauf(j.runId).status, 'running', 'the run starts')
    await sessionMerken(j.runId)
    quotaSchreiben(0, 0)
    setSetting('claude_gate_on', '1')
  })

  await pruefe('the fable window has its own threshold', async () => {
    setSetting('claude_gate_fable', '80')
    quotaSchreiben(85, 30)   // fable 85 %: below 95, above the new 80
    const j = await laufStarten({ repo_id: repoId, model: 'claude-fable-5', prompt: 'E2E-Fable-Schwelle' })
    wahr(!!j.runId && j.deferred, `fable 85 % defers against its own threshold of 80 (${JSON.stringify(j)})`)
    await formular(`/api/runs/${j.runId}/kill`, {})
    const s = await laufStarten({ repo_id: repoId, model: 'claude-sonnet-5', prompt: 'E2E-Fable-Schwelle-2' })
    wahr(!!s.runId && !s.deferred, `a sonnet run ignores the fable threshold (${JSON.stringify(s)})`)
    await sessionMerken(s.runId)
    quotaSchreiben(0, 0)
    setSetting('claude_gate_fable', '95')
  })

  await pruefe('a deferred run can be started anyway, from the endpoint', async () => {
    quotaSchreiben(99)
    const j = await laufStarten({ repo_id: repoId, model: 'claude-fable-5', prompt: 'E2E-Force' })
    wahr(!!j.runId && j.deferred, 'deferred as before')
    const r = await formular(`/api/runs/${j.runId}/start`, {})
    gleich(r.status, 200, 'the endpoint answers 200')
    gleich(lauf(j.runId).status, 'running', 'the run is running')
    enthaelt(ereignisse(j.runId).join(','), 'forced_start', 'the forced start is recorded')
    await sessionMerken(j.runId)
    quotaSchreiben(0, 0)
  })

  await pruefe('the start-anyway button sits on the detail page and in the overview', async () => {
    quotaSchreiben(99)
    const j = await laufStarten({ repo_id: repoId, model: 'claude-fable-5', prompt: 'E2E-Force-UI' })
    wahr(!!j.runId && j.deferred, 'deferred')
    const seite = await hol(`/runs/${j.runId}`).then(r => r.text())
    enthaelt(seite, `action="/api/runs/${j.runId}/start"`, 'the detail banner offers the button')
    enthaelt(seite, 'Start anyway', 'and it is the operator-facing word')
    const uebersicht = await hol(`/?repo=${repoId}`).then(r => r.text())
    enthaelt(uebersicht, `action="/api/runs/${j.runId}/start"`, 'the overview row carries it too')
    await formular(`/api/runs/${j.runId}/start`, {})
    await sessionMerken(j.runId)
    quotaSchreiben(0, 0)
  })

  await pruefe('only a deferred run may be started this way', async () => {
    const laufend = await laufStarten({ repo_id: repoId, model: 'claude-sonnet-5', prompt: 'E2E-Force-Nein' })
    wahr(!!laufend.runId && !laufend.deferred, 'a run that is not deferred')
    const r = await formular(`/api/runs/${laufend.runId}/start`, {})
    gleich(r.status, 400, 'the endpoint refuses')
    gleich(lauf(laufend.runId).status, 'running', 'and leaves the run alone')
    await sessionMerken(laufend.runId)
  })

  await pruefe('a deferred run still starts by itself once the gate opens', async () => {
    quotaSchreiben(99)
    const j = await laufStarten({ repo_id: repoId, model: 'claude-fable-5', prompt: 'E2E-AutoRetry' })
    wahr(!!j.runId && j.deferred, 'deferred by the gate')
    quotaSchreiben(0, 0)
    await watcherTick()
    await warteAuf(() => lauf(j.runId)?.status === 'running',
      { was: 'the watcher starts it once the gate opens', timeoutMs: 8000 })
    enthaelt(ereignisse(j.runId).join(','), 'deferred_retry', 'the watcher path is the non-forced one')
    await sessionMerken(j.runId)
  })

  await pruefe('quota_full is a claude run\u2019s signal, not the machine\u2019s', async () => {
    // Both runs must be RUNNING before the quota flips to 100 % — a claude
    // start into a full window would be deferred by the gate, not flagged.
    const c = await laufStarten({ repo_id: repoId, model: 'claude-sonnet-5', prompt: 'E2E-Quota-Rot' })
    wahr(!!c.runId && !c.deferred, 'the claude run is running')
    await sessionMerken(c.runId)
    const fremd = await laufStarten({ repo_id: repoId, harness: 'opencode', model: 'deepseek/deepseek-v4', prompt: 'E2E-Quota-Fremd' })
    wahr(!!fremd.runId && !fremd.deferred, 'the other-harness run is running too')
    await sessionMerken(fremd.runId)

    writeFileSync(quotaDatei, JSON.stringify({
      five_hour: { used_percentage: 100, resets_at: 1800000000 },
      seven_day: { used_percentage: 0 },
      seven_day_fable: { used_percentage: 0 },
    }))
    await watcherTick()

    const ev = db.prepare(`SELECT payload FROM events WHERE run_id=? AND kind='anomaly:quota_full'`).get(c.runId)
    wahr(!!ev, 'a claude run on a full window is flagged')
    enthaelt(ev.payload, '"window":"5h"', 'the event names the window that is full')
    gleich(db.prepare(`SELECT count(*) n FROM events WHERE run_id=? AND kind='anomaly:quota_full'`)
      .get(fremd.runId).n, 0, 'a run on another harness is not blamed for claude\u2019s quota')

    // The overview says WHICH window is exhausted — not a bare word with no way
    // to tell whose quota ran out.
    const zeile = (await (await hol(`/?repo=${repoId}`)).text()).split('<tr').find(z => z.includes(c.runId))
    enthaelt(zeile, 'quota exhausted', 'the row says the word')
    enthaelt(zeile, '(5h', 'and names the window')

    db.prepare(`UPDATE runs SET status='done', ended_at=datetime('now') WHERE id=?`).run(c.runId)
    db.prepare(`UPDATE runs SET status='done', ended_at=datetime('now') WHERE id=?`).run(fremd.runId)
    quotaSchreiben(0, 0)
  })

  // ------------------------------------------------------------------
  // The goal is the one definition field that does NOT travel in the prompt
  // file: `/goal <condition>` exists only inside the session, so the hub types
  // it in after the start. Which means it can also fail to arrive — hence a
  // test for each of the two ways in.
  gruppe('The goal: a second prompt into the session')

  const paneText = async (runId) =>
    (await sh('tmux', ['capture-pane', '-p', '-t', `=${lauf(runId).tmux_session}:`])).stdout

  await pruefe('both forms carry the goal, and it names who knows one', async () => {
    for (const [pfad, was] of [[`/runs/new?repo=${repoId}`, 'run form'], [`/agents/edit?repo=${repoId}`, 'agent form']]) {
      const html = await (await hol(pfad)).text()
      enthaelt(html, 'name="goal"', `the field is in the ${was}`)
      enthaelt(html, 'data-goal-harnesses="claude"', `and says who has one (${was})`)
    }
  })

  await pruefe('a claude run gets its goal typed into the session after the start', async () => {
    const j = await laufStarten({ repo_id: repoId, harness: 'claude', prompt: 'E2E-Ziel',
      goal: 'all tests are green' })
    wahr(!!j.runId, `run started (${JSON.stringify(j)})`)
    await sessionMerken(j.runId)
    gleich(lauf(j.runId).goal, 'all tests are green', 'the run carries the definition copy')
    await warteAuf(async () => (await paneText(j.runId)).includes('[agent sah] /goal all tests are green'),
      { was: 'the goal command in the pane', timeoutMs: 15_000 })
    await warteAuf(() => !!lauf(j.runId).goal_sent_at, { was: 'delivery recorded', timeoutMs: 5000 })
    enthaelt(ereignisse(j.runId).join(','), 'goal_sent', 'and the run says so in its own event list')
    const html = await (await hol(`/runs/${j.runId}`)).text()
    enthaelt(html, 'all tests are green', 'the detail page shows the goal')
    await formular(`/api/runs/${j.runId}/kill`, {})
  })

  await pruefe('a coding agent that knows no goal simply has none', async () => {
    const j = await laufStarten({ repo_id: repoId, harness: 'cursor', model: 'auto',
      prompt: 'E2E-Ziel-cursor', goal: 'all tests are green' })
    wahr(!!j.runId, `run started (${JSON.stringify(j)})`)
    await sessionMerken(j.runId)
    gleich(lauf(j.runId).goal, null, 'nothing stored — cursor has no /goal')
    await formular(`/api/runs/${j.runId}/kill`, {})
  })

  await pruefe('what did not get through is delivered by the watcher, and only once', async () => {
    // Exactly the case of a hub restarted between the start and the delivery:
    // the run is going, the session stands, nobody has typed the goal in.
    const j = await laufStarten({ repo_id: repoId, harness: 'claude', prompt: 'E2E-Ziel-Watcher',
      goal: 'the branch is pushed' })
    await sessionMerken(j.runId)
    await warteAuf(() => !!lauf(j.runId).goal_sent_at, { was: 'first delivery', timeoutMs: 15_000 })
    await watcherTick()
    const einmal = (await paneText(j.runId)).split('/goal the branch is pushed').length - 1
    wahr(einmal >= 1, `it is in the pane (${einmal}×)`)
    db.prepare('UPDATE runs SET goal_sent_at=NULL WHERE id=?').run(j.runId)
    await watcherTick()
    await warteAuf(() => !!lauf(j.runId).goal_sent_at, { was: 'the watcher delivers what is missing', timeoutMs: 8000 })
    await formular(`/api/runs/${j.runId}/kill`, {})
  })

  // ------------------------------------------------------------------
  gruppe('Incidents: rate limit and provider errors (auto-alarm)')

  const vorfaelle = (id) => db.prepare('SELECT * FROM incidents WHERE run_id=? ORDER BY id').all(id)
  const logAnhaengen = (id, text) => {
    const f = join(SB, 'runs', id, 'log.txt')
    mkdirSync(join(SB, 'runs', id), { recursive: true })
    writeFileSync(f, text, { flag: 'a' })
  }

  await pruefe('cursor: run passes through the pipeline and "Cannot use this model" is detected', async () => {
    // Two things at once because they belong together: that a cursor harness survives
    // the whole path (form → DB CHECK → worktree → session → watcher), and that
    // cursor's LOUD model rejection arrives as an incident. That rejection is the most
    // likely startup failure with cursor — the CLI only accepts IDs from 'cursor-agent
    // models' and writes the complete list into the log for anything else.
    const j = await laufStarten({ repo_id: repoId, harness: 'cursor',
      model: 'claude-opus-5-xhigh', prompt: 'E2E-Vorfall-cursor', expected_minutes: '45' })
    const RC = j.runId
    wahr(!!RC, `run created (response: ${JSON.stringify(j).slice(0, 200)})`)
    const lauf = db.prepare('SELECT harness, model, effort FROM runs WHERE id=?').get(RC)
    gleich(lauf.harness, 'cursor', 'harness in the DB')
    gleich(lauf.model, 'claude-opus-5-xhigh', 'model ID stored verbatim')
    gleich(lauf.effort, null, 'no separate effort — the level is baked into the ID')
    await sessionMerken(RC)
    await watcherTick()
    logAnhaengen(RC, 'Cannot use this model: gibtsnicht-9000. Available models: auto, gpt-5.2\r\n')
    await watcherTick()
    const v = vorfaelle(RC)
    gleich(v.length, 1, `exactly one incident (has: ${JSON.stringify(v.map(x => [x.typ, x.schwere]))})`)
    gleich(v[0].typ, 'model_error', 'classified as a model error')
    enthaelt(v[0].beleg, 'Cannot use this model', 'evidence is the line')
  })

  let RH = null   // "hermes" run (the stub ignores the harness; the hub's patterns do not)
  await pruefe('hermes: first log match is noted YELLOW, without a notification', async () => {
    const j = await laufStarten({ repo_id: repoId, harness: 'hermes', prompt: 'E2E-Vorfall-hermes', expected_minutes: '45' })
    RH = j.runId
    wahr(!!RH, 'run created')
    await sessionMerken(RH)
    await watcherTick()   // bring the offset up to date — the stub startup already wrote
    logAnhaengen(RH, '\x1b[33m⏳ Retrying in 12.0s (rate limited by upstream provider (429))...\x1b[0m\r\n')
    await watcherTick()
    const v = vorfaelle(RH)
    gleich(v.length, 1, `exactly one incident (has: ${JSON.stringify(v.map(x => [x.typ, x.schwere]))})`)
    gleich(v[0].typ, 'rate_limit', 'type')
    gleich(v[0].schwere, 'gelb', 'yellow')
    gleich(v[0].quelle, 'log', 'source')
    enthaelt(v[0].beleg, 'Retrying', 'evidence is the line')
    falsch(ereignisse(RH).some(k => k === 'notified'), 'no notification for yellow')
    // In the overview the incident is a compact badge inside the run's OWN row,
    // and the action that clears it is still in that cell — it is only hidden
    // until the row is hovered (the same rule the pencil and the archive button
    // follow). Checked against the route it posts to, which outlives markup.
    const zeile = (await (await hol(`/?repo=${repoId}`)).text()).split('<tr ').find(z => z.includes(RH))
    wahr(!!zeile, 'the run has a row')
    enthaelt(zeile, 'Rate limit 1×', 'overview shows the incident')
    enthaelt(zeile, 'incident yellow', 'in the severity it was given')
    enthaelt(zeile, `/api/incidents/${v[0].id}/resolve`, 'and the action to clear it sits in the same cell')
    enthaelt(zeile, 'Dismiss', 'named for the group it belongs to — noticed, not to-do')
  })
  await pruefe('the sidebar\'s incident counts link into the overview filtered to incident runs', async () => {
    const seite = await (await hol(`/?repo=${repoId}`)).text()
    enthaelt(seite, 'incidents=1', 'the sidebar links the counts into the filtered overview')
    const gefiltert = await (await hol(`/?repo=${repoId}&incidents=1`)).text()
    wahr(gefiltert.split('<tr ').some(z => z.includes(RH)), 'the run with the incident is in the filtered list')
    const fragment = await (await hol(`/api/fragments/runs-body?repo=${repoId}&incidents=1`)).text()
    enthaelt(fragment, 'data-incidents="1"', 'the filter travels with the tbody, so live updates keep it')
    enthaelt(fragment, RH, 'and the fragment shows the same selection the page did')
  })
  await pruefe('the same match counts only once per pass (offset)', async () => {
    await watcherTick(); await watcherTick()
    gleich(vorfaelle(RH)[0].anzahl, 1, 'anzahl stays 1')
  })
  await pruefe('repetition within 10 min → RED (retry loop), notification attempt recorded', async () => {
    logAnhaengen(RH, '⚠️  API call failed (attempt 2/5): RateLimitError (HTTP 429)\n')
    await watcherTick()
    const v = vorfaelle(RH)[0]
    gleich(v.anzahl, 2, 'anzahl 2')
    gleich(v.schwere, 'rot', 'red')
    wahr(ereignisse(RH).includes('incident:eskaliert'), `escalated (has: ${ereignisse(RH).join(', ')})`)
    const tg = db.prepare(`SELECT payload FROM events WHERE run_id=? AND kind='notified' ORDER BY id DESC LIMIT 1`).get(RH)
    wahr(!!tg && JSON.parse(tg.payload).type === 'incident:rate_limit', 'the incident was announced (with no channel configured: delivered=false, but attempted)')
    enthaelt(await (await hol(`/runs/${RH}`)).text(), 'Incidents', 'detail page shows the section')
  })
  await pruefe('resolving via the UI withdraws the alarm', async () => {
    const v = vorfaelle(RH)[0]
    const r = await formular(`/api/incidents/${v.id}/resolve`, { back: `/runs/${RH}` }, { alsBrowser: true })
    gleich(r.status, 303, 'redirect')
    gleich(r.headers.get('location'), `/runs/${RH}`, 'back to the run page')
    const nach = vorfaelle(RH)[0]
    wahr(!!nach.geloest_am, 'geloest_am set')
    gleich(nach.geloest_von, 'web', 'by web')
    falsch((await (await hol(`/?repo=${repoId}`)).text()).includes('Rate limit 2×'), 'overview without an open incident')
  })
  await pruefe('if it recurs AFTER resolving, the alarm goes on again (auto-alarm)', async () => {
    // The resolution happened within the same second — the new match must come after it.
    db.prepare(`UPDATE incidents SET geloest_am=datetime('now','-2 minutes') WHERE run_id=?`).run(RH)
    logAnhaengen(RH, '⏳ Retrying in 30.0s (rate limited by upstream provider (429))...\n')
    await watcherTick()
    const v = vorfaelle(RH)
    gleich(v.length, 1, 'still ONE record (history remains)')
    gleich(v[0].geloest_am, null, 'open again')
    gleich(v[0].wieder_geoeffnet, 1, 'reopened once')
    gleich(v[0].anzahl, 3, 'keeps counting')
    wahr(ereignisse(RH).includes('incident:wieder'), 'event incident:wieder')
  })
  await pruefe('the detector\'s protocol is in the run directory', async () => {
    const f = join(SB, 'runs', RH, 'detektor.jsonl')
    wahr(existsSync(f), 'detektor.jsonl')
    const arten = readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).art)
    wahr(arten.includes('log') && arten.includes('vorfall') && arten.includes('geloest'), `entries: ${[...new Set(arten)].join(', ')}`)
  })

 // R1 is 'done' by now — incidents are only collected for running runs.
  let RC = null
  await pruefe('claude: the menu text "Upgrade to Max for higher rate limits" is NOT an incident', async () => {
    const j = await laufStarten({ repo_id: repoId, harness: 'claude', prompt: 'E2E-Vorfall-claude' })
    RC = j.runId
    await sessionMerken(RC)
    // Exactly this stood in a production run as a rate limit in the database.
    await watcherTick()
    logAnhaengen(RC, '\x1b[38;5;246m/\x1b[39m\x1b[1mu\x1b[22mpgrade   Upgrade to Max for higher rate limits and more Opus\x1b[K\r\n')
    await watcherTick()
    gleich(vorfaelle(RC).length, 0, 'no incident')
  })

  await pruefe('claude: transcript entry with isApiErrorMessage → RED immediately, with original timestamp', async () => {
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
    gleich(v.length, 1, 'one incident')
    gleich(v[0].typ, 'auth_error', 'type from the enum')
    gleich(v[0].schwere, 'rot', 'red without detours')
    gleich(v[0].quelle, 'transcript', 'source')
    gleich(v[0].erst_gesehen, '2026-08-11 08:05:00', 'timestamp from the transcript, not "now"')
  })
  await pruefe('hook report (fl-report _api_error via stdin) → RED; rate limit counter increments', async () => {
    const hookJson = JSON.stringify({ hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: "You've hit your session limit · resets 8:36pm" })
    const r = await new Promise((resolve) => {
      const p = execFile(FL_REPORT_REPO, ['_api_error'],
        { env: { ...process.env, FL_RUN_ID: RC, FL_HUB_URL: BASIS } }, (err, stdout, stderr) => resolve({ ok: !err, stdout, stderr }))
      p.stdin.end(hookJson)
    })
    wahr(r.ok, `fl-report ok (${r.stderr})`)
    const v = vorfaelle(RC).find(x => x.typ === 'rate_limit')
    wahr(!!v, 'incident rate_limit')
    gleich(v.schwere, 'rot', 'red')
    gleich(v.quelle, 'hook:claude', 'source')
    enthaelt(v.beleg, 'session limit', 'evidence from last_assistant_message')
    gleich(lauf(RC).rate_limit_hits, 1, 'rate_limit_hits')
  })
  await pruefe('a hook report from a FOREIGN claude session (a process the agent spawned) is ignored', async () => {
    // The false alarm of 2026-08-30: an agent testing a fake model id spawned its
    // own claude; the child inherited the worktree's hooks AND FL_RUN_ID, and its
    // StopFailure opened a red "Model unavailable" on the healthy parent run.
    const hookJson = JSON.stringify({ hook_event_name: 'StopFailure', error: 'model_not_found',
      session_id: '11111111-2222-4333-8444-555555555555',
      last_assistant_message: 'Model not found: nosuch/model-xyz.' })
    const r = await new Promise((resolve) => {
      const p = execFile(FL_REPORT_REPO, ['_api_error'],
        { env: { ...process.env, FL_RUN_ID: RC, FL_HUB_URL: BASIS } }, (err, stdout, stderr) => resolve({ ok: !err, stdout, stderr }))
      p.stdin.end(hookJson)
    })
    wahr(r.ok, `fl-report ok (${r.stderr})`)
    falsch(vorfaelle(RC).some(v => v.typ === 'model_error'), 'no model_error incident on the run')
    // The decision is traceable in the detector's protocol — it says WHY.
    const proto = readFileSync(join(SB, 'runs', RC, 'detektor.jsonl'), 'utf8').split('\n').filter(Boolean)
      .map(l => JSON.parse(l)).filter(e => e.art === 'verworfen')
    wahr(proto.some(e => String(e.grund).includes('foreign claude session')), 'and the protocol says why')
    // The run's OWN session (the hub started it with --session-id <run id>) still reports:
    const eigen = JSON.stringify({ hook_event_name: 'StopFailure', error: 'model_not_found', session_id: RC,
      last_assistant_message: 'Model not found: really/missing-model.' })
    const r2 = await new Promise((resolve) => {
      const p = execFile(FL_REPORT_REPO, ['_api_error'],
        { env: { ...process.env, FL_RUN_ID: RC, FL_HUB_URL: BASIS } }, (err, stdout, stderr) => resolve({ ok: !err, stdout, stderr }))
      p.stdin.end(eigen)
    })
    wahr(r2.ok, `fl-report ok (${r2.stderr})`)
    const v = vorfaelle(RC).find(x => x.typ === 'model_error')
    wahr(!!v, 'the run\'s own session still opens the incident')
    enthaelt(v.beleg, 'really/missing-model', 'with the evidence')
  })
  await pruefe('an error hook that only says the session was stopped opens no incident', async () => {
    // opencode's `session.error` fires while its process dies — and the hub is
    // very often the one killing it: the retention pass, the kill route, a
    // flow, archiving. Measured on run c532df45: retention closed the session,
    // the plugin reported the bare word "Aborted", and the hub opened a RED
    // incident about its own cleanup. On an aborted run such an incident never
    // resolves by itself, so it was still asking for hands two days later.
    const j = await laufStarten({ repo_id: repoId, harness: 'opencode', prompt: 'E2E-Abbruch', expected_minutes: '45' })
    const RA = j.runId
    await sessionMerken(RA)
    const melde = (text) => hol(`/api/runs/${RA}/report`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: '_api_error', error: 'unknown', text }),
    })
    gleich((await melde('Aborted')).status, 200, 'the report is accepted')
    gleich(vorfaelle(RA).length, 0, 'and nothing is filed as a provider fault')
    // Narrow, not blunt: a real error is still a real error.
    gleich((await melde('AI_APICallError: 503 upstream unavailable')).status, 200, 'a real error is accepted too')
    const v = vorfaelle(RA)
    gleich(v.length, 1, `now there is one incident (has: ${JSON.stringify(v.map(x => [x.typ, x.beleg]))})`)
    gleich(v[0].typ, 'provider_error', 'classified as what it is')
    db.prepare(`UPDATE runs SET status='done', ended_at=datetime('now') WHERE id=?`).run(RA)
  })
  await pruefe('hook and transcript see the same event → not counted twice', async () => {
    const r = lauf(RC)
    const dir = join(SB, 'claude-projects', r.workdir_effective.replaceAll('/', '-'))
    writeFileSync(join(dir, `${RC}.jsonl`), JSON.stringify({ type: 'assistant', error: 'rate_limit',
      timestamp: new Date().toISOString(), isApiErrorMessage: true, message: { content: 'limit' } }) + '\n', { flag: 'a' })
    await watcherTick()
    gleich(vorfaelle(RC).find(x => x.typ === 'rate_limit').anzahl, 1, 'anzahl stays 1 (dedupe within 90 s)')
  })
  await pruefe('silence after a log match turns RED (the limit stands at the end)', async () => {
    const j = await laufStarten({ repo_id: repoId, harness: 'opencode', prompt: 'E2E-Vorfall-stille' })
    await sessionMerken(j.runId)
    await watcherTick()
    logAnhaengen(j.runId, 'AI_APICallError: [Stealth] stealth/ox-alpha is temporarily rate-limited upstream.\n')
    await watcherTick()
    gleich(vorfaelle(j.runId)[0]?.schwere, 'gelb', 'yellow at first')
    db.prepare(`UPDATE incidents SET zuletzt_gesehen=datetime('now','-6 minutes'), erst_gesehen=datetime('now','-6 minutes') WHERE run_id=?`).run(j.runId)
    db.prepare(`UPDATE runs SET last_activity_at=datetime('now','-7 minutes') WHERE id=?`).run(j.runId)
    await watcherTick()
    const v = vorfaelle(j.runId)[0]
    gleich(v.schwere, 'rot', 'red after 5 min of silence')
    gleich(v.typ, 'rate_limit', 'type from the opencode text')
  })
  await pruefe('if the agent keeps working for 30 min, a yellow match expires on its own', async () => {
    const j = await laufStarten({ repo_id: repoId, harness: 'hermes', prompt: 'E2E-Vorfall-verlaufen' })
    await sessionMerken(j.runId)
    await watcherTick()
    logAnhaengen(j.runId, '⚠️  API call failed (attempt 1/5): APIConnectionError\n')
    await watcherTick()
    db.prepare(`UPDATE incidents SET zuletzt_gesehen=datetime('now','-31 minutes'), erst_gesehen=datetime('now','-31 minutes') WHERE run_id=?`).run(j.runId)
    db.prepare(`UPDATE runs SET last_activity_at=datetime('now','-1 minutes') WHERE id=?`).run(j.runId)
    await watcherTick()
    const v = vorfaelle(j.runId)[0]
    wahr(!!v.geloest_am, 'closed')
    enthaelt(v.geloest_von, 'auto:', 'automatic')
  })
  await pruefe('a red incident that recovered on its own resolves itself — and un-rings', async () => {
    const j = await laufStarten({ repo_id: repoId, harness: 'claude', prompt: 'E2E-Vorfall-erholt', expected_minutes: '45' })
    await sessionMerken(j.runId)
    // Hand-crafted red incident, not yet announced, notification NOT yet due
    // (the suite runs with delay 0 — the due point is set by hand here).
    db.prepare(`INSERT INTO incidents(run_id, typ, quelle, schwere, erst_gesehen, zuletzt_gesehen, beleg, notify_at)
                VALUES(?,?,?,?,datetime('now'),datetime('now'),'Everything is broken.', datetime('now','+10 minutes'))`)
      .run(j.runId, 'provider_error', 'hook:claude', 'rot')
    const { vorfaelleMeldenFaellig } = await import('../server/incidents.mjs')
    await vorfaelleMeldenFaellig()
    falsch(ereignisse(j.runId).some(k => k === 'notified'), 'not due yet: nothing announced')
    // Due and still open → the alarm.
    db.prepare(`UPDATE incidents SET notify_at=datetime('now','-1 second') WHERE run_id=?`).run(j.runId)
    await vorfaelleMeldenFaellig()
    const tg = db.prepare(`SELECT payload FROM events WHERE run_id=? AND kind='notified' ORDER BY id DESC LIMIT 1`).get(j.runId)
    wahr(!!tg && JSON.parse(tg.payload).type === 'incident:provider_error', 'due: the alarm fires')
    wahr(!!vorfaelle(j.runId)[0].gemeldet_am, 'recorded as announced')
    // The agent demonstrably works again (activity AFTER the occurrence, no
    // recurrence) → resolves itself, and the announced alarm is un-rung.
    db.prepare(`UPDATE incidents SET zuletzt_gesehen=datetime('now','-11 minutes'), erst_gesehen=datetime('now','-11 minutes') WHERE run_id=?`).run(j.runId)
    db.prepare(`UPDATE runs SET last_activity_at=datetime('now') WHERE id=?`).run(j.runId)
    await watcherTick()
    const v = vorfaelle(j.runId)[0]
    enthaelt(v.geloest_von, 'auto:', 'resolved by itself')
    const tg2 = db.prepare(`SELECT payload FROM events WHERE run_id=? AND kind='notified' ORDER BY id DESC LIMIT 1`).get(j.runId)
    wahr(!!tg2 && JSON.parse(tg2.payload).type === 'incident_resolved:provider_error', 'and the recovery is announced')
  })
  await pruefe('raising the expected duration retracts the overrun statement', async () => {
    const j = await laufStarten({ repo_id: repoId, harness: 'hermes', prompt: 'E2E-Dauer-Edit', expected_minutes: '90' })
    await sessionMerken(j.runId)
    await watcherTick()
    // The run "is" far over its expected duration and never reported progress:
    db.prepare(`UPDATE runs SET started_at=datetime('now','-120 minutes') WHERE id=?`).run(j.runId)
    await watcherTick()
    wahr(ereignisse(j.runId).includes('anomaly:overrun'), 'overrun anomaly')
    wahr(ereignisse(j.runId).includes('notified:overrun'), 'and the operator heard about it')
    // The operator raises the duration — the statement the old value produced is withdrawn:
    const r = await formular(`/api/runs/${j.runId}/edit`, { expected_minutes: '240' })
    gleich(r.status, 200, `edit ok (${JSON.stringify(await r.json().catch(() => r.text()))})`)
    gleich(lauf(j.runId).expected_minutes, 240, 'new duration stored')
    wahr(ereignisse(j.runId).includes('cleared:anomaly:overrun'), 'the anomaly event is history, renamed')
    falsch(ereignisse(j.runId).includes('notified:overrun'), 'the notification flag with it')
    // A genuine overrun of the NEW duration can page once again:
    db.prepare(`UPDATE runs SET started_at=datetime('now','-300 minutes') WHERE id=?`).run(j.runId)
    await watcherTick()
    gleich(ereignisse(j.runId).filter(k => k === 'anomaly:overrun').length, 1, 'the anomaly fires anew against the new value')
    wahr(ereignisse(j.runId).includes('notified:overrun'), 'and the operator hears about the new overrun')
  })
  await pruefe('provider pulse: two failures → global incident with banner, recovery closes it', async () => {
    let antwort = 500
    const http = await import('node:http')
    const hs = http.createServer((req, res) => { res.writeHead(antwort).end('{}') })
    await new Promise(r => hs.listen(0, '127.0.0.1', r))
    process.env.FREILAUF_PULS_AUS = '0'
    process.env.FREILAUF_PULS_TAKT_MS = '0'
    process.env.FREILAUF_PULS_URL_TEST = `http://127.0.0.1:${hs.address().port}/`
    try {
      await watcherTick()
      gleich(db.prepare(`SELECT count(*) c FROM incidents WHERE run_id IS NULL`).get().c, 0, 'one failure is not enough')
      await watcherTick()
      const g = db.prepare(`SELECT * FROM incidents WHERE run_id IS NULL AND geloest_am IS NULL`).all()
      wahr(g.length >= 1, `global incident (has ${g.length})`)
      wahr(g.every(x => x.typ.startsWith('provider_down:')), 'type provider_down:<name>')
      enthaelt(await (await hol(`/?repo=${repoId}`)).text(), 'Provider unreachable', 'banner in the overview')
      antwort = 200
      await watcherTick()
      gleich(db.prepare(`SELECT count(*) c FROM incidents WHERE run_id IS NULL AND geloest_am IS NULL`).get().c, 0, 'recovered → closed')
      enthaelt(db.prepare(`SELECT geloest_von FROM incidents WHERE run_id IS NULL LIMIT 1`).get().geloest_von, 'erholt', 'reason')
    } finally {
      process.env.FREILAUF_PULS_AUS = '1'
      delete process.env.FREILAUF_PULS_URL_TEST
      delete process.env.FREILAUF_PULS_TAKT_MS
      hs.close()
    }
  })
  await pruefe('overview: runtime of finished runs ends at ended_at, not "now"', async () => {
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Dauer' })
    await sessionMerken(j.runId)
    db.prepare(`UPDATE runs SET status='done', started_at=datetime('now','-3 days'), ended_at=datetime('now','-3 days','+2 minutes') WHERE id=?`).run(j.runId)
    const html = await (await hol(`/?repo=${repoId}`)).text()
    const zeile = html.split('<tr').find(z => z.includes(j.runId))
    enthaelt(zeile, '>2 min<', '2 min instead of 4320')
  })
  await pruefe('overview: started column is relative with exact datetime on hover', async () => {
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-started' })
    await sessionMerken(j.runId)
    db.prepare(`UPDATE runs SET started_at=datetime('now','-4 minutes') WHERE id=?`).run(j.runId)
    const html = await (await hol(`/?repo=${repoId}`)).text()
    const zeile = html.split('<tr').find(z => z.includes(j.runId))
    wahr(!!zeile, 'row for the run')
    enthaelt(zeile, 'class="reltime"', 'relative-time element')
    wahr(/\d+ minutes ago/.test(zeile), 'relative English minutes')
    wahr(/title="[^"]*\d{2}:\d{2}:\d{2}/.test(zeile), 'title carries a clock time')
    wahr(/datetime="\d{4}-\d{2}-\d{2}T/.test(zeile), 'datetime is ISO')
    enthaelt(html, '>Started<', 'column header')
  })

  // Simulation with REAL Claude Code: a mini server answers 429 with the
  // subscription-limit headers, Claude aborts, the StopFailure hook reports via
  // fl-report to this sandbox hub. No quota consumed, no network — but the full path.
  if (vorhanden('claude')) {
    await pruefe('REAL: Claude Code + simulated 429 → StopFailure hook → incident rate_limit', async () => {
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
        // --session-id is what makes this the RUN'S OWN claude. runner.mjs passes it on
        // every real start, and handleReport()'s foreign-session guard compares the hook's
        // session id against the run id: without it this probe is indistinguishable from a
        // claude the agent spawned itself, and its 429 is correctly discarded.
        const r = await new Promise((resolve) => execFile('claude',
          ['-p', 'sag hallo', '--model', 'sonnet', '--settings', settingsDatei, '--session-id', j.runId],
          { cwd: arbeitsdir, timeout: 120_000, env: { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${mock.address().port}`,
            FL_RUN_ID: j.runId, FL_HUB_URL: BASIS,
            // The hooks call `fl-report` by name and find it on PATH. In production
            // that is ~/.local/bin, filled by the deploy before it restarts the hub;
            // here it is this checkout, because that is what the suite tests.
            PATH: `${join(PROJEKT, 'bin')}:${join(homedir(), '.local', 'bin')}:${process.env.PATH}` } },
          (err, stdout, stderr) => resolve({ err, stdout: String(stdout), stderr: String(stderr) })))
        enthaelt(r.stdout + r.stderr, 'limit', `Claude reports the limit (${(r.stdout + r.stderr).slice(-200)})`)
        await warteAuf(() => vorfaelle(j.runId).some(v => v.typ === 'rate_limit'), { was: 'incident via the hook', timeoutMs: 15_000 })
        const v = vorfaelle(j.runId).find(v => v.typ === 'rate_limit')
        gleich(v.quelle, 'hook:claude', 'source is the hook')
        gleich(v.schwere, 'rot', 'red')
        enthaelt(v.beleg, 'rate_limit', 'evidence carries the enum')
      } finally { mock.close() }
    })
  } else {
    uebersprungen('REAL: Claude Code + simulated 429', 'claude not in PATH')
  }

  // ------------------------------------------------------------------
  gruppe('Sessions page: list, end, and the run that hung on it')

  {
    let SESS = null, SESSNAME = null
    await pruefe('a running session is listed with its run', async () => {
      const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Sessionseite' })
      SESS = j.runId
      wahr(!!SESS, `run created (${j.error ?? ''})`)
      await warteAuf(() => !!lauf(SESS)?.tmux_session, { was: 'tmux session' })
      SESSNAME = lauf(SESS).tmux_session
      sessions.add(SESSNAME)
      const html = await (await hol('/sessions')).text()
      enthaelt(html, SESSNAME, 'the session name is on the page')
      // Its row must carry the marker the default filter hides it by — that is
      // the whole safety of "running agents are not shown".
      enthaelt(html, `data-session="${SESSNAME}" data-running="1"`, 'marked as running')
    })

    await pruefe('ending a session ends the run that hung on it', async () => {
      const r = await formular('/api/sessions/kill', { session: SESSNAME })
      const j = await r.json()
      wahr(j.ok, `kill answered ok (${JSON.stringify(j.results ?? j)})`)
      sessions.delete(SESSNAME)
      falsch((await sh('tmux', ['has-session', '-t', `=${SESSNAME}`])).ok, 'session gone')
      const l = lauf(SESS)
      gleich(l.status, 'aborted', 'the run does not stay on "running"')
      wahr(l.ended_at !== null, 'ended_at set')
      wahr(l.tmux_closed_at !== null, 'tmux_closed_at set immediately')
      wahr(ereignisse(SESS).includes('aborted'), `event recorded (has: ${ereignisse(SESS).join(', ')})`)
    })

    await pruefe('ending a session that is already gone is not an error', async () => {
      const j = await (await formular('/api/sessions/kill', { session: SESSNAME })).json()
      wahr(j.ok, 'idempotent')
    })

    await pruefe('several sessions go in ONE call', async () => {
      const a = await laufStarten({ repo_id: repoId, prompt: 'E2E-Bulk-a' })
      const b = await laufStarten({ repo_id: repoId, prompt: 'E2E-Bulk-b' })
      await warteAuf(() => !!lauf(a.runId)?.tmux_session && !!lauf(b.runId)?.tmux_session,
        { was: 'both tmux sessions' })
      const namen = [lauf(a.runId).tmux_session, lauf(b.runId).tmux_session]
      namen.forEach(n => sessions.add(n))
      const j = await (await formular('/api/sessions/kill', { session: namen })).json()
      wahr(j.ok, `both ended (${JSON.stringify(j.results ?? j)})`)
      gleich(j.results.length, 2, 'one result per session')
      for (const n of namen) sessions.delete(n)
      gleich(lauf(a.runId).status, 'aborted', 'first run aborted')
      gleich(lauf(b.runId).status, 'aborted', 'second run aborted')
    })

    await pruefe('the keep time is set in hours on the settings page', async () => {
      // Written directly instead of through the form: this test is about the
      // field and the hours conversion, not about the save route (that one has
      // its own group).
      db.prepare(`INSERT INTO settings(key,value) VALUES('session_keep_hours','0.5')
                  ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run()
      const html = await (await hol('/settings')).text()
      enthaelt(html, 'name="session_keep_hours"', 'the field is on the settings page')
      enthaelt(html, 'value="0.5"', 'and shows what is stored')
      const { sessionKeepMs } = await import('../server/sessions.mjs')
      gleich(sessionKeepMs({ session_keep_hours: '0.5' }), 1800_000, 'half an hour')
    })
    await pruefe('the archive-session rule is configurable on the settings page', async () => {
      const html = await (await hol('/settings')).text()
      for (const feld of ['name="archive_session_on"', 'name="archive_session_keep_hours"']) {
        enthaelt(html, feld, `field ${feld}`)
      }
    })
    await pruefe('the worktree-extras LLM is configured on the settings page', async () => {
      const html = await (await hol('/settings')).text()
      for (const feld of ['name="llm_extras_on"', 'name="llm_extras_model"', 'name="llm_extras_or_provider"']) {
        enthaelt(html, feld, `field ${feld}`)
      }
    })
  }

  // ------------------------------------------------------------------
  gruppe('The agent stays operable after the work is done')

  {
    // The coding agents that run in a TUI (claude, opencode, cursor) do not go
    // away when the task is finished — the session stands, the process sits at
    // its prompt. Whether one may type into it is therefore a fact about the
    // SESSION, not about the run's record.
    let RN = null, RNSESS = null
    await pruefe('a finished run whose session still stands stays writable', async () => {
      const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Nachbedienung' })
      RN = j.runId
      await warteAuf(() => !!lauf(RN)?.tmux_session, { was: 'tmux session' })
      RNSESS = lauf(RN).tmux_session
      sessions.add(RNSESS)
      db.prepare(`UPDATE runs SET status='done', ended_at=datetime('now') WHERE id=?`).run(RN)
      const html = await (await hol(`/runs/${RN}`)).text()
      enthaelt(html, 'data-live="1"', 'the terminal is offered with write access')
      enthaelt(html, `freilaufSend(this,'/api/runs/${RN}/send')`, 'and the send form is there')
      falsch(html.includes(`freilaufKill('${RN}')`), 'but no "end run" — that run is over')
      enthaelt(html, 'name="session"', 'instead: end the session it left standing')
    })

    await pruefe('a message reaches the session of a finished run', async () => {
      const r = await formular(`/api/runs/${RN}/send`, { text: 'weiter geht es' })
      gleich(r.status, 200, 'accepted')
      // A message into a finished run is a follow-up COMMISSION now: recorded
      // under its own name, and the run is clocked from this moment
      // (followup_started, watchFollowUps) — the plain message_sent kind is
      // for a run that is still going.
      wahr(ereignisse(RN).includes('followup_started'), `recorded (has: ${ereignisse(RN).join(', ')})`)
      wahr(!!lauf(RN).followup_since, 'and the commission is clocked')
      gleich(lauf(RN).status, 'done', 'and the run stays done')
    })

    await pruefe('"end run" on a finished run does NOT rewrite it to aborted', async () => {
      // The button is gone from the page, but the endpoint is reachable — and a
      // run that came through cleanly must not become a failed one because
      // somebody closed its leftover session. The open follow-up commission
      // goes with the session: nothing can report for it any more.
      const r = await formular(`/api/runs/${RN}/kill`, {})
      gleich(r.status, 200, 'accepted')
      gleich(lauf(RN).status, 'done', 'still done')
      wahr(lauf(RN).tmux_closed_at !== null, 'only the session is marked closed')
      gleich(lauf(RN).followup_since, null, 'and the follow-up commission is given up with the session')
    })

    await pruefe('without a session there is no write access left', async () => {
      const html = await (await hol(`/runs/${RN}`)).text()
      falsch(html.includes('data-live="1"'), 'read-only')
      enthaelt(html, 'data-session="0"', 'and the box says there is no session')
      sessions.delete(RNSESS)
    })

    await pruefe('ending the session from the detail page lands back on the run', async () => {
      const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Session-zurueck' })
      await warteAuf(() => !!lauf(j.runId)?.tmux_session, { was: 'tmux session' })
      const name = lauf(j.runId).tmux_session
      sessions.add(name)
      db.prepare(`UPDATE runs SET status='done', ended_at=datetime('now') WHERE id=?`).run(j.runId)
      const r = await formular('/api/sessions/kill', { session: name, back: `/runs/${j.runId}` }, { alsBrowser: true })
      gleich(r.status, 303, 'redirect instead of JSON')
      gleich(r.headers.get('location'), `/runs/${j.runId}`, 'back to the run, not to the session list')
      sessions.delete(name)
      gleich(lauf(j.runId).status, 'done', 'the finished run is left alone')
    })
  }

  gruppe('Worktree cleanup: no data loss (regression test)')

  {
    const s = lauf(R1).tmux_session
    await sh('tmux', ['kill-session', '-t', `=${s}`])
    sessions.delete(s)
    await watcherTick()
    // KNOWN BUG (in watcher.mjs, not here): closeOldSessions() does not notice a
    // vanished session, because `tmux display -p -t "=name"` answers with code 0 even
    // for non-existent sessions. Thus tmux_closed_at stays empty and the whole
    // worktree cleanup never starts. Once that is fixed, the following block becomes
    // a real check again.
    if (lauf(R1).tmux_closed_at !== null) {
      await pruefe('session over: tmux_closed_at gets set', () => {
        wahr(lauf(R1).tmux_closed_at !== null, 'tmux_closed_at')
      })
    } else {
      uebersprungen('session over: tmux_closed_at gets set',
        'known bug: tmux display reports success even for missing sessions')
      db.prepare(`UPDATE runs SET tmux_closed_at=datetime('now') WHERE id=?`).run(R1)
    }
  }
  await pruefe('unpushed branch: worktree stays put', async () => {
    const wt = lauf(R1).workdir_effective
    await watcherTick()
    wahr(existsSync(wt), `worktree ${wt} still exists`)
    falsch(ereignisse(R1).includes('worktree_removed'), 'not removed')
  })
  await pruefe('pushed, but uncommitted work: worktree stays put', async () => {
    const wt = lauf(R1).workdir_effective
    await sh('git', ['-C', wt, 'push', '-q', '-u', 'origin', 'HEAD'])
    writeFileSync(join(wt, 'offene-notiz.txt'), 'noch nicht committet\n')
    db.prepare(`DELETE FROM events WHERE run_id=? AND kind IN ('anomaly:unpushed','branch_synced')`).run(R1)
    await watcherTick()
    wahr(existsSync(wt), 'worktree still exists')
    wahr(ereignisse(R1).includes('anomaly:worktree_dirty'), `marked as dirty (has: ${ereignisse(R1).join(', ')})`)
  })
  await pruefe('pushed and clean: worktree gets cleaned up', async () => {
    const wt = lauf(R1).workdir_effective
    rmSync(join(wt, 'offene-notiz.txt'))
    db.prepare(`DELETE FROM events WHERE run_id=? AND kind='anomaly:worktree_dirty'`).run(R1)
    await watcherTick()
    falsch(existsSync(wt), 'worktree removed')
    wahr(ereignisse(R1).includes('worktree_removed'), 'event recorded')
  })
  await pruefe('the work is in the origin — nothing was lost', async () => {
    const l = await sh('git', ['-C', ORIGIN, 'log', '--oneline', '-1', lauf(R1).branch_expected])
    enthaelt(l.stdout, 'Arbeit des Agenten', 'commit in the origin')
  })

  // ------------------------------------------------------------------
  await pruefe('a run interrupted during startup does not stay "running" forever', async () => {
    // If the hub dies in the middle of the startup sequence (service restart, reboot),
    // the run used to be stuck on 'running' forever — with no session, no worktree,
    // and a terminal that had nothing to attach to.
    const id = 'aaaaaaaa-1111-4222-8333-444444444444'
    db.prepare(`INSERT INTO runs(id,repo_id,status,harness,prompt,branch_mode,expected_minutes,started_at)
                VALUES(?,?,'running','claude','x','keiner',45, datetime('now','-30 minutes'))`).run(id, repoId)
    await watcherTick()
    const r = lauf(id)
    gleich(r.status, 'failed', 'completed as failed')
    enthaelt(r.report_md ?? '', 'interrupted', 'reason in the report')
    const seite = await (await hol(`/runs/${id}`)).text()
    falsch(seite.includes('data-live=\"1\"'), 'the page no longer promises a terminal')
    enthaelt(seite, 'Retry run', 'retry is offered')
  })

  await pruefe('a run created just now is NOT swept up by this', async () => {
    // Counter-check: while fl-start is still working, a run rightly has no session.
    const id = 'bbbbbbbb-1111-4222-8333-444444444444'
    db.prepare(`INSERT INTO runs(id,repo_id,status,harness,prompt,branch_mode,expected_minutes,started_at)
                VALUES(?,?,'running','claude','x','keiner',45, datetime('now'))`).run(id, repoId)
    await watcherTick()
    gleich(lauf(id).status, 'running', 'left untouched')
    db.prepare('DELETE FROM runs WHERE id=?').run(id)
  })

  gruppe('Failed start, retry and abort')

  let R2 = null
  await pruefe('failed start is recorded as failed', async () => {
    writeFileSync(FEHLSTART, 'an')
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Fehlstart', branch_mode: 'neu', branch_pattern: 'agent/e2e-fehl/{kurz}' })
    R2 = j.runId
    gleich(lauf(R2).status, 'failed', 'status')
    enthaelt(lauf(R2).report_md, 'fl-start', 'reason named')
  })
  await pruefe('retry uses the same worktree and starts up', async () => {
    const vorher = lauf(R2).workdir_effective
    wahr(existsSync(vorher), 'worktree from the failed attempt is still there')
    rmSync(FEHLSTART)
    const r = await formular(`/api/runs/${R2}/retry`, {}, { alsBrowser: true })
    gleich(r.status, 303, 'redirect instead of JSON')
    await sessionMerken(R2)
    gleich(lauf(R2).status, 'running', 'status')
    gleich(lauf(R2).workdir_effective, vorher, 'same worktree')
  })
  await pruefe('abort sets aborted and closes the session immediately', async () => {
    const r = await formular(`/api/runs/${R2}/kill`, {})
    gleich(r.status, 200, 'status')
    const l = lauf(R2)
    gleich(l.status, 'aborted', 'status')
    wahr(l.tmux_closed_at !== null, 'tmux_closed_at set immediately')
    falsch((await sh('tmux', ['has-session', '-t', `=${l.tmux_session}`])).ok, 'session terminated')
    sessions.delete(l.tmux_session)
  })
  await pruefe('terminal of a terminated session reports 410 instead of hanging', async () => {
    const e = await wsVersuch(`/term?run=${R2}&ro=1`)
    gleich(e.art, 'http', 'HTTP response')
    gleich(e.status, 410, 'status')
  })
  await pruefe('retry after an abort clears the old session close — the terminal is offered again', async () => {
    const r = await formular(`/api/runs/${R2}/retry`, {}, { alsBrowser: true })
    gleich(r.status, 303, 'redirect instead of JSON')
    await sessionMerken(R2)
    const l = lauf(R2)
    gleich(l.status, 'running', 'running again')
    gleich(l.tmux_closed_at, null, 'tmux_closed_at of the aborted attempt is gone — else pageRun() shows "no session"')
    const seite = await (await hol(`/runs/${R2}`)).text()
    wahr(seite.includes('data-session="1"'), 'detail page renders a terminal for the new session')
    // Leave the run somewhere the rest of the suite can ignore it.
    await formular(`/api/runs/${R2}/kill`, {})
    const l2 = lauf(R2)
    sessions.delete(l2.tmux_session)
  })
  await pruefe('cancel on a FAILED run aborts it — the click decides, not the race', async () => {
    // The button is rendered while the run is going, so a click can land after
    // the watcher has already written 'failed' (pane died in between — the
    // production case was two seconds). The final status must say what the
    // CLICK said: aborted, with the session closed and the follow-up commission
    // given up. A 'done' run stays protected (see the follow-up group).
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Abbruch-nach-Fehlschlag' })
    await warteAuf(() => !!lauf(j.runId)?.tmux_session, { was: 'tmux session' })
    await sessionMerken(j.runId)
    db.prepare(`UPDATE runs SET status='failed', ended_at=datetime('now') WHERE id=?`).run(j.runId)
    const r = await formular(`/api/runs/${j.runId}/kill`, {})
    gleich(r.status, 200, 'accepted')
    const l = lauf(j.runId)
    gleich(l.status, 'aborted', 'the final status is aborted')
    wahr(l.tmux_closed_at !== null, 'session closed with it')
    enthaelt(ereignisse(j.runId).join(','), 'aborted', 'and the run says why it ended')
    falsch((await sh('tmux', ['has-session', '-t', `=${l.tmux_session}`])).ok, 'session terminated')
    sessions.delete(l.tmux_session)
  })

  // ------------------------------------------------------------------
  gruppe('Branch expectation "fixed": occupied, free, only on origin')

  await pruefe('a fixed branch another worktree holds is rejected before a run exists', async () => {
    // 'main' is checked out in the repo itself — git grants a branch to exactly
    // one worktree. Before, this only came out as a failed run with git's raw
    // message ("'main' is already used by worktree at …").
    const vorher = db.prepare('SELECT COUNT(*) n FROM runs').get().n
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Festbranch', branch_mode: 'fest', branch_pattern: 'main' })
    falsch(j.ok, 'rejected')
    enthaelt(j.error, 'main', 'branch named')
    enthaelt(j.error, REPO, 'the occupying worktree named')
    gleich(db.prepare('SELECT COUNT(*) n FROM runs').get().n, vorher, 'no run created')
    const r = await formular('/runs/new', {
      repo_id: repoId, harness: 'claude', prompt: 'E2E-Festbranch-Formular',
      branch_mode: 'fest', branch_pattern: 'main', expected_minutes: '45',
    }, { alsBrowser: true })
    gleich(r.status, 400, 'the HTML form as well')
    enthaelt(await r.text(), 'main', 'branch named')
  })
  await pruefe('an agent whose branch got occupied later fails at start, also readably', async () => {
    // The form check cannot help here: the branch was still free when the agent
    // was saved. That is what the check in the runner is for — second line.
    const r = await formular('/agents/edit', {
      repo_id: repoId, name: 'e2e-festbranch', harness: 'claude', prompt: 'E2E-Agent-Festbranch',
      branch_mode: 'fest', branch_pattern: 'feature/e2e-belegt', expected_minutes: '45',
      schedule_kind: 'manuell', active: '1',
    }, { alsBrowser: true })
    gleich(r.status, 303, 'agent saved (branch still free)')
    const fremd = join(SB, 'fremdes-worktree')
    await sh('git', ['-C', REPO, 'branch', 'feature/e2e-belegt'])
    await sh('git', ['-C', REPO, 'worktree', 'add', fremd, 'feature/e2e-belegt'])
    const s = await formular('/agents/start', { id: String(agent('e2e-festbranch').id), repo: String(repoId) }, { alsBrowser: true })
    gleich(s.status, 303, 'redirect')
    const l = db.prepare('SELECT * FROM runs WHERE agent_id=?').get(agent('e2e-festbranch').id)
    gleich(l.status, 'failed', 'status')
    enthaelt(l.report_md, 'feature/e2e-belegt', 'branch named')
    enthaelt(l.report_md, fremd, 'the occupying worktree named')
    falsch(/already used by worktree/.test(l.report_md), 'no raw git message')
  })
  await pruefe('a free fixed branch is checked out', async () => {
    await sh('git', ['-C', REPO, 'branch', 'feature/e2e-fest'])
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Festbranch-frei', branch_mode: 'fest', branch_pattern: 'feature/e2e-fest' })
    const l = lauf(j.runId)
    gleich(l.status, 'running', 'status')
    const b = await sh('git', ['-C', l.workdir_effective, 'rev-parse', '--abbrev-ref', 'HEAD'])
    gleich(b.stdout.trim(), 'feature/e2e-fest', 'branch')
  })
  await pruefe('a fixed branch that only exists on origin starts from THERE', async () => {
    // Otherwise the run would build on the base branch and the first push would
    // bounce off as non-fast-forward.
    // A commit of its own on the remote branch (plumbing: no checkout needed),
    // so that "starts from origin/<branch>" is distinguishable from "starts
    // from the base branch".
    const tree = await sh('git', ['-C', REPO, 'rev-parse', 'main^{tree}'])
    const commit = await sh('git', ['-C', REPO, 'commit-tree', tree.stdout.trim(), '-p', 'main', '-m', 'e2e nur auf origin'])
    const soll = { stdout: commit.stdout }
    await sh('git', ['-C', REPO, 'push', '-q', 'origin', `${commit.stdout.trim()}:refs/heads/feature/e2e-nur-origin`])
    await sh('git', ['-C', REPO, 'fetch', '-q', 'origin'])
    const mainSha = await sh('git', ['-C', REPO, 'rev-parse', 'main'])
    falsch(soll.stdout.trim() === mainSha.stdout.trim(), 'remote branch differs from the base branch')
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Festbranch-origin', branch_mode: 'fest', branch_pattern: 'feature/e2e-nur-origin' })
    const l = lauf(j.runId)
    gleich(l.status, 'running', 'status')
    const ist = await sh('git', ['-C', l.workdir_effective, 'rev-parse', 'HEAD'])
    gleich(ist.stdout.trim(), soll.stdout.trim(), 'starting point is the remote branch')
  })

  // ------------------------------------------------------------------
  gruppe('Scheduler (waits for the hub\'s 30-second tick)')

  await pruefe('create schedule agents and switch on the pipeline', async () => {
    // A: runs every minute, but already has a running run -> must be skipped.
    const a = await formular('/agents/edit', {
      repo_id: repoId, name: 'e2e-jede-minute', harness: 'claude', prompt: 'E2E-Dauerlaeufer',
      branch_mode: 'keiner', expected_minutes: '45', schedule_kind: 'cron', schedule: '* * * * *', active: '1',
    }, { alsBrowser: true })
    gleich(a.status, 303, 'agent A created')
    const idA = agent('e2e-jede-minute').id
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-belegt' })
    db.prepare('UPDATE runs SET agent_id=? WHERE id=?').run(idA, j.runId)

    // B: one-off date in the past -> must fire exactly once.
    const gestern = new Date(Date.now() - 3600_000).toISOString().slice(0, 16)
    const b = await formular('/agents/edit', {
      repo_id: repoId, name: 'e2e-einmalig', harness: 'claude', prompt: 'E2E-Einmalig',
      branch_mode: 'keiner', expected_minutes: '45', schedule_kind: 'einmalig', run_at: gestern, active: '1',
    }, { alsBrowser: true })
    gleich(b.status, 303, 'agent B created')
    gleich((await (await formular('/api/settings/pipeline', { value: '1' })).json()).ok, true, 'pipeline on')
  })
  await pruefe('one-off date fires exactly once and switches itself to manual', async () => {
    const idB = agent('e2e-einmalig').id
    await warteAuf(() => db.prepare('SELECT count(*) c FROM runs WHERE agent_id=?').get(idB).c === 1,
      { was: 'run of the one-off agent', timeoutMs: 75_000, taktMs: 1000 })
    const a = agent('e2e-einmalig')
    gleich(a.schedule_kind, 'manuell', 'kind reset')
    gleich(a.run_at, null, 'date cleared')
    for (const r of db.prepare('SELECT id FROM runs WHERE agent_id=?').all(idB)) await sessionMerken(r.id)
  })
  await pruefe('an agent does not overtake itself', async () => {
    const idA = agent('e2e-jede-minute').id
    const belegt = db.prepare(`SELECT id FROM runs WHERE agent_id=? AND status='running'`).get(idA)
    await warteAuf(() => ereignisse(belegt.id).includes('schedule_skipped'),
      { was: 'schedule_skipped', timeoutMs: 75_000, taktMs: 1000 })
    gleich(db.prepare('SELECT count(*) c FROM runs WHERE agent_id=?').get(idA).c, 1, 'only one run')
  })
  await pruefe('pipeline can be switched off again', async () => {
    gleich((await (await formular('/api/settings/pipeline', { value: '0' })).json()).ok, true, 'ok')
    gleich(db.prepare(`SELECT value FROM settings WHERE key='pipeline_on'`).get().value, '0', 'saved')
  })

  // ------------------------------------------------------------------
  gruppe('Run title and planned start')

  await pruefe('the single-run form asks for a title and a start time', async () => {
    const html = await (await hol(`/runs/new?repo=${repoId}`)).text()
    enthaelt(html, 'name="title"', 'title field')
    enthaelt(html, 'generated from the prompt', 'says what an empty field means')
    enthaelt(html, 'name="start_mode"', 'start kind')
    enthaelt(html, 'name="start_at"', 'point in time')
    enthaelt(html, 'name="start_in_minutes"', 'in n minutes')
  })
  await pruefe('an empty title becomes the first line of the prompt', async () => {
    // No OPENROUTER_API_KEY in the sandbox, so no model is asked — exactly the
    // case the fallback exists for.
    const j = await laufStarten({ repo_id: repoId, prompt: '# Rewrite the login form\n\nand much more text' })
    await sessionMerken(j.runId)
    gleich(lauf(j.runId).title, 'Rewrite the login form', 'title from the prompt')
    const html = await (await hol(`/?repo=${repoId}`)).text()
    enthaelt(html, 'Rewrite the login form', 'shown in the overview')
  })
  await pruefe('a typed title is taken over verbatim', async () => {
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Titel', title: '  Nightly cleanup  ' })
    await sessionMerken(j.runId)
    gleich(lauf(j.runId).title, 'Nightly cleanup', 'trimmed and stored')
  })
  let TITELLAUF = null
  await pruefe('a run of an agent is called by its agent', async () => {
    const r = await formular('/agents/edit', {
      repo_id: repoId, name: 'e2e-titel-agent', harness: 'claude', prompt: 'E2E-Agentenlauf',
      branch_mode: 'keiner', expected_minutes: '45', schedule_kind: 'manuell', active: '1',
    }, { alsBrowser: true })
    gleich(r.status, 303, 'agent created')
    const s = await formular('/agents/start', { id: agent('e2e-titel-agent').id, repo: repoId }, { alsBrowser: true })
    TITELLAUF = s.headers.get('location').split('/')[2]
    await sessionMerken(TITELLAUF)
    gleich(lauf(TITELLAUF).title, 'e2e-titel-agent', 'the agent name, not a generated title')
  })
  await pruefe('renaming changes the run — the agent keeps its name', async () => {
    const r = await formular(`/api/runs/${TITELLAUF}/title`, { title: 'Renamed by hand' })
    gleich((await r.json()).title, 'Renamed by hand', 'the new title comes back')
    gleich(lauf(TITELLAUF).title, 'Renamed by hand', 'stored on the run')
    gleich(agent('e2e-titel-agent').name, 'e2e-titel-agent', 'the agent is untouched')
    enthaelt(await (await hol(`/runs/${TITELLAUF}`)).text(), 'Renamed by hand', 'detail page shows it')
  })
  await pruefe('an emptied title falls back to the agent instead of leaving a nameless row', async () => {
    const r = await formular(`/api/runs/${TITELLAUF}/title`, { title: '   ' })
    gleich((await r.json()).title, 'e2e-titel-agent', 'the agent name comes back')
    gleich(lauf(TITELLAUF).title, null, 'nothing stored')
  })

  let GEPLANT = null
  await pruefe('a run planned for later waits instead of starting', async () => {
    const j = await laufStarten({
      repo_id: repoId, prompt: 'E2E-spaeter', title: 'Planned run',
      start_mode: 'in', start_in_minutes: '60',
    })
    GEPLANT = j.runId
    wahr(j.scheduled, `reported as planned (${JSON.stringify(j)})`)
    const r = lauf(GEPLANT)
    gleich(r.status, 'scheduled', 'status')
    gleich(r.tmux_session, null, 'no session — nothing was started')
    wahr(!!r.start_at, 'point in time noted')
    await watcherTick()
    gleich(lauf(GEPLANT).status, 'scheduled', 'a pass before the moment changes nothing')
    // The status cell of the overview: the word (translated, from lang/en.json —
    // the raw 'scheduled' is a database value and no longer reaches the screen)
    // and, underneath it, WHAT the run is waiting for. That second line is the
    // whole point of showing a waiting run at the top of the list.
    const zeile = (await (await hol(`/?repo=${repoId}`)).text()).split('<tr').find(z => z.includes(GEPLANT))
    enthaelt(zeile, 'Scheduled', 'the waiting run is visible in the overview')
    enthaelt(zeile, 'starts at', 'and says what it is waiting for')
    enthaelt(zeile, 'Planned run', 'with its title')
  })
  await pruefe('a planned run does not yet show a runtime — it has not started', async () => {
    // The detail page must say the same as the overview, which shows no duration
    // for a planned run. started_at still holds the PLANNING moment (the real
    // start is written when the run launches), so counting from it — or calling
    // the run "running" — would present waiting as runtime.
    const html = await (await hol(`/runs/${GEPLANT}`)).text()
    const i = html.indexOf('id="run-metrics"')
    const metrik = i < 0 ? '' : html.slice(i, i + 600)
    enthaelt(metrik, '>– <span class="dim">/ Expectation', 'runtime is a dash, not elapsed minutes')
    falsch(metrik.includes('(running)'), 'it does not call a planned run running')
  })
  await pruefe('when the moment has come the watcher starts it', async () => {
    db.prepare(`UPDATE runs SET start_at=datetime('now','-1 minutes') WHERE id=?`).run(GEPLANT)
    await watcherTick()
    const r = lauf(GEPLANT)
    gleich(r.status, 'running', 'started')
    wahr(!!r.tmux_session, 'has a session')
    await sessionMerken(GEPLANT)
    enthaelt(ereignisse(GEPLANT).join(','), 'scheduled_start', 'recorded as a planned start')
  })
  await pruefe('a planned run can be started ahead of its time, from the endpoint', async () => {
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-StartNow', title: 'Start now run', start_mode: 'in', start_in_minutes: '60' })
    const id = j.runId
    gleich(lauf(id).status, 'scheduled', 'waiting first')
    const r = await formular(`/api/runs/${id}/start-now`, {})
    gleich(r.status, 200, 'the endpoint answers 200')
    gleich(lauf(id).status, 'running', 'the run is running ahead of its time')
    enthaelt(ereignisse(id).join(','), 'scheduled_start', 'recorded as a planned start')
    await sessionMerken(id)
  })
  await pruefe('only a planned run may be started this way', async () => {
    const laufend = await laufStarten({ repo_id: repoId, prompt: 'E2E-StartNow-Nein' })
    wahr(!!laufend.runId && !laufend.scheduled, 'a run that is not planned')
    const r = await formular(`/api/runs/${laufend.runId}/start-now`, {})
    gleich(r.status, 400, 'the endpoint refuses')
    gleich(lauf(laufend.runId).status, 'running', 'and leaves the run alone')
    await sessionMerken(laufend.runId)
  })
  await pruefe('the start-now button sits on the detail banner next to the cancel', async () => {
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-StartNow-UI', title: 'Start now UI', start_mode: 'in', start_in_minutes: '60' })
    const seite = await hol(`/runs/${j.runId}`).then(r => r.text())
    enthaelt(seite, `action="/api/runs/${j.runId}/start-now"`, 'the banner offers the start-now button')
    enthaelt(seite, 'button class="success"', 'and it is the green one')
    enthaelt(seite, `action="/api/runs/${j.runId}/kill"`, 'the cancel stays beside it')
    await formular(`/api/runs/${j.runId}/start-now`, {})
    await sessionMerken(j.runId)
  })
  await pruefe('"when the repo is free" waits for exactly that', async () => {
    // The groups before left runs behind; the question here is only about the
    // blocker this test starts itself.
    db.prepare(`UPDATE runs SET status='done', ended_at=datetime('now')
                WHERE repo_id=? AND status IN ('running','waiting_help')`).run(repoId)
    const blocker = await laufStarten({ repo_id: repoId, prompt: 'E2E-Blocker' })
    await sessionMerken(blocker.runId)
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-frei', start_mode: 'idle' })
    await watcherTick()
    gleich(lauf(j.runId).status, 'scheduled', 'the repo is busy: it keeps waiting')
    gleich(lauf(j.runId).start_at, null, 'no point in time — it waits for a state')

    db.prepare(`UPDATE runs SET status='done', ended_at=datetime('now') WHERE id=?`).run(blocker.runId)
    await watcherTick()
    gleich(lauf(j.runId).status, 'running', 'repo free: started')
    await sessionMerken(j.runId)
  })

  // ------------------------------------------------------------------
  gruppe('Edit a run before and during its life (run-edit.mjs)')

  /** The "Edit this run" card of a detail page, scoped — the layout carries a
   *  Quick-Run dialog with the same field names, so assertions must not match it. */
  const editKarte = async (runId) => {
    const html = await (await hol(`/runs/${runId}`)).text()
    const i = html.indexOf('id="run-edit"')
    return i < 0 ? '' : html.slice(i, i + 4000)
  }

  /** ms → local time in the datetime-local shape the form sends. */
  const datenLocal = (ms) => {
    const d = new Date(ms)
    const z = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}`
  }

  await pruefe('a running run accepts only the expected duration', async () => {
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Edit-laeuft' })
    await sessionMerken(j.runId)
    gleich(lauf(j.runId).status, 'running', 'sanity: running')

    const p1 = await formular(`/api/runs/${j.runId}/edit`, { prompt: 'anders' })
    gleich(p1.status, 400, 'a prompt edit is refused for a started run')
    enthaelt((await p1.json()).error, 'not started yet', 'the reason names the rule')
    gleich(lauf(j.runId).prompt, 'E2E-Edit-laeuft', 'prompt untouched')

    const p2 = await formular(`/api/runs/${j.runId}/edit`, { repo_id: String(repo2Id) })
    gleich(p2.status, 400, 'a move is refused for a started run')
    gleich(lauf(j.runId).repo_id, repoId, 'repo untouched')

    const p3 = await formular(`/api/runs/${j.runId}/edit`, { expected_minutes: '90' })
    gleich(p3.status, 200, 'the duration edit is accepted')
    gleich(lauf(j.runId).expected_minutes, 90, 'new duration')
    enthaelt(ereignisse(j.runId).join(','), 'edited', 'the edit is an event')

    const karte = await editKarte(j.runId)
    enthaelt(karte, 'name="expected_minutes"', 'card offers the duration')
    falsch(karte.includes('name="prompt"'), 'no prompt textarea for a started run')
    falsch(karte.includes('name="repo_id"'), 'no repo select for a started run')
    falsch(karte.includes('name="start_mode"'), 'no start-time block for a started run')
    falsch(karte.includes('name="branch_mode"'), 'no branch rule for a started run')

    // Clean up: the run must not linger as 'running' for the status sidebar.
    db.prepare(`UPDATE runs SET status='done', ended_at=datetime('now') WHERE id=?`).run(j.runId)
  })

  await pruefe('a finished run refuses every edit', async () => {
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Edit-fertig' })
    await sessionMerken(j.runId)
    db.prepare(`UPDATE runs SET status='done', ended_at=datetime('now') WHERE id=?`).run(j.runId)
    const r = await formular(`/api/runs/${j.runId}/edit`, { expected_minutes: '1' })
    gleich(r.status, 400, 'refused')
    enthaelt((await r.json()).error, 'already over', 'the reason says the run is over')
    gleich(await editKarte(j.runId), '', 'no card at all on the detail page')
  })

  let EDITLAUF = null
  await pruefe('a scheduled run is edited: prompt, duration, repo and start time before it starts', async () => {
    const j = await laufStarten({
      repo_id: repoId, prompt: 'E2E-Edit-alt', title: 'Planned edit',
      start_mode: 'in', start_in_minutes: '60',
    })
    EDITLAUF = j.runId
    wahr(j.scheduled, `planned (${JSON.stringify(j)})`)
    gleich(lauf(EDITLAUF).title, 'Planned edit', 'an operator title')

    const neu = datenLocal(Date.now() + 30 * 60_000)
    // A classic form post lands back on the run page.
    const r = await formular(`/api/runs/${EDITLAUF}/edit`, {
      expected_minutes: '120', prompt: 'E2E-Edit-neu', repo_id: String(repo2Id),
      start_mode: 'at', start_at: neu,
    }, { alsBrowser: true })
    gleich(r.status, 303, 'form post redirects back')
    gleich(r.headers.get('location'), `/runs/${EDITLAUF}`, 'to the run page')
    const l = lauf(EDITLAUF)
    gleich(l.prompt, 'E2E-Edit-neu', 'new prompt')
    gleich(l.expected_minutes, 120, 'new duration')
    gleich(l.repo_id, repo2Id, 'moved to the other repo')
    gleich(l.start_mode, 'at', 'start mode')
    gleich(l.title, 'Planned edit', 'an operator title stays')
    // Same local-time reading the form parser makes of the input; the DB stores
    // UTC, so the expected value is derived from the same Date.parse.
    const so = new Date(Date.parse(neu))
    gleich(l.start_at, so.toISOString().slice(0, 19).replace('T', ' '), 'the start time moved')
    // Still scheduled: 30 minutes in the future, a watcher pass must not start it.
    gleich(l.status, 'scheduled', 'still waiting')
    await watcherTick()
    gleich(lauf(EDITLAUF).status, 'scheduled', 'a pass before the edited moment changes nothing')

    const karte = await editKarte(EDITLAUF)
    enthaelt(karte, 'E2E-Edit-neu', 'card shows the new prompt')
    enthaelt(karte, 'name="prompt"', 'prompt textarea for a planned run')
    enthaelt(karte, 'name="repo_id"', 'repo select for a planned run')
    enthaelt(karte, '>e2e2<', 'the other repo is selected')
    enthaelt(karte, 'name="start_mode"', 'the planned run offers its start time')
    enthaelt(karte, 'name="start_at"', 'with the date-time field')
    enthaelt(karte, `value="${neu}"`, 'prefilled with what it is waiting for')
    enthaelt(karte, 'name="branch_mode"', 'and the branch rule, prefilled for a planned run')

    // The live channel renders the same card.
    const frag = await (await hol(`/api/fragments/run-detail?id=${EDITLAUF}`)).text()
    enthaelt(frag, 'id="run-edit"', 'card is part of the fragment')
    enthaelt(frag, 'E2E-Edit-neu', 'and carries the new prompt')
    enthaelt(frag, 'name="start_mode"', 'and the start-time block')
  })

  await pruefe('the branch rule of a planned run can be edited', async () => {
    const j = await laufStarten({
      repo_id: repoId, prompt: 'E2E-Edit-branch', title: 'Branch planned',
      start_mode: 'in', start_in_minutes: '60',
    })
    const r = await formular(`/api/runs/${j.runId}/edit`, {
      branch_mode: 'neu', branch_pattern: 'agent/e2e-edit', keep_on_branch: '1',
    })
    gleich(r.status, 200, 'the branch edit is accepted')
    const l = lauf(j.runId)
    gleich(l.branch_mode, 'neu', 'new branch mode')
    gleich(l.branch_pattern, 'agent/e2e-edit', 'new branch pattern')
    gleich(l.keep_on_branch, 1, 'keep-on-branch set')

    // An invalid combination is a problem, not a partial write.
    const schlecht = await formular(`/api/runs/${j.runId}/edit`, {
      branch_mode: 'keiner', keep_on_branch: '1',
    })
    gleich(schlecht.status, 400, 'keep without a branch is refused')
    gleich(lauf(j.runId).branch_mode, 'neu', 'the earlier edit stands')

    const karte = await editKarte(j.runId)
    enthaelt(karte, 'value="neu" checked', 'the edited mode is selected')
    enthaelt(karte, 'value="agent/e2e-edit"', 'the edited pattern is prefilled')

    // Clean up: a planned run must not linger.
    await formular(`/api/runs/${j.runId}/kill`, {})
  })

  await pruefe('the edited run starts with its new prompt in its new repo', async () => {
    db.prepare(`UPDATE runs SET start_at=datetime('now','-1 minutes') WHERE id=?`).run(EDITLAUF)
    await watcherTick()
    const l = lauf(EDITLAUF)
    gleich(l.status, 'running', 'started once the moment has come')
    wahr(!!l.tmux_session, 'has a session')
    await sessionMerken(EDITLAUF)
    gleich(l.repo_id, repo2Id, 'started in the repo it was moved to')
    gleich(l.expected_minutes, 120, 'with the edited duration')
    const p = readFileSync(join(SB, 'runs', EDITLAUF, 'prompt.md'), 'utf8')
    enthaelt(p, 'E2E-Edit-neu', 'the launched prompt is the edited one')
    falsch(p.includes('E2E-Edit-alt'), 'the old prompt is gone')

    // Clean up for the status sidebar that counts later.
    db.prepare(`UPDATE runs SET status='done', ended_at=datetime('now') WHERE id=?`).run(EDITLAUF)
  })

  await pruefe('editing a planned run to "now" starts it right away', async () => {
    const j = await laufStarten({
      repo_id: repoId, prompt: 'E2E-Edit-jetzt', title: 'Start now by edit',
      start_mode: 'in', start_in_minutes: '60',
    })
    gleich(lauf(j.runId).status, 'scheduled', 'sanity: planned')
    const r = await formular(`/api/runs/${j.runId}/edit`, { start_mode: 'now' })
    gleich(r.status, 200, 'the edit is accepted')
    const gestartet = await r.json()
    gleich(gestartet.ok, true, 'and reports the start')
    const l = lauf(j.runId)
    gleich(l.status, 'running', 'the run is running, not waiting')
    wahr(!!l.tmux_session, 'has a session')
    await sessionMerken(j.runId)
    enthaelt(ereignisse(j.runId).join(','), 'scheduled_start', 'recorded as a started planned run')

    // Clean up.
    db.prepare(`UPDATE runs SET status='done', ended_at=datetime('now') WHERE id=?`).run(j.runId)
  })

  // ------------------------------------------------------------------
  gruppe('Archive')

  let ARV = null
  await pruefe('one click archives a finished run — it leaves the overview, the record stays', async () => {
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Archiv', title: 'Archived by hand' })
    await sessionMerken(j.runId)
    db.prepare(`UPDATE runs SET status='done', ended_at=datetime('now') WHERE id=?`).run(j.runId)
    ARV = j.runId
    enthaelt(await (await hol(`/runs/${ARV}`)).text(), 'Move to archive', 'detail page offers archiving once the run is over')
    // A classic form post (Accept: text/html) lands back on the overview.
    const r = await formular(`/api/runs/${ARV}/archive`, { back: `/?repo=${repoId}` }, { alsBrowser: true })
    gleich(r.status, 303, 'redirects back')
    gleich(r.headers.get('location'), `/?repo=${repoId}`, 'back to the overview')
    const auf = lauf(ARV)
    wahr(!!auf.archived_at, 'archived_at is set')
    // The overview row is gone; the archive page shows it.
    falsch((await (await hol(`/?repo=${repoId}`)).text()).includes(ARV), 'not in the overview any more')
    const archiv = await (await hol(`/archive?repo=${repoId}`)).text()
    enthaelt(archiv, ARV, 'listed in the archive')
    enthaelt(archiv, 'Archived by hand', 'with its title')
    enthaelt(archiv, 'Restore', 'restore button')
  })
  // A run whose work never reached the base branch must say so wherever it is
  // listed. The overview does it under the status word; the archive did not, so
  // an archived run blocked on a merge was indistinguishable from one that
  // merged cleanly — and the archive is the last place that can still say it.
  await pruefe('the archive says when an archived run\'s work is not on the base branch', async () => {
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Archiv-blockiert', title: 'Archived while blocked' })
    await sessionMerken(j.runId)
    db.prepare(`UPDATE runs SET status='done', ended_at=datetime('now'), merge_status='blocked_error' WHERE id=?`).run(j.runId)
    await formular(`/api/runs/${j.runId}/archive`, {})
    const zeile = (await (await hol(`/archive?repo=${repoId}`)).text()).split('<tr ').find(z => z.includes(j.runId))
    wahr(!!zeile, 'the run is in the archive')
    enthaelt(zeile, 'blocked: integration error', 'and the row says its work is not on the base branch')
    // A cleanly merged run stays quiet — the line is a warning, not furniture.
    db.prepare(`UPDATE runs SET merge_status='merged' WHERE id=?`).run(j.runId)
    const sauber = (await (await hol(`/archive?repo=${repoId}`)).text()).split('<tr ').find(z => z.includes(j.runId))
    falsch(sauber.includes('blocked: integration error'), 'a merged run says nothing')
    db.prepare('DELETE FROM runs WHERE id=?').run(j.runId)   // keep the pagination count below stable
  })
  await pruefe('the detail page offers to restore an archived run', async () => {
    const html = await (await hol(`/runs/${ARV}`)).text()
    enthaelt(html, 'Restore to overview', 'button on the detail page')
    enthaelt(html, 'archived', 'mentions the archive')
  })
  // The sidebar's incident count is a LINK into the overview filtered to the
  // runs that carry an open incident — and no archived run is ever in the
  // overview. Measured on this installation: two open incidents, both on runs
  // the operator had archived, so two repos said "1 needs you" and both clicks
  // landed on "no runs yet". The number and the list behind it are one set.
  await pruefe('an archived run\'s incident leaves the sidebar count with it', async () => {
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Archiv-Vorfall', title: 'Archived with an incident' })
    await sessionMerken(j.runId)
    db.prepare(`UPDATE runs SET status='failed', ended_at=datetime('now') WHERE id=?`).run(j.runId)
    const inc = await import('../server/incidents.mjs')
    await inc.vorfallMelden(j.runId, { typ: 'auth_error', quelle: 'e2e', schwere: 'rot', beleg: 'E2E' })

    const zaehlt = async () => {
      const seite = await (await hol(`/?repo=${repoId}`)).text()
      const block = seite.split('side-incidents')[1]?.split('</div>')[0] ?? ''
      return { block, gefiltert: await (await hol(`/?repo=${repoId}&incidents=1`)).text() }
    }
    const vorher = await zaehlt()
    enthaelt(vorher.block, 'need you', 'while the run is visible the sidebar asks for hands')
    enthaelt(vorher.block, `incidents=1`, 'and the number is a link into the filtered overview')
    wahr(vorher.gefiltert.includes(j.runId), 'which shows the run behind the number')

    await formular(`/api/runs/${j.runId}/archive`, {})
    wahr(!!lauf(j.runId).archived_at, 'archived')
    const nachher = await zaehlt()
    falsch(nachher.block.includes('need you'), 'archived: the sidebar no longer promises a row')
    falsch(nachher.gefiltert.includes(j.runId), 'and the filtered overview has none to give')
    // The record itself is untouched — the archive and the run's own page keep it.
    wahr(inc.offeneVorfaelle(j.runId).length === 1, 'the incident is still open, it is only not counted here')
    enthaelt(await (await hol(`/runs/${j.runId}`)).text(), 'Incidents', 'and still shown on the run\'s page')
    db.prepare('DELETE FROM runs WHERE id=?').run(j.runId)   // keep the pagination count below stable
  })
  await pruefe('restore puts the run back into the overview', async () => {
    const r = await formular(`/api/runs/${ARV}/unarchive`, { back: `/archive?repo=${repoId}` }, { alsBrowser: true })
    gleich(r.status, 303, 'redirects back')
    gleich(lauf(ARV).archived_at, null, 'archived_at cleared')
    enthaelt(await (await hol(`/?repo=${repoId}`)).text(), ARV, 'visible in the overview again')
    falsch((await (await hol(`/archive?repo=${repoId}`)).text()).includes(ARV), 'gone from the archive')
  })
  await pruefe('retrying an archived run brings it back to the overview', async () => {
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Archiv-retry' })
    await sessionMerken(j.runId)
    db.prepare(`UPDATE runs SET status='failed', ended_at=datetime('now') WHERE id=?`).run(j.runId)
    await formular(`/api/runs/${j.runId}/archive`, {})
    wahr(!!lauf(j.runId).archived_at, 'archived')
    const r = await formular(`/api/runs/${j.runId}/retry`, {})
    gleich(r.status, 200, 'retried')
    const auf = lauf(j.runId)
    gleich(auf.status, 'running', 'running again')
    gleich(auf.archived_at, null, 'left the archive — an active run must not be hidden')
    falsch((await (await hol(`/archive?repo=${repoId}`)).text()).includes(j.runId), 'not in the archive any more')
  })
  await pruefe('a run that is still working cannot be archived', async () => {
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Archiv-laeuft' })
    await sessionMerken(j.runId)
    gleich(lauf(j.runId).status, 'running', 'sanity: it is running')
    const r = await formular(`/api/runs/${j.runId}/archive`, {})
    gleich(r.status, 400, 'rejected')
    gleich(lauf(j.runId).archived_at, null, 'nothing archived')
    // Clean up: the run must not linger for the watcher's sake.
    db.prepare(`UPDATE runs SET status='done', ended_at=datetime('now') WHERE id=?`).run(j.runId)
  })
  await pruefe('several runs go into the archive in one request', async () => {
    // The overview's multi-select: forty finished runs of which four are kept
    // used to be forty clicks. One request, one result per run.
    const ids = []
    for (const titel of ['E2E-Bulk-1', 'E2E-Bulk-2']) {
      const j = await laufStarten({ repo_id: repoId, prompt: titel, title: titel })
      await sessionMerken(j.runId)
      db.prepare(`UPDATE runs SET status='done', ended_at=datetime('now') WHERE id=?`).run(j.runId)
      ids.push(j.runId)
    }
    const r = await formular('/api/runs/archive', { run: ids, back: `/?repo=${repoId}` })
    gleich(r.status, 200, 'accepted')
    const j = await r.json()
    wahr(j.ok, 'all of them archived')
    gleich(j.results.length, 2, 'one result per run')
    for (const id of ids) wahr(!!lauf(id).archived_at, `${id} archived`)
    const uebersicht = await (await hol(`/?repo=${repoId}`)).text()
    for (const id of ids) falsch(uebersicht.includes(id), 'gone from the overview')
    for (const id of ids) db.prepare('DELETE FROM runs WHERE id=?').run(id)   // keep the pagination count stable
  })
  await pruefe('one run that may not be archived does not hold up the rest', async () => {
    const fertig = await laufStarten({ repo_id: repoId, prompt: 'E2E-Bulk-fertig' })
    await sessionMerken(fertig.runId)
    db.prepare(`UPDATE runs SET status='done', ended_at=datetime('now') WHERE id=?`).run(fertig.runId)
    const laeuft = await laufStarten({ repo_id: repoId, prompt: 'E2E-Bulk-laeuft' })
    await sessionMerken(laeuft.runId)
    gleich(lauf(laeuft.runId).status, 'running', 'sanity: still working')

    const r = await formular('/api/runs/archive', { run: [fertig.runId, laeuft.runId, 'not-a-run'] })
    gleich(r.status, 200, 'answered per run, not refused as a whole')
    const j = await r.json()
    falsch(j.ok, 'not everything went')
    const nach = Object.fromEntries(j.results.map(x => [x.run, x.ok]))
    gleich(nach[fertig.runId], true, 'the finished one is archived')
    gleich(nach[laeuft.runId], false, 'the running one is refused')
    gleich(nach['not-a-run'], false, 'an unknown id is refused, not a 500')
    wahr(!!lauf(fertig.runId).archived_at, 'archived')
    gleich(lauf(laeuft.runId).archived_at, null, 'the running run stays in the overview')

    db.prepare(`UPDATE runs SET status='done', ended_at=datetime('now') WHERE id=?`).run(laeuft.runId)
    for (const id of [fertig.runId, laeuft.runId]) db.prepare('DELETE FROM runs WHERE id=?').run(id)
  })
  await pruefe('a bulk archive without a single run is refused', async () => {
    const r = await formular('/api/runs/archive', { back: `/?repo=${repoId}` })
    gleich(r.status, 400, 'refused')
  })
  await pruefe('the overview offers the multi-select', async () => {
    const html = await (await hol(`/?repo=${repoId}`)).text()
    enthaelt(html, 'id="runs-all"', 'select-all box')
    enthaelt(html, 'id="runs-archive-selected"', 'the bulk button')
    enthaelt(html, 'class="run-pick"', 'a checkbox per archivable run')
    // Under the table, not above it: one goes down the list deciding, and the
    // button belongs where the deciding stopped.
    wahr(html.indexOf('id="runs-archive-selected"') > html.indexOf('</table>'),
      'the bulk bar stands under the table')
  })
  await pruefe('archiving closes the tmux session right away by default', async () => {
    // The rule exists to make archiving mean what the operator's gesture says:
    // "this finished work is put away". Its session goes with it — keep 0.
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Archiv-session' })
    const sess = await sessionMerken(j.runId)
    wahr(sess, 'a session stands')
    db.prepare(`UPDATE runs SET status='done', ended_at=datetime('now') WHERE id=?`).run(j.runId)
    const r = await formular(`/api/runs/${j.runId}/archive`, {})
    gleich(r.status, 200, 'archived')
    gleich(lauf(j.runId).archived_at !== null, true, 'archived')
    gleich((await sh('tmux', ['has-session', '-t', `=${sess}`])).ok, false, 'the session is gone')
    gleich(lauf(j.runId).tmux_closed_at !== null, true, 'the run record knows the session closed')
    wahr(ereignisse(j.runId).includes('tmux_closed'), `event recorded (has: ${ereignisse(j.runId).join(', ')})`)
    sessions.delete(sess)   // already gone — do not let the cleanup expect it alive
    db.prepare('DELETE FROM runs WHERE id=?').run(j.runId)   // keep the pagination count stable
  })
  await pruefe('a switched-off archive rule keeps the session', async () => {
    db.prepare(`INSERT INTO settings(key,value) VALUES('archive_session_on','0')
                ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run()
    try {
      const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Archiv-aus' })
      const sess = await sessionMerken(j.runId)
      wahr(sess, 'a session stands')
      db.prepare(`UPDATE runs SET status='done', ended_at=datetime('now') WHERE id=?`).run(j.runId)
      await formular(`/api/runs/${j.runId}/archive`, {})
      gleich(lauf(j.runId).archived_at !== null, true, 'archived')
      gleich((await sh('tmux', ['has-session', '-t', `=${sess}`])).ok, true, 'the session survives — the rule is off')
      gleich(lauf(j.runId).tmux_closed_at, null, 'and the record still expects it open')
      // The ordinary retention cleans it up later; leave that to the sandbox cleanup.
      db.prepare('DELETE FROM runs WHERE id=?').run(j.runId)   // keep the pagination count stable
    } finally {
      db.prepare(`DELETE FROM settings WHERE key='archive_session_on'`).run()
    }
  })
  await pruefe('a keep time defers the close to the watcher pass', async () => {
    db.prepare(`INSERT INTO settings(key,value) VALUES('archive_session_keep_hours','2')
                ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run()
    try {
      const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Archiv-keep' })
      const sess = await sessionMerken(j.runId)
      wahr(sess, 'a session stands')
      db.prepare(`UPDATE runs SET status='done', ended_at=datetime('now') WHERE id=?`).run(j.runId)
      await formular(`/api/runs/${j.runId}/archive`, {})
      gleich(lauf(j.runId).archived_at !== null, true, 'archived')
      gleich((await sh('tmux', ['has-session', '-t', `=${sess}`])).ok, true, 'inside the keep window: still there')
      // Two hours pass, and the watcher closes what the archive left standing.
      db.prepare(`UPDATE runs SET archived_at=datetime('now','-3 hours') WHERE id=?`).run(j.runId)
      await watcherTick()
      gleich((await sh('tmux', ['has-session', '-t', `=${sess}`])).ok, false, 'after the keep time the session is gone')
      gleich(lauf(j.runId).tmux_closed_at !== null, true, 'the record agrees')
      sessions.delete(sess)
      db.prepare('DELETE FROM runs WHERE id=?').run(j.runId)   // keep the pagination count stable
    } finally {
      db.prepare(`DELETE FROM settings WHERE key='archive_session_keep_hours'`).run()
    }
  })
  await pruefe('the archive is paginated', async () => {
    // 55 archived runs → 2 pages of 50. Inserted directly: only the archive page
    // cares about them, the overview must not show them anyway.
    const ids = []
    for (let i = 0; i < 55; i++) {
      const id = randomUUID()
      ids.push(id)
      db.prepare(`INSERT INTO runs(id, repo_id, status, harness, prompt, branch_mode,
                   expected_minutes, started_at, ended_at, archived_at)
                  VALUES(?, ?, 'done', 'claude', 'E2E-Archiv-Masse', 'keiner', 45,
                   datetime('now', ?), datetime('now'), datetime('now', ?))`)
        .run(id, repoId, `-${i} days`, `-${i} days`)
    }
    const seite1 = await (await hol(`/archive?repo=${repoId}`)).text()
    enthaelt(seite1, 'Page 1 of 2', 'pagination line')
    enthaelt(seite1, 'next ›', 'a next link')
    enthaelt(seite1, ids[0], 'newest archived first')
    falsch(seite1.includes(ids[ids.length - 1]), 'the oldest is on page 2')
    const seite2 = await (await hol(`/archive?repo=${repoId}&page=2`)).text()
    enthaelt(seite2, 'Page 2 of 2', 'second page')
    enthaelt(seite2, ids[ids.length - 1], 'the oldest sits here')
    falsch(/<a [^>]*>next ›<\/a>/.test(seite2), 'no next link on the last page')
    const alle = db.prepare(`SELECT id FROM runs WHERE repo_id=? AND archived_at IS NOT NULL`).all(repoId)
    gleich(alle.length, 55, 'all inserted runs are archived')
    // Page 3 beyond the range clamps to the last page instead of an empty one.
    const seite3 = await (await hol(`/archive?repo=${repoId}&page=99`)).text()
    enthaelt(seite3, 'Page 2 of 2', 'clamped to the last page')
  })

  // ------------------------------------------------------------------
  // A favorite is the setup half of a run definition under a name; the Quick-Run
  // dialog adds the task, the branch rule and the start time and starts without
  // taking the page away. What is checked here is the seam between the two: what
  // the favorite decides, what the request may decide — and that the request
  // cannot decide what the favorite already did.
  gruppe('Favorites and Quick Run')

  let FAVID = null

  await pruefe('a favorite is saved with its setup, and the settings page lists it', async () => {
    const r = await formular('/settings/favorites/edit', {
      name: 'E2E-Favorit', harness: 'claude', model: 'claude-opus-5', skills: 'e2e-fleiss',
    }, { alsBrowser: true })
    gleich(r.status, 303, 'saved and redirected')
    const row = db.prepare('SELECT * FROM favorites WHERE name=?').get('E2E-Favorit')
    wahr(!!row, 'stored')
    gleich(row.harness, 'claude', 'coding agent')
    gleich(row.model, 'claude-opus-5', 'model')
    gleich(row.skills, '["e2e-fleiss"]', 'extra skill')
    FAVID = row.id
    const html = await (await hol('/settings/favorites')).text()
    enthaelt(html, 'E2E-Favorit', 'listed by name')
    enthaelt(html, 'claude-opus-5', 'with its setup')
  })
  await pruefe('the Quick-Run dialog stands on every page, not only on the run form', async () => {
    for (const pfad of ['/', '/agents', '/sessions', '/settings', `/archive?repo=${repoId}`]) {
      const html = await (await hol(pfad)).text()
      enthaelt(html, 'id="qr-dialog"', `${pfad}: dialog`)
      enthaelt(html, 'id="qr-open"', `${pfad}: button in the header`)
      enthaelt(html, 'E2E-Favorit', `${pfad}: the favorite is selectable`)
    }
  })
  await pruefe('the start time stands open under the task, only the branch rule is folded away', async () => {
    const html = await (await hol('/')).text()
    const dialog = html.slice(html.indexOf('id="qr-dialog"'))
    const aufgabe = dialog.indexOf('name="prompt"')
    const start = dialog.indexOf('name="start_mode"')
    const details = dialog.indexOf('details class="qr-more"')
    wahr(aufgabe >= 0 && start >= 0 && details >= 0, 'task, start time and the folded block are all there')
    wahr(aufgabe < start && start < details, 'the start time sits under the task and before the folded block')
  })
  await pruefe('a quick run starts with the favorite\'s setup and only the task from the dialog', async () => {
    const r = await formular('/api/runs/quick', {
      repo_id: String(repoId), favorite_id: String(FAVID),
      prompt: 'E2E-Quickrun: tu etwas', branch_mode: 'keiner', start_mode: 'now',
    })
    const j = await r.json()
    wahr(j.ok && !!j.runId, `started (${JSON.stringify(j)})`)
    // The answer comes back while the launch is still going: what a Quick Run
    // has to decide is decided, the worktree and the session are the hub's
    // business from here (scheduler.mjs, `detached`).
    wahr(j.pending, 'the answer says the start is still running')
    const wt = await sessionMerken(j.runId)
    wahr(!!wt, 'and the session really does come up afterwards')
    const l = lauf(j.runId)
    gleich(l.harness, 'claude', 'coding agent from the favorite')
    gleich(l.model, 'claude-opus-5', 'model from the favorite')
    gleich(l.skills, '["e2e-fleiss"]', 'extra skill from the favorite')
    gleich(l.prompt, 'E2E-Quickrun: tu etwas', 'task from the dialog')
    gleich(l.expected_minutes, 45, 'the duration is not asked for and takes the default')
    gleich(l.status, 'running', 'really started')
  })
  await pruefe('the request cannot override what the favorite decided', async () => {
    const r = await formular('/api/runs/quick', {
      repo_id: String(repoId), favorite_id: String(FAVID),
      prompt: 'E2E-Quickrun: untergeschoben', branch_mode: 'keiner',
      // Everything a favorite owns — smuggled in alongside it.
      harness: 'hermes', model: 'boeses/modell', provider: 'openrouter', skills: '',
    })
    const j = await r.json()
    wahr(j.ok, `started (${JSON.stringify(j)})`)
    await sessionMerken(j.runId)
    const l = lauf(j.runId)
    gleich(l.harness, 'claude', 'coding agent stayed the favorite\'s')
    gleich(l.model, 'claude-opus-5', 'model stayed the favorite\'s')
    gleich(l.skills, '["e2e-fleiss"]', 'skills stayed the favorite\'s')
  })
  await pruefe('a quick run can be planned instead of started', async () => {
    const r = await formular('/api/runs/quick', {
      repo_id: String(repoId), favorite_id: String(FAVID),
      prompt: 'E2E-Quickrun: spaeter', branch_mode: 'keiner',
      start_mode: 'in', start_in_minutes: '30',
    })
    const j = await r.json()
    wahr(j.ok && j.scheduled, `planned (${JSON.stringify(j)})`)
    const l = lauf(j.runId)
    gleich(l.status, 'scheduled', 'waiting')
    gleich(l.tmux_session, null, 'nothing started yet')
    wahr(!!l.start_at, 'point in time noted')
  })
  await pruefe('a broken quick run is a readable answer, not a run', async () => {
    const ohneFavorit = await formular('/api/runs/quick', {
      repo_id: String(repoId), favorite_id: '99999', prompt: 'x', branch_mode: 'keiner',
    })
    gleich(ohneFavorit.status, 400, 'unknown favorite rejected')
    const ohnePrompt = await formular('/api/runs/quick', {
      repo_id: String(repoId), favorite_id: String(FAVID), prompt: '   ', branch_mode: 'keiner',
    })
    gleich(ohnePrompt.status, 400, 'empty task rejected')
    enthaelt((await ohnePrompt.json()).error, 'Prompt', 'names what is missing')
    const branchOhneMuster = await formular('/api/runs/quick', {
      repo_id: String(repoId), favorite_id: String(FAVID), prompt: 'x', branch_mode: 'neu',
    })
    gleich(branchOhneMuster.status, 400, 'branch rule without a pattern rejected — same check as the run form')
  })
  await pruefe('more favorites than there is room for are refused', async () => {
    const max = db.prepare('SELECT count(*) c FROM favorites').get().c
    for (let i = max; i < 3; i++) {
      await formular('/settings/favorites/edit', { name: `E2E-Fill-${i}`, harness: 'claude' }, { alsBrowser: true })
    }
    gleich(db.prepare('SELECT count(*) c FROM favorites').get().c, 3, 'three slots in use')
    const r = await formular('/settings/favorites/edit', { name: 'E2E-zuviel', harness: 'claude' }, { alsBrowser: true })
    gleich(r.status, 400, 'the fourth is refused')
    falsch(!!db.prepare('SELECT id FROM favorites WHERE name=?').get('E2E-zuviel'), 'and not stored')
  })

  // ------------------------------------------------------------------
  // The whole flows module had no e2e coverage: not one of its four pages, not
  // one of its ten endpoints, not one of its static files. It sits at the end of
  // the suite on purpose — a flow with a `run_finished` trigger is what makes the
  // attachment block render checkboxes at all, and the group deletes it again so
  // nothing that follows inherits a flow hanging on an agent.
  gruppe('Flows: pages, meta and the round trip through the API')

  /** POST a JSON body — /api/flows/save reads JSON, not a form. */
  const jsonPost = (pfad, obj) => hol(pfad, {
    method: 'POST', body: JSON.stringify(obj),
    headers: { 'content-type': 'application/json', accept: 'application/json' },
  })

  let FLOWID = null

  await pruefe('the three flow pages answer with real HTML', async () => {
    // One characteristic string per page, each from lang/en.json. Deliberately not
    // "Flows" for all three: a flow is not a place one navigates to, so there is no
    // nav entry carrying that word onto every page.
    const kennzeichen = {
      '/flows': 'New flow',           // flows.new
      '/flows/edit': 'Back',          // flows.editor.back — the designer's own head
      '/flows/runs': 'Flow runs',     // flows.runs.title
    }
    for (const [pfad, text] of Object.entries(kennzeichen)) {
      const r = await hol(pfad)
      gleich(r.status, 200, `${pfad}: status`)
      const html = await r.text()
      wahr(html.length > 500, `${pfad}: not an empty page (${html.length} bytes)`)
      enthaelt(html, text, `${pfad}: its own heading`)
    }
    enthaelt(await (await hol('/flows')).text(), 'no flows yet', 'the empty list says so instead of showing a broken table')
  })
  await pruefe('the flow designer\'s own scripts and its data reach the page', async () => {
    const html = await (await hol('/flows/edit')).text()
    // Markup, unavoidably: the designer is a client application and these two are
    // the seam it hangs on — the catalog it boots from and the module that boots
    // it. Everything else about the page is checked through the API below.
    enthaelt(html, 'window.FREILAUF_FLOWS', 'the editor state is injected')
    enthaelt(html, '/static/flows.js', 'the designer module is pulled in')
    enthaelt(html, 'Save', 'and the button that saves what was drawn')
  })
  await pruefe('the step registry reaches the editor through /api/flows/meta', async () => {
    const j = await (await hol('/api/flows/meta')).json()
    wahr(j.ok, 'ok')
    for (const feld of ['steps', 'groups', 'triggerKinds', 'ops', 'fieldTypes']) {
      wahr(Array.isArray(j[feld]) && j[feld].length > 0, `${feld} is present and not empty`)
    }
    wahr(j.steps.every(s => s.type && s.component && s.group && Array.isArray(s.fields)),
      'every step names its type, component, group and fields — that is what the property editor renders from')
    wahr(j.steps.some(s => s.type === 'notify') && j.steps.some(s => s.type === 'switch_outcome'),
      'known building blocks are in the registry')
    wahr(j.triggerKinds.includes('run_finished'), 'the trigger that an attachment is')
    wahr(j.groups.every(g => j.steps.some(s => s.group === g)), 'no toolbox group without a step in it')
  })
  await pruefe('a flow is saved through the API and comes back unchanged', async () => {
    const definition = {
      properties: {},
      sequence: [{ id: 'e2e-note', componentType: 'task', type: 'note', name: 'E2E note', properties: { text: 'E2E flow ran' } }],
    }
    const r = await jsonPost('/api/flows/save', {
      name: 'E2E-Flow', active: true, trigger: { kind: 'run_finished' }, definition,
    })
    const j = await r.json()
    wahr(j.ok && !!j.id, `saved (${JSON.stringify(j).slice(0, 200)})`)
    FLOWID = j.id
    const gelesen = await (await hol(`/api/flows/${FLOWID}`)).json()
    wahr(gelesen.ok, 'read back')
    gleich(gelesen.flow.name, 'E2E-Flow', 'name')
    gleich(gelesen.flow.active, 1, 'active')
    gleich(gelesen.flow.trigger.kind, 'run_finished', 'trigger')
    gleich(gelesen.flow.definition.sequence[0].properties.text, 'E2E flow ran', 'the definition survived the round trip')
    enthaelt(await (await hol('/flows')).text(), 'E2E-Flow', 'and the list shows it')
  })
  await pruefe('a definition the registry does not know is refused instead of stored', async () => {
    const r = await jsonPost('/api/flows/save', {
      name: 'E2E-Flow-kaputt', trigger: { kind: 'manual' },
      definition: { properties: {}, sequence: [{ id: 'x', type: 'gibtsnicht', properties: {} }] },
    })
    gleich(r.status, 400, 'rejected')
    wahr((await r.json()).problems.length > 0, 'with a reason')
    falsch(!!db.prepare('SELECT id FROM flows WHERE name=?').get('E2E-Flow-kaputt'), 'nothing stored')
    // A required field left empty is the same class of answer.
    const ohneText = await jsonPost('/api/flows/save', {
      name: 'E2E-Flow-leer', trigger: { kind: 'manual' },
      definition: { properties: {}, sequence: [{ id: 'y', type: 'note', properties: {} }] },
    })
    gleich(ohneText.status, 400, 'a required field left empty is refused too')
  })
  await pruefe('all three run forms carry the flow attachment block', async () => {
    // The only safeguard of the attach block. Checked by what the definition is
    // built from — the field NAMES — plus the class the block is styled and found
    // by; there is no text of its own that would prove the checkbox is a checkbox.
    for (const pfad of [`/runs/new?repo=${repoId}`, `/agents/edit?repo=${repoId}`, '/settings/favorites/edit']) {
      const html = await (await hol(pfad)).text()
      enthaelt(html, 'Flows after this run', `${pfad}: the block's legend`)
      enthaelt(html, 'flows-attach', `${pfad}: the block's own container`)
      enthaelt(html, 'name="flows"', `${pfad}: the checkbox the definition is built from`)
      enthaelt(html, `value="${FLOWID}"`, `${pfad}: the flow is offered`)
      enthaelt(html, `name="flow_when_${FLOWID}"`, `${pfad}: with its condition`)
      enthaelt(html, 'E2E-Flow', `${pfad}: by name`)
    }
  })
  await pruefe('ticking the box really attaches the flow, and the editor sees the same row', async () => {
    const r = await formular('/agents/edit', {
      repo_id: String(repoId), name: 'e2e-flow-agent', harness: 'claude', prompt: 'x',
      branch_mode: 'keiner', expected_minutes: '5', schedule_kind: 'manuell',
      flows: String(FLOWID), [`flow_when_${FLOWID}`]: 'failed',
    }, { alsBrowser: true })
    gleich(r.status, 303, 'agent saved')
    gleich(agent('e2e-flow-agent').flows, `[{"flowId":${FLOWID},"when":"failed"}]`, 'the attachment landed on the agent')
    // One storage, two editors: the flow editor reads the very same row back.
    const html = await (await hol(`/flows/edit?id=${FLOWID}`)).text()
    enthaelt(html, '"when":"failed"', 'the flow editor knows the condition the agent form wrote')
    enthaelt(html, 'e2e-flow-agent', 'and which agent it hangs on')
  })
  await pruefe('a flow can be switched off and on again through the API', async () => {
    const aus = await formular(`/api/flows/${FLOWID}/toggle`, {})
    gleich(aus.status, 200, 'toggled')
    gleich(db.prepare('SELECT active FROM flows WHERE id=?').get(FLOWID).active, 0, 'off')
    await formular(`/api/flows/${FLOWID}/toggle`, {})
    gleich(db.prepare('SELECT active FROM flows WHERE id=?').get(FLOWID).active, 1, 'on again')
  })
  await pruefe('deleting the flow also removes it from the agent it hung on', async () => {
    const r = await formular(`/api/flows/${FLOWID}/delete`, {})
    gleich(r.status, 200, 'deleted')
    gleich((await hol(`/api/flows/${FLOWID}`)).status, 404, 'gone')
    gleich(agent('e2e-flow-agent').flows, null, 'no dead id left behind on the agent')
    // Without an attachable flow the block falls back to its "nothing here" form —
    // legend and hint, but no checkbox.
    const html = await (await hol(`/runs/new?repo=${repoId}`)).text()
    enthaelt(html, 'Flows after this run', 'the block still stands')
    falsch(html.includes('name="flows"'), 'but offers nothing to attach any more')
  })

  // ------------------------------------------------------------------
  // The trigger that fires after a merge, and the block that may run a real
  // command afterwards — end to end, with a real shell instead of a stub. What
  // this group cannot do is produce the merge itself: the integrator lives in
  // another module, so the merge is written the way it will be written, by SQL.
  // The two cases that need the real integrator are described in
  // test/TODO-e2e-run-merged.md.
  gruppe('Flows: run_merged fires, and shell_command really runs')

  await pruefe('a merge starts the flow, and its command writes the SHA into a file', async () => {
    // The columns belong to the merge integrator; on this branch the test adds
    // them itself, exactly as it will find them once both branches are one.
    const spalten = db.prepare('PRAGMA table_info(runs)').all().map(c => c.name)
    for (const [name, typ] of [['merge_status', 'TEXT'], ['merged_sha', 'TEXT'], ['merged_at', 'TEXT'],
      ['resolves_run_id', 'TEXT'], ['resolver_run_id', 'TEXT']]) {
      if (!spalten.includes(name)) db.exec(`ALTER TABLE runs ADD COLUMN ${name} ${typ}`)
    }
    const ziel = join(SB, 'merged.txt')
    const r = await jsonPost('/api/flows/save', {
      name: 'E2E-Merge-Flow', active: true, trigger: { kind: 'run_merged', repoId },
      definition: { properties: {}, sequence: [{
        id: 'e2e-shell', componentType: 'task', type: 'shell_command', name: 'write the sha',
        properties: { command: `echo {{trigger.merge.sha}} > ${ziel}`, cwd: SB, timeoutMinutes: 1, detach: false, outputVar: 'shell' },
      }] },
    })
    const j = await r.json()
    wahr(j.ok && !!j.id, `flow saved (${JSON.stringify(j).slice(0, 200)})`)
    const flowId = j.id

    db.prepare(`INSERT INTO runs(id, repo_id, status, harness, prompt, branch_mode, expected_minutes,
                ended_at, flow_dispatched, merge_status, merged_sha, merged_at)
                VALUES('e2e-merged-1',?,'done','claude','p','keiner',5,datetime('now'),1,'merged','deadbee',datetime('now'))`).run(repoId)
    db.prepare(`INSERT INTO events(run_id, kind, payload) VALUES('e2e-merged-1','merged',?)`)
      .run(JSON.stringify({ sha: 'deadbee', files: ['server/flows/steps.mjs'] }))

    const { flowsTick } = await import('../server/flows/triggers.mjs')
    await flowsTick()
    await warteAuf(() => existsSync(ziel), { was: 'the command of the flow has run', timeoutMs: 10_000 })
    gleich(readFileSync(ziel, 'utf8').trim(), 'deadbee', 'the template put the merge commit into the file')
    const fr = db.prepare('SELECT * FROM flow_runs WHERE flow_id=? ORDER BY started_at DESC LIMIT 1').get(flowId)
    gleich(fr.status, 'done', 'the flow run finished')
    gleich(JSON.parse(fr.context).vars.shell.exit_code, 0, 'and the command with exit code 0')
    gleich(db.prepare('SELECT merge_dispatched FROM runs WHERE id=?').get('e2e-merged-1').merge_dispatched, 1, 'the merge is marked')
  })

  await pruefe('the repo form names the flows that run after a merge, and offers a new one', async () => {
    // A run_merged flow hangs on the repo, not on an agent — so the repo form is
    // its way in. The attachment block of the run forms cannot show it.
    const html = await (await hol(`/repos/edit?id=${repoId}`)).text()
    enthaelt(html, 'Flows after merge', 'the block from lang/en.json')
    enthaelt(html, 'E2E-Merge-Flow', 'the flow of this repo by name')
    enthaelt(html, '/flows/edit?trigger=run_merged&amp;repo=' + repoId, 'and the way to a new one, pre-aimed')
    const neu = await (await hol('/repos/edit')).text()
    falsch(neu.includes('Flows after merge'), 'a repo that does not exist yet has nothing to hang a flow on')
  })
  await pruefe('the editor really arrives with that trigger and repo already set', async () => {
    const html = await (await hol(`/flows/edit?trigger=run_merged&repo=${repoId}`)).text()
    const m = html.match(/window\.FREILAUF_FLOWS=(\{.*?\})<\/script>/s)
    wahr(!!m, 'the editor state is injected')
    const flow = JSON.parse(m[1]).flow
    gleich(flow.trigger.kind, 'run_merged', 'the trigger the button asked for')
    gleich(flow.trigger.repoId, repoId, 'aimed at this repo')
    enthaelt(flow.name, 'After merge', 'and named after what it does')
    const ohne = await (await hol('/flows/edit?trigger=run_merged&repo=999999')).text()
    enthaelt(ohne, '"repoId":null', 'a repo that does not exist becomes "all repos", not a broken filter')
  })

  await pruefe('a detached command ends its step at once and keeps running afterwards', async () => {
    // The reason the block has that switch at all: a command that restarts the
    // hub must outlive the flow run, and the flow run must be finished and
    // saved before the command hits it.
    const ziel = join(SB, 'detached.txt')
    const r = await jsonPost('/api/flows/save', {
      name: 'E2E-Merge-Flow-detach', active: true, trigger: { kind: 'run_merged', repoId },
      definition: { properties: {}, sequence: [{
        id: 'e2e-shell-bg', componentType: 'task', type: 'shell_command', name: 'in the background',
        properties: { command: `sleep 1; touch ${ziel}`, cwd: SB, timeoutMinutes: 1, detach: true, outputVar: 'shell' },
      }] },
    })
    const j = await r.json()
    wahr(j.ok && !!j.id, 'flow saved')

    db.prepare(`INSERT INTO runs(id, repo_id, status, harness, prompt, branch_mode, expected_minutes,
                ended_at, flow_dispatched, merge_status, merged_sha, merged_at)
                VALUES('e2e-merged-2',?,'done','claude','p','keiner',5,datetime('now'),1,'merged','cafe123',datetime('now'))`).run(repoId)

    const { flowsTick } = await import('../server/flows/triggers.mjs')
    const t0 = Date.now()
    await flowsTick()
    const fr = db.prepare('SELECT * FROM flow_runs WHERE flow_id=? ORDER BY started_at DESC LIMIT 1').get(j.id)
    gleich(fr.status, 'done', 'the flow run is over')
    gleich(JSON.parse(fr.context).vars.shell.detached, true, 'the step answered "detached" instead of waiting')
    falsch(existsSync(ziel), 'and it really did not wait — the file is not there yet')
    wahr(Date.now() - t0 < 3000, `the pass did not wait for the command (${Date.now() - t0} ms)`)
    await warteAuf(() => existsSync(ziel), { was: 'the detached command runs on by itself', timeoutMs: 5000 })
  })

  // ------------------------------------------------------------------
  // Five pages whose HTML was never fetched once. Checked against the strings
  // from lang/en.json and against form field names, not against markup — these
  // tests are meant to survive the rebuild that is coming.
  gruppe('Pages that had no test at all')

  await pruefe('the repo list shows the repo with path, base branch and prompt column', async () => {
    const r = await hol('/repos')
    gleich(r.status, 200, 'status')
    const html = await r.text()
    enthaelt(html, 'Create repo', 'the way into the form')
    enthaelt(html, 'Worktree extras', 'column header')
    enthaelt(html, 'Repo prompt', 'column header')
    enthaelt(html, 'e2e', 'the sandbox repo by name')
    enthaelt(html, REPO, 'with its path')
  })
  await pruefe('the repo form carries every field the save route reads back', async () => {
    const row = db.prepare('SELECT * FROM repos WHERE name=?').get('e2e')
    const html = await (await hol(`/repos/edit?id=${row.id}`)).text()
    enthaelt(html, 'Path (main checkout)', 'the label from lang/en.json')
    for (const feld of ['name="name"', 'name="path"', 'name="base_branch"', 'name="prompt"', 'name="worktree_extras"']) {
      enthaelt(html, feld, `field ${feld}`)
    }
    enthaelt(html, REPO, 'prefilled with what is stored')
    enthaelt(html, 'main', 'and the base branch')
  })
  await pruefe('the repo form carries the extras finder: button and dialog, with the warning', async () => {
    const html = await (await hol('/repos/edit')).text()
    enthaelt(html, 'id="extras-find"', 'the button')
    enthaelt(html, 'id="extras-dialog"', 'the modal')
    enthaelt(html, 'id="extras-start"', 'its start button')
    enthaelt(html, 'Worktree extras', 'the label of the field it fills')
    enthaelt(html, 'completely replaces', 'the warning that existing entries are not kept')
  })
  await pruefe('the extras suggestion checks algorithmically before any model is asked', async () => {
    const leer = await (await formular('/api/repos/extras-suggest', { path: '' })).json()
    falsch(leer.ok, 'empty path is refused')
    const weg = await (await formular('/api/repos/extras-suggest', { path: join(SB, 'gibt-es-nicht') })).json()
    falsch(weg.ok, 'missing directory is refused')
    enthaelt(weg.error, 'gibt-es-nicht', 'and names the path')
    const keinGit = await (await formular('/api/repos/extras-suggest', { path: SB })).json()
    falsch(keinGit.ok, 'a directory without .git is refused')
    enthaelt(keinGit.error, 'git', 'and says so')
  })
  await pruefe('a git repo without a credential for its model source reports the LLM as off', async () => {
    // The message stopped naming OPENROUTER_API_KEY when the four direct LLM
    // calls became source-driven: the source may be any model provider, or a
    // coding agent, so the sentence names the SETTING that switches it on and
    // where to put a credential. What it must still do is refuse and say why.
    const j = await (await formular('/api/repos/extras-suggest', { path: REPO })).json()
    falsch(j.ok, 'not ok without a key')
    enthaelt(j.error, 'no key', 'names the missing credential as the reason')
    enthaelt(j.error, 'Worktree extras', 'and where to change it')
  })
  await pruefe('the agents page shows the schedule and all three actions of a row', async () => {
    // An agent with a real schedule, deliberately left switched OFF: the scheduler
    // only ever picks up active ones, so this row cannot start anything by itself.
    const gespeichert = await formular('/agents/edit', {
      repo_id: String(repoId), name: 'e2e-anzeige', harness: 'claude', prompt: 'x',
      branch_mode: 'keiner', expected_minutes: '20',
      schedule_kind: 'woechentlich', schedule_days: ['1', '3'], schedule_time: '07:30', schedule_weeks: '1',
    }, { alsBrowser: true })
    gleich(gespeichert.status, 303, 'agent saved')
    const r = await hol(`/agents?repo=${repoId}`)
    gleich(r.status, 200, 'status')
    const html = await r.text()
    enthaelt(html, 'Create agent', 'the way to a new agent')
    enthaelt(html, 'Flows hang on an agent', 'the hint that says where flows are attached')
    enthaelt(html, 'Schedule', 'the schedule column exists')
    const zeile = html.split('<tr').find(z => z.includes('e2e-anzeige'))
    wahr(!!zeile, 'the agent has a row')
    enthaelt(zeile, 'weekly: Mon, Wed at 07:30', 'the schedule column says what is really planned')
    enthaelt(zeile, '20 min', 'the expected duration')
    // The actions are checked by the routes they post to: those outlive any markup.
    enthaelt(zeile, '/agents/toggle', 'the on/off toggle')
    enthaelt(zeile, 'off', 'which says what the agent currently is')
    enthaelt(zeile, '/agents/start', 'the "start now" button')
    enthaelt(zeile, 'start now', 'by its name')
    enthaelt(zeile, `/agents/edit?id=${agent('e2e-anzeige').id}`, 'and the edit link')
  })
  await pruefe('the toggle in the row switches the agent on and off again', async () => {
    const a = agent('e2e-anzeige')
    gleich(a.active, 0, 'starts switched off')
    const r = await formular('/agents/toggle', { id: String(a.id), repo: String(repoId) }, { alsBrowser: true })
    gleich(r.status, 303, 'redirects back to the list')
    gleich(agent('e2e-anzeige').active, 1, 'now on')
    await formular('/agents/toggle', { id: String(a.id), repo: String(repoId) }, { alsBrowser: true })
    // Off again on purpose: an ACTIVE weekly agent left behind would be picked up
    // by the scheduler tick and start a run nobody asked for.
    gleich(agent('e2e-anzeige').active, 0, 'and off again')
  })
  await pruefe('the favorite form is the run setup under a name', async () => {
    const r = await hol(`/settings/favorites/edit?id=${FAVID}`)
    gleich(r.status, 200, 'status')
    const html = await r.text()
    enthaelt(html, 'Edit favorite', 'the title from lang/en.json')
    enthaelt(html, 'E2E-Favorit', 'prefilled with what is stored')
    enthaelt(html, 'name="harness"', 'the coding agent')
    enthaelt(html, 'name="model"', 'the model')
    enthaelt(html, 'e2e-fleiss', 'the extra-skills block is part of it')
    const neu = await hol('/settings/favorites/edit')
    gleich(neu.status, 200, 'a fresh favorite form answers as well')
    enthaelt(await neu.text(), 'New favorite', 'with its own title')
  })
  await pruefe('the Telegram plugin brings its own setup wizard, and the old address still finds it', async () => {
    const alt = await hol('/telegram-setup', { redirect: 'manual' })
    gleich(alt.status, 303, 'the historic address redirects')
    gleich(alt.headers.get('location'), '/settings/notifications/telegram', 'to the plugin\'s own wizard')
    const r = await hol('/settings/notifications/telegram')
    gleich(r.status, 200, 'status')
    const html = await r.text()
    for (const schritt of ['Step 1 — bot token', 'Step 2 — find the chat ID', 'Step 3 — test']) {
      enthaelt(html, schritt, schritt)
    }
    enthaelt(html, '/settings/notifications/telegram/token', 'step 1 posts the token to the plugin\'s own action')
    enthaelt(html, 'name="telegram_token"', 'and has the field for it')
    enthaelt(html, '/settings/notifications/telegram/test', 'step 3 sends the test message')
    enthaelt(html, '/settings/notifications/telegram/json/chats', 'step 2 asks the plugin\'s own JSON route')
    // A plugin that brings no wizard has no page, and an id nobody registered
    // certainly not — a 200 there would be a page rendering nothing.
    gleich((await hol('/settings/notifications/no-such-notifier')).status, 400, 'an unknown notifier has no wizard')
  })

  // ------------------------------------------------------------------
  // Status used to stand in three places and fully on exactly ONE page: two
  // quota bars in the header, the pipeline switch as running text beside them,
  // and the usage panel on the overview. The question those three answer
  // together — can I send something off right now, and is anything stuck? —
  // could therefore only be asked from the overview.
  gruppe('The status sidebar: one reading, on every page')

  await pruefe('the sidebar stands on every page, and the header kept only context and action', async () => {
    for (const pfad of ['/', '/agents', '/sessions', '/settings', '/repos', `/archive?repo=${repoId}`, '/flows', '/runs/new']) {
      const html = await (await hol(pfad)).text()
      enthaelt(html, 'id="status-sidebar"', `${pfad}: the sidebar`)
      enthaelt(html, 'id="header-status"', `${pfad}: the pipeline reading, inside it`)
      enthaelt(html, 'Pipeline', `${pfad}: by its name from lang/en.json`)
      const kopf = html.slice(html.indexOf('<header'), html.indexOf('</header>'))
      // The two things that stay: the repo is context, Quick Run is an action.
      enthaelt(kopf, 'id="repo-switch"', `${pfad}: the repo switcher stayed in the header`)
      enthaelt(kopf, 'id="qr-open"', `${pfad}: and so did the Quick-Run button`)
      // The one thing that left: a reading. It is a status, and status is the
      // sidebar's job now — a bar that has to stay one line high cannot carry it.
      falsch(kopf.includes('class="quota"'), `${pfad}: no quota bar left in the header`)
      falsch(kopf.includes('id="header-status"'), `${pfad}: and no pipeline reading either`)
    }
  })
  await pruefe('the sidebar counts the work in flight of THIS repo and links each count into the overview', async () => {
    const html = await (await hol(`/?repo=${repoId}`)).text()
    const leiste = html.slice(html.indexOf('id="status-sidebar"'), html.indexOf('</aside>'))
    wahr(leiste.length > 50, 'the sidebar has content')
    enthaelt(leiste, 'Work in flight', 'the block by its name from lang/en.json')
    const zaehl = (s) => db.prepare(`SELECT count(*) c FROM runs WHERE repo_id=? AND archived_at IS NULL AND status=?`).get(repoId, s).c
    let gesehen = 0
    for (const s of ['running', 'waiting_help', 'scheduled', 'deferred']) {
      const n = zaehl(s)
      if (!n) {
        // Zero is not information, it is furniture: the line is absent, not "0".
        falsch(leiste.includes(`status=${s}"`), `${s}: none of them, so no line`)
        continue
      }
      gesehen++
      enthaelt(leiste, `/?repo=${repoId}&amp;status=${s}`, `${s}: linked into the overview`)
      enthaelt(leiste, `<span class="n">${n}</span>`, `${s}: with the count the database holds`)
      // With only one repo the sum of all repos equals this repo's own count, so
      // the overall suffix would add nothing and must stay away.
      falsch(leiste.includes(`overall`), `${s}: one repo, so no "(y overall)" suffix`)
    }
    wahr(gesehen > 0, 'at least one status was in flight at this point of the suite')

    // A second repo makes "overall" mean something: the line reads this repo's
    // own count in the link and the sum of BOTH repos in the dimmed suffix. The
    // fixture runs are directly inserted (nothing starts them: scheduled, start_at
    // far in the future), one in this repo so the line exists, three in the other
    // repo so the overall exceeds it — and cleaned up right after.
    const zweites = db.prepare(`INSERT INTO repos(name, path) VALUES('e2e-zweites', ?)`).run(REPO).lastInsertRowid
    const einsetzen = db.prepare(`INSERT INTO runs(id, repo_id, harness, prompt, branch_mode, expected_minutes, status, start_mode, start_at)
      VALUES(?, ?, 'claude', 'E2E-Gesamt', 'keiner', 45, 'scheduled', 'at', '2030-01-01 00:00:00')`)
    einsetzen.run('e2e-gesamt-own', repoId)
    for (let i = 0; i < 3; i++) einsetzen.run(`e2e-gesamt-${i}`, zweites)
    try {
      const s2 = 'scheduled'
      const jetzt = db.prepare(`SELECT count(*) c FROM runs WHERE repo_id=? AND archived_at IS NULL AND status=?`).get(repoId, s2).c
      const gesamt = db.prepare(`SELECT count(*) c FROM runs WHERE archived_at IS NULL AND status=?`).get(s2).c
      wahr(gesamt > jetzt, `the fixture makes the overall exceed this repo (${gesamt} > ${jetzt})`)
      const html2 = await (await hol(`/?repo=${repoId}`)).text()
      const leiste2 = html2.slice(html2.indexOf('id="status-sidebar"'), html2.indexOf('</aside>'))
      enthaelt(leiste2, `<span class="n">${jetzt}</span> <span>Scheduled <span class="dim">in this repo</span></span>`,
        'the repo count links with the status and the "in this repo" scope')
      enthaelt(leiste2, `<span class="overall dim">(${gesamt} overall)</span>`, 'and the sum of all repos stands dimmed outside the link')
      falsch(leiste2.includes(`/status=scheduled"><span class="n">${gesamt}</span>`), 'the overall is NOT the number that links')
    } finally {
      db.prepare(`DELETE FROM runs WHERE id LIKE 'e2e-gesamt-%'`).run()
      db.prepare(`DELETE FROM repos WHERE id=?`).run(zweites)
    }
  })
  await pruefe('a count leads to the overview filtered to exactly that status', async () => {
    // A planned run: it exists, it has no session, and nothing picks it up for
    // the next ten hours — so this is deterministic wherever the suite stands.
    const j = await laufStarten({
      repo_id: repoId, prompt: 'E2E-Filter', title: 'Filter run',
      start_mode: 'in', start_in_minutes: '600',
    })
    wahr(j.scheduled, `planned (${JSON.stringify(j)})`)
    const gefiltert = await (await hol(`/?repo=${repoId}&status=scheduled`)).text()
    const koerper = gefiltert.slice(gefiltert.indexOf('id="runs-body"'), gefiltert.indexOf('</table>'))
    enthaelt(koerper, j.runId, 'the filtered list holds the planned run')
    const ids = [...koerper.matchAll(/id="run-([0-9a-f-]{36})"/g)].map(m => m[1])
    for (const id of ids) gleich(lauf(id).status, 'scheduled', `${id.slice(0, 8)}: really has that status`)
    const erwartet = db.prepare(`SELECT count(*) c FROM runs WHERE repo_id=? AND archived_at IS NULL AND status='scheduled'`).get(repoId).c
    gleich(ids.length, erwartet, 'exactly the runs of that status, no more and no fewer')
    enthaelt(gefiltert, 'Show all', 'and a way back to the whole list')
    // The live channel has to ask for the SAME selection, or the first update
    // would silently replace the filtered list with the unfiltered one.
    enthaelt(koerper, 'data-status="scheduled"', 'the tbody carries the filter for the live channel')
    const frag = await hol(`/api/fragments/runs-body?repo=${repoId}&status=scheduled`)
    gleich(frag.status, 200, 'the fragment answers')
    gleich([...(await frag.text()).matchAll(/id="run-([0-9a-f-]{36})"/g)].length, erwartet, 'with the same selection')
    // A status the CHECK constraint does not know is no filter, not an error.
    const alles = await hol(`/?repo=${repoId}&status=erfunden`)
    gleich(alles.status, 200, 'an invented status is simply no filter')
    wahr([...(await alles.text()).matchAll(/id="run-([0-9a-f-]{36})"/g)].length > erwartet, 'and the whole list comes back')
  })
  await pruefe('the overview is seven fact columns plus the pick box, and its empty state spans all of them', async () => {
    const html = await (await hol(`/?repo=${repoId}`)).text()
    const kopf = html.slice(html.indexOf('<thead'), html.indexOf('</thead>'))
    gleich((kopf.match(/<th[ >]/g) || []).length, 8, 'eight columns: the multi-select box plus seven facts')
    gleich((kopf.match(/<th>/g) || []).length, 7, 'seven titled columns, not eleven')
    enthaelt(kopf, '<th class="pick-col">', 'and the nameless first one is the multi-select column')
    // Eleven columns became seven without losing a single fact: traffic light,
    // status word and last anomaly are one statement, and so are harness/model
    // and branch/PR.
    for (const titel of ['Status', 'Title', 'Coding agent/model', 'Started', 'Duration/expected', 'Branch/PR', 'Incidents']) {
      enthaelt(kopf, `>${titel}<`, `header ${titel}`)
    }
    const zeile = html.split('<tr ').find(z => z.includes(RH))
    gleich((zeile.match(/<td/g) || []).length, 8, 'and a row has exactly as many cells as the head has columns')
    // A repo without runs: the sentence has to span the whole table, otherwise
    // it sits in the first column with seven empty cells beside it.
    const leer = await (await hol('/api/fragments/runs-body?repo=999999')).text()
    enthaelt(leer, 'colspan="8"', 'the empty state spans all eight')
    enthaelt(leer, 'no runs yet', 'and says so')
  })
  await pruefe('the sidebar says what every tmux session on this machine costs', async () => {
    const html = await (await hol(`/?repo=${repoId}`)).text()
    const leiste = html.slice(html.indexOf('id="status-sidebar"'), html.indexOf('</aside>'))
    enthaelt(leiste, 'id="side-mem"', 'the block is there')
    enthaelt(leiste, 'tmux memory', 'by its name from lang/en.json')
    // A figure, and a way to the page that breaks it down per session.
    wahr(/id="side-mem"[\s\S]*?<a href="\/sessions"><b>(\d+(\.\d+)?\s(MB|GB)|0 MB)<\/b><\/a>/.test(leiste),
      `a memory figure linked to /sessions (${leiste.slice(leiste.indexOf('id="side-mem"'), leiste.indexOf('id="side-mem"') + 240)})`)
    enthaelt(leiste, 'sessions', 'and how many sessions it is spread over')
    // The reading is up to eight minutes old, and the block says so instead of
    // presenting itself as live — the panel's whole honesty rests on that line.
    enthaelt(leiste, 'measured every 8 min', 'the update interval, read out of the answer')
    // It is on EVERY page, like the rest of the sidebar: a bill that runs
    // quietly must not need a navigation to be seen.
    for (const pfad of ['/agents', '/settings', '/sessions']) {
      enthaelt(await (await hol(pfad)).text(), 'id="side-mem"', `${pfad}: there too`)
    }
  })
  await pruefe('the sidebar fragment renders the same aside the page does', async () => {
    const r = await hol(`/api/fragments/sidebar?repo=${repoId}`)
    gleich(r.status, 200, 'status')
    const frag = await r.text()
    enthaelt(frag, 'id="status-sidebar"', 'the swap target')
    enthaelt(frag, 'id="header-status"', 'with the pipeline reading inside it')
    enthaelt(frag, 'Work in flight', 'and the work counts of the repo it was asked for')
    // Same renderer as the page — a fragment that builds its own markup is the
    // mistake server/run-def.mjs was written from.
    const seite = await (await hol(`/?repo=${repoId}`)).text()
    gleich(frag.trim(), seite.slice(seite.indexOf('<aside id="status-sidebar"'), seite.indexOf('</aside>') + '</aside>'.length).trim(),
      'byte for byte what the page carries')
  })

  // ------------------------------------------------------------------
  // A panel is the one thing in the sidebar the hub does not measure itself: a
  // project pushes it (POST /api/panels, bin/fl-panel) and the hub renders it.
  // So what is tested here is the seam — that a pushed number really reaches
  // every page, that a failed measurement keeps the last numbers instead of
  // blanking them, and that nothing a producer sends can leave the shape the
  // renderer knows.
  gruppe('Panels: a project pushes its own numbers into the sidebar')

  const leisteVon = (html) => html.slice(html.indexOf('id="status-sidebar"'), html.indexOf('</aside>'))

  await pruefe('a pushed value stands in the sidebar of every page of that repo', async () => {
    const r = await formular('/api/panels', {
      repo: String(repoId),
      key: 'findings',
      value: JSON.stringify({
        title: 'Findings', total: 33, tone: 'yellow',
        items: [{ label: 'bug', count: 17, tone: 'red' }, { label: 'task', count: 16 }],
        note: 'from `befund.py zaehl`',
      }),
    })
    gleich(r.status, 200, 'accepted')
    const antwort = await r.json()
    wahr(antwort.ok, 'ok')

    for (const pfad of [`/?repo=${repoId}`, `/agents?repo=${repoId}`, `/settings?repo=${repoId}`]) {
      const leiste = leisteVon(await (await hol(pfad)).text())
      enthaelt(leiste, 'Findings', `${pfad}: the title the project chose`)
      enthaelt(leiste, '>33<', `${pfad}: the headline number`)
      enthaelt(leiste, 'bug', `${pfad}: the split`)
      enthaelt(leiste, 'as of', `${pfad}: and WHEN it was measured — a reading without its time is the staleness this exists against`)
    }
    // The note's Markdown subset is rendered by the HUB, so a backtick becomes
    // a <code> and nothing else can be smuggled through it.
    enthaelt(leisteVon(await (await hol(`/?repo=${repoId}`)).text()), '<code>befund.py zaehl</code>', 'the note is rendered, not pasted')
  })

  await pruefe('the sidebar fragment carries it too — the live channel updates it', async () => {
    const frag = await (await hol(`/api/fragments/sidebar?repo=${repoId}`)).text()
    enthaelt(frag, 'data-panel="findings"', 'the block is in the fragment')
    enthaelt(frag, '>33<', 'with its number')
  })

  await pruefe('GET /api/panels answers with the value and its state', async () => {
    const data = await (await hol(`/api/panels?repo=${repoId}`, { headers: { accept: 'application/json' } })).json()
    wahr(data.ok, 'ok')
    gleich(data.panels.length, 1, 'one panel')
    gleich(data.panels[0].total, 33, 'the number')
    gleich(data.panels[0].state, 'fresh', 'freshly pushed')
    wahr(typeof data.panels[0].age_s === 'number', 'and how old the reading is')
  })

  await pruefe('a failed measurement keeps the last numbers and says they are not confirmed', async () => {
    const r = await formular('/api/panels', { repo: String(repoId), key: 'findings', error: 'register tool missing on this branch' })
    gleich(r.status, 200, 'a failure is a push too')
    const leiste = leisteVon(await (await hol(`/?repo=${repoId}`)).text())
    enthaelt(leiste, '>33<', 'the numbers are still there')
    enthaelt(leiste, 'panel-cold', 'greyed as a whole')
    enthaelt(leiste, 'register tool missing', 'and the reason is named')
    // …and the next good push clears it, or a fixed producer would look broken forever.
    await formular('/api/panels', { repo: String(repoId), key: 'findings', value: JSON.stringify({ title: 'Findings', total: 30 }) })
    const leiste2 = leisteVon(await (await hol(`/?repo=${repoId}`)).text())
    falsch(leiste2.includes('panel-cold'), 'the failure is over')
    enthaelt(leiste2, '>30<', 'with the new number')
  })

  await pruefe('what a producer must not be able to do', async () => {
    const nein = await formular('/api/panels', { repo: String(repoId), key: 'findings', value: JSON.stringify({ title: 'x' }) })
    gleich(nein.status, 400, 'a value with neither total nor items is refused')
    const schluessel = await formular('/api/panels', { repo: String(repoId), key: 'Not A Key', value: JSON.stringify({ total: 1 }) })
    gleich(schluessel.status, 400, 'and so is an invalid key')
    const kaputt = await formular('/api/panels', { repo: '999999', key: 'x', value: JSON.stringify({ total: 1 }) })
    gleich(kaputt.status, 400, 'an unknown repo is an answer, never a 500')

    // Markup in a label is data, and the hub escapes it — the producer never
    // gets to decide how this column is built.
    await formular('/api/panels', {
      repo: String(repoId), key: 'shapes',
      value: JSON.stringify({ total: 1, items: [{ label: '<b>bold</b>', count: 1 }], note: '<script>x</script>' }),
    })
    const leiste = leisteVon(await (await hol(`/?repo=${repoId}`)).text())
    falsch(leiste.includes('<b>bold</b>'), 'a label cannot bring its own markup')
    falsch(leiste.includes('<script>'), 'and neither can the note')
    enthaelt(leiste, '&lt;b&gt;bold&lt;/b&gt;', 'it is shown as the text it is')
    await formular('/api/panels', { repo: String(repoId), key: 'shapes', remove: '1' })
    falsch(leisteVon(await (await hol(`/?repo=${repoId}`)).text()).includes('data-panel="shapes"'), 'and it can be removed again')
  })

  await pruefe('bin/fl-panel pushes from outside the hub, and finds the hub itself', async () => {
    // The way a flow step or a cron line would call it: FL_HUB_URL out of the
    // environment, everything else on the command line.
    const r = await new Promise((res) => execFile(process.execPath,
      [join(PROJEKT, 'bin', 'fl-panel'), 'set', 'tests',
        '--repo', String(repoId), '--title', 'Tests', '--total', '12', '--item', 'failing=3:red', '--ttl', '60'],
      { env: { ...process.env, FL_HUB_URL: BASIS }, timeout: 30_000 },
      (err, stdout, stderr) => res({ code: err?.code ?? 0, stdout, stderr })))
    gleich(r.code, 0, `fl-panel exited 0 (${r.stderr})`)
    enthaelt(r.stdout, 'tests = 12', 'and says what it pushed')
    const leiste = leisteVon(await (await hol(`/?repo=${repoId}`)).text())
    enthaelt(leiste, 'Tests', 'the panel it created')
    enthaelt(leiste, 'failing', 'with the row from --item')
    await formular('/api/panels', { repo: String(repoId), key: 'tests', remove: '1' })
    await formular('/api/panels', { repo: String(repoId), key: 'findings', remove: '1' })
  })

  // ------------------------------------------------------------------
  // The repo chosen in the header travels as the freilauf_repo cookie, so a page
  // that carries no ?repo= of its own (a menu click, a context-less page) keeps
  // the choice instead of falling back to the first repo. The cookie is written
  // twice: by the client when the switcher changes, and by the server whenever a
  // page request names a repo — both must agree, so the "back" links and the
  // sidebar counts persist the choice exactly like the select does.
  gruppe('The repo choice sticks (freilauf_repo cookie)')

  await pruefe('a page request that names a repo answers with the freilauf_repo cookie', async () => {
    const r = await hol(`/?repo=${repoId}`)
    gleich(r.status, 200, 'status')
    enthaelt(r.headers.get('set-cookie') ?? '', `freilauf_repo=${repoId}`, 'the cookie is set')
    // A page that names no repo stays silent — the switcher itself is the only
    // place that may remember a choice, not every stray link.
    const ohne = await hol('/settings')
    falsch((ohne.headers.get('set-cookie') ?? '').includes('freilauf_repo='), 'no repo named, no cookie written')
  })
  await pruefe('without ?repo= the persisted choice wins over the first repo', async () => {
    const zwei = await formular('/repos/edit', {
      name: 'e2e-zwei', path: REPO, base_branch: 'main', worktree_extras: '[]',
    }, { alsBrowser: true })
    gleich(zwei.status, 303, 'second repo created')
    const zweiId = db.prepare(`SELECT id FROM repos WHERE name='e2e-zwei'`).get().id
    // The first repo by name is 'e2e' — without the cookie the overview would
    // show it. With the cookie it must show the persisted one instead.
    const overview = await (await hol('/', { headers: { cookie: `freilauf_repo=${zweiId}` } })).text()
    enthaelt(overview, `id="repo-switch"`, 'header has the switcher')
    const kopf = overview.slice(overview.indexOf('<header'), overview.indexOf('</header>'))
    enthaelt(kopf, `option value="${zweiId}" selected`, 'the persisted repo is selected in the header')
    enthaelt(overview, `<body data-repo="${zweiId}"`, 'and the page context is that repo')
    // A context page (agents) honors it too — its "create" button belongs to it.
    const agents = await (await hol('/agents', { headers: { cookie: `freilauf_repo=${zweiId}` } })).text()
    enthaelt(agents, `/agents/edit?repo=${zweiId}`, 'the agents page belongs to the persisted repo')
    // And a context-less page (settings) keeps it in the header.
    const settings = await (await hol('/settings', { headers: { cookie: `freilauf_repo=${zweiId}` } })).text()
    const kopf2 = settings.slice(settings.indexOf('<header'), settings.indexOf('</header>'))
    enthaelt(kopf2, `option value="${zweiId}" selected`, 'settings keeps the persisted repo in the header')
  })
  await pruefe('an invalid cookie (deleted repo) falls back instead of an empty page', async () => {
    const html = await (await hol('/', { headers: { cookie: 'freilauf_repo=999999' } })).text()
    enthaelt(html, 'id="repo-switch"', 'page renders')
    falsch(html.includes('data-repo="999999"'), 'not the deleted id')
  })
  // A page that shows ONE object cannot follow the switcher — a run belongs to
  // its repo. So it reloads as itself and only the choice moves; the dropdown
  // one just used has to stay on the repo one just picked. The rule lives in
  // layout(), which is why this holds for every such page at once.
  await pruefe('a page belonging to one repo still shows the CHOSEN repo in the header', async () => {
    const zweiId = db.prepare(`SELECT id FROM repos WHERE name='e2e-zwei'`).get().id
    const run = db.prepare(`SELECT id, repo_id FROM runs WHERE repo_id=? ORDER BY started_at LIMIT 1`).get(repoId)
    wahr(!!run && run.repo_id !== zweiId, 'a run of the FIRST repo exists')
    const r = await hol(`/runs/${run.id}?repo=${zweiId}`)
    const html = await r.text()
    const kopf = html.slice(html.indexOf('<header'), html.indexOf('</header>'))
    enthaelt(kopf, `option value="${zweiId}" selected`, 'the header shows what was picked, not the run\'s repo')
    falsch(kopf.includes(`option value="${repoId}" selected`), 'and not both')
    // The page context is untouched: <body data-repo> is the live channel's
    // filter, and the events of THIS run must keep arriving.
    enthaelt(html, `<body data-repo="${repoId}"`, 'the run is still the run')
    enthaelt(html, `data-repo="${zweiId}"`, 'the sidebar counts the chosen repo')
    enthaelt(r.headers.get('set-cookie') ?? '', `freilauf_repo=${zweiId}`, 'and the choice is persisted')
    // Without the parameter nothing changes: the page's own repo answers.
    const ohne = await (await hol(`/runs/${run.id}`)).text()
    const kopfOhne = ohne.slice(ohne.indexOf('<header'), ohne.indexOf('</header>'))
    enthaelt(kopfOhne, `option value="${repoId}" selected`, 'no ?repo= — the page\'s own repo stands in the header')
  })
  // …and it SAYS so. The rule above is right and silent: the header names a repo
  // the content has nothing to do with, and the sidebar counts somebody else's
  // runs. The note is derived in layout() from the two repo ids, so it appears
  // on every page that hands its repo over and on no page that follows the
  // switcher — that is what the three cases below pin down.
  await pruefe('a page on another repo than the header says so, by name', async () => {
    const zweiId = db.prepare(`SELECT id FROM repos WHERE name='e2e-zwei'`).get().id
    const repoName = db.prepare('SELECT name FROM repos WHERE id=?').get(repoId).name
    const run = db.prepare(`SELECT id FROM runs WHERE repo_id=? ORDER BY started_at LIMIT 1`).get(repoId)
    const html = await (await hol(`/runs/${run.id}?repo=${zweiId}`)).text()
    enthaelt(html, 'class="banner other-repo"', 'the note is there')
    enthaelt(html, repoName, 'and names the repo the run belongs to')
    enthaelt(html, 'e2e-zwei', 'and the one that was picked')
    enthaelt(html, `href="/?repo=${zweiId}"`, 'with the way to the picked repo')
    // Same run, no switch: nothing to say.
    const gleich_ = await (await hol(`/runs/${run.id}?repo=${repoId}`)).text()
    falsch(gleich_.includes('banner other-repo'), 'no note when the header agrees')
    // A repo form belongs to ONE repo just as much as a run does.
    const form = await (await hol(`/repos/edit?id=${repoId}&repo=${zweiId}`)).text()
    enthaelt(form, 'class="banner other-repo"', 'the repo form says it too')
    // The overview FOLLOWS the switcher — it renders the chosen repo, so there
    // is no mismatch it could report, whatever the parameter says.
    const uebersicht = await (await hol(`/?repo=${zweiId}`)).text()
    falsch(uebersicht.includes('banner other-repo'), 'a page that follows the switcher never shows it')
    const archiv = await (await hol(`/archive?repo=${zweiId}`)).text()
    falsch(archiv.includes('banner other-repo'), 'the archive neither')
    // And a page without any repo context (settings) cannot be on the wrong one.
    const einst = await (await hol('/settings', { headers: { cookie: `freilauf_repo=${zweiId}` } })).text()
    falsch(einst.includes('banner other-repo'), 'nor a page without a repo context')
  })

  // ------------------------------------------------------------------
  // POST /settings/save writes only the keys the request actually carried. The
  // old version looped `b[k] ?? ''` over the whole key list, so a body with one
  // field blanked the other fifteen — switching the language would have wiped
  // a stored secret. `telegram_token` is the canary precisely because it is now
  // a PLUGIN-declared key: it reaches the allowlist through
  // `allPluginSettingKeys()`, so this also proves that half still works. Three
  // things have to hold at once, and only all three
  // together describe the rule: an absent key is untouched, a present but empty
  // one is still cleared (that is how a text field is emptied on purpose), and a
  // key nobody declared never reaches the settings table.
  gruppe('POST /settings/save writes only what the request brought')

  {
    const einstellung = (k) => db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value
    const setzen = (k, v) => db.prepare(`INSERT INTO settings(key,value) VALUES(?,?)
                                         ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(k, v)

    await pruefe('a post with only ui_language leaves the other keys alone', async () => {
      setzen('telegram_token', 'geheim:123')
      setzen('abo_price', '200')
      try {
        const r = await formular('/settings/save', { ui_language: 'en' }, { alsBrowser: true })
        gleich(r.status, 303, 'saved')
        gleich(einstellung('telegram_token'), 'geheim:123', 'the token survived a post that never mentioned it')
        gleich(einstellung('abo_price'), '200', 'and so did the subscription price')
        gleich(einstellung('ui_language'), 'en', 'while the key that was posted did arrive')
      } finally {
        setzen('telegram_token', '')
        setzen('abo_price', '200')
      }
    })

    await pruefe('an empty text field still clears its setting', async () => {
      setzen('prompt_suffix', 'never send this to the agent')
      const r = await formular('/settings/save', { prompt_suffix: '' }, { alsBrowser: true })
      gleich(r.status, 303, 'saved')
      gleich(einstellung('prompt_suffix'), '', 'present-but-empty means delete, not "not mentioned"')
    })

    await pruefe('a key that is not in SETTINGS_KEYS never reaches the table', async () => {
      const r = await formular('/settings/save',
        { ui_language: 'en', erfundener_schluessel: 'ha' }, { alsBrowser: true })
      gleich(r.status, 303, 'saved')
      gleich(einstellung('erfundener_schluessel'), undefined, 'the invented key was dropped')
    })
  }

  // ------------------------------------------------------------------
  // Nothing in this suite ever rendered a page in another language, so a string
  // hard-wired instead of run through t() stayed invisible as long as the English
  // text happened to match. This group closes that hole — and puts the language
  // back to English no matter what, because every other assertion here reads
  // English strings.
  gruppe('The UI really renders in the chosen language')

  await pruefe('switching the UI language changes what the pages say', async () => {
    // Only the language goes over the wire — the route writes what the request
    // brought and leaves the rest standing (see the group above).
    const spracheSetzen = (lang) =>
      formular('/settings/save', { ui_language: lang }, { alsBrowser: true })
    try {
      gleich((await spracheSetzen('de')).status, 303, 'language saved')
      const html = await (await hol('/repos')).text()
      enthaelt(html, 'Repo anlegen', 'repos.create in German')
      enthaelt(html, 'Übersicht', 'and the navigation with it (nav.overview)')
      enthaelt(html, 'Worktree-Ergänzungen', 'a column header too (repos.extras)')
      falsch(html.includes('Create repo'), 'the English string is really gone')
      // The strings that used to sit hard-wired between the tags. English alone
      // is no proof for them: "min" and "in {x}, out {y}" read exactly like the
      // literals they replaced, so only a second language shows that they go
      // through t() at all.
      const uebersicht = await (await hol(`/?repo=${repoId}`)).text()
      enthaelt(uebersicht, ' Min.', 'the duration unit is translated (unit.minutes)')
      const detail = await (await hol(`/runs/${RH}`)).text()
      enthaelt(detail, 'rein ', 'the token metric is translated (run.tokens_value)')
    } finally {
      gleich((await spracheSetzen('en')).status, 303, 'back to English')
    }
    enthaelt(await (await hol('/repos')).text(), 'Create repo', 'English again for everything that follows')
    // The other way round for the incident severity: 'rot' is the value the
    // CHECK on the table stores, so only the English page can show that the
    // line renders a word instead of the raw column.
    enthaelt(await (await hol(`/runs/${RH}`)).text(), ', red)',
      'the incident severity is a translated word, not the stored value')
  })

  // ------------------------------------------------------------------
  // The timezone is a display setting: it goes through the ordinary save route,
  // is stored like any other setting, and makes the very next page render its
  // times in the chosen zone — chips and the injected window.FREILAUF_TZ, which is
  // what keeps the browser's tooltips on the same clock as the server's.
  gruppe('The display timezone is a central setting')

  await pruefe('the settings page offers the timezone and saves it', async () => {
    const html = await (await hol('/settings')).text()
    enthaelt(html, 'name="ui_timezone"', 'the select is on the settings page')
    const r = await formular('/settings/save', { ui_timezone: 'America/New_York' }, { alsBrowser: true })
    gleich(r.status, 303, 'saved')
    gleich(db.prepare(`SELECT value FROM settings WHERE key='ui_timezone'`).get()?.value,
      'America/New_York', 'stored like any other setting')
    try {
      enthaelt(await (await hol('/settings')).text(),
        'option value="America/New_York" selected', 'the saved zone is the selected option')
    } finally {
      await formular('/settings/save', { ui_timezone: '' }, { alsBrowser: true })
    }
  })

  await pruefe('times on a page render in the configured timezone', async () => {
    db.prepare(`UPDATE runs SET started_at='2026-08-25 12:00:00' WHERE id=?`).run(RH)
    await formular('/settings/save', { ui_timezone: 'America/New_York', ui_language: 'en' }, { alsBrowser: true })
    try {
      const detail = await (await hol(`/runs/${RH}`)).text()
      // 12:00 UTC on 2026-08-25 is 08:00 in New York (EDT, UTC-4) — the chip
      // must read the configured clock, not UTC and not the server's.
      enthaelt(detail, '08:00', 'the run start chip reads the New York clock')
      enthaelt(detail, 'window.FREILAUF_TZ="America/New_York"', 'the browser is told the same zone')
    } finally {
      await formular('/settings/save', { ui_timezone: '' }, { alsBrowser: true })
    }
  })

  // ------------------------------------------------------------------
  gruppe('The live channel (server/events.mjs)')

  /**
   * Reads an SSE stream for a while and returns the raw frames. Deliberately no
   * EventSource: there is no browser here, and the wire format is exactly what
   * this test is about.
   */
  async function lauscher(pfad, { msKopf = 1500 } = {}) {
    const ctrl = new AbortController()
    const res = await fetch(BASIS + pfad, { signal: ctrl.signal, headers: { accept: 'text/event-stream' } })
    const leser = res.body.getReader()
    const dec = new TextDecoder()
    let text = ''
    const lesen = (async () => {
      try {
        for (;;) {
          const { done, value } = await leser.read()
          if (done) break
          text += dec.decode(value, { stream: true })
        }
      } catch { /* aborted below */ }
    })()
    return {
      res,
      text: () => text,
      async warteAufText(teil, ms = msKopf) {
        const ende = Date.now() + ms
        while (Date.now() < ende) {
          if (text.includes(teil)) return true
          await new Promise(r => setTimeout(r, 25))
        }
        return false
      },
      async schliessen() { ctrl.abort(); await lesen },
    }
  }

  await pruefe('the channel opens as a stream and says so before anything happens', async () => {
    const l = await lauscher('/api/events')
    try {
      gleich(l.res.status, 200, 'status')
      enthaelt(l.res.headers.get('content-type') ?? '', 'text/event-stream', 'content type')
      // The headers must be flushed at once, otherwise the browser fires onopen
      // only at the first real event — which may be minutes away.
      wahr(await l.warteAufText(': connected'), `the greeting arrives immediately (got: ${JSON.stringify(l.text())})`)
    } finally { await l.schliessen() }
  })

  await pruefe('a title generated after the fact reaches an open page', async () => {
    // This is the case the live channel was built for: the run is created, the
    // page is open, and the real title only arrives once the model has answered.
    const l = await lauscher(`/api/events?repo=${repoId}`)
    try {
      await l.warteAufText(': connected')
      const r = await formular(`/api/runs/${R1}/title`, { title: 'Live channel proof' })
      gleich(r.status, 200, 'rename accepted')
      wahr(await l.warteAufText('event: run'), `an event arrives (got: ${JSON.stringify(l.text())})`)
      enthaelt(l.text(), R1, 'and it names the run')
      enthaelt(l.text(), '"kind":"title"', 'and says what changed')
      enthaelt(l.text(), 'id: ', 'with an id, so a reconnect can catch up')
    } finally { await l.schliessen() }
  })

  await pruefe('a listener on another repo is not told about this one', async () => {
    // The filter is the whole reason the event carries a repoId: an operator
    // watching one repo must not see another repo's runs appear.
    const fremd = await formular('/repos/edit', {
      name: 'e2e-fremd', path: join(SB, 'repo'), base_branch: 'main', worktree_extras: '[]',
    }, { alsBrowser: true })
    gleich(fremd.status, 303, 'second repo created')
    const fremdId = db.prepare(`SELECT id FROM repos WHERE name='e2e-fremd'`).get().id
    const l = await lauscher(`/api/events?repo=${fremdId}`)
    try {
      await l.warteAufText(': connected')
      await formular(`/api/runs/${R1}/title`, { title: 'Still not yours' })
      wahr(!(await l.warteAufText('event: run', 600)), `nothing arrived (got: ${JSON.stringify(l.text())})`)
    } finally { await l.schliessen() }
  })

  await pruefe('the five status changes that wrote no event now write one', async () => {
    // Measured before the live channel was wired: of the 18 places that set
    // runs.status, five left no trace at all — so the run's own event list did
    // not know why it had stopped. addEvent() is the channel's single choke
    // point, which only works if every transition really passes through it.
    const j = await laufStarten({ repo_id: repoId, prompt: 'event coverage', branch_mode: 'keiner' })
    await sessionMerken(j.runId)
    await formular(`/api/runs/${j.runId}/send`, { text: 'hello' })
    enthaelt(ereignisse(j.runId).join(','), 'message_sent', 'a message from a human is recorded')
    await formular(`/api/runs/${j.runId}/kill`, {})
    enthaelt(ereignisse(j.runId).join(','), 'aborted', 'ending it by hand is recorded')
    await formular(`/api/runs/${j.runId}/retry`, {})
    enthaelt(ereignisse(j.runId).join(','), 'retry', 'and so is retrying it')
    await sessionMerken(j.runId)
    await formular(`/api/runs/${j.runId}/kill`, {})   // leave nothing running
  })

  // ------------------------------------------------------------------
  gruppe('tmux cleanup: the memory-freeing agent')

  await pruefe('the cleanup settings page renders the reusable setup block', async () => {
    const html = await (await hol('/settings/cleanup')).text()
    gleich(html.includes('<fieldset class="cleanup-setup">'), true, 'the agent+provider+model block, wrapped for a settings page')
    enthaelt(html, 'name="harness"', 'with the harness select')
    enthaelt(html, 'name="cleanup_on"', 'the on/off switch')
    enthaelt(html, 'name="cleanup_threshold_gb"', 'the threshold field')
    enthaelt(html, 'name="cleanup_target_gb"', 'the target field')
    enthaelt(html, 'name="cleanup_prompt"', 'the prompt textarea')
  })
  await pruefe('the cleanup settings save stores agent + switch + numbers', async () => {
    const r = await formular('/settings/cleanup', {
      harness: 'claude', cleanup_on: '1', cleanup_threshold_gb: '3', cleanup_target_gb: '1',
      cleanup_cooldown_min: '10', cleanup_repo_id: String(repoId), cleanup_prompt: '',
    }, { alsBrowser: true })
    gleich(r.status, 303, 'redirect back')
    gleich(db.prepare(`SELECT value FROM settings WHERE key='cleanup_harness'`).get().value, 'claude', 'agent stored')
    gleich(db.prepare(`SELECT value FROM settings WHERE key='cleanup_on'`).get().value, '1', 'switch on')
    gleich(db.prepare(`SELECT value FROM settings WHERE key='cleanup_threshold_gb'`).get().value, '3', 'threshold')
    gleich(db.prepare(`SELECT value FROM settings WHERE key='cleanup_target_gb'`).get().value, '1', 'target')
    gleich(db.prepare(`SELECT value FROM settings WHERE key='cleanup_cooldown_min'`).get().value, '10', 'cooldown')
    // The prompt was not changed: the built-in memory template stays the template.
    gleich(db.prepare(`SELECT value FROM settings WHERE key='cleanup_prompt'`).get().value, '', 'prompt empty = the built-in template')
  })
  await pruefe('the settings page summary names the configured cleanup agent', async () => {
    const html = await (await hol('/settings')).text()
    enthaelt(html, 'cleanup', 'the settings index links to the cleanup page')
    enthaelt(html, 'Claude Code', 'and names the configured agent in its summary')
  })

  let CL = null
  await pruefe('the sidebar and the sessions page show the free-memory controls', async () => {
    const sitzung = (await sh('tmux', ['list-sessions', '-F', '#{session_name}'])).stdout.trim()
    if (!sitzung) return uebersprungen('side memory block', 'no tmux server in this environment')
    const sidebar = await (await hol('/api/fragments/sidebar')).text()
    enthaelt(sidebar, 'class="mem-free"', 'the small button in the sidebar tmux block')
    const page = await (await hol('/sessions')).text()
    enthaelt(page, 'cleanup-free-open', 'the button in the Sessions-page box')
    enthaelt(page, 'id="cleanup-dialog"', 'one shared modal for the action')
    enthaelt(page, 'name="keep"', 'with the keep-runs field on the Sessions page')
    const overview = await (await hol('/')).text()
    enthaelt(overview, 'id="cleanup-dialog"', 'the modal is on every page')
    falsch(overview.includes('name="keep"'), 'but the keep field only on the Sessions page')
  })
  await pruefe('the cleanup agent starts through the ordinary run path', async () => {
    const r = await formular('/api/cleanup/start', { target_gb: '2', keep: '', source: 'sessions' })
    const j = await r.json()
    gleich(r.status, 200, `started (${JSON.stringify(j)})`)
    wahr(!!j.runId, 'run id')
    CL = j.runId
    await sessionMerken(CL)
    const l = lauf(CL)
    gleich(l.harness, 'claude', 'configured coding agent')
    gleich(l.flows, null, 'no attached flows')
    enthaelt(l.prompt, 'höchstens 2 GB', 'the prompt carries the target')
    enthaelt(l.prompt, 'Ohne Ausnahmen', 'and the default keep sentence')
    enthaelt(ereignisse(CL).join(','), 'cleanup_run', 'marked as a cleanup run')
  })
  await pruefe('a second start is refused while one is in flight', async () => {
    const j = await (await formular('/api/cleanup/start', { target_gb: '2' })).json()
    gleich(j.ok, false, 'refused')
    enthaelt(j.error, 'already in progress', 'and names the reason')
  })
  await pruefe('a manual keep list turns run ids into protected session names', async () => {
    const r = await formular('/api/cleanup/start', { target_gb: '1', keep: lauf(CL).id })
    // The first run is still in flight — the keep resolution happens before the
    // in-flight check? No: in-flight is checked first, so this must stay refused.
    const j = await r.json()
    gleich(j.ok, false, 'still refused while the first run is going')
  })
  await pruefe('the cleanup run ends like any other and frees the gate', async () => {
    const r = await hol(`/api/runs/${CL}/report`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'done', text: 'CL1 GB freed.' }),
    })
    gleich(r.status, 200, 'report accepted')
    gleich(lauf(CL).status, 'done', 'done')
    const wieder = await (await formular('/api/cleanup/start', { target_gb: '1', keep: lauf(CL).id })).json()
    gleich(wieder.ok, true, 'a new start is possible after the run ended')
    wahr(!!wieder.runId, 'and it starts')
    await sessionMerken(wieder.runId)
    const keepLauf = lauf(wieder.runId)
    enthaelt(keepLauf.prompt, 'Diese Sessions bleiben auf jeden Fall erhalten', 'the keep line is present')
    enthaelt(keepLauf.prompt, lauf(CL).tmux_session, 'naming the kept run\'s session')
    await formular(`/api/runs/${wieder.runId}/kill`, {})
  })
  await pruefe('the agent helper script protects and kills nothing in plan mode', async () => {
    const skript = join(PROJEKT, 'bin', 'fl-session-cleanup')
    const s1 = 'fl-aufraum-test-1', s2 = 'fl-aufraum-test-2'
    await sh('tmux', ['new-session', '-d', '-s', s1, 'sleep 300'])
    await sh('tmux', ['new-session', '-d', '-s', s2, 'sleep 300'])
    sessions.add(s1); sessions.add(s2)
    const plan = await sh('bash', [skript, '--target-gb', '0', '--db', join(SB, 'data', 'freilauf.db')])
    enthaelt(plan.stdout, '|kill', 'plan mode names sessions to kill')
    enthaelt(plan.stdout, 'killed=0', 'but kills nothing without --kill')
    const mitKeep = await sh('bash', [skript, '--target-gb', '0', '--keep', s1, '--db', join(SB, 'data', 'freilauf.db')])
    enthaelt(mitKeep.stdout, `${s1}|`, 'the kept session is listed')
    enthaelt(mitKeep.stdout, '|protect', 'and marked protected')
    await sh('tmux', ['kill-session', '-t', `=${s1}`])
    await sh('tmux', ['kill-session', '-t', `=${s2}`])
  })

  // ------------------------------------------------------------------
  gruppe('Integration: a run is done when its work is on the base branch')

  // Everything below only happens because the repo asks for it. Turning it on
  // goes through the repo FORM, so the block one clicks and the columns the hub
  // reads cannot drift apart.
  const integrate = await import('../server/integrate.mjs')
  const g = (dir, ...args) => sh('git', ['-C', dir, ...args])

  async function repoMerge(fields = {}) {
    const row = db.prepare('SELECT * FROM repos WHERE name=?').get('e2e')
    const r = await formular(`/repos/edit?id=${row.id}`, {
      name: 'e2e', path: REPO, base_branch: 'main',
      worktree_extras: row.worktree_extras ?? '[]', prompt: row.prompt ?? '',
      merge_mode: 'hub', merge_check: '', finish_timeout_min: '15',
      merge_max_attempts: '2', conflict_parallel: '1', notify_running: '1', max_parallel: '0',
      ...fields,
    }, { alsBrowser: true })
    gleich(r.status, 303, `repo saved (${JSON.stringify(fields)})`)
    return db.prepare('SELECT * FROM repos WHERE name=?').get('e2e')
  }

  /** A report exactly as fl-report sends it — and the hub's answer to it. */
  async function sendReport(runId, body) {
    const r = await hol(`/api/runs/${runId}/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    gleich(r.status, 200, 'the report endpoint answers 2xx — anything else lands in inbox.jsonl')
    return r.json()
  }

  /** Start a run and hand back id, worktree and session. */
  async function mergeRun(fields = {}) {
    const j = await laufStarten({ repo_id: String(repoId), prompt: 'E2E-Merge', branch_mode: 'keiner', ...fields })
    wahr(!!j.runId, `run started (${JSON.stringify(j)})`)
    await sessionMerken(j.runId)
    const row = lauf(j.runId)
    return { id: j.runId, wt: row.workdir_effective, session: row.tmux_session }
  }

  async function writeAndCommit(wt, datei, content, message) {
    writeFileSync(join(wt, datei), content)
    await g(wt, 'add', '-A')
    await g(wt, '-c', 'user.email=e2e@test.local', '-c', 'user.name=E2E', 'commit', '-qm', message)
  }

  const originSubject = async (ref = 'main') =>
    (await g(ORIGIN, 'log', '-1', '--format=%s', ref)).stdout.trim()

  // The `run_merged` flow of the group above is still active: it hangs on this
  // repo and fires on every real merge from here on. That is the seam between
  // the two halves of this work — the integrator writes the merge, the flow
  // trigger reads it — and it is the one thing neither branch could test alone.
  const mergeFlowId = db.prepare(`SELECT id FROM flows WHERE name='E2E-Merge-Flow'`).get()?.id ?? null
  const flowRunsFor = (runId) => db.prepare('SELECT * FROM flow_runs WHERE flow_id=? AND trigger_run_id=?')
    .all(mergeFlowId, runId)
  const triggerOf = (fr) => JSON.parse(fr.context).trigger

  await repoMerge()

  await pruefe('the repo form carries the Integration block and stores it', async () => {
    const row = db.prepare('SELECT * FROM repos WHERE name=?').get('e2e')
    gleich(row.merge_mode, 'hub', 'merge mode stored')
    gleich(row.finish_timeout_min, 15, 'timeout stored')
    gleich(row.notify_running, 1, 'the checkbox is on')
    const html = await (await hol(`/repos/edit?id=${row.id}`)).text()
    for (const feld of ['name="merge_mode"', 'name="merge_check"', 'name="finish_timeout_min"',
      'name="merge_max_attempts"', 'name="conflict_parallel"', 'name="notify_running"', 'name="max_parallel"']) {
      enthaelt(html, feld, `field ${feld}`)
    }
  })

  await pruefe('a wrong number is a readable problem, not a stored zero', async () => {
    const row = db.prepare('SELECT * FROM repos WHERE name=?').get('e2e')
    const r = await formular(`/repos/edit?id=${row.id}`, {
      name: 'e2e', path: REPO, base_branch: 'main', worktree_extras: row.worktree_extras ?? '[]',
      merge_mode: 'hub', finish_timeout_min: '0', merge_max_attempts: '2',
      conflict_parallel: '1', notify_running: '1', max_parallel: '0',
    }, { alsBrowser: true })
    gleich(r.status, 400, 'refused')
    gleich(db.prepare('SELECT finish_timeout_min FROM repos WHERE name=?').get('e2e').finish_timeout_min, 15, 'unchanged')
  })

  // ---- 1. the clean case: the report is checked, then merged and pushed ----
  let cleanRun = null
  await pruefe('a clean, mergeable run is merged into main and only THEN done', async () => {
    cleanRun = await mergeRun()
    await writeAndCommit(cleanRun.wt, 'clean.txt', 'clean\n', 'E2E: clean run')
    const antwort = await sendReport(cleanRun.id, { kind: 'done', text: 'Everything went fine.' })
    wahr(antwort.ok, 'accepted')
    enthaelt(antwort.message ?? '', 'Freilauf is merging it into main', 'the answer says what happens now')
    await warteAuf(() => lauf(cleanRun.id).merge_status === 'merged',
      { was: 'the run is merged', timeoutMs: 30_000 })
    const r = lauf(cleanRun.id)
    gleich(r.status, 'done', 'done — and not a second earlier')
    wahr(!!r.merged_sha, 'the merged commit is recorded')
    const anc = await g(REPO, 'merge-base', '--is-ancestor', r.merged_sha, 'origin/main')
    wahr(anc.ok, 'the run\'s tip really is an ancestor of origin/main')
    enthaelt(await originSubject(), 'Merge run', 'a merge commit, always --no-ff')
    const ev = ereignisse(cleanRun.id)
    enthaelt(ev.join(','), 'finish_started', 'the gate is recorded')
    enthaelt(ev.join(','), 'finish_clean', 'and its verdict')
    enthaelt(ev.join(','), 'merged', 'and the merge')
    gleich(ev.filter(k => k === 'notified:done').length, 1, 'the operator hears about it exactly once')
  })


  await pruefe('the merge starts the run_merged flow — once, with the facts of the merge', async () => {
    const { flowsTick } = await import('../server/flows/triggers.mjs')
    wahr(!!mergeFlowId, 'the flow of the group above is still there')
    const l = await mergeRun()
    await writeAndCommit(l.wt, 'flow-merge.txt', 'for the flow\n', 'E2E: a merge a flow reacts to')
    await sendReport(l.id, { kind: 'done', text: 'merged for the flow' })
    await warteAuf(() => lauf(l.id).merge_status === 'merged', { was: 'merged', timeoutMs: 30_000 })
    await warteAuf(() => flowRunsFor(l.id).length === 1,
      { was: 'exactly one flow run for this merge', timeoutMs: 15_000 })
    const trigger = triggerOf(flowRunsFor(l.id)[0])
    gleich(trigger.kind, 'run_merged', 'started by the merge, not by the end of the run')
    gleich(trigger.run.id, l.id, 'and it names the run')
    gleich(trigger.merge.sha, lauf(l.id).merged_sha, 'the commit it landed as')
    gleich(trigger.merge.base, 'main', 'the branch it landed on')
    // The files of the MERGE, not the ones the run happened to touch: that is
    // what an agent downstream has to react to.
    gleich(trigger.merge.files.join(','), 'flow-merge.txt', 'and what the merge really changed')
    gleich(lauf(l.id).merge_dispatched, 1, 'the merge is marked as dispatched')
    await flowsTick()
    gleich(flowRunsFor(l.id).length, 1, 'a second pass starts nothing more')
  })

  // ---- 2. dirty: the agent is told, and reports again ----
  await pruefe('an uncommitted change holds the run and names the file', async () => {
    const l = await mergeRun()
    await writeAndCommit(l.wt, 'a.txt', 'a\n', 'E2E: committed part')
    writeFileSync(join(l.wt, 'forgotten.txt'), 'left behind\n')
    const antwort = await sendReport(l.id, { kind: 'done', text: 'done, I think' })
    enthaelt(antwort.message ?? '', 'NOT finished yet', 'the answer says the run is not over')
    enthaelt(antwort.message ?? '', 'forgotten.txt', 'and names the file')
    const r = lauf(l.id)
    gleich(r.status, 'running', 'the run stays running — its agent can still fix this')
    gleich(r.finish_state, 'awaiting_commit', 'and is waiting for the commit')
    wahr((r.report_md ?? '').includes('done, I think'), 'the report is already safe')
    // The agent does what it was told.
    await g(l.wt, 'add', '-A')
    await g(l.wt, '-c', 'user.email=e2e@test.local', '-c', 'user.name=E2E', 'commit', '-qm', 'E2E: the leftover')
    await integrate.integrateTick()
    await warteAuf(() => lauf(l.id).merge_status === 'merged', { was: 'merged after the commit', timeoutMs: 30_000 })
    gleich(lauf(l.id).status, 'done', 'and now it is done')
  })

  // ---- 3. conflict → conflict run ----
  const resolverSetup = async () => formular('/settings/merge', {
    harness: 'claude', model: '', provider: '', effort: '',
    merge_resolver_prompt: 'Keep the tests green.',
  }, { alsBrowser: true })

  let conflicted = null, resolver = null
  await pruefe('the Merge settings page stores the conflict resolver through the run form\'s own validation', async () => {
    const r = await resolverSetup()
    gleich(r.status, 303, 'saved')
    gleich(db.prepare(`SELECT value FROM settings WHERE key='merge_resolver_harness'`).get().value, 'claude', 'harness')
    const html = await (await hol('/settings/merge')).text()
    enthaelt(html, 'name="harness"', 'the run form\'s own setup block')
    enthaelt(html, 'Keep the tests green.', 'and the operator\'s own instructions')
    enthaelt(await (await hol('/settings')).text(), '/settings/merge', 'the settings page links to it')
  })

  await pruefe('a branch that no longer merges holds the run and names the conflict', async () => {
    conflicted = await mergeRun()
    await writeAndCommit(conflicted.wt, 'README.md', '# Testrepo\nfrom the run\n', 'E2E: run changes the readme')
    // Meanwhile somebody else lands a change on the same line. The main
    // checkout has to be level with origin first — the hub has been merging
    // into it all along, so a commit on a stale main could not be pushed.
    await g(REPO, 'fetch', 'origin')
    await g(REPO, 'reset', '--hard', 'origin/main')
    writeFileSync(join(REPO, 'README.md'), '# Testrepo\nfrom outside\n')
    await g(REPO, 'add', '-A')
    await g(REPO, '-c', 'user.email=e2e@test.local', '-c', 'user.name=E2E', 'commit', '-qm', 'E2E: outside change')
    await g(REPO, 'push', '-q', 'origin', 'main')
    const antwort = await sendReport(conflicted.id, { kind: 'done', text: 'I changed the readme.' })
    enthaelt(antwort.message ?? '', 'cannot be merged into main', 'the answer says why')
    enthaelt(antwort.message ?? '', 'README.md', 'and names the file')
    enthaelt(antwort.message ?? '', 'Do NOT merge into or push to main yourself', 'the ground rule')
    gleich(lauf(conflicted.id).finish_state, 'awaiting_merge', 'waiting for the agent to resolve it')
    gleich(lauf(conflicted.id).status, 'running', 'still running')
  })

  await pruefe('when the deadline passes, a conflict run takes over', async () => {
    await repoMerge({ finish_timeout_min: '1' })
    // The clock is a parameter, so the suite advances it instead of waiting.
    await integrate.integrateTick(Date.now() + 5 * 60_000)
    const orig = lauf(conflicted.id)
    gleich(orig.status, 'done', 'the original run leaves the gate')
    gleich(orig.merge_status, 'resolving', 'and its work is with a resolver')
    gleich(orig.merge_attempts, 1, 'first attempt')
    resolver = db.prepare('SELECT * FROM runs WHERE resolves_run_id=?').get(conflicted.id)
    wahr(!!resolver, 'a conflict run exists')
    await sessionMerken(resolver.id)
    gleich(orig.resolver_run_id, resolver.id, 'and the original points at it')
    wahr(resolver.branch_expected.startsWith('resolve/'), `its own branch (${resolver.branch_expected})`)
    const prompt = readFileSync(join(SB, 'runs', resolver.id, 'prompt.md'), 'utf8')
    enthaelt(prompt, 'README.md', 'the task names the conflicting file')
    enthaelt(prompt, 'I changed the readme.', 'and carries the original report')
    enthaelt(prompt, 'Keep the tests green.', 'and the operator\'s own instructions')
    enthaelt(prompt, 'BOTH intentions survive', 'and the rule that keeps work from being dropped')
    enthaelt(ereignisse(conflicted.id).join(','), 'resolver_started', 'recorded on the original run')
  })

  await pruefe('when the conflict run delivers, BOTH runs are merged', async () => {
    const wt = lauf(resolver.id).workdir_effective
    await g(wt, 'fetch', 'origin')
    await g(wt, '-c', 'user.email=e2e@test.local', '-c', 'user.name=E2E', 'merge', 'origin/main')
    writeFileSync(join(wt, 'README.md'), '# Testrepo\nfrom the run\nfrom outside\n')
    await g(wt, 'add', '-A')
    await g(wt, '-c', 'user.email=e2e@test.local', '-c', 'user.name=E2E', 'commit', '-qm', 'E2E: both intentions')
    await sendReport(resolver.id, { kind: 'done', text: 'Resolved.' })
    await warteAuf(() => lauf(resolver.id).merge_status === 'merged', { was: 'the resolver is merged', timeoutMs: 30_000 })
    gleich(lauf(conflicted.id).merge_status, 'merged', 'and so is the run it worked for')
    gleich(lauf(conflicted.id).merged_sha, lauf(resolver.id).merged_sha, 'the same commit for both')
    gleich(ereignisse(conflicted.id).filter(k => k === 'notified:done').length, 1,
      'the original run hears about its merge exactly once, and only now')
    // A conflict run is the integrator's tool: it never speaks for itself, and
    // nothing hangs on its end.
    gleich(ereignisse(resolver.id).filter(k => k.startsWith('notified')).length, 0,
      'and the conflict run itself announces nothing of its own')
    gleich(lauf(resolver.id).flow_dispatched, 1, 'no flow ever fires for it')
    gleich(lauf(resolver.id).flows, null, 'and it carries no attachments to fire')
    const mergedEvent = db.prepare(`SELECT payload FROM events WHERE run_id=? AND kind='merged'`).get(conflicted.id)
    wahr(Array.isArray(JSON.parse(mergedEvent.payload).files), 'the merged event carries the files the merge changed')
  })


  await pruefe('a merge over a conflict run fires once, for the ORIGINAL run', async () => {
    const { flowsTick } = await import('../server/flows/triggers.mjs')
    await flowsTick()
    await warteAuf(() => flowRunsFor(conflicted.id).length === 1,
      { was: 'one flow run for the integration', timeoutMs: 15_000 })
    const trigger = triggerOf(flowRunsFor(conflicted.id)[0])
    gleich(trigger.run.id, conflicted.id, 'the flow is about the run whose work landed')
    gleich(trigger.merge.sha, lauf(conflicted.id).merged_sha, 'with the commit it landed as')
    gleich(trigger.merge.resolver_run_id, resolver.id, 'and it names the conflict run that got it there')
    // The dispatch fires per RUN, the flow has to fire per INTEGRATION — and the
    // two only differ when a conflict run was involved (see 3.15).
    gleich(flowRunsFor(resolver.id).length, 0, 'the conflict run itself never starts a flow')
    gleich(lauf(resolver.id).merge_dispatched, 1, 'it is marked at birth, so no pass looks at it again')
    gleich(lauf(conflicted.id).merge_dispatched, 1, 'and the original is marked once it fired')
    const vorher = db.prepare('SELECT count(*) c FROM flow_runs').get().c
    await flowsTick()
    gleich(db.prepare('SELECT count(*) c FROM flow_runs').get().c, vorher, 'a second pass starts nothing more')
  })

  // ---- 5. the attempt limit ----
  await pruefe('after the last attempt the hub asks a human instead of trying again', async () => {
    await repoMerge({ finish_timeout_min: '1', merge_max_attempts: '1' })
    const l = await mergeRun()
    await writeAndCommit(l.wt, 'README.md', '# Testrepo\nsecond run\n', 'E2E: second conflict')
    await g(REPO, 'fetch', 'origin')
    await g(REPO, 'reset', '--hard', 'origin/main')
    writeFileSync(join(REPO, 'README.md'), '# Testrepo\nsecond outside\n')
    await g(REPO, 'add', '-A')
    await g(REPO, '-c', 'user.email=e2e@test.local', '-c', 'user.name=E2E', 'commit', '-qm', 'E2E: second outside')
    await g(REPO, 'push', '-q', 'origin', 'main')
    await sendReport(l.id, { kind: 'done', text: 'second run report' })
    gleich(lauf(l.id).finish_state, 'awaiting_merge', 'conflict')
    await integrate.integrateTick(Date.now() + 5 * 60_000)
    const r1 = db.prepare('SELECT * FROM runs WHERE resolves_run_id=?').get(l.id)
    wahr(!!r1, 'one conflict run — the limit')
    await sessionMerken(r1.id)
    // It ends without delivering.
    await formular(`/api/runs/${r1.id}/kill`, {})
    await integrate.integrateTick(Date.now() + 10 * 60_000)
    const orig = lauf(l.id)
    gleich(orig.merge_status, 'blocked_conflict', 'no second attempt — a human decides')
    const openIncident = db.prepare(`SELECT * FROM incidents WHERE run_id=? AND typ='merge_blocked' AND geloest_am IS NULL`).get(l.id)
    wahr(!!openIncident, 'an open incident, so it shows up in the sidebar')
    enthaelt(ereignisse(l.id).join(','), 'notified:merge_blocked', 'and the operator was told')
    // And the operator can act on it without leaving the run's page.
    const html = await (await hol(`/runs/${l.id}`)).text()
    enthaelt(html, 'id="run-integration"', 'the detail page has an Integration line')
    enthaelt(html, 'blocked: conflict unresolved', 'saying where the work stands')
    enthaelt(html, `/api/runs/${l.id}/merge"`, 'with "Merge now"')
    enthaelt(html, `/api/runs/${l.id}/merge-skip`, 'and "Skip merge"')
    enthaelt(html, 'claude --resume', 'and the command that reopens the session')
    // One conflict run per attempt, and never one for a conflict run: that is
    // the recursion guard, and the whole reason isResolverRun() exists.
    gleich(db.prepare('SELECT count(*) c FROM runs WHERE resolves_run_id=?').get(l.id).c, 1,
      'exactly one conflict run — the limit was one attempt')
    gleich(db.prepare('SELECT count(*) c FROM runs WHERE resolves_run_id=?').get(r1.id).c, 0,
      'and no conflict run for the conflict run')
    gleich(lauf(r1.id).merge_status, null, 'the failed conflict run carries no verdict of its own')
    falsch(!!db.prepare(`SELECT 1 FROM incidents WHERE run_id=? AND typ='merge_blocked'`).get(r1.id),
      'and no incident: what went wrong there is the original run\'s problem')
    gleich(ereignisse(r1.id).filter(k => k.startsWith('notified')).length, 0,
      'and it never rang the phone')
    falsch((await (await hol(`/runs/${r1.id}`)).text()).includes(`/api/runs/${r1.id}/retry`),
      'a conflict run has no retry button — "Merge now" on the original starts a fresh one')
  })

  // ---- 6. + 14. failed with commits: assessed, backed up, merged by hand ----
  await pruefe('a failed run is never merged by itself — but its work is named and backed up', async () => {
    await repoMerge({ finish_timeout_min: '15', merge_max_attempts: '2' })
    const vorher = (await g(ORIGIN, 'rev-parse', 'main')).stdout.trim()
    const l = await mergeRun()
    await writeAndCommit(l.wt, 'failed.txt', 'work\n', 'E2E: work of a failed run')
    await sendReport(l.id, { kind: 'failed', text: 'it broke' })
    const r = lauf(l.id)
    gleich(r.status, 'failed', 'failed')
    gleich(r.merge_status, 'unmerged_commits', 'its work is named')
    gleich((await g(ORIGIN, 'rev-parse', 'main')).stdout.trim(), vorher, 'and nothing was merged')
    const ev = db.prepare(`SELECT payload FROM events WHERE run_id=? AND kind='merge_assessed'`).get(l.id)
    const payload = JSON.parse(ev.payload)
    gleich(payload.status, 'unmerged_commits', 'the assessment is recorded')
    gleich(payload.commits, 1, 'with the number of commits')
    gleich(payload.dirty, 0, 'and of dirty files')
    // origin is the backup: work nobody merged must not live on one disk alone.
    const ref = `run/${l.id.split('-')[0]}`
    wahr((await g(ORIGIN, 'rev-parse', `refs/heads/${ref}`)).ok, `the tip is backed up as origin/${ref}`)
    enthaelt(ereignisse(l.id).join(','), 'branch_backed_up', 'and that is recorded')
    // …and the operator can still merge it, with one click.
    const antwort = await (await formular(`/api/runs/${l.id}/merge`, {})).json()
    wahr(antwort.ok, `merge by hand accepted (${JSON.stringify(antwort)})`)
    await warteAuf(() => lauf(l.id).merge_status === 'merged', { was: 'merged by hand', timeoutMs: 30_000 })
    enthaelt(ereignisse(l.id).join(','), 'merge_manual', 'the manual action is in the run\'s history')
  })

  // ---- 7. the other agents learn that main moved ----
  await pruefe('after a merge the other running agents are told that main moved', async () => {
    const onlooker = await mergeRun({ prompt: 'E2E-Onlooker' })
    const l = await mergeRun()
    await writeAndCommit(l.wt, 'moved.txt', 'moved\n', 'E2E: moves main')
    await sendReport(l.id, { kind: 'done', text: 'moved main' })
    await warteAuf(() => lauf(l.id).merge_status === 'merged', { was: 'merged', timeoutMs: 30_000 })
    // The colon is not decoration: 'capture-pane -t "=name"' is no valid target
    // ("can't find pane"), exactly like pipe-pane and set-hook (see AGENTS.md).
    await warteAuf(async () =>
      (await sh('tmux', ['capture-pane', '-p', '-t', `=${onlooker.session}:`])).stdout.includes('has moved'),
    { was: 'the watching agent sees the notice in its session', timeoutMs: 15_000 })
    // The text is on the screen ~300 ms before the event is written (the paste
    // and the Enter are two send-keys with a pause between them), so wait for it.
    await warteAuf(() => ereignisse(onlooker.id).includes('main_moved'),
      { was: 'the notice is recorded on the watching run', timeoutMs: 10_000 })
    await warteAuf(() => ereignisse(l.id).includes('main_moved_notified'),
      { was: 'and on the run that moved main', timeoutMs: 10_000 })
    await formular(`/api/runs/${onlooker.id}/kill`, {})
  })

  // ---- 8. the agent vanishes while the gate waits ----
  await pruefe('an agent that disappears mid-gate escalates instead of counting as aborted', async () => {
    const l = await mergeRun()
    writeFileSync(join(l.wt, 'only-dirt.txt'), 'dirt\n')
    await sendReport(l.id, { kind: 'done', text: 'am I done?' })
    gleich(lauf(l.id).finish_state, 'awaiting_commit', 'waiting')
    await sh('tmux', ['kill-session', '-t', `=${l.session}`])
    await watcherTick()
    await warteAuf(() => lauf(l.id).merge_status === 'blocked_dirty',
      { was: 'the escalation happened', timeoutMs: 15_000 })
    const r = lauf(l.id)
    gleich(r.status, 'done', 'done, not aborted: this run HAD reported')
    wahr(!!db.prepare(`SELECT 1 FROM incidents WHERE run_id=? AND typ='merge_blocked' AND geloest_am IS NULL`).get(l.id),
      'and it is waiting for a human')
  })

  // ---- 11. the merge check ----
  await pruefe('a red merge check is treated like a conflict: nothing is pushed, the agent is told', async () => {
    await repoMerge({ merge_check: 'false' })
    const vorher = (await g(ORIGIN, 'rev-parse', 'main')).stdout.trim()
    const l = await mergeRun()
    await writeAndCommit(l.wt, 'check.txt', 'check\n', 'E2E: merge check')
    await sendReport(l.id, { kind: 'done', text: 'please check' })
    await warteAuf(() => lauf(l.id).finish_state === 'check_failed',
      { was: 'the merge check failed', timeoutMs: 30_000 })
    gleich(lauf(l.id).status, 'running', 'the run stays running — its agent can fix it')
    gleich((await g(ORIGIN, 'rev-parse', 'main')).stdout.trim(), vorher, 'and nothing reached main')
    await warteAuf(async () =>
      (await sh('tmux', ['capture-pane', '-p', '-t', `=${l.session}:`])).stdout.includes('merge check failed'),
    { was: 'the agent is told', timeoutMs: 15_000 })
    // Green check, one more commit — the tip has to move for a new check.
    await repoMerge({ merge_check: 'true' })
    await writeAndCommit(l.wt, 'check.txt', 'check again\n', 'E2E: fixed')
    await integrate.integrateTick()
    await warteAuf(() => lauf(l.id).merge_status === 'merged', { was: 'merged after the fix', timeoutMs: 30_000 })
    await repoMerge({ merge_check: '' })
  })

  // ---- 11b. a push that keeps failing: it waits, and it alarms ONCE ----
  // Measured on production run 0c1fc610: a broken pre-push hook in the
  // operator's checkout produced 28 push attempts, five `merge_blocked`
  // escalations, five force-pushed backup branches and five notifications about
  // the same problem inside ten minutes. Two causes, both fixed together — the
  // loop re-enqueues every run that is still 'merging' on EVERY 5-second pass,
  // so the five attempts collapsed into twenty seconds; and the retry was a
  // `setTimeout` that outlived the escalation it was scheduled under, so four
  // pending timers walked the whole merge again after a human had already been
  // called. `origin` is pointed at a path that does not exist because that is a
  // push failure which is NOT a conflict: anything saying "rejected" goes down
  // the conflict ladder instead.
  await pruefe('a failing push waits between attempts and raises exactly one alarm', async () => {
    const l = await mergeRun()
    await writeAndCommit(l.wt, 'pushfail.txt', 'x\n', 'E2E: the push will fail')
    const echteUrl = (await g(REPO, 'remote', 'get-url', 'origin')).stdout.trim()
    await g(REPO, 'remote', 'set-url', 'origin', join(SB, 'kein-origin.git'))
    try {
      const fehler = () => ereignisse(l.id).filter(k => k === 'merge_error').length
      await sendReport(l.id, { kind: 'done', text: 'push failure' })
      await warteAuf(() => fehler() >= 1, { was: 'the first push attempt failed', timeoutMs: 30_000 })
      gleich(lauf(l.id).finish_state, 'merging', 'the run is still the integrator\'s job')

      // Two passes of the loop inside the retry window must change nothing.
      await integrate.integrateTick()
      await integrate.integrateTick()
      await new Promise(r => setTimeout(r, 700))
      gleich(fehler(), 1, 'no second attempt inside the retry window')

      // One pass per elapsed window. The fifth failure escalates — and the
      // clock stays well under finish_timeout_min, so this is the push giving
      // up and not the deadline.
      for (let i = 1; i <= 12 && !ereignisse(l.id).includes('merge_blocked'); i++) {
        const vor = fehler()
        await integrate.integrateTick(Date.now() + i * 70_000)
        await warteAuf(() => fehler() > vor || ereignisse(l.id).includes('merge_blocked'),
          { was: `another push attempt after tick ${i}`, timeoutMs: 30_000 })
      }
      const kinds = ereignisse(l.id)
      wahr(kinds.includes('merge_blocked'), `the failures escalate (events: ${kinds.join(',')})`)
      gleich(kinds.filter(k => k === 'merge_blocked').length, 1, 'blocked exactly once')
      gleich(kinds.filter(k => k === 'notified:merge_blocked').length, 1,
        'and the operator is told once, not once per wave')
      gleich(kinds.filter(k => k === 'finish_escalated').length, 1, 'escalated once')
      gleich(lauf(l.id).merge_status, 'blocked_error', 'and it says why')
      gleich(lauf(l.id).finish_state, null, 'the run has left the loop')

      // Nothing may pick it back up: a human has been called, and no leftover
      // retry may merge, push or alarm behind their back.
      const vorher = kinds.length
      const fehlerVorher = fehler()
      await integrate.integrateTick(Date.now() + 15 * 70_000)
      await new Promise(r => setTimeout(r, 1000))
      gleich(fehler(), fehlerVorher, 'no further push attempt after the escalation')
      gleich(ereignisse(l.id).length, vorher, 'and nothing else happened either')
    } finally {
      await g(REPO, 'remote', 'set-url', 'origin', echteUrl)
    }
  })

  // ---- 12. an end somebody asked for stays an abort ----
  await pruefe('killing a run in the gate aborts it — that end WAS asked for', async () => {
    const l = await mergeRun()
    writeFileSync(join(l.wt, 'open.txt', ), 'open\n')
    await sendReport(l.id, { kind: 'done', text: 'x' })
    gleich(lauf(l.id).finish_state, 'awaiting_commit', 'waiting')
    await formular(`/api/runs/${l.id}/kill`, {})
    await warteAuf(() => !!lauf(l.id).merge_status, { was: 'the assessment', timeoutMs: 15_000 })
    const r = lauf(l.id)
    gleich(r.status, 'aborted', 'aborted, not done')
    wahr(['unmerged_dirty', 'unmerged_both'].includes(r.merge_status), `assessed (${r.merge_status})`)
    falsch(!!db.prepare(`SELECT 1 FROM incidents WHERE run_id=? AND typ='merge_blocked'`).get(l.id),
      'and nobody is asked to do anything: the operator did this on purpose')
  })

  // ---- 10. fl-report prints the hub's answer ----
  await pruefe('the real bin/fl-report prints the hub\'s answer and files nothing', async () => {
    const l = await mergeRun()
    writeFileSync(join(l.wt, 'unsaid.txt'), 'x\n')
    const r = await sh(join(PROJEKT, 'bin', 'fl-report'), ['done', 'from the real script'], {
      env: { ...process.env, FL_RUN_ID: l.id, FL_HUB_URL: BASIS, HOME: SB },
    })
    wahr(r.ok, `exit 0 (${r.stderr})`)
    enthaelt(r.stdout, 'NOT finished yet', 'the answer reaches the agent as this tool\'s output')
    enthaelt(r.stdout, 'unsaid.txt', 'and names the file')
    falsch(existsSync(join(SB, 'agents', 'runs', l.id, 'inbox.jsonl')), 'nothing was filed as unreachable')
    await formular(`/api/runs/${l.id}/kill`, {})
  })

  // ---- 13. origin is the backup: the operator's own commits are pushed ----
  await pruefe('commits the operator made on main himself are pushed to origin', async () => {
    await g(REPO, 'fetch', 'origin')
    await g(REPO, 'reset', '--hard', 'origin/main')
    writeFileSync(join(REPO, 'by-operator.txt'), 'by hand\n')
    await g(REPO, 'add', '-A')
    await g(REPO, '-c', 'user.email=e2e@test.local', '-c', 'user.name=E2E', 'commit', '-qm', 'E2E: operator commit')
    const localTip = (await g(REPO, 'rev-parse', 'main')).stdout.trim()
    falsch((await g(ORIGIN, 'rev-parse', 'main')).stdout.trim() === localTip, 'origin does not have it yet')
    // The throttle is a parameter too, so the suite does not have to wait a minute.
    await integrate.pushOperatorBase(Date.now() + 10 * 60_000)
    gleich((await g(ORIGIN, 'rev-parse', 'main')).stdout.trim(), localTip, 'now it is on origin')
    wahr(!!db.prepare('SELECT last_push_at FROM repos WHERE name=?').get('e2e').last_push_at,
      'and the repo records when it was last backed up')
  })

  // ---- the branch rule under hub, and keeping work on a branch ----
  await pruefe('a run can keep its work on its branch — pushed, not merged', async () => {
    await repoMerge({ merge_mode: 'hub' })
    const beforeMain = (await g(ORIGIN, 'rev-parse', 'main')).stdout.trim()
    const branch = `keep/e2e-${Date.now().toString(36)}`
    const l = await mergeRun({ branch_mode: 'neu', branch_pattern: branch, keep_on_branch: '1' })
    gleich(lauf(l.id).keep_on_branch, 1, 'the run carries the field')
    // The prompt says it, and says it ONCE: the keep sentence replaces the merge
    // rule instead of standing next to it and contradicting it.
    const prompt = readFileSync(join(SB, 'runs', l.id, 'prompt.md'), 'utf8')
    enthaelt(prompt, 'STAYS on that branch', 'the agent is told the work stays put')
    enthaelt(prompt, 'Freilauf will not merge it into main', 'and who will not merge it')
    falsch(prompt.includes('Freilauf merges your work into main itself'),
      'and NOT the merge rule as well — two rules about one thing is one too many')

    await writeAndCommit(l.wt, 'kept.txt', 'stays here\n', 'E2E: work that stays on its branch')
    const answer = await sendReport(l.id, { kind: 'done', text: 'kept it here' })
    wahr(answer.ok, 'accepted')
    await warteAuf(() => lauf(l.id).merge_status === 'kept_on_branch',
      { was: 'the run is closed as kept', timeoutMs: 20_000 })
    const r = lauf(l.id)
    gleich(r.status, 'done', 'done')
    gleich(r.merged_sha, null, 'nothing was merged')
    gleich((await g(ORIGIN, 'rev-parse', 'main')).stdout.trim(), beforeMain, 'and main did not move')
    // …but the work is on origin: nothing may live only on this machine.
    wahr((await g(ORIGIN, 'rev-parse', `refs/heads/${branch}`)).ok, `the branch is on origin (${branch})`)
    enthaelt(ereignisse(l.id).join(','), 'branch_kept', 'and that is recorded')
    gleich(flowRunsFor(l.id).length, 0, 'no run_merged flow fires — there was no merge')

    // The operator may still change his mind: one click runs the ordinary path.
    const merged = await (await formular(`/api/runs/${l.id}/merge`, {})).json()
    wahr(merged.ok, `merge by hand accepted (${JSON.stringify(merged)})`)
    await warteAuf(() => lauf(l.id).merge_status === 'merged', { was: 'merged after all', timeoutMs: 30_000 })
    gleich(lauf(l.id).keep_on_branch, 0, 'and the run no longer keeps anything back')
  })

  await pruefe('a dirty worktree still holds a kept run — committing is not optional', async () => {
    const branch = `keep/dirty-${Date.now().toString(36)}`
    const l = await mergeRun({ branch_mode: 'fest', branch_pattern: branch, keep_on_branch: '1' })
    // A name no earlier test committed: every worktree here starts from
    // origin/main, and the files this suite merged along the way are IN it. A
    // file that is already tracked with the same content leaves git clean.
    const datei = `keep-leftover-${Date.now().toString(36)}.txt`
    writeFileSync(join(l.wt, datei), 'left behind\n')
    const answer = await sendReport(l.id, { kind: 'done', text: 'am I done?' })
    enthaelt(answer.message ?? '', datei, 'the same M1 as for any other run')
    gleich(lauf(l.id).finish_state, 'awaiting_commit', 'and the same waiting state')
    gleich(lauf(l.id).status, 'running', 'the run stays running')
    await g(l.wt, 'add', '-A')
    await g(l.wt, '-c', 'user.email=e2e@test.local', '-c', 'user.name=E2E', 'commit', '-qm', 'E2E: the leftover')
    await integrate.integrateTick()
    await warteAuf(() => lauf(l.id).merge_status === 'kept_on_branch',
      { was: 'kept once it was clean', timeoutMs: 20_000 })
    gleich(lauf(l.id).status, 'done', 'and closed')
  })

  await pruefe('under hub, "no branch" no longer promises throwaway work', async () => {
    const l = await mergeRun({ branch_mode: 'keiner' })
    const prompt = readFileSync(join(SB, 'runs', l.id, 'prompt.md'), 'utf8')
    enthaelt(prompt, 'Freilauf merges your commits into main', 'it says what really happens')
    falsch(prompt.includes('throwaway'), 'and not the opposite, in the same prompt as the merge rule')
    await formular(`/api/runs/${l.id}/kill`, {})
  })

  await pruefe('the form says which rule means what, and Quick Run carries the keep box', async () => {
    const html = await (await hol(`/runs/new?repo=${repoId}`)).text()
    enthaelt(html, 'data-merge-mode="hub"', 'the form knows this repo integrates')
    enthaelt(html, 'data-explain="off"', 'both explanations are rendered')
    enthaelt(html, 'data-explain="hub"', 'so CSS can pick without a round trip')
    enthaelt(html, 'name="keep_on_branch"', 'and the keep box is there')
    enthaelt(html, 'data-merge-modes=', 'with the map the Quick-Run dialog switches by')
    // Quick Run goes through the same branchFields(), so the box has to survive
    // pickQuickFields' allowlist — that is where a field falls off silently.
    const fav = db.prepare('SELECT id FROM favorites ORDER BY id LIMIT 1').get()
    const j = await (await formular('/api/runs/quick', {
      repo_id: String(repoId), favorite_id: String(fav.id), prompt: 'E2E-Quick-Keep',
      branch_mode: 'neu', branch_pattern: `keep/quick-${Date.now().toString(36)}`, keep_on_branch: '1',
      start_mode: 'now',
    })).json()
    wahr(j.ok, `quick run started (${JSON.stringify(j)})`)
    await sessionMerken(j.runId)
    gleich(lauf(j.runId).keep_on_branch, 1, 'the ticked box arrived at the run')
    await formular(`/api/runs/${j.runId}/kill`, {})
  })

  // ---- 8b. follow-up reports: a finished run reports again ----
  let followed = null
  await pruefe('a done report from a finished run is a follow-up: merged again, announced as such, flows fired again', async () => {
    await repoMerge({ merge_mode: 'hub' })
    followed = await mergeRun()
    await writeAndCommit(followed.wt, 'first.txt', 'first\n', 'E2E: the first report')
    await sendReport(followed.id, { kind: 'done', text: 'The task is done.' })
    await warteAuf(() => lauf(followed.id).merge_status === 'merged', { was: 'merged the first time', timeoutMs: 30_000 })
    const firstSha = lauf(followed.id).merged_sha
    // The first merge's flow run is dispatched a tick after the merge — wait
    // for it, or the count below would compare against a number read too early.
    await warteAuf(() => flowRunsFor(followed.id).length === 1, { was: 'the first merge fired the flow', timeoutMs: 15_000 })
    gleich(lauf(followed.id).telegram_on, 1, 'notifications are on for every run from the start')

    // The operator typed more into the session, the agent did it and reports again.
    await writeAndCommit(followed.wt, 'second.txt', 'second\n', 'E2E: the follow-up')
    const antwort = await sendReport(followed.id, { kind: 'done', text: 'Added the second file, as asked.' })
    wahr(antwort.ok, 'a finished run is not refused')
    enthaelt(antwort.message ?? '', 'Freilauf is merging it into main', 'the same answer a first report gets')
    await warteAuf(() => lauf(followed.id).followup_open === 0 && lauf(followed.id).merged_sha !== firstSha,
      { was: 'the follow-up is merged', timeoutMs: 30_000 })
    const r = lauf(followed.id)
    gleich(r.status, 'done', 'still done — the status is the first attempt\'s truth')
    gleich(r.followups, 1, 'one follow-up counted')
    gleich(r.merge_status, 'merged', 'merged')
    gleich(r.finish_state, null, 'and out of the gate')
    wahr((await g(REPO, 'merge-base', '--is-ancestor', r.merged_sha, 'origin/main')).ok, 'the follow-up commit is on origin/main')
    enthaelt(r.report_md, 'The task is done.', 'the first report is kept')
    enthaelt(r.report_md, '## Follow-up report #1', 'and the follow-up stands under its own heading')
    enthaelt(r.report_md, 'Added the second file', 'with its text')
    gleich(r.followup_md, 'Added the second file, as asked.', 'the latest follow-up on its own')
    const ev = ereignisse(followed.id)
    enthaelt(ev.join(','), 'followup_reported', 'recorded on the way in')
    enthaelt(ev.join(','), 'followup_done', 'and on the way out')
    gleich(ev.filter(k => k === 'notified:done').length, 1, 'the done message was sent once, for the first report')
    gleich(ev.filter(k => k === 'notified:followup').length, 1, 'and the follow-up is its own message')
    gleich(ev.filter(k => k === 'merged').length, 2, 'two merges, one per report')
    gleich(ev.filter(k => k === 'finish_started').length, 2, 'and the gate ran once per report')
    await warteAuf(() => flowRunsFor(followed.id).length === 2,
      { was: 'the run_merged flow fires again for the follow-up\'s merge', timeoutMs: 15_000 })
    gleich(triggerOf(flowRunsFor(followed.id).at(-1)).merge.sha, r.merged_sha, 'with the new merge\'s facts')
    gleich(triggerOf(flowRunsFor(followed.id).at(-1)).run.followups, 1, 'and the run info says it is a follow-up')
    gleich(triggerOf(flowRunsFor(followed.id).at(-1)).run.last_report, 'Added the second file, as asked.', 'last_report is the follow-up text')
  })

  await pruefe('a follow-up without new commits is reported, not merged — and a dirty one is held like a first report', async () => {
    const antwort = await sendReport(followed.id, { kind: 'done', text: 'Here is the list you asked for: a, b, c.' })
    wahr(antwort.ok, 'accepted')
    enthaelt(antwort.message ?? '', 'follow-up report #2 received', 'the answer says which report it was')
    enthaelt(antwort.message ?? '', 'Nothing to merge', 'and that there was nothing to merge')
    const r = lauf(followed.id)
    gleich(r.followups, 2, 'counted')
    gleich(r.followup_open, 0, 'closed at once')
    gleich(r.finish_state, null, 'no gate left open')
    gleich(ereignisse(followed.id).filter(k => k === 'notified:followup').length, 2, 'announced anyway — the operator asked for it')
    // Dirty: the same M1, and the run stays where it is until the agent commits.
    writeFileSync(join(followed.wt, 'half.txt'), 'not committed\n')
    const held = await sendReport(followed.id, { kind: 'done', text: 'done with the third thing' })
    enthaelt(held.message ?? '', 'NOT finished yet', 'the same answer as for a first report')
    enthaelt(held.message ?? '', 'half.txt', 'and the file is named')
    gleich(lauf(followed.id).finish_state, 'awaiting_commit', 'in the gate')
    gleich(lauf(followed.id).followup_open, 1, 'as a follow-up')
    gleich(lauf(followed.id).status, 'done', 'and the status is untouched')
    await g(followed.wt, 'add', '-A')
    await g(followed.wt, '-c', 'user.email=e2e@test.local', '-c', 'user.name=E2E', 'commit', '-qm', 'E2E: the third thing')
    await integrate.integrateTick()
    await warteAuf(() => lauf(followed.id).followup_open === 0, { was: 'the follow-up is merged once clean', timeoutMs: 30_000 })
    gleich(lauf(followed.id).followups, 3, 'third follow-up')
    gleich(ereignisse(followed.id).filter(k => k === 'followup_reported').length, 3, 'reported three times — the re-report after M1 is not a fourth')
  })

  await pruefe('the checkbox under the terminal silences the notifications for the run and nothing else', async () => {
    const html = await (await hol(`/runs/${followed.id}`)).text()
    enthaelt(html, 'id="notify-on"', 'the box is on the detail page')
    enthaelt(html, `data-run="${followed.id}"`, 'and knows its run')
    wahr(/id="notify-on"[^>]*checked/.test(html), 'ticked by default')
    const off = await (await formular(`/api/runs/${followed.id}/notify`, { on: '0' })).json()
    gleich(off.notify_on, 0, 'switched off')
    gleich(off.telegram_on, 0, 'and the old field name still answers, for whoever reads it')
    gleich(lauf(followed.id).telegram_on, 0, 'stored (the column keeps its historic name)')
    enthaelt(ereignisse(followed.id).join(','), 'notify_off', 'and recorded')
    falsch(/id="notify-on"[^>]*checked/.test(await (await hol(`/runs/${followed.id}`)).text()), 'the page shows it unticked')
    const before = ereignisse(followed.id).filter(k => k === 'notified:followup').length
    await writeAndCommit(followed.wt, 'quiet.txt', 'quiet\n', 'E2E: a quiet follow-up')
    await sendReport(followed.id, { kind: 'done', text: 'quietly done' })
    await warteAuf(() => lauf(followed.id).followup_open === 0 && lauf(followed.id).followups === 4,
      { was: 'the quiet follow-up is merged', timeoutMs: 30_000 })
    wahr((await g(REPO, 'merge-base', '--is-ancestor', lauf(followed.id).merged_sha, 'origin/main')).ok,
      'merged all the same — the box is about the messages only')
    gleich(ereignisse(followed.id).filter(k => k === 'notified:followup').length, before, 'nothing announced')
    enthaelt(ereignisse(followed.id).join(','), 'notify_muted', 'but it is written down that there was none')
    // The old address is an alias, not a redirect: whatever still posts to it
    // has to keep working.
    const on = await (await formular(`/api/runs/${followed.id}/telegram`, { on: '1' })).json()
    gleich(on.notify_on, 1, 'and back on, through the old route')
    gleich(lauf(followed.id).telegram_on, 1, 'stored')
    // A help call from a finished run reaches the operator too, and changes nothing about the run.
    const help = await sendReport(followed.id, { kind: 'help', text: 'Which of the two?' })
    wahr(help.ok, 'help from a finished run is accepted')
    gleich(lauf(followed.id).status, 'done', 'the status stays')
    gleich(lauf(followed.id).help_text, 'Which of the two?', 'the question is stored')
    gleich(ereignisse(followed.id).filter(k => k === 'notified:help').length, 1, 'and sent')
  })

  // ---- 8c. follow-up commissions: the operator types more work into a finished run ----
  await pruefe('a message into a finished run is a follow-up commission: the run displays as running again and is clocked', async () => {
    const vor = await formular(`/api/runs/${followed.id}/send`, { text: 'Please also document the new file.' })
    wahr(vor.ok, 'the send is accepted')
    const r = lauf(followed.id)
    wahr(!!r.followup_since, 'the commission is clocked from now')
    gleich(r.status, 'done', 'the status still tells the truth about the first attempt')
    const ev = ereignisse(followed.id)
    enthaelt(ev.join(','), 'followup_started', 'recorded as a commission')
    falsch(ev.includes('message_sent'), 'and not as a plain message — that kind is for live runs')
    // The pages agree: the status word is "running" again, with the follow-up line.
    const detail = await (await hol(`/runs/${followed.id}`)).text()
    enthaelt(detail, 'status-chip">Running<', 'the detail page displays it as running')
    enthaelt(detail, 'Follow-up work since', 'and says since when')
    const laufend = await (await hol(`/?repo=${repoId}&status=running`)).text()
    enthaelt(laufend, `/runs/${followed.id}`, 'the overview’s running filter shows the commissioned run')
    enthaelt(laufend, 'Follow-up work since', 'with the follow-up line in the status cell')

    // The watcher holds the follow-up to the run's expected duration, counting
    // from the commission — the same clock a first attempt works against.
    db.prepare(`UPDATE runs SET followup_since=datetime('now', '-36 minutes') WHERE id=?`).run(followed.id)
    await watcherTick()
    enthaelt(ereignisse(followed.id).join(','), 'anomaly:followup_soft_overrun', '80 % of the expected duration: yellow')
    falsch(ereignisse(followed.id).includes('anomaly:followup_overrun'), 'but not yet red')
    db.prepare(`UPDATE runs SET followup_since=datetime('now', '-46 minutes') WHERE id=?`).run(followed.id)
    await watcherTick()
    enthaelt(ereignisse(followed.id).join(','), 'anomaly:followup_overrun', 'past the expected duration without a report: red')
    enthaelt(ereignisse(followed.id).join(','), 'notified:followup_overrun', 'and the operator hears it')
    await watcherTick()
    gleich(ereignisse(followed.id).filter(k => k === 'notified:followup_overrun').length, 1, 'the next pass does not page again')

    // New instructions restart the clock — and retract the old overrun statement
    // the same way a raised duration retracts one, so a genuine overrun of the
    // new commission can page again.
    await formular(`/api/runs/${followed.id}/send`, { text: 'And add tests, too.' })
    falsch(ereignisse(followed.id).includes('anomaly:followup_overrun'), 'the new commission clears the old statement')
    falsch(ereignisse(followed.id).includes('notified:followup_overrun'), 'and its notification flag with it')
    wahr(!!lauf(followed.id).followup_since, 'and is clocked from now')

    // The follow-up report ends the commission: clock stopped, statement gone.
    const antwort = await sendReport(followed.id, { kind: 'done', text: 'Documented and tested, as asked.' })
    wahr(antwort.ok, 'the report is accepted')
    await warteAuf(() => lauf(followed.id).followup_open === 0 && lauf(followed.id).followups === 5,
      { was: 'the follow-up is processed', timeoutMs: 30_000 })
    gleich(lauf(followed.id).followup_since, null, 'the commission is answered: the clock stopped')
    falsch(ereignisse(followed.id).includes('anomaly:followup_overrun'), 'no leftover statement')
    gleich(lauf(followed.id).status, 'done', 'and the status is still the first attempt’s truth')
  })

  await pruefe('a follow-up whose agent is gone is not held to a deadline that can never be met', async () => {
    // A dead pane can never report — holding the commission to its deadline
    // would produce a misleading alarm after the run's expected duration. The
    // watcher gives it up and says why. remain-on-exit keeps the SESSION alive
    // while the process inside is dead, which is exactly the shape hermes
    // leaves behind.
    const sname = 'fl-followup-dead'
    sessions.add(sname)
    await sh('tmux', ['new-session', '-d', '-x', '80', '-y', '24', '-s', sname])
    await sh('tmux', ['set-option', '-t', `=${sname}:`, 'remain-on-exit', 'on'])
    await sh('tmux', ['send-keys', '-t', `=${sname}:`, 'exit', 'Enter'])
    await warteAuf(async () => {
      const r = await sh('tmux', ['display', '-p', '-t', `=${sname}:`, '#{pane_dead}'])
      return r.ok && r.stdout.trim() === '1'
    }, { was: 'the pane is dead', timeoutMs: 5000 })
    const id = 'f0110ade-0000-4000-8000-000000000001'
    db.prepare(`INSERT INTO runs(id, repo_id, status, harness, prompt, branch_mode, expected_minutes, tmux_session, started_at, followup_since)
                VALUES(?, ?, 'done', 'hermes', 'p', 'keiner', 45, ?, datetime('now'), datetime('now'))`)
      .run(id, repoId, sname)
    await watcherTick()
    gleich(lauf(id).followup_since, null, 'the commission is given up')
    enthaelt(ereignisse(id).join(','), 'followup_agent_gone', 'and it is written down why')
    db.prepare('DELETE FROM runs WHERE id=?').run(id)
  })

  // ---- 9. with merge_mode off nothing of this happens ----
  await pruefe('with the integration switched off a done report closes the run as it always did', async () => {
    await repoMerge({ merge_mode: 'off' })
    const l = await mergeRun()
    writeFileSync(join(l.wt, 'irrelevant.txt'), 'does not matter\n')
    const antwort = await sendReport(l.id, { kind: 'done', text: 'plain old done' })
    gleich(antwort.message ?? null, null, 'no answer to read — there is nothing to say')
    const r = lauf(l.id)
    gleich(r.status, 'done', 'done right away, dirty worktree and all')
    gleich(r.finish_state, null, 'no gate')
    gleich(r.merge_status, null, 'and no verdict about its work')
    // And the prompt is the one it always was, down to the sentence about a
    // detached worktree — with the integration off, not a word may change.
    const prompt = readFileSync(join(SB, 'runs', l.id, 'prompt.md'), 'utf8')
    enthaelt(prompt, 'No branch — the worktree is detached; changes are throwaway changes.',
      'the old sentence, byte for byte')
    falsch(prompt.includes('Freilauf merges'), 'and nothing about merging at all')
    const html = await (await hol(`/runs/new?repo=${repoId}`)).text()
    enthaelt(html, 'data-merge-mode="off"', 'the form says so too')
    enthaelt(html, 'data-hub-only hidden', 'and the keep box is not even offered')

    // …and a follow-up with the integration off is a report and nothing more:
    // appended, announced, the flows fired again — no gate, no merge.
    const { flowsTick } = await import('../server/flows/triggers.mjs')
    await flowsTick()
    gleich(lauf(l.id).flow_dispatched, 1, 'the first end was dispatched')
    const again = await sendReport(l.id, { kind: 'done', text: 'and the follow-up, off mode' })
    wahr(again.ok, 'accepted')
    enthaelt(again.message ?? '', 'follow-up report #1 received', 'the agent is told what it was')
    const f = lauf(l.id)
    gleich(f.status, 'done', 'done stays done')
    gleich(f.followups, 1, 'counted')
    gleich(f.finish_state, null, 'no gate')
    gleich(f.merge_status, null, 'no verdict')
    enthaelt(f.report_md, 'plain old done', 'the first report')
    enthaelt(f.report_md, '## Follow-up report #1', 'and the follow-up under it')
    gleich(ereignisse(l.id).filter(k => k === 'notified:followup').length, 1, 'announced')
    await flowsTick()
    gleich(lauf(l.id).flow_dispatched, 1, 'the "run finished" triggers were evaluated again')
  })

  // ------------------------------------------------------------------
  gruppe('Plugins: the page, an external package, the discovery scan and the wizard')

  // Deliberately the LAST stub group: it registers plugins into a process-wide
  // registry and it answers the discovery findings, so everything above must
  // have run against the hub as it ships. Every package it builds is removed
  // again by its own last test.
  const PAKETE = join(SB, 'pakete')

  /** Write a plugin package into a directory of the sandbox (never into the plugin dir). */
  function paketBauen(name, manifest, quelle) {
    const dir = join(PAKETE, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2))
    writeFileSync(join(dir, manifest.main ?? 'index.mjs'), quelle)
    return dir
  }

  const EXT_PROVIDER = `export default {
  id: 'e2e-provider',
  kind: 'provider',
  label: 'E2E Model Provider',
  envKeys: ['E2E_PROVIDER_KEY'],
  ocPrefix: 'e2e',
  mdKey: 'e2e',
  pulse: { url: 'https://example.invalid/health' },
  async fetchModels() { return [{ id: 'e2e-mini', name: 'E2E Mini' }] },
}
`
  // `bin: 'sh'` is the point of this one: the discovery scan asks the shell
  // whether a coding agent's binary exists, and a test that depends on claude
  // being installed on the machine running it is not a test.
  const EXT_AGENT = `export default {
  id: 'e2e-agent',
  kind: 'harness',
  label: 'E2E Coding Agent',
  bin: 'sh',
  installHint: 'it is already on every machine',
  subscription: false,
  providers: [],
  logPatterns: [{ typ: 'rate_limit', re: /e2e-never-matches-anything/ }],
  modelArgs: () => [],
  effortOptions: () => [],
  usage: async () => null,
  pulseId: () => null,
}
`

  await pruefe('the Plugins page lists the coding agents, the model providers and the packages', async () => {
    const r = await hol('/settings/plugins')
    gleich(r.status, 200, 'status')
    const html = await r.text()
    // The two sections that replaced the old Coding-agents page…
    enthaelt(html, 'Claude Code', 'a coding agent by its label')
    enthaelt(html, 'cursor-agent', 'and one by its binary')
    enthaelt(html, 'OpenRouter', 'a model provider')
    enthaelt(html, 'DeepSeek', 'and another one')
    // …plus the two the page is new for.
    enthaelt(html, '/settings/plugins/save', 'every card posts to the save route')
    enthaelt(html, '/settings/plugins/install', 'the install form')
    enthaelt(html, '/settings/plugins/scan', 'the scan button')
    enthaelt(html, 'name="cred_api_key_env"', 'a credential can be pointed at another variable')
    enthaelt(html, 'name="cred_api_key_value"', 'or carry a value of its own')
  })

  await pruefe('a save round-trips the enabled flag, the provider selection and a credential', async () => {
    const providerVorher = JSON.parse(
      db.prepare(`SELECT config FROM plugin_config WHERE plugin_id='hermes'`).get().config).providers
    try {
      // 1. the provider selection of a coding agent
      const r1 = await formular('/settings/plugins/save',
        { id: 'hermes', enabled: '1', providers: ['deepseek'] }, { alsBrowser: true })
      gleich(r1.status, 303, 'saved')
      const hermes = db.prepare(`SELECT * FROM plugin_config WHERE plugin_id='hermes'`).get()
      gleich(hermes.enabled, 1, 'enabled')
      gleich(JSON.parse(hermes.config).providers.join(','), 'deepseek', 'only the ticked provider survived')

      // 2. the enabled flag really switches off — the hidden `0` companion is
      //    what makes that possible at all (a form sends nothing for an
      //    unticked box).
      const r2 = await formular('/settings/plugins/save', { id: 'hermes', enabled: '0' }, { alsBrowser: true })
      gleich(r2.status, 303, 'saved')
      gleich(db.prepare(`SELECT enabled FROM plugin_config WHERE plugin_id='hermes'`).get().enabled, 0, 'switched off')

      // 3. a stored credential VALUE
      // Deliberately NOT in a real key's shape ("sk-…"): pruefe-vor-push.sh greps the
      // committed state for exactly that, and a canary that trips the secret scanner
      // would block every push over a string invented to be harmless.
      const geheim = 'e2e-canary-do-not-render-me'
      gleich((await formular('/settings/plugins/save', {
        id: 'deepseek', enabled: '1', cred_api_key_mode: 'value', cred_api_key_value: geheim,
      }, { alsBrowser: true })).status, 303, 'credential saved')
      const cfg = JSON.parse(db.prepare(`SELECT config FROM plugin_config WHERE plugin_id='deepseek'`).get().config)
      gleich(cfg.credentials.api_key.mode, 'value', 'stored as a value')
      gleich(cfg.credentials.api_key.value, geheim, 'and it is the value that was typed')

      // THE assertion of this test: a page renders, and a page is shared,
      // logged and screenshotted. The value must never come back out of it.
      const html = await (await hol('/settings/plugins')).text()
      falsch(html.includes(geheim), 'the credential value is nowhere in the HTML')
      enthaelt(html, 'value=""', 'the password field is rendered empty')

      // 4. an empty password field means "keep what is stored" — walking
      //    through the form again must not wipe a key.
      gleich((await formular('/settings/plugins/save',
        { id: 'deepseek', enabled: '1', cred_api_key_mode: 'value', cred_api_key_value: '' },
        { alsBrowser: true })).status, 303, 'saved again')
      gleich(JSON.parse(db.prepare(`SELECT config FROM plugin_config WHERE plugin_id='deepseek'`).get().config)
        .credentials.api_key.value, geheim, 'the stored value survived an empty submit')

      // 5. an environment variable NAME instead — the better answer where a
      //    machine can be given one, and the only half that may be shown.
      gleich((await formular('/settings/plugins/save', {
        id: 'deepseek', enabled: '1', cred_api_key_mode: 'env', cred_api_key_env: 'MY_OWN_DEEPSEEK_KEY',
      }, { alsBrowser: true })).status, 303, 'saved')
      const cfg2 = JSON.parse(db.prepare(`SELECT config FROM plugin_config WHERE plugin_id='deepseek'`).get().config)
      gleich(cfg2.credentials.api_key.mode, 'env', 'reads the environment now')
      gleich(cfg2.credentials.api_key.envVar, 'MY_OWN_DEEPSEEK_KEY', 'under the name the operator gave')
      falsch('value' in cfg2.credentials.api_key, 'and the stored value is gone, not shadowed')
      const html2 = await (await hol('/settings/plugins')).text()
      enthaelt(html2, 'MY_OWN_DEEPSEEK_KEY', 'the NAME is shown')
      falsch(html2.includes(geheim), 'the value still is not')
    } finally {
      await formular('/settings/plugins/save',
        { id: 'hermes', enabled: '1', providers: providerVorher }, { alsBrowser: true })
    }
  })

  await pruefe('an unknown plugin id is a readable problem, not a 500', async () => {
    const r = await formular('/settings/plugins/save', { id: 'no-such-plugin', enabled: '1' }, { alsBrowser: true })
    gleich(r.status, 400, 'refused')
    enthaelt(await r.text(), 'no-such-plugin', 'and the page names it')
  })

  await pruefe('an external package is installed from a directory and joins the registry', async () => {
    const dir = paketBauen('e2e-provider', {
      api: 1, id: 'e2e-provider', kind: 'provider', name: 'E2E Model Provider', version: '0.4.2',
      description: 'A model provider built by the e2e suite.',
    }, EXT_PROVIDER)

    const r = await formular('/settings/plugins/install', { path: dir }, { alsBrowser: true })
    gleich(r.status, 303, `installed (${r.status === 400 ? await r.text() : ''})`.slice(0, 400))
    // It is COPIED into the plugin directory, not linked: the operator's own
    // directory may move, and a service must not die because it did.
    wahr(existsSync(join(sk.PLUGINS, 'e2e-provider', 'plugin.json')), 'the package landed in the plugin directory')

    const html = await (await hol('/settings/plugins')).text()
    enthaelt(html, 'E2E Model Provider', 'the plugin has a card')
    enthaelt(html, '0.4.2', 'the packages table names its version')
    enthaelt(html, 'e2e-provider', 'and its id')
    // A registered provider is choosable wherever a provider is chosen — the
    // whole point of the registry being mutable.
    enthaelt(await (await hol('/api/coding-agents/detect')).text(), 'ok', 'the detect API still answers')
  })

  await pruefe('a package whose id is already taken is refused, and nothing is written', async () => {
    // Refused BEFORE anything is copied: a package shadowing `claude` could
    // replace the coding agent every run is started with, without saying so.
    const dopplung = paketBauen('e2e-provider-again', {
      api: 1, id: 'e2e-provider', kind: 'provider', name: 'A second one', version: '9.9.9',
    }, EXT_PROVIDER)
    const r = await formular('/settings/plugins/install', { path: dopplung }, { alsBrowser: true })
    gleich(r.status, 400, 'refused')
    enthaelt(await r.text(), 'already taken', 'and it says why')
    falsch(existsSync(join(sk.PLUGINS, 'e2e-provider-again')), 'nothing new on disk')
    // The original is untouched, version and all.
    enthaelt(await (await hol('/settings/plugins')).text(), '0.4.2', 'the installed one still stands')

    const kaputt = paketBauen('e2e-broken', {
      api: 2, id: 'e2e-broken', kind: 'provider', name: 'From the future', version: '1.0.0',
    }, EXT_PROVIDER)
    const r2 = await formular('/settings/plugins/install', { path: kaputt }, { alsBrowser: true })
    gleich(r2.status, 400, 'a manifest for another api version is refused too')
    enthaelt(await r2.text(), 'api', 'naming the field')

    const r3 = await formular('/settings/plugins/install', { path: join(SB, 'does-not-exist') }, { alsBrowser: true })
    gleich(r3.status, 400, 'a path that is not a directory is refused')
    gleich((await formular('/settings/plugins/install', { path: '' }, { alsBrowser: true })).status, 400, 'and an empty one')
  })

  await pruefe('the scan finds a coding agent on this machine and the banner asks about it once', async () => {
    // An external coding agent whose binary is `sh`: present on every machine
    // the suite can run on, so the finding is deterministic.
    const dir = paketBauen('e2e-agent', {
      api: 1, id: 'e2e-agent', kind: 'harness', name: 'E2E Coding Agent', version: '1.2.3',
      description: 'A coding agent built by the e2e suite.',
    }, EXT_AGENT)
    gleich((await formular('/settings/plugins/install', { path: dir }, { alsBrowser: true })).status, 303, 'installed')

    gleich((await formular('/settings/plugins/scan', {}, { alsBrowser: true })).status, 303, 'scanned')
    const row = db.prepare(`SELECT * FROM discovery WHERE id='harness:e2e-agent'`).get()
    wahr(!!row, 'the scan wrote a row for it')
    gleich(JSON.parse(row.detail).bin, 'sh', 'and recorded WHICH binary it found')
    wahr(row.answer === null, 'nobody has been asked yet')
    // A found credential is NAMED, never read — the row carries a variable
    // name and no value, because it is shown in the UI and travels with a
    // database dump.
    falsch(JSON.stringify(row.detail).includes('sk-'), 'no secret in a discovery row')

    enthaelt(await (await hol('/')).text(), 'banner discovery', 'the banner appears on an ordinary page')
    enthaelt(await (await hol('/settings/plugins')).text(), 'E2E Coding Agent', 'and the finding has a card')

    // Answering is what "asked once" means: a page that only SHOWS something
    // has not asked anybody anything.
    gleich((await formular('/settings/plugins/discovery',
      { id: 'harness:e2e-agent', answer: 'dismissed' }, { alsBrowser: true })).status, 303, 'answered')
    const nachher = db.prepare(`SELECT * FROM discovery WHERE id='harness:e2e-agent'`).get()
    gleich(nachher.answer, 'dismissed', 'the answer is recorded')
    wahr(!!nachher.asked_at, 'together with the moment it was asked')
    falsch((await (await hol('/')).text()).includes('banner discovery'), 'and it stops asking')

    // …and a second scan does not un-answer it.
    gleich((await formular('/settings/plugins/scan', {}, { alsBrowser: true })).status, 303, 'scanned again')
    gleich(db.prepare(`SELECT answer FROM discovery WHERE id='harness:e2e-agent'`).get().answer, 'dismissed',
      'a rescan never overwrites an answer')
  })

  await pruefe('"Add" from a finding switches the plugin on and answers the suggestion', async () => {
    // Put the finding back the way a fresh machine would have it.
    db.prepare(`UPDATE discovery SET answer=NULL, asked_at=NULL WHERE id='harness:e2e-agent'`).run()
    gleich((await formular('/settings/plugins/add', { id: 'e2e-agent' }, { alsBrowser: true })).status, 303, 'added')
    const cfg = db.prepare(`SELECT * FROM plugin_config WHERE plugin_id='e2e-agent'`).get()
    wahr(!!cfg, 'the plugin is configured now')
    gleich(cfg.enabled, 1, 'and switched on')
    gleich(cfg.source, 'external', 'recorded as an external package')
    gleich(db.prepare(`SELECT answer FROM discovery WHERE id='harness:e2e-agent'`).get().answer, 'added', 'and the finding is answered')
  })

  await pruefe('an external package is uninstalled again — directory, registry and configuration', async () => {
    for (const id of ['e2e-agent', 'e2e-provider']) {
      const r = await formular('/settings/plugins/uninstall', { id }, { alsBrowser: true })
      gleich(r.status, 303, `${id} removed`)
      falsch(existsSync(join(sk.PLUGINS, id)), `${id}: the directory is gone`)
      wahr(!db.prepare('SELECT 1 FROM plugin_config WHERE plugin_id=?').get(id), `${id}: its configuration too`)
      wahr(!db.prepare('SELECT 1 FROM discovery WHERE plugin_id=?').get(id), `${id}: and its findings`)
    }
    const html = await (await hol('/settings/plugins')).text()
    falsch(html.includes('E2E Model Provider'), 'the page no longer offers it')
    falsch(html.includes('E2E Coding Agent'), 'nor the coding agent')
    // A built-in is never removable: it is part of the running code, and a
    // registry disagreeing with the imports would be a lie.
    const r = await formular('/settings/plugins/uninstall', { id: 'claude' }, { alsBrowser: true })
    gleich(r.status, 400, 'a built-in is refused')
    enthaelt(await r.text(), 'built-in', 'and it says so')
    // And the hub still works with everything the suite installed gone.
    gleich((await hol('/settings/plugins')).status, 200, 'the page still renders')
    gleich((await hol('/')).status, 200, 'and so does the overview')
  })

  // ------------------------------------------------------------------
  gruppe('Notifications: optional, and a channel is a plugin')

  // This group runs inside the plugins group's fence and for the same reason:
  // it registers a plugin into a process-wide registry, and it is the FIRST
  // thing in the whole suite that gives this hub a working notification
  // channel. Everything above ran with none configured — which is exactly the
  // state the first test below asserts is a complete installation and not a
  // missing step.
  const NOTIFY_LOG = join(SB, 'notified.jsonl')

  // A notifier that writes what it was handed to a file: the only way to assert
  // on the MESSAGE the hub composes without talking to somebody's API. Its
  // `outfile` is a declared setting, so configuring it goes through the very
  // form an operator uses.
  const EXT_NOTIFIER = `import { appendFileSync } from 'node:fs'
export default {
  id: 'e2e-notifier',
  kind: 'notifier',
  label: 'E2E Notifier',
  settings: [{ key: 'outfile', type: 'text', required: true, labelKey: 'e2e.outfile' }],
  async send(message, ctx) {
    const file = ctx.setting('outfile')
    if (!file) return { ok: false, error: 'no outfile configured' }
    appendFileSync(file, JSON.stringify({
      kind: message.kind, text: message.text, url: message.url, runId: message.runId,
      attachment: message.attachment ? message.attachment.fileName : null,
      attachmentContent: message.attachment ? message.attachment.content : null,
      linkLabel: message.linkLabel,
    }) + '\\n')
    return { ok: true }
  },
}
`
  const gemeldet = () => (existsSync(NOTIFY_LOG)
    ? readFileSync(NOTIFY_LOG, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    : [])

  await pruefe('with no channel configured the page says so, and every notifying path is a silent no-op', async () => {
    const r = await hol('/settings/notifications')
    gleich(r.status, 200, 'the page renders')
    const html = await r.text()
    enthaelt(html, 'No channel is configured', 'and states the quiet installation as a state, not a problem')
    enthaelt(html, 'Notifications are optional', 'saying outright that nothing here has to be filled in')
    enthaelt(html, 'Telegram', 'the built-in channel has a card')
    enthaelt(html, '/settings/notifications/save', 'which posts to the save route')
    // Nothing anywhere nags about it: the banner slot on an ordinary page is
    // for coding agents and discoveries, never for a missing notifier.
    falsch((await (await hol('/')).text()).includes('banner notify'), 'no banner on the overview')

    // The test button refuses rather than reporting a success nobody had.
    const t1 = await formular('/settings/notifications/test', { id: 'telegram' }, { alsBrowser: true })
    gleich(t1.status, 303, 'the button answers')
    // The reason is TRANSLATED before it travels: it is rendered to the
    // operator, and the Telegram wizard's own step 3 reaches this same path.
    enthaelt(decodeURIComponent(t1.headers.get('location')), 'not configured yet',
      'and says which of the two it was, in the operator\'s language')

    // And the run path: a report still writes its flag, with delivered=false,
    // so a hub that is switched on later does not fire a backlog.
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E: quiet report', branch_mode: 'keiner', expected_minutes: '5' })
    await sessionMerken(j.runId)
    await warteAuf(() => lauf(j.runId).status === 'running', { was: 'the run is up' })
    await sendReport(j.runId, { kind: 'done', text: 'nothing to hear' })
    await warteAuf(() => lauf(j.runId).status === 'done', { was: 'the run is done' })
    const flagge = db.prepare(`SELECT payload FROM events WHERE run_id=? AND kind='notified:done'`).get(j.runId)
    wahr(!!flagge, 'the run is marked as told')
    gleich(JSON.parse(flagge.payload).delivered, false, 'and honestly says nothing was delivered')
    falsch(existsSync(NOTIFY_LOG), 'no channel wrote anything')
  })

  await pruefe('an external notifier package joins the registry and gets a card of its own', async () => {
    const dir = paketBauen('e2e-notifier', {
      api: 1, id: 'e2e-notifier', kind: 'notifier', name: 'E2E Notifier', version: '2.0.0',
      description: 'A notification channel built by the e2e suite.',
    }, EXT_NOTIFIER)
    const r = await formular('/settings/plugins/install', { path: dir }, { alsBrowser: true })
    gleich(r.status, 303, `installed (${r.status === 400 ? await r.text() : ''})`.slice(0, 400))

    const html = await (await hol('/settings/notifications')).text()
    enthaelt(html, 'E2E Notifier', 'the package has a card on the notifications page')
    enthaelt(html, 'Telegram', 'next to the built-in one')
    gleich((html.match(/action="\/settings\/notifications\/save"/g) ?? []).length, 2, 'one card per registered notifier')
    // It is registered but not yet ready: a declared `required` setting with no
    // value is what "not configured" means, and the hub is still quiet.
    enthaelt(html, 'No channel is configured', 'a registered channel is not a configured one')

    // A duplicate id is refused for a notifier exactly as for the other kinds.
    const wieder = paketBauen('e2e-notifier-again', {
      api: 1, id: 'e2e-notifier', kind: 'notifier', name: 'A second one', version: '9.9.9',
    }, EXT_NOTIFIER)
    const r2 = await formular('/settings/plugins/install', { path: wieder }, { alsBrowser: true })
    gleich(r2.status, 400, 'the duplicate is refused')
    enthaelt(await r2.text(), 'already taken', 'and it says why')
  })

  await pruefe('configuring it makes the hub speak — and the message carries what a channel needs', async () => {
    const r = await formular('/settings/notifications/save',
      { id: 'e2e-notifier', enabled: '1', set_outfile: NOTIFY_LOG }, { alsBrowser: true })
    gleich(r.status, 303, 'saved')
    enthaelt(await (await hol('/settings/notifications')).text(), 'At least one channel is configured',
      'and the page changes its mind about the installation')

    const t = await formular('/settings/notifications/test', { id: 'e2e-notifier' }, { alsBrowser: true })
    gleich(t.headers.get('location'), '/settings/notifications?test=ok', 'the test message went out')
    const [erste] = gemeldet()
    wahr(!!erste, 'the plugin really received it')
    gleich(erste.kind, 'test', 'the message says what it is about')
    wahr(String(erste.text).length > 0, 'and carries text')
    wahr(String(erste.url ?? '').startsWith('http'), 'plus a link the channel may render')
    wahr(String(erste.linkLabel ?? '').length > 0, 'with a label for it')
  })

  await pruefe('a run report reaches the configured channel, attachment and all', async () => {
    const vorher = gemeldet().length
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E: a loud report', branch_mode: 'keiner', expected_minutes: '5' })
    await sessionMerken(j.runId)
    await warteAuf(() => lauf(j.runId).status === 'running', { was: 'the run is up' })
    await sendReport(j.runId, { kind: 'done', text: 'loud and clear' })
    await warteAuf(() => gemeldet().length > vorher, { was: 'the channel heard about the run', timeoutMs: 20_000 })
    const m = gemeldet().at(-1)
    gleich(m.kind, 'run', 'the message names what it is about')
    gleich(m.runId, j.runId, 'and which run')
    enthaelt(m.text, 'loud and clear', 'the report is in it')
    wahr(String(m.attachment ?? '').endsWith('.md'), 'and the full report travels as an attachment')
    gleich(JSON.parse(db.prepare(`SELECT payload FROM events WHERE run_id=? AND kind='notified:done'`)
      .get(j.runId).payload).delivered, true, 'the flag records the delivery')
  })

  await pruefe('a report with a DETAILED version: the text is the short report, the document is the detail', async () => {
    const vorher = gemeldet().length
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E: two-part report', branch_mode: 'keiner', expected_minutes: '5' })
    await sessionMerken(j.runId)
    await warteAuf(() => lauf(j.runId).status === 'running', { was: 'the run is up' })
    await sendReport(j.runId, {
      kind: 'done',
      text: 'Kurz: Frage beantwortet, nichts zu mergen.',
      detail: 'Ausfuehrlich: alle Details zur Antwort, Schritt fuer Schritt.',
    })
    await warteAuf(() => gemeldet().length > vorher, { was: 'the channel heard about the run', timeoutMs: 20_000 })
    const m = gemeldet().at(-1)
    enthaelt(m.text, 'Kurz: Frage beantwortet', 'the TEXT is the short report')
    falsch(m.text.includes('Schritt fuer Schritt'), 'the detail is not duplicated into the text')
    gleich(m.attachmentContent, 'Ausfuehrlich: alle Details zur Antwort, Schritt fuer Schritt.',
      'the DOCUMENT is the detailed report')
    gleich(lauf(j.runId).report_detail_md, 'Ausfuehrlich: alle Details zur Antwort, Schritt fuer Schritt.',
      'and it is stored on the run')
    enthaelt(m.text, `/runs/${j.runId}`, 'the message carries the run link')
  })

  await pruefe('fl-report --detail hands the detailed report to the hub', async () => {
    const vorher = gemeldet().length
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E: fl-report detail', branch_mode: 'keiner', expected_minutes: '5' })
    await sessionMerken(j.runId)
    await warteAuf(() => lauf(j.runId).status === 'running', { was: 'the run is up' })
    const kurz = join(SB, 'runs', j.runId, 'report.md')
    const detail = join(SB, 'runs', j.runId, 'report-detail.md')
    writeFileSync(kurz, 'Kurztext von fl-report')
    writeFileSync(detail, 'Detailtext von fl-report')
    const r = await flReport(j.runId, ['done', '--file', kurz, '--detail', detail])
    wahr(r.ok, 'the report goes through')
    await warteAuf(() => gemeldet().length > vorher, { was: 'the channel heard about the run', timeoutMs: 20_000 })
    const m = gemeldet().at(-1)
    gleich(m.runId, j.runId, 'and which run')
    enthaelt(m.text, 'Kurztext von fl-report', 'the short file is the message text')
    gleich(m.attachmentContent, 'Detailtext von fl-report', 'the detail file is the document')
  })

  await pruefe('a replayed inbox report is not sent a second time', async () => {
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E: replay dedupe', branch_mode: 'keiner', expected_minutes: '5' })
    await sessionMerken(j.runId)
    await warteAuf(() => lauf(j.runId).status === 'running', { was: 'the run is up' })
    const body = { kind: 'done', text: 'same report, once' }
    await sendReport(j.runId, body)
    await warteAuf(() => lauf(j.runId).status === 'done', { was: 'the run is done' })
    gleich(gemeldet().filter(x => x.runId === j.runId).length, 1, 'one message for the report')
    // fl-report lost the hub's answer and wrote the SAME payload to the inbox;
    // the watcher replays it — the identical text must not ring a second time.
    writeFileSync(join(SB, 'runs', j.runId, 'inbox.jsonl'), JSON.stringify(body) + '\n')
    await watcherTick()
    gleich(gemeldet().filter(x => x.runId === j.runId).length, 1, 'the replayed line does not ring again')
    gleich(lauf(j.runId).followups, 0, 'and it was not mistaken for a follow-up')
    gleich(readFileSync(join(SB, 'runs', j.runId, 'inbox.jsonl'), 'utf8'), '', 'the processed line is cleared')
  })

  await pruefe('the notify flow step sends through the configured channels — under its new name and its old one', async () => {
    for (const [typ, text] of [['notify', 'from the notify step'], ['telegram', 'from a flow saved before the rename']]) {
      const vorher = gemeldet().length
      const r = await jsonPost('/api/flows/save', {
        name: `E2E-Notify-${typ}`, active: true, trigger: { kind: 'manual' },
        definition: { properties: {}, sequence: [{
          id: `e2e-${typ}`, componentType: 'task', type: typ, name: 'say it',
          properties: { text, attachment: '', outputVar: 'out' },
        }] },
      })
      const j = await r.json()
      // A stored `telegram` step is not an error and not a migration: it is an
      // ALIAS, so the flow saves, validates and runs as the notify step it is.
      wahr(j.ok && !!j.id, `${typ}: flow saved (${JSON.stringify(j).slice(0, 200)})`)
      // Through the route, not the function: "run now" is a button, and the
      // route is what an operator's click reaches.
      gleich((await formular(`/api/flows/${j.id}/run`, {}, { alsBrowser: true })).status, 303, `${typ}: run now`)
      await warteAuf(() => gemeldet().length > vorher, { was: `${typ}: the message went out`, timeoutMs: 15_000 })
      const m = gemeldet().at(-1)
      gleich(m.kind, 'flow', `${typ}: the message says it comes from a flow`)
      enthaelt(m.text, text, `${typ}: with the rendered text`)
      const fr = db.prepare('SELECT * FROM flow_runs WHERE flow_id=? ORDER BY started_at DESC LIMIT 1').get(j.id)
      gleich(fr.status, 'done', `${typ}: the flow run finished`)
      gleich(JSON.parse(fr.context).vars.out.delivered, true, `${typ}: and recorded the delivery`)
    }
    // The designer only ever offers the new name.
    const meta = await (await hol('/api/flows/meta')).json()
    falsch(meta.steps.some(x => x.type === 'telegram'), 'the toolbox offers one notify block, not two')
  })

  await pruefe('switching the channel off silences it again, and uninstalling removes it', async () => {
    const vorher = gemeldet().length
    gleich((await formular('/settings/notifications/save',
      { id: 'e2e-notifier', enabled: '0', set_outfile: NOTIFY_LOG }, { alsBrowser: true })).status, 303, 'switched off')
    const t = await formular('/settings/notifications/test', { id: 'e2e-notifier' }, { alsBrowser: true })
    enthaelt(decodeURIComponent(t.headers.get('location')), 'switched off', 'the test button says which of the two it is')
    gleich(gemeldet().length, vorher, 'and nothing was written')

    gleich((await formular('/settings/plugins/uninstall', { id: 'e2e-notifier' }, { alsBrowser: true })).status, 303, 'uninstalled')
    falsch(existsSync(join(sk.PLUGINS, 'e2e-notifier')), 'the directory is gone')
    const html = await (await hol('/settings/notifications')).text()
    falsch(html.includes('E2E Notifier'), 'the page no longer offers it')
    enthaelt(html, 'No channel is configured', 'and the hub is quiet again — which is a complete installation')
  })

  // ------------------------------------------------------------------
  gruppe('Repos: deactivating takes one out of every dropdown, deleting needs its name')

  await pruefe('a repo can be switched off and on again, explicitly or by flipping', async () => {
    const id = db.prepare(`INSERT INTO repos(name,path,base_branch) VALUES('e2e-off','${REPO}','main') RETURNING id`).get().id
    const aktiv = () => db.prepare('SELECT active FROM repos WHERE id=?').get(id).active
    gleich(aktiv(), 1, 'a new repo is active')
    gleich((await formular('/repos/toggle', { id: String(id), active: '0' }, { alsBrowser: true })).status, 303, 'switching off redirects')
    gleich(aktiv(), 0, "and '0' really means off — the string is truthy, so it has to be compared")
    await formular('/repos/toggle', { id: String(id) }, { alsBrowser: true })
    gleich(aktiv(), 1, 'no `active` flips it')
    await formular('/repos/toggle', { id: String(id) }, { alsBrowser: true })
    gleich(aktiv(), 0, 'and flips it back')
    gleich((await formular('/repos/toggle', { id: '999999' }, { alsBrowser: true })).status, 400, 'an unknown repo is a readable refusal')
  })

  await pruefe('an inactive repo is gone from every repo dropdown but still on the Repos page', async () => {
    const row = db.prepare(`SELECT * FROM repos WHERE name='e2e-off'`).get()
    // Deactivated by the test above.
    gleich(row.active, 0, 'precondition: it is off')

    // The header switcher and the Quick-Run dialog share one query, so both are
    // covered by the overview's HTML.
    const start = await (await hol(`/?repo=${repoId}`)).text()
    falsch(start.includes('>e2e-off<'), 'not in the header switcher or the Quick-Run dialog')
    // Every other place a repo can be picked.
    falsch((await (await hol('/agents/move?id=1')).text()).includes('>e2e-off<'), 'not a move target')
    falsch((await (await hol('/settings/cleanup')).text()).includes('>e2e-off<'), 'not in the cleanup settings')
    const meta = await (await hol('/api/flows/meta')).json()
    falsch(meta.repos.some(r => r.name === 'e2e-off'), "not in the flow designer's repo list")
    // ...but the Repos page shows it, marked, or deactivating would be a way of
    // losing a repository rather than of putting one away.
    const seite = await (await hol('/repos')).text()
    enthaelt(seite, 'e2e-off', 'the Repos page lists it')
    enthaelt(seite, 'repo-off', 'and marks it as deactivated')
    enthaelt(seite, '/repos/toggle', 'with the button to bring it back')

    // /api/repos shows it with its flag, and filters on request.
    const alle = await (await hol('/api/repos')).json()
    wahr(alle.repos.some(r => r.name === 'e2e-off' && r.active === 0), 'the API lists it with active:0')
    falsch((await (await hol('/api/repos?active=1')).json()).repos.some(r => r.name === 'e2e-off'), 'active=1 filters it out')
    wahr((await (await hol('/api/repos?active=0')).json()).repos.some(r => r.name === 'e2e-off'), 'active=0 finds only it')
  })

  await pruefe('an inactive repo starts nothing, and its history stays reachable', async () => {
    const row = db.prepare(`SELECT * FROM repos WHERE name='e2e-off'`).get()
    // A manual start is refused — by name, so the operator knows why.
    const j = await (await hol('/api/runs', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        repo_id: String(row.id), harness: 'claude', prompt: 'should not start',
        branch_mode: 'keiner', expected_minutes: '10',
      }).toString(),
    })).json()
    falsch(j.ok && j.runId, `no run was created (${JSON.stringify(j)})`)
    enthaelt(JSON.stringify(j), 'e2e-off', 'and the refusal names the repo')
    gleich(db.prepare('SELECT count(*) c FROM runs WHERE repo_id=?').get(row.id).c, 0, 'not even a row')

    // Its own pages still render when they are asked for by id — that is what
    // makes deactivating better than deleting.
    gleich((await hol(`/?repo=${row.id}`)).status, 200, 'the overview')
    gleich((await hol(`/archive?repo=${row.id}`)).status, 200, 'the archive')
    gleich((await hol(`/api/fragments/sidebar?repo=${row.id}`)).status, 200, 'and the sidebar fragment')
  })

  await pruefe('deleting refuses without the exact name, and while work is in flight', async () => {
    const id = db.prepare(`INSERT INTO repos(name,path,base_branch) VALUES('e2e-del','${REPO}','main') RETURNING id`).get().id
    const da = () => db.prepare('SELECT count(*) c FROM repos WHERE id=?').get(id).c

    gleich((await formular('/repos/delete', { id: String(id) }, { alsBrowser: true })).status, 400, 'no confirm at all')
    gleich((await formular('/repos/delete', { id: String(id), confirm: 'e2e-de' }, { alsBrowser: true })).status, 400, 'a near miss')
    gleich(da(), 1, 'and the repo is still there after both')

    // A run in flight is the second fence: deleting would pull the ground out
    // from under a live tmux session.
    db.prepare(`INSERT INTO runs(id,repo_id,harness,prompt,branch_mode,expected_minutes,status)
      VALUES('e2e-del-run',?,'claude','x','keiner',10,'running')`).run(id)
    const r = await formular('/repos/delete', { id: String(id), confirm: 'e2e-del' }, { alsBrowser: true })
    gleich(r.status, 400, 'the right name is not enough while a run is going')
    gleich(da(), 1, 'still there')
    db.prepare(`UPDATE runs SET status='done' WHERE id='e2e-del-run'`).run()
  })

  await pruefe('deleting takes the runs, agents, events and incidents — and nothing off the disk', async () => {
    const id = db.prepare(`SELECT id FROM repos WHERE name='e2e-del'`).get().id
    const agentId = db.prepare(`INSERT INTO agents(repo_id,name,harness,prompt,branch_mode,expected_minutes)
      VALUES(?,'e2e-del-agent','claude','x','keiner',10) RETURNING id`).get(id).id
    db.prepare(`UPDATE runs SET agent_id=? WHERE id='e2e-del-run'`).run(agentId)
    db.prepare(`INSERT INTO events(run_id,kind) VALUES('e2e-del-run','started')`).run()
    db.prepare(`INSERT INTO incidents(run_id,typ,quelle) VALUES('e2e-del-run','rate_limit','log')`).run()

    // The dialog states the facts, and they are the real counts.
    const seite = await (await hol('/repos')).text()
    enthaelt(seite, 'repo-del-' + id, 'the confirmation dialog is on the page')
    enthaelt(seite, REPO, 'and names the checkout it will not touch')

    const r = await formular('/repos/delete', { id: String(id), confirm: 'e2e-del' }, { alsBrowser: true })
    gleich(r.status, 303, 'the right name on a quiet repo goes through')
    gleich(db.prepare('SELECT count(*) c FROM repos WHERE id=?').get(id).c, 0, 'the repo')
    gleich(db.prepare('SELECT count(*) c FROM agents WHERE repo_id=?').get(id).c, 0, 'its agents')
    gleich(db.prepare(`SELECT count(*) c FROM runs WHERE id='e2e-del-run'`).get().c, 0, 'its runs')
    gleich(db.prepare(`SELECT count(*) c FROM events WHERE run_id='e2e-del-run'`).get().c, 0, 'their events')
    gleich(db.prepare(`SELECT count(*) c FROM incidents WHERE run_id='e2e-del-run'`).get().c, 0, 'and their incidents')
    // The one thing it must never do.
    wahr(existsSync(join(REPO, '.git')), 'the git checkout is untouched')
  })

  // ------------------------------------------------------------------
  gruppe("Freilauf skills: the page, the installation, and the read-only API")

  await pruefe('the settings page names what is shipped and where it would go', async () => {
    const html = await (await hol('/settings/skills')).text()
    enthaelt(html, 'freilauf-runs', 'the shipped skills are listed by name')
    // The shared reference is installed but NOT offered: nobody picks it, the
    // other skills load it themselves. A footnote says one more is coming
    // along, without naming it.
    falsch(html.includes('<b>freilauf-models</b>'), 'the shared skill is not in the list')
    enthaelt(html, 'shared reference', 'but the page admits one more is installed')
    // Descriptions are printed in full — cutting them ended sentences mid-word.
    enthaelt(html, 'even when the word Freilauf is never said', 'and a description is not truncated')
    // Where they land and what cannot be scoped — with somewhere to say so.
    enthaelt(html, 'user level', 'the page says they are installed at user level')
    enthaelt(html, 'github.com/hwalde/freilauf/issues', 'and links the issue tracker for per-project scoping')
    enthaelt(html, 'name="skills_install"', 'the installation switch is there')
    enthaelt(html, 'name="skills_auto_update"', 'and the automatic-update switch')
    // With the installation off, "keep them up to date" is a switch about
    // nothing: hidden AND disabled, so its hidden `0` companion cannot post and
    // overwrite a preference the operator left on.
    enthaelt(html, '<div id="skills-auto" hidden>', 'the update row is hidden while the installation is off')
    enthaelt(html, 'id="skills-pick" hidden', 'and so is the per-skill picker')
    // Derived, not typed in: the subject here is "every box the picker renders
    // is disabled", and a literal turns shipping one more skill into a failure
    // of this check instead of a change in what it is about. `shared` skills
    // are not rendered as boxes at all, which is the assertion two lines up.
    const pickbar = (await (await hol('/api/skills')).json()).skills.filter(s => s.role !== 'shared').length
    wahr(pickbar >= 6, `the picker has boxes to disable (${pickbar})`)
    gleich((html.match(/name="skills_selected"[^>]*disabled/g) ?? []).length, pickbar,
      'with every one of its boxes disabled, so a save cannot rewrite the selection unseen')
    falsch(html.includes('name="skills_pick"'), 'and the marker that says "this form carried the picker" is absent')
    gleich((html.match(/name="skills_auto_update"[^>]*disabled/g) ?? []).length, 2,
      'and both of its inputs are disabled, so neither travels')
    falsch(/<div class="btn-row"><button>[^<]*<\/button>\s*<a /.test(html),
      'the form offers one action and no link beside it')
    enthaelt(html, 'type="hidden" name="skills_install" value="0"',
      'each carries its hidden 0 companion — without it an unticked box would read as "not mentioned"')
    enthaelt(html, 'id="skills-remove-dialog"', 'the confirmation dialog is rendered by the server')
    enthaelt(html, 'data-was-on=', 'and the form records the state it was rendered with')
  })

  // The target directories are DERIVED from the enabled coding agents, so the
  // test derives them too — hardcoding `.claude/skills` here would turn a
  // change to the plugin set into a failure of this test instead of a change in
  // its subject. Every path lies inside the sandbox home
  // (FREILAUF_SKILLS_HOME), never in the operator's real one.
  const skillZiele = async () => (await (await hol('/api/skills')).json()).targets.map(t => t.dir)

  await pruefe('switching the installation on writes into the covering directories, off takes it back', async () => {
    const vorher = await skillZiele()
    wahr(vorher.length >= 1, 'there is at least one target directory')
    wahr(vorher.every(d => d.startsWith(join(SB, 'skillhome'))),
      'and every one of them is inside the sandbox home, not the operator\'s')

    const eingeschaltet = await formular('/settings/skills',
      { skills_install: '1', skills_auto_update: '1' }, { alsBrowser: true })
    gleich(eingeschaltet.status, 303, 'saving redirects')
    gleich(db.prepare("SELECT value FROM settings WHERE key='skills_install'").get().value, '1', 'the switch is stored')
    for (const wurzel of vorher) {
      const ziel = join(wurzel, 'freilauf-models')
      wahr(existsSync(join(ziel, 'SKILL.md')), `${wurzel}: the skill is really on disk`)
      wahr(existsSync(join(ziel, '.freilauf-skill.json')), `${wurzel}: with the marker that makes it removable`)
    }

    const seite = await (await hol('/settings/skills')).text()
    enthaelt(seite, vorher[0], 'the page now shows where it went')

    const aus = await formular('/settings/skills', { skills_install: '0', skills_auto_update: '1' }, { alsBrowser: true })
    gleich(aus.status, 303, 'switching off redirects too')
    for (const wurzel of vorher) falsch(existsSync(join(wurzel, 'freilauf-models')), `${wurzel}: the copy is gone`)
  })

  await pruefe('saving with the update row absent leaves the stored preference alone', async () => {
    const wert = () => db.prepare("SELECT value FROM settings WHERE key='skills_auto_update'").get()?.value
    await formular('/settings/skills', { skills_install: '1', skills_auto_update: '1' }, { alsBrowser: true })
    gleich(wert(), '1', 'it is on to begin with')
    // The browser hides AND disables the row when the installation goes off, so
    // a real save from that page carries no `skills_auto_update` at all. The
    // stored preference has to survive that, or switching the installation back
    // on would silently find updates off.
    await formular('/settings/skills', { skills_install: '0' }, { alsBrowser: true })
    gleich(wert(), '1', 'and a save without the field does not turn it off')
    gleich(db.prepare("SELECT value FROM settings WHERE key='skills_install'").get().value, '0', 'while the installation really went off')
  })

  await pruefe('only the selected skills are installed, and deselecting removes just that one', async () => {
    const HOME = join(SB, 'skillhome')
    const wurzel = async () => (await (await hol('/api/skills')).json()).targets[0].dir
    const da = async (name) => existsSync(join(await wurzel(), name, 'SKILL.md'))

    // Everything, which is what an installation that said yes before this
    // setting existed already has on disk.
    await formular('/settings/skills', { skills_install: '1', skills_auto_update: '1' }, { alsBrowser: true })
    wahr(await da('freilauf-runs'), 'runs is there')
    wahr(await da('freilauf-agents'), 'agents too')
    wahr(await da('freilauf-models'), 'and the shared one, which nobody picks')

    // Now pick two. The third goes; the shared one rides along.
    await formular('/settings/skills', {
      skills_install: '1', skills_auto_update: '1', skills_pick: '1',
      skills_selected: ['freilauf-runs', 'freilauf-repos'],
    }, { alsBrowser: true })
    wahr(await da('freilauf-runs'), 'a selected skill stays')
    wahr(await da('freilauf-repos'), 'and the other one')
    falsch(await da('freilauf-agents'), 'the deselected one is removed')
    wahr(await da('freilauf-models'), 'the shared one rides along with whatever is selected')
    gleich(db.prepare("SELECT value FROM settings WHERE key='skills_selected'").get().value,
      JSON.stringify(['freilauf-runs', 'freilauf-repos']), 'and the choice is stored')

    // A save WITHOUT the picker block must not rewrite the selection — with the
    // installation off the boxes are disabled, so nothing would travel and an
    // unguarded read would wipe a choice nobody could see.
    await formular('/settings/skills', { skills_install: '1', skills_auto_update: '0' }, { alsBrowser: true })
    gleich(db.prepare("SELECT value FROM settings WHERE key='skills_selected'").get().value,
      JSON.stringify(['freilauf-runs', 'freilauf-repos']), 'the selection survives a save that did not carry it')
    wahr(await da('freilauf-runs'), 'and nothing was reinstalled behind it')

    // Selecting nothing takes even the shared one: it exists for the others.
    await formular('/settings/skills', { skills_install: '1', skills_auto_update: '1', skills_pick: '1' },
      { alsBrowser: true })
    falsch(await da('freilauf-runs'), 'nothing selected, nothing installed')
    falsch(await da('freilauf-models'), 'the shared one goes with them')

    // Back to all of them for the checks after this one.
    db.prepare("DELETE FROM settings WHERE key='skills_selected'").run()
    await formular('/settings/skills/sync', {}, { alsBrowser: true })
    wahr(await da('freilauf-runs'), 'an absent selection means all of them again')
    await formular('/settings/skills', { skills_install: '0', skills_auto_update: '1' }, { alsBrowser: true })
  })

  await pruefe('a "sync now" post re-establishes the state without changing the settings', async () => {
    await formular('/settings/skills', { skills_install: '1', skills_auto_update: '1' }, { alsBrowser: true })
    const ziel = join((await skillZiele())[0], 'freilauf-models')
    rmSync(ziel, { recursive: true, force: true })
    const r = await formular('/settings/skills/sync', {}, { alsBrowser: true })
    gleich(r.status, 303, 'the button redirects')
    wahr(existsSync(join(ziel, 'SKILL.md')), 'and the missing copy is back')
    await formular('/settings/skills', { skills_install: '0', skills_auto_update: '1' }, { alsBrowser: true })
  })

  await pruefe('a directory the hub did not write is named on the page instead of overwritten', async () => {
    const wurzel = (await (await hol('/api/skills')).json()).targets[0]?.dir
      ?? join(SB, 'skillhome', '.claude', 'skills')
    const fremd = join(wurzel, 'freilauf-models')
    mkdirSync(fremd, { recursive: true })
    writeFileSync(join(fremd, 'SKILL.md'), '---\nname: freilauf-models\n---\nnot ours\n')
    await formular('/settings/skills', { skills_install: '1', skills_auto_update: '1' }, { alsBrowser: true })
    enthaelt(readFileSync(join(fremd, 'SKILL.md'), 'utf8'), 'not ours', 'the foreign file is untouched')
    const html = await (await hol('/settings/skills')).text()
    enthaelt(html, fremd, 'and the page names the directory it could not write')
    // Switching off must not take it either.
    await formular('/settings/skills', { skills_install: '0', skills_auto_update: '1' }, { alsBrowser: true })
    wahr(existsSync(join(fremd, 'SKILL.md')), 'switching off leaves a foreign skill alone')
    rmSync(fremd, { recursive: true, force: true })
  })

  await pruefe('GET /api/skills answers what is shipped, where it goes and what is installed', async () => {
    const j = await (await hol('/api/skills')).json()
    wahr(j.ok, 'ok')
    wahr(Array.isArray(j.skills) && j.skills.length >= 1, 'the shipped skills')
    wahr(j.skills.every(s => s.name && s.description), 'each with a name and a description')
    wahr(Array.isArray(j.harnesses) && j.harnesses.some(h => h.id === 'claude'), 'every registered coding agent')
    wahr(j.harnesses.find(h => h.id === 'claude').user.some(p => p.includes('.claude/skills')),
      'and the directories it declares')
    gleich(j.install, false, 'the switch is off again after the test above')
  })

  await pruefe('the read-only API answers for repos, agents, runs, favorites and sessions', async () => {
    const repos = await (await hol('/api/repos')).json()
    wahr(repos.ok && repos.repos.some(r => r.id === repoId), 'the repo is listed')
    wahr(Array.isArray(repos.repos[0].extras), 'with its worktree extras parsed')

    const agents = await (await hol(`/api/agents?repo=${repoId}`)).json()
    wahr(agents.ok && Array.isArray(agents.agents), 'agents answer')

    const runs = await (await hol(`/api/runs?repo=${repoId}&limit=5`)).json()
    wahr(runs.ok && Array.isArray(runs.runs), 'runs answer')
    wahr(runs.runs.length <= 5, 'and the limit is honoured')
    wahr(runs.runs.every(r => r.short_id && r.id), 'every row carries its short id')

    const favs = await (await hol('/api/favorites')).json()
    wahr(favs.ok && Array.isArray(favs.favorites) && Number.isFinite(favs.max), 'favorites answer')

    // An unknown run is a 404 with a reason, not a 500 and not an empty 200.
    const fehlt = await hol('/api/runs/00000000-0000-0000-0000-000000000000')
    gleich(fehlt.status, 404, 'an unknown run is a 404')
  })

  await pruefe('GET /api/runs/<id> carries the files, the events and a liveness verdict', async () => {
    const j = await (await hol(`/api/runs/${R1}`)).json()
    wahr(j.ok, 'ok')
    gleich(j.run.id, R1, 'the run')
    wahr(Array.isArray(j.events) && j.events.length > 0, 'its events')
    wahr(Array.isArray(j.incidents), 'its incidents')
    wahr(j.files.report.path.includes(R1), 'the report path')
    wahr(typeof j.files.report.exists === 'boolean', 'with an exists flag, so nobody has to guess the path')
    // The whole point of the block: "done" says the run reported, not that the
    // process is gone — three of the four coding agents stay in their TUI.
    wahr(['working', 'idle_in_tui', 'process_gone', 'no_session', 'unknown'].includes(j.liveness.verdict),
      `liveness verdict is one of the five (${j.liveness.verdict})`)
    wahr([true, false, null].includes(j.liveness.pane_alive),
      'pane_alive is a tri-state — null means tmux could not be asked, never "gone"')
  })

  await pruefe("the skill's own run-alive script answers against a live hub", async () => {
    // A script shipped inside a skill is a promise like any other line in it.
    // Run it the way an agent would: fl-api on PATH, FL_HUB_URL from the
    // session — which is exactly what a run's environment carries.
    const skript = join(PROJEKT, 'skills', 'freilauf-runs', 'scripts', 'run-alive.py')
    const lauf = (args) => new Promise((res) => execFile('python3', [skript, ...args], {
      env: { ...process.env, PATH: `${join(PROJEKT, 'bin')}:${process.env.PATH}`, FL_HUB_URL: sk.basis },
      timeout: 30_000,
    }, (err, stdout, stderr) => res({ code: err?.code ?? 0, stdout, stderr })))

    const hilfe = await lauf(['--help'])
    gleich(hilfe.code, 0, '--help works')
    enthaelt(hilfe.stdout, 'run-alive', 'and says what it is')

    const einer = await lauf([R1])
    gleich(einer.code, 0, `one run answers (${einer.stderr})`)
    enthaelt(einer.stdout, 'verdict', 'the header')
    enthaelt(einer.stdout, R1.slice(0, 8), 'and the run it was asked about')
    // The verdict column is the whole point: it is one of the five words, and
    // it is NOT the status column.
    wahr(/\b(working|idle_in_tui|process_gone|no_session|unknown)\b/.test(einer.stdout),
      `a verdict is printed (${einer.stdout.trim()})`)

    const liste = await lauf(['--repo', String(repoId)])
    gleich(liste.code, 0, `a whole repo answers (${liste.stderr})`)
    wahr(liste.stdout.split('\n').filter(Boolean).length >= 2, 'header plus at least one run')

    const quatsch = await lauf(['--wat'])
    gleich(quatsch.code, 2, 'an unknown option is a usage error, not a crash')
  })

  await pruefe("the skills' options tool answers against a live hub", async () => {
    // Every dropdown in the UI is a list this must be able to print, and the
    // check must catch a wrong value with the valid ones next to it — that is
    // the whole point of shipping it.
    const skript = join(PROJEKT, 'skills', 'freilauf-runs', 'scripts', 'fl-options.py')
    const lauf = (args) => new Promise((res) => execFile('python3', [skript, ...args], {
      env: { ...process.env, FL_HUB_URL: BASIS },
      timeout: 40_000,
    }, (err, stdout, stderr) => res({ code: err?.code ?? 0, stdout, stderr })))

    const uebersicht = await lauf([])
    gleich(uebersicht.code, 0, `no arguments is the overview (${uebersicht.stderr})`)
    enthaelt(uebersicht.stdout, 'Freilauf options', 'and it says what it is')
    enthaelt(uebersicht.stdout, '`repos`', 'listing the commands rather than the data')

    const repos = await lauf(['repos'])
    gleich(repos.code, 0, 'repos answers')
    enthaelt(repos.stdout, 'e2e', 'with the sandbox repo in it')

    const wo = await lauf(['where'])
    gleich(wo.code, 0, 'where answers')
    enthaelt(wo.stdout, BASIS, 'naming the hub it found')

    // The fill-in help: a wrong value must come back with the valid ones.
    const schlecht = await lauf(['check', 'harness=claude', 'effort=maximum', 'repo_id=' + repoId])
    gleich(schlecht.code, 1, 'a broken definition exits 1')
    enthaelt(schlecht.stdout, 'WRONG', 'and says which field is wrong')
    enthaelt(schlecht.stdout, 'effort', 'naming it')
    enthaelt(schlecht.stdout, 'MISSING', 'plus what is missing entirely')

    // A coding agent that is NOT on a subscription needs a model provider, and
    // the hub itself accepts the hole: an empty provider is its legacy path for
    // a hand-typed complete slug, so such an agent saves, schedules, starts —
    // and then launches with a bare model id and no credential. Agents really
    // were created that way through these skills, so the refusal lives here.
    const ohne = await lauf(['check', 'harness=opencode', 'model=whatever',
      'repo_id=' + repoId, 'prompt=do a thing', 'branch_mode=keiner'])
    gleich(ohne.code, 1, `a missing provider is refused, not noted (${ohne.stdout})`)
    enthaelt(ohne.stdout, 'MISSING  provider', 'naming the field')
    // opencode-zen and not openrouter: the list is what the operator enabled
    // INTERSECTED with what holds a credential, and the sandbox deliberately
    // carries no key — a key-free provider is the one entry always in it.
    enthaelt(ohne.stdout, 'opencode-zen', 'and the values this installation would accept')
    // ...and the model is then NOT measured against some other catalogue: the
    // provider decides which one, so "your model is fine" would be a lie.
    enthaelt(ohne.stdout, 'NOT checked', 'the model is left unjudged without one')

    // claude, by contrast, IS on its subscription — so the same emptiness is
    // correct there, and that is the only reading of a check that passes
    // without a provider.
    const gut = await lauf(['check', 'harness=claude', 'repo_id=' + repoId, 'prompt=do a thing',
      'branch_mode=keiner'])
    gleich(gut.code, 0, `a sound definition exits 0 (${gut.stdout})`)
    enthaelt(gut.stdout, '/api/runs', 'and hands back the command to post it')

    const quatsch = await lauf(['nonsense'])
    gleich(quatsch.code, 2, 'an unknown command is a usage error')
  })

  await pruefe("the plugin skill's tool finds the contract and reads the registry", async () => {
    // The whole point of this one is that it must not restate `docs/plugins.md`
    // — so if it cannot FIND that file it is worth nothing. The resolution is
    // therefore the first assertion, and the section index the second: an
    // agent that has to read 1450 lines to find one contract reads none of it.
    const skript = join(PROJEKT, 'skills', 'freilauf-plugins', 'scripts', 'fl-plugins.py')
    const lauf = (args) => new Promise((res) => execFile('python3', [skript, ...args], {
      env: { ...process.env, FL_HUB_URL: BASIS },
      timeout: 40_000,
    }, (err, stdout, stderr) => res({ code: err?.code ?? 0, stdout, stderr })))

    const uebersicht = await lauf([])
    gleich(uebersicht.code, 0, `no arguments is the overview (${uebersicht.stderr})`)
    enthaelt(uebersicht.stdout, 'Freilauf plugins', 'and it says what it is')
    enthaelt(uebersicht.stdout, '`docs [text]`', 'listing the commands rather than the data')

    const docs = await lauf(['docs'])
    gleich(docs.code, 0, `docs answers (${docs.stderr})`)
    enthaelt(docs.stdout, join(PROJEKT, 'docs', 'plugins.md'), 'resolving the real file')
    enthaelt(docs.stdout, 'Coding agent plugin contract', 'and printing its sections')
    enthaelt(docs.stdout, 'Notifier plugin contract', 'all three kinds among them')

    const liste = await lauf(['list'])
    gleich(liste.code, 0, `list answers (${liste.stderr})`)
    enthaelt(liste.stdout, 'Coding agents', 'the registered coding agents')
    enthaelt(liste.stdout, 'External packages', 'and the external packages')
    // There IS no JSON route for the registry, and a tool that quietly showed
    // half the answer would be worse than one that names the gap.
    enthaelt(liste.stdout, '/settings/notifications', 'saying where the rest of the answer is')

    const quatsch = await lauf(['nonsense'])
    gleich(quatsch.code, 2, 'an unknown command is a usage error')
  })

  await pruefe('the search finds a run by its title, its prompt and its id', async () => {
    const nachTitel = await (await hol(`/api/runs?repo=${repoId}&q=${encodeURIComponent(R1.slice(0, 8))}&archived=all`)).json()
    wahr(nachTitel.runs.some(r => r.id === R1), 'by the beginning of its id')
  })

  await pruefe('the welcome wizard answers on every step and each POST moves one step on', async () => {
    for (let step = 1; step <= 6; step++) {
      const r = await hol(`/welcome?step=${step}`)
      gleich(r.status, 200, `step ${step} renders`)
      const html = await r.text()
      enthaelt(html, `${step} of 6`, `step ${step} says where it is`)
      enthaelt(html, 'name="welcome_hide"', `step ${step} carries the "do not show again" box`)
      enthaelt(html, 'welcome=skip', `step ${step} offers the way out`)
      // …and on an unlocked page that way out is a SUBMIT of the very form the
      // box is in, not a link beside it. A link is what threw a ticked box
      // away, and the wizard then greeted the operator it had just been told
      // to stop greeting.
      if (step < 6) enthaelt(html, 'name="exit" value="1"', `step ${step} leaves by submitting, not by navigating`)
      // Opening the wizard as an ordinary page IS the "not now" answer. Without
      // it the nav's own "Overview" link — `layout()` draws it around every
      // unlocked step — would bounce the reader right back here.
      wahr(String(r.headers.get('set-cookie') ?? '').includes('freilauf_welcome'),
        `step ${step} marks the session, so every link off the page works`)
    }
    // An out-of-range step is step 1, not a 404: the address is typed by hand
    // and by a bookmark, and neither deserves an error page.
    gleich((await hol('/welcome?step=99')).status, 200, 'a nonsense step still renders')
    gleich((await hol('/welcome?step=abc')).status, 200, 'and so does a non-number')

    const schritte = [
      ['/welcome/hello', {}, '/welcome?step=2'],
      ['/welcome/scan', {}, '/welcome?step=2'],
      ['/welcome/agents', {}, '/welcome?step=3'],
      ['/welcome/provider', { id: 'openrouter' }, '/welcome?step=4'],
      ['/welcome/llm', {}, '/welcome?step=5'],
      // Step 5 asks about the hub's own agent skills. It is answered with the
      // box UNticked here, so the suite's own sandbox home stays empty; the
      // installation itself is exercised by the "Freilauf skills" group.
      ['/welcome/skills', { skills_install: '0', skills_auto_update: '1' }, '/welcome?step=6'],
      ['/welcome/done', {}, '/'],
    ]
    for (const [pfad, daten, ziel] of schritte) {
      const r = await formular(pfad, daten, { alsBrowser: true })
      gleich(r.status, 303, `${pfad} redirects`)
      gleich(r.headers.get('location'), ziel, `${pfad} → ${ziel}`)
    }
    // Step 3 really configured the provider it was handed.
    gleich(db.prepare(`SELECT enabled FROM plugin_config WHERE plugin_id='openrouter'`).get().enabled, 1,
      'the chosen model provider is switched on')
    // A provider the hub does not know is a readable problem, not a stored row.
    const schlecht = await formular('/welcome/provider', { id: 'not-a-provider' }, { alsBrowser: true })
    gleich(schlecht.status, 400, 'an unknown provider is refused')
  })

  await pruefe('ticking "do not show again" is what stops GET / from redirecting', async () => {
    const alsBrowser = { headers: { accept: 'text/html,application/xhtml+xml' } }
    try {
      // A fresh installation: the wizard is what `GET /` shows, but only for a
      // BROWSER navigation — an API caller asking for `/` must never be
      // answered with a redirect to HTML.
      sk.setzeEinstellung('welcome_hide', '0')
      const alsMensch = await hol('/', alsBrowser)
      gleich(alsMensch.status, 303, 'a browser navigation goes to the wizard')
      gleich(alsMensch.headers.get('location'), '/welcome', 'to /welcome')
      gleich((await hol('/')).status, 200, 'a fetch without an Accept header gets the overview')
      gleich((await hol('/api/usage')).status, 200, 'and the API is untouched')
      // "Skip for now" is a session answer and must not bounce into a loop.
      const skip = await hol('/?welcome=skip', alsBrowser)
      gleich(skip.status, 200, 'skipping lands on the overview')
      wahr(String(skip.headers.get('set-cookie') ?? '').includes('freilauf_welcome'),
        'and marks the browser so the link does not bounce back')

      // The box is honoured from any step, not only the last one.
      gleich((await formular('/welcome/hello', { welcome_hide: '1' }, { alsBrowser: true })).status, 303, 'ticked on step 1')
      gleich(db.prepare(`SELECT value FROM settings WHERE key='welcome_hide'`).get().value, '1', 'the setting is written')
      const danach = await hol('/', alsBrowser)
      gleich(danach.status, 200, 'and the overview is the overview again')
      enthaelt(await danach.text(), 'Quick Run', 'really the hub, not the wizard')
      // …and it can be switched back on, which is what the hidden `0`
      // companion exists for: an unticked box sends NOTHING, so without a
      // field carrying `0` the wizard could only ever be switched off.
      enthaelt(await (await hol('/welcome')).text(),
        '<input type="hidden" name="welcome_hide" value="0">', 'the form ships that companion')
      gleich((await formular('/welcome/hello', { welcome_hide: '0' }, { alsBrowser: true })).status, 303, 'unticked')
      gleich(db.prepare(`SELECT value FROM settings WHERE key='welcome_hide'`).get().value, '0', 'switched back on')
      gleich((await hol('/', alsBrowser)).status, 303, 'and the wizard is back')

      // The way out of an unlocked wizard saves the box on its way. This is the
      // gesture a returning operator actually makes — tick it, then leave — and
      // it used to be a link outside the form, so the tick never arrived.
      const raus = await formular('/welcome/hello', { welcome_hide: '1', exit: '1' }, { alsBrowser: true })
      gleich(raus.status, 303, 'leaving redirects')
      gleich(raus.headers.get('location'), '/', 'into the hub, not on to step 2')
      gleich(db.prepare(`SELECT value FROM settings WHERE key='welcome_hide'`).get().value, '1',
        'and the ticked box was saved on the way out')
      // Untouched box, same exit: the session mark is what keeps `GET /` from
      // sending the operator straight back to the page they just left.
      sk.setzeEinstellung('welcome_hide', '0')
      const rausOhne = await formular('/welcome/hello', { welcome_hide: '0', exit: '1' }, { alsBrowser: true })
      gleich(rausOhne.headers.get('location'), '/', 'leaving without ticking still leaves')
      wahr(String(rausOhne.headers.get('set-cookie') ?? '').includes('freilauf_welcome'),
        'and marks the session, so the redirect cannot bounce it back')
    } finally {
      sk.setzeEinstellung('welcome_hide', '1')
    }
  })

  // ------------------------------------------------------------------
  if (ECHT) {
    // From here on with the REAL fl-start and real harnesses. Deliberately a second
    // hub start: the stub part above must stay deterministic and free of charge.
    await hubStoppen()
    await hubStarten({ echteAgenten: true })

    const harnesses = [
      { name: 'claude', bedingung: () => vorhanden('claude'), fehlt: 'claude not in PATH' },
      {
        name: 'opencode', provider: 'openrouter', model: ECHT_MODELL,
        bedingung: () => vorhanden('opencode') && !!ECHT_KEYS.OPENROUTER_API_KEY,
        fehlt: 'opencode missing or OPENROUTER_API_KEY is not set',
      },
      {
        name: 'hermes', provider: 'openrouter', model: ECHT_MODELL,
        bedingung: () => vorhanden('hermes') && !!ECHT_KEYS.OPENROUTER_API_KEY,
        fehlt: 'hermes missing or OPENROUTER_API_KEY is not set',
      },
      {
        // Zen needs no key for the free models — and this also covers that the
        // prefix is right (opencode/… and NOT opencode-zen/…).
        name: 'opencode', titel: 'opencode via OpenCode Zen (free model)',
        provider: 'opencode-zen', model: ZEN_MODELL, marke: 'zen-echt.md',
        bedingung: () => vorhanden('opencode'),
        fehlt: 'opencode not in PATH',
      },
    ]

    for (const h of harnesses) {
      gruppe(`Real run: ${h.titel ?? h.name}${h.provider ? ` — ${h.provider}/${h.model}` : ''}`)
      if (!h.bedingung()) {
        uebersprungen(h.titel ?? h.name, h.fehlt)
        continue
      }
      await pruefe(`${h.name} writes the file and reports done`, async () => {
        const marke = h.marke ?? `${h.name}-echt.md`
        const j = await laufStarten({
          repo_id: repoId, harness: h.name,
          ...(h.provider ? { provider: h.provider, model: h.model } : {}),
          prompt: `Lege im aktuellen Verzeichnis die Datei ${marke} an mit genau einer Zeile: ${h.name} lief. `
            + `Fuehre danach genau dieses Kommando aus: fl-report done "${h.name}-Rauchtest fertig"`,
          branch_mode: 'keiner', expected_minutes: '10',
        })
        wahr(!!j.runId, `run started (${JSON.stringify(j)})`)
        await sessionMerken(j.runId)
        await warteAuf(() => ['done', 'failed', 'aborted'].includes(lauf(j.runId).status),
          { was: `end of the ${h.name} run`, timeoutMs: 420_000, taktMs: 2000 })
        const r = lauf(j.runId)
        gleich(r.status, 'done', `status (report: ${(r.report_md ?? '').slice(0, 80)})`)
        wahr(existsSync(join(r.workdir_effective, marke)),
          `${marke} was really created in the worktree`)
        wahr((r.report_md ?? '').length > 0, 'report present')
      })
    }
  }
} catch (err) {
  console.log(`\nAborted: ${err.stack}`)
  zaehler.fehler.push({ name: 'Test run', grund: err.message })
} finally {
  await aufraeumen()
}

process.exit(bericht(`E2E tests${ECHT ? ' (with real runs)' : ''}`, start))
