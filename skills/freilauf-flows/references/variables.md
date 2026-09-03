# Freilauf flow variables — the complete schema

Source of truth: `server/flows/template.mjs` (syntax, operators),
`server/flows/varschema.mjs` (types, shapes, scope),
`server/flows/actions.mjs` (`runInfo()` — what the values really are).

## Syntax

`{{ path }}` and nothing else. **There is no `${…}`, no `{path}`, no
`{{#if}}`.** Whitespace inside the braces is trimmed.

| form | meaning |
|---|---|
| `{{trigger.run.report}}` | the value, rendered as text |
| `{{vars.review}}` alone, as the whole field | `resolve()` — the value **keeps its type** (object, number, boolean, array) |
| `text {{vars.review}} more` | always text; an object becomes pretty-printed JSON |
| `{{vars.x \| default: nothing found}}` | the fallback when the value renders empty |

`render()` never throws. A path nothing wrote renders as the empty string; a
missing value with a `default:` renders the fallback. Only a field whose entire
value is one `{{path}}` goes through `resolve()` and keeps its type — that is
what `condition.left`, `for_each.list`, `set_var.value` and `switch_outcome`
rely on.

Dotted paths index arrays too: `{{vars.extracted.open_points.0}}`.

## The three roots

| root | contents |
|---|---|
| `trigger` | `kind`, `at` (ISO), `run` (a `RunInfo`, or absent), `merge` (only under `run_merged`) |
| `vars` | the outputs of the steps that already ran |
| `flow` | `flow.id` (number, `null` for an unsaved flow), `flow.name` (string) |

`trigger.kind` ∈ `run_finished`, `run_merged`, `cron`, `manual`.

`trigger.run` exists under `run_finished` and `run_merged` (always), under
`manual` (only when "run now" was given a run — the catalog marks it
*conditional*), and **never under `cron`**.

`trigger.merge` exists **only under `run_merged`** — plus under `manual` when
the simulated run really was merged (`mergeFactsIfMerged`).

## `trigger.run` — `RUN_SHAPE`

Every field is always present; a value the hub does not have is `''`, `0` or
`null`, never `undefined`.

| path | type | value |
|---|---|---|
| `id` | string | the run uuid |
| `short_id` | string | the short id used in branch patterns |
| `status` | string, enum | `scheduled`, `deferred`, `running`, `waiting_help`, `done`, `failed`, `aborted` |
| `outcome` | string, enum | `done`, `failed`, `aborted` — **`''` while the run is still going** |
| `ended_normally` | boolean | `status === 'done'` |
| `agent_id` | number | `null` for a single run |
| `agent_name` | string | `''` for a single run |
| `repo_id` | number | |
| `repo_name` | string | |
| `repo_path` | string | the repo checkout on the hub machine (the default `cwd` of `shell_command`) |
| `harness` | string | coding agent id |
| `model` | string | |
| `provider` | string | |
| `branch` | string | reported branch, else the expected one, else `''` |
| `pr_url` | string | |
| `report` | string | **everything** the run ever reported, follow-ups included |
| `followups` | number | 0 for a run that reported once |
| `last_report` | string | only the latest follow-up text, else the report |
| `help_text` | string | the question a `waiting_help` run asked |
| `exit_code` | number | `null` when there is none |
| `duration_min` | number | rounded; measured against *now* while the run is going |
| `started_at` | string | database timestamp |
| `ended_at` | string | `''` while running |
| `incidents` | number | how many incident rows this run has (open or not) |
| `worktree` | string | |
| `merge_status` | string, enum | `''`, `nothing`, `merged`, `resolving`, `blocked_dirty`, `blocked_conflict`, `blocked_error`, `blocked_no_remote`, `unmerged_commits`, `unmerged_dirty`, `unmerged_both`, `skipped_by_operator` |
| `merged_sha` | string | |
| `url` | string | the run's detail page |
| `flow_run_id` | string | the flow run that started this run, `null` otherwise |

`''` in `merge_status` is what a run reports while the integrator has said
nothing yet — **and forever on an installation whose repo has `merge_mode='off'`**.
Ask `{{trigger.run.merge_status}} eq merged` when you need "did this really land
on the base branch"; `outcome eq done` only says the agent finished.

## `trigger.merge` — `MERGE_SHAPE`

| path | type | value |
|---|---|---|
| `sha` | string | the commit that landed |
| `base` | string | the branch it landed on (the repo's `base_branch`) |
| `resolver_run_id` | string | the conflict run that made it mergeable, else `null` |
| `files` | string_list | the paths the merge changed; `[]` when the `merged` event carried none |

Under `run_merged`, `trigger.run` is **always the origin run**, never the
conflict run: a conflict run is marked dispatched and skipped, so the trigger
fires once per integration.

## Step outputs

`vars.<outputVar>`, with `outputVar` sanitized (see below). The shapes are per
step in `references/steps.md`; the type system behind them:

| declared shape | what the picker and the checks know |
|---|---|
| a literal shape | exact types, enums included |
| `extract` | exactly the fields you declared, with their types and enum values |
| `start_agent` / `start_single_run` | `{id, deferred}` without `wait`, the whole `RUN_SHAPE` with it |
| `shell_command` | `{ok, detached}` when `detach` is ticked, `{ok, exit_code, stdout, stderr}` otherwise |
| `set_var`, an HTTP response's `json` | `any` — nothing below it is ever checked or warned about |

`for_each` writes `vars.<itemVar>` (element type `string` when it walks a known
`string_list`, otherwise `any`) and `vars.<itemVar>_index` (number, **1-based**).

## `varName()` sanitizes, silently

Every `outputVar` and every `itemVar` runs through
`String(s).trim().replace(/[^A-Za-z0-9_]/g, '_')`, falling back to the step's
default when the result is empty.

- `outputVar: "my var"` ⇒ `{{vars.my_var}}`
- `outputVar: "run-1"` ⇒ `{{vars.run_1}}`
- `outputVar: "extract.result"` ⇒ `{{vars.extract_result}}` — the dot is
  replaced, so this does **not** create a nested object

The same rule applies to an `extract` field **name** (`schemaFromFields()` in
`server/flows/llm.mjs` uses the identical regex), so a field called
`"needs review"` is `{{vars.<outputVar>.needs_review}}` and a field whose name
sanitizes to nothing is dropped from the schema entirely.

## Scope: when a variable exists

`varsInScope()` is what the designer's picker and `definitionHints()` both use.

1. **Order.** A variable exists only *after* the step that writes it. A template
   at step 3 that names step 5's output is a hint `unknown_var`.
2. **Conditionality.** A variable written inside a **branch** of an earlier
   `condition`/`switch_outcome`, or inside an earlier `for_each` body, is in
   scope but marked *conditional*: it is offered and never warned about,
   because it may not have been set on the path actually taken.
3. **A step cannot read its own output.** Inside a `for_each` body the loop's
   item variables are readable, but the container's own output is not — the
   step has not finished.
4. Under `cron`, `trigger.run` is not in scope at all. Under `manual` it is
   conditional.

Hints are **never** save errors. `POST /api/flows/save` returns them in `hints`
alongside `ok: true`; an expression may legitimately reach into an HTTP response
the hub cannot describe.

Hint codes: `unknown_var` (nothing writes that variable), `unknown_field` (the
variable exists, that field does not), `op_type` (the operator cannot answer for
that type), `bool_value`, `number_value`, `enum_value` (the right side can never
match). Each carries `{stepId, stepName, field, code, path}`.

## Operators, and which type may use which

`compare(left, op, right)` stringifies both sides and trims them. Strings
compare **case-insensitively**. Numbers are parsed with `parseFloat`; a
non-number becomes `NaN`, and every numeric comparison against `NaN` is `false`.

| operator | meaning |
|---|---|
| `eq` / `neq` | equal / not equal, case-insensitive on text |
| `contains` / `not_contains` | substring, case-insensitive |
| `empty` / `not_empty` | the rendered text is `''` / is not |
| `truthy` / `falsy` | JS truthiness, **except**: a string in `''`, `0`, `false`, `no`, `off`, `null`, `undefined` (trimmed, lower-cased) is falsy; an array is truthy when non-empty |
| `gt` / `lt` / `gte` / `lte` | numeric |
| `matches` | case-insensitive regular expression on the right side; an invalid pattern is `false` |

`empty`, `not_empty`, `truthy` and `falsy` ignore the right side entirely
(`UNARY_OPS`) — the designer hides the value field for them.

Which operators the catalog allows per type (`opsForType()`):

| type | allowed |
|---|---|
| `boolean` | `truthy`, `falsy`, `eq`, `neq` |
| `number` | `eq`, `neq`, `gt`, `lt`, `gte`, `lte`, `empty`, `not_empty` |
| `string_list` | `contains`, `not_contains`, `empty`, `not_empty`, `truthy`, `falsy` |
| `object` | `contains`, `not_contains`, `empty`, `not_empty`, `truthy`, `falsy` |
| `string`, `any` | all thirteen |

Value checks: a `boolean` compared against anything but `true`/`false` is
`bool_value`; a `number` under a numeric operator against non-numeric text is
`number_value`; an enum under `eq`/`neq` against a value not in the enum is
`enum_value`. A right side containing `{{` is never judged.

## Worked comparisons

```jsonc
// "did the work land on main?"
{ "left": "{{trigger.run.merge_status}}", "op": "eq", "right": "merged" }

// "the extraction says review is needed" — boolean, so eq/truthy only
{ "left": "{{vars.extracted.needs_review}}", "op": "truthy", "right": "" }

// "the run took more than an hour"
{ "left": "{{trigger.run.duration_min}}", "op": "gt", "right": "60" }

// "the merge touched the server"
{ "left": "{{trigger.merge.files}}", "op": "contains", "right": "server/" }

// "the command failed"
{ "left": "{{vars.shell.ok}}", "op": "falsy", "right": "" }
```
