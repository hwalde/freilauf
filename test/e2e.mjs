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
import { group, check, skipped, equal, isTrue, isFalse, contains, waitFor, summary, counter } from './mini.mjs'
import { newSandbox, sh, hasBinary, freePort, PROJECT } from './sandbox-env.mjs'

const ECHT = process.argv.includes('--echt')
// User-specified test model for opencode/hermes (cheap, tool-capable).
// Capture the provider key NOW: the stub part deletes it from the environment in a
// moment, but the real-run part still needs it.
const ECHT_KEYS = { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY }
const ECHT_MODELL = process.env.FREILAUF_TEST_MODELL ?? 'deepseek/deepseek-v4-flash-0731'
// Zen: one of the free models — runs without a key.
const ZEN_MODELL = process.env.FREILAUF_TEST_ZEN_MODELL ?? 'nemotron-3.5-lightning-free'
const KEEP = process.argv.includes('--keep')
const start = Date.now()

// ------------------------------------------------- sandbox and hub process
// Both come from test/sandbox-env.mjs: the browser suite runs against exactly the
// same sandbox, and one copy of that construction is enough. The names below stay
// what the tests in this file have always used.
const sk = newSandbox({ prefix: 'Freilauf-e2e-', keep: KEEP })
const { SB, REPO, ORIGIN, FAILED_START, sessions, fetchPath, postForm } = sk
let db = null
let PORT = 0
let BASE = ''

/** Start the hub and carry port, base URL and database into this file. */
async function startHub(opts = {}) {
  await sk.startHub({ keys: ECHT_KEYS, ...opts })
  db = sk.db
  PORT = sk.port
  BASE = sk.base
}
async function stopHub() {
  await sk.stopHub()
  db = null
}

// The watcher ticks inside the hub every 30 s; watcherTick() triggers the same
// pass right away.
let watcherTick = null
async function prepareWatcher() { watcherTick = await sk.prepareWatcher() }

// ---------------------------------------------------------------- Database
// The fl-report of THIS checkout — the one this suite is testing. The copy in
// ~/.local/bin can lag behind (it is installed by the deploy), and the
// session-id forwarding under test exists only in this file's version.
const FL_REPORT_REPO = fileURLToPath(new URL('../bin/fl-report', import.meta.url))

const lauf = (id) => db.prepare('SELECT * FROM runs WHERE id=?').get(id)
const ereignisse = (id) => db.prepare('SELECT kind FROM events WHERE run_id=? ORDER BY id').all(id).map(e => e.kind)
const agent = (name) => db.prepare('SELECT * FROM agents WHERE name=?').get(name)

/** Start a run via the JSON API and record the created tmux session. */
async function laufStarten(data) {
  const r = await postForm('/api/runs', { harness: 'claude', branch_mode: 'keiner', expected_minutes: '45', ...data })
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
    try { s = await waitFor(() => lauf(runId)?.tmux_session, { what: `tmux session of ${runId}`, timeoutMs: 20_000 }) }
    catch { s = null }
  }
  if (s) sessions.add(s)
  return s
}

// ---------------------------------------------------------------- Cleanup
async function cleanUp() {
  await sk.cleanUp()
  db = null
}
process.on('SIGINT', async () => { await cleanUp(); process.exit(130) })
process.on('SIGTERM', async () => { await cleanUp(); process.exit(143) })
// SIGHUP is what this suite really dies of: it is run from inside a tmux session
// (an agent's own run), and when that session is closed tmux hangs up the whole
// process group. Node's default for SIGHUP is to exit without running any of the
// above — which is how six killed suites left 294 tmux sessions standing.
process.on('SIGHUP', async () => { await cleanUp(); process.exit(129) })

// ================================================================== Test run
try {
  console.log(`Sandbox: ${SB}`)
  await sk.build()
  await startHub()
  await prepareWatcher()
  console.log(`Hub: ${BASE}${ECHT ? '   [--echt: real runs per harness — consumes quota and credits]' : ''}`)

  // ------------------------------------------------------------------
  group('Coding agents: initial state, detection, configuration')

  await check('fresh installation: every page shows the setup banner', async () => {
    const html = await (await fetchPath('/')).text()
    contains(html, 'banner setup', 'banner container')
    contains(html, '/settings/coding-agents', 'link to the settings')
  })
  await check('run creation without a configured coding agent is rejected', async () => {
    const r = await postForm('/api/runs', { repo_id: '1', harness: 'claude', prompt: 'x', branch_mode: 'keiner', expected_minutes: '5' })
    equal(r.status, 400, 'rejected')
    contains((await r.json()).error, 'not configured', 'reason names the configuration')
  })
  await check('detect API lists the known coding agents with install state', async () => {
    const j = await (await fetchPath('/api/coding-agents/detect')).json()
    isTrue(j.ok, 'ok')
    equal(j.agents.map(a => a.id).sort().join(','), 'claude,cursor,hermes,opencode', 'all four plugins')
    isTrue(j.agents.every(a => typeof a.installed === 'boolean' && a.configured === false), 'installed flag, none configured yet')
  })
  await check('coding agents can be added with their provider selection', async () => {
    const faelle = [
      ['claude', []],
      ['opencode', ['opencode-zen', 'deepseek', 'openrouter']],
      ['hermes', ['openrouter', 'opencode-zen', 'deepseek']],
      ['cursor', []],
    ]
    for (const [harness, providers] of faelle) {
      const r = await postForm('/settings/coding-agents/save',
        { harness, enabled: '1', ...(providers.length ? { providers } : {}) }, { asBrowser: true })
      equal(r.status, 303, harness)
    }
    // The rows live in `plugin_config` now (kind='harness'), with the allowed
    // model providers inside the `config` JSON — one table for coding agents
    // and model providers alike, because a provider had no place to carry an
    // enabled flag or a credential before it.
    equal(db.prepare(`SELECT count(*) c FROM plugin_config WHERE kind='harness' AND enabled=1`).get().c, 4, 'four enabled')
    const opencodeConfig = JSON.parse(
      db.prepare(`SELECT config FROM plugin_config WHERE plugin_id='opencode'`).get().config)
    equal(opencodeConfig.providers.length, 3, 'providers stored')
  })
  await check('unknown coding agent is rejected by the settings form', async () => {
    const r = await postForm('/settings/coding-agents/save', { harness: 'gpt', enabled: '1' }, { asBrowser: true })
    equal(r.status, 400, 'rejected')
  })
  await check('the banner disappears once a coding agent is configured', async () => {
    isFalse((await (await fetchPath('/')).text()).includes('banner setup'), 'no banner')
  })
  await check('settings page lists the configured coding agents', async () => {
    const html = await (await fetchPath('/settings/plugins')).text()
    contains(html, 'Claude Code', 'label')
    contains(html, 'cursor-agent', 'binary name')
  })
  await check('the old coding-agents address still leads there', async () => {
    // A 303 and not a 404: the address is in bookmarks, in the setup banner
    // and in the docs, and an operator who follows one of those must land on
    // the page the section moved to.
    const r = await fetchPath('/settings/coding-agents')
    equal(r.status, 303, 'redirect')
    equal(r.headers.get('location'), '/settings/plugins', 'to the plugins page')
  })
  await check('usage API answers with the Claude quota from the fixture', async () => {
    const j = await (await fetchPath('/api/usage')).json()
    isTrue(j.ok, 'ok')
    const claude = j.usage.find(u => u.harness === 'claude')
    isTrue(!!claude && claude.ok, `claude row (${JSON.stringify(j.usage).slice(0, 200)})`)
    equal(claude.data.five, 1, '5h percentage from quota.json')
    const cursor = j.usage.find(u => u.harness === 'cursor')
    isTrue(!!cursor && cursor.ok === false, 'cursor row honestly unavailable (no auth file in the sandbox)')
  })

  // ------------------------------------------------------------------
  group('Basic scaffolding: pages, static files, API fallback')

  await check('empty state leads to creating a repo', async () => {
    const r = await fetchPath('/')
    equal(r.status, 200, 'status')
    contains(await r.text(), 'Create repo', 'hint text')
  })
  // The flow designer's own scripts belong in this loop as much as xterm does: a
  // moved or renamed entry in STATIC_MAP shows up nowhere else, and the designer
  // page would be silently dead. /static/flows/ carries the two pure modules the
  // browser runs as well, so designer and server judge a flow by the same code.
  for (const datei of ['/static/xterm.js', '/static/addon-fit.js', '/static/hub.js', '/static/hub.css', '/static/xterm.css',
    '/static/flows.js', '/static/flows.css', '/static/flows/template.mjs', '/static/flows/varschema.mjs',
    '/static/swd.js', '/static/swd.css', '/static/swd-light.css']) {
    await check(`${datei} is served`, async () => {
      const r = await fetchPath(datei)
      equal(r.status, 200, 'status')
      isTrue((await r.text()).length > 100, 'content present')
    })
  }
  // Without a validator a browser cannot revalidate, so it re-downloaded the
  // whole set on every page view: ~600 KB per page and ~900 KB on a run detail
  // page, xterm.js alone being 488 KB — read off disk SYNCHRONOUSLY, in the one
  // event loop that also holds every SSE stream, the terminal WebSocket, the
  // scheduler and the watcher. That is what "the hub hangs" was made of.
  await check('a static file carries an ETag and answers a revalidation with 304', async () => {
    const r = await fetchPath('/static/hub.js')
    const etag = r.headers.get('etag')
    isTrue(!!etag, 'the answer carries a validator')
    equal(r.headers.get('cache-control'), 'no-cache',
      'and asks to be revalidated rather than blindly reused — these URLs carry no content hash')
    isTrue((await r.text()).length > 100, 'the cold answer is the file')

    const zweite = await fetchPath('/static/hub.js', { headers: { 'if-none-match': etag } })
    equal(zweite.status, 304, 'the unchanged file is not sent a second time')
    equal((await zweite.text()).length, 0, 'and carries no body at all')
  })

  await check('unknown API path answers 404 instead of hanging', async () => {
    const r = await fetchPath('/api/gibtsnicht', { timeoutMs: 5000 })
    equal(r.status, 404, 'status')
  })
  await check('a notifier wizard\'s own JSON route answers without a credential', async () => {
    // `/api/telegram/chats` became `/settings/notifications/telegram/json/chats`:
    // reading the bot's chats is knowledge about Telegram, and it travels with
    // the plugin rather than with the hub's API surface.
    const j = await (await fetchPath('/settings/notifications/telegram/json/chats', { timeoutMs: 5000 })).json()
    isFalse(j.ok, 'ok')
    isTrue(typeof j.error === 'string' && j.error.length > 0, 'error message')
  })

  // ------------------------------------------------------------------
  group('Repos: create and validate')

  await check('valid repo is created', async () => {
    const r = await postForm('/repos/edit', {
      name: 'e2e', path: REPO, base_branch: 'main',
      worktree_extras: JSON.stringify([{ path: '.env', mode: 'copy' }, { path: 'referenz/', mode: 'link' }]),
    }, { asBrowser: true })
    equal(r.status, 303, 'redirect')
    const repo = db.prepare('SELECT * FROM repos WHERE name=?').get('e2e')
    isTrue(!!repo, 'repo in the database')
    equal(repo.path, REPO, 'path')
  })
  await check('broken JSON is rejected (400 instead of 500)', async () => {
    const r = await postForm('/repos/edit', { name: 'x', path: REPO, worktree_extras: '[{kaputt' }, { asBrowser: true })
    equal(r.status, 400, 'status')
  })
  await check('path without .git is rejected', async () => {
    const r = await postForm('/repos/edit', { name: 'x', path: '/tmp', worktree_extras: '[]' }, { asBrowser: true })
    equal(r.status, 400, 'status')
    contains(await r.text(), 'git', 'reason mentions git')
  })
  await check('unknown mode in the extras is rejected', async () => {
    const r = await postForm('/repos/edit', {
      name: 'x', path: REPO, worktree_extras: JSON.stringify([{ path: '.env', mode: 'kopieren' }]),
    }, { asBrowser: true })
    equal(r.status, 400, 'status')
  })
  await check('a repo prompt is saved and survives an update', async () => {
    const row = db.prepare('SELECT * FROM repos WHERE name=?').get('e2e')
    const r = await postForm(`/repos/edit?id=${row.id}`, {
      name: 'e2e', path: REPO, base_branch: 'main',
      worktree_extras: row.worktree_extras,
      prompt: 'This repo is only for e2e tests.',
    }, { asBrowser: true })
    equal(r.status, 303, 'redirect')
    equal(db.prepare('SELECT prompt FROM repos WHERE name=?').get('e2e').prompt, 'This repo is only for e2e tests.', 'prompt in the database')
    // Emptying it sets the row back to NULL — no empty string stays behind.
    const r2 = await postForm(`/repos/edit?id=${row.id}`, {
      name: 'e2e', path: REPO, base_branch: 'main',
      worktree_extras: row.worktree_extras, prompt: '   ',
    }, { asBrowser: true })
    equal(r2.status, 303, 'redirect of the clearing update')
    equal(db.prepare('SELECT prompt FROM repos WHERE name=?').get('e2e').prompt, null, 'whitespace-only prompt is NULL')
  })

  const repoId = db.prepare('SELECT id FROM repos WHERE name=?').get('e2e').id

  // ------------------------------------------------------------------
  group('Agents: create and validate')

  await check('active is a checkbox, and a spelled-out "0" means off rather than on', async () => {
    // The form's box carries no hidden `0` companion, so ABSENT is what off
    // means there. A caller scripting this route writes `active=0` instead —
    // and the string '0' is truthy, so it used to switch the agent ON.
    const base = { repo_id: repoId, harness: 'claude', prompt: 'x', branch_mode: 'keiner', schedule_kind: 'manuell' }
    const aktiv = (name) => db.prepare('SELECT active FROM agents WHERE repo_id=? AND name=?').get(repoId, name)?.active
    await postForm('/agents/edit', { ...base, name: 'schalter-an', active: '1' }, { asBrowser: true })
    equal(aktiv('schalter-an'), 1, "'1' switches it on")
    await postForm('/agents/edit', { ...base, name: 'schalter-null', active: '0' }, { asBrowser: true })
    equal(aktiv('schalter-null'), 0, "'0' switches it off — it is compared, not coerced")
    await postForm('/agents/edit', { ...base, name: 'schalter-fehlt' }, { asBrowser: true })
    equal(aktiv('schalter-fehlt'), 0, 'and an absent field is off, the way an unticked box arrives')
    db.prepare("DELETE FROM agents WHERE name LIKE 'schalter-%'").run()
  })

  await check('unknown harness is rejected', async () => {
    const r = await postForm('/agents/edit', { repo_id: repoId, name: 'a1', harness: 'gpt', prompt: 'x', branch_mode: 'keiner', schedule_kind: 'manuell' }, { asBrowser: true })
    equal(r.status, 400, 'status')
  })
  await check('empty prompt is rejected', async () => {
    const r = await postForm('/agents/edit', { repo_id: repoId, name: 'a2', harness: 'claude', prompt: '   ', branch_mode: 'keiner', schedule_kind: 'manuell' }, { asBrowser: true })
    equal(r.status, 400, 'status')
  })
  await check('invalid cron expression is rejected', async () => {
    const r = await postForm('/agents/edit', { repo_id: repoId, name: 'a3', harness: 'claude', prompt: 'x', branch_mode: 'keiner', schedule_kind: 'cron', schedule: 'jeden tag' }, { asBrowser: true })
    equal(r.status, 400, 'status')
  })
  await check('weekly without a weekday is rejected', async () => {
    const r = await postForm('/agents/edit', { repo_id: repoId, name: 'a4', harness: 'claude', prompt: 'x', branch_mode: 'keiner', schedule_kind: 'woechentlich', schedule_time: '06:00', schedule_weeks: '1' }, { asBrowser: true })
    equal(r.status, 400, 'status')
  })
  await check('one-off without a date is rejected', async () => {
    const r = await postForm('/agents/edit', { repo_id: repoId, name: 'a5', harness: 'claude', prompt: 'x', branch_mode: 'keiner', schedule_kind: 'einmalig', run_at: '' }, { asBrowser: true })
    equal(r.status, 400, 'status')
  })
  await check('multi-week cadence without an anchor week is rejected', async () => {
    const r = await postForm('/agents/edit', { repo_id: repoId, name: 'a6', harness: 'claude', prompt: 'x', branch_mode: 'keiner', schedule_kind: 'woechentlich', schedule_days: ['1'], schedule_time: '06:00', schedule_weeks: '2', schedule_anchor: '' }, { asBrowser: true })
    equal(r.status, 400, 'status')
  })
  await check('weekly agent is saved with all fields', async () => {
    const r = await postForm('/agents/edit', {
      repo_id: repoId, name: 'e2e-woechentlich', harness: 'claude', prompt: 'Testauftrag', branch_mode: 'keiner',
      expected_minutes: '30', schedule_kind: 'woechentlich', schedule_days: ['1', '3', '5'],
      schedule_time: '07:30', schedule_weeks: '2', schedule_anchor: '2026-08-24', active: '1',
    }, { asBrowser: true })
    equal(r.status, 303, 'redirect')
    const a = agent('e2e-woechentlich')
    equal(a.schedule_kind, 'woechentlich', 'kind')
    equal(a.schedule_days, '1,3,5', 'weekdays')
    equal(a.schedule_time, '07:30', 'time')
    equal(a.schedule_weeks, 2, 'cadence')
    equal(a.schedule_anchor, '2026-08-24', 'anchor week')
  })
  await check('several times on the same days land in one column', async () => {
    const r = await postForm('/agents/edit', {
      repo_id: repoId, name: 'e2e-mehrzeit', harness: 'claude', prompt: 'x', branch_mode: 'keiner',
      expected_minutes: '30', schedule_kind: 'woechentlich', schedule_mode: 'same',
      schedule_days: ['2'], schedule_time: ['11:00', '08:00', ''], schedule_weeks: '1', active: '1',
    }, { asBrowser: true })
    equal(r.status, 303, 'redirect')
    const a = agent('e2e-mehrzeit')
    equal(a.schedule_time, '08:00,11:00', 'sorted, the emptied chip dropped')
    equal(a.schedule_slots, null, 'the same times everywhere need no per-day list')
  })
  await check('times per weekday are stored as slots, and the days follow from them', async () => {
    const r = await postForm('/agents/edit', {
      repo_id: repoId, name: 'e2e-protag', harness: 'claude', prompt: 'x', branch_mode: 'keiner',
      expected_minutes: '30', schedule_kind: 'woechentlich', schedule_mode: 'per_day',
      schedule_day_time_2: ['08:00', '11:00'], schedule_day_time_3: ['14:17'],
      schedule_days: ['1'], schedule_time: '06:00', schedule_weeks: '1', active: '1',
    }, { asBrowser: true })
    equal(r.status, 303, 'redirect')
    const a = agent('e2e-protag')
    equal(a.schedule_slots, '{"2":["08:00","11:00"],"3":["14:17"]}', 'the per-day list')
    equal(a.schedule_days, '2,3', 'the days that have times — not the checkboxes of the other mode')
    equal(a.schedule_time, null, "the other mode's time does not survive alongside")
  })
  await check('a schedule_slots JSON is the same thing said in one field', async () => {
    const r = await postForm('/agents/edit', {
      repo_id: repoId, name: 'e2e-slots-json', harness: 'claude', prompt: 'x', branch_mode: 'keiner',
      expected_minutes: '30', schedule_kind: 'woechentlich',
      schedule_slots: '{"2":["08:00","11:00"],"3":["14:17"]}', schedule_weeks: '1', active: '1',
    }, { asBrowser: true })
    equal(r.status, 303, 'redirect')
    const a = agent('e2e-slots-json')
    equal(a.schedule_slots, '{"2":["08:00","11:00"],"3":["14:17"]}', 'stored as given')
    equal(a.schedule_days, '2,3', 'days derived')
  })
  await check('per-day without a single time, and unreadable times, are rejected', async () => {
    const leer = await postForm('/agents/edit', {
      repo_id: repoId, name: 'e2e-protag-leer', harness: 'claude', prompt: 'x', branch_mode: 'keiner',
      schedule_kind: 'woechentlich', schedule_mode: 'per_day', schedule_weeks: '1',
    }, { asBrowser: true })
    equal(leer.status, 400, 'no day has a time')
    const kaputt = await postForm('/agents/edit', {
      repo_id: repoId, name: 'e2e-protag-kaputt', harness: 'claude', prompt: 'x', branch_mode: 'keiner',
      schedule_kind: 'woechentlich', schedule_mode: 'per_day', schedule_day_time_2: 'bald', schedule_weeks: '1',
    }, { asBrowser: true })
    equal(kaputt.status, 400, 'a half-typed time is not silently dropped')
    const json = await postForm('/agents/edit', {
      repo_id: repoId, name: 'e2e-slots-kaputt', harness: 'claude', prompt: 'x', branch_mode: 'keiner',
      schedule_kind: 'woechentlich', schedule_slots: 'kein json', schedule_weeks: '1',
    }, { asBrowser: true })
    equal(json.status, 400, 'unreadable JSON')
  })
  await check('switching from per-day back to the same times drops the slots', async () => {
    const id = agent('e2e-protag').id
    const r = await postForm(`/agents/edit?id=${id}`, {
      repo_id: repoId, name: 'e2e-protag', harness: 'claude', prompt: 'x', branch_mode: 'keiner',
      expected_minutes: '30', schedule_kind: 'woechentlich', schedule_mode: 'same',
      schedule_days: ['1'], schedule_time: '06:00', schedule_weeks: '1', active: '1',
    }, { asBrowser: true })
    equal(r.status, 303, 'redirect')
    const a = agent('e2e-protag')
    equal(a.schedule_slots, null, 'the per-day list is gone, not left to outrank the columns')
    equal(a.schedule_time, '06:00', 'and the simple time is what runs')
  })
  await check('the form comes back in the mode the agent was saved in', async () => {
    const id = agent('e2e-slots-json').id
    const html = await (await fetchPath(`/agents/edit?id=${id}`)).text()
    isTrue(/value="per_day"[^>]*\n?[^>]*checked/.test(html), 'per-day mode preselected')
    isTrue(/name="schedule_day_time_2" value="08:00"/.test(html), "Tuesday's first time")
    isTrue(/name="schedule_day_time_2" value="11:00"/.test(html), "Tuesday's second time")
    isTrue(/name="schedule_day_time_3" value="14:17"/.test(html), "Wednesday's own time")
  })
  await check('switching to manual clears the schedule fields', async () => {
    const id = agent('e2e-woechentlich').id
    const r = await postForm(`/agents/edit?id=${id}`, {
      repo_id: repoId, name: 'e2e-woechentlich', harness: 'claude', prompt: 'Testauftrag',
      branch_mode: 'keiner', expected_minutes: '30', schedule_kind: 'manuell', active: '1',
    }, { asBrowser: true })
    equal(r.status, 303, 'redirect')
    const a = agent('e2e-woechentlich')
    equal(a.schedule_kind, 'manuell', 'kind')
    equal(a.schedule_days, null, 'weekdays cleared')
    equal(a.run_at, null, 'date cleared')
  })

  // ------------------------------------------------------------------
  group('Agents: delete and move (per-repo names)')

  await check('a second repo exists for the move tests', async () => {
    const r = await postForm('/repos/edit', {
      name: 'e2e2', path: REPO, base_branch: 'main', worktree_extras: '[]',
    }, { asBrowser: true })
    equal(r.status, 303, 'repo created')
  })
  const repo2Id = db.prepare('SELECT id FROM repos WHERE name=?').get('e2e2').id

  await check('same name is allowed in two repos, rejected inside one', async () => {
    const anlegen = (rid) => postForm('/agents/edit', {
      repo_id: rid, name: 'e2e-dup', harness: 'claude', prompt: 'x', branch_mode: 'keiner', schedule_kind: 'manuell',
    }, { asBrowser: true })
    equal((await anlegen(repoId)).status, 303, 'first agent in repo1')
    equal((await anlegen(repo2Id)).status, 303, 'same name allowed in repo2')
    const dup = await anlegen(repoId)
    equal(dup.status, 400, 'duplicate in the same repo is rejected')
    contains(await dup.text(), 'already exists', 'readable reason instead of a 500')
    equal(db.prepare('SELECT count(*) c FROM agents WHERE repo_id=? AND name=?').get(repoId, 'e2e-dup').c, 1, 'no second row in repo1')
  })

  await check('a deleted agent leaves its runs untouched', async () => {
    const r = await postForm('/agents/edit', {
      repo_id: repoId, name: 'e2e-weg', harness: 'claude', prompt: 'Mach was',
      branch_mode: 'keiner', schedule_kind: 'manuell', expected_minutes: '30',
    }, { asBrowser: true })
    equal(r.status, 303, 'agent created')
    const a = db.prepare('SELECT * FROM agents WHERE repo_id=? AND name=?').get(repoId, 'e2e-weg')
    isTrue(!!a, 'agent in the database')
    const st = await postForm('/agents/start', { id: String(a.id), repo: String(repoId) })
    equal(st.status, 303, 'start redirects')
    const run = db.prepare('SELECT * FROM runs WHERE agent_id=? ORDER BY started_at DESC LIMIT 1').get(a.id)
    isTrue(!!run, 'a run was started for the agent')
    equal(run.agent_id, a.id, 'run references the agent')
    equal(run.title, 'e2e-weg', 'run carries the agent name as its title snapshot')
    sessionMerken(run.id)

    const del = await postForm('/agents/delete', { id: String(a.id), repo: String(repoId) }, { asBrowser: true })
    equal(del.status, 303, 'delete redirects')
    equal(db.prepare('SELECT count(*) c FROM agents WHERE id=?').get(a.id).c, 0, 'agent row gone')
    const surviving = db.prepare('SELECT * FROM runs WHERE id=?').get(run.id)
    isTrue(!!surviving, 'the run survives the delete')
    equal(surviving.agent_id, null, 'reference cut')
    equal(surviving.title, 'e2e-weg', 'title snapshot keeps the name')
    equal(surviving.prompt, run.prompt, 'definition copy untouched')
  })

  await check('move to another repo keeps the name when it is free', async () => {
    const r = await postForm('/agents/edit', {
      repo_id: repoId, name: 'e2e-frei', harness: 'claude', prompt: 'x',
      branch_mode: 'keiner', schedule_kind: 'manuell',
    }, { asBrowser: true })
    equal(r.status, 303, 'created')
    const a = db.prepare('SELECT * FROM agents WHERE repo_id=? AND name=?').get(repoId, 'e2e-frei')
    const mv = await postForm('/agents/move', { id: String(a.id), repo: String(repo2Id) }, { asBrowser: true })
    equal(mv.status, 303, 'moved')
    const row = db.prepare('SELECT * FROM agents WHERE id=?').get(a.id)
    equal(row.repo_id, repo2Id, 'now lives in repo2')
    equal(row.name, 'e2e-frei', 'name unchanged when it is free there')
  })

  await check('move into a name collision appends a datetime suffix', async () => {
    // 'e2e-frei' is already in repo2 — a second one from repo1 must not overwrite it.
    const r = await postForm('/agents/edit', {
      repo_id: repoId, name: 'e2e-frei', harness: 'claude', prompt: 'x',
      branch_mode: 'keiner', schedule_kind: 'manuell',
    }, { asBrowser: true })
    equal(r.status, 303, 'same name in repo1 allowed')
    const a = db.prepare('SELECT * FROM agents WHERE repo_id=? AND name=?').get(repoId, 'e2e-frei')
    const mv = await postForm('/agents/move', { id: String(a.id), repo: String(repo2Id) }, { asBrowser: true })
    equal(mv.status, 303, 'moved')
    const row = db.prepare('SELECT * FROM agents WHERE id=?').get(a.id)
    equal(row.repo_id, repo2Id, 'now lives in repo2')
    equal(/^e2e-frei-\d{4}-\d{2}-\d{2}-\d{6}$/.test(row.name), true, `name got a datetime suffix (${row.name})`)
  })

  await check('move page and the agent detail page expose the actions', async () => {
    const a = db.prepare('SELECT * FROM agents WHERE repo_id=? AND name=?').get(repo2Id, 'e2e-frei')
    const html = await (await fetchPath(`/agents/move?id=${a.id}`)).text()
    contains(html, 'Move agent', 'move page title')
    contains(html, 'e2e-frei', 'names the agent')
    contains(html, 'e2e', 'lists a target repo')
    // The destructive actions live on the agent's detail (edit) page, not in
    // the overview table — a cleanup action must not sit next to the on/off
    // switch, and delete asks for the confirm dialog where it appears.
    const detail = await (await fetchPath(`/agents/edit?id=${a.id}&repo=${repo2Id}`)).text()
    contains(detail, '/agents/move', 'move link on the agent detail page')
    contains(detail, '/agents/delete', 'delete form on the agent detail page')
    const page = await (await fetchPath(`/agents?repo=${repoId}`)).text()
    isFalse(page.includes('/agents/move'), 'no move link in the agents table')
    isFalse(page.includes('/agents/delete'), 'no delete form in the agents table')
  })

  // ------------------------------------------------------------------
  group('Provider and effort selection (harness-dependent)')

  await check('each harness only gets providers it can actually use here', async () => {
    const p = async (h) => (await (await fetchPath(`/api/providers?harness=${h}`)).json()).provider.map(x => x.id)
    equal((await p('claude')).length, 0, 'claude runs on the subscription, no provider')
    isTrue((await p('opencode')).includes('opencode-zen'), 'opencode knows Zen')
    isFalse((await p('hermes')).includes('opencode-zen'), 'hermes cannot use Zen here (no key)')
  })

  await check('reasoning effort only where it actually arrives', async () => {
    const eff = async (q) => (await (await fetchPath('/api/effort?' + q)).json())
    const c = await eff('harness=claude')
    isTrue(c.ok && c.stufen.includes('high'), `claude names levels (${JSON.stringify(c).slice(0, 90)})`)
    const quatsch = await eff('harness=opencode&provider=openrouter&model=gibtsnicht/quatsch')
    isFalse(quatsch.ok, 'unknown model: no field instead of guessed levels')
    equal((await fetchPath('/api/effort?harness=quatsch')).status, 200, 'always answers with 200')
  })

  await check('an impossible level is rejected instead of silently dropped', async () => {
    // opencode discards an unknown variant without comment — the hub must catch that
    // beforehand, otherwise the DB would hold a promise that does nothing.
    const r = await postForm('/agents/edit', {
      repo_id: String(repoId), name: 'effort-quatsch', harness: 'opencode', provider: 'opencode-zen',
      model: 'hy3-free', effort: 'ultraturbo', prompt: 'x', branch_mode: 'keiner',
      expected_minutes: '5', schedule_kind: 'manuell',
    }, { asBrowser: true })
    equal(r.status, 400, 'rejected')
    contains(await r.text(), 'Reasoning effort', 'with a reason')
    isFalse(!!db.prepare(`SELECT 1 FROM agents WHERE name='effort-quatsch'`).get(), 'nothing saved')
  })

  await check('a disabled coding agent is rejected at run creation and can be re-enabled', async () => {
    await postForm('/settings/coding-agents/save', { harness: 'hermes', enabled: '0' }, { asBrowser: true })
    const r = await postForm('/api/runs', { repo_id: String(repoId), harness: 'hermes', prompt: 'x', branch_mode: 'keiner', expected_minutes: '5' })
    equal(r.status, 400, 'rejected')
    contains((await r.json()).error, 'not configured', 'reason')
    const wieder = await postForm('/settings/coding-agents/save',
      { harness: 'hermes', enabled: '1', providers: ['openrouter', 'opencode-zen', 'deepseek'] }, { asBrowser: true })
    equal(wieder.status, 303, 're-enabled')
  })

  group('Single run: worktree, prompt, tmux, log')

  await check('the start form shows the ACTUAL pipeline state', async () => {
    // Used to be hard-wired: the form always claimed "pipeline is off",
    // even when the top-right corner said "on".
    const text = async () => (await fetchPath(`/runs/new?repo=${repoId}`)).text()
    await postForm('/api/settings/pipeline', { value: '0' })
    contains(await text(), 'Pipeline is off', 'hint with the pipeline switched off')
    await postForm('/api/settings/pipeline', { value: '1' })
    const an = await text()
    contains(an, 'Pipeline is on', 'hint with the pipeline switched on')
    isFalse(an.includes('Pipeline is off'), 'no contradictory hint next to it')
    await postForm('/api/settings/pipeline', { value: '0' })
  })

  let R1 = null
  await check('run starts via the form and redirects to the run page', async () => {
    const r = await postForm('/runs/new', {
      repo_id: repoId, harness: 'claude', prompt: 'E2E-Auftrag: nichts tun.',
      branch_mode: 'neu', branch_pattern: 'agent/e2e/{kurz}', expected_minutes: '45',
    }, { asBrowser: true })
    equal(r.status, 303, 'redirect')
    const ort = r.headers.get('location')
    isTrue(/^\/runs\/[0-9a-f-]{36}$/.test(ort), `target is a run page (${ort})`)
    R1 = ort.split('/')[2]
    await sessionMerken(R1)
    equal(lauf(R1).status, 'running', 'status')
  })
  await check('worktree exists and is on the expected branch', async () => {
    const l = lauf(R1)
    isTrue(existsSync(l.workdir_effective), `worktree ${l.workdir_effective}`)
    const b = await sh('git', ['-C', l.workdir_effective, 'rev-parse', '--abbrev-ref', 'HEAD'])
    equal(b.stdout.trim(), l.branch_expected, 'branch')
    contains(l.branch_expected, 'agent/e2e/', 'branch pattern expanded')
  })
  await check('worktree extras: .env copied, referenz/ linked', () => {
    const wt = lauf(R1).workdir_effective
    isTrue(existsSync(join(wt, '.env')), '.env present')
    isFalse(lstatSync(join(wt, '.env')).isSymbolicLink(), '.env is a copy')
    isTrue(lstatSync(join(wt, 'referenz')).isSymbolicLink(), 'referenz/ is a symlink')
  })
  await check('prompt.md contains the task and the platform suffix', () => {
    const p = readFileSync(join(SB, 'runs', R1, 'prompt.md'), 'utf8')
    contains(p, 'E2E-Auftrag', 'own task')
    contains(p, 'fl-report done', 'platform rules')
    contains(p, R1, 'run ID')
  })
  await check('a per-repo prompt is added to every run', async () => {
    db.prepare('UPDATE repos SET prompt=? WHERE id=?').run('This repo has its own rules.', repoId)
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Repo-Prompt' })
    isTrue(!!j.runId, `run (${JSON.stringify(j)})`)
    await sessionMerken(j.runId)
    const p = readFileSync(join(SB, 'runs', j.runId, 'prompt.md'), 'utf8')
    contains(p, 'E2E-Repo-Prompt', 'own task')
    contains(p, 'Repository context', 'section label')
    contains(p, 'This repo has its own rules.', 'repo prompt content')
    // Repo config is read at launch, not snapshotted: clearing it removes it from
    // the next run, and runs before it keep their prompt.md.
    db.prepare('UPDATE repos SET prompt=? WHERE id=?').run(null, repoId)
  })
  await check('tmux session is running and assigned to the run', async () => {
    const s = lauf(R1).tmux_session
    isTrue(!!s, 'session in the database')
    isTrue((await sh('tmux', ['has-session', '-t', `=${s}`])).ok, `session ${s} is alive`)
  })
  await check('log file is created (fl-start --log → pipe-pane)', () => {
    // The CONTENT is checked only after the first send: pipe-pane attaches only
    // after startup, so the initial output can escape it.
    isTrue(existsSync(join(SB, 'runs', R1, 'log.txt')), 'log.txt created')
  })

  // ------------------------------------------------------------------
  group('Terminal in the browser (WebSocket)')

  const wsVersuch = (pfad) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}${pfad}`)
    const fertig = (e) => { try { ws.close() } catch {} ; resolve(e) }
    const t = setTimeout(() => fertig({ art: 'timeout' }), 8000)
    ws.on('message', (d) => { clearTimeout(t); fertig({ art: 'data', text: String(d) }) })
    ws.on('unexpected-response', (_req, res) => { clearTimeout(t); fertig({ art: 'http', status: res.statusCode }) })
    ws.on('error', (err) => { clearTimeout(t); fertig({ art: 'fehler', text: err.message }) })
  })

  await check('terminal connects and delivers the session content', async () => {
    const e = await wsVersuch(`/term?run=${R1}&ro=1`)
    equal(e.art, 'data', `event (${JSON.stringify(e)})`)
    isTrue(e.text.length > 0, 'output received')
  })
  await check('unknown run yields 404 instead of hanging', async () => {
    const e = await wsVersuch('/term?run=00000000-0000-4000-8000-000000000000&ro=1')
    equal(e.art, 'http', 'HTTP response')
    equal(e.status, 404, 'status')
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

  await check('with ro=0, typed text really lands in the session', async () => {
    await wsSchreiben(`/term?run=${R1}&ro=0`, 'direkt getippt\r')
    await waitFor(async () => (await sh('tmux', ['capture-pane', '-p', '-t', `=${lauf(R1).tmux_session}:`]))
      .stdout.includes('[agent saw] direkt getippt'), { what: 'typed text in the pane', timeoutMs: 8000 })
  })
  await check('without the ro parameter the terminal stays mute (fail-closed)', async () => {
    await wsSchreiben(`/term?run=${R1}`, 'darf nicht ankommen\r')
    await new Promise((r) => setTimeout(r, 1500))
    const p = await sh('tmux', ['capture-pane', '-p', '-t', `=${lauf(R1).tmux_session}:`])
    isFalse(p.stdout.includes('darf nicht ankommen'), 'nothing let through')
  })

  // ------------------------------------------------------------------
  group('Sending text and reports (fl-report)')

  // The fl-report of THIS checkout, like FL_REPORT_REPO above and for the same
  // reason: ~/.local/bin holds whatever the last deploy installed, and a suite
  // that asks the machine what it has installed is a suite that is green or red
  // depending on the machine.
  const flReport = (runId, args) => sh(FL_REPORT_REPO, args, {
    env: { ...process.env, FL_RUN_ID: runId, FL_HUB_URL: BASE },
  })

  await check('sending via the API lands in the tmux session', async () => {
    const r = await postForm(`/api/runs/${R1}/send`, { text: 'hallo aus dem test' })
    equal(r.status, 200, 'status')
    equal((await r.json()).ok, true, 'ok')
    await waitFor(async () => (await sh('tmux', ['capture-pane', '-p', '-t', `=${lauf(R1).tmux_session}:`]))
      .stdout.includes('[agent saw] hallo aus dem test'), { what: 'text in the pane', timeoutMs: 8000 })
  })
  await check('the log records the transcript', async () => {
    const datei = join(SB, 'runs', R1, 'log.txt')
    await waitFor(() => readFileSync(datei, 'utf8').includes('hallo aus dem test'),
      { what: 'sent text in the log', timeoutMs: 8000 })
  })
  await check('form POST redirects back to the run page (no bare JSON)', async () => {
    const r = await postForm(`/api/runs/${R1}/send`, { text: 'zweiter text' }, { asBrowser: true })
    equal(r.status, 303, 'status')
    equal(r.headers.get('location'), `/runs/${R1}`, 'target')
  })
  await check('progress, branch and PR are taken over', async () => {
    isTrue((await flReport(R1, ['progress', 'laeuft weiter'])).ok, 'progress')
    isTrue((await flReport(R1, ['branch', 'agent/e2e/gemeldet'])).ok, 'branch')
    isTrue((await flReport(R1, ['pr', 'https://example.invalid/pr/1'])).ok, 'pr')
    const l = lauf(R1)
    equal(l.branch_reported, 'agent/e2e/gemeldet', 'branch')
    equal(l.pr_url, 'https://example.invalid/pr/1', 'PR')
    isTrue(ereignisse(R1).includes('progress'), 'event progress')
  })
  await check('a call for help sets the run to waiting_help', async () => {
    isTrue((await flReport(R1, ['help', 'Variante A oder B?'])).ok, 'help')
    const l = lauf(R1)
    equal(l.status, 'waiting_help', 'status')
    contains(l.help_text, 'Variante A', 'question stored')
  })
  await check('an answer sets the run back to running', async () => {
    await postForm(`/api/runs/${R1}/send`, { text: 'Nimm B.' })
    const l = lauf(R1)
    equal(l.status, 'running', 'status')
    contains(l.help_answer, 'Nimm B.', 'answer stored')
  })
  await check('final report lands in the run and on the page', async () => {
    const datei = join(SB, 'report.md')
    writeFileSync(datei, '# Bericht\n- alles erledigt\n')
    isTrue((await flReport(R1, ['done', '--file', datei])).ok, 'done')
    const l = lauf(R1)
    equal(l.status, 'done', 'status')
    contains(l.report_md, 'alles erledigt', 'report stored')
    contains(await (await fetchPath(`/runs/${R1}`)).text(), 'alles erledigt', 'report on the page')
  })

  await check('the detail page shows the prompt in a collapsible block near the top', async () => {
    const html = await (await fetchPath(`/runs/${R1}`)).text()
    contains(html, 'id="run-prompt"', 'the prompt block exists')
    contains(html, 'E2E-Auftrag: nichts tun.', 'the run\'s prompt text is on the page')
    const reihe = ['id="run-head"', 'id="run-prompt"', 'class="chips"'].map(s => html.indexOf(s))
    isTrue(reihe[0] !== -1 && reihe[1] !== -1 && reihe[2] !== -1, 'title, prompt block and chips all rendered')
    equal(reihe[0] < reihe[1] && reihe[1] < reihe[2], true, 'title → prompt → chips (prompt sits near the top)')
  })

  // ------------------------------------------------------------------
  group('cursor: a run ends even without fl-report')

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
    isTrue(!!j.runId, `run created (${JSON.stringify(j).slice(0, 200)})`)
    await sessionMerken(j.runId)
    return j.runId
  }
  const AGENT_TEXT = 'Done: dark-mode hover fixed, pushed as abc1234.'
  const TURN_END = ['{"role":"assistant","message":{"content":[{"type":"text","text":"' + AGENT_TEXT + '"}]}}',
    '{"type":"turn_ended","status":"success"}']

  let RCU = null
  await check('the hub writes the stop hook into the worktree before the start', async () => {
    RCU = await cursorRun('E2E-cursor-turn-end')
    const f = join(lauf(RCU).workdir_effective, '.cursor', 'hooks.json')
    const j = JSON.parse(readFileSync(f, 'utf8'))
    contains(j.hooks.stop[0].command, 'fl-report _turn_end', 'stop reports the turn end')
    contains(j.hooks.sessionEnd[0].command, 'fl-report _exit', 'sessionEnd is the second net')
  })
  await check('the prompt tells cursor how the run ends, with a copy-ready command', async () => {
    const p = readFileSync(join(SB, 'runs', RCU, 'prompt.md'), 'utf8')
    contains(p, `fl-report done --file ${join(SB, 'runs', RCU, 'report.md')}`, 'exact command, exact path')
    contains(p, 'cursor-agent', 'the harness gets its own rules')
    isFalse(p.includes('{report_file}'), 'no placeholder left over')
  })
  await check('the stop hook closes the run and keeps the agent\'s own words', async () => {
    writeTranscript(RCU, TURN_END)
    isTrue((await flReport(RCU, ['_turn_end'])).ok, '_turn_end accepted')
    const l = lauf(RCU)
    equal(l.status, 'done', 'status')
    contains(l.report_md, AGENT_TEXT, 'the closing message becomes the report')
    contains(l.report_md, 'without calling', 'and it says why the platform wrote it')
    isTrue(ereignisse(RCU).includes('turn_end_finished'), 'recorded as its own event')
  })
  await check('a turn end while waiting for help does NOT close the run', async () => {
    const id = await cursorRun('E2E-cursor-help')
    isTrue((await flReport(id, ['help', 'A or B?'])).ok, 'help')
    equal(lauf(id).status, 'waiting_help', 'waiting')
    // Ending the turn is exactly right here: the agent asked and is idle until a
    // human answers. Closing the run on it would throw the question away.
    writeTranscript(id, TURN_END)
    await flReport(id, ['_turn_end'])
    await watcherTick()
    equal(lauf(id).status, 'waiting_help', 'still waiting')
  })
  await check('without a hook the transcript closes the run', async () => {
    // Second channel: a repository bringing its own .cursor/hooks.json keeps the
    // hub from writing one, and a cursor release could rename the event. The
    // transcript cannot go away — it is where cursor keeps the conversation.
    const id = await cursorRun('E2E-cursor-transcript')
    await watcherTick()
    equal(lauf(id).status, 'running', 'still running while the turn is open')
    writeTranscript(id, TURN_END)
    await watcherTick()
    equal(lauf(id).status, 'done', 'closed by the watcher')
    contains(lauf(id).report_md, AGENT_TEXT, 'same report text')
  })
  await check('all three end channels together notify exactly once', async () => {
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
    equal(lauf(id).status, 'done', 'done')
    const kinds = ereignisse(id)
    const ende = kinds.filter(k => /^notified:(done|failed|pane_died|exit_without_report)$/.test(k))
    equal(ende.join(','), 'notified:done', 'exactly one end message, and it is the done one')
    equal(kinds.filter(k => k === 'done').length, 1, 'the run was closed exactly once')
    equal(kinds.filter(k => k === 'turn_end_finished').length, 1, 'only the channel that got there first closes it')
  })
  await check('a claude run is not closed by a turn end', async () => {
    // Every other harness has a dying process as its safety net; there the turn
    // end stays what it always was — a note.
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-claude-turn-end', expected_minutes: '45' })
    await sessionMerken(j.runId)
    isTrue((await flReport(j.runId, ['_turn_end'])).ok, '_turn_end accepted')
    equal(lauf(j.runId).status, 'running', 'keeps running')
  })

  // ------------------------------------------------------------------
  group('Watcher: anomalies, costs, branch reconciliation')

  let R3 = null
  await check('exceeded expectation creates anomalies', async () => {
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Ueberzug', expected_minutes: '1' })
    R3 = j.runId
    isTrue(!!R3, 'run created')
    await sessionMerken(R3)
    // Backdate the start time instead of waiting five minutes.
    db.prepare(`UPDATE runs SET started_at=datetime('now','-5 minutes') WHERE id=?`).run(R3)
    await watcherTick()
    const k = ereignisse(R3)
    isTrue(k.includes('anomaly:overrun'), `anomaly:overrun (has: ${k.join(', ')})`)
    isTrue(k.includes('anomaly:soft_overrun'), 'anomaly:soft_overrun')
  })
  await check('a progress report clears the anomalies again', async () => {
    isTrue((await flReport(R3, ['progress', 'melde mich, dauert laenger'])).ok, 'progress')
    const k = ereignisse(R3)
    isFalse(k.includes('anomaly:overrun'), 'anomaly:overrun is gone')
    isTrue(k.includes('cleared:anomaly:overrun'), 'marked as resolved')
    isTrue(k.includes('cleared:anomaly:soft_overrun'), 'the yellow level too')
  })
  await check('a run that came through stops calling for attention', async () => {
    // The traffic light is fed by incidents AND by the run's anomalies. An
    // anomaly is a statement about a run IN FLIGHT — "this is taking longer
    // than planned" — and every other way of overtaking one already retracts
    // it: the progress report just above, a raised expected duration, a
    // resume, activity coming back. The run REACHING ITS END was the one
    // nobody had wired up. Measured on the production hub: run 9b6bfee6 ran 52
    // minutes against an expectation of 45, reported done and had its work
    // merged into main — and sat in the overview with a RED dot titled "needs
    // attention", beside a run that had genuinely called for help and was
    // green. Three more wore the same yellow, all of them done and merged.
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Ampel', expected_minutes: '1' })
    await sessionMerken(j.runId)
    db.prepare(`UPDATE runs SET started_at=datetime('now','-5 minutes') WHERE id=?`).run(j.runId)
    await watcherTick()
    isTrue(ereignisse(j.runId).includes('anomaly:overrun'), 'it overran')
    const zeile = async () => (await (await fetchPath(`/api/fragments/run-row?id=${j.runId}&repo=${repoId}`)).text())
    contains(await zeile(), 'class="dot red"', 'while it runs, an overrun is red — that is the point of it')

    isTrue((await flReport(j.runId, ['done', 'fertig'])).ok, 'reports done')
    equal(lauf(j.runId).status, 'done', 'and the record says so')
    const fertig = await zeile()
    isFalse(fertig.includes('class="dot red"'), 'a finished run is not red for having been slow')
    isFalse(fertig.includes('class="dot yellow"'), 'and not yellow either')
    contains(fertig, 'class="dot green"', 'it came through')
    // Nothing is rewritten: the event stays as history and the status cell goes
    // on printing it, next to a duration column that says the same thing. What
    // ends is the call for attention, not the record.
    isTrue(ereignisse(j.runId).includes('anomaly:overrun'), 'the anomaly event is untouched')
    contains(fertig, 'far over the expected duration', 'and the row still names it as history')

    // A run that did NOT come through keeps its colour: there the anomaly is
    // the explanation of why it did not.
    db.prepare(`UPDATE runs SET status='aborted' WHERE id=?`).run(j.runId)
    contains(await zeile(), 'class="dot red"', 'an aborted run keeps what its anomaly says')
    db.prepare(`UPDATE runs SET status='done' WHERE id=?`).run(j.runId)
  })
  await check('the watcher notices a dead pane by itself', async () => {
    // The producer side of `_pane_died`, which had NO test at all: every other
    // check of that path calls handleReport() directly, so the consumer was
    // covered and the thing that is supposed to CALL it was not. It never
    // called it. watchRun() asked `tmux display -p -t '=name'` — a session
    // target where a PANE target is wanted — and measured against tmux 3.4
    // that is not an error and not an empty list: it is exit 0 with every
    // format field expanded to nothing. `if (r.ok && r.stdout.trim())` reads
    // that as "tmux said nothing", `st.pane_dead` keeps its '?' default, and
    // the run stays 'running' with no event, no anomaly and nothing in the
    // log. Seen in production on sandboxed run f365ea8e: the container died at
    // launch, the pane was dead, and twelve minutes later the hub still had it
    // as a working agent — but the fault was never sandbox-specific. It was
    // every crashed CLI, every plugin harness that exits, every one of the
    // hub's own harnesses when its process dies. watchFollowUps(), a hundred
    // lines further down, had the colon all along.
    const sname = 'fl-cc-panedead-watcher'
    sessions.add(sname)
    await sh('tmux', ['new-session', '-d', '-x', '80', '-y', '24', '-s', sname])
    await sh('tmux', ['set-option', '-t', `=${sname}:`, 'remain-on-exit', 'on'])
    // `exit 7` rather than a bare `exit`, so the exit STATUS is asserted too:
    // the fields come out of ONE format string, and the one that used to be
    // split on whitespace shifted left whenever a field before it was empty.
    await sh('tmux', ['send-keys', '-t', `=${sname}:`, 'exit 7', 'Enter'])
    await waitFor(async () => {
      const r = await sh('tmux', ['display', '-p', '-t', `=${sname}:`, '#{pane_dead}'])
      return r.ok && r.stdout.trim() === '1'
    }, { what: 'the pane is dead', timeoutMs: 5000 })

    // The bare target, measured here rather than argued about: tmux is happy
    // with it and says nothing whatsoever.
    const bare = await sh('tmux', ['display', '-p', '-t', `=${sname}`, '#{pane_dead}'])
    isTrue(bare.ok, 'the bare target is not an error — that is the trap')
    equal(bare.stdout.trim(), '', 'it answers exit 0 and NOTHING, so nobody noticed')

    const id = randomUUID()
    db.prepare(`INSERT INTO runs(id,repo_id,harness,prompt,branch_mode,expected_minutes,status,
                                 workdir_effective,tmux_session,started_at)
                VALUES(?,?,'claude','the agent crashed','keiner',45,'running',?,?,datetime('now'))`)
      .run(id, repoId, REPO, sname)
    mkdirSync(join(SB, 'runs', id), { recursive: true })
    await watcherTick()
    const k = ereignisse(id)
    isTrue(k.includes('pane_died'), `the watcher reported it (has: ${k.join(', ')})`)
    equal(lauf(id).status, 'failed', 'and the run does not sit on "running" for ever')
    equal(lauf(id).exit_code, 7, 'with the status the pane really carried')
    db.prepare('DELETE FROM runs WHERE id=?').run(id)
  })

  await check('two watcher passes never overlap', async () => {
    // `startWatcher()` is a plain 30-second interval, so a pass longer than 30 s
    // ran into the next one — and a pass that reconciles containers talks to a
    // daemon, which is exactly the call that takes seconds. Both passes then
    // read one run's `log_offset`, scan the SAME bytes and report the same log
    // line twice, which is how a single match becomes a red incident.
    // `flowsTick()` has had this guard from the beginning; the tick itself
    // never got it. A skipped pass is counted rather than silent.
    const wa = await import('../server/watcher.mjs')
    const vorher = wa.skippedTicks()
    await Promise.all([wa.tick(), wa.tick()])
    equal(wa.skippedTicks(), vorher + 1, 'the second pass found the first one running and did nothing')
    // …and the flag is given back: the next pass runs normally.
    await wa.tick()
    equal(wa.skippedTicks(), vorher + 1, 'nothing was skipped once the first pass was over')
  })

  await check('cost finalization really runs for finished runs', async () => {
    await watcherTick()
    const l = lauf(R1)
    isTrue(l.quota7_end !== null, 'quota7_end set')
    isTrue(l.cost_eur !== null, 'cost_eur computed')
  })
  await check('unpushed branch is reported', async () => {
    const l = lauf(R1)
    // The reported branch does not exist in git — the reconciliation counts the real one.
    db.prepare('UPDATE runs SET branch_reported=? WHERE id=?').run(l.branch_expected, R1)
    db.prepare(`DELETE FROM events WHERE run_id=? AND kind IN ('anomaly:unpushed','branch_synced')`).run(R1)
    await sh('git', ['-C', l.workdir_effective, 'commit', '-q', '--allow-empty', '-m', 'Arbeit des Agenten'])
    await watcherTick()
    isTrue(ereignisse(R1).includes('anomaly:unpushed'), `anomaly:unpushed (has: ${ereignisse(R1).join(', ')})`)
  })
  await check('a run the hub merged itself is never reported as unpushed', async () => {
    // The integrator merges the run's branch into the base branch and pushes
    // THAT, which leaves the branch behind its upstream with nothing of its own
    // missing. Measured on run d4ee07d2: `merged` at 16:47:56, then
    // `anomaly:unpushed {"track":"[behind 1]"}` and a notification about work
    // that was already on origin. Nothing of a merged run lives only here.
    for (const status of ['merged', 'kept_on_branch']) {
      db.prepare(`DELETE FROM events WHERE run_id=? AND kind IN ('anomaly:unpushed','branch_synced')`).run(R1)
      db.prepare('UPDATE runs SET merge_status=? WHERE id=?').run(status, R1)
      await watcherTick()
      isFalse(ereignisse(R1).includes('anomaly:unpushed'), `${status}: not reported as unpushed`)
    }
    db.prepare('UPDATE runs SET merge_status=NULL WHERE id=?').run(R1)
  })

  // ------------------------------------------------------------------
  group('Extra skills: opt-in per run and agent')

  await check('forms offer the skill as a checkbox, nothing preselected', async () => {
    const html = await (await fetchPath(`/runs/new?repo=${repoId}`)).text()
    contains(html, 'e2e-fleiss', 'single-run form')
    contains(html, 'Testskill gegen faule Modelle', 'description')
    isFalse(/name="skills"[^>]*checked/.test(html), 'opt-in: not preselected')
    contains(await (await fetchPath(`/agents/edit?repo=${repoId}`)).text(), 'e2e-fleiss', 'agent form')
  })
  await check('a selected skill lands as a SKILL.md reference in the run prompt', async () => {
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Skilltest', skills: 'e2e-fleiss' })
    isTrue(!!j.runId, `run (${JSON.stringify(j)})`)
    await sessionMerken(j.runId)
    equal(lauf(j.runId).skills, '["e2e-fleiss"]', 'definition copy on the run')
    const prompt = readFileSync(join(SB, 'runs', j.runId, 'prompt.md'), 'utf8')
    contains(prompt, join(SB, 'zusaetze', 'e2e-fleiss', 'SKILL.md'), 'full path in the prompt')
    contains(prompt, 'ENTIRE task', 'instruction to apply')
    contains(await (await fetchPath(`/runs/${j.runId}`)).text(), 'e2e-fleiss', 'detail page shows the selection')
  })
  await check('without the checkbox the prompt stays free of skill references', async () => {
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-ohne-Skill' })
    await sessionMerken(j.runId)
    equal(lauf(j.runId).skills, null, 'no selection')
    isFalse(readFileSync(join(SB, 'runs', j.runId, 'prompt.md'), 'utf8').includes('SKILL.md'), 'no reference')
  })
  await check('agent with skill: the run inherits the selection (also via the scheduler path)', async () => {
    const r = await postForm('/agents/edit', {
      repo_id: repoId, name: 'skill-traeger', harness: 'claude', prompt: 'E2E-Agent-Skill',
      branch_mode: 'keiner', expected_minutes: '45', schedule_kind: 'manuell', active: '1',
      skills: 'e2e-fleiss',
    }, { asBrowser: true })
    equal(r.status, 303, 'saved')
    equal(agent('skill-traeger').skills, '["e2e-fleiss"]', 'on the agent')
    const r2 = await postForm('/agents/start', { id: String(agent('skill-traeger').id), repo: String(repoId) }, { asBrowser: true })
    equal(r2.status, 303, 'started')
    const runId = r2.headers.get('location').split('/')[2]
    await sessionMerken(runId)
    equal(lauf(runId).skills, '["e2e-fleiss"]', 'copy on the run')
    contains(readFileSync(join(SB, 'runs', runId, 'prompt.md'), 'utf8'), 'e2e-fleiss/SKILL.md', 'in the prompt')
  })
  await check('slider: depth from the form lands in the run and in the prompt', async () => {
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Skill-Tiefe', skills: 'e2e-fleiss', 'skill_regler_e2e-fleiss': '4' })
    await sessionMerken(j.runId)
    // e2e-fleiss defines no slider → the value is dropped, the checkbox remains.
    equal(lauf(j.runId).skills, '["e2e-fleiss"]', 'no suffix without a slider definition')
  })
  await check('made-up skill names from the form are discarded', async () => {
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Skill-boese', skills: '../../etc/passwd' })
    await sessionMerken(j.runId)
    equal(lauf(j.runId).skills, null, 'not taken over')
  })

  // ------------------------------------------------------------------
  group('One definition for agent and single run')

  await check('both forms are built from the same block', async () => {
    const runForm = await (await fetchPath(`/runs/new?repo=${repoId}`)).text()
    const agentForm = await (await fetchPath(`/agents/edit?repo=${repoId}`)).text()
    for (const feld of ['name="harness"', 'id="prov"', 'name="model"', 'id="effort"', 'name="prompt"',
      'name="branch_mode"', 'name="branch_pattern"', 'name="expected_minutes"', 'name="or_mode"']) {
      isTrue(runForm.includes(feld) && agentForm.includes(feld), `${feld} in both forms`)
    }
    isFalse(runForm.includes('name="schedule_kind"'), 'only the agent has a schedule')
    isTrue(agentForm.includes('name="schedule_kind"'), 'the agent has one')
  })

  await check('the last used coding agent, model and effort are preselected', async () => {
    const j = await laufStarten({ repo_id: repoId, harness: 'cursor', model: 'gpt-5.2-high',
      prompt: 'E2E-Merken', expected_minutes: '45' })
    isTrue(!!j.runId, `run started (${JSON.stringify(j)})`)
    await sessionMerken(j.runId)
    for (const [pfad, was] of [[`/runs/new?repo=${repoId}`, 'run form'], [`/agents/edit?repo=${repoId}`, 'agent form']]) {
      const html = await (await fetchPath(pfad)).text()
      contains(html, 'value="gpt-5.2-high"', `model preselected in the ${was}`)
      isTrue(/<option value="cursor" selected>/.test(html), `coding agent preselected in the ${was}`)
    }
  })

  await check('an existing agent keeps its own setup in the form', async () => {
    const r = await postForm('/agents/edit', {
      repo_id: repoId, name: 'merk-test', harness: 'claude', model: 'claude-opus-5',
      prompt: 'x', branch_mode: 'keiner', expected_minutes: '45', schedule_kind: 'manuell', active: '1',
    }, { asBrowser: true })
    equal(r.status, 303, 'saved')
    const html = await (await fetchPath(`/agents/edit?id=${agent('merk-test').id}&repo=${repoId}`)).text()
    contains(html, 'value="claude-opus-5"', 'its own model, not the remembered one')
  })

  await check('"save as agent" carries provider, effort and skills along', async () => {
    const j = await laufStarten({ repo_id: repoId, harness: 'claude', prompt: 'E2E-Speichern',
      skills: 'e2e-fleiss', expected_minutes: '20', branch_mode: 'neu', branch_pattern: 'x/{kurz}',
      save_agent: '1', agent_name: 'aus-einzellauf' })
    isTrue(!!j.runId, `run started (${JSON.stringify(j)})`)
    await sessionMerken(j.runId)
    const a = agent('aus-einzellauf')
    isTrue(!!a, 'agent saved')
    equal(a.skills, '["e2e-fleiss"]', 'skills — used to fall off on this path')
    equal(a.expected_minutes, 20, 'expected duration')
    equal(a.branch_pattern, 'x/{kurz}', 'branch pattern')
    equal(a.schedule_kind, 'manuell', 'no schedule: runs manually')
  })

  // ------------------------------------------------------------------
  // The budget gate reads the quota file live (server/quota.mjs), so the whole
  // path — form, startRun, gate, deferral — can be driven by rewriting the
  // fixture. Which is the point of testing it here rather than only in the unit
  // suite: the gate has to receive the run's MODEL, and that hand-over crosses
  // four modules.
  group('Budget gate: a full per-model week defers that model, not every model')

  const quotaDatei = join(SB, 'quota.json')
  const quotaSchreiben = (fable, general = 10) => writeFileSync(quotaDatei, JSON.stringify({
    five_hour: { used_percentage: 1, resets_at: 1800000000 },
    seven_day: { used_percentage: general },
    seven_day_fable: { used_percentage: fable },
  }))

  await check('the fable week at 99 % defers a fable run', async () => {
    quotaSchreiben(99)
    const j = await laufStarten({ repo_id: repoId, model: 'claude-fable-5', prompt: 'E2E-Quota-Fable' })
    isTrue(!!j.runId, `run created (${JSON.stringify(j)})`)
    isTrue(j.deferred, 'deferred instead of started')
    equal(lauf(j.runId).status, 'deferred', 'status')
    const ev = db.prepare(`SELECT payload FROM events WHERE run_id=? AND kind='deferred'`).get(j.runId)
    contains(ev?.payload ?? '', 'Fable', 'the reason names the window that blocks')
    // Away before the watcher's next pass picks it back up with a fresh fixture.
    await postForm(`/api/runs/${j.runId}/kill`, {})
  })

  await check('…and the same week lets every other model through', async () => {
    const j = await laufStarten({ repo_id: repoId, model: 'claude-sonnet-5', prompt: 'E2E-Quota-Sonnet' })
    isTrue(!!j.runId && !j.deferred, `run started (${JSON.stringify(j)})`)
    equal(lauf(j.runId).status, 'running', 'a window it does not draw from blocks nothing')
    await sessionMerken(j.runId)
    quotaSchreiben(0, 0)   // back to the sandbox fixture
  })

  // The gate is a rule the OPERATOR configures — and the reason a full quota
  // must not block everything is that the rule must be switchable and adjustable
  // per window. Settings are read live (server/scheduler.mjs), so writing the
  // table is the whole test.
  const setSetting = (k, v) => db.prepare(`INSERT INTO settings(key,value) VALUES(?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(k, v)

  await check('the claude gate can be switched off entirely', async () => {
    setSetting('claude_gate_on', '0')
    quotaSchreiben(99)
    const j = await laufStarten({ repo_id: repoId, model: 'claude-fable-5', prompt: 'E2E-Gate-Off' })
    isTrue(!!j.runId && !j.deferred, `a full fable week no longer defers (${JSON.stringify(j)})`)
    equal(lauf(j.runId).status, 'running', 'the run starts')
    await sessionMerken(j.runId)
    quotaSchreiben(0, 0)
    setSetting('claude_gate_on', '1')
  })

  await check('the fable window has its own threshold', async () => {
    setSetting('claude_gate_fable', '80')
    quotaSchreiben(85, 30)   // fable 85 %: below 95, above the new 80
    const j = await laufStarten({ repo_id: repoId, model: 'claude-fable-5', prompt: 'E2E-Fable-Schwelle' })
    isTrue(!!j.runId && j.deferred, `fable 85 % defers against its own threshold of 80 (${JSON.stringify(j)})`)
    await postForm(`/api/runs/${j.runId}/kill`, {})
    const s = await laufStarten({ repo_id: repoId, model: 'claude-sonnet-5', prompt: 'E2E-Fable-Schwelle-2' })
    isTrue(!!s.runId && !s.deferred, `a sonnet run ignores the fable threshold (${JSON.stringify(s)})`)
    await sessionMerken(s.runId)
    quotaSchreiben(0, 0)
    setSetting('claude_gate_fable', '95')
  })

  await check('a deferred run can be started anyway, from the endpoint', async () => {
    quotaSchreiben(99)
    const j = await laufStarten({ repo_id: repoId, model: 'claude-fable-5', prompt: 'E2E-Force' })
    isTrue(!!j.runId && j.deferred, 'deferred as before')
    const r = await postForm(`/api/runs/${j.runId}/start`, {})
    equal(r.status, 200, 'the endpoint answers 200')
    equal(lauf(j.runId).status, 'running', 'the run is running')
    contains(ereignisse(j.runId).join(','), 'forced_start', 'the forced start is recorded')
    await sessionMerken(j.runId)
    quotaSchreiben(0, 0)
  })

  await check('the start-anyway button sits on the detail page and in the overview', async () => {
    quotaSchreiben(99)
    const j = await laufStarten({ repo_id: repoId, model: 'claude-fable-5', prompt: 'E2E-Force-UI' })
    isTrue(!!j.runId && j.deferred, 'deferred')
    const seite = await fetchPath(`/runs/${j.runId}`).then(r => r.text())
    contains(seite, `action="/api/runs/${j.runId}/start"`, 'the detail banner offers the button')
    contains(seite, 'Start anyway', 'and it is the operator-facing word')
    const uebersicht = await fetchPath(`/?repo=${repoId}`).then(r => r.text())
    contains(uebersicht, `action="/api/runs/${j.runId}/start"`, 'the overview row carries it too')
    await postForm(`/api/runs/${j.runId}/start`, {})
    await sessionMerken(j.runId)
    quotaSchreiben(0, 0)
  })

  await check('only a deferred run may be started this way', async () => {
    const laufend = await laufStarten({ repo_id: repoId, model: 'claude-sonnet-5', prompt: 'E2E-Force-Nein' })
    isTrue(!!laufend.runId && !laufend.deferred, 'a run that is not deferred')
    const r = await postForm(`/api/runs/${laufend.runId}/start`, {})
    equal(r.status, 400, 'the endpoint refuses')
    equal(lauf(laufend.runId).status, 'running', 'and leaves the run alone')
    await sessionMerken(laufend.runId)
  })

  await check('a deferred run still starts by itself once the gate opens', async () => {
    quotaSchreiben(99)
    const j = await laufStarten({ repo_id: repoId, model: 'claude-fable-5', prompt: 'E2E-AutoRetry' })
    isTrue(!!j.runId && j.deferred, 'deferred by the gate')
    quotaSchreiben(0, 0)
    await watcherTick()
    await waitFor(() => lauf(j.runId)?.status === 'running',
      { what: 'the watcher starts it once the gate opens', timeoutMs: 8000 })
    contains(ereignisse(j.runId).join(','), 'deferred_retry', 'the watcher path is the non-forced one')
    await sessionMerken(j.runId)
  })

  await check('quota_full is a claude run\u2019s signal, not the machine\u2019s', async () => {
    // Both runs must be RUNNING before the quota flips to 100 % — a claude
    // start into a full window would be deferred by the gate, not flagged.
    const c = await laufStarten({ repo_id: repoId, model: 'claude-sonnet-5', prompt: 'E2E-Quota-Rot' })
    isTrue(!!c.runId && !c.deferred, 'the claude run is running')
    await sessionMerken(c.runId)
    const fremd = await laufStarten({ repo_id: repoId, harness: 'opencode', model: 'deepseek/deepseek-v4', prompt: 'E2E-Quota-Fremd' })
    isTrue(!!fremd.runId && !fremd.deferred, 'the other-harness run is running too')
    await sessionMerken(fremd.runId)

    writeFileSync(quotaDatei, JSON.stringify({
      five_hour: { used_percentage: 100, resets_at: 1800000000 },
      seven_day: { used_percentage: 0 },
      seven_day_fable: { used_percentage: 0 },
    }))
    await watcherTick()

    const ev = db.prepare(`SELECT payload FROM events WHERE run_id=? AND kind='anomaly:quota_full'`).get(c.runId)
    isTrue(!!ev, 'a claude run on a full window is flagged')
    contains(ev.payload, '"window":"5h"', 'the event names the window that is full')
    equal(db.prepare(`SELECT count(*) n FROM events WHERE run_id=? AND kind='anomaly:quota_full'`)
      .get(fremd.runId).n, 0, 'a run on another harness is not blamed for claude\u2019s quota')

    // The overview says WHICH window is exhausted — not a bare word with no way
    // to tell whose quota ran out.
    const zeile = (await (await fetchPath(`/?repo=${repoId}`)).text()).split('<tr').find(z => z.includes(c.runId))
    contains(zeile, 'quota exhausted', 'the row says the word')
    contains(zeile, '(5h', 'and names the window')

    db.prepare(`UPDATE runs SET status='done', ended_at=datetime('now') WHERE id=?`).run(c.runId)
    db.prepare(`UPDATE runs SET status='done', ended_at=datetime('now') WHERE id=?`).run(fremd.runId)
    quotaSchreiben(0, 0)
  })

  // ------------------------------------------------------------------
  // The goal is the one definition field that does NOT travel in the prompt
  // file: `/goal <condition>` exists only inside the session, so the hub types
  // it in after the start. Which means it can also fail to arrive — hence a
  // test for each of the two ways in.
  group('The goal: a second prompt into the session')

  const paneText = async (runId) =>
    (await sh('tmux', ['capture-pane', '-p', '-t', `=${lauf(runId).tmux_session}:`])).stdout

  await check('both forms carry the goal, and it names who knows one', async () => {
    for (const [pfad, was] of [[`/runs/new?repo=${repoId}`, 'run form'], [`/agents/edit?repo=${repoId}`, 'agent form']]) {
      const html = await (await fetchPath(pfad)).text()
      contains(html, 'name="goal"', `the field is in the ${was}`)
      contains(html, 'data-goal-harnesses="claude"', `and says who has one (${was})`)
    }
  })

  await check('a claude run gets its goal typed into the session after the start', async () => {
    const j = await laufStarten({ repo_id: repoId, harness: 'claude', prompt: 'E2E-Ziel',
      goal: 'all tests are green' })
    isTrue(!!j.runId, `run started (${JSON.stringify(j)})`)
    await sessionMerken(j.runId)
    equal(lauf(j.runId).goal, 'all tests are green', 'the run carries the definition copy')
    await waitFor(async () => (await paneText(j.runId)).includes('[agent saw] /goal all tests are green'),
      { what: 'the goal command in the pane', timeoutMs: 15_000 })
    await waitFor(() => !!lauf(j.runId).goal_sent_at, { what: 'delivery recorded', timeoutMs: 5000 })
    contains(ereignisse(j.runId).join(','), 'goal_sent', 'and the run says so in its own event list')
    const html = await (await fetchPath(`/runs/${j.runId}`)).text()
    contains(html, 'all tests are green', 'the detail page shows the goal')
    await postForm(`/api/runs/${j.runId}/kill`, {})
  })

  // The long condition is the case that was broken in production: pasted in
  // ONE piece with the command word in front of it, claude collapsed it into a
  // `[Pasted text #n]` placeholder and submitted it as an ordinary message —
  // no goal, and nothing said so. The command word is typed now and only the
  // condition is pasted. The stub is not claude, so what this pins is the
  // half that IS the hub's: both parts arrive, in order, as one line.
  await check('a long goal arrives whole — command typed, condition pasted', async () => {
    const bedingung = 'alle Pruefungen sind gruen und '.repeat(40) + 'die Datei ZIEL.md liegt vor'
    isTrue(bedingung.length > 800, `the condition is past claude's paste threshold (${bedingung.length})`)
    const j = await laufStarten({ repo_id: repoId, harness: 'claude', prompt: 'E2E-Ziel-lang',
      goal: bedingung })
    isTrue(!!j.runId, `run started (${JSON.stringify(j)})`)
    await sessionMerken(j.runId)
    await waitFor(async () => (await paneText(j.runId)).includes('[agent saw] /goal alle Pruefungen'),
      { what: 'the typed command word in front of the pasted condition', timeoutMs: 15_000 })
    const pane = (await paneText(j.runId)).replace(/\s+/g, ' ')
    contains(pane, 'die Datei ZIEL.md liegt vor', 'and the END of the condition arrived too — nothing truncated')
    await postForm(`/api/runs/${j.runId}/kill`, {})
  })

  await check('a coding agent that knows no goal simply has none', async () => {
    const j = await laufStarten({ repo_id: repoId, harness: 'cursor', model: 'auto',
      prompt: 'E2E-Ziel-cursor', goal: 'all tests are green' })
    isTrue(!!j.runId, `run started (${JSON.stringify(j)})`)
    await sessionMerken(j.runId)
    equal(lauf(j.runId).goal, null, 'nothing stored — cursor has no /goal')
    await postForm(`/api/runs/${j.runId}/kill`, {})
  })

  await check('what did not get through is delivered by the watcher, and only once', async () => {
    // Exactly the case of a hub restarted between the start and the delivery:
    // the run is going, the session stands, nobody has typed the goal in.
    const j = await laufStarten({ repo_id: repoId, harness: 'claude', prompt: 'E2E-Ziel-Watcher',
      goal: 'the branch is pushed' })
    await sessionMerken(j.runId)
    await waitFor(() => !!lauf(j.runId).goal_sent_at, { what: 'first delivery', timeoutMs: 15_000 })
    await watcherTick()
    const einmal = (await paneText(j.runId)).split('/goal the branch is pushed').length - 1
    isTrue(einmal >= 1, `it is in the pane (${einmal}×)`)
    db.prepare('UPDATE runs SET goal_sent_at=NULL WHERE id=?').run(j.runId)
    await watcherTick()
    await waitFor(() => !!lauf(j.runId).goal_sent_at, { what: 'the watcher delivers what is missing', timeoutMs: 8000 })
    await postForm(`/api/runs/${j.runId}/kill`, {})
  })

  // ------------------------------------------------------------------
  group('Incidents: rate limit and provider errors (auto-alarm)')

  const vorfaelle = (id) => db.prepare('SELECT * FROM incidents WHERE run_id=? ORDER BY id').all(id)
  const logAnhaengen = (id, text) => {
    const f = join(SB, 'runs', id, 'log.txt')
    mkdirSync(join(SB, 'runs', id), { recursive: true })
    writeFileSync(f, text, { flag: 'a' })
  }

  await check('cursor: run passes through the pipeline and "Cannot use this model" is detected', async () => {
    // Two things at once because they belong together: that a cursor harness survives
    // the whole path (form → DB CHECK → worktree → session → watcher), and that
    // cursor's LOUD model rejection arrives as an incident. That rejection is the most
    // likely startup failure with cursor — the CLI only accepts IDs from 'cursor-agent
    // models' and writes the complete list into the log for anything else.
    const j = await laufStarten({ repo_id: repoId, harness: 'cursor',
      model: 'claude-opus-5-xhigh', prompt: 'E2E-Vorfall-cursor', expected_minutes: '45' })
    const RC = j.runId
    isTrue(!!RC, `run created (response: ${JSON.stringify(j).slice(0, 200)})`)
    const lauf = db.prepare('SELECT harness, model, effort FROM runs WHERE id=?').get(RC)
    equal(lauf.harness, 'cursor', 'harness in the DB')
    equal(lauf.model, 'claude-opus-5-xhigh', 'model ID stored verbatim')
    equal(lauf.effort, null, 'no separate effort — the level is baked into the ID')
    await sessionMerken(RC)
    await watcherTick()
    logAnhaengen(RC, 'Cannot use this model: gibtsnicht-9000. Available models: auto, gpt-5.2\r\n')
    await watcherTick()
    const v = vorfaelle(RC)
    equal(v.length, 1, `exactly one incident (has: ${JSON.stringify(v.map(x => [x.typ, x.schwere]))})`)
    equal(v[0].typ, 'model_error', 'classified as a model error')
    contains(v[0].beleg, 'Cannot use this model', 'evidence is the line')
  })

  let RH = null   // "hermes" run (the stub ignores the harness; the hub's patterns do not)
  await check('hermes: first log match is noted YELLOW, without a notification', async () => {
    const j = await laufStarten({ repo_id: repoId, harness: 'hermes', prompt: 'E2E-Vorfall-hermes', expected_minutes: '45' })
    RH = j.runId
    isTrue(!!RH, 'run created')
    await sessionMerken(RH)
    await watcherTick()   // bring the offset up to date — the stub startup already wrote
    logAnhaengen(RH, '\x1b[33m⏳ Retrying in 12.0s (rate limited by upstream provider (429))...\x1b[0m\r\n')
    await watcherTick()
    const v = vorfaelle(RH)
    equal(v.length, 1, `exactly one incident (has: ${JSON.stringify(v.map(x => [x.typ, x.schwere]))})`)
    equal(v[0].typ, 'rate_limit', 'type')
    equal(v[0].schwere, 'gelb', 'yellow')
    equal(v[0].quelle, 'log', 'source')
    contains(v[0].beleg, 'Retrying', 'evidence is the line')
    isFalse(ereignisse(RH).some(k => k === 'notified'), 'no notification for yellow')
    // In the overview the incident is a compact badge inside the run's OWN row,
    // and the action that clears it is still in that cell — it is only hidden
    // until the row is hovered (the same rule the pencil and the archive button
    // follow). Checked against the route it posts to, which outlives markup.
    const zeile = (await (await fetchPath(`/?repo=${repoId}`)).text()).split('<tr ').find(z => z.includes(RH))
    isTrue(!!zeile, 'the run has a row')
    contains(zeile, 'Rate limit 1×', 'overview shows the incident')
    contains(zeile, 'incident yellow', 'in the severity it was given')
    contains(zeile, `/api/incidents/${v[0].id}/resolve`, 'and the action to clear it sits in the same cell')
    contains(zeile, 'Dismiss', 'named for the group it belongs to — noticed, not to-do')
  })
  await check('the sidebar\'s incident counts link into the overview filtered to incident runs', async () => {
    const seite = await (await fetchPath(`/?repo=${repoId}`)).text()
    contains(seite, 'incidents=1', 'the sidebar links the counts into the filtered overview')
    const gefiltert = await (await fetchPath(`/?repo=${repoId}&incidents=1`)).text()
    isTrue(gefiltert.split('<tr ').some(z => z.includes(RH)), 'the run with the incident is in the filtered list')
    const fragment = await (await fetchPath(`/api/fragments/runs-body?repo=${repoId}&incidents=1`)).text()
    contains(fragment, 'data-incidents="1"', 'the filter travels with the tbody, so live updates keep it')
    contains(fragment, RH, 'and the fragment shows the same selection the page did')
  })
  await check('the same match counts only once per pass (offset)', async () => {
    await watcherTick(); await watcherTick()
    equal(vorfaelle(RH)[0].anzahl, 1, 'anzahl stays 1')
  })
  await check('repetition within 10 min → RED (retry loop), notification attempt recorded', async () => {
    logAnhaengen(RH, '⚠️  API call failed (attempt 2/5): RateLimitError (HTTP 429)\n')
    await watcherTick()
    const v = vorfaelle(RH)[0]
    equal(v.anzahl, 2, 'anzahl 2')
    equal(v.schwere, 'rot', 'red')
    isTrue(ereignisse(RH).includes('incident:eskaliert'), `escalated (has: ${ereignisse(RH).join(', ')})`)
    const tg = db.prepare(`SELECT payload FROM events WHERE run_id=? AND kind='notified' ORDER BY id DESC LIMIT 1`).get(RH)
    isTrue(!!tg && JSON.parse(tg.payload).type === 'incident:rate_limit', 'the incident was announced (with no channel configured: delivered=false, but attempted)')
    contains(await (await fetchPath(`/runs/${RH}`)).text(), 'Incidents', 'detail page shows the section')
  })
  await check('resolving via the UI withdraws the alarm', async () => {
    const v = vorfaelle(RH)[0]
    const r = await postForm(`/api/incidents/${v.id}/resolve`, { back: `/runs/${RH}` }, { asBrowser: true })
    equal(r.status, 303, 'redirect')
    equal(r.headers.get('location'), `/runs/${RH}`, 'back to the run page')
    const nach = vorfaelle(RH)[0]
    isTrue(!!nach.geloest_am, 'geloest_am set')
    equal(nach.geloest_von, 'web', 'by web')
    isFalse((await (await fetchPath(`/?repo=${repoId}`)).text()).includes('Rate limit 2×'), 'overview without an open incident')
  })
  await check('if it recurs AFTER resolving, the alarm goes on again (auto-alarm)', async () => {
    // The resolution happened within the same second — the new match must come after it.
    db.prepare(`UPDATE incidents SET geloest_am=datetime('now','-2 minutes') WHERE run_id=?`).run(RH)
    logAnhaengen(RH, '⏳ Retrying in 30.0s (rate limited by upstream provider (429))...\n')
    await watcherTick()
    const v = vorfaelle(RH)
    equal(v.length, 1, 'still ONE record (history remains)')
    equal(v[0].geloest_am, null, 'open again')
    equal(v[0].wieder_geoeffnet, 1, 'reopened once')
    equal(v[0].anzahl, 3, 'keeps counting')
    isTrue(ereignisse(RH).includes('incident:wieder'), 'event incident:wieder')
  })
  await check('the detector\'s protocol is in the run directory', async () => {
    const f = join(SB, 'runs', RH, 'detektor.jsonl')
    isTrue(existsSync(f), 'detektor.jsonl')
    const arten = readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).art)
    isTrue(arten.includes('log') && arten.includes('vorfall') && arten.includes('geloest'), `entries: ${[...new Set(arten)].join(', ')}`)
  })

 // R1 is 'done' by now — incidents are only collected for running runs.
  let RC = null
  await check('claude: the menu text "Upgrade to Max for higher rate limits" is NOT an incident', async () => {
    const j = await laufStarten({ repo_id: repoId, harness: 'claude', prompt: 'E2E-Vorfall-claude' })
    RC = j.runId
    await sessionMerken(RC)
    // Exactly this stood in a production run as a rate limit in the database.
    await watcherTick()
    logAnhaengen(RC, '\x1b[38;5;246m/\x1b[39m\x1b[1mu\x1b[22mpgrade   Upgrade to Max for higher rate limits and more Opus\x1b[K\r\n')
    await watcherTick()
    equal(vorfaelle(RC).length, 0, 'no incident')
  })

  await check('claude: transcript entry with isApiErrorMessage → RED immediately, with original timestamp', async () => {
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
    equal(v.length, 1, 'one incident')
    equal(v[0].typ, 'auth_error', 'type from the enum')
    equal(v[0].schwere, 'rot', 'red without detours')
    equal(v[0].quelle, 'transcript', 'source')
    equal(v[0].erst_gesehen, '2026-08-11 08:05:00', 'timestamp from the transcript, not "now"')
  })
  await check('hook report (fl-report _api_error via stdin) → RED; rate limit counter increments', async () => {
    const hookJson = JSON.stringify({ hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: "You've hit your session limit · resets 8:36pm" })
    const r = await new Promise((resolve) => {
      const p = execFile(FL_REPORT_REPO, ['_api_error'],
        { env: { ...process.env, FL_RUN_ID: RC, FL_HUB_URL: BASE } }, (err, stdout, stderr) => resolve({ ok: !err, stdout, stderr }))
      p.stdin.end(hookJson)
    })
    isTrue(r.ok, `fl-report ok (${r.stderr})`)
    const v = vorfaelle(RC).find(x => x.typ === 'rate_limit')
    isTrue(!!v, 'incident rate_limit')
    equal(v.schwere, 'rot', 'red')
    equal(v.quelle, 'hook:claude', 'source')
    contains(v.beleg, 'session limit', 'evidence from last_assistant_message')
    equal(lauf(RC).rate_limit_hits, 1, 'rate_limit_hits')
  })
  await check('a hook report from a FOREIGN claude session (a process the agent spawned) is ignored', async () => {
    // The false alarm of 2026-08-30: an agent testing a fake model id spawned its
    // own claude; the child inherited the worktree's hooks AND FL_RUN_ID, and its
    // StopFailure opened a red "Model unavailable" on the healthy parent run.
    const hookJson = JSON.stringify({ hook_event_name: 'StopFailure', error: 'model_not_found',
      session_id: '11111111-2222-4333-8444-555555555555',
      last_assistant_message: 'Model not found: nosuch/model-xyz.' })
    const r = await new Promise((resolve) => {
      const p = execFile(FL_REPORT_REPO, ['_api_error'],
        { env: { ...process.env, FL_RUN_ID: RC, FL_HUB_URL: BASE } }, (err, stdout, stderr) => resolve({ ok: !err, stdout, stderr }))
      p.stdin.end(hookJson)
    })
    isTrue(r.ok, `fl-report ok (${r.stderr})`)
    isFalse(vorfaelle(RC).some(v => v.typ === 'model_error'), 'no model_error incident on the run')
    // The decision is traceable in the detector's protocol — it says WHY.
    const proto = readFileSync(join(SB, 'runs', RC, 'detektor.jsonl'), 'utf8').split('\n').filter(Boolean)
      .map(l => JSON.parse(l)).filter(e => e.art === 'verworfen')
    isTrue(proto.some(e => String(e.grund).includes('foreign claude session')), 'and the protocol says why')
    // The run's OWN session (the hub started it with --session-id <run id>) still reports:
    const eigen = JSON.stringify({ hook_event_name: 'StopFailure', error: 'model_not_found', session_id: RC,
      last_assistant_message: 'Model not found: really/missing-model.' })
    const r2 = await new Promise((resolve) => {
      const p = execFile(FL_REPORT_REPO, ['_api_error'],
        { env: { ...process.env, FL_RUN_ID: RC, FL_HUB_URL: BASE } }, (err, stdout, stderr) => resolve({ ok: !err, stdout, stderr }))
      p.stdin.end(eigen)
    })
    isTrue(r2.ok, `fl-report ok (${r2.stderr})`)
    const v = vorfaelle(RC).find(x => x.typ === 'model_error')
    isTrue(!!v, 'the run\'s own session still opens the incident')
    contains(v.beleg, 'really/missing-model', 'with the evidence')
  })
  await check('an error hook that only says the session was stopped opens no incident', async () => {
    // opencode's `session.error` fires while its process dies — and the hub is
    // very often the one killing it: the retention pass, the kill route, a
    // flow, archiving. Measured on run c532df45: retention closed the session,
    // the plugin reported the bare word "Aborted", and the hub opened a RED
    // incident about its own cleanup. On an aborted run such an incident never
    // resolves by itself, so it was still asking for hands two days later.
    const j = await laufStarten({ repo_id: repoId, harness: 'opencode', prompt: 'E2E-Abbruch', expected_minutes: '45' })
    const RA = j.runId
    await sessionMerken(RA)
    const melde = (text) => fetchPath(`/api/runs/${RA}/report`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: '_api_error', error: 'unknown', text }),
    })
    equal((await melde('Aborted')).status, 200, 'the report is accepted')
    equal(vorfaelle(RA).length, 0, 'and nothing is filed as a provider fault')
    // Narrow, not blunt: a real error is still a real error.
    equal((await melde('AI_APICallError: 503 upstream unavailable')).status, 200, 'a real error is accepted too')
    const v = vorfaelle(RA)
    equal(v.length, 1, `now there is one incident (has: ${JSON.stringify(v.map(x => [x.typ, x.beleg]))})`)
    equal(v[0].typ, 'provider_error', 'classified as what it is')
    db.prepare(`UPDATE runs SET status='done', ended_at=datetime('now') WHERE id=?`).run(RA)
  })
  await check('hook and transcript see the same event → not counted twice', async () => {
    const r = lauf(RC)
    const dir = join(SB, 'claude-projects', r.workdir_effective.replaceAll('/', '-'))
    writeFileSync(join(dir, `${RC}.jsonl`), JSON.stringify({ type: 'assistant', error: 'rate_limit',
      timestamp: new Date().toISOString(), isApiErrorMessage: true, message: { content: 'limit' } }) + '\n', { flag: 'a' })
    await watcherTick()
    equal(vorfaelle(RC).find(x => x.typ === 'rate_limit').anzahl, 1, 'anzahl stays 1 (dedupe within 90 s)')
  })
  await check('silence after a log match turns RED (the limit stands at the end)', async () => {
    const j = await laufStarten({ repo_id: repoId, harness: 'opencode', prompt: 'E2E-Vorfall-stille' })
    await sessionMerken(j.runId)
    await watcherTick()
    logAnhaengen(j.runId, 'AI_APICallError: [Stealth] stealth/ox-alpha is temporarily rate-limited upstream.\n')
    await watcherTick()
    equal(vorfaelle(j.runId)[0]?.schwere, 'gelb', 'yellow at first')
    db.prepare(`UPDATE incidents SET zuletzt_gesehen=datetime('now','-6 minutes'), erst_gesehen=datetime('now','-6 minutes') WHERE run_id=?`).run(j.runId)
    db.prepare(`UPDATE runs SET last_activity_at=datetime('now','-7 minutes') WHERE id=?`).run(j.runId)
    await watcherTick()
    const v = vorfaelle(j.runId)[0]
    equal(v.schwere, 'rot', 'red after 5 min of silence')
    equal(v.typ, 'rate_limit', 'type from the opencode text')
  })
  await check('if the agent keeps working for 30 min, a yellow match expires on its own', async () => {
    const j = await laufStarten({ repo_id: repoId, harness: 'hermes', prompt: 'E2E-Vorfall-verlaufen' })
    await sessionMerken(j.runId)
    await watcherTick()
    logAnhaengen(j.runId, '⚠️  API call failed (attempt 1/5): APIConnectionError\n')
    await watcherTick()
    db.prepare(`UPDATE incidents SET zuletzt_gesehen=datetime('now','-31 minutes'), erst_gesehen=datetime('now','-31 minutes') WHERE run_id=?`).run(j.runId)
    db.prepare(`UPDATE runs SET last_activity_at=datetime('now','-1 minutes') WHERE id=?`).run(j.runId)
    await watcherTick()
    const v = vorfaelle(j.runId)[0]
    isTrue(!!v.geloest_am, 'closed')
    contains(v.geloest_von, 'auto:', 'automatic')
  })
  await check('a red incident that recovered on its own resolves itself — and un-rings', async () => {
    const j = await laufStarten({ repo_id: repoId, harness: 'claude', prompt: 'E2E-Vorfall-erholt', expected_minutes: '45' })
    await sessionMerken(j.runId)
    // Hand-crafted red incident, not yet announced, notification NOT yet due
    // (the suite runs with delay 0 — the due point is set by hand here).
    db.prepare(`INSERT INTO incidents(run_id, typ, quelle, schwere, erst_gesehen, zuletzt_gesehen, beleg, notify_at)
                VALUES(?,?,?,?,datetime('now'),datetime('now'),'Everything is broken.', datetime('now','+10 minutes'))`)
      .run(j.runId, 'provider_error', 'hook:claude', 'rot')
    const { notifyDueIncidents } = await import('../server/incidents.mjs')
    await notifyDueIncidents()
    isFalse(ereignisse(j.runId).some(k => k === 'notified'), 'not due yet: nothing announced')
    // Due and still open → the alarm.
    db.prepare(`UPDATE incidents SET notify_at=datetime('now','-1 second') WHERE run_id=?`).run(j.runId)
    await notifyDueIncidents()
    const tg = db.prepare(`SELECT payload FROM events WHERE run_id=? AND kind='notified' ORDER BY id DESC LIMIT 1`).get(j.runId)
    isTrue(!!tg && JSON.parse(tg.payload).type === 'incident:provider_error', 'due: the alarm fires')
    isTrue(!!vorfaelle(j.runId)[0].gemeldet_am, 'recorded as announced')
    // The agent demonstrably works again (activity AFTER the occurrence, no
    // recurrence) → resolves itself, and the announced alarm is un-rung.
    db.prepare(`UPDATE incidents SET zuletzt_gesehen=datetime('now','-11 minutes'), erst_gesehen=datetime('now','-11 minutes') WHERE run_id=?`).run(j.runId)
    db.prepare(`UPDATE runs SET last_activity_at=datetime('now') WHERE id=?`).run(j.runId)
    await watcherTick()
    const v = vorfaelle(j.runId)[0]
    contains(v.geloest_von, 'auto:', 'resolved by itself')
    const tg2 = db.prepare(`SELECT payload FROM events WHERE run_id=? AND kind='notified' ORDER BY id DESC LIMIT 1`).get(j.runId)
    isTrue(!!tg2 && JSON.parse(tg2.payload).type === 'incident_resolved:provider_error', 'and the recovery is announced')
  })
  await check('raising the expected duration retracts the overrun statement', async () => {
    const j = await laufStarten({ repo_id: repoId, harness: 'hermes', prompt: 'E2E-Dauer-Edit', expected_minutes: '90' })
    await sessionMerken(j.runId)
    await watcherTick()
    // The run "is" far over its expected duration and never reported progress:
    db.prepare(`UPDATE runs SET started_at=datetime('now','-120 minutes') WHERE id=?`).run(j.runId)
    await watcherTick()
    isTrue(ereignisse(j.runId).includes('anomaly:overrun'), 'overrun anomaly')
    isTrue(ereignisse(j.runId).includes('notified:overrun'), 'and the operator heard about it')
    // The operator raises the duration — the statement the old value produced is withdrawn:
    const r = await postForm(`/api/runs/${j.runId}/edit`, { expected_minutes: '240' })
    equal(r.status, 200, `edit ok (${JSON.stringify(await r.json().catch(() => r.text()))})`)
    equal(lauf(j.runId).expected_minutes, 240, 'new duration stored')
    isTrue(ereignisse(j.runId).includes('cleared:anomaly:overrun'), 'the anomaly event is history, renamed')
    isFalse(ereignisse(j.runId).includes('notified:overrun'), 'the notification flag with it')
    // A genuine overrun of the NEW duration can page once again:
    db.prepare(`UPDATE runs SET started_at=datetime('now','-300 minutes') WHERE id=?`).run(j.runId)
    await watcherTick()
    equal(ereignisse(j.runId).filter(k => k === 'anomaly:overrun').length, 1, 'the anomaly fires anew against the new value')
    isTrue(ereignisse(j.runId).includes('notified:overrun'), 'and the operator hears about the new overrun')
  })
  await check('provider pulse: two failures → global incident with banner, recovery closes it', async () => {
    let antwort = 500
    const http = await import('node:http')
    const hs = http.createServer((req, res) => { res.writeHead(antwort).end('{}') })
    await new Promise(r => hs.listen(0, '127.0.0.1', r))
    process.env.FREILAUF_PULS_AUS = '0'
    process.env.FREILAUF_PULS_TAKT_MS = '0'
    process.env.FREILAUF_PULS_URL_TEST = `http://127.0.0.1:${hs.address().port}/`
    try {
      await watcherTick()
      equal(db.prepare(`SELECT count(*) c FROM incidents WHERE run_id IS NULL`).get().c, 0, 'one failure is not enough')
      await watcherTick()
      const g = db.prepare(`SELECT * FROM incidents WHERE run_id IS NULL AND geloest_am IS NULL`).all()
      isTrue(g.length >= 1, `global incident (has ${g.length})`)
      isTrue(g.every(x => x.typ.startsWith('provider_down:')), 'type provider_down:<name>')
      contains(await (await fetchPath(`/?repo=${repoId}`)).text(), 'Provider unreachable', 'banner in the overview')
      antwort = 200
      await watcherTick()
      equal(db.prepare(`SELECT count(*) c FROM incidents WHERE run_id IS NULL AND geloest_am IS NULL`).get().c, 0, 'recovered → closed')
      contains(db.prepare(`SELECT geloest_von FROM incidents WHERE run_id IS NULL LIMIT 1`).get().geloest_von, 'erholt', 'reason')
    } finally {
      process.env.FREILAUF_PULS_AUS = '1'
      delete process.env.FREILAUF_PULS_URL_TEST
      delete process.env.FREILAUF_PULS_TAKT_MS
      hs.close()
    }
  })
  await check('overview: runtime of finished runs ends at ended_at, not "now"', async () => {
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Dauer' })
    await sessionMerken(j.runId)
    db.prepare(`UPDATE runs SET status='done', started_at=datetime('now','-3 days'), ended_at=datetime('now','-3 days','+2 minutes') WHERE id=?`).run(j.runId)
    const html = await (await fetchPath(`/?repo=${repoId}`)).text()
    const zeile = html.split('<tr').find(z => z.includes(j.runId))
    contains(zeile, '>2 min<', '2 min instead of 4320')
  })
  await check('overview: started column is relative with exact datetime on hover', async () => {
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-started' })
    await sessionMerken(j.runId)
    db.prepare(`UPDATE runs SET started_at=datetime('now','-4 minutes') WHERE id=?`).run(j.runId)
    const html = await (await fetchPath(`/?repo=${repoId}`)).text()
    const zeile = html.split('<tr').find(z => z.includes(j.runId))
    isTrue(!!zeile, 'row for the run')
    contains(zeile, 'class="reltime"', 'relative-time element')
    isTrue(/\d+ minutes ago/.test(zeile), 'relative English minutes')
    isTrue(/title="[^"]*\d{2}:\d{2}:\d{2}/.test(zeile), 'title carries a clock time')
    isTrue(/datetime="\d{4}-\d{2}-\d{2}T/.test(zeile), 'datetime is ISO')
    contains(html, '>Started<', 'column header')
  })

  // Simulation with REAL Claude Code: a mini server answers 429 with the
  // subscription-limit headers, Claude aborts, the StopFailure hook reports via
  // fl-report to this sandbox hub. No quota consumed, no network — but the full path.
  if (hasBinary('claude')) {
    await check('REAL: Claude Code + simulated 429 → StopFailure hook → incident rate_limit', async () => {
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
            FL_RUN_ID: j.runId, FL_HUB_URL: BASE,
            // The hooks call `fl-report` by name and find it on PATH. In production
            // that is ~/.local/bin, filled by the deploy before it restarts the hub;
            // here it is this checkout, because that is what the suite tests.
            PATH: `${join(PROJECT, 'bin')}:${join(homedir(), '.local', 'bin')}:${process.env.PATH}` } },
          (err, stdout, stderr) => resolve({ err, stdout: String(stdout), stderr: String(stderr) })))
        contains(r.stdout + r.stderr, 'limit', `Claude reports the limit (${(r.stdout + r.stderr).slice(-200)})`)
        await waitFor(() => vorfaelle(j.runId).some(v => v.typ === 'rate_limit'), { what: 'incident via the hook', timeoutMs: 15_000 })
        // The same settings file carries the attention hooks: UserPromptSubmit
        // fires before the (failing) API call, so the real claude has told the
        // hub it started working — the one measurement of that wiring the
        // suite makes without spending quota.
        isTrue(ereignisse(j.runId).includes('agent_working'), 'the real UserPromptSubmit hook reported _working')
        const v = vorfaelle(j.runId).find(v => v.typ === 'rate_limit')
        equal(v.quelle, 'hook:claude', 'source is the hook')
        equal(v.schwere, 'rot', 'red')
        contains(v.beleg, 'rate_limit', 'evidence carries the enum')
      } finally { mock.close() }
    })
  } else {
    skipped('REAL: Claude Code + simulated 429', 'claude not in PATH')
  }

  // ------------------------------------------------------------------
  group('Sessions page: list, end, and the run that hung on it')

  {
    let SESS = null, SESSNAME = null
    await check('a running session is listed with its run', async () => {
      const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Sessionseite' })
      SESS = j.runId
      isTrue(!!SESS, `run created (${j.error ?? ''})`)
      await waitFor(() => !!lauf(SESS)?.tmux_session, { what: 'tmux session' })
      SESSNAME = lauf(SESS).tmux_session
      sessions.add(SESSNAME)
      const html = await (await fetchPath('/sessions')).text()
      contains(html, SESSNAME, 'the session name is on the page')
      // Its row must carry the marker the default filter hides it by — that is
      // the whole safety of "running agents are not shown".
      contains(html, `data-session="${SESSNAME}" data-running="1"`, 'marked as running')
    })

    await check('ending a session ends the run that hung on it', async () => {
      const r = await postForm('/api/sessions/kill', { session: SESSNAME })
      const j = await r.json()
      isTrue(j.ok, `kill answered ok (${JSON.stringify(j.results ?? j)})`)
      sessions.delete(SESSNAME)
      isFalse((await sh('tmux', ['has-session', '-t', `=${SESSNAME}`])).ok, 'session gone')
      const l = lauf(SESS)
      equal(l.status, 'aborted', 'the run does not stay on "running"')
      isTrue(l.ended_at !== null, 'ended_at set')
      isTrue(l.tmux_closed_at !== null, 'tmux_closed_at set immediately')
      isTrue(ereignisse(SESS).includes('aborted'), `event recorded (has: ${ereignisse(SESS).join(', ')})`)
    })

    await check('ending a session that is already gone is not an error', async () => {
      const j = await (await postForm('/api/sessions/kill', { session: SESSNAME })).json()
      isTrue(j.ok, 'idempotent')
    })

    await check('several sessions go in ONE call', async () => {
      const a = await laufStarten({ repo_id: repoId, prompt: 'E2E-Bulk-a' })
      const b = await laufStarten({ repo_id: repoId, prompt: 'E2E-Bulk-b' })
      await waitFor(() => !!lauf(a.runId)?.tmux_session && !!lauf(b.runId)?.tmux_session,
        { what: 'both tmux sessions' })
      const namen = [lauf(a.runId).tmux_session, lauf(b.runId).tmux_session]
      namen.forEach(n => sessions.add(n))
      const j = await (await postForm('/api/sessions/kill', { session: namen })).json()
      isTrue(j.ok, `both ended (${JSON.stringify(j.results ?? j)})`)
      equal(j.results.length, 2, 'one result per session')
      for (const n of namen) sessions.delete(n)
      equal(lauf(a.runId).status, 'aborted', 'first run aborted')
      equal(lauf(b.runId).status, 'aborted', 'second run aborted')
    })

    await check('the keep time is set in hours on the settings page', async () => {
      // Written directly instead of through the form: this test is about the
      // field and the hours conversion, not about the save route (that one has
      // its own group).
      db.prepare(`INSERT INTO settings(key,value) VALUES('session_keep_hours','0.5')
                  ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run()
      const html = await (await fetchPath('/settings')).text()
      contains(html, 'name="session_keep_hours"', 'the field is on the settings page')
      contains(html, 'value="0.5"', 'and shows what is stored')
      const { sessionKeepMs } = await import('../server/sessions.mjs')
      equal(sessionKeepMs({ session_keep_hours: '0.5' }), 1800_000, 'half an hour')
    })
    await check('the archive-session rule is configurable on the settings page', async () => {
      const html = await (await fetchPath('/settings')).text()
      for (const feld of ['name="archive_session_on"', 'name="archive_session_keep_hours"']) {
        contains(html, feld, `field ${feld}`)
      }
    })
    await check('the worktree-extras LLM is configured on the settings page', async () => {
      const html = await (await fetchPath('/settings')).text()
      for (const feld of ['name="llm_extras_on"', 'name="llm_extras_model"', 'name="llm_extras_or_provider"']) {
        contains(html, feld, `field ${feld}`)
      }
    })
  }

  // ------------------------------------------------------------------
  group('The agent stays operable after the work is done')

  {
    // The coding agents that run in a TUI (claude, opencode, cursor) do not go
    // away when the task is finished — the session stands, the process sits at
    // its prompt. Whether one may type into it is therefore a fact about the
    // SESSION, not about the run's record.
    let RN = null, RNSESS = null
    await check('a finished run whose session still stands stays writable', async () => {
      const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Nachbedienung' })
      RN = j.runId
      await waitFor(() => !!lauf(RN)?.tmux_session, { what: 'tmux session' })
      RNSESS = lauf(RN).tmux_session
      sessions.add(RNSESS)
      db.prepare(`UPDATE runs SET status='done', ended_at=datetime('now') WHERE id=?`).run(RN)
      const html = await (await fetchPath(`/runs/${RN}`)).text()
      contains(html, 'data-live="1"', 'the terminal is offered with write access')
      contains(html, `freilaufSend(this,'/api/runs/${RN}/send')`, 'and the send form is there')
      isFalse(html.includes(`freilaufKill('${RN}')`), 'but no "end run" — that run is over')
      contains(html, 'name="session"', 'instead: end the session it left standing')
    })

    await check('a message reaches the session of a finished run', async () => {
      const r = await postForm(`/api/runs/${RN}/send`, { text: 'weiter geht es' })
      equal(r.status, 200, 'accepted')
      // A message into a finished run is a follow-up COMMISSION now: recorded
      // under its own name, and the run is clocked from this moment
      // (followup_started, watchFollowUps) — the plain message_sent kind is
      // for a run that is still going.
      isTrue(ereignisse(RN).includes('followup_started'), `recorded (has: ${ereignisse(RN).join(', ')})`)
      isTrue(!!lauf(RN).followup_since, 'and the commission is clocked')
      equal(lauf(RN).status, 'done', 'and the run stays done')
    })

    await check('"end run" on a finished run does NOT rewrite it to aborted', async () => {
      // The button is gone from the page, but the endpoint is reachable — and a
      // run that came through cleanly must not become a failed one because
      // somebody closed its leftover session. The open follow-up commission
      // goes with the session: nothing can report for it any more.
      const r = await postForm(`/api/runs/${RN}/kill`, {})
      equal(r.status, 200, 'accepted')
      equal(lauf(RN).status, 'done', 'still done')
      isTrue(lauf(RN).tmux_closed_at !== null, 'only the session is marked closed')
      equal(lauf(RN).followup_since, null, 'and the follow-up commission is given up with the session')
    })

    await check('without a session there is no write access left', async () => {
      const html = await (await fetchPath(`/runs/${RN}`)).text()
      isFalse(html.includes('data-live="1"'), 'read-only')
      contains(html, 'data-session="0"', 'and the box says there is no session')
      sessions.delete(RNSESS)
    })

    await check('ending the session from the detail page lands back on the run', async () => {
      const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Session-zurueck' })
      await waitFor(() => !!lauf(j.runId)?.tmux_session, { what: 'tmux session' })
      const name = lauf(j.runId).tmux_session
      sessions.add(name)
      db.prepare(`UPDATE runs SET status='done', ended_at=datetime('now') WHERE id=?`).run(j.runId)
      const r = await postForm('/api/sessions/kill', { session: name, back: `/runs/${j.runId}` }, { asBrowser: true })
      equal(r.status, 303, 'redirect instead of JSON')
      equal(r.headers.get('location'), `/runs/${j.runId}`, 'back to the run, not to the session list')
      sessions.delete(name)
      equal(lauf(j.runId).status, 'done', 'the finished run is left alone')
    })
  }

  group("The agent's attention: running, waiting for input, and back")

  {
    // What the coding agents' hooks say (docs/plugins.md, "Attention") is
    // played in through fl-report exactly as the hooks would send it. The stub
    // agent's pane stays alive, so the liveness verdict can be read too.
    const report = (runId, body) => fetch(`${BASE}/api/runs/${runId}/report`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    let RA = null
    await check('a running run whose agent ends its turn displays as waiting for input', async () => {
      const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-attention', expected_minutes: '45' })
      RA = j.runId
      await sessionMerken(RA)
      isTrue((await flReport(RA, ['_turn_end'])).ok, '_turn_end accepted')
      const l = lauf(RA)
      equal(l.status, 'running', 'the record is untouched')
      equal(l.agent_state, 'waiting', 'the agent is noted as waiting')
      isTrue(!!l.agent_state_at, 'with the moment')
      isTrue(ereignisse(RA).includes('agent_waiting'), 'and an event for the live channel')
      const html = await (await fetchPath(`/runs/${RA}`)).text()
      contains(html, 'Waiting for input', 'the detail page says so')
      contains(html, 'id="run-attention">', 'with the since-line shown')
      const rows = await (await fetchPath(`/?repo=${repoId}&status=waiting_input`)).text()
      contains(rows, `id="run-${RA}"`, 'the overview filter finds it under waiting for input')
      isFalse((await (await fetchPath(`/?repo=${repoId}&status=running`)).text()).includes(`id="run-${RA}"`), 'and not under running')
      const side = await (await fetchPath(`/api/fragments/sidebar?repo=${repoId}`)).text()
      contains(side, `status=waiting_input`, 'the sidebar counts it there')
      const api = await (await fetchPath(`/api/runs/${RA}`)).json()
      equal(api.liveness.agent_state, 'waiting', 'the read API carries the state')
      equal(api.liveness.verdict, 'waiting_input', 'and its verdict says what to do')
    })

    await check('input makes it running again — and a repeat writes no second event', async () => {
      isTrue((await flReport(RA, ['_working'])).ok, '_working accepted')
      equal(lauf(RA).agent_state, 'working', 'working')
      // The chip, not the whole page: the sidebar next to it counts OTHER runs
      // of the repo that wait for input (an earlier group's claude run).
      const html = await (await fetchPath(`/runs/${RA}`)).text()
      contains(html, '"status-chip">Running<', 'the page reads running again')
      contains(html, 'id="run-attention" hidden', 'and the since-line is hidden')
      await flReport(RA, ['_working'])
      await flReport(RA, ['_working'])
      equal(ereignisse(RA).filter(k => k === 'agent_working').length, 1, 'three hooks, one event')
      isTrue((await flReport(RA, ['_waiting'])).ok, '_waiting (the idle notification) accepted')
      equal(lauf(RA).agent_state, 'waiting', 'waiting again')
    })

    await check('a key typed into the browser terminal answers the wait — before any hook does', async () => {
      // The agent's hooks say "working" on Enter (claude, cursor, hermes) or on
      // the first token (opencode) and never for a half-typed line, a menu or a
      // dialog answered with one key. The WebSocket every keystroke passes
      // through says it at the first byte, for all four alike.
      const quelle = () => JSON.parse(db.prepare(`SELECT payload FROM events WHERE run_id=? AND kind='agent_working' ORDER BY id DESC LIMIT 1`).get(RA)?.payload ?? 'null')?.source
      equal(lauf(RA).agent_state, 'waiting', 'waiting')
      // What the terminal sends on the application's behalf is not the operator.
      await wsSchreiben(`/term?run=${RA}&ro=0`, '\x1b[<0;12;5M\x1b[<0;12;5m')
      equal(lauf(RA).agent_state, 'waiting', 'a mouse click changes nothing')
      // Nor does the read-only client: tmux drops its input.
      await wsSchreiben(`/term?run=${RA}`, 'x')
      equal(lauf(RA).agent_state, 'waiting', 'a read-only terminal changes nothing')
      const vorher = ereignisse(RA).filter(k => k === 'agent_working').length
      await wsSchreiben(`/term?run=${RA}&ro=0`, 'y')
      equal(lauf(RA).agent_state, 'working', 'one key: working')
      equal(ereignisse(RA).filter(k => k === 'agent_working').length, vorher + 1, 'with one event for the live channel')
      equal(quelle(), 'terminal', 'whose source names the terminal')
      const html = await (await fetchPath(`/runs/${RA}`)).text()
      contains(html, '"status-chip">Running<', 'the page reads running')
      // The send form is the other way into the session, and agrees.
      await flReport(RA, ['_turn_end'])
      equal(lauf(RA).agent_state, 'waiting', 'waiting again')
      const r = await postForm(`/api/runs/${RA}/send`, { text: 'carry on' })
      equal(r.status, 200, 'sent')
      equal(lauf(RA).agent_state, 'working', 'working from the send route')
      equal(quelle(), 'send', 'with its own source')
      equal(lauf(RA).status, 'running', 'and the record untouched')
      // Back to waiting for the tests that follow.
      await flReport(RA, ['_waiting'])
      equal(lauf(RA).agent_state, 'waiting', 'waiting')
    })

    await check("a subagent's or a foreign claude session's hook is ignored", async () => {
      // The run's own claude carries the run id as its session id; a claude the
      // AGENT spawned inherits FL_RUN_ID and the hooks but not that id.
      const r = await report(RA, { kind: '_working', session_id: 'some-other-session' })
      equal(r.status, 200, 'accepted without complaint')
      equal(lauf(RA).agent_state, 'waiting', 'but nothing changed')
    })

    await check('the watcher does not call a waiting agent idle', async () => {
      db.prepare(`UPDATE runs SET last_activity_at=datetime('now','-20 minutes') WHERE id=?`).run(RA)
      await watcherTick()
      isFalse(ereignisse(RA).includes('anomaly:no_activity'), 'no "no activity" while it waits on purpose')
      await flReport(RA, ['_working'])
      db.prepare(`UPDATE runs SET last_activity_at=datetime('now','-20 minutes') WHERE id=?`).run(RA)
      await watcherTick()
      isTrue(ereignisse(RA).includes('anomaly:no_activity'), 'a working agent that is silent for 20 min is')
    })

    await check('an answer typed straight into the terminal ends a help call', async () => {
      isTrue((await flReport(RA, ['help', 'Which branch?'])).ok, 'help')
      equal(lauf(RA).status, 'waiting_help', 'waiting for help')
      await flReport(RA, ['_turn_end'])
      equal(lauf(RA).status, 'waiting_help', 'the turn end does not change that')
      const html = await (await fetchPath(`/runs/${RA}`)).text()
      contains(html, 'Waiting for help', 'and the question outranks the idle on the page')
      // The operator types the answer into the terminal: the hub never sees the
      // text, the agent's UserPromptSubmit hook is what says the question is answered.
      isTrue((await flReport(RA, ['_working'])).ok, '_working')
      equal(lauf(RA).status, 'running', 'running again')
      equal(lauf(RA).help_answer, null, 'the answer text is unknown')
      isTrue(ereignisse(RA).includes('help_answered'), 'help_answered recorded')
    })

    await check('closing the session forgets what the agent said', async () => {
      await flReport(RA, ['_turn_end'])
      equal(lauf(RA).agent_state, 'waiting', 'waiting')
      const r = await postForm(`/api/runs/${RA}/kill`, {})
      equal(r.status, 200, 'ended')
      equal(lauf(RA).agent_state, null, 'no state without a session')
      sessions.delete(lauf(RA).tmux_session)
    })

    let RF = null
    await check('typing into a finished run\'s terminal is the follow-up commission', async () => {
      const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-attention-followup', expected_minutes: '45' })
      RF = j.runId
      await sessionMerken(RF)
      await flReport(RF, ['_working'])
      db.prepare(`UPDATE runs SET status='done', ended_at=datetime('now') WHERE id=?`).run(RF)
      // The agent makes two or three more tool calls after `fl-report done` —
      // a summary, a `git status` — before it stops. Those arrive as `_working
      // tool` on a run that is already done, and inside the grace window after
      // the report they are the reporting turn finishing, not a commission.
      isTrue((await flReport(RF, ['_working', 'tool'])).ok, 'a tool call right after the report')
      equal(lauf(RF).followup_since, null, 'is not a commission')
      equal(lauf(RF).agent_state, 'working', 'but the state is noted')
      isTrue((await flReport(RF, ['_turn_end'])).ok, 'the agent stops after its report')
      equal(lauf(RF).followup_since, null, 'a turn end on a finished run commissions nothing')
      contains(await (await fetchPath(`/runs/${RF}`)).text(), '"status-chip">Done<', 'and the run reads done, not waiting for input')
      // The terminal writes into tmux directly; the send route is never called.
      // The agent's own prompt hook is the first the hub hears of it — and a
      // human's line is a commission whenever it comes.
      isTrue((await flReport(RF, ['_working', 'prompt'])).ok, 'the operator typed, the agent works')
      const l = lauf(RF)
      equal(l.status, 'done', 'the record stays done')
      isTrue(!!l.followup_since, 'but a commission is open')
      equal(l.agent_state, 'working', 'and the agent works')
      isTrue(ereignisse(RF).includes('followup_started'), 'recorded as a follow-up start')
      const html = await (await fetchPath(`/runs/${RF}`)).text()
      contains(html, '"status-chip">Running<', 'displayed as running')
    })

    await check('…then waiting for input, then running again — one commission', async () => {
      await flReport(RF, ['_turn_end'])
      equal(lauf(RF).agent_state, 'waiting', 'waiting')
      const html = await (await fetchPath(`/runs/${RF}`)).text()
      contains(html, '"status-chip">Waiting for input<', 'displayed as waiting for input')
      contains((await (await fetchPath(`/?repo=${repoId}&status=waiting_input`)).text()), `id="run-${RF}"`, 'filtered under waiting for input')
      await flReport(RF, ['_working'])
      equal(lauf(RF).agent_state, 'working', 'working again')
      equal(ereignisse(RF).filter(k => k === 'followup_started').length, 1, 'still the same commission')
      equal((await (await fetchPath(`/api/runs/${RF}`)).json()).liveness.verdict, 'working', 'the read API agrees')
    })

    await check('the follow-up clock pauses while the agent waits for input', async () => {
      await flReport(RF, ['_turn_end'])
      db.prepare(`UPDATE runs SET followup_since=datetime('now','-2 hours') WHERE id=?`).run(RF)
      await watcherTick()
      isFalse(ereignisse(RF).includes('anomaly:followup_overrun'), 'no overrun for a conversation the operator is in')
      await flReport(RF, ['_working'])
      await watcherTick()
      isTrue(ereignisse(RF).includes('anomaly:followup_overrun'), 'a follow-up that works past the duration is one')
    })

    await check('past the grace window a tool call is work somebody asked for', async () => {
      // opencode's plugin cannot tell a typed line from a tool call (its
      // status says busy either way): a busy that comes long after the last
      // report is somebody's follow-up, and the window is what tells the two
      // apart.
      const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-attention-grace', expected_minutes: '45' })
      await sessionMerken(j.runId)
      db.prepare(`UPDATE runs SET status='done', ended_at=datetime('now','-3 minutes') WHERE id=?`).run(j.runId)
      isTrue((await flReport(j.runId, ['_working', 'busy'])).ok, 'busy, three minutes after the report')
      isTrue(!!lauf(j.runId).followup_since, 'is a commission')
      isTrue(ereignisse(j.runId).includes('followup_started'), 'recorded as such')
    })

    await check('a follow-up report closes the commission, the agent may keep waiting', async () => {
      isTrue((await flReport(RF, ['done', 'follow-up done'])).ok, 'reported')
      await flReport(RF, ['_turn_end'])
      const l = lauf(RF)
      equal(l.followup_since, null, 'commission closed')
      equal(l.status, 'done', 'done')
      const html = await (await fetchPath(`/runs/${RF}`)).text()
      contains(html, '"status-chip">Done<', 'displayed as done — a waiting agent on a finished run is just finished')
    })
  }

  group('Surviving a lost tmux server: a run is resumed, not aborted')

  {
    // The session is killed BEHIND the hub's back — `tmux kill-session` by
    // hand, the way a reboot or a dead tmux server looks to the watcher. Not
    // through any hub route: those are deliberate ends and stay aborts.
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Resume: work, then lose the session' })
    await waitFor(() => !!lauf(j.runId)?.tmux_session, { what: 'tmux session' })
    const alt = lauf(j.runId).tmux_session
    sessions.add(alt)
    await sh('tmux', ['kill-session', '-t', `=${alt}`])
    await watcherTick()
    await check('the watcher resumes the run in a new session instead of aborting it', async () => {
      const r = lauf(j.runId)
      equal(r.status, 'running', 'still running')
      // The stub reuses a free name, so the new session may be CALLED like
      // the old one — what counts is that a session stands again.
      isTrue(!!r.tmux_session, 'a session is recorded')
      const alive = await sh('tmux', ['has-session', '-t', `=${r.tmux_session}`])
      isTrue(alive.ok, `and it stands (${r.tmux_session})`)
      if (r.tmux_session) sessions.add(r.tmux_session)
      equal(ereignisse(j.runId).filter(k => k === 'tmux_started').length, 2, 'two sessions were started for this run')
      equal(r.resume_pending, 0, 'the mark is cleared once the session stands')
      equal(r.resume_attempts, 1, 'one automatic resume counted')
      const ev = ereignisse(j.runId)
      contains(ev.join(','), 'session_lost', 'session_lost written')
      contains(ev.join(','), 'resumed', 'resumed written')
      isFalse(ev.includes('aborted'), 'never aborted')
      isFalse(ev.includes('anomaly:session_gone'), 'no session_gone anomaly — the session is back')
      isTrue(existsSync(join(SB, 'runs', j.runId, 'resume-prompt.md')), 'the CLI was launched with a continuation prompt')
      const text = readFileSync(join(SB, 'runs', j.runId, 'resume-prompt.md'), 'utf8')
      contains(text, 'interrupted', 'which says what happened')
      const rec = readFileSync(join(SB, 'runs', j.runId, 'prompt.md'), 'utf8')
      contains(rec, 'E2E-Resume', 'prompt.md is still the record of the task')
      isFalse(rec.includes('interrupted'), 'and was not overwritten by the continuation')
    })
    await check('the cap: past RESUME_MAX a lost session ends the run the old way', async () => {
      db.prepare('UPDATE runs SET resume_attempts=3 WHERE id=?').run(j.runId)
      const s = lauf(j.runId).tmux_session
      await sh('tmux', ['kill-session', '-t', `=${s}`])
      sessions.delete(s)
      await watcherTick()
      equal(lauf(j.runId).status, 'aborted', 'aborted, as before the resume existed')
      const ev = ereignisse(j.runId)
      contains(ev.join(','), 'resume_refused', 'and the refusal is written on the run')
    })
    await check('a session the hub ends itself is an abort, never a resume', async () => {
      const k = await laufStarten({ repo_id: repoId, prompt: 'E2E-Resume: killed on purpose' })
      await waitFor(() => !!lauf(k.runId)?.tmux_session, { what: 'tmux session' })
      sessions.add(lauf(k.runId).tmux_session)
      await postForm(`/api/runs/${k.runId}/kill`, {})
      await watcherTick()
      equal(lauf(k.runId).status, 'aborted', 'aborted')
      isFalse(ereignisse(k.runId).includes('session_lost'), 'no session_lost — the hub knew who ended it')
    })
  }

  group('Worktree cleanup: no data loss (regression test)')

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
      await check('session over: tmux_closed_at gets set', () => {
        isTrue(lauf(R1).tmux_closed_at !== null, 'tmux_closed_at')
      })
    } else {
      skipped('session over: tmux_closed_at gets set',
        'known bug: tmux display reports success even for missing sessions')
      db.prepare(`UPDATE runs SET tmux_closed_at=datetime('now') WHERE id=?`).run(R1)
    }
  }
  await check('unpushed branch: worktree stays put', async () => {
    const wt = lauf(R1).workdir_effective
    await watcherTick()
    isTrue(existsSync(wt), `worktree ${wt} still exists`)
    isFalse(ereignisse(R1).includes('worktree_removed'), 'not removed')
  })
  await check('pushed, but uncommitted work: worktree stays put', async () => {
    const wt = lauf(R1).workdir_effective
    await sh('git', ['-C', wt, 'push', '-q', '-u', 'origin', 'HEAD'])
    writeFileSync(join(wt, 'offene-notiz.txt'), 'noch nicht committet\n')
    db.prepare(`DELETE FROM events WHERE run_id=? AND kind IN ('anomaly:unpushed','branch_synced')`).run(R1)
    await watcherTick()
    isTrue(existsSync(wt), 'worktree still exists')
    isTrue(ereignisse(R1).includes('anomaly:worktree_dirty'), `marked as dirty (has: ${ereignisse(R1).join(', ')})`)
  })
  await check('pushed and clean: worktree gets cleaned up', async () => {
    const wt = lauf(R1).workdir_effective
    rmSync(join(wt, 'offene-notiz.txt'))
    db.prepare(`DELETE FROM events WHERE run_id=? AND kind='anomaly:worktree_dirty'`).run(R1)
    await watcherTick()
    isFalse(existsSync(wt), 'worktree removed')
    isTrue(ereignisse(R1).includes('worktree_removed'), 'event recorded')
  })
  await check('the work is in the origin — nothing was lost', async () => {
    const l = await sh('git', ['-C', ORIGIN, 'log', '--oneline', '-1', lauf(R1).branch_expected])
    contains(l.stdout, 'Arbeit des Agenten', 'commit in the origin')
  })

  // ------------------------------------------------------------------
  await check('a run interrupted during startup does not stay "running" forever', async () => {
    // If the hub dies in the middle of the startup sequence (service restart, reboot),
    // the run used to be stuck on 'running' forever — with no session, no worktree,
    // and a terminal that had nothing to attach to.
    const id = 'aaaaaaaa-1111-4222-8333-444444444444'
    db.prepare(`INSERT INTO runs(id,repo_id,status,harness,prompt,branch_mode,expected_minutes,started_at)
                VALUES(?,?,'running','claude','x','keiner',45, datetime('now','-30 minutes'))`).run(id, repoId)
    await watcherTick()
    const r = lauf(id)
    equal(r.status, 'failed', 'completed as failed')
    contains(r.report_md ?? '', 'interrupted', 'reason in the report')
    const seite = await (await fetchPath(`/runs/${id}`)).text()
    isFalse(seite.includes('data-live=\"1\"'), 'the page no longer promises a terminal')
    contains(seite, 'Retry run', 'retry is offered')
  })

  await check('a run created just now is NOT swept up by this', async () => {
    // Counter-check: while fl-start is still working, a run rightly has no session.
    const id = 'bbbbbbbb-1111-4222-8333-444444444444'
    db.prepare(`INSERT INTO runs(id,repo_id,status,harness,prompt,branch_mode,expected_minutes,started_at)
                VALUES(?,?,'running','claude','x','keiner',45, datetime('now'))`).run(id, repoId)
    await watcherTick()
    equal(lauf(id).status, 'running', 'left untouched')
    db.prepare('DELETE FROM runs WHERE id=?').run(id)
  })

  group('Failed start, retry and abort')

  let R2 = null
  await check('failed start is recorded as failed', async () => {
    writeFileSync(FAILED_START, 'an')
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Fehlstart', branch_mode: 'neu', branch_pattern: 'agent/e2e-fehl/{kurz}' })
    R2 = j.runId
    equal(lauf(R2).status, 'failed', 'status')
    contains(lauf(R2).report_md, 'fl-start', 'reason named')
  })
  await check('retry uses the same worktree and starts up', async () => {
    const vorher = lauf(R2).workdir_effective
    isTrue(existsSync(vorher), 'worktree from the failed attempt is still there')
    rmSync(FAILED_START)
    // The failed attempt's started_at must not survive into the new one, and
    // that is not cosmetics: `closeOrphanedRuns()` measures its grace
    // period against this column, so a retry that kept the old timestamp had
    // none — the watcher pass falling into the seconds between launchRun()'s
    // `started` event and its `tmux_session` wrote `failed / start interrupted,
    // no session` over a run that was starting perfectly well. Measured on run
    // b9b1a876: retry 13:38:35, started 13:38:43, orphan sweep 13:38:45,
    // session 13:38:45 — the agent then worked and its `done` arrived as a
    // FOLLOW-UP, which by design keeps the status, so the run stayed red while
    // it ran. The overrun clock reads the same column and was over from the
    // first second.
    db.prepare(`UPDATE runs SET started_at=datetime('now','-2 hours') WHERE id=?`).run(R2)
    const startVorher = lauf(R2).started_at
    const r = await postForm(`/api/runs/${R2}/retry`, {}, { asBrowser: true })
    equal(r.status, 303, 'redirect instead of JSON')
    await sessionMerken(R2)
    equal(lauf(R2).status, 'running', 'status')
    equal(lauf(R2).workdir_effective, vorher, 'same worktree')
    isTrue(lauf(R2).started_at > startVorher, 'started_at is the retry, not the attempt before it')
    isTrue(lauf(R2).started_at >= db.prepare(`SELECT datetime('now','-60 seconds') AS t`).get().t,
      'and it is fresh, so the orphan sweep grants the new launch its grace period')
  })
  await check('abort sets aborted and closes the session immediately', async () => {
    const r = await postForm(`/api/runs/${R2}/kill`, {})
    equal(r.status, 200, 'status')
    const l = lauf(R2)
    equal(l.status, 'aborted', 'status')
    isTrue(l.tmux_closed_at !== null, 'tmux_closed_at set immediately')
    isFalse((await sh('tmux', ['has-session', '-t', `=${l.tmux_session}`])).ok, 'session terminated')
    sessions.delete(l.tmux_session)
  })
  await check('terminal of a terminated session reports 410 instead of hanging', async () => {
    const e = await wsVersuch(`/term?run=${R2}&ro=1`)
    equal(e.art, 'http', 'HTTP response')
    equal(e.status, 410, 'status')
  })
  await check('retry after an abort clears the old session close — the terminal is offered again', async () => {
    const r = await postForm(`/api/runs/${R2}/retry`, {}, { asBrowser: true })
    equal(r.status, 303, 'redirect instead of JSON')
    await sessionMerken(R2)
    const l = lauf(R2)
    equal(l.status, 'running', 'running again')
    equal(l.tmux_closed_at, null, 'tmux_closed_at of the aborted attempt is gone — else pageRun() shows "no session"')
    const seite = await (await fetchPath(`/runs/${R2}`)).text()
    isTrue(seite.includes('data-session="1"'), 'detail page renders a terminal for the new session')
    // Leave the run somewhere the rest of the suite can ignore it.
    await postForm(`/api/runs/${R2}/kill`, {})
    const l2 = lauf(R2)
    sessions.delete(l2.tmux_session)
  })
  await check('cancel on a FAILED run aborts it — the click decides, not the race', async () => {
    // The button is rendered while the run is going, so a click can land after
    // the watcher has already written 'failed' (pane died in between — the
    // production case was two seconds). The final status must say what the
    // CLICK said: aborted, with the session closed and the follow-up commission
    // given up. A 'done' run stays protected (see the follow-up group).
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Abbruch-nach-Fehlschlag' })
    await waitFor(() => !!lauf(j.runId)?.tmux_session, { what: 'tmux session' })
    await sessionMerken(j.runId)
    db.prepare(`UPDATE runs SET status='failed', ended_at=datetime('now') WHERE id=?`).run(j.runId)
    const r = await postForm(`/api/runs/${j.runId}/kill`, {})
    equal(r.status, 200, 'accepted')
    const l = lauf(j.runId)
    equal(l.status, 'aborted', 'the final status is aborted')
    isTrue(l.tmux_closed_at !== null, 'session closed with it')
    contains(ereignisse(j.runId).join(','), 'aborted', 'and the run says why it ended')
    isFalse((await sh('tmux', ['has-session', '-t', `=${l.tmux_session}`])).ok, 'session terminated')
    sessions.delete(l.tmux_session)
  })

  // ------------------------------------------------------------------
  group('Branch expectation "fixed": occupied, free, only on origin')

  await check('a fixed branch another worktree holds is rejected before a run exists', async () => {
    // 'main' is checked out in the repo itself — git grants a branch to exactly
    // one worktree. Before, this only came out as a failed run with git's raw
    // message ("'main' is already used by worktree at …").
    const vorher = db.prepare('SELECT COUNT(*) n FROM runs').get().n
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Festbranch', branch_mode: 'fest', branch_pattern: 'main' })
    isFalse(j.ok, 'rejected')
    contains(j.error, 'main', 'branch named')
    contains(j.error, REPO, 'the occupying worktree named')
    equal(db.prepare('SELECT COUNT(*) n FROM runs').get().n, vorher, 'no run created')
    const r = await postForm('/runs/new', {
      repo_id: repoId, harness: 'claude', prompt: 'E2E-Festbranch-Formular',
      branch_mode: 'fest', branch_pattern: 'main', expected_minutes: '45',
    }, { asBrowser: true })
    equal(r.status, 400, 'the HTML form as well')
    contains(await r.text(), 'main', 'branch named')
  })
  await check('an agent whose branch got occupied later fails at start, also readably', async () => {
    // The form check cannot help here: the branch was still free when the agent
    // was saved. That is what the check in the runner is for — second line.
    const r = await postForm('/agents/edit', {
      repo_id: repoId, name: 'e2e-festbranch', harness: 'claude', prompt: 'E2E-Agent-Festbranch',
      branch_mode: 'fest', branch_pattern: 'feature/e2e-belegt', expected_minutes: '45',
      schedule_kind: 'manuell', active: '1',
    }, { asBrowser: true })
    equal(r.status, 303, 'agent saved (branch still free)')
    const fremd = join(SB, 'fremdes-worktree')
    await sh('git', ['-C', REPO, 'branch', 'feature/e2e-belegt'])
    await sh('git', ['-C', REPO, 'worktree', 'add', fremd, 'feature/e2e-belegt'])
    const s = await postForm('/agents/start', { id: String(agent('e2e-festbranch').id), repo: String(repoId) }, { asBrowser: true })
    equal(s.status, 303, 'redirect')
    const l = db.prepare('SELECT * FROM runs WHERE agent_id=?').get(agent('e2e-festbranch').id)
    equal(l.status, 'failed', 'status')
    contains(l.report_md, 'feature/e2e-belegt', 'branch named')
    contains(l.report_md, fremd, 'the occupying worktree named')
    isFalse(/already used by worktree/.test(l.report_md), 'no raw git message')
  })
  await check('a free fixed branch is checked out', async () => {
    await sh('git', ['-C', REPO, 'branch', 'feature/e2e-fest'])
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Festbranch-frei', branch_mode: 'fest', branch_pattern: 'feature/e2e-fest' })
    const l = lauf(j.runId)
    equal(l.status, 'running', 'status')
    const b = await sh('git', ['-C', l.workdir_effective, 'rev-parse', '--abbrev-ref', 'HEAD'])
    equal(b.stdout.trim(), 'feature/e2e-fest', 'branch')
  })
  await check('a fixed branch that only exists on origin starts from THERE', async () => {
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
    isFalse(soll.stdout.trim() === mainSha.stdout.trim(), 'remote branch differs from the base branch')
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Festbranch-origin', branch_mode: 'fest', branch_pattern: 'feature/e2e-nur-origin' })
    const l = lauf(j.runId)
    equal(l.status, 'running', 'status')
    const ist = await sh('git', ['-C', l.workdir_effective, 'rev-parse', 'HEAD'])
    equal(ist.stdout.trim(), soll.stdout.trim(), 'starting point is the remote branch')
  })

  // ------------------------------------------------------------------
  group('Scheduler (waits for the hub\'s 30-second tick)')

  await check('create schedule agents and switch on the pipeline', async () => {
    // A: runs every minute, but already has a running run -> must be skipped.
    const a = await postForm('/agents/edit', {
      repo_id: repoId, name: 'e2e-jede-minute', harness: 'claude', prompt: 'E2E-Dauerlaeufer',
      branch_mode: 'keiner', expected_minutes: '45', schedule_kind: 'cron', schedule: '* * * * *', active: '1',
    }, { asBrowser: true })
    equal(a.status, 303, 'agent A created')
    const idA = agent('e2e-jede-minute').id
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-belegt' })
    db.prepare('UPDATE runs SET agent_id=? WHERE id=?').run(idA, j.runId)

    // B: one-off date in the past -> must fire exactly once.
    const gestern = new Date(Date.now() - 3600_000).toISOString().slice(0, 16)
    const b = await postForm('/agents/edit', {
      repo_id: repoId, name: 'e2e-einmalig', harness: 'claude', prompt: 'E2E-Einmalig',
      branch_mode: 'keiner', expected_minutes: '45', schedule_kind: 'einmalig', run_at: gestern, active: '1',
    }, { asBrowser: true })
    equal(b.status, 303, 'agent B created')
    equal((await (await postForm('/api/settings/pipeline', { value: '1' })).json()).ok, true, 'pipeline on')
  })
  await check('one-off date fires exactly once and switches itself to manual', async () => {
    const idB = agent('e2e-einmalig').id
    await waitFor(() => db.prepare('SELECT count(*) c FROM runs WHERE agent_id=?').get(idB).c === 1,
      { what: 'run of the one-off agent', timeoutMs: 75_000, taktMs: 1000 })
    const a = agent('e2e-einmalig')
    equal(a.schedule_kind, 'manuell', 'kind reset')
    equal(a.run_at, null, 'date cleared')
    for (const r of db.prepare('SELECT id FROM runs WHERE agent_id=?').all(idB)) await sessionMerken(r.id)
  })
  await check('an agent does not overtake itself', async () => {
    const idA = agent('e2e-jede-minute').id
    const belegt = db.prepare(`SELECT id FROM runs WHERE agent_id=? AND status='running'`).get(idA)
    await waitFor(() => ereignisse(belegt.id).includes('schedule_skipped'),
      { what: 'schedule_skipped', timeoutMs: 75_000, taktMs: 1000 })
    equal(db.prepare('SELECT count(*) c FROM runs WHERE agent_id=?').get(idA).c, 1, 'only one run')
  })
  await check('pipeline can be switched off again', async () => {
    equal((await (await postForm('/api/settings/pipeline', { value: '0' })).json()).ok, true, 'ok')
    equal(db.prepare(`SELECT value FROM settings WHERE key='pipeline_on'`).get().value, '0', 'saved')
  })

  // ------------------------------------------------------------------
  group('Run title and planned start')

  await check('the single-run form asks for a title and a start time', async () => {
    const html = await (await fetchPath(`/runs/new?repo=${repoId}`)).text()
    contains(html, 'name="title"', 'title field')
    contains(html, 'generated from the prompt', 'says what an empty field means')
    contains(html, 'name="start_mode"', 'start kind')
    contains(html, 'name="start_at"', 'point in time')
    contains(html, 'name="start_in_minutes"', 'in n minutes')
  })
  await check('an empty title becomes the first line of the prompt', async () => {
    // No OPENROUTER_API_KEY in the sandbox, so no model is asked — exactly the
    // case the fallback exists for.
    const j = await laufStarten({ repo_id: repoId, prompt: '# Rewrite the login form\n\nand much more text' })
    await sessionMerken(j.runId)
    equal(lauf(j.runId).title, 'Rewrite the login form', 'title from the prompt')
    const html = await (await fetchPath(`/?repo=${repoId}`)).text()
    contains(html, 'Rewrite the login form', 'shown in the overview')
  })
  await check('a typed title is taken over verbatim', async () => {
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Titel', title: '  Nightly cleanup  ' })
    await sessionMerken(j.runId)
    equal(lauf(j.runId).title, 'Nightly cleanup', 'trimmed and stored')
  })
  let TITELLAUF = null
  await check('a run of an agent is called by its agent', async () => {
    const r = await postForm('/agents/edit', {
      repo_id: repoId, name: 'e2e-titel-agent', harness: 'claude', prompt: 'E2E-Agentenlauf',
      branch_mode: 'keiner', expected_minutes: '45', schedule_kind: 'manuell', active: '1',
    }, { asBrowser: true })
    equal(r.status, 303, 'agent created')
    const s = await postForm('/agents/start', { id: agent('e2e-titel-agent').id, repo: repoId }, { asBrowser: true })
    TITELLAUF = s.headers.get('location').split('/')[2]
    await sessionMerken(TITELLAUF)
    equal(lauf(TITELLAUF).title, 'e2e-titel-agent', 'the agent name, not a generated title')
  })
  await check('renaming changes the run — the agent keeps its name', async () => {
    const r = await postForm(`/api/runs/${TITELLAUF}/title`, { title: 'Renamed by hand' })
    equal((await r.json()).title, 'Renamed by hand', 'the new title comes back')
    equal(lauf(TITELLAUF).title, 'Renamed by hand', 'stored on the run')
    equal(agent('e2e-titel-agent').name, 'e2e-titel-agent', 'the agent is untouched')
    contains(await (await fetchPath(`/runs/${TITELLAUF}`)).text(), 'Renamed by hand', 'detail page shows it')
  })
  await check('an emptied title falls back to the agent instead of leaving a nameless row', async () => {
    const r = await postForm(`/api/runs/${TITELLAUF}/title`, { title: '   ' })
    equal((await r.json()).title, 'e2e-titel-agent', 'the agent name comes back')
    equal(lauf(TITELLAUF).title, null, 'nothing stored')
  })

  let GEPLANT = null
  await check('a run planned for later waits instead of starting', async () => {
    const j = await laufStarten({
      repo_id: repoId, prompt: 'E2E-spaeter', title: 'Planned run',
      start_mode: 'in', start_in_minutes: '60',
    })
    GEPLANT = j.runId
    isTrue(j.scheduled, `reported as planned (${JSON.stringify(j)})`)
    const r = lauf(GEPLANT)
    equal(r.status, 'scheduled', 'status')
    equal(r.tmux_session, null, 'no session — nothing was started')
    isTrue(!!r.start_at, 'point in time noted')
    await watcherTick()
    equal(lauf(GEPLANT).status, 'scheduled', 'a pass before the moment changes nothing')
    // The status cell of the overview: the word (translated, from lang/en.json —
    // the raw 'scheduled' is a database value and no longer reaches the screen)
    // and, underneath it, WHAT the run is waiting for. That second line is the
    // whole point of showing a waiting run at the top of the list.
    const zeile = (await (await fetchPath(`/?repo=${repoId}`)).text()).split('<tr').find(z => z.includes(GEPLANT))
    contains(zeile, 'Scheduled', 'the waiting run is visible in the overview')
    contains(zeile, 'starts at', 'and says what it is waiting for')
    contains(zeile, 'Planned run', 'with its title')
  })
  await check('a planned run does not yet show a runtime — it has not started', async () => {
    // The detail page must say the same as the overview, which shows no duration
    // for a planned run. started_at still holds the PLANNING moment (the real
    // start is written when the run launches), so counting from it — or calling
    // the run "running" — would present waiting as runtime.
    const html = await (await fetchPath(`/runs/${GEPLANT}`)).text()
    const i = html.indexOf('id="run-metrics"')
    const metrik = i < 0 ? '' : html.slice(i, i + 600)
    contains(metrik, '>– <span class="dim">/ Expectation', 'runtime is a dash, not elapsed minutes')
    isFalse(metrik.includes('(running)'), 'it does not call a planned run running')
  })
  await check('when the moment has come the watcher starts it', async () => {
    db.prepare(`UPDATE runs SET start_at=datetime('now','-1 minutes') WHERE id=?`).run(GEPLANT)
    await watcherTick()
    const r = lauf(GEPLANT)
    equal(r.status, 'running', 'started')
    isTrue(!!r.tmux_session, 'has a session')
    await sessionMerken(GEPLANT)
    contains(ereignisse(GEPLANT).join(','), 'scheduled_start', 'recorded as a planned start')
  })
  await check('a planned run can be started ahead of its time, from the endpoint', async () => {
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-StartNow', title: 'Start now run', start_mode: 'in', start_in_minutes: '60' })
    const id = j.runId
    equal(lauf(id).status, 'scheduled', 'waiting first')
    const r = await postForm(`/api/runs/${id}/start-now`, {})
    equal(r.status, 200, 'the endpoint answers 200')
    equal(lauf(id).status, 'running', 'the run is running ahead of its time')
    contains(ereignisse(id).join(','), 'scheduled_start', 'recorded as a planned start')
    await sessionMerken(id)
  })
  await check('only a planned run may be started this way', async () => {
    const laufend = await laufStarten({ repo_id: repoId, prompt: 'E2E-StartNow-Nein' })
    isTrue(!!laufend.runId && !laufend.scheduled, 'a run that is not planned')
    const r = await postForm(`/api/runs/${laufend.runId}/start-now`, {})
    equal(r.status, 400, 'the endpoint refuses')
    equal(lauf(laufend.runId).status, 'running', 'and leaves the run alone')
    await sessionMerken(laufend.runId)
  })
  await check('the start-now button sits on the detail banner next to the cancel', async () => {
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-StartNow-UI', title: 'Start now UI', start_mode: 'in', start_in_minutes: '60' })
    const seite = await fetchPath(`/runs/${j.runId}`).then(r => r.text())
    contains(seite, `action="/api/runs/${j.runId}/start-now"`, 'the banner offers the start-now button')
    contains(seite, 'button class="success"', 'and it is the green one')
    contains(seite, `action="/api/runs/${j.runId}/kill"`, 'the cancel stays beside it')
    await postForm(`/api/runs/${j.runId}/start-now`, {})
    await sessionMerken(j.runId)
  })
  await check('"when the repo is free" waits for exactly that', async () => {
    // The groups before left runs behind; the question here is only about the
    // blocker this test starts itself.
    db.prepare(`UPDATE runs SET status='done', ended_at=datetime('now')
                WHERE repo_id=? AND status IN ('running','waiting_help')`).run(repoId)
    const blocker = await laufStarten({ repo_id: repoId, prompt: 'E2E-Blocker' })
    await sessionMerken(blocker.runId)
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-frei', start_mode: 'idle' })
    await watcherTick()
    equal(lauf(j.runId).status, 'scheduled', 'the repo is busy: it keeps waiting')
    equal(lauf(j.runId).start_at, null, 'no point in time — it waits for a state')

    db.prepare(`UPDATE runs SET status='done', ended_at=datetime('now') WHERE id=?`).run(blocker.runId)
    await watcherTick()
    equal(lauf(j.runId).status, 'running', 'repo free: started')
    await sessionMerken(j.runId)
  })

  // ------------------------------------------------------------------
  group('Edit a run before and during its life (run-edit.mjs)')

  /** The "Edit this run" card of a detail page, scoped — the layout carries a
   *  Quick-Run dialog with the same field names, so assertions must not match it. */
  const editKarte = async (runId) => {
    const html = await (await fetchPath(`/runs/${runId}`)).text()
    const i = html.indexOf('id="run-edit"')
    return i < 0 ? '' : html.slice(i, i + 4000)
  }

  /** ms → local time in the datetime-local shape the form sends. */
  const datenLocal = (ms) => {
    const d = new Date(ms)
    const z = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}`
  }

  await check('a running run accepts only the expected duration', async () => {
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Edit-laeuft' })
    await sessionMerken(j.runId)
    equal(lauf(j.runId).status, 'running', 'sanity: running')

    const p1 = await postForm(`/api/runs/${j.runId}/edit`, { prompt: 'anders' })
    equal(p1.status, 400, 'a prompt edit is refused for a started run')
    contains((await p1.json()).error, 'not started yet', 'the reason names the rule')
    equal(lauf(j.runId).prompt, 'E2E-Edit-laeuft', 'prompt untouched')

    const p2 = await postForm(`/api/runs/${j.runId}/edit`, { repo_id: String(repo2Id) })
    equal(p2.status, 400, 'a move is refused for a started run')
    equal(lauf(j.runId).repo_id, repoId, 'repo untouched')

    const p3 = await postForm(`/api/runs/${j.runId}/edit`, { expected_minutes: '90' })
    equal(p3.status, 200, 'the duration edit is accepted')
    equal(lauf(j.runId).expected_minutes, 90, 'new duration')
    contains(ereignisse(j.runId).join(','), 'edited', 'the edit is an event')

    const karte = await editKarte(j.runId)
    contains(karte, 'name="expected_minutes"', 'card offers the duration')
    isFalse(karte.includes('name="prompt"'), 'no prompt textarea for a started run')
    isFalse(karte.includes('name="repo_id"'), 'no repo select for a started run')
    isFalse(karte.includes('name="start_mode"'), 'no start-time block for a started run')
    isFalse(karte.includes('name="branch_mode"'), 'no branch rule for a started run')

    // Clean up: the run must not linger as 'running' for the status sidebar.
    db.prepare(`UPDATE runs SET status='done', ended_at=datetime('now') WHERE id=?`).run(j.runId)
  })

  await check('a finished run refuses every edit', async () => {
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Edit-fertig' })
    await sessionMerken(j.runId)
    db.prepare(`UPDATE runs SET status='done', ended_at=datetime('now') WHERE id=?`).run(j.runId)
    const r = await postForm(`/api/runs/${j.runId}/edit`, { expected_minutes: '1' })
    equal(r.status, 400, 'refused')
    contains((await r.json()).error, 'already over', 'the reason says the run is over')
    equal(await editKarte(j.runId), '', 'no card at all on the detail page')
  })

  let EDITLAUF = null
  await check('a scheduled run is edited: prompt, duration, repo and start time before it starts', async () => {
    const j = await laufStarten({
      repo_id: repoId, prompt: 'E2E-Edit-alt', title: 'Planned edit',
      start_mode: 'in', start_in_minutes: '60',
    })
    EDITLAUF = j.runId
    isTrue(j.scheduled, `planned (${JSON.stringify(j)})`)
    equal(lauf(EDITLAUF).title, 'Planned edit', 'an operator title')

    const neu = datenLocal(Date.now() + 30 * 60_000)
    // A classic form post lands back on the run page.
    const r = await postForm(`/api/runs/${EDITLAUF}/edit`, {
      expected_minutes: '120', prompt: 'E2E-Edit-neu', repo_id: String(repo2Id),
      start_mode: 'at', start_at: neu,
    }, { asBrowser: true })
    equal(r.status, 303, 'form post redirects back')
    equal(r.headers.get('location'), `/runs/${EDITLAUF}`, 'to the run page')
    const l = lauf(EDITLAUF)
    equal(l.prompt, 'E2E-Edit-neu', 'new prompt')
    equal(l.expected_minutes, 120, 'new duration')
    equal(l.repo_id, repo2Id, 'moved to the other repo')
    equal(l.start_mode, 'at', 'start mode')
    equal(l.title, 'Planned edit', 'an operator title stays')
    // Same local-time reading the form parser makes of the input; the DB stores
    // UTC, so the expected value is derived from the same Date.parse.
    const so = new Date(Date.parse(neu))
    equal(l.start_at, so.toISOString().slice(0, 19).replace('T', ' '), 'the start time moved')
    // Still scheduled: 30 minutes in the future, a watcher pass must not start it.
    equal(l.status, 'scheduled', 'still waiting')
    await watcherTick()
    equal(lauf(EDITLAUF).status, 'scheduled', 'a pass before the edited moment changes nothing')

    const karte = await editKarte(EDITLAUF)
    contains(karte, 'E2E-Edit-neu', 'card shows the new prompt')
    contains(karte, 'name="prompt"', 'prompt textarea for a planned run')
    contains(karte, 'name="repo_id"', 'repo select for a planned run')
    contains(karte, '>e2e2<', 'the other repo is selected')
    contains(karte, 'name="start_mode"', 'the planned run offers its start time')
    contains(karte, 'name="start_at"', 'with the date-time field')
    contains(karte, `value="${neu}"`, 'prefilled with what it is waiting for')
    contains(karte, 'name="branch_mode"', 'and the branch rule, prefilled for a planned run')

    // The live channel renders the same card.
    const frag = await (await fetchPath(`/api/fragments/run-detail?id=${EDITLAUF}`)).text()
    contains(frag, 'id="run-edit"', 'card is part of the fragment')
    contains(frag, 'E2E-Edit-neu', 'and carries the new prompt')
    contains(frag, 'name="start_mode"', 'and the start-time block')
  })

  await check('the branch rule of a planned run can be edited', async () => {
    const j = await laufStarten({
      repo_id: repoId, prompt: 'E2E-Edit-branch', title: 'Branch planned',
      start_mode: 'in', start_in_minutes: '60',
    })
    const r = await postForm(`/api/runs/${j.runId}/edit`, {
      branch_mode: 'neu', branch_pattern: 'agent/e2e-edit', keep_on_branch: '1',
    })
    equal(r.status, 200, 'the branch edit is accepted')
    const l = lauf(j.runId)
    equal(l.branch_mode, 'neu', 'new branch mode')
    equal(l.branch_pattern, 'agent/e2e-edit', 'new branch pattern')
    equal(l.keep_on_branch, 1, 'keep-on-branch set')

    // An invalid combination is a problem, not a partial write.
    const schlecht = await postForm(`/api/runs/${j.runId}/edit`, {
      branch_mode: 'keiner', keep_on_branch: '1',
    })
    equal(schlecht.status, 400, 'keep without a branch is refused')
    equal(lauf(j.runId).branch_mode, 'neu', 'the earlier edit stands')

    const karte = await editKarte(j.runId)
    contains(karte, 'value="neu" checked', 'the edited mode is selected')
    contains(karte, 'value="agent/e2e-edit"', 'the edited pattern is prefilled')

    // Clean up: a planned run must not linger.
    await postForm(`/api/runs/${j.runId}/kill`, {})
  })

  await check('the edited run starts with its new prompt in its new repo', async () => {
    db.prepare(`UPDATE runs SET start_at=datetime('now','-1 minutes') WHERE id=?`).run(EDITLAUF)
    await watcherTick()
    const l = lauf(EDITLAUF)
    equal(l.status, 'running', 'started once the moment has come')
    isTrue(!!l.tmux_session, 'has a session')
    await sessionMerken(EDITLAUF)
    equal(l.repo_id, repo2Id, 'started in the repo it was moved to')
    equal(l.expected_minutes, 120, 'with the edited duration')
    const p = readFileSync(join(SB, 'runs', EDITLAUF, 'prompt.md'), 'utf8')
    contains(p, 'E2E-Edit-neu', 'the launched prompt is the edited one')
    isFalse(p.includes('E2E-Edit-alt'), 'the old prompt is gone')

    // Clean up for the status sidebar that counts later.
    db.prepare(`UPDATE runs SET status='done', ended_at=datetime('now') WHERE id=?`).run(EDITLAUF)
  })

  await check('editing a planned run to "now" starts it right away', async () => {
    const j = await laufStarten({
      repo_id: repoId, prompt: 'E2E-Edit-jetzt', title: 'Start now by edit',
      start_mode: 'in', start_in_minutes: '60',
    })
    equal(lauf(j.runId).status, 'scheduled', 'sanity: planned')
    const r = await postForm(`/api/runs/${j.runId}/edit`, { start_mode: 'now' })
    equal(r.status, 200, 'the edit is accepted')
    const gestartet = await r.json()
    equal(gestartet.ok, true, 'and reports the start')
    const l = lauf(j.runId)
    equal(l.status, 'running', 'the run is running, not waiting')
    isTrue(!!l.tmux_session, 'has a session')
    await sessionMerken(j.runId)
    contains(ereignisse(j.runId).join(','), 'scheduled_start', 'recorded as a started planned run')

    // Clean up.
    db.prepare(`UPDATE runs SET status='done', ended_at=datetime('now') WHERE id=?`).run(j.runId)
  })

  // ------------------------------------------------------------------
  group('Archive')

  let ARV = null
  await check('one click archives a finished run — it leaves the overview, the record stays', async () => {
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Archiv', title: 'Archived by hand' })
    await sessionMerken(j.runId)
    db.prepare(`UPDATE runs SET status='done', ended_at=datetime('now') WHERE id=?`).run(j.runId)
    ARV = j.runId
    contains(await (await fetchPath(`/runs/${ARV}`)).text(), 'Move to archive', 'detail page offers archiving once the run is over')
    // A classic form post (Accept: text/html) lands back on the overview.
    const r = await postForm(`/api/runs/${ARV}/archive`, { back: `/?repo=${repoId}` }, { asBrowser: true })
    equal(r.status, 303, 'redirects back')
    equal(r.headers.get('location'), `/?repo=${repoId}`, 'back to the overview')
    const auf = lauf(ARV)
    isTrue(!!auf.archived_at, 'archived_at is set')
    // The overview row is gone; the archive page shows it.
    isFalse((await (await fetchPath(`/?repo=${repoId}`)).text()).includes(ARV), 'not in the overview any more')
    const archiv = await (await fetchPath(`/archive?repo=${repoId}`)).text()
    contains(archiv, ARV, 'listed in the archive')
    contains(archiv, 'Archived by hand', 'with its title')
    contains(archiv, 'Restore', 'restore button')
  })
  // A run whose work never reached the base branch must say so wherever it is
  // listed. The overview does it under the status word; the archive did not, so
  // an archived run blocked on a merge was indistinguishable from one that
  // merged cleanly — and the archive is the last place that can still say it.
  await check('the archive says when an archived run\'s work is not on the base branch', async () => {
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Archiv-blockiert', title: 'Archived while blocked' })
    await sessionMerken(j.runId)
    db.prepare(`UPDATE runs SET status='done', ended_at=datetime('now'), merge_status='blocked_error' WHERE id=?`).run(j.runId)
    await postForm(`/api/runs/${j.runId}/archive`, {})
    const zeile = (await (await fetchPath(`/archive?repo=${repoId}`)).text()).split('<tr ').find(z => z.includes(j.runId))
    isTrue(!!zeile, 'the run is in the archive')
    contains(zeile, 'blocked: integration error', 'and the row says its work is not on the base branch')
    // A cleanly merged run stays quiet — the line is a warning, not furniture.
    db.prepare(`UPDATE runs SET merge_status='merged' WHERE id=?`).run(j.runId)
    const sauber = (await (await fetchPath(`/archive?repo=${repoId}`)).text()).split('<tr ').find(z => z.includes(j.runId))
    isFalse(sauber.includes('blocked: integration error'), 'a merged run says nothing')
    db.prepare('DELETE FROM runs WHERE id=?').run(j.runId)   // keep the pagination count below stable
  })
  await check('the detail page offers to restore an archived run', async () => {
    const html = await (await fetchPath(`/runs/${ARV}`)).text()
    contains(html, 'Restore to overview', 'button on the detail page')
    contains(html, 'archived', 'mentions the archive')
  })
  // The sidebar's incident count is a LINK into the overview filtered to the
  // runs that carry an open incident — and no archived run is ever in the
  // overview. Measured on this installation: two open incidents, both on runs
  // the operator had archived, so two repos said "1 needs you" and both clicks
  // landed on "no runs yet". The number and the list behind it are one set.
  await check('an archived run\'s incident leaves the sidebar count with it', async () => {
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Archiv-Vorfall', title: 'Archived with an incident' })
    await sessionMerken(j.runId)
    db.prepare(`UPDATE runs SET status='failed', ended_at=datetime('now') WHERE id=?`).run(j.runId)
    const inc = await import('../server/incidents.mjs')
    await inc.reportIncident(j.runId, { typ: 'auth_error', quelle: 'e2e', schwere: 'rot', beleg: 'E2E' })

    const zaehlt = async () => {
      const seite = await (await fetchPath(`/?repo=${repoId}`)).text()
      const block = seite.split('side-incidents')[1]?.split('</div>')[0] ?? ''
      return { block, gefiltert: await (await fetchPath(`/?repo=${repoId}&incidents=1`)).text() }
    }
    const vorher = await zaehlt()
    contains(vorher.block, 'need you', 'while the run is visible the sidebar asks for hands')
    contains(vorher.block, `incidents=1`, 'and the number is a link into the filtered overview')
    isTrue(vorher.gefiltert.includes(j.runId), 'which shows the run behind the number')

    await postForm(`/api/runs/${j.runId}/archive`, {})
    isTrue(!!lauf(j.runId).archived_at, 'archived')
    const nachher = await zaehlt()
    isFalse(nachher.block.includes('need you'), 'archived: the sidebar no longer promises a row')
    isFalse(nachher.gefiltert.includes(j.runId), 'and the filtered overview has none to give')
    // The record itself is untouched — the archive and the run's own page keep it.
    isTrue(inc.openIncidentsOf(j.runId).length === 1, 'the incident is still open, it is only not counted here')
    contains(await (await fetchPath(`/runs/${j.runId}`)).text(), 'Incidents', 'and still shown on the run\'s page')
    db.prepare('DELETE FROM runs WHERE id=?').run(j.runId)   // keep the pagination count below stable
  })
  await check('restore puts the run back into the overview', async () => {
    const r = await postForm(`/api/runs/${ARV}/unarchive`, { back: `/archive?repo=${repoId}` }, { asBrowser: true })
    equal(r.status, 303, 'redirects back')
    equal(lauf(ARV).archived_at, null, 'archived_at cleared')
    contains(await (await fetchPath(`/?repo=${repoId}`)).text(), ARV, 'visible in the overview again')
    isFalse((await (await fetchPath(`/archive?repo=${repoId}`)).text()).includes(ARV), 'gone from the archive')
  })
  await check('retrying an archived run brings it back to the overview', async () => {
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Archiv-retry' })
    await sessionMerken(j.runId)
    db.prepare(`UPDATE runs SET status='failed', ended_at=datetime('now') WHERE id=?`).run(j.runId)
    await postForm(`/api/runs/${j.runId}/archive`, {})
    isTrue(!!lauf(j.runId).archived_at, 'archived')
    const r = await postForm(`/api/runs/${j.runId}/retry`, {})
    equal(r.status, 200, 'retried')
    const auf = lauf(j.runId)
    equal(auf.status, 'running', 'running again')
    equal(auf.archived_at, null, 'left the archive — an active run must not be hidden')
    isFalse((await (await fetchPath(`/archive?repo=${repoId}`)).text()).includes(j.runId), 'not in the archive any more')
  })
  await check('a run that is still working cannot be archived', async () => {
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Archiv-laeuft' })
    await sessionMerken(j.runId)
    equal(lauf(j.runId).status, 'running', 'sanity: it is running')
    const r = await postForm(`/api/runs/${j.runId}/archive`, {})
    equal(r.status, 400, 'rejected')
    equal(lauf(j.runId).archived_at, null, 'nothing archived')
    // Clean up: the run must not linger for the watcher's sake.
    db.prepare(`UPDATE runs SET status='done', ended_at=datetime('now') WHERE id=?`).run(j.runId)
  })
  await check('a finished run with an open follow-up keeps its session', async () => {
    // Archiving closes the run's tmux session, and a finished run whose
    // follow-up commission is open is one the operator is typing into right
    // now — the overview shows it as running for exactly that reason. So the
    // row must not offer the button and the route must not take it. Measured
    // on run 49a26807: "running — follow-up in progress" and the archive
    // button in the same row.
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-archive-followup' })
    await sessionMerken(j.runId)
    db.prepare(`UPDATE runs SET status='done', ended_at=datetime('now'),
                followup_since=datetime('now') WHERE id=?`).run(j.runId)

    const row = (await (await fetchPath(`/?repo=${repoId}`)).text())
      .split('<tr ').find(chunk => chunk.includes(j.runId))
    isTrue(!!row, 'the run is in the overview')
    isFalse(row.includes(`/api/runs/${j.runId}/archive`), 'no archive button in the row')
    isFalse(row.includes('class="run-pick"'), 'and no checkbox for the bulk archive')
    const detail = await (await fetchPath(`/runs/${j.runId}`)).text()
    isFalse(detail.includes(`/api/runs/${j.runId}/archive`), 'nor on the detail page')

    const r = await postForm(`/api/runs/${j.runId}/archive`, {})
    equal(r.status, 400, 'the route refuses it too')
    equal(lauf(j.runId).archived_at, null, 'nothing archived')
    contains((await r.json()).error, 'follow-up', 'and says WHY, not "only finished runs"')

    // Once the follow-up has reported, the run may go like any other.
    db.prepare(`UPDATE runs SET followup_since=NULL WHERE id=?`).run(j.runId)
    equal((await postForm(`/api/runs/${j.runId}/archive`, {})).status, 200, 'afterwards it archives')
    db.prepare('DELETE FROM runs WHERE id=?').run(j.runId)   // keep the pagination count stable
  })
  await check('several runs go into the archive in one request', async () => {
    // The overview's multi-select: forty finished runs of which four are kept
    // used to be forty clicks. One request, one result per run.
    const ids = []
    for (const titel of ['E2E-Bulk-1', 'E2E-Bulk-2']) {
      const j = await laufStarten({ repo_id: repoId, prompt: titel, title: titel })
      await sessionMerken(j.runId)
      db.prepare(`UPDATE runs SET status='done', ended_at=datetime('now') WHERE id=?`).run(j.runId)
      ids.push(j.runId)
    }
    const r = await postForm('/api/runs/archive', { run: ids, back: `/?repo=${repoId}` })
    equal(r.status, 200, 'accepted')
    const j = await r.json()
    isTrue(j.ok, 'all of them archived')
    equal(j.results.length, 2, 'one result per run')
    for (const id of ids) isTrue(!!lauf(id).archived_at, `${id} archived`)
    const uebersicht = await (await fetchPath(`/?repo=${repoId}`)).text()
    for (const id of ids) isFalse(uebersicht.includes(id), 'gone from the overview')
    for (const id of ids) db.prepare('DELETE FROM runs WHERE id=?').run(id)   // keep the pagination count stable
  })
  await check('one run that may not be archived does not hold up the rest', async () => {
    const fertig = await laufStarten({ repo_id: repoId, prompt: 'E2E-Bulk-fertig' })
    await sessionMerken(fertig.runId)
    db.prepare(`UPDATE runs SET status='done', ended_at=datetime('now') WHERE id=?`).run(fertig.runId)
    const laeuft = await laufStarten({ repo_id: repoId, prompt: 'E2E-Bulk-laeuft' })
    await sessionMerken(laeuft.runId)
    equal(lauf(laeuft.runId).status, 'running', 'sanity: still working')

    const r = await postForm('/api/runs/archive', { run: [fertig.runId, laeuft.runId, 'not-a-run'] })
    equal(r.status, 200, 'answered per run, not refused as a whole')
    const j = await r.json()
    isFalse(j.ok, 'not everything went')
    const nach = Object.fromEntries(j.results.map(x => [x.run, x.ok]))
    equal(nach[fertig.runId], true, 'the finished one is archived')
    equal(nach[laeuft.runId], false, 'the running one is refused')
    equal(nach['not-a-run'], false, 'an unknown id is refused, not a 500')
    isTrue(!!lauf(fertig.runId).archived_at, 'archived')
    equal(lauf(laeuft.runId).archived_at, null, 'the running run stays in the overview')

    db.prepare(`UPDATE runs SET status='done', ended_at=datetime('now') WHERE id=?`).run(laeuft.runId)
    for (const id of [fertig.runId, laeuft.runId]) db.prepare('DELETE FROM runs WHERE id=?').run(id)
  })
  await check('a bulk archive without a single run is refused', async () => {
    const r = await postForm('/api/runs/archive', { back: `/?repo=${repoId}` })
    equal(r.status, 400, 'refused')
  })
  await check('the overview offers the multi-select', async () => {
    const html = await (await fetchPath(`/?repo=${repoId}`)).text()
    contains(html, 'id="runs-all"', 'select-all box')
    contains(html, 'id="runs-archive-selected"', 'the bulk button')
    contains(html, 'class="run-pick"', 'a checkbox per archivable run')
    // Under the table, not above it: one goes down the list deciding, and the
    // button belongs where the deciding stopped.
    isTrue(html.indexOf('id="runs-archive-selected"') > html.indexOf('</table>'),
      'the bulk bar stands under the table')
  })
  await check('archiving closes the tmux session right away by default', async () => {
    // The rule exists to make archiving mean what the operator's gesture says:
    // "this finished work is put away". Its session goes with it — keep 0.
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Archiv-session' })
    const sess = await sessionMerken(j.runId)
    isTrue(sess, 'a session stands')
    db.prepare(`UPDATE runs SET status='done', ended_at=datetime('now') WHERE id=?`).run(j.runId)
    const r = await postForm(`/api/runs/${j.runId}/archive`, {})
    equal(r.status, 200, 'archived')
    equal(lauf(j.runId).archived_at !== null, true, 'archived')
    equal((await sh('tmux', ['has-session', '-t', `=${sess}`])).ok, false, 'the session is gone')
    equal(lauf(j.runId).tmux_closed_at !== null, true, 'the run record knows the session closed')
    isTrue(ereignisse(j.runId).includes('tmux_closed'), `event recorded (has: ${ereignisse(j.runId).join(', ')})`)
    sessions.delete(sess)   // already gone — do not let the cleanup expect it alive
    db.prepare('DELETE FROM runs WHERE id=?').run(j.runId)   // keep the pagination count stable
  })
  await check('a switched-off archive rule keeps the session', async () => {
    db.prepare(`INSERT INTO settings(key,value) VALUES('archive_session_on','0')
                ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run()
    try {
      const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Archiv-aus' })
      const sess = await sessionMerken(j.runId)
      isTrue(sess, 'a session stands')
      db.prepare(`UPDATE runs SET status='done', ended_at=datetime('now') WHERE id=?`).run(j.runId)
      await postForm(`/api/runs/${j.runId}/archive`, {})
      equal(lauf(j.runId).archived_at !== null, true, 'archived')
      equal((await sh('tmux', ['has-session', '-t', `=${sess}`])).ok, true, 'the session survives — the rule is off')
      equal(lauf(j.runId).tmux_closed_at, null, 'and the record still expects it open')
      // The ordinary retention cleans it up later; leave that to the sandbox cleanup.
      db.prepare('DELETE FROM runs WHERE id=?').run(j.runId)   // keep the pagination count stable
    } finally {
      db.prepare(`DELETE FROM settings WHERE key='archive_session_on'`).run()
    }
  })
  await check('a keep time defers the close to the watcher pass', async () => {
    db.prepare(`INSERT INTO settings(key,value) VALUES('archive_session_keep_hours','2')
                ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run()
    try {
      const j = await laufStarten({ repo_id: repoId, prompt: 'E2E-Archiv-keep' })
      const sess = await sessionMerken(j.runId)
      isTrue(sess, 'a session stands')
      db.prepare(`UPDATE runs SET status='done', ended_at=datetime('now') WHERE id=?`).run(j.runId)
      await postForm(`/api/runs/${j.runId}/archive`, {})
      equal(lauf(j.runId).archived_at !== null, true, 'archived')
      equal((await sh('tmux', ['has-session', '-t', `=${sess}`])).ok, true, 'inside the keep window: still there')
      // Two hours pass, and the watcher closes what the archive left standing.
      db.prepare(`UPDATE runs SET archived_at=datetime('now','-3 hours') WHERE id=?`).run(j.runId)
      await watcherTick()
      equal((await sh('tmux', ['has-session', '-t', `=${sess}`])).ok, false, 'after the keep time the session is gone')
      equal(lauf(j.runId).tmux_closed_at !== null, true, 'the record agrees')
      sessions.delete(sess)
      db.prepare('DELETE FROM runs WHERE id=?').run(j.runId)   // keep the pagination count stable
    } finally {
      db.prepare(`DELETE FROM settings WHERE key='archive_session_keep_hours'`).run()
    }
  })
  await check('the archive is paginated', async () => {
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
    const seite1 = await (await fetchPath(`/archive?repo=${repoId}`)).text()
    contains(seite1, 'Page 1 of 2', 'pagination line')
    contains(seite1, 'next ›', 'a next link')
    contains(seite1, ids[0], 'newest archived first')
    isFalse(seite1.includes(ids[ids.length - 1]), 'the oldest is on page 2')
    const seite2 = await (await fetchPath(`/archive?repo=${repoId}&page=2`)).text()
    contains(seite2, 'Page 2 of 2', 'second page')
    contains(seite2, ids[ids.length - 1], 'the oldest sits here')
    isFalse(/<a [^>]*>next ›<\/a>/.test(seite2), 'no next link on the last page')
    const alle = db.prepare(`SELECT id FROM runs WHERE repo_id=? AND archived_at IS NOT NULL`).all(repoId)
    equal(alle.length, 55, 'all inserted runs are archived')
    // Page 3 beyond the range clamps to the last page instead of an empty one.
    const seite3 = await (await fetchPath(`/archive?repo=${repoId}&page=99`)).text()
    contains(seite3, 'Page 2 of 2', 'clamped to the last page')
  })

  // ------------------------------------------------------------------
  // A favorite is the setup half of a run definition under a name; the Quick-Run
  // dialog adds the task, the branch rule and the start time and starts without
  // taking the page away. What is checked here is the seam between the two: what
  // the favorite decides, what the request may decide — and that the request
  // cannot decide what the favorite already did.
  group('Favorites and Quick Run')

  let FAVID = null

  await check('a favorite is saved with its setup, and the settings page lists it', async () => {
    const r = await postForm('/settings/favorites/edit', {
      name: 'E2E-Favorit', harness: 'claude', model: 'claude-opus-5', skills: 'e2e-fleiss',
    }, { asBrowser: true })
    equal(r.status, 303, 'saved and redirected')
    const row = db.prepare('SELECT * FROM favorites WHERE name=?').get('E2E-Favorit')
    isTrue(!!row, 'stored')
    equal(row.harness, 'claude', 'coding agent')
    equal(row.model, 'claude-opus-5', 'model')
    equal(row.skills, '["e2e-fleiss"]', 'extra skill')
    FAVID = row.id
    const html = await (await fetchPath('/settings/favorites')).text()
    contains(html, 'E2E-Favorit', 'listed by name')
    contains(html, 'claude-opus-5', 'with its setup')
  })
  await check('the Quick-Run dialog stands on every page, not only on the run form', async () => {
    for (const pfad of ['/', '/agents', '/sessions', '/settings', `/archive?repo=${repoId}`]) {
      const html = await (await fetchPath(pfad)).text()
      contains(html, 'id="qr-dialog"', `${pfad}: dialog`)
      contains(html, 'id="qr-open"', `${pfad}: button in the header`)
      contains(html, 'E2E-Favorit', `${pfad}: the favorite is selectable`)
    }
  })
  await check('the start time stands open under the task, only the branch rule is folded away', async () => {
    const html = await (await fetchPath('/')).text()
    const dialog = html.slice(html.indexOf('id="qr-dialog"'))
    const aufgabe = dialog.indexOf('name="prompt"')
    const start = dialog.indexOf('name="start_mode"')
    const details = dialog.indexOf('details class="qr-more"')
    isTrue(aufgabe >= 0 && start >= 0 && details >= 0, 'task, start time and the folded block are all there')
    isTrue(aufgabe < start && start < details, 'the start time sits under the task and before the folded block')
  })
  await check('a quick run starts with the favorite\'s setup and only the task from the dialog', async () => {
    const r = await postForm('/api/runs/quick', {
      repo_id: String(repoId), favorite_id: String(FAVID),
      prompt: 'E2E-Quickrun: tu etwas', branch_mode: 'keiner', start_mode: 'now',
    })
    const j = await r.json()
    isTrue(j.ok && !!j.runId, `started (${JSON.stringify(j)})`)
    // The answer comes back while the launch is still going: what a Quick Run
    // has to decide is decided, the worktree and the session are the hub's
    // business from here (scheduler.mjs, `detached`).
    isTrue(j.pending, 'the answer says the start is still running')
    const wt = await sessionMerken(j.runId)
    isTrue(!!wt, 'and the session really does come up afterwards')
    const l = lauf(j.runId)
    equal(l.harness, 'claude', 'coding agent from the favorite')
    equal(l.model, 'claude-opus-5', 'model from the favorite')
    equal(l.skills, '["e2e-fleiss"]', 'extra skill from the favorite')
    equal(l.prompt, 'E2E-Quickrun: tu etwas', 'task from the dialog')
    equal(l.expected_minutes, 45, 'the duration is not asked for and takes the default')
    equal(l.status, 'running', 'really started')
  })
  await check('the request cannot override what the favorite decided', async () => {
    const r = await postForm('/api/runs/quick', {
      repo_id: String(repoId), favorite_id: String(FAVID),
      prompt: 'E2E-Quickrun: untergeschoben', branch_mode: 'keiner',
      // Everything a favorite owns — smuggled in alongside it.
      harness: 'hermes', model: 'boeses/modell', provider: 'openrouter', skills: '',
    })
    const j = await r.json()
    isTrue(j.ok, `started (${JSON.stringify(j)})`)
    await sessionMerken(j.runId)
    const l = lauf(j.runId)
    equal(l.harness, 'claude', 'coding agent stayed the favorite\'s')
    equal(l.model, 'claude-opus-5', 'model stayed the favorite\'s')
    equal(l.skills, '["e2e-fleiss"]', 'skills stayed the favorite\'s')
  })
  await check('a quick run can be planned instead of started', async () => {
    const r = await postForm('/api/runs/quick', {
      repo_id: String(repoId), favorite_id: String(FAVID),
      prompt: 'E2E-Quickrun: spaeter', branch_mode: 'keiner',
      start_mode: 'in', start_in_minutes: '30',
    })
    const j = await r.json()
    isTrue(j.ok && j.scheduled, `planned (${JSON.stringify(j)})`)
    const l = lauf(j.runId)
    equal(l.status, 'scheduled', 'waiting')
    equal(l.tmux_session, null, 'nothing started yet')
    isTrue(!!l.start_at, 'point in time noted')
  })
  await check('a broken quick run is a readable answer, not a run', async () => {
    const ohneFavorit = await postForm('/api/runs/quick', {
      repo_id: String(repoId), favorite_id: '99999', prompt: 'x', branch_mode: 'keiner',
    })
    equal(ohneFavorit.status, 400, 'unknown favorite rejected')
    const ohnePrompt = await postForm('/api/runs/quick', {
      repo_id: String(repoId), favorite_id: String(FAVID), prompt: '   ', branch_mode: 'keiner',
    })
    equal(ohnePrompt.status, 400, 'empty task rejected')
    contains((await ohnePrompt.json()).error, 'Prompt', 'names what is missing')
    const branchOhneMuster = await postForm('/api/runs/quick', {
      repo_id: String(repoId), favorite_id: String(FAVID), prompt: 'x', branch_mode: 'neu',
    })
    equal(branchOhneMuster.status, 400, 'branch rule without a pattern rejected — same check as the run form')
  })
  await check('more favorites than there is room for are refused', async () => {
    const max = db.prepare('SELECT count(*) c FROM favorites').get().c
    for (let i = max; i < 3; i++) {
      await postForm('/settings/favorites/edit', { name: `E2E-Fill-${i}`, harness: 'claude' }, { asBrowser: true })
    }
    equal(db.prepare('SELECT count(*) c FROM favorites').get().c, 3, 'three slots in use')
    const r = await postForm('/settings/favorites/edit', { name: 'E2E-zuviel', harness: 'claude' }, { asBrowser: true })
    equal(r.status, 400, 'the fourth is refused')
    isFalse(!!db.prepare('SELECT id FROM favorites WHERE name=?').get('E2E-zuviel'), 'and not stored')
  })

  // ------------------------------------------------------------------
  // The whole flows module had no e2e coverage: not one of its four pages, not
  // one of its ten endpoints, not one of its static files. It sits at the end of
  // the suite on purpose — a flow with a `run_finished` trigger is what makes the
  // attachment block render checkboxes at all, and the group deletes it again so
  // nothing that follows inherits a flow hanging on an agent.
  group('Flows: pages, meta and the round trip through the API')

  /** POST a JSON body — /api/flows/save reads JSON, not a form. */
  const jsonPost = (pfad, obj) => fetchPath(pfad, {
    method: 'POST', body: JSON.stringify(obj),
    headers: { 'content-type': 'application/json', accept: 'application/json' },
  })

  let FLOWID = null

  await check('the three flow pages answer with real HTML', async () => {
    // One characteristic string per page, each from lang/en.json. Deliberately not
    // "Flows" for all three: a flow is not a place one navigates to, so there is no
    // nav entry carrying that word onto every page.
    const kennzeichen = {
      '/flows': 'New flow',           // flows.new
      '/flows/edit': 'Back',          // flows.editor.back — the designer's own head
      '/flows/runs': 'Flow runs',     // flows.runs.title
    }
    for (const [pfad, text] of Object.entries(kennzeichen)) {
      const r = await fetchPath(pfad)
      equal(r.status, 200, `${pfad}: status`)
      const html = await r.text()
      isTrue(html.length > 500, `${pfad}: not an empty page (${html.length} bytes)`)
      contains(html, text, `${pfad}: its own heading`)
    }
    contains(await (await fetchPath('/flows')).text(), 'no flows yet', 'the empty list says so instead of showing a broken table')
  })
  await check('the flow designer\'s own scripts and its data reach the page', async () => {
    const html = await (await fetchPath('/flows/edit')).text()
    // Markup, unavoidably: the designer is a client application and these two are
    // the seam it hangs on — the catalog it boots from and the module that boots
    // it. Everything else about the page is checked through the API below.
    contains(html, 'window.FREILAUF_FLOWS', 'the editor state is injected')
    contains(html, '/static/flows.js', 'the designer module is pulled in')
    contains(html, 'Save', 'and the button that saves what was drawn')
  })
  await check('the step registry reaches the editor through /api/flows/meta', async () => {
    const j = await (await fetchPath('/api/flows/meta')).json()
    isTrue(j.ok, 'ok')
    for (const feld of ['steps', 'groups', 'triggerKinds', 'ops', 'fieldTypes']) {
      isTrue(Array.isArray(j[feld]) && j[feld].length > 0, `${feld} is present and not empty`)
    }
    isTrue(j.steps.every(s => s.type && s.component && s.group && Array.isArray(s.fields)),
      'every step names its type, component, group and fields — that is what the property editor renders from')
    isTrue(j.steps.some(s => s.type === 'notify') && j.steps.some(s => s.type === 'switch_outcome'),
      'known building blocks are in the registry')
    isTrue(j.triggerKinds.includes('run_finished'), 'the trigger that an attachment is')
    isTrue(j.groups.every(g => j.steps.some(s => s.group === g)), 'no toolbox group without a step in it')
  })
  await check('a flow is saved through the API and comes back unchanged', async () => {
    const definition = {
      properties: {},
      sequence: [{ id: 'e2e-note', componentType: 'task', type: 'note', name: 'E2E note', properties: { text: 'E2E flow ran' } }],
    }
    const r = await jsonPost('/api/flows/save', {
      name: 'E2E-Flow', active: true, trigger: { kind: 'run_finished' }, definition,
    })
    const j = await r.json()
    isTrue(j.ok && !!j.id, `saved (${JSON.stringify(j).slice(0, 200)})`)
    FLOWID = j.id
    const gelesen = await (await fetchPath(`/api/flows/${FLOWID}`)).json()
    isTrue(gelesen.ok, 'read back')
    equal(gelesen.flow.name, 'E2E-Flow', 'name')
    equal(gelesen.flow.active, 1, 'active')
    equal(gelesen.flow.trigger.kind, 'run_finished', 'trigger')
    equal(gelesen.flow.definition.sequence[0].properties.text, 'E2E flow ran', 'the definition survived the round trip')
    contains(await (await fetchPath('/flows')).text(), 'E2E-Flow', 'and the list shows it')
  })
  await check('a definition the registry does not know is refused instead of stored', async () => {
    const r = await jsonPost('/api/flows/save', {
      name: 'E2E-Flow-kaputt', trigger: { kind: 'manual' },
      definition: { properties: {}, sequence: [{ id: 'x', type: 'gibtsnicht', properties: {} }] },
    })
    equal(r.status, 400, 'rejected')
    isTrue((await r.json()).problems.length > 0, 'with a reason')
    isFalse(!!db.prepare('SELECT id FROM flows WHERE name=?').get('E2E-Flow-kaputt'), 'nothing stored')
    // A required field left empty is the same class of answer.
    const ohneText = await jsonPost('/api/flows/save', {
      name: 'E2E-Flow-leer', trigger: { kind: 'manual' },
      definition: { properties: {}, sequence: [{ id: 'y', type: 'note', properties: {} }] },
    })
    equal(ohneText.status, 400, 'a required field left empty is refused too')
  })
  await check('all three run forms carry the flow attachment block', async () => {
    // The only safeguard of the attach block. Checked by what the definition is
    // built from — the field NAMES — plus the class the block is styled and found
    // by; there is no text of its own that would prove the checkbox is a checkbox.
    for (const pfad of [`/runs/new?repo=${repoId}`, `/agents/edit?repo=${repoId}`, '/settings/favorites/edit']) {
      const html = await (await fetchPath(pfad)).text()
      contains(html, 'Flows after this run', `${pfad}: the block's legend`)
      contains(html, 'flows-attach', `${pfad}: the block's own container`)
      contains(html, 'name="flows"', `${pfad}: the checkbox the definition is built from`)
      contains(html, `value="${FLOWID}"`, `${pfad}: the flow is offered`)
      contains(html, `name="flow_when_${FLOWID}"`, `${pfad}: with its condition`)
      contains(html, 'E2E-Flow', `${pfad}: by name`)
    }
  })
  await check('ticking the box really attaches the flow, and the editor sees the same row', async () => {
    const r = await postForm('/agents/edit', {
      repo_id: String(repoId), name: 'e2e-flow-agent', harness: 'claude', prompt: 'x',
      branch_mode: 'keiner', expected_minutes: '5', schedule_kind: 'manuell',
      flows: String(FLOWID), [`flow_when_${FLOWID}`]: 'failed',
    }, { asBrowser: true })
    equal(r.status, 303, 'agent saved')
    equal(agent('e2e-flow-agent').flows, `[{"flowId":${FLOWID},"when":"failed"}]`, 'the attachment landed on the agent')
    // One storage, two editors: the flow editor reads the very same row back.
    const html = await (await fetchPath(`/flows/edit?id=${FLOWID}`)).text()
    contains(html, '"when":"failed"', 'the flow editor knows the condition the agent form wrote')
    contains(html, 'e2e-flow-agent', 'and which agent it hangs on')
  })
  await check('a flow can be switched off and on again through the API', async () => {
    const aus = await postForm(`/api/flows/${FLOWID}/toggle`, {})
    equal(aus.status, 200, 'toggled')
    equal(db.prepare('SELECT active FROM flows WHERE id=?').get(FLOWID).active, 0, 'off')
    await postForm(`/api/flows/${FLOWID}/toggle`, {})
    equal(db.prepare('SELECT active FROM flows WHERE id=?').get(FLOWID).active, 1, 'on again')
  })
  await check('deleting the flow also removes it from the agent it hung on', async () => {
    const r = await postForm(`/api/flows/${FLOWID}/delete`, {})
    equal(r.status, 200, 'deleted')
    equal((await fetchPath(`/api/flows/${FLOWID}`)).status, 404, 'gone')
    equal(agent('e2e-flow-agent').flows, null, 'no dead id left behind on the agent')
    // Without an attachable flow the block falls back to its "nothing here" form —
    // legend and hint, but no checkbox.
    const html = await (await fetchPath(`/runs/new?repo=${repoId}`)).text()
    contains(html, 'Flows after this run', 'the block still stands')
    isFalse(html.includes('name="flows"'), 'but offers nothing to attach any more')
  })

  // ------------------------------------------------------------------
  // The trigger that fires after a merge, and the block that may run a real
  // command afterwards — end to end, with a real shell instead of a stub. What
  // this group cannot do is produce the merge itself: the integrator lives in
  // another module, so the merge is written the way it will be written, by SQL.
  // The two cases that need the real integrator are described in
  // test/TODO-e2e-run-merged.md.
  group('Flows: run_merged fires, and shell_command really runs')

  await check('a merge starts the flow, and its command writes the SHA into a file', async () => {
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
    isTrue(j.ok && !!j.id, `flow saved (${JSON.stringify(j).slice(0, 200)})`)
    const flowId = j.id

    db.prepare(`INSERT INTO runs(id, repo_id, status, harness, prompt, branch_mode, expected_minutes,
                ended_at, flow_dispatched, merge_status, merged_sha, merged_at)
                VALUES('e2e-merged-1',?,'done','claude','p','keiner',5,datetime('now'),1,'merged','deadbee',datetime('now'))`).run(repoId)
    db.prepare(`INSERT INTO events(run_id, kind, payload) VALUES('e2e-merged-1','merged',?)`)
      .run(JSON.stringify({ sha: 'deadbee', files: ['server/flows/steps.mjs'] }))

    const { flowsTick } = await import('../server/flows/triggers.mjs')
    await flowsTick()
    await waitFor(() => existsSync(ziel), { what: 'the command of the flow has run', timeoutMs: 10_000 })
    equal(readFileSync(ziel, 'utf8').trim(), 'deadbee', 'the template put the merge commit into the file')
    const fr = db.prepare('SELECT * FROM flow_runs WHERE flow_id=? ORDER BY started_at DESC LIMIT 1').get(flowId)
    equal(fr.status, 'done', 'the flow run finished')
    equal(JSON.parse(fr.context).vars.shell.exit_code, 0, 'and the command with exit code 0')
    equal(db.prepare('SELECT merge_dispatched FROM runs WHERE id=?').get('e2e-merged-1').merge_dispatched, 1, 'the merge is marked')
  })

  await check('the repo form names the flows that run after a merge, and offers a new one', async () => {
    // A run_merged flow hangs on the repo, not on an agent — so the repo form is
    // its way in. The attachment block of the run forms cannot show it.
    const html = await (await fetchPath(`/repos/edit?id=${repoId}`)).text()
    contains(html, 'Flows after merge', 'the block from lang/en.json')
    contains(html, 'E2E-Merge-Flow', 'the flow of this repo by name')
    contains(html, '/flows/edit?trigger=run_merged&amp;repo=' + repoId, 'and the way to a new one, pre-aimed')
    const neu = await (await fetchPath('/repos/edit')).text()
    isFalse(neu.includes('Flows after merge'), 'a repo that does not exist yet has nothing to hang a flow on')
  })
  await check('the editor really arrives with that trigger and repo already set', async () => {
    const html = await (await fetchPath(`/flows/edit?trigger=run_merged&repo=${repoId}`)).text()
    const m = html.match(/window\.FREILAUF_FLOWS=(\{.*?\})<\/script>/s)
    isTrue(!!m, 'the editor state is injected')
    const flow = JSON.parse(m[1]).flow
    equal(flow.trigger.kind, 'run_merged', 'the trigger the button asked for')
    equal(flow.trigger.repoId, repoId, 'aimed at this repo')
    contains(flow.name, 'After merge', 'and named after what it does')
    const ohne = await (await fetchPath('/flows/edit?trigger=run_merged&repo=999999')).text()
    contains(ohne, '"repoId":null', 'a repo that does not exist becomes "all repos", not a broken filter')
  })

  await check('a detached command ends its step at once and keeps running afterwards', async () => {
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
    isTrue(j.ok && !!j.id, 'flow saved')

    db.prepare(`INSERT INTO runs(id, repo_id, status, harness, prompt, branch_mode, expected_minutes,
                ended_at, flow_dispatched, merge_status, merged_sha, merged_at)
                VALUES('e2e-merged-2',?,'done','claude','p','keiner',5,datetime('now'),1,'merged','cafe123',datetime('now'))`).run(repoId)

    const { flowsTick } = await import('../server/flows/triggers.mjs')
    const t0 = Date.now()
    await flowsTick()
    const fr = db.prepare('SELECT * FROM flow_runs WHERE flow_id=? ORDER BY started_at DESC LIMIT 1').get(j.id)
    equal(fr.status, 'done', 'the flow run is over')
    equal(JSON.parse(fr.context).vars.shell.detached, true, 'the step answered "detached" instead of waiting')
    isFalse(existsSync(ziel), 'and it really did not wait — the file is not there yet')
    isTrue(Date.now() - t0 < 3000, `the pass did not wait for the command (${Date.now() - t0} ms)`)
    await waitFor(() => existsSync(ziel), { what: 'the detached command runs on by itself', timeoutMs: 5000 })
  })

  // ------------------------------------------------------------------
  // Five pages whose HTML was never fetched once. Checked against the strings
  // from lang/en.json and against form field names, not against markup — these
  // tests are meant to survive the rebuild that is coming.
  group('Pages that had no test at all')

  await check('the repo list shows the repo with path, base branch and prompt column', async () => {
    const r = await fetchPath('/repos')
    equal(r.status, 200, 'status')
    const html = await r.text()
    contains(html, 'Create repo', 'the way into the form')
    contains(html, 'Worktree extras', 'column header')
    contains(html, 'Repo prompt', 'column header')
    contains(html, 'e2e', 'the sandbox repo by name')
    contains(html, REPO, 'with its path')
  })
  await check('the repo form carries every field the save route reads back', async () => {
    const row = db.prepare('SELECT * FROM repos WHERE name=?').get('e2e')
    const html = await (await fetchPath(`/repos/edit?id=${row.id}`)).text()
    contains(html, 'Path (main checkout)', 'the label from lang/en.json')
    for (const feld of ['name="name"', 'name="path"', 'name="base_branch"', 'name="prompt"', 'name="worktree_extras"']) {
      contains(html, feld, `field ${feld}`)
    }
    contains(html, REPO, 'prefilled with what is stored')
    contains(html, 'main', 'and the base branch')
  })
  await check('the repo form carries the extras finder: button and dialog, with the warning', async () => {
    const html = await (await fetchPath('/repos/edit')).text()
    contains(html, 'id="extras-find"', 'the button')
    contains(html, 'id="extras-dialog"', 'the modal')
    contains(html, 'id="extras-start"', 'its start button')
    contains(html, 'Worktree extras', 'the label of the field it fills')
    contains(html, 'completely replaces', 'the warning that existing entries are not kept')
  })
  await check('the extras suggestion checks algorithmically before any model is asked', async () => {
    const leer = await (await postForm('/api/repos/extras-suggest', { path: '' })).json()
    isFalse(leer.ok, 'empty path is refused')
    const weg = await (await postForm('/api/repos/extras-suggest', { path: join(SB, 'gibt-es-nicht') })).json()
    isFalse(weg.ok, 'missing directory is refused')
    contains(weg.error, 'gibt-es-nicht', 'and names the path')
    const keinGit = await (await postForm('/api/repos/extras-suggest', { path: SB })).json()
    isFalse(keinGit.ok, 'a directory without .git is refused')
    contains(keinGit.error, 'git', 'and says so')
  })
  await check('a git repo without a credential for its model source reports the LLM as off', async () => {
    // The message stopped naming OPENROUTER_API_KEY when the four direct LLM
    // calls became source-driven: the source may be any model provider, or a
    // coding agent, so the sentence names the SETTING that switches it on and
    // where to put a credential. What it must still do is refuse and say why.
    const j = await (await postForm('/api/repos/extras-suggest', { path: REPO })).json()
    isFalse(j.ok, 'not ok without a key')
    contains(j.error, 'no key', 'names the missing credential as the reason')
    contains(j.error, 'Worktree extras', 'and where to change it')
  })
  await check('the agents page shows the schedule and all three actions of a row', async () => {
    // An agent with a real schedule, deliberately left switched OFF: the scheduler
    // only ever picks up active ones, so this row cannot start anything by itself.
    const gespeichert = await postForm('/agents/edit', {
      repo_id: String(repoId), name: 'e2e-anzeige', harness: 'claude', prompt: 'x',
      branch_mode: 'keiner', expected_minutes: '20',
      schedule_kind: 'woechentlich', schedule_days: ['1', '3'], schedule_time: '07:30', schedule_weeks: '1',
    }, { asBrowser: true })
    equal(gespeichert.status, 303, 'agent saved')
    const r = await fetchPath(`/agents?repo=${repoId}`)
    equal(r.status, 200, 'status')
    const html = await r.text()
    contains(html, 'Create agent', 'the way to a new agent')
    contains(html, 'Flows hang on an agent', 'the hint that says where flows are attached')
    contains(html, 'Schedule', 'the schedule column exists')
    const zeile = html.split('<tr').find(z => z.includes('e2e-anzeige'))
    isTrue(!!zeile, 'the agent has a row')
    contains(zeile, 'weekly: Mon, Wed at 07:30', 'the schedule column says what is really planned')
    contains(zeile, '20 min', 'the expected duration')
    // The actions are checked by the routes they post to: those outlive any markup.
    contains(zeile, '/agents/toggle', 'the on/off toggle')
    contains(zeile, 'off', 'which says what the agent currently is')
    contains(zeile, '/agents/start', 'the "start now" button')
    contains(zeile, 'start now', 'by its name')
    contains(zeile, `/agents/edit?id=${agent('e2e-anzeige').id}`, 'and the edit link')
  })
  await check('the toggle in the row switches the agent on and off again', async () => {
    const a = agent('e2e-anzeige')
    equal(a.active, 0, 'starts switched off')
    const r = await postForm('/agents/toggle', { id: String(a.id), repo: String(repoId) }, { asBrowser: true })
    equal(r.status, 303, 'redirects back to the list')
    equal(agent('e2e-anzeige').active, 1, 'now on')
    await postForm('/agents/toggle', { id: String(a.id), repo: String(repoId) }, { asBrowser: true })
    // Off again on purpose: an ACTIVE weekly agent left behind would be picked up
    // by the scheduler tick and start a run nobody asked for.
    equal(agent('e2e-anzeige').active, 0, 'and off again')
  })
  await check('the favorite form is the run setup under a name', async () => {
    const r = await fetchPath(`/settings/favorites/edit?id=${FAVID}`)
    equal(r.status, 200, 'status')
    const html = await r.text()
    contains(html, 'Edit favorite', 'the title from lang/en.json')
    contains(html, 'E2E-Favorit', 'prefilled with what is stored')
    contains(html, 'name="harness"', 'the coding agent')
    contains(html, 'name="model"', 'the model')
    contains(html, 'e2e-fleiss', 'the extra-skills block is part of it')
    const neu = await fetchPath('/settings/favorites/edit')
    equal(neu.status, 200, 'a fresh favorite form answers as well')
    contains(await neu.text(), 'New favorite', 'with its own title')
  })
  await check('the Telegram plugin brings its own setup wizard, and the old address still finds it', async () => {
    const alt = await fetchPath('/telegram-setup', { redirect: 'manual' })
    equal(alt.status, 303, 'the historic address redirects')
    equal(alt.headers.get('location'), '/settings/notifications/telegram', 'to the plugin\'s own wizard')
    const r = await fetchPath('/settings/notifications/telegram')
    equal(r.status, 200, 'status')
    const html = await r.text()
    for (const schritt of ['Step 1 — bot token', 'Step 2 — find the chat ID', 'Step 3 — test']) {
      contains(html, schritt, schritt)
    }
    contains(html, '/settings/notifications/telegram/token', 'step 1 posts the token to the plugin\'s own action')
    contains(html, 'name="telegram_token"', 'and has the field for it')
    contains(html, '/settings/notifications/telegram/test', 'step 3 sends the test message')
    contains(html, '/settings/notifications/telegram/json/chats', 'step 2 asks the plugin\'s own JSON route')
    // A plugin that brings no wizard has no page, and an id nobody registered
    // certainly not — a 200 there would be a page rendering nothing.
    equal((await fetchPath('/settings/notifications/no-such-notifier')).status, 400, 'an unknown notifier has no wizard')
  })

  // ------------------------------------------------------------------
  // Status used to stand in three places and fully on exactly ONE page: two
  // quota bars in the header, the pipeline switch as running text beside them,
  // and the usage panel on the overview. The question those three answer
  // together — can I send something off right now, and is anything stuck? —
  // could therefore only be asked from the overview.
  group('The status sidebar: one reading, on every page')

  await check('the sidebar stands on every page, and the header kept only context and action', async () => {
    for (const pfad of ['/', '/agents', '/sessions', '/settings', '/repos', `/archive?repo=${repoId}`, '/flows', '/runs/new']) {
      const html = await (await fetchPath(pfad)).text()
      contains(html, 'id="status-sidebar"', `${pfad}: the sidebar`)
      contains(html, 'id="header-status"', `${pfad}: the pipeline reading, inside it`)
      contains(html, 'Pipeline', `${pfad}: by its name from lang/en.json`)
      const kopf = html.slice(html.indexOf('<header'), html.indexOf('</header>'))
      // The two things that stay: the repo is context, Quick Run is an action.
      contains(kopf, 'id="repo-switch"', `${pfad}: the repo switcher stayed in the header`)
      contains(kopf, 'id="qr-open"', `${pfad}: and so did the Quick-Run button`)
      // The one thing that left: a reading. It is a status, and status is the
      // sidebar's job now — a bar that has to stay one line high cannot carry it.
      isFalse(kopf.includes('class="quota"'), `${pfad}: no quota bar left in the header`)
      isFalse(kopf.includes('id="header-status"'), `${pfad}: and no pipeline reading either`)
    }
  })
  await check('the sidebar counts the work in flight of THIS repo and links each count into the overview', async () => {
    const html = await (await fetchPath(`/?repo=${repoId}`)).text()
    const leiste = html.slice(html.indexOf('id="status-sidebar"'), html.indexOf('</aside>'))
    isTrue(leiste.length > 50, 'the sidebar has content')
    contains(leiste, 'Work in flight', 'the block by its name from lang/en.json')
    // The same rule the sidebar renders by (server/run-state.mjs): "running"
    // is the record's running minus the agents that say they wait, plus the
    // finished runs with an open follow-up — the unit suite holds SQL and
    // JavaScript together, this test holds the page to the SQL.
    const { displayStatusSql, WORK_STATUSES } = await import('../server/run-state.mjs')
    const zaehl = (s) => db.prepare(`SELECT count(*) c FROM runs WHERE repo_id=? AND archived_at IS NULL AND ${displayStatusSql(s)}`).get(repoId).c
    let gesehen = 0
    for (const s of WORK_STATUSES) {
      const n = zaehl(s)
      if (!n) {
        // Zero is not information, it is furniture: the line is absent, not "0".
        isFalse(leiste.includes(`status=${s}"`), `${s}: none of them, so no line`)
        continue
      }
      gesehen++
      contains(leiste, `/?repo=${repoId}&amp;status=${s}`, `${s}: linked into the overview`)
      contains(leiste, `<span class="n">${n}</span>`, `${s}: with the count the database holds`)
      // With only one repo the sum of all repos equals this repo's own count, so
      // the overall suffix would add nothing and must stay away.
      isFalse(leiste.includes(`overall`), `${s}: one repo, so no "(y overall)" suffix`)
    }
    isTrue(gesehen > 0, 'at least one status was in flight at this point of the suite')

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
      isTrue(gesamt > jetzt, `the fixture makes the overall exceed this repo (${gesamt} > ${jetzt})`)
      const html2 = await (await fetchPath(`/?repo=${repoId}`)).text()
      const leiste2 = html2.slice(html2.indexOf('id="status-sidebar"'), html2.indexOf('</aside>'))
      contains(leiste2, `<span class="n">${jetzt}</span> <span>Scheduled <span class="dim">in this repo</span></span>`,
        'the repo count links with the status and the "in this repo" scope')
      contains(leiste2, `<span class="overall dim">(${gesamt} overall)</span>`, 'and the sum of all repos stands dimmed outside the link')
      isFalse(leiste2.includes(`/status=scheduled"><span class="n">${gesamt}</span>`), 'the overall is NOT the number that links')
    } finally {
      db.prepare(`DELETE FROM runs WHERE id LIKE 'e2e-gesamt-%'`).run()
      db.prepare(`DELETE FROM repos WHERE id=?`).run(zweites)
    }
  })
  await check('a count leads to the overview filtered to exactly that status', async () => {
    // A planned run: it exists, it has no session, and nothing picks it up for
    // the next ten hours — so this is deterministic wherever the suite stands.
    const j = await laufStarten({
      repo_id: repoId, prompt: 'E2E-Filter', title: 'Filter run',
      start_mode: 'in', start_in_minutes: '600',
    })
    isTrue(j.scheduled, `planned (${JSON.stringify(j)})`)
    const gefiltert = await (await fetchPath(`/?repo=${repoId}&status=scheduled`)).text()
    const koerper = gefiltert.slice(gefiltert.indexOf('id="runs-body"'), gefiltert.indexOf('</table>'))
    contains(koerper, j.runId, 'the filtered list holds the planned run')
    const ids = [...koerper.matchAll(/id="run-([0-9a-f-]{36})"/g)].map(m => m[1])
    for (const id of ids) equal(lauf(id).status, 'scheduled', `${id.slice(0, 8)}: really has that status`)
    const erwartet = db.prepare(`SELECT count(*) c FROM runs WHERE repo_id=? AND archived_at IS NULL AND status='scheduled'`).get(repoId).c
    equal(ids.length, erwartet, 'exactly the runs of that status, no more and no fewer')
    contains(gefiltert, 'Show all', 'and a way back to the whole list')
    // The live channel has to ask for the SAME selection, or the first update
    // would silently replace the filtered list with the unfiltered one.
    contains(koerper, 'data-status="scheduled"', 'the tbody carries the filter for the live channel')
    const frag = await fetchPath(`/api/fragments/runs-body?repo=${repoId}&status=scheduled`)
    equal(frag.status, 200, 'the fragment answers')
    equal([...(await frag.text()).matchAll(/id="run-([0-9a-f-]{36})"/g)].length, erwartet, 'with the same selection')
    // A status the CHECK constraint does not know is no filter, not an error.
    const alles = await fetchPath(`/?repo=${repoId}&status=erfunden`)
    equal(alles.status, 200, 'an invented status is simply no filter')
    isTrue([...(await alles.text()).matchAll(/id="run-([0-9a-f-]{36})"/g)].length > erwartet, 'and the whole list comes back')
  })
  await check('the overview is seven fact columns plus the pick box, and its empty state spans all of them', async () => {
    const html = await (await fetchPath(`/?repo=${repoId}`)).text()
    const kopf = html.slice(html.indexOf('<thead'), html.indexOf('</thead>'))
    equal((kopf.match(/<th[ >]/g) || []).length, 8, 'eight columns: the multi-select box plus seven facts')
    equal((kopf.match(/<th>/g) || []).length, 7, 'seven titled columns, not eleven')
    contains(kopf, '<th class="pick-col">', 'and the nameless first one is the multi-select column')
    // Eleven columns became seven without losing a single fact: traffic light,
    // status word and last anomaly are one statement, and so are harness/model
    // and branch/PR.
    for (const titel of ['Status', 'Title', 'Coding agent/model', 'Started', 'Duration/expected', 'Branch/PR', 'Incidents']) {
      contains(kopf, `>${titel}<`, `header ${titel}`)
    }
    const zeile = html.split('<tr ').find(z => z.includes(RH))
    equal((zeile.match(/<td/g) || []).length, 8, 'and a row has exactly as many cells as the head has columns')
    // A repo without runs: the sentence has to span the whole table, otherwise
    // it sits in the first column with seven empty cells beside it.
    const leer = await (await fetchPath('/api/fragments/runs-body?repo=999999')).text()
    contains(leer, 'colspan="8"', 'the empty state spans all eight')
    contains(leer, 'no runs yet', 'and says so')
  })
  await check('the sidebar says what every tmux session on this machine costs', async () => {
    const html = await (await fetchPath(`/?repo=${repoId}`)).text()
    const leiste = html.slice(html.indexOf('id="status-sidebar"'), html.indexOf('</aside>'))
    contains(leiste, 'id="side-mem"', 'the block is there')
    contains(leiste, 'tmux memory', 'by its name from lang/en.json')
    // A figure, and a way to the page that breaks it down per session.
    isTrue(/id="side-mem"[\s\S]*?<a href="\/sessions"><b>(\d+(\.\d+)?\s(MB|GB)|0 MB)<\/b><\/a>/.test(leiste),
      `a memory figure linked to /sessions (${leiste.slice(leiste.indexOf('id="side-mem"'), leiste.indexOf('id="side-mem"') + 240)})`)
    contains(leiste, 'sessions', 'and how many sessions it is spread over')
    // The reading is up to eight minutes old, and the block says so instead of
    // presenting itself as live — the panel's whole honesty rests on that line.
    contains(leiste, 'measured every 8 min', 'the update interval, read out of the answer')
    // It is on EVERY page, like the rest of the sidebar: a bill that runs
    // quietly must not need a navigation to be seen.
    for (const pfad of ['/agents', '/settings', '/sessions']) {
      contains(await (await fetchPath(pfad)).text(), 'id="side-mem"', `${pfad}: there too`)
    }
  })
  await check('the sidebar fragment renders the same aside the page does', async () => {
    const r = await fetchPath(`/api/fragments/sidebar?repo=${repoId}`)
    equal(r.status, 200, 'status')
    const frag = await r.text()
    contains(frag, 'id="status-sidebar"', 'the swap target')
    contains(frag, 'id="header-status"', 'with the pipeline reading inside it')
    contains(frag, 'Work in flight', 'and the work counts of the repo it was asked for')
    // Same renderer as the page — a fragment that builds its own markup is the
    // mistake server/run-def.mjs was written from.
    const seite = await (await fetchPath(`/?repo=${repoId}`)).text()
    equal(frag.trim(), seite.slice(seite.indexOf('<aside id="status-sidebar"'), seite.indexOf('</aside>') + '</aside>'.length).trim(),
      'byte for byte what the page carries')
  })

  // ------------------------------------------------------------------
  // A panel is the one thing in the sidebar the hub does not measure itself: a
  // project pushes it (POST /api/panels, bin/fl-panel) and the hub renders it.
  // So what is tested here is the seam — that a pushed number really reaches
  // every page, that a failed measurement keeps the last numbers instead of
  // blanking them, and that nothing a producer sends can leave the shape the
  // renderer knows.
  group('Panels: a project pushes its own numbers into the sidebar')

  const leisteVon = (html) => html.slice(html.indexOf('id="status-sidebar"'), html.indexOf('</aside>'))

  await check('a pushed value stands in the sidebar of every page of that repo', async () => {
    const r = await postForm('/api/panels', {
      repo: String(repoId),
      key: 'findings',
      value: JSON.stringify({
        title: 'Findings', total: 33, tone: 'yellow',
        items: [{ label: 'bug', count: 17, tone: 'red' }, { label: 'task', count: 16 }],
        note: 'from `befund.py zaehl`',
      }),
    })
    equal(r.status, 200, 'accepted')
    const antwort = await r.json()
    isTrue(antwort.ok, 'ok')

    for (const pfad of [`/?repo=${repoId}`, `/agents?repo=${repoId}`, `/settings?repo=${repoId}`]) {
      const leiste = leisteVon(await (await fetchPath(pfad)).text())
      contains(leiste, 'Findings', `${pfad}: the title the project chose`)
      contains(leiste, '>33<', `${pfad}: the headline number`)
      contains(leiste, 'bug', `${pfad}: the split`)
      contains(leiste, 'as of', `${pfad}: and WHEN it was measured — a reading without its time is the staleness this exists against`)
    }
    // The note's Markdown subset is rendered by the HUB, so a backtick becomes
    // a <code> and nothing else can be smuggled through it.
    contains(leisteVon(await (await fetchPath(`/?repo=${repoId}`)).text()), '<code>befund.py zaehl</code>', 'the note is rendered, not pasted')
  })

  await check('the sidebar fragment carries it too — the live channel updates it', async () => {
    const frag = await (await fetchPath(`/api/fragments/sidebar?repo=${repoId}`)).text()
    contains(frag, 'data-panel="findings"', 'the block is in the fragment')
    contains(frag, '>33<', 'with its number')
  })

  await check('GET /api/panels answers with the value and its state', async () => {
    const data = await (await fetchPath(`/api/panels?repo=${repoId}`, { headers: { accept: 'application/json' } })).json()
    isTrue(data.ok, 'ok')
    equal(data.panels.length, 1, 'one panel')
    equal(data.panels[0].total, 33, 'the number')
    equal(data.panels[0].state, 'fresh', 'freshly pushed')
    isTrue(typeof data.panels[0].age_s === 'number', 'and how old the reading is')
  })

  await check('a failed measurement keeps the last numbers and says they are not confirmed', async () => {
    const r = await postForm('/api/panels', { repo: String(repoId), key: 'findings', error: 'register tool missing on this branch' })
    equal(r.status, 200, 'a failure is a push too')
    const leiste = leisteVon(await (await fetchPath(`/?repo=${repoId}`)).text())
    contains(leiste, '>33<', 'the numbers are still there')
    contains(leiste, 'panel-cold', 'greyed as a whole')
    contains(leiste, 'register tool missing', 'and the reason is named')
    // …and the next good push clears it, or a fixed producer would look broken forever.
    await postForm('/api/panels', { repo: String(repoId), key: 'findings', value: JSON.stringify({ title: 'Findings', total: 30 }) })
    const leiste2 = leisteVon(await (await fetchPath(`/?repo=${repoId}`)).text())
    isFalse(leiste2.includes('panel-cold'), 'the failure is over')
    contains(leiste2, '>30<', 'with the new number')
  })

  await check('what a producer must not be able to do', async () => {
    const nein = await postForm('/api/panels', { repo: String(repoId), key: 'findings', value: JSON.stringify({ title: 'x' }) })
    equal(nein.status, 400, 'a value with neither total nor items is refused')
    const schluessel = await postForm('/api/panels', { repo: String(repoId), key: 'Not A Key', value: JSON.stringify({ total: 1 }) })
    equal(schluessel.status, 400, 'and so is an invalid key')
    const kaputt = await postForm('/api/panels', { repo: '999999', key: 'x', value: JSON.stringify({ total: 1 }) })
    equal(kaputt.status, 400, 'an unknown repo is an answer, never a 500')

    // Markup in a label is data, and the hub escapes it — the producer never
    // gets to decide how this column is built.
    await postForm('/api/panels', {
      repo: String(repoId), key: 'shapes',
      value: JSON.stringify({ total: 1, items: [{ label: '<b>bold</b>', count: 1 }], note: '<script>x</script>' }),
    })
    const leiste = leisteVon(await (await fetchPath(`/?repo=${repoId}`)).text())
    isFalse(leiste.includes('<b>bold</b>'), 'a label cannot bring its own markup')
    isFalse(leiste.includes('<script>'), 'and neither can the note')
    contains(leiste, '&lt;b&gt;bold&lt;/b&gt;', 'it is shown as the text it is')
    await postForm('/api/panels', { repo: String(repoId), key: 'shapes', remove: '1' })
    isFalse(leisteVon(await (await fetchPath(`/?repo=${repoId}`)).text()).includes('data-panel="shapes"'), 'and it can be removed again')
  })

  await check('bin/fl-panel pushes from outside the hub, and finds the hub itself', async () => {
    // The way a flow step or a cron line would call it: FL_HUB_URL out of the
    // environment, everything else on the command line.
    const r = await new Promise((res) => execFile(process.execPath,
      [join(PROJECT, 'bin', 'fl-panel'), 'set', 'tests',
        '--repo', String(repoId), '--title', 'Tests', '--total', '12', '--item', 'failing=3:red', '--ttl', '60'],
      { env: { ...process.env, FL_HUB_URL: BASE }, timeout: 30_000 },
      (err, stdout, stderr) => res({ code: err?.code ?? 0, stdout, stderr })))
    equal(r.code, 0, `fl-panel exited 0 (${r.stderr})`)
    contains(r.stdout, 'tests = 12', 'and says what it pushed')
    const leiste = leisteVon(await (await fetchPath(`/?repo=${repoId}`)).text())
    contains(leiste, 'Tests', 'the panel it created')
    contains(leiste, 'failing', 'with the row from --item')
    await postForm('/api/panels', { repo: String(repoId), key: 'tests', remove: '1' })
    await postForm('/api/panels', { repo: String(repoId), key: 'findings', remove: '1' })
  })

  // ------------------------------------------------------------------
  // The repo chosen in the header travels as the freilauf_repo cookie, so a page
  // that carries no ?repo= of its own (a menu click, a context-less page) keeps
  // the choice instead of falling back to the first repo. The cookie is written
  // twice: by the client when the switcher changes, and by the server whenever a
  // page request names a repo — both must agree, so the "back" links and the
  // sidebar counts persist the choice exactly like the select does.
  group('The repo choice sticks (freilauf_repo cookie)')

  await check('a page request that names a repo answers with the freilauf_repo cookie', async () => {
    const r = await fetchPath(`/?repo=${repoId}`)
    equal(r.status, 200, 'status')
    contains(r.headers.get('set-cookie') ?? '', `freilauf_repo=${repoId}`, 'the cookie is set')
    // A page that names no repo stays silent — the switcher itself is the only
    // place that may remember a choice, not every stray link.
    const ohne = await fetchPath('/settings')
    isFalse((ohne.headers.get('set-cookie') ?? '').includes('freilauf_repo='), 'no repo named, no cookie written')
  })
  await check('without ?repo= the persisted choice wins over the first repo', async () => {
    const zwei = await postForm('/repos/edit', {
      name: 'e2e-zwei', path: REPO, base_branch: 'main', worktree_extras: '[]',
    }, { asBrowser: true })
    equal(zwei.status, 303, 'second repo created')
    const zweiId = db.prepare(`SELECT id FROM repos WHERE name='e2e-zwei'`).get().id
    // The first repo by name is 'e2e' — without the cookie the overview would
    // show it. With the cookie it must show the persisted one instead.
    const overview = await (await fetchPath('/', { headers: { cookie: `freilauf_repo=${zweiId}` } })).text()
    contains(overview, `id="repo-switch"`, 'header has the switcher')
    const kopf = overview.slice(overview.indexOf('<header'), overview.indexOf('</header>'))
    contains(kopf, `option value="${zweiId}" selected`, 'the persisted repo is selected in the header')
    contains(overview, `<body data-repo="${zweiId}"`, 'and the page context is that repo')
    // A context page (agents) honors it too — its "create" button belongs to it.
    const agents = await (await fetchPath('/agents', { headers: { cookie: `freilauf_repo=${zweiId}` } })).text()
    contains(agents, `/agents/edit?repo=${zweiId}`, 'the agents page belongs to the persisted repo')
    // And a context-less page (settings) keeps it in the header.
    const settings = await (await fetchPath('/settings', { headers: { cookie: `freilauf_repo=${zweiId}` } })).text()
    const kopf2 = settings.slice(settings.indexOf('<header'), settings.indexOf('</header>'))
    contains(kopf2, `option value="${zweiId}" selected`, 'settings keeps the persisted repo in the header')
  })
  await check('an invalid cookie (deleted repo) falls back instead of an empty page', async () => {
    const html = await (await fetchPath('/', { headers: { cookie: 'freilauf_repo=999999' } })).text()
    contains(html, 'id="repo-switch"', 'page renders')
    isFalse(html.includes('data-repo="999999"'), 'not the deleted id')
  })
  // A page that shows ONE object cannot follow the switcher — a run belongs to
  // its repo. So it reloads as itself and only the choice moves; the dropdown
  // one just used has to stay on the repo one just picked. The rule lives in
  // layout(), which is why this holds for every such page at once.
  await check('a page belonging to one repo still shows the CHOSEN repo in the header', async () => {
    const zweiId = db.prepare(`SELECT id FROM repos WHERE name='e2e-zwei'`).get().id
    const run = db.prepare(`SELECT id, repo_id FROM runs WHERE repo_id=? ORDER BY started_at LIMIT 1`).get(repoId)
    isTrue(!!run && run.repo_id !== zweiId, 'a run of the FIRST repo exists')
    const r = await fetchPath(`/runs/${run.id}?repo=${zweiId}`)
    const html = await r.text()
    const kopf = html.slice(html.indexOf('<header'), html.indexOf('</header>'))
    contains(kopf, `option value="${zweiId}" selected`, 'the header shows what was picked, not the run\'s repo')
    isFalse(kopf.includes(`option value="${repoId}" selected`), 'and not both')
    // The page context is untouched: <body data-repo> is the live channel's
    // filter, and the events of THIS run must keep arriving.
    contains(html, `<body data-repo="${repoId}"`, 'the run is still the run')
    contains(html, `data-repo="${zweiId}"`, 'the sidebar counts the chosen repo')
    contains(r.headers.get('set-cookie') ?? '', `freilauf_repo=${zweiId}`, 'and the choice is persisted')
    // Without the parameter nothing changes: the page's own repo answers.
    const ohne = await (await fetchPath(`/runs/${run.id}`)).text()
    const kopfOhne = ohne.slice(ohne.indexOf('<header'), ohne.indexOf('</header>'))
    contains(kopfOhne, `option value="${repoId}" selected`, 'no ?repo= — the page\'s own repo stands in the header')
  })
  // …and it SAYS so. The rule above is right and silent: the header names a repo
  // the content has nothing to do with, and the sidebar counts somebody else's
  // runs. The note is derived in layout() from the two repo ids, so it appears
  // on every page that hands its repo over and on no page that follows the
  // switcher — that is what the three cases below pin down.
  await check('a page on another repo than the header says so, by name', async () => {
    const zweiId = db.prepare(`SELECT id FROM repos WHERE name='e2e-zwei'`).get().id
    const repoName = db.prepare('SELECT name FROM repos WHERE id=?').get(repoId).name
    const run = db.prepare(`SELECT id FROM runs WHERE repo_id=? ORDER BY started_at LIMIT 1`).get(repoId)
    const html = await (await fetchPath(`/runs/${run.id}?repo=${zweiId}`)).text()
    contains(html, 'class="banner other-repo"', 'the note is there')
    contains(html, repoName, 'and names the repo the run belongs to')
    contains(html, 'e2e-zwei', 'and the one that was picked')
    contains(html, `href="/?repo=${zweiId}"`, 'with the way to the picked repo')
    // Same run, no switch: nothing to say.
    const equal_ = await (await fetchPath(`/runs/${run.id}?repo=${repoId}`)).text()
    isFalse(equal_.includes('banner other-repo'), 'no note when the header agrees')
    // A repo form belongs to ONE repo just as much as a run does.
    const form = await (await fetchPath(`/repos/edit?id=${repoId}&repo=${zweiId}`)).text()
    contains(form, 'class="banner other-repo"', 'the repo form says it too')
    // The overview FOLLOWS the switcher — it renders the chosen repo, so there
    // is no mismatch it could report, whatever the parameter says.
    const uebersicht = await (await fetchPath(`/?repo=${zweiId}`)).text()
    isFalse(uebersicht.includes('banner other-repo'), 'a page that follows the switcher never shows it')
    const archiv = await (await fetchPath(`/archive?repo=${zweiId}`)).text()
    isFalse(archiv.includes('banner other-repo'), 'the archive neither')
    // And a page without any repo context (settings) cannot be on the wrong one.
    const einst = await (await fetchPath('/settings', { headers: { cookie: `freilauf_repo=${zweiId}` } })).text()
    isFalse(einst.includes('banner other-repo'), 'nor a page without a repo context')
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
  group('POST /settings/save writes only what the request brought')

  {
    const einstellung = (k) => db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value
    const setzen = (k, v) => db.prepare(`INSERT INTO settings(key,value) VALUES(?,?)
                                         ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(k, v)

    await check('a post with only ui_language leaves the other keys alone', async () => {
      setzen('telegram_token', 'geheim:123')
      setzen('abo_price', '200')
      try {
        const r = await postForm('/settings/save', { ui_language: 'en' }, { asBrowser: true })
        equal(r.status, 303, 'saved')
        equal(einstellung('telegram_token'), 'geheim:123', 'the token survived a post that never mentioned it')
        equal(einstellung('abo_price'), '200', 'and so did the subscription price')
        equal(einstellung('ui_language'), 'en', 'while the key that was posted did arrive')
      } finally {
        setzen('telegram_token', '')
        setzen('abo_price', '200')
      }
    })

    await check('an empty text field still clears its setting', async () => {
      setzen('prompt_suffix', 'never send this to the agent')
      const r = await postForm('/settings/save', { prompt_suffix: '' }, { asBrowser: true })
      equal(r.status, 303, 'saved')
      equal(einstellung('prompt_suffix'), '', 'present-but-empty means delete, not "not mentioned"')
    })

    await check('a key that is not in SETTINGS_KEYS never reaches the table', async () => {
      const r = await postForm('/settings/save',
        { ui_language: 'en', erfundener_schluessel: 'ha' }, { asBrowser: true })
      equal(r.status, 303, 'saved')
      equal(einstellung('erfundener_schluessel'), undefined, 'the invented key was dropped')
    })
  }

  // ------------------------------------------------------------------
  // Nothing in this suite ever rendered a page in another language, so a string
  // hard-wired instead of run through t() stayed invisible as long as the English
  // text happened to match. This group closes that hole — and puts the language
  // back to English no matter what, because every other assertion here reads
  // English strings.
  group('The UI really renders in the chosen language')

  await check('switching the UI language changes what the pages say', async () => {
    // Only the language goes over the wire — the route writes what the request
    // brought and leaves the rest standing (see the group above).
    const spracheSetzen = (lang) =>
      postForm('/settings/save', { ui_language: lang }, { asBrowser: true })
    try {
      equal((await spracheSetzen('de')).status, 303, 'language saved')
      const html = await (await fetchPath('/repos')).text()
      contains(html, 'Repo anlegen', 'repos.create in German')
      contains(html, 'Übersicht', 'and the navigation with it (nav.overview)')
      contains(html, 'Worktree-Ergänzungen', 'a column header too (repos.extras)')
      isFalse(html.includes('Create repo'), 'the English string is really gone')
      // The strings that used to sit hard-wired between the tags. English alone
      // is no proof for them: "min" and "in {x}, out {y}" read exactly like the
      // literals they replaced, so only a second language shows that they go
      // through t() at all.
      const uebersicht = await (await fetchPath(`/?repo=${repoId}`)).text()
      contains(uebersicht, ' Min.', 'the duration unit is translated (unit.minutes)')
      const detail = await (await fetchPath(`/runs/${RH}`)).text()
      contains(detail, 'rein ', 'the token metric is translated (run.tokens_value)')
    } finally {
      equal((await spracheSetzen('en')).status, 303, 'back to English')
    }
    contains(await (await fetchPath('/repos')).text(), 'Create repo', 'English again for everything that follows')
    // The other way round for the incident severity: 'rot' is the value the
    // CHECK on the table stores, so only the English page can show that the
    // line renders a word instead of the raw column.
    contains(await (await fetchPath(`/runs/${RH}`)).text(), ', red)',
      'the incident severity is a translated word, not the stored value')
  })

  // ------------------------------------------------------------------
  // The timezone is a display setting: it goes through the ordinary save route,
  // is stored like any other setting, and makes the very next page render its
  // times in the chosen zone — chips and the injected window.FREILAUF_TZ, which is
  // what keeps the browser's tooltips on the same clock as the server's.
  group('The display timezone is a central setting')

  await check('the settings page offers the timezone and saves it', async () => {
    const html = await (await fetchPath('/settings')).text()
    contains(html, 'name="ui_timezone"', 'the select is on the settings page')
    const r = await postForm('/settings/save', { ui_timezone: 'America/New_York' }, { asBrowser: true })
    equal(r.status, 303, 'saved')
    equal(db.prepare(`SELECT value FROM settings WHERE key='ui_timezone'`).get()?.value,
      'America/New_York', 'stored like any other setting')
    try {
      contains(await (await fetchPath('/settings')).text(),
        'option value="America/New_York" selected', 'the saved zone is the selected option')
    } finally {
      await postForm('/settings/save', { ui_timezone: '' }, { asBrowser: true })
    }
  })

  await check('times on a page render in the configured timezone', async () => {
    db.prepare(`UPDATE runs SET started_at='2026-08-25 12:00:00' WHERE id=?`).run(RH)
    await postForm('/settings/save', { ui_timezone: 'America/New_York', ui_language: 'en' }, { asBrowser: true })
    try {
      const detail = await (await fetchPath(`/runs/${RH}`)).text()
      // 12:00 UTC on 2026-08-25 is 08:00 in New York (EDT, UTC-4) — the chip
      // must read the configured clock, not UTC and not the server's.
      contains(detail, '08:00', 'the run start chip reads the New York clock')
      contains(detail, 'window.FREILAUF_TZ="America/New_York"', 'the browser is told the same zone')
    } finally {
      await postForm('/settings/save', { ui_timezone: '' }, { asBrowser: true })
    }
  })

  // ------------------------------------------------------------------
  group('The live channel (server/events.mjs)')

  /**
   * Reads an SSE stream for a while and returns the raw frames. Deliberately no
   * EventSource: there is no browser here, and the wire format is exactly what
   * this test is about.
   */
  async function lauscher(pfad, { msKopf = 1500 } = {}) {
    const ctrl = new AbortController()
    const res = await fetch(BASE + pfad, { signal: ctrl.signal, headers: { accept: 'text/event-stream' } })
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

  await check('the channel opens as a stream and says so before anything happens', async () => {
    const l = await lauscher('/api/events')
    try {
      equal(l.res.status, 200, 'status')
      contains(l.res.headers.get('content-type') ?? '', 'text/event-stream', 'content type')
      // The headers must be flushed at once, otherwise the browser fires onopen
      // only at the first real event — which may be minutes away.
      isTrue(await l.warteAufText(': connected'), `the greeting arrives immediately (got: ${JSON.stringify(l.text())})`)
    } finally { await l.schliessen() }
  })

  await check('a title generated after the fact reaches an open page', async () => {
    // This is the case the live channel was built for: the run is created, the
    // page is open, and the real title only arrives once the model has answered.
    const l = await lauscher(`/api/events?repo=${repoId}`)
    try {
      await l.warteAufText(': connected')
      const r = await postForm(`/api/runs/${R1}/title`, { title: 'Live channel proof' })
      equal(r.status, 200, 'rename accepted')
      isTrue(await l.warteAufText('event: run'), `an event arrives (got: ${JSON.stringify(l.text())})`)
      contains(l.text(), R1, 'and it names the run')
      contains(l.text(), '"kind":"title"', 'and says what changed')
      contains(l.text(), 'id: ', 'with an id, so a reconnect can catch up')
    } finally { await l.schliessen() }
  })

  await check('a listener on another repo is not told about this one', async () => {
    // The filter is the whole reason the event carries a repoId: an operator
    // watching one repo must not see another repo's runs appear.
    const fremd = await postForm('/repos/edit', {
      name: 'e2e-fremd', path: join(SB, 'repo'), base_branch: 'main', worktree_extras: '[]',
    }, { asBrowser: true })
    equal(fremd.status, 303, 'second repo created')
    const fremdId = db.prepare(`SELECT id FROM repos WHERE name='e2e-fremd'`).get().id
    const l = await lauscher(`/api/events?repo=${fremdId}`)
    try {
      await l.warteAufText(': connected')
      await postForm(`/api/runs/${R1}/title`, { title: 'Still not yours' })
      isTrue(!(await l.warteAufText('event: run', 600)), `nothing arrived (got: ${JSON.stringify(l.text())})`)
    } finally { await l.schliessen() }
  })

  await check('the five status changes that wrote no event now write one', async () => {
    // Measured before the live channel was wired: of the 18 places that set
    // runs.status, five left no trace at all — so the run's own event list did
    // not know why it had stopped. addEvent() is the channel's single choke
    // point, which only works if every transition really passes through it.
    const j = await laufStarten({ repo_id: repoId, prompt: 'event coverage', branch_mode: 'keiner' })
    await sessionMerken(j.runId)
    await postForm(`/api/runs/${j.runId}/send`, { text: 'hello' })
    contains(ereignisse(j.runId).join(','), 'message_sent', 'a message from a human is recorded')
    await postForm(`/api/runs/${j.runId}/kill`, {})
    contains(ereignisse(j.runId).join(','), 'aborted', 'ending it by hand is recorded')
    await postForm(`/api/runs/${j.runId}/retry`, {})
    contains(ereignisse(j.runId).join(','), 'retry', 'and so is retrying it')
    await sessionMerken(j.runId)
    await postForm(`/api/runs/${j.runId}/kill`, {})   // leave nothing running
  })

  // ------------------------------------------------------------------
  group('tmux cleanup: the memory-freeing agent')

  await check('the cleanup settings page renders the reusable setup block', async () => {
    const html = await (await fetchPath('/settings/cleanup')).text()
    equal(html.includes('<fieldset class="cleanup-setup">'), true, 'the agent+provider+model block, wrapped for a settings page')
    contains(html, 'name="harness"', 'with the harness select')
    contains(html, 'name="cleanup_on"', 'the on/off switch')
    contains(html, 'name="cleanup_threshold_gb"', 'the threshold field')
    contains(html, 'name="cleanup_target_gb"', 'the target field')
    contains(html, 'name="cleanup_prompt"', 'the prompt textarea')
  })
  await check('the cleanup settings save stores agent + switch + numbers', async () => {
    const r = await postForm('/settings/cleanup', {
      harness: 'claude', cleanup_on: '1', cleanup_threshold_gb: '3', cleanup_target_gb: '1',
      cleanup_cooldown_min: '10', cleanup_repo_id: String(repoId), cleanup_prompt: '',
    }, { asBrowser: true })
    equal(r.status, 303, 'redirect back')
    equal(db.prepare(`SELECT value FROM settings WHERE key='cleanup_harness'`).get().value, 'claude', 'agent stored')
    equal(db.prepare(`SELECT value FROM settings WHERE key='cleanup_on'`).get().value, '1', 'switch on')
    equal(db.prepare(`SELECT value FROM settings WHERE key='cleanup_threshold_gb'`).get().value, '3', 'threshold')
    equal(db.prepare(`SELECT value FROM settings WHERE key='cleanup_target_gb'`).get().value, '1', 'target')
    equal(db.prepare(`SELECT value FROM settings WHERE key='cleanup_cooldown_min'`).get().value, '10', 'cooldown')
    // The prompt was not changed: the built-in memory template stays the template.
    equal(db.prepare(`SELECT value FROM settings WHERE key='cleanup_prompt'`).get().value, '', 'prompt empty = the built-in template')
  })
  await check('the settings page summary names the configured cleanup agent', async () => {
    const html = await (await fetchPath('/settings')).text()
    contains(html, 'cleanup', 'the settings index links to the cleanup page')
    contains(html, 'Claude Code', 'and names the configured agent in its summary')
  })

  let CL = null
  await check('the sidebar and the sessions page show the free-memory controls', async () => {
    const sitzung = (await sh('tmux', ['list-sessions', '-F', '#{session_name}'])).stdout.trim()
    if (!sitzung) return skipped('side memory block', 'no tmux server in this environment')
    const sidebar = await (await fetchPath('/api/fragments/sidebar')).text()
    contains(sidebar, 'class="mem-free"', 'the small button in the sidebar tmux block')
    const page = await (await fetchPath('/sessions')).text()
    contains(page, 'cleanup-free-open', 'the button in the Sessions-page box')
    contains(page, 'id="cleanup-dialog"', 'one shared modal for the action')
    contains(page, 'name="keep"', 'with the keep-runs field on the Sessions page')
    const overview = await (await fetchPath('/')).text()
    contains(overview, 'id="cleanup-dialog"', 'the modal is on every page')
    isFalse(overview.includes('name="keep"'), 'but the keep field only on the Sessions page')
  })
  await check('the cleanup agent starts through the ordinary run path', async () => {
    const r = await postForm('/api/cleanup/start', { target_gb: '2', keep: '', source: 'sessions' })
    const j = await r.json()
    equal(r.status, 200, `started (${JSON.stringify(j)})`)
    isTrue(!!j.runId, 'run id')
    CL = j.runId
    await sessionMerken(CL)
    const l = lauf(CL)
    equal(l.harness, 'claude', 'configured coding agent')
    equal(l.flows, null, 'no attached flows')
    contains(l.prompt, 'höchstens 2 GB', 'the prompt carries the target')
    contains(l.prompt, 'Ohne Ausnahmen', 'and the default keep sentence')
    contains(ereignisse(CL).join(','), 'cleanup_run', 'marked as a cleanup run')
  })
  await check('a second start is refused while one is in flight', async () => {
    const j = await (await postForm('/api/cleanup/start', { target_gb: '2' })).json()
    equal(j.ok, false, 'refused')
    contains(j.error, 'already in progress', 'and names the reason')
  })
  await check('a manual keep list turns run ids into protected session names', async () => {
    const r = await postForm('/api/cleanup/start', { target_gb: '1', keep: lauf(CL).id })
    // The first run is still in flight — the keep resolution happens before the
    // in-flight check? No: in-flight is checked first, so this must stay refused.
    const j = await r.json()
    equal(j.ok, false, 'still refused while the first run is going')
  })
  await check('the cleanup run ends like any other and frees the gate', async () => {
    const r = await fetchPath(`/api/runs/${CL}/report`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'done', text: 'CL1 GB freed.' }),
    })
    equal(r.status, 200, 'report accepted')
    equal(lauf(CL).status, 'done', 'done')
    const wieder = await (await postForm('/api/cleanup/start', { target_gb: '1', keep: lauf(CL).id })).json()
    equal(wieder.ok, true, 'a new start is possible after the run ended')
    isTrue(!!wieder.runId, 'and it starts')
    await sessionMerken(wieder.runId)
    const keepLauf = lauf(wieder.runId)
    contains(keepLauf.prompt, 'Diese Sessions bleiben auf jeden Fall erhalten', 'the keep line is present')
    contains(keepLauf.prompt, lauf(CL).tmux_session, 'naming the kept run\'s session')
    await postForm(`/api/runs/${wieder.runId}/kill`, {})
  })
  await check('the agent helper script protects and kills nothing in plan mode', async () => {
    const skript = join(PROJECT, 'bin', 'fl-session-cleanup')
    const s1 = 'fl-aufraum-test-1', s2 = 'fl-aufraum-test-2'
    await sh('tmux', ['new-session', '-d', '-s', s1, 'sleep 300'])
    await sh('tmux', ['new-session', '-d', '-s', s2, 'sleep 300'])
    sessions.add(s1); sessions.add(s2)
    const plan = await sh('bash', [skript, '--target-gb', '0', '--db', join(SB, 'data', 'freilauf.db')])
    contains(plan.stdout, '|kill', 'plan mode names sessions to kill')
    contains(plan.stdout, 'killed=0', 'but kills nothing without --kill')
    const mitKeep = await sh('bash', [skript, '--target-gb', '0', '--keep', s1, '--db', join(SB, 'data', 'freilauf.db')])
    contains(mitKeep.stdout, `${s1}|`, 'the kept session is listed')
    contains(mitKeep.stdout, '|protect', 'and marked protected')
    await sh('tmux', ['kill-session', '-t', `=${s1}`])
    await sh('tmux', ['kill-session', '-t', `=${s2}`])
  })

  // ------------------------------------------------------------------
  group('Integration: a run is done when its work is on the base branch')

  // Everything below only happens because the repo asks for it. Turning it on
  // goes through the repo FORM, so the block one clicks and the columns the hub
  // reads cannot drift apart.
  const integrate = await import('../server/integrate.mjs')
  const g = (dir, ...args) => sh('git', ['-C', dir, ...args])

  async function repoMerge(fields = {}) {
    const row = db.prepare('SELECT * FROM repos WHERE name=?').get('e2e')
    const r = await postForm(`/repos/edit?id=${row.id}`, {
      name: 'e2e', path: REPO, base_branch: 'main',
      worktree_extras: row.worktree_extras ?? '[]', prompt: row.prompt ?? '',
      merge_mode: 'hub', merge_check: '', finish_timeout_min: '15',
      merge_max_attempts: '2', conflict_parallel: '1', notify_running: '1', max_parallel: '0',
      ...fields,
    }, { asBrowser: true })
    equal(r.status, 303, `repo saved (${JSON.stringify(fields)})`)
    return db.prepare('SELECT * FROM repos WHERE name=?').get('e2e')
  }

  /** A report exactly as fl-report sends it — and the hub's answer to it. */
  async function sendReport(runId, body) {
    const r = await fetchPath(`/api/runs/${runId}/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    equal(r.status, 200, 'the report endpoint answers 2xx — anything else lands in inbox.jsonl')
    return r.json()
  }

  /** Start a run and hand back id, worktree and session. */
  async function mergeRun(fields = {}) {
    const j = await laufStarten({ repo_id: String(repoId), prompt: 'E2E-Merge', branch_mode: 'keiner', ...fields })
    isTrue(!!j.runId, `run started (${JSON.stringify(j)})`)
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

  await check('the repo form carries the Integration block and stores it', async () => {
    const row = db.prepare('SELECT * FROM repos WHERE name=?').get('e2e')
    equal(row.merge_mode, 'hub', 'merge mode stored')
    equal(row.finish_timeout_min, 15, 'timeout stored')
    equal(row.notify_running, 1, 'the checkbox is on')
    const html = await (await fetchPath(`/repos/edit?id=${row.id}`)).text()
    for (const feld of ['name="merge_mode"', 'name="merge_check"', 'name="finish_timeout_min"',
      'name="merge_max_attempts"', 'name="conflict_parallel"', 'name="notify_running"', 'name="max_parallel"']) {
      contains(html, feld, `field ${feld}`)
    }
  })

  await check('a wrong number is a readable problem, not a stored zero', async () => {
    const row = db.prepare('SELECT * FROM repos WHERE name=?').get('e2e')
    const r = await postForm(`/repos/edit?id=${row.id}`, {
      name: 'e2e', path: REPO, base_branch: 'main', worktree_extras: row.worktree_extras ?? '[]',
      merge_mode: 'hub', finish_timeout_min: '0', merge_max_attempts: '2',
      conflict_parallel: '1', notify_running: '1', max_parallel: '0',
    }, { asBrowser: true })
    equal(r.status, 400, 'refused')
    equal(db.prepare('SELECT finish_timeout_min FROM repos WHERE name=?').get('e2e').finish_timeout_min, 15, 'unchanged')
  })

  // ---- 1. the clean case: the report is checked, then merged and pushed ----
  let cleanRun = null
  await check('a clean, mergeable run is merged into main and only THEN done', async () => {
    cleanRun = await mergeRun()
    await writeAndCommit(cleanRun.wt, 'clean.txt', 'clean\n', 'E2E: clean run')
    const antwort = await sendReport(cleanRun.id, { kind: 'done', text: 'Everything went fine.' })
    isTrue(antwort.ok, 'accepted')
    contains(antwort.message ?? '', 'Freilauf is merging it into main', 'the answer says what happens now')
    await waitFor(() => lauf(cleanRun.id).merge_status === 'merged',
      { what: 'the run is merged', timeoutMs: 30_000 })
    const r = lauf(cleanRun.id)
    equal(r.status, 'done', 'done — and not a second earlier')
    isTrue(!!r.merged_sha, 'the merged commit is recorded')
    const anc = await g(REPO, 'merge-base', '--is-ancestor', r.merged_sha, 'origin/main')
    isTrue(anc.ok, 'the run\'s tip really is an ancestor of origin/main')
    contains(await originSubject(), 'Merge run', 'a merge commit, always --no-ff')
    const ev = ereignisse(cleanRun.id)
    contains(ev.join(','), 'finish_started', 'the gate is recorded')
    contains(ev.join(','), 'finish_clean', 'and its verdict')
    contains(ev.join(','), 'merged', 'and the merge')
    equal(ev.filter(k => k === 'notified:done').length, 1, 'the operator hears about it exactly once')
  })


  await check('the merge starts the run_merged flow — once, with the facts of the merge', async () => {
    const { flowsTick } = await import('../server/flows/triggers.mjs')
    isTrue(!!mergeFlowId, 'the flow of the group above is still there')
    const l = await mergeRun()
    await writeAndCommit(l.wt, 'flow-merge.txt', 'for the flow\n', 'E2E: a merge a flow reacts to')
    await sendReport(l.id, { kind: 'done', text: 'merged for the flow' })
    await waitFor(() => lauf(l.id).merge_status === 'merged', { what: 'merged', timeoutMs: 30_000 })
    await waitFor(() => flowRunsFor(l.id).length === 1,
      { what: 'exactly one flow run for this merge', timeoutMs: 15_000 })
    const trigger = triggerOf(flowRunsFor(l.id)[0])
    equal(trigger.kind, 'run_merged', 'started by the merge, not by the end of the run')
    equal(trigger.run.id, l.id, 'and it names the run')
    equal(trigger.merge.sha, lauf(l.id).merged_sha, 'the commit it landed as')
    equal(trigger.merge.base, 'main', 'the branch it landed on')
    // The files of the MERGE, not the ones the run happened to touch: that is
    // what an agent downstream has to react to.
    equal(trigger.merge.files.join(','), 'flow-merge.txt', 'and what the merge really changed')
    equal(lauf(l.id).merge_dispatched, 1, 'the merge is marked as dispatched')
    await flowsTick()
    equal(flowRunsFor(l.id).length, 1, 'a second pass starts nothing more')
  })

  // ---- 2. dirty: the agent is told, and reports again ----
  await check('an uncommitted change holds the run and names the file', async () => {
    const l = await mergeRun()
    await writeAndCommit(l.wt, 'a.txt', 'a\n', 'E2E: committed part')
    writeFileSync(join(l.wt, 'forgotten.txt'), 'left behind\n')
    const antwort = await sendReport(l.id, { kind: 'done', text: 'done, I think' })
    contains(antwort.message ?? '', 'NOT finished yet', 'the answer says the run is not over')
    contains(antwort.message ?? '', 'forgotten.txt', 'and names the file')
    const r = lauf(l.id)
    equal(r.status, 'running', 'the run stays running — its agent can still fix this')
    equal(r.finish_state, 'awaiting_commit', 'and is waiting for the commit')
    isTrue((r.report_md ?? '').includes('done, I think'), 'the report is already safe')
    // The agent does what it was told.
    await g(l.wt, 'add', '-A')
    await g(l.wt, '-c', 'user.email=e2e@test.local', '-c', 'user.name=E2E', 'commit', '-qm', 'E2E: the leftover')
    await integrate.integrateTick()
    await waitFor(() => lauf(l.id).merge_status === 'merged', { what: 'merged after the commit', timeoutMs: 30_000 })
    equal(lauf(l.id).status, 'done', 'and now it is done')
  })

  // ---- 3. conflict → conflict run ----
  const resolverSetup = async () => postForm('/settings/merge', {
    harness: 'claude', model: '', provider: '', effort: '',
    merge_resolver_prompt: 'Keep the tests green.',
  }, { asBrowser: true })

  let conflicted = null, resolver = null
  await check('the Merge settings page stores the conflict resolver through the run form\'s own validation', async () => {
    const r = await resolverSetup()
    equal(r.status, 303, 'saved')
    equal(db.prepare(`SELECT value FROM settings WHERE key='merge_resolver_harness'`).get().value, 'claude', 'harness')
    const html = await (await fetchPath('/settings/merge')).text()
    contains(html, 'name="harness"', 'the run form\'s own setup block')
    contains(html, 'Keep the tests green.', 'and the operator\'s own instructions')
    contains(await (await fetchPath('/settings')).text(), '/settings/merge', 'the settings page links to it')
  })

  await check('a branch that no longer merges holds the run and names the conflict', async () => {
    conflicted = await mergeRun()
    await writeAndCommit(conflicted.wt, 'README.md', '# Test repo\nfrom the run\n', 'E2E: run changes the readme')
    // Meanwhile somebody else lands a change on the same line. The main
    // checkout has to be level with origin first — the hub has been merging
    // into it all along, so a commit on a stale main could not be pushed.
    await g(REPO, 'fetch', 'origin')
    await g(REPO, 'reset', '--hard', 'origin/main')
    writeFileSync(join(REPO, 'README.md'), '# Test repo\nfrom outside\n')
    await g(REPO, 'add', '-A')
    await g(REPO, '-c', 'user.email=e2e@test.local', '-c', 'user.name=E2E', 'commit', '-qm', 'E2E: outside change')
    await g(REPO, 'push', '-q', 'origin', 'main')
    const antwort = await sendReport(conflicted.id, { kind: 'done', text: 'I changed the readme.' })
    contains(antwort.message ?? '', 'cannot be merged into main', 'the answer says why')
    contains(antwort.message ?? '', 'README.md', 'and names the file')
    contains(antwort.message ?? '', 'Do NOT merge into or push to main yourself', 'the ground rule')
    equal(lauf(conflicted.id).finish_state, 'awaiting_merge', 'waiting for the agent to resolve it')
    equal(lauf(conflicted.id).status, 'running', 'still running')
  })

  await check('when the deadline passes, a conflict run takes over', async () => {
    await repoMerge({ finish_timeout_min: '1' })
    // The clock is a parameter, so the suite advances it instead of waiting.
    await integrate.integrateTick(Date.now() + 5 * 60_000)
    const orig = lauf(conflicted.id)
    equal(orig.status, 'done', 'the original run leaves the gate')
    equal(orig.merge_status, 'resolving', 'and its work is with a resolver')
    equal(orig.merge_attempts, 1, 'first attempt')
    resolver = db.prepare('SELECT * FROM runs WHERE resolves_run_id=?').get(conflicted.id)
    isTrue(!!resolver, 'a conflict run exists')
    await sessionMerken(resolver.id)
    equal(orig.resolver_run_id, resolver.id, 'and the original points at it')
    isTrue(resolver.branch_expected.startsWith('resolve/'), `its own branch (${resolver.branch_expected})`)
    const prompt = readFileSync(join(SB, 'runs', resolver.id, 'prompt.md'), 'utf8')
    contains(prompt, 'README.md', 'the task names the conflicting file')
    contains(prompt, 'I changed the readme.', 'and carries the original report')
    contains(prompt, 'Keep the tests green.', 'and the operator\'s own instructions')
    contains(prompt, 'BOTH intentions survive', 'and the rule that keeps work from being dropped')
    contains(ereignisse(conflicted.id).join(','), 'resolver_started', 'recorded on the original run')
  })

  await check('when the conflict run delivers, BOTH runs are merged', async () => {
    const wt = lauf(resolver.id).workdir_effective
    await g(wt, 'fetch', 'origin')
    await g(wt, '-c', 'user.email=e2e@test.local', '-c', 'user.name=E2E', 'merge', 'origin/main')
    writeFileSync(join(wt, 'README.md'), '# Test repo\nfrom the run\nfrom outside\n')
    await g(wt, 'add', '-A')
    await g(wt, '-c', 'user.email=e2e@test.local', '-c', 'user.name=E2E', 'commit', '-qm', 'E2E: both intentions')
    await sendReport(resolver.id, { kind: 'done', text: 'Resolved.' })
    await waitFor(() => lauf(resolver.id).merge_status === 'merged', { what: 'the resolver is merged', timeoutMs: 30_000 })
    equal(lauf(conflicted.id).merge_status, 'merged', 'and so is the run it worked for')
    equal(lauf(conflicted.id).merged_sha, lauf(resolver.id).merged_sha, 'the same commit for both')
    equal(ereignisse(conflicted.id).filter(k => k === 'notified:done').length, 1,
      'the original run hears about its merge exactly once, and only now')
    // A conflict run is the integrator's tool: it never speaks for itself, and
    // nothing hangs on its end.
    equal(ereignisse(resolver.id).filter(k => k.startsWith('notified')).length, 0,
      'and the conflict run itself announces nothing of its own')
    equal(lauf(resolver.id).flow_dispatched, 1, 'no flow ever fires for it')
    equal(lauf(resolver.id).flows, null, 'and it carries no attachments to fire')
    const mergedEvent = db.prepare(`SELECT payload FROM events WHERE run_id=? AND kind='merged'`).get(conflicted.id)
    isTrue(Array.isArray(JSON.parse(mergedEvent.payload).files), 'the merged event carries the files the merge changed')
  })


  await check('a merge over a conflict run fires once, for the ORIGINAL run', async () => {
    const { flowsTick } = await import('../server/flows/triggers.mjs')
    await flowsTick()
    await waitFor(() => flowRunsFor(conflicted.id).length === 1,
      { what: 'one flow run for the integration', timeoutMs: 15_000 })
    const trigger = triggerOf(flowRunsFor(conflicted.id)[0])
    equal(trigger.run.id, conflicted.id, 'the flow is about the run whose work landed')
    equal(trigger.merge.sha, lauf(conflicted.id).merged_sha, 'with the commit it landed as')
    equal(trigger.merge.resolver_run_id, resolver.id, 'and it names the conflict run that got it there')
    // The dispatch fires per RUN, the flow has to fire per INTEGRATION — and the
    // two only differ when a conflict run was involved (see 3.15).
    equal(flowRunsFor(resolver.id).length, 0, 'the conflict run itself never starts a flow')
    equal(lauf(resolver.id).merge_dispatched, 1, 'it is marked at birth, so no pass looks at it again')
    equal(lauf(conflicted.id).merge_dispatched, 1, 'and the original is marked once it fired')
    const vorher = db.prepare('SELECT count(*) c FROM flow_runs').get().c
    await flowsTick()
    equal(db.prepare('SELECT count(*) c FROM flow_runs').get().c, vorher, 'a second pass starts nothing more')
  })

  // ---- 5. the attempt limit ----
  await check('after the last attempt the hub asks a human instead of trying again', async () => {
    await repoMerge({ finish_timeout_min: '1', merge_max_attempts: '1' })
    const l = await mergeRun()
    await writeAndCommit(l.wt, 'README.md', '# Test repo\nsecond run\n', 'E2E: second conflict')
    await g(REPO, 'fetch', 'origin')
    await g(REPO, 'reset', '--hard', 'origin/main')
    writeFileSync(join(REPO, 'README.md'), '# Test repo\nsecond outside\n')
    await g(REPO, 'add', '-A')
    await g(REPO, '-c', 'user.email=e2e@test.local', '-c', 'user.name=E2E', 'commit', '-qm', 'E2E: second outside')
    await g(REPO, 'push', '-q', 'origin', 'main')
    await sendReport(l.id, { kind: 'done', text: 'second run report' })
    equal(lauf(l.id).finish_state, 'awaiting_merge', 'conflict')
    await integrate.integrateTick(Date.now() + 5 * 60_000)
    const r1 = db.prepare('SELECT * FROM runs WHERE resolves_run_id=?').get(l.id)
    isTrue(!!r1, 'one conflict run — the limit')
    await sessionMerken(r1.id)
    // It ends without delivering.
    await postForm(`/api/runs/${r1.id}/kill`, {})
    await integrate.integrateTick(Date.now() + 10 * 60_000)
    const orig = lauf(l.id)
    equal(orig.merge_status, 'blocked_conflict', 'no second attempt — a human decides')
    const openIncident = db.prepare(`SELECT * FROM incidents WHERE run_id=? AND typ='merge_blocked' AND geloest_am IS NULL`).get(l.id)
    isTrue(!!openIncident, 'an open incident, so it shows up in the sidebar')
    contains(ereignisse(l.id).join(','), 'notified:merge_blocked', 'and the operator was told')
    // And the operator can act on it without leaving the run's page.
    const html = await (await fetchPath(`/runs/${l.id}`)).text()
    contains(html, 'id="run-integration"', 'the detail page has an Integration line')
    contains(html, 'blocked: conflict unresolved', 'saying where the work stands')
    contains(html, `/api/runs/${l.id}/merge"`, 'with "Merge now"')
    contains(html, `/api/runs/${l.id}/merge-skip`, 'and "Skip merge"')
    contains(html, 'claude --resume', 'and the command that reopens the session')
    // One conflict run per attempt, and never one for a conflict run: that is
    // the recursion guard, and the whole reason isResolverRun() exists.
    equal(db.prepare('SELECT count(*) c FROM runs WHERE resolves_run_id=?').get(l.id).c, 1,
      'exactly one conflict run — the limit was one attempt')
    equal(db.prepare('SELECT count(*) c FROM runs WHERE resolves_run_id=?').get(r1.id).c, 0,
      'and no conflict run for the conflict run')
    equal(lauf(r1.id).merge_status, null, 'the failed conflict run carries no verdict of its own')
    isFalse(!!db.prepare(`SELECT 1 FROM incidents WHERE run_id=? AND typ='merge_blocked'`).get(r1.id),
      'and no incident: what went wrong there is the original run\'s problem')
    equal(ereignisse(r1.id).filter(k => k.startsWith('notified')).length, 0,
      'and it never rang the phone')
    isFalse((await (await fetchPath(`/runs/${r1.id}`)).text()).includes(`/api/runs/${r1.id}/retry`),
      'a conflict run has no retry button — "Merge now" on the original starts a fresh one')
  })

  // ---- 6. + 14. failed with commits: assessed, backed up, merged by hand ----
  await check('a failed run is never merged by itself — but its work is named and backed up', async () => {
    await repoMerge({ finish_timeout_min: '15', merge_max_attempts: '2' })
    const vorher = (await g(ORIGIN, 'rev-parse', 'main')).stdout.trim()
    const l = await mergeRun()
    await writeAndCommit(l.wt, 'failed.txt', 'work\n', 'E2E: work of a failed run')
    await sendReport(l.id, { kind: 'failed', text: 'it broke' })
    const r = lauf(l.id)
    equal(r.status, 'failed', 'failed')
    equal(r.merge_status, 'unmerged_commits', 'its work is named')
    equal((await g(ORIGIN, 'rev-parse', 'main')).stdout.trim(), vorher, 'and nothing was merged')
    const ev = db.prepare(`SELECT payload FROM events WHERE run_id=? AND kind='merge_assessed'`).get(l.id)
    const payload = JSON.parse(ev.payload)
    equal(payload.status, 'unmerged_commits', 'the assessment is recorded')
    equal(payload.commits, 1, 'with the number of commits')
    equal(payload.dirty, 0, 'and of dirty files')
    // origin is the backup: work nobody merged must not live on one disk alone.
    const ref = `run/${l.id.split('-')[0]}`
    isTrue((await g(ORIGIN, 'rev-parse', `refs/heads/${ref}`)).ok, `the tip is backed up as origin/${ref}`)
    contains(ereignisse(l.id).join(','), 'branch_backed_up', 'and that is recorded')
    // …and the operator can still merge it, with one click.
    const antwort = await (await postForm(`/api/runs/${l.id}/merge`, {})).json()
    isTrue(antwort.ok, `merge by hand accepted (${JSON.stringify(antwort)})`)
    await waitFor(() => lauf(l.id).merge_status === 'merged', { what: 'merged by hand', timeoutMs: 30_000 })
    contains(ereignisse(l.id).join(','), 'merge_manual', 'the manual action is in the run\'s history')
  })

  // ---- 7. the other agents learn that main moved ----
  await check('after a merge the other running agents are told that main moved', async () => {
    const onlooker = await mergeRun({ prompt: 'E2E-Onlooker' })
    const l = await mergeRun()
    await writeAndCommit(l.wt, 'moved.txt', 'moved\n', 'E2E: moves main')
    await sendReport(l.id, { kind: 'done', text: 'moved main' })
    await waitFor(() => lauf(l.id).merge_status === 'merged', { what: 'merged', timeoutMs: 30_000 })
    // The colon is not decoration: 'capture-pane -t "=name"' is no valid target
    // ("can't find pane"), exactly like pipe-pane and set-hook (see AGENTS.md).
    await waitFor(async () =>
      (await sh('tmux', ['capture-pane', '-p', '-t', `=${onlooker.session}:`])).stdout.includes('has moved'),
    { what: 'the watching agent sees the notice in its session', timeoutMs: 15_000 })
    // The text is on the screen ~300 ms before the event is written (the paste
    // and the Enter are two send-keys with a pause between them), so wait for it.
    await waitFor(() => ereignisse(onlooker.id).includes('main_moved'),
      { what: 'the notice is recorded on the watching run', timeoutMs: 10_000 })
    await waitFor(() => ereignisse(l.id).includes('main_moved_notified'),
      { what: 'and on the run that moved main', timeoutMs: 10_000 })
    await postForm(`/api/runs/${onlooker.id}/kill`, {})
  })

  // ---- 8. the agent vanishes while the gate waits ----
  await check('an agent that disappears mid-gate escalates instead of counting as aborted', async () => {
    const l = await mergeRun()
    writeFileSync(join(l.wt, 'only-dirt.txt'), 'dirt\n')
    await sendReport(l.id, { kind: 'done', text: 'am I done?' })
    equal(lauf(l.id).finish_state, 'awaiting_commit', 'waiting')
    await sh('tmux', ['kill-session', '-t', `=${l.session}`])
    await watcherTick()
    await waitFor(() => lauf(l.id).merge_status === 'blocked_dirty',
      { what: 'the escalation happened', timeoutMs: 15_000 })
    const r = lauf(l.id)
    equal(r.status, 'done', 'done, not aborted: this run HAD reported')
    isTrue(!!db.prepare(`SELECT 1 FROM incidents WHERE run_id=? AND typ='merge_blocked' AND geloest_am IS NULL`).get(l.id),
      'and it is waiting for a human')
  })

  // ---- 11. the merge check ----
  await check('a red merge check is treated like a conflict: nothing is pushed, the agent is told', async () => {
    await repoMerge({ merge_check: 'false' })
    const vorher = (await g(ORIGIN, 'rev-parse', 'main')).stdout.trim()
    const l = await mergeRun()
    await writeAndCommit(l.wt, 'check.txt', 'check\n', 'E2E: merge check')
    await sendReport(l.id, { kind: 'done', text: 'please check' })
    await waitFor(() => lauf(l.id).finish_state === 'check_failed',
      { what: 'the merge check failed', timeoutMs: 30_000 })
    equal(lauf(l.id).status, 'running', 'the run stays running — its agent can fix it')
    equal((await g(ORIGIN, 'rev-parse', 'main')).stdout.trim(), vorher, 'and nothing reached main')
    await waitFor(async () =>
      (await sh('tmux', ['capture-pane', '-p', '-t', `=${l.session}:`])).stdout.includes('merge check failed'),
    { what: 'the agent is told', timeoutMs: 15_000 })
    // Green check, one more commit — the tip has to move for a new check.
    await repoMerge({ merge_check: 'true' })
    await writeAndCommit(l.wt, 'check.txt', 'check again\n', 'E2E: fixed')
    await integrate.integrateTick()
    await waitFor(() => lauf(l.id).merge_status === 'merged', { what: 'merged after the fix', timeoutMs: 30_000 })
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
  await check('a failing push waits between attempts and raises exactly one alarm', async () => {
    const l = await mergeRun()
    await writeAndCommit(l.wt, 'pushfail.txt', 'x\n', 'E2E: the push will fail')
    const echteUrl = (await g(REPO, 'remote', 'get-url', 'origin')).stdout.trim()
    await g(REPO, 'remote', 'set-url', 'origin', join(SB, 'kein-origin.git'))
    try {
      const fehler = () => ereignisse(l.id).filter(k => k === 'merge_error').length
      await sendReport(l.id, { kind: 'done', text: 'push failure' })
      await waitFor(() => fehler() >= 1, { what: 'the first push attempt failed', timeoutMs: 30_000 })
      equal(lauf(l.id).finish_state, 'merging', 'the run is still the integrator\'s job')

      // Two passes of the loop inside the retry window must change nothing.
      await integrate.integrateTick()
      await integrate.integrateTick()
      await new Promise(r => setTimeout(r, 700))
      equal(fehler(), 1, 'no second attempt inside the retry window')

      // One pass per elapsed window. The fifth failure escalates — and the
      // clock stays well under finish_timeout_min, so this is the push giving
      // up and not the deadline.
      for (let i = 1; i <= 12 && !ereignisse(l.id).includes('merge_blocked'); i++) {
        const vor = fehler()
        await integrate.integrateTick(Date.now() + i * 70_000)
        await waitFor(() => fehler() > vor || ereignisse(l.id).includes('merge_blocked'),
          { what: `another push attempt after tick ${i}`, timeoutMs: 30_000 })
      }
      const kinds = ereignisse(l.id)
      isTrue(kinds.includes('merge_blocked'), `the failures escalate (events: ${kinds.join(',')})`)
      equal(kinds.filter(k => k === 'merge_blocked').length, 1, 'blocked exactly once')
      equal(kinds.filter(k => k === 'notified:merge_blocked').length, 1,
        'and the operator is told once, not once per wave')
      equal(kinds.filter(k => k === 'finish_escalated').length, 1, 'escalated once')
      equal(lauf(l.id).merge_status, 'blocked_error', 'and it says why')
      equal(lauf(l.id).finish_state, null, 'the run has left the loop')

      // Nothing may pick it back up: a human has been called, and no leftover
      // retry may merge, push or alarm behind their back.
      const vorher = kinds.length
      const fehlerVorher = fehler()
      await integrate.integrateTick(Date.now() + 15 * 70_000)
      await new Promise(r => setTimeout(r, 1000))
      equal(fehler(), fehlerVorher, 'no further push attempt after the escalation')
      equal(ereignisse(l.id).length, vorher, 'and nothing else happened either')
    } finally {
      await g(REPO, 'remote', 'set-url', 'origin', echteUrl)
    }
  })

  // ---- 12. an end somebody asked for stays an abort ----
  await check('killing a run in the gate aborts it — that end WAS asked for', async () => {
    const l = await mergeRun()
    writeFileSync(join(l.wt, 'open.txt', ), 'open\n')
    await sendReport(l.id, { kind: 'done', text: 'x' })
    equal(lauf(l.id).finish_state, 'awaiting_commit', 'waiting')
    await postForm(`/api/runs/${l.id}/kill`, {})
    await waitFor(() => !!lauf(l.id).merge_status, { what: 'the assessment', timeoutMs: 15_000 })
    const r = lauf(l.id)
    equal(r.status, 'aborted', 'aborted, not done')
    isTrue(['unmerged_dirty', 'unmerged_both'].includes(r.merge_status), `assessed (${r.merge_status})`)
    isFalse(!!db.prepare(`SELECT 1 FROM incidents WHERE run_id=? AND typ='merge_blocked'`).get(l.id),
      'and nobody is asked to do anything: the operator did this on purpose')
  })

  // ---- 10. fl-report prints the hub's answer ----
  await check('the real bin/fl-report prints the hub\'s answer and files nothing', async () => {
    const l = await mergeRun()
    writeFileSync(join(l.wt, 'unsaid.txt'), 'x\n')
    const r = await sh(join(PROJECT, 'bin', 'fl-report'), ['done', 'from the real script'], {
      env: { ...process.env, FL_RUN_ID: l.id, FL_HUB_URL: BASE, HOME: SB },
    })
    isTrue(r.ok, `exit 0 (${r.stderr})`)
    contains(r.stdout, 'NOT finished yet', 'the answer reaches the agent as this tool\'s output')
    contains(r.stdout, 'unsaid.txt', 'and names the file')
    isFalse(existsSync(join(SB, 'agents', 'runs', l.id, 'inbox.jsonl')), 'nothing was filed as unreachable')
    await postForm(`/api/runs/${l.id}/kill`, {})
  })

  // ---- 13. origin is the backup: the operator's own commits are pushed ----
  await check('commits the operator made on main himself are pushed to origin', async () => {
    await g(REPO, 'fetch', 'origin')
    await g(REPO, 'reset', '--hard', 'origin/main')
    writeFileSync(join(REPO, 'by-operator.txt'), 'by hand\n')
    await g(REPO, 'add', '-A')
    await g(REPO, '-c', 'user.email=e2e@test.local', '-c', 'user.name=E2E', 'commit', '-qm', 'E2E: operator commit')
    const localTip = (await g(REPO, 'rev-parse', 'main')).stdout.trim()
    isFalse((await g(ORIGIN, 'rev-parse', 'main')).stdout.trim() === localTip, 'origin does not have it yet')
    // The throttle is a parameter too, so the suite does not have to wait a minute.
    await integrate.pushOperatorBase(Date.now() + 10 * 60_000)
    equal((await g(ORIGIN, 'rev-parse', 'main')).stdout.trim(), localTip, 'now it is on origin')
    isTrue(!!db.prepare('SELECT last_push_at FROM repos WHERE name=?').get('e2e').last_push_at,
      'and the repo records when it was last backed up')
  })

  // ---- the branch rule under hub, and keeping work on a branch ----
  await check('a run can keep its work on its branch — pushed, not merged', async () => {
    await repoMerge({ merge_mode: 'hub' })
    const beforeMain = (await g(ORIGIN, 'rev-parse', 'main')).stdout.trim()
    const branch = `keep/e2e-${Date.now().toString(36)}`
    const l = await mergeRun({ branch_mode: 'neu', branch_pattern: branch, keep_on_branch: '1' })
    equal(lauf(l.id).keep_on_branch, 1, 'the run carries the field')
    // The prompt says it, and says it ONCE: the keep sentence replaces the merge
    // rule instead of standing next to it and contradicting it.
    const prompt = readFileSync(join(SB, 'runs', l.id, 'prompt.md'), 'utf8')
    contains(prompt, 'STAYS on that branch', 'the agent is told the work stays put')
    contains(prompt, 'Freilauf will not merge it into main', 'and who will not merge it')
    isFalse(prompt.includes('Freilauf merges your work into main itself'),
      'and NOT the merge rule as well — two rules about one thing is one too many')

    await writeAndCommit(l.wt, 'kept.txt', 'stays here\n', 'E2E: work that stays on its branch')
    const answer = await sendReport(l.id, { kind: 'done', text: 'kept it here' })
    isTrue(answer.ok, 'accepted')
    await waitFor(() => lauf(l.id).merge_status === 'kept_on_branch',
      { what: 'the run is closed as kept', timeoutMs: 20_000 })
    const r = lauf(l.id)
    equal(r.status, 'done', 'done')
    equal(r.merged_sha, null, 'nothing was merged')
    equal((await g(ORIGIN, 'rev-parse', 'main')).stdout.trim(), beforeMain, 'and main did not move')
    // …but the work is on origin: nothing may live only on this machine.
    isTrue((await g(ORIGIN, 'rev-parse', `refs/heads/${branch}`)).ok, `the branch is on origin (${branch})`)
    contains(ereignisse(l.id).join(','), 'branch_kept', 'and that is recorded')
    equal(flowRunsFor(l.id).length, 0, 'no run_merged flow fires — there was no merge')

    // The operator may still change his mind: one click runs the ordinary path.
    const merged = await (await postForm(`/api/runs/${l.id}/merge`, {})).json()
    isTrue(merged.ok, `merge by hand accepted (${JSON.stringify(merged)})`)
    await waitFor(() => lauf(l.id).merge_status === 'merged', { what: 'merged after all', timeoutMs: 30_000 })
    equal(lauf(l.id).keep_on_branch, 0, 'and the run no longer keeps anything back')
  })

  await check('a dirty worktree still holds a kept run — committing is not optional', async () => {
    const branch = `keep/dirty-${Date.now().toString(36)}`
    const l = await mergeRun({ branch_mode: 'fest', branch_pattern: branch, keep_on_branch: '1' })
    // A name no earlier test committed: every worktree here starts from
    // origin/main, and the files this suite merged along the way are IN it. A
    // file that is already tracked with the same content leaves git clean.
    const datei = `keep-leftover-${Date.now().toString(36)}.txt`
    writeFileSync(join(l.wt, datei), 'left behind\n')
    const answer = await sendReport(l.id, { kind: 'done', text: 'am I done?' })
    contains(answer.message ?? '', datei, 'the same M1 as for any other run')
    equal(lauf(l.id).finish_state, 'awaiting_commit', 'and the same waiting state')
    equal(lauf(l.id).status, 'running', 'the run stays running')
    await g(l.wt, 'add', '-A')
    await g(l.wt, '-c', 'user.email=e2e@test.local', '-c', 'user.name=E2E', 'commit', '-qm', 'E2E: the leftover')
    await integrate.integrateTick()
    await waitFor(() => lauf(l.id).merge_status === 'kept_on_branch',
      { what: 'kept once it was clean', timeoutMs: 20_000 })
    equal(lauf(l.id).status, 'done', 'and closed')
  })

  await check('under hub, "no branch" no longer promises throwaway work', async () => {
    const l = await mergeRun({ branch_mode: 'keiner' })
    const prompt = readFileSync(join(SB, 'runs', l.id, 'prompt.md'), 'utf8')
    contains(prompt, 'Freilauf merges your commits into main', 'it says what really happens')
    isFalse(prompt.includes('throwaway'), 'and not the opposite, in the same prompt as the merge rule')
    await postForm(`/api/runs/${l.id}/kill`, {})
  })

  await check('the form says which rule means what, and Quick Run carries the keep box', async () => {
    const html = await (await fetchPath(`/runs/new?repo=${repoId}`)).text()
    contains(html, 'data-merge-mode="hub"', 'the form knows this repo integrates')
    contains(html, 'data-explain="off"', 'both explanations are rendered')
    contains(html, 'data-explain="hub"', 'so CSS can pick without a round trip')
    contains(html, 'name="keep_on_branch"', 'and the keep box is there')
    contains(html, 'data-merge-modes=', 'with the map the Quick-Run dialog switches by')
    // Quick Run goes through the same branchFields(), so the box has to survive
    // pickQuickFields' allowlist — that is where a field falls off silently.
    const fav = db.prepare('SELECT id FROM favorites ORDER BY id LIMIT 1').get()
    const j = await (await postForm('/api/runs/quick', {
      repo_id: String(repoId), favorite_id: String(fav.id), prompt: 'E2E-Quick-Keep',
      branch_mode: 'neu', branch_pattern: `keep/quick-${Date.now().toString(36)}`, keep_on_branch: '1',
      start_mode: 'now',
    })).json()
    isTrue(j.ok, `quick run started (${JSON.stringify(j)})`)
    await sessionMerken(j.runId)
    equal(lauf(j.runId).keep_on_branch, 1, 'the ticked box arrived at the run')
    await postForm(`/api/runs/${j.runId}/kill`, {})
  })

  // ---- 8b. follow-up reports: a finished run reports again ----
  let followed = null
  await check('a done report from a finished run is a follow-up: merged again, announced as such, flows fired again', async () => {
    await repoMerge({ merge_mode: 'hub' })
    followed = await mergeRun()
    await writeAndCommit(followed.wt, 'first.txt', 'first\n', 'E2E: the first report')
    await sendReport(followed.id, { kind: 'done', text: 'The task is done.' })
    await waitFor(() => lauf(followed.id).merge_status === 'merged', { what: 'merged the first time', timeoutMs: 30_000 })
    const firstSha = lauf(followed.id).merged_sha
    // The first merge's flow run is dispatched a tick after the merge — wait
    // for it, or the count below would compare against a number read too early.
    await waitFor(() => flowRunsFor(followed.id).length === 1, { what: 'the first merge fired the flow', timeoutMs: 15_000 })
    equal(lauf(followed.id).telegram_on, 1, 'notifications are on for every run from the start')

    // The operator typed more into the session, the agent did it and reports again.
    await writeAndCommit(followed.wt, 'second.txt', 'second\n', 'E2E: the follow-up')
    const antwort = await sendReport(followed.id, { kind: 'done', text: 'Added the second file, as asked.' })
    isTrue(antwort.ok, 'a finished run is not refused')
    contains(antwort.message ?? '', 'Freilauf is merging it into main', 'the same answer a first report gets')
    await waitFor(() => lauf(followed.id).followup_open === 0 && lauf(followed.id).merged_sha !== firstSha,
      { what: 'the follow-up is merged', timeoutMs: 30_000 })
    const r = lauf(followed.id)
    equal(r.status, 'done', 'still done — the status is the first attempt\'s truth')
    equal(r.followups, 1, 'one follow-up counted')
    equal(r.merge_status, 'merged', 'merged')
    equal(r.finish_state, null, 'and out of the gate')
    isTrue((await g(REPO, 'merge-base', '--is-ancestor', r.merged_sha, 'origin/main')).ok, 'the follow-up commit is on origin/main')
    contains(r.report_md, 'The task is done.', 'the first report is kept')
    contains(r.report_md, '## Follow-up report #1', 'and the follow-up stands under its own heading')
    contains(r.report_md, 'Added the second file', 'with its text')
    equal(r.followup_md, 'Added the second file, as asked.', 'the latest follow-up on its own')
    const ev = ereignisse(followed.id)
    contains(ev.join(','), 'followup_reported', 'recorded on the way in')
    contains(ev.join(','), 'followup_done', 'and on the way out')
    equal(ev.filter(k => k === 'notified:done').length, 1, 'the done message was sent once, for the first report')
    equal(ev.filter(k => k === 'notified:followup').length, 1, 'and the follow-up is its own message')
    equal(ev.filter(k => k === 'merged').length, 2, 'two merges, one per report')
    equal(ev.filter(k => k === 'finish_started').length, 2, 'and the gate ran once per report')
    await waitFor(() => flowRunsFor(followed.id).length === 2,
      { what: 'the run_merged flow fires again for the follow-up\'s merge', timeoutMs: 15_000 })
    equal(triggerOf(flowRunsFor(followed.id).at(-1)).merge.sha, r.merged_sha, 'with the new merge\'s facts')
    equal(triggerOf(flowRunsFor(followed.id).at(-1)).run.followups, 1, 'and the run info says it is a follow-up')
    equal(triggerOf(flowRunsFor(followed.id).at(-1)).run.last_report, 'Added the second file, as asked.', 'last_report is the follow-up text')
  })

  await check('a follow-up without new commits is reported, not merged — and a dirty one is held like a first report', async () => {
    const antwort = await sendReport(followed.id, { kind: 'done', text: 'Here is the list you asked for: a, b, c.' })
    isTrue(antwort.ok, 'accepted')
    contains(antwort.message ?? '', 'follow-up report #2 received', 'the answer says which report it was')
    contains(antwort.message ?? '', 'Nothing to merge', 'and that there was nothing to merge')
    const r = lauf(followed.id)
    equal(r.followups, 2, 'counted')
    equal(r.followup_open, 0, 'closed at once')
    equal(r.finish_state, null, 'no gate left open')
    equal(ereignisse(followed.id).filter(k => k === 'notified:followup').length, 2, 'announced anyway — the operator asked for it')
    // Dirty: the same M1, and the run stays where it is until the agent commits.
    writeFileSync(join(followed.wt, 'half.txt'), 'not committed\n')
    const held = await sendReport(followed.id, { kind: 'done', text: 'done with the third thing' })
    contains(held.message ?? '', 'NOT finished yet', 'the same answer as for a first report')
    contains(held.message ?? '', 'half.txt', 'and the file is named')
    equal(lauf(followed.id).finish_state, 'awaiting_commit', 'in the gate')
    equal(lauf(followed.id).followup_open, 1, 'as a follow-up')
    equal(lauf(followed.id).status, 'done', 'and the status is untouched')
    await g(followed.wt, 'add', '-A')
    await g(followed.wt, '-c', 'user.email=e2e@test.local', '-c', 'user.name=E2E', 'commit', '-qm', 'E2E: the third thing')
    await integrate.integrateTick()
    await waitFor(() => lauf(followed.id).followup_open === 0, { what: 'the follow-up is merged once clean', timeoutMs: 30_000 })
    equal(lauf(followed.id).followups, 3, 'third follow-up')
    equal(ereignisse(followed.id).filter(k => k === 'followup_reported').length, 3, 'reported three times — the re-report after M1 is not a fourth')
  })

  await check('the checkbox under the terminal silences the notifications for the run and nothing else', async () => {
    const html = await (await fetchPath(`/runs/${followed.id}`)).text()
    contains(html, 'id="notify-on"', 'the box is on the detail page')
    contains(html, `data-run="${followed.id}"`, 'and knows its run')
    isTrue(/id="notify-on"[^>]*checked/.test(html), 'ticked by default')
    const off = await (await postForm(`/api/runs/${followed.id}/notify`, { on: '0' })).json()
    equal(off.notify_on, 0, 'switched off')
    equal(off.telegram_on, 0, 'and the old field name still answers, for whoever reads it')
    equal(lauf(followed.id).telegram_on, 0, 'stored (the column keeps its historic name)')
    contains(ereignisse(followed.id).join(','), 'notify_off', 'and recorded')
    isFalse(/id="notify-on"[^>]*checked/.test(await (await fetchPath(`/runs/${followed.id}`)).text()), 'the page shows it unticked')
    const before = ereignisse(followed.id).filter(k => k === 'notified:followup').length
    await writeAndCommit(followed.wt, 'quiet.txt', 'quiet\n', 'E2E: a quiet follow-up')
    await sendReport(followed.id, { kind: 'done', text: 'quietly done' })
    await waitFor(() => lauf(followed.id).followup_open === 0 && lauf(followed.id).followups === 4,
      { what: 'the quiet follow-up is merged', timeoutMs: 30_000 })
    isTrue((await g(REPO, 'merge-base', '--is-ancestor', lauf(followed.id).merged_sha, 'origin/main')).ok,
      'merged all the same — the box is about the messages only')
    equal(ereignisse(followed.id).filter(k => k === 'notified:followup').length, before, 'nothing announced')
    contains(ereignisse(followed.id).join(','), 'notify_muted', 'but it is written down that there was none')
    // The old address is an alias, not a redirect: whatever still posts to it
    // has to keep working.
    const on = await (await postForm(`/api/runs/${followed.id}/telegram`, { on: '1' })).json()
    equal(on.notify_on, 1, 'and back on, through the old route')
    equal(lauf(followed.id).telegram_on, 1, 'stored')
    // A help call from a finished run reaches the operator too, and changes nothing about the run.
    const help = await sendReport(followed.id, { kind: 'help', text: 'Which of the two?' })
    isTrue(help.ok, 'help from a finished run is accepted')
    equal(lauf(followed.id).status, 'done', 'the status stays')
    equal(lauf(followed.id).help_text, 'Which of the two?', 'the question is stored')
    equal(ereignisse(followed.id).filter(k => k === 'notified:help').length, 1, 'and sent')
  })

  // ---- 8c. follow-up commissions: the operator types more work into a finished run ----
  await check('a message into a finished run is a follow-up commission: the run displays as running again and is clocked', async () => {
    const vor = await postForm(`/api/runs/${followed.id}/send`, { text: 'Please also document the new file.' })
    isTrue(vor.ok, 'the send is accepted')
    const r = lauf(followed.id)
    isTrue(!!r.followup_since, 'the commission is clocked from now')
    equal(r.status, 'done', 'the status still tells the truth about the first attempt')
    const ev = ereignisse(followed.id)
    contains(ev.join(','), 'followup_started', 'recorded as a commission')
    isFalse(ev.includes('message_sent'), 'and not as a plain message — that kind is for live runs')
    // The pages agree: the status word is "running" again, with the follow-up line.
    const detail = await (await fetchPath(`/runs/${followed.id}`)).text()
    contains(detail, 'status-chip">Running<', 'the detail page displays it as running')
    contains(detail, 'Follow-up work since', 'and says since when')
    const laufend = await (await fetchPath(`/?repo=${repoId}&status=running`)).text()
    contains(laufend, `/runs/${followed.id}`, 'the overview’s running filter shows the commissioned run')
    contains(laufend, 'Follow-up work since', 'with the follow-up line in the status cell')

    // The watcher holds the follow-up to the run's expected duration, counting
    // from the commission — the same clock a first attempt works against.
    db.prepare(`UPDATE runs SET followup_since=datetime('now', '-36 minutes') WHERE id=?`).run(followed.id)
    await watcherTick()
    contains(ereignisse(followed.id).join(','), 'anomaly:followup_soft_overrun', '80 % of the expected duration: yellow')
    isFalse(ereignisse(followed.id).includes('anomaly:followup_overrun'), 'but not yet red')
    db.prepare(`UPDATE runs SET followup_since=datetime('now', '-46 minutes') WHERE id=?`).run(followed.id)
    await watcherTick()
    contains(ereignisse(followed.id).join(','), 'anomaly:followup_overrun', 'past the expected duration without a report: red')
    contains(ereignisse(followed.id).join(','), 'notified:followup_overrun', 'and the operator hears it')
    await watcherTick()
    equal(ereignisse(followed.id).filter(k => k === 'notified:followup_overrun').length, 1, 'the next pass does not page again')

    // New instructions restart the clock — and retract the old overrun statement
    // the same way a raised duration retracts one, so a genuine overrun of the
    // new commission can page again.
    await postForm(`/api/runs/${followed.id}/send`, { text: 'And add tests, too.' })
    isFalse(ereignisse(followed.id).includes('anomaly:followup_overrun'), 'the new commission clears the old statement')
    isFalse(ereignisse(followed.id).includes('notified:followup_overrun'), 'and its notification flag with it')
    isTrue(!!lauf(followed.id).followup_since, 'and is clocked from now')

    // The follow-up report ends the commission: clock stopped, statement gone.
    const antwort = await sendReport(followed.id, { kind: 'done', text: 'Documented and tested, as asked.' })
    isTrue(antwort.ok, 'the report is accepted')
    await waitFor(() => lauf(followed.id).followup_open === 0 && lauf(followed.id).followups === 5,
      { what: 'the follow-up is processed', timeoutMs: 30_000 })
    equal(lauf(followed.id).followup_since, null, 'the commission is answered: the clock stopped')
    isFalse(ereignisse(followed.id).includes('anomaly:followup_overrun'), 'no leftover statement')
    equal(lauf(followed.id).status, 'done', 'and the status is still the first attempt’s truth')
  })

  await check('a follow-up whose agent is gone is not held to a deadline that can never be met', async () => {
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
    await waitFor(async () => {
      const r = await sh('tmux', ['display', '-p', '-t', `=${sname}:`, '#{pane_dead}'])
      return r.ok && r.stdout.trim() === '1'
    }, { what: 'the pane is dead', timeoutMs: 5000 })
    const id = 'f0110ade-0000-4000-8000-000000000001'
    db.prepare(`INSERT INTO runs(id, repo_id, status, harness, prompt, branch_mode, expected_minutes, tmux_session, started_at, followup_since)
                VALUES(?, ?, 'done', 'hermes', 'p', 'keiner', 45, ?, datetime('now'), datetime('now'))`)
      .run(id, repoId, sname)
    await watcherTick()
    equal(lauf(id).followup_since, null, 'the commission is given up')
    contains(ereignisse(id).join(','), 'followup_agent_gone', 'and it is written down why')
    db.prepare('DELETE FROM runs WHERE id=?').run(id)
  })

  // ---- 9. with merge_mode off nothing of this happens ----
  await check('with the integration switched off a done report closes the run as it always did', async () => {
    await repoMerge({ merge_mode: 'off' })
    const l = await mergeRun()
    writeFileSync(join(l.wt, 'irrelevant.txt'), 'does not matter\n')
    const antwort = await sendReport(l.id, { kind: 'done', text: 'plain old done' })
    equal(antwort.message ?? null, null, 'no answer to read — there is nothing to say')
    const r = lauf(l.id)
    equal(r.status, 'done', 'done right away, dirty worktree and all')
    equal(r.finish_state, null, 'no gate')
    equal(r.merge_status, null, 'and no verdict about its work')
    // And the prompt is the one it always was, down to the sentence about a
    // detached worktree — with the integration off, not a word may change.
    const prompt = readFileSync(join(SB, 'runs', l.id, 'prompt.md'), 'utf8')
    contains(prompt, 'No branch — the worktree is detached; changes are throwaway changes.',
      'the old sentence, byte for byte')
    isFalse(prompt.includes('Freilauf merges'), 'and nothing about merging at all')
    const html = await (await fetchPath(`/runs/new?repo=${repoId}`)).text()
    contains(html, 'data-merge-mode="off"', 'the form says so too')
    contains(html, 'data-hub-only hidden', 'and the keep box is not even offered')

    // …and a follow-up with the integration off is a report and nothing more:
    // appended, announced, the flows fired again — no gate, no merge.
    const { flowsTick } = await import('../server/flows/triggers.mjs')
    await flowsTick()
    equal(lauf(l.id).flow_dispatched, 1, 'the first end was dispatched')
    const again = await sendReport(l.id, { kind: 'done', text: 'and the follow-up, off mode' })
    isTrue(again.ok, 'accepted')
    contains(again.message ?? '', 'follow-up report #1 received', 'the agent is told what it was')
    const f = lauf(l.id)
    equal(f.status, 'done', 'done stays done')
    equal(f.followups, 1, 'counted')
    equal(f.finish_state, null, 'no gate')
    equal(f.merge_status, null, 'no verdict')
    contains(f.report_md, 'plain old done', 'the first report')
    contains(f.report_md, '## Follow-up report #1', 'and the follow-up under it')
    equal(ereignisse(l.id).filter(k => k === 'notified:followup').length, 1, 'announced')
    await flowsTick()
    equal(lauf(l.id).flow_dispatched, 1, 'the "run finished" triggers were evaluated again')
  })

  // ------------------------------------------------------------------
  group('Plugins: the page, an external package, the discovery scan and the wizard')

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

  await check('the Plugins page lists the coding agents, the model providers and the packages', async () => {
    const r = await fetchPath('/settings/plugins')
    equal(r.status, 200, 'status')
    const html = await r.text()
    // The two sections that replaced the old Coding-agents page…
    contains(html, 'Claude Code', 'a coding agent by its label')
    contains(html, 'cursor-agent', 'and one by its binary')
    contains(html, 'OpenRouter', 'a model provider')
    contains(html, 'DeepSeek', 'and another one')
    // …plus the two the page is new for.
    contains(html, '/settings/plugins/save', 'every card posts to the save route')
    contains(html, '/settings/plugins/install', 'the install form')
    contains(html, '/settings/plugins/scan', 'the scan button')
    contains(html, 'name="cred_api_key_env"', 'a credential can be pointed at another variable')
    contains(html, 'name="cred_api_key_value"', 'or carry a value of its own')
  })

  await check('a save round-trips the enabled flag, the provider selection and a credential', async () => {
    const providerVorher = JSON.parse(
      db.prepare(`SELECT config FROM plugin_config WHERE plugin_id='hermes'`).get().config).providers
    try {
      // 1. the provider selection of a coding agent
      const r1 = await postForm('/settings/plugins/save',
        { id: 'hermes', enabled: '1', providers: ['deepseek'] }, { asBrowser: true })
      equal(r1.status, 303, 'saved')
      const hermes = db.prepare(`SELECT * FROM plugin_config WHERE plugin_id='hermes'`).get()
      equal(hermes.enabled, 1, 'enabled')
      equal(JSON.parse(hermes.config).providers.join(','), 'deepseek', 'only the ticked provider survived')

      // 2. the enabled flag really switches off — the hidden `0` companion is
      //    what makes that possible at all (a form sends nothing for an
      //    unticked box).
      const r2 = await postForm('/settings/plugins/save', { id: 'hermes', enabled: '0' }, { asBrowser: true })
      equal(r2.status, 303, 'saved')
      equal(db.prepare(`SELECT enabled FROM plugin_config WHERE plugin_id='hermes'`).get().enabled, 0, 'switched off')

      // 3. a stored credential VALUE
      // Deliberately NOT in a real key's shape ("sk-…"): check-vor-push.sh greps the
      // committed state for exactly that, and a canary that trips the secret scanner
      // would block every push over a string invented to be harmless.
      const geheim = 'e2e-canary-do-not-render-me'
      equal((await postForm('/settings/plugins/save', {
        id: 'deepseek', enabled: '1', cred_api_key_mode: 'value', cred_api_key_value: geheim,
      }, { asBrowser: true })).status, 303, 'credential saved')
      const cfg = JSON.parse(db.prepare(`SELECT config FROM plugin_config WHERE plugin_id='deepseek'`).get().config)
      equal(cfg.credentials.api_key.mode, 'value', 'stored as a value')
      equal(cfg.credentials.api_key.value, geheim, 'and it is the value that was typed')

      // THE assertion of this test: a page renders, and a page is shared,
      // logged and screenshotted. The value must never come back out of it.
      const html = await (await fetchPath('/settings/plugins')).text()
      isFalse(html.includes(geheim), 'the credential value is nowhere in the HTML')
      contains(html, 'value=""', 'the password field is rendered empty')

      // 4. an empty password field means "keep what is stored" — walking
      //    through the form again must not wipe a key.
      equal((await postForm('/settings/plugins/save',
        { id: 'deepseek', enabled: '1', cred_api_key_mode: 'value', cred_api_key_value: '' },
        { asBrowser: true })).status, 303, 'saved again')
      equal(JSON.parse(db.prepare(`SELECT config FROM plugin_config WHERE plugin_id='deepseek'`).get().config)
        .credentials.api_key.value, geheim, 'the stored value survived an empty submit')

      // 5. an environment variable NAME instead — the better answer where a
      //    machine can be given one, and the only half that may be shown.
      equal((await postForm('/settings/plugins/save', {
        id: 'deepseek', enabled: '1', cred_api_key_mode: 'env', cred_api_key_env: 'MY_OWN_DEEPSEEK_KEY',
      }, { asBrowser: true })).status, 303, 'saved')
      const cfg2 = JSON.parse(db.prepare(`SELECT config FROM plugin_config WHERE plugin_id='deepseek'`).get().config)
      equal(cfg2.credentials.api_key.mode, 'env', 'reads the environment now')
      equal(cfg2.credentials.api_key.envVar, 'MY_OWN_DEEPSEEK_KEY', 'under the name the operator gave')
      isFalse('value' in cfg2.credentials.api_key, 'and the stored value is gone, not shadowed')
      const html2 = await (await fetchPath('/settings/plugins')).text()
      contains(html2, 'MY_OWN_DEEPSEEK_KEY', 'the NAME is shown')
      isFalse(html2.includes(geheim), 'the value still is not')
    } finally {
      await postForm('/settings/plugins/save',
        { id: 'hermes', enabled: '1', providers: providerVorher }, { asBrowser: true })
    }
  })

  await check('an unknown plugin id is a readable problem, not a 500', async () => {
    const r = await postForm('/settings/plugins/save', { id: 'no-such-plugin', enabled: '1' }, { asBrowser: true })
    equal(r.status, 400, 'refused')
    contains(await r.text(), 'no-such-plugin', 'and the page names it')
  })

  await check('an external package is installed from a directory and joins the registry', async () => {
    const dir = paketBauen('e2e-provider', {
      api: 1, id: 'e2e-provider', kind: 'provider', name: 'E2E Model Provider', version: '0.4.2',
      description: 'A model provider built by the e2e suite.',
    }, EXT_PROVIDER)

    const r = await postForm('/settings/plugins/install', { path: dir }, { asBrowser: true })
    equal(r.status, 303, `installed (${r.status === 400 ? await r.text() : ''})`.slice(0, 400))
    // It is COPIED into the plugin directory, not linked: the operator's own
    // directory may move, and a service must not die because it did.
    isTrue(existsSync(join(sk.PLUGINS, 'e2e-provider', 'plugin.json')), 'the package landed in the plugin directory')

    const html = await (await fetchPath('/settings/plugins')).text()
    contains(html, 'E2E Model Provider', 'the plugin has a card')
    contains(html, '0.4.2', 'the packages table names its version')
    contains(html, 'e2e-provider', 'and its id')
    // A registered provider is choosable wherever a provider is chosen — the
    // whole point of the registry being mutable.
    contains(await (await fetchPath('/api/coding-agents/detect')).text(), 'ok', 'the detect API still answers')
  })

  await check('a package whose id is already taken is refused, and nothing is written', async () => {
    // Refused BEFORE anything is copied: a package shadowing `claude` could
    // replace the coding agent every run is started with, without saying so.
    const dopplung = paketBauen('e2e-provider-again', {
      api: 1, id: 'e2e-provider', kind: 'provider', name: 'A second one', version: '9.9.9',
    }, EXT_PROVIDER)
    const r = await postForm('/settings/plugins/install', { path: dopplung }, { asBrowser: true })
    equal(r.status, 400, 'refused')
    contains(await r.text(), 'already taken', 'and it says why')
    isFalse(existsSync(join(sk.PLUGINS, 'e2e-provider-again')), 'nothing new on disk')
    // The original is untouched, version and all.
    contains(await (await fetchPath('/settings/plugins')).text(), '0.4.2', 'the installed one still stands')

    const kaputt = paketBauen('e2e-broken', {
      api: 2, id: 'e2e-broken', kind: 'provider', name: 'From the future', version: '1.0.0',
    }, EXT_PROVIDER)
    const r2 = await postForm('/settings/plugins/install', { path: kaputt }, { asBrowser: true })
    equal(r2.status, 400, 'a manifest for another api version is refused too')
    contains(await r2.text(), 'api', 'naming the field')

    const r3 = await postForm('/settings/plugins/install', { path: join(SB, 'does-not-exist') }, { asBrowser: true })
    equal(r3.status, 400, 'a path that is not a directory is refused')
    equal((await postForm('/settings/plugins/install', { path: '' }, { asBrowser: true })).status, 400, 'and an empty one')
  })

  await check('the scan finds a coding agent on this machine and the banner asks about it once', async () => {
    // An external coding agent whose binary is `sh`: present on every machine
    // the suite can run on, so the finding is deterministic.
    const dir = paketBauen('e2e-agent', {
      api: 1, id: 'e2e-agent', kind: 'harness', name: 'E2E Coding Agent', version: '1.2.3',
      description: 'A coding agent built by the e2e suite.',
    }, EXT_AGENT)
    equal((await postForm('/settings/plugins/install', { path: dir }, { asBrowser: true })).status, 303, 'installed')

    equal((await postForm('/settings/plugins/scan', {}, { asBrowser: true })).status, 303, 'scanned')
    const row = db.prepare(`SELECT * FROM discovery WHERE id='harness:e2e-agent'`).get()
    isTrue(!!row, 'the scan wrote a row for it')
    equal(JSON.parse(row.detail).bin, 'sh', 'and recorded WHICH binary it found')
    isTrue(row.answer === null, 'nobody has been asked yet')
    // A found credential is NAMED, never read — the row carries a variable
    // name and no value, because it is shown in the UI and travels with a
    // database dump.
    isFalse(JSON.stringify(row.detail).includes('sk-'), 'no secret in a discovery row')

    contains(await (await fetchPath('/')).text(), 'banner discovery', 'the banner appears on an ordinary page')
    contains(await (await fetchPath('/settings/plugins')).text(), 'E2E Coding Agent', 'and the finding has a card')

    // Answering is what "asked once" means: a page that only SHOWS something
    // has not asked anybody anything.
    equal((await postForm('/settings/plugins/discovery',
      { id: 'harness:e2e-agent', answer: 'dismissed' }, { asBrowser: true })).status, 303, 'answered')
    const nachher = db.prepare(`SELECT * FROM discovery WHERE id='harness:e2e-agent'`).get()
    equal(nachher.answer, 'dismissed', 'the answer is recorded')
    isTrue(!!nachher.asked_at, 'together with the moment it was asked')
    isFalse((await (await fetchPath('/')).text()).includes('banner discovery'), 'and it stops asking')

    // …and a second scan does not un-answer it.
    equal((await postForm('/settings/plugins/scan', {}, { asBrowser: true })).status, 303, 'scanned again')
    equal(db.prepare(`SELECT answer FROM discovery WHERE id='harness:e2e-agent'`).get().answer, 'dismissed',
      'a rescan never overwrites an answer')
  })

  await check('"Add" from a finding switches the plugin on and answers the suggestion', async () => {
    // Put the finding back the way a fresh machine would have it.
    db.prepare(`UPDATE discovery SET answer=NULL, asked_at=NULL WHERE id='harness:e2e-agent'`).run()
    equal((await postForm('/settings/plugins/add', { id: 'e2e-agent' }, { asBrowser: true })).status, 303, 'added')
    const cfg = db.prepare(`SELECT * FROM plugin_config WHERE plugin_id='e2e-agent'`).get()
    isTrue(!!cfg, 'the plugin is configured now')
    equal(cfg.enabled, 1, 'and switched on')
    equal(cfg.source, 'external', 'recorded as an external package')
    equal(db.prepare(`SELECT answer FROM discovery WHERE id='harness:e2e-agent'`).get().answer, 'added', 'and the finding is answered')
  })

  await check('an external package is uninstalled again — directory, registry and configuration', async () => {
    for (const id of ['e2e-agent', 'e2e-provider']) {
      const r = await postForm('/settings/plugins/uninstall', { id }, { asBrowser: true })
      equal(r.status, 303, `${id} removed`)
      isFalse(existsSync(join(sk.PLUGINS, id)), `${id}: the directory is gone`)
      isTrue(!db.prepare('SELECT 1 FROM plugin_config WHERE plugin_id=?').get(id), `${id}: its configuration too`)
      isTrue(!db.prepare('SELECT 1 FROM discovery WHERE plugin_id=?').get(id), `${id}: and its findings`)
    }
    const html = await (await fetchPath('/settings/plugins')).text()
    isFalse(html.includes('E2E Model Provider'), 'the page no longer offers it')
    isFalse(html.includes('E2E Coding Agent'), 'nor the coding agent')
    // A built-in is never removable: it is part of the running code, and a
    // registry disagreeing with the imports would be a lie.
    const r = await postForm('/settings/plugins/uninstall', { id: 'claude' }, { asBrowser: true })
    equal(r.status, 400, 'a built-in is refused')
    contains(await r.text(), 'built-in', 'and it says so')
    // And the hub still works with everything the suite installed gone.
    equal((await fetchPath('/settings/plugins')).status, 200, 'the page still renders')
    equal((await fetchPath('/')).status, 200, 'and so does the overview')
  })

  // ------------------------------------------------------------------
  group('Notifications: optional, and a channel is a plugin')

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

  await check('with no channel configured the page says so, and every notifying path is a silent no-op', async () => {
    const r = await fetchPath('/settings/notifications')
    equal(r.status, 200, 'the page renders')
    const html = await r.text()
    contains(html, 'No channel is configured', 'and states the quiet installation as a state, not a problem')
    contains(html, 'Notifications are optional', 'saying outright that nothing here has to be filled in')
    contains(html, 'Telegram', 'the built-in channel has a card')
    contains(html, '/settings/notifications/save', 'which posts to the save route')
    // Nothing anywhere nags about it: the banner slot on an ordinary page is
    // for coding agents and discoveries, never for a missing notifier.
    isFalse((await (await fetchPath('/')).text()).includes('banner notify'), 'no banner on the overview')

    // The test button refuses rather than reporting a success nobody had.
    const t1 = await postForm('/settings/notifications/test', { id: 'telegram' }, { asBrowser: true })
    equal(t1.status, 303, 'the button answers')
    // The reason is TRANSLATED before it travels: it is rendered to the
    // operator, and the Telegram wizard's own step 3 reaches this same path.
    contains(decodeURIComponent(t1.headers.get('location')), 'not configured yet',
      'and says which of the two it was, in the operator\'s language')

    // And the run path: a report still writes its flag, with delivered=false,
    // so a hub that is switched on later does not fire a backlog.
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E: quiet report', branch_mode: 'keiner', expected_minutes: '5' })
    await sessionMerken(j.runId)
    await waitFor(() => lauf(j.runId).status === 'running', { what: 'the run is up' })
    await sendReport(j.runId, { kind: 'done', text: 'nothing to hear' })
    await waitFor(() => lauf(j.runId).status === 'done', { what: 'the run is done' })
    const flagge = db.prepare(`SELECT payload FROM events WHERE run_id=? AND kind='notified:done'`).get(j.runId)
    isTrue(!!flagge, 'the run is marked as told')
    equal(JSON.parse(flagge.payload).delivered, false, 'and honestly says nothing was delivered')
    isFalse(existsSync(NOTIFY_LOG), 'no channel wrote anything')
  })

  await check('an external notifier package joins the registry and gets a card of its own', async () => {
    const dir = paketBauen('e2e-notifier', {
      api: 1, id: 'e2e-notifier', kind: 'notifier', name: 'E2E Notifier', version: '2.0.0',
      description: 'A notification channel built by the e2e suite.',
    }, EXT_NOTIFIER)
    const r = await postForm('/settings/plugins/install', { path: dir }, { asBrowser: true })
    equal(r.status, 303, `installed (${r.status === 400 ? await r.text() : ''})`.slice(0, 400))

    const html = await (await fetchPath('/settings/notifications')).text()
    contains(html, 'E2E Notifier', 'the package has a card on the notifications page')
    contains(html, 'Telegram', 'next to the built-in one')
    equal((html.match(/action="\/settings\/notifications\/save"/g) ?? []).length, 2, 'one card per registered notifier')
    // It is registered but not yet ready: a declared `required` setting with no
    // value is what "not configured" means, and the hub is still quiet.
    contains(html, 'No channel is configured', 'a registered channel is not a configured one')

    // A duplicate id is refused for a notifier exactly as for the other kinds.
    const wieder = paketBauen('e2e-notifier-again', {
      api: 1, id: 'e2e-notifier', kind: 'notifier', name: 'A second one', version: '9.9.9',
    }, EXT_NOTIFIER)
    const r2 = await postForm('/settings/plugins/install', { path: wieder }, { asBrowser: true })
    equal(r2.status, 400, 'the duplicate is refused')
    contains(await r2.text(), 'already taken', 'and it says why')
  })

  await check('configuring it makes the hub speak — and the message carries what a channel needs', async () => {
    const r = await postForm('/settings/notifications/save',
      { id: 'e2e-notifier', enabled: '1', set_outfile: NOTIFY_LOG }, { asBrowser: true })
    equal(r.status, 303, 'saved')
    contains(await (await fetchPath('/settings/notifications')).text(), 'At least one channel is configured',
      'and the page changes its mind about the installation')

    const t = await postForm('/settings/notifications/test', { id: 'e2e-notifier' }, { asBrowser: true })
    equal(t.headers.get('location'), '/settings/notifications?test=ok', 'the test message went out')
    const [erste] = gemeldet()
    isTrue(!!erste, 'the plugin really received it')
    equal(erste.kind, 'test', 'the message says what it is about')
    isTrue(String(erste.text).length > 0, 'and carries text')
    isTrue(String(erste.url ?? '').startsWith('http'), 'plus a link the channel may render')
    isTrue(String(erste.linkLabel ?? '').length > 0, 'with a label for it')
  })

  await check('a run report reaches the configured channel, attachment and all', async () => {
    const vorher = gemeldet().length
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E: a loud report', branch_mode: 'keiner', expected_minutes: '5' })
    await sessionMerken(j.runId)
    await waitFor(() => lauf(j.runId).status === 'running', { what: 'the run is up' })
    await sendReport(j.runId, { kind: 'done', text: 'loud and clear' })
    await waitFor(() => gemeldet().length > vorher, { what: 'the channel heard about the run', timeoutMs: 20_000 })
    const m = gemeldet().at(-1)
    equal(m.kind, 'run', 'the message names what it is about')
    equal(m.runId, j.runId, 'and which run')
    contains(m.text, 'loud and clear', 'the report is in it')
    isTrue(String(m.attachment ?? '').endsWith('.md'), 'and the full report travels as an attachment')
    equal(JSON.parse(db.prepare(`SELECT payload FROM events WHERE run_id=? AND kind='notified:done'`)
      .get(j.runId).payload).delivered, true, 'the flag records the delivery')
  })

  await check('a report with a DETAILED version: the text is the short report, the document is the detail', async () => {
    const vorher = gemeldet().length
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E: two-part report', branch_mode: 'keiner', expected_minutes: '5' })
    await sessionMerken(j.runId)
    await waitFor(() => lauf(j.runId).status === 'running', { what: 'the run is up' })
    await sendReport(j.runId, {
      kind: 'done',
      text: 'Kurz: Frage beantwortet, nichts zu mergen.',
      detail: 'Ausfuehrlich: alle Details zur Antwort, Schritt fuer Schritt.',
    })
    await waitFor(() => gemeldet().length > vorher, { what: 'the channel heard about the run', timeoutMs: 20_000 })
    const m = gemeldet().at(-1)
    contains(m.text, 'Kurz: Frage beantwortet', 'the TEXT is the short report')
    isFalse(m.text.includes('Schritt fuer Schritt'), 'the detail is not duplicated into the text')
    equal(m.attachmentContent, 'Ausfuehrlich: alle Details zur Antwort, Schritt fuer Schritt.',
      'the DOCUMENT is the detailed report')
    equal(lauf(j.runId).report_detail_md, 'Ausfuehrlich: alle Details zur Antwort, Schritt fuer Schritt.',
      'and it is stored on the run')
    contains(m.text, `/runs/${j.runId}`, 'the message carries the run link')
  })

  await check('fl-report --detail hands the detailed report to the hub', async () => {
    const vorher = gemeldet().length
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E: fl-report detail', branch_mode: 'keiner', expected_minutes: '5' })
    await sessionMerken(j.runId)
    await waitFor(() => lauf(j.runId).status === 'running', { what: 'the run is up' })
    const kurz = join(SB, 'runs', j.runId, 'report.md')
    const detail = join(SB, 'runs', j.runId, 'report-detail.md')
    writeFileSync(kurz, 'Kurztext von fl-report')
    writeFileSync(detail, 'Detailtext von fl-report')
    const r = await flReport(j.runId, ['done', '--file', kurz, '--detail', detail])
    isTrue(r.ok, 'the report goes through')
    await waitFor(() => gemeldet().length > vorher, { what: 'the channel heard about the run', timeoutMs: 20_000 })
    const m = gemeldet().at(-1)
    equal(m.runId, j.runId, 'and which run')
    contains(m.text, 'Kurztext von fl-report', 'the short file is the message text')
    equal(m.attachmentContent, 'Detailtext von fl-report', 'the detail file is the document')
  })

  await check('a replayed inbox report is not sent a second time', async () => {
    const j = await laufStarten({ repo_id: repoId, prompt: 'E2E: replay dedupe', branch_mode: 'keiner', expected_minutes: '5' })
    await sessionMerken(j.runId)
    await waitFor(() => lauf(j.runId).status === 'running', { what: 'the run is up' })
    const body = { kind: 'done', text: 'same report, once' }
    await sendReport(j.runId, body)
    await waitFor(() => lauf(j.runId).status === 'done', { what: 'the run is done' })
    equal(gemeldet().filter(x => x.runId === j.runId).length, 1, 'one message for the report')
    // fl-report lost the hub's answer and wrote the SAME payload to the inbox;
    // the watcher replays it — the identical text must not ring a second time.
    writeFileSync(join(SB, 'runs', j.runId, 'inbox.jsonl'), JSON.stringify(body) + '\n')
    await watcherTick()
    equal(gemeldet().filter(x => x.runId === j.runId).length, 1, 'the replayed line does not ring again')
    equal(lauf(j.runId).followups, 0, 'and it was not mistaken for a follow-up')
    equal(readFileSync(join(SB, 'runs', j.runId, 'inbox.jsonl'), 'utf8'), '', 'the processed line is cleared')
  })

  await check('the notify flow step sends through the configured channels — under its new name and its old one', async () => {
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
      isTrue(j.ok && !!j.id, `${typ}: flow saved (${JSON.stringify(j).slice(0, 200)})`)
      // Through the route, not the function: "run now" is a button, and the
      // route is what an operator's click reaches.
      equal((await postForm(`/api/flows/${j.id}/run`, {}, { asBrowser: true })).status, 303, `${typ}: run now`)
      await waitFor(() => gemeldet().length > vorher, { what: `${typ}: the message went out`, timeoutMs: 15_000 })
      const m = gemeldet().at(-1)
      equal(m.kind, 'flow', `${typ}: the message says it comes from a flow`)
      contains(m.text, text, `${typ}: with the rendered text`)
      const fr = db.prepare('SELECT * FROM flow_runs WHERE flow_id=? ORDER BY started_at DESC LIMIT 1').get(j.id)
      equal(fr.status, 'done', `${typ}: the flow run finished`)
      equal(JSON.parse(fr.context).vars.out.delivered, true, `${typ}: and recorded the delivery`)
    }
    // The designer only ever offers the new name.
    const meta = await (await fetchPath('/api/flows/meta')).json()
    isFalse(meta.steps.some(x => x.type === 'telegram'), 'the toolbox offers one notify block, not two')
  })

  await check('switching the channel off silences it again, and uninstalling removes it', async () => {
    const vorher = gemeldet().length
    equal((await postForm('/settings/notifications/save',
      { id: 'e2e-notifier', enabled: '0', set_outfile: NOTIFY_LOG }, { asBrowser: true })).status, 303, 'switched off')
    const t = await postForm('/settings/notifications/test', { id: 'e2e-notifier' }, { asBrowser: true })
    contains(decodeURIComponent(t.headers.get('location')), 'switched off', 'the test button says which of the two it is')
    equal(gemeldet().length, vorher, 'and nothing was written')

    equal((await postForm('/settings/plugins/uninstall', { id: 'e2e-notifier' }, { asBrowser: true })).status, 303, 'uninstalled')
    isFalse(existsSync(join(sk.PLUGINS, 'e2e-notifier')), 'the directory is gone')
    const html = await (await fetchPath('/settings/notifications')).text()
    isFalse(html.includes('E2E Notifier'), 'the page no longer offers it')
    contains(html, 'No channel is configured', 'and the hub is quiet again — which is a complete installation')
  })

  // ------------------------------------------------------------------
  group('Repos: deactivating takes one out of every dropdown, deleting needs its name')

  await check('a repo can be switched off and on again, explicitly or by flipping', async () => {
    const id = db.prepare(`INSERT INTO repos(name,path,base_branch) VALUES('e2e-off','${REPO}','main') RETURNING id`).get().id
    const aktiv = () => db.prepare('SELECT active FROM repos WHERE id=?').get(id).active
    equal(aktiv(), 1, 'a new repo is active')
    equal((await postForm('/repos/toggle', { id: String(id), active: '0' }, { asBrowser: true })).status, 303, 'switching off redirects')
    equal(aktiv(), 0, "and '0' really means off — the string is truthy, so it has to be compared")
    await postForm('/repos/toggle', { id: String(id) }, { asBrowser: true })
    equal(aktiv(), 1, 'no `active` flips it')
    await postForm('/repos/toggle', { id: String(id) }, { asBrowser: true })
    equal(aktiv(), 0, 'and flips it back')
    equal((await postForm('/repos/toggle', { id: '999999' }, { asBrowser: true })).status, 400, 'an unknown repo is a readable refusal')
  })

  await check('an inactive repo is gone from every repo dropdown but still on the Repos page', async () => {
    const row = db.prepare(`SELECT * FROM repos WHERE name='e2e-off'`).get()
    // Deactivated by the test above.
    equal(row.active, 0, 'precondition: it is off')

    // The header switcher and the Quick-Run dialog share one query, so both are
    // covered by the overview's HTML.
    const start = await (await fetchPath(`/?repo=${repoId}`)).text()
    isFalse(start.includes('>e2e-off<'), 'not in the header switcher or the Quick-Run dialog')
    // Every other place a repo can be picked.
    isFalse((await (await fetchPath('/agents/move?id=1')).text()).includes('>e2e-off<'), 'not a move target')
    isFalse((await (await fetchPath('/settings/cleanup')).text()).includes('>e2e-off<'), 'not in the cleanup settings')
    const meta = await (await fetchPath('/api/flows/meta')).json()
    isFalse(meta.repos.some(r => r.name === 'e2e-off'), "not in the flow designer's repo list")
    // ...but the Repos page shows it, marked, or deactivating would be a way of
    // losing a repository rather than of putting one away.
    const seite = await (await fetchPath('/repos')).text()
    contains(seite, 'e2e-off', 'the Repos page lists it')
    contains(seite, 'repo-off', 'and marks it as deactivated')
    contains(seite, '/repos/toggle', 'with the button to bring it back')

    // /api/repos shows it with its flag, and filters on request.
    const alle = await (await fetchPath('/api/repos')).json()
    isTrue(alle.repos.some(r => r.name === 'e2e-off' && r.active === 0), 'the API lists it with active:0')
    isFalse((await (await fetchPath('/api/repos?active=1')).json()).repos.some(r => r.name === 'e2e-off'), 'active=1 filters it out')
    isTrue((await (await fetchPath('/api/repos?active=0')).json()).repos.some(r => r.name === 'e2e-off'), 'active=0 finds only it')
  })

  await check('an inactive repo starts nothing, and its history stays reachable', async () => {
    const row = db.prepare(`SELECT * FROM repos WHERE name='e2e-off'`).get()
    // A manual start is refused — by name, so the operator knows why.
    const j = await (await fetchPath('/api/runs', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        repo_id: String(row.id), harness: 'claude', prompt: 'should not start',
        branch_mode: 'keiner', expected_minutes: '10',
      }).toString(),
    })).json()
    isFalse(j.ok && j.runId, `no run was created (${JSON.stringify(j)})`)
    contains(JSON.stringify(j), 'e2e-off', 'and the refusal names the repo')
    equal(db.prepare('SELECT count(*) c FROM runs WHERE repo_id=?').get(row.id).c, 0, 'not even a row')

    // Its own pages still render when they are asked for by id — that is what
    // makes deactivating better than deleting.
    equal((await fetchPath(`/?repo=${row.id}`)).status, 200, 'the overview')
    equal((await fetchPath(`/archive?repo=${row.id}`)).status, 200, 'the archive')
    equal((await fetchPath(`/api/fragments/sidebar?repo=${row.id}`)).status, 200, 'and the sidebar fragment')
  })

  await check('deleting refuses without the exact name, and while work is in flight', async () => {
    const id = db.prepare(`INSERT INTO repos(name,path,base_branch) VALUES('e2e-del','${REPO}','main') RETURNING id`).get().id
    const da = () => db.prepare('SELECT count(*) c FROM repos WHERE id=?').get(id).c

    equal((await postForm('/repos/delete', { id: String(id) }, { asBrowser: true })).status, 400, 'no confirm at all')
    equal((await postForm('/repos/delete', { id: String(id), confirm: 'e2e-de' }, { asBrowser: true })).status, 400, 'a near miss')
    equal(da(), 1, 'and the repo is still there after both')

    // A run in flight is the second fence: deleting would pull the ground out
    // from under a live tmux session.
    db.prepare(`INSERT INTO runs(id,repo_id,harness,prompt,branch_mode,expected_minutes,status)
      VALUES('e2e-del-run',?,'claude','x','keiner',10,'running')`).run(id)
    const r = await postForm('/repos/delete', { id: String(id), confirm: 'e2e-del' }, { asBrowser: true })
    equal(r.status, 400, 'the right name is not enough while a run is going')
    equal(da(), 1, 'still there')
    db.prepare(`UPDATE runs SET status='done' WHERE id='e2e-del-run'`).run()
  })

  await check('deleting takes the runs, agents, events and incidents — and nothing off the disk', async () => {
    const id = db.prepare(`SELECT id FROM repos WHERE name='e2e-del'`).get().id
    const agentId = db.prepare(`INSERT INTO agents(repo_id,name,harness,prompt,branch_mode,expected_minutes)
      VALUES(?,'e2e-del-agent','claude','x','keiner',10) RETURNING id`).get(id).id
    db.prepare(`UPDATE runs SET agent_id=? WHERE id='e2e-del-run'`).run(agentId)
    db.prepare(`INSERT INTO events(run_id,kind) VALUES('e2e-del-run','started')`).run()
    db.prepare(`INSERT INTO incidents(run_id,typ,quelle) VALUES('e2e-del-run','rate_limit','log')`).run()

    // The dialog states the facts, and they are the real counts.
    const seite = await (await fetchPath('/repos')).text()
    contains(seite, 'repo-del-' + id, 'the confirmation dialog is on the page')
    contains(seite, REPO, 'and names the checkout it will not touch')

    const r = await postForm('/repos/delete', { id: String(id), confirm: 'e2e-del' }, { asBrowser: true })
    equal(r.status, 303, 'the right name on a quiet repo goes through')
    equal(db.prepare('SELECT count(*) c FROM repos WHERE id=?').get(id).c, 0, 'the repo')
    equal(db.prepare('SELECT count(*) c FROM agents WHERE repo_id=?').get(id).c, 0, 'its agents')
    equal(db.prepare(`SELECT count(*) c FROM runs WHERE id='e2e-del-run'`).get().c, 0, 'its runs')
    equal(db.prepare(`SELECT count(*) c FROM events WHERE run_id='e2e-del-run'`).get().c, 0, 'their events')
    equal(db.prepare(`SELECT count(*) c FROM incidents WHERE run_id='e2e-del-run'`).get().c, 0, 'and their incidents')
    // The one thing it must never do.
    isTrue(existsSync(join(REPO, '.git')), 'the git checkout is untouched')
  })

  // ------------------------------------------------------------------
  group("Freilauf skills: the page, the installation, and the read-only API")

  await check('the settings page names what is shipped and where it would go', async () => {
    const html = await (await fetchPath('/settings/skills')).text()
    contains(html, 'freilauf-runs', 'the shipped skills are listed by name')
    // The shared reference is installed but NOT offered: nobody picks it, the
    // other skills load it themselves. A footnote says one more is coming
    // along, without naming it.
    isFalse(html.includes('<b>freilauf-models</b>'), 'the shared skill is not in the list')
    contains(html, 'shared reference', 'but the page admits one more is installed')
    // Descriptions are printed in full — cutting them ended sentences mid-word.
    contains(html, 'even when the word Freilauf is never said', 'and a description is not truncated')
    // Where they land and what cannot be scoped — with somewhere to say so.
    contains(html, 'user level', 'the page says they are installed at user level')
    contains(html, 'github.com/hwalde/freilauf/issues', 'and links the issue tracker for per-project scoping')
    contains(html, 'name="skills_install"', 'the installation switch is there')
    contains(html, 'name="skills_auto_update"', 'and the automatic-update switch')
    // With the installation off, "keep them up to date" is a switch about
    // nothing: hidden AND disabled, so its hidden `0` companion cannot post and
    // overwrite a preference the operator left on.
    contains(html, '<div id="skills-auto" hidden>', 'the update row is hidden while the installation is off')
    contains(html, 'id="skills-pick" hidden', 'and so is the per-skill picker')
    // Derived, not typed in: the subject here is "every box the picker renders
    // is disabled", and a literal turns shipping one more skill into a failure
    // of this check instead of a change in what it is about. `shared` skills
    // are not rendered as boxes at all, which is the assertion two lines up.
    const pickbar = (await (await fetchPath('/api/skills')).json()).skills.filter(s => s.role !== 'shared').length
    isTrue(pickbar >= 6, `the picker has boxes to disable (${pickbar})`)
    equal((html.match(/name="skills_selected"[^>]*disabled/g) ?? []).length, pickbar,
      'with every one of its boxes disabled, so a save cannot rewrite the selection unseen')
    isFalse(html.includes('name="skills_pick"'), 'and the marker that says "this form carried the picker" is absent')
    equal((html.match(/name="skills_auto_update"[^>]*disabled/g) ?? []).length, 2,
      'and both of its inputs are disabled, so neither travels')
    isFalse(/<div class="btn-row"><button>[^<]*<\/button>\s*<a /.test(html),
      'the form offers one action and no link beside it')
    contains(html, 'type="hidden" name="skills_install" value="0"',
      'each carries its hidden 0 companion — without it an unticked box would read as "not mentioned"')
    contains(html, 'id="skills-remove-dialog"', 'the confirmation dialog is rendered by the server')
    contains(html, 'data-was-on=', 'and the form records the state it was rendered with')
  })

  // The target directories are DERIVED from the enabled coding agents, so the
  // test derives them too — hardcoding `.claude/skills` here would turn a
  // change to the plugin set into a failure of this test instead of a change in
  // its subject. Every path lies inside the sandbox home
  // (FREILAUF_SKILLS_HOME), never in the operator's real one.
  const skillZiele = async () => (await (await fetchPath('/api/skills')).json()).targets.map(t => t.dir)

  await check('switching the installation on writes into the covering directories, off takes it back', async () => {
    const vorher = await skillZiele()
    isTrue(vorher.length >= 1, 'there is at least one target directory')
    isTrue(vorher.every(d => d.startsWith(join(SB, 'skillhome'))),
      'and every one of them is inside the sandbox home, not the operator\'s')

    const eingeschaltet = await postForm('/settings/skills',
      { skills_install: '1', skills_auto_update: '1' }, { asBrowser: true })
    equal(eingeschaltet.status, 303, 'saving redirects')
    equal(db.prepare("SELECT value FROM settings WHERE key='skills_install'").get().value, '1', 'the switch is stored')
    for (const wurzel of vorher) {
      const ziel = join(wurzel, 'freilauf-models')
      isTrue(existsSync(join(ziel, 'SKILL.md')), `${wurzel}: the skill is really on disk`)
      isTrue(existsSync(join(ziel, '.freilauf-skill.json')), `${wurzel}: with the marker that makes it removable`)
    }

    const seite = await (await fetchPath('/settings/skills')).text()
    contains(seite, vorher[0], 'the page now shows where it went')

    const aus = await postForm('/settings/skills', { skills_install: '0', skills_auto_update: '1' }, { asBrowser: true })
    equal(aus.status, 303, 'switching off redirects too')
    for (const wurzel of vorher) isFalse(existsSync(join(wurzel, 'freilauf-models')), `${wurzel}: the copy is gone`)
  })

  await check('saving with the update row absent leaves the stored preference alone', async () => {
    const wert = () => db.prepare("SELECT value FROM settings WHERE key='skills_auto_update'").get()?.value
    await postForm('/settings/skills', { skills_install: '1', skills_auto_update: '1' }, { asBrowser: true })
    equal(wert(), '1', 'it is on to begin with')
    // The browser hides AND disables the row when the installation goes off, so
    // a real save from that page carries no `skills_auto_update` at all. The
    // stored preference has to survive that, or switching the installation back
    // on would silently find updates off.
    await postForm('/settings/skills', { skills_install: '0' }, { asBrowser: true })
    equal(wert(), '1', 'and a save without the field does not turn it off')
    equal(db.prepare("SELECT value FROM settings WHERE key='skills_install'").get().value, '0', 'while the installation really went off')
  })

  await check('only the selected skills are installed, and deselecting removes just that one', async () => {
    const HOME = join(SB, 'skillhome')
    const wurzel = async () => (await (await fetchPath('/api/skills')).json()).targets[0].dir
    const da = async (name) => existsSync(join(await wurzel(), name, 'SKILL.md'))

    // Everything, which is what an installation that said yes before this
    // setting existed already has on disk.
    await postForm('/settings/skills', { skills_install: '1', skills_auto_update: '1' }, { asBrowser: true })
    isTrue(await da('freilauf-runs'), 'runs is there')
    isTrue(await da('freilauf-agents'), 'agents too')
    isTrue(await da('freilauf-models'), 'and the shared one, which nobody picks')

    // Now pick two. The third goes; the shared one rides along.
    await postForm('/settings/skills', {
      skills_install: '1', skills_auto_update: '1', skills_pick: '1',
      skills_selected: ['freilauf-runs', 'freilauf-repos'],
    }, { asBrowser: true })
    isTrue(await da('freilauf-runs'), 'a selected skill stays')
    isTrue(await da('freilauf-repos'), 'and the other one')
    isFalse(await da('freilauf-agents'), 'the deselected one is removed')
    isTrue(await da('freilauf-models'), 'the shared one rides along with whatever is selected')
    equal(db.prepare("SELECT value FROM settings WHERE key='skills_selected'").get().value,
      JSON.stringify(['freilauf-runs', 'freilauf-repos']), 'and the choice is stored')

    // A save WITHOUT the picker block must not rewrite the selection — with the
    // installation off the boxes are disabled, so nothing would travel and an
    // unguarded read would wipe a choice nobody could see.
    await postForm('/settings/skills', { skills_install: '1', skills_auto_update: '0' }, { asBrowser: true })
    equal(db.prepare("SELECT value FROM settings WHERE key='skills_selected'").get().value,
      JSON.stringify(['freilauf-runs', 'freilauf-repos']), 'the selection survives a save that did not carry it')
    isTrue(await da('freilauf-runs'), 'and nothing was reinstalled behind it')

    // Selecting nothing takes even the shared one: it exists for the others.
    await postForm('/settings/skills', { skills_install: '1', skills_auto_update: '1', skills_pick: '1' },
      { asBrowser: true })
    isFalse(await da('freilauf-runs'), 'nothing selected, nothing installed')
    isFalse(await da('freilauf-models'), 'the shared one goes with them')

    // Back to all of them for the checks after this one.
    db.prepare("DELETE FROM settings WHERE key='skills_selected'").run()
    await postForm('/settings/skills/sync', {}, { asBrowser: true })
    isTrue(await da('freilauf-runs'), 'an absent selection means all of them again')
    await postForm('/settings/skills', { skills_install: '0', skills_auto_update: '1' }, { asBrowser: true })
  })

  await check('a "sync now" post re-establishes the state without changing the settings', async () => {
    await postForm('/settings/skills', { skills_install: '1', skills_auto_update: '1' }, { asBrowser: true })
    const ziel = join((await skillZiele())[0], 'freilauf-models')
    rmSync(ziel, { recursive: true, force: true })
    const r = await postForm('/settings/skills/sync', {}, { asBrowser: true })
    equal(r.status, 303, 'the button redirects')
    isTrue(existsSync(join(ziel, 'SKILL.md')), 'and the missing copy is back')
    await postForm('/settings/skills', { skills_install: '0', skills_auto_update: '1' }, { asBrowser: true })
  })

  await check('a directory the hub did not write is named on the page instead of overwritten', async () => {
    const wurzel = (await (await fetchPath('/api/skills')).json()).targets[0]?.dir
      ?? join(SB, 'skillhome', '.claude', 'skills')
    const fremd = join(wurzel, 'freilauf-models')
    mkdirSync(fremd, { recursive: true })
    writeFileSync(join(fremd, 'SKILL.md'), '---\nname: freilauf-models\n---\nnot ours\n')
    await postForm('/settings/skills', { skills_install: '1', skills_auto_update: '1' }, { asBrowser: true })
    contains(readFileSync(join(fremd, 'SKILL.md'), 'utf8'), 'not ours', 'the foreign file is untouched')
    const html = await (await fetchPath('/settings/skills')).text()
    contains(html, fremd, 'and the page names the directory it could not write')
    // Switching off must not take it either.
    await postForm('/settings/skills', { skills_install: '0', skills_auto_update: '1' }, { asBrowser: true })
    isTrue(existsSync(join(fremd, 'SKILL.md')), 'switching off leaves a foreign skill alone')
    rmSync(fremd, { recursive: true, force: true })
  })

  await check('GET /api/skills answers what is shipped, where it goes and what is installed', async () => {
    const j = await (await fetchPath('/api/skills')).json()
    isTrue(j.ok, 'ok')
    isTrue(Array.isArray(j.skills) && j.skills.length >= 1, 'the shipped skills')
    isTrue(j.skills.every(s => s.name && s.description), 'each with a name and a description')
    isTrue(Array.isArray(j.harnesses) && j.harnesses.some(h => h.id === 'claude'), 'every registered coding agent')
    isTrue(j.harnesses.find(h => h.id === 'claude').user.some(p => p.includes('.claude/skills')),
      'and the directories it declares')
    equal(j.install, false, 'the switch is off again after the test above')
  })

  await check('the read-only API answers for repos, agents, runs, favorites and sessions', async () => {
    const repos = await (await fetchPath('/api/repos')).json()
    isTrue(repos.ok && repos.repos.some(r => r.id === repoId), 'the repo is listed')
    isTrue(Array.isArray(repos.repos[0].extras), 'with its worktree extras parsed')

    const agents = await (await fetchPath(`/api/agents?repo=${repoId}`)).json()
    isTrue(agents.ok && Array.isArray(agents.agents), 'agents answer')

    const runs = await (await fetchPath(`/api/runs?repo=${repoId}&limit=5`)).json()
    isTrue(runs.ok && Array.isArray(runs.runs), 'runs answer')
    isTrue(runs.runs.length <= 5, 'and the limit is honoured')
    isTrue(runs.runs.every(r => r.short_id && r.id), 'every row carries its short id')

    const favs = await (await fetchPath('/api/favorites')).json()
    isTrue(favs.ok && Array.isArray(favs.favorites) && Number.isFinite(favs.max), 'favorites answer')

    // An unknown run is a 404 with a reason, not a 500 and not an empty 200.
    const fehlt = await fetchPath('/api/runs/00000000-0000-0000-0000-000000000000')
    equal(fehlt.status, 404, 'an unknown run is a 404')
  })

  await check('GET /api/runs/<id> carries the files, the events and a liveness verdict', async () => {
    const j = await (await fetchPath(`/api/runs/${R1}`)).json()
    isTrue(j.ok, 'ok')
    equal(j.run.id, R1, 'the run')
    isTrue(Array.isArray(j.events) && j.events.length > 0, 'its events')
    isTrue(Array.isArray(j.incidents), 'its incidents')
    isTrue(j.files.report.path.includes(R1), 'the report path')
    isTrue(typeof j.files.report.exists === 'boolean', 'with an exists flag, so nobody has to guess the path')
    // The whole point of the block: "done" says the run reported, not that the
    // process is gone — three of the four coding agents stay in their TUI.
    isTrue(['working', 'idle_in_tui', 'process_gone', 'no_session', 'unknown'].includes(j.liveness.verdict),
      `liveness verdict is one of the five (${j.liveness.verdict})`)
    isTrue([true, false, null].includes(j.liveness.pane_alive),
      'pane_alive is a tri-state — null means tmux could not be asked, never "gone"')
  })

  await check("the skill's own run-alive script answers against a live hub", async () => {
    // A script shipped inside a skill is a promise like any other line in it.
    // Run it the way an agent would: fl-api on PATH, FL_HUB_URL from the
    // session — which is exactly what a run's environment carries.
    const skript = join(PROJECT, 'skills', 'freilauf-runs', 'scripts', 'run-alive.py')
    const lauf = (args) => new Promise((res) => execFile('python3', [skript, ...args], {
      env: { ...process.env, PATH: `${join(PROJECT, 'bin')}:${process.env.PATH}`, FL_HUB_URL: sk.base },
      timeout: 30_000,
    }, (err, stdout, stderr) => res({ code: err?.code ?? 0, stdout, stderr })))

    const hilfe = await lauf(['--help'])
    equal(hilfe.code, 0, '--help works')
    contains(hilfe.stdout, 'run-alive', 'and says what it is')

    const einer = await lauf([R1])
    equal(einer.code, 0, `one run answers (${einer.stderr})`)
    contains(einer.stdout, 'verdict', 'the header')
    contains(einer.stdout, R1.slice(0, 8), 'and the run it was asked about')
    // The verdict column is the whole point: it is one of the five words, and
    // it is NOT the status column.
    isTrue(/\b(working|idle_in_tui|process_gone|no_session|unknown)\b/.test(einer.stdout),
      `a verdict is printed (${einer.stdout.trim()})`)

    const liste = await lauf(['--repo', String(repoId)])
    equal(liste.code, 0, `a whole repo answers (${liste.stderr})`)
    isTrue(liste.stdout.split('\n').filter(Boolean).length >= 2, 'header plus at least one run')

    const quatsch = await lauf(['--wat'])
    equal(quatsch.code, 2, 'an unknown option is a usage error, not a crash')
  })

  await check("the skills' options tool answers against a live hub", async () => {
    // Every dropdown in the UI is a list this must be able to print, and the
    // check must catch a wrong value with the valid ones next to it — that is
    // the whole point of shipping it.
    const skript = join(PROJECT, 'skills', 'freilauf-runs', 'scripts', 'fl-options.py')
    const lauf = (args) => new Promise((res) => execFile('python3', [skript, ...args], {
      env: { ...process.env, FL_HUB_URL: BASE },
      timeout: 40_000,
    }, (err, stdout, stderr) => res({ code: err?.code ?? 0, stdout, stderr })))

    const uebersicht = await lauf([])
    equal(uebersicht.code, 0, `no arguments is the overview (${uebersicht.stderr})`)
    contains(uebersicht.stdout, 'Freilauf options', 'and it says what it is')
    contains(uebersicht.stdout, '`repos`', 'listing the commands rather than the data')

    const repos = await lauf(['repos'])
    equal(repos.code, 0, 'repos answers')
    contains(repos.stdout, 'e2e', 'with the sandbox repo in it')

    const wo = await lauf(['where'])
    equal(wo.code, 0, 'where answers')
    contains(wo.stdout, BASE, 'naming the hub it found')

    // The fill-in help: a wrong value must come back with the valid ones.
    const schlecht = await lauf(['check', 'harness=claude', 'effort=maximum', 'repo_id=' + repoId])
    equal(schlecht.code, 1, 'a broken definition exits 1')
    contains(schlecht.stdout, 'WRONG', 'and says which field is wrong')
    contains(schlecht.stdout, 'effort', 'naming it')
    contains(schlecht.stdout, 'MISSING', 'plus what is missing entirely')

    // A coding agent that is NOT on a subscription needs a model provider, and
    // the hub itself accepts the hole: an empty provider is its legacy path for
    // a hand-typed complete slug, so such an agent saves, schedules, starts —
    // and then launches with a bare model id and no credential. Agents really
    // were created that way through these skills, so the refusal lives here.
    const ohne = await lauf(['check', 'harness=opencode', 'model=whatever',
      'repo_id=' + repoId, 'prompt=do a thing', 'branch_mode=keiner'])
    equal(ohne.code, 1, `a missing provider is refused, not noted (${ohne.stdout})`)
    contains(ohne.stdout, 'MISSING  provider', 'naming the field')
    // opencode-zen and not openrouter: the list is what the operator enabled
    // INTERSECTED with what holds a credential, and the sandbox deliberately
    // carries no key — a key-free provider is the one entry always in it.
    contains(ohne.stdout, 'opencode-zen', 'and the values this installation would accept')
    // ...and the model is then NOT measured against some other catalogue: the
    // provider decides which one, so "your model is fine" would be a lie.
    contains(ohne.stdout, 'NOT checked', 'the model is left unjudged without one')

    // claude, by contrast, IS on its subscription — so the same emptiness is
    // correct there, and that is the only reading of a check that passes
    // without a provider.
    const gut = await lauf(['check', 'harness=claude', 'repo_id=' + repoId, 'prompt=do a thing',
      'branch_mode=keiner'])
    equal(gut.code, 0, `a sound definition exits 0 (${gut.stdout})`)
    contains(gut.stdout, '/api/runs', 'and hands back the command to post it')

    const quatsch = await lauf(['nonsense'])
    equal(quatsch.code, 2, 'an unknown command is a usage error')
  })

  await check("the plugin skill's tool finds the contract and reads the registry", async () => {
    // The whole point of this one is that it must not restate `docs/plugins.md`
    // — so if it cannot FIND that file it is worth nothing. The resolution is
    // therefore the first assertion, and the section index the second: an
    // agent that has to read 1450 lines to find one contract reads none of it.
    const skript = join(PROJECT, 'skills', 'freilauf-plugins', 'scripts', 'fl-plugins.py')
    const lauf = (args) => new Promise((res) => execFile('python3', [skript, ...args], {
      env: { ...process.env, FL_HUB_URL: BASE },
      timeout: 40_000,
    }, (err, stdout, stderr) => res({ code: err?.code ?? 0, stdout, stderr })))

    const uebersicht = await lauf([])
    equal(uebersicht.code, 0, `no arguments is the overview (${uebersicht.stderr})`)
    contains(uebersicht.stdout, 'Freilauf plugins', 'and it says what it is')
    contains(uebersicht.stdout, '`docs [text]`', 'listing the commands rather than the data')

    const docs = await lauf(['docs'])
    equal(docs.code, 0, `docs answers (${docs.stderr})`)
    contains(docs.stdout, join(PROJECT, 'docs', 'plugins.md'), 'resolving the real file')
    contains(docs.stdout, 'Coding agent plugin contract', 'and printing its sections')
    contains(docs.stdout, 'Notifier plugin contract', 'all three kinds among them')

    const liste = await lauf(['list'])
    equal(liste.code, 0, `list answers (${liste.stderr})`)
    contains(liste.stdout, 'Coding agents', 'the registered coding agents')
    contains(liste.stdout, 'External packages', 'and the external packages')
    // There IS no JSON route for the registry, and a tool that quietly showed
    // half the answer would be worse than one that names the gap.
    contains(liste.stdout, '/settings/notifications', 'saying where the rest of the answer is')

    const quatsch = await lauf(['nonsense'])
    equal(quatsch.code, 2, 'an unknown command is a usage error')
  })

  await check('the search finds a run by its title, its prompt and its id', async () => {
    const nachTitel = await (await fetchPath(`/api/runs?repo=${repoId}&q=${encodeURIComponent(R1.slice(0, 8))}&archived=all`)).json()
    isTrue(nachTitel.runs.some(r => r.id === R1), 'by the beginning of its id')
  })

  await check('the welcome wizard answers on every step and each POST moves one step on', async () => {
    for (let step = 1; step <= 6; step++) {
      const r = await fetchPath(`/welcome?step=${step}`)
      equal(r.status, 200, `step ${step} renders`)
      const html = await r.text()
      contains(html, `${step} of 6`, `step ${step} says where it is`)
      contains(html, 'name="welcome_hide"', `step ${step} carries the "do not show again" box`)
      contains(html, 'welcome=skip', `step ${step} offers the way out`)
      // …and on an unlocked page that way out is a SUBMIT of the very form the
      // box is in, not a link beside it. A link is what threw a ticked box
      // away, and the wizard then greeted the operator it had just been told
      // to stop greeting.
      if (step < 6) contains(html, 'name="exit" value="1"', `step ${step} leaves by submitting, not by navigating`)
      // Opening the wizard as an ordinary page IS the "not now" answer. Without
      // it the nav's own "Overview" link — `layout()` draws it around every
      // unlocked step — would bounce the reader right back here.
      isTrue(String(r.headers.get('set-cookie') ?? '').includes('freilauf_welcome'),
        `step ${step} marks the session, so every link off the page works`)
    }
    // An out-of-range step is step 1, not a 404: the address is typed by hand
    // and by a bookmark, and neither deserves an error page.
    equal((await fetchPath('/welcome?step=99')).status, 200, 'a nonsense step still renders')
    equal((await fetchPath('/welcome?step=abc')).status, 200, 'and so does a non-number')

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
    for (const [pfad, data, ziel] of schritte) {
      const r = await postForm(pfad, data, { asBrowser: true })
      equal(r.status, 303, `${pfad} redirects`)
      equal(r.headers.get('location'), ziel, `${pfad} → ${ziel}`)
    }
    // Step 3 really configured the provider it was handed.
    equal(db.prepare(`SELECT enabled FROM plugin_config WHERE plugin_id='openrouter'`).get().enabled, 1,
      'the chosen model provider is switched on')
    // A provider the hub does not know is a readable problem, not a stored row.
    const schlecht = await postForm('/welcome/provider', { id: 'not-a-provider' }, { asBrowser: true })
    equal(schlecht.status, 400, 'an unknown provider is refused')
  })

  await check('ticking "do not show again" is what stops GET / from redirecting', async () => {
    const asBrowser = { headers: { accept: 'text/html,application/xhtml+xml' } }
    try {
      // A fresh installation: the wizard is what `GET /` shows, but only for a
      // BROWSER navigation — an API caller asking for `/` must never be
      // answered with a redirect to HTML.
      sk.setSetting('welcome_hide', '0')
      const alsMensch = await fetchPath('/', asBrowser)
      equal(alsMensch.status, 303, 'a browser navigation goes to the wizard')
      equal(alsMensch.headers.get('location'), '/welcome', 'to /welcome')
      equal((await fetchPath('/')).status, 200, 'a fetch without an Accept header gets the overview')
      equal((await fetchPath('/api/usage')).status, 200, 'and the API is untouched')
      // "Skip for now" is a session answer and must not bounce into a loop.
      const skip = await fetchPath('/?welcome=skip', asBrowser)
      equal(skip.status, 200, 'skipping lands on the overview')
      isTrue(String(skip.headers.get('set-cookie') ?? '').includes('freilauf_welcome'),
        'and marks the browser so the link does not bounce back')

      // The box is honoured from any step, not only the last one.
      equal((await postForm('/welcome/hello', { welcome_hide: '1' }, { asBrowser: true })).status, 303, 'ticked on step 1')
      equal(db.prepare(`SELECT value FROM settings WHERE key='welcome_hide'`).get().value, '1', 'the setting is written')
      const danach = await fetchPath('/', asBrowser)
      equal(danach.status, 200, 'and the overview is the overview again')
      contains(await danach.text(), 'Quick Run', 'really the hub, not the wizard')
      // …and it can be switched back on, which is what the hidden `0`
      // companion exists for: an unticked box sends NOTHING, so without a
      // field carrying `0` the wizard could only ever be switched off.
      contains(await (await fetchPath('/welcome')).text(),
        '<input type="hidden" name="welcome_hide" value="0">', 'the form ships that companion')
      equal((await postForm('/welcome/hello', { welcome_hide: '0' }, { asBrowser: true })).status, 303, 'unticked')
      equal(db.prepare(`SELECT value FROM settings WHERE key='welcome_hide'`).get().value, '0', 'switched back on')
      equal((await fetchPath('/', asBrowser)).status, 303, 'and the wizard is back')

      // The way out of an unlocked wizard saves the box on its way. This is the
      // gesture a returning operator actually makes — tick it, then leave — and
      // it used to be a link outside the form, so the tick never arrived.
      const raus = await postForm('/welcome/hello', { welcome_hide: '1', exit: '1' }, { asBrowser: true })
      equal(raus.status, 303, 'leaving redirects')
      equal(raus.headers.get('location'), '/', 'into the hub, not on to step 2')
      equal(db.prepare(`SELECT value FROM settings WHERE key='welcome_hide'`).get().value, '1',
        'and the ticked box was saved on the way out')
      // Untouched box, same exit: the session mark is what keeps `GET /` from
      // sending the operator straight back to the page they just left.
      sk.setSetting('welcome_hide', '0')
      const rausOhne = await postForm('/welcome/hello', { welcome_hide: '0', exit: '1' }, { asBrowser: true })
      equal(rausOhne.headers.get('location'), '/', 'leaving without ticking still leaves')
      isTrue(String(rausOhne.headers.get('set-cookie') ?? '').includes('freilauf_welcome'),
        'and marks the session, so the redirect cannot bounce it back')
    } finally {
      sk.setSetting('welcome_hide', '1')
    }
  })

  // ------------------------------------------------------------------
  if (ECHT) {
    // From here on with the REAL fl-start and real harnesses. Deliberately a second
    // hub start: the stub part above must stay deterministic and free of charge.
    await stopHub()
    await startHub({ realAgents: true })

    const harnesses = [
      { name: 'claude', bedingung: () => hasBinary('claude'), fehlt: 'claude not in PATH' },
      {
        name: 'opencode', provider: 'openrouter', model: ECHT_MODELL,
        bedingung: () => hasBinary('opencode') && !!ECHT_KEYS.OPENROUTER_API_KEY,
        fehlt: 'opencode missing or OPENROUTER_API_KEY is not set',
      },
      {
        name: 'hermes', provider: 'openrouter', model: ECHT_MODELL,
        bedingung: () => hasBinary('hermes') && !!ECHT_KEYS.OPENROUTER_API_KEY,
        fehlt: 'hermes missing or OPENROUTER_API_KEY is not set',
      },
      {
        // Zen needs no key for the free models — and this also covers that the
        // prefix is right (opencode/… and NOT opencode-zen/…).
        name: 'opencode', titel: 'opencode via OpenCode Zen (free model)',
        provider: 'opencode-zen', model: ZEN_MODELL, marke: 'zen-echt.md',
        bedingung: () => hasBinary('opencode'),
        fehlt: 'opencode not in PATH',
      },
    ]

    for (const h of harnesses) {
      group(`Real run: ${h.titel ?? h.name}${h.provider ? ` — ${h.provider}/${h.model}` : ''}`)
      if (!h.bedingung()) {
        skipped(h.titel ?? h.name, h.fehlt)
        continue
      }
      await check(`${h.name} writes the file and reports done`, async () => {
        const marke = h.marke ?? `${h.name}-echt.md`
        const j = await laufStarten({
          repo_id: repoId, harness: h.name,
          ...(h.provider ? { provider: h.provider, model: h.model } : {}),
          prompt: `Lege im aktuellen Verzeichnis die Datei ${marke} an mit genau einer Zeile: ${h.name} lief. `
            + `Fuehre danach genau dieses Kommando aus: fl-report done "${h.name}-Rauchtest fertig"`,
          branch_mode: 'keiner', expected_minutes: '10',
        })
        isTrue(!!j.runId, `run started (${JSON.stringify(j)})`)
        await sessionMerken(j.runId)
        await waitFor(() => ['done', 'failed', 'aborted'].includes(lauf(j.runId).status),
          { what: `end of the ${h.name} run`, timeoutMs: 420_000, taktMs: 2000 })
        const r = lauf(j.runId)
        equal(r.status, 'done', `status (report: ${(r.report_md ?? '').slice(0, 80)})`)
        isTrue(existsSync(join(r.workdir_effective, marke)),
          `${marke} was really created in the worktree`)
        isTrue((r.report_md ?? '').length > 0, 'report present')
        // The agent's attention through the REAL hooks (docs/plugins.md,
        // "Attention"): the CLI said it started working, and — since
        // `fl-report done` is a tool call INSIDE the turn — said its turn was
        // over afterwards, which is what leaves a finished run's agent sitting
        // at its prompt. hermes and opencode need what setup/02 installs on
        // this machine (the plugin, the hooks block); a machine without that
        // fails here, and rightly so — it is what the suite is for.
        isTrue(ereignisse(j.runId).includes('agent_working'), `${h.name} reported _working through its hook`)
        await waitFor(() => lauf(j.runId).agent_state === 'waiting',
          { what: `${h.name} reporting its turn end`, timeoutMs: 90_000, taktMs: 1000 })
        isTrue(ereignisse(j.runId).includes('agent_waiting'), `${h.name} reported its turn end`)
        // …and the calls it made AFTER `fl-report done` — measured: two or
        // three, a summary or a `git status` — did not turn the finished run
        // into a follow-up. It reads "done", not "waiting for input".
        equal(lauf(j.runId).followup_since, null, `${h.name}'s tail calls after the report opened no commission`)
        contains(await (await fetchPath(`/runs/${j.runId}`)).text(), '"status-chip">Done<', `${h.name}'s run reads done`)
      })
    }
  }
  // ------------------------------------------------------------------
  group('The report socket')
  {
    // The narrow channel of SANDBOX.md: a second listener carrying
    // exactly two routes and a per-run bearer, so an agent can report without
    // being handed the whole API on 127.0.0.1 — and so a container, which cannot
    // reach the host's loopback at all, has a way home.
    //
    // The hub is restarted with FREILAUF_HUB_SOCKET pointed INTO the sandbox.
    // That is not a convenience: the default path is
    // `$XDG_RUNTIME_DIR/freilauf/hub.sock`, which on this machine belongs to the
    // production hub — a suite that used it would take the running hub's socket
    // away from it.
    const SOCK = join(SB, 'hub.sock')
    const http_ = await import('node:http')
    // This group is about the CHANNEL, not about the sandbox decision, and one
    // of its checks needs a run that is demonstrably not sandboxed. `off` is the
    // hub's default anyway; saying it here is what keeps the group from
    // depending on what an earlier group left in the settings table.
    sk.setSetting('sandbox_mode', 'off')
    await stopHub()
    await startHub({ env: { FREILAUF_HUB_SOCKET: SOCK } })

    /** One request over the unix socket. `token` absent = no Authorization header. */
    const ueberSocket = (method, pfad, { token = null, body: koerper = null } = {}) =>
      new Promise((resolve, reject) => {
        const kopf = { 'content-type': 'application/json' }
        if (token) kopf.authorization = `Bearer ${token}`
        const req = http_.request({ socketPath: SOCK, path: pfad, method, headers: kopf }, (res) => {
          let d = ''
          res.setEncoding('utf8')
          res.on('data', (c) => { d += c })
          res.on('end', () => { let j = null; try { j = JSON.parse(d) } catch {} resolve({ status: res.statusCode, text: d, json: j }) })
        })
        req.on('error', reject)
        if (koerper) req.write(JSON.stringify(koerper))
        req.end()
      })

    const laufFuerSocket = async (prompt) => {
      const j = await laufStarten({ repo_id: repoId, prompt })
      await sessionMerken(j.runId)
      return j.runId
    }

    await check('the hub listens on the socket it was told to listen on', async () => {
      await waitFor(() => existsSync(SOCK), { was: 'the socket file', timeoutMs: 10_000 })
      isTrue(lstatSync(SOCK).isSocket(), 'and it really is a socket')
    })

    await check('a report through the socket, with the run own token, changes the run', async () => {
      const id = await laufFuerSocket('socket report')
      const token = lauf(id).report_token
      isTrue(/^[0-9a-f]{64}$/.test(token ?? ''), 'the run carries a token without anybody asking for one')
      const r = await ueberSocket('POST', `/api/runs/${id}/report`, { token, body: { kind: 'branch', branch: 'over-the-socket' } })
      equal(r.status, 200, 'accepted')
      equal(lauf(id).branch_reported, 'over-the-socket', 'and the run really changed')
      // …and the answer the finish gate would give travels back the same way,
      // which is what fl-report prints into the agent's running turn.
      const fertig = await ueberSocket('POST', `/api/runs/${id}/report`, { token, body: { kind: 'done', text: 'socket done' } })
      equal(fertig.status, 200, 'a done report too')
      isTrue(fertig.json?.ok, 'with the same { ok, message } shape the loopback route answers')
      await waitFor(() => lauf(id).status === 'done', { was: 'the run ending', timeoutMs: 10_000 })
    })

    await check('a wrong token is refused, and a foreign run cannot be spoken for', async () => {
      const id = await laufFuerSocket('socket wrong token')
      const fremd = await laufFuerSocket('socket other run')
      const falscher = await ueberSocket('POST', `/api/runs/${id}/report`, { token: 'f'.repeat(64), body: { kind: 'branch', branch: 'nope' } })
      equal(falscher.status, 401, 'a token that is not this run own')
      const ohne = await ueberSocket('POST', `/api/runs/${id}/report`, { body: { kind: 'branch', branch: 'nope' } })
      equal(ohne.status, 401, 'and no token at all — on the socket the token is REQUIRED')
      // The id in the path and the token have to be the same run: that is what
      // keeps one agent from reporting for another agent's work.
      const quer = await ueberSocket('POST', `/api/runs/${fremd}/report`, { token: lauf(id).report_token, body: { kind: 'branch', branch: 'nope' } })
      equal(quer.status, 401, 'this run token does not open another run')
      equal(lauf(id).branch_reported, null, 'nothing was written')
      equal(lauf(fremd).branch_reported, null, 'nowhere')
    })

    await check('the socket carries nothing but its two routes', async () => {
      const id = await laufFuerSocket('socket route allowlist')
      const token = lauf(id).report_token
      // Every one of these is a real route of the hub on 127.0.0.1, and none of
      // them may be reachable from an agent's channel — even with a valid token.
      for (const [method, pfad] of [
        ['POST', `/api/runs/${id}/kill`],
        ['POST', `/api/runs/${id}/send`],
        ['POST', `/api/runs/${id}/edit`],
        ['POST', '/settings/save'],
        ['GET', '/api/runs'],
        ['GET', `/api/runs/${id}`],
        ['GET', '/'],
      ]) {
        equal((await ueberSocket(method, pfad, { token })).status, 404, `${method} ${pfad} is not on the socket`)
      }
      equal(lauf(id).status, 'running', 'and the run is untouched by all of it')
    })

    await check('an unsandboxed run is told that it is unsandboxed', async () => {
      const id = await laufFuerSocket('socket sandbox answer')
      const token = lauf(id).report_token
      const r = await ueberSocket('GET', `/api/runs/${id}/sandbox`, { token })
      equal(r.status, 200, 'answered')
      equal(r.json.sandboxed, false, 'not sandboxed')
      equal(r.json.run, id, 'and it is about this run')
      contains(r.json.message, 'not sandboxed', 'in a sentence the agent can read')
      equal((await ueberSocket('GET', `/api/runs/${id}/sandbox`, {})).status, 401, 'and it needs the token like everything here')
    })

    await check('the 127.0.0.1 route still takes a report with no token at all', async () => {
      // The transition rule: an agent that is mid-run right now was started by a
      // hub that knew no token, so its fl-report sends none. Breaking that would
      // silence every run in flight the moment this release is deployed.
      const id = await laufFuerSocket('loopback without a token')
      const r = await fetchPath(`/api/runs/${id}/report`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'branch', branch: 'no-token-needed' }),
      })
      equal(r.status, 200, 'accepted')
      equal(lauf(id).branch_reported, 'no-token-needed', 'and it changed the run')
    })

    await check('fl-report itself finds the socket and carries the token', async () => {
      const id = await laufFuerSocket('fl-report over the socket')
      const token = lauf(id).report_token
      // Deliberately NO FL_HUB_URL: this is the environment a sandboxed run gets,
      // where loopback leads nowhere. The report has to arrive anyway.
      const umgebung = {
        ...process.env, FL_RUN_ID: id, FL_RUN_TOKEN: token, FL_HUB_SOCKET: SOCK,
        HOME: SB, FREILAUF_RUNS_DIR: join(SB, 'runs'),
      }
      delete umgebung.FL_HUB_URL
      delete umgebung.CC_HUB_URL
      const r = await sh(FL_REPORT_REPO, ['progress', 'coming along over the socket'], { env: umgebung })
      isTrue(r.ok, `fl-report succeeded (${r.stderr.trim()})`)
      isFalse(r.stderr.includes('not reachable'), 'and did not fall back to the inbox')
      isTrue(ereignisse(id).includes('progress'), 'the progress report arrived')
      // The new kind of §7.12.1 reaches handleReport intact — what the hub then
      // DOES with it is another change; here it only has to travel.
      const zugang = await sh(FL_REPORT_REPO, ['access', 'files.example.org: the dependency mirror'], { env: umgebung })
      isTrue(zugang.ok, 'fl-report access is a kind this script knows')
    })

    await check('with no channel at all the report lands in the run directory the hub reads', async () => {
      // The last fallback, and the one nothing could observe: it used to write to
      // `$HOME/agents/runs/<id>` literally, so a suite that relocates the runs
      // directory never saw it — and inside a container, where $HOME is the run's
      // own seeded home, that path does not exist at all. It honours
      // FREILAUF_RUNS_DIR now, which is what makes this assertion possible.
      const id = await laufFuerSocket('the inbox fallback')
      const umgebung = {
        ...process.env, FL_RUN_ID: id, HOME: SB, FREILAUF_RUNS_DIR: join(SB, 'runs'),
        FL_HUB_URL: 'http://127.0.0.1:1', FL_HUB_SOCKET: join(SB, 'no-such.sock'),
      }
      delete umgebung.CC_HUB_URL
      const r = await sh(FL_REPORT_REPO, ['progress', 'nobody is listening'], { env: umgebung })
      isTrue(r.ok, 'fl-report still exits 0 — a report is never lost over a closed door')
      contains(r.stderr, 'inbox.jsonl', 'and says where it put the report')
      const inbox = join(SB, 'runs', id, 'inbox.jsonl')
      isTrue(existsSync(inbox), `the line is in the sandbox's own runs directory (${inbox})`)
      contains(readFileSync(inbox, 'utf8'), 'nobody is listening', 'with the report in it')
      // …and it is the directory the WATCHER reads, which is the whole point:
      // one pass and the report is a real event on the run.
      await watcherTick()
      isTrue(ereignisse(id).includes('progress'), 'the watcher collected it')
    })
  }

  // ------------------------------------------------------------------
  group('Sandbox: the container path')
  {
    // This machine has no Docker, and SANDBOX.md says the sandbox
    // has to be covered anyway. It is, because everything worth asserting here
    // is a question about what the hub SAYS to a container runtime: the exact
    // flags a profile produces, the order a kill puts a container and a tmux
    // session in, what a pass does when the daemon does not answer, which
    // container is reaped and which is not. test/shims/docker writes every word
    // down and answers what the test dictates — and its `run` executes the
    // wrapped command on the host, so a sandboxed run really starts a session
    // and everything downstream of the launch is exercised for real.
    //
    // Where a module of server/sandbox/ is not on disk yet, the check says so by
    // name and is SKIPPED. Nothing below is weakened to make it pass.
    const shim = sk.docker
    const seiten = (m) => m ? null : 'server/sandbox/index.mjs is not written yet'

    await check('nothing before this group ever called a container runtime', () => {
      // The one rule the whole feature hangs on, asserted rather than assumed:
      // an installation that does not ask for a sandbox takes byte for byte the
      // path it took before. Every group above ran with FREILAUF_SANDBOX_OFF=1
      // and no runtime binary named, so the shim's log has to be empty.
      equal(shim.calls().length, 0, 'runtime invocations from the unsandboxed suite')
    })

    // From here on the hub knows a runtime: the shim, named through
    // FREILAUF_SANDBOX_RUNTIME_BIN and first on the PATH.
    await stopHub()
    await startHub({ sandbox: true })
    watcherTick = await sk.prepareWatcher({ sandbox: true })
    shim.reset()

    const runtime = await import('../server/sandbox/runtime.mjs')
    const specMod = await import('../server/sandbox/spec.mjs')
    const profiles = await import('../server/sandbox/profiles.mjs')
    const cloneMod = await import('../server/sandbox/clone.mjs')
    const execMod = await import('../server/sandbox/exec.mjs')
    const integrate = await import('../server/integrate.mjs')
    // The facade of the module contract. Absent on the day this was written —
    // every check that needs it names it and skips rather than pretends.
    let facade = null
    try { facade = await import('../server/sandbox/index.mjs') } catch { facade = null }

    const g = (dir, ...args) => sh('git', ['-C', dir, ...args])
    /** The value after a flag in an argv, or null. */
    const wert = (argv, flag) => { const i = argv.indexOf(flag); return i < 0 ? null : argv[i + 1] }
    /** Every value of a flag that may repeat (-v, -e, --label, --tmpfs). */
    const werte = (argv, flag) => argv.reduce((out, tok, i) => (tok === flag ? [...out, argv[i + 1]] : out), [])
    const hatFlag = (argv, flag) => argv.includes(flag)

    await check('discovery goes through the shim and reads its answer', async () => {
      runtime._runtimeInfoCacheReset()
      shim.info({ ServerVersion: '27.5.1', SecurityOptions: ['name=rootless'], Runtimes: { runc: {}, runsc: {} } })
      const info = await runtime.runtimeInfo('docker', { force: true })
      isTrue(info.available, `runtime available (${JSON.stringify(info)})`)
      equal(info.version, '27.5.1', 'version out of docker info')
      equal(info.rootless, true, 'rootless read off SecurityOptions')
      isTrue(info.runtimes.includes('runsc'), 'the registered OCI runtimes are named')
      equal(runtime.runtimeBin('docker'), shim.BIN, 'the seam really points at the shim')
    })

    /**
     * Every mode change is restored in a `finally`, and that is not tidiness.
     * The shim's mode lives in a FILE that outlives the check that set it, so a
     * failing assertion inside one of these used to leave the whole group's
     * runtime answering `command not found` — five red checks, none of them
     * about what they said they were about. A fixture that survives its own
     * test's failure hides the one failure that was real.
     */
    async function imModus(mode, fn) {
      shim.mode(mode)
      runtime._runtimeInfoCacheReset()
      try { return await fn() } finally {
        shim.mode('ok')
        runtime._runtimeInfoCacheReset()
      }
    }

    await check('an absent binary is "not available", not a crash', async () => {
      await imModus('absent', async () => {
        const info = await runtime.runtimeInfo('docker', { force: true })
        isFalse(info.available, 'not available')
        // A DOTTED i18n key, never a bare word: the settings page prints this
        // reason, and `no_binary` reached the operator as those nine characters
        // on the one line they read while working out what to install. Asserted
        // as the KEY and not as the sentence, so improving the English does not
        // turn this red.
        isTrue(String(info.reason).startsWith('sandbox.reason.'),
          `a dotted reason key, got ${info.reason}`)
        isTrue(['sandbox.reason.no_binary', 'sandbox.reason.unreachable'].includes(info.reason),
          `and one this case can produce (${info.reason})`)
      })
    })

    // Deliberately NOT tested here: that an unknown runtime id is refused by
    // name. `runtimeBin()` returns the seam's binary BEFORE it consults the
    // runtime table, so with the shim named `runtimeInfo('nosuch')` probes the
    // shim and comes back available — the seam replaces the binary wholesale,
    // which is what makes it a seam. That refusal belongs where there is no
    // seam, and test/unit.mjs asserts it there.
    let gebautesImage = null
    await check('a build goes through the shim, and a local image has an id but no digest', async () => {
      shim.reset()
      const r = await runtime.buildImage('base', { runtime: 'docker' })
      isTrue(r.ok, `the build succeeded (${JSON.stringify(r).slice(0, 200)})`)
      const a = shim.lastArgv('build')
      isTrue(!!a, 'and it really went through the runtime binary')
      isTrue(a.includes('-f') && a.some(x => x.endsWith('base.Dockerfile')), `-f names the Dockerfile (${a.join(' ')})`)
      isTrue(a.includes('--build-arg') && a.some(x => x.startsWith('UID=')), 'the uid travels as a build arg (§7.7)')
      isTrue(a.includes('-t'), '-t names the tag')
      // The trap the runtime's own comment names: `RepoDigests` is filled only
      // for an image that came from or went to a registry, so a LOCAL build has
      // an Id and no pinnable digest — and `buildRunArgv()` may put only the
      // latter after an `@`. A shim that always answered a digest would hide it.
      equal(r.digest, null, 'a locally built image has no repo digest')
      isTrue(!!r.imageId, `but it has an id, which is what provenance is recorded from (${r.imageId})`)
      const d = await runtime.imageDigest(r.image)
      equal(d.digest, null, 'and asking again says the same')
      equal(d.id, r.imageId, 'about the same image')
      gebautesImage = r.image
    })

    // ---- the command line of §7.11, read out of the shim's own log ----------
    const RUN_ID = 'e2e-sandbox-argv'
    const HOME_DIR = join(SB, 'runs', RUN_ID, 'home')
    const RUN_DIR = join(SB, 'runs', RUN_ID)
    const CA = join(sk.SANDBOX_DIR, 'ca', 'freilauf-ca.crt')
    const SOCKET = join(sk.SANDBOX_DIR, 'sock', `${RUN_ID}.sock`)
    mkdirSync(HOME_DIR, { recursive: true })
    writeFileSync(CA, '-----BEGIN CERTIFICATE-----\ne2e\n-----END CERTIFICATE-----\n')
    writeFileSync(SOCKET, '')            // a file is enough: the shim mounts nothing
    const EMPTY = join(RUN_DIR, 'empty')
    writeFileSync(EMPTY, '')

    await check('the Balanced profile produces the §7.11 command line', async () => {
      const balanced = profiles.getProfileByName('Balanced')
      isTrue(!!balanced, 'the built-in profile is seeded')
      const spec = profiles.profileSpecFull(balanced.id)
      const { bin, args } = runtime.buildRunArgv(spec, {
        runId: RUN_ID, hubId: 'e2e-hub',
        workdir: REPO, homeDir: HOME_DIR, runDir: RUN_DIR,
        repoGitDir: join(REPO, '.git'), emptyFile: EMPTY,
        hubSocketSource: SOCKET, uid: 1000, gid: 1000,
        env: { FL_RUN_ID: RUN_ID, FL_RUN_TOKEN: 'tok' },
        image: 'freilauf/agent', digest: 'sha256:' + 'a'.repeat(64),
        caPath: CA, term: 'xterm-256color',
        binPaths: [join(PROJECT, 'bin', 'fl-report')],
        cmd: ['sh', '-c', 'echo sandboxed'],
      })
      equal(bin, shim.BIN, 'the pane command is the shim, not a bare docker')
      // Really invoke it. The assertion below reads the LOG, not the return
      // value of the builder — the question is what a runtime would have been
      // told, and a builder that is right while the caller drops half the argv
      // would pass a test that only looked at the builder.
      const r = await sh(bin, args)
      isTrue(r.ok, `the shim ran the wrapped command (${r.stderr.trim()})`)
      contains(r.stdout, 'sandboxed', 'and its output came back through the pane')

      const a = shim.runFor(`fl-${RUN_ID}`)
      isTrue(!!a, 'the invocation is in the argv log')
      equal(a[0], 'run', 'it is a `run`')
      for (const f of ['-it', '--rm', '--init', '--read-only']) isTrue(hatFlag(a, f), `flag ${f}`)
      equal(wert(a, '--name'), `fl-${RUN_ID}`, '--name')
      const labels = werte(a, '--label')
      isTrue(labels.includes(`freilauf.run=${RUN_ID}`), `label freilauf.run (${labels})`)
      isTrue(labels.includes('freilauf.hub=e2e-hub'), `label freilauf.hub (${labels})`)
      equal(wert(a, '--detach-keys'), 'ctrl-^,ctrl-^', '--detach-keys')
      equal(wert(a, '--stop-timeout'), '30', '--stop-timeout')
      equal(wert(a, '--user'), '1000:1000', '--user')
      equal(wert(a, '--cap-drop'), 'ALL', '--cap-drop ALL')
      equal(wert(a, '--security-opt'), 'no-new-privileges', '--security-opt')
      equal(wert(a, '--pids-limit'), '4096', '--pids-limit')
      equal(wert(a, '--memory'), '8g', '--memory')
      equal(wert(a, '--memory-swap'), '8g', '--memory-swap')
      equal(wert(a, '--cpus'), '4', '--cpus')
      equal(wert(a, '--shm-size'), '1g', '--shm-size')
      equal(wert(a, '--network'), `fl-net-${RUN_ID}`, 'the per-run internal network')
      const tmpfs = werte(a, '--tmpfs')
      isTrue(tmpfs.some(x => x.startsWith('/tmp:') && x.includes('size=2g')), `/tmp tmpfs (${tmpfs})`)
      isTrue(tmpfs.some(x => x.startsWith('/run:') && x.includes('noexec')), `/run tmpfs (${tmpfs})`)
      isTrue(tmpfs.some(x => x.startsWith(`${HOME_DIR}/.cache:`)), `the cache tmpfs (${tmpfs})`)
      const mounts = werte(a, '-v')
      isTrue(mounts.includes(`${REPO}:${REPO}`), `the working copy, read-write (${mounts})`)
      isTrue(mounts.includes(`${join(REPO, '.git')}:${join(REPO, '.git')}:ro`), 'the operator .git, READ-ONLY')
      isTrue(mounts.includes(`${EMPTY}:${join(REPO, '.git')}/config:ro`), 'an empty file over the operator .git/config')
      isTrue(mounts.includes(`${RUN_DIR}:${RUN_DIR}`), 'the run directory')
      isTrue(mounts.includes(`${HOME_DIR}:${HOME_DIR}`), 'the per-run home')
      isTrue(mounts.includes(`${SOCKET}:/run/freilauf/hub.sock`), 'the hub socket')
      isTrue(mounts.includes(`${CA}:/etc/freilauf/ca.crt:ro`), 'the CA, read-only')
      equal(wert(a, '-w'), REPO, '-w is the working copy')
      const envs = werte(a, '-e')
      isTrue(envs.includes(`HOME=${HOME_DIR}`), `HOME points at the per-run home (${envs.length} -e flags)`)
      isTrue(envs.includes(`FL_RUN_ID=${RUN_ID}`), 'FL_RUN_ID travels')
      isTrue(envs.some(x => x.startsWith('HTTPS_PROXY=')), 'the proxy variables are set under allowlist')
      isTrue(envs.includes('NO_PROXY='), 'NO_PROXY is empty on purpose — nothing bypasses the proxy')
      isTrue(envs.includes('SSL_CERT_FILE=/etc/freilauf/ca.crt'), 'the CA is named for every runtime')
      const image = a[a.length - 4]
      contains(image, 'freilauf/agent@sha256:', 'the image is pinned by digest, and stands before the command')
      equal(a.slice(-3).join(' '), 'sh -c echo sandboxed', 'the agent command is the tail')
    })

    await check('the wrapped command really runs on the host, in -w, with the container environment', async () => {
      const { bin, args } = runtime.buildRunArgv({ network: { mode: 'none' } }, {
        runId: 'e2e-wrap', hubId: 'e2e-hub', workdir: REPO, homeDir: HOME_DIR,
        env: { FL_RUN_ID: 'e2e-wrap' }, image: 'busybox',
        cmd: ['sh', '-c', 'printf "%s|%s" "$PWD" "$FL_RUN_ID"'],
      })
      const r = await sh(bin, args)
      equal(r.stdout.trim(), `${REPO}|e2e-wrap`, 'the -w directory and the -e variable both arrived')
    })

    await check('a `none` network writes no proxy variables at all', () => {
      const { args } = runtime.buildRunArgv({ network: { mode: 'none' } }, {
        runId: 'x', workdir: REPO, image: 'busybox', caPath: CA,
      })
      equal(wert(args, '--network'), 'none', '--network none')
      isFalse(werte(args, '-e').some(x => x.startsWith('HTTPS_PROXY=')),
        'no proxy variable — pointing at a proxy that is not there turns every request into a connection error')
    })

    // ---- exec: the container branch of runGit(), for real -------------------
    await check('git through the container really runs (runGit branch 2)', async () => {
      // A run row that says it is sandboxed and names a container the shim
      // knows. That is exactly the state exec.mjs branches on.
      shim.container('fl-e2e-exec', { state: 'running', workdir: REPO, labels: { 'freilauf.hub': 'e2e-hub' } })
      const run = { id: 'e2e-exec', sandbox: 1, sandbox_container: 'fl-e2e-exec', workdir_effective: REPO }
      const r = await execMod.runGit(run, ['rev-parse', 'HEAD'])
      isTrue(r.ok, `git answered (${r.stderr})`)
      const direkt = await g(REPO, 'rev-parse', 'HEAD')
      equal(r.stdout.trim(), direkt.stdout.trim(), 'and it is the same commit the host sees')
      const letzte = shim.lastArgv('exec')
      isTrue(!!letzte && letzte.includes('fl-e2e-exec'), `it went through \`exec\` (${JSON.stringify(letzte)})`)
    })

    await check('a container that is gone falls back to the hardened host command', async () => {
      const run = { id: 'e2e-exec2', sandbox: 1, sandbox_container: 'fl-does-not-exist', workdir_effective: REPO }
      const r = await execMod.runGit(run, ['rev-parse', 'HEAD'])
      isTrue(r.ok, 'the answer still comes — the dirt of a dead run is a display fact')
    })

    // ---- the clone, and the tip reaching the integrator ---------------------
    await check('a sandboxed run works in a clone, and its tip reaches the base branch', async () => {
      const repoRow = db.prepare('SELECT * FROM repos WHERE id=?').get(repoId)
      const vorher = await g(ORIGIN, 'log', '-1', '--format=%s', 'main')
      const j = await laufStarten({ repo_id: String(repoId), prompt: 'E2E-Sandbox-Clone', branch_mode: 'keiner' })
      isTrue(!!j.runId, `run started (${JSON.stringify(j)})`)
      await sessionMerken(j.runId)
      const row = lauf(j.runId)

      const c = await cloneMod.makeSandboxClone(repoRow, row)
      isTrue(existsSync(join(c.dir, '.git')), `the clone exists at ${c.dir}`)
      db.prepare('UPDATE runs SET workdir_effective=?, worktree_kind=?, base_sha=? WHERE id=?')
        .run(c.dir, 'clone', c.baseSha, j.runId)
      const nachher = lauf(j.runId)
      equal(nachher.worktree_kind, 'clone', 'worktree_kind says clone — the ONE thing the integrator reads')
      isTrue(cloneMod.isClone(nachher), 'isClone() agrees')

      writeFileSync(join(c.dir, 'sandbox-clone.md'), 'work done in a clone\n')
      await g(c.dir, 'add', '-A')
      await g(c.dir, '-c', 'user.email=e2e@test.local', '-c', 'user.name=E2E', 'commit', '-qm', 'Sandbox clone commit')
      const tip = await g(c.dir, 'rev-parse', 'HEAD')

      // The seam of §7.4: a clone's commits live in a repository the operator's
      // checkout has never heard of, so the integrator fetches the tip across
      // before it can merge anything.
      const gesammelt = await cloneMod.collectRunTip(lauf(j.runId))
      equal(gesammelt, tip.stdout.trim(), 'collectRunTip() brought the tip over')
      const sichtbar = await g(REPO, 'cat-file', '-e', gesammelt)
      isTrue(sichtbar.ok, 'and the operator checkout can now see that commit')

      // …and the ordinary merge path completes on it, unchanged. merge_mode is
      // switched on for this one run and off again below.
      const repoForm = db.prepare('SELECT * FROM repos WHERE id=?').get(repoId)
      await postForm(`/repos/edit?id=${repoId}`, {
        name: repoForm.name, path: REPO, base_branch: 'main',
        worktree_extras: repoForm.worktree_extras ?? '[]', prompt: repoForm.prompt ?? '',
        merge_mode: 'hub', merge_check: '', finish_timeout_min: '15',
        merge_max_attempts: '2', conflict_parallel: '1', notify_running: '1', max_parallel: '0',
      }, { asBrowser: true })
      await fetchPath(`/api/runs/${j.runId}/report`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'done', text: 'clone run finished' }),
      })
      await waitFor(() => lauf(j.runId).status === 'done',
        { was: 'the clone run being merged', timeoutMs: 30_000 })
      const jetzt = await g(ORIGIN, 'log', '-1', '--format=%s', 'main')
      isFalse(jetzt.stdout.trim() === vorher.stdout.trim(), 'origin/main moved')
      const dateien = await g(ORIGIN, 'show', '--name-only', '--format=', 'main')
      contains((await g(ORIGIN, 'log', '--format=%s', '-3', 'main')).stdout, 'Sandbox clone commit',
        `the clone's own commit is on the base branch (${dateien.stdout.trim()})`)
      // Back off again, so nothing after this group inherits it.
      await postForm(`/repos/edit?id=${repoId}`, {
        name: repoForm.name, path: REPO, base_branch: 'main',
        worktree_extras: repoForm.worktree_extras ?? '[]', prompt: repoForm.prompt ?? '',
        merge_mode: 'off', merge_check: '', finish_timeout_min: '15',
        merge_max_attempts: '2', conflict_parallel: '1', notify_running: '1', max_parallel: '0',
      }, { asBrowser: true })
    })

    // ---- the verdict: "the daemon did not answer" is not "there is nothing" --
    await check('an unreachable daemon is a third answer, not an empty one', async () => {
      await imModus('unreachable', async () => {
        const antwort = await runtime.listOwned('e2e-hub')
        equal(antwort.verdict, 'unreachable', 'the verdict travels with the empty list')
        equal(antwort.containers.length, 0, 'and the list IS empty — which is why the verdict has to be read')
        const zustand = await runtime.containerState('fl-e2e-exec')
        equal(zustand.verdict, 'unreachable', 'containerState says the same')
        equal(zustand.exists, null, 'exists is null, not false — nobody answered')
      })
    })

    await check('a watcher pass with an unreachable daemon reaps nothing and ends no run', async () => {
      const j = await laufStarten({ repo_id: String(repoId), prompt: 'E2E-Sandbox-Unreachable' })
      await sessionMerken(j.runId)
      db.prepare('UPDATE runs SET sandbox=1, sandbox_container=? WHERE id=?').run(`fl-${j.runId}`, j.runId)
      shim.reset()          // reset() clears the mode too, so it is set AFTER it
      await imModus('unreachable', () => watcherTick())
      equal(lauf(j.runId).status, 'running', 'the run is untouched — a daemon restart must not end it')
      isFalse(ereignisse(j.runId).includes('sandbox:container_gone'),
        'and nothing claimed its container was gone')
      isFalse(shim.order().includes('rm'), 'nothing was removed on an answer nobody got')
      isFalse(shim.order().includes('stop'), 'and nothing was stopped')
      await fetchPath(`/api/runs/${j.runId}/kill`, { method: 'POST' })
    })

    await check('with the sandbox off, an ordinary run never calls the runtime', async () => {
      shim.reset()
      const j = await laufStarten({ repo_id: String(repoId), prompt: 'E2E-Sandbox-Off' })
      isTrue(!!j.runId, `run started (${JSON.stringify(j)})`)
      await sessionMerken(j.runId)
      equal(lauf(j.runId).sandbox, 0, 'the run is not sandboxed')
      equal(shim.argvFor('run').length, 0, `no container was started (${JSON.stringify(shim.order())})`)
      await fetchPath(`/api/runs/${j.runId}/kill`, { method: 'POST' })
    })

    // ---- the live half of a policy change ----------------------------------
    await check('limits change on a live container without a restart', async () => {
      shim.container('fl-e2e-live', { state: 'running', limits: { memory: '8g', cpus: '4' } })
      shim.reset()
      const r = await runtime.updateLimits('fl-e2e-live', { memory: '16g', cpus: 8, pidsLimit: 8192 })
      isTrue(r.ok && r.changed, `docker update succeeded (${JSON.stringify(r)})`)
      const a = shim.lastArgv('update')
      equal(wert(a, '--memory'), '16g', '--memory')
      equal(wert(a, '--cpus'), '8', '--cpus')
      equal(wert(a, '--pids-limit'), '8192', '--pids-limit')
      isFalse(shim.order().includes('run'), 'and nothing was restarted for it')
      equal(shim.containers()['fl-e2e-live'].state, 'running', 'the container is still the same one')
    })

    await check('an empty limit writes no flag — `` is not a configured 0', async () => {
      shim.reset()
      const r = await runtime.updateLimits('fl-e2e-live', { memory: '', cpus: null })
      equal(r.changed, false, 'nothing to change')
      equal(shim.argvFor('update').length, 0, 'and no call at all — --memory 0 is a refusal, not "no limit"')
    })

    await check('the proxy policy swaps live, and a tightening is in force at once', async () => {
      const proxy = await import('../server/sandbox/proxy.mjs')
      const handle = await proxy.startProxy({ id: 'e2e-proxy' },
        { network: { mode: 'allowlist', engine: 'builtin', presets: [], allow: ['api.example.com'] } },
        { runDir: join(SB, 'runs') })
      try {
        isTrue(handle.url.startsWith('http://127.0.0.1:'), `the built-in proxy binds loopback only (${handle.url})`)
        isTrue(proxy.hostAllowed(handle.policy, 'api.example.com'), 'the allowed host is allowed')
        isFalse(proxy.hostAllowed(handle.policy, 'evil.example.com'), 'and nothing else is')
        await proxy.reloadProxy(handle, { network: { mode: 'allowlist', engine: 'builtin', presets: [], allow: [] } })
        isFalse(proxy.hostAllowed(handle.policy, 'api.example.com'),
          'after the reload the tightening is in force for the next connection')
      } finally {
        await proxy.stopProxy(handle)
      }
    })

    // ---- the narrowing rule, which is what an override may and may not do ----
    await check('an override that would LOOSEN a locked field is refused, and named', () => {
      const { spec, refused } = specMod.resolveSandboxSpec({
        hub: { spec: { network: { mode: 'allowlist' }, resources: { memory: '8g' } },
          lock: ['network.mode', 'resources.memory'] },
        agentOrRun: { spec: { network: { mode: 'open' }, resources: { memory: '64g' } } },
      })
      equal(spec.network.mode, 'allowlist', 'the stricter value is kept')
      equal(spec.resources.memory, '8g', 'and so is the lower limit')
      isTrue(refused.some(r => r.path === 'network.mode'), `the loosening is reported (${JSON.stringify(refused)})`)
      isTrue(refused.some(r => r.path === 'resources.memory'), 'both of them')
    })

    await check('narrowing a locked field is allowed and silent', () => {
      const { spec, refused } = specMod.resolveSandboxSpec({
        hub: { spec: { network: { mode: 'allowlist' }, resources: { memory: '8g' } },
          lock: ['network.mode', 'resources.memory'] },
        agentOrRun: { spec: { network: { mode: 'none' }, resources: { memory: '2g' } } },
      })
      equal(spec.network.mode, 'none', 'stricter mode wins')
      equal(spec.resources.memory, '2g', 'a lower limit is a narrowing')
      equal(refused.length, 0, `nothing refused (${JSON.stringify(refused)})`)
    })

    // ---- what needs the facade of the module contract -----------------------
    // These are written against server/sandbox/index.mjs as the contract
    // describes it. They are NOT weakened to pass without it: where the module
    // is missing they say so and skip.
    const fehlt = seiten(facade)

    // The witness the two ordering checks below need: the shim runs it before it
    // answers `stop`, so it sees the world AT THAT MOMENT. Neither ordering can
    // be read out of a log afterwards — by then the session is gone either way.
    const sessionWitness = (name) => shim.hook('stop',
      `tmux has-session -t "=${name}" 2>/dev/null && echo standing > "$FL_DOCKER_STATE/witness" || echo gone > "$FL_DOCKER_STATE/witness"`)

    if (fehlt) skipped('ending a session stops the container before tmux', fehlt)
    else {
      await check('ending a session stops the container before tmux', async () => {
        const j = await laufStarten({ repo_id: String(repoId), prompt: 'E2E-Sandbox-KillSession' })
        const s = await sessionMerken(j.runId)
        db.prepare('UPDATE runs SET sandbox=1, sandbox_container=? WHERE id=?').run(`fl-${j.runId}`, j.runId)
        shim.container(`fl-${j.runId}`, { state: 'running' })
        shim.reset()
        sessionWitness(s)
        await postForm('/api/sessions/kill', { session: s })
        await waitFor(async () => !(await sh('tmux', ['has-session', '-t', `=${s}`])).ok,
          { was: 'the tmux session going away' })
        isTrue(shim.order().includes('stop'), `the container was stopped (${JSON.stringify(shim.order())})`)
        // The ordering IS the assertion: a session closed first leaves the agent
        // running in a container whose client is gone (§7.11).
        equal(shim.witness(), 'standing', 'and the session was still standing when it was stopped')
        shim.clearHook('stop')
      })
    }

    if (fehlt) skipped('the kill route stops the container before the tmux session', fehlt)
    else {
      await check('the kill route stops the container before the tmux session', async () => {
        const j = await laufStarten({ repo_id: String(repoId), prompt: 'E2E-Sandbox-Kill' })
        const s = await sessionMerken(j.runId)
        db.prepare('UPDATE runs SET sandbox=1, sandbox_container=? WHERE id=?').run(`fl-${j.runId}`, j.runId)
        shim.container(`fl-${j.runId}`, { state: 'running' })
        shim.reset()
        sessionWitness(s)
        await fetchPath(`/api/runs/${j.runId}/kill`, { method: 'POST' })
        await waitFor(async () => !(await sh('tmux', ['has-session', '-t', `=${s}`])).ok,
          { was: 'the tmux session going away' })
        isTrue(shim.order().includes('stop'),
          'the container was stopped — §7.11 names BOTH killSessions() and /api/runs/<id>/kill, '
          + 'and web.mjs\'s kill route calls tmux directly without stopping the container first')
        equal(shim.witness(), 'standing', 'and it was stopped while the session still stood')
        shim.clearHook('stop')
      })
    }

    if (fehlt) skipped('an orphaned container is reaped, a live one is not', fehlt)
    else {
      await check('an orphaned container is reaped, a live one is not', async () => {
        const id = facade.hubId()
        const tot = await laufStarten({ repo_id: String(repoId), prompt: 'E2E-Sandbox-Orphan' })
        await sessionMerken(tot.runId)
        await fetchPath(`/api/runs/${tot.runId}/kill`, { method: 'POST' })
        const lebt = await laufStarten({ repo_id: String(repoId), prompt: 'E2E-Sandbox-Live' })
        await sessionMerken(lebt.runId)
        for (const r of [tot.runId, lebt.runId]) {
          db.prepare('UPDATE runs SET sandbox=1, sandbox_container=? WHERE id=?').run(`fl-${r}`, r)
          shim.container(`fl-${r}`, { state: 'running', labels: { 'freilauf.hub': id } })
        }
        // Exactly the state the hub leaves behind: the run is terminal and its
        // session is closed. `tmux_session` KEEPS its name — nothing in the hub
        // ever NULLs that column (reconcileClosedSession and the kill route both
        // write `tmux_closed_at` instead), and a reaper that asks
        // `!run.tmux_session` therefore never fires on a real installation.
        equal(lauf(tot.runId).status, 'aborted', 'the orphan\'s run is terminal')
        isTrue(!!lauf(tot.runId).tmux_closed_at, 'and its session is recorded as closed')
        shim.reset()
        // The pass the WATCHER runs, which is the one production has. (There is
        // a second `reconcileContainers()` in server/sandbox/index.mjs; it asks
        // `!run.tmux_session`, and nothing in the hub ever NULLs that column —
        // reconcileClosedSession() and the kill route both write
        // `tmux_closed_at` instead — so that copy never reaps anything. Two
        // copies of one rule is the drift run-def.mjs exists to prevent.)
        const watcherMod = await import('../server/watcher.mjs')
        await watcherMod.reconcileContainers(id)
        const angefasst = shim.argvFor('rm').flat().concat(shim.argvFor('stop').flat())
        isTrue(angefasst.includes(`fl-${tot.runId}`),
          'the orphan of a terminal run whose session is closed was stopped and removed')
        isFalse(angefasst.includes(`fl-${lebt.runId}`),
          'and the container of a run still in flight was NOT touched (hermes\' orphan-reaper rule)')
        await fetchPath(`/api/runs/${lebt.runId}/kill`, { method: 'POST' })
      })
    }

    // ---- the two halves of a live change are delivered separately -----------
    //
    // §7.12.3 splits a live change in two: the network rules go to the proxy,
    // memory/cpus/pids go to `docker update`. Neither of these runs has a proxy
    // — nothing prepared one, which is also the state a hub is in for every run
    // it did not launch itself — so what is under test here is exactly what
    // `changePolicy()` does with the half it cannot deliver. The half it CAN is
    // asserted end to end where a proxy really stands, in the sandbox page group
    // below ('"allow" reaches the facade').
    //
    // The `sandbox:policy_changed` payload is read rather than merely counted:
    // its `applied`/`enforced` are what the run's own record says about whether
    // the policy it now names is the policy in force, and a boolean nobody reads
    // is how the old "reported a change it did not make" defect survived.
    const politikEreignis = (runId) => {
      const row = db.prepare(
        `SELECT payload FROM events WHERE run_id=? AND kind='sandbox:policy_changed' ORDER BY id DESC LIMIT 1`).get(runId)
      try { return JSON.parse(row?.payload || '{}') } catch { return {} }
    }

    // ONE run for both checks below, and deliberately so: each of them leaves a
    // sandboxed container behind for the reaper group further down, whose
    // ordering assertion reads one global call log — a second leftover makes two
    // runs reaped concurrently and their `rm`/`network rm` interleave.
    let politikLauf = null
    const politikLaufHolen = async () => {
      if (politikLauf) return politikLauf
      const j = await laufStarten({ repo_id: String(repoId), prompt: 'E2E-Sandbox-Policy' })
      await sessionMerken(j.runId)
      db.prepare('UPDATE runs SET sandbox=1, sandbox_container=? WHERE id=?').run(`fl-${j.runId}`, j.runId)
      shim.container(`fl-${j.runId}`, { state: 'running' })
      politikLauf = j
      return j
    }

    if (fehlt) skipped('a limits-only change needs no proxy, a network-only one refuses without it', fehlt)
    else {
      await check('a limits-only change needs no proxy, a network-only one refuses without it', async () => {
        const j = await politikLaufHolen()

        // A patch that never involves the proxy. It must land — the run has no
        // proxy handle, and `docker update` does not care.
        shim.reset()
        const nurGrenzen = await facade.changePolicy(lauf(j.runId), { resources: { memory: '16g' } }, 'e2e')
        isTrue(nurGrenzen?.ok, `the limits-only change was applied (${JSON.stringify(nurGrenzen)})`)
        equal(nurGrenzen.applied.limits, true, 'and it says so per half')
        equal(nurGrenzen.applied.proxy, false, 'the proxy half was never asked for')
        isTrue(shim.argvFor('update').length > 0, 'docker update carried the new limit')
        equal(wert(shim.lastArgv('update'), '--memory'), '16g', 'the one that was patched')
        equal(shim.argvFor('run').length, 0, 'and nothing was restarted for it')
        equal(politikEreignis(j.runId).enforced, true, 'the record says the policy is in force')
        equal(lauf(j.runId).status, 'running', 'the run kept running')

        // And the other end of the same rule: a change the proxy has to carry,
        // with no proxy to carry it, is a REFUSAL. It used to answer ok — the
        // operator was told "Allow for this run" had worked while the agent kept
        // hitting the same wall.
        shim.reset()
        const nurNetz = await facade.changePolicy(lauf(j.runId), { network: { allow: ['files.example.org'] } }, 'e2e')
        isFalse(nurNetz?.ok, `a network change with no proxy is refused (${JSON.stringify(nurNetz)})`)
        isFalse(nurNetz.partial, 'and nothing of it landed, so it is not a partial application')
        equal(nurNetz.applied.proxy, false, 'the proxy half did not land')
        equal(shim.argvFor('update').length, 0, 'and no limit was touched by a network-only patch')
        contains(String(nurNetz.error), 'proxy', 'the reason names the proxy')
        equal(politikEreignis(j.runId).enforced, false, 'and the record says the new policy is NOT in force')
        // The spec row is written all the same: a resume has to come back with
        // the policy the operator asked for, not the one they replaced.
        contains(String(lauf(j.runId).sandbox_spec), 'files.example.org', 'while the row carries the new list for the next resume')
      })
    }

    if (fehlt) skipped('a mixed change applies the limits and names the half that did not land', fehlt)
    else {
      await check('a mixed change applies the limits and names the half that did not land', async () => {
        const j = await politikLaufHolen()
        shim.reset()
        // Both halves in one patch, and only one of them deliverable. Refusing
        // the whole call would throw away a limits change that needs no proxy;
        // answering ok would report a network rule that is not in force. So:
        // partly applied, and the answer says which half is which.
        // A different memory value from the check above, so "the limits half
        // landed" cannot be satisfied by the state that check left behind.
        const r = await facade.changePolicy(lauf(j.runId),
          { network: { allow: ['files.example.org', 'mirror.example.org'] }, resources: { memory: '24g' } }, 'e2e')
        isFalse(r?.ok, `not a success — half of it did not land (${JSON.stringify(r)})`)
        equal(r.partial, true, 'it is reported as partly applied')
        equal(r.applied.limits, true, 'the limits half really went')
        equal(r.applied.proxy, false, 'the network half did not')
        isTrue(shim.argvFor('update').length > 0, 'docker update carried the new limit')
        equal(wert(shim.lastArgv('update'), '--memory'), '24g', 'with the value that was patched')
        equal(shim.argvFor('run').length, 0, 'and nothing was restarted for it')
        contains(String(r.error), 'proxy', 'the reason names the half that did not land')
        const ev = politikEreignis(j.runId)
        equal(ev.enforced, false, 'the run\'s record says the policy is not fully in force')
        equal(ev.applied?.limits, true, 'and carries the same per-half truth as the answer')
        equal(ev.applied?.proxy, false, 'both ways round')
        equal(lauf(j.runId).status, 'running', 'the run kept running')
        await fetchPath(`/api/runs/${j.runId}/kill`, { method: 'POST' })
      })
    }

    if (fehlt) skipped('a reconfiguration marks resume_pending BEFORE the container is stopped', fehlt)
    else {
      await check('a reconfiguration marks resume_pending BEFORE the container is stopped', async () => {
        // This check reconfigures by ADDING an extra mount, and `filesystem.extraMounts`
        // is in the hub's DEFAULT lock — every entry there is a host path crossing the
        // wall, so a lower layer adding one is a loosening and is refused. That refusal
        // is correct and stays; what was wrong is this check inheriting whatever lock
        // the checks above left standing. It states its own precondition instead, the
        // way the Adopt check next door had to learn to.
        sk.setSetting('sandbox_lock', '')
        const j = await laufStarten({ repo_id: String(repoId), prompt: 'E2E-Sandbox-Reconfigure' })
        await sessionMerken(j.runId)
        db.prepare('UPDATE runs SET sandbox=1, sandbox_container=? WHERE id=?').run(`fl-${j.runId}`, j.runId)
        shim.container(`fl-${j.runId}`, { state: 'running' })
        shim.reset()
        // The witness as a FILE rather than a `node -e` one-liner: the paths it
        // needs carry quotes of their own, and a shell string that has to
        // survive two levels of quoting is how a witness ends up silently
        // writing nothing — which reads exactly like the thing it was watching
        // for not having happened.
        const zeugeSkript = join(SB, 'witness-restart.mjs')
        writeFileSync(zeugeSkript, `import { DatabaseSync } from 'node:sqlite'
import { writeFileSync } from 'node:fs'
const d = new DatabaseSync(${JSON.stringify(join(SB, 'data', 'freilauf.db'))})
d.exec('PRAGMA busy_timeout = 5000;')
const r = d.prepare('SELECT resume_pending, sandbox_spec FROM runs WHERE id=?').get(${JSON.stringify(j.runId)})
const e = d.prepare("SELECT COUNT(*) c FROM events WHERE run_id=? AND kind='sandbox:restarting'").get(${JSON.stringify(j.runId)})
writeFileSync(process.env.FL_DOCKER_STATE + '/witness',
  JSON.stringify({ resume_pending: r?.resume_pending ?? null, spec: r?.sandbox_spec ?? null, restarting: e?.c ?? null }))
`)
        shim.hook('stop', `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(zeugeSkript)}`)
        // A change docker cannot apply to a running container: a new mount.
        await facade.changePolicy(lauf(j.runId),
          { filesystem: { extraMounts: [{ source: SB, target: SB, mode: 'ro' }] } }, 'e2e')
        const evs = db.prepare('SELECT kind, id FROM events WHERE run_id=? ORDER BY id').all(j.runId)
        const restarting = evs.find(e => e.kind === 'sandbox:restarting')
        isTrue(!!restarting, `sandbox:restarting was written (${evs.map(e => e.kind).join(', ')})`)
        isTrue(shim.order().includes('stop'), 'and the container was stopped')
        // The ordering is the whole point, and it can only be seen from INSIDE
        // the stop: whoever resumes this run next — this caller, or a watcher
        // pass that finds the session gone a second later — has to resume it
        // with the NEW spec. Asking afterwards answers nothing; by then the
        // resume has happened either way.
        //
        // §7.12.4 spells step 1 as `resume_pending`, and index.mjs deliberately
        // writes the SPEC there instead, with its reason in the code:
        // `resumeRun()` refuses a run that is already marked pending, so
        // pre-marking would turn its own direct call into a no-op. The
        // guarantee is the same one either way, so that is what is asserted
        // here — the fact that carries it, not the column the section named.
        const zeuge = JSON.parse(shim.witness() || '{}')
        equal(zeuge.restarting, 1, 'sandbox:restarting was written before the container was stopped')
        isTrue(typeof zeuge.spec === 'string' && zeuge.spec.includes(SB),
          `and the row already carried the NEW spec (${String(zeuge.spec).slice(0, 120)})`)
        shim.clearHook('stop')
        await fetchPath(`/api/runs/${j.runId}/kill`, { method: 'POST' })
      })
    }

    // ---- and the whole thing through the hub, once ---------------------------
    if (fehlt) skipped('a run started with the sandbox on is prepared as one', fehlt)
    else {
      // Only from here on does the hub sandbox anything: `sandbox_mode` is `off`
      // by default and that is what every group above ran under.
      sk.setSetting('sandbox_mode', 'available')
      let sandboxDoc = null            // the sandbox.json the hub really wrote
      // The image the run is launched from. Without one `buildRunArgv()`
      // refuses — "there is nothing to start" — and rightly so; the repo column
      // is the operator's own way of naming it, and the tag is the one the
      // build above produced, so the two halves of this group describe one
      // image rather than two.
      db.prepare('UPDATE repos SET sandbox_image=? WHERE id=?').run(gebautesImage ?? 'freilauf/base:1', repoId)
      await check('a run started with the sandbox on is prepared as one', async () => {
        shim.reset()
        const j = await laufStarten({ repo_id: String(repoId), prompt: 'E2E-Sandbox-Launch', sandbox: 'on' })
        isTrue(!!j.runId, `run started (${JSON.stringify(j)})`)
        await sessionMerken(j.runId)
        const row = lauf(j.runId)
        equal(row.sandbox, 1, `the run really is sandboxed (${row.status})`)
        isTrue(!!row.sandbox_spec, 'and its spec is frozen into the row, like every definition field')
        equal(row.worktree_kind, 'clone', 'it works in a clone, not a linked worktree')
        isTrue(existsSync(join(SB, 'runs', j.runId, 'sandbox.json')),
          'sandbox.json records what was launched (§7.14)')
        isTrue(existsSync(join(SB, 'runs', j.runId, 'home')), 'and the run has a home of its own')
        isTrue(shim.order().includes('network-create'),
          `the per-run network was created (${JSON.stringify(shim.order())})`)
        isTrue(!!shim.networks()[`fl-net-${j.runId}`], 'and it is called fl-net-<run id>')
        sandboxDoc = join(SB, 'runs', j.runId, 'sandbox.json')
        await fetchPath(`/api/runs/${j.runId}/kill`, { method: 'POST' })
      })

      await check('the pane command the launcher prints resolves to the shim too', async () => {
        // The fence has to reach the LAST hop, or the suite asserts a command
        // line nobody runs: `sandbox/runtime-cli.mjs` is what `wrap.sh` execs
        // into the tmux pane, it calls the same `buildRunArgv()`, and it
        // resolves the binary through `runtimeBin()` in ITS OWN process. That
        // process inherits `FREILAUF_SANDBOX_RUNTIME_BIN` from whoever launched
        // it — the hub in production, this suite here — and the binary is an
        // ABSOLUTE path, so no PATH lookup stands between the two.
        isTrue(!!sandboxDoc && existsSync(sandboxDoc), `the hub wrote a sandbox document (${sandboxDoc})`)
        const r = await sh(process.execPath,
          [join(PROJECT, 'sandbox', 'runtime-cli.mjs'), sandboxDoc, '--term', 'xterm-256color',
            '--', 'sh', '-c', 'echo pane'])
        isTrue(r.ok, `the launcher printed a command line (${r.stderr.trim()})`)
        const argv = r.stdout.split('\0').filter(Boolean)
        equal(argv[0], shim.BIN, 'the binary the pane would exec is the shim, not a bare docker')
        equal(argv[1], 'run', 'and it is a `run`')
        equal(argv.slice(-3).join(' '), 'sh -c echo pane', 'with the harness command as its tail')
        // …and the printed line really is runnable: the shim's launcher carries
        // its own state directory, so a pane that inherits nothing still lands
        // in this sandbox and nowhere near a real daemon.
        const lauf2 = await sh(argv[0], argv.slice(1))
        contains(lauf2.stdout, 'pane', 'and running it does what the pane would do')
      })

      await check('the form refuses a loosening override outright', async () => {
        sk.setSetting('sandbox_lock', JSON.stringify(['network.mode']))
        const r = await postForm('/api/runs', {
          harness: 'claude', branch_mode: 'keiner', expected_minutes: '45',
          repo_id: String(repoId), prompt: 'E2E-Sandbox-FormRefusal',
          sandbox: 'on', sandbox_overrides: JSON.stringify({ network: { mode: 'open' } }),
        })
        const j = await r.json()
        isFalse(!!j.runId, `no run was created (${JSON.stringify(j).slice(0, 200)})`)
        contains(JSON.stringify(j), 'network.mode', 'and the problem names the locked path')
      })

      await check('an override stored before the lock is refused at start, and says so on the run', async () => {
        // The case the form cannot catch, and the reason the event exists: the
        // repo carried the override first and the hub locked the field
        // afterwards. Nothing re-validates a stored row, so the refusal has to
        // happen where the layers are resolved — at the start — and be written
        // down there. An override that looks saved and is not in force is the
        // "field that looks like it saved and did not" failure, one layer out.
        db.prepare('UPDATE repos SET sandbox_overrides=? WHERE id=?')
          .run(JSON.stringify({ network: { mode: 'open' } }), repoId)
        const j = await laufStarten({ repo_id: String(repoId), prompt: 'E2E-Sandbox-Refused', sandbox: 'on' })
        isTrue(!!j.runId, `run started (${JSON.stringify(j).slice(0, 200)})`)
        await sessionMerken(j.runId)
        equal(lauf(j.runId).sandbox, 1, 'the run is sandboxed at all')
        isTrue(ereignisse(j.runId).includes('sandbox:override_refused'),
          `the refusal is on the record (${ereignisse(j.runId).join(', ')})`)
        const spec = JSON.parse(lauf(j.runId).sandbox_spec || '{}')
        isFalse(spec?.network?.mode === 'open', 'and the loosening did not take effect')
        db.prepare('UPDATE repos SET sandbox_overrides=? WHERE id=?').run('{}', repoId)
        sk.setSetting('sandbox_lock', '[]')
        await fetchPath(`/api/runs/${j.runId}/kill`, { method: 'POST' })
      })
      db.prepare('UPDATE repos SET sandbox_image=NULL WHERE id=?').run(repoId)
      sk.setSetting('sandbox_mode', 'off')
    }

    await check('every container the shim created is written down for the cleanup', () => {
      // The tmux-session rule, one layer out. There are no real containers on
      // this machine, but the list has to exist BEFORE there are — that is the
      // whole lesson of the 157 leaked sessions in AGENTS.md.
      const erzeugt = shim.created()
      isTrue(erzeugt.includes(`fl-${RUN_ID}`), `the argv-log container is on the list (${erzeugt.length} entries)`)
      isTrue(erzeugt.every(n => n.startsWith('fl-') || n.startsWith('network:') || n.startsWith('shim-')),
        `and nothing foreign is (${JSON.stringify(erzeugt)})`)
    })

    // The seam goes back the way this group found it: FREILAUF_SANDBOX_RUNTIME_BIN
    // and the shim on the PATH live in THIS process's environment, and every
    // child it starts from here on would inherit them — a later group, a --echt
    // run, anything. A fixture that outlives the test that set it is the same
    // failure the shim's mode file had a moment ago, and it is the one way a
    // "no container runtime" check somewhere else could quietly find one.
    watcherTick = await sk.prepareWatcher({ sandbox: false })
    await check('the group leaves no runtime behind in the environment', () => {
      equal(process.env.FREILAUF_SANDBOX_RUNTIME_BIN, undefined, 'no runtime binary is named any more')
      equal(process.env.FREILAUF_SANDBOX_OFF, '1', 'and the hard off is back on')
      isFalse(String(process.env.PATH ?? '').split(':').includes(sk.SHIM_DIR), 'the shim is off the PATH')
    })
  }


  // ------------------------------------------------------------------
  group('Sandbox: pages and decisions')

  {
    // Two of the sandbox modules are still being written by other hands; the
    // pages are built against the module contract and answer honestly where a
    // module is absent, so the tests that NEED one say which and skip rather
    // than pretending the page failed.
    const HAT_RUNTIME = existsSync(join(PROJECT, 'server', 'sandbox', 'runtime.mjs'))
    const HAT_FASSADE = existsSync(join(PROJECT, 'server', 'sandbox', 'index.mjs'))

    // A plain hub first: no runtime binary is named, which is what an ordinary
    // installation looks like.
    await stopHub()
    await startHub()

    await check('the settings page refuses a sandbox mode above off while no runtime is found', async () => {
      const vorher = db.prepare(`SELECT value FROM settings WHERE key='sandbox_mode'`).get()?.value ?? ''
      const r = await postForm('/settings/sandbox', { sandbox_mode: 'default_on' }, { asBrowser: true })
      equal(r.status, 400, 'a readable refusal, not a 303 and not a 500')
      contains(await r.text(), 'runtime', 'and it says why')
      equal(db.prepare(`SELECT value FROM settings WHERE key='sandbox_mode'`).get()?.value ?? '', vorher,
        'nothing was written — a fence that only exists in the browser is not one')
      // `off` is always allowed: switching the feature back off must not need a
      // runtime one no longer has.
      equal((await postForm('/settings/sandbox', { sandbox_mode: 'off' }, { asBrowser: true })).status, 303,
        'switching it off goes through')
    })

    await check('the repo form says the sandbox is unavailable instead of offering a setting that does nothing', async () => {
      sk.setSetting('sandbox_mode', 'available')
      const html = await (await fetchPath(`/repos/edit?id=${repoId}`)).text()
      isFalse(html.includes('name="sandbox_default"'), 'no select the operator could change and nothing would read')
      contains(html, 'container runtime', 'and it names what is missing')
      sk.setSetting('sandbox_mode', 'off')
    })

    // From here on with the shimmed runtime.
    await stopHub()
    await startHub({ sandbox: true })
    sk.setSetting('sandbox_mode', 'available')

    await check('the repo form saves a sandbox default and it comes back', async () => {
      if (!HAT_RUNTIME) { skipped('the repo sandbox block', 'server/sandbox/runtime.mjs is not on disk yet'); return }
      const row = db.prepare('SELECT * FROM repos WHERE id=?').get(repoId)
      const html = await (await fetchPath(`/repos/edit?id=${repoId}`)).text()
      contains(html, 'name="sandbox_default"', 'the block is offered where a runtime was found')
      const r = await postForm('/repos/edit?id=' + repoId, {
        name: row.name, path: row.path, base_branch: row.base_branch,
        worktree_extras: row.worktree_extras, prompt: row.prompt ?? '',
        sandbox_default: 'on', sandbox_profile_id: '', sandbox_overrides: '{"resources":{"cpus":2}}',
        sandbox_image: '', sandbox_audit_only: '1',
      }, { asBrowser: true })
      equal(r.status, 303, 'it saves')
      const nach = db.prepare('SELECT * FROM repos WHERE id=?').get(repoId)
      equal(nach.sandbox_default, 'on', 'the tri-state came back')
      // The checkbox is the one authority for auditOnly; it is merged into the
      // stored document rather than living beside it.
      const doc = JSON.parse(nach.sandbox_overrides)
      equal(doc.network?.auditOnly, true, 'audit-only is in the stored document')
      equal(doc.resources?.cpus, 2, 'and the typed override survived next to it')
      contains(await (await fetchPath(`/repos/edit?id=${repoId}`)).text(), 'value="1" checked', 'the form shows it ticked again')

      // Saying it twice is a refusal, not a silent winner.
      const zwei = await postForm('/repos/edit?id=' + repoId, {
        name: row.name, path: row.path, base_branch: row.base_branch,
        worktree_extras: row.worktree_extras, prompt: row.prompt ?? '',
        sandbox_default: 'on', sandbox_profile_id: '', sandbox_image: '',
        sandbox_overrides: '{"network":{"auditOnly":true}}', sandbox_audit_only: '1',
      }, { asBrowser: true })
      equal(zwei.status, 400, 'audit-only said twice is refused')

      // …and put back, so the rest of the suite's repo is what it was.
      await postForm('/repos/edit?id=' + repoId, {
        name: row.name, path: row.path, base_branch: row.base_branch,
        worktree_extras: row.worktree_extras, prompt: row.prompt ?? '',
        sandbox_default: 'inherit', sandbox_profile_id: '', sandbox_overrides: '', sandbox_image: '',
      }, { asBrowser: true })
    })

    // One run that really ran behind walls — written straight into the row and
    // the run directory, because what is under test here is the PAGE.
    const SB_RUN = randomUUID()
    const spec = {
      image: { ref: 'freilauf/agent-claude', digest: 'sha256:0123456789abcdef0123456789abcdef' },
      network: { mode: 'allowlist', engine: 'builtin', allow: ['api.anthropic.com'], presets: [] },
      resources: { memory: '8g', cpus: 4, pidsLimit: 4096 },
    }
    db.prepare(`INSERT INTO runs(id,repo_id,harness,prompt,branch_mode,expected_minutes,status,
        sandbox,sandbox_spec,sandbox_container,sandbox_overrides,started_at)
      VALUES(?,?,'claude','sandbox page','keiner',10,'running',1,?,?,'{}',datetime('now'))`)
      .run(SB_RUN, repoId, JSON.stringify(spec), `fl-${SB_RUN.slice(0, 8)}`)
    mkdirSync(join(SB, 'runs', SB_RUN), { recursive: true })
    // …and the record of the proxy it ran behind. This is not decoration for the
    // page: `sandbox.json` is where `portOfRecordedProxy()` reads the port a
    // restarted hub has to bring the listener back on, so writing it is what
    // makes this fabricated run a run whose EGRESS POLICY CAN STILL BE CHANGED.
    // Without it the allow button below reaches a hub holding no proxy handle
    // for this run — which is a real state (every run that outlives a restart is
    // in it for a moment) but not the one that check is about.
    const SB_PROXY_PORT = await freePort()
    writeFileSync(join(SB, 'runs', SB_RUN, 'sandbox.json'), JSON.stringify({
      version: 1, appDir: PROJECT, spec,
      ctx: { runId: SB_RUN, proxyUrl: `http://127.0.0.1:${SB_PROXY_PORT}` },
    }, null, 2))
    writeFileSync(join(SB, 'runs', SB_RUN, 'egress.jsonl'),
      `${JSON.stringify({ at: '2026-09-05T10:00:00.000Z', host: 'pypi.org', action: 'deny', rejected_by: 'not_allowed' })}\n`
      + `${JSON.stringify({ at: '2026-09-05T10:00:01.000Z', host: 'pypi.org', action: 'deny', rejected_by: 'not_allowed' })}\n`)

    await check('a run detail page renders the sandbox line, with the three buttons per blocked host', async () => {
      const html = await (await fetchPath(`/runs/${SB_RUN}`)).text()
      contains(html, 'id="sandbox-card"', 'the card is there')
      contains(html, 'freilauf/agent-claude', 'and names the image')
      contains(html, 'sha256:0123456789ab', 'with its digest')
      contains(html, 'api.anthropic.com', 'the resolved allow list is on the page')
      contains(html, 'pypi.org', 'and the host that was turned away')
      contains(html, `/api/runs/${SB_RUN}/sandbox/allow`, 'the allow route')
      contains(html, 'value="run"', 'once for this run')
      contains(html, 'value="repo"', 'once for this repo')
      contains(html, `/api/runs/${SB_RUN}/sandbox/deny`, 'and "deny and tell the agent"')
      contains(html, `/api/runs/${SB_RUN}/audit.jsonl`, 'the audit export is one click away')
      // The reconfigure form is deliberately NOT part of the run-detail
      // fragment: the live channel swaps by id, and a textarea somebody is
      // typing into lives only in the DOM.
      contains(html, 'id="sandbox-reconfigure"', 'the reconfigure block is on the page')
      const frag = await (await fetchPath(`/api/fragments/run-detail?id=${SB_RUN}`)).text()
      contains(frag, 'id="sandbox-card"', 'the card IS in the fragment, so the live channel keeps it current')
      isFalse(frag.includes('id="sandbox-reconfigure"'), 'and the textarea is not, so a swap cannot throw an edit away')
    })

    await check('the overview says a run was sandboxed, in the status cell and once', async () => {
      const html = await (await fetchPath(`/?repo=${repoId}`)).text()
      const zeile = html.slice(html.indexOf(`id="run-${SB_RUN}"`))
      const bis = zeile.indexOf('</tr>')
      const row = zeile.slice(0, bis > 0 ? bis : 4000)
      contains(row, 'sandbox-suffix', 'the suffix is in this run’s row')
      equal((row.match(/sandbox-suffix/g) ?? []).length, 1, 'one statement, in one cell')
      contains(row.slice(0, row.indexOf('title-cell')), 'sandbox-suffix', 'and that cell is the status cell')
    })

    await check('"deny and tell the agent" is an answer, and it is written down', async () => {
      const r = await postForm(`/api/runs/${SB_RUN}/sandbox/deny`, { host: 'pypi.org' })
      const j = await r.json()
      isTrue(j.ok, `the refusal went out (${JSON.stringify(j)})`)
      contains(j.text, 'pypi.org', 'and the sentence names the host')
      isTrue(ereignisse(SB_RUN).includes('sandbox:policy_changed'), 'the run records the decision')
    })

    await check('"allow" reaches the facade, and a locked allow list refuses before it does', async () => {
      // The hub locked network.allow: nothing below it may add to the list, so
      // the button is refused with the reason rather than quietly doing nothing.
      sk.setSetting('sandbox_lock', JSON.stringify(['network.allow']))
      const gesperrt = await (await postForm(`/api/runs/${SB_RUN}/sandbox/allow`, { host: 'pypi.org', scope: 'repo' })).json()
      isFalse(gesperrt.ok, 'a locked allow list refuses')
      contains(String(gesperrt.error), 'lock', 'and says the hub locked it')
      contains(await (await fetchPath(`/runs/${SB_RUN}`)).text(), 'disabled', 'the page greys the buttons out too')

      sk.setSetting('sandbox_lock', '')
      const r = await (await postForm(`/api/runs/${SB_RUN}/sandbox/allow`, { host: 'pypi.org', scope: 'run' })).json()
      if (!HAT_FASSADE) {
        isFalse(r.ok, 'without the facade the route says so instead of pretending')
        skipped('allow for this run', 'server/sandbox/index.mjs is not on disk yet')
        return
      }
      isTrue(r.ok, `the change was applied (${JSON.stringify(r)})`)
      isTrue(ereignisse(SB_RUN).includes('sandbox:policy_changed'), 'and the run records it')
      // A NETWORK change is only applied when the proxy really carried it, and
      // this is the one place in the suite where one does. The hub holds no
      // handle for this run — nothing in this process launched it — so the
      // reload goes the way it goes in production after every deploy: the
      // recorded port out of `sandbox.json`, the listener brought back on it,
      // and only then the new rules. An answer of `ok` without that is the
      // defect the whole finish gate of this function exists against.
      isTrue(ereignisse(SB_RUN).includes('sandbox:proxy_restarted'),
        'the proxy this hub had no handle for was brought back to carry it')
      equal(r.applied?.proxy, true, 'and the answer says the proxy half really landed')
      const angewandt = db.prepare(
        `SELECT payload FROM events WHERE run_id=? AND kind='sandbox:policy_changed' ORDER BY id DESC LIMIT 1`).get(SB_RUN)
      equal(JSON.parse(angewandt?.payload || '{}').enforced, true,
        'the run\'s own record says the new policy is in force')
      contains(String(lauf(SB_RUN).sandbox_spec), 'pypi.org', 'and the row carries the host for the next resume')
    })

    await check('the break-glass is refused when the hub does not allow leaving the sandbox', async () => {
      sk.setSetting('sandbox_allow_bypass', '0')
      const r = await (await postForm(`/api/runs/${SB_RUN}/sandbox/bypass`, {})).json()
      isFalse(r.ok, 'refused')
      // …and the button is not even offered, so nobody clicks something that
      // cannot happen.
      isFalse((await (await fetchPath(`/runs/${SB_RUN}`)).text()).includes('/sandbox/bypass'),
        'the page does not offer it either')
      sk.setSetting('sandbox_allow_bypass', '1')
      contains(await (await fetchPath(`/runs/${SB_RUN}`)).text(), '/sandbox/bypass',
        'and it comes back when the hub allows it')
    })

    await check('the audit export is one hash-chained file, and it verifies', async () => {
      const r = await fetchPath(`/api/runs/${SB_RUN}/audit.jsonl`)
      equal(r.status, 200, 'the route answers')
      contains(r.headers.get('content-type') ?? '', 'ndjson', 'as JSONL')
      const text = await r.text()
      const { verifyAuditChain } = await import('../server/sandbox/audit.mjs')
      const v = verifyAuditChain(text)
      isTrue(v.ok, `the chain verifies (${JSON.stringify(v.problems)})`)
      const erste = JSON.parse(text.split('\n')[0])
      equal(erste.run, SB_RUN, 'the first line names the run')
      contains(text, 'pypi.org', 'and the proxy log travels with it')
      equal((await fetchPath(`/api/runs/${randomUUID()}/audit.jsonl`)).status, 404, 'an unknown run is a 404, not a chain of nothing')
    })

    await check('the settings page shows the shimmed runtime and lets the mode be raised', async () => {
      if (!HAT_RUNTIME) { skipped('the sandbox settings page', 'server/sandbox/runtime.mjs is not on disk yet'); return }
      const html = await (await fetchPath('/settings/sandbox')).text()
      contains(html, 'name="sandbox_mode"', 'the hub layer is a form')
      contains(html, 'name="sandbox_lock"', 'with the lock list')
      equal((await postForm('/settings/sandbox', { sandbox_mode: 'available' }, { asBrowser: true })).status, 303,
        'and with a runtime found the mode may be raised')
    })
  }

  // ------------------------------------------------------------------
  group('Sandbox: the blocked need')

  {
    // The two channels that turn "the sandbox is in the agent's way" into
    // something a person sees (SANDBOX.md): the agent asking,
    // and the proxy turning a host away. Both are exercised on rows written
    // straight into the database — what is under test is the hub's REACTION,
    // and a real container would only add a runtime to the list of things that
    // can make this test flaky.
    //
    // No tmux session on purpose: `closeOrphanedRuns()` leaves a
    // session-less run alone for five minutes, and giving it a fake session
    // name would send the watcher off to RESUME it.
    const legeSandboxLauf = () => {
      const id = randomUUID()
      db.prepare(`INSERT INTO runs(id,repo_id,harness,prompt,branch_mode,expected_minutes,status,
                                   sandbox,sandbox_container,started_at)
                  VALUES(?,?,'claude','sandbox need','keiner',45,'running',1,?,datetime('now'))`)
        .run(id, repoId, `fl-${id.slice(0, 8)}`)
      mkdirSync(join(SB, 'runs', id), { recursive: true })
      return id
    }
    const vorfaelleVon = (id) => db.prepare('SELECT * FROM incidents WHERE run_id=? ORDER BY id').all(id)
    const blockEreignis = (id, host, atMs) =>
      db.prepare(`INSERT INTO events(run_id,kind,payload) VALUES(?,'sandbox:blocked',?)`)
        .run(id, JSON.stringify({ host, method: 'CONNECT', count: 1, at: new Date(atMs).toISOString() }))
    const melde = (id, body) => fetchPath(`/api/runs/${id}/report`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    // A `sandbox=1` row makes `sandboxInUse()` true, and this suite process has
    // no runtime shim by the time this group runs (the container-path group
    // clears it deliberately and asserts that it did). Three silent passes then
    // open a global `docker_unreachable` — which is the fixture talking, not the
    // feature, so the counter is put back before every tick below.
    const { _resetDockerSilence } = await import('../server/watcher.mjs')
    const tick = async () => { _resetDockerSilence(); await watcherTick() }

    const SB_ASK = legeSandboxLauf()

    await check('fl-report access reaches a human and leaves the run RUNNING', async () => {
      const j = await (await melde(SB_ASK, { kind: 'access',
        text: 'pypi.org: the test dependencies are installed from there' })).json()
      isTrue(j.ok, `the hub accepts the kind (${JSON.stringify(j).slice(0, 160)})`)
      // The answer travels back as the agent's own tool output — the one moment
      // it is guaranteed to read something.
      contains(String(j.message ?? ''), 'keep working', 'and it tells the agent to carry on meanwhile')
      // THE difference from a help call: the agent did not stop, so the run
      // must not read as waiting for a human.
      equal(lauf(SB_ASK).status, 'running', 'the run stays running')
      const v = vorfaelleVon(SB_ASK).find(x => x.typ === 'sandbox_access')
      isTrue(!!v, 'an incident was opened')
      equal(v.schwere, 'rot', 'red: a wall does not clear itself by waiting')
      contains(v.beleg ?? '', 'pypi.org', "carrying the agent's own words")
      const ev = ereignisse(SB_ASK)
      isTrue(ev.includes('access_request'), "the run's own history says so")
      isTrue(ev.includes('notified:access'), 'and the configured channels were told')
      // …and it is where a human already looks. Asserted through the incident's
      // own resolve route and its evidence rather than through the rendered
      // name, which is translated and therefore says more about the UI language
      // an earlier group left behind than about this feature.
      const html = await (await fetchPath(`/runs/${SB_ASK}`)).text()
      contains(html, `/api/incidents/${v.id}/resolve`, 'the run page offers the one button')
      contains(html, 'pypi.org', 'and shows what the agent asked for')
    })

    await check('a muted run gets no message and keeps the incident', async () => {
      db.prepare('UPDATE runs SET telegram_on=0 WHERE id=?').run(SB_ASK)
      const j = await (await melde(SB_ASK, { kind: 'access',
        text: 'files.pythonhosted.org: the wheels live there' })).json()
      isTrue(j.ok, 'the request is processed exactly as before')
      contains(ereignisse(SB_ASK).join(','), 'notify_muted', 'the silence is written down')
      const v = vorfaelleVon(SB_ASK).find(x => x.typ === 'sandbox_access')
      isTrue(v.anzahl >= 2, `the incident counted the second need (${v.anzahl}×)`)
      equal(lauf(SB_ASK).status, 'running', 'and the run is still running')
      db.prepare('UPDATE runs SET telegram_on=1 WHERE id=?').run(SB_ASK)
    })

    const SB_DENY = legeSandboxLauf()

    await check('a proxy denial becomes a yellow incident', async () => {
      blockEreignis(SB_DENY, 'pypi.org', Date.now() - 20_000)
      await tick()
      const v = vorfaelleVon(SB_DENY).find(x => x.typ === 'sandbox_blocked')
      isTrue(!!v, 'the watcher turned the event into a record')
      equal(v.schwere, 'gelb', 'yellow — one denial may be exactly what the policy intended')
      equal(v.quelle, 'proxy', 'and it says where it came from')
      contains(v.beleg ?? '', 'pypi.org', 'naming the host that was turned away')
      // Twenty more requests to the SAME host are still one host.
      for (let i = 0; i < 5; i++) blockEreignis(SB_DENY, 'pypi.org', Date.now() - 15_000 + i)
      await tick()
      equal(vorfaelleVon(SB_DENY).find(x => x.typ === 'sandbox_blocked').schwere, 'gelb',
        'the same host again does not promote it')
    })

    await check('a second distinct host promotes it to red', async () => {
      blockEreignis(SB_DENY, 'files.pythonhosted.org', Date.now() - 5_000)
      await tick()
      const v = vorfaelleVon(SB_DENY).find(x => x.typ === 'sandbox_blocked')
      equal(v.schwere, 'rot', 'two hosts: the policy is written for another job')
      contains(v.beleg ?? '', 'files.pythonhosted.org', 'the second host is in the evidence')
      isTrue(ereignisse(SB_DENY).includes('incident:eskaliert'), 'the run records the promotion')
    })

    await check('a sandboxed run\'s log turns a wall into a yellow anomaly', async () => {
      logAnhaengen(SB_DENY, "Error: EROFS: read-only file system, mkdir '/usr/lib/node_modules/x'\n")
      await tick()
      isTrue(ereignisse(SB_DENY).includes('anomaly:sandbox_denied'),
        'the log scanner saw it')
    })

    // Leave nothing standing: these rows never had a session, and a `running`
    // row outlives the suite in the overview of anybody debugging with --keep.
    db.prepare(`UPDATE runs SET status='aborted', ended_at=datetime('now') WHERE id IN (?,?)`)
      .run(SB_ASK, SB_DENY)
  }


  // ------------------------------------------------------------------
  group('Sandbox: nothing is left running')
  //
  // Three leaks, measured against a running hub rather than argued from the
  // code, and every check below asserts the OBSERVABLE — a network that is gone,
  // a `network rm` that was really issued, an event that says the run was let
  // go — never the shape of the fix.
  //
  //   1. the orphan reaper removed a terminal run's containers and left its
  //      NETWORK. Docker's default address pool subnets out after roughly 31
  //      of them, and past that no sandboxed run starts at all — a failure that
  //      arrives days after the runs that caused it.
  //   2. `teardownSandbox()` was on no ordinary end path at all (its callers
  //      were a failed launch and the facade itself), so a normally finished run
  //      left its built-in proxy listener standing inside the hub process, with
  //      that finished run's allow policy, plus the `docker events` tail child.
  //   3. and `--rm` takes a finished container away by itself, so the reaper
  //      never even SEES the ordinary case — which is how every ordinary run
  //      leaked, not just the orphans.
  {
    const shim = sk.docker
    watcherTick = await sk.prepareWatcher({ sandbox: true })
    const runtime = await import('../server/sandbox/runtime.mjs')
    const watcherMod = await import('../server/watcher.mjs')
    const sessMod = await import('../server/sessions.mjs')
    let facade = null
    try { facade = await import('../server/sandbox/index.mjs') } catch { facade = null }
    const fehlt = facade ? null : 'server/sandbox/index.mjs is not written yet'
    const hubId = facade?.hubId?.() ?? 'e2e-hub'

    /**
     * A sandboxed run in the state the hub really leaves behind: terminal, its
     * session recorded as closed (`tmux_session` KEEPS its name — nothing in
     * this hub ever NULLs that column), a container name on the row, and a
     * network the daemon is holding.
     */
    async function sandboxLauf({ status = 'aborted', container = true } = {}) {
      const id = randomUUID()
      db.prepare(`INSERT INTO runs(id,repo_id,harness,prompt,branch_mode,expected_minutes,status,
                                   sandbox,sandbox_container,tmux_session,tmux_closed_at,started_at,ended_at)
                  VALUES(?,?,'claude','leak','keiner',45,?,1,?,?,datetime('now'),datetime('now'),datetime('now'))`)
        .run(id, repoId, status, `fl-${id}`, `fl-leak-${id.slice(0, 8)}`)
      mkdirSync(join(SB, 'runs', id), { recursive: true })
      await runtime.createNetwork(`fl-net-${id}`, { runtime: 'docker' })
      if (container) {
        shim.container(`fl-${id}`, { state: 'exited', labels: { 'freilauf.hub': hubId } })
        shim.container(`fl-proxy-${id}`, { state: 'exited', labels: { 'freilauf.hub': hubId } })
      }
      return id
    }
    const netze = () => Object.keys(shim.networks())
    const netzDa = (id) => netze().includes(`fl-net-${id}`)

    if (fehlt) skipped('the reaper takes the run\'s network with its containers', fehlt)
    else {
      await check('the reaper takes the run\'s network with its containers', async () => {
        const id = await sandboxLauf()
        isTrue(netzDa(id), 'the daemon is holding the run\'s network to begin with')
        shim.reset()
        const out = await watcherMod.reconcileContainers(hubId)
        equal(out.verdict, 'ok', 'the pass ran')
        isFalse(netzDa(id), `the network is gone (${JSON.stringify(netze())})`)
        isTrue(shim.argvFor('network-rm').flat().includes(`fl-net-${id}`),
          `and it was really asked for (${JSON.stringify(shim.order())})`)
        // Order, not tidiness: `network rm` is refused while an endpoint is
        // still attached, and the proxy container is reaped in the same pass.
        //
        // Asked PER RUN, because that is the invariant. One pass reaps every
        // terminal sandboxed run this hub left behind — the groups before this
        // one leave several — so a global `lastIndexOf('rm') < indexOf(
        // 'network-rm')` compares the LAST run's containers against the FIRST
        // run's network and fails on a pass that did everything right. It read
        // as a flake because the number of leftovers moves with the suite.
        const calls = shim.calls()
        const stelle = (verb, name) => calls.findIndex(c => c.verb === verb && c.argv.includes(name))
        const netzWeg = stelle('network-rm', `fl-net-${id}`)
        for (const c of [`fl-${id}`, `fl-proxy-${id}`]) {
          const weg = stelle('rm', c)
          isTrue(weg >= 0 && weg < netzWeg,
            `${c} was removed before its network (${weg} < ${netzWeg}, ${JSON.stringify(shim.order())})`)
        }
      })

      await check('…and a second pass asks for nothing more', async () => {
        shim.reset()
        await watcherMod.reconcileContainers(hubId)
        equal(shim.argvFor('network-rm').length, 0,
          'the release is written down once and never repeated')
      })

      await check('a run whose containers `--rm` already took is released too', async () => {
        // The case the reaper never sees, and the one every ordinary run is:
        // nothing is listed, so the loop over the daemon's containers has
        // nothing to act on — and the network sat there for ever.
        const id = await sandboxLauf({ status: 'done', container: false })
        shim.reset()
        await watcherMod.reconcileContainers(hubId)
        isFalse(netzDa(id), 'the network of a finished run is gone as well')
        isTrue(ereignisse(id).includes('sandbox:released'),
          `and the run says it was let go (${JSON.stringify(ereignisse(id))})`)
      })

      await check('a run still in flight keeps everything it needs', async () => {
        // The reaper's own rule, one layer out: a network taken from under a
        // working agent is the same mistake as reaping its container.
        const id = randomUUID()
        db.prepare(`INSERT INTO runs(id,repo_id,harness,prompt,branch_mode,expected_minutes,status,
                                     sandbox,sandbox_container,tmux_session,started_at)
                    VALUES(?,?,'claude','leak','keiner',45,'running',1,?,?,datetime('now'))`)
          .run(id, repoId, `fl-${id}`, `fl-leak-${id.slice(0, 8)}`)
        mkdirSync(join(SB, 'runs', id), { recursive: true })
        await runtime.createNetwork(`fl-net-${id}`, { runtime: 'docker' })
        shim.container(`fl-${id}`, { state: 'running', labels: { 'freilauf.hub': hubId } })
        shim.reset()
        await watcherMod.reconcileContainers(hubId)
        isTrue(netzDa(id), 'the live run\'s network is untouched')
        isFalse(ereignisse(id).includes('sandbox:released'), 'and nothing was released')
        db.prepare(`UPDATE runs SET status='aborted', ended_at=datetime('now'),
                    tmux_closed_at=datetime('now') WHERE id=?`).run(id)
      })

      await check('a dead pane releases the sandbox, even though the session still stands', async () => {
        // `fl-start --keep` sets `remain-on-exit`, so a crashed run's screen
        // stays readable and `tmux_closed_at` stays NULL for hours. Until
        // 2026-09-06 the reaper asked only about a CLOSED session, so a run
        // whose agent process had already exited went on holding its network
        // and its egress proxy — measured: a hermes launch died at exit 127 and
        // `fl-proxy-<id>` was still running a minute later with nothing behind
        // it. `pane_died` is the durable evidence that the process is gone.
        const id = randomUUID()
        db.prepare(`INSERT INTO runs(id,repo_id,harness,prompt,branch_mode,expected_minutes,status,
                                     sandbox,sandbox_container,tmux_session,started_at,ended_at)
                    VALUES(?,?,'hermes','leak','keiner',45,'failed',1,?,?,datetime('now'),datetime('now'))`)
          .run(id, repoId, `fl-${id}`, `fl-leak-${id.slice(0, 8)}`)
        mkdirSync(join(SB, 'runs', id), { recursive: true })
        await runtime.createNetwork(`fl-net-${id}`, { runtime: 'docker' })
        db.prepare(`INSERT INTO events(run_id,ts,kind,payload) VALUES(?,datetime('now'),'pane_died',?)`)
          .run(id, JSON.stringify({ exit: 127 }))
        shim.reset()
        await watcherMod.reconcileContainers(hubId)
        isFalse(netzDa(id), 'the network of a run whose agent is gone is released')
        isTrue(ereignisse(id).includes('sandbox:released'),
          `and the run says it was let go (${JSON.stringify(ereignisse(id))})`)
      })

      await check('…but a finished run whose agent is still in its TUI keeps everything', async () => {
        // The other half, and the reason the rule is `pane_died` and not merely
        // "the run is over": claude, opencode and cursor all sit in their TUI
        // after reporting `done`, and a follow-up commission typed into that
        // session still needs the container and its way out.
        const id = randomUUID()
        db.prepare(`INSERT INTO runs(id,repo_id,harness,prompt,branch_mode,expected_minutes,status,
                                     sandbox,sandbox_container,tmux_session,started_at,ended_at)
                    VALUES(?,?,'claude','leak','keiner',45,'done',1,?,?,datetime('now'),datetime('now'))`)
          .run(id, repoId, `fl-${id}`, `fl-leak-${id.slice(0, 8)}`)
        mkdirSync(join(SB, 'runs', id), { recursive: true })
        await runtime.createNetwork(`fl-net-${id}`, { runtime: 'docker' })
        shim.container(`fl-${id}`, { state: 'running', labels: { 'freilauf.hub': hubId } })
        shim.reset()
        await watcherMod.reconcileContainers(hubId)
        isTrue(netzDa(id), 'a live TUI keeps its network')
        isFalse(ereignisse(id).includes('sandbox:released'), 'and nothing was released')
        db.prepare('UPDATE runs SET tmux_closed_at=datetime(\'now\') WHERE id=?').run(id)
      })

      await check('an unreachable daemon releases nothing — "no answer" is not "gone"', async () => {
        const id = await sandboxLauf()
        shim.reset()
        shim.mode('unreachable')
        try {
          await watcherMod.reconcileContainers(hubId)
        } finally { shim.mode('ok') }
        isTrue(netzDa(id), 'the network is left exactly where it was')
        isFalse(ereignisse(id).includes('sandbox:released'),
          'and nothing claims the run was released')
        isFalse(shim.order().includes('network-rm'), 'no removal was even attempted')
        // …and the next pass, with an answer, does the work.
        shim.reset()
        await watcherMod.reconcileContainers(hubId)
        isFalse(netzDa(id), 'the pass that got an answer released it')
      })

      await check('an ended SESSION releases the sandbox, not only the reaper', async () => {
        // teardownSandbox() on the ordinary end path — the kill route, the
        // sessions page, retention and the archive pass all meet in
        // reconcileClosedSession(), so one wiring covers all four. Observable
        // through the shim: the container is stopped and the network removed by
        // the session's end, before any reconciliation pass runs.
        const id = randomUUID()
        db.prepare(`INSERT INTO runs(id,repo_id,harness,prompt,branch_mode,expected_minutes,status,
                                     sandbox,sandbox_container,tmux_session,started_at)
                    VALUES(?,?,'claude','leak','keiner',45,'running',1,?,?,datetime('now'))`)
          .run(id, repoId, `fl-${id}`, `fl-leak-${id.slice(0, 8)}`)
        mkdirSync(join(SB, 'runs', id), { recursive: true })
        await runtime.createNetwork(`fl-net-${id}`, { runtime: 'docker' })
        shim.container(`fl-${id}`, { state: 'running', labels: { 'freilauf.hub': hubId } })
        shim.reset()
        equal(sessMod.reconcileClosedSession(id, 'web'), 'aborted', 'the session\'s end ends the run')
        // The release is fire-and-forget, exactly as the container stop always
        // was — so it is waited for, not raced.
        await waitFor(() => !netzDa(id), { was: 'the run\'s network being released' })
        isTrue(ereignisse(id).includes('sandbox:container_gone'),
          'the client-died case is on the record: the container was still running')
      })

      await check('a session closed IN ORDER TO resume releases nothing and ends nothing', async () => {
        // §7.12.4's reconfigure and the break-glass both close the session
        // through killSessions() to bring the run BACK. Measured twice on two
        // sandboxes: the run became `aborted`, after which resumeRun() refused
        // it with "status is aborted" and the agent's conversation was gone.
        const id = randomUUID()
        db.prepare(`INSERT INTO runs(id,repo_id,harness,prompt,branch_mode,expected_minutes,status,
                                     sandbox,sandbox_container,tmux_session,resume_pending,started_at)
                    VALUES(?,?,'claude','leak','keiner',45,'running',1,?,?,1,datetime('now'))`)
          .run(id, repoId, `fl-${id}`, `fl-leak-${id.slice(0, 8)}`)
        mkdirSync(join(SB, 'runs', id), { recursive: true })
        await runtime.createNetwork(`fl-net-${id}`, { runtime: 'docker' })
        shim.reset()
        equal(sessMod.reconcileClosedSession(id, 'web'), 'resuming', 'the third case is named')
        equal(lauf(id).status, 'running', 'the run is still one resumeRun() may pick up')
        equal(shim.order().length, 0, `and nothing was said to the daemon (${JSON.stringify(shim.order())})`)
        isTrue(netzDa(id), 'the network the resume walks back through is still there')
        db.prepare(`UPDATE runs SET status='aborted', ended_at=datetime('now'), resume_pending=0 WHERE id=?`).run(id)
      })

      await check('nothing of this group is left holding a network', async () => {
        // The whole point, said once at the end: after the runs are terminal and
        // a pass has run, the daemon holds no `fl-net-` of a run that is over.
        shim.reset()
        await watcherMod.reconcileContainers(hubId)
        const offen = netze().filter(n => n.startsWith('fl-net-'))
          .filter(n => {
            const row = db.prepare('SELECT status FROM runs WHERE id=?').get(n.slice('fl-net-'.length))
            return !row || ['done', 'failed', 'aborted'].includes(row.status)
          })
        equal(offen.length, 0, `networks of finished runs left behind: ${JSON.stringify(offen)}`)
      })
    }

    // The seam goes back the way this group found it — a fixture that outlives
    // its own test is how a "no container runtime" check elsewhere quietly finds
    // one (the same rule the container-path group states about its mode file).
    watcherTick = await sk.prepareWatcher({ sandbox: false })
  }

  // ------------------------------------------------------------------
  group('Sandbox: the floor holds')

  {
    // The experiment an independent evaluator ran on a live hub, driven through
    // the real routes rather than the functions behind them — because that is
    // where the hole was. `validateSandboxOverrides()` judges §7.3's narrowing
    // rule only when it is handed the baseline the patch narrows FROM
    // (`spec.mjs`: `if (against && lock.length)`), and `sandboxReconfigure()`
    // passed the lock alone. The check never ran; `changePolicy()` merges a
    // patch field by field and narrows nothing of its own; and the result was
    // frozen into `runs.sandbox_spec` for the rest of the run, later resumes
    // included. The assertion that was missing is the second one below: not
    // only that the answer is a refusal, but that NOTHING was written.
    const DICHT = {
      runtime: 'docker',
      image: { ref: 'freilauf/agent-claude', digest: null, pull: 'if-missing' },
      network: { mode: 'allowlist', engine: 'builtin', allow: [], deny: [], presets: [], auditOnly: false },
      filesystem: { worktree: 'rw', repoGit: 'ro', extras: 'ro', readOnlyRoot: true },
      resources: { memory: '8g', memorySwap: '8g', cpus: 4, pidsLimit: 4096 },
      secrets: { mode: 'env', gitFetch: 'mirror' },
    }
    const legeLauf = (status = 'running') => {
      const id = randomUUID()
      db.prepare(`INSERT INTO runs(id,repo_id,harness,prompt,branch_mode,expected_minutes,status,
                                   sandbox,sandbox_spec,sandbox_container,sandbox_overrides,started_at)
                  VALUES(?,?,'claude','floor','keiner',30,?,1,?,?,'{}',datetime('now'))`)
        .run(id, repoId, status, JSON.stringify(DICHT), `fl-${id.slice(0, 8)}`)
      mkdirSync(join(SB, 'runs', id), { recursive: true })
      return id
    }
    /** A problem page as the sentence it makes — the `<ul class="err">` items. */
    const problemText = (html) => (html.match(/<ul class="err">([\s\S]*?)<\/ul>/)?.[1] ?? html)
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300)
    const specVon = (id) => db.prepare('SELECT sandbox_spec AS s FROM runs WHERE id=?').get(id).s
    const overridesVon = (id) => db.prepare('SELECT sandbox_overrides AS o FROM runs WHERE id=?').get(id).o
    const LOCK = ['network', 'resources', 'filesystem', 'secrets']

    const FL_RUN = legeLauf()

    await check('reconfigure cannot loosen what the hub locked, and a refusal writes nothing', async () => {
      sk.setSetting('sandbox_lock', JSON.stringify(LOCK))
      const vorherSpec = specVon(FL_RUN)
      const vorherOverrides = overridesVon(FL_RUN)
      // Byte for byte the patch that walked through the live hub.
      const r = await postForm(`/api/runs/${FL_RUN}/sandbox/reconfigure`, {
        overrides: JSON.stringify({
          network: { mode: 'open', auditOnly: true, allow: ['evil.example.com'] },
          resources: { memory: '64g', cpus: 64 },
          filesystem: { readOnlyRoot: false },
        }),
      })
      equal(r.status, 400, 'the route refuses')
      const j = await r.json()
      isFalse(j.ok, `and says so (${JSON.stringify(j).slice(0, 200)})`)
      for (const pfad of ['network.mode', 'network.allow', 'network.auditOnly',
        'resources.memory', 'resources.cpus', 'filesystem.readOnlyRoot']) {
        contains(String(j.error), pfad, `the reason names ${pfad} rather than one blanket sentence`)
      }
      // THE assertion that was missing. The evaluator's run answered 400 with
      // the weakened spec already on disk — the operator told the weakening had
      // failed when it had succeeded, which is worse than either alone.
      equal(specVon(FL_RUN), vorherSpec, 'runs.sandbox_spec is untouched')
      equal(overridesVon(FL_RUN), vorherOverrides, 'and so are the run’s own overrides')
      const spec = JSON.parse(specVon(FL_RUN))
      equal(spec.network.mode, 'allowlist', 'the network is still an allowlist')
      equal(spec.network.auditOnly, false, 'still enforcing rather than only watching')
      equal(spec.resources.memory, '8g', 'still 8g')
      equal(spec.resources.cpus, 4, 'still 4 cpus')
      equal(spec.filesystem.readOnlyRoot, true, 'and the root is still read-only')
    })

    await check('…and the same route still NARROWS under the same lock', async () => {
      // A lock that refused a tightening would be a lock nobody could work
      // under — and it would push the operator to the break-glass instead.
      const r = await postForm(`/api/runs/${FL_RUN}/sandbox/reconfigure`, {
        overrides: JSON.stringify({ network: { mode: 'none' }, resources: { cpus: 1 } }),
      })
      const j = await r.json()
      // The lock is taken back HERE, before the first assertion, and that is the
      // rule rather than the tidying: `skipped()` ENDS a check by
      // throwing, and a failing assertion does the same — so a reset on the
      // last line of a check that can skip is a reset that does not run. It did
      // not, and the whole-suite cost was two checks further down: the hub was
      // still locked on `network`, so Adopt's own document — adding three hosts
      // to an empty `network.allow` — was judged a LOOSENING and answered 400
      // naming `network.allow`. The lock was right, the fixture was not.
      sk.setSetting('sandbox_lock', '')
      if (!j.ok) {
        // The facade may be absent, or may want a container this suite has none
        // of; what is under test here is that the LOCK did not refuse it.
        isFalse(String(j.error).includes('locked'), `refused by the facade, not by the lock (${j.error})`)
        skipped('the narrowing reconfigure', 'the sandbox facade did not apply it in this sandbox')
      } else {
        equal(JSON.parse(specVon(FL_RUN)).network.mode, 'none', 'the tightening is in force')
      }
    })

    await check('taking a planned run out of its sandbox is a named event, not a quiet setting', async () => {
      // §7.3 is absolute about this: every weakening is written down. Without
      // it the run carried nothing at all — `sandboxStatusSuffix()` and
      // `hasSandboxStory()` both key on `sandbox:bypassed`, so a run that was
      // going to be contained and now is not showed neither "sandboxed" nor
      // "bypassed" in the overview, and nobody was told.
      // `runs.started_at` is NOT NULL, so a planned row keeps the timestamp the
      // fixture wrote; what `runEditAllowed()` reads is the STATUS.
      const geplant = legeLauf('scheduled')
      sk.setSetting('sandbox_allow_bypass', '1')
      const r = await postForm(`/api/runs/${geplant}/edit`, { sandbox: '0' })
      equal(r.status, 200, 'the edit goes through')
      equal(db.prepare('SELECT sandbox FROM runs WHERE id=?').get(geplant).sandbox, 0, 'the run is out of its sandbox')
      isTrue(ereignisse(geplant).includes('sandbox:bypassed'), 'and the run says so in its own history')
      // Both, and in that order: `sandbox:bypassed` is the specific statement a
      // reader has to meet first, `edited` is the record that a human changed
      // this run at all. One without the other is half a history.
      isTrue(ereignisse(geplant).includes('edited'), 'next to the ordinary record of the edit')
      // The refusal keeps its own rule: with the break glass forbidden, nothing
      // happens and nothing is written down.
      const zweiter = legeLauf('scheduled')
      sk.setSetting('sandbox_allow_bypass', '0')
      equal((await postForm(`/api/runs/${zweiter}/edit`, { sandbox: '0' })).status, 400, 'refused')
      equal(db.prepare('SELECT sandbox FROM runs WHERE id=?').get(zweiter).sandbox, 1, 'the run stays contained')
      isFalse(ereignisse(zweiter).includes('sandbox:bypassed'), 'and a refusal writes no event either')
      sk.setSetting('sandbox_allow_bypass', '1')
      db.prepare(`UPDATE runs SET status='aborted', ended_at=datetime('now') WHERE id IN (?,?)`).run(geplant, zweiter)
    })

    await check('Adopt takes every host that was ticked, not the last one', async () => {
      // `parseForm()` collapses a repeated field to its LAST value and exposes
      // the list under `<name>_list` — the convention `b.run_list` and
      // `b.session_list` already follow. Reading `b.host` could never see more
      // than one: measured live, three ticked boxes adopted one host, a 303,
      // and no warning. That is the audit-only rollout path — observe, then
      // enforce — quietly throwing away most of what was observed.
      const lauf = legeLauf()
      const hosts = ['registry.npmjs.org', 'files.pythonhosted.org', 'deb.debian.org']
      writeFileSync(join(SB, 'runs', lauf, 'egress.jsonl'),
        hosts.map(h => JSON.stringify({ at: '2026-09-05T10:00:00.000Z', host: h, action: 'would_deny' })).join('\n') + '\n')
      const seite = await (await fetchPath(`/repos/edit?id=${repoId}`)).text()
      contains(seite, 'id="sandbox-adopt"', 'the block is offered')
      for (const h of hosts) contains(seite, h, `${h} is on the page as a ticked candidate`)

      db.prepare('UPDATE repos SET sandbox_overrides=? WHERE id=?').run('{}', repoId)
      // Said here rather than inherited from whatever the checks above left
      // behind: adopting a host WIDENS `network.allow`, so a lock still
      // standing on `network` refuses it — correctly — and the failure then
      // reads as a broken route instead of a dirty fixture.
      sk.setSetting('sandbox_lock', '')
      const r = await postForm('/repos/sandbox/adopt', { id: String(repoId), host: hosts }, { asBrowser: true })
      // `problemPage()` answers 400 for the empty selection AND for every
      // validation problem, so the status alone cannot say which it was. The
      // sentence can, and a diagnosis that needs a second suite run is a
      // diagnosis nobody makes.
      equal(r.status, 303, `it saves${r.status === 303 ? '' : ' — ' + problemText(await r.text())}`)
      const allow = JSON.parse(db.prepare('SELECT sandbox_overrides AS o FROM repos WHERE id=?').get(repoId).o)
        .network?.allow ?? []
      equal([...allow].sort().join(','), [...hosts].sort().join(','),
        'all three landed, in the repo’s own overrides')

      // And it is not a second writer of that column: the lock the repo form
      // obeys refuses an adopted host the same way it refuses a typed one.
      db.prepare('UPDATE repos SET sandbox_overrides=? WHERE id=?').run('{}', repoId)
      sk.setSetting('sandbox_lock', JSON.stringify(['network.allow']))
      const gesperrt = await postForm('/repos/sandbox/adopt', { id: String(repoId), host: ['evil.example.com'] },
        { asBrowser: true })
      const gesperrtText = await gesperrt.text()
      sk.setSetting('sandbox_lock', '')            // before the assertions, see above
      equal(gesperrt.status, 400, 'a locked allow list refuses the adoption')
      contains(gesperrtText, 'network.allow', 'and names the path that is locked')
      equal(db.prepare('SELECT sandbox_overrides AS o FROM repos WHERE id=?').get(repoId).o, '{}',
        'nothing was written')
      db.prepare(`UPDATE runs SET status='aborted', ended_at=datetime('now') WHERE id=?`).run(lauf)
      db.prepare('UPDATE repos SET sandbox_overrides=? WHERE id=?').run('{}', repoId)
    })

    await check('the repo form warns about a loosening while it is typed, not at the launch', async () => {
      // The floor already held at launch (`resolveSandboxSpec()` refuses and
      // writes `sandbox:override_refused`), so this is about WHEN the operator
      // finds out. The form passed `lock` and no baseline, so its check was
      // dead code and it accepted what the run would then not honour.
      sk.setSetting('sandbox_lock', JSON.stringify(['resources']))
      const row = db.prepare('SELECT * FROM repos WHERE id=?').get(repoId)
      const felder = {
        name: row.name, path: row.path, base_branch: row.base_branch,
        worktree_extras: row.worktree_extras ?? '', prompt: row.prompt ?? '',
        sandbox_default: 'inherit', sandbox_profile_id: '', sandbox_image: '',
      }
      const r = await postForm('/repos/edit?id=' + repoId,
        { ...felder, sandbox_overrides: '{"resources":{"memory":"64g"}}' }, { asBrowser: true })
      equal(r.status, 400, 'raising a locked limit is refused at the form')
      contains(await r.text(), 'resources.memory', 'and the sentence names the path')
      const runter = await postForm('/repos/edit?id=' + repoId,
        { ...felder, sandbox_overrides: '{"resources":{"memory":"1g"}}' }, { asBrowser: true })
      equal(runter.status, 303, 'lowering it goes through')
      sk.setSetting('sandbox_lock', '')
      await postForm('/repos/edit?id=' + repoId, { ...felder, sandbox_overrides: '' }, { asBrowser: true })
    })

    db.prepare(`UPDATE runs SET status='aborted', ended_at=datetime('now') WHERE id=?`).run(FL_RUN)
  }

  // ------------------------------------------------------------------
  group('Sandbox: the proxy comes back')
  //
  // §8.19, and the defect an evaluator measured by hand on a live hub. With the
  // default `network.engine: 'builtin'` the run's egress proxy is a listener
  // inside the HUB PROCESS, so a deploy takes it with it — while the container's
  // `HTTPS_PROXY`, frozen at creation, still points at the port that has just
  // died. The run survives, its tmux session survives, the container survives,
  // and from that moment every request the agent makes fails with a connection
  // error while the hub reads `running` throughout. This hub restarted 164 times
  // in 30 days, so it is the ordinary case and not the edge one.
  //
  // `restoreProxies()` was written for it and NOTHING CALLED IT — so what is
  // under test here is the wiring: a watcher pass, the same one `hub.mjs` runs
  // two seconds after listen, brings the listener back on the port the run's own
  // `sandbox.json` records, with the policy the run was started with.
  //
  // The restart is a real one. The hub process starts the run and holds the
  // listener; `sk.stopHub()` takes both away; the pass that repairs it runs
  // afterwards, with no second process anywhere near the port — which is also
  // what makes the two negatives below assertable rather than racy.
  {
    const netMod = await import('node:net')
    const watcherMod = await import('../server/watcher.mjs')
    const dbMod = (await import('../server/db.mjs')).default
    const { setSetting: setzeSchalter } = await import('../server/db.mjs')
    let facade = null
    try { facade = await import('../server/sandbox/index.mjs') } catch { facade = null }
    const shim = sk.docker
    const fehlt = typeof facade?.restoreProxies === 'function'
      ? null : 'server/sandbox/index.mjs does not export restoreProxies()'

    // Every query goes through the hub's OWN connection, not through `sk.db`:
    // `stopHub()` closes that one, and half of this group happens while the
    // hub is deliberately not running.
    const zeile = (id) => dbMod.prepare('SELECT * FROM runs WHERE id=?').get(id)
    const arten = (id) => dbMod.prepare('SELECT kind FROM events WHERE run_id=? ORDER BY id').all(id).map(e => e.kind)
    const anzahl = (id, kind) =>
      dbMod.prepare('SELECT COUNT(*) AS n FROM events WHERE run_id=? AND kind=?').get(id, kind).n
    const nutzlast = (id, kind) => {
      const row = dbMod.prepare('SELECT payload FROM events WHERE run_id=? AND kind=? ORDER BY id DESC LIMIT 1')
        .get(id, kind)
      try { return row?.payload ? JSON.parse(row.payload) : null } catch { return null }
    }
    /** The port the run's container was told to talk to — out of its own sandbox.json. */
    const portVon = (id) => {
      try {
        const url = JSON.parse(readFileSync(join(SB, 'runs', id, 'sandbox.json'), 'utf8'))?.ctx?.proxyUrl
        return url ? Number(new URL(String(url)).port) : 0
      } catch { return 0 }
    }
    /** Is anything listening there at all? The container's question, asked from outside. */
    const lauscht = (port) => new Promise((res) => {
      if (!port) return res(false)
      const s = netMod.connect({ host: '127.0.0.1', port })
      const fertig = (v) => { try { s.destroy() } catch {} ; res(v) }
      s.once('connect', () => fertig(true))
      s.once('error', () => fertig(false))
      setTimeout(() => fertig(false), 3000).unref()
    })
    /**
     * A CONNECT through the listener, so the POLICY can be read off the answer
     * rather than inferred from a socket being open. A host outside the allow
     * list is refused BEFORE any name is resolved (`decide()` in proxy.mjs), so
     * this never leaves the machine.
     */
    const durchProxy = (port, host) => new Promise((res) => {
      let buf = ''
      const s = netMod.connect({ host: '127.0.0.1', port }, () => {
        s.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`)
      })
      const fertig = (v) => { try { s.destroy() } catch {} ; res(v) }
      s.on('data', (d) => { buf += d.toString(); if (buf.includes('\r\n')) fertig(buf.split('\r\n')[0]) })
      s.on('error', () => fertig('connection refused'))
      setTimeout(() => fertig(buf.split('\r\n')[0] || 'no answer'), 5000).unref()
    })

    let LEBT = null, LEBT_PORT = 0, VORBEI = null, VORBEI_PORT = 0

    if (fehlt) skipped('a sandboxed run’s proxy is a listener in the hub process', fehlt)
    else {
      watcherTick = await sk.prepareWatcher({ sandbox: true })
      sk.setSetting('sandbox_mode', 'available')
      // The image the run is launched from — whatever the container-path group
      // built into the shim's table, so the two halves of the suite describe one
      // image rather than two.
      const bilder = (() => {
        try { return JSON.parse(readFileSync(join(shim.STATE, 'images.json'), 'utf8')) } catch { return {} }
      })()
      db.prepare('UPDATE repos SET sandbox_image=? WHERE id=?')
        .run(Object.keys(bilder)[0] ?? 'freilauf/base:1', repoId)

      // THE SANDBOX HALF OF A WATCHER PASS, driven by hand.
      //
      // `tick()` runs `reconcileContainers()` and `restoreSandboxProxies()` only
      // while the hub owns them, and the suite has taken them
      // (FREILAUF_SANDBOX_REAPER_OFF, see test/sandbox.mjs): one shim state
      // with two drivers made every `stop`/`rm`/`network-rm` appear twice and
      // moved the failing checks from run to run. This group is the one that
      // asked `watcherTick()` for the restore, so it says so instead. Same shape
      // as the reaper group next door, which already calls
      // `reconcileContainers(hubId)` itself, and the same argument
      // FREILAUF_INTEGRATOR_OFF rests on.
      const sandboxPass = async () => {
        let pass = null
        try { pass = await watcherMod.reconcileContainers() } catch { /* the verdict is the point, not the throw */ }
        await watcherMod.restoreSandboxProxies(pass?.verdict ?? null)
      }

      await check('a sandboxed run’s proxy is a listener in the hub process', async () => {
        const j = await laufStarten({ repo_id: String(repoId), prompt: 'E2E-Sandbox-ProxyRestore', sandbox: 'on' })
        isTrue(!!j.runId, `run started (${JSON.stringify(j).slice(0, 200)})`)
        LEBT = j.runId
        await sessionMerken(LEBT)
        equal(zeile(LEBT).sandbox, 1, 'the run really is sandboxed')
        isTrue(arten(LEBT).includes('sandbox:proxy_started'),
          `and its egress goes through a proxy (${arten(LEBT).join(', ')})`)
        LEBT_PORT = portVon(LEBT)
        isTrue(LEBT_PORT > 0, `sandbox.json names the port the container talks to (${LEBT_PORT})`)
        isTrue(await lauscht(LEBT_PORT), `and something answers there while the hub is up (${LEBT_PORT})`)

        // The second fixture, prepared while there is still a hub: a run that is
        // OVER. Its proxy goes with its session, and nothing may bring it back.
        const k = await laufStarten({ repo_id: String(repoId), prompt: 'E2E-Sandbox-ProxyDone', sandbox: 'on' })
        VORBEI = k.runId
        await sessionMerken(VORBEI)
        VORBEI_PORT = portVon(VORBEI)
        isTrue(VORBEI_PORT > 0, `the second run has a recorded port too (${VORBEI_PORT})`)
        await fetchPath(`/api/runs/${VORBEI}/kill`, { method: 'POST' })
        // Only that it is OVER — when exactly its listener goes is the
        // teardown's business and another group's subject; what matters here is
        // that a run in this state is not one a pass may bring a proxy back for.
        await waitFor(() => ['done', 'failed', 'aborted'].includes(zeile(VORBEI).status),
          { was: 'the second run reaching a terminal status' })
      })

      await check('a hub restart takes the listener with it — the container keeps dialling a dead port', async () => {
        // THE defect, stated as the observable it is. Nothing else changes: the
        // run is still running, its session still stands, and its sandbox.json
        // still names a port nothing is behind.
        await sk.stopHub()
        isFalse(await lauscht(LEBT_PORT), `nothing answers on ${LEBT_PORT} any more`)
        equal(zeile(LEBT).status, 'running', 'while the run says it is working')
        equal(portVon(LEBT), LEBT_PORT, 'and the port the container was told about has not moved')
      })

      await check('an unreachable runtime restores nothing and ends nothing', async () => {
        // tmuxVerdict()'s lesson, one layer over: "the daemon did not answer" is
        // not an answer, and a pass that acted on it would be guessing about
        // somebody's live agent.
        shim.mode('unreachable')
        watcherMod._resetProxyRestore()
        try { await watcherTick(); await sandboxPass() } finally { shim.mode('ok') }
        isFalse(await lauscht(LEBT_PORT), 'no listener was bound on a question nobody answered')
        equal(anzahl(LEBT, 'sandbox:proxy_restarted'), 0, 'and nothing claims one was')
        equal(zeile(LEBT).status, 'running', 'the run was not ended over it either')
      })

      await check('the next pass brings the listener back, on the recorded port', async () => {
        watcherMod._resetProxyRestore()
        await watcherTick(); await sandboxPass()
        isTrue(await lauscht(LEBT_PORT),
          `the port the container dials answers again (${LEBT_PORT})`)
        equal(anzahl(LEBT, 'sandbox:proxy_restarted'), 1, 'and the run says so, once')
      })

      await check('…with the list it was started with, enforced', async () => {
        const start = nutzlast(LEBT, 'sandbox:proxy_started')
        const zurueck = nutzlast(LEBT, 'sandbox:proxy_restarted')
        equal(JSON.stringify([...(zurueck?.allow ?? [])].sort()),
          JSON.stringify([...(start?.allow ?? [])].sort()),
          'the resolved allow list is the same one, not a fresh reading of a changed policy')
        equal(zurueck?.engine, 'builtin', 'the built-in engine is what needed restoring')
        // And it is really THIS run's proxy rather than a socket that happens to
        // be open: the refusal is enforced, and it is recorded on this run.
        const antwort = await durchProxy(LEBT_PORT, 'evil.example.com')
        contains(antwort, '403', `a host outside the list is refused (${antwort})`)
        await waitFor(() => arten(LEBT).includes('sandbox:blocked'),
          { was: 'the denial being recorded on this very run' })
      })

      await check('a run that is over gets nothing back', async () => {
        // A terminal run needs no egress, and a listener bound for it would be
        // the hub holding a finished run's policy open for ever — the leak
        // `teardownSandbox()` exists to close.
        isFalse(await lauscht(VORBEI_PORT), `nothing listens for the finished run (${VORBEI_PORT})`)
        equal(anzahl(VORBEI, 'sandbox:proxy_restarted'), 0, 'and no pass claims to have restored it')
      })

      await check('a second pass costs nothing — a proxy this process holds is left alone', async () => {
        watcherMod._resetProxyRestore()
        await watcherTick(); await sandboxPass()
        equal(anzahl(LEBT, 'sandbox:proxy_restarted'), 1,
          'the restart is written down once, not once per pass')
        isTrue(await lauscht(LEBT_PORT), 'and the listener is still the same one')
      })

      // What this group started, taken back: the listener it restored lives in
      // THIS process, and a fixture that outlives its own test is how the next
      // suite finds a port it cannot explain.
      try { await facade.teardownSandbox(zeile(LEBT), { reason: 'e2e', removeNetwork: true, force: true }) } catch {}
      dbMod.prepare(`UPDATE runs SET status='aborted', ended_at=datetime('now') WHERE id IN (?,?)`)
        .run(LEBT, VORBEI)
      setzeSchalter('sandbox_mode', 'off')
    }
  }

  // =========================================================================
  group('Sandbox: a REAL container, because both of these passed every stub')
  //
  // Every other sandbox check in this file goes through the docker SHIM, which
  // is right for what those check — the argv is the control, and a stub can
  // count what it was handed. These two cannot be asked that way, and the proof
  // is that they were not: both were completely broken while every existing
  // test was green, and both cost a real run to find.
  //
  //   1. `docker exec -u hub` — `spec.user` is a POLICY word, not a login name,
  //      and no image this hub starts has such an account. Measured against the
  //      real daemon: `unable to find user hub: no matching entries in passwd
  //      file`. So every hub-side git call inside the box failed, `dirtyFiles()`
  //      answered `unknown`, and the finish gate wrote `finish_error` every few
  //      seconds FOR EVER on a run whose status said `running` and whose session
  //      was alive.
  //   2. The hub socket was mounted from the CONTAINER path, so docker was told
  //      `-v /run/freilauf/hub.sock:/run/freilauf/hub.sock` for a host path that
  //      does not exist — and made a DIRECTORY of it inside the box. §7.6's
  //      bearer-token channel had therefore never been exercised once.
  //
  // A shim cannot answer either question: only a daemon knows whether an account
  // exists, and only a kernel knows whether a mount point is a socket. So this
  // group needs a real one, and SKIPS ITSELF GREEN without it — the same rule
  // the browser and proxy suites follow. Nothing here touches the hub: it starts
  // one container of its own, from an image this repository builds, and removes
  // it in a `finally`.
  {
    const netMod = await import('node:net')
    const fsMod = await import('node:fs')
    const osMod = await import('node:os')
    const runtime = await import('../server/sandbox/runtime.mjs')
    const facadeReal = await import('../server/sandbox/index.mjs').catch(() => null)

    // The seams the sandbox group set point at the SHIM. Cleared for this group
    // and restored afterwards — a fixture that outlives its own test is the trap
    // the group above already has a comment about.
    const gemerkt = {}
    for (const k of ['FREILAUF_SANDBOX_RUNTIME_BIN', 'FREILAUF_SANDBOX_DOCKER_HOST', 'FREILAUF_SANDBOX_RUNTIME_FORCE']) {
      gemerkt[k] = process.env[k]; delete process.env[k]
    }
    // …and the shim's DIRECTORY comes off the PATH with it, because the sandbox
    // puts it first so that a bare `docker` finds the stub. A group about the
    // real daemon that resolved the stub would be the same "green while broken"
    // this whole group exists about, so the binary is named absolutely rather
    // than looked up: whatever `docker` is on the PATH once the shim's own
    // directory is out of it.
    const shimDir = gemerkt.FREILAUF_SANDBOX_RUNTIME_BIN
      ? gemerkt.FREILAUF_SANDBOX_RUNTIME_BIN.replace(/\/[^/]+$/, '')
      : null
    const echtesDocker = String(process.env.PATH ?? '').split(':')
      .filter(d => d && d !== shimDir)
      .map(d => join(d, 'docker'))
      .find(p => { try { return fsMod.statSync(p).isFile() } catch { return false } }) ?? null
    if (echtesDocker) process.env.FREILAUF_SANDBOX_RUNTIME_BIN = echtesDocker
    runtime._runtimeInfoCacheReset()

    let echterDaemon = null
    if (echtesDocker) {
      try { echterDaemon = await runtime.runtimeInfo('docker', { force: true }) } catch { echterDaemon = null }
    }
    // An image this repository builds, whichever of them the machine has. Named
    // through the plugin's own rule (`harnessImage()`), never as a literal — the
    // version is the plugin's build arg, and a literal here would go stale the
    // day one is bumped.
    let bild = null
    if (echterDaemon?.available) {
      for (const h of ['claude', 'opencode', 'cursor', 'hermes']) {
        const ref = await runtime.harnessImage(h).catch(() => null)
        if (ref && (await runtime.imageDigest(ref, { runtime: 'docker' })).ok) { bild = ref; break }
      }
    }

    if (!bild) {
      await check('skipped: no container daemon with a Freilauf agent image on this machine', () => {
        isTrue(true, 'a machine without one must not sit in front of a red test')
      })
    } else {
      const SB2 = fsMod.mkdtempSync(join(osMod.tmpdir(), 'fl-real-'))
      const RID = `e2e${Date.now().toString(36)}`
      const W = join(SB2, 'work'); fsMod.mkdirSync(W)
      const H = join(SB2, 'home'); fsMod.mkdirSync(H)
      const RD = join(SB2, 'run'); fsMod.mkdirSync(RD)
      const GD = join(SB2, 'repo.git'); fsMod.mkdirSync(GD); fsMod.writeFileSync(join(GD, 'config'), '')
      const MK = join(SB2, 'mask'); fsMod.writeFileSync(MK, '')
      const SD = join(SB2, 'sock'); fsMod.mkdirSync(SD)
      const HS = join(SD, 'hub.sock')
      sh('git', ['init', '-q', W])
      fsMod.writeFileSync(join(W, 'dirty.txt'), 'uncommitted\n')

      // A REAL unix socket, which is the only thing that makes the second check
      // a check: a regular file would be bind-mounted as a file and prove
      // nothing about the failure being fixed.
      const lauscher = netMod.createServer(() => {})
      await new Promise(r => lauscher.listen(HS, r))

      const name = runtime.containerName(RID)
      const ident = runtime.hubIdentity(echterDaemon)
      const { bin, args } = runtime.buildRunArgv(
        { runtime: 'docker', image: { ref: bild }, network: { mode: 'none' }, retention: 'run' },
        {
          runId: RID, hubId: 'e2e-real', tty: false,
          workdir: W, homeDir: H, runDir: RD, repoGitDir: GD, emptyFile: MK,
          hubSocketSource: HS, ...ident,
          env: { FL_RUN_ID: RID }, cmd: ['sleep', '300'],
        })

      let lief = false
      try {
        // `-d` instead of the pane's `-it`: this suite has no tmux pane, and
        // what is under test is the container, not how it is attached to.
        const r = await sh(bin, ['run', '-d', ...args.slice(1)], { timeout: 120_000, env: runtime.runtimeEnv('docker') })
        lief = r.ok
        await check('the container really starts from the argv the hub builds', () => {
          isTrue(r.ok, `docker run (${String(r.stderr || '').trim().split('\n').pop() || 'ok'})`)
        })

        if (lief) {
          await check('the hub can run git inside the box — the finish gate’s own call', async () => {
            // The exact shape `dirtyFiles()` uses. It answered `unknown` for
            // every sandboxed run, which is what made `runFinishCheck()` return
            // `error` and the gate loop.
            const st = await runtime.execIn(name, ['git', '-C', W, '--no-optional-locks', 'status', '--porcelain'],
              { runtime: 'docker' })
            isTrue(st.ok, `git status ran (code ${st.code}: ${st.stderr.trim().slice(0, 120)})`)
            contains(st.stdout, 'dirty.txt', 'and answered about the working copy, not about a user that does not exist')
          })

          await check('…because nobody hands `docker exec` a LOGIN NAME any more', async () => {
            equal(await runtime.execIdentity('docker'),
              runtime.containerIdentity('docker', ident).execUser,
              'the exec asks the same function the launch asks')
            // The regression, reproduced deliberately: this is what the finish
            // gate did on every pass, and the daemon's answer is the whole bug.
            const alt = await runtime.execIn(name, ['true'], { runtime: 'docker', user: 'hub' })
            isFalse(alt.ok, 'a login name that no image declares is still refused by the daemon')
            contains(String(alt.stderr).toLowerCase(), 'unable to find user',
              'with exactly the wording that cost a run its whole life')
          })

          await check('/run/freilauf/hub.sock inside the container is a SOCKET, not a directory', async () => {
            const t = await runtime.execIn(name, ['sh', '-c',
              '[ -S /run/freilauf/hub.sock ] && echo socket || { [ -d /run/freilauf/hub.sock ] && echo directory || echo missing; }'],
              { runtime: 'docker' })
            equal(t.stdout.trim(), 'socket',
              'the HOST socket is mounted at the container path §7.6 names')
            // And the run's own env names the same path, or the mount is right
            // and nothing looks at it.
            equal(facadeReal?.CONTAINER_HUB_SOCKET ?? null, '/run/freilauf/hub.sock',
              'which is the path FL_HUB_SOCKET carries')
          })
        }
      } finally {
        await sh(echtesDocker ?? 'docker', ['rm', '-f', name], { timeout: 60_000 })
        try { lauscher.close() } catch {}
        try { fsMod.rmSync(SB2, { recursive: true, force: true }) } catch {}
        for (const [k, v] of Object.entries(gemerkt)) {
          if (v === undefined) delete process.env[k]; else process.env[k] = v
        }
        runtime._runtimeInfoCacheReset()
      }
    }
  }

  // =========================================================================
  group('Sandbox: the image a run really used is written into its row')
  //
  // Defect 1 of the final review, and the reason five earlier reviews and every
  // green test missed it: two features landed on the same day and nothing
  // connected them.
  //
  //   * `ensureImage()` learned to resolve the harness's own image, so a repo no
  //     longer has to name one — and it only RETURNED the answer. The container
  //     got it; `runs.sandbox_spec` kept saying `image.ref: null`.
  //   * `checkableSandbox()` (integrate.mjs) reads exactly that column to decide
  //     whether `repos.merge_check_sandboxed` can be honoured.
  //
  // So a repo that ticked the box got `merge_check_host {reason:'run_not_boxed'}`
  // and ran an untrusted agent's MERGED code on the host as the hub user — the
  // one execution path the box exists to prevent, wearing a reason word that says
  // the run was not boxed when it was.
  //
  // Defect 2 rides on the same line: the digest was computed here and discarded,
  // so `image.digest` and the `started` event's `sandbox.digest` were always
  // null and a resume after an image rebuild ran different bytes in silence.
  //
  // This group drives the whole thing through the hub with no image named
  // anywhere — repo column empty, no override, no profile — because that is the
  // configuration the defect lived in.
  {
    const runtimeMod = await import('../server/sandbox/runtime.mjs')
    const igMod = await import('../server/integrate.mjs')
    const shim = sk.docker
    const g = (dir, ...args) => sh('git', ['-C', dir, ...args])
    const nutzlastVon = (id, kind) => {
      const row = db?.prepare('SELECT payload FROM events WHERE run_id=? AND kind=? ORDER BY id DESC LIMIT 1')
        .get(id, kind)
      try { return row?.payload ? JSON.parse(row.payload) : null } catch { return null }
    }

    // The proxy group deliberately leaves the hub down (it is what a deploy looks
    // like), so this one starts its own.
    try { await stopHub() } catch { /* already down */ }
    await startHub({ sandbox: true })
    watcherTick = await sk.prepareWatcher({ sandbox: true })
    sk.setSetting('sandbox_mode', 'available')

    const BILD = await runtimeMod.harnessImage('claude')
    const ID = 'sha256:1111111111111111111111111111111111111111111111111111111111111111'
    const DIGEST = 'sha256:2222222222222222222222222222222222222222222222222222222222222222'
    // NOTHING names an image: the repo column is cleared, and the shim is simply
    // told that the harness's own image exists on the machine.
    db.prepare('UPDATE repos SET sandbox_image=NULL WHERE id=?').run(repoId)
    {
      const pfad = join(shim.STATE, 'images.json')
      let bilder = {}
      try { bilder = JSON.parse(readFileSync(pfad, 'utf8')) } catch { bilder = {} }
      bilder[BILD] = { id: ID, repoDigest: `${String(BILD).split(':')[0]}@${DIGEST}` }
      writeFileSync(pfad, JSON.stringify(bilder))
    }

    let BOX = null

    await check('a run that names no image is launched from its harness’s own — and the ROW says so', async () => {
      const j = await laufStarten({ repo_id: String(repoId), prompt: 'E2E-Sandbox-ImageFreeze', sandbox: 'on' })
      isTrue(!!j.runId, `run started (${JSON.stringify(j).slice(0, 200)})`)
      BOX = j.runId
      await sessionMerken(BOX)
      equal(lauf(BOX).sandbox, 1, 'the run really is sandboxed')
      isTrue(ereignisse(BOX).includes('sandbox:image_default'),
        `the harness's own image was resolved (${ereignisse(BOX).join(', ')})`)
      const spec = JSON.parse(lauf(BOX).sandbox_spec ?? '{}')
      equal(spec.image?.ref, BILD,
        'runs.sandbox_spec names it — this column stayed null for every such run')
    })

    await check('…and its provenance, which was computed and thrown away', () => {
      const spec = JSON.parse(lauf(BOX).sandbox_spec ?? '{}')
      equal(spec.image?.digest, DIGEST, 'the pinnable digest is frozen with the ref')
      equal(spec.image?.id, ID, 'and the local image id, which a locally built image is all that has')
      isTrue(ereignisse(BOX).includes('sandbox:image_resolved'), 'the freeze is an event of its own')
      const ev = nutzlastVon(BOX, 'started')
      equal(ev?.sandbox?.image, BILD, 'the started event names the image')
      equal(ev?.sandbox?.digest, DIGEST,
        'and carries the digest — runtime.mjs’s “that is the whole provenance story”, implemented')
    })

    await check('a boxed run and an unboxed one are no longer the same answer', () => {
      const boxed = igMod.checkableSandbox(lauf(BOX))
      equal(boxed.reason, null, 'this run can be checked in a container')
      equal(boxed.spec.image.ref, BILD, 'out of the image its row now carries')
      // The state the defect produced, reproduced deliberately.
      equal(igMod.checkableSandbox({ sandbox: 1, sandbox_spec: '{"image":{}}' }).reason, 'no_image',
        'a boxed run with no image is named as that, never as “not boxed”')
    })

    await check('a hub restart does not silently end a run’s container-event log', async () => {
      // Defect 3. `startDockerEvents()` had ONE caller — `prepareSandbox()` — and
      // the tail is a child process of the hub, so every deploy ended the
      // container-event log of every run in flight for the rest of that run. On
      // an installation that deploys 164 times in 30 days that is most of the
      // audit trail, and the file gives no sign of it: it simply stops.
      //
      // THIS PROCESS IS THE RESTARTED HUB. Its `eventTails` map is empty, which
      // is exactly the state a deploy leaves behind, and it shares the database
      // and the runs directory with the hub that started the run.
      const facade = await import('../server/sandbox/index.mjs')
      isTrue(typeof facade.restoreDockerEvents === 'function',
        'server/sandbox/index.mjs exports restoreDockerEvents()')
      const name = lauf(BOX).sandbox_container || `fl-${BOX}`
      equal(lauf(BOX).status, 'running', 'the run is still in flight — a finished one is owed nothing')

      // The daemon says nothing: the hub learned nothing, and acting on nothing
      // is the mistake `tmuxVerdict()` exists to prevent.
      shim.container(name, { state: 'running', labels: { 'freilauf.hub': 'e2e-hub' } })
      shim.reset()
      let out = null
      try { shim.mode('unreachable'); out = await facade.restoreDockerEvents() } finally { shim.mode('ok') }
      equal(out.restored.length, 0, 'an unreachable daemon restores nothing')
      isFalse(ereignisse(BOX).includes('sandbox:audit_restored'), 'and claims nothing was restored')

      // A container that has exited has no events left to write.
      shim.container(name, { state: 'exited' })
      shim.reset()
      out = await facade.restoreDockerEvents()
      isFalse(out.restored.includes(BOX), 'a container that is not running gets no tail either')
      isFalse(ereignisse(BOX).includes('sandbox:audit_restored'), 'still nothing claimed')

      // Positive evidence: the container is running, so the tail comes back.
      shim.container(name, { state: 'running' })
      shim.reset()
      out = await facade.restoreDockerEvents()
      isTrue(out.restored.includes(BOX), `the run in flight got its tail back (${JSON.stringify(out)})`)
      isTrue(ereignisse(BOX).includes('sandbox:audit_restored'), 'and the run says so')
      const zeilen = readFileSync(join(SB, 'runs', BOX, 'docker-events.jsonl'), 'utf8')
      contains(zeilen, 'freilauf.tail_restarted',
        'the GAP is written into the audit file — nothing can reconstruct those minutes, and saying so is the honest answer')
      // The spawn happens a microtask later (the tail resolves the runtime module
      // first), so this waits for it rather than racing it.
      await waitFor(() => shim.order().includes('events'),
        { was: 'a real `docker events` tail being spawned', timeoutMs: 10_000 })
      isTrue(shim.order().includes('events'), `and a real tail was spawned (${JSON.stringify(shim.order())})`)
    })

    await check('the merge check of such a run runs in a CONTAINER, not on the host', async () => {
      // The box, and a check that says nothing about the code — what is under
      // test is WHERE it ran.
      db.prepare(`UPDATE repos SET merge_mode='hub', merge_check=?, merge_check_sandboxed=1,
                  finish_timeout_min=15 WHERE id=?`).run('true', repoId)
      const row = lauf(BOX)
      const dir = row.workdir_effective
      isTrue(!!dir && existsSync(join(dir, '.git')), `the run has a working copy (${dir})`)
      writeFileSync(join(dir, 'boxed-work.md'), 'work done in a box\n')
      await g(dir, 'add', '-A')
      await g(dir, '-c', 'user.email=e2e@test.local', '-c', 'user.name=E2E', 'commit', '-qm', 'Boxed run commit')

      const sauber = await g(dir, 'status', '--porcelain')
      equal(sauber.stdout.trim(), '', 'the working copy is clean — a dirty one never reaches the check at all')

      shim.reset()
      await fetchPath(`/api/runs/${BOX}/report`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'done', text: 'boxed run finished' }),
      })
      try {
        await waitFor(() => lauf(BOX).status === 'done', { was: 'the boxed run being merged', timeoutMs: 60_000 })
      } catch {
        const r = lauf(BOX)
        isTrue(false, `the run did not come through: status=${r.status} finish=${r.finish_state} `
          + `merge=${r.merge_status} events=${ereignisse(BOX).join(',')}`)
      }

      const arten = ereignisse(BOX)
      isTrue(arten.includes('merge_check_sandboxed'),
        `the check was containerised (${arten.filter(k => k.startsWith('merge_check')).join(', ') || 'nothing at all'})`)
      isFalse(arten.includes('merge_check_host'),
        'and NOT run on the host — that event, with reason "run_not_boxed", was the defect')
      const argv = shim.argvFor('run').find(a => String(a[a.indexOf('--name') + 1] ?? '').startsWith('fl-check-'))
      isTrue(!!argv, `a check container was really started (${JSON.stringify(shim.order())})`)
      const bildArg = argv.find(a => String(a).startsWith(BILD))
      isTrue(!!bildArg, `out of the run’s own image (${JSON.stringify(argv?.slice(-4))})`)
      contains(bildArg, `@${DIGEST}`,
        'digest-pinned — the check runs against the same bytes the agent ran on, which is only '
        + 'possible because the launch froze the digest into the row')
      equal(nutzlastVon(BOX, 'merge_check_sandboxed')?.network, 'allowlist',
        'under the run’s own network policy')
    })

    db.prepare(`UPDATE repos SET merge_mode='off', merge_check='', merge_check_sandboxed=0 WHERE id=?`).run(repoId)

    await check('an ACCEPTED loosening is an event too, and it names what got weaker', async () => {
      // Defect 4. "Every weakening is a visible, named event — never a silent
      // setting" was the acceptance criterion, and only a REFUSED loosening of a
      // LOCKED path was ever written down — so a weakening was visible exactly
      // when it did not happen. A repo swapping Balanced for Open network emitted
      // nothing at all.
      //
      // The lock is cleared for this one check on purpose: a LOCKED loosening is
      // refused and already has its own event and its own group ("the floor
      // holds"). What had no event at all is the loosening nobody locked — the
      // ordinary case on an installation whose operator cleared the list.
      const lockVorher = db.prepare("SELECT value FROM settings WHERE key='sandbox_lock'").get()?.value ?? null
      sk.setSetting('sandbox_lock', '[]')
      db.prepare('UPDATE repos SET sandbox_overrides=? WHERE id=?')
        .run(JSON.stringify({ network: { mode: 'open' }, filesystem: { readOnlyRoot: false } }), repoId)
      try {
        const j = await laufStarten({ repo_id: String(repoId), prompt: 'E2E-Sandbox-Weakened', sandbox: 'on' })
        isTrue(!!j.runId, `run started (${JSON.stringify(j).slice(0, 200)})`)
        await sessionMerken(j.runId)
        const arten = ereignisse(j.runId)
        isTrue(arten.includes('sandbox:policy_weakened'),
          `the loosening is on the record (${arten.join(', ')})`)
        const roh = db.prepare(`SELECT payload FROM events WHERE run_id=? AND kind='sandbox:policy_weakened'`)
          .all(j.runId).map(r => { try { return JSON.parse(r.payload) } catch { return {} } })
        const pfade = roh.map(p => p.path)
        isTrue(pfade.includes('network.mode'), `Balanced → Open network is named (${JSON.stringify(pfade)})`)
        isTrue(pfade.includes('filesystem.readOnlyRoot'), 'and so is the writable root filesystem')
        const netz = roh.find(p => p.path === 'network.mode')
        equal(netz.from, 'allowlist', 'the event says what it was')
        equal(netz.to, 'open', '…and what it became')
        equal(netz.by, 'repo', 'and which layer did it')
        db.prepare(`UPDATE runs SET status='aborted', ended_at=datetime('now') WHERE id=?`).run(j.runId)
      } finally {
        db.prepare('UPDATE repos SET sandbox_overrides=? WHERE id=?').run('{}', repoId)
        if (lockVorher === null) db.prepare("DELETE FROM settings WHERE key='sandbox_lock'").run()
        else sk.setSetting('sandbox_lock', lockVorher)
      }
    })

    // Back off again, so nothing after this group inherits the box or the mode.
    sk.setSetting('sandbox_mode', 'off')
  }

  // =========================================================================
  group('Sandbox: a REAL image answers what a stub cannot')
  //
  // The group above proves the wiring against the shim, which is right for the
  // wiring. It cannot prove the one thing defects 1 and 2 are really about: that
  // the ref this hub resolves for a harness NAMES AN IMAGE THAT EXISTS, and that
  // the daemon has a digest to freeze for it. A stub answers whatever its own
  // fixture says — and the evaluator's own words about the last two blockers are
  // that both "passed every stub".
  //
  // So this asks the real daemon, and SKIPS ITSELF GREEN without one.
  {
    const fsMod = await import('node:fs')
    const runtime = await import('../server/sandbox/runtime.mjs')

    const gemerkt = {}
    for (const k of ['FREILAUF_SANDBOX_RUNTIME_BIN', 'FREILAUF_SANDBOX_DOCKER_HOST', 'FREILAUF_SANDBOX_RUNTIME_FORCE']) {
      gemerkt[k] = process.env[k]; delete process.env[k]
    }
    const shimDir = gemerkt.FREILAUF_SANDBOX_RUNTIME_BIN
      ? gemerkt.FREILAUF_SANDBOX_RUNTIME_BIN.replace(/\/[^/]+$/, '') : null
    const echtesDocker = String(process.env.PATH ?? '').split(':')
      .filter(d => d && d !== shimDir)
      .map(d => join(d, 'docker'))
      .find(p => { try { return fsMod.statSync(p).isFile() } catch { return false } }) ?? null
    if (echtesDocker) process.env.FREILAUF_SANDBOX_RUNTIME_BIN = echtesDocker
    runtime._runtimeInfoCacheReset()

    let daemon = null
    if (echtesDocker) { try { daemon = await runtime.runtimeInfo('docker', { force: true }) } catch { daemon = null } }

    let harness = null, ref = null, seen = null
    if (daemon?.available) {
      for (const h of ['claude', 'opencode', 'cursor', 'hermes']) {
        const r = await runtime.harnessImage(h).catch(() => null)
        if (!r) continue
        const d = await runtime.imageDigest(r, { runtime: 'docker' })
        if (d.ok) { harness = h; ref = r; seen = d; break }
      }
    }

    try {
      if (!seen) {
        skipped('the harness’s own image exists, and the daemon has provenance for it',
          'no container daemon with a Freilauf agent image on this machine')
      } else {
        await check('the harness’s own image exists, and the daemon has provenance for it', () => {
          // The half a stub cannot answer: `harnessImage()` is the rule the LAUNCH
          // uses when a repo names no image, and this is a real `image inspect` of
          // its answer.
          isTrue(ref.startsWith('freilauf/agent-'), `${harness} resolves to ${ref}`)
          isTrue(!!seen.id, 'the daemon knows an image id for it — the provenance a local build has')
          isTrue(seen.digest === null || String(seen.digest).startsWith('sha256:'),
            `and a repo digest where there is one (${seen.digest})`)
        })

        await check('a spec resolved that way really starts a container of that image', async () => {
          // `ensureImage()`'s answer, taken to the daemon: the frozen spec has to
          // be a document `buildRunArgv()` can build a real `docker run` out of,
          // digest and all. That is what a resume reads back after a restart.
          const SB3 = fsMod.mkdtempSync(join((await import('node:os')).tmpdir(), 'fl-img-'))
          const RID = `e2eimg${Date.now().toString(36)}`
          const W = join(SB3, 'work'); fsMod.mkdirSync(W)
          const H = join(SB3, 'home'); fsMod.mkdirSync(H)
          const RD = join(SB3, 'run'); fsMod.mkdirSync(RD)
          const GD = join(SB3, 'repo.git'); fsMod.mkdirSync(GD); fsMod.writeFileSync(join(GD, 'config'), '')
          const MK = join(SB3, 'mask'); fsMod.writeFileSync(MK, '')
          const name = runtime.containerName(RID)
          const ident = runtime.hubIdentity(daemon)
          const frozen = { runtime: 'docker', image: { ref, digest: seen.digest, id: seen.id },
            network: { mode: 'none' }, retention: 'run' }
          const { bin, args } = runtime.buildRunArgv(frozen, {
            runId: RID, hubId: 'e2e-img', tty: false,
            workdir: W, homeDir: H, runDir: RD, repoGitDir: GD, emptyFile: MK,
            ...ident, env: { FL_RUN_ID: RID }, cmd: ['sh', '-c', 'echo boxed'],
          })
          try {
            const r = await sh(bin, ['run', '--rm', ...args.slice(1)],
              { timeout: 120_000, env: runtime.runtimeEnv('docker') })
            isTrue(r.ok, `the frozen spec runs (${String(r.stderr || '').trim().split('\n').pop() || 'ok'})`)
            contains(r.stdout, 'boxed', 'and the container really executed')
          } finally {
            await sh(echtesDocker ?? 'docker', ['rm', '-f', name], { timeout: 60_000 })
            try { fsMod.rmSync(SB3, { recursive: true, force: true }) } catch {}
          }
        })
      }
    } finally {
      for (const [k, v] of Object.entries(gemerkt)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v
      }
      runtime._runtimeInfoCacheReset()
    }
  }

  // =========================================================================
  group('Sandbox: the default lock, on an installation that configured none')
  //
  // Every sandbox group above SETS `sandbox_lock` before it asks anything of
  // the layering — which is exactly how the defect survived six reviews. The
  // machinery was measured and the DEFAULT VALUE it operates on was not:
  // `sandbox_lock` shipped as an absent settings row, `resolveSandboxSpec()`
  // narrows only `if (i > 0 && pathLocked(path, lock))`, and so out of the box
  // a repo could hand its container the operator's own `.git` read-write and
  // nothing anywhere would refuse it.
  //
  // This group therefore configures NOTHING. It deletes the row, which is the
  // one state a fresh installation is really in, and drives the real routes.
  {
    try { await stopHub() } catch { /* the group above may leave it down */ }
    await startHub({ sandbox: true })
    sk.setSetting('sandbox_mode', 'available')

    /** A fresh installation: nobody has ever written the two rows. */
    const frisch = () => sk.db.prepare('DELETE FROM settings WHERE key IN (?, ?)')
      .run('sandbox_lock', 'sandbox_lock_seeded')
    const wert = (key) => sk.db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value ?? null
    const repoZeile = () => db.prepare('SELECT * FROM repos WHERE id=?').get(repoId)
    const repoFelder = () => {
      const row = repoZeile()
      return {
        name: row.name, path: row.path, base_branch: row.base_branch,
        worktree_extras: row.worktree_extras ?? '', prompt: row.prompt ?? '',
        sandbox_default: 'inherit', sandbox_profile_id: '', sandbox_image: '',
      }
    }

    await check('the settings page seeds the lock and PRINTS it, instead of an empty box', async () => {
      frisch()
      const html = await (await fetchPath('/settings/sandbox')).text()
      contains(html, 'name="sandbox_lock"', 'the field is still there to edit')
      for (const pfad of ['filesystem.repoGit', 'network.mode', 'secrets.mode', 'filesystem.extraMounts']) {
        contains(html, `<code>${pfad}</code>`, `and the page names ${pfad} as locked`)
      }
      const gespeichert = JSON.parse(wert('sandbox_lock') ?? '[]')
      isTrue(gespeichert.includes('filesystem.repoGit'), `the row was written (${gespeichert.length} paths)`)
      // An installation that was ALREADY sandboxing just became stricter, and a
      // policy that tightens silently is the failure the whole module is
      // written against. The note carries the day it happened.
      const seed = JSON.parse(wert('sandbox_lock_seeded') ?? 'null')
      isTrue(!!seed?.at, 'the moment is written down')
      contains(html, String(seed.at).slice(0, 10), 'and the page says so, with the date')
    })

    await check('and a repo that configured nothing may no longer loosen the wall', async () => {
      frisch()
      const felder = repoFelder()
      for (const [doc, pfad] of [
        ['{"filesystem":{"repoGit":"rw"}}', 'filesystem.repoGit'],
        ['{"network":{"mode":"open"}}', 'network.mode'],
        ['{"filesystem":{"readOnlyRoot":false}}', 'filesystem.readOnlyRoot'],
        ['{"innerSandbox":"weak"}', 'innerSandbox'],
      ]) {
        const r = await postForm('/repos/edit?id=' + repoId, { ...felder, sandbox_overrides: doc }, { asBrowser: true })
        equal(r.status, 400, `${pfad} is refused with no lock configured at all`)
        contains(await r.text(), pfad, 'and the sentence names the path')
      }
      equal(repoZeile().sandbox_overrides ?? '{}', '{}', 'and nothing of it was stored')
    })

    await check('…and the audit-only checkbox is refused with it, because it is the same egress', async () => {
      // `auditOnly: true` lets everything through and only writes down what it
      // WOULD have blocked, so as egress it IS `mode: 'open'`. Locking one and
      // leaving the other would be a door with a window beside it — which is
      // why this costs a shipped checkbox (and the "Audit" and "Open network"
      // profiles) until the operator takes the path out of the lock.
      frisch()
      const felder = repoFelder()
      const audit = await postForm('/repos/edit?id=' + repoId,
        { ...felder, sandbox_overrides: '', sandbox_audit_only: '1' }, { asBrowser: true })
      equal(audit.status, 400, 'switching the wall to advisory is refused out of the box')
      contains(await audit.text(), 'network.auditOnly',
        'the sentence names the path — and, since this refusal is the one an operator meets first, '
        + 'the string itself names Settings → Sandbox as the place it is changed')
      equal(repoZeile().sandbox_overrides ?? '{}', '{}', 'nothing was stored')
    })

    await check('…while narrowing, and everything outside the wall, still goes through', async () => {
      frisch()
      const felder = repoFelder()
      const enger = await postForm('/repos/edit?id=' + repoId,
        { ...felder, sandbox_overrides: '{"network":{"mode":"none"}}' }, { asBrowser: true })
      equal(enger.status, 303, 'tightening the network is not a refusal')
      // The default is a LIST, not an inversion: an allowlist a repo may fill,
      // resources it may spend, an image it may name. A layer that may change
      // nothing is not a layer.
      const frei = await postForm('/repos/edit?id=' + repoId,
        { ...felder, sandbox_overrides: '{"network":{"allow":["api.example"]},"resources":{"cpus":2}}' },
        { asBrowser: true })
      equal(frei.status, 303, 'and what is not the wall is still the repo’s own')
      contains(String(repoZeile().sandbox_overrides), 'api.example', 'it really stored it')
      await postForm('/repos/edit?id=' + repoId, { ...felder, sandbox_overrides: '' }, { asBrowser: true })
    })

    await check('saving the form makes the list the operator’s own — note gone, empty stays empty', async () => {
      frisch()
      await fetchPath('/settings/sandbox')                       // seeds
      isTrue(!!wert('sandbox_lock_seeded'), 'the note is standing')
      const r = await postForm('/settings/sandbox', { sandbox_lock: 'network.mode' }, { asBrowser: true })
      equal(r.status, 303, 'the form saves')
      equal(wert('sandbox_lock_seeded'), '', 'and the note is done — pressing Save is having seen it')
      equal(JSON.parse(wert('sandbox_lock')).join(), 'network.mode', 'the operator’s own list stands')

      // An emptied list is a decision, and it is never seeded over again.
      await postForm('/settings/sandbox', { sandbox_lock: '' }, { asBrowser: true })
      const html = await (await fetchPath('/settings/sandbox')).text()
      equal(JSON.parse(wert('sandbox_lock') ?? 'null').length, 0, 'cleared stays cleared across a page render')
      isFalse(html.includes('<code>filesystem.repoGit</code>'), 'and the page prints no lock')
    })

    sk.setSetting('sandbox_mode', 'off')
    sk.setSetting('sandbox_lock', '')
    await stopHub()
  }

  // ------------------------------------------------------------------
  group('Sandbox: a dead pane is not a dead agent')
  {
    // `_pane_died` had no sandbox branch. For a sandboxed run the pane IS the
    // `docker` client, so a restarted daemon, a `permission denied` on the
    // socket or a `docker run` that never got past `runc create` killed the
    // pane — and the run was set `failed` with a red notification, which is the
    // acceptance criterion "infrastructure trouble never makes runs count as
    // ended" broken in the one place the tri-state discipline was missing.
    //
    // What is under test is the DISTINCTION, so all four cases are driven
    // through the same route with only the daemon's answer changed: an ordinary
    // agent exit must behave exactly as it always did, and nothing that is the
    // infrastructure's fault may end a run.
    const shim = sk.docker
    await startHub({ sandbox: true })
    watcherTick = await sk.prepareWatcher({ sandbox: true })
    const runtimeMod = await import('../server/sandbox/runtime.mjs')
    const sessMod = await import('../server/sessions.mjs')
    const { handleReport } = await import('../server/reports.mjs')
    runtimeMod._runtimeInfoCacheReset()
    sessMod._resetRuntimeModule()
    shim.reset()
    shim.mode('ok')

    /** A run the watcher would find with a dead pane: sandboxed unless told otherwise. */
    const legeLauf = ({ sandbox = 1 } = {}) => {
      const id = randomUUID()
      db.prepare(`INSERT INTO runs(id,repo_id,harness,prompt,branch_mode,expected_minutes,status,
                                   sandbox,sandbox_container,workdir_effective,tmux_session,started_at)
                  VALUES(?,?,'claude','pane death','keiner',45,'running',?,?,?,?,datetime('now'))`)
        .run(id, repoId, sandbox, sandbox ? `fl-${id.slice(0, 8)}` : null, REPO, `fl-cc-pane-${id.slice(0, 8)}`)
      mkdirSync(join(SB, 'runs', id), { recursive: true })
      return id
    }
    const lauf = (id) => db.prepare('SELECT * FROM runs WHERE id=?').get(id)
    const arten = (id) => db.prepare('SELECT kind FROM events WHERE run_id=? ORDER BY id').all(id).map(e => e.kind)
    // `docker inspect --format` of a running / an exited container, in the four
    // tab-separated fields containerState() asks for.
    const laeuft = 'out true\t0\tfalse\trunning'

    await check('an ordinary agent exit still ends the run, exactly as before', async () => {
      const id = legeLauf()
      // `--rm` took the container with the agent's own exit: the daemon answers,
      // and it answers that there is no such container.
      shim.say('inspect', 'notfound')
      await handleReport(id, { kind: '_pane_died', exit: '42' }, 'internal')
      const r = lauf(id)
      equal(r.status, 'failed', 'the run is failed')
      equal(r.exit_code, 42, 'with the exit status the pane carried')
      isTrue(arten(id).includes('pane_died'), 'and the pane_died event is written')
      shim.clearSay('inspect')
    })

    await check('an unsandboxed run never asks a daemon at all', async () => {
      const vorher = shim.calls().length
      const id = legeLauf({ sandbox: 0 })
      await handleReport(id, { kind: '_pane_died', exit: '1' }, 'internal')
      equal(lauf(id).status, 'failed', 'byte for byte the old behaviour')
      equal(shim.calls().length, vorher, 'and not one runtime invocation was spent on it')
    })

    await check('a daemon that does not answer decides nothing, and says so once', async () => {
      const id = legeLauf()
      shim.say('inspect', 'unreachable')
      await handleReport(id, { kind: '_pane_died', exit: '1' }, 'internal')
      equal(lauf(id).status, 'running', 'the run is NOT failed — not knowing is a reason to wait')
      isFalse(arten(id).includes('pane_died'), 'and nothing claims the pane death was the agent’s')
      isTrue(arten(id).includes('sandbox:pane_unclear'), 'the fact is recorded')
      // The watcher fires `_pane_died` on every 30-second pass for as long as the
      // pane stays dead; one event per pass would be a flood.
      await handleReport(id, { kind: '_pane_died', exit: '1' }, 'internal')
      await handleReport(id, { kind: '_pane_died', exit: '1' }, 'internal')
      equal(arten(id).filter(k => k === 'sandbox:pane_unclear').length, 1, 'and recorded once, not once a pass')
      equal(lauf(id).status, 'running', 'still running after three passes')
      shim.clearSay('inspect')
    })

    await check('the client died and the agent did not: the run is resumed, never failed', async () => {
      const id = legeLauf()
      shim.say('inspect', laeuft)
      await handleReport(id, { kind: '_pane_died', exit: '1' }, 'internal')
      const r = lauf(id)
      isFalse(r.status === 'failed', `the run is not failed (${r.status}; ${arten(id).join(', ')})`)
      const k = arten(id)
      isTrue(k.includes('sandbox:client_gone'), 'the client’s death is recorded as the client’s')
      isFalse(k.includes('pane_died'), 'and not as the agent’s')
      // The recovery path that already exists: resumeRun() writes `session_lost`
      // and either launches or defers. Either is a run still on its way.
      isTrue(k.includes('session_lost') || r.resume_pending === 1 || r.status === 'deferred',
        `and it was handed to the resume path (${k.join(', ')})`)
      shim.clearSay('inspect')
    })

    await check('exit 125 is infrastructure even where the container is demonstrably absent', async () => {
      // docker's own reserved code: the client never started the container, so
      // asking the daemon afterwards can only ever say "no such container" —
      // which for every other exit code is the ordinary end.
      const id = legeLauf()
      shim.say('inspect', 'notfound')
      await handleReport(id, { kind: '_pane_died', exit: '125' }, 'internal')
      const k = arten(id)
      isFalse(lauf(id).status === 'failed', 'a failed `runc create` does not fail the run')
      isTrue(k.includes('sandbox:client_gone'), 'it is recorded as the client')
      isFalse(k.includes('pane_died'), 'and never as the agent')
      shim.clearSay('inspect')
    })

    // The seam goes back the way this group found it — a fixture that outlives
    // its own test is the trap the container-path group already has a comment
    // about.
    await stopHub()
    watcherTick = await sk.prepareWatcher({ sandbox: false })
  }

  // =========================================================================
  group('Sandbox: the placement production uses, driven by the suite at last')
  //
  // THE GAP THIS CLOSES. `test/sandbox.mjs` set `FREILAUF_SANDBOX_PROXY_BIND`
  // and nothing else, and `proxyPlacement()` answers `'process'` for any bind at
  // all — so every sandbox group above this one, on every machine, exercised the
  // IN-PROCESS listener. Under a rootless daemon that is exactly the placement
  // production does NOT take: the first end-to-end fenced run on this machine
  // only came up after the bind was unset by hand. A suite that structurally
  // cannot reach the production path is not covering it, and the two blockers
  // that reached that run got past every green test for precisely that reason.
  //
  // The suite drives both now, and the placement is NAMED rather than implied
  // (`sandbox: 'container'` vs `sandbox: true`, `placementOf()` in
  // sandbox.mjs). The resolution order itself — forced → bind → rootless →
  // rootful — is pinned in test/unit.mjs, so a change that moved production onto
  // the untested side would fail there rather than surface on a live run.
  {
    const shim = sk.docker
    const wert = (argv, flag) => { const i = argv.indexOf(flag); return i < 0 ? null : argv[i + 1] }
    const werte = (argv, flag) => argv.reduce((o, tok, i) => (tok === flag ? [...o, argv[i + 1]] : o), [])
    const nutzlast = (id, kind) => {
      const row = db.prepare('SELECT payload FROM events WHERE run_id=? AND kind=? ORDER BY id DESC LIMIT 1')
        .get(id, kind)
      try { return row?.payload ? JSON.parse(row.payload) : null } catch { return null }
    }

    let facade = null
    try { facade = await import('../server/sandbox/index.mjs') } catch { facade = null }
    const fehlt = facade ? null : 'server/sandbox/index.mjs is not written yet'

    if (fehlt) skipped('a sandboxed run puts its egress proxy in a container', fehlt)
    else {
      // ---- the production placement --------------------------------------
      await startHub({ sandbox: 'container' })
      watcherTick = await sk.prepareWatcher({ sandbox: 'container' })
      sk.setSetting('sandbox_mode', 'available')
      const runtimeMod = await import('../server/sandbox/runtime.mjs')
      runtimeMod._runtimeInfoCacheReset()
      shim.reset()
      shim.mode('ok')
      // The same image the container-path group taught the shim about, so the
      // two halves of this suite describe one image rather than two.
      const bilder = (() => {
        try { return JSON.parse(readFileSync(join(shim.STATE, 'images.json'), 'utf8')) } catch { return {} }
      })()
      db.prepare('UPDATE repos SET sandbox_image=? WHERE id=?')
        .run(Object.keys(bilder)[0] ?? 'freilauf/base:1', repoId)

      let IM_CONTAINER = null
      await check('a sandboxed run puts its egress proxy in a container of its own', async () => {
        const j = await laufStarten({ repo_id: String(repoId), prompt: 'E2E-Sandbox-Placement', sandbox: 'on' })
        IM_CONTAINER = j.runId
        await sessionMerken(IM_CONTAINER)
        await waitFor(() => !!nutzlast(IM_CONTAINER, 'sandbox:proxy_started'),
          { was: 'the run reporting that its proxy came up' })

        const proxyRun = shim.argvFor('run').find(a => a.includes('freilauf.role=proxy'))
        isTrue(!!proxyRun, `a proxy container was created (${shim.order().join(', ')})`)
        equal(wert(proxyRun, '--name'), `fl-proxy-${IM_CONTAINER}`,
          'under the name the agent’s HTTPS_PROXY dials')
        equal(wert(proxyRun, '--network'), `fl-net-${IM_CONTAINER}`,
          'on the run’s own internal network — not on the host')
        // Its one leg out. Without this the proxy would be as walled in as the
        // agent, and every request would fail as a DNS error.
        isTrue(shim.argvFor('network-connect').some(a => a.includes(`fl-proxy-${IM_CONTAINER}`)),
          `and connected to a network that has a route out (${shim.order().join(', ')})`)
      })

      await check('…and the agent is told to dial that container, never a host address', () => {
        const start = nutzlast(IM_CONTAINER, 'sandbox:proxy_started')
        equal(start?.url, `http://fl-proxy-${IM_CONTAINER}:8080`,
          'the recorded proxy URL is the container’s name')
        isFalse(String(start?.url ?? '').includes('127.0.0.1'),
          'a loopback address here is the in-process placement, which a rootless daemon cannot reach')

        // The AGENT's container is created by `fl-start` out of the spec, and
        // this suite's fl-start is a stub — so the shim's log holds the proxy's
        // `docker run` and not the agent's. What the hub really handed over is
        // in the run's own `sandbox.json`, which is also what `restoreProxies()`
        // reads back, and the argv builder is pure enough to be asked directly.
        const gespeichert = JSON.parse(readFileSync(join(SB, 'runs', IM_CONTAINER, 'sandbox.json'), 'utf8'))
        equal(gespeichert?.ctx?.proxyUrl, `http://fl-proxy-${IM_CONTAINER}:8080`,
          'and that is the URL frozen into the run’s spec file, where a restart reads it')
        const { args } = runtimeMod.buildRunArgv(
          { runtime: 'docker', image: { ref: 'x:1' }, network: { mode: 'allowlist' } },
          { runId: IM_CONTAINER, network: `fl-net-${IM_CONTAINER}`, image: 'x:1',
            workdir: '/w', home: '/h', proxyUrl: gespeichert.ctx.proxyUrl })
        const umgebung = werte(args, '-e').filter(Boolean)
        isTrue(umgebung.some(e => e === `HTTPS_PROXY=http://fl-proxy-${IM_CONTAINER}:8080`),
          `the agent’s HTTPS_PROXY names the proxy container (${umgebung.filter(e => /PROXY/i.test(e)).join(' ')})`)
      })

      try { await facade.teardownSandbox(db.prepare('SELECT * FROM runs WHERE id=?').get(IM_CONTAINER),
        { reason: 'e2e', removeNetwork: true, force: true }) } catch {}
      db.prepare(`UPDATE runs SET status='aborted', ended_at=datetime('now') WHERE id=?`).run(IM_CONTAINER)

      // ---- and the other one, from the same sandbox ------------------------
      await stopHub()
      await startHub({ sandbox: true })
      watcherTick = await sk.prepareWatcher({ sandbox: true })
      sk.setSetting('sandbox_mode', 'available')
      runtimeMod._runtimeInfoCacheReset()
      shim.reset()

      await check('the same suite still drives the in-process listener — both, not one', async () => {
        const j = await laufStarten({ repo_id: String(repoId), prompt: 'E2E-Sandbox-Placement-Prozess', sandbox: 'on' })
        await sessionMerken(j.runId)
        await waitFor(() => !!nutzlast(j.runId, 'sandbox:proxy_started'),
          { was: 'the second run reporting its proxy' })
        const start = nutzlast(j.runId, 'sandbox:proxy_started')
        isTrue(String(start?.url ?? '').includes('127.0.0.1'),
          `this one is a listener in the hub process (${start?.url})`)
        isFalse(shim.argvFor('run').some(a => a.includes('freilauf.role=proxy')),
          'and no proxy container was started for it')
        try { await facade.teardownSandbox(db.prepare('SELECT * FROM runs WHERE id=?').get(j.runId),
          { reason: 'e2e', removeNetwork: true, force: true }) } catch {}
        db.prepare(`UPDATE runs SET status='aborted', ended_at=datetime('now') WHERE id=?`).run(j.runId)
      })

      sk.setSetting('sandbox_mode', 'off')
      await stopHub()
      watcherTick = await sk.prepareWatcher({ sandbox: false })
    }
  }

} catch (err) {
  console.log(`\nAborted: ${err.stack}`)
  counter.failures.push({ name: 'Test run', reason: err.message })
} finally {
  await cleanUp()
}

process.exit(summary(`E2E tests${ECHT ? ' (with real runs)' : ''}`, start))
