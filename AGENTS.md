# Freilauf

Web UI for managing autonomous coding agents (claude / opencode / hermes / cursor).
Agents run in tmux sessions, every run in its own git worktree; the hub
(`server/hub.mjs`, one process: HTTP + WebSocket terminal + scheduler + watcher)
schedules, observes, collects reports, merges finished work into the base branch
and optionally notifies through a plugin. `vpn-proxy.mjs` is the TLS edge; the
service runs from its own deploy checkout (`bin/freilauf-deploy`), never from a
human's working copy. State: SQLite in the data dir, runs in `~/agents/runs`,
worktrees in `~/agents/worktrees`; every path is overridable via `FREILAUF_*`.

> No private information in this file or anywhere in the repo (ports, VPN
> addresses, hostnames, certificate paths). That lives in `CLAUDE.local.md`,
> gitignored. "Planung x.y" in comments means a private planning document.

## Language, and the multilingual UI

Source, comments, docs, skills and commit messages are **English**. UI strings
are never hardcoded: `t('key')` via `server/i18n.mjs`, client side via
`window.FREILAUF_I18N`; `lang/en.json` is the reference and `de.json`/`zh.json`
must carry the same keys (a unit test enforces it). Subagents
`english-enforcer` and `i18n-checker` guard both. Legacy German identifiers
are renamed opportunistically; new code is English.

## Rule files

Every `AGENTS.md` has a `CLAUDE.md` next to it containing exactly one line,
`@AGENTS.md`, and nothing else (unit test group "Docs"). Nested rule file:
`server/flows/AGENTS.md`. When you edit a rule file or a doc you write for an
agent: compact, one sentence per rule, a reason where the rule is not obvious,
nothing that the code or a `grep` already shows.

## What is documented, and what is not

**The code is the single source of truth.** A document holds only what the
code cannot say by itself:

1. **Requirements** the code must keep satisfying — the invariants somebody
   working on an area has to know before changing it. `docs/requirements.md`,
   one section per area, its table of contents names the modules each section
   covers.
2. **Contracts** third parties write against: `docs/plugins.md` (coding
   agents, model providers, notifiers), `docs/panels.md` (a project's own
   sidebar numbers), `server/flows/AGENTS.md` (flow steps), `SANDBOX.md`
   (container profiles and the measurements behind them).
3. **Measured traps** in the tools we drive (tmux, git, docker, the agent
   CLIs) that the code cannot show and that hurt when unknown:
   `docs/pitfalls.md`, one line each.

Not documented: how a function works, what a table holds, the history of a
bug, run ids and dates — `git log`, tests and the code carry those. A document
that contradicts the code is wrong and is corrected or deleted in the same
commit, never obeyed; a requirement that no longer holds is removed, not kept
"for history". Documents hold no style guidelines that could later argue with
a task.

Public documents, maintained **in the same commit** as the change they
describe: `README.md` with `README.de.md` and `README.zh-CN.md` (English is
the reference, both translations follow), `SETUP_WITH_AGENT.md` (what a
stranger's agent acts on: install, setup scripts, prompt, plugin contracts,
flow blocks, the file map), `CONTRIBUTING.md`, `CHANGELOG.md` (Keep a
Changelog categories, one section per ISO day, newest first — every change a
user or operator would notice), `ROADMAP.md` (English only, deliberately
incomplete, may be empty). License CC BY 4.0.

## Standard workflow

1. **Read first.** Find the area you touch in the file map below, read the
   matching section of `docs/requirements.md` and the contract document if one
   applies, then the code. For anything touching tmux, git worktrees, docker or
   a CLI's flags, scan `docs/pitfalls.md` for the tool's name.
2. **Work.** Every run definition change goes through `server/run-def.mjs`;
   every run transition through `addEvent()` in `server/db.mjs`; every message
   to a human through `server/notify.mjs`; every plugin-side vendor fact into
   the plugin, never into the hub.
3. **Test.** `node test/unit.mjs` (~1 s) and `node test/e2e.mjs` (~40 s,
   sandboxed, safe next to a live hub) always; `test/browser.mjs` for
   `public/hub.js`, `test/proxy.mjs` for `vpn-proxy.mjs`,
   `test/proxy-egress.mjs` for the sandbox proxy, `test/deploy.mjs` for
   `bin/freilauf-deploy`. The suites own the watcher, integrator and container
   clocks (`FREILAUF_WATCHER_OFF`, `FREILAUF_INTEGRATOR_OFF`,
   `FREILAUF_SANDBOX_REAPER_OFF`) and point every path and credential into
   their sandbox; a new external dependency of the hub gets its own
   `FREILAUF_*` fence there.
4. **Evaluator until PASS** (below).
5. **Update the documents**: the changelog entry; the requirements section if
   an invariant was added, changed or dropped; `docs/pitfalls.md` if you
   measured a new trap; the public documents if they describe what changed.
   Delete what the code no longer satisfies.

## Quality assurance: the evaluator

Before anything is reported as done or working, the `evaluator` subagent
(`.claude/agents/evaluator.md`) checks it: fresh context, it never edits the
work (Bash only to run the suites), judged against observed evidence — test output, the diff, the running page.
Reason: the builder never grades its own work, and a second pair of eyes finds
different mistakes. Hand it the task or acceptance criteria, the changed files
and the paths to the evidence. `NEEDS_WORK` means work through every finding
without debate, weakened tests or loosened criteria, then have it re-checked;
only `PASS` ends the task.

## Where is what

| Area | Code | Requirements section |
|---|---|---|
| What a run is: forms, validation, agents, favorites | `server/run-def.mjs`, `server/favorites.mjs`, `server/run-edit.mjs` | Run definition |
| Starting runs, schedules, budget gate | `server/scheduler.mjs`, `server/quota.mjs` | Scheduling; Quota and gates |
| Worktree, prompt, launch, resume | `server/runner.mjs`, `bin/fl-start` | Launch and resume |
| Reports, follow-ups, attention state | `server/reports.mjs`, `bin/fl-report`, `server/hub-socket.mjs`, `server/goal.mjs` | Reports and follow-ups; Attention |
| Extra skills, the cleanup agent, model catalogs, extras suggestion | `server/zusaetze.mjs`, `server/cleanup.mjs`, `server/models.mjs`, `server/extras-suggest.mjs` | Run definition |
| Watching, anomalies, incidents | `server/watcher.mjs`, `server/detect.mjs`, `server/incidents.mjs` | Watcher and incidents |
| Merging into the base branch | `server/integrate.mjs` | Integration |
| tmux sessions, retention, memory | `server/sessions.mjs`, `server/terminal.mjs` | Sessions |
| Pages, sidebar, live channel, transport | `server/pages.mjs`, `server/web.mjs`, `server/web-helpers.mjs`, `server/notifications.mjs`, `server/events.mjs`, `public/hub.js`, `vpn-proxy.mjs` | Pages and live channel |
| Plugins, credentials, discovery, welcome | `server/plugins/`, `server/harnesses/`, `server/providers/`, `server/notifiers/`, `server/welcome.mjs` | Plugins (+ `docs/plugins.md`) |
| The hub's own LLM calls, titles, alerts | `server/llm/`, `server/title.mjs` | LLM layer |
| Usage, balances, OpenRouter routing | `server/usage.mjs`, `server/claude-usage.mjs`, `server/balances.mjs`, `server/providers/openrouter-routing.mjs` | Quota and gates |
| Repos, archive, panels, read API | `server/web.mjs`, `server/panels.mjs`, `server/read-api.mjs`, `bin/fl-api` | Repos and archive; Panels |
| Shipped agent skills | `skills/`, `server/skills.mjs` | Skills |
| Sandbox | `server/sandbox/`, `sandbox/` | `SANDBOX.md` |
| No-code flows | `server/flows/` | `server/flows/AGENTS.md` |
| Deploy, units, CLI | `bin/freilauf-deploy`, `bin/freilauf`, `deploy/`, `setup/` | Deploying and restarts |
| Schema, migrations, events | `server/db.mjs` | Run definition; Pages and live channel |

## Pitfalls that hurt on any change

- `Number('')` is `0` and finite, `Number(null)` too, and the string `'0'` is
  truthy: compare a form or settings value against the strings that mean
  "set" before converting; never coerce a checkbox.
- A plugin file (`server/harnesses/*`, `server/providers/*`, `server/sandbox/*`
  loaders) imports hub modules **lazily inside the function**; a static import
  closes the registry cycle and dies with a `ReferenceError` in a file nobody
  edited.
- A tmux pane target needs the colon: `-t '=name:'`. The bare form does not
  fail, it answers empty, and empty reads as good news.
- `git --no-optional-locks status` — the flag goes before the subcommand;
  after it, git answers an empty status, which reads as "clean".
- tmux, git and docker answer "no such thing" and "I could not answer" alike
  in the exit code; classify the message (`tmuxVerdict()`, `runtimeVerdict()`)
  and do nothing when the answer is unknown.
- A branch belongs to exactly one worktree; never `--force` a worktree onto
  the base branch, and never run `merge`/`checkout`/`reset` in the operator's
  checkout (push is the one git command allowed there).
- Settings keys are computed per save (`settingsKeys()` in pages.mjs is a
  function): a module-level constant is evaluated before plugins are
  registered and drops their fields silently.
- `node:sqlite` has no `.transaction()`; use `BEGIN`/`COMMIT` via `db.exec`.
- A `<form>` closes an open `<p>` and cannot nest in another `<form>`; buttons
  that belong together go in `div.btn-row`, footer forms stand outside the
  save form.
- A green test proves only the path it took: `curl` from the server over `lo`
  says nothing about the firewall, a stub daemon says nothing about an image,
  and a synthetic DOM event says nothing about a real drag.
