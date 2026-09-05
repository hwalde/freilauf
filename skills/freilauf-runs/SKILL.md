---
name: freilauf-runs
description: >
  Find, start, watch, edit, stop and archive Freilauf runs — one execution of a
  coding agent in its own tmux session and git worktree. Use this skill whenever
  someone asks what a run is doing, whether an agent is still working or stuck,
  why a run failed or went red, how to start a run or give a finished one more
  work, how to attach to its tmux session, where its report or log is, or how to
  cancel, retry or archive it. Also use it for "is my agent still alive", "what
  happened to that job", "kill that session", "the run says failed but the
  screen is still moving" — even when the word Freilauf is never said.
license: CC BY 4.0
metadata:
  project: Freilauf
  source: https://github.com/hwalde/freilauf
---

# Freilauf runs

A **run** is one execution of a coding agent (claude / opencode / hermes /
cursor / a plugin) in its own tmux session and its own git worktree. An agent
and a single run are the same thing plus a name and a schedule.

Everything here goes through **`fl-api`**, which resolves the hub URL itself:

```bash
fl-api /api/runs repo=3 status=running        # GET, values become query params
fl-api -X POST /api/runs/<id>/title title="Docs sweep"   # POST, form-encoded
fl-api --url                                  # print the hub base URL
```

Repeat a name to send a list (`skills=unlazy skills=other`). Exit code 0 = HTTP
2xx, 1 = HTTP error (body still printed), 3 = the hub did not answer.

**Before deciding a harness / provider / model / effort, read
`../freilauf-models/SKILL.md`** — and the operator's saved setups
(`fl-api /api/favorites`) outrank every recommendation in it. Its step 3 is the
one rule worth carrying here as well: **a coding agent that is not on a
subscription needs a `provider`, every time, even when only one is available.**
Without it the run starts with a bare model id and no credential and fails at
its first API call, looking exactly like a provider outage.


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

`check` is not optional politeness: it **refuses** (exit 1) a definition whose
coding agent needs a model `provider` and does not name one — the one mistake
the hub itself accepts and the run then dies of. `fl-options.py coding-agents`
says which coding agents need one, this installation's plugins included.

### Where is the hub, on this machine?

The scripts work it out, in this order, and `fl-options.py where` shows it:

1. `FL_HUB_URL` — set inside every run Freilauf starts, so a run always talks to
   **its own** hub even if the machine has two installations.
2. `FREILAUF_HUB_URL` — export it to point a shell at one deliberately.
3. the calling card `.freilauf-skill.json` next to this skill: Freilauf writes
   its own address there when it installs the skill, and keeps it current.
4. `FREILAUF_LOCAL_PORT` from `~/.config/freilauf/env`.
5. `http://127.0.0.1:8791`, the code default.

`fl-api` is the raw client and follows the same idea; it is always on the PATH
inside a run. Outside one, prefer the scripts — they are self-contained.

## 1. Find a run

```bash
fl-api /api/runs                       # 50 newest, not archived
fl-api /api/runs repo=3 status=running
fl-api /api/runs agent=7 limit=200
fl-api /api/runs q="flaky test"        # searches title, prompt, and id-prefix
fl-api /api/runs archived=1            # only archived   (archived=all → both)
```

| param | meaning |
|---|---|
| `repo` | repo id (`fl-api /api/repos` lists them) |
| `status` | one exact value, see the status table below |
| `agent` | agent id (`fl-api /api/agents`) |
| `q` | `LIKE %q%` on title and prompt, **prefix** match on the id |
| `archived` | omitted = only unarchived, `1` = only archived, `all` = both |
| `limit` | default 50, hard ceiling 200 |

Sorted by `COALESCE(started_at, start_at)` descending. Each row carries
`short_id` (the first uuid segment — what session names and branches use) plus
`agent_name` and `repo_name`.

**One run in full** — and this is the endpoint that answers the interesting
questions:

```bash
fl-api /api/runs/<uuid>
```

It needs the **full 36-character uuid**; a short id gives 404. It returns
`run` (the whole row), `agent`, `repo`, `liveness`, `worktree`, `files`,
`events` (the run's complete history) and `incidents`.

## 2. Is the agent still running?

**This is a different question from the run's status, and getting it wrong is
the most common mistake on this hub.** Three of the four coding agents stay
alive in their TUI after the work is done — claude, opencode and cursor all sit
there waiting for a follow-up; only hermes (`chat -q`) exits. A run on `done`
usually still has a live agent in a live session.

```bash
fl-api /api/runs/<uuid> | python3 -c 'import json,sys; print(json.load(sys.stdin)["liveness"])'
```

```jsonc
{ "tmux_session": "fl-oc-nightly-1a2b3c4d", "pane_alive": true,
  "status": "done", "finish_state": null, "followup_open": 0,
  "followup_since": null, "last_activity_at": "2026-09-03 12:41:07",
  "agent_state": null, "agent_state_at": null,
  "verdict": "idle_in_tui" }
```

| `verdict` | means |
|---|---|
| `working` | pane alive **and** the run is in flight (`running`/`waiting_help`, or a finished run with an open follow-up) and the agent has not said it waits |
| `waiting_input` | pane alive and the coding agent's own hook said its turn is over — it sits at its prompt waiting for a human (`agent_state: "waiting"`). Typing into the terminal is what it needs; a `running` run in this state has stopped without reporting |
| `idle_in_tui` | pane alive, run already finished — the normal state of a done run |
| `process_gone` | the session exists, but every pane in it is dead |
| `no_session` | the run never had a session name recorded |
| `unknown` | the pane could not be asked about |

**`pane_alive` is tri-state: `true` / `false` / `null`**, and `null`
(→ `unknown`) covers two different things: tmux did not answer, **or the session
no longer exists** — a `tmux list-panes` on a killed session fails exactly like
an unreachable tmux does. Tell them apart with `tmux has-session -t "=<name>"`
and the run's `tmux_closed_at`. Never read `unknown` as "the agent is gone":
tmux reports "there is no server" and "I could not answer you" through the same
exit code, and the hub itself skips such a run and retries on the next pass
rather than ending it.

`verdict: "working"` says the process is there; it does **not** say the agent is
doing anything. For that read `last_activity_at`, which the watcher refreshes
per pass from a per-harness source: claude's transcript mtime, opencode's own
session store, cursor's agent-transcript mtime — and **nothing at all for
hermes**, whose `last_activity_at` therefore stays empty. Silence is never an
argument on hermes.

### One command for the whole answer

This skill ships a script that asks the question for one run or for a whole
repo and prints the status and the verdict side by side — which is the only way
to see that they disagree:

```bash
<skill-dir>/scripts/run-alive.py <run-uuid>
<skill-dir>/scripts/run-alive.py --repo <id>
<skill-dir>/scripts/run-alive.py --status running
```

```text
SHORT     STATUS        VERDICT       SESSION                    LAST ACTIVITY        TITLE
1a2b3c4d  done          idle_in_tui   fl-oc-nightly-1a2b3c4d     2026-09-03 12:41:07  Docs sweep
5e6f7a8b  running       unknown       fl-nightly-5e6f7a8b        2026-09-03 09:02:11  Flaky test hunt
```

It shows the 15 newest and says how many it held back (`--all` for everything).
Exit codes: 0 printed something, 1 no run matched, 2 usage, 3 no hub answered.
Needs only `python3` — it talks to the hub itself and finds it the way
"Start here" describes.

### The same question from a shell

```bash
tmux has-session -t "=<session>"                       # exit 0 = it exists
tmux list-panes  -t "=<session>:" -F '#{pane_dead} #{pane_pid} #{pane_current_command}'
tmux capture-pane -p -t "=<session>:" | tail -40       # what is on the screen
```

The `=` prefix means "this exact name, no prefix matching". **The trailing colon
is mandatory for `capture-pane`, `pipe-pane` and `set-hook`** — without it tmux
answers `can't find pane: =<session>` on stderr and produces no output at all
(measured with tmux 3.4: exit 1), so a script that only reads stdout concludes
"nothing there". `list-panes` and `has-session` work
either way; always write the colon, it is never wrong. And never use
`tmux display -p -t "=<name>"` to test existence — it returns 0 for a session
that does not exist.

## 3. Errors — and the caveat that matters most

**An incident, a `failed` status or a red traffic light does NOT mean the coding
agent stopped.** Three separate reasons:

1. `status` records **what was reported**, not what the process is doing. A run
   marked `failed` by its agent, or `aborted` because its session was closed,
   may still have a live process — and a run on `done` almost always does.
2. Incidents from the **log scanner** are pattern matches on the agent's own
   screen. An agent working on error handling, reading this very file, or
   running the test suite puts "API Error: 503" and "rate limit" into its own
   log. The hub vetoes escalation when there is measurable work *after* the hit,
   but a yellow entry can still be nothing but text.
3. An incident describes a *moment*, not a state. It stays open until somebody
   or something resolves it, long after the condition went away.

**So: before telling anyone an agent is gone, check liveness (§2)**, and report
the two facts separately — "recorded as failed; its pane is alive and it last
moved 40 seconds ago" is the useful sentence.

### Reading the errors

```bash
fl-api /api/runs/<uuid>/incidents
```

The incident columns are German on the wire: `typ`, `quelle` (source),
`schwere` (`gelb` = suspected, `rot` = confirmed), `erst_gesehen`,
`zuletzt_gesehen`, `anzahl` (count), `beleg` (evidence), `geloest_am`
(resolved-at, **NULL = open**), `geloest_von`, `wieder_geoeffnet`, `notify_at`,
`gemeldet_am`.

| `typ` | what it is | needs a human? |
|---|---|---|
| `auth_error` | token / login | **yes** — every following run hits the same wall |
| `billing_error` | credits, payment, account on hold | **yes** |
| `model_error` | model id unknown or unavailable | **yes** |
| `rate_limit` | 429, usage limit | no — the hub defers and retries |
| `provider_error` | 5xx, overloaded, connection | no |
| `provider_down:<provider>` | global, from the 5-minute provider pulse | no |
| `merge_blocked` | the hub could not get the work onto the base branch | **yes** |
| `tmux_gone` / `tmux_unreachable` | global: all sessions lost / tmux silent | **yes** |
| `unbekannt` | an API error it could not classify | no |

Plus: **any `rot` incident on a run that ended `failed`/`aborted` needs a
human** — that is why the run did not come through.

Resolve one, or all of a run's:

```bash
fl-api -X POST /api/incidents/<incident id>/resolve
fl-api -X POST /api/runs/<uuid>/incidents/resolve-all
```

Resolving only silences it. A recurrence reopens it and notifies again.

### Anomalies are events, not incidents

The watcher writes them into the run's `events` list: `anomaly:no_activity`,
`anomaly:soft_overrun` (80 % of the expected duration), `anomaly:overrun`,
`anomaly:quota_full`, `anomaly:session_gone`, `anomaly:worktree_dirty`,
`anomaly:unpushed`, `anomaly:exit_without_report`, plus the follow-up pair
`anomaly:followup_soft_overrun` / `anomaly:followup_overrun`. **A retracted
anomaly is renamed, not deleted** — it becomes `cleared:anomaly:…`, so match
`kind` on the `anomaly:` **prefix** or you will count withdrawn statements as
live ones.

Read `references/incidents.md` when you need the detection channels per harness,
the yellow→red escalation rule, or the auto-resolve conditions.

## 4. Start a run

Two endpoints. Use **Quick Run** when a favorite already describes the setup;
use the full endpoint when the task needs a specific model, skills, a goal or a
saved agent.

### Quick Run — a favorite plus a task

```bash
fl-api -X POST /api/runs/quick \
  favorite_id=1 repo_id=3 \
  prompt="Fix the flaky test in test/e2e.mjs" \
  branch_mode=neu branch_pattern="fix/{kurz}"
```

The endpoint takes an **allowlist of exactly five form fields** — `repo_id`,
`prompt`, `branch_mode`, `branch_pattern`, `keep_on_branch` — plus
`favorite_id` and the start-time fields. Everything else (harness, provider,
model, effort, skills, flows) comes from the favorite and **cannot** be
overridden here; that is deliberate, so the button cannot start something other
than its name promises. Answers JSON: `{ ok, runId, pending, deferred,
scheduled, title, favorite }`.

**It answers before the run is running.** `pending: true` means the row exists
and the launch — `git fetch`, the worktree checkout, the tmux session, seconds
of it in a large repository — is still going in the hub. So do not read
`tmux_session` or expect `verdict: "working"` in the same breath; poll
`GET /api/runs/<id>` until `tmux_session` is set, or until the status says
`deferred`/`failed`. `POST /api/runs` below does wait, and answers with the
session already standing.

### The full endpoint

```bash
fl-api -X POST /api/runs \
  repo_id=3 \
  harness=opencode provider=openrouter model="z-ai/glm-5.3-flash" effort=high \
  prompt="Port the parser to the new API and keep the tests green" \
  branch_mode=neu branch_pattern="feat/{kurz}" \
  expected_minutes=60 \
  title="Parser port"
```

`repo_id` and `prompt` are required. `title` is optional (otherwise the prompt's
first line, which a cheap LLM then improves in the background). The rest:

| field | values | note |
|---|---|---|
| `harness` | `claude` `opencode` `hermes` `cursor` … | must be a **configured** plugin |
| `provider` | one id out of `fl-api /api/providers harness=<id>` | **required whenever that list is non-empty — one entry included.** Omit it only for a coding agent answering `subscription: true` (claude, cursor today), where sending one is an error. A missing one is *not* refused by the hub: the run starts with a bare model id and no credential and dies at its first API call, so `fl-options.py check` refuses it for you |
| `model`, `effort` | see `../freilauf-models/SKILL.md` | validated against what that exact combination offers |
| `goal` | completion condition | only for a harness that declares one (claude); otherwise dropped |
| `branch_mode` | **`keiner`** \| **`neu`** \| **`fest`** | German wire values: no branch / new branch / existing branch |
| `branch_pattern` | e.g. `feat/{kurz}` | required unless `keiner`; `{kurz}` = short run id |
| `keep_on_branch` | `1` | only under `merge_mode=hub`, and never with `keiner` |
| `expected_minutes` | integer | default 45 (0, blank and junk all become 45); drives the overrun traffic light |
| `skills`, `flows` | repeat the field per entry | opt-in extra skills / flows to fire when the run ends |
| `start_mode` | `now` \| `at` (+ `start_at`) \| `in` (+ `start_in_minutes`) \| `idle` | `idle` = when no other run of this repo is going; the last three land in status `scheduled` |
| `save_agent`, `agent_name` | `1` + a name | also store this definition as a reusable agent |

The answer is `{ ok, runId, deferred, scheduled, error }`. **`deferred` is not a
failure** — the budget gate parked the run until the quota refills, and the hub
picks it up itself. Do not retry it in a loop; §5 has the override.

Read `references/run-fields.md` for the complete field list, the OpenRouter
serving-provider fields (`or_mode` = `offen`/`auto`/`pin` and friends), the
skill-dial fields, and exactly which validation rejects what.

## 5. Change a run that still has a future

```bash
fl-api -X POST /api/runs/<uuid>/edit expected_minutes=120
fl-api -X POST /api/runs/<uuid>/edit prompt="…" repo_id=4
fl-api -X POST /api/runs/<uuid>/edit start_mode=now
```

What a status allows — the endpoint refuses anything else:

| field | `scheduled` | `deferred` | `running` / `waiting_help` | `done` / `failed` / `aborted` |
|---|---|---|---|---|
| `expected_minutes` | ✓ | ✓ | ✓ | only while a follow-up is open |
| `prompt` | ✓ | ✓ | — | — |
| `repo_id` | ✓ | ✓ | — | — |
| `branch_mode` / `branch_pattern` / `keep_on_branch` | ✓ | ✓ | — | — |
| `start_mode` / `start_at` / `start_in_minutes` | ✓ | — | — | — |

The rule behind the table: **whatever is read at the moment it is used stays
editable until then.** The prompt, the repo and the branch rule are read when
the run launches; the expected duration is read live on every watcher pass.
Consequences:

- Raising `expected_minutes` **retracts** the overrun statement — the
  `anomaly:*overrun` events become `cleared:*` and the notification flag is
  dropped, so a genuine overrun of the *new* duration can page again. The
  running agent is deliberately not told.
- Changing the prompt re-derives the title **only** while it is still the old
  prompt's fallback; a name a human or the title LLM gave always wins.
- `start_mode=now` on a `scheduled` run **starts it immediately** (budget gate
  included; blocked means `deferred`, not failed). Not offered on a `deferred`
  run, which already starts the moment the gate opens.
- Moving a run to the repo it is already in is a no-op, not an error. Nothing is
  applied at all if any part of the request is invalid.

## 6. Stop, retry, archive — a run is never deleted

There is **no delete**. A run is aborted, or archived; the record, report, log,
events and incidents stay.

| action | call | what it does |
|---|---|---|
| stop / cancel / close | `-X POST /api/runs/<id>/kill` | kills the tmux session, and then depends on the status: `running`/`waiting_help` → `aborted` + leftover work assessed + flows fired; `scheduled`/`deferred` → `aborted` (this is how you cancel one); **`done`/`failed`/`aborted` → the session only**, event `tmux_closed`, the clean record is *not* rewritten |
| force a deferred start | `-X POST /api/runs/<id>/start` | only `deferred`; skips the budget gate, event `forced_start` |
| run it again | `-X POST /api/runs/<id>/retry` | clears report, follow-ups, integration state and archive flag, then launches a **new session** |
| archive | `-X POST /api/runs/<id>/archive` | only `done`/`failed`/`aborted`; also closes the tmux session (immediately by default) |
| archive several | `-X POST /api/runs/archive run=<id> run=<id> …` | the same rule per run; answers `results: [{run, ok, error}]` — a refusal (a run still in flight, an unknown id) does not hold up the rest |
| restore | `-X POST /api/runs/<id>/unarchive` | back into the overview; the session does not come back |
| rename | `-X POST /api/runs/<id>/title title="…"` | empty title falls back to the agent's name |
| mute | `-X POST /api/runs/<id>/notify on=0` | no message about this run on any channel; `on=1` re-enables. `/telegram` is an alias |
| say it is done | `-X POST /api/runs/<id>/mark-done` | exactly what `fl-report done` is, typed by a human — same finish gate |
| merge now | `-X POST /api/runs/<id>/merge` | optional `leftovers=commit` or `leftovers=discard` for an uncommitted worktree |
| give up on merging | `-X POST /api/runs/<id>/merge-skip` | `merge_status=skipped_by_operator` |

Ending a session — through any of those paths or through
`-X POST /api/sessions/kill session=<name>` — is a **run event**, not just a
tmux call: a run still on `running`/`waiting_help` becomes `aborted` with a
report line saying why, and its flows fire.

## 7. Reading the run row

| status | meaning |
|---|---|
| `scheduled` | waiting for its time, or for the repo to fall idle |
| `deferred` | the budget gate parked it; the hub retries by itself |
| `running` | started |
| `waiting_help` | the agent asked a question and is waiting for a human |
| `done` / `failed` / `aborted` | terminal — and see §2: the process usually lives on |

`finish_state` is a **sub-state of `running`**, not a status: `checking`,
`awaiting_commit` (the worktree is dirty — nothing is merged while it is),
`awaiting_merge` (it conflicts), `merging`, `check_failed`. While it is set, the
run has already reported and the watcher stops writing overrun anomalies for it.

`merge_status` is where the work ended up: `merged`, `merging`, `resolving`,
`kept_on_branch`, `nothing`, `blocked_dirty`, `blocked_conflict`,
`blocked_error`, `blocked_no_remote`, `skipped_by_operator`, and — for a run
that ended badly, which is never merged automatically — `unmerged_commits`,
`unmerged_dirty`, `unmerged_both`. `references/integration.md` says what to do
about each.

Other columns worth reading: `followup_since` (a human sent more work into a
finished session — it displays as running again), `followup_open`, `followups`,
`archived_at` (NULL = visible), `resolves_run_id` (set = this is a **conflict
run**, a tool of the integrator, not work anybody asked for — the interesting
run is the one it points at), `base_sha`, `merged_sha`, `expected_minutes`,
`cost_eur`/`cost_usd`, `tokens_in`/`tokens_out`, `exit_code`,
`workdir_effective` (the worktree), `tmux_session`, `tmux_closed_at`,
`last_activity_at`.

### The files

`/api/runs/<uuid>` returns `files` with an absolute `path` and an `exists` flag
for each, all under `~/agents/runs/<uuid>/`: **`prompt.md`** (the full prompt,
platform rules included), **`report.md`** and **`report-detail.md`** (what the
agent wrote), **`log.txt`** (the tmux `pipe-pane` log — everything that was on
the agent's screen), **`detektor.jsonl`** (every incident decision with its
reasoning) and **`inbox.jsonl`** (reports that could not reach the hub; the
watcher replays them). `worktree.path` in the same answer is where the agent
actually works.

## 8. The tmux session, and attaching to it

The hub names a session **`fl-<tag><name>-<short id>`** — tag `` (empty) for
claude, `oc-` for opencode, `he-` for hermes, `cu-` for cursor, and a plugin's
own `sessionTag` (noted in `<data dir>/harness-tags` the first time it launches
one). So `fl-oc-nightly-1a2b3c4d` is opencode, `fl-nightly-1a2b3c4d` is claude.

`<name>` is the agent's name, lowercased and sanitized — or literally `einzel`
(German for "single") for a run without an agent. A collision appends `-2`,
`-3`. **Sessions from before the project was renamed carry a `cc-` prefix and
are still live**; `fl-attach`, `fl-kill` and `fl-help` list and address both.

Do not derive the name — read `tmux_session` off the run row, or:

```bash
fl-api /api/sessions        # every session on the machine, run/agent/repo, RSS, CPU
fl-attach <session|name>    # pick and attach (bare name works too)
fl-attach -p "Status?" -n <session>   # send a line in without attaching
fl-kill <session>           # end one, with a confirmation
fl-help                     # overview of all fl-* commands
```

`/api/sessions` runs three subprocesses per call — do not poll it.

**Attaching rewraps the agent's window to your terminal size**, with or without
write access (`window-size latest` is the default) — that is visible to the
agent, and `tmux attach -r` does not prevent it. In the browser the terminal is
fail-closed twice: `/term` grants write access only on an explicit `?ro=0`, and
the page sends that only when the session stands *and* a process is in it.

## 9. A finished run can be given more work

The agent is still sitting in its TUI (§2), so this is the ordinary shape of a
day, not a trick:

```bash
fl-api -X POST /api/runs/<uuid>/send text="Also update the German README."
```

On a **finished** run that send is a **follow-up commission**: `followup_since`
is set, the run displays as running again, and the expected duration starts
counting from that moment (new instructions restart the clock). On a
`waiting_help` run the same call is the **answer** to the question and puts the
run back on `running` — which is why you must never send a random note to a run
in that status.

The agent reports the follow-up with the **same command it always uses**,
`fl-report done --file <report>`; the hub tells a first report from a follow-up
by the run's status. It goes through the same finish gate, integrator and flows,
and the run's **status does not change** — a `done` run stays `done`; what the
follow-up delivered shows in `followups`, the merge line and the report.

`fl-report` is how an agent talks to the hub (`done`, `failed`, `help`,
`progress`, `branch`, `pr`). It reads `FL_RUN_ID` and `FL_HUB_URL` from the
environment and **falls back to `http://127.0.0.1:8791`** — the code default,
which is very often not this hub's port. A hand-written call from outside a run
must set `FL_HUB_URL` (`fl-api --url` prints the right one), or the report ends
up in `inbox.jsonl`. `POST /api/runs/<id>/report` takes a **JSON** body, so it
is one of the few routes `fl-api` cannot drive.

## 10. When a run reported but will not finish

With the repo's integration on (`merge_mode=hub`) a `done` report is **checked,
not believed**: dirty worktree → the agent is told to commit; conflict → it is
told to merge the base branch and resolve; otherwise the hub merges and pushes
itself, and only then is the run `done`. The run sits in `finish_state`
meanwhile, and the hub's answer is printed into the agent's own turn.

Stuck? Look at `finish_state`, then `merge_status`, then the `merge_blocked`
incident — then use `/merge`, `/merge-skip` or `/mark-done`.

Read `references/integration.md` when a run is blocked, when you need the
escalation ladder, what a conflict run is, or what `keep_on_branch` changes.

## Gotchas

- **`/api/runs/<id>` needs the full uuid.** A short id returns 404. Get the full
  one from `/api/runs` (`id`, with `short_id` next to it).
- **`pane_alive: null` is "unknown", never "the agent is gone"** — and it also
  turns up when the session was simply killed. See §2.
- **A `deferred` run is not broken.** The budget gate parked it; it starts by
  itself. Force it only with `/start`, and only if the operator agrees.
- **A start into an inactive repo is refused.** A repo can be deactivated
  (`repos.active = 0`), which takes it out of every repo dropdown and stops both
  scheduled and manual starts; its existing runs stay fully readable with an
  explicit `?repo=<id>`. If a start is refused with a problem naming the repo,
  that is why — see `../freilauf-repos/SKILL.md`.
- **Killing a finished run does not un-finish it** — it only closes the session.
  Killing a *live* one writes `aborted` over whatever it was.
- **Branch mode `fest` with a branch another worktree holds is refused**, the
  classic case being the repo's base branch: git grants a branch to exactly one
  worktree. The endpoint says so instead of failing at `git worktree add`.
- **The wire values are German in three places**: branch modes
  `keiner`/`neu`/`fest`, the OpenRouter open mode `offen`, and the incident
  columns (`typ`, `schwere` = `gelb`/`rot`, `geloest_am`, …). Agent schedules use
  `manuell`/`woechentlich`/`einmalig`/`cron`.
- **A run working on Freilauf itself reads its own alarm texts into its log** and
  can open incidents about them. Confirm against liveness and activity before
  acting on a log-scan incident.
