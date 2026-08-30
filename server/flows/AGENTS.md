# Freilauf flows — no-code automation on top of runs

`server/flows/` is a self-contained module: it owns its tables, its pages, its
API and its client (`public/flows.js`, `public/flows.css`). The rest of the hub
knows it through the seams listed under *Integration*. Nothing in here is
required for the hub to schedule, watch or report runs.

## What a flow is

A flow = **trigger** + **definition** (a tree of steps from the graphical
designer, [sequential-workflow-designer](https://github.com/nocode-js/sequential-workflow-designer)).
Every execution is a **flow run** with its own context:

```
context = {
  trigger: { kind: 'run_finished' | 'run_merged' | 'cron' | 'manual', at,
             run: RunInfo | null, merge?: { sha, base, resolver_run_id, files } },
  vars:    { ... }          // outputs of steps, addressed by their "output variable"
  flow:    { id, name }
}
```

`RunInfo` (built by `actions.runInfo()`) is everything a flow may know about a
run: `id, short_id, status, outcome ('done'|'failed'|'aborted'), ended_normally,
agent_id, agent_name, repo_id, repo_name, repo_path, harness, model, provider,
branch, pr_url, report, followups, last_report, help_text, exit_code,
duration_min, started_at, ended_at, incidents, worktree, url, flow_run_id,
merge_status, merged_sha`. "Did the run end normally or was it aborted?" is
`outcome` / `ended_normally`; whether its work has landed on the base branch is
`merge_status` (the merge integrator's column — read here, never written).

A finished run can report **again** (`server/reports.mjs`, follow-up reports:
the operator typed more work into the session and the agent ran `fl-report
done` once more). Its `run_finished` flows then fire once more, and so do the
`run_merged` ones when the follow-up's work was merged (`rearmDispatch()` in
`db.mjs` takes the dispatch marks back). `report` carries everything the run
ever reported, `last_report` only the latest text — the one a flow fired by a
follow-up usually wants — and `followups` counts them (0 for a run that
reported once).

Text fields in steps are **templates**: `{{trigger.run.report}}`,
`{{vars.review.branch}}`, `{{x | default: text}}`. A single `{{path}}` used as
the whole value keeps its type (objects, numbers); anything else renders as text,
objects as JSON, missing values as an empty string. Templates never throw.

## Files

| File | Role |
|---|---|
| `db.mjs` | tables `flows`, `flow_runs`; retrofits `runs.flow_dispatched`, `runs.merge_dispatched` and `runs.flow_run_id`; all queries; the one-time migration of old trigger filters into attachments; the two startup rules (merges are never replayed, a flow run caught mid-step is closed) |
| `attach.mjs` | **the attachment** — which flows hang on an agent / a single run and under which condition: parsing, the form block both run forms embed, the flow editor's side of the same rows, the run detail page's section — plus `mergeFlowsBlock()`, the repo form's list of what runs after a merge |
| `template.mjs` | pure: `render`, `resolve`, `getPath`/`setPath`, `compare` (the condition operators), `varName` |
| `varschema.mjs` | pure: the **typed variable catalog** — which variables exist where, of which type, with which allowed values; plus the placement rules |
| `steps.mjs` | **the step registry** — one entry per building block: designer metadata (`fields`), defaults, validation and `run()` |
| `engine.mjs` | executes a definition: frame stack, persistence after every step, suspend/resume (`wait`, `delay`), stop |
| `actions.mjs` | the production `api` object steps run against (tmux, notifications, agent/run start, LLM, HTTP) — the only file with side effects |
| `aliases.mjs` | pure, import-free: step types that were renamed (`telegram` → `notify`) and `renameSteps()`. A leaf module because both `steps.mjs` and `db.mjs` need it and they cannot import each other |
| `llm.mjs` | structured extraction via OpenRouter `json_schema` (`schemaFromFields`, `extractStructured`) |
| `triggers.mjs` | `run_finished`/`run_merged`/`cron`/`manual`, `flowsForRun`, `flowsForMerge`, `flowsTick()` (dispatcher), `runFlowNow()` |
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
| `shell_command` | runs a command on the hub machine as the hub's user. A non-zero exit code is a **result** (`vars.<out>.ok/exit_code/stdout/stderr`), not a failure of the step — only a command that could not run at all (no such working directory, spawn error, timeout) throws. With `detach` it is started in its own session (`setsid -f`) and the step ends at once with `{ ok, detached }` — see "Restarting the hub from a flow" |
| `extract` | LLM fills user-defined fields from report / terminal log tail / claude transcript / custom text |
| `for_each` | container: repeats its body per element of a list (`maxItems` caps it); the element is `vars.<itemVar>` |
| `notify` | one message to the notification channels configured under Settings → Notifications, optionally with an attachment. With none configured it reports `not delivered` and the flow carries on — a hub that says nothing anywhere is a supported installation, not a failed step |
| `set_var`, `http_request`, `condition`, `switch_outcome`, `delay`, `stop`, `note` | as named |

Target selector (`send_message`, `kill_run`): `trigger_run`, `agent` (running runs
of that agent), `repo`, `all_running`, `run_id` (template).

`extract` sources: `report`, `log` (pipe-pane tail, cleaned), `transcript`
(claude's JSONL — what the agent said and did, not what the terminal drew; other
harnesses have none, so it falls back to the log), `report_and_log`, `custom`.

`notify` links to the trigger run's detail page, otherwise to its own flow run.
Deliberately **not** through `notifyRun()`: that dedupe belongs to the watcher's
alarms and would swallow a second flow message about the same run.

**Its type used to be `telegram`, and a step's type is stored data** — it sits in
`flows.definition` and in the definition snapshot every `flow_runs` row carries.
So the rename is handled twice, and both halves are wanted: `renameSteps()`
(`aliases.mjs`) rewrites a definition on the way OUT of the database, in
`hydrate()` and in `hydrateRun()`, so the designer, the validator and the
variable catalog only ever see today's name and the new one is written back the
next time the flow is saved; and `STEP_MAP.telegram` is an alias of
`STEP_MAP.notify`, so a definition that reaches the engine some other way — an
older client posting one, a suspended run resumed from a row nobody rewrote —
finds its step instead of failing with "unknown step type". The alias is
deliberately **not** in `STEPS`: the toolbox offers one notify block, not two,
and `stepsMeta()` is built from `STEPS`.

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
| `trigger.run.*` | `RUN_SHAPE` — `outcome`, `status` and `merge_status` as enums, `ended_normally` boolean, `duration_min`/`exit_code`/`incidents` numbers |
| `trigger.merge.*` | `MERGE_SHAPE` — `sha`, `base`, `resolver_run_id` strings, `files` a string list. Offered **only under `run_merged`**: under `cron`, `manual` or `run_finished` there is no merge, and a picker that offered one would promise a value that is never there |
| other steps | `outputShape` in the registry: a literal shape, `{ from: 'extract_fields' }`, `{ from: 'run_if_wait', otherwise }` (with `wait` the finished `RunInfo` replaces the output), or `{ from: 'if_field', field, then, otherwise }` for a step whose output depends on one of its own switches (`shell_command` with `detach`) |
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

**A flow run left on `running` by a restart is closed as failed**
(`failRunningFlowRuns()` in `db.mjs`, once at load, with
`hub restarted while this step was running` in its own log). Persisting after
every step is not the same as being resumable: there is no startup resume, and
repeating the step that was in flight would not be idempotent — it may have sent
a message, started a run, restarted the hub. Ever `running` would be a lie about
work that nobody is doing. `waiting` is deliberately untouched: that state is a
row, not a stack frame.

### Restarting the hub from a flow

The case that made `shell_command` carry a `detach` switch at all: "after every
merge, restart Freilauf". A step that restarts the hub kills the process that is
executing it — the flow run would stay on `running` and, per the rule above, be
marked failed on the way back up, every single time.

`detach` starts the command in its own session
(`setsid -f bash -lc 'exec </dev/null >/dev/null 2>&1; <command>'` — the same
pattern the `StopFailure` hook uses in `runner.mjs`, and for the same reason)
and the step answers at once with `{ ok: true, detached: true }`. The flow run
is finished and saved **before** the command reaches the hub. The redirections
are the shell's own, done before the command runs: a detached child that still
held our stdout pipe would make `execFile` wait for it after all, whatever the
command looks like.

So the operator's flow is: trigger `run_merged`, one `shell_command`,
`detach` ticked, and a `sleep` in front of the command —
`sleep 3; freilauf-deploy`. The sleep is what gives the answer time to reach the
browser.

**One step, and deliberately no condition after it.** The flow used to be three:
pull the working checkout, branch on whether the pull worked, restart or send a
message. Only the first two of those could ever report anything —
whatever the restart does happens after the process running the flow is gone. So
everything that has to be judged *after* the restart belongs in the script:
`freilauf-deploy` checks that the hub answers, rolls back to the previous commit if
it does not, and notifies itself (through `bin/fl-notify`, so it reaches whatever
channel the operator configured — and nothing at all when they configured none).
See "Deploying: the service runs from its own checkout" in the root `AGENTS.md`.

The command runs **as the hub's user on the hub machine**. That is nothing new
(the hub starts coding agents with full shell access anyway), but it is said in
the field's own hint rather than left to be discovered.

## Triggers and dispatch (`triggers.mjs`)

Finished runs are found by **polling**, not by hooks in every end path: each run
carries `flow_dispatched` (0/1). `flowsTick()` takes every terminal run with
`flow_dispatched = 0`, marks it first (crash-safe, never double-fires), resumes
flow runs waiting on it, then starts the flows the run itself carries
(`flowsForRun()`). Then it resumes elapsed delays and evaluates cron triggers
(minute-debounced like the scheduler). Re-entrancy is guarded.

All flows of one run start **in parallel** (`Promise.allSettled` around
individual catches) — that is what a no-code platform does with a trigger, and
one flow throwing at its first step must not swallow the others.

The `run_finished` trigger carries **no filter of its own**. Which runs start
the flow, and under which condition, is the **attachment** (`attach.mjs`):
`agents.flows` → `runs.flows`, a list of `{ flowId, when }` with `when` one of
`always | done | failed | not_done | aborted`. One storage, three editors (agent
form, single-run form, the flow editor's trigger panel) — nothing has to be kept
in sync because there is nothing to sync. The old filters
(`agentIds`/`repoId`/`outcomes`/`singleRuns`/`flowStarted`) are migrated into
attachments once, in `db.mjs`, and then dropped by `normalizeTrigger()`.

The `run_merged` trigger **does** carry a filter of its own, and exactly one:
the repo (`repoId`, `null` = all repos). That is not an inconsistency with the
paragraph above, it is the same rule applied to a different fact. An attachment
says "this agent's runs start this flow" — but a merge belongs to the
**repository**, and the run that carries it may be a conflict run that never
had an attachment to inherit. "After every merge into this repo" cannot be
written as an attachment at all.

Consequently the way in is the **repo form**, not the agents page:
`mergeFlowsBlock()` (attach.mjs, one call in `pages.mjs`) lists the flows whose
`run_merged` trigger points at this repo or at all repos — the switched-off ones
included, because "nothing happens, it is off" is part of the answer — and links
to `/flows/edit?trigger=run_merged&repo=<id>`, which opens the editor with the
trigger, the repo and a name already filled in (`newFlowPreset()` in web.mjs).

Dispatch works like the finished runs, on `runs.merge_dispatched`: `flowsTick()`
takes every run with `merge_status='merged'` and `merge_dispatched=0`, marks it
first, and starts `flowsForMerge()` — all of them in parallel. A run carrying
`resolves_run_id` (a conflict run) is marked and **skipped**: it merged the
origin run's work, and the trigger fires once per integration, not once per run
involved in it. `trigger.run` is therefore always the origin run, never the
conflict run. The merge columns belong to the integrator (`server/integrate.mjs`)
and are only ever read here; a database without them costs one line in the log,
not a broken tick.

Loop guard: runs started by a flow (`runs.flow_run_id` set) never dispatch
attachments, and `defFromFlowProps()` gives a flow-started single run no
attachments in the first place. Chaining is done with `wait` on the start step.

Runs that were already finished more than an hour before the module first ran
are marked dispatched at startup, and so is every merge that was already there
— history is never replayed.

### Flow runs are deleted after a while

Nothing ever deleted a `flow_runs` row, and while a flow was something a
*finished agent run* started that was fine: a handful a day, and every one of
them about something that happened. A **cron** flow is the other case. The one
that brings pushed commits live fires every ten minutes — 144 flow runs a day,
for as long as the machine is up, almost all of them saying "there was nothing
to deploy". `/flows/runs` would silt up until the interesting row could not be
found in it any more.

`pruneFlowRuns(nowMs)` (`db.mjs`) therefore deletes by `ended_at`, and the rule
is deliberately not one number:

| status | kept |
|---|---|
| `done`, `stopped` | `flow_runs_keep_days` (Settings, default 7; `0` = forever) |
| `failed` | **four times** as long |
| `waiting`, `running` | never deleted, at any age |

The successful ones are the noise; the failed one is the reason somebody opens
the page at all, and they are rare enough that keeping them four times as long
costs nothing. `waiting` is not old, it is **suspended** — deleting it would
throw away work that is still going to happen, the same reason
`failRunningFlowRuns()` leaves it alone.

`flowsTick()` calls it at the end of a pass, **at most every ten minutes**
(in-memory timestamp): the pass runs on every report, every merge and every
watcher tick, and a DELETE that finds nothing is still a table scan each time.
Losing the timestamp on a restart costs one extra sweep, which is why it is not
a settings row.

## Integration — the seams

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
4. `server/pages.mjs`: exports `layout()`; shows `attachmentSummary()` in the
   agents table and `flowSection()` on the run detail page, and links to
   `/flows` from the agents page. There is deliberately **no** nav entry.
5. `server/run-def.mjs`: the attachment is a field of the run definition —
   `flowAttachFields()` in the form block, `attachmentsFromForm()` on the way
   back, carried through `defFromAgent`/`saveAgent`/`createRun` like `skills`.
   The two columns (`agents.flows`, `runs.flows`) sit in `server/db.mjs`.

Plus `util.sendToSession()` (shared with the run detail page's message form).

## Designer page (`public/flows.js`)

Loads `window.FREILAUF_FLOWS = { i18n, meta, flow }` injected by `web.mjs`
(`i18n` = the `flows.*` catalog, `meta` = `editorMeta()`). Toolbox groups and
step defaults come from `meta.steps`; the root editor edits the trigger; the
step editor renders `fields`. It is an **ES module** and imports
`varschema.mjs` from `/static/flows/` — client validation is therefore not a
mirror of the server's but the same code, so a red step in the designer is
exactly what the server would reject. Save is `POST /api/flows/save` with
`{ id, name, active, trigger, attachments, definition }`; the answer carries
`hints`.

The `run_merged` trigger's panel is a single repo `<select>` (`#trigger-repo`,
"all repos" as its default) — the whole filter of that trigger. The
`run_finished` trigger's panel is the attachment list — agents plus their
condition. It travels in `attachments` and is written back onto the **agents**
(`setFlowAttachments`), not into the flow row: the agent form reads the same
rows, so neither side can hold a stale copy. Switching the trigger kind away
from `run_finished` detaches the flow everywhere (`forgetFlow`), and so does
deleting it — otherwise dead ids would pile up in `agents.flows`.

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

`test/unit.mjs`, group "Flows: the run_merged trigger and the shell_command
block": the repo filter (`normalizeTrigger`, `flowsForMerge`,
`flowsForMergeOfRepo`), the dispatch against the sandbox database (fires once,
the conflict run is marked and skipped, history is not replayed), the registry
entry and the `detach`-dependent output shape, the engine against a stub
`api.shell` (templates, exit code as a result, detach) and the restart rule for
flow runs. `test/e2e.mjs`, group "Flows: run_merged fires, and shell_command
really runs": a real command writing the merge SHA into a file, a detached one
that outlives its step, the repo form's block and the pre-aimed editor.
`test/browser.mjs` drives the trigger editor's repo select.
`test/TODO-e2e-run-merged.md` lists the two cases that need the real merge
integrator.

`test/unit.mjs`, groups "Flows": templates and operators, attachments
(`parseAttachments`, `attachmentFires`, `flowsForRun`, `normalizeTrigger`),
`validateDefinition`, the typed catalog (types and enums out of an extraction,
order, conditional branch variables, the drop position, `pathProblem`,
`valueProblem`, `opsForType`) and the placement rules, plus the engine
end-to-end with a stub `api` (branching,
outputs, wait/resume on a run, delay, stop, step failure, for-each including a
wait inside the body). The persistence runs
against the unit sandbox database (`FREILAUF_DATA_DIR`).
