# Editing an agent safely — the round trip

Read this when you are about to change an existing agent, when a
`POST /agents/edit` came back 400, or when you want to build the body by hand
instead of using `scripts/agent-edit.py`.

## Why a round trip is required

`POST /agents/edit` is not a patch. `saveAgent()` in `server/run-def.mjs` issues
one `UPDATE agents SET name=?, harness=?, model=?, prompt=?, goal=?, …` covering
every column of the definition and the schedule, and the values come only from
the submitted body. A field you leave out is written as its parsed default:

| omitted | becomes |
|---|---|
| `active` | **0** — the agent is switched off. Only `1`, `on` or `true` switch it on; every other value, and an absent field, mean off |
| `prompt` | empty → refused (`Prompt is empty.`) |
| `model`, `provider`, `effort`, `goal`, `branch_pattern` | NULL — and a NULL `provider` is a working agent that fails at its first API call, see the end of this file |
| `keep_on_branch` | 0 |
| `expected_minutes` | 45 |
| `skills`, `flows` | NULL (all selections dropped) |
| `schedule_kind` | `manuell`, and every schedule column NULL |
| `or_mode` | `offen` — a pinned or auto-routed agent loses its routing |

So: read the agent, turn the row back into a form body, change the one thing,
send the whole body.

## Row → form body

`GET /api/agents` gives the row. The mapping is not one-to-one; four fields need
converting. (This mirrors `setupToFormBody()` / `scheduleFields()` in the hub.)

| row field | body |
|---|---|
| `active` (0/1) | `active=1`, or the field omitted entirely for off |
| `keep_on_branch` (0/1) | `keep_on_branch=1`, or omitted |
| `or_provider` non-empty | `or_mode=pin`, `or_provider=<tag>` |
| `or_routing` JSON with `"mode":"auto"` | `or_mode=auto`, `or_quant=<quant_min>`, `or_region=<location or "all">`, `or_max_in=<max_in>`, `or_max_out=<max_out>` — omit a key the JSON does not carry |
| neither | `or_mode=offen` |
| `skills` (list of `"name"` or `"name:dial"`) | one `skills=<name>` per entry, plus `skill_regler_<name>=<dial>` where there is one |
| `flows` (list of `{flowId, when}`) | one `flows=<flowId>` per entry, plus `flow_when_<flowId>=<when>` |
| `schedule_days` (`"1,2,5"`) | one `schedule_days=<n>` per number |
| `schedule_time` (stored `"08:00,11:00"`) | one `schedule_time=<HH:MM>` per time — repeat the name. The comma-separated single form does **not** work here (see below) |
| `schedule_slots` non-empty | send it as the JSON string it is, and send **neither** `schedule_days` nor `schedule_time`: the slots outrank both, and two statements about one schedule is one too many |
| everything else | the same name, the value as a string; NULL becomes `''` |

`/api/agents` already parses `skills` and `flows` from JSON into lists;
`or_routing` it does **not** — that one is the raw stored string.

Only the fields belonging to the chosen `schedule_kind` need sending. Sending
extra ones is harmless: `scheduleFromForm()` reads only the branch it is in.

## The script

`scripts/agent-edit.py` does the whole round trip and the encoding above.

```bash
# show what would be sent, change nothing
python3 scripts/agent-edit.py --id 7 --dry-run

# change one thing
python3 scripts/agent-edit.py --id 7 model=z-ai/glm-5.3-flash
python3 scripts/agent-edit.py --id 7 prompt=@/path/to/new-prompt.md
python3 scripts/agent-edit.py --id 7 schedule_kind=cron schedule='0 6 * * 1-5'

# repeated fields: repeat the argument (this REPLACES the whole list)
python3 scripts/agent-edit.py --id 7 skills=unlazy skill_regler_unlazy=3
python3 scripts/agent-edit.py --id 7 --clear skills   # drop every skill
```

It prints the HTTP status and, on a 400, the refusal sentences it found in the
page. It needs `fl-api` on the PATH (only for `fl-api --url`) or `FL_HUB_URL` in
the environment.

## By hand

```bash
fl-api --status --raw -X POST "/agents/edit?id=7" \
  name="nightly docs" repo_id=3 active=1 \
  harness=opencode provider=openrouter model=z-ai/glm-5.3-flash effort=high \
  or_mode=auto or_quant=fp8 or_region=all \
  prompt="$(cat prompt.md)" \
  branch_mode=neu branch_pattern='docs/{date}-{kurz}' \
  expected_minutes=60 \
  skills=unlazy skill_regler_unlazy=3 \
  flows=4 flow_when_4=failed \
  schedule_kind=woechentlich \
  schedule_days=1 schedule_days=2 schedule_days=3 schedule_days=4 schedule_days=5 \
  schedule_time=06:00 schedule_weeks=1
```

Several times on the same days: `schedule_time=08:00 schedule_time=11:00`. The
comma-separated spelling (`schedule_time=08:00,11:00`) is a stored-value form
and is **not** accepted by `/agents/edit`: the server reads times through its
`<name>_list` field, which treats one comma-joined element as a single (invalid)
time and refuses with `Time is missing or invalid`. Repeat the name instead.
Different times per weekday — Tuesday at 08:00 and
11:00, Wednesday at 14:17 — is one field instead of those two:

```bash
fl-api --status --raw -X POST "/agents/edit?id=7" \
  … schedule_kind=woechentlich schedule_weeks=1 \
  schedule_slots='{"2":["08:00","11:00"],"3":["14:17"]}'
```

A weekday that is not in the JSON simply does not run.

`--status` puts `HTTP 303 /agents/edit` on stderr; that 303 is the success.
`--raw` keeps the 400 page readable (it is HTML, so the JSON pretty-printer
would only pass it through anyway). `fl-api` exits 1 on both 303 and 400 — the
status line is the only thing that tells them apart.

Creating a new agent is the same call without `?id=`.

## Every refusal, with its key

Problems are rendered through `t()`, so they arrive as English sentences
(`lang/en.json`). Placeholders in braces are filled in.

| key | text |
|---|---|
| `form.name_missing` | Name is missing. |
| `agents.name_taken` | An agent named "{name}" already exists in this repo. |
| `run.unknown_harness` | Unknown coding agent: {harness} |
| `run.harness_not_configured` | Coding agent "{harness}" is not configured or disabled — add it under Settings → Coding agents. |
| `form.subscription_no_provider` | {harness} runs on its subscription — there is no provider selection, only the model. |
| `form.provider_unavailable` | Provider "{provider}" is not available for {harness} here (missing key or not enabled?). Possible: {list} |
| `form.effort_invalid` | Reasoning effort "{effort}" is not possible for {target} — possible: {list} |
| `form.or_quant_unknown` | Unknown minimum quantization "{quant}" — known: fp4, fp5, fp6, fp8, fp16, bf16, fp32, int4, int8, mxfp4, q4 … |
| `form.prompt_missing` | Prompt is empty. |
| `form.goal_too_long` | The goal is {len} characters long — at most {max} are allowed. |
| `form.branch_mode_unknown` | Unknown branch expectation: {mode} |
| `form.branch_missing` | Branch pattern is missing (expectation is not "none"). |
| `form.keep_needs_branch` | Keeping the work on a branch needs a branch — choose "new" or "existing". |
| `run.branch_in_use` | Branch "{branch}" is already checked out in {worktree} — git grants a branch to only one worktree. … |
| `sched.err_days` | Please select at least one weekday. |
| `sched.err_time` | Time is missing or invalid (format HH:MM). |
| `sched.err_weeks` | Interval must be 1, 2, 3 or 4 weeks. |
| `sched.err_anchor` | A multi-week interval needs an anchor week. |
| `sched.err_at` | Please give a valid date. |
| `sched.err_cron_missing` | Cron expression is missing. |
| `sched.err_cron` | "{expr}" is not a 5-field cron (minute hour day month weekday), e.g. "0 6 * * 1-5". |

Move and delete answer differently — a problem page or a 404 body:

| key | text |
|---|---|
| `agents.not_found` | Agent not found. |
| `agents.move_bad_repo` | The target repo does not exist. |
| `agents.move_same_repo` | The agent already lives in that repo. |

The hub's UI language is switchable, and these strings are translated. If the
operator runs the UI in German or Chinese the sentences come back in that
language — match on the situation, not on the exact wording, when it matters.

## Silent drops (no refusal, no effect)

These are not errors and produce nothing in the problem list. If a setting
"did not stick", it is almost certainly one of them:

- `goal` on a harness that declares none (anything but claude today);
- `skills=<name>` for a folder that does not exist under `~/agents/zusaetze`
  (`FREILAUF_ZUSAETZE_DIR`);
- `skill_regler_<name>` with a value that skill's dial does not offer — the
  skill is kept, the dial dropped;
- `flows=<id>` for a flow that does not exist or whose trigger is not
  `run_finished`;
- `or_mode=auto` anywhere but `harness=opencode` + `provider=openrouter` — the
  only combination the requirements can be passed through, so `or_routing` is
  stored as NULL. A *bad* `or_quant` is still a refusal, whatever the harness;
- any `or_*` field when `provider` is not `openrouter` — both `or_provider` and
  `or_routing` are nulled. (`or_mode=pin` **is** stored for every harness as
  long as the provider is openrouter; only `auto` is gated on opencode.)

A `provider` the harness cannot use here is **not** a silent drop: it is
`form.provider_unavailable` above.

An **absent** `provider`, on the other hand, is neither refused nor dropped: it
is stored as NULL, and NULL is the hub's legacy path for a hand-typed complete
model slug. The agent saves and schedules, and its runs launch with a bare
`--model` and no credential — hermes losing its `--effort` on the way, since
that is passed on the provider branch only. Every coding agent whose
`/api/providers` answer lists at least one provider needs one of those ids,
even when the list holds exactly one; only `subscription: true` means "send
none". `scripts/agent-edit.py` refuses such a save for you (`--force` for the
deliberate hand-typed-slug case), and `scripts/fl-options.py agents` lists the
agents on this hub that already have the hole.
