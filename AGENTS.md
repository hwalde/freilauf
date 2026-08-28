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
| Its second prompt, for the harnesses that know one | `goalFields` | both forms (see below) |
| Its setup half, on its own | `runSetupFields`, `branchFields` | favorite form, Quick-Run dialog |
| What each branch rule MEANS — label, explanation, agent sentence | `BRANCH_MODE_INFO`, `branchRuleText`, `branchContext` | `branchFields` + `launchRun` (see below) |
| Form → definition, incl. all validation | `runDefFromForm(body, problems)` | both forms + `POST /api/runs` |
| Its setup half, on its own | `runSetupFromForm(body, problems)` | favorites (see below) |
| Agent row → definition | `defFromAgent(row)` | scheduler, "start now", flows |
| Write an agent (INSERT/UPDATE) | `saveAgent(...)` | agent form + "save as agent" |
| Field list for the flow designer | `RUN_DEF_FLOW_FIELDS`, `defFromFlowProps` | `flows/steps.mjs` |
| Last used setup, **per coding agent** | `rememberRunChoice`, `lastRunChoice`, `lastRunChoiceFor` | both forms (preselection, and the reset on switching the coding agent) |
| Title + start time (single run only) | `runTitleField`, `runStartTimeFields`, `runStartFromForm` | single-run form + `POST /api/runs` |

### Agent lifecycle: delete, move, per-repo names

An agent lives in exactly one repo, and its **name is unique per repo** —
two repos may each carry an agent called "nightly". The agents table enforces
`UNIQUE(repo_id, name)`; databases from before the change are rebuilt once at
startup (`agentNameUniquePerRepo()` in db.mjs). The form reports a duplicate
inside one repo as a readable problem (`agents.name_taken`), never a 500.

Three lifecycle operations, all in `server/run-def.mjs` next to `saveAgent`:

| Operation | Function | Notes |
|---|---|---|
| Delete | `deleteAgent(id)` | NULLs `runs.agent_id` first, then drops the row — the runs survive with their definition copy and title snapshot (`POST /agents/delete`) |
| Move | `moveAgent(id, repoId)` | `UPDATE agents SET repo_id, name`; a name collision in the target repo appends a `YYYYMMDD-HHMMSS` suffix (`POST /agents/move`, page `GET /agents/move`) |
| Name free? | `agentNameTaken(repoId, name, excludeId)` | mirrors the UNIQUE constraint for validation |

And there is exactly **one** way from a definition to a running run:
**`startRun(def, { repoId, agentId, promptExtra, title, startMode, startAt })`**
in `server/scheduler.mjs` — including the budget gate (`budgetGate(harness)`,
also used by the watcher when picking a deferred run back up).
`startForAgent(agent)` is only its wrapper for a stored definition.

`keep_on_branch` (0/1) is the newest field and went exactly that way: the form
block, `runDefFromForm`, `defFromAgent`, `saveAgent`, `createRun`,
`RUN_DEF_FLOW_FIELDS`/`defFromFlowProps`, two columns — and
`pickQuickFields`'s allowlist in web.mjs, which is the one place a field can
fall off silently because it is an allowlist and not a spread. It is
deliberately NOT part of `rememberRunChoice`: it belongs to the task, not to the
setup.

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

The repo is not just the path — under **Repos** each repo can carry its own
**repo prompt** (`repos.prompt`): instructions that are added to **every** run
of that repo, agents and single runs alike. Like `base_branch` and
`worktree_extras` it is read live at launch (`repoPromptZusatz()` in
runner.mjs composes it as a labeled section into `prompt.md`) — repo config is
not snapshotted into the run, so editing it affects the next run, never a
running or finished one.

### The goal: the second prompt, and the only one that is typed in

The prompt says what to do. A **goal** says when it is **done**: claude's
`/goal <condition>` sets a completion condition, has a small model check it
after every turn, and while it does not hold claude takes another turn by
itself — until it holds, until claude judges it impossible, or until someone
clears it. So it belongs in the run definition (`agents.goal`, snapshotted into
`runs.goal`), under the prompt, folded away, and only in the two forms that
describe a run: the agent form and the single-run form. Deliberately **not** in
Quick Run — that dialog asks for the task and the time, and a favorite carries
no task.

It is the one definition field that never reaches the agent through
`prompt.md`, because **there is no CLI flag for it**. The command exists only
inside the session, so the hub types it in **after** the start —
`server/goal.mjs`, one delivery function and two ways into it:

| Way in | When | Why both |
|---|---|---|
| `launchRun()` | right after the session stands, not awaited | it waits for the TUI to draw, and a start must not hang on that |
| watcher pass | every run that still owes its session a goal | a hub restarted between the start and the delivery, a session that had not drawn yet, a run that was answering a help call |

`runs.goal_sent_at` is what keeps the two from typing it in twice, and what
lets the detail page answer "did the goal ever arrive?". Only from status
`running`: `waiting_help` means the agent asked a question and is waiting, so a
goal typed in there would **be** the answer. A retry clears the mark — a retry
is a new session, and a `/goal` typed into the old one went with it.

**Who knows a goal is the plugin's answer, not the form's** (`goal` in the
harness plugin, see [docs/plugins.md](docs/plugins.md)). The form block writes
that list into `data-goal-harnesses`, hub.js shows or hides the block on it —
and hiding **disables** the field, because a hidden field that still submits is
a text one can neither see nor correct: switching the coding agent would
otherwise send along a condition meant for claude. What was typed stays in the
DOM, so switching back and forth does not cost it.

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

### Runs can be archived

`runs.archived_at` (NULL = visible) moves a finished run out of the overview —
the record, report, log and incidents stay intact and the detail page keeps
working. Only terminal statuses may go (`done`/`failed`/`aborted`): a running
one is still being watched and a deferred/scheduled one would start later
anyway, so archiving it would hide work that is not over. One click per row in
the overview (`POST /api/runs/<id>/archive`) or on the detail page; the
**Archive** page (`/archive`, per repo like the overview) lists them
newest-archived first with pagination (50 per page,
`CCHUB_ARCHIVE_PAGE_SIZE`) and a restore button
(`POST /api/runs/<id>/unarchive`). Nothing else in the code filters on
`archived_at` — the watcher, the flows and the incidents keep their view of a
run whether it is archived or not.

### Favorites and Quick Run: the setup without the task

Picking a coding agent, a provider, a model out of ~200 slugs and an effort level
is the half of starting a run that is the same every time and says nothing about
the task. A **favorite** (`server/favorites.mjs`, table `favorites`, Settings →
Favorites) is exactly that half under a name: harness, provider, model, serving
provider, effort — plus the two opt-ins that behave like a setting rather than
like a task, the **extra skills including their dial** and the **attached
flows**. Deliberately not part of it: prompt, branch rule, expected duration,
start time. Room for `FAVORITES_MAX` of them (3, `CCHUB_FAVORITES_MAX`), because
a shortcut one has to read is not one.

The **Quick Run** button sits in the header of *every* page and opens a dialog
asking for what a favorite does not carry: the task and the start time, both
open, and — folded away — the branch rule. When a run happens is decided in the
same breath as what it does, so that block stands next to the task rather than
behind a click; the branch rule is the one of the three usually left as it
is. It does **not** navigate: `POST
/api/runs/quick` answers JSON, the page stays where it was and a toast says
whether the run started, was planned or was deferred, with a link to it. Being
torn to a detail page is what would make a quick start not quick.

The one exit that does lead away is **More settings**: the moment one wants more
than the dialog asks, the run stops being quick. It opens the FULL single-run
form in a new window (`/runs/new?repo=…&favorite=…`): the favorite becomes the
form's template (`favoriteTemplate()` in favorites.mjs, the counterpart of
`favoriteToFormBody()`), and hub.js parks the task, the branch rule and the
start time in `sessionStorage` (key `cchub:qrfull`) — a window opened by the
opener inherits a copy, and the form page restores the fields onto the MAIN
form before its start-time and branch syncs run. What the dialog does not ask
for stays as the favorite's template rendered it; there is still no second
definition builder involved.

There is **no second definition builder** behind any of this, which is the whole
reason a favorite stores only the setup half:

| Direction | Function | Ends in |
|---|---|---|
| form → favorite | `favoriteFromForm()` → `runSetupFromForm()` | the same validation the run form applies |
| favorite → form | `favoriteToFormBody()` | `runDefFromForm()` — the ordinary start path |

`runSetupFromForm()` is `runDefFromForm()`'s own first half (harness enabled,
provider possible for this harness, effort really accepted), and
`runSetupFields()` / `branchFields()` are the form blocks both run forms already
use. So what is saved under a name cannot come to mean something else than what
the run form would have made of the same inputs — the drift `run-def.mjs` exists
to prevent, one field further out.

The Quick-Run endpoint takes exactly four fields from the request
(`pickQuickFields`: repo, prompt, branch mode, branch pattern) and lets the
favorite fill in the rest. An allowlist and not a spread: otherwise a request
could quietly replace the favorite's coding agent, model or skills and start
something other than the name on the button promised. The e2e suite asserts
precisely that.

Two page-level consequences worth knowing: the dialog lives in `layout()`, so
the single-run form now carries the planned-start block **twice** — hence
`data-start-switch` instead of an id, scoped per fieldset. And favorites are
edited on a page of their own rather than three side by side, because the
provider/model/effort block is driven through `#prov`, `#model` and `#effort`,
and three of those would be three elements sharing one id.

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

### Provider balances

The sibling of the above, and the reason it exists: `openrouterCredits()` used
to sit in `quota.mjs` with one vendor's URL, auth header and response shape
hard-coded into it — exactly the provider-specific knowledge `docs/plugins.md`
says belongs in a plugin. It is a **`balance()` contract** on the provider
plugin now, aggregated by `server/balances.mjs`.

The shape is **normalized rather than passed through**, because the two
providers that implement it disagree on almost everything: OpenRouter keeps one
pot, reports it as numbers and says nothing about whether calls still go
through; DeepSeek reports **strings**, **one entry per currency** (an account
can hold CNY and USD at once) and adds `is_available`, which nobody else has.
Folding those into a single number would silently drop one of the two pots. The
full contract and its four rules are in `docs/plugins.md`.

Two consequences worth knowing. The panel printed `{eur} €` for a dollar figure
until the currency became part of the answer; the setting behind the gate is
still called `openrouter_min_eur`, because renaming a stored key would need a
migration for nothing. And **the budget gate does NOT go through the
aggregator** — `balances.mjs` reaches the database via `coding-agents.mjs`, and
`db.mjs` imports the harness registry, which imports `quota.mjs`. The gate needs
one number from one plugin, so it asks that plugin directly.

**Both caches are keyed on the configuration, not only on time**
(`usage.mjs`, `balances.mjs`): the set of enabled coding agents decides who is
asked at all, so changing it does not make the answer old, it makes it about
something else. And the in-flight flag is released by the promise, never at the
end of the body — with nothing configured the loop has no `await`, so the body
ran to completion (flag reset included) *before* the assignment that set the
flag, and every later call got that one stale promise for the life of the
process. Both only became visible when the status sidebar started asking on
every page, the first of which happens before anything is configured.

## The live channel: a run announces itself

The hub rendered a whole page and then never spoke again. A title generated
after the fact only appeared on the next reload, a run that ended left the
overview showing work that was over, and killing a run needed
`location.reload()` to make the page agree with reality.

**`server/events.mjs`** is the channel that fixes that: an event bus and one SSE
endpoint, `GET /api/events[?repo=<id>]`. It can be this small because HTTP,
scheduler and watcher share **one process** (`hub.mjs`) — whoever changes a run
is in the same memory as whoever holds the browser connection, so a publish is a
function call. No broker, no second port. It imports nothing at all, which is
what lets `db.mjs` import *it* without a cycle.

### It hangs on `addEvent()`, and that was measured

There are **39 `UPDATE runs SET` sites in 10 files**. Publishing from each of
them is the drift `run-def.mjs` exists to prevent, so the channel hangs on the
one place a run's transitions already pass through — `addEvent()` in `db.mjs`.

That this holds was **measured, not assumed**: of the 18 places that write
`status=`, 13 already added an event. The five that did not — ending a run by
hand, answering a help call, retrying, and the two flow equivalents — were a gap
in the run's own event list, not just in the channel. "Why did this run stop?"
had no answer on its own detail page. They write one now (`message_sent`,
`help_answered`, `aborted {by}`, `retry`).

Three changes are visible without writing an event — the generated title,
archiving and unarchiving — and those call `announceRun()` explicitly.

### The event carries a signal, never markup

The browser answers an event by **fetching a fragment** (`/api/fragments/…`),
which the server renders through the same function the full page uses. So a row
keeps exactly ONE renderer, and translations, traffic-light rules and
conditional cells cannot drift between the page and its updates. The event's
`status` field is a **hint**, not the truth: some call sites run `addEvent`
before the `UPDATE` and some after, which is harmless precisely because nobody
renders from it.

**Deliberately no htmx**, and it was tried on paper first. Every swap here is a
special case — an element that may not exist yet, a row that must not be
replaced while it is being renamed, a terminal that must never be touched — and
the inline `onclick` attributes plus the capture-phase rename listener would
have to be reconciled with a library's own handlers. It came to 40 lines of
vanilla instead of a 51 KB dependency.

Three rules the client keeps, each with a test:

- **A row being renamed is skipped.** The half-typed title lives only in the
  DOM; swapping the row throws it away mid-word.
- **A run the page does not show yet re-renders the tbody**, not the row. The
  empty state and the sort order both live there, so a new row cannot be
  appended. The same is true for anything whose *presence* depends on state (the
  scheduled banner, the usage panel): from absent to present is a parent swap.
- **`#term` is never part of a fragment.** Replacing it tears the xterm instance
  off the DOM, leaves the WebSocket open and leaks a tmux client — and every
  attached client rewraps the running agent's window, because tmux runs with
  `window-size=latest`.

**And `location.reload()` after killing a run STAYS.** It looks like a leftover
and is the opposite: it is what closes the terminal's WebSocket, and with it
that tmux client. The send and kill forms also sit outside the fragment and have
to disappear. The reason is in the code, so it does not get modernized away.

## The transport: why the hub felt slow, and what carries it now

Every page rendered in single-digit milliseconds and the hub still hung. That is
the shape of this whole section: **none of it was visible from inside the hub**,
because the requests never got there. Three causes, all in the layer between the
browser and `hub.mjs`, all measured on the running installation.

### One connection per tab, and a browser has six

`vpn-proxy.mjs` was `https.createServer` — HTTP/1.1 only. A browser opens at most
**6 connections per origin** over HTTP/1.1, and since the live channel exists
**every open cc-hub tab holds one of them open forever**: an EventSource is a
response that never ends. Four tabs left the page two connections to load itself
through; six left it none, and every further request simply queued in the browser
until a tab was closed.

It is `http2.createSecureServer` now, `ALPNProtocols: ['h2', 'http/1.1']`. An h2
browser multiplexes pages, fragments, static files and the SSE stream over ONE
connection, and the ceiling stops existing.

`allowHTTP1: true` is what keeps the terminal working: browsers do not run
WebSockets over h2 (RFC 8441 is not advertised here), so they open a separate
HTTP/1.1 connection for the upgrade — and the proxy's `upgrade` event still fires
for it. That was measured against Node 22 before the switch, because the h2
server's compat layer documents `request` but not `upgrade`.

**Hop-by-hop headers become fatal under h2.** `connection`, `keep-alive`,
`transfer-encoding` and `upgrade` describe one connection; node rejects them on
an h2 stream outright. The hub's SSE handler sends `connection: keep-alive`, so
passing the upstream headers straight through would have killed the live channel
for every h2 client — silently, since the throw happens inside the proxy. Both
directions are filtered (`normalizeHeaders`, `responseHeaders`), and the same
function turns an h2 client's `:authority` into the `host` the allowlist reads.

### `pipe()` does not close what it stopped reading

`up.pipe(res)` alone does not survive the client going away. When a browser
closes an SSE stream — a navigation, a closed tab — the downstream `res` ends,
but the **upstream request to the hub was never destroyed**: node's `pipe()`
unpipes a dead destination, it does not tear down the source.

So every page view left behind a socket to the hub, and inside the hub the SSE
client record that hangs on it: an entry in `clients` that receives every
published event, plus a 25 s heartbeat interval, for the life of the process.
Measured before the fix: **7 browser connections, 19 upstream ones**, and the
number only ever went up.

`res.on('close') → upstream.destroy()`. Everything the hub does to notice a gone
client (`req.on('close')` in events.mjs) depends on this socket actually closing
— which is why the fix belongs in the proxy and not there.

### Static files had no validator, and were read from disk every time

`serveStatic` did a `readFileSync` on **every** request and answered with nothing
but a content-type. Two consequences, and the second is the expensive one:

- a synchronous read in the request path blocks the ONE event loop that also
  holds every SSE stream, the terminal WebSocket, the scheduler and the watcher.
  xterm.js alone is 488 KB off disk;
- with no validator a browser cannot revalidate, so it re-downloaded the whole
  set on every page view — ~600 KB per page, ~900 KB on a run detail page.

Now: in memory, with an ETag from the file's mtime+size and `cache-control:
no-cache`. A repeat page view went from 104 KB to 10.5 KB. `no-cache` rather than
a long `max-age` because these URLs carry no content hash — a cached hub.js would
otherwise outlive a deploy. The entry is validated against one `statSync` per
request (metadata, no bytes), so editing `public/hub.js` still takes effect on
the next reload; the dev loop this repo lives on must not be traded for a cache.

### And a page render never waits on somebody else's server

`layout()` awaits `subscriptionUsage()` and `providerBalances()` — the rail and
the panel — on **every** page, and both talk to vendor APIs (cursor's dashboard
endpoint carries a 12 s timeout). With a two-minute cache the hub was fast for
two minutes and then ONE page view paid for everybody.

Both are **stale-while-revalidate** now: an expired entry is returned as it
stands while the refresh runs behind it, and the live channel re-fetches the
sidebar anyway, so the new numbers arrive on their own. `force` (the `/api/usage`
route) still waits — that caller asked for the current answer, not a fast one.
The only request that could still wait on a vendor is the one finding no cached
answer at all, which is why `hub.mjs` **warms both at startup**, fire and forget.
First page view after a restart: 1.15 s before, 11 ms after.

## The status sidebar: one place that says how the machine is doing

`statusSidebar()` in `pages.mjs`, right of the content, on **every** page,
`id="status-sidebar"`. In it, in this order: pipeline state (`headerStatus()`,
`id="header-status"`), work in flight per status for the current repo (each
count links to `/?repo=…&status=…`, the overview's one filter; when the other
repos together hold more of the same status, the sum across ALL repos follows as
a dimmed `(y overall)` suffix outside the link, shown only when it differs), open
incidents split the way `incidents.mjs` splits them, subscription usage and
provider balances (`usagePanel()`, `id="usage-panel"`).

Before this, status stood in three places and fully on exactly one page: two
quota bars in the header, the pipeline switch as running text beside them, and
the usage panel on the overview. The two bars were `bar()` in `layout()` and
`pctBar()` in `usagePanel()` — the same reading, two markups, the thresholds
spelled out twice. There is one `quotaBar()` now, and every bar in the
application comes out of it.

- **`layout()` is `async`** because the panel is: every call site awaits it.
- The header kept **context** (repo switcher) and one **action** (Quick Run) and
  gave up status. It is a line high and has to stay that way.
- **The chosen repo is remembered.** The switcher's choice travels as the
  `cchub_repo` cookie, so a page that carries no `?repo=` of its own (a menu
  click, a context-less page like settings) keeps the selection instead of
  falling back to the first repo — the reset the overview used to do on every
  navigation. The cookie is written twice on purpose: by the client when the
  switcher changes (so the very next page already shows the choice) and by the
  router whenever a page request names a valid `?repo=` (so followed links and
  "back" redirects persist too). `selectRepo()` and `layout()` read it in that
  order: explicit `?repo=` wins, then the cookie, then the first repo. An id
  that no longer exists (a deleted repo) is ignored, not trusted. `<body
  data-repo>` is **not** affected: pages without a repo context still set no SSE
  filter.
- **The fold lives on the shell**, not on the sidebar: `#shell.side-closed`,
  written from `localStorage['cchub.sidebar.open']` in try/catch. The live
  channel replaces `#status-sidebar` **whole** — blocks appear and disappear
  (no open incidents, no incident block), and an element that is not in the DOM
  cannot be swapped in by its own id — so a class on the sidebar itself would
  go with every update. `sidebarSync()` re-applies it after each swap.
- The sidebar carries **its own repo** (`data-repo` on the aside). `<body
  data-repo>` is the SSE filter and is only set where a page really has a repo
  context; the sidebar reads one on every page, so it has to say which.
- Fragment route: `GET /api/fragments/sidebar?repo=`, rendered by the same
  function the page uses. `/api/fragments/header-status` and `…/usage` still
  exist; the client simply asks for the whole aside instead.
- Under ~1000 px it drops **below** the content. A table narrowed by the
  sidebar is the one thing it must never cause.

### The overview: seven columns, and forms on a grid

Eleven columns became seven without losing a fact: traffic light + status word
+ last anomaly are **one** statement (`td.status-cell`), and harness/model and
branch/PR are one technical pair each (`td.two-line`). `OVERVIEW_COLS` is what
the empty state spans. The incident cell is a badge with its action on hover —
the rule the pencil and the archive button already followed, keyboard included
(`:focus-within`, because focus lands *inside* the form). A run's `status` goes
through `t()` (`status.*`), an anomaly kind through `anomaly.*`, a harness
through its plugin label. A table that does not fit scrolls inside
`.table-wrap`; it does not get to decide how wide the page is.

Forms are a two-column grid (`form.form-grid`): captions in one column, fields
in the other, hints in the field's column, and a tall field gets its caption
above it. **Every selector there carries `:not([hidden])`** — `label[hidden] {
display: none }` is the weaker selector of the two, and without the guard the
grid would bring switched-off schedule fields back, visible *and* submitted.

## Integration: a run is done when its work is on main

**No agent merges or pushes to the base branch.** Agents make branches
mergeable; the hub integrates. That one rule is what this whole section is
about, and everything below follows from it.

Before it, a run ended when the agent called `cc-report done`. What it had
committed then sat in its worktree and its branch, and whether it ever reached
`main` depended on whether the agent did it itself — which is how this
repository's reflog came to hold two `reset`s on main, a cherry-pick duplicate
and a finished branch lying unmerged for days.

Now a run is `done` when its work is **on `main`**. The hub checks the `done`
report instead of believing it, lets the still-living agent fix what is missing,
merges itself — serially per repo, in an integration worktree of its own, by
`push origin` — and escalates only when the agent does not deliver: to a fresh
conflict run, and last of all to a human. It all lives in
**`server/integrate.mjs`** and is off unless the repo says so
(`repos.merge_mode='hub'`; `'off'` is byte for byte the old behaviour, including
the prompt).

### The finish gate: `runs.finish_state`, not a new status

`handleReport(runId, {kind:'done'})` is where every end channel already met —
`cc-report done`, cursor's `finishByTurnEnd()`, the inbox fallback. So the check
hangs there. It stores the report first (it is safe from that moment on,
whatever the agent does next), then asks three questions in this order:

1. **uncommitted changes?** → `awaiting_commit`. Dirt outranks everything: half
   a run's work on `main` is the more expensive mistake, so nothing is merged
   while the worktree is dirty — not even the committed part.
2. **no commits at all?** (`tip == base_sha`) → nothing to merge, the run closes
   as it always did and the Telegram line says so.
3. **still mergeable?** — a **dry run with `git merge-tree --write-tree
   --name-only origin/{base} <tip>`**. Measured with git 2.43: exit 1 on
   conflict, the conflicting paths on stdout, and `git status` afterwards empty.
   It touches no worktree, which is the point — anything that checked out a
   branch here would fight the agent for its own.

`runs.finish_state` carries this as a **sub-state of `running`**, and not as a
new value in `runs.status`: that column has a CHECK, and a new value would be a
table rebuild like `harnessCheckErweitern()`. It is also simply true — the run
is still running. Its terminal stays writable, messages reach it, a human can
step in.

`runs.base_sha` is the worktree's HEAD right after it was created. It is what
makes "did this run commit anything" and "what does it want merged" answerable
without guessing at a branch. A run from before that column falls back to
`git merge-base <tip> origin/{base}`.

### The answer has to reach the agent, so `cc-report` prints it

`cc-report` used to call `curl -fsS` and throw the answer away. It now reads the
response and prints the `message` field on stdout — which puts the text into the
agent's **running turn** as that tool's own output, the cheapest moment there
is. Two consequences worth keeping:

- **`POST /api/runs/<id>/report` must answer 2xx.** Anything else is "hub
  unreachable" to `cc-report`, which files the report in `inbox.jsonl` for the
  watcher to replay. A finish gate that answered 4xx would loop.
- Channels with no call to answer (`finishByTurnEnd`, the inbox) get the same
  text typed into the tmux session instead — `handleReport` takes a
  `via: 'http' | 'inbox' | 'internal'` for exactly that. And `'internal'`
  carries a **loop guard for cursor**: `finishByTurnEnd()` fires at every turn
  end of a running cursor run, so an injected message would be answered by
  cursor working, ending its turn, and the hub injecting it again. The same
  message therefore only goes out anew when the state changed or two minutes
  passed.

### The check loop, and what the watcher may not do

Its own timer in `integrate.mjs`, every **5 s** — far denser than the 30-second
watcher, because an agent told "commit first" usually does it in seconds. Per
run a `nextCheckAt`, and the interval is a pure function:
`nextCheckDelayMs(elapsed)` → 5 s under a minute, 15 s under five, 30 s after.
At most **two git checks at a time**; what does not get a turn stays due and is
at the front of the next pass, so nothing starves. A check is kept cheap:
`git --no-optional-locks status --porcelain` (the flag is git-level and has to
stand **before** the subcommand — after it git rejects it as unknown and returns
an empty status, which reads as "clean"), and the conflict dry run only when
`rev-parse HEAD` says the tip has moved.

A run with a `finish_state` **has reported**. So:

- `_pane_died`, `_exit` and `reconcileClosedSession()` do not mark it
  `failed`/`aborted` and write no "ended without report" anomaly — they call
  `escalate(runId, 'agent_gone')`. That is for the **unasked-for** end only: a
  human or a flow ending the run on purpose (`/kill`, the sessions page,
  `kill_run`) still aborts it, and it is assessed like any other unfinished run.
- `watchRun()` writes no `overrun`, `soft_overrun` or `no_activity` for it: it is
  waiting on purpose.
- The deadline is `finish_started_at + repos.finish_timeout_min`, and it **does
  not run while the run is `waiting_help`** — there the agent waits for a human,
  not the other way round; answering the question restarts the clock.
- `integrateTick(nowMs)` takes the time as a parameter, like `pickUpScheduled()`,
  so the tests advance the clock instead of waiting fifteen minutes.

### The integrator: one queue per repo, and a worktree of the hub's own

`Map<repoId, Promise>` — each job hangs on the repo's chain, errors caught so
the chain can never tear. That this needs neither a broker nor a database lock
is the same argument `events.mjs` rests on: HTTP, scheduler and watcher are one
process.

The merge happens in `~/agents/integrate/<repo>` (`CCHUB_INTEGRATE_DIR`), a
detached worktree that belongs to the hub and is cleaned before every job. **Not
in the operator's checkout**, and that is not politeness: git refuses to push
into a branch that is checked out there, a branch belongs to exactly one
worktree, and `merge`/`reset` in a directory somebody is editing is how work
gets lost. The repo's **worktree extras are applied** to it as well
(`applyExtras()`, shared with `makeWorktree()`) — a `merge_check` like
`node test/unit.mjs` wants the linked `node_modules` as much as an agent does.

Then: `git merge --no-ff` (always, so every run is findable as a merge commit),
the optional `repos.merge_check` **on the merged result**, and
`git push origin HEAD:{base}`. A rejected push is retried once from the top
(somebody was faster); a second rejection is treated as a conflict. Only after
the push does the run become `done`, does Telegram hear about it, do the other
agents learn that `main` moved, and do the flows fire — a flow then sees a run
whose work really is on `main`.

### The escalation ladder

| Situation | `merge_status` | What happens |
|---|---|---|
| worktree still dirty | `blocked_dirty` | **nothing is merged**, incident + Telegram, three one-click answers on the detail page |
| conflict, or a red merge check | `resolving` → `blocked_conflict` | a conflict run, up to `repos.merge_max_attempts` of them; then a human |
| git/network/auth error | `blocked_error` | incident + Telegram, "Merge now" retries |
| no `origin` remote | `blocked_no_remote` | incident + Telegram; the hub never merges in the operator's checkout |
| ended `failed`/`aborted` | `unmerged_*` | never merged automatically — named, backed up, and the operator decides |

A **conflict run** is an ordinary single run through `startRun()`: budget gate,
title, overview, watcher, incidents, and the same finish gate at its end. Its
setup lives under Settings → Merge and goes back into a run the one way there
is — `setupToFormBody()` → `runDefFromForm()`, the same pair a favorite uses
(the function was lifted out of `favorites.mjs`, where it only happened to sit).
It works on a **fresh branch of its own**, `resolve/<short id>`: a branch belongs
to exactly one worktree and the original's worktree holds its own, so taking it
away under a possibly still-standing session is the trap this file warns about
elsewhere. A branch from the same tip has the same content and costs nothing.
**No conflict run starts a conflict run** — a failed one counts against the
ORIGINAL run's attempts, and that loop guard sits in `escalate()`.

**`repos.conflict_parallel` (default 1)** bounds how many conflict runs work at
once per repo. Keep it at 1 for a small repository where every task touches the
same files: parallel resolvers then invalidate each other and only the first
one's work survives. Raise it for a large repository where conflicts rarely land
on the same files.

### The branch rule under `hub`, and keeping work on a branch

Under `merge_mode='off'` the branch rule answers "does this work survive": no
branch means a detached worktree and throwaway changes. Under `hub` it answers
nothing of the kind — the hub merges **every** run — and only decides under
which NAME the work travels:

| Rule | `off` | `hub` |
|---|---|---|
| **no branch** | detached, throwaway unless the agent pushes it somewhere itself | detached; the commits are merged into `{base}` at the end. Where a name is needed anyway (backup, conflict run) it is `run/<short id>` |
| **new branch** | a branch from the pattern; whether it reaches `{base}` is up to the agent | the same branch, merged into `{base}` at the end — pick it for a readable name on origin |
| **existing branch** | continue across several runs | the same, and merged after **every** run — unless "keep on branch" says otherwise |

The form said none of this, and the prompt sentence for "no branch" still
promised *"changes are throwaway changes"* — in the same prompt where
`MERGE_RULE` promised the opposite. Both now come out of **one** table,
`BRANCH_MODE_INFO` in `run-def.mjs`: the i18n key of each explanation and the
English sentence the agent reads, per merge mode. `branchRuleText()` is what
`launchRun` calls instead of the inline ternary it used to carry, and a unit
test checks that every `explain` key really exists in `lang/en.json` — a table
may not name a string that is not there.

The form renders **both** explanations and lets CSS show the one that fits
`data-merge-mode` on the fieldset. So the static case needs no JavaScript, and
the only form that can change repo without rebuilding the page — the Quick-Run
dialog, which has a repo `<select>` while the header's switcher reloads — just
flips that attribute from a `repoId → mode` map, and rewrites the `<span
data-base>` inside the sentences so a repo with a base branch of its own is not
described with somebody else's.

**"Keep the work on its branch"** (`runs.keep_on_branch`) is for the long-lived
branch: a documentation branch, a spike, an agent that works on the same
`fest` branch for a week. Only offered under `hub` (the checkbox carries
`hidden` from the server as well as the CSS rule, so it is gone without the
stylesheet too), and refused with "no branch" — keeping work on a branch needs a
branch. What the integrator then does is a **short** version of the finish gate:

- the **dirt check stays** — a run is only over when its work is committed, and
  M1 is the same message as ever;
- **no dry run, no merge**; instead the branch is pushed to origin (the same
  `backupBranch()` the backup rule uses), `merge_status='kept_on_branch'`,
  event `branch_kept`, and the Telegram done line reads
  `Kept on branch <name> — not merged, as configured`;
- a **failed push is an escalation**, like a merge that cannot be pushed:
  the operator wants nothing living only on this machine;
- it sends no "main has moved" (nothing moved) but still receives one, and it
  fires no `run_merged` flow, because there was no merge;
- the prompt gets the `keep` sentence **instead of** `MERGE_RULE`. Two rules
  about the same thing is one too many — that is the lesson this whole table was
  written from;
- **"Merge now" is offered anyway.** Keeping the work on its branch is what
  happened automatically at the end of the run, not a verdict for all time; the
  click clears the flag and runs the ordinary path, dry run and all.

### The conflict run is not a normal run

`isResolverRun(run)` — `!!run.resolves_run_id`, one predicate in
`integrate.mjs`, and every one of the rules below asks it. A conflict run is a
**tool of the integrator**, not work anybody asked for. It shares the start path,
a worktree, a session, the watcher (activity, incidents, cost) and its row in the
overview, which says what it is for ("conflict run for …"). Everything else is
off:

| What | Why |
|---|---|
| **No Telegram of its own**, in any state — `notifyRun()` returns at the top | The operator hears about the run it works FOR: T-RESOLVING at the start, the done line naming the resolver after the merge, T-BLOCKED-CONFLICT when it did not get there. Three messages about one problem is two too many. |
| **No flows** — `flows=NULL`, `flow_dispatched=1`, `merge_dispatched=1` at creation | A flow must not fire for a run the operator never started, and the *merge* it carries belongs to the run it worked FOR: `run_merged` fires once per integration, on the original. Both flags are set at creation rather than at the end, because that is what the triggers poll on — and `dispatchMerges()` skips a `resolves_run_id` row for the same reason, so the two sides agree instead of depending on each other. |
| **No generated title** | It is called `Resolve conflicts: <original title>`; a model would only make that less clear. |
| **Never `unmerged_*` / `blocked_*`, never a `merge_blocked` incident** | Everything that goes wrong here is mapped onto the original: `escalate(original, 'resolver_failed')` → attempts → the next conflict run or `blocked_conflict`. It only ever carries `merged` or nothing. |
| **The finish gate is help, not a gate** | M1/M2/M4 reach it while it lives. Deadline gone or agent dead → `escalate(original, 'resolver_failed')` — **never** a conflict run for a conflict run. That is the recursion guard, and it is the reason the predicate exists. |
| **No `assessUnmerged()`** on `failed`/`aborted` | Same: not a decision for the operator, an answer the original still needs. |
| **No "main has moved"** | It has exactly one job; a notice about a moving base branch is noise inside it. |
| **`max_parallel` counts it but never blocks it** | It starts on the manual path. Its own ceiling is `conflict_parallel`. |
| **No retry button** | A conflict run is never repeated — "Merge now" on the original starts a fresh one, with a fresh branch. Renaming and archiving stay. |

### "main has moved" is built in, not a flow

After every merge the other running agents of the repo are told — urgently
(`M5a`) when the merge touched files they are working on too, as a note (`M5b`)
otherwise. Built into the hub on purpose: a flow would have to be attached to
every agent, and a forgotten attachment is invisible. Not to a run in
`waiting_help`, because a text typed into a session that is waiting for a human's
answer is read by the agent AS that answer — which is exactly why the send route
and the flow step switch such a run back to `running` first.

### `failed` and `aborted` are never merged automatically

`assessUnmerged()` runs on every path a run can end badly and writes
`unmerged_commits` / `unmerged_both` / `unmerged_dirty` / `nothing`. A failed
run's work is not automatically wanted — but it is **named**, so nobody has to go
looking, and the Telegram message carries the paragraph plus the resume command
(`resumeCommand(run)`, a plugin capability, see `docs/plugins.md`). The detail
page has the buttons: merge now, commit or discard the leftovers and merge, or
skip. That is why there is no `merge_when` setting.

### Nothing lives only on this machine

The remote is the backup, and that is a rule beyond the integrator:

1. **The integrator knows no local merge.** Its only way out is
   `push origin HEAD:{base}`. A merge that cannot be pushed is thrown away
   (`reset --hard origin/{base}`) and escalated. There is no state "merged, but
   only locally".
2. **The operator's own commits on `{base}` are pushed by the hub**
   (`pushOperatorBase()`, in the watcher pass, throttled to once a minute per
   repo). A **push touches no working tree**, which is why it is the one git
   command the hub runs in the operator's checkout — `merge`, `checkout` and
   `reset` stay forbidden there. Diverged? **Never `--force`**: a global incident
   plus Telegram, and a human reconciles it. Success sets `repos.last_push_at`,
   shown on the Repos page.
3. **Work that nobody merged is pushed as a branch** — the run's own branch, or
   `run/<short id>` for a detached worktree (`branch_backed_up`). Same intention
   as the existing `anomaly:unpushed`, only carried out instead of reported.
   Remote branches are **not** deleted after a merge in v1: visible history is
   cheaper than an accidental deletion.

### Visibility, and the one rule the whole thing hangs on

The overview's status cell carries the finish state under the status word (and
the merge status on a finished run), the detail page has an "Integration" line
with the buttons, and a blocked merge is a `merge_blocked` incident — which puts
it in the sidebar's "Needs you" group on every page. The repo form's
"Integration" block ends with the flows that run **after** a merge
(`mergeFlowsBlock`), and the repo list's Integration column says how many there
are: a `run_merged` flow hangs on the repository, not on an agent, so this is
where one goes looking for it. None of it needs a second
renderer, because **every** change of `finish_state`/`merge_status` goes through
`addEvent()` and the live channel re-fetches the fragment. There is no silent
`UPDATE runs` on this path, and that is not a style preference: it is what makes
the pages agree with the database.

`repos.max_parallel` (0 = unlimited) belongs here too: it bounds the SCHEDULED
starts of a repo — the timetable and the planned single runs. A start the
operator triggers by hand is never blocked, because a limit that overrules a
deliberate decision is a limit one works around.

## Tests

```bash
node test/unit.mjs          # pure logic (cron, schedules, quota gate, parsers, registries, i18n, docs,
                            # the finish gate's decisions and its texts) — ~1 s
node test/e2e.mjs           # complete hub in a sandbox, stub instead of real agents — ~40 s
node test/e2e.mjs --echt    # additionally ONE real run per harness (consumes quota)
node test/e2e.mjs --keep    # keep the sandbox (debugging)
node test/browser.mjs       # public/hub.js in a real Chromium — ~10 s
node test/proxy.mjs         # vpn-proxy.mjs against a stub upstream — <1 s
```

The e2e suite starts a **second hub** on a free port with its own database, its
own test repo and its own `cc-start` stub. It may therefore run at any time
alongside production: the production database, `~/agents` and foreign tmux
sessions are never touched, and only sessions the suite created itself are
killed (also on Ctrl-C). Watcher passes are triggered directly instead of
waiting for the 30-second interval. That sandbox lives in
**`test/sandkasten.mjs`** — one construction, two suites, because a second copy
of it would drift the way the run definition once did.

**The sandbox kills what its own stub created, and the stub writes the list.**
That used to be a `sessions` Set filled by two helpers, so every run started
along another path — the scheduler, a flow, a conflict run, a retry — created a
tmux session nothing would ever kill. One per suite run is enough: agents working
on this repository run the suite dozens of times a day, and the machine ended up
with 157 live sessions, 11 of them belonging to the running hub, together holding
gigabytes of RSS while it sat in swap. The leftovers are recognizable by their
`-2` suffix — the stub's own collision loop, firing because a retry reuses the
run id while the first session is still standing. The stub knows the name it
created and cannot forget to write it down, so `$SB/sessions.txt` is the list and
`aufraeumen()` reads it. Still no pattern across all `cc-*`: that file holds
exactly the sessions THIS sandbox produced.

The sandbox repo has a **bare `origin`** next to it, which is what lets the
integration be tested for real: the group "Integration: a run is done when its
work is on the base branch" walks a clean run through to a merge commit on
`origin/main`, holds a dirty one and reads the hub's answer, produces a real
conflict, watches a conflict run take over and both runs end up merged, hits the
attempt limit, kills an agent mid-gate, fails a merge check, and pushes an
operator commit to origin. The suite **owns the integrator's clock**
(`CCHUB_INTEGRATOR_OFF=1`): two processes driving one integration worktree is a
race nobody wants to debug, so the hub still integrates on the report path and
the suite calls `integrateTick(nowMs)` itself. The last test in the group turns
`merge_mode` back to `off` — everything before it is the proof that without the
setting nothing runs differently.

**Why there is a browser suite.** `public/hub.js` was 746 lines with not one
test, because no browser ran in the suite: everything else stops at the HTML the
server sends. And the ways that file breaks are all **silent** — a dead listener
throws nothing, the selects simply never fill, the terminal is a black box, the
pencil does nothing. `test/browser.mjs` therefore drives Chromium against a
sandbox hub and writes down what hub.js does today: the relative times that tick
by themselves, the schedule and start-time blocks (the latter **per fieldset** —
the Quick-Run dialog puts that block on the page twice), the Quick Run that
clears only the task, inline renaming including its guard against sending twice,
the form parked in `sessionStorage` while one builds a flow, the
provider/model/effort cascade, the sessions page's optimistic ending, and both
branches of the terminal. Every test also fails on an exception in the browser
console, because that is where a silent break first shows.

**Why there is a proxy suite.** AGENTS.md has carried the sentence "a green test
against 127.0.0.1 says NOTHING about the path through the TLS proxy" for a long
time, and nothing tested that path at all — which is exactly where the three
slowdowns above were hiding. `test/proxy.mjs` starts `vpn-proxy.mjs` against a
**stub** upstream, because what is being tested is what the proxy does with a
connection and a stub can COUNT its connections: ALPN really offers h2 and still
falls back to http/1.1 for the terminal, an SSE stream survives the hop-by-hop
headers h2 forbids, and eight abandoned streams leave **not one** socket behind.
It is part of `npm test` (it needs only openssl, and reports itself skipped and
green without it).

It is **not** part of `npm test`: it needs `playwright` (a devDependency) and a
Chromium. Without either, the suite reports itself skipped and ends green —
whoever has no browser must not sit in front of a red test.

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

### cursor: when a run is over

**cursor's TUI stays standing after the work is done** ("→ Add a follow-up").
The pane never dies, the process never exits — so `_pane_died` and `_exit`, the
last safety nets under every other harness, never fire. Until this was built, a
cursor run whose agent forgot `cc-report done` stood on `running` **forever**,
and a single run waiting for "when no other run of this repo is going" waited
behind it just as long. Measured on 2026-08-25: one forgotten report held up four
runs, among them the one meant to fix exactly this.

Two channels report the end, and both end in `finishByTurnEnd()`
(`reports.mjs`) — the single place that knows a turn end can be a run's end:

| Channel | What | Speed |
|---|---|---|
| `stop` hook | `runner.mjs` writes `.cursor/hooks.json` into the worktree before the start (`hookFiles()` in the plugin); `stop` fires when the agent ends its turn while the session stays alive, `sessionEnd` when the process really exits | within a second |
| transcript | `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl` ends a finished turn with `{"type":"turn_ended"}` (`server/cursor-transcript.mjs`) | next watcher pass |

The transcript is not decoration: an existing `.cursor/hooks.json` is **never**
overwritten (a repository may bring its own tooling), and a cursor release could
rename the event. It also finally gives cursor an **activity source** — the file
grows while the agent works (measured: 325 → 693 → 994 → 1302 bytes across three
tool calls, mtime advancing each time), which is what `measureActivity()` reads.

Only from status `running`. `waiting_help` means the agent asked a question and
is deliberately idle until a human answers — ending its turn is correct there,
not the end of the work (the answer via `/api/runs/<id>/send` puts it back on
`running`). A run that reported properly is already `done` when the hook fires,
because `cc-report` is a tool call *inside* the turn and the hook comes after it
— so this only ever catches the case it is meant for. What it writes as the
report is the agent's own closing message from the transcript, plus one line
saying that the platform, not the agent, closed the run.

**Detecting the end three times must still notify once.** Two channels here plus
`sessionEnd`'s `_exit` all run into `handleReport()`, and `handleReport()` is
what writes to Telegram — so the fences against a run ringing the phone three
times about the same thing are load-bearing, not incidental: `handleReport()`
accepts a run only in `running`/`waiting_help`, `finishByTurnEnd()` fires only
from `running`, and `notifyRun()` carries a `telegram_sent:<type>` flag per run.
Whichever channel gets there first closes the run; the others find it finished
and fall out. The e2e suite fires all three at one run and asserts a single
`telegram_sent:done` ("all three end channels together ring Telegram exactly
once") — remove any of the three fences and that test goes red.

The hook file is the hub's, not the agent's work: `harnessOwnedPaths()` keeps
the worktree cleanup from counting it as uncommitted changes (the same trap the
worktree extras once fell into), and this repo gitignores `.cursor/hooks.json`.

**And the prompt says it too**, because the detection is the net and not the
plan. `platformSuffix()` builds four sections, and the order is the point:

1. the platform rules (working directory, branch, duration, help/branch/pr/failed)
2. the operator's own addition — **Settings → Platform prompt suffix**
3. the harness's own lines (`promptRules`): cursor is told that its turn ending
   closes the run and that a summary printed into the TUI is not a report
4. **how the run ends** — last, because that is what runs actually fail on:
   write the report to `{report_file}` (→ `~/agents/runs/<id>/report.md`,
   deliberately outside the worktree so a report file cannot leave it dirty),
   then `cc-report done --file <that path>`, then stop.

**Section 4 cannot be removed, and that is a lesson rather than a preference.**
The settings field used to *replace* this whole block. It is called a suffix, it
starts out empty and it looks like a free notepad — so the day somebody wrote
their own working rules into it, every prompt on this hub silently lost the
sentence "at the end always `cc-report done`". The runs kept working and kept not
reporting. Whatever is written there is an addition now, placed where it reads
like one; for rules that concern a single repository the repo prompt is still the
better place.

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

The one trigger that is **not** an attachment is `run_merged`: it fires once per
merge into a repo's base branch and carries its own filter, the repo, because a
merge belongs to the repository and may be carried by a conflict run that never
hung on an agent — its way in is therefore the repo form, not the agents page.
Together with the `shell_command` block (a command on the hub machine, exit code
as a result rather than a failure, optionally detached) that is what lets a flow
restart the hub after a merge.

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

## tmux sessions: the machine, not the bookkeeping

`server/sessions.mjs` + the **Sessions** page. Every other page shows what the
hub *recorded*; this one shows what the machine is actually *holding* — and it
is the only place where a session can be ended by hand.

A session deliberately outlives its agent: `cc-start --keep` sets
`remain-on-exit`, so the screen stays readable afterwards. The price is a
process keeping its memory until the session goes, and with the old rule that
bill ran for days (thirty sessions, 15 GB, measured).

- **Running agents are hidden by default.** The row you must not hit by accident
  is not within reach of the mouse; one checkbox shows them, and the choice
  lives in `localStorage`. Ending one of them asks first — that confirmation is
  the only friction on the page.
- **Oldest first**, because that is the order one cleans up in.
- **Nothing blocks.** A click marks its row "ending …" in the same tick and the
  request goes off in the background; several rows can be clicked away in a row,
  and `POST /api/sessions/kill` takes any number of names and kills them
  concurrently. Only what the server confirms is struck through.
- Shown per session: age, last activity, state, the run behind it, the pane's
  command, and **RSS/CPU of the whole process tree** (one `ps`, summed from the
  pane PID down) — the pane itself is only a shell and would understate it by an
  order of magnitude.

### The work is done — who is still there, and who only left a screen

Three of the four coding agents keep running after the task is finished, and
that is not a detail of the terminal but the reason it exists (measured
2026-08-27, one trivial prompt each):

| Coding agent | Command (`cc-start`) | When the work is done |
|---|---|---|
| claude | `claude --permission-mode dontAsk "$CC_PROMPT"` | stays in its TUI, pane alive — production sessions on `done` runs still had a live `claude` pane 19 h later |
| opencode | `opencode --auto --prompt "$CC_PROMPT"` | stays in its TUI, pane alive |
| cursor | `cursor-agent --force --trust -- "$CC_PROMPT"` | stays at "→ Add a follow-up", pane alive — this is what `finishByTurnEnd()` exists for |
| hermes | `hermes chat -q "$CC_PROMPT" --yolo` | **exits.** `-q` is "single query (non-interactive mode)": it prints its answer plus a `hermes --resume …` line and the process ends (measured: dead pane, status 0, 9 s after the start) |

So a standing session and a reachable agent are two different facts, and only
`pane_dead` tells them apart — `remain-on-exit` keeps hermes's screen exactly
the way it keeps a crashed run's. `paneAlive()` (sessions.mjs) is that one
question, one `tmux list-panes` per detail page.

**Which is why the run's terminal is writable as long as its SESSION is**, not
as long as its status says `running`. It used to hang on the status, and that
locked the operator out of the ordinary case: the run reports `done`, the agent
is still sitting in its TUI ready for a follow-up, and the page showed a
read-only screen of it. `pageRun()` therefore asks for the session and the pane,
never for the status; the status only decides the BUTTON underneath — a run
still in flight is ended (`/api/runs/<id>/kill`, sets `aborted`), a finished one
only loses the session it left standing (`/api/sessions/kill` with a `back`,
which leaves the record alone). `/api/runs/<id>/kill` enforces the same rule
from its own side: on `done`/`failed`/`aborted` it closes the session and writes
`tmux_closed` instead of rewriting a clean run into a failed one. What is sent
into a finished session is real work that this run no longer records, and the
retention clock keeps counting from the run's end — the page says so.

**Ending a session is a run event, not just a tmux call.**
`reconcileClosedSession()` is the single place that knows this: a run still on
`running`/`waiting_help` becomes `aborted` with an `ended_at` and a report line
saying why, and attached flows fire. Nothing could ever report for that run
again — leaving it on `running` is how the overview came to show runs that did
not exist. The watcher uses the same function when it finds a session gone (it
used to only set `tmux_closed_at` and leave the status alone), and so does the
retention pass.

**Retention is in hours and counts from the agent's end** (Settings → keep the
tmux session open, `session_keep_hours`, `0` = right away; the old
`retention_days` is still read as a fallback for an installation that has not
saved the field yet). The first version fired on a **dead pane** only — but a
claude that reported `done` and stays in its TUI keeps its pane alive forever,
which is exactly the set of sessions that was piling up. `finishedAtMs()`
therefore takes the **earlier** of the run's end and the process's end.

Automatic closing only ever touches sessions **that carry a run of this hub**.
The e2e suite and other hub instances share the same tmux server, and a pattern
across all `cc-*` would kill theirs; a foreign session is listed and ended by
hand, never by the watcher.

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
its own run red. The veto costs nothing where it matters — hermes, the harness
for which the log is the *only* source, has no activity measurement, so it never
applies to it; claude, opencode and cursor each have a second channel that
reports a real error (claude, opencode) or at least the agent's activity
(cursor) independently of the log.

**Silence is only an argument where activity is measured.** `measureActivity()`
has a source for claude (transcript mtime), opencode (session store) and cursor
(transcript mtime, see "cursor: when a run is over"); for hermes it has none and
returns nothing. `bewerteLogTreffer()` therefore reads
`letzteAktivitaetMs === null` as *unknown*, never as *silent* — otherwise every
yellow log hit on that harness turned red five minutes later while the agent was
happily working. There, repetition and the check LLM are the escalation paths; a
hit that has not recurred within 30 min expires by itself.

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
`beforeShellExecution`, `beforeMCPExecution`, `beforeReadFile`, `afterFileEdit`,
`beforeSubmitPrompt`, `afterAgentResponse`, `stop`, `sessionStart`, `sessionEnd`,
`preToolUse`/`postToolUse`, … — nothing for a failed call), and there is no open
pulse endpoint for `api2.cursor.sh`:
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
  `pages.mjs`, and `data-live` means "session standing AND a process in it" —
  never "the run's status is `running`" (see above). Touching only one of the
  two sides yields a terminal that silently does nothing — exactly how it sat
  for a long time, because `ro=0` appeared nowhere.
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
- **cursor's hook format is the other one.** `<workspace>/.cursor/hooks.json` is
  `{ version, hooks: { <event>: [{ command }] } }` — a **flat** list per event,
  exactly the shape Claude rejects. Handing cursor Claude's nesting gets the file
  silently ignored, and a silently ignored end-of-turn hook is the whole bug
  again. cursor also reads `<workspace>/.claude/settings.json`, so the two
  formats really do meet in one directory tree.
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
- **A `<form>` closes an open `<p>`.** The HTML parser does it, so
  `<p><a class="btn">…</a><form class="inline"><button>…</button></form></p>`
  puts the two buttons on two lines and no CSS can talk it out of that — the
  form has become a sibling of the paragraph before the stylesheet ever sees it.
  Buttons that belong next to each other go in a `<div class="btn-row">`.
- **`--no-optional-locks` is a GIT-level option, not a `status` one.**
  `git -C <dir> status --porcelain --no-optional-locks` is rejected as an unknown
  option — and the finish gate read the resulting empty output as "worktree
  clean", so every dirty run sailed straight through to a merge. Correct is
  `git -C <dir> --no-optional-locks status --porcelain`. Found by the e2e test
  that was written for exactly that case, not by reading the code.
- **`capture-pane` needs the colon too.** `tmux capture-pane -p -t "=name"`
  answers "can't find pane" — the same trap `pipe-pane` and `set-hook` already
  have an entry for above. `-t "=name:"` is what works, and a test that asserts
  on an empty capture asserts on nothing.
- **The text is on the agent's screen before the event is in the database.**
  `sendToSession()` is a bracketed paste, a 300 ms pause and then Enter; the
  event is written after all three. A test that greps `capture-pane` and then
  reads the events in the same breath is racing itself.
- **A green test only proves the path the test took.** `curl` against the VPN IP
  from the server itself runs over `lo` and says nothing about the firewall;
  check real reachability only from a VPN client.
