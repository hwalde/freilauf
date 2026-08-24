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
  fields: [ { key, kind, required?, default?, options?, showIf?, placeholder? } ],
  async run(props, ctx, api, { flowRunId, step }) → { msg?, output?, branch?, wait?, stop? }
}
```

`fields` is the **single source of truth** for the property editor: the client
receives it via `GET /api/flows/meta` and renders inputs by `kind`
(`text, textarea, number, checkbox, select, agent, repo, harness, fields`).
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
| `start_single_run` | `createRun()` + `launchRun()` with prompt/model/branch rule from the step |
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
trigger matches (`triggerMatches()`: outcomes, repo, agents, single runs, runs
started by a flow). Then it resumes elapsed delays and evaluates cron triggers
(minute-debounced like the scheduler). Re-entrancy is guarded.

Loop guard: runs started by a flow (`runs.flow_run_id` set) do **not** fire
`run_finished` triggers unless the trigger opts in (`flowStarted`). Chaining is
done with `wait` on the start step instead.

Runs that were already finished more than an hour before the module first ran
are marked dispatched at startup, so history is never replayed.

## Integration — the four seams

1. `server/web.mjs`: mounts `flowRoute` (`/flows*`) and `flowApi`
   (`/api/flows*`, `/api/flow-runs*`); serves `flows.js/css` and the designer
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
step editor renders `fields`. Client validation mirrors `validateDefinition()`
so a red step in the designer is exactly what the server would reject. Save is
`POST /api/flows/save` with `{ id, name, active, trigger, definition }`.

## Tests

`test/unit.mjs`, group "Flows": templates and operators, `triggerMatches`,
`validateDefinition`, and the engine end-to-end with a stub `api` (branching,
outputs, wait/resume on a run, delay, stop, step failure, for-each including a
wait inside the body). The persistence runs
against the unit sandbox database (`CCHUB_DATA_DIR`).
