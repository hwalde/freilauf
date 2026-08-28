#!/usr/bin/env node
// cc-hub — browser tests: what public/hub.js actually does, in a real browser.
//
// Why this suite exists: hub.js was 746 lines with not one test, because no
// browser ran in the suite. Every other check in this project stops at the HTML
// the server sends — what happens after it reaches a browser was unobserved, and
// the ways it breaks are all SILENT. A dead listener does not throw: the selects
// simply never fill, the terminal is a black box, the pencil does nothing. That
// is precisely what a rebuild of this file (live updates, htmx) walks into
// blind, so what it does today is written down here as tests first.
//
// It runs a hub in the sandbox from test/sandkasten.mjs — the same one the e2e
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
import { gruppe, pruefe, uebersprungen, gleich, wahr, falsch, enthaelt, bericht, zaehler } from './mini.mjs'
import { neuerSandkasten } from './sandkasten.mjs'

const BEHALTEN = process.argv.includes('--keep')
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
  gruppe('Browser tests')
  uebersprungen('the whole suite', `${grund} — hub.js stays untested here, which is not the same as broken`)
  process.exit(bericht('Browser tests', start))
}

// ---------------------------------------------------------------- sandbox
const sk = neuerSandkasten({ praefix: 'cc-hub-browser-', behalten: BEHALTEN })
const { hol, formular } = sk
let db = null
let kontext = null

async function aufraeumen() {
  try { await kontext?.close() } catch {}
  try { await browser?.close() } catch {}
  await sk.aufraeumen()
}
process.on('SIGINT', async () => { await aufraeumen(); process.exit(130) })
process.on('SIGTERM', async () => { await aufraeumen(); process.exit(143) })

// ---------------------------------------------------------------- page helper
/**
 * A page that watches itself: every uncaught exception and every console error
 * is collected, and `sauber(p)` turns them into a failing check. The silent
 * breakages this suite is about announce themselves in exactly those two places.
 */
async function neueSeite(pfad) {
  const p = await kontext.newPage()
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
  if (pfad) await p.goto(sk.basis + pfad, { waitUntil: 'load' })
  return p
}
const sauber = (p) => wahr(p.fehler.length === 0, `the browser console stays quiet (${p.fehler.join(' | ')})`)

/** Poll inside the page until the condition holds — same idea as warteAuf. */
const wartePage = (p, fn, arg, was) =>
  p.waitForFunction(fn, arg, { timeout: 10_000 })
    .catch(() => { throw new Error(`timeout while waiting for: ${was}`) })

// ---------------------------------------------------------------- test data
const jsonPost = (pfad, obj) => hol(pfad, {
  method: 'POST', body: JSON.stringify(obj),
  headers: { 'content-type': 'application/json', accept: 'application/json' },
})

async function laufStarten(daten) {
  const r = await formular('/api/runs', { harness: 'claude', branch_mode: 'keiner', expected_minutes: '45', ...daten })
  const j = await r.json()
  if (!j.runId) throw new Error(`run not started: ${JSON.stringify(j)}`)
  const s = db.prepare('SELECT tmux_session FROM runs WHERE id=?').get(j.runId)?.tmux_session
  if (s) sk.sessions.add(s)
  return j.runId
}
const melden = (runId, kind, text) => jsonPost(`/api/runs/${runId}/report`, { kind, text })
const laufRow = (id) => db.prepare('SELECT * FROM runs WHERE id=?').get(id)
const dbZeit = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')

let repoId = 0, repoId2 = 0, FLOWID = 0, FAV1 = 0, FAV2 = 0
let R_ALT = '', R_TICK = '', R_GEPLANT = '', R_LIVE = '', R_ENDE = '', R_OHNE_SESSION = ''

async function datenAnlegen() {
  for (const [harness, providers] of [['claude', []], ['opencode', ['opencode-zen', 'openrouter', 'deepseek']]]) {
    await formular('/settings/coding-agents/save',
      { harness, enabled: '1', ...(providers.length ? { providers } : {}) }, { alsBrowser: true })
  }
  for (const name of ['browser', 'browser-zwei']) {
    await formular('/repos/edit', { name, path: sk.REPO, base_branch: 'main', worktree_extras: '[]' }, { alsBrowser: true })
  }
  repoId = db.prepare('SELECT id FROM repos WHERE name=?').get('browser').id
  repoId2 = db.prepare('SELECT id FROM repos WHERE name=?').get('browser-zwei').id

  // Two favorites: one is enough for the dialog to stand, two are needed to see
  // that the chosen one is remembered.
  for (const [name, model] of [['Fav-eins', 'claude-opus-5'], ['Fav-zwei', 'claude-sonnet-4-5']]) {
    await formular('/settings/favorites/edit', { name, harness: 'claude', model }, { alsBrowser: true })
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

  await formular('/agents/edit', {
    repo_id: String(repoId), name: 'browser-agent', harness: 'claude', prompt: 'Browser-Testauftrag',
    branch_mode: 'keiner', expected_minutes: '45', schedule_kind: 'manuell', active: '1',
  }, { alsBrowser: true })

  R_ALT = await laufStarten({ repo_id: String(repoId), prompt: 'Browser-Lauf alt' })
  R_TICK = await laufStarten({ repo_id: String(repoId), prompt: 'Browser-Lauf tickt' })
  R_ENDE = await laufStarten({ repo_id: String(repoId), prompt: 'Browser-Lauf beendet' })
  R_OHNE_SESSION = await laufStarten({ repo_id: String(repoId), prompt: 'Browser-Lauf ohne Session' })
  R_LIVE = await laufStarten({ repo_id: String(repoId), prompt: 'Browser-Lauf laeuft' })
  for (const id of [R_ALT, R_TICK, R_ENDE, R_OHNE_SESSION]) await melden(id, 'done', 'fertig')

  // A planned run: the overview cell then looks FORWARD ("in 20 minutes").
  const g = await formular('/api/runs', {
    repo_id: String(repoId), harness: 'claude', prompt: 'Browser-Lauf geplant',
    branch_mode: 'keiner', expected_minutes: '45', start_mode: 'in', start_in_minutes: '20',
  })
  R_GEPLANT = (await g.json()).runId

  // Fixed points in time instead of "just now": the ladder in relTimeText is
  // what is under test, and it must not depend on how long the setup took.
  const jetzt = Date.now()
  db.prepare('UPDATE runs SET started_at=?, ended_at=? WHERE id=?')
    .run(dbZeit(jetzt - 5 * 60_000), dbZeit(jetzt - 3 * 60_000), R_ALT)
  db.prepare('UPDATE runs SET started_at=? WHERE id=?').run(dbZeit(jetzt - 12_000), R_TICK)
  // A finished run whose session is gone — the terminal must say so instead of
  // opening a black box against a 404.
  db.prepare('UPDATE runs SET tmux_session=NULL WHERE id=?').run(R_OHNE_SESSION)
}

// ================================================================== Test run
try {
  console.log(`Sandbox: ${sk.SB}`)
  await sk.bauen()
  await sk.hubStarten()
  db = sk.db
  kontext = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  await datenAnlegen()
  console.log(`Hub: ${sk.basis}   Chromium ${browser.version()}`)

  // ------------------------------------------------------------------ A1
  gruppe('A1 — relative timestamps: hydrated, ticking, exact on hover')

  await pruefe('a run started five minutes ago reads "5 minutes ago" and carries the exact time in its title', async () => {
    const p = await neueSeite(`/?repo=${repoId}`)
    const zelle = `tr[onclick*="${R_ALT}"] time.reltime`
    const text = (await p.textContent(zelle)).trim()
    wahr(/^\d+ minutes ago$/.test(text), `relative text (${text})`)
    const titel = await p.getAttribute(zelle, 'title')
    wahr(/\d{2}:\d{2}:\d{2}/.test(titel), `title carries the exact timestamp down to the second (${titel})`)
    sauber(p)
    await p.close()
  })

  await pruefe('the cell counts on by itself without the page being reloaded', async () => {
    const p = await neueSeite(`/?repo=${repoId}`)
    const zelle = `tr[onclick*="${R_TICK}"] time.reltime`
    const erst = (await p.textContent(zelle)).trim()
    wahr(/seconds ago$/.test(erst), `starts in seconds (${erst})`)
    await wartePage(p, ([sel, alt]) => document.querySelector(sel).textContent.trim() !== alt,
      [zelle, erst], 'the text to change on its own')
    const jetzt = (await p.textContent(zelle)).trim()
    wahr(/seconds ago$/.test(jetzt), `still counting seconds (${jetzt})`)
    sauber(p)
    await p.close()
  })

  await pruefe('a planned run reads forward: "in n minutes", not "n minutes ago"', async () => {
    // relTimeText is signed, like fmtRelativeTime on the server. Losing the sign
    // would make every waiting run look like it had already run.
    const p = await neueSeite(`/?repo=${repoId}`)
    const text = (await p.textContent(`tr[onclick*="${R_GEPLANT}"] time.reltime`)).trim()
    wahr(/^in \d+ minutes$/.test(text), `forward-looking text (${text})`)
    sauber(p)
    await p.close()
  })

  // ------------------------------------------------------------------ A2
  gruppe('A2 — the repo switcher in the header')

  await pruefe('choosing another repo appends ?repo= and navigates there', async () => {
    const p = await neueSeite(`/?repo=${repoId}`)
    await p.selectOption('#repo-switch', String(repoId2))
    await p.waitForURL(new RegExp(`[?&]repo=${repoId2}$`), { timeout: 10_000 })
    gleich(new URL(p.url()).pathname, '/', 'stays on the page one was standing on')
    sauber(p)
    await p.close()
  })

  // ------------------------------------------------------------------
  // The sidebar is the one panel that is on every page, so the one panel that
  // has to be foldable — and the fold has to survive the page, otherwise one
  // closes it again on every navigation. The class sits on the SHELL and not on
  // the sidebar itself, because the live channel replaces #status-sidebar whole
  // and would carry a class on it away with the swap.
  gruppe('The status sidebar folds away, and stays folded')

  await pruefe('the toggle folds the readings away and remembers it across pages', async () => {
    const p = await neueSeite(`/?repo=${repoId}`)
    wahr(await p.isVisible('#side-body'), 'open to begin with')
    gleich(await p.$eval('#side-toggle', b => b.getAttribute('aria-expanded')), 'true', 'and says so to a screen reader')
    await p.click('#side-toggle')
    falsch(await p.isVisible('#side-body'), 'folded away')
    gleich(await p.$eval('#side-toggle', b => b.getAttribute('aria-expanded')), 'false', 'and says that too')
    gleich(await p.evaluate(() => localStorage.getItem('cchub.sidebar.open')), '0', 'the choice is written down')
    // Another page, same choice — that is the whole point of writing it down.
    await p.goto(sk.basis + '/agents', { waitUntil: 'load' })
    falsch(await p.isVisible('#side-body'), 'still folded on the next page')
    wahr(await p.isVisible('#side-toggle'), 'but the way back is still reachable')
    await p.click('#side-toggle')
    wahr(await p.isVisible('#side-body'), 'and opens again')
    gleich(await p.evaluate(() => localStorage.getItem('cchub.sidebar.open')), '1', 'which is written down as well')
    sauber(p)
    await p.close()
  })
  await pruefe('a live update does not pop the folded sidebar back open', async () => {
    const p = await neueSeite(`/?repo=${repoId}`)
    await p.click('#side-toggle')
    falsch(await p.isVisible('#side-body'), 'folded')
    // Mark the element that is standing there now — the live channel replaces
    // the whole aside, so the mark disappearing IS the proof of the swap.
    await p.evaluate(() => { document.getElementById('status-sidebar').dataset.vorher = '1' })
    // A real run event, from outside the browser, exactly like the watcher's.
    await laufStarten({ repo_id: repoId, prompt: 'a run while the sidebar is folded' })
    await wartePage(p, () => !document.getElementById('status-sidebar')?.dataset.vorher,
      null, 'the live channel to swap the sidebar')
    // The server knows nothing about the fold, so without hub.js re-applying it
    // after the swap the sidebar would stand open again.
    falsch(await p.isVisible('#side-body'), 'still folded after the swap')
    gleich(await p.$eval('#side-toggle', b => b.getAttribute('aria-expanded')), 'false', 'and still says so')
    sauber(p)
    await p.close()
  })

  // ------------------------------------------------------------------
  // `label { display: block }` plus a field inline after the caption means every
  // row of a form starts at a different x, depending on how long the caption is.
  gruppe('Forms: captions in one column, tall fields with the caption above')

  await pruefe('every caption starts at the same x and its field at the same x', async () => {
    const p = await neueSeite(`/runs/new?repo=${repoId}`)
    const kanten = await p.$$eval('form[action="/runs/new"] > label:not(.chk)', (labels) => labels
      .filter(l => !l.hidden && !l.querySelector('textarea'))
      .map(l => {
        const feld = l.querySelector('input, select')
        return feld ? { links: Math.round(l.getBoundingClientRect().left), feld: Math.round(feld.getBoundingClientRect().left) } : null
      })
      .filter(Boolean))
    wahr(kanten.length >= 3, `at least three captioned fields (${kanten.length})`)
    gleich(new Set(kanten.map(k => k.links)).size, 1, 'all captions start at one x')
    gleich(new Set(kanten.map(k => k.feld)).size, 1, 'and all fields start at one x')
    wahr(kanten[0].feld > kanten[0].links, 'the field really stands beside its caption, not under it')
    sauber(p)
    await p.close()
  })
  await pruefe('the prompt caption stands ABOVE its box, not beside its bottom edge', async () => {
    const p = await neueSeite(`/runs/new?repo=${repoId}`)
    const masse = await p.$eval('form[action="/runs/new"] label:has(textarea)', (l) => {
      const ta = l.querySelector('textarea')
      const lr = l.getBoundingClientRect(), tr = ta.getBoundingClientRect()
      // The caption is the label's own text, so its box starts where the label
      // does and the textarea has to begin BELOW that line.
      return { labelOben: Math.round(lr.top), feldOben: Math.round(tr.top), feldLinks: Math.round(tr.left),
        labelLinks: Math.round(lr.left), hoehe: Math.round(tr.height) }
    })
    wahr(masse.hoehe > 100, `the box really is tall (${masse.hoehe}px) — that is what makes this matter`)
    wahr(masse.feldOben > masse.labelOben, 'the box starts below the caption')
    gleich(masse.feldLinks, masse.labelLinks, 'and uses the full width instead of standing in the second column')
    sauber(p)
    await p.close()
  })

  // ------------------------------------------------------------------ A3
  gruppe('A3 — the schedule shows only the kind that was chosen')

  await pruefe('every kind shows its own block, and "manual" shows none of them', async () => {
    const p = await neueSeite(`/agents/edit?repo=${repoId}`)
    for (const kind of ['woechentlich', 'einmalig', 'cron']) {
      await p.selectOption('#schedule-kind', kind)
      wahr(await p.isVisible(`.zp[data-kind="${kind}"]`), `${kind}: its own block`)
      for (const anders of ['woechentlich', 'einmalig', 'cron'].filter(k => k !== kind)) {
        falsch(await p.isVisible(`.zp[data-kind="${anders}"]`), `${kind}: ${anders} stays away`)
      }
    }
    await p.selectOption('#schedule-kind', 'manuell')
    for (const kind of ['woechentlich', 'einmalig', 'cron']) {
      falsch(await p.isVisible(`.zp[data-kind="${kind}"]`), `manual: ${kind} hidden`)
    }
    sauber(p)
    await p.close()
  })

  await pruefe('the anchor week only appears where an interval needs one', async () => {
    const p = await neueSeite(`/agents/edit?repo=${repoId}`)
    await p.selectOption('#schedule-kind', 'woechentlich')
    await p.selectOption('select[name=schedule_weeks]', '1')
    falsch(await p.isVisible('input[name=schedule_anchor]'), 'every week: no anchor')
    await p.selectOption('select[name=schedule_weeks]', '2')
    wahr(await p.isVisible('input[name=schedule_anchor]'), 'every second week: anchor')
    sauber(p)
    await p.close()
  })

  // ------------------------------------------------------------------ A4
  gruppe('A4 — the planned start switches per fieldset, not per page')

  await pruefe('the run form and the Quick-Run dialog do not switch each other', async () => {
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
    gleich((await zustaende()).length, 2, 'the block really stands twice')

    await p.selectOption('form[action="/runs/new"] select[data-start-switch]', 'at')
    let z = await zustaende()
    gleich(z[0].bloecke.at, false, 'the form shows its date block')
    gleich(z[0].bloecke.in, true, 'and hides the others')
    gleich(z[1].bloecke.at, true, 'the dialog stays exactly as it was')
    gleich(z[1].wert, 'now', 'and keeps its own choice')

    await p.click('#qr-open')
    await p.selectOption('#qr-form select[data-start-switch]', 'idle')
    z = await zustaende()
    gleich(z[1].bloecke.idle, false, 'now the dialog shows its idle block')
    gleich(z[0].bloecke.at, false, 'and the form still shows the date one')
    gleich(z[0].bloecke.idle, true, 'unswitched by the dialog')
    sauber(p)
    await p.close()
  })

  // ------------------------------------------------------------------ A5
  gruppe('A5 — the branch pattern only matters where a branch is wanted')

  await pruefe('the pattern field follows the mode, scoped to its own form', async () => {
    const p = await neueSeite(`/runs/new?repo=${repoId}`)
    const formular_ = 'form[action="/runs/new"]'
    falsch(await p.isVisible(`${formular_} [data-branch-pattern]`), 'mode "none": no pattern')
    await p.selectOption(`${formular_} select[data-branch-mode]`, 'neu')
    wahr(await p.isVisible(`${formular_} [data-branch-pattern]`), 'mode "new branch": pattern')
    gleich(await p.$eval('#qr-form [data-branch-pattern]', el => el.hidden), true,
      'the dialog\'s own branch rule is untouched')
    await p.selectOption(`${formular_} select[data-branch-mode]`, 'keiner')
    falsch(await p.isVisible(`${formular_} [data-branch-pattern]`), 'back to none: gone again')
    sauber(p)
    await p.close()
  })

  // ------------------------------------------------------------------ A7
  gruppe('A7 — the Quick-Run dialog starts a run without taking the page away')

  await pruefe('it opens with the cursor in the task field', async () => {
    const p = await neueSeite(`/?repo=${repoId}`)
    gleich(await p.$eval('#qr-dialog', d => d.open), false, 'closed to begin with')
    await p.click('#qr-open')
    gleich(await p.$eval('#qr-dialog', d => d.open), true, 'open')
    gleich(await p.evaluate(() => document.activeElement?.getAttribute('name')), 'prompt',
      'and the focus is where one types')
    sauber(p)
    await p.close()
  })

  await pruefe('the favorite chosen last is the one offered next time', async () => {
    const p = await neueSeite(`/?repo=${repoId}`)
    await p.click('#qr-open')
    await p.selectOption('#qr-fav', String(FAV2))
    gleich(await p.evaluate(() => localStorage.getItem('cchub.quickrun.favorite')), String(FAV2),
      'remembered in localStorage')
    await p.reload({ waitUntil: 'load' })
    gleich(await p.$eval('#qr-fav', s => s.value), String(FAV2), 'preselected after a reload')
    sauber(p)
    await p.close()
  })

  await pruefe('a quick run starts, clears ONLY the task and says so in a toast with a link', async () => {
    const vorher = db.prepare('SELECT count(*) c FROM runs').get().c
    const p = await neueSeite(`/?repo=${repoId}`)
    await p.click('#qr-open')
    await p.selectOption('#qr-fav', String(FAV1))
    await p.fill('#qr-form textarea[name=prompt]', 'Browser-Quickrun: tu etwas')
    await p.click('#qr-form button[type=submit]')
    await p.waitForSelector('#cchub-toasts .toast', { timeout: 15_000 })

    gleich(await p.$eval('#qr-dialog', d => d.open), false, 'the dialog closed itself')
    gleich(await p.$eval('#qr-form textarea[name=prompt]', el => el.value), '', 'the task is cleared')
    gleich(await p.$eval('#qr-fav', s => s.value), String(FAV1), 'the favorite stands as the next run\'s setup')
    gleich(await p.$eval('#qr-form select[name=repo_id]', s => s.value), String(repoId), 'the repo stands')
    gleich(await p.$eval('#qr-form select[data-branch-mode]', s => s.value), 'keiner', 'the branch rule stands')
    gleich(await p.$eval('#qr-form select[data-start-switch]', s => s.value), 'now', 'the start time stands')
    gleich(new URL(p.url()).pathname, '/', 'and the page one started from is still the page one is on')

    enthaelt(await p.textContent('#cchub-toasts .toast span'), 'Run started', 'the toast says what happened')
    const href = await p.$eval('#cchub-toasts .toast a', a => a.getAttribute('href'))
    wahr(/^\/runs\/[0-9a-f-]{36}$/.test(href), `with a link to the run (${href})`)
    gleich(db.prepare('SELECT count(*) c FROM runs').get().c, vorher + 1, 'exactly one run was created')
    const neu = laufRow(href.slice('/runs/'.length))
    if (neu?.tmux_session) sk.sessions.add(neu.tmux_session)
    gleich(neu.status, 'running', 'and it really runs')
    sauber(p)
    await p.close()
  })

  await pruefe('a refused quick run stands readable in the dialog instead of vanishing', async () => {
    const p = await neueSeite(`/?repo=${repoId}`)
    await p.click('#qr-open')
    await p.evaluate(() => { document.querySelector('details.qr-more').open = true })
    await p.selectOption('#qr-form select[data-branch-mode]', 'neu')      // a new branch without a pattern
    await p.fill('#qr-form textarea[name=prompt]', 'Browser-Quickrun: kaputt')
    await p.click('#qr-form button[type=submit]')
    await p.waitForSelector('#qr-error:not([hidden])', { timeout: 15_000 })
    wahr((await p.textContent('#qr-error')).trim().length > 0, 'with the reason from the server')
    gleich(await p.$eval('#qr-dialog', d => d.open), true, 'the dialog stays open so it can be corrected')
    gleich(await p.$eval('#qr-form button[type=submit]', b => b.disabled), false, 'and can be sent again')
    sauber(p)
    await p.close()
  })

  // ------------------------------------------------------------------ A8
  gruppe('A8 — renaming a run in place')

  await pruefe('the pencil stays out of reach until the row is hovered — but the keyboard finds it', async () => {
    const p = await neueSeite(`/?repo=${repoId}`)
    const stift = `tr[onclick*="${R_ALT}"] [data-title-edit]`
    gleich(await p.$eval(stift, b => getComputedStyle(b).opacity), '0', 'invisible at rest')
    await p.hover(`tr[onclick*="${R_ALT}"] .title-cell`)
    await wartePage(p, (sel) => getComputedStyle(document.querySelector(sel)).opacity === '1',
      stift, 'the pencil to appear on hover')
    await p.mouse.move(0, 0)
    await p.$eval(stift, b => b.focus())
    gleich(await p.$eval(stift, b => getComputedStyle(b).opacity), '1', 'and it appears on focus alone')
    sauber(p)
    await p.close()
  })

  await pruefe('Enter saves — and sends exactly one request, not two', async () => {
    // input.disabled takes the focus and thereby fires blur, which lands in
    // speichern() a second time. Without the 'laeuft' guard every rename would
    // go out twice.
    const p = await neueSeite(`/?repo=${repoId}`)
    const anfragen = []
    p.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/title')) anfragen.push(r.url()) })
    const zeile = `tr[onclick*="${R_ALT}"]`
    await p.click(`${zeile} [data-title-edit]`)
    await p.waitForSelector(`${zeile} input.title-input`)
    gleich(await p.$eval(`${zeile} input.title-input`, i => i.maxLength), 80, 'the input is capped at 80')
    await p.fill(`${zeile} input.title-input`, 'Von Hand benannt')
    await p.keyboard.press('Enter')
    await wartePage(p, (sel) => document.querySelector(sel)?.textContent.trim() === 'Von Hand benannt',
      `${zeile} [data-title-text]`, 'the new title to stand in the row')
    gleich(anfragen.length, 1, 'one POST /api/runs/<id>/title, no double send')
    gleich(laufRow(R_ALT).title, 'Von Hand benannt', 'and it is what the database holds')
    gleich(await p.$$eval(`${zeile} input.title-input`, els => els.length), 0, 'the input made way for the link again')
    sauber(p)
    await p.close()
  })

  await pruefe('Escape throws the change away without asking the server', async () => {
    const p = await neueSeite(`/?repo=${repoId}`)
    const anfragen = []
    p.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/title')) anfragen.push(r.url()) })
    const zeile = `tr[onclick*="${R_ALT}"]`
    await p.click(`${zeile} [data-title-edit]`)
    await p.fill(`${zeile} input.title-input`, 'Weggeworfen')
    await p.keyboard.press('Escape')
    await wartePage(p, (sel) => document.querySelectorAll(sel).length === 0,
      `${zeile} input.title-input`, 'the input to close')
    gleich((await p.textContent(`${zeile} [data-title-text]`)).trim(), 'Von Hand benannt', 'the old title stayed')
    gleich(anfragen.length, 0, 'and nothing was sent')
    gleich(laufRow(R_ALT).title, 'Von Hand benannt', 'the database is untouched')
    sauber(p)
    await p.close()
  })

  await pruefe('on the detail page the browser tab is renamed along with the run', async () => {
    const p = await neueSeite(`/runs/${R_ALT}`)
    await p.click('h2 [data-title-edit]')
    await p.fill('h2 input.title-input', 'Auf der Detailseite benannt')
    await p.keyboard.press('Enter')
    await wartePage(p, () => document.title === 'cc-hub — Auf der Detailseite benannt',
      null, 'document.title to follow')
    gleich(laufRow(R_ALT).title, 'Auf der Detailseite benannt', 'and the run carries the name')
    sauber(p)
    await p.close()
  })

  // ------------------------------------------------------------------ A9
  gruppe('A9 — a trip to the flow editor does not cost what was typed')

  await pruefe('the flow links carry the way back, and the form comes back with it', async () => {
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
    await p.selectOption('select[data-branch-mode]', 'neu')
    await p.fill('input[name=branch_pattern]', 'agent/browser/{datum}')
    await p.check(`fieldset.flows-attach input[name=flows][value="${FLOWID}"]`)
    await p.uncheck('input[name=active]')      // deliberately OFF — and it must stay off

    const link = await p.$eval('fieldset.flows-attach p a[href^="/flows"]', a => a.getAttribute('href'))
    gleich(new URL(link, 'http://x').searchParams.get('back'), zurueck, 'the link knows the way back')

    await p.click('fieldset.flows-attach p a[href^="/flows"]')
    await p.waitForURL(/\/flows\/edit/, { timeout: 10_000 })
    // The editor's Back button goes exactly there — a fresh load, which is what
    // restoreForm() is for.
    await p.goto(sk.basis + zurueck, { waitUntil: 'load' })

    gleich(await p.$eval('input[name=name]', el => el.value), 'geparkter-agent', 'name')
    gleich(await p.$eval('textarea[name=prompt]', el => el.value), 'Dieser Text darf den Ausflug nicht kosten.', 'task')
    gleich(await p.$eval('input[name=expected_minutes]', el => el.value), '77', 'expected duration')
    gleich(await p.$eval('#model', el => el.value), 'claude-opus-5', 'model')
    gleich(await p.$eval('select[data-branch-mode]', el => el.value), 'neu', 'branch mode')
    gleich(await p.$eval('input[name=branch_pattern]', el => el.value), 'agent/browser/{datum}', 'branch pattern')
    gleich(await p.$eval(`fieldset.flows-attach input[name=flows][value="${FLOWID}"]`, el => el.checked), true,
      'the ticked flow is ticked again')
    // The one that says the most: an unchecked box is NOT in a FormData, and
    // "absent" has to mean "was not ticked" — not "leave it as the server sent it",
    // which for this box is checked.
    gleich(await p.$eval('input[name=active]', el => el.checked), false,
      'and the box left unticked comes back unticked')
    // data-gewaehlt is the memory between the restore and the fetch that fills
    // the <select> afterwards — the most fragile seam in the file.
    await wartePage(p, () => document.getElementById('effort')?.value === 'high', null,
      'the asynchronously filled effort select to carry the choice again')
    gleich(await p.$eval('#effort', el => el.dataset.gewaehlt), 'high', 'through data-gewaehlt')
    sauber(p)
    await p.close()
  })

  await pruefe('coming back from a freshly built flow ticks it and cleans the URL', async () => {
    const p = await neueSeite(`/agents/edit?repo=${repoId}&flow=${FLOWID}`)
    gleich(await p.$eval(`fieldset.flows-attach input[name=flows][value="${FLOWID}"]`, el => el.checked), true,
      'the new flow is attached right away — that is what the trip was for')
    falsch(new URL(p.url()).searchParams.has('flow'), 'and the parameter is gone from the address bar')
    sauber(p)
    await p.close()
  })

  await pruefe('the trigger editor: "run merged" asks for a repo, the other kinds do not', async () => {
    // The root editor is the one panel of the designer that is ours from top to
    // bottom, and its newest branch is a select that appears only for one
    // trigger kind. That is the silent breakage this suite exists for: no
    // exception, just a filter nobody can set.
    const p = await neueSeite(`/flows/edit?id=${FLOWID}`)
    await p.waitForSelector('#trigger-kind', { timeout: 10_000 })
    falsch(await p.$('#trigger-repo'), 'a "run finished" flow shows the agent list, not a repo')
    await p.selectOption('#trigger-kind', 'run_merged')
    await p.waitForSelector('#trigger-repo', { timeout: 10_000 })
    const optionen = await p.$$eval('#trigger-repo option', o => o.map(x => x.textContent.trim()))
    enthaelt(optionen.join('|'), 'all repos', 'the default is every repo')
    enthaelt(optionen.join('|'), 'browser', 'and the repos of this hub are offered')
    await p.selectOption('#trigger-repo', String(repoId))
    await p.selectOption('#trigger-kind', 'cron')
    falsch(await p.$('#trigger-repo'), 'a schedule has no repo filter — the block really goes away again')
    sauber(p)
    await p.close()
  })

  // ------------------------------------------------------------------ A10
  gruppe('A10 — the cascade: coding agent → provider → model → effort')

  await pruefe('a subscription coding agent shows no provider, but its models and its effort levels', async () => {
    const p = await neueSeite(`/runs/new?repo=${repoId}`)
    await p.selectOption('select[name=harness]', 'claude')
    await wartePage(p, () => document.getElementById('prov-label').hidden === true, null,
      'the provider label to disappear for claude')
    await wartePage(p, () => document.querySelectorAll('#modelle option').length > 0, null,
      'the model list to arrive')
    gleich(await p.$eval('#prov', s => s.value), '', 'and no provider is set')
    await wartePage(p, () => document.getElementById('effort-label').hidden === false, null,
      'the effort field to appear where levels exist')
    wahr(await p.$$eval('#effort option', o => o.length) > 1, 'with its levels')
    sauber(p)
    await p.close()
  })

  await pruefe('switching the coding agent REPLACES provider, model and effort instead of carrying them over', async () => {
    const p = await neueSeite(`/runs/new?repo=${repoId}`)
    await p.selectOption('select[name=harness]', 'claude')
    await wartePage(p, () => document.getElementById('effort-label').hidden === false, null, 'claude to be ready')
    await p.fill('#model', 'claude-opus-5')
    await p.selectOption('#effort', 'high')

    await p.selectOption('select[name=harness]', 'opencode')
    await wartePage(p, () => document.getElementById('prov-label').hidden === false, null,
      'the provider label to appear for a keyed coding agent')
    falsch((await p.$eval('#model', el => el.value)) === 'claude-opus-5',
      'a claude model slug is not carried into opencode')
    gleich(await p.$eval('#effort', s => s.value), '', 'and neither is the effort level')
    const provider = await p.$$eval('#prov option', o => o.map(x => x.value))
    wahr(provider.includes('opencode-zen'), `the providers this coding agent really has here (${provider.join(',')})`)
    sauber(p)
    await p.close()
  })

  await pruefe('the effort field hides itself where the combination knows no levels', async () => {
    // Hiding instead of graying out: with opencode an invalid level fizzles
    // silently, so a field without effect is worse than none.
    const p = await neueSeite(`/runs/new?repo=${repoId}`)
    await p.selectOption('select[name=harness]', 'opencode')
    await wartePage(p, () => document.getElementById('prov-label').hidden === false, null, 'opencode to be ready')
    await p.fill('#model', 'gibtsnicht/quatsch')
    await wartePage(p, () => document.getElementById('effort-label').hidden === true, null,
      'the effort field to disappear for a model nobody knows')
    falsch(await p.isVisible('#effort'), 'really gone from the page, not merely marked')
    sauber(p)
    await p.close()
  })

  await pruefe('the OpenRouter routing block belongs to opencode + openrouter and to nothing else', async () => {
    const p = await neueSeite(`/runs/new?repo=${repoId}`)
    await p.selectOption('select[name=harness]', 'opencode')
    await wartePage(p, () => document.getElementById('prov-label').hidden === false, null, 'opencode to be ready')
    await p.selectOption('#prov', 'opencode-zen')
    gleich(await p.$eval('#or-routing', el => el.hidden), true, 'opencode + Zen: no serving provider to pass through')
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

  await pruefe('the goal belongs to the coding agent that knows one — hidden means not submitted', async () => {
    // A hidden field that still submits is a text the operator cannot see and
    // cannot correct: switching the coding agent would silently send along a
    // condition meant for claude. So hiding and disabling are one move.
    const p = await neueSeite(`/runs/new?repo=${repoId}`)
    await p.selectOption('select[name=harness]', 'claude')
    await wartePage(p, () => document.getElementById('goal-block').hidden === false, null,
      'the goal block to be there for claude')
    // Folded away: it is optional, and a form should not open with a field most
    // runs leave empty. One click is what a goal costs.
    falsch(await p.$eval('#goal-block', el => el.open), 'and folded, because most runs have none')
    await p.click('#goal-block summary')
    await p.fill('#goal-block textarea', 'all tests are green')
    await p.selectOption('select[name=harness]', 'opencode')
    await wartePage(p, () => document.getElementById('goal-block').hidden === true, null,
      'and to disappear for a coding agent without a /goal')
    wahr(await p.$eval('#goal-block textarea', el => el.disabled), 'the field is disabled, so nothing is submitted')
    await p.selectOption('select[name=harness]', 'claude')
    await wartePage(p, () => document.getElementById('goal-block').hidden === false, null, 'and comes back')
    gleich(await p.$eval('#goal-block textarea', el => el.value), 'all tests are green',
      'with what was typed — switching back and forth does not cost it')
    sauber(p)
    await p.close()
  })

  // ------------------------------------------------------------------ A13
  gruppe('A13 — the sessions page: filter, selection, non-blocking ending')

  await pruefe('a running agent\'s row is out of reach until it is asked for', async () => {
    const p = await neueSeite('/sessions')
    const laufend = `tr[data-session="${laufRow(R_LIVE).tmux_session}"]`
    gleich(await p.$eval('#sess-show-running', c => c.checked), false, 'the switch starts off')
    gleich(await p.$eval(laufend, tr => tr.hidden), true, 'so the running row is hidden')
    falsch(await p.$eval('#sess-hidden', el => el.hidden), 'and the page says how many are hidden')
    wahr(/\d+/.test(await p.textContent('#sess-hidden')), 'with the number in it')

    await p.check('#sess-show-running')
    gleich(await p.$eval(laufend, tr => tr.hidden), false, 'switched on it is there')
    await p.reload({ waitUntil: 'load' })
    gleich(await p.$eval('#sess-show-running', c => c.checked), true, 'and the choice survives a reload')
    gleich(await p.$eval(laufend, tr => tr.hidden), false, 'row still visible')
    sauber(p)
    await p.close()
  })

  await pruefe('"select all" only touches rows one can actually see', async () => {
    const p = await neueSeite('/sessions')
    await p.uncheck('#sess-show-running')     // running rows out of reach again
    const laufend = `tr[data-session="${laufRow(R_LIVE).tmux_session}"]`
    await p.check('#sess-all')
    gleich(await p.$eval(`${laufend} .sess-pick`, b => b.checked), false,
      'the hidden row is not selected — one may not end what is not on screen')
    const gewaehlt = await p.$$eval('tbody tr[data-session]', trs =>
      trs.filter(tr => !tr.hidden && tr.querySelector('.sess-pick')?.checked).length)
    wahr(gewaehlt > 0, 'the visible ones are')
    enthaelt(await p.textContent('#sess-kill-selected'), `(${gewaehlt})`, 'and the button carries the number')
    sauber(p)
    await p.close()
  })

  await pruefe('a click marks its row in the same tick and lets the request go in the background', async () => {
    const p = await neueSeite('/sessions')
    const name = laufRow(R_ENDE).tmux_session
    const zeile = `tr[data-session="${name}"]`
    gleich(await p.$eval(zeile, tr => tr.dataset.running), '0', 'the run behind it is over')
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
    wahr(sofort.ending, 'the row is marked "ending" straight away')
    enthaelt(sofort.text, 'ending', 'and says so')
    wahr(sofort.knopfAus, 'its button cannot be pressed twice')
    await wartePage(p, (sel) => document.querySelector(sel).classList.contains('gone'), zeile,
      'the row to be struck through once the server confirms')
    gleich(await p.$eval(zeile, tr => tr.classList.contains('ending')), false, 'the in-between state is over')
    sauber(p)
    await p.close()
  })

  // ------------------------------------------------------------------ A14
  gruppe('A14 — the terminal')

  await pruefe('without a session there is a sentence, not a black box', async () => {
    const p = await neueSeite(`/runs/${R_OHNE_SESSION}`)
    gleich(await p.$eval('#term', el => el.dataset.session), '0', 'the page says there is none')
    enthaelt(await p.textContent('#term'), 'No tmux session', 'and the box says it in words')
    wahr(await p.$eval('#term', el => el.classList.contains('dim')), 'toned down')
    gleich(await p.$$eval('#term .xterm', els => els.length), 0, 'no terminal was built at all')
    sauber(p)
    await p.close()
  })

  await pruefe('with a live session xterm builds up and the session speaks', async () => {
    const p = await neueSeite(`/runs/${R_LIVE}`)
    gleich(await p.$eval('#term', el => el.dataset.session), '1', 'session there')
    gleich(await p.$eval('#term', el => el.dataset.live), '1', 'and write access, because the run is live')
    await p.waitForSelector('#term .xterm-screen', { timeout: 15_000 })
    // What stands there is this run's own prompt — proof that the socket is
    // attached to THIS session and not merely open.
    await wartePage(p, (id) => (document.querySelector('#term .xterm-rows')?.textContent || '').includes(id),
      R_LIVE, 'the tmux session\'s content to arrive through the WebSocket')
    sauber(p)
    await p.close()
  })

  await pruefe('a page without a terminal starts none and stays quiet', async () => {
    const p = await neueSeite(`/?repo=${repoId}`)
    gleich(await p.$$eval('#term', els => els.length), 0, 'no terminal box on the overview')
    sauber(p)
    await p.close()
  })

  // ----------------------------------------------------------------
  gruppe('The live channel — the page follows the run without being reloaded')

  // Every test here changes the run from OUTSIDE the browser (through the API,
  // the way the watcher or a reporting agent would) and then waits for the open
  // page to catch up on its own. Nothing is clicked, nothing is reloaded.

  await pruefe('a title generated after the fact arrives on the open overview', async () => {
    const p = await neueSeite(`/?repo=${repoId}`)
    const vorher = await p.textContent(`#run-${R_ALT} [data-title-text]`)
    await formular(`/api/runs/${R_ALT}/title`, { title: 'Arrived by itself' })
    await wartePage(p, (id) => document.querySelector(`#run-${id} [data-title-text]`)?.textContent === 'Arrived by itself',
      R_ALT, 'the row to carry the new title')
    falsch(vorher === 'Arrived by itself', 'and it really was something else before')
    sauber(p)
    await p.close()
  })

  await pruefe('a run that did not exist yet appears in the table by itself', async () => {
    const p = await neueSeite(`/?repo=${repoId}`)
    const neu = await laufStarten({ repo_id: repoId, prompt: 'born while the page was open' })
    // The row cannot be created in place — the empty state and the sort order
    // live in the tbody, so the parent is re-rendered. This is the case a
    // row-level swap cannot serve.
    await wartePage(p, (id) => !!document.getElementById(`run-${id}`), neu, 'the new row to show up')
    sauber(p)
    await p.close()
  })

  await pruefe('a run leaving the overview takes its row with it', async () => {
    const p = await neueSeite(`/?repo=${repoId}`)
    wahr(await p.$(`#run-${R_ENDE}`) !== null, 'the finished run is listed to begin with')
    await formular(`/api/runs/${R_ENDE}/archive`, {})
    // The fragment answers 204 for an archived run, and 204 means gone, not broken.
    await wartePage(p, (id) => !document.getElementById(`run-${id}`), R_ENDE, 'the archived row to disappear')
    sauber(p)
    await p.close()
  })

  await pruefe('a row being renamed is left alone until the typing is done', async () => {
    // The half-typed title exists only in the DOM, so a swap would throw it
    // away mid-word. This is the one case where the live channel has to hold back.
    const p = await neueSeite(`/?repo=${repoId}`)
    await p.hover(`#run-${R_TICK}`)
    await p.click(`#run-${R_TICK} [data-title-edit]`)
    await p.fill(`#run-${R_TICK} .title-inline input`, 'half typed')
    await formular(`/api/runs/${R_TICK}/title`, { title: 'pushed from outside' })
    await new Promise(r => setTimeout(r, 900))   // long enough for the swap to have happened
    // Check the input still EXISTS before asking for its value: if the row was
    // swapped, the element is gone and inputValue() would sit in a 30 s timeout
    // instead of saying what went wrong.
    const feld = await p.$(`#run-${R_TICK} .title-inline input`)
    wahr(feld !== null, 'the open input was not swapped away underneath the cursor')
    gleich(feld ? await feld.inputValue() : '(row was replaced)', 'half typed', 'the typing survived')
    await p.keyboard.press('Escape')
    sauber(p)
    await p.close()
  })

  await pruefe('the detail page follows along without touching the terminal', async () => {
    const p = await neueSeite(`/runs/${R_LIVE}`)
    await wartePage(p, () => !!document.querySelector('#term .xterm-rows'), null, 'the terminal to be up')
    // Mark the very xterm instance: if the swap ever reaches #term, this is gone
    // — and with it the WebSocket, which would leak a tmux client that keeps
    // resizing the running agent's window.
    await p.evaluate(() => { document.querySelector('#term').dataset.marke = 'unberuehrt' })
    await formular(`/api/runs/${R_LIVE}/title`, { title: 'Detail follows along' })
    await wartePage(p, () => document.querySelector('#run-head [data-title-text]')?.textContent === 'Detail follows along',
      null, 'the heading to carry the new title')
    gleich(await p.getAttribute('#term', 'data-marke'), 'unberuehrt', 'the terminal was never replaced')
    wahr(await p.$('#term .xterm-rows') !== null, 'and it is still a live terminal')
    sauber(p)
    await p.close()
  })

  await pruefe('the channel reconnects by itself and keeps working', async () => {
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
    await formular(`/api/runs/${R_ALT}/title`, { title: 'After a reconnect' })
    await wartePage(p, (id) => document.querySelector(`#run-${id} [data-title-text]`)?.textContent === 'After a reconnect',
      R_ALT, 'the row to update after the page came back')
    sauber(p)
    await p.close()
  })
} catch (err) {
  console.log(`\nAborted: ${err.stack}`)
  zaehler.fehler.push({ name: 'Test run', grund: err.message })
} finally {
  await aufraeumen()
}

process.exit(bericht('Browser tests', start))
