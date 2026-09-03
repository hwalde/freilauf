# The run definition, field by field

Everything a run is made of lives in `server/run-def.mjs` — one builder for the
agent form, the single-run form, the JSON API, favorites and flow steps. This
file lists the **form field names** those endpoints read. All of them are
form-encoded (`fl-api -X POST …`), never JSON.

Endpoints that consume this: `POST /api/runs` (full), `POST /api/runs/quick`
(five fields plus `favorite_id`), `POST /api/runs/<id>/edit` (a subset),
`POST /agents/edit`.

---

## Context

| field | required | note |
|---|---|---|
| `repo_id` | yes | the repo the run belongs to; `fl-api /api/repos` lists them. Not part of the definition — it is the context |

## Setup — harness, provider, model, effort

Decide these with `../freilauf-models/SKILL.md`, after checking
`fl-api /api/favorites`.

| field | rule |
|---|---|
| `harness` | must be registered **and enabled**. An unknown id is `run.unknown_harness`; a known but unconfigured one is `run.harness_not_configured` |
| `provider` | must be in the set this harness may use (`fl-api /api/providers harness=<id>`). A subscription harness (claude, cursor) refuses any provider at all |
| `model` | free text, trimmed; empty = the harness picks its own default |
| `effort` | checked against `fl-api /api/effort harness=… provider=… model=…` for **exactly that combination**. An unaccepted level is a validation error, not a silent drop — because opencode discards an unknown variant silently and hermes ignores it |

## OpenRouter serving provider

Rendered on **every** harness as soon as `provider=openrouter`. `pin` is stored
for all of them; `auto` only survives on **`harness=opencode`**, the one place
the requirements can be passed through to the run — elsewhere they are accepted
and dropped without a complaint (hermes has no per-run provider routing).
Without `provider=openrouter` every `or_*` field is dropped.

| field | values |
|---|---|
| `or_mode` | **`offen`** (German for "open": OpenRouter routes freely — the default), `auto` (the hub picks an ordered chain), `pin` (one fixed tag) |
| `or_provider` | the serving-provider tag; only read when `or_mode=pin` |
| `or_quant` | `auto` only: a **lower** bound on quantization — `fp8` admits fp8, bf16, fp16, fp32 and excludes fp4. An unparseable value is a validation error, never a silent "no filter" |
| `or_region` | `all` (default) \| `us` \| `eu` \| `de` \| `cn`; anything else falls back to `all` |
| `or_max_in`, `or_max_out` | USD per million tokens; empty or ≤ 0 = no ceiling |

The `auto` config is resolved to a concrete provider order **before** the run is
created and frozen into its definition, so the same model with the same
requirements gets the same order (cached 24 h). Any failure launches unpinned
and logs it — a start never fails on a convenience feature.

## The task

| field | rule |
|---|---|
| `prompt` | required, must not be blank |
| `goal` | the completion condition, only for a harness that declares one (claude: `/goal`, max 4000 characters). A leading `/goal` is stripped. Too long is an error, not a silent trim. A harness without one sends nothing |
| `expected_minutes` | integer; `+b.expected_minutes || 45`, so 0, blank and junk all become **45** |
| `title` | single runs only, capped. Empty → the agent's name, else the prompt's first meaningful line, which a cheap LLM then replaces in the background |

The prompt is not the whole story: the repo's own **repo prompt** and the
platform rules are composed into `prompt.md` at launch, read live from the repo
row — so editing a repo affects the next run, never a running one.

## Branch rule

| field | values |
|---|---|
| `branch_mode` | **`keiner`** (no branch — a detached worktree), **`neu`** (a new branch from the pattern), **`fest`** (an existing branch) |
| `branch_pattern` | required unless `keiner`. `{kurz}` interpolates the short run id |
| `keep_on_branch` | `1` — only meaningful under `merge_mode=hub`, and **refused together with `keiner`** ("keeping work on a branch needs a branch") |

Two validations you will hit:

- **`fest` with a branch another worktree already holds is refused.** Git grants
  a branch to exactly one worktree, and the classic case is the repo's base
  branch, which the operator's own checkout holds. A pattern containing `{` is
  only resolved at launch and is checked there instead.
- What the rule *means* depends on the repo's `merge_mode`. Under `off`, "no
  branch" really is throwaway work. Under `hub` the hub merges **every** run and
  the rule only decides the name the work travels under.

## Extra skills

Opt-in skills from `~/agents/zusaetze/<name>/SKILL.md`.

```bash
fl-api -X POST /api/runs … skills=unlazy skill_regler_unlazy=4
```

| field | note |
|---|---|
| `skills` | repeat once per skill; unknown names are dropped |
| `skill_regler_<name>` | the skill's dial. For `unlazy` it is the depth-tree depth, `2`–`5`; anything else stores the bare name |

Stored as a JSON list of `"name"` or `"name:value"` entries.

## Attached flows

```bash
fl-api -X POST /api/runs … flows=3 flow_when_3=failed flows=5
```

| field | note |
|---|---|
| `flows` | repeat once per flow id; unknown ids are dropped |
| `flow_when_<id>` | `always` (default) \| `done` \| `failed` \| `aborted` \| `not_done` |

Every attached flow fires when the run ends, all in parallel.

## When it starts

| field | note |
|---|---|
| `start_mode` | `now` (default) \| `at` \| `in` \| `idle` |
| `start_at` | required for `at`; a local datetime string, parsed with `Date.parse` and stored as UTC |
| `start_in_minutes` | required for `in`; > 0. Resolved to a point in time immediately — the database knows only `at` and `idle` |
| — | `idle` = start when no other run of this repo is going |

`at` and `in` both end in status `scheduled` with `start_mode='at'`. A missed
moment is caught up on the next watcher pass, not lost.

## Saving it as an agent

| field | note |
|---|---|
| `save_agent` | `1` — also store this definition as a reusable agent |
| `agent_name` | its name; must be unique **within the repo**. A duplicate is swallowed here: the run is what matters, not the copy |

---

## What `POST /api/runs/quick` accepts

The favorite supplies harness, provider, model, effort, OpenRouter routing,
skills and flows. The request may only add:

`favorite_id`, `repo_id`, `prompt`, `branch_mode`, `branch_pattern`,
`keep_on_branch`, plus the start-time fields.

This is an **allowlist, not a spread** — a request cannot quietly replace the
favorite's coding agent or model, so the run that starts is the one the
favorite's name promises. Expected duration is not asked for and takes the
default.

---

## What `POST /api/runs/<id>/edit` accepts

`expected_minutes`, `prompt`, `repo_id`, `start_mode` + `start_at` +
`start_in_minutes`, `branch_mode` + `branch_pattern` + `keep_on_branch`.

An omitted field means "not being changed". The branch trio is read as a unit:
sending `branch_mode` at all makes the endpoint read the other two, so send all
three together. `start_mode=now` is an action, not a stored value — it launches
the run.

Nothing is applied if any part of the request is invalid: the whole edit is
collect-then-act. On success the run gets an `edited` event naming the fields
that really changed.

---

## Answers

`POST /api/runs` and `/api/runs/quick`:

```jsonc
{ "ok": true, "runId": "1a2b3c4d-…", "deferred": false, "scheduled": false }
```

- `scheduled: true` — it is waiting for its time or for an idle repo.
- `deferred: true` — the **budget gate** parked it. That is not an error and not
  a reason to retry: the watcher starts it as soon as the window refills.
  `POST /api/runs/<id>/start` overrides the gate, and that is the operator's
  call, not yours.
- `ok: false` with `error` — a joined list of validation problems, already
  translated into the hub's UI language.
