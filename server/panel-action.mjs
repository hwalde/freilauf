// Freilauf — what happens when somebody uses a panel's controls.
//
// `server/panels.mjs` is the value: what a project pushed, what the hub keeps,
// what the sidebar draws. This file is the other half — the gesture. It
// validates what came back from the widgets, keeps what the panel asked the hub
// to keep, and calls the command the panel declared.
//
// ## Why this is not `api.shell` from the flow module
//
// `server/flows/actions.mjs` already runs commands for the hub, and reusing it
// was the first idea. It takes a COMMAND STRING and runs `bash -lc` — which is
// exactly right there (a flow step is written by the operator in a textarea and
// wants pipes, `&&` and a `sleep`) and exactly wrong here. A panel's command
// line is assembled out of values somebody typed into a 240px column, and the
// first value containing a space, a quote or a `;` would then be a bug nobody
// finds again. So the two share the primitive they are both built on —
// `sh()` in util.mjs, which is `execFile` and has never involved a shell — and
// differ where they have to: a panel action is `argv`, a placeholder is
// substituted INSIDE one element, and there is no shell anywhere on the path.
//
// The second difference is `detach`. A flow step may start something that
// outlives it (the command that restarts this very hub). A panel action may
// not: the whole point of the button is that the operator sees whether it
// worked, and a detached command has no exit code to show. A button that
// reports nothing is worse than no button.
//
// ## What the operator is promised
//
// Every press ends in a recorded outcome on the panel row — running, applied,
// failed with the reason, timed out, or "the hub was restarted while it ran".
// It is server state and not a toast, so it survives the sidebar being swapped
// by the live channel, a reload, and closing the tab. That is the same
// reasoning `runs.finish_state` rests on: what the pages say has to come out of
// the database, or the pages and the truth drift.
import { existsSync } from 'node:fs'
import { sh, tailText } from './util.mjs'
import { env } from './env.mjs'
import { getRepo } from './db.mjs'
import {
  panelValue, setControlValue, setActionResult, PANEL_MAX_VALUE, ACTION_TIMEOUT_MAX,
} from './panels.mjs'

/** What is kept of a command's output, and what is shown of it. */
const OUT_KEEP = 2000
const OUT_LINE = 200
/** How long past its own timeout a "running" mark may stand before it is a lie. */
const RUNNING_SLACK_MS = 20_000

/**
 * Is this reading of an action still worth believing?
 *
 * `lost` is the one that had to be invented rather than found: the command runs
 * in this process, so a deploy or a reboot in the middle of it leaves a row
 * saying `running` that nothing will ever finish. Rendering that as "running"
 * for ever is the quiet staleness this hub has been caught by twice already, so
 * it is derived from the clock instead of trusted: past the timeout the command
 * was given, plus a slack for the write that never came, "running" means nobody
 * answered.
 */
export function actionState(result, nowMs = Date.now()) {
  if (!result) return null
  if (result.running) {
    const limit = (Number(result.timeoutS) || ACTION_TIMEOUT_MAX) * 1000 + RUNNING_SLACK_MS
    return nowMs - (Number(result.at) || 0) > limit ? 'lost' : 'running'
  }
  if (result.saved) return 'saved'
  return result.ok ? 'ok' : 'failed'
}

/**
 * The line of a command's output worth putting in a 240px column.
 *
 * The LAST non-empty line, because that is where a script puts its verdict —
 * the first customer prints `SCHWARM_DROSSEL result=OK …` as its closing line
 * on purpose. stderr wins when stdout said nothing, since a command that failed
 * usually only wrote there.
 */
export function outputLine(stdout, stderr) {
  for (const text of [stdout, stderr]) {
    const lines = String(text ?? '').split('\n').map(l => l.trim()).filter(Boolean)
    if (lines.length) return lines[lines.length - 1].slice(0, OUT_LINE)
  }
  return ''
}

/**
 * What the widgets sent, checked against what the panel declared.
 *
 * Deliberately STRICT, and that is the opposite of `normalizePanel()` one file
 * over. Repairing a pushed number is cosmetic — the worst case is a block that
 * reads oddly. Repairing a SUBMITTED number means sending a command an argument
 * nobody typed, and "the throttle is at 4" when 40 was meant is not a display
 * problem. So an invalid value is a refusal that names the field and the rule,
 * and `''` is refused for a number rather than becoming the `0` this codebase
 * has an entry about.
 *
 * Missing keys are not an error: they fall back to the control's current value.
 * A page can be a minute older than the panel it draws, and a form that posts
 * four of five fields must not fail on the fifth it never showed.
 */
export function checkValues(controls, submitted) {
  const values = {}
  for (const c of controls) {
    if (c.type === 'button') continue
    const given = Object.hasOwn(submitted, c.key) ? submitted[c.key] : undefined
    let v = given === undefined || given === null ? c.value : String(given)
    if (c.type === 'toggle') {
      v = ['1', 'true', 'on', 'yes'].includes(String(v).trim().toLowerCase()) ? '1' : '0'
    } else if (c.type === 'number') {
      const s = String(v).trim()
      if (s === '') return { ok: false, key: c.key, error: `${c.label}: needs a number` }
      const n = Number(s)
      if (!Number.isFinite(n)) return { ok: false, key: c.key, error: `${c.label}: ${JSON.stringify(s)} is not a number` }
      if (c.min !== null && c.min !== undefined && n < c.min) return { ok: false, key: c.key, error: `${c.label}: at least ${c.min}` }
      if (c.max !== null && c.max !== undefined && n > c.max) return { ok: false, key: c.key, error: `${c.label}: at most ${c.max}` }
      v = String(n)
    } else if (c.type === 'select') {
      const list = Array.isArray(c.options) ? c.options : []
      if (!list.some(o => o.value === v)) {
        return { ok: false, key: c.key, error: `${c.label}: ${JSON.stringify(v)} is not one of ${list.map(o => o.value).join(', ')}` }
      }
    } else {
      v = String(v).replace(/[\r\n\t]+/g, ' ')
      // Cut, never truncated silently: a text that reaches a command line half
      // written is worse than a refusal that says how long it may be.
      if (v.length > PANEL_MAX_VALUE) return { ok: false, key: c.key, error: `${c.label}: at most ${PANEL_MAX_VALUE} characters` }
    }
    values[c.key] = v
  }
  return { ok: true, values }
}

/**
 * The command line, with the values substituted in.
 *
 * `{{name}}` is replaced wherever it stands INSIDE an element, so `--n={{n}}`
 * works and `{{n}}` alone works, and neither can ever become two arguments —
 * the element count of `argv` is decided by the producer and by nobody else.
 * An unknown name becomes the empty string rather than being left as `{{…}}`:
 * a literal pair of braces reaching a program is a value that program will
 * misread, while an empty argument is at least visibly empty.
 *
 * Beyond the control keys, four names the panel itself knows. The controls win,
 * so a project that really wants a control called `panel` gets its own value —
 * documented, and the reason `panel`/`repo` are named in docs/panels.md.
 */
export function buildArgv(action, values, ctx = {}) {
  const table = {
    control: ctx.control ?? '',
    panel: ctx.panel ?? '',
    repo: ctx.repo == null ? '' : String(ctx.repo),
    repo_path: ctx.repoPath ?? '',
    ...values,
  }
  return action.argv.map(a => String(a).replace(/\{\{\s*([a-z0-9_-]+)\s*\}\}/gi, (_, name) => {
    const v = table[name]
    return v === undefined || v === null ? '' : String(v)
  }))
}

/** The environment a panel command is handed on top of the hub's own. */
function actionEnv(values, ctx) {
  const out = {
    ...process.env,
    FL_PANEL: ctx.panel,
    FL_PANEL_REPO: String(ctx.repo),
    FL_PANEL_CONTROL: ctx.control ?? '',
    // So the command can push the panel back without knowing where the hub is
    // — which is the whole second half of the contract: the numbers it changed
    // are stale on the screen until it says otherwise.
    FL_HUB_URL: process.env.FL_HUB_URL || `http://127.0.0.1:${env('LOCAL_PORT') ?? '8791'}`,
  }
  // A control key is `[a-z0-9_-]`, so the uppercased name can never be
  // anything but a plain identifier — no key of a panel can invent a variable
  // name with a `=` or a space in it.
  for (const [k, v] of Object.entries(values)) out[`FL_PANEL_V_${k.toUpperCase().replace(/-/g, '_')}`] = String(v)
  return out
}

/**
 * Run one panel action and record what it did.
 *
 * Not awaited by the route. A command may take a minute — the operator's click
 * must not hold an HTTP request open for it, and the page must not have to stay
 * open for the outcome to exist. So the row is marked `running` before the
 * process starts (which is what the sidebar draws, and what the next press is
 * refused against), and the outcome is written and published when it is over.
 * Same shape as a detached Quick Run start, and for the same reason.
 */
async function runAction(action, argv, values, ctx) {
  const started = Date.now()
  setActionResult(ctx.repo, ctx.panel, {
    running: true, control: ctx.control, at: started, timeoutS: action.timeoutS, by: ctx.by ?? null,
  })
  let result
  try {
    const r = await sh(argv[0], argv.slice(1), {
      cwd: action.cwd,
      timeout: action.timeoutS * 1000,
      env: actionEnv(values, ctx),
      maxBuffer: 8 * 1024 * 1024,
    })
    // util.sh() flattens execFile's error, so the three ways this ends are told
    // apart by what it reports — the same reading `api.shell` makes, and worth
    // repeating rather than sharing, because the SENTENCES differ: a flow logs,
    // a panel has to say it in a sidebar.
    if (!r.ok && typeof r.code !== 'number') {
      result = { ok: false, at: started, control: ctx.control, error: 'not_started', detail: String(r.code || r.stderr).trim().slice(0, OUT_LINE) }
    } else if (!r.ok && r.code === 0) {
      result = { ok: false, at: started, control: ctx.control, error: 'timeout', timeoutS: action.timeoutS }
    } else {
      result = {
        ok: r.code === 0, at: started, control: ctx.control, exitCode: r.code,
        line: outputLine(r.stdout, r.stderr),
        out: tailText(r.stdout, OUT_KEEP), err: tailText(r.stderr, OUT_KEEP),
      }
    }
  } catch (err) {
    result = { ok: false, at: started, control: ctx.control, error: 'not_started', detail: String(err?.message ?? err).slice(0, OUT_LINE) }
  }
  result.endedAt = Date.now()
  result.by = ctx.by ?? null
  // WHAT the command was given, not only that it ran. Without this the panel
  // contradicted itself inside one block: measured 2026-09-09 on a panel whose
  // controls are not stored — typed 7, pressed, and one second later the field
  // read 2 (the producer's last push) while the outcome line three lines under
  // it read "applied 17:06 · OK anzahl=7". Both halves were true in their own
  // terms and the number the operator had typed was the one that vanished.
  // `panelValue()` prefers these over the pushed value while they are the newer
  // statement; a push that arrives after the command still wins, so the project
  // keeps ownership and only the hole between the two closes.
  if (result.ok) result.values = { ...values }
  // The kept value is written only now, and only on success: with a command in
  // the way, "the hub holds 4" and "the project was told 4" have to be the same
  // statement or the panel is lying about one of them.
  if (result.ok) for (const c of ctx.storeKeys) setControlValue(ctx.repo, ctx.panel, c, values[c])
  setActionResult(ctx.repo, ctx.panel, result)
  return result
}

/**
 * Somebody used a panel's controls.
 *
 * Answers at once. `done` is the promise of the command, for the tests and for
 * any caller that really wants to wait; the route does not.
 */
export async function submitPanel({ repoId, key, control = null, submitted = {}, by = null }) {
  const panel = panelValue(repoId, key)
  if (!panel) return { ok: false, error: `no panel ${JSON.stringify(String(key))} in this repo` }
  const controls = panel.controls ?? []
  if (!controls.length) return { ok: false, error: 'this panel has no controls' }

  // Which control was used. The form always says; a script may leave it out,
  // and then the only unambiguous readings are "the one button there is" and
  // "no button at all, just save".
  const buttons = controls.filter(c => c.type === 'button')
  let pressed = null
  if (control) {
    pressed = controls.find(c => c.key === String(control)) ?? null
    if (!pressed) return { ok: false, error: `this panel has no control ${JSON.stringify(String(control))} — it may have changed since the page was drawn` }
    if (!pressed.submit) return { ok: false, error: `${pressed.label} does not submit anything` }
  } else if (buttons.length === 1) {
    pressed = buttons[0]
  } else if (buttons.length > 1) {
    return { ok: false, error: `name the control that was used: ${buttons.map(b => b.key).join(', ')}` }
  }

  const checked = checkValues(controls, submitted)
  if (!checked.ok) return { ok: false, error: checked.error, control: checked.key }

  const action = pressed?.action ?? panel.action ?? null
  const storeKeys = controls.filter(c => c.store && c.type !== 'button').map(c => c.key)
  if (!action && !storeKeys.length) return { ok: false, error: 'nothing is stored and no command is declared — this control does nothing' }

  if (action) {
    // One command per panel at a time. Two presses of "apply" a second apart
    // would otherwise race for the same setting, and the one that finished
    // second would decide — which is not the one the operator pressed second.
    const state = actionState(panel.actionResult)
    if (state === 'running') return { ok: false, error: 'the last command of this panel is still running' }
    if (!existsSync(action.cwd)) {
      const result = { ok: false, at: Date.now(), endedAt: Date.now(), control: pressed?.key ?? null, error: 'no_cwd', detail: action.cwd, by }
      setActionResult(repoId, key, result)
      return { ok: false, error: `the working directory of this command does not exist: ${action.cwd}`, result }
    }
    const ctx = {
      repo: Number(repoId), panel: String(key), control: pressed?.key ?? null,
      repoPath: getRepo(Number(repoId))?.path ?? '', storeKeys, by,
    }
    const argv = buildArgv(action, checked.values, ctx)
    const done = runAction(action, argv, checked.values, ctx).catch(() => null)
    return { ok: true, running: true, values: checked.values, argv, done }
  }

  // The plain "the hub keeps it" case: written now, because there is nothing
  // that could still refuse it. The result row is what answers "was it taken?"
  // for a panel whose producer does not push again.
  for (const c of storeKeys) setControlValue(repoId, key, c, checked.values[c])
  const result = { ok: true, saved: true, at: Date.now(), endedAt: Date.now(), control: pressed?.key ?? null, by }
  setActionResult(repoId, key, result)
  return { ok: true, running: false, saved: true, values: checked.values }
}
