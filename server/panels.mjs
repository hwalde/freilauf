// Freilauf — panels: numbers a PROJECT pushes into the status sidebar.
//
// The sidebar answers "how is the machine doing" — quota, work in flight, open
// incidents, memory. What it could not answer was "how is the WORK doing", and
// that question is the project's own: how many findings are still open, how
// many tickets, how many failing tests. The hub cannot know it, and it must not
// learn it: Freilauf drives one repository today and is meant to drive a
// thousand, so a counting rule of one project has no business in this code.
//
// So the project says it, and the hub only stores and renders. A panel value is
// pushed (`POST /api/panels`, `bin/fl-panel`), it is per repo, and it carries
// the moment it was measured.
//
// ## Why push, and not a command the hub runs
//
// Measured on this machine, 2026-09-04, and it is the whole reason this module
// has the shape it has: the operator's checkout of the pilot repository was
// **627 commits behind `origin/main`** and did not contain the register tool at
// all. The hub merges into `origin/{base}`; a working checkout learns of that
// only when a human runs `git pull`. A panel that counted there would have
// shown a number that was days old, on every page, looking current — the exact
// staleness the claude quota panel was already caught on.
//
// The producer, on the other hand, sits in the right place by construction: a
// `run_merged` flow runs in the integration worktree, at `origin/{base}`, in
// the very moment the number changed. It costs one push per merge — a handful
// per day — where polling every two minutes would ask 720 times for a value
// that moved five times.
//
// ## Data, never markup
//
// A panel delivers numbers and labels; the hub renders them (`panelsBlock()` in
// pages.mjs). Not for fear of an attacker — whoever can push here can already
// reach every other POST route on this hub — but for three duller reasons that
// outlive any threat model:
//
//   - the folded sidebar's RAIL draws dots and bars out of values; it can do
//     nothing at all with a fragment of HTML,
//   - `GET /api/panels` is what a skill, a flow condition or a later statistic
//     reads — a number can be compared, alerted on and drawn, HTML can only be
//     pasted,
//   - markup would freeze this hub's own CSS class names into a contract with
//     code we never see.
//
// The freedom that costs nothing is given back instead: a `href` on the
// headline, and a `note` in a tiny Markdown subset the hub renders itself.
import db from './db.mjs'
import { publish } from './events.mjs'
import { parseDbUtc, toDbUtc } from './util.mjs'

db.exec(`
CREATE TABLE IF NOT EXISTS panel_values (
  repo_id  INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  key      TEXT NOT NULL,
  value    TEXT NOT NULL DEFAULT '{}',
  -- A producer that could not measure says so here. NULL means the value
  -- stands; a string means the last attempt failed, and the block shows the
  -- previous numbers greyed out with the reason. "I have nothing to say" and
  -- "I am broken" must never look alike.
  error    TEXT,
  ttl_min  INTEGER,
  source   TEXT,
  at       TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (repo_id, key)
);
`)

/** Panel keys: the same shape a plugin id has — lowercase, digits, dashes. */
export const PANEL_KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/

/** Hard caps. A sidebar column is 240px wide; anything past this is not a panel. */
export const PANEL_MAX_ITEMS = 8
const MAX_TITLE = 40
const MAX_LABEL = 40
const MAX_NOTE = 200
const MAX_ERROR = 200
const MAX_PANELS_PER_REPO = 6

/** The tones a value may carry. Anything else is dropped, never rendered raw. */
const TONES = ['red', 'yellow', 'green']

/**
 * A number, or null — and `''` is null, never 0.
 *
 * `Number('')` is 0 AND finite, which is how an unset field becomes a confident
 * zero. This trap has its own entry in AGENTS.md twice over; a panel is exactly
 * the place it would be invisible, because "0 open findings" reads like good
 * news rather than like a missing value.
 */
function num(v) {
  if (v === null || v === undefined) return null
  if (typeof v === 'string' && v.trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function text(v, max) {
  if (v === null || v === undefined) return null
  const s = String(v).replace(/\s+/g, ' ').trim()
  return s ? s.slice(0, max) : null
}

/**
 * A link the browser can actually follow: an absolute http(s) URL or a path on
 * this hub. A filesystem path inside the repository is dead in a browser, and a
 * `javascript:` one is not a link at all.
 */
function href(v) {
  const s = text(v, 500)
  if (!s) return null
  if (/^https?:\/\//i.test(s)) return s
  if (s.startsWith('/') && !s.startsWith('//')) return s
  return null
}

function tone(v) {
  const s = String(v ?? '').trim().toLowerCase()
  return TONES.includes(s) ? s : null
}

/**
 * Bring whatever a producer pushed into the one shape the renderer knows.
 *
 * Returns `{ ok, value, problems }`. It is deliberately forgiving about what it
 * can repair (a count as a string, an unknown tone, a fourteenth item) and
 * strict about what it cannot (no items and no total at all is not a panel).
 * A producer is a 40-line script in somebody else's repository; a rejection it
 * cannot read is worth less than a value quietly cut to eight rows.
 */
export function normalizePanel(raw) {
  const problems = []
  if (raw === null || raw === undefined) return { ok: false, value: null, problems: ['no value'] }
  let obj = raw
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw) } catch (err) { return { ok: false, value: null, problems: [`not valid JSON: ${err.message}`] } }
  }
  if (typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, value: null, problems: ['the value must be a JSON object'] }
  }

  const items = []
  const rawItems = Array.isArray(obj.items) ? obj.items : []
  for (const it of rawItems) {
    if (items.length >= PANEL_MAX_ITEMS) { problems.push(`more than ${PANEL_MAX_ITEMS} items — the rest was dropped`); break }
    if (!it || typeof it !== 'object') continue
    const label = text(it.label ?? it.key, MAX_LABEL)
    if (!label) continue
    items.push({
      key: text(it.key, MAX_LABEL) ?? label,
      label,
      count: num(it.count),
      tone: tone(it.tone),
      href: href(it.href),
    })
  }

  const total = num(obj.total)
  if (total === null && !items.length) {
    return { ok: false, value: null, problems: ['a panel needs a total or at least one item'] }
  }

  return {
    ok: true,
    problems,
    value: {
      title: text(obj.title, MAX_TITLE),
      total,
      tone: tone(obj.tone),
      href: href(obj.href),
      note: text(obj.note, MAX_NOTE),
      items,
    },
  }
}

function shape(row) {
  if (!row) return null
  let value = null
  try { value = JSON.parse(row.value || '{}') } catch { value = null }
  return {
    repoId: row.repo_id,
    key: row.key,
    title: value?.title || row.key,
    total: value?.total ?? null,
    tone: value?.tone ?? null,
    href: value?.href ?? null,
    note: value?.note ?? null,
    items: Array.isArray(value?.items) ? value.items : [],
    error: row.error || null,
    ttlMin: row.ttl_min ?? null,
    source: row.source || null,
    at: row.at,
    atMs: parseDbUtc(row.at),
  }
}

/**
 * Is this reading still current?
 *
 * `fresh` when it is inside its own TTL, `stale` when it is past it, `error`
 * when the last push said the measurement failed. A panel WITHOUT a ttl is
 * never stale — it is a value that changes when the work changes, and a
 * producer that pushes on merge has no business promising an interval.
 */
export function panelState(panel, nowMs = Date.now()) {
  if (!panel) return 'error'
  if (panel.error) return 'error'
  if (!panel.ttlMin || !panel.atMs) return 'fresh'
  return nowMs - panel.atMs > panel.ttlMin * 60_000 ? 'stale' : 'fresh'
}

/** Every panel of one repo, in the order they were first pushed. */
export function panelValues(repoId) {
  if (repoId == null) return []
  return db.prepare('SELECT * FROM panel_values WHERE repo_id=? ORDER BY key').all(Number(repoId)).map(shape)
}

/** One panel, or null. */
export function panelValue(repoId, key) {
  if (repoId == null) return null
  return shape(db.prepare('SELECT * FROM panel_values WHERE repo_id=? AND key=?').get(Number(repoId), String(key)))
}

/**
 * Store one panel value.
 *
 * `value` may be null when `error` is given: a producer that failed to measure
 * keeps the numbers it pushed last time and only says that they are no longer
 * being confirmed. Announcing goes through `publish()` directly rather than
 * through `addEvent()` — a panel is not a run and has no event list; the client
 * answers a `panel` event by re-fetching the sidebar fragment, exactly as it
 * answers a run event.
 */
export function setPanelValue({ repoId, key, value = null, error = null, ttlMin = null, source = null }) {
  const id = Number(repoId)
  const k = String(key ?? '')
  // The repo is checked HERE and not only in the route, because `foreign_keys`
  // really is ON in this database: an unknown id would otherwise leave SQLite
  // to throw a constraint error out of a write path, and a refused push has to
  // be an answer the caller can read, never a 500.
  if (!Number.isFinite(id) || !db.prepare('SELECT 1 FROM repos WHERE id=?').get(id)) {
    return { ok: false, error: `unknown repo ${JSON.stringify(repoId)}` }
  }
  if (!PANEL_KEY_RE.test(k)) return { ok: false, error: `invalid panel key ${JSON.stringify(k)}` }

  const known = panelValue(id, k)
  if (!known) {
    const n = db.prepare('SELECT count(*) c FROM panel_values WHERE repo_id=?').get(id).c
    if (n >= MAX_PANELS_PER_REPO) return { ok: false, error: `a repo carries at most ${MAX_PANELS_PER_REPO} panels` }
  }

  let stored = known ? JSON.stringify({
    title: known.title, total: known.total, tone: known.tone,
    href: known.href, note: known.note, items: known.items,
  }) : '{}'
  const problems = []
  if (value !== null && value !== undefined) {
    const norm = normalizePanel(value)
    if (!norm.ok) return { ok: false, error: norm.problems.join('; ') }
    problems.push(...norm.problems)
    stored = JSON.stringify(norm.value)
  } else if (!known && !error) {
    return { ok: false, error: 'a panel needs a value' }
  }

  db.prepare(`INSERT INTO panel_values(repo_id, key, value, error, ttl_min, source, at)
              VALUES(?,?,?,?,?,?,?)
              ON CONFLICT(repo_id, key) DO UPDATE SET
                value = excluded.value, error = excluded.error,
                ttl_min = excluded.ttl_min, source = excluded.source, at = excluded.at`)
    .run(id, k, stored, text(error, MAX_ERROR), num(ttlMin) === null ? null : Math.max(0, Math.round(num(ttlMin))),
      text(source, 80), toDbUtc(Date.now()))

  publish('panel', { repoId: id, key: k })
  return { ok: true, problems, panel: panelValue(id, k) }
}

/** Forget one panel. A key that was never there is not an error — it is gone either way. */
export function deletePanelValue(repoId, key) {
  const id = Number(repoId)
  if (!Number.isFinite(id)) return { ok: false, error: 'unknown repo' }
  db.prepare('DELETE FROM panel_values WHERE repo_id=? AND key=?').run(id, String(key))
  publish('panel', { repoId: id, key: String(key) })
  return { ok: true }
}
