# cc-hub flows — no-code automation on top of runs

`server/flows/` is a self-contained module: it owns its tables, its pages, its
API and its client (`public/flows.js`, `public/flows.css`). The rest of the hub
knows it through exactly four seams (listed under *Integration*). Nothing in
here is required for the hub to schedule, watch or report runs — remove the
module and the four seams and the hub works as before.

## What a flow is

A flow = **trigger** + **definition** (a tree of steps from the graphical
designer, [sequential-workflow-designer](https://github.com/nocode-js/sequential-workflow-designer)).
Every execution is a **flow run** with its own context:

```
context = {
  trigger: { kind: 'run_finished' | 'cron' | 'manual', at, run: RunInfo | null },
  vars:    { ... }          // outputs of steps, addressed by their "output variable"
  flow:    { id, name }
}
```

`RunInfo` (built by `actions.runInfo()`) is everything a flow may know about a
run: `id, short_id, status, outcome ('done'|'failed'|'aborted'), ended_normally,
agent_id, agent_name, repo_id, repo_name, repo_path, harness, model, provider,
branch, pr_url, report, help_text, exit_code, duration_min, started_at, ended_at,
incidents, worktree, url, flow_run_id`. "Did the run end normally or was it
aborted?" is `outcome` / `ended_normally`.

Text fields in steps are **templates**: `{{trigger.run.report}}`,
`{{vars.review.branch}}`, `{{x | default: text}}`. A single `{{path}}` used as
the whole value keeps its type (objects, numbers); anything else renders as text,
objects as JSON, missing values as an empty string. Templates never throw.

## Files

| File | Role |
|---|---|
| `db.mjs` | tables `flows`, `flow_runs`; retrofits `runs.flow_dispatched` and `runs.flow_run_id`; all queries |
| `template.mjs` | pure: `render`, `resolve`, `getPath`/`setPath`, `compare` (the condition operators), `varName` |
| `varschema.mjs` | pure: the **typed variable catalog** — which variables exist where, of which type, with which allowed values; plus the placement rules |
| `steps.mjs` | **the step registry** — one entry per building block: designer metadata (`fields`), defaults, validation and `run()` |
| `engine.mjs` | executes a definition: frame stack, persistence after every step, suspend/resume (`wait`, `delay`), stop |
| `actions.mjs` | the production `api` object steps run against (tmux, Telegram, agent/run start, LLM, HTTP) — the only file with side effects |
| `llm.mjs` | structured extraction via OpenRouter `json_schema` (`schemaFromFields`, `extractStructured`) |
| `triggers.mjs` | `run_finished`/`cron`/`manual`, `triggerMatches`, `flowsTick()` (dispatcher), `runFlowNow()` |
| `web.mjs` | pages `/flows`, `/flows/edit`, `/flows/runs`, `/flows/runs/<id>`; API `/api/flows/*`, `/api/flow-runs/*` |
| `../../public/flows.js` | designer page: toolbox from the registry, property editors from `fields`, trigger editor, save |

## Step registry contract (`steps.mjs`)

```js
{
  type: 'send_message',          // stable id, also the i18n key suffix (flows.step.<type>, flows.step.<type>.desc)
  component: 'task' | 'switch' | 'container',   // switch declares `branches: [...]`, container holds a `sequence`
  group: 'agents' | 'data' | 'control' | 'notify',
  output: true,                  // result goes to vars.<properties.outputVar || type>
  outputShape: { … },            // what that variable looks like — see "Typed variables"
  placement: { needsRun: … },    // where the step may sit at all — see "Placement rules"
  fields: [ { key, kind, required?, default?, options?, showIf?, placeholder? } ],
  async run(props, ctx, api, { flowRunId, step }) → { msg?, output?, branch?, wait?, stop? }
}
```

`fields` is the **single source of truth** for the property editor: the client
receives it via `GET /api/flows/meta` and renders inputs by `kind`
(`text, textarea, number, checkbox, select, agent, repo, harness, fields, var,
op, value`).
`showIf: { target: 'agent' }` hides a field unless another has that value; the
server-side `validateDefinition()` honours the same rule. A field label is
`flows.field.<key>` (shared between steps), an optional hint
`flows.field.<key>.hint`. Adding a step therefore means: one registry entry,
three i18n keys per language, nothing in the client.

`run()` results:

- `output` — stored under `vars.<outputVar>` when the step declares `output: true`
- `branch` — for switch steps: which branch sequence to enter
- `wait: { runId }` — suspend until that run ends; on resume the run's `RunInfo`
  becomes the step's output. `wait: { resumeAt }` — suspend until a time.
- `loop: { items, itemVar }` — container steps: run the body once per element
  (`vars.<itemVar>`, `vars.<itemVar>_index`)
- `stop` — end the flow run as done
- throwing → flow run `failed` with the message in the log

Steps never touch the database or tmux themselves — everything goes through
`api` so the engine runs against a stub in `test/unit.mjs`.

### Built-in steps

| type | does |
|---|---|
| `send_message` | types a text into the tmux session of target runs (bracketed paste + Enter, same as the detail page) |
| `start_agent` | `startForAgent(agent, promptExtra)` — quota gate applies; `wait` suspends until the run ends |
| `start_single_run` | the same `startRun(def, …)` the run form uses — quota gate applies. Its property fields ARE the run definition (`RUN_DEF_FLOW_FIELDS` from `server/run-def.mjs`), so a field cannot exist in the form and be missing here |
| `kill_run` | kills the tmux session of target runs, marks them aborted |
| `extract` | LLM fills user-defined fields from report / terminal log tail / claude transcript / custom text |
| `for_each` | container: repeats its body per element of a list (`maxItems` caps it); the element is `vars.<itemVar>` |
| `set_var`, `http_request`, `condition`, `switch_outcome`, `delay`, `stop`, `telegram`, `note` | as named |

Target selector (`send_message`, `kill_run`): `trigger_run`, `agent` (running runs
of that agent), `repo`, `all_running`, `run_id` (template).

`extract` sources: `report`, `log` (pipe-pane tail, cleaned), `transcript`
(claude's JSONL — what the agent said and did, not what the terminal drew; other
harnesses have none, so it falls back to the log), `report_and_log`, `custom`.

`telegram` links to the trigger run's detail page, otherwise to its own flow run.
Deliberately **not** through `notifyRun()`: that dedupe belongs to the watcher's
alarms and would swallow a second flow message about the same run.

## Typed variables (`varschema.mjs`)

Naming a variable used to be typing and hoping. `varschema.mjs` answers, for
**every spot in the tree**, which variables are readable there, of which type
and with which allowed values — and the designer turns that into pickers.

It is **pure and import-free of anything Node**, because `server/web.mjs`
serves it *and* `template.mjs` to the browser under `/static/flows/`
(`public/flows.js` is an ES module and imports them). Designer and server
therefore judge a flow by literally the same code, not by two implementations
that drift.

Where the types come from:

| Source | What is known |
|---|---|
| `extract` | exactly: `fields[].type` and `enumValues`, and `strict` json_schema makes the model keep to them. The field name is sanitized like `schemaFromFields()` — "needs review" really is `vars.<out>.needs_review`, and the picker says so |
| `trigger.run.*` | `RUN_SHAPE` — `outcome` and `status` as enums, `ended_normally` boolean, `duration_min`/`exit_code`/`incidents` numbers |
| other steps | `outputShape` in the registry: a literal shape, `{ from: 'extract_fields' }`, or `{ from: 'run_if_wait', otherwise }` (with `wait` the finished `RunInfo` replaces the output) |
| `for_each` | the element type of the list it walks; `<itemVar>_index` is a number |
| `set_var`, an HTTP response body | `any` — and `any` silences every check below it |

Two things the catalog respects that a flat list of names cannot:

- **Order.** A variable exists only *after* the step that writes it. The picker
  at step 3 does not offer what step 5 will produce.
- **Conditionality.** A variable written inside a branch or a loop body of an
  earlier step is marked `conditional`: offered (with a `?`), never warned about.

Out of that come `pathProblem()` (variable nothing writes / field that does not
exist), `valueProblem()` (a boolean against `"yes"` can never match, an enum
against a value not in it, a number against text) and `opsForType()` (a boolean
answers `truthy/falsy/eq/neq` — nothing else). All of it is a **hint**, never a
save error: `definitionHints()` returns them, `POST /api/flows/save` ships them
in `hints`, and the designer lists them above the canvas and next to the field.
An expression may legitimately reach into an HTTP response we cannot describe.

## Placement rules

Not every block may sit everywhere, and "it just won't stick" is not an
explanation. Rules are declared in the registry (`placement`) and enforced
three times: the designer refuses the drop (`canInsertStep`/`canMoveStep`) and
prints why in the status line, an already-placed step goes red
(`validator.step` → the library's error badge) with the reason in its property
panel, and `validateDefinition()` repeats the check so a hand-written
definition cannot slip past.

| Rule | Meaning |
|---|---|
| *(implicit, every step)* | nothing may follow a `stop` in the same sequence — it would never run |
| `needsRun: true` | the step reads the outcome of a finished run: `switch_outcome`. The run comes from the trigger (`run_finished`) or from an earlier `start_agent`/`start_single_run` with **wait**. Under a `cron` trigger there is neither — error. Under `manual` the run only exists when "run now" is given one — warning |
| `needsRun: { whenField, is }` | the same, but only while a field has that value: `send_message`/`kill_run` need one **for the target "the trigger run" and for that alone**. Every other target — an agent, a repo, all running runs, a run id — reaches runs that have nothing to do with this flow, and works in any flow, cron included |

`activeRuleKey()` decides which rule applies to a step **with its current
properties**, and only that one is shown: the toolbox states it in the item's
tooltip (the toolbox step carries the default properties), the property panel
states it before anything is broken. Advertising a field-bound rule regardless
of the selected value would claim the opposite of what the step does — hence
the separate `needs_run_target` code and text.
`flows.placement.<code>.rule` is the rule, `flows.placement.<code>.why` the
explanation when it is violated.

## Engine (`engine.mjs`)

State of a flow run = `{ definition, frames: [{ path, index, loop? }], pending? }`.
`path` addresses a sequence in the **snapshotted** definition (`[]` = root,
`[{ stepId, branch }]` = a branch of a switch, `[{ stepId }]` = the body of a
container). A frame carrying `loop` (`{ items, itemVar, i }`) re-enters its
sequence for the next element instead of being popped — that is the whole
for-each implementation, so suspending inside a loop body works like anywhere
else. The engine pops/pushes frames, persists context+state+log after **every**
step, and stops at `MAX_STEPS` (2000, loop bodies included) — a flow is not a
program. Because the definition is snapshotted, editing
a flow never breaks a suspended run. Suspension is a row state
(`status='waiting'`, `wait_run_id` or `resume_at`), so it survives a hub restart.

## Triggers and dispatch (`triggers.mjs`)

Finished runs are found by **polling**, not by hooks in every end path: each run
carries `flow_dispatched` (0/1). `flowsTick()` takes every terminal run with
`flow_dispatched = 0`, marks it first (crash-safe, never double-fires), resumes
flow runs waiting on it, then starts every active flow whose `run_finished`
trigger matches (`triggerMatches()`: outcomes, scope, single runs, runs started
by a flow). The scope is either agents or a repo, never both — an agent belongs
to exactly one repo, so a repo filter next to chosen agents could only narrow
the result to nothing. The editor offers one selector; `normalizeTrigger()`
drops `repoId` as soon as `agentIds` is non-empty. Then it resumes elapsed delays and evaluates cron triggers
(minute-debounced like the scheduler). Re-entrancy is guarded.

Loop guard: runs started by a flow (`runs.flow_run_id` set) do **not** fire
`run_finished` triggers unless the trigger opts in (`flowStarted`). Chaining is
done with `wait` on the start step instead.

Runs that were already finished more than an hour before the module first ran
are marked dispatched at startup, so history is never replayed.

## Integration — the four seams

1. `server/web.mjs`: mounts `flowRoute` (`/flows*`) and `flowApi`
   (`/api/flows*`, `/api/flow-runs*`); serves `flows.js/css`, the two pure
   modules (`/static/flows/template.mjs`, `/static/flows/varschema.mjs` — the
   prefix keeps varschema's relative import resolvable) and the designer
   library from `node_modules` via `STATIC_MAP`; the kill endpoint calls
   `flowsTick()`.
2. `server/reports.mjs`: after `done`, `failed`, `_pane_died` it calls
   `flowsTick()` (dynamic import — no static cycle) for low latency.
3. `server/watcher.mjs`: `flowsTick()` at the end of every tick — the backstop
   for every other way a run can end, plus delays and cron.
4. `server/pages.mjs`: exports `layout()` and has the "Flows" nav entry.

Plus `util.sendToSession()` (shared with the run detail page's message form).

## Designer page (`public/flows.js`)

Loads `window.CCHUB_FLOWS = { i18n, meta, flow }` injected by `web.mjs`
(`i18n` = the `flows.*` catalog, `meta` = `editorMeta()`). Toolbox groups and
step defaults come from `meta.steps`; the root editor edits the trigger; the
step editor renders `fields`. It is an **ES module** and imports
`varschema.mjs` from `/static/flows/` — client validation is therefore not a
mirror of the server's but the same code, so a red step in the designer is
exactly what the server would reject. Save is `POST /api/flows/save` with
`{ id, name, active, trigger, definition }`; the answer carries `hints`.

Field kinds beyond the plain inputs:

- `var` — variable picker from the catalog, grouped by producing step, with
  "own expression…" as the escape hatch (an HTTP response has no schema).
- `op` — operator list narrowed by the left side's type; an operator that no
  longer fits stays selectable but is marked `⚠`.
- `value` — the right-hand side: a `<select>` of `true`/`false` or of the enum
  values where the type allows only those, a number field for numbers, and
  nothing at all for `empty/not_empty/truthy/falsy`.

Every free-text field offers the catalog while typing `{{`. Warnings show up in
three places: next to the field, in the notes panel above the canvas (click →
selects the step) and as a yellow glow on the step itself — the library only
knows the red error badge, so the glow is a `drop-shadow` of our own.

## Tests

`test/unit.mjs`, groups "Flows": templates and operators, `triggerMatches`,
`validateDefinition`, the typed catalog (types and enums out of an extraction,
order, conditional branch variables, the drop position, `pathProblem`,
`valueProblem`, `opsForType`) and the placement rules, plus the engine
end-to-end with a stub `api` (branching,
outputs, wait/resume on a run, delay, stop, step failure, for-each including a
wait inside the body). The persistence runs
against the unit sandbox database (`CCHUB_DATA_DIR`).
