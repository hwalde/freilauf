---
name: freilauf-agents
description: >
  Create, edit, schedule, move, delete, start or review a Freilauf agent — a
  stored run definition that carries a name and a schedule. Use this skill when
  someone wants a recurring or nightly coding job set up, wants to change what
  an existing agent does (its prompt, coding agent, model, branch rule, expected
  duration, goal, extra skills or attached flows), wants one switched on or off,
  started now, renamed or moved to another repo, or wants to look over what an
  agent has produced so far — even when the words "Freilauf" or "agent" are
  never used ("run the docs sweep every morning at six", "make the nightly job
  use a cheaper model", "why did the cleanup job not fire last night").
license: CC BY 4.0
metadata:
  project: Freilauf
  source: https://github.com/hwalde/freilauf
---

# Freilauf agents

An **agent** is a stored run definition with two things a single run has not: a
**name** and a **schedule**. Everything else — coding agent, provider, model,
effort, prompt, goal, branch rule, keep-on-branch, expected duration, extra
skills, attached flows — is the same run definition, owned by
`server/run-def.mjs`. An agent lives in exactly one repo and its name is unique
**per repo**.

For anything about one individual run (its terminal, report, incidents,
merge state, retry) read `../freilauf-runs/SKILL.md`. For the
harness/provider/model/effort decision read `../freilauf-models/SKILL.md`
**before** you fill those fields in — and the operator's favorites
(`fl-api /api/favorites`) come before any recommendation in it.

## The tool

`fl-api <path> [name=value …]` (GET) and `fl-api -X POST <path> [name=value …]`
(form-encoded body). A name may be repeated; it arrives as a repeated field.

## 1. Look at the agents

```bash
fl-api /api/agents               # every agent on the hub
fl-api /api/agents repo=<id>     # only this repo's
```

Answers `{ ok, agents: [...] }`. Each row is the whole `agents` table row plus
`repo_name`, `harness_label`, `skills` (parsed from JSON to a list) and `flows`
(parsed to `[{flowId, when}]`). `or_routing` is **not** parsed — it is the raw
JSON string as stored. The HTML page is `/agents?repo=<id>`.

Columns worth knowing: `active` (0/1), `harness`, `model`, `provider`, `effort`,
`or_provider`, `or_routing`, `prompt`, `goal`, `branch_mode`, `branch_pattern`,
`keep_on_branch`, `expected_minutes`, `skills`, `flows`, `schedule_kind`,
`schedule_days`, `schedule_time`, `schedule_weeks`, `schedule_anchor`, `run_at`,
`schedule`, `created_at`, `updated_at`.

## 2. Three things about writing, before you write anything

**`POST /agents/edit` is HTML, not JSON.** On success it answers **303** with a
`Location`; on a refusal **400** with an HTML page whose `<ul class="err">` lists
the problems. `fl-api` exits 1 for both, because neither is 2xx. So always:

```bash
# --status puts "HTTP 303 /agents/edit" (= saved) or "HTTP 400" on stderr.
# The 400 body is a whole page including the sidebar, so pull out the err list:
fl-api --status --raw -X POST "/agents/edit?id=<id>" name=… |
  grep -o '<ul class="err">.*</ul>' | sed -e 's|</li>|\n|g' -e 's|<[^>]*>||g'
```

**It is a full replace, never a patch.** `saveAgent()` writes every column from
the submitted body. A field you do not send is reset: no `prompt` → the prompt
is emptied (refused), no `skills` → the skills are dropped, **no `active` → the
agent is switched off**, no `schedule_kind` → the schedule becomes `manuell`.
Read the agent first and send it back whole. This skill's
`scripts/agent-edit.py` does exactly that round trip:

```bash
python3 <skill-dir>/scripts/agent-edit.py --id 7 --dry-run
python3 <skill-dir>/scripts/agent-edit.py --id 7 model=z-ai/glm-5.3-flash
python3 <skill-dir>/scripts/agent-edit.py --id 7 prompt=@new-prompt.md
```

Read `references/editing.md` when you want to build the body by hand, when a
save came back 400, or for the row → form-body mapping the four non-obvious
fields need (`or_routing`, `skills`, `flows`, `schedule_days`).

**Several wire values are German** and must be sent verbatim:
`branch_mode` ∈ `keiner` | `neu` | `fest`, `schedule_kind` ∈ `manuell` |
`woechentlich` | `einmalig` | `cron`, OpenRouter open mode `or_mode=offen`.

## 3. Create or edit

`GET /agents/edit?id=<id>` renders the form (HTML), `GET /agents/edit?repo=<id>`
an empty one. The write is `POST /agents/edit` for a new agent and
`POST /agents/edit?id=<id>` for an existing one. Complete body:

| field | required | values |
|---|---|---|
| `name` | yes | unique within the repo |
| `repo_id` | yes | the repo. On an **edit** the agent stays in its repo whatever you send — moving is `/agents/move` — but the field is still read for the duplicate-name and fixed-branch checks |
| `active` | — | `1` (or `on`/`true`) = on. Anything else, **including an absent field**, is off — the form's checkbox simply does not submit when it is unticked. `/agents/toggle` flips it without a full save |
| `harness` | yes | a configured coding agent id (`claude`, `opencode`, `hermes`, `cursor`, or a plugin) |
| `provider` | — | model provider id; empty for a subscription harness (claude, cursor), which refuse one |
| `model` | — | the identifier exactly as the provider spells it |
| `effort` | — | only a level that really exists for this harness+provider+model |
| `or_mode` | — | `offen` (default) / `auto` / `pin`. Only meaningful with `provider=openrouter` |
| `or_provider` | — | the serving-provider tag, with `or_mode=pin` |
| `or_quant` | — | `or_mode=auto`: minimum quantization, a *lower* bound. `fp4 int4 q4 nf4 mxfp4 fp5 fp6 int8 fp8 fp16 bf16 fp32` |
| `or_region` | — | `or_mode=auto`: `all` (default) / `us` / `eu` / `de` / `cn` |
| `or_max_in`, `or_max_out` | — | `or_mode=auto`: price caps, USD per million tokens |
| `prompt` | yes | the task. Must not be blank |
| `goal` | — | the completion condition; only claude has one today (see §6) |
| `branch_mode` | yes | `keiner` (detached worktree) / `neu` (create a branch) / `fest` (an existing branch) |
| `branch_pattern` | with `neu`/`fest` | the branch name. `{date}`, `{agent}`, `{kurz}` are expanded at start |
| `keep_on_branch` | — | `1` or `on`. Needs a branch; refused with `branch_mode=keiner` |
| `expected_minutes` | — | integer, default 45. Anything unparseable falls back to 45 |
| `skills` | — | **repeated**, one per selected extra skill (the folder name under `~/agents/zusaetze`). Unknown names are dropped silently |
| `skill_regler_<name>` | — | that skill's dial (`unlazy` takes `2`–`5`); an invalid value is dropped and the skill kept |
| `flows` | — | **repeated**, one flow id per attached flow. Only flows with a `run_finished` trigger can be attached |
| `flow_when_<flowId>` | — | `always` (default) / `done` / `failed` / `not_done` / `aborted` |
| `schedule_kind` | — | see §4; absent means `manuell` |
| `schedule_days` | with `woechentlich` | **repeated**, `0`=Sunday … `6`=Saturday |
| `schedule_time` | with `woechentlich` | `HH:MM`, the hub machine's local time |
| `schedule_weeks` | with `woechentlich` | `1`–`4` |
| `schedule_anchor` | when `schedule_weeks` > 1 | `YYYY-MM-DD` |
| `run_at` | with `einmalig` | `YYYY-MM-DDTHH:MM`, local time |
| `schedule` | with `cron` | a 5-field cron expression |

Only the fields of the **chosen** `schedule_kind` are taken over; the others are
nulled, so switching to `manuell` really does stop the agent.

Every `or_*` field is dropped unless `provider=openrouter`, and `or_mode=auto`
is dropped again unless the harness is **opencode** — that is the one place the
requirements can be passed through to the run. No complaint either way, exactly
as the form behaves.

A refusal is a list of English sentences. The ones you will actually hit:

| when | text (shortened) |
|---|---|
| name blank | `Name is missing.` |
| name reused in the repo | `An agent named "…" already exists in this repo.` |
| prompt blank | `Prompt is empty.` |
| unknown/disabled harness | `Unknown coding agent: …` / `Coding agent "…" is not configured or disabled…` |
| provider on claude/cursor | `… runs on its subscription — there is no provider selection, only the model.` |
| provider not usable here | `Provider "…" is not available for … here` |
| bad effort | `Reasoning effort "…" is not possible for …` |
| goal over 4000 chars | `The goal is … characters long — at most … are allowed.` |
| bad branch mode / missing pattern | `Unknown branch expectation: …` / `Branch pattern is missing…` |
| `fest` on a branch another worktree holds | `Branch "…" is already checked out in …` |
| keep-on-branch without a branch | `Keeping the work on a branch needs a branch…` |
| schedule | `Please select at least one weekday.` · `Time is missing or invalid (format HH:MM).` · `Interval must be 1, 2, 3 or 4 weeks.` · `A multi-week interval needs an anchor week.` · `Please give a valid date.` · `Cron expression is missing.` · `"…" is not a 5-field cron …` |

The full list with its i18n keys is in `references/editing.md`.

## 4. The schedule

| `schedule_kind` | fires |
|---|---|
| `manuell` | never by itself — only "start now", a flow or the API |
| `woechentlich` | on each selected weekday at `schedule_time`, every `schedule_weeks` weeks counted in **whole weeks from the anchor's Monday** |
| `einmalig` | once, as soon as `run_at` has passed. A start missed while the hub was off is caught up — and the agent then **rewrites itself to `manuell`** |
| `cron` | whenever the expression matches the current minute |

**Cron is a minimal 5-field dialect** (`server/util.mjs`): `minute hour day
month weekday`, evaluated in the hub machine's **local** time. Supported per
field: `*`, a number, `a-b`, comma lists, and `/n` steps on any of those. Field
maxima are `59 23 31 12 6` — **weekday 7 is rejected by validation** even though
the matcher would read it as Sunday, so write Sunday as `0`. No names (`MON`),
no `@daily`, no seconds. `0 6 * * 1-5` is the canonical example.

What the scheduler does with it (`server/scheduler.mjs`):

- a tick every **30 s**; a due minute fires at most once (debounced per agent and minute);
- **the global pipeline switch gates it.** With the `pipeline_on` setting off,
  *no* scheduled start happens at all — the first thing to check when an agent
  "did not fire". A manual start, a flow start and `POST /api/runs` are never
  gated by it. It is the switch in the status sidebar;
  `fl-api -X POST /api/settings/pipeline value=1` turns it on (`value=0` off);
- an agent whose previous run is still `running`, `waiting_help` or `deferred`
  is **skipped**, not queued — the event `schedule_skipped` is written on that
  busy run. A slow agent does not lap itself;
- `repos.max_parallel` (0 = unlimited) bounds **scheduled** starts only, and a
  skip there is also `schedule_skipped` with `reason: 'max_parallel'`;
- then the budget gate. Blocked means the run is created as `deferred`, not
  lost; the watcher starts it when the window refills.

## 5. Delete, move, start, toggle

| do | call | notes |
|---|---|---|
| start now | `fl-api -X POST /agents/start id=<id> repo=<repoId>` | ignores the pipeline switch and `max_parallel`; the budget gate still applies. 303 to the new run — `fl-api` cannot show the `Location`, so read the id back with `fl-api /api/runs agent=<id> limit=1` |
| on/off | `fl-api -X POST /agents/toggle id=<id> repo=<repoId>` | flips `active` |
| delete | `fl-api -X POST /agents/delete id=<id>` | **the past runs survive.** Only `runs.agent_id` is nulled; each run keeps its own definition copy and title snapshot, so the history stays in the overview. Irreversible — confirm with the operator first |
| move | `fl-api -X POST /agents/move id=<id> repo=<targetRepoId>` | a name collision in the target repo appends a `YYYY-MM-DD-HHMMSS` suffix (UTC). Refused for a target that does not exist or is the repo it already lives in. `GET /agents/move?id=<id>` is the page |

All four answer 303 on success. An unknown id: `start` and `delete` answer
**404**, `move` a 400 problem page, `toggle` nothing at all (it just redirects).
`toggle` takes `repo` only to decide where the browser goes back to; `start`
ignores it (it redirects to the new run, or to `/agents` when none was created)
and `delete` ignores it too, reading the repo from the row.

## 6. The goal — the second prompt

`agents.goal` is not the task, it is the condition under which the task is
**done**. Claude's `/goal <condition>` has a small model check it after every
turn and takes another turn by itself while it does not hold. Rules:

- only a coding agent whose plugin declares a `goal` spec has one — **claude
  today**, max **4000** characters. Sending a goal to any other harness is not
  an error: it is silently dropped, exactly as the disabled form field would;
- a leading `/goal` is stripped for you; too long is a refusal, never a
  silent truncation (half a condition means something else);
- there is **no CLI flag** for it. `server/goal.mjs` types it into the tmux
  session after the start, once the TUI has drawn, and again from the watcher
  pass for anything that did not get through. `runs.goal_sent_at` is the
  once-only mark; a retry clears it. It is only ever delivered from status
  `running` — in `waiting_help` the text would be read as the answer to the
  agent's question.

## 7. What the agent actually receives

`launchRun()` writes `~/agents/runs/<id>/prompt.md` as these parts, in this
order, joined by blank lines (empty parts dropped):

1. the run's **prompt** (the agent's `prompt`, snapshotted at creation);
2. the **repo prompt** (`repos.prompt`) as `Repository context (applies to every run of this repo)` — read **live** at launch, so editing it changes the next run, never a running one;
3. the **prompt extra**, when a flow's `start_agent` step passed one;
4. the **extra skills** block: one line per selected skill telling the agent to read that `SKILL.md` first;
5. the **platform suffix** (`platformSuffix()`): platform rules (working directory, the branch sentence, expected minutes, how to call `fl-report progress/branch/pr/help/failed`), then the operator's *Settings → Platform prompt suffix*, then the harness's own rules, then how the run ends, then the follow-up rules.

**The operator's prompt suffix is an addition and cannot replace the finish
rules.** It used to replace the whole block, and prompts silently lost the
sentence "at the end always `fl-report done`". Do not try to steer the ending
through that field; put repo-wide instructions in the repo prompt instead.

Under `repos.merge_mode='hub'` the suffix additionally carries the merge rule
(the hub merges, the agent never pushes to the base branch) — unless
`keep_on_branch` is set, where the branch sentence already says the opposite.

## 8. What an agent has produced

```bash
fl-api /api/runs agent=<id> limit=20                # newest first, unarchived
fl-api /api/runs agent=<id> archived=all limit=50   # including archived ones
fl-api /api/runs/<runId>                            # one run, in full
```

Reading a row for history:

| field | means |
|---|---|
| `status` | `scheduled` `deferred` `running` `waiting_help` `done` `failed` `aborted` |
| `finish_state` | a sub-state of `running` while the finish gate holds the run: `checking` `awaiting_commit` `awaiting_merge` `check_failed` `merging` |
| `merge_status` | `merged` · `kept_on_branch` · `resolving` · `blocked_dirty` `blocked_conflict` `blocked_error` `blocked_no_remote` · `unmerged_commits` `unmerged_both` `unmerged_dirty` · `nothing`. **`done` does not mean merged** — read this column |
| `started_at` / `ended_at` | the real start (a planned or deferred wait is not counted) and the end, UTC |
| `expected_minutes` | the definition's estimate. Compare against `ended_at − started_at`: past 80 % the watcher writes `anomaly:soft_overrun`, past 100 % `anomaly:overrun` |
| `cost_eur` / `cost_usd`, `tokens_in` / `tokens_out` | what the run cost, where the harness reports it |
| `followups` | how many follow-up reports the run got after it had finished (0 = reported once) |
| `resolves_run_id` | set = this is a conflict run the integrator started, not work anybody asked for |

The report: `report_md` (short — the message text the operator got),
`report_detail_md` (the long write-up) and `followup_md` (the latest follow-up)
are columns on the run row from `GET /api/runs/<runId>`; the same text is on
disk as `~/agents/runs/<runId>/report.md` and `report-detail.md`, and that
response's `files` block gives the exact paths and whether they exist. Anything
deeper — events, incidents, liveness, retry, terminal — is
`../freilauf-runs/SKILL.md`.

## 9. Attached flows, in one paragraph

An agent carries `flows`: a list of `{flowId, when}` written by the repeated
`flows` field plus `flow_when_<flowId>`. The attachment **is** the filter — when
the run ends, every attached flow whose condition covers the outcome starts, all
of them in parallel. The list is snapshotted into `runs.flows` at creation, so
editing the agent does not change what a run already in flight will fire. The
same rows are edited from the flow designer's trigger panel, so nothing has to
be kept in sync. Everything else — triggers, steps, variables, `run_merged` —
is `../freilauf-flows/SKILL.md`.

## Gotchas

- **A branch belongs to exactly one worktree.** `branch_mode=fest` with the base
  branch (which the main checkout holds) can never work; the form refuses it
  before the agent is saved.
- **Do not invent a model id.** opencode reports an unknown model as
  `UnknownError: Unexpected server error` — indistinguishable from a real
  provider outage. Copy ids from `/api/models` (see `../freilauf-models/SKILL.md`).
- **An inactive repo starts nothing.** A repo can be deactivated
  (`repos.active = 0`): it vanishes from every repo dropdown, its agents are
  skipped by the scheduler, and a manual start is refused with a problem naming
  the repo. So "the agent did not fire" and "the repo is not in the list" are
  frequently the same cause. `fl-api /api/repos` shows `active` on every row;
  `../freilauf-repos/SKILL.md` has what deactivating does and does not do.
- **`schedule_time` and `run_at` and cron are the hub machine's local time**,
  not UTC. The run rows in the API are UTC.
- **`einmalig` rewrites itself.** After it fires, `schedule_kind` is `manuell`
  and `run_at` is NULL. An agent that "did not fire twice" fired once by design.
- **Repeated fields need the value repeated on the command line**
  (`skills=unlazy skills=other`), not comma-joined. `schedule_days` too.
- **Weekday numbering is `0`=Sunday**, matching JavaScript's `getDay()`, in both
  `schedule_days` and the cron weekday field.
- Creating an agent *and* starting a run in one JSON round trip:
  `fl-api -X POST /api/runs repo_id=<id> save_agent=1 agent_name=<name> …` takes
  the same definition fields and answers **JSON** (`{ok, runId, deferred,
  scheduled, error}`). The agent it saves gets **no schedule** (`manuell`) and a
  duplicate name is swallowed silently. Use it when you want the run id back;
  use `/agents/edit` when you want the schedule.
