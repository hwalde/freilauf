# The complete Freilauf flow step registry

Source of truth: `server/flows/steps.mjs` (fields, defaults, `run()`),
`server/flows/actions.mjs` (what the `api` really does),
`server/run-def.mjs` (`RUN_DEF_FLOW_FIELDS`, `defFromFlowProps`).

Seventeen step types. There is no eighteenth — do not invent one.

`count_runs` and `toggle_agent` exist **since 2026-09-03**. An installation older
than that does not have them: ask `fl-api /api/flows/meta` before you write one,
or `fl-api /api/flows/step-defaults type=<type>`, which answers `{}` for a type
the hub does not know.

## Index

| `type` | `componentType` | group | output? | default `outputVar` |
|---|---|---|---|---|
| `send_message` | `task` | agents | yes | `sent` |
| `start_agent` | `task` | agents | yes | `run` |
| `start_single_run` | `task` | agents | yes | `run` |
| `kill_run` | `task` | agents | yes | `killed` |
| `toggle_agent` | `task` | agents | yes | `agent` |
| `extract` | `task` | data | yes | `extracted` |
| `set_var` | `task` | data | yes | `value` |
| `shell_command` | `task` | data | yes | `shell` |
| `http_request` | `task` | data | yes | `http` |
| `count_runs` | `task` | data | yes | `runs` |
| `condition` | `switch` (`true`/`false`) | control | no | — |
| `switch_outcome` | `switch` (`done`/`failed`/`aborted`) | control | no | — |
| `for_each` | `container` | control | no (writes the item vars) | — |
| `delay` | `task` | control | no | — |
| `stop` | `task` | control | no | — |
| `notify` | `task` | notify | yes | `notify` |
| `note` | `task` | notify | no | — |

`telegram` is an accepted **alias** of `notify` (`server/flows/aliases.mjs`).
Definitions are rewritten to `notify` on the way out of the database and
written back under the new name at the next save. Never write a new
`telegram` step.

**Any field not listed with a default gets `''`** (a `checkbox` gets `false`, a
`fields` editor gets `[]`) — that is `defaultProps()` in `steps.mjs`. Ask the
hub for a fresh step's properties with
`fl-api /api/flows/step-defaults type=<type>`.

## Which properties are templated

Only these strings go through `render()` / `resolve()`. Everything else is used
verbatim, so `{{…}}` in them is a literal that will break the step.

| step | rendered (`{{…}}` works) | NOT rendered |
|---|---|---|
| `send_message` | `text`, `runId` | `target`, `agentId`, `repoId` |
| `start_agent` | `promptExtra` | `agentId`, `wait` |
| `start_single_run` | `model`, `prompt`, `branchPattern` | `harness`, `provider`, `effort`, `goal`, `branchMode`, `keepOnBranch`, `expectedMinutes`, `repoId`, every `or*` field |
| `kill_run` | `runId` | `target`, `agentId`, `repoId` |
| `toggle_agent` | — | `agentId`, `active`, `startNow` |
| `extract` | `text` (source `custom` only), `sourceRun` | **`instructions`**, `fields`, `model`, `llmSource`, `fallback`, `fallbackModel` |
| `set_var` | `value` | `outputVar` |
| `shell_command` | `command`, `cwd`, `timeoutMinutes` | `detach` |
| `http_request` | `url`, `body`, header **values** | `method`, header **names** |
| `count_runs` | `statuses`, `titlePrefix` | `repoId`, `agentId` |
| `condition` | `left`, `right` | `op` |
| `switch_outcome` | `value` | — |
| `for_each` | `list` | `itemVar`, `maxItems` |
| `delay` | `minutes` | — |
| `stop` | `reason` | — |
| `notify` | `text`, `attachment` | — |
| `note` | `text` | — |

`outputVar` is never templated and always goes through `varName()`.

---

## agents

### `send_message`

Types a text into the tmux session of the target runs — bracketed paste plus
Enter, the same path as the run detail page's message form.

| property | default | notes |
|---|---|---|
| `target` | `agent` | `trigger_run` \| `agent` \| `repo` \| `all_running` \| `run_id` |
| `agentId` | `''` | number, only for `target=agent`; empty ⇒ the step reaches nothing |
| `repoId` | `''` | number, only for `target=repo` |
| `runId` | `''` | only for `target=run_id`; a template, e.g. `{{vars.review.id}}` |
| `text` | `''` | **required** |
| `outputVar` | `sent` | |

Output `{ count: number, run_ids: string_list }`.

- Non-`trigger_run` targets are filtered to statuses `running` and
  `waiting_help`; the query is `LIMIT 50`.
- **A run only receives a message when it has a tmux session AND is
  `running`/`waiting_help`.** With `target=trigger_run` in a `run_finished`
  flow the trigger run is finished, so the step reports `sent to 0 run(s)`
  unless the session is still up and the run is still going.
- A `waiting_help` run is switched back to `running` and the message is stored
  as its help answer (event `help_answered {by:'flow'}`); every send writes a
  `flow_message` event.
- Placement rule `needs_run_target`: with `target=trigger_run` this step needs a
  run at that spot. Every other target is legal in a cron flow.

### `start_agent`

`startForAgent(agent, promptExtra)` — the same start path the "start now" button
uses, budget gate included.

| property | default | notes |
|---|---|---|
| `agentId` | `''` | **required**, number |
| `promptExtra` | `''` | appended instructions |
| `wait` | `true` | suspend until that run ends |
| `outputVar` | `run` | |

Output without `wait`: `{ id: string, deferred: boolean }`. With `wait` the
finished run's `RUN_SHAPE` **replaces** the output.

- A start that fails (`ok:false`) **throws** and fails the flow run.
- A `deferred` run (budget gate) still ends eventually, so `wait` stays correct
  — but the flow run sits in `waiting` until it does.
- The started run carries `runs.flow_run_id`, which is the loop guard: it never
  dispatches attachments of its own.

### `start_single_run`

`startRun(def, { repoId })` — an ad-hoc run with its own prompt. Its properties
**are** the run definition: `RUN_DEF_FLOW_FIELDS` in `server/run-def.mjs`.

| property | default | notes |
|---|---|---|
| `repoId` | `''` | **required**, number |
| `harness` | `''` | **required** — `claude` \| `opencode` \| `hermes` \| `cursor` \| plugin id |
| `provider` | `''` | model provider; leave empty for subscription harnesses |
| `model` | `''` | templated |
| `effort` | `''` | not templated |
| `orMode` | `offen` | `offen` (German wire value: OpenRouter routes freely) \| `auto` \| `pin` |
| `orProvider` | `''` | serving-provider tag, only with `orMode=pin` |
| `orQuant` | `''` | min. quantization, only with `orMode=auto` (`fp8`, `bf16`, …) |
| `orRegion` | `all` | `all` \| `us` \| `eu` \| `de` \| `cn`, only with `orMode=auto` |
| `orMaxIn` / `orMaxOut` | `''` | USD per million, only with `orMode=auto` |
| `prompt` | `''` | **required**, templated |
| `goal` | `''` | claude's `/goal` condition; harnesses without a goal spec drop it |
| `branchMode` | `keiner` | German wire values: `keiner` (detached) \| `neu` (create) \| `fest` (existing) |
| `branchPattern` | `''` | templated; `{date}` and `{kurz}` are expanded at launch |
| `keepOnBranch` | `false` | forced to 0 when `branchMode=keiner` |
| `expectedMinutes` | `45` | |
| `wait` | `true` | |
| `outputVar` | `run` | |

Output as `start_agent`.

- The whole `or*` block is dropped unless `provider === 'openrouter'`, and a
  routing config that does not parse becomes no routing rather than an error.
- A `goal` longer than the harness's limit is **silently dropped** here (the
  form would report it as a problem; `defFromFlowProps` discards the problems).
- `skills: null` and `flows: null` are hard-coded: a flow-started run carries no
  extra skills and no attachments.
- Read `../freilauf-models/SKILL.md` before filling `harness`/`provider`/
  `model`/`effort`, and check `fl-api /api/favorites` first.

### `kill_run`

Kills the tmux session of the target runs and marks them `aborted`.

| property | default |
|---|---|
| `target`, `agentId`, `repoId`, `runId` | as `send_message` (`target` default `agent`) |
| `outputVar` | `killed` |

Output `{ count, run_ids }` — **`count` counts runs it acted on, not runs it
really aborted**: `killRun()` always returns true, while the `aborted` event and
the status change only happen for a run in `running`/`waiting_help`/`deferred`.
Same placement rule as `send_message`.

### `toggle_agent`

Switches an agent's **schedule** on, off or over — the toggle on the agents page,
reachable from a flow. What it is for: "the nightly job has failed three times in
a row, stop it firing until somebody looks", and the flow that switches it back
on afterwards.

| property | default | notes |
|---|---|---|
| `agentId` | `''` | **required**, number. Not templated |
| `active` | `on` | `on` \| `off` \| `toggle`. Not templated |
| `startNow` | `false` | checkbox, shown only for `active=on`. Not templated |
| `outputVar` | `agent` | |

Output `{ id: number, name: string, active_before: boolean, active_after: boolean,
started_run_id: string|null }`.

- **`off` stops the SCHEDULE and nothing else.** A manual start, a flow start and
  an API start all still work — the switch is a reversible pause, not a lock.
- `startNow` starts a run **only after switching on**: with `active=off` the
  ticked box is ignored, because a ticked box is not a second command.
- It also starts nothing while a run of this agent is `running`, `waiting_help`
  or **`deferred`** (a deferred run has not begun but it is queued and it will).
  The step then logs `skipped (agent is busy)` and leaves
  `started_run_id` null — a **result** to branch on, not a failure.
- An agent id nobody has **throws**: a step that switched nothing must not report
  success.
- No placement rule — legal in a `cron` flow like everywhere else.

```jsonc
{ "id": "t1", "componentType": "task", "type": "toggle_agent", "name": "Stop the nightly",
  "properties": { "agentId": 4, "active": "off", "startNow": false, "outputVar": "agent" } }
// then: { "type": "notify", "properties": { "text": "{{vars.agent.name}} is now off" } }
```

---

## data

### `extract`

The LLM block. See the SKILL.md section "The `extract` step" for the full
contract; the properties are:

| property | default | notes |
|---|---|---|
| `source` | `report` | `report` \| `log` \| `transcript` \| `report_and_log` \| `custom` — where the TEXT comes from |
| `sourceRun` | `{{trigger.run.id}}` | resolved; ignored when `source=custom`; empty ⇒ throws |
| `text` | `''` | only shown/used with `source=custom`; rendered |
| `instructions` | `''` | prepended to the prompt — **not templated** |
| `fields` | `[]` | **required**; list of `{ name, type, description, enumValues }` |
| `llmSource` | `''` | model SOURCE (`provider:<id>` / `agent:<id>`); empty = `llm_check_source` |
| `model` | `''` | empty = `llm_check_model` (throws when that is empty too) |
| `fallback` | `''` | a second source, tried on transport failure; empty = the check job's chain |
| `fallbackModel` | `''` | empty = the primary model, or an agent source's own default |
| `outputVar` | `extracted` | |

`fields[].type` ∈ `string`, `number`, `boolean`, `string_list` — those four and
nothing else (`FIELD_TYPES` in `server/flows/llm.mjs`). `enumValues` is a
comma-separated string and only applies to `type: 'string'`.

Text sizes it works on: report as stored, log tail 48 KB (escape sequences
stripped, repeated lines collapsed), claude transcript tail 256 KB. The final
input is capped at 60 000 characters — first half plus last half, `…` between.

### `set_var`

| property | default |
|---|---|
| `outputVar` | `value` (**required**) |
| `value` | `''` (**required**) |

Output: `resolve(value)` — a bare `{{path}}` keeps its type, anything else is
text. Declared shape `any`, which silences every downstream type check.

### `shell_command`

Runs a command on the hub machine, as the hub's user, via `bash -lc`.

| property | default | notes |
|---|---|---|
| `command` | `''` | **required**, templated |
| `cwd` | `{{trigger.run.repo_path}}` | templated; empty ⇒ `$HOME`; a directory that does not exist **throws** |
| `timeoutMinutes` | `10` | resolved; floored at 1 |
| `detach` | `false` | |
| `outputVar` | `shell` | |

Output with `detach=false`: `{ ok: boolean, exit_code: number, stdout: string,
stderr: string }` — `stdout`/`stderr` are the **last** 20 KB each, and the
command may print at most 8 MB before it counts as broken.
With `detach=true`: `{ ok: true, detached: true }` and nothing else.

**A non-zero exit code is a result, not a step failure** — branch on
`{{vars.shell.ok}}`. Only a command that could not run at all throws: a missing
`cwd`, a spawn error, or the timeout.

`detach` starts it under `setsid -f` with its own redirections and returns
immediately; the flow run is finished and saved before the command does
anything. That is what makes "restart the hub from a flow" work — the canonical
step is a single detached `sleep 3; freilauf-deploy`, and everything to be
judged after the restart is judged by that script, not by a following step.

### `http_request`

| property | default | notes |
|---|---|---|
| `url` | `''` | **required**, templated |
| `method` | `POST` | `GET` \| `POST` \| `PUT` \| `PATCH` \| `DELETE` |
| `headers` | `''` | one `Name: value` per line; the value is templated |
| `body` | `''` | templated; not sent for `GET`/`HEAD` |
| `outputVar` | `http` | |

Output `{ status: number, ok: boolean, body: string, json: any }`. `body` is cut
at 20 000 characters, `json` is `null` when the response is not JSON, the
timeout is 60 s, and `content-type: application/json` is added when a body is
sent and no content-type was given. A 4xx/5xx is a **result** (`ok:false`), not
a step failure; a network error or timeout throws.


### `count_runs`

How many runs the hub has **right now** — the number a flow needs before it hands
out more work. `repos.max_parallel` does not answer it: that ceiling belongs to
the scheduler, and a run started by a flow or by the API walks straight past it.
Before this block the only way was a `shell_command` calling
`fl-api /api/runs repo=1 status=running`, a JSON parse and a `condition` on the
result.

| property | default | notes |
|---|---|---|
| `repoId` | `''` | number; empty = every repo. NOT templated |
| `statuses` | `running` | comma-separated, templated. `scheduled`, `deferred`, `running`, `waiting_help`, `done`, `failed`, `aborted` — empty = every status |
| `titlePrefix` | `''` | templated; counts only runs whose title starts with it, case-insensitively (umlauts included). Empty = every title |
| `agentId` | `''` | number; empty = every agent. NOT templated |
| `outputVar` | `runs` | |

Output `{ count: number, ids: string_list, titles: string_list }`, ordered newest
first. A run without a title contributes an empty string, never `undefined`. The
log line is `<n> Runs`.

**A status the hub does not know fails the step** (`count_runs: unknown status
runnning — allowed: …`) rather than being dropped. Dropping it would *widen* the
filter, and a flow would branch on a number that looks perfectly plausible and is
wrong. There is no `queued`; the seven names above are the whole list
(`runs.status` CHECK in `server/db.mjs`).

No placement rule — it reads the hub's own state, never the trigger run, so it is
as legal under `cron` as it is after a finished run.

```jsonc
{ "id": "c1", "componentType": "task", "type": "count_runs", "name": "How busy are we?",
  "properties": { "repoId": 1, "statuses": "running, waiting_help",
                  "titlePrefix": "nightly ", "agentId": "", "outputVar": "busy" } }
// then: { "type": "condition", "properties": { "left": "{{vars.busy.count}}", "op": "lt", "right": "3" } }
```

---

## control

### `condition`

`component: 'switch'`, branches `true` and `false`.

| property | default |
|---|---|
| `left` | `''` (**required**) |
| `op` | `eq` |
| `right` | `''` |

Operators: `eq`, `neq`, `contains`, `not_contains`, `empty`, `not_empty`,
`truthy`, `falsy`, `gt`, `lt`, `gte`, `lte`, `matches`. Both sides are
stringified and trimmed; string comparison is **case-insensitive**; `matches` is
a case-insensitive `RegExp` on the right side and an invalid pattern is `false`.
`empty`/`not_empty`/`truthy`/`falsy` ignore `right`.

### `switch_outcome`

`component: 'switch'`, branches `done`, `failed`, `aborted`.

| property | default |
|---|---|
| `value` | `{{trigger.run.outcome}}` |

**Anything that is not `done`/`failed`/`aborted` falls through to the `failed`
branch — including an empty value.** Placement rule `needs_run`: it may only sit
where a finished run is readable (a `run_finished`/`run_merged` trigger, or
after a `start_*` step with `wait`). Under `cron` the server rejects the
definition; under `manual` it is a warning.

### `for_each`

`component: 'container'` — it carries a `sequence` instead of `branches`.

| property | default |
|---|---|
| `list` | `''` (**required**) |
| `itemVar` | `item` |
| `maxItems` | `50` |

Writes `vars.<itemVar>` and `vars.<itemVar>_index` (**1-based**) per pass; it
declares no `outputVar`. `toList()` accepts an array as it is, parses a JSON
array, otherwise splits text on newlines and drops empty lines; a single object
or number becomes a one-element list. A list longer than `maxItems` is cut and
the log line says so. An empty list means the body never runs.

### `delay`

| property | default |
|---|---|
| `minutes` | `5` (**required**) |

Suspends the flow run: status `waiting`, `resume_at` set. Survives a hub
restart; resumed by `flowsTick()` (every report, every merge, every 30 s watcher
tick), so the real resolution is roughly half a minute, never sub-second.

### `stop`

| property | default |
|---|---|
| `reason` | `''` (rendered into the log line) |

Ends the flow run as **`done`**, not as failed. Nothing may follow a `stop` in
the same sequence — placement code `after_stop`, enforced by the server too.

---

## notify

### `notify`

| property | default | notes |
|---|---|---|
| `text` | `''` | **required**, templated |
| `attachment` | `''` | templated; non-empty ⇒ sent as `flow-attachment.md` |
| `outputVar` | `notify` | |

Output `{ delivered: boolean }`. The message goes to every enabled notifier
under Settings → Notifications; the hub appends the link on its own — the
trigger run's detail page, otherwise this flow run's page, otherwise `/flows`.

**With no notifier configured the step logs `not delivered` and the flow carries
on.** That is a supported installation, not a failure. It deliberately does not
go through `notifyRun()`, so the watcher's per-run dedupe cannot swallow it.

### `note`

| property | default |
|---|---|
| `text` | `''` (**required**, templated) |

Writes one line into the flow run's log. The cheapest way to see what a variable
actually holds: `{{vars.extracted}}` renders an object as pretty JSON.
