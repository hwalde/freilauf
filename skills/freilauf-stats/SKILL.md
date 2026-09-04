---
name: freilauf-stats
description: >
  Read Freilauf's own numbers from the shell — the status sidebar without a
  browser. Use this skill when someone asks how much quota or credit is left,
  why a run was deferred or is not starting, what the machine is holding in
  memory, how many runs are in flight or stuck, whether anything needs a human,
  what a run or a week cost, how many tokens something burned, or how fresh any
  of those numbers actually are. Also use it before answering "can I start
  another run right now" and before reporting any figure that came out of a
  cache — even when the words "Freilauf", "sidebar" or "statistics" are not
  used.
license: CC BY 4.0
metadata:
  project: Freilauf
  source: https://github.com/hwalde/freilauf
---

# Reading Freilauf's statistics

The status sidebar is on every page of the web UI and is the whole "how is this
machine doing" answer. Everything in it is reachable from a shell.

**There is no aggregate statistics page.** Per-run figures live on the run, the
sidebar aggregates the current moment, and nothing renders "this week's spend"
or "runs per outcome". For anything cross-run, query the database read-only
(see [references/sql-recipes.md](references/sql-recipes.md)).

**Every number here comes out of a cache.** Report the value *and* its age when
the age could matter — the section "Freshness" at the bottom is the table.

## The one command

`fl-api` (repo `bin/fl-api`, installed to `~/.local/bin` by
`setup/02-install-scripts.sh`) talks to the hub on `127.0.0.1`:

```bash
fl-api /api/usage                        # GET, pretty-printed JSON
fl-api /api/runs repo=3 status=running   # name=value become query parameters
fl-api -X POST /api/runs/<uuid>/start    # POST, form-encoded body
fl-api --url                             # just print the base URL
```

Exit codes: `0` = HTTP 2xx, `1` = HTTP error (body still printed), `2` = usage
error, `3` = the hub did not answer. Inside a run `FL_HUB_URL` is authoritative;
otherwise the port is read from `~/.config/freilauf/env`. The hub has **no
authentication** — being able to run the command on the machine is the
authorization.

## The sidebar, block by block

`statusSidebar()` in `server/pages.mjs` renders, in this order:

| # | block | what it says | shell equivalent |
|---|---|---|---|
| 0 | rail (folded state) | pipeline dot, incident dots, one bar per usage window — its `7d` is the **maximum** weekly window | — |
| 1 | `headerStatus()` | pipeline on/off, and the **running commit sha** (`hubVersion()`: `git rev-parse --short HEAD` at the module's own directory, cached for the process, empty without git) | `git -C ~/agents/deploy/freilauf rev-parse --short HEAD` |
| 2 | `workBlock(repoId)` | work in flight per status | `fl-api /api/runs repo=<id> status=<s>` |
| 3 | `incidentBlock(repoId)` | open incidents, "Needs you" / "Noticed" | SQL, see below |
| 3b | `panelsBlock(repoId)` | what the PROJECT counts — see below | `fl-api /api/panels repo=<id>` |
| 4 | `usagePanel()` | subscription windows + provider balances | `fl-api /api/usage` |
| 5 | `memoryBlock()` | RSS of every tmux session on the machine | `fl-api /api/sessions` |

Blocks 3–5 vanish entirely when they have nothing to say, and block 2 prints a
"nothing in flight" line instead of a list. **A zero is never rendered** — "no
open incidents" means the block is absent, not that it reads 0.

### Work in flight (block 2)

`WORK_STATUSES = ['running', 'waiting_help', 'scheduled', 'deferred']`, in that
reading order. Per status:

```sql
SELECT count(*) FROM runs WHERE repo_id=? AND archived_at IS NULL AND status=?
```

Two rules that are easy to get wrong:

- **A finished run with an open follow-up commission counts as `running`.** The
  `running` row adds `status IN ('done','failed','aborted') AND followup_since
  IS NOT NULL` — the operator typed new work into a finished run's session, so
  it is work in flight. `followUpActive()` / `displayStatus()` in `pages.mjs`
  do the same for the overview.
- **The dimmed `(y overall)` suffix** is the same count across *all* repos
  (`WHERE archived_at IS NULL AND status=?`, no repo filter). It is rendered
  **only when the total is strictly greater** than this repo's count, and it
  sits outside the link.

### Incidents (block 3)

```sql
SELECT i.*, r.status AS run_status FROM incidents i
  LEFT JOIN runs r ON r.id = i.run_id
 WHERE i.geloest_am IS NULL AND (i.run_id IS NULL OR r.repo_id = ?)
```

**`run_id IS NULL` is a GLOBAL incident** (provider pulse, `tmux_gone`,
`tmux_unreachable`) and is therefore counted in **every** repo's sidebar. Do
not report a global incident as belonging to the repo you happen to be looking
at.

The split is `brauchtMensch(v, runStatus)` in `server/incidents.mjs`:

| group | rule |
|---|---|
| **Needs you** | type head ∈ `auth_error`, `billing_error`, `model_error`, `merge_blocked`, `tmux_gone`, `tmux_unreachable` — **or** `schwere='rot'` on a run whose status is `failed`/`aborted` |
| **Noticed** | everything else — `rate_limit`, `provider_error`, `provider_down:<id>` |

`schwere` is a stored German value, `'gelb'` or `'rot'`. Type names carry a
suffix after a colon (`provider_down:openrouter`); the split looks only at the
head. Incident columns: `erst_gesehen`, `zuletzt_gesehen`, `anzahl`, `beleg`
(the evidence line), `geloest_am` (NULL = open), `wieder_geoeffnet`.

## Panels: the numbers the hub did NOT measure

Everything else in the sidebar is the hub's own reading. A **panel** is a number
a project pushed in — open findings by type, failing tests, whatever that
repository counts. Freilauf stores and renders it and knows nothing about what
it means, so never explain a panel's numbers: report them with their state.

```bash
fl-api /api/panels repo=3      # {panels:[{key,title,total,items,state,at,age_s,error}]}
```

`state` is the only part the row cannot say by itself:

| state | what to say |
|---|---|
| `fresh` | the number, and when it was measured (`at`) |
| `stale` | the number **plus** that it is past its own TTL — nobody has confirmed it since `at` |
| `error` | the numbers are the LAST good ones; `error` says why the latest measurement failed |

Pushing one is `bin/fl-panel` (`fl-panel set <key> --total n --item "label=count:tone"`,
or JSON on stdin). Inside a run it needs no repo — `FL_RUN_ID` says which.
The contract is `docs/panels.md` in the Freilauf checkout.

## Getting the numbers without a browser

```bash
fl-api /api/usage                          # subscription windows + balances
fl-api /api/sessions                       # memory + every tmux session
fl-api /api/runs repo=3 status=deferred    # one status of one repo
fl-api /api/runs/<uuid>                    # one run: events, incidents, liveness
fl-api /api/repos                          # repo ids, base branch, merge mode
```

`/api/runs` filters: `repo`, `status`, `agent`, `q` (title/prompt/id),
`archived` (`1` = only archived, `all` = both; default excludes archived),
`limit` (default 50, ceiling 200). It answers `{ok, count, limit, runs[]}` with
the row's stored values — `status: "waiting_help"`, never a translated word.
**`count` is the number of rows returned, not a total**: it is capped by
`limit`, so `count == limit` means "at least that many" and a real count needs
SQL.

`/api/sessions` shells out three times per call (`tmux` ×2 and one `ps`) —
ask it when you need it, never in a loop.

`/api/runs/<uuid>` adds `events[]` (payload parsed), `incidents[]` (**all** of
the run's incidents, open and resolved — filter on `geloest_am IS NULL`),
`liveness` (`verdict`: `working` | `idle_in_tui` | `process_gone` |
`no_session` | `unknown`), `worktree`, `files` (each with an `exists` flag).

`GET /api/fragments/sidebar?repo=<id>` returns the **rendered HTML** of the
sidebar, through the same function the page uses. Ask for it only when the
markup is genuinely what is wanted. A fragment with no content answers **204,
not 404** — an empty body is the correct answer, so do not treat it as an error.

## Subscription usage

`fl-api /api/usage` → `{ok, usage[], balances[]}`. Each row carries its own
`ok` flag, so a source that went silent is reported as silent rather than
dropped.

```jsonc
{ "usage": [
    { "harness": "claude", "label": "Claude Code", "ok": true,
      "data": { "kind": "claude", "plan": "max (…)",
        "five": 41.2, "resets_at": "2026-09-03T18:00:00.000Z",
        "five_at": null,                    // null = the account itself answered
        "seven": 63.0,                      // MAX of every weekly window
        "seven_general": 55.1,
        "seven_general_at": 1756900000000,  // non-null = not live, read at this ms
        "seven_fable": 63.0,
        "weekly_scoped": [ { "label": "Fable", "pct": 63.0,
                             "resets_at": "…", "stale": true, "at": 1756900000000 } ],
        "live": true } },
    { "harness": "cursor", "label": "Cursor CLI", "ok": true,
      "data": { "kind": "cursor", "plan": "pro", "spent_usd": 7.4,
        "included_usd": 20, "remaining_usd": 12.6, "pct": 37.0,
        "cycle_end": "…" } } ] }
```

*(Values above are illustrative, not this machine's.)*

**The rule that matters: `seven` is not the window that binds a run.** `seven`
is the maximum of every weekly window — the account's worst case, which is what
one dot on the rail can honestly show. Which window binds is a question about
the **run**:

- the **general** week binds every claude run;
- a **per-model** week binds only a run on that model.

`server/quota.mjs` owns that: `windowAppliesToModel(label, model)` (a naming
token of the vendor's display label occurring in the model identifier — nothing
about "Fable" is hardcoded), `weeklyWindows()`, `weeklyBinding()`,
`sevenFor(quota, model)`, `sevenForRun(run, quota)`. So a Fable week at 96 %
says nothing about a run on Sonnet. **Never answer "how much claude quota is
left" with `seven` alone — ask which model the run uses.**

`five_at` / `seven_general_at` non-null, and `stale: true` on a scoped window,
mean **the value is not the current live answer**: it is either the last live
answer the hub remembered or `~/.claude/quota.json`, whichever is newer, and
`at` is the epoch-ms it was read. The panel prints "as of …" next to it for
exactly that reason. A number that looks current and is two days old is the
failure this whole subsystem was rebuilt over — **always pass the age on**.

Depth (three sources, merge by age, the remembered-windows file, the rate-limit
backoff, and why the hub never writes `quota.json` or refreshes claude's OAuth
token): read [references/quota-windows.md](references/quota-windows.md).

## Provider balances

Normalized, because the two providers that report one disagree about
everything:

```jsonc
{ "provider": "deepseek", "label": "DeepSeek", "ok": true,
  "data": { "available": true,
            "amounts": [ { "currency": "USD", "remaining": 4.2,
                           "granted": 0, "topped_up": 4.2 },
                         { "currency": "CNY", "remaining": 0 } ] } }
```

- **One entry per currency.** DeepSeek can hold CNY and USD at once; folding
  them into one number drops a pot. OpenRouter reports a single `USD` entry and
  `available: null`.
- **`available: false` outranks the figure next to it** — the account says calls
  are blocked (promotional credit can expire while the number still looks
  healthy). `null` means the provider makes no such statement.
- **A provider with no configured credential is left out of the list
  entirely.** So `ok: false` means "configured but the endpoint did not answer",
  never "not set up". A provider no enabled coding agent may use is also absent.
- `granted` / `topped_up` are DeepSeek's split and are optional.

## Why was my run deferred?

A start that would run into an exhausted budget becomes status **`deferred`**,
not `failed`. It writes an event `deferred` with payload
`{reason, resets_at}` and sends a notification. The watcher retries every pass
(`retryDeferred()`), so **do not loop on it**. `fl-api /api/runs/<uuid>` shows
the reason: the `events[]` entry of kind `deferred`.

Which gate is asked (`budgetGate(harness, model, provider)` in
`server/scheduler.mjs`): the **coding agent's** own gate if it declares one,
else the **model provider's**, else `LEGACY_DEFAULT_GATE = 'openrouter'`. A
gate the operator switched off cannot block; a gate that throws does not block.

| gate | settings keys (defaults) | blocks when |
|---|---|---|
| claude | `claude_gate_on` (1), `claude_gate_5h` (90), `claude_gate_7d` (95), `claude_gate_fable` (null → follows `_7d`) | 5 h window ≥ `_5h`, or **a weekly window that binds this run's model** ≥ its own threshold |
| cursor | `cursor_gate_on` (1), `cursor_gate_pct` (95) | spend ÷ included amount of the running period ≥ pct |
| openrouter | `openrouter_gate_on` (1), `openrouter_min_eur` (5) | USD balance < minimum (**the key says eur and holds dollars** — renaming it would be a migration for nothing) |
| deepseek | `deepseek_gate_on` (1), `deepseek_min_usd` (2) | USD balance < minimum, **or** the account reports `is_available: false` |

No signal — no credential, no answer, no such currency — never blocks. "Not
reported" is never "zero".

**Forcing a deferred run:**

```bash
fl-api -X POST /api/runs/<uuid>/start
```

Only a `deferred` run may go (event `forced_start`, gate not asked again).
Anything else answers **400** — a `scheduled` run is waiting for its time, not
for a quota, and is started through its edit card instead.

`anomaly:quota_full` is the related flag on a **running** claude run: written
only when a window that binds *that run's model* is at 100 %, with payload
`{window, pct, resets_at}` where `window` is `'5h'`, `'7d'` or `'7d Fable'`.

## tmux memory

```bash
fl-api /api/sessions    # { ok, memory: {...}, sessions: [...] }
```

`memory` is `sessionMemory()`: `{sessions, running, rssKb, measuredAtMs,
intervalMs}`.

- It measures **every tmux session on the machine, foreign ones included** — the
  question is what the machine holds, not what this hub booked.
- `rssKb` is summed over the **whole process tree below each pane's PID**, from
  one `ps -eo pid=,ppid=,rss=,pcpu=`. The pane itself is only a shell and would
  understate it by an order of magnitude.
- **`intervalMs` is both the cache TTL and the update interval** (8 min default).
  `measuredAtMs` is when it was really taken. Quote the age.
- `sessions[]` rows (oldest first) carry `name`, `createdMs`, `activityMs`,
  `attached`, `windows`, `path`, `panes[]` (`{dead, pid, deadStatus, …}`),
  `run` (the whole run row or null), `state` (`agent_running` | `run_ended` |
  `dead` | `unknown`), `resources: {rssKb, cpu, count}`, `finishedAtMs`.

**An empty list is not proof there are no sessions.** tmux reports "no server"
and "I could not answer you" through the same exit code; `tmuxVerdict()` in
`server/sessions.mjs` splits them into `ok` / `no_server` / `unreachable`, and
the display callers deliberately render `unreachable` as an empty list. If the
answer matters (you are about to say "nothing is running"), check the pane
directly — `fl-api /api/runs/<uuid>` reports `liveness.pane_alive` as
`true`/`false`/**`null`**, and `null` means *unknown*, never *gone*.

## Cost and metrics per run

Columns on `runs` (`server/db.mjs`), all nullable:

| column | meaning |
|---|---|
| `quota5_start` / `quota5_end` | the 5-hour window at start and at end, in percent |
| `quota7_start` / `quota7_end` | the **binding** weekly window at both ends — `sevenForRun()`, so both describe *one* window |
| `cost_eur` | claude only: the subscription delta. `max(0, quota7_end − quota7_start) / 100 / 4.348 × abo_price` (setting `abo_price`, default 200), rounded to cents |
| `cost_usd` | real API spend, where the harness reports one |
| `tokens_in` / `tokens_out` | default 0 |
| `rate_limit_hits` | incremented only when a **hook** report (`_api_error`, claude/opencode) is classified as a rate limit — the log scanner never touches it |
| `last_activity_at`, `started_at`, `ended_at` | UTC text, `YYYY-MM-DD HH:MM:SS` |
| `expected_minutes` | read **live** — editing it on a running run moves the watcher's thresholds at once |

`cost_eur` is an *estimate against a subscription*, not money that moved.
`finishCostsPass()` in `server/watcher.mjs` fills both ends once, for runs in a
terminal status with `quota7_end IS NULL` — so a very short run gets its
figures on a later watcher pass, not at the moment it reported.

Cross-run questions need SQL: **[references/sql-recipes.md](references/sql-recipes.md)**
has the DB path resolution, the read-only invocation and nine verified queries
(spend per repo this week, runs per outcome, slowest runs, deferral reasons,
token hogs, open incidents by type).

## Events and anomalies

`events (id, run_id, ts, kind, payload)` — append-only, `ts` in UTC text,
`payload` a JSON string or NULL. Every status transition of a run goes through
`addEvent()`, which is also what the live SSE channel hangs on.

**An anomaly is retracted by RENAMING it**, never by deleting it:
`clearAnomalies()` does `UPDATE events SET kind = 'cleared:' || kind`. So the
history survives, `addEventOnce()` fires again on recurrence, and a query for
current anomalies must match `kind LIKE 'anomaly:%'` — which `cleared:anomaly:…`
correctly no longer does. The `notified:*` flags are deliberately *not* cleared
along with it (raising an expected duration is the one exception).

The traffic light (`ampel()` in `pages.mjs`) is where the yellow/red split is
decided:

| | |
|---|---|
| **red** | a red incident, or status `waiting_help` / `failed`, or **any** `anomaly:*` other than the four below |
| **yellow** | a yellow incident, or status `deferred`, or a non-null `finish_state`, or one of exactly four anomalies: `anomaly:no_activity`, `anomaly:soft_overrun`, `anomaly:followup_soft_overrun`, `anomaly:unpushed` |
| **green** | none of the above |

Red anomaly kinds in the tree today: `quota_full`, `overrun`,
`followup_overrun`, `session_gone`, `exit_without_report`, `worktree_dirty`.

## Freshness — every cache in one table

| what | default TTL | env var | notes |
|---|---|---|---|
| subscription usage | 60 s | `FREILAUF_USAGE_CACHE_MS` | stale-while-revalidate; keyed on the set of enabled coding agents |
| provider balances | 60 s | `FREILAUF_BALANCE_CACHE_MS` | same; keyed on the relevant provider ids |
| tmux session memory | 8 min | `FREILAUF_SESSION_MEM_CACHE_MS` | the TTL **is** the update interval; travels as `intervalMs` |
| claude live windows | 2 min | `FREILAUF_CLAUDE_USAGE_TTL_MS` | on failure: backoff 2 min doubling to 30 min (`…_BACKOFF_MS`, `…_BACKOFF_MAX_MS`), the vendor's `Retry-After` wins when longer |
| remembered claude windows | 24 h | `FREILAUF_CLAUDE_WINDOW_MEMORY_MS` | file `~/.local/share/freilauf/claude-windows.json`; a window past its own `resets_at` is forgotten |
| budget-gate meters | 2 min | — | `METER_TTL_MS` in `quota.mjs`, separate from the panel's caches |
| OpenRouter routing | 24 h | `FREILAUF_OR_ROUTING_JSON` (path) | `~/.local/share/freilauf/openrouter-routing.json` |
| sidebar re-fetch | 30 s | `window.FREILAUF_SIDEBAR_POLL_MS` | browser-side only |

**`/api/usage` does not force a refresh** — it returns the same cached,
stale-while-revalidate answer the panel shows. Nothing on a page render waits
on a vendor's server.

## Traps

- **`Number('')` is `0` and finite, and so is `Number(null)`.** An unset
  numeric setting therefore reads as a configured zero, and a window the
  account does not report (`seven_day_opus: null`) arrives as a confident 0 %.
  Check for empty/null *before* converting, and treat "missing" as "no signal",
  never as zero.
- **A fragment route answers 204, not 404,** when its content is empty. That is
  the block being absent from the page, not an error.
- **Three "empties" that are not empty:** an unanswered tmux (renders as `[]`),
  `ok: false` (configured but silent — an unconfigured source is absent from the
  array), and `count == limit` on `/api/runs` (a page, not a total).
- **`seven` / the rail's `7d` is the maximum weekly window** — never the one
  binding a particular run.
- **Never report a cached figure as current** without saying when it was
  measured — `stale`/`at`, `measuredAtMs`, `intervalMs` exist for that.

Acting on what you read — starting, retrying, killing or archiving a run — is
the `freilauf-runs` skill; picking a model that fits the quota you just measured
is `freilauf-models`.
