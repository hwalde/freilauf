# cc-hub

Web UI for managing autonomous coding agents (claude / opencode / hermes / cursor).
Agents run in tmux sessions, every run in its own git worktree. The hub schedules,
observes, collects reports and notifies via Telegram.

> **No private information in this file.** Everything machine- and operator-specific
> (real ports, VPN addresses, hostnames, firewall details, certificate paths) belongs
> in `CLAUDE.local.md` — gitignored, versioned in the private sister repo
> `cc-hub-private`. Claude Code loads both files automatically. References to
> "Planung x.y" in code comments mean the internal planning document (also in the
> sister repo, not part of this repo).

## Project language

The project language is **English**: source files, comments, documentation,
SKILL.md files and commit messages. UI strings are never hardcoded — they live in
the translation files (see below). Two custom subagents guard this
(`.claude/agents/english-enforcer.md` and `.claude/agents/i18n-checker.md`);
cursor registers them as subagents too. Legacy German identifiers still exist in
older modules and are renamed opportunistically — new code must use English
identifiers.

## AGENTS.md / CLAUDE.md convention

`AGENTS.md` is the canonical instruction file (readable by every agent CLI).
Next to **every** `AGENTS.md` sits a `CLAUDE.md` containing exactly one line —
`@AGENTS.md` — so Claude Code picks up the same content via its include
mechanism. A unit test (`test/unit.mjs`, group "Docs") enforces both the pairing
and that the CLAUDE.md contains nothing but the include.

## Multilingual UI

The web UI is multilingual: **English is the default**, German and Chinese are
selectable under Settings → UI language. All UI strings go through
`server/i18n.mjs` (`t('key')`); client-side strings reach `public/hub.js` via
the injected `window.CCHUB_I18N` catalog.

- Language files: **`lang/en.json`** (reference), **`lang/de.json`**,
  **`lang/zh.json`** — flat `key → string` maps with `{placeholder}`
  interpolation.
- **They must be maintained together**: every key added to `en.json` needs a
  translation in `de.json` and `zh.json`. A unit test enforces identical key
  sets and non-empty values.
- A missing key falls back to English; an unknown key renders as the key itself
  (never crash a page over a string).

## Architecture

```
Browser --https--> <wg-IP>:8790 --http--> 127.0.0.1:8791 --> tmux sessions
(via WireGuard)    vpn-proxy.mjs           server/hub.mjs      cc-<name>-<id>
                   cchub-vpn.service       cchub.service       cc-oc-/he-/cu-…

(8790/8791 are the code defaults; the real values come from ~/.config/cc-hub/env.)
```

- **`server/hub.mjs`** binds firmly to `127.0.0.1` — never directly reachable from
  the network. HTTP + WebSocket terminal + scheduler + watcher run in this one process.
- **`vpn-proxy.mjs`** binds exclusively to the WireGuard address. If the firewall
  fails, nothing listens to the outside anyway. Host allowlist + origin check are the
  rebinding/CSRF fence (`CCHUB_ALLOWED_HOSTS` in `~/.config/cc-hub/env`).
- **systemd user units**: `cchub.service` starts automatically, `cchub-vpn.service`
  deliberately does **not** (fail-closed). Control: `cchub on|off|status|logs`.
- **Runs** are created exclusively via `bin/cc-start` (installed to
  `~/.local/bin`); agents report back via `bin/cc-report` (HTTP to the hub,
  fallback `inbox.jsonl`). All `cc-*` scripts are part of this repo (`bin/`),
  installed by `setup/02-install-scripts.sh`.
- State: SQLite at `~/.local/share/cc-hub/cc-hub.db`, run data in `~/agents/runs`,
  worktrees in `~/agents/worktrees`. All paths can be redirected via `CCHUB_*`
  variables — exactly that is what the test suite lives on.

## The run definition: agent and single run are the same thing

An agent and a single run differ in exactly **two** things: an agent has a name
and a schedule and can be started again. Everything else — coding agent,
provider, model, effort, prompt, branch rule, expected duration, extra skills,
attached flows —
is one and the same **run definition**, and it lives in **`server/run-def.mjs`**:

| What | Function | Used by |
|---|---|---|
| Form block (HTML) | `runDefFields(values)` | agent form + single-run form |
| Form → definition, incl. all validation | `runDefFromForm(body, problems)` | both forms + `POST /api/runs` |
| Agent row → definition | `defFromAgent(row)` | scheduler, "start now", flows |
| Write an agent (INSERT/UPDATE) | `saveAgent(...)` | agent form + "save as agent" |
| Field list for the flow designer | `RUN_DEF_FLOW_FIELDS`, `defFromFlowProps` | `flows/steps.mjs` |
| Last used setup, **per coding agent** | `rememberRunChoice`, `lastRunChoice`, `lastRunChoiceFor` | both forms (preselection, and the reset on switching the coding agent) |
| Title + start time (single run only) | `runTitleField`, `runStartTimeFields`, `runStartFromForm` | single-run form + `POST /api/runs` |

And there is exactly **one** way from a definition to a running run:
**`startRun(def, { repoId, agentId, promptExtra, title, startMode, startAt })`**
in `server/scheduler.mjs` — including the budget gate (`budgetGate(harness)`,
also used by the watcher when picking a deferred run back up).
`startForAgent(agent)` is only its wrapper for a stored definition.

A new field of a run therefore needs **one** change in `run-def.mjs`, not four.
Before that, the copies had already drifted: the single-run form dropped the
branch mode it had been prefilled with, `POST /api/runs` saved an agent without
provider/effort/skills, only the agent form checked the branch rule, and only
the agent path knew the budget gate — a single run started into an exhausted
quota and died at the first API call instead of being deferred.

New forms/steps that start a run go through these functions. What is
deliberately **not** part of the definition: the repo (it is the context, and
the switcher in the header sets it), the name and the schedule (they make an
agent an agent).

### Every run has a title

An agent run is recognizable by its agent — a single run is not: it is not
stored anywhere, it only exists as a prompt. So `runs.title` carries a name for
**every** run:

1. what was typed into the single-run form's title field, otherwise
2. the agent's name, otherwise
3. the first meaningful line of the prompt (`fallbackTitle`) — and in the
   background a cheap model at OpenRouter replaces it with a real one.

The generated title **never** holds a start up: the run carries the fallback
from the first moment and `applyGeneratedTitle()` writes over it afterwards —
and only if it is still the fallback, so a rename by hand always wins over the
model. Everything about this is fail-soft (`server/title.mjs`), the exact
opposite of the check LLM: without a key, switched off or on any error the run
simply keeps the fallback. Model and on/off live under **Settings → Run
titles** (`llm_title_model`, default `deepseek/deepseek-v4-flash`, ~$0.05 per
million input tokens — a title costs a fraction of a cent).

Every run can be **renamed inline** in the overview and on its detail page
(`POST /api/runs/<id>/title`, pencil next to the title). That touches only the
run: the agent keeps its name, and its next run is called by it again. An
emptied title falls back to the agent's name.

### A single run may also start later

The single-run form carries what an agent's schedule carries — minus the
repetition, because a single run happens once. Three ways to wait, all ending
in status `scheduled` (which the CHECK rule always knew and nothing ever used):

| Kind | Stored | Started by |
|---|---|---|
| at a date and time | `start_mode='at'`, `start_at` (UTC) | `pickUpScheduled()` once the moment has passed — a missed one is caught up, like an agent's one-off schedule |
| in n minutes | the same, resolved in the form | as above |
| when no other run of this repo is going | `start_mode='idle'` | `pickUpScheduled()` as soon as the repo is free |

`pickUpScheduled()` (scheduler.mjs) runs in the **watcher** pass, not in the
scheduler tick: the pipeline switch gates the scheduled AGENT starts, and a
single run sent off by hand is not one of those — same rule as the "start now"
button. Per repo and pass exactly **one** run starts, because after the first
one the repo is not free any more. The budget gate applies as at any other
start; blocked means `deferred`, not lost. Waiting runs stand at the top of the
overview next to the deferred ones and can be cancelled on their detail page.

## Plugin architecture: coding agents and providers

Coding agents (harnesses) and model providers are **plugins** — one file each
under `server/harnesses/` and `server/providers/`, registered in the respective
`index.mjs`. Everything harness-specific (capabilities, log error patterns, CLI
argument building, effort handling, subscription usage, install detection) lives
in the plugin file; the rest of the code consults the registries.

**Full contract and how to add a new coding agent or provider:
[docs/plugins.md](docs/plugins.md).**

### Configured coding agents

The plugins describe what the hub *could* drive; what it *may* drive is
configured under **Settings → Coding agents** (table `coding_agents`): per
coding agent an enabled flag and the selection of allowed providers. Forms only
offer configured & enabled coding agents; a fresh installation has none and
shows a banner on every page. `server/coding-agents.mjs` holds the logic,
including the optional seed: on first start with an empty table the hub imports
`~/.config/cc-hub/coding-agents.json` (override: `CCHUB_AGENTS_SEED`) — the
private setup repo installs that file.

### Subscription usage

Harness plugins may implement `usage()`; `server/usage.mjs` aggregates and
caches the results for the overview panel and `GET /api/usage`. Claude reads
`~/.claude/quota.json`, cursor asks the Cursor API with the CLI's own token
(`~/.config/cursor/auth.json`): `GetCurrentPeriodUsage` reports spend, the
included amount and the cycle end of the running period in cents — the bar
therefore measures against the amount the account really has, on every plan.
Cursor documents that amount nowhere and its public APIs are admin-only, so this
internal dashboard endpoint is the only source; it has no contract. When it
stays silent the configurable `cursor_included_usd` setting (default 20) steps
in as a fallback and the UI marks the value as estimated.

## Tests

```bash
node test/unit.mjs          # pure logic (cron, schedules, quota gate, parsers, registries, i18n, docs) — ~1 s
node test/e2e.mjs           # complete hub in a sandbox, stub instead of real agents — ~30 s
node test/e2e.mjs --echt    # additionally ONE real run per harness (consumes quota)
node test/e2e.mjs --keep    # keep the sandbox (debugging)
```

The e2e suite starts a **second hub** on a free port with its own database, its
own test repo and its own `cc-start` stub. It may therefore run at any time
alongside production: the production database, `~/agents` and foreign tmux
sessions are never touched, and only sessions the suite created itself are
killed (also on Ctrl-C). Watcher passes are triggered directly instead of
waiting for the 30-second interval.

## Models, providers and reasoning effort

None of this is typed into the code — everything comes from its authoritative
source:

| What | From | Why not otherwise |
|---|---|---|
| Providers per harness | harness plugin (`providers`, `keyFreeProviders`) ∩ operator selection | claude runs only on the subscription; hermes needs a key for Zen/DeepSeek, opencode does not |
| Models for opencode | `opencode models --pure` | opencode's provider list is credential-gated; the vendor catalog contains models that would fail here immediately |
| Models for hermes | vendor API or `models.dev` | hermes has no own list |
| Models for claude | maintained list in `server/harnesses/claude.mjs` | without an API key there is no catalog; free input always stays possible |
| Models for cursor | `cursor-agent models` | account-bound (comes from the server); the CLI names the same list when rejecting |
| Effort claude | `claude --effort __probe__` — the CLI names its levels itself | no settings key, no reliable env variable |
| Effort hermes | `hermes chat --help` ∩ model levels | hermes does NOT validate and silently runs with the default on nonsense |
| Effort opencode | model catalog (`~/.cache/opencode/models.json`) | opencode discards an unknown variant **silently** |
| Effort cursor | is part **of the model ID** (`…-low/-medium/-high/-xhigh/-max`) | cursor-agent has no `--effort`; the field stays out of the form |

Pass-through: claude `--effort`, hermes `--reasoning` (cc-start translates),
opencode via `OPENCODE_CONFIG_CONTENT` with `agent.build.{model,variant}` — the
variant only works when the model is set in the same block. Verification:
`~/.local/state/opencode/model.json` records the last used variant per model.
cursor gets **only** `--model` with an ID that `cursor-agent models` printed
verbatim — nothing is assembled there.

### cursor in particular

The ~200 flat IDs are base × effort level × fast, already multiplied out. That is
why the hub does **not** split into base + effort: an ID built that way might
not exist at all, and `<datalist>` filters them just as well as the ~360 from
OpenRouter. IDs ending in `-fast` are cursor's fast mode (more expensive) — they
sort last and are marked; the default is the variant without. `auto` is part of
the same list and hence a valid `--model` value: cursor then routes to its own
models (composer/vega/grok), which draw on the Cursor-models pool of the
included usage rather than the third-party one. It sorts first and is marked.

**cursor reads the Claude configuration along** — measured with canary code
words in an empty repo, all three confirmed:

| Source | Result |
|---|---|
| `CLAUDE.md` / `CLAUDE.local.md` / `AGENTS.md` | loaded as a rules file |
| `.claude/skills/*/SKILL.md` | loaded as a skill |
| `.claude/agents/*.md` | registered as a subagent (real `tool_call`, not file reading) |

In the binary this hangs on `thirdPartyExtensibilityEnabled` (default **on**);
also read are `.claude/settings.json`, `.claude/settings.local.json`,
`.claude/commands` and Claude **hooks**. There is **no** local switch for it —
`allow_third_party_plugin_imports` is a server-side team/enterprise field.

Consequence for cc-hub: a cursor run pulls in `~/.claude/skills` and the
worktree's `CLAUDE.md` **automatically**. The opt-in idea behind
`~/agents/zusaetze/` (deliberately no `.claude/skills` folder) therefore only
half applies to cursor — the run sees more than its prompt plus the checked
extras.

## No-code flows

`server/flows/` — a self-contained module (own tables, pages, API, designer
client) that reacts to finished runs, a cron schedule or a button with
building blocks: message running agents, start agents/single runs (optionally
waiting for their result), extract structured data from a report via LLM,
branch on the outcome, loop over a list, Telegram, HTTP, delay.

**A flow is not a place you navigate to** — there is no "Flows" nav entry. A
flow hangs on the agent or the single run whose end starts it: both forms carry
the attachment block (`flowAttachFields` in `flows/attach.mjs`, embedded by
`runDefFields` like the extra skills), and the flow pages are reached from
there and from the button on the agents page. When a run ends, **every**
attached flow starts — all of them in parallel, the way a no-code platform fans
a trigger out.

The attachment carries the condition (`always`, only on `done`/`failed`/
`aborted`, or `not_done`), so the case distinction is made where one thinks of
it. It does **not** replace `switch_outcome`: that block branches on the result
of a run the flow started **itself**, which no attachment can know about.

Agent side and flow side cannot drift because there is only **one** storage:
`agents.flows` (snapshotted into `runs.flows` when the run is created, like
every other definition field). The agent form writes it, the flow editor's
trigger panel writes the same rows from the other side (`agentsWithFlow`,
`setFlowAttachments`), and the `run_finished` trigger itself carries no filter
at all any more — a filter next to the attachment would be a second copy of the
same statement. Older triggers (`agentIds`/`repoId`/`outcomes`/`singleRuns`)
are converted into attachments once, at startup, in `flows/db.mjs`.

Variables are **typed**, not guessed: `varschema.mjs` knows for every spot in a
flow which variables exist there, of which type and with which allowed values —
so a condition picks its left side from a list, its operator is narrowed to what
that type can answer, and a boolean or an enum is chosen instead of typed. The
same module runs in the browser (served under `/static/flows/`), so the designer
and the server judge a flow by identical code. It also carries the placement
rules: `switch_outcome` needs a finished run, and the designer refuses the drop
with the reason instead of silently not sticking.

Architecture, step registry contract and the integration seams:
**[server/flows/AGENTS.md](server/flows/AGENTS.md)**.

## Extra skills (opt-in)

`~/agents/zusaetze/<name>/SKILL.md` — **deliberately not** a `.claude/skills`
folder, otherwise every claude instance would load them automatically. Every
folder with a SKILL.md appears as a checkbox in the agent and single-run forms
(`zusaetze.mjs`); when selected, the prompt gets the instruction to read and
apply the SKILL.md (full path). Installed commit-pinned via
`setup/02-install-scripts.sh` (currently: `unlazy` for lazy/small models), not
part of this repo. Path override for tests: `CCHUB_ZUSAETZE_DIR`.

## Incidents (rate limit, provider outage)

On a rate limit or provider outage the agent cannot report anything — without an
API there is no tool call. Detection therefore runs from the outside, in three
stages, all ending in `incidents` (one record per run and type; resolve via
button, **reopens** on recurrence and notifies via Telegram again — auto-alarm
principle):

| Source | Harness | Immediately red? |
|---|---|---|
| Hook `StopFailure` → `cc-report _api_error` | claude | yes (fixed enum) |
| Transcript JSONL `isApiErrorMessage` + `error` | claude | yes (second channel, with timestamp) |
| Plugin `session.error` → `cc-report _api_error` | opencode | yes |
| pipe-pane log, patterns per harness (plugin `logPatterns`, orchestrated in `detect.mjs`) | all; for hermes and cursor the **only** source | no: yellow; red on repetition within 10 min or 5 min of silence — or when the optional check LLM (settings, OpenRouter) confirms it |
| Provider pulse (plugin pulse targets, every 5 min) | global | after 2 failures, closes on recovery |

**A working agent is never escalated.** `bewerteLogTreffer()` starts with a veto:
measurable work *after* the last hit means the agent is demonstrably not blocked
by an API error, so the hit was text on its screen — and neither repetition nor
silence may promote it to red. Applying the module's own principle ("a real limit
stands at the end") to only one of the two paths was the hole: an agent scrolling
through source code about API errors produced five hits in two minutes and turned
its own run red. The veto costs nothing where it matters — cursor and hermes,
the two harnesses for which the log is the *only* source, have no activity
measurement, so it never applies to them; claude and opencode, where it does,
each have a hook and a transcript/plugin channel that reports a real error red
immediately anyway.

**Silence is only an argument where activity is measured.** `measureActivity()`
has a source for claude (transcript mtime) and opencode (session store); for
cursor and hermes it has none and returns nothing. `bewerteLogTreffer()`
therefore reads `letzteAktivitaetMs === null` as *unknown*, never as *silent* —
otherwise every yellow log hit on exactly those two harnesses turned red five
minutes later while the agent was happily working. There, repetition and the
check LLM are the escalation paths; a hit that has not recurred within 30 min
expires by itself.

### Does it need a human? (`brauchtMensch`)

Severity says how sure the detector is. It does **not** say whether anything is
left to do — and that was the question the single "resolve" button could not
answer. `incidents.mjs` splits it:

| Group | What | Button |
|---|---|---|
| **Needs you** | `auth_error`, `billing_error`, `model_error` — always. A token, a credit balance or a wrong model ID does not get better by waiting; every following run walks into the same wall. Plus a **red** incident on a run with status `failed`/`aborted`: that is the reason it did not come through. | "Mark as handled" |
| **Noticed** | everything else — rate limit, provider hiccup, global pulse. The hub deferred, retried, or the run simply carried on. | "Dismiss" |

Neither button changes anything about the run; both only silence the entry here
and on Telegram, and a recurrence reopens it. What the watcher adds: incidents in
the "noticed" group **close by themselves** when the run reaches `done` — a run
that came through has already answered what the hiccup during it meant. The
Telegram message states the group in its second line, so the reader can tell a
"get up" from a "noted" without opening the hub.

cursor, like hermes, has **no** hook for API errors (its hook enum knows
`beforeShellExecution`, `afterFileEdit`, `stop`, `beforeSubmitPrompt` — nothing
for a failed call), and there is no open pulse endpoint for `api2.cursor.sh`:
`providerVonLauf()` deliberately returns `null` there ("not monitored", not
"healthy"). In return cursor rejects an unknown model **loudly** (`Cannot use
this model: …`) — unlike opencode and hermes, which swallow nonsense silently.

Log and transcript are read by **offset** (`runs.log_offset` /
`transcript_offset`): only new bytes, every line counts once. Every decision is
recorded in `~/agents/runs/<id>/detektor.jsonl`. hermes has **no** hook for API
errors (`post_api_request` only fires after success).

## Pitfalls that already cost time here

- **A branch belongs to exactly one worktree.** Branch expectation "fixed" with
  the base branch (`main`) — which the main checkout itself holds — can never
  work: `git worktree add` refuses it. The hub therefore checks beforehand
  (`branchWorktree()` in `runner.mjs`): `runDefFromForm()` blocks it for every
  form path, so no run is even created, and a start that gets there anyway
  (an agent whose branch was taken afterwards) fails with a readable sentence
  instead of git's "'main' is already used by worktree at …". `--force` would push it
  through, but the main checkout would then carry the agent's commits as
  reverse-modifications in its working tree — never do that.
- **tmux targets need the colon.** `-t "=name"` is no valid target for
  `pipe-pane` and `set-hook` ("can't find pane" / "no such window"); correct is
  `-t "=name:"`. And `tmux display -p -t "=name"` returns exit code 0 for a
  **non-existing** session — whoever checks "session gone?" with it checks
  nothing. That is what `tmux has-session` is for.
- **The terminal is fail-closed, twice.** `/term` only enables write access on an
  explicit `?ro=0` (`terminal.mjs`); without the parameter tmux attaches with
  `-r` AND every input is discarded. The client sets `ro=0` from `data-live` in
  `pages.mjs`. Touching only one of the two sides yields a terminal that
  silently does nothing — exactly how it sat for a long time, because `ro=0`
  appeared nowhere.
- **`tmux attach -r` is only the shorthand for `-f read-only,ignore-size`.** And
  `ignore-size` is useless while `window-size` is `latest` (default): the
  browser rewraps the agent's window to its size while watching — with and
  without write access alike. The remedy would be `window-size manual` on the
  session.
- **`cc-start` positional arguments.** `cc-start [name] [directory]`; when the
  name is set via `--name` (that is how the hub calls it), the directory moves
  to position 1. Otherwise the agent starts in the CALLER's working directory
  instead of the worktree.
- **Claude hook format.** Every event is a list of
  `{ matcher?, hooks: [{ type, command }] }`. A bare command list makes Claude
  discard the settings file **completely** and the run hangs at a dialog.
- **`StopFailure` exists — but Claude does not wait for it.** (Claude Code
  2.1.241; the enum is in the binary: `rate_limit`, `overloaded`, `server_error`,
  `authentication_failed`, `billing_error`, `model_not_found`, …) The process is
  gone within 100 ms after the event and tears the hook down; `SessionEnd` on
  the other hand is awaited. The hook must therefore detach immediately:
  `setsid -f cc-report _api_error` — the child inherits the stdin pipe with the
  JSON. Simulating without quota: a mini HTTP server answering 429 with
  `anthropic-ratelimit-unified-status: rejected`, and `ANTHROPIC_BASE_URL`
  pointed at it (that is how `test/e2e.mjs` does it).
- **Worktree extras with `mode: "link"`** create a symlink. A `.gitignore` rule
  with a slash (`referenz/`) does **not** match it — the worktree then counts as
  dirty forever and is never cleaned up. Write the rule without the slash.
- **The log scanner hits menu text.** "Upgrade to Max for higher rate limits"
  from the `/` menu once sat in the DB as a rate limit on a production run.
  Patterns in the harness plugins are therefore narrow, there is an exception
  list, and a single log hit is only yellow.
- **`opencode --prompt` stops sending the prompt off when it gets long.** The
  text lands in the TUI's editor either way, but only a short one is submitted
  by itself — measured with opencode 1.18.23: ~2 KB goes, ~20 KB stays put. A
  real hub prompt (task + platform rules + extra skills) is past that, and the
  failure is silent in every direction: tmux session alive, no line in the log,
  the run simply never starts working. `cc-start` therefore presses Enter once
  from the launcher after the TUI has drawn (it waits for the status bar, not
  for a fixed number of seconds). Enter on an empty editor is a no-op in
  opencode — measured — so the case that submitted by itself is not harmed.
- **`\b5\d\d\b` is not an HTTP status.** cursor's own status line
  `⠠⠛ Globbing  555 tokens` opened a "Provider error" incident, because the
  pattern matches a token count just as happily as a 503. A status code counts
  only next to an error word (`HTTP_5XX` in `harnesses/patterns.mjs`, shared by
  cursor/hermes/opencode and `typVonText`).
- **An agent working on cc-hub reads its own alarm texts into the log.** One
  cursor run produced three incidents in seven minutes, all from its own screen:
  the token count above, the hub's section heading `Incidents: rate limit and
  provider errors (auto-alarm)`, and the e2e suite's success line
  `✓ cursor: … and "Cannot use this model" is detected`. The exception for "work
  on exactly this code" existed but was **case-sensitive** (`incidents` vs.
  `Incidents:`). The exception list is `i`-flagged now and additionally skips
  test-runner tick lines and "… is detected"/"is reported" phrasings.
- **And the exception list alone will never be enough.** The very next run — the
  claude run *fixing* the above — went red from two lines of the test file it had
  just written (`scanneZeilen('cursor', ['API Error: 503', …])`), five hits in
  two minutes via the repetition path. Two answers, and the second one is the
  load-bearing one: a call with a quoted argument list is source code, not
  output (no harness prints that shape); and above all, **work after the hit
  vetoes escalation** (see above) — patterns can always be tricked, a run that
  keeps producing output cannot.
- **`cursor-agent -p` is wrong for a run.** `-p/--print` prints and exits — the
  tmux session would be gone immediately. The prompt belongs as a **positional
  argument** after `--` (`cursor-agent --force --trust -- "$CC_PROMPT"`); the
  TUI then works through the task and stays up afterwards, like opencode.
- **Without `--trust` cursor hangs at the dialog** "Do you trust the contents of
  this directory?" — the session lives but does nothing. Same pattern as
  Claude's trust flag, only as a command-line switch instead of an entry in
  `~/.claude.json`.
- **Cursor's bracket syntax is model-dependent and unusable as a foundation.**
  `grok-4.6[effort=high,fast=false]` works, but
  `claude-opus-4-8[context=1m,effort=high,fast=false]` — the example from
  cursor's **own** help — is rejected. Only a flat ID from `cursor-agent models`
  is reliable.
- **`agents.harness` carries a CHECK, `runs.harness` does not.** SQLite cannot
  alter a CHECK, and `CREATE TABLE IF NOT EXISTS` does not apply to an existing
  database — a new harness therefore needs the table rebuild in
  `harnessCheckErweitern()` (db.mjs). It takes the table header from
  `sqlite_master`, keeps the CHECK in sync with the plugin registry and only
  replaces that one spot, so retrofitted columns, defaults and the UNIQUE
  reliably survive.
- **A green test only proves the path the test took.** `curl` against the VPN IP
  from the server itself runs over `lo` and says nothing about the firewall;
  check real reachability only from a VPN client.
