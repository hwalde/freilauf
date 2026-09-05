#!/usr/bin/env node
// Freilauf — browser tests: what public/hub.js actually does, in a real browser.
//
// Why this suite exists: hub.js was 746 lines with not one test, because no
// browser ran in the suite. Every other check in this project stops at the HTML
// the server sends — what happens after it reaches a browser was unobserved, and
// the ways it breaks are all SILENT. A dead listener does not throw: the selects
// simply never fill, the terminal is a black box, the pencil does nothing. That
// is precisely what a rebuild of this file (live updates, htmx) walks into
// blind, so what it does today is written down here as tests first.
//
// It runs a hub in the sandbox from test/sandbox-env.mjs — the same one the e2e
// suite uses, on its own port with its own database, so both may run at the
// same time and next to a live hub.
//
// Without playwright, or without a Chromium that starts, the whole suite reports
// itself skipped and ends with exit code 0: a developer without a browser must
// not sit in front of a red test. It is therefore deliberately NOT part of
// `npm test` — like the real-run e2e mode, it is asked for by name.
//
// Usage:
//   node test/browser.mjs            headless
//   node test/browser.mjs --sichtbar with a visible window (debugging)
//   node test/browser.mjs --keep     keep the sandbox
import { group, check, skipped, equal, isTrue, isFalse, contains, waitFor, summary, counter } from './mini.mjs'
import { newSandbox } from './sandbox-env.mjs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const KEEP = process.argv.includes('--keep')
const SICHTBAR = process.argv.includes('--sichtbar')
const start = Date.now()

// ---------------------------------------------------------------- the browser
let chromium = null
let browser = null
let grund = ''
try {
  ({ chromium } = await import('playwright'))
} catch (err) {
  grund = `playwright is not installed (${String(err.message).split('\n')[0]})`
}
if (chromium) {
  try {
    browser = await chromium.launch({ headless: !SICHTBAR })
  } catch (err) {
    grund = `Chromium does not start (${String(err.message).split('\n')[0]})`
  }
}
if (!browser) {
  group('Browser tests')
  skipped('the whole suite', `${grund} — hub.js stays untested here, which is not the same as broken`)
  process.exit(summary('Browser tests', start))
}

// ---------------------------------------------------------------- sandbox
const sk = newSandbox({ prefix: 'Freilauf-browser-', keep: KEEP })
const { fetchPath, postForm } = sk
let db = null
let kontext = null

async function cleanUp() {
  try { await kontext?.close() } catch {}
  try { await browser?.close() } catch {}
  await sk.cleanUp()
}
process.on('SIGINT', async () => { await cleanUp(); process.exit(130) })
process.on('SIGTERM', async () => { await cleanUp(); process.exit(143) })
// See test/e2e.mjs: a suite run from inside a tmux session dies of SIGHUP, and
// node's default for it skips every handler above.
process.on('SIGHUP', async () => { await cleanUp(); process.exit(129) })

// ---------------------------------------------------------------- page helper
/**
 * A page that watches itself: every uncaught exception and every console error
 * is collected, and `sauber(p)` turns them into a failing check. The silent
 * breakages this suite is about announce themselves in exactly those two places.
 * `init` runs in the page before ANY script, so a test can e.g. shorten the
 * sidebar poll interval the page would otherwise use.
 */
async function neueSeite(pfad, init) {
  const p = await kontext.newPage()
  if (init) await p.addInitScript(init)
  p.fehler = []
  p.dialoge = []
  p.on('pageerror', (err) => p.fehler.push(`pageerror: ${err.message}`))
  p.on('console', (m) => {
    if (m.type() !== 'error') return
    // A failed request is the browser reporting a server answer, not a break in
    // hub.js — and one test deliberately provokes a 400 to see it handled. The
    // status codes themselves are the e2e suite's job; here it is the exceptions
    // that matter, and those arrive as 'pageerror' or as a real console error.
    if (/Failed to load resource/.test(m.text())) return
    p.fehler.push(`console: ${m.text()}`)
  })
  // alert()/confirm() block a real browser just as they block a real user —
  // record what was said and answer yes, so no test hangs on a modal.
  p.on('dialog', (d) => { p.dialoge.push(d.message()); d.accept().catch(() => {}) })
  if (pfad) await p.goto(sk.base + pfad, { waitUntil: 'load' })
  return p
}
const sauber = (p) => isTrue(p.fehler.length === 0, `the browser console stays quiet (${p.fehler.join(' | ')})`)

/** Poll inside the page until the condition holds — same idea as waitFor. */
const wartePage = (p, fn, arg, was) =>
  p.waitForFunction(fn, arg, { timeout: 10_000 })
    .catch(() => { throw new Error(`timeout while waiting for: ${was}`) })

// ---------------------------------------------------------------- test data
const jsonPost = (pfad, obj) => fetchPath(pfad, {
  method: 'POST', body: JSON.stringify(obj),
  headers: { 'content-type': 'application/json', accept: 'application/json' },
})

async function laufStarten(data) {
  const r = await postForm('/api/runs', { harness: 'claude', branch_mode: 'keiner', expected_minutes: '45', ...data })
  const j = await r.json()
  if (!j.runId) throw new Error(`run not started: ${JSON.stringify(j)}`)
  const s = db.prepare('SELECT tmux_session FROM runs WHERE id=?').get(j.runId)?.tmux_session
  if (s) sk.sessions.add(s)
  return j.runId
}
const melden = (runId, kind, text) => jsonPost(`/api/runs/${runId}/report`, { kind, text })
const laufRow = (id) => db.prepare('SELECT * FROM runs WHERE id=?').get(id)
const dbTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')

let repoId = 0, repoId2 = 0, FLOWID = 0, FAV1 = 0, FAV2 = 0
let R_ALT = '', R_TICK = '', R_GEPLANT = '', R_LIVE = '', R_ENDE = '', R_OHNE_SESSION = ''

async function datenAnlegen() {
  for (const [harness, providers] of [['claude', []], ['opencode', ['opencode-zen', 'openrouter', 'deepseek']]]) {
    await postForm('/settings/coding-agents/save',
      { harness, enabled: '1', ...(providers.length ? { providers } : {}) }, { asBrowser: true })
  }
  for (const name of ['browser', 'browser-zwei']) {
    await postForm('/repos/edit', { name, path: sk.REPO, base_branch: 'main', worktree_extras: '[]' }, { asBrowser: true })
  }
  repoId = db.prepare('SELECT id FROM repos WHERE name=?').get('browser').id
  repoId2 = db.prepare('SELECT id FROM repos WHERE name=?').get('browser-zwei').id
  // The second repo INTEGRATES. The branch rule means something different there
  // — that is the whole point of the explanations, and it cannot be seen with
  // one repo alone.
  await postForm('/repos/edit?id=' + repoId2, {
    name: 'browser-zwei', path: sk.REPO, base_branch: 'main', worktree_extras: '[]',
    merge_mode: 'hub', finish_timeout_min: '15', merge_max_attempts: '2',
    conflict_parallel: '1', notify_running: '1', max_parallel: '0',
  }, { asBrowser: true })

  // Two favorites: one is enough for the dialog to stand, two are needed to see
  // that the chosen one is remembered.
  for (const [name, model] of [['Fav-eins', 'claude-opus-5'], ['Fav-zwei', 'claude-sonnet-4-5']]) {
    await postForm('/settings/favorites/edit', { name, harness: 'claude', model }, { asBrowser: true })
  }
  FAV1 = db.prepare('SELECT id FROM favorites WHERE name=?').get('Fav-eins').id
  FAV2 = db.prepare('SELECT id FROM favorites WHERE name=?').get('Fav-zwei').id

  // A flow with a run_finished trigger — only then does the attachment block
  // render checkboxes at all, which A9 needs.
  const fr = await jsonPost('/api/flows/save', {
    name: 'Browser-Flow', active: true, trigger: { kind: 'run_finished' },
    definition: { properties: {}, sequence: [{ id: 'n1', componentType: 'task', type: 'note', name: 'note', properties: { text: 'x' } }] },
  })
  FLOWID = (await fr.json()).id

  await postForm('/agents/edit', {
    repo_id: String(repoId), name: 'browser-agent', harness: 'claude', prompt: 'Browser-Testauftrag',
    branch_mode: 'keiner', expected_minutes: '45', schedule_kind: 'manuell', active: '1',
  }, { asBrowser: true })

  R_ALT = await laufStarten({ repo_id: String(repoId), prompt: 'Browser-Lauf alt' })
  R_TICK = await laufStarten({ repo_id: String(repoId), prompt: 'Browser-Lauf tickt' })
  R_ENDE = await laufStarten({ repo_id: String(repoId), prompt: 'Browser-Lauf beendet' })
  R_OHNE_SESSION = await laufStarten({ repo_id: String(repoId), prompt: 'Browser-Lauf ohne Session' })
  R_LIVE = await laufStarten({ repo_id: String(repoId), prompt: 'Browser-Lauf laeuft' })
  for (const id of [R_ALT, R_TICK, R_ENDE, R_OHNE_SESSION]) await melden(id, 'done', 'fertig')

  // A planned run: the overview cell then looks FORWARD ("in 20 minutes").
  const g = await postForm('/api/runs', {
    repo_id: String(repoId), harness: 'claude', prompt: 'Browser-Lauf geplant',
    branch_mode: 'keiner', expected_minutes: '45', start_mode: 'in', start_in_minutes: '20',
  })
  R_GEPLANT = (await g.json()).runId

  // Fixed points in time instead of "just now": the ladder in relTimeText is
  // what is under test, and it must not depend on how long the setup took.
  const jetzt = Date.now()
  db.prepare('UPDATE runs SET started_at=?, ended_at=? WHERE id=?')
    .run(dbTime(jetzt - 5 * 60_000), dbTime(jetzt - 3 * 60_000), R_ALT)
  db.prepare('UPDATE runs SET started_at=? WHERE id=?').run(dbTime(jetzt - 12_000), R_TICK)
  // A finished run whose session is gone — the terminal must say so instead of
  // opening a black box against a 404.
  db.prepare('UPDATE runs SET tmux_session=NULL WHERE id=?').run(R_OHNE_SESSION)
}

// ================================================================== Test run
try {
  console.log(`Sandbox: ${sk.SB}`)
  await sk.build()
  await sk.startHub({ env: { FREILAUF_USAGE_CACHE_MS: '300', FREILAUF_BALANCE_CACHE_MS: '300' } })
  db = sk.db
  kontext = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  await datenAnlegen()
  console.log(`Hub: ${sk.base}   Chromium ${browser.version()}`)

  // ------------------------------------------------------------------ A1
  group('A1 — relative timestamps: hydrated, ticking, exact on hover')

  await check('a run started five minutes ago reads "5 minutes ago" and carries the exact time in its title', async () => {
    const p = await neueSeite(`/?repo=${repoId}`)
    const zelle = `tr[onclick*="${R_ALT}"] time.reltime`
    const text = (await p.textContent(zelle)).trim()
    isTrue(/^\d+ minutes ago$/.test(text), `relative text (${text})`)
    const titel = await p.getAttribute(zelle, 'title')
    isTrue(/\d{2}:\d{2}:\d{2}/.test(titel), `title carries the exact timestamp down to the second (${titel})`)
    sauber(p)
    await p.close()
  })

  await check('the cell counts on by itself without the page being reloaded', async () => {
    const p = await neueSeite(`/?repo=${repoId}`)
    const zelle = `tr[onclick*="${R_TICK}"] time.reltime`
    const erst = (await p.textContent(zelle)).trim()
    isTrue(/seconds ago$/.test(erst), `starts in seconds (${erst})`)
    await wartePage(p, ([sel, alt]) => document.querySelector(sel).textContent.trim() !== alt,
      [zelle, erst], 'the text to change on its own')
    const jetzt = (await p.textContent(zelle)).trim()
    isTrue(/seconds ago$/.test(jetzt), `still counting seconds (${jetzt})`)
    sauber(p)
    await p.close()
  })

  await check('a planned run reads forward: "in n minutes", not "n minutes ago"', async () => {
    // relTimeText is signed, like fmtRelativeTime on the server. Losing the sign
    // would make every waiting run look like it had already run.
    const p = await neueSeite(`/?repo=${repoId}`)
    const text = (await p.textContent(`tr[onclick*="${R_GEPLANT}"] time.reltime`)).trim()
    isTrue(/^in \d+ minutes$/.test(text), `forward-looking text (${text})`)
    sauber(p)
    await p.close()
  })

  await check('the relative-time tooltip follows the configured timezone', async () => {
    // 12:00 UTC on 2026-08-25 is 08:00 in New York (EDT, UTC-4). The tooltip is
    // re-rendered by hub.js from window.FREILAUF_TZ — it must read the configured
    // clock, not the browser machine's.
    const ur = db.prepare('SELECT started_at FROM runs WHERE id=?').get(R_ALT).started_at
    db.prepare("UPDATE runs SET started_at='2026-08-25 12:00:00' WHERE id=?").run(R_ALT)
    await postForm('/settings/save', { ui_timezone: 'America/New_York' })
    try {
      const p = await neueSeite(`/?repo=${repoId}`)
      const titel = await p.getAttribute(`tr[onclick*="${R_ALT}"] time.reltime`, 'title')
      contains(titel, '08:00', `title in New York time (${titel})`)
      sauber(p)
      await p.close()
    } finally {
      db.prepare('UPDATE runs SET started_at=? WHERE id=?').run(ur, R_ALT)
      await postForm('/settings/save', { ui_timezone: '' })
    }
  })

  // ------------------------------------------------------------------ A2
  group('A2 — the repo switcher in the header')

  await check('choosing another repo appends ?repo= and navigates there', async () => {
    const p = await neueSeite(`/?repo=${repoId}`)
    await p.selectOption('#repo-switch', String(repoId2))
    await p.waitForURL(new RegExp(`[?&]repo=${repoId2}$`), { timeout: 10_000 })
    equal(new URL(p.url()).pathname, '/', 'stays on the page one was standing on')
    sauber(p)
    await p.close()
  })

  await check('the chosen repo sticks: navigation keeps it until it is changed again', async () => {
    const p = await neueSeite(`/?repo=${repoId}`)
    // The very complaint this fixes: switch the repo, then walk the menu — the
    // choice used to fall back to the first repo on the next page.
    await p.selectOption('#repo-switch', String(repoId2))
    await p.waitForURL(new RegExp(`[?&]repo=${repoId2}$`), { timeout: 10_000 })
    // A context-less page: settings renders the switcher too and must keep the choice.
    await p.goto(sk.base + '/settings', { waitUntil: 'load' })
    equal(await p.$eval('#repo-switch', s => s.value), String(repoId2), 'settings keeps the chosen repo in the header')
    // A context page reached through the menu: agents must BE that repo now.
    await p.click('header nav a[href="/agents"]')
    await p.waitForURL(/\/agents$/, { timeout: 10_000 })
    equal(await p.$eval('#repo-switch', s => s.value), String(repoId2), 'agents keeps the chosen repo in the header')
    equal(await p.$eval('body', b => b.dataset.repo), String(repoId2), 'and the agents page really is that repo')
    equal(await p.$eval('#status-sidebar', a => a.dataset.repo), String(repoId2), 'the sidebar follows the same choice')
    sauber(p)
    await p.close()
  })

  await check('on a page that belongs to one repo the dropdown keeps the new choice', async () => {
    // A run detail page cannot become another repo's page — it reloads as
    // itself. Before this the dropdown snapped back to the run's repo and the
    // click read as if it had been swallowed.
    const p = await neueSeite(`/runs/${R_ALT}`)
    equal(await p.$eval('#repo-switch', s => s.value), String(repoId), 'starts on the run\'s repo')
    isFalse(await p.isVisible('.banner.other-repo'), 'and says nothing while the two agree')
    const ereignisse = []
    p.on('request', (r) => { if (r.url().includes('/api/events')) ereignisse.push(r.url()) })
    await p.selectOption('#repo-switch', String(repoId2))
    await p.waitForURL(new RegExp(`/runs/${R_ALT}\\?repo=${repoId2}$`), { timeout: 10_000 })
    equal(await p.$eval('#repo-switch', s => s.value), String(repoId2), 'after the reload it still shows what was picked')
    equal(await p.$eval('#status-sidebar', a => a.dataset.repo), String(repoId2), 'the sidebar follows it')
    // …while the page is still about this run: <body data-repo> is the live
    // channel's filter and must stay with the run whose events it wants.
    equal(await p.$eval('body', b => b.dataset.repo), String(repoId), 'the run is still the run')
    // Which is right and silent — so the page says it, with both names in it.
    isTrue(await p.isVisible('.banner.other-repo'), 'the note about the other repo is visible')
    const hinweis = await p.$eval('.banner.other-repo', el => el.textContent)
    contains(hinweis, 'browser-zwei', 'it names the repo that was picked')
    // And for that one stretch the stream is unfiltered: the detail wants this
    // run's repo, the sidebar counts the other one, and one filter cannot serve
    // both. Without it the sidebar would sit there stale.
    for (let i = 0; i < 100 && !ereignisse.length; i++) await p.waitForTimeout(50)
    isTrue(ereignisse.length > 0, 'the live channel opened')
    isFalse(ereignisse.some(u => u.includes('repo=')), 'the live channel listens to both repos while they differ')
    sauber(p)
    await p.close()
  })

  // ------------------------------------------------------------------
  // The sidebar is the one panel that is on every page, so the one panel that
  // has to be foldable — and the fold has to survive the page, otherwise one
  // closes it again on every navigation. The class sits on the SHELL and not on
  // the sidebar itself, because the live channel replaces #status-sidebar whole
  // and would carry a class on it away with the swap.
  group('The status sidebar folds away, and stays folded')

  await check('the toggle folds the readings away and remembers it across pages', async () => {
    const p = await neueSeite(`/?repo=${repoId}`)
    isTrue(await p.isVisible('#side-body'), 'open to begin with')
    equal(await p.$eval('#side-toggle', b => b.getAttribute('aria-expanded')), 'true', 'and says so to a screen reader')
    await p.click('#side-toggle')
    isFalse(await p.isVisible('#side-body'), 'folded away')
    equal(await p.$eval('#side-toggle', b => b.getAttribute('aria-expanded')), 'false', 'and says that too')
    equal(await p.evaluate(() => localStorage.getItem('freilauf.sidebar.open')), '0', 'the choice is written down')
    // Another page, same choice — that is the whole point of writing it down.
    await p.goto(sk.base + '/agents', { waitUntil: 'load' })
    isFalse(await p.isVisible('#side-body'), 'still folded on the next page')
    isTrue(await p.isVisible('#side-toggle'), 'but the way back is still reachable')
    await p.click('#side-toggle')
    isTrue(await p.isVisible('#side-body'), 'and opens again')
    equal(await p.evaluate(() => localStorage.getItem('freilauf.sidebar.open')), '1', 'which is written down as well')
    sauber(p)
    await p.close()
  })
  await check('a live update does not pop the folded sidebar back open', async () => {
    const p = await neueSeite(`/?repo=${repoId}`)
    await p.click('#side-toggle')
    isFalse(await p.isVisible('#side-body'), 'folded')
    // Mark the element that is standing there now — the live channel replaces
    // the whole aside, so the mark disappearing IS the proof of the swap.
    await p.evaluate(() => { document.getElementById('status-sidebar').dataset.vorher = '1' })
    // A real run event, from outside the browser, exactly like the watcher's.
    await laufStarten({ repo_id: repoId, prompt: 'a run while the sidebar is folded' })
    await wartePage(p, () => !document.getElementById('status-sidebar')?.dataset.vorher,
      null, 'the live channel to swap the sidebar')
    // The server knows nothing about the fold, so without hub.js re-applying it
    // after the swap the sidebar would stand open again.
    isFalse(await p.isVisible('#side-body'), 'still folded after the swap')
    equal(await p.$eval('#side-toggle', b => b.getAttribute('aria-expanded')), 'false', 'and still says so')
    sauber(p)
    await p.close()
  })

  // ------------------------------------------------------------------
  // The sidebar's statistics (subscription usage, provider balances) move on
  // their OWN clock: a long-running agent burns quota without firing a single
  // run event, and before the poll the panel sat frozen at page-load values.
  // The poll (window.FREILAUF_SIDEBAR_POLL_MS) plus the shortened server caches
  // (the sandbox hub starts with FREILAUF_USAGE_CACHE_MS=300) turn that minute into
  // seconds — the page itself behaves exactly as in production, only faster.
  group('The status sidebar statistics refresh on their own')

  await check('the Claude usage percentage is updated without a run event', async () => {
    const p = await neueSeite(`/?repo=${repoId}`, () => { window.FREILAUF_SIDEBAR_POLL_MS = 1500 })
    // The sandbox quota.json fixture starts at 1 % — read what the panel shows.
    const liest5h = () => p.$$eval('#usage-panel .quota', (qs) => {
      for (const q of qs) {
        const label = q.querySelector('.quota-label')
        if (label && label.textContent.trim() === '5h') return q.querySelector('.quota-pct')?.textContent.trim() ?? null
      }
      return null
    })
    const anfang = await liest5h()
    isTrue(anfang !== null, `the panel shows a Claude 5h percentage (${anfang})`)
    isTrue(anfang === '1 %', `and it is the fixture value (${anfang})`)
    // Change the source data. NO run event, NO page interaction — only the poll
    // may make this show up: the first poll after the change still serves the
    // cached panel while the refresh runs behind it, the next one shows the
    // new value.
    const quotaPfad = join(sk.SB, 'quota.json')
    writeFileSync(quotaPfad, JSON.stringify({
      five_hour: { used_percentage: 42, resets_at: 1800000000 }, seven_day_fable: { used_percentage: 0 },
    }))
    try {
      await wartePage(p, () => {
        for (const q of document.querySelectorAll('#usage-panel .quota')) {
          const label = q.querySelector('.quota-label')
          if (label && label.textContent.trim() === '5h')
            return /^42 %/.test(q.querySelector('.quota-pct')?.textContent ?? '')
        }
        return false
      }, null, 'the sidebar to show the new Claude usage')
      equal(await liest5h(), '42 %', 'the updated percentage is on screen')
    } finally {
      writeFileSync(quotaPfad, JSON.stringify({
        five_hour: { used_percentage: 1, resets_at: 1800000000 }, seven_day_fable: { used_percentage: 0 },
      }))
    }
    sauber(p)
    await p.close()
  })

  // ------------------------------------------------------------------
  // `label { display: block }` plus a field inline after the caption means every
  // row of a form starts at a different x, depending on how long the caption is.
  group('Forms: captions in one column, tall fields with the caption above')

  await check('every caption starts at the same x and its field at the same x', async () => {
    const p = await neueSeite(`/runs/new?repo=${repoId}`)
    const kanten = await p.$$eval('form[action="/runs/new"] > label:not(.chk)', (labels) => labels
      .filter(l => !l.hidden && !l.querySelector('textarea'))
      .map(l => {
        const feld = l.querySelector('input, select')
        return feld ? { links: Math.round(l.getBoundingClientRect().left), feld: Math.round(feld.getBoundingClientRect().left) } : null
      })
      .filter(Boolean))
    isTrue(kanten.length >= 3, `at least three captioned fields (${kanten.length})`)
    equal(new Set(kanten.map(k => k.links)).size, 1, 'all captions start at one x')
    equal(new Set(kanten.map(k => k.feld)).size, 1, 'and all fields start at one x')
    isTrue(kanten[0].feld > kanten[0].links, 'the field really stands beside its caption, not under it')
    sauber(p)
    await p.close()
  })
  await check('the prompt caption stands ABOVE its box, not beside its bottom edge', async () => {
    const p = await neueSeite(`/runs/new?repo=${repoId}`)
    const masse = await p.$eval('form[action="/runs/new"] label:has(textarea)', (l) => {
      const ta = l.querySelector('textarea')
      const lr = l.getBoundingClientRect(), tr = ta.getBoundingClientRect()
      // The caption is the label's own text, so its box starts where the label
      // does and the textarea has to begin BELOW that line.
      return { labelOben: Math.round(lr.top), feldOben: Math.round(tr.top), feldLinks: Math.round(tr.left),
        labelLinks: Math.round(lr.left), hoehe: Math.round(tr.height) }
    })
    isTrue(masse.hoehe > 100, `the box really is tall (${masse.hoehe}px) — that is what makes this matter`)
    isTrue(masse.feldOben > masse.labelOben, 'the box starts below the caption')
    equal(masse.feldLinks, masse.labelLinks, 'and uses the full width instead of standing in the second column')
    sauber(p)
    await p.close()
  })

  // ------------------------------------------------------------------ A3
  group('A3 — the schedule shows only the kind that was chosen')

  await check('every kind shows its own block, and "manual" shows none of them', async () => {
    const p = await neueSeite(`/agents/edit?repo=${repoId}`)
    for (const kind of ['woechentlich', 'einmalig', 'cron']) {
      await p.selectOption('#schedule-kind', kind)
      isTrue(await p.isVisible(`.zp[data-kind="${kind}"]`), `${kind}: its own block`)
      for (const anders of ['woechentlich', 'einmalig', 'cron'].filter(k => k !== kind)) {
        isFalse(await p.isVisible(`.zp[data-kind="${anders}"]`), `${kind}: ${anders} stays away`)
      }
    }
    await p.selectOption('#schedule-kind', 'manuell')
    for (const kind of ['woechentlich', 'einmalig', 'cron']) {
      isFalse(await p.isVisible(`.zp[data-kind="${kind}"]`), `manual: ${kind} hidden`)
    }
    sauber(p)
    await p.close()
  })

  await check('the anchor week only appears where an interval needs one', async () => {
    const p = await neueSeite(`/agents/edit?repo=${repoId}`)
    await p.selectOption('#schedule-kind', 'woechentlich')
    await p.selectOption('select[name=schedule_weeks]', '1')
    isFalse(await p.isVisible('input[name=schedule_anchor]'), 'every week: no anchor')
    await p.selectOption('select[name=schedule_weeks]', '2')
    isTrue(await p.isVisible('input[name=schedule_anchor]'), 'every second week: anchor')
    sauber(p)
    await p.close()
  })

  await check('the two weekly modes show one block each', async () => {
    const p = await neueSeite(`/agents/edit?repo=${repoId}`)
    await p.selectOption('#schedule-kind', 'woechentlich')
    isTrue(await p.isVisible('.zpm[data-mode="same"]'), 'the same times are the default')
    isFalse(await p.isVisible('.zpm[data-mode="per_day"]'), 'the per-day grid stays away')
    await p.check('input[name=schedule_mode][value="per_day"]')
    isTrue(await p.isVisible('.zpm[data-mode="per_day"]'), 'per-day grid')
    isFalse(await p.isVisible('.zpm[data-mode="same"]'), 'and the other one goes')
    equal(await p.locator('.day-times .day-row').count(), 7, 'one row per weekday, empty ones included')
    sauber(p)
    await p.close()
  })

  await check('a time is added an hour later, removed again, and the last one cannot go', async () => {
    const p = await neueSeite(`/agents/edit?repo=${repoId}`)
    await p.selectOption('#schedule-kind', 'woechentlich')
    const box = '.zpm[data-mode="same"] .times'
    equal(await p.locator(`${box} input[type=time]`).count(), 1, 'one time to start with')
    isFalse(await p.isVisible(`${box} .time-del`), 'and it carries no delete button')
    await p.click(`${box} .time-add`)
    equal(await p.locator(`${box} input[type=time]`).count(), 2, 'a second one')
    equal(await p.locator(`${box} input[type=time]`).nth(1).inputValue(), '07:00', 'an hour after the first')
    isTrue(await p.locator(`${box} .time-del`).first().isVisible(), 'now both can go')
    // A per-day row may become empty — that is how a weekday is switched off.
    await p.check('input[name=schedule_mode][value="per_day"]')
    const tag = '.day-times .day-row:nth-child(2) .times'
    await p.click(`${tag} .time-add`)
    equal(await p.locator(`${tag} input[type=time]`).count(), 1, 'Tuesday has a time')
    isTrue(await p.isVisible(`${tag} .time-del`), 'and it may be taken away again')
    await p.click(`${tag} .time-del`)
    equal(await p.locator(`${tag} input[type=time]`).count(), 0, 'the day is switched off')
    sauber(p)
    await p.close()
  })

  // ------------------------------------------------------------------ A4
  group('A4 — the planned start switches per fieldset, not per page')

  await check('the run form and the Quick-Run dialog do not switch each other', async () => {
    // The most important check of this group: the Quick-Run dialog sits in the
    // layout of EVERY page, so on /runs/new this block stands twice. Going back
    // to ids would silently switch the wrong one.
    const p = await neueSeite(`/runs/new?repo=${repoId}`)
    const zustaende = () => p.evaluate(() =>
      Array.from(document.querySelectorAll('select[data-start-switch]')).map(s => ({
        wert: s.value,
        bloecke: Object.fromEntries(Array.from(s.closest('fieldset').querySelectorAll('.st'))
          .map(b => [b.dataset.mode, b.hidden])),
      })))
    equal((await zustaende()).length, 2, 'the block really stands twice')

    await p.selectOption('form[action="/runs/new"] select[data-start-switch]', 'at')
    let z = await zustaende()
    equal(z[0].bloecke.at, false, 'the form shows its date block')
    equal(z[0].bloecke.in, true, 'and hides the others')
    equal(z[1].bloecke.at, true, 'the dialog stays exactly as it was')
    equal(z[1].wert, 'now', 'and keeps its own choice')

    await p.click('#qr-open')
    await p.selectOption('#qr-form select[data-start-switch]', 'idle')
    z = await zustaende()
    equal(z[1].bloecke.idle, false, 'now the dialog shows its idle block')
    equal(z[0].bloecke.at, false, 'and the form still shows the date one')
    equal(z[0].bloecke.idle, true, 'unswitched by the dialog')
    sauber(p)
    await p.close()
  })

  // ------------------------------------------------------------------ A5
  group('A5 — the branch rule explains itself, per repo')

  await check('the explanation that fits the repo is the visible one', async () => {
    // Repo 1 does not integrate, repo 2 does. Both explanations are in the
    // markup either way — CSS picks, so the static case needs no JavaScript.
    const aus = await neueSeite(`/runs/new?repo=${repoId}`)
    const feld = 'form[action="/runs/new"] fieldset.branch-choice'
    equal(await aus.$eval(feld, f => f.dataset.mergeMode), 'off', 'the repo that does not integrate says so')
    isTrue(await aus.isVisible(`${feld} [data-explain="off"]`), 'the off explanation is shown')
    isFalse(await aus.isVisible(`${feld} [data-explain="hub"]`), 'and the hub one is not')
    contains(await aus.textContent(`${feld} [data-explain="off"]`), 'throwaway',
      'off: "no branch" really does mean throwaway work')
    isFalse(await aus.isVisible(`${feld} [data-hub-only]`), 'and "keep on branch" means nothing here')
    sauber(aus)
    await aus.close()

    const an = await neueSeite(`/runs/new?repo=${repoId2}`)
    equal(await an.$eval(feld, f => f.dataset.mergeMode), 'hub', 'the integrating repo says so')
    isTrue(await an.isVisible(`${feld} [data-explain="hub"]`), 'the hub explanation is shown')
    isFalse(await an.isVisible(`${feld} [data-explain="off"]`), 'and the off one is not')
    contains(await an.textContent(`${feld} [data-explain="hub"]`), 'Freilauf merges',
      'hub: the hub merges it, whatever the rule is called')
    isTrue(await an.isVisible(`${feld} [data-hub-only]`), 'and "keep on branch" is offered')
    sauber(an)
    await an.close()
  })

  await check('switching repo inside the dialog switches the explanation with it', async () => {
    // The Quick-Run dialog is the ONE form that can change repo without
    // rebuilding the page — the header's switcher reloads. So this is the only
    // place the map on the fieldset is needed at all.
    const p = await neueSeite(`/?repo=${repoId}`)
    await p.click('#qr-open')
    // The dialog folds the branch rule away — it is the one of the three things
    // it asks for that is usually left as it is. Unfold it, or every visibility
    // check below would pass for the wrong reason.
    await p.evaluate(() => { document.querySelector('#qr-dialog details.qr-more').open = true })
    const feld = '#qr-form fieldset.branch-choice'
    equal(await p.$eval(feld, f => f.dataset.mergeMode), 'off', 'it opens on the repo one is looking at')
    isFalse(await p.isVisible(`${feld} [data-hub-only]`), 'no keep box yet')
    await p.selectOption('#qr-form select[name=repo_id]', String(repoId2))
    await wartePage(p, () => document.querySelector('#qr-form fieldset.branch-choice').dataset.mergeMode === 'hub',
      null, 'the fieldset to follow the repo')
    isTrue(await p.isVisible(`${feld} [data-explain="hub"]`), 'the hub explanation appears')
    isTrue(await p.isVisible(`${feld} [data-hub-only]`), 'and so does the keep box')
    await p.check(`${feld} input[name=keep_on_branch]`)
    await p.selectOption('#qr-form select[name=repo_id]', String(repoId))
    await wartePage(p, () => document.querySelector('#qr-form fieldset.branch-choice').dataset.mergeMode === 'off',
      null, 'and back again')
    // Hidden AND unticked: a box one cannot see must not still submit.
    equal(await p.$eval(`${feld} input[name=keep_on_branch]`, c => c.checked), false,
      'going back to a repo that does not integrate unticks it')
    sauber(p)
    await p.close()
  })

  group('A5b — the branch pattern only matters where a branch is wanted')

  await check('the pattern field follows the mode, scoped to its own form', async () => {
    const p = await neueSeite(`/runs/new?repo=${repoId}`)
    const formular_ = 'form[action="/runs/new"]'
    isFalse(await p.isVisible(`${formular_} [data-branch-pattern]`), 'mode "none": no pattern')
    await p.check(`${formular_} input[name=branch_mode][value=neu]`)
    isTrue(await p.isVisible(`${formular_} [data-branch-pattern]`), 'mode "new branch": pattern')
    equal(await p.$eval('#qr-form [data-branch-pattern]', el => el.hidden), true,
      'the dialog\'s own branch rule is untouched')
    await p.check(`${formular_} input[name=branch_mode][value=keiner]`)
    isFalse(await p.isVisible(`${formular_} [data-branch-pattern]`), 'back to none: gone again')
    sauber(p)
    await p.close()
  })

  // ------------------------------------------------------------------ A7
  group('A7 — the Quick-Run dialog starts a run without taking the page away')

  await check('it opens with the cursor in the task field', async () => {
    const p = await neueSeite(`/?repo=${repoId}`)
    equal(await p.$eval('#qr-dialog', d => d.open), false, 'closed to begin with')
    await p.click('#qr-open')
    equal(await p.$eval('#qr-dialog', d => d.open), true, 'open')
    equal(await p.evaluate(() => document.activeElement?.getAttribute('name')), 'prompt',
      'and the focus is where one types')
    sauber(p)
    await p.close()
  })

  await check('the favorite chosen last is the one offered next time', async () => {
    const p = await neueSeite(`/?repo=${repoId}`)
    await p.click('#qr-open')
    await p.selectOption('#qr-fav', String(FAV2))
    equal(await p.evaluate(() => localStorage.getItem('freilauf.quickrun.favorite')), String(FAV2),
      'remembered in localStorage')
    await p.reload({ waitUntil: 'load' })
    equal(await p.$eval('#qr-fav', s => s.value), String(FAV2), 'preselected after a reload')
    sauber(p)
    await p.close()
  })

  await check('a quick run starts, clears ONLY the task and says so in a toast with a link', async () => {
    const vorher = db.prepare('SELECT count(*) c FROM runs').get().c
    const p = await neueSeite(`/?repo=${repoId}`)
    await p.click('#qr-open')
    await p.selectOption('#qr-fav', String(FAV1))
    await p.fill('#qr-form textarea[name=prompt]', 'Browser-Quickrun: tu etwas')
    await p.click('#qr-form button[type=submit]')
    // The dialog closes on the ANSWER, and the answer comes back while the hub
    // is still building the worktree — so the first toast is the pending one.
    await p.waitForSelector('#freilauf-toasts .toast.pending', { timeout: 15_000 })
    contains(await p.textContent('#freilauf-toasts .toast.pending span:not(.spin)'), 'Starting',
      'and it says the start is under way')

    equal(await p.$eval('#qr-dialog', d => d.open), false, 'the dialog closed itself')
    equal(await p.$eval('#qr-form textarea[name=prompt]', el => el.value), '', 'the task is cleared')
    equal(await p.$eval('#qr-fav', s => s.value), String(FAV1), 'the favorite stands as the next run\'s setup')
    equal(await p.$eval('#qr-form select[name=repo_id]', s => s.value), String(repoId), 'the repo stands')
    equal(await p.$eval('#qr-form input[name=branch_mode]:checked', r => r.value), 'keiner', 'the branch rule stands')
    equal(await p.$eval('#qr-form select[data-start-switch]', s => s.value), 'now', 'the start time stands')
    equal(new URL(p.url()).pathname, '/', 'and the page one started from is still the page one is on')

    // The same toast then turns into the outcome, in place: one run, one line.
    await p.waitForSelector('#freilauf-toasts .toast.ok', { timeout: 30_000 })
    equal(await p.$$eval('#freilauf-toasts .toast', els => els.length), 1,
      'the outcome replaced the pending toast instead of stacking below it')
    contains(await p.textContent('#freilauf-toasts .toast span:not(.spin)'), 'Run started',
      'the toast says what happened')
    const href = await p.$eval('#freilauf-toasts .toast a', a => a.getAttribute('href'))
    isTrue(/^\/runs\/[0-9a-f-]{36}$/.test(href), `with a link to the run (${href})`)
    equal(db.prepare('SELECT count(*) c FROM runs').get().c, vorher + 1, 'exactly one run was created')
    const neu = laufRow(href.slice('/runs/'.length))
    if (neu?.tmux_session) sk.sessions.add(neu.tmux_session)
    equal(neu.status, 'running', 'and it really runs')
    sauber(p)
    await p.close()
  })

  await check('a refused quick run stands readable in the dialog instead of vanishing', async () => {
    const p = await neueSeite(`/?repo=${repoId}`)
    await p.click('#qr-open')
    await p.evaluate(() => { document.querySelector('details.qr-more').open = true })
    await p.check('#qr-form input[name=branch_mode][value=neu]')      // a new branch without a pattern
    await p.fill('#qr-form textarea[name=prompt]', 'Browser-Quickrun: kaputt')
    await p.click('#qr-form button[type=submit]')
    await p.waitForSelector('#qr-error:not([hidden])', { timeout: 15_000 })
    isTrue((await p.textContent('#qr-error')).trim().length > 0, 'with the reason from the server')
    equal(await p.$eval('#qr-dialog', d => d.open), true, 'the dialog stays open so it can be corrected')
    equal(await p.$eval('#qr-form button[type=submit]', b => b.disabled), false, 'and can be sent again')
    sauber(p)
    await p.close()
  })

  await check('"More settings" opens the FULL run form in a new window with the dialog\'s state', async () => {
    const p = await neueSeite(`/?repo=${repoId}`)
    await p.click('#qr-open')
    await p.selectOption('#qr-fav', String(FAV1))
    await p.fill('#qr-form textarea[name=prompt]', 'Browser-Quickrun: doch mehr Einstellungen')
    await p.evaluate(() => { document.querySelector('#qr-dialog details.qr-more').open = true })
    await p.check('#qr-form input[name=branch_mode][value=neu]')
    await p.fill('#qr-form input[name=branch_pattern]', 'aufschub/{datum}')
    await p.selectOption('#qr-form select[data-start-switch]', 'in')
    await p.fill('#qr-form input[name=start_in_minutes]', '45')

    const popupFehler = []
    const [neu] = await Promise.all([
      p.waitForEvent('popup'),
      p.click('#qr-form [data-qr-full]'),
    ])
    neu.on('pageerror', (err) => popupFehler.push(`pageerror: ${err.message}`))
    neu.on('console', (m) => {
      if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) popupFehler.push(`console: ${m.text()}`)
    })
    await neu.waitForLoadState('load')
    equal(await p.$eval('#qr-dialog', d => d.open), false, 'the dialog closes on the way out')

    const u = new URL(neu.url())
    equal(u.pathname, '/runs/new', 'a full run form opens')
    equal(u.searchParams.get('repo'), String(repoId), 'for the repo chosen in the dialog')
    equal(u.searchParams.get('favorite'), String(FAV1), 'carrying the favorite as its template')

    // The dialog's own fields, parked in sessionStorage and restored onto the
    // MAIN form — the dialog on that page has them empty, the two must not mix.
    equal(await neu.$eval('form.settings textarea[name=prompt]', el => el.value),
      'Browser-Quickrun: doch mehr Einstellungen', 'the task survives')
    equal(await neu.$eval('form.settings input[name=branch_mode]:checked', el => el.value), 'neu', 'the branch rule survives')
    equal(await neu.$eval('form.settings input[name=branch_pattern]', el => el.value),
      'aufschub/{datum}', 'with its pattern')
    equal(await neu.$eval('form.settings [data-branch-pattern]', el => el.hidden), false,
      'the pattern is visible again — the branch sync saw the restored value')
    equal(await neu.$eval('form.settings select[data-start-switch]', el => el.value), 'in', 'the start time survives')
    equal(await neu.$eval('form.settings .st[data-mode="in"]', el => el.hidden), false,
      'and its block is shown, not the default "now"')

    // The favorite's setup is the form's TEMPLATE, not something the dialog typed.
    equal(await neu.$eval('form.settings select[name=harness]', el => el.value), 'claude',
      'the favorite\'s coding agent')
    equal(await neu.$eval('form.settings #model', el => el.value), 'claude-opus-5', 'and its model')

    equal(await neu.evaluate(() => sessionStorage.getItem('freilauf:qrfull')), null,
      'the parked state is consumed on the way in')
    equal(await p.evaluate(() => sessionStorage.getItem('freilauf:qrfull')), null,
      'and not left over in the opener either')

    isTrue(popupFehler.length === 0, `the new window's console stays quiet (${popupFehler.join(' | ')})`)
    sauber(p)
    await p.close()
    await neu.close()
  })

  // ------------------------------------------------------------------ A8
  group('A8 — renaming a run in place')

  await check('the pencil stays out of reach until the row is hovered — but the keyboard finds it', async () => {
    const p = await neueSeite(`/?repo=${repoId}`)
    const stift = `tr[onclick*="${R_ALT}"] [data-title-edit]`
    equal(await p.$eval(stift, b => getComputedStyle(b).opacity), '0', 'invisible at rest')
    await p.hover(`tr[onclick*="${R_ALT}"] .title-cell`)
    await wartePage(p, (sel) => getComputedStyle(document.querySelector(sel)).opacity === '1',
      stift, 'the pencil to appear on hover')
    await p.mouse.move(0, 0)
    await p.$eval(stift, b => b.focus())
    // WAIT for it, do not sample it: the pencil carries `transition: opacity .1s`,
    // so moving the mouse away starts a fade-out that focusing immediately turns
    // back around — and reading getComputedStyle in that moment returns whatever
    // the animation happens to be at (measured: 0.424233, and red maybe one run
    // in four). The assertion is unchanged; only the moment it is read is.
    await wartePage(p, (sel) => getComputedStyle(document.querySelector(sel)).opacity === '1',
      stift, 'the pencil to appear on focus alone')
    sauber(p)
    await p.close()
  })

  await check('Enter saves — and sends exactly one request, not two', async () => {
    // input.disabled takes the focus and thereby fires blur, which lands in
    // speichern() a second time. Without the 'laeuft' guard every rename would
    // go out twice.
    const p = await neueSeite(`/?repo=${repoId}`)
    const anfragen = []
    p.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/title')) anfragen.push(r.url()) })
    const zeile = `tr[onclick*="${R_ALT}"]`
    await p.click(`${zeile} [data-title-edit]`)
    await p.waitForSelector(`${zeile} input.title-input`)
    equal(await p.$eval(`${zeile} input.title-input`, i => i.maxLength), 80, 'the input is capped at 80')
    await p.fill(`${zeile} input.title-input`, 'Von Hand benannt')
    await p.keyboard.press('Enter')
    await wartePage(p, (sel) => document.querySelector(sel)?.textContent.trim() === 'Von Hand benannt',
      `${zeile} [data-title-text]`, 'the new title to stand in the row')
    equal(anfragen.length, 1, 'one POST /api/runs/<id>/title, no double send')
    equal(laufRow(R_ALT).title, 'Von Hand benannt', 'and it is what the database holds')
    equal(await p.$$eval(`${zeile} input.title-input`, els => els.length), 0, 'the input made way for the link again')
    sauber(p)
    await p.close()
  })

  await check('Escape throws the change away without asking the server', async () => {
    const p = await neueSeite(`/?repo=${repoId}`)
    const anfragen = []
    p.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/title')) anfragen.push(r.url()) })
    const zeile = `tr[onclick*="${R_ALT}"]`
    await p.click(`${zeile} [data-title-edit]`)
    await p.fill(`${zeile} input.title-input`, 'Weggeworfen')
    await p.keyboard.press('Escape')
    await wartePage(p, (sel) => document.querySelectorAll(sel).length === 0,
      `${zeile} input.title-input`, 'the input to close')
    equal((await p.textContent(`${zeile} [data-title-text]`)).trim(), 'Von Hand benannt', 'the old title stayed')
    equal(anfragen.length, 0, 'and nothing was sent')
    equal(laufRow(R_ALT).title, 'Von Hand benannt', 'the database is untouched')
    sauber(p)
    await p.close()
  })

  await check('on the detail page the browser tab is renamed along with the run', async () => {
    const p = await neueSeite(`/runs/${R_ALT}`)
    await p.click('h2 [data-title-edit]')
    await p.fill('h2 input.title-input', 'Auf der Detailseite benannt')
    await p.keyboard.press('Enter')
    await wartePage(p, () => document.title === 'Freilauf — Auf der Detailseite benannt',
      null, 'document.title to follow')
    equal(laufRow(R_ALT).title, 'Auf der Detailseite benannt', 'and the run carries the name')
    sauber(p)
    await p.close()
  })

  // ------------------------------------------------------------------ A9
  group('A9 — a trip to the flow editor does not cost what was typed')

  await check('the flow links carry the way back, and the form comes back with it', async () => {
    const zurueck = `/agents/edit?repo=${repoId}`
    const p = await neueSeite(zurueck)
    // Pin the coding agent first and let its cascade settle: switching it clears
    // model and effort by design, so typing into them before that is over would
    // be testing the race, not the parking.
    await p.selectOption('select[name=harness]', 'claude')
    await wartePage(p, () => document.querySelectorAll('#effort option').length > 1, null,
      'the effort levels to arrive')
    await p.waitForTimeout(500)

    await p.fill('input[name=name]', 'geparkter-agent')
    await p.fill('textarea[name=prompt]', 'Dieser Text darf den Ausflug nicht kosten.')
    await p.fill('input[name=expected_minutes]', '77')
    await p.fill('#model', 'claude-opus-5')
    await p.selectOption('#effort', 'high')
    await p.check('input[name=branch_mode][value=neu]')
    await p.fill('input[name=branch_pattern]', 'agent/browser/{datum}')
    await p.check(`fieldset.flows-attach input[name=flows][value="${FLOWID}"]`)
    await p.uncheck('input[name=active]')      // deliberately OFF — and it must stay off

    const link = await p.$eval('fieldset.flows-attach p a[href^="/flows"]', a => a.getAttribute('href'))
    equal(new URL(link, 'http://x').searchParams.get('back'), zurueck, 'the link knows the way back')

    await p.click('fieldset.flows-attach p a[href^="/flows"]')
    await p.waitForURL(/\/flows\/edit/, { timeout: 10_000 })
    // The editor's Back button goes exactly there — a fresh load, which is what
    // restoreForm() is for.
    await p.goto(sk.base + zurueck, { waitUntil: 'load' })

    equal(await p.$eval('input[name=name]', el => el.value), 'geparkter-agent', 'name')
    equal(await p.$eval('textarea[name=prompt]', el => el.value), 'Dieser Text darf den Ausflug nicht kosten.', 'task')
    equal(await p.$eval('input[name=expected_minutes]', el => el.value), '77', 'expected duration')
    equal(await p.$eval('#model', el => el.value), 'claude-opus-5', 'model')
    equal(await p.$eval('input[name=branch_mode]:checked', el => el.value), 'neu', 'branch mode')
    equal(await p.$eval('input[name=branch_pattern]', el => el.value), 'agent/browser/{datum}', 'branch pattern')
    equal(await p.$eval(`fieldset.flows-attach input[name=flows][value="${FLOWID}"]`, el => el.checked), true,
      'the ticked flow is ticked again')
    // The one that says the most: an unchecked box is NOT in a FormData, and
    // "absent" has to mean "was not ticked" — not "leave it as the server sent it",
    // which for this box is checked.
    equal(await p.$eval('input[name=active]', el => el.checked), false,
      'and the box left unticked comes back unticked')
    // data-gewaehlt is the memory between the restore and the fetch that fills
    // the <select> afterwards — the most fragile seam in the file.
    await wartePage(p, () => document.getElementById('effort')?.value === 'high', null,
      'the asynchronously filled effort select to carry the choice again')
    equal(await p.$eval('#effort', el => el.dataset.gewaehlt), 'high', 'through data-gewaehlt')
    sauber(p)
    await p.close()
  })

  await check('coming back from a freshly built flow ticks it and cleans the URL', async () => {
    const p = await neueSeite(`/agents/edit?repo=${repoId}&flow=${FLOWID}`)
    equal(await p.$eval(`fieldset.flows-attach input[name=flows][value="${FLOWID}"]`, el => el.checked), true,
      'the new flow is attached right away — that is what the trip was for')
    isFalse(new URL(p.url()).searchParams.has('flow'), 'and the parameter is gone from the address bar')
    sauber(p)
    await p.close()
  })

  await check('the trigger editor: "run merged" asks for a repo, the other kinds do not', async () => {
    // The root editor is the one panel of the designer that is ours from top to
    // bottom, and its newest branch is a select that appears only for one
    // trigger kind. That is the silent breakage this suite exists for: no
    // exception, just a filter nobody can set.
    const p = await neueSeite(`/flows/edit?id=${FLOWID}`)
    await p.waitForSelector('#trigger-kind', { timeout: 10_000 })
    isFalse(await p.$('#trigger-repo'), 'a "run finished" flow shows the agent list, not a repo')
    await p.selectOption('#trigger-kind', 'run_merged')
    await p.waitForSelector('#trigger-repo', { timeout: 10_000 })
    const optionen = await p.$$eval('#trigger-repo option', o => o.map(x => x.textContent.trim()))
    contains(optionen.join('|'), 'all repos', 'the default is every repo')
    contains(optionen.join('|'), 'browser', 'and the repos of this hub are offered')
    await p.selectOption('#trigger-repo', String(repoId))
    await p.selectOption('#trigger-kind', 'cron')
    isFalse(await p.$('#trigger-repo'), 'a schedule has no repo filter — the block really goes away again')
    sauber(p)
    await p.close()
  })

  // ------------------------------------------------------------------ A10
  group('A10 — the cascade: coding agent → provider → model → effort')

  await check('a subscription coding agent shows no provider, but its models and its effort levels', async () => {
    const p = await neueSeite(`/runs/new?repo=${repoId}`)
    await p.selectOption('select[name=harness]', 'claude')
    await wartePage(p, () => document.getElementById('prov-label').hidden === true, null,
      'the provider label to disappear for claude')
    await wartePage(p, () => document.querySelectorAll('#modelle option').length > 0, null,
      'the model list to arrive')
    equal(await p.$eval('#prov', s => s.value), '', 'and no provider is set')
    await wartePage(p, () => document.getElementById('effort-label').hidden === false, null,
      'the effort field to appear where levels exist')
    isTrue(await p.$$eval('#effort option', o => o.length) > 1, 'with its levels')
    sauber(p)
    await p.close()
  })

  await check('switching the coding agent REPLACES provider, model and effort instead of carrying them over', async () => {
    const p = await neueSeite(`/runs/new?repo=${repoId}`)
    await p.selectOption('select[name=harness]', 'claude')
    await wartePage(p, () => document.getElementById('effort-label').hidden === false, null, 'claude to be ready')
    await p.fill('#model', 'claude-opus-5')
    await p.selectOption('#effort', 'high')

    await p.selectOption('select[name=harness]', 'opencode')
    await wartePage(p, () => document.getElementById('prov-label').hidden === false, null,
      'the provider label to appear for a keyed coding agent')
    isFalse((await p.$eval('#model', el => el.value)) === 'claude-opus-5',
      'a claude model slug is not carried into opencode')
    equal(await p.$eval('#effort', s => s.value), '', 'and neither is the effort level')
    const provider = await p.$$eval('#prov option', o => o.map(x => x.value))
    isTrue(provider.includes('opencode-zen'), `the providers this coding agent really has here (${provider.join(',')})`)
    sauber(p)
    await p.close()
  })

  await check('the cascade runs on the Merge settings page too — same block, same ids', async () => {
    // The conflict resolver's setup is runSetupFields(), the very block the run
    // form embeds. It has a page of its own for exactly one reason: #prov,
    // #model and #effort may exist once per page, and hub.js drives them by id.
    const p = await neueSeite('/settings/merge')
    await p.selectOption('select[name=harness]', 'claude')
    await wartePage(p, () => document.getElementById('prov-label').hidden === true, null,
      'the provider label to disappear for claude')
    await wartePage(p, () => document.querySelectorAll('#modelle option').length > 0, null,
      'the model list to arrive on this page as well')
    await wartePage(p, () => document.getElementById('effort-label').hidden === false, null,
      'and the effort field to appear')
    sauber(p)
    await p.close()
  })

  await check('the effort field hides itself where the combination knows no levels', async () => {
    // Hiding instead of graying out: with opencode an invalid level fizzles
    // silently, so a field without effect is worse than none.
    const p = await neueSeite(`/runs/new?repo=${repoId}`)
    await p.selectOption('select[name=harness]', 'opencode')
    await wartePage(p, () => document.getElementById('prov-label').hidden === false, null, 'opencode to be ready')
    await p.fill('#model', 'gibtsnicht/quatsch')
    await wartePage(p, () => document.getElementById('effort-label').hidden === true, null,
      'the effort field to disappear for a model nobody knows')
    isFalse(await p.isVisible('#effort'), 'really gone from the page, not merely marked')
    sauber(p)
    await p.close()
  })

  await check('the OpenRouter routing block belongs to opencode + openrouter and to nothing else', async () => {
    const p = await neueSeite(`/runs/new?repo=${repoId}`)
    await p.selectOption('select[name=harness]', 'opencode')
    await wartePage(p, () => document.getElementById('prov-label').hidden === false, null, 'opencode to be ready')
    await p.selectOption('#prov', 'opencode-zen')
    equal(await p.$eval('#or-routing', el => el.hidden), true, 'opencode + Zen: no serving provider to pass through')
    // This sandbox has no OpenRouter key, so the provider list cannot contain
    // openrouter — the option is put in the way ladeProvider() would have. What
    // is under test is the rule in syncRouting(), not where the option came from.
    await p.evaluate(() => {
      const s = document.getElementById('prov')
      const o = document.createElement('option')
      o.value = 'openrouter'; o.textContent = 'OpenRouter'
      s.append(o); s.value = 'openrouter'
      s.dispatchEvent(new Event('change'))
    })
    await wartePage(p, () => document.getElementById('or-routing').hidden === false, null,
      'the routing block to appear for opencode + openrouter')
    await p.selectOption('select[name=harness]', 'claude')
    await wartePage(p, () => document.getElementById('or-routing').hidden === true, null,
      'and to disappear again for a coding agent that cannot pass it through')
    sauber(p)
    await p.close()
  })

  await check('a form that OPENS with OpenRouter already selected shows the routing block at once', async () => {
    // The regression this pins: ladeProvider() restores the pre-selected
    // provider programmatically — and a programmatic assignment fires no
    // 'change' event, so syncRouting() never ran. A favorite template or an
    // agent's stored setup opened the form with the block hidden until the
    // operator re-picked the model they had already picked. Both halves of the
    // page are intercepted: the server-rendered preselection is set the way
    // the server really renders it for a template (data-gewaehlt, harness
    // selected), and /api/providers is patched because this sandbox has no
    // OpenRouter key — what is under test is hub.js's init path, not the key.
    const p = await neueSeite(null)
    await p.route('**/api/providers?*', async (route) => {
      const j = await (await route.fetch()).json()
      if (!j.subscription && !j.provider.some(x => x.id === 'openrouter')) {
        j.provider = [{ id: 'openrouter', label: 'OpenRouter' }, ...j.provider]
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(j) })
    })
    await p.route('**/api/models*', route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, models: [{ id: 'z-ai/glm-5.3-flash', name: 'GLM', tools: true }] }),
    }))
    await p.route('**/runs/new*', async (route) => {
      const antwort = await route.fetch()
      const html = (await antwort.text())
        .replace(/id="prov" data-gewaehlt="[^"]*"/, 'id="prov" data-gewaehlt="openrouter"')
        .replace(/(<select name="harness">)([\s\S]*?)(<\/select>)/, (_m, auf, innen, zu) =>
          auf + innen
            .replace(/ selected/g, '')
            .replace(/<option value="opencode"/, '<option value="opencode" selected') + zu)
      await route.fulfill({ response: antwort, body: html, contentType: 'text/html; charset=utf-8' })
    })
    await p.goto(sk.base + `/runs/new?repo=${repoId}`, { waitUntil: 'load' })
    isTrue(await p.$eval('select[name=harness]', s => s.value === 'opencode'), 'the page opens on opencode, preselected by the template')
    await wartePage(p, () => document.getElementById('or-routing').hidden === false, null,
      'the routing block to be visible without a single interaction')
    isTrue(await p.$eval('#prov', s => s.value === 'openrouter'), 'and the provider really is the pre-selected OpenRouter')
    sauber(p)
    await p.close()
  })

  await check('the goal belongs to the coding agent that knows one — hidden means not submitted', async () => {
    // A hidden field that still submits is a text the operator cannot see and
    // cannot correct: switching the coding agent would silently send along a
    // condition meant for claude. So hiding and disabling are one move.
    const p = await neueSeite(`/runs/new?repo=${repoId}`)
    await p.selectOption('select[name=harness]', 'claude')
    await wartePage(p, () => document.getElementById('goal-block').hidden === false, null,
      'the goal block to be there for claude')
    // Folded away: it is optional, and a form should not open with a field most
    // runs leave empty. One click is what a goal costs.
    isFalse(await p.$eval('#goal-block', el => el.open), 'and folded, because most runs have none')
    await p.click('#goal-block summary')
    await p.fill('#goal-block textarea', 'all tests are green')
    await p.selectOption('select[name=harness]', 'opencode')
    await wartePage(p, () => document.getElementById('goal-block').hidden === true, null,
      'and to disappear for a coding agent without a /goal')
    isTrue(await p.$eval('#goal-block textarea', el => el.disabled), 'the field is disabled, so nothing is submitted')
    await p.selectOption('select[name=harness]', 'claude')
    await wartePage(p, () => document.getElementById('goal-block').hidden === false, null, 'and comes back')
    equal(await p.$eval('#goal-block textarea', el => el.value), 'all tests are green',
      'with what was typed — switching back and forth does not cost it')
    sauber(p)
    await p.close()
  })

  // ------------------------------------------------------------------ A13
  group('A13 — the sessions page: filter, selection, non-blocking ending')

  await check('a running agent\'s row is out of reach until it is asked for', async () => {
    const p = await neueSeite('/sessions')
    const laufend = `tr[data-session="${laufRow(R_LIVE).tmux_session}"]`
    equal(await p.$eval('#sess-show-running', c => c.checked), false, 'the switch starts off')
    equal(await p.$eval(laufend, tr => tr.hidden), true, 'so the running row is hidden')
    isFalse(await p.$eval('#sess-hidden', el => el.hidden), 'and the page says how many are hidden')
    isTrue(/\d+/.test(await p.textContent('#sess-hidden')), 'with the number in it')

    await p.check('#sess-show-running')
    equal(await p.$eval(laufend, tr => tr.hidden), false, 'switched on it is there')
    await p.reload({ waitUntil: 'load' })
    equal(await p.$eval('#sess-show-running', c => c.checked), true, 'and the choice survives a reload')
    equal(await p.$eval(laufend, tr => tr.hidden), false, 'row still visible')
    sauber(p)
    await p.close()
  })

  await check('"select all" only touches rows one can actually see', async () => {
    const p = await neueSeite('/sessions')
    await p.uncheck('#sess-show-running')     // running rows out of reach again
    const laufend = `tr[data-session="${laufRow(R_LIVE).tmux_session}"]`
    await p.check('#sess-all')
    equal(await p.$eval(`${laufend} .sess-pick`, b => b.checked), false,
      'the hidden row is not selected — one may not end what is not on screen')
    const gewaehlt = await p.$$eval('tbody tr[data-session]', trs =>
      trs.filter(tr => !tr.hidden && tr.querySelector('.sess-pick')?.checked).length)
    isTrue(gewaehlt > 0, 'the visible ones are')
    contains(await p.textContent('#sess-kill-selected'), `(${gewaehlt})`, 'and the button carries the number')
    sauber(p)
    await p.close()
  })

  await check('a click marks its row in the same tick and lets the request go in the background', async () => {
    const p = await neueSeite('/sessions')
    const name = laufRow(R_ENDE).tmux_session
    const zeile = `tr[data-session="${name}"]`
    equal(await p.$eval(zeile, tr => tr.dataset.running), '0', 'the run behind it is over')
    // Everything in one evaluate: whatever is true right after the click happened
    // without waiting for the server — that is the whole design of this page.
    const sofort = await p.evaluate((sel) => {
      document.querySelector(`${sel} .sess-kill`).click()
      const tr = document.querySelector(sel)
      return {
        ending: tr.classList.contains('ending'),
        text: tr.querySelector('.sess-state').textContent,
        knopfAus: tr.querySelector('.sess-kill').disabled,
      }
    }, zeile)
    isTrue(sofort.ending, 'the row is marked "ending" straight away')
    contains(sofort.text, 'ending', 'and says so')
    isTrue(sofort.knopfAus, 'its button cannot be pressed twice')
    await wartePage(p, (sel) => document.querySelector(sel).classList.contains('gone'), zeile,
      'the row to be struck through once the server confirms')
    equal(await p.$eval(zeile, tr => tr.classList.contains('ending')), false, 'the in-between state is over')
    sauber(p)
    await p.close()
  })

  // ------------------------------------------------------------------ A15
  group('A15 — the "Edit this run" card')

  await check('a running run offers only its expected duration', async () => {
    const p = await neueSeite(`/runs/${R_LIVE}`)
    await p.click('#run-edit summary')
    equal(await p.$eval('#run-edit input[name=expected_minutes]', el => el.value), '45', 'the duration input is prefilled')
    equal(await p.$$eval('#run-edit textarea[name=prompt]', els => els.length), 0, 'no prompt textarea for a started run')
    equal(await p.$$eval('#run-edit select[name=repo_id]', els => els.length), 0, 'no repo select for a started run')
    equal(await p.$$eval('#run-edit select[name=start_mode]', els => els.length), 0, 'no start-time block for a started run')
    equal(await p.$$eval('#run-edit input[name=branch_mode]', els => els.length), 0, 'no branch rule for a started run')
    sauber(p)
    await p.close()
  })

  await check('a scheduled run offers prompt, repo, branch and its start time too, prefilled', async () => {
    const p = await neueSeite(`/runs/${R_GEPLANT}`)
    await p.click('#run-edit summary')
    equal(await p.$eval('#run-edit textarea[name=prompt]', el => el.value), 'Browser-Lauf geplant', 'the prompt is prefilled')
    isTrue((await p.$$eval('#run-edit select[name=repo_id] option', els => els.length)) >= 2, 'both repos are offered')
    equal(await p.$eval('#run-edit select[name=repo_id]', el => el.value), String(repoId), 'the current repo is selected')
    equal(await p.$eval('#run-edit select[name=start_mode]', el => el.value), 'at', 'the start kind is prefilled')
    isTrue(await p.$eval('#run-edit input[name=start_at]', el => el.value !== ''), 'the date-time is prefilled')
    equal(await p.$eval('#run-edit input[name=branch_mode][value=keiner]', el => el.checked), true, 'the branch rule is prefilled')
    // The branch rule reacts INSIDE the card too (it is a swap-in-able block).
    equal(await p.$eval('#run-edit [data-branch-pattern]', el => el.hidden), true, 'no pattern for "no branch"')
    await p.click('#run-edit input[name=branch_mode][value=neu]')
    equal(await p.$eval('#run-edit [data-branch-pattern]', el => el.hidden), false, 'picking a branch reveals the pattern')
    // The start-switch works INSIDE the card — and must not touch the Quick-Run
    // dialog that sits in every page's layout (the same fieldset scoping A4
    // guards on the run form).
    await p.selectOption('#run-edit select[name=start_mode]', 'idle')
    equal(await p.$eval('#run-edit .st[data-mode="at"]', el => el.hidden), true, 'the card hides its date block')
    equal(await p.$eval('#run-edit .st[data-mode="idle"]', el => el.hidden), false, 'and shows the idle hint')
    equal(await p.$eval('#qr-form select[data-start-switch]', el => el.value), 'now', 'the dialog keeps its own choice')
    equal(await p.$eval('#qr-form .st[data-mode="at"]', el => el.hidden), true, 'and the dialog stays untouched')
    sauber(p)
    await p.close()
  })

  await check('an edit in the card survives the live channel, then lands', async () => {
    const p = await neueSeite(`/runs/${R_GEPLANT}`)
    await p.click('#run-edit summary')
    await p.focus('#run-edit textarea[name=prompt]')
    // Change the run from OUTSIDE while the operator is typing: the fragment
    // arrives, but must not swap the card under the focused textarea — the
    // half-written prompt lives only in the DOM.
    await postForm(`/api/runs/${R_GEPLANT}/edit`, { expected_minutes: '33' })
    await p.waitForTimeout(700)
    const noch = await p.evaluate(() => {
      const a = document.activeElement
      return a && a.name === 'prompt' && !!a.closest('#run-edit')
    })
    isTrue(noch, 'the half-typed prompt is still there, still focused')
    equal(await p.$eval('#run-edit input[name=expected_minutes]', el => el.value), '45', 'the card was NOT swapped')
    // Blur and change again: now the swap is allowed and lands.
    await p.evaluate(() => document.activeElement.blur())
    await postForm(`/api/runs/${R_GEPLANT}/edit`, { expected_minutes: '44' })
    await wartePage(p, () => (document.querySelector('#run-edit input[name=expected_minutes]')?.value) === '44',
      null, 'the card to carry the new duration after the swap')
    sauber(p)
    await p.close()
  })

  // ------------------------------------------------------------------ A16
  group('A16 — the collapsible prompt on the detail page')

  await check('the prompt block sits between title and chips, folded away, and unfolds', async () => {
    const p = await neueSeite(`/runs/${R_LIVE}`)
    const karte = await p.$('#run-prompt')
    isTrue(!!karte, 'the prompt block exists')
    equal(await p.$eval('#run-prompt', el => el.open), false, 'collapsed by default')
    // Position: after the title, before the fact chips — "weit oben".
    const oben = await p.evaluate(() => {
      const reihe = [...document.querySelectorAll('#run-head, #run-prompt, ul.chips')]
      return reihe.map(el => el.id || 'chips').join(',')
    })
    equal(oben, 'run-head,run-prompt,chips', 'title → prompt → chips')
    contains(await p.textContent('#run-prompt pre'), 'Browser-Lauf laeuft', 'the prompt text is inside')
    await p.click('#run-prompt summary')
    equal(await p.$eval('#run-prompt', el => el.open), true, 'and unfolds on the summary click')
    sauber(p)
    await p.close()
  })

  // ------------------------------------------------------------------ A14
  group('A14 — the terminal')

  await check('without a session there is a sentence, not a black box', async () => {
    const p = await neueSeite(`/runs/${R_OHNE_SESSION}`)
    equal(await p.$eval('#term', el => el.dataset.session), '0', 'the page says there is none')
    contains(await p.textContent('#term'), 'No tmux session', 'and the box says it in words')
    isTrue(await p.$eval('#term', el => el.classList.contains('dim')), 'toned down')
    equal(await p.$$eval('#term .xterm', els => els.length), 0, 'no terminal was built at all')
    sauber(p)
    await p.close()
  })

  await check('with a live session xterm builds up and the session speaks', async () => {
    const p = await neueSeite(`/runs/${R_LIVE}`)
    equal(await p.$eval('#term', el => el.dataset.session), '1', 'session there')
    equal(await p.$eval('#term', el => el.dataset.live), '1', 'and write access, because the run is live')
    await p.waitForSelector('#term .xterm-screen', { timeout: 15_000 })
    // What stands there is this run's own prompt — proof that the socket is
    // attached to THIS session and not merely open.
    await wartePage(p, (id) => (document.querySelector('#term .xterm-rows')?.textContent || '').includes(id),
      R_LIVE, 'the tmux session\'s content to arrive through the WebSocket')
    sauber(p)
    await p.close()
  })

  await check('the terminal goes full screen and Esc brings it back', async () => {
    const p = await neueSeite(`/runs/${R_LIVE}`)
    await p.waitForSelector('#term .xterm-screen', { timeout: 15_000 })
    const hoch = () => p.$eval('#term', el => el.getBoundingClientRect().height)
    const zeilen = () => p.$$eval('#term .xterm-rows > div', els => els.length)
    const vorher = await hoch()
    const zeilenVorher = await zeilen()
    isFalse(await p.$eval('#term-wrap', el => el.classList.contains('term-full')), 'it starts in the page')
    isFalse(await p.isVisible('#term-full-exit'), 'and the way out is not offered yet')
    await p.click('#term-full')
    isTrue(await p.$eval('#term-wrap', el => el.classList.contains('term-full')), 'the icon blows it up')
    isTrue(await p.$eval('details.run-term', el => el.open), 'and the details stayed open, not toggled shut')
    isTrue(await p.isVisible('#term-full-exit'), 'the way out is in the terminal now')
    isTrue(await hoch() > vorher, 'the terminal really is bigger')
    // The refit hangs on the ResizeObserver over #term, so xterm has to follow
    // by itself — a full-screen box still showing 480 pixels worth of rows is
    // the failure this assertion is here for.
    await wartePage(p, (n) => document.querySelectorAll('#term .xterm-rows > div').length > n,
      zeilenVorher, 'xterm to refit to the new size')
    await p.keyboard.press('Escape')
    await wartePage(p, () => !document.querySelector('#term-wrap').classList.contains('term-full'),
      null, 'Esc to bring it back into the page')
    isFalse(await p.$eval('body', el => el.classList.contains('term-full-on')), 'and the page scrolls again')
    // …and the icon in the corner is the other way out.
    await p.click('#term-full')
    await p.click('#term-full-exit')
    isFalse(await p.$eval('#term-wrap', el => el.classList.contains('term-full')), 'the corner icon closes it too')
    sauber(p)
    await p.close()
  })

  // Cinema mode is the other half of the same gesture, and it breaks in ways a
  // server test cannot see: a height that no longer fits above the fold, a
  // sidebar that stays, an order that never moves the terminal to the top — and
  // the memory, which is the one thing here that outlives the page.
  await check('cinema mode lifts the terminal above the fold, and is remembered per run', async () => {
    const p = await neueSeite(`/runs/${R_LIVE}`)
    await p.waitForSelector('#term .xterm-screen', { timeout: 15_000 })
    const kasten = () => p.$eval('#term', el => {
      const r = el.getBoundingClientRect()
      return { oben: r.top + window.scrollY, hoch: r.height, breit: r.width, unten: r.bottom, sicht: window.innerHeight }
    })
    const kopf = () => p.$eval('#run-head', el => el.getBoundingClientRect().top + window.scrollY)
    const zeilen = () => p.$$eval('#term .xterm-rows > div', els => els.length)
    const vorher = await kasten()
    const zeilenVorher = await zeilen()
    isTrue(await kopf() < vorher.oben, 'the run\'s heading stands above the terminal to begin with')
    isTrue(await p.isVisible('#status-sidebar'), 'and the status sidebar is there')

    await p.click('#term-cinema')
    isTrue(await p.$eval('body', el => el.classList.contains('term-cinema-on')), 'the icon switches the mode on')
    isTrue(await p.$eval('details.run-term', el => el.open), 'the details stayed open, not toggled shut')
    equal(await p.getAttribute('#term-cinema', 'aria-pressed'), 'true', 'the button says it is pressed')
    equal(await p.getAttribute('#term-cinema', 'title'),
      await p.getAttribute('#term-cinema', 'data-title-exit'), 'and now offers the way out')
    isFalse(await p.isVisible('#status-sidebar'), 'the sidebar is gone')
    const drin = await kasten()
    isTrue(drin.oben < await kopf(), 'the terminal moved above everything that stood over it')
    isTrue(drin.breit > vorher.breit, 'it takes the full width')
    isTrue(drin.hoch > vorher.hoch, 'and it is taller than the 480px it has in the page')
    // The whole point of the mode: it still fits above the fold. Two pixels of
    // slack, because a measured height lands on a fractional device pixel.
    isTrue(drin.unten <= drin.sicht + 2, `it still fits above the fold (${drin.unten} <= ${drin.sicht})`)
    await wartePage(p, (n) => document.querySelectorAll('#term .xterm-rows > div').length > n,
      zeilenVorher, 'xterm to refit to the new size')

    // The memory is per run and survives a reload — the live channel's own way
    // of ending up on this page again.
    await p.reload({ waitUntil: 'load' })
    await p.waitForSelector('#term .xterm-screen', { timeout: 15_000 })
    isTrue(await p.$eval('body', el => el.classList.contains('term-cinema-on')), 'a reload comes back into cinema mode')
    isFalse(await p.isVisible('#status-sidebar'), 'sidebar still away')

    await p.click('#term-cinema')
    isFalse(await p.$eval('body', el => el.classList.contains('term-cinema-on')), 'the same icon closes it again')
    isTrue(await p.isVisible('#status-sidebar'), 'and the sidebar comes back')
    equal(await p.getAttribute('#term-cinema', 'aria-pressed'), 'false', 'the button is unpressed')
    // …and the memory is really gone, or every later test on this run would
    // render in cinema mode (the whole suite shares one browser context).
    const q = await neueSeite(`/runs/${R_LIVE}`)
    isFalse(await q.$eval('body', el => el.classList.contains('term-cinema-on')), 'a fresh page is an ordinary one again')
    sauber(q)
    await q.close()
    sauber(p)
    await p.close()
  })

  // Copying out of the terminal. Both paths are things neither the server nor a
  // click can produce: an OSC 52 frame the way tmux sends one at the end of a
  // mouse drag, and a selection that is xterm's own. The clipboard itself is
  // stubbed in the page — what is under test is that the sequence is decoded
  // and handed over at all, not that a headless Chromium can write a clipboard.
  /** The screen row that carries this run's own text, in page coordinates. */
  const textZeile = async (p, runId) => {
    const box = await p.evaluate((id) => {
      const rows = [...document.querySelectorAll('#term .xterm-rows > div')]
      const row = rows.find((d) => d.textContent.includes(id)) || rows.find((d) => d.textContent.trim())
      if (!row) return null
      const r = row.getBoundingClientRect()
      return { x: r.left, y: r.top + r.height / 2 }
    }, runId)
    isTrue(!!box, 'a row with text to drag across')
    return box
  }
  /** A real mouse drag across that row, optionally with Shift held. */
  const ziehe = async (p, zeile, mitShift) => {
    if (mitShift) await p.keyboard.down('Shift')
    await p.mouse.move(zeile.x + 4, zeile.y)
    await p.mouse.down()
    await p.mouse.move(zeile.x + 180, zeile.y, { steps: 8 })
    await p.mouse.up()
    if (mitShift) await p.keyboard.up('Shift')
    await p.waitForTimeout(400)
  }

  const clipboardStub = () => {
    window.__copied = []
    const stub = (text) => { window.__copied.push(String(text)); return Promise.resolve() }
    try {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: stub } })
    } catch { /* then the fallback path runs, and the test says so by failing */ }
  }

  await check('an OSC 52 out of the session lands in the clipboard — a read request is never answered', async () => {
    const p = await neueSeite(`/runs/${R_LIVE}`, clipboardStub)
    // Both clipboard ways need the document to be focused, and so does the code
    // under test: an unfocused page drops the sequence on purpose.
    await p.bringToFront()
    await p.waitForSelector('#term .xterm-screen', { timeout: 15_000 })
    // Exactly what tmux writes to its client: an EMPTY target field, base64, BEL.
    await p.evaluate((b64) => window.FREILAUF_TERM.write('\x1b]52;;' + b64 + '\x07'),
      Buffer.from('Kopf über — 42', 'utf8').toString('base64'))
    await wartePage(p, () => window.__copied.length > 0, null, 'the clipboard to be written')
    equal(await p.evaluate(() => window.__copied[0]), 'Kopf über — 42',
      'decoded as UTF-8, so umlauts survive the base64')
    contains(await p.textContent('#freilauf-toasts'), 'clipboard',
      'and it says so — a clipboard written from a remote session must not be written silently')

    // `?` asks for the clipboard's CONTENT. Answering it would hand whatever the
    // operator has copied to whatever runs in that session.
    await p.evaluate(() => window.FREILAUF_TERM.write('\x1b]52;;?\x07'))
    await p.waitForTimeout(200)
    equal(await p.evaluate(() => window.__copied.length), 1, 'nothing was copied, and nothing was sent back')
    sauber(p)
    await p.close()
  })

  await check('marking with the mouse copies and then clears the selection', async () => {
    const p = await neueSeite(`/runs/${R_LIVE}`, clipboardStub)
    await p.bringToFront()
    await p.waitForSelector('#term .xterm-screen', { timeout: 15_000 })
    await wartePage(p, (id) => (document.querySelector('#term .xterm-rows')?.textContent || '').includes(id),
      R_LIVE, 'the session\'s content to be there to select')
    // A REAL drag with the browser's own mouse, not a synthetic event: xterm
    // stops propagation while it handles one, so a listener that is not in the
    // capture phase never sees it — a synthetic mouseup dispatched at #term
    // bubbles happily and proves nothing about the path a hand takes.
    const zeile = await textZeile(p, R_LIVE)
    await ziehe(p, zeile)
    await wartePage(p, () => window.__copied.length > 0, null, 'the selection to reach the clipboard')
    isTrue(String(await p.evaluate(() => window.__copied[0])).trim().length > 0, 'and it carried real text')
    await wartePage(p, () => !window.FREILAUF_TERM.hasSelection(), null,
      'and the selection to be gone afterwards, the way tmux\'s own drag-end leaves it')

    // A click somewhere else must not copy again: the drag is tracked from its
    // mousedown precisely so a standing selection is not re-sent on every click.
    await p.evaluate(() => {
      window.FREILAUF_TERM.selectAll()
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })
    await p.waitForTimeout(200)
    equal(await p.evaluate(() => window.__copied.length), 1, 'a mouseup that began nowhere copies nothing')
    sauber(p)
    await p.close()
  })

  // The case the first release did not cover, and the reason there is a button
  // for it: an application in the pane may take mouse reporting for itself.
  // Measured on this machine with `#{mouse_any_flag}` — claude leaves the mouse
  // to tmux, which marks and copies; opencode takes it (any-motion, SGR,
  // alternate screen) and does nothing with a drag. Here the terminal is put
  // into exactly that mode by writing the sequence an application would send,
  // and then a REAL mouse drag is made over it.
  await check('an application that takes the mouse changes nothing — and the button hands it over', async () => {
    const p = await neueSeite(`/runs/${R_LIVE}`, clipboardStub)
    await p.bringToFront()
    await p.waitForSelector('#term .xterm-screen', { timeout: 15_000 })
    await wartePage(p, (id) => (document.querySelector('#term .xterm-rows')?.textContent || '').includes(id),
      R_LIVE, 'the session\'s content to be there to drag over')
    // 1003 = report any motion, 1006 = SGR encoding: opencode's own two. What
    // the terminal writes here is what opencode's TUI writes for real.
    await p.evaluate(() => window.FREILAUF_TERM.write('\x1b[?1003h\x1b[?1006h'))
    await p.waitForTimeout(300)
    const zeile = await textZeile(p, R_LIVE)
    equal(await p.getAttribute('#term-mouse', 'aria-pressed'), 'true',
      'the mouse selects to begin with — nobody has to know what the TUI does with it')

    // Nothing pressed, nothing held: the drag simply copies.
    await ziehe(p, zeile)
    isTrue(await p.evaluate(() => window.__copied.length) > 0, 'the plain drag copies')
    isTrue(String(await p.evaluate(() => window.__copied[0])).trim().length > 0, 'and it copied real text')
    isFalse(await p.evaluate(() => window.FREILAUF_TERM.hasSelection()), 'the selection is cleared afterwards')

    // A click is not a marking gesture. While the mouse selects it reaches
    // xterm as a shift-click, which EXTENDS a standing selection — copying on
    // that would fill the clipboard every time one clicks in to type.
    await p.evaluate(() => { window.__copied.length = 0 })
    await p.mouse.click(zeile.x + 40, zeile.y)
    await p.waitForTimeout(300)
    equal(await p.evaluate(() => window.__copied.length), 0, 'a click copies nothing')

    // The button is the way out, for a session one wants to click around in.
    await p.click('#term-mouse')
    equal(await p.getAttribute('#term-mouse', 'aria-pressed'), 'false', 'the agent has the mouse now')
    isTrue(await p.$eval('details.run-term', el => el.open), 'and the details stayed open, not toggled shut')
    await ziehe(p, zeile)
    isFalse(await p.evaluate(() => window.FREILAUF_TERM.hasSelection()),
      'the drag went to the application, which does nothing with it')
    equal(await p.evaluate(() => window.__copied.length), 0, 'so nothing reaches the clipboard')
    // …and the one thing the operator cannot see for themselves: WHY.
    await wartePage(p, () => (document.getElementById('freilauf-toasts')?.textContent || '').includes('Shift'),
      null, 'the hint naming Shift and the button')
    // Shift is every terminal's way out, and it works there too.
    await ziehe(p, zeile, true)
    isTrue(await p.evaluate(() => window.__copied.length) > 0, 'Shift+drag selects and copies even then')

    // The choice is global, so it has to go back — every later page in this
    // context would otherwise render in it.
    await p.click('#term-mouse')
    equal(await p.getAttribute('#term-mouse', 'aria-pressed'), 'true', 'and selecting is the default again')
    sauber(p)
    await p.close()
  })

  // …and the same thing once through the whole chain, because the test above
  // writes the sequence into xterm itself and therefore proves nothing about
  // the hop it actually comes over: tmux → the pty in terminal.mjs → the
  // WebSocket → xterm's parser. The copy is aimed at THIS page's client by
  // name (`-t`), so no other tmux client on the machine is written to, and the
  // whole check reports itself skipped where the operator's tmux has
  // `set-clipboard off` — that is their setting, not a broken hub.
  const tmux = (...a) => { try { return String(execFileSync('tmux', a, { encoding: 'utf8' })).trim() } catch { return '' } }
  const tmuxTest = tmux('show', '-sv', 'set-clipboard') === 'off'
    ? (name) => skipped(name, 'this machine\'s tmux has set-clipboard off — it sends no OSC 52 at all')
    : check
  await tmuxTest('a tmux copy really arrives through the WebSocket', async () => {
    const session = laufRow(R_LIVE).tmux_session
    // The page's own tmux client, picked by the time it attached and NOT by
    // its name: a client is named after its tty, and pts numbers are reused —
    // the client of a page that has just been closed can come back under the
    // very same name, and writing that one's clipboard would prove nothing.
    const clients = () => tmux('list-clients', '-t', `=${session}`, '-F', '#{client_created}\t#{client_name}')
      .split('\n').filter(Boolean).map((l) => l.split('\t'))
    const seit = Math.floor(Date.now() / 1000)
    const p = await neueSeite(`/runs/${R_LIVE}`, clipboardStub)
    await p.bringToFront()
    await p.waitForSelector('#term .xterm-screen', { timeout: 15_000 })
    // It appears when the WebSocket has attached, a beat after the first frame.
    let client = ''
    for (let i = 0; i < 200 && !client; i++) {
      client = (clients().find(([created]) => Number(created) >= seit) || [])[1] || ''
      if (!client) await p.waitForTimeout(100)
    }
    isTrue(!!client, `the page is attached as a tmux client (${client})`)
    tmux('set-buffer', '-w', '-t', client, '-b', 'fl-browser-test', 'TMUX-SAYS-HELLO')
    await wartePage(p, () => window.__copied.includes('TMUX-SAYS-HELLO'), null,
      'tmux\'s own clipboard sequence to come out at the other end')
    tmux('delete-buffer', '-b', 'fl-browser-test')
    sauber(p)
    await p.close()
  })

  await check('a page without a terminal starts none and stays quiet', async () => {
    const p = await neueSeite(`/?repo=${repoId}`)
    equal(await p.$$eval('#term', els => els.length), 0, 'no terminal box on the overview')
    sauber(p)
    await p.close()
  })

  // ----------------------------------------------------------------
  group('The live channel — the page follows the run without being reloaded')

  // Every test here changes the run from OUTSIDE the browser (through the API,
  // the way the watcher or a reporting agent would) and then waits for the open
  // page to catch up on its own. Nothing is clicked, nothing is reloaded.

  await check('a title generated after the fact arrives on the open overview', async () => {
    const p = await neueSeite(`/?repo=${repoId}`)
    const vorher = await p.textContent(`#run-${R_ALT} [data-title-text]`)
    await postForm(`/api/runs/${R_ALT}/title`, { title: 'Arrived by itself' })
    await wartePage(p, (id) => document.querySelector(`#run-${id} [data-title-text]`)?.textContent === 'Arrived by itself',
      R_ALT, 'the row to carry the new title')
    isFalse(vorher === 'Arrived by itself', 'and it really was something else before')
    sauber(p)
    await p.close()
  })

  await check('a run that did not exist yet appears in the table by itself', async () => {
    const p = await neueSeite(`/?repo=${repoId}`)
    const neu = await laufStarten({ repo_id: repoId, prompt: 'born while the page was open' })
    // The row cannot be created in place — the empty state and the sort order
    // live in the tbody, so the parent is re-rendered. This is the case a
    // row-level swap cannot serve.
    await wartePage(p, (id) => !!document.getElementById(`run-${id}`), neu, 'the new row to show up')
    sauber(p)
    await p.close()
  })

  await check('a run leaving the overview takes its row with it', async () => {
    const p = await neueSeite(`/?repo=${repoId}`)
    isTrue(await p.$(`#run-${R_ENDE}`) !== null, 'the finished run is listed to begin with')
    await postForm(`/api/runs/${R_ENDE}/archive`, {})
    // The fragment answers 204 for an archived run, and 204 means gone, not broken.
    await wartePage(p, (id) => !document.getElementById(`run-${id}`), R_ENDE, 'the archived row to disappear')
    sauber(p)
    await p.close()
  })

  await check('a row being renamed is left alone until the typing is done', async () => {
    // The half-typed title exists only in the DOM, so a swap would throw it
    // away mid-word. This is the one case where the live channel has to hold back.
    const p = await neueSeite(`/?repo=${repoId}`)
    await p.hover(`#run-${R_TICK}`)
    await p.click(`#run-${R_TICK} [data-title-edit]`)
    await p.fill(`#run-${R_TICK} .title-inline input`, 'half typed')
    await postForm(`/api/runs/${R_TICK}/title`, { title: 'pushed from outside' })
    await new Promise(r => setTimeout(r, 900))   // long enough for the swap to have happened
    // Check the input still EXISTS before asking for its value: if the row was
    // swapped, the element is gone and inputValue() would sit in a 30 s timeout
    // instead of saying what went wrong.
    const feld = await p.$(`#run-${R_TICK} .title-inline input`)
    isTrue(feld !== null, 'the open input was not swapped away underneath the cursor')
    equal(feld ? await feld.inputValue() : '(row was replaced)', 'half typed', 'the typing survived')
    await p.keyboard.press('Escape')
    sauber(p)
    await p.close()
  })

  await check('the detail page follows along without touching the terminal', async () => {
    const p = await neueSeite(`/runs/${R_LIVE}`)
    await wartePage(p, () => !!document.querySelector('#term .xterm-rows'), null, 'the terminal to be up')
    // Mark the very xterm instance: if the swap ever reaches #term, this is gone
    // — and with it the WebSocket, which would leak a tmux client that keeps
    // resizing the running agent's window.
    await p.evaluate(() => { document.querySelector('#term').dataset.marke = 'unberuehrt' })
    await postForm(`/api/runs/${R_LIVE}/title`, { title: 'Detail follows along' })
    await wartePage(p, () => document.querySelector('#run-head [data-title-text]')?.textContent === 'Detail follows along',
      null, 'the heading to carry the new title')
    equal(await p.getAttribute('#term', 'data-marke'), 'unberuehrt', 'the terminal was never replaced')
    isTrue(await p.$('#term .xterm-rows') !== null, 'and it is still a live terminal')
    sauber(p)
    await p.close()
  })

  await check('the notification box under the terminal switches the run with one click and survives a live update', async () => {
    const p = await neueSeite(`/runs/${R_LIVE}`)
    await wartePage(p, () => !!document.querySelector('#term .xterm-rows'), null, 'the terminal to be up')
    equal(await p.$eval('#notify-on', el => el.checked), true, 'ticked by default')
    await p.click('#notify-on')
    await waitFor(() => db.prepare('SELECT telegram_on FROM runs WHERE id=?').get(R_LIVE).telegram_on === 0,
      { what: 'the click to reach the database' })
    equal(await p.$eval('#notify-on', el => el.checked), false, 'and the box shows it')
    // The box sits outside the fragment, like the terminal it sits under: a live
    // update of the page must not flip a box the operator just clicked.
    await postForm(`/api/runs/${R_LIVE}/title`, { title: 'Muted, and updated' })
    await wartePage(p, () => document.querySelector('#run-head [data-title-text]')?.textContent === 'Muted, and updated',
      null, 'the heading to carry the new title')
    equal(await p.$eval('#notify-on', el => el.checked), false, 'the box is untouched by the swap')
    await p.click('#notify-on')
    await waitFor(() => db.prepare('SELECT telegram_on FROM runs WHERE id=?').get(R_LIVE).telegram_on === 1,
      { what: 'the second click to reach the database' })
    sauber(p)
    await p.close()
  })

  await check('the channel reconnects by itself and keeps working', async () => {
    const p = await neueSeite(`/?repo=${repoId}`)
    // Drop the stream from the browser side; EventSource has to come back on its
    // own, sending Last-Event-ID, which the hub answers from its ring buffer.
    await p.evaluate(() => new Promise(r => {
      const alt = window.EventSource
      window.__zu = 0
      window.EventSource = class extends alt { constructor(...a) { super(...a); window.__zu++ } }
      r()
    }))
    await p.reload({ waitUntil: 'load' })
    // Wait for the channel to be UP before changing anything. A fresh load
    // carries no Last-Event-ID, so an event fired before the connection exists
    // is missed — which made this test a race the moment the page grew a
    // sidebar and took longer to settle.
    await wartePage(p, () => document.body.dataset.live === '1', null, 'the live channel to be connected')
    await postForm(`/api/runs/${R_ALT}/title`, { title: 'After a reconnect' })
    await wartePage(p, (id) => document.querySelector(`#run-${id} [data-title-text]`)?.textContent === 'After a reconnect',
      R_ALT, 'the row to update after the page came back')
    sauber(p)
    await p.close()
  })

  group('A20 — the overview: pick several runs, archive them at once')

  await check('select all, untick a few, archive the rest', async () => {
    // The gesture this exists for: forty finished runs of which four are worth
    // keeping. Three here, one of them kept.
    const ids = []
    for (const n of [1, 2, 3]) {
      const id = await laufStarten({ repo_id: String(repoId), prompt: `Browser-Bulk ${n}` })
      await melden(id, 'done', 'fertig')
      ids.push(id)
    }
    const p = await neueSeite(`/?repo=${repoId}`)
    await wartePage(p, (id) => !!document.getElementById(`run-${id}`), ids[2], 'the new rows to be listed')

    equal(await p.$eval('#runs-archive-selected', el => el.disabled), true, 'nothing selected, nothing to press')
    await p.click('#runs-all')
    const alle = await p.$$eval('#runs-body .run-pick', els => els.length)
    isTrue(alle >= 3, `every archivable run has a box (${alle})`)
    equal(await p.$eval('#runs-archive-selected', el => el.disabled), false, 'the button woke up')
    contains(await p.textContent('#runs-archive-selected'), `(${alle})`, 'the label counts the selection')
    // A run still in flight carries no box at all — "select all" can never
    // promise something the server would refuse.
    equal(await p.$$eval(`#run-${R_LIVE} .run-pick`, els => els.length), 0, 'a running run cannot be selected')

    // Untick the keepers: everything except the three that were just made.
    const keep = await p.$$eval('#runs-body .run-pick', (els, meine) =>
      els.map(el => el.value).filter(v => !meine.includes(v)), ids)
    for (const id of keep) await p.uncheck(`#run-${id} .run-pick`)
    contains(await p.textContent('#runs-archive-selected'), '(3)', 'three left over')
    equal(await p.$eval('#runs-all', el => el.checked), false, 'and "select all" says so')

    await p.click('#runs-archive-selected')
    for (const id of ids) {
      await wartePage(p, (x) => !document.getElementById(`run-${x}`), id, 'the archived row to disappear')
      isTrue(!!laufRow(id).archived_at, 'archived in the database')
    }
    for (const id of keep) equal(laufRow(id).archived_at, null, 'an unticked run stays in the overview')
    equal(await p.$eval('#runs-archive-selected', el => el.disabled), true, 'the selection is spent')
    sauber(p)
    await p.close()
  })

  await check('a tick survives the live channel replacing the table', async () => {
    // The selection lives in a Set, not in the checkboxes: the tbody is
    // re-rendered whenever somebody else's run appears, and a tick that lived
    // only in the DOM would go with it.
    const meiner = await laufStarten({ repo_id: String(repoId), prompt: 'Browser-Bulk-bleibt' })
    await melden(meiner, 'done', 'fertig')
    const p = await neueSeite(`/?repo=${repoId}`)
    await wartePage(p, () => document.body.dataset.live === '1', null, 'the live channel to be connected')
    await wartePage(p, (id) => !!document.getElementById(`run-${id}`), meiner, 'the row to be listed')
    await p.check(`#run-${meiner} .run-pick`)
    contains(await p.textContent('#runs-archive-selected'), '(1)', 'one selected')

    // A new run: the whole tbody is replaced (the empty state and the sort order
    // live there, so a row cannot be appended).
    const fremder = await laufStarten({ repo_id: String(repoId), prompt: 'Browser-Bulk-fremd' })
    await wartePage(p, (id) => !!document.getElementById(`run-${id}`), fremder, 'the foreign row to arrive')
    equal(await p.$eval(`#run-${meiner} .run-pick`, el => el.checked), true, 'the tick is still there after the swap')
    contains(await p.textContent('#runs-archive-selected'), '(1)', 'and the count did not move')

    // The same for a single ROW being replaced — its own run reporting.
    await postForm(`/api/runs/${meiner}/title`, { title: 'Renamed under the tick' })
    await wartePage(p, (id) => document.querySelector(`#run-${id} [data-title-text]`)?.textContent === 'Renamed under the tick',
      meiner, 'the row to carry the new title')
    equal(await p.$eval(`#run-${meiner} .run-pick`, el => el.checked), true, 'the row swap kept it too')
    sauber(p)
    await p.close()
  })

  group('A11 — the worktree-extras dialog')
  await check('it opens and the client refuses an empty path', async () => {
    const p = await neueSeite('/repos/edit')
    equal(await p.$eval('#extras-dialog', d => d.open), false, 'closed to begin with')
    await p.click('#extras-find')
    equal(await p.$eval('#extras-dialog', d => d.open), true, 'open')
    equal(await p.textContent('#extras-path'), '—', 'no path entered yet')
    equal(await p.$eval('#extras-error', e => e.hidden), true, 'no error to begin with')
    await p.click('#extras-start')
    await wartePage(p, () => !document.getElementById('extras-error').hidden, null, 'the empty-path error')
    contains(await p.textContent('#extras-error'), 'path', 'it says what is missing')
    // Cancel closes it again.
    await p.click('#extras-dialog [data-extras-close]')
    equal(await p.$eval('#extras-dialog', d => d.open), false, 'closed by cancel')
    sauber(p)
    await p.close()
  })
  await check('the algorithmic errors from the hub land in the dialog, and the path is shown', async () => {
    const p = await neueSeite(`/repos/edit?id=${repoId}`)
    contains(await p.textContent('#extras-dialog'), 'completely replaces', 'the warning that existing extras are not kept')
    // Overwrite the stored path while the dialog is still closed — a modal
    // blocks the page behind it, so filling must happen before it opens.
    await p.fill('input[name=path]', '/gibt/es/nicht')
    await p.click('#extras-find')
    equal(await p.textContent('#extras-path'), '/gibt/es/nicht', 'the dialog shows the path')
    await p.click('#extras-start')
    await wartePage(p, () => !document.getElementById('extras-error').hidden, null, 'the hub answer')
    contains(await p.textContent('#extras-error'), '/gibt/es/nicht', 'the path is named')
    sauber(p)
    await p.close()
  })

  group('A19 — the repo-delete confirmation, and "deactivate instead"')
  await check('the delete button stays dead until the name is typed exactly', async () => {
    const id = sk.db.prepare(`INSERT INTO repos(name,path,base_branch)
      VALUES('browser-del','${sk.REPO}','main') RETURNING id`).get().id
    const p = await neueSeite('/repos')
    const dlg = '#repo-del-' + id
    equal(await p.$eval(dlg, d => d.open), false, 'closed to begin with')
    await p.click(`.repo-delete-open[data-repo="${id}"]`)
    equal(await p.$eval(dlg, d => d.open), true, 'the row opens its own dialog')
    // Everything the operator needs before an irreversible click.
    const text = await p.textContent(dlg)
    contains(text, 'browser-del', 'it names the repo')
    contains(text, sk.REPO, 'and the checkout it will NOT touch')
    equal(await p.$eval(`${dlg} .repo-del-go`, b => b.disabled), true, 'the delete button starts disabled')
    // It is the one button here that destroys something, so it must not look
    // like the two beside it — and a disabled button has to look disabled, or a
    // red button that does nothing on click reads as broken.
    const rot = await p.$eval(`${dlg} .repo-del-go`, (b) => {
      const c = getComputedStyle(b)
      return { bg: c.backgroundColor, opacity: c.opacity, cursor: c.cursor }
    })
    const ghost = await p.$eval(`${dlg} .repo-del-deactivate`, (b) => getComputedStyle(b).backgroundColor)
    isFalse(rot.bg === ghost, `the delete button does not share the ghost background (${rot.bg})`)
    isTrue(Number(rot.opacity) < 1, `disabled is visible (opacity ${rot.opacity})`)
    equal(rot.cursor, 'not-allowed', 'and the cursor says so too')
    // The channel is the `danger` class, which is this project's destructive
    // colour everywhere else (kill a run, end a session, delete a flow).
    isTrue(await p.$eval(`${dlg} .repo-del-go`, b => b.classList.contains('danger')), 'through the house danger class')

    await p.fill(`${dlg} .repo-del-name`, 'browser-de')
    equal(await p.$eval(`${dlg} .repo-del-go`, b => b.disabled), true, 'a near miss does not arm it')
    await p.fill(`${dlg} .repo-del-name`, 'browser-del')
    equal(await p.$eval(`${dlg} .repo-del-go`, b => b.disabled), false, 'the exact name arms it')
    equal(await p.$eval(`${dlg} .repo-del-confirm`, i => i.value), 'browser-del',
      'and the hidden field that actually travels carries the name')

    // Cancel changes nothing at all.
    await p.click(`${dlg} [data-repo-del-close]`)
    equal(await p.$eval(dlg, d => d.open), false, 'cancel closes it')
    equal(sk.db.prepare('SELECT count(*) c FROM repos WHERE id=?').get(id).c, 1, 'and the repo is still there')
    // Reopening starts empty again — a name left in the field would arm the
    // button before anybody typed anything.
    await p.click(`.repo-delete-open[data-repo="${id}"]`)
    equal(await p.$eval(`${dlg} .repo-del-name`, i => i.value), '', 'the field is empty again')
    equal(await p.$eval(`${dlg} .repo-del-go`, b => b.disabled), true, 'and the button dead again')
    sauber(p)
    await p.close()
  })

  await check('"deactivate instead" is the way out of the dialog, and it works', async () => {
    const id = sk.db.prepare(`SELECT id FROM repos WHERE name='browser-del'`).get().id
    const p = await neueSeite('/repos')
    await p.click(`.repo-delete-open[data-repo="${id}"]`)
    await Promise.all([p.waitForLoadState('load'), p.click(`#repo-del-${id} .repo-del-deactivate`)])
    equal(sk.db.prepare('SELECT active FROM repos WHERE id=?').get(id).active, 0, 'the repo is deactivated')
    equal(sk.db.prepare('SELECT count(*) c FROM repos WHERE id=?').get(id).c, 1, 'and still very much there')
    contains(await p.textContent('body'), 'browser-del', 'the Repos page still lists it')
    sauber(p)
    await p.close()
  })

  await check('confirming really deletes it', async () => {
    const id = sk.db.prepare(`SELECT id FROM repos WHERE name='browser-del'`).get().id
    const p = await neueSeite('/repos')
    await p.click(`.repo-delete-open[data-repo="${id}"]`)
    await p.fill(`#repo-del-${id} .repo-del-name`, 'browser-del')
    await Promise.all([p.waitForLoadState('load'), p.click(`#repo-del-${id} .repo-del-go`)])
    equal(sk.db.prepare('SELECT count(*) c FROM repos WHERE id=?').get(id).c, 0, 'gone')
    sauber(p)
    await p.close()
  })

  group('A18 — the Freilauf-skills removal confirmation')
  await check('unticking the installation asks before anything is deleted', async () => {
    // Switch it on through the ordinary form first, so the page really renders
    // with `data-was-on="1"` — that attribute is what makes the question
    // askable at all, and a test that set it by hand would test nothing.
    await postForm('/settings/skills', { skills_install: '1', skills_auto_update: '1' }, { asBrowser: true })
    const p = await neueSeite('/settings/skills')
    equal(await p.$eval('#skills-form', f => f.dataset.wasOn), '1', 'the form knows it was on')
    equal(await p.$eval('#skills-remove-dialog', d => d.open), false, 'the dialog is closed to begin with')

    // Saving with the box still ticked must NOT ask.
    await p.click('#skills-form button')
    await p.waitForLoadState('load')
    equal(await p.$eval('#skills-remove-dialog', d => d.open), false, 'saving unchanged asks nothing')

    // Unticking and saving DOES ask, and nothing is submitted yet.
    // "Keep them up to date" is a switch about nothing without an installation:
    // unticking makes it disappear, and — the load-bearing half — DISABLES both
    // of its inputs, so the hidden `0` companion cannot post and overwrite a
    // preference the operator left on.
    equal(await p.$eval('#skills-auto', d => d.hidden), false, 'the update row is there while the installation is on')
    await p.uncheck('#skills-form input[type=checkbox][name=skills_install]')
    equal(await p.$eval('#skills-auto', d => d.hidden), true, 'unticking hides it at once, without a save')
    equal(await p.$$eval('#skills-auto input', (l) => l.every(i => i.disabled)), true, 'and disables both inputs')
    // The per-skill picker follows the same rule, and for the same reason: a
    // hidden checkbox that still submitted would rewrite the selection unseen.
    equal(await p.$eval('#skills-pick', d => d.hidden), true, 'the picker goes with it')
    equal(await p.$$eval('#skills-pick input', (l) => l.length > 0 && l.every(i => i.disabled)), true,
      'and every one of its boxes is disabled')
    await p.check('#skills-form input[type=checkbox][name=skills_install]')
    equal(await p.$eval('#skills-auto', d => d.hidden), false, 'ticking brings it back')
    equal(await p.$$eval('#skills-auto input', (l) => l.every(i => !i.disabled)), true, 'enabled again')
    equal(await p.$eval('#skills-pick', d => d.hidden), false, 'and the picker with it')
    equal(await p.$$eval('#skills-pick input', (l) => l.every(i => !i.disabled)), true, 'enabled again too')
    await p.uncheck('#skills-form input[type=checkbox][name=skills_install]')
    await p.click('#skills-form button')
    await wartePage(p, () => document.getElementById('skills-remove-dialog').open, null, 'the confirmation')
    contains(await p.textContent('#skills-remove-dialog'), 'freilauf-models',
      'and it names the directories that would go')
    equal(await p.$eval('#skills-form input[type=checkbox][name=skills_install]', b => b.checked), false, 'the box stays as clicked')

    // Cancel leaves everything alone — the setting is still on.
    await p.click('#skills-remove-dialog [data-skills-close]')
    equal(await p.$eval('#skills-remove-dialog', d => d.open), false, 'cancel closes it')
    equal(sk.db.prepare("SELECT value FROM settings WHERE key='skills_install'").get().value, '1',
      'and nothing was saved')

    // Confirming submits the form for real.
    await p.click('#skills-form button')
    await wartePage(p, () => document.getElementById('skills-remove-dialog').open, null, 'the confirmation again')
    await Promise.all([p.waitForLoadState('load'), p.click('#skills-remove-confirm')])
    equal(sk.db.prepare("SELECT value FROM settings WHERE key='skills_install'").get().value, '0',
      'confirming really switches it off')
    sauber(p)
    await p.close()
  })

  group('A12 — the tmux-cleanup triggers')
  let CL_ERSTER = ''
  await check('the sidebar and the Sessions page offer the configured cleanup agent', async () => {
    // The sidebar's tmux block measures the real tmux server — give it one
    // session so there is something to show, and register it for the cleanup.
    const { execFile } = await import('node:child_process')
    await new Promise((r) => execFile('tmux', ['new-session', '-d', '-s', 'fl-browser-mem', 'sleep 300'], () => r()))
    sk.sessions.add('fl-browser-mem')
    await postForm('/settings/cleanup', {
      harness: 'claude', cleanup_on: '1', cleanup_threshold_gb: '1', cleanup_target_gb: '0.5',
      cleanup_cooldown_min: '5',
    }, { asBrowser: true })
    const p = await neueSeite('/')
    await wartePage(p, () => !!document.querySelector('.mem-free-open'), null, 'the small sidebar free-memory button')
    const p2 = await neueSeite('/sessions')
    await wartePage(p2, () => !!document.querySelector('.cleanup-free-open'), null, 'the Sessions-page button')
    // The one shared modal is on the page, with an explanation and the target field.
    const d = await p2.$eval('#cleanup-dialog', el => ({ open: el.open, keep: !!el.querySelector('input[name=keep]') }))
    equal(d.open, false, 'the modal is closed to begin with')
    equal(d.keep, true, 'the keep field is on the Sessions page')
    const p1 = await neueSeite('/')
    const d1 = await p1.$eval('#cleanup-dialog', el => ({ keep: !!el.querySelector('input[name=keep]') }))
    equal(d1.keep, false, 'but not on the overview')
    sauber(p); sauber(p2); sauber(p1)
    await p.close(); await p2.close(); await p1.close()
  })
  await check('the sidebar button opens the modal and starts the agent', async () => {
    const p = await neueSeite('/')
    // An earlier test may have folded the sidebar away (the choice is persisted in
    // localStorage) — the button lives inside the folded-away body.
    await p.evaluate(() => { try { localStorage.setItem('freilauf.sidebar.open', '1') } catch (err) { /* private mode */ } })
    await p.reload()
    await wartePage(p, () => !!document.querySelector('.mem-free-open') &&
      getComputedStyle(document.querySelector('.mem-free-open')).display !== 'none', null, 'the small sidebar free-memory button')
    await p.click('.mem-free-open')
    equal(await p.$eval('#cleanup-dialog', d => d.open), true, 'the modal opens')
    contains(await p.textContent('#cleanup-dialog'), 'Free memory', 'with a title')
    await p.fill('#cleanup-dialog-form input[name=target]', '0.5')
    await p.click('#cleanup-dialog-form button[type=submit]')
    await wartePage(p, () => !!document.querySelector('.toast a'), null, 'the toast with a link to the run')
    const href = await p.$eval('.toast a', a => a.getAttribute('href'))
    CL_ERSTER = href.split('/').pop()
    await waitFor(async () => !!(db.prepare('SELECT tmux_session FROM runs WHERE id=?').get(CL_ERSTER)?.tmux_session),
      { what: 'the cleanup run to get its session', timeoutMs: 10_000 })
    const s = db.prepare('SELECT tmux_session FROM runs WHERE id=?').get(CL_ERSTER).tmux_session
    sk.sessions.add(s)
    equal(db.prepare('SELECT kind FROM events WHERE run_id=? AND kind=?').get(CL_ERSTER, 'cleanup_run')?.kind,
      'cleanup_run', 'marked as a cleanup run')
    // The second attempt while one is running shows the reason inside the modal,
    // not a second run.
    const vorher = db.prepare(`SELECT count(*) c FROM runs WHERE status IN ('running','waiting_help')`).get().c
    await p.click('.mem-free-open')
    await p.click('#cleanup-dialog-form button[type=submit]')
    await wartePage(p, () => !document.getElementById('cleanup-dialog-error').hidden, null, 'the modal error')
    contains(await p.textContent('#cleanup-dialog-error'), 'already in progress', 'it names the reason')
    equal(db.prepare(`SELECT count(*) c FROM runs WHERE status IN ('running','waiting_help')`).get().c, vorher,
      'no second run')
    sauber(p)
    await p.close()
  })
  await check('the Sessions button opens the modal and starts the agent with a keep list', async () => {
    // End the first run so a new one may start.
    await melden(CL_ERSTER, 'done', 'freed some GB.')
    const p = await neueSeite('/sessions')
    await wartePage(p, () => !!document.querySelector('.cleanup-free-open'), null, 'the Sessions-page button')
    await p.click('.cleanup-free-open')
    equal(await p.$eval('#cleanup-dialog', d => d.open), true, 'the modal opens')
    await p.fill('#cleanup-dialog-form input[name=target]', '0.5')
    await p.fill('#cleanup-dialog-form input[name=keep]', CL_ERSTER)
    await p.click('#cleanup-dialog-form button[type=submit]')
    await wartePage(p, () => !!document.querySelector('.toast a'), null, 'the toast with a link to the new run')
    const href = await p.$eval('.toast a', a => a.getAttribute('href'))
    const id = href.split('/').pop()
    await waitFor(async () => !!(db.prepare('SELECT tmux_session FROM runs WHERE id=?').get(id)?.tmux_session),
      { what: 'the kept cleanup run to get its session', timeoutMs: 10_000 })
    sk.sessions.add(db.prepare('SELECT tmux_session FROM runs WHERE id=?').get(id).tmux_session)
    const prompt = db.prepare('SELECT prompt FROM runs WHERE id=?').get(id).prompt
    contains(prompt, 'Diese Sessions bleiben auf jeden Fall erhalten', 'the keep line is present')
    contains(prompt, db.prepare('SELECT tmux_session FROM runs WHERE id=?').get(CL_ERSTER).tmux_session,
      'naming the kept run\'s session')
    sauber(p)
    await p.close()
  })
  // ------------------------------------------------------------------
  group('A17 — the model source for the hub\'s own questions')

  // Three fieldsets on the Settings page ask the same thing in a row (incident
  // check, run title, worktree extras) and the welcome wizard asks it again —
  // so nothing in hub.js knows an id here: everything is scoped to the fieldset
  // the <select> sits in, and the listener is delegated. Both of those are
  // silent when they break: the datalist simply stays as the server rendered
  // it, and the warning simply never appears.
  //
  // `/api/llm-models` is intercepted rather than answered for real: asking a
  // model provider means a request to a vendor, and asking a coding agent means
  // starting its CLI. What is under test is the client, and a stub also lets
  // the request itself be asserted.
  const quellenSeite = async () => {
    const p = await neueSeite(null)
    p.gefragt = []
    await p.route('**/api/llm-models*', async (route) => {
      const source = new URL(route.request().url()).searchParams.get('source')
      p.gefragt.push(source)
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          source,
          models: [{ id: `${source}/one`, name: 'Model One' }, { id: `${source}/two`, name: `${source}/two` }],
        }),
      })
    })
    await p.goto(sk.base + '/settings', { waitUntil: 'load' })
    return p
  }
  const listenWerte = (p, id) => p.$$eval(`#${id} option`, os => os.map(o => o.value))

  await check('every source picker fills its own model datalist, and keeps what the server put there', async () => {
    const p = await quellenSeite()
    await wartePage(p, () => document.querySelectorAll('#title-mru option').length > 1,
      null, 'the title datalist to be filled from the API')

    // Each of the three fieldsets asked once, for the source IT carries.
    equal(p.gefragt.length, 3, `three questions, one per job (${p.gefragt.join(', ')})`)
    isTrue(p.gefragt.every(s => s === 'provider:openrouter'),
      `all three at their stored source (${p.gefragt.join(', ')})`)

    const werte = await listenWerte(p, 'title-mru')
    isTrue(werte.includes('provider:openrouter/one'), `the answer landed in the list (${werte.join(', ')})`)
    isTrue(werte.includes('provider:openrouter/two'), 'both entries')
    // The recently-used models the server rendered are not replaced by a
    // vendor's catalog — they are what the field falls back to.
    const vorgabe = await p.$eval('input[name=llm_title_model]', i => i.value)
    isTrue(werte.includes(vorgabe), `the server-rendered suggestion survived (${vorgabe})`)
    // …and a name that is not the id is shown as the option's label.
    equal(await p.$eval('#title-mru option[value="provider:openrouter/one"]', o => o.textContent), 'Model One',
      'a model with a name of its own shows it')
    sauber(p)
    await p.close()
  })

  await check('choosing a coding agent shows the overhead warning and disables the OpenRouter pin', async () => {
    const p = await quellenSeite()
    await wartePage(p, () => document.querySelectorAll('#title-mru option').length > 1, null, 'the first fill')

    const feld = 'fieldset:has(select[name=llm_check_source])'
    // Before: a model provider, so no warning and the pin applies.
    equal(await p.$eval(`${feld} [data-llm-overhead]`, el => el.hidden), true, 'no warning at a provider source')
    equal(await p.$eval(`${feld} [data-llm-pin]`, el => el.hidden), false, 'the pin is offered')
    equal(await p.$eval('input[name=llm_check_or_provider]', i => i.disabled), false, 'and it submits')

    await p.selectOption('select[name=llm_check_source]', 'agent:claude')
    await wartePage(p, () => !document.querySelector('fieldset:has(select[name="llm_check_source"]) [data-llm-overhead]').hidden,
      null, 'the overhead warning to appear')
    const warnung = await p.textContent(`${feld} [data-llm-overhead]`)
    isTrue(warnung.trim().length > 0, `the warning has a text (${warnung.trim().slice(0, 60)})`)

    // Hidden AND disabled. A hidden field that still submits is a trap this
    // project has been bitten by before — here it would send an OpenRouter
    // endpoint tag along with somebody else's answer.
    equal(await p.$eval(`${feld} [data-llm-pin]`, el => el.hidden), true, 'the pin is hidden')
    equal(await p.$eval('input[name=llm_check_or_provider]', i => i.disabled), true, 'and disabled, not merely invisible')

    // The change is scoped to its own fieldset — the other two are untouched.
    equal(await p.$eval('fieldset:has(select[name=llm_title_source]) [data-llm-overhead]', el => el.hidden), true,
      'the run-title fieldset keeps its own state')
    equal(await p.$eval('input[name=llm_title_or_provider]', i => i.disabled), false, 'and its pin still submits')

    // The new source was asked for its models, and the list grew rather than
    // losing what was already in it.
    await wartePage(p, () => Array.prototype.some.call(
      document.querySelectorAll('#llm-mru option'), o => o.value === 'agent:claude/one'),
    null, 'the models of the newly chosen source')
    equal(p.gefragt.at(-1), 'agent:claude', 'the request carried the chosen source')

    // …and back again: both halves must be reversible, or the warning would
    // simply stay on the page for ever after one look at a coding agent.
    await p.selectOption('select[name=llm_check_source]', 'provider:openrouter')
    await wartePage(p, () => document.querySelector('fieldset:has(select[name="llm_check_source"]) [data-llm-overhead]').hidden,
      null, 'the warning to go away again')
    equal(await p.$eval(`${feld} [data-llm-pin]`, el => el.hidden), false, 'the pin is back')
    equal(await p.$eval('input[name=llm_check_or_provider]', i => i.disabled), false, 'and submits again')
    // Switching source does not cost the recently-used entries.
    const werte = await listenWerte(p, 'llm-mru')
    isTrue(werte.includes('provider:openrouter/one'), `the provider's models are back (${werte.join(', ')})`)
    isFalse(werte.includes('agent:claude/one'), 'and the previous source\'s are gone')
    sauber(p)
    await p.close()
  })

  await check('the fallback picker shows its model field and asks only on change', async () => {
    // The fallback select is its own container ([data-llm-fb]), NOT the
    // primary's wiring: it must not double the page-load requests (the test
    // above pins three, one per job) and must not fight the primary over one
    // warning. The model field is hidden while no fallback is chosen, and the
    // models of a chosen one are fetched on CHANGE only.
    const p = await quellenSeite()
    await wartePage(p, () => document.querySelectorAll('#title-mru option').length > 1, null, 'the first fill')
    equal(p.gefragt.length, 3, 'the fallback adds no request of its own on page load')

    const feld = 'fieldset:has(select[name=llm_check_fallback])'
    equal(await p.$eval(`${feld} [data-llm-fb-model]`, el => el.hidden), true, 'no fallback: no model field')

    await p.selectOption('select[name=llm_check_fallback]', 'agent:claude')
    await wartePage(p, () => !document.querySelector('fieldset:has(select[name="llm_check_fallback"]) [data-llm-fb-model]').hidden,
      null, 'the model field to appear with the fallback')
    equal(await p.$eval(`${feld} [data-llm-fb-overhead]`, el => el.hidden), false, 'the overhead warning follows the fallback too')
    await wartePage(p, () => Array.prototype.some.call(
      document.querySelectorAll('fieldset select[name="llm_check_fallback"] ~ * #llm_check_fb_list option, #llm_check_fb_list option'),
      o => o.value === 'agent:claude/one'),
      null, 'the fallback model list to be filled on change')
    equal(p.gefragt.at(-1), 'agent:claude', 'the request carried the fallback source')

    // The other fieldsets are untouched — scoping again.
    equal(await p.$eval('fieldset:has(select[name="llm_title_fallback"]) [data-llm-fb-model]', el => el.hidden), true,
      'the run-title fieldset keeps its own fallback state')

    // Emptying the fallback hides the model field again — reversible.
    await p.selectOption('select[name=llm_check_fallback]', '')
    await wartePage(p, () => document.querySelector('fieldset:has(select[name="llm_check_fallback"]) [data-llm-fb-model]').hidden,
      null, 'the model field to go away again')
    equal(await p.$eval(`${feld} [data-llm-fb-overhead]`, el => el.hidden), true, 'and the warning with it')
    sauber(p)
    await p.close()
  })

  await check('a source that answers nothing leaves the field working', async () => {
    // The model input is free text and must keep working whatever a vendor
    // says — an empty answer, an error, a broken connection.
    const p = await neueSeite(null)
    await p.route('**/api/llm-models*', route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: 'nobody is answering' }),
    }))
    await p.goto(sk.base + '/settings', { waitUntil: 'load' })
    const vorgabe = await p.$eval('input[name=llm_title_model]', i => i.value)
    const werte = await listenWerte(p, 'title-mru')
    isTrue(werte.includes(vorgabe), 'the server-rendered suggestions are still there')
    await p.selectOption('select[name=llm_title_source]', 'provider:deepseek')
    await p.waitForTimeout(200)
    isTrue((await listenWerte(p, 'title-mru')).includes(vorgabe), 'and a switch does not empty the list either')
    sauber(p)
    await p.close()
  })
} catch (err) {
  console.log(`\nAborted: ${err.stack}`)
  counter.failures.push({ name: 'Test run', reason: err.message })
} finally {
  await cleanUp()
}

process.exit(summary('Browser tests', start))
