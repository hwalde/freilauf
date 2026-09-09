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
//
// ## And a panel may TAKE a value, not only show one
//
// The block above is about numbers travelling one way. The other direction was
// asked for by the same operator on the same day: "how many swarm workers may
// run at once" is a number that BELONGS next to the number of open findings,
// and having to open a terminal to change it is what makes an operator not
// change it. So a panel value may carry `controls` — a declared list of
// widgets — and an `action` — an argv command with an explicit working
// directory.
//
// The rule of the block above survives intact, and that is deliberate: a
// control is DATA too. The project says "a number between 0 and 6 called
// gleichzeitig"; the hub decides what that looks like in a 240px column. No
// project ever writes an `<input>`, which is what keeps the rail, the read API
// and this hub's CSS class names out of somebody else's repository.
//
// Two ways a changed value can mean something, and both are needed:
//
//   `store: true`   the hub keeps it. `GET /api/panels` reports it, the project
//                   READS it when it needs it, and nothing is executed. The
//                   declared `value` is then only the seed for the first time —
//                   afterwards the stored one is the truth, because in this way
//                   the hub IS the store and a second truth would be the whole
//                   failure this file is written against.
//   an `action`     the values travel to a command as argv elements. The
//                   project stays the owner: it writes the value where it
//                   belongs and pushes the panel again. The declared `value` is
//                   what was last measured.
//
// Combined they are "store only when the command succeeded" — a value the hub
// keeps while the command that was supposed to apply it failed would be a lie
// about what the project holds.
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

-- What a control the hub KEEPS is currently set to. Its own table rather than a
-- field inside the value column, because the two have different owners and
-- different lifetimes: the value is overwritten wholesale by every push of the
-- producer, and a setting the operator made must survive exactly that.
-- Namespaced per repo, panel and field, which is what makes two panels
-- declaring a control called "n" harmless.
CREATE TABLE IF NOT EXISTS panel_control_values (
  repo_id    INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  panel_key  TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL DEFAULT '',
  at         TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (repo_id, panel_key, key)
);
`)

// The outcome of the last action of a panel, as JSON. On the panel row rather
// than in a table of its own: exactly one command may run per panel at a time
// (see `submitPanel`), so there is exactly one outcome worth showing, and it
// belongs to the block the operator is looking at.
if (!db.prepare('PRAGMA table_info(panel_values)').all().some(c => c.name === 'action_result')) {
  db.exec('ALTER TABLE panel_values ADD COLUMN action_result TEXT')
}

/** Panel keys: the same shape a plugin id has — lowercase, digits, dashes. */
export const PANEL_KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/

/** A control's key — the name a placeholder in `argv` refers to. */
export const CONTROL_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,29}$/

/** Hard caps. A sidebar column is 240px wide; anything past this is not a panel. */
export const PANEL_MAX_ITEMS = 8
/**
 * And at most this many controls. Six is not a shy number in a 240px column:
 * a number, a number, a select and a button — the first customer's whole
 * throttle — is four. A panel that wants more is a settings page, and a page
 * is what `href` is for.
 */
export const PANEL_MAX_CONTROLS = 6
export const PANEL_MAX_OPTIONS = 12
export const PANEL_MAX_ARGV = 24
const MAX_TITLE = 40
const MAX_LABEL = 40
const MAX_NOTE = 200
const MAX_ERROR = 200
const MAX_HINT = 120
const MAX_CONFIRM = 200
const MAX_ARG = 500
export const PANEL_MAX_VALUE = 200
const MAX_PANELS_PER_REPO = 6

/** The five widgets. Everything a small control panel needs, and nothing that needs a second column. */
export const CONTROL_TYPES = ['number', 'text', 'select', 'toggle', 'button']

/** Seconds a panel command may run before it is killed. */
export const ACTION_TIMEOUT_DEFAULT = 60
export const ACTION_TIMEOUT_MAX = 600

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
 * A push that must be refused rather than repaired.
 *
 * `normalizePanel` is deliberately forgiving about the numbers — a fourteenth
 * item is cut, an unknown tone is dropped, and a producer is a 40-line script
 * in somebody else's repository. A CONTROL is the other kind of thing: it is
 * half of a contract with a command, and half a contract repaired into
 * something plausible is how a button comes to send an argument nobody wrote.
 * So the caps are still repaired and the structure is refused, by name.
 */
class PanelRefusal extends Error {}
const refuse = (msg) => { throw new PanelRefusal(msg) }

/** True/false out of whatever a producer wrote — JSON booleans, 1/0, "yes", "on". */
function flag(v, fallback = false) {
  if (v === null || v === undefined || v === '') return fallback
  if (typeof v === 'boolean') return v
  const s = String(v).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(s)) return true
  if (['0', 'false', 'no', 'off'].includes(s)) return false
  return fallback
}

/**
 * The value a control carries, as the string the form and the command see.
 *
 * Everything crossing this seam is a string, because that is what an argv
 * element is, what a form field is and what the settings table holds. A number
 * keeps its formatting through `num()` (so `1.0` arrives as `1`), and — the
 * trap this whole file has an entry about — an EMPTY value stays empty and
 * never becomes `0`.
 */
function controlValue(raw, type) {
  if (type === 'toggle') return flag(raw) ? '1' : '0'
  if (type === 'number') { const n = num(raw); return n === null ? '' : String(n) }
  if (raw === null || raw === undefined) return ''
  return String(raw).replace(/[\r\n\t]+/g, ' ').slice(0, PANEL_MAX_VALUE)
}

/**
 * The options of a `select`, as `{value,label}` — a bare string is both.
 *
 * A select with no options at all is refused rather than rendered empty: a
 * dropdown that can only produce the empty string is a control that cannot be
 * used, and the producer is the only one who can say what belongs in it.
 */
function options(raw, problems, key) {
  const list = Array.isArray(raw) ? raw : []
  const out = []
  for (const o of list) {
    if (out.length >= PANEL_MAX_OPTIONS) { problems.push(`${key}: more than ${PANEL_MAX_OPTIONS} options — the rest was dropped`); break }
    const value = typeof o === 'object' && o !== null ? o.value : o
    if (value === null || value === undefined || value === '') continue
    const v = String(value).slice(0, PANEL_MAX_VALUE)
    const label = text(typeof o === 'object' && o !== null ? (o.label ?? v) : v, MAX_LABEL) ?? v
    if (!out.some(x => x.value === v)) out.push({ value: v, label })
  }
  if (!out.length) refuse(`control ${JSON.stringify(key)} is a select with no options`)
  return out
}

/**
 * A command a panel may call: an explicit working directory and an argv list.
 *
 * Two things it deliberately is NOT. It is not a shell string — a placeholder
 * is substituted INSIDE one argv element and can therefore never become two
 * arguments, which is what makes the first value containing a space or a quote
 * a non-event instead of a bug nobody finds again. And `cwd` has no default:
 * `docs/panels.md` already carries the measurement (a working checkout 627
 * commits behind `origin/main`), and a command that silently ran in the wrong
 * checkout would be that measurement happening again with a button on it.
 */
export function normalizeAction(raw, where) {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) refuse(`${where}: the action must be a JSON object`)
  const cwd = text(raw.cwd, 500)
  if (!cwd) refuse(`${where}: the action needs a "cwd" — the directory the command runs in, spelled out`)
  if (!cwd.startsWith('/')) refuse(`${where}: the action's cwd must be an absolute path, not ${JSON.stringify(cwd)}`)
  const rawArgv = Array.isArray(raw.argv) ? raw.argv : null
  if (!rawArgv || !rawArgv.length) refuse(`${where}: the action needs an "argv" — the program and its arguments as a list`)
  if (rawArgv.length > PANEL_MAX_ARGV) refuse(`${where}: an action takes at most ${PANEL_MAX_ARGV} argv elements`)
  const argv = rawArgv.map((a) => {
    if (a === null || a === undefined) refuse(`${where}: an argv element is empty — argv is positional, so nothing may silently fall out of it`)
    const s = String(a)
    if (s.length > MAX_ARG) refuse(`${where}: an argv element is longer than ${MAX_ARG} characters`)
    return s
  })
  if (!argv[0].trim()) refuse(`${where}: the first argv element is the program, and it is empty`)
  const t = num(raw.timeout_s ?? raw.timeoutS)
  return {
    cwd,
    argv,
    timeoutS: t === null ? ACTION_TIMEOUT_DEFAULT : Math.min(ACTION_TIMEOUT_MAX, Math.max(1, Math.round(t))),
  }
}

/**
 * The widgets of one panel.
 *
 * `submit` is what a control does when it CHANGES, and its default is the one
 * decision here worth stating: a button submits (it has no other purpose), a
 * toggle submits (a switch that needs a second click on a different widget is
 * not a switch), and a number, a text or a select does not — those are typed
 * and read back before they are meant, and they travel when a button is
 * pressed. Any of it is overridable, so "one select and no button" is one
 * field away.
 */
export function normalizeControls(raw, problems) {
  const list = Array.isArray(raw) ? raw : []
  if (!list.length) return []
  const out = []
  for (const c of list) {
    if (out.length >= PANEL_MAX_CONTROLS) { problems.push(`more than ${PANEL_MAX_CONTROLS} controls — the rest was dropped`); break }
    if (!c || typeof c !== 'object') refuse('a control must be a JSON object')
    const key = String(c.key ?? '').trim()
    if (!CONTROL_KEY_RE.test(key)) {
      refuse(`control key ${JSON.stringify(key)} is not usable — lowercase letters, digits, "-" and "_", starting with a letter or digit`)
    }
    if (out.some(x => x.key === key)) refuse(`control ${JSON.stringify(key)} is declared twice`)
    const type = String(c.type ?? 'text').trim().toLowerCase()
    if (!CONTROL_TYPES.includes(type)) refuse(`control ${JSON.stringify(key)}: unknown type ${JSON.stringify(type)} — one of ${CONTROL_TYPES.join(', ')}`)

    const control = {
      key,
      type,
      label: text(c.label, MAX_LABEL) ?? key,
      hint: text(c.hint, MAX_HINT),
      confirm: text(c.confirm, MAX_CONFIRM),
      value: type === 'button' ? '' : controlValue(c.value, type),
      store: type === 'button' ? false : flag(c.store),
      // A button ALWAYS submits, whatever it says: it has no second purpose,
      // and `"submit": false` on one would render something that looks like the
      // way to act and is refused when pressed — the exact shape this file
      // refuses a button with nothing behind it for.
      submit: type === 'button' ? true : flag(c.submit, type === 'toggle'),
      tone: tone(c.tone),
      min: null, max: null, step: null, placeholder: null, options: null, action: null,
    }
    if (type === 'number') {
      control.min = num(c.min)
      control.max = num(c.max)
      control.step = num(c.step)
      if (control.min !== null && control.max !== null && control.min > control.max) {
        refuse(`control ${JSON.stringify(key)}: min ${control.min} is above max ${control.max}`)
      }
    }
    if (type === 'text') control.placeholder = text(c.placeholder, MAX_LABEL)
    if (type === 'select') {
      control.options = options(c.options, problems, key)
      // A seed that is not in its own list would be sent to the command as a
      // value the producer never offered — the first option is the honest
      // reading of "nothing valid was said".
      if (!control.options.some(o => o.value === control.value)) {
        if (control.value) problems.push(`${key}: the value ${JSON.stringify(control.value)} is not one of its options`)
        control.value = control.options[0].value
      }
    }
    if (type === 'number' && control.value !== '') {
      const n = Number(control.value)
      if (control.min !== null && n < control.min) problems.push(`${key}: the value ${n} is below its own minimum`)
      if (control.max !== null && n > control.max) problems.push(`${key}: the value ${n} is above its own maximum`)
    }
    if (c.action !== null && c.action !== undefined) {
      if (type !== 'button') refuse(`control ${JSON.stringify(key)}: only a button carries an action of its own`)
      control.action = normalizeAction(c.action, `control ${JSON.stringify(key)}`)
    }
    out.push(control)
  }
  if (!out.length) refuse('a "controls" list that produced no usable control')
  return out
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

  let controls = []
  let action = null
  try {
    controls = normalizeControls(obj.controls, problems)
    action = normalizeAction(obj.action, 'panel')
  } catch (err) {
    if (!(err instanceof PanelRefusal)) throw err
    return { ok: false, value: null, problems: [err.message] }
  }

  const total = num(obj.total)
  // A panel that TAKES a value is a panel even with no number in it: "how many
  // workers may run" is worth its block whether or not the project also counts
  // something. Before controls existed, "no total and no item" was simply not a
  // panel, and it still is not.
  if (total === null && !items.length && !controls.length) {
    return { ok: false, value: null, problems: ['a panel needs a total, an item or a control'] }
  }

  // A button with nothing to press it FOR is the one shape that reads as
  // working and does nothing at all — the failure this repository keeps writing
  // down. It is only a button when something would happen: an action here, an
  // action of its own, or a value the hub is asked to keep.
  if (controls.length && !action && !controls.some(c => c.action || c.store)) {
    return { ok: false, value: null, problems: ['these controls neither store a value (`"store": true`) nor call anything (`action`) — nothing would happen'] }
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
      controls,
      action,
    },
  }
}

function shape(row, stored = null) {
  if (!row) return null
  let value = null
  try { value = JSON.parse(row.value || '{}') } catch { value = null }
  let actionResult = null
  try { actionResult = row.action_result ? JSON.parse(row.action_result) : null } catch { actionResult = null }
  // What the last command was GIVEN, where that is the newer statement.
  //
  // For a control the hub does not store, the rendered value is the producer's
  // last push — and a successful command does not move it. So a press was
  // followed, within a second, by the field going back to the old number while
  // the outcome line directly under it said the command had been applied with
  // the new one (measured 2026-09-09: field 2, line "applied · OK anzahl=7").
  // One block, two answers, and the operator's own number the one that
  // disappeared.
  //
  // The rule is the same one the two lines already imply: `applied 14:05` next
  // to `as of 11:20` says the command ran and the numbers have not been
  // confirmed since. So the applied values stand until the producer confirms
  // otherwise — and a push that arrives after the command wins outright, which
  // is what keeps the project the owner of its own measurement.
  //
  // "After" is decided by the ORDER OF WRITES and never by comparing the two
  // timestamps: `panel_values.at` is whole seconds and `endedAt` is
  // milliseconds, so a press and a push inside one second would be ordered by
  // whichever way that comparison happened to round — the `statSync().mtimeMs`
  // trap in AGENTS.md, one table further out. `setPanelValue()` therefore
  // STRIKES these values when it stores a push; the rest of the result stays,
  // because "applied 14:05" is still true and still worth reading.
  const applied = actionResult?.ok ? actionResult.values || null : null
  const controls = (Array.isArray(value?.controls) ? value.controls : []).map((c) => {
    // The stored value outranks the declared one, and only for a control the
    // panel asked the hub to keep. That is not the hub preferring itself: for a
    // `store` control the hub IS the store, so the producer's `value` was the
    // seed and the stored one is what everybody — this render, `GET
    // /api/panels`, the command's argv — has to agree on. For every other
    // control the declared value is the last measurement and nothing may
    // shadow it.
    const held = c.store && stored ? stored.get(`${row.key}/${c.key}`) : undefined
    if (held === undefined) {
      // Nothing kept — so the applied value is the newest thing anybody said
      // about this control, if there is one. A select is asked the same
      // question the stored branch is asked below: an option the producer has
      // since withdrawn is not a value this field can show.
      const was = applied?.[c.key]
      if (was === undefined) return { ...c, stored: false }
      if (c.type === 'select' && !c.options?.some(o => o.value === was)) return { ...c, stored: false }
      return { ...c, value: was, appliedAt: actionResult.endedAt ?? actionResult.at, stored: false, applied: true }
    }
    // …unless the producer has since changed what the field may hold. A kept
    // "woche" under a select that now offers only "stunde" would be reported by
    // the read API as a value nothing can act on and drawn as a dropdown showing
    // something else — so the declaration wins back, which is the same "the
    // first option is the honest reading" rule a seed nobody could satisfy gets.
    if (c.type === 'select' && !c.options?.some(o => o.value === held.value)) return { ...c, stored: false }
    return { ...c, value: held.value, storedAt: held.at, stored: true }
  })
  return {
    repoId: row.repo_id,
    key: row.key,
    title: value?.title || row.key,
    total: value?.total ?? null,
    tone: value?.tone ?? null,
    href: value?.href ?? null,
    note: value?.note ?? null,
    items: Array.isArray(value?.items) ? value.items : [],
    controls,
    action: value?.action ?? null,
    actionResult,
    error: row.error || null,
    ttlMin: row.ttl_min ?? null,
    source: row.source || null,
    at: row.at,
    atMs: parseDbUtc(row.at),
  }
}

/** Every kept control value of one repo, keyed `panel\0control`. One query, not one per panel. */
function storedValues(repoId, panelKey = null) {
  const rows = panelKey
    ? db.prepare('SELECT * FROM panel_control_values WHERE repo_id=? AND panel_key=?').all(repoId, panelKey)
    : db.prepare('SELECT * FROM panel_control_values WHERE repo_id=?').all(repoId)
  return new Map(rows.map(r => [`${r.panel_key}/${r.key}`, { value: r.value, at: r.at }]))
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
  const id = Number(repoId)
  const stored = storedValues(id)
  return db.prepare('SELECT * FROM panel_values WHERE repo_id=? ORDER BY key').all(id).map(row => shape(row, stored))
}

/** One panel, or null. */
export function panelValue(repoId, key) {
  if (repoId == null) return null
  const id = Number(repoId)
  const k = String(key)
  return shape(db.prepare('SELECT * FROM panel_values WHERE repo_id=? AND key=?').get(id, k), storedValues(id, k))
}


/**
 * Keep what the operator set.
 *
 * Written per control rather than as one blob, because a producer may add a
 * control tomorrow and the ones set today must not be rewritten by that.
 */
export function setControlValue(repoId, key, controlKey, value) {
  db.prepare(`INSERT INTO panel_control_values(repo_id, panel_key, key, value, at) VALUES(?,?,?,?,?)
              ON CONFLICT(repo_id, panel_key, key) DO UPDATE SET value=excluded.value, at=excluded.at`)
    .run(Number(repoId), String(key), String(controlKey), String(value ?? ''), toDbUtc(Date.now()))
}

/** What the last press of a button did. `null` forgets it — a fresh push says nothing about an old command. */
export function setActionResult(repoId, key, result) {
  db.prepare('UPDATE panel_values SET action_result=? WHERE repo_id=? AND key=?')
    .run(result === null ? null : JSON.stringify(result), Number(repoId), String(key))
  publish('panel', { repoId: Number(repoId), key: String(key) })
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

  // The RAW row, not `panelValue()`: the shaped one carries the stored control
  // values merged over the declared ones, and writing that back would bake a
  // setting into the producer's own document — the second truth this module
  // exists to avoid.
  const row = db.prepare('SELECT * FROM panel_values WHERE repo_id=? AND key=?').get(id, k)
  if (!row) {
    const n = db.prepare('SELECT count(*) c FROM panel_values WHERE repo_id=?').get(id).c
    if (n >= MAX_PANELS_PER_REPO) return { ok: false, error: `a repo carries at most ${MAX_PANELS_PER_REPO} panels` }
  }

  let stored = row?.value || '{}'
  const problems = []
  let controls = null
  if (value !== null && value !== undefined) {
    const norm = normalizePanel(value)
    if (!norm.ok) return { ok: false, error: norm.problems.join('; ') }
    problems.push(...norm.problems)
    stored = JSON.stringify(norm.value)
    controls = norm.value.controls
  } else if (!row && !error) {
    return { ok: false, error: 'a panel needs a value' }
  }

  db.prepare(`INSERT INTO panel_values(repo_id, key, value, error, ttl_min, source, at)
              VALUES(?,?,?,?,?,?,?)
              ON CONFLICT(repo_id, key) DO UPDATE SET
                value = excluded.value, error = excluded.error,
                ttl_min = excluded.ttl_min, source = excluded.source, at = excluded.at`)
    .run(id, k, stored, text(error, MAX_ERROR), num(ttlMin) === null ? null : Math.max(0, Math.round(num(ttlMin))),
      text(source, 80), toDbUtc(Date.now()))

  // A push is the producer saying what is true NOW, so it supersedes the values
  // the last command was given (see `shape()`): those stood only because
  // nothing newer had been said about them. The rest of the action result is
  // deliberately kept — "applied 14:05" next to a fresh "as of 14:06" is still
  // the honest pair, and losing it would take the outcome of a press off the
  // screen the moment the producer answered.
  if (row?.action_result) {
    let last = null
    try { last = JSON.parse(row.action_result) } catch { last = null }
    if (last && last.values) {
      delete last.values
      db.prepare('UPDATE panel_values SET action_result=? WHERE repo_id=? AND key=?')
        .run(JSON.stringify(last), id, k)
    }
  }

  // A control the producer dropped takes its kept value with it. Left behind,
  // it would come back to life the day somebody declares that key again — with
  // a value nobody remembers setting, which is worse than starting from the
  // seed.
  if (controls) {
    const alive = new Set(controls.filter(c => c.store).map(c => c.key))
    for (const r of db.prepare('SELECT key FROM panel_control_values WHERE repo_id=? AND panel_key=?').all(id, k)) {
      if (!alive.has(r.key)) db.prepare('DELETE FROM panel_control_values WHERE repo_id=? AND panel_key=? AND key=?').run(id, k, r.key)
    }
  }

  publish('panel', { repoId: id, key: k })
  return { ok: true, problems, panel: panelValue(id, k) }
}

/** Forget one panel. A key that was never there is not an error — it is gone either way. */
export function deletePanelValue(repoId, key) {
  const id = Number(repoId)
  if (!Number.isFinite(id)) return { ok: false, error: 'unknown repo' }
  db.prepare('DELETE FROM panel_values WHERE repo_id=? AND key=?').run(id, String(key))
  // The kept values go with it. There is no foreign key between the two tables
  // (a control value is addressed by the panel's KEY, not by a row id), so this
  // is the deletion — leaving them would make a re-pushed panel of the same
  // name inherit settings from a panel that was removed on purpose.
  db.prepare('DELETE FROM panel_control_values WHERE repo_id=? AND panel_key=?').run(id, String(key))
  publish('panel', { repoId: id, key: String(key) })
  return { ok: true }
}
