---
name: freilauf-flows
description: >
  Build, inspect, attach, debug and run Freilauf no-code flows — the automations
  that fire when a run finishes, when work is merged into a base branch, on a
  cron schedule or on a button. Use this skill whenever the task is "after this
  agent finishes, do X", "when something lands on main, run/notify/deploy",
  "every night at 3 do X", "review the report and start a follow-up run",
  "extract structured data from a run report", or when you must write a flow
  definition JSON, attach a flow to an agent, or work out why a flow run failed,
  went to the wrong branch, or never fired at all — even if the word "flow" is
  never used.
license: CC BY 4.0
metadata:
  project: Freilauf
  source: https://github.com/hwalde/freilauf
---

# Freilauf flows

A **flow** is a trigger plus a tree of steps. Every execution is a **flow run**
with its own context (`trigger`, `vars`, `flow`), its own log and its own row.
Module: `server/flows/`, reference `server/flows/AGENTS.md`.

Everything below is reachable from a shell on the hub machine through
**`fl-api`** (`bin/fl-api`, installed to `~/.local/bin`): `fl-api <path>
[name=value …]` for GET, `fl-api -X POST <path> [name=value …]` for a
form-encoded POST, `fl-api --url` for the base URL. It sends
`accept: application/json`, so the flow endpoints answer JSON rather than
redirecting — but it **cannot** send a JSON body, so `POST /api/flows/save`
needs `curl` (recipe below).


## Start here

```bash
<skill-dir>/scripts/fl-options.py            # what you can choose, and where the hub is
<skill-dir>/scripts/fl-options.py check ...  # validate a run definition BEFORE you post it
```

**Never guess a repo id, an agent id, a coding agent, a provider, a model or an
effort level.** Every one of them is a dropdown in the web UI, and
`fl-options.py` prints the same lists — for THIS installation, which is the only
one that counts. It also finds the hub by itself; if nothing answers,
`fl-options.py where` says what it tried and what to do.

## The API

| method + path | parameters | answer |
|---|---|---|
| `GET /api/flows/meta` | — | `{ok, steps, groups, agents, repos, harnesses, triggerKinds, outcomes, whenKinds, ops, fieldTypes}` — the step registry as data |
| `GET /api/flows` | — | `{ok, flows:[…]}`; each: `{id, name, active(0/1), trigger{}, definition{}, created_at, updated_at}` |
| `GET /api/flows/<id>` | — | `{ok, flow:{…}}` or `404 {ok:false}` |
| `GET /api/flows/step-defaults` | `type=<step type>` | `{ok, properties:{…}}` — a fresh step's defaults; `{}` for an unknown type |
| `POST /api/flows/save` | **JSON body** (below) | `{ok:true, id, hints:[…]}` or `400 {ok:false, problems:[…]}` |
| `POST /api/flows/<id>/run` | `run_id=<uuid>` (optional) | `{ok:true, flowRunId}` / `400 {ok:false,error}` / `404 {ok:false,error:'unknown flow'}` |
| `POST /api/flows/<id>/toggle` | — | `{ok:true}` — flips `active` |
| `POST /api/flows/<id>/delete` | — | `{ok:true}`; also detaches the flow from every agent |
| `GET /api/flow-runs/<uuid>` | — | `{ok, flowRun:{…}}` or `404 {ok:false}` |
| `POST /api/flow-runs/<uuid>/stop` | — | `{ok:true}` or `409 {ok:false}` (not `running`/`waiting`) |

A `flowRun` carries `{id, flow_id, flow_name, status, trigger_run_id, context,
state, log, wait_run_id, resume_at, error, started_at, ended_at}`. `context` is
`{trigger, vars, flow}` — that is where you read what the variables really held.
`log` is a list of `{ts, step, name, type, ok, msg, ms?}`, `msg` cut at 2000
characters. `state.definition` is the **snapshot** the run started with.

`problems` is a list of readable sentences: an unknown step type, a missing
required field, a broken placement rule, an invalid cron expression, a name
already taken. `hints` is different — the save **succeeded** and these are
warnings (`{stepId, stepName, field, code, path}`), see
`references/variables.md`.

### Saving a flow

```bash
HUB=$(fl-api --url)
curl -sS -H 'content-type: application/json' -X POST "$HUB/api/flows/save" -d '{
  "id": null,
  "name": "Review after nightly",
  "active": true,
  "trigger": { "kind": "run_finished" },
  "attachments": [ { "agentId": 4, "when": "done" } ],
  "definition": { "properties": {}, "sequence": [] }
}'
```

Rules that bite:

- **`saveFlow` overwrites `name`, `active`, `trigger` and `definition`
  wholesale.** To change one thing, `GET /api/flows/<id>` first and post the
  whole object back.
- **An absent `attachments` key leaves the attachments alone**; an explicit
  `[]` detaches the flow from every agent. A partial save without the key used
  to silently detach everything — that is why the distinction exists.
- `GET /api/flows/<id>` does **not** return the attachments (they live on the
  agents). To add one without dropping the others, read the current set from
  `fl-api /api/agents` (each agent's `flows` field) and send the full list.
- An empty `name` is filled with a free `Flow n`. A duplicate name is a 400.
- Setting the trigger to anything other than `run_finished` detaches the flow
  from every agent, whatever `attachments` says.
- `active: true/false` — any truthy value becomes 1.

## The definition JSON

```jsonc
{
  "properties": {},          // reserved by the designer library; keep it, leave it empty
  "sequence": [ /* steps */ ]
}
```

A step:

```jsonc
{
  "id": "s1",                // unique string; the engine addresses branches and loop bodies by it
  "componentType": "task",   // "task" | "switch" | "container" — the SERVER ignores it,
                             //   the browser designer needs it. Always set it correctly.
  "type": "notify",          // the registry id — see references/steps.md
  "name": "Tell me",         // free label, shown in the log and the designer
  "properties": { "text": "…", "outputVar": "notify" },
  "branches": { },           // switch steps ONLY: one key per declared branch
  "sequence": [ ]            // container steps ONLY (for_each): the body
}
```

`id` must be unique across the whole tree. A missing or duplicated `id` breaks
`sequenceAt()` and a branch or loop body will never be entered.

### A complete flow that really saves

Trigger: a nightly agent finished. Extract a verdict from its report, and either
notify or start a fix run and wait for it.

```jsonc
{
  "properties": {},
  "sequence": [
    { "id": "s1", "componentType": "task", "type": "extract", "name": "Read the report",
      "properties": {
        "source": "report",
        "sourceRun": "{{trigger.run.id}}",
        "text": "",
        "instructions": "Judge whether the run left anything broken.",
        "fields": [
          { "name": "needs fix", "type": "boolean", "description": "something is broken", "enumValues": "" },
          { "name": "summary",   "type": "string",  "description": "one sentence",        "enumValues": "" },
          { "name": "open_points", "type": "string_list", "description": "what is left",  "enumValues": "" }
        ],
        "llmSource": "", "model": "", "fallback": "", "fallbackModel": "",
        "outputVar": "verdict"
      } },
    { "id": "s2", "componentType": "switch", "type": "condition", "name": "Broken?",
      "properties": { "left": "{{vars.verdict.needs_fix}}", "op": "truthy", "right": "" },
      "branches": {
        "true": [
          { "id": "s3", "componentType": "task", "type": "start_single_run", "name": "Fix it",
            "properties": {
              "repoId": 1, "harness": "opencode", "provider": "openrouter",
              "model": "z-ai/glm-5.3-flash", "effort": "high",
              "orMode": "auto", "orProvider": "", "orQuant": "fp8", "orRegion": "all",
              "orMaxIn": "", "orMaxOut": "",
              "prompt": "The nightly run left these open points:\n{{vars.verdict.open_points}}\n\nFix them.",
              "goal": "", "branchMode": "neu", "branchPattern": "flow/{date}-{kurz}",
              "keepOnBranch": false, "expectedMinutes": 45,
              "wait": true, "outputVar": "fix"
            } },
          { "id": "s4", "componentType": "task", "type": "notify", "name": "Report the fix",
            "properties": { "text": "Fix run {{vars.fix.short_id}} → {{vars.fix.outcome}}\n{{vars.verdict.summary}}",
                            "attachment": "", "outputVar": "notify" } }
        ],
        "false": [
          { "id": "s5", "componentType": "task", "type": "note", "name": "All good",
            "properties": { "text": "clean: {{vars.verdict.summary}}" } }
        ]
      } }
  ]
}
```

Note `needs fix` in the schema becoming `{{vars.verdict.needs_fix}}` — every
extract field name is sanitized. Note `wait: true` on `s3`, which is what makes
`{{vars.fix.outcome}}` in `s4` the finished run rather than `{id, deferred}`.

## Triggers

| `kind` | extra keys | fires when |
|---|---|---|
| `run_finished` | **none** | a run this flow is *attached* to reached `done`/`failed`/`aborted` |
| `run_merged` | `repoId` (number, `null` = every repo) | a run's work landed on a repo's base branch |
| `cron` | `expr` (5 fields: minute hour day month weekday) | the expression matches, once per minute slot |
| `manual` | — | only "run now" / `POST /api/flows/<id>/run` |

`normalizeTrigger()` drops everything else and an unknown `kind` becomes
`manual`. `expr` supports `*`, numbers, `a-b` ranges, `a,b` lists and `/step`;
an invalid one is a 400 on save. It is matched against the hub machine's
**local** time (`cronMatches` reads `getHours()`/`getMinutes()`), and it can
only fire as often as `flowsTick()` runs — every 30 s at worst, so a
minute-granular expression is the finest thing worth writing.

**`run_finished` carries no filter of its own — the attachment is the filter.**
It used to have `agentIds`/`repoId`/`outcomes`; those were migrated into
attachments once and are now stripped on every save. A `run_finished` flow with
no attachment fires for nothing at all.

`run_merged` is the exception, and deliberately so: a merge belongs to the
**repository**, and the run carrying it may be a conflict run that never had an
attachment. Its way in is the repo form (`/repos/edit?id=<n>` → "flows after a
merge"), not the agents page. `trigger.run` is always the origin run; a
conflict run (`resolves_run_id`) is marked dispatched and skipped, so the
trigger fires once per integration.

Detection is **polling**, on `runs.flow_dispatched` / `runs.merge_dispatched`.
`flowsTick()` runs after every report, after every merge and at the end of every
30 s watcher pass; a run is marked *before* its flows start, so a crash never
double-fires. Runs finished more than an hour before the module first ran, and
merges that were already there, are marked dispatched at startup — history is
never replayed. A **follow-up report** re-arms both marks, so the flows fire
again.

## Attaching a flow to an agent

Storage: **`agents.flows`**, a JSON list of `{flowId, when}`, snapshotted into
`runs.flows` when the run is created. Three editors write those same rows — the
agent form, the single-run form and the flow editor's `attachments` — so nothing
has to be kept in sync.

`when` ∈ `always` | `done` | `failed` | `not_done` (failed or aborted) |
`aborted`. Anything else becomes `always`.

| from | how |
|---|---|
| the flow side (**use this from a shell**) | `GET /api/flows/<id>`, then post it back with `attachments: [{agentId, when}, …]`. `setFlowAttachments` touches only *this* flow's entry on every agent; their other attachments keep their order |
| the agent form (`POST /agents/edit`) | repeated checkbox `flows=<flowId>` plus one `flow_when_<flowId>=<when>` per checked flow. This is a **full** form save — a partial POST wipes the rest of the agent |
| reading | `fl-api /api/agents` → each agent's `flows` field, already parsed |

Only flows whose trigger is `run_finished` are attachable
(`attachableFlows()`); a checkbox for anything else does not exist and
`attachmentsFromForm()` drops unknown ids.

**`runs.flows` is a snapshot.** Editing an agent's attachments changes its
*next* run, never a run that already exists — including one that is still
running. To make a change take effect now, you have to start a new run.

Deleting a flow, or moving its trigger off `run_finished`, calls `forgetFlow()`
and removes it from every agent.

## The building blocks

Seventeen step types. `count_runs` and `toggle_agent` exist **since 2026-09-03**.
**Read `references/steps.md` before writing any step you
have not written before** — it has every property, every default, every output
shape, and which strings are templated.

| type | one line |
|---|---|
| `send_message` | type a text into the tmux session of running runs |
| `start_agent` | start a configured agent; `wait` suspends until it ends |
| `start_single_run` | start an ad-hoc run from a full run definition; `wait` as above |
| `kill_run` | kill the session of the target runs and mark them aborted |
| `toggle_agent` | switch an agent's schedule on/off/over, optionally start a run |
| `extract` | LLM fills fields you declare from a report / log / transcript / custom text |
| `set_var` | store a value under `vars.<name>` |
| `shell_command` | run a command on the hub machine; exit code is a result, not a failure |
| `http_request` | call a webhook/API; status, body and parsed JSON become variables |
| `count_runs` | how many runs the hub has right now → `{count, ids, titles}` |
| `condition` | compare two values → `true` / `false` branch |
| `switch_outcome` | branch on a finished run's outcome → `done` / `failed` / `aborted` |
| `for_each` | container: repeat its body per list element |
| `delay` | suspend for n minutes (survives a restart) |
| `stop` | end the flow run as **done** |
| `notify` | one message to the configured notification channels |
| `note` | write a line into the flow run log |

`telegram` is an accepted alias of `notify`; never write a new one.

The four you reach for constantly:

- **`notify`** — `text` (required, templated), optional `attachment` (non-empty
  ⇒ sent as a file). With no notifier configured it logs `not delivered` and the
  flow carries on; that is a supported installation, not an error.
- **`start_single_run`** — its properties *are* the run definition. Read
  `../freilauf-models/SKILL.md` before filling `harness`/`provider`/`model`/
  `effort`, and check `fl-api /api/favorites` first: a favorite is the
  operator's own considered answer and outranks any recommendation. A
  `provider` is **required** for every coding agent that is not on a
  subscription (one available provider included) — a step that omits it starts
  a run with a bare model id and no credential, which dies at its first API
  call; `scripts/fl-options.py check harness=… provider=… model=…` says so
  before you save the flow.
  Branch modes are German wire values: `keiner` (detached), `neu` (new branch),
  `fest` (existing branch). OpenRouter's open mode is `offen`.
- **`extract`** — see below.
- **`shell_command`** — `command` required, `cwd` defaults to
  `{{trigger.run.repo_path}}`, `timeoutMinutes` 10, `detach` false. Branch on
  `{{vars.shell.ok}}`. The canonical "restart the hub after a merge" flow is one
  detached step running `sleep 3; freilauf-deploy` and nothing after it — a step
  that restarts the hub kills the process running the flow.

## Variables in one paragraph

`{{ path }}`, and **there is no `${…}`**. A field whose entire value is one
`{{path}}` keeps the value's type; anything else is text (objects as pretty
JSON, missing values as `''`). `{{ path | default: text }}` supplies a fallback.
Three roots: `trigger` (`kind`, `at`, `run`, `merge`), `vars` (step outputs),
`flow` (`id`, `name`). A variable exists only **after** the step that writes it;
one written inside a branch or a loop body is conditional; a step cannot read
its own output. `outputVar` and extract field names are sanitized to
`[A-Za-z0-9_]` — `"my var"` becomes `vars.my_var`, `"needs review"` becomes
`.needs_review`. **Read `references/variables.md`** before writing a
`condition`, before reading a `trigger.run` field you have not used, and
whenever a template renders empty: it has the complete `RUN_SHAPE` and
`MERGE_SHAPE`, the type system and the operator-per-type table.

## The `extract` step

The one LLM caller in the hub that **throws**: a failed extraction fails the
whole flow run, with `extract: <reason>` in the log. Everywhere else the hub
fails an LLM call soft; here the steps below would otherwise carry an empty
object forward.

| property | default | notes |
|---|---|---|
| `source` | `report` | `report` \| `log` \| `transcript` \| `report_and_log` \| `custom` — where the TEXT comes from |
| `sourceRun` | `{{trigger.run.id}}` | resolved; unused when `source=custom`; empty ⇒ throws |
| `text` | `''` | the custom text, templated; only with `source=custom` |
| `instructions` | `''` | what to extract and how to judge it — **not templated** |
| `fields` | `[]` | **required** |
| `llmSource` | `''` | the model SOURCE (`provider:<id>` / `agent:<id>`); empty = the check job's |
| `model` | `''` | empty = `llm_check_model`; throws when both are empty |
| `fallback` / `fallbackModel` | `''` | empty = the check job's fallback chain |
| `outputVar` | `extracted` | |

A `fields` entry is `{name, type, description, enumValues}`. `type` ∈
**`string`, `number`, `boolean`, `string_list`** and nothing else.
`enumValues` is a comma-separated string and only applies to `string`.
`schemaFromFields()` turns them into a strict JSON schema
(`additionalProperties: false`, **every named field `required`**); names are
sanitized with the same regex as `varName()` and a name that sanitizes to
nothing is dropped. Whatever the model omits anyway is back-filled — `[]`, `0`,
`false`, `''` — so a downstream template never sees `undefined`. The result
lands whole under `vars.<outputVar>`, each field as
`{{vars.<outputVar>.<sanitized name>}}` with the declared type.

Input is capped at **60 000 characters** (first half + `…` + last half). The log
tail is 48 KB, the claude transcript tail 256 KB; `transcript` falls back to the
log for every harness but claude.

With `llmSource`, `model`, `fallback` and `fallbackModel` all empty the step
inherits the **check job** completely: source, model, fallback chain and
OpenRouter routing (`llm_check_*`, `jobFallbacks('check')`, `jobRouting('check')`).
Name a model only when this step really needs a different one.

## The engine

- State is `{definition (snapshot), frames, pending?}`, **persisted after every
  step** together with the context and the log. Editing a flow never breaks a
  suspended run.
- Ceiling **2000 steps** per resume, `for_each` bodies included; past it the run
  fails with `step limit reached`.
- Statuses: `running` | `waiting` | `done` | `failed` | `stopped`.
- `wait: true` on a start step, and `delay`, suspend the run as `waiting`
  (`wait_run_id` / `resume_at`). Both survive a hub restart and are resumed by
  `flowsTick()`.
- A step that throws ends the run as `failed`, with `<step name>: <message>` in
  `error`.
- **`stop` ends the run as `done`**, not failed.
- **A hub restart fails every `running` flow run** (`hub restarted while this
  step was running`): there is no startup resume, and replaying the step in
  flight would not be idempotent. `waiting` runs are deliberately untouched.
- Retention: `flow_runs_keep_days` (Settings, default 7, `0` = forever) for
  `done`/`stopped`, **four times** as long for `failed`, never for
  `waiting`/`running`. Swept at most every ten minutes. A cron flow firing every
  ten minutes produces 144 rows a day — that is what the rule is for.

## Gotchas

- **`switch_outcome` falls through to `failed` for anything that is not
  `done`/`failed`/`aborted`** — an empty value included. `trigger.run.outcome`
  is `''` while a run is still going, so a `switch_outcome` on a run that has
  not ended takes the `failed` branch and looks like a real failure.
- **Only `model`, `prompt` and `branchPattern` of `start_single_run` are
  templated.** `provider`, `effort`, `harness`, `goal` and the `or*` fields are
  not — a `{{…}}` there is passed through literally and the run starts wrong.
  `extract.instructions` is not templated either.
- **"Run now" ignores both `active` and the trigger kind.** `runFlowNow()` will
  execute a switched-off `cron` flow on demand; the tick honours both. So a flow
  that works from the button and never fires by itself is almost always an
  attachment problem or a switched-off flow.
- **A flow started by a flow does not re-dispatch attachments.** A run carrying
  `runs.flow_run_id` is skipped by the `run_finished` dispatcher, and
  `defFromFlowProps()` gives such a run no attachments at all. Chain with `wait`
  on the start step, not by attaching a flow to a flow-started run.
- **Placement is enforced on save, not only in the designer.** `switch_outcome`
  needs a finished run at that point (`run_finished`/`run_merged`, or after a
  `start_*` with `wait`; `cron` is an error, `manual` a warning), and
  `send_message`/`kill_run` need one **only** with `target=trigger_run`. Nothing
  may follow a `stop` in the same sequence.
- **`send_message` reaches only live sessions.** A run must have a tmux session
  and be `running`/`waiting_help`; in a `run_finished` flow the trigger run
  usually is neither, and the step logs `sent to 0 run(s)` without failing.
- **`kill_run`'s `count` is runs acted on, not runs aborted** — the status
  change only applies to `running`/`waiting_help`/`deferred`.
- **A `condition` compares text, case-insensitively.** `{{vars.x.n}} gt 5` works
  because both sides are parsed as numbers, but `eq` against an object compares
  its JSON.
- `for_each`'s `<itemVar>_index` is **1-based**, and `maxItems` (default 50)
  silently truncates.
- `trigger.run` does not exist under `cron` and is only conditional under
  `manual`. `trigger.merge` exists only under `run_merged` (and under `manual`
  when the simulated run really was merged).
- **`merge_status` is `''`, not `nothing`, when the repo does not integrate.**
  Test for `eq merged` when you mean "it landed on the base branch".

## Debugging a flow run

```bash
fl-api /api/flows                        # ids, active flags, triggers
fl-api /api/flows/7                      # the stored definition
fl-api -X POST /api/flows/7/run run_id=$RUN_UUID   # dry-run with real trigger data
fl-api /api/flow-runs/$FLOW_RUN_UUID     # status, error, log, and context.vars
```

`POST /api/flows/<id>/run` with a finished run as `run_id` builds a `manual`
trigger carrying that run's real `RunInfo` — and its `trigger.merge` too when it
really was merged. That is the fastest way to see what a template will render
without waiting for the next nightly. Web pages: `/flows`, `/flows/edit`,
`/flows/runs`, `/flows/runs/<uuid>`.
