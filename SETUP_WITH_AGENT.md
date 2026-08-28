# Setting up cc-hub — a guide written for coding agents

**You are a coding agent (Claude Code, opencode, cursor-agent, …) and someone
asked you to install, understand or adapt cc-hub. This file is for you.**

Humans: hand this file to your agent — *"read SETUP_WITH_AGENT.md and set this
up for me"* — and answer the handful of questions it will ask. Everything here
is also readable by a human, it is just written for the reader who can run the
commands.

This document is deliberately short on internals. When you need those, the map
at the end tells you which file to open. Two rules before anything else:

- **Never invent machine-specific values.** Ports, IP addresses, hostnames,
  certificate paths and API keys are things you *ask the human for* — see
  [Questions for the human](#2-questions-for-the-human).
- **Adapt this project.** cc-hub is one operator's opinions turned into code.
  It is a starting point, not a product with a support contract — see
  [Make it yours](#make-it-yours).

---

## 1. The mental model — read this before running anything

cc-hub is a **web UI that runs other coding agents for you**, unattended.
Six facts and you can reason about the whole system:

1. **A run is one agent working on one task.** It gets its own **git worktree**
   under `~/agents/worktrees/` and its own **tmux session** — so several runs
   never collide, and you can attach to any of them and watch.
2. **An agent and a single run are the same thing.** They share one *run
   definition* (coding agent, provider, model, effort, prompt, branch rule, …).
   An "agent" is just a run definition that also has a name and a schedule.
   This lives in `server/run-def.mjs`, and there is exactly one way from a
   definition to a running run: `startRun()` in `server/scheduler.mjs`.
3. **The agent reports back with `bin/cc-report`** (`done`, `failed`, `help`,
   `progress`, `branch`, `pr`). The hub also watches from the outside — tmux
   state, logs, transcripts, hooks — because an agent that hit a rate limit
   cannot report anything.
4. **The hub does the merging, not the agent** (when a repo is set to
   `merge_mode = hub`). A run is `done` when its work is on the base branch.
   If the worktree is dirty or the merge conflicts, the still-living agent is
   told to fix it, and only then a human. `server/integrate.mjs`.
5. **Coding agents and model providers are plugins** — one file each under
   `server/harnesses/` and `server/providers/`. Adding support for a new CLI is
   adding a file, not editing ten call sites. [`docs/plugins.md`](docs/plugins.md).
6. **The service runs from its own checkout** (`~/agents/deploy/cc-hub`), never
   from the directory a human edits in. `cchub deploy` moves it forward, health
   checks it and rolls back if it fails.

Security model in one line: **the hub can drive tmux, which is shell access.**
It binds to `127.0.0.1` only; a TLS proxy in front of it binds *exclusively* to
a WireGuard address. There is no login — the VPN is the auth layer. Never
expose it any other way.

---

## 2. Questions for the human

You cannot derive these from the repository, and guessing them is how a shell
ends up on the open internet. Ask the human, all at once:

| Question | Why it cannot be guessed |
|---|---|
| **Which WireGuard address should the UI bind to?** (`CCHUB_VPN_BIND`) | There is deliberately no default. Without a value the proxy refuses to start — that is the fence against ending up on `0.0.0.0`. |
| **Which two ports?** (`CCHUB_VPN_PORT`, `CCHUB_LOCAL_PORT`) | The values in `env.example` are placeholders. Pick something free and unremarkable. |
| **Which hostnames may address it?** (`CCHUB_ALLOWED_HOSTS`) | Rebinding/CSRF fence. Only the VPN IP and names whose DNS the operator controls. Every name must also be in the certificate. |
| **Do certificates exist, or should you create them?** | `~/.local/certs/cc-hub/dev-cert.pem` + `dev-key.pem`, e.g. via [mkcert](https://github.com/FiloSottile/mkcert), SANs = the VPN IP and any hostname above. |
| **Which coding agent CLIs are installed and licensed?** | `claude`, `opencode`, `hermes`, `cursor-agent` — the hub only offers what the operator configures. |
| **Which API keys, if any?** | `OPENROUTER_API_KEY` etc. **Ask for them to be pasted into `~/.config/cc-hub/env` by the human.** Do not read them, echo them, or put them in a commit, a log or your report. |
| **Telegram notifications?** | Optional. The bot token and chat id are entered in the UI's setup assistant, not by you. |

If the human does not know, say what the value is *for* and offer the safe
default (VPN-only, fail-closed). Do not proceed on a guess for
`CCHUB_VPN_BIND` or `CCHUB_ALLOWED_HOSTS`.

---

## 3. Install it

Prerequisites: Linux with systemd user units, **Node.js ≥ 22** (`node:sqlite`),
`tmux`, `git`, `jq`, `curl`, a working WireGuard interface, and at least one
agent CLI on the `PATH`. Verify before starting:

```bash
node --version && tmux -V && git --version && jq --version && ip -br a show wg0
command -v claude opencode hermes cursor-agent   # at least one
```

Then, in order — each step prints what to do next:

```bash
./setup/01-npm-install.sh       # deps for THIS checkout (tests, editing, running by hand)
./setup/02-install-scripts.sh   # cc-* + cchub + cchub-deploy → ~/.local/bin, opencode plugin, extra skills
./setup/03-install-services.sh  # ~/.config/cc-hub/env (from env.example) + systemd user units
```

Now **the human edits `~/.config/cc-hub/env`** with the answers from section 2
(at minimum `CCHUB_VPN_BIND` and `CCHUB_ALLOWED_HOSTS`) and places the
certificates. Then the firewall, which needs root:

```bash
sudo ./setup/04-firewall.sh     # ufw: the VPN port only on wg0, denied everywhere else
```

If you cannot run `sudo`, print the command and let the human run it. Say so
rather than skipping it — without this rule the port is only protected by the
bind address.

Finally, create the checkout the **service** runs from and bring it live:

```bash
cchub-deploy --init --from "$PWD"   # clone into ~/agents/deploy/cc-hub and deploy it
cchub status                        # hub process, VPN access, pipeline, sessions, deployed sha
cchub on                            # start the TLS proxy → reachable over WireGuard
```

**Verify from a VPN client, not from the server.** `curl` against the VPN IP
from the machine itself travels over `lo` and proves nothing about the
firewall. This is a real trap and it is in `AGENTS.md` under "Pitfalls".

Troubleshooting, in the order that pays off: `cchub status` → `cchub logs` →
`systemctl --user status cchub.service`. A hub that will not start is almost
always a missing value in `~/.config/cc-hub/env` or a missing certificate.

---

## 4. First five minutes in the UI

The hub starts empty on purpose. In this order:

1. **Settings → Coding agents.** Nothing runs until at least one is configured
   and enabled. The add dialog detects installed CLIs. For each, tick the model
   providers it may use. *(A banner nags on every page until you do this.)*
2. **Repos → add a repository.** Path, base branch, and — this is the useful
   part — an optional **repo prompt** that is added to *every* run of that repo,
   plus `merge_mode`. Start with `merge_mode = off` (agents keep their work on
   their branch) and switch to `hub` once you trust the setup; `hub` is what
   turns "the agent says it is done" into "the work is on `main`".
3. **Start a single run.** Small, boring task, a repo you do not mind. Watch it
   in the browser terminal. This is the fastest way to learn what the system
   does — much faster than reading `AGENTS.md`.
4. **Then make it an agent**: same form plus a name and a schedule.
5. Optional: **Settings → Telegram** (setup assistant), **Settings → Favorites**
   (the setup half of a run under a name, feeds the Quick Run button in the
   header), **Settings → UI language** (English, 中文, Deutsch).

Nothing about the pipeline switch is subtle: `cchub pipeline off` stops
*scheduled* starts. Manual starts always work — a limit that overrules a
deliberate decision is a limit people work around.

---

## 5. Keeping your machine's values out of the repository

cc-hub is developed with a **private sister repository** that holds everything
machine- and operator-specific, and the public repo stays free of it. Copy the
pattern if you fork — it is small and it works:

- `CLAUDE.local.md` next to `CLAUDE.md`, **gitignored**: the real ports, the VPN
  address, hostnames, certificate paths. Claude Code loads both files, so your
  agent has the full picture while the public repo has none of it.
- `~/.config/cc-hub/env` — the only place API keys live. Never in the repo, and
  `chmod 600`.
- `~/.config/cc-hub/coding-agents.json` — an optional **seed**: on first start
  with an empty configuration, the hub creates your coding agents and providers
  from it. This is what makes a fresh machine reproducible.
- `pruefe-vor-push.sh` — a pre-push hook that greps the **committed** state for
  private IPs, home paths, key formats and Telegram tokens. Its generic patterns
  are in the script; the operator's own patterns live *outside* the repo, in
  `~/.config/cc-hub/verbotene-muster`, because a list of secret values is itself
  a list of secret values.

**As an agent working in this repository, treat that as binding**: no real
ports, addresses, hostnames, home paths or keys in any file you commit — the
code defaults in `env.example` are deliberately fictional. Run
`./pruefe-vor-push.sh` before you hand work back.

---

## 6. Make it yours

This is the part people skip, so it is in its own section: **you are encouraged
to change this project.** It was built for one operator's workflow and there is
no promise that it fits yours. Fork it, rip parts out, wire it to your own
tooling. The seams that were designed to be pulled on:

| You want to… | Pull on this seam |
|---|---|
| drive a coding agent CLI that is not supported | a new file in `server/harnesses/` + a `case` in `bin/cc-start` → [`docs/plugins.md`](docs/plugins.md) |
| use another model provider | a new file in `server/providers/` → same doc |
| change what every agent is told | Settings → **Platform prompt suffix** (added, never replacing the platform rules), or a **repo prompt** per repository |
| give agents an opt-in capability | drop a folder with a `SKILL.md` into `~/agents/zusaetze/` — it appears as a checkbox in the run forms. Deliberately *not* `.claude/skills`, so nothing loads automatically |
| do something after a run finishes or a merge lands | **no-code flows** — a graphical designer, no code needed: message running agents, start follow-up runs and wait, extract data from a report via LLM, branch, loop, Telegram, HTTP, shell command → [`server/flows/AGENTS.md`](server/flows/AGENTS.md) |
| change when a run is allowed to start | the budget gate + `repos.max_parallel` in `server/scheduler.mjs` |
| change a run that is not over | the "Edit this run" card on its detail page: the expected duration of a running run, plus the prompt and the repo of one that has not started yet — `server/run-edit.mjs` decides what a status allows |
| add a UI language | a new `lang/<code>.json` with the same keys, plus the language list — see `server/i18n.mjs` |

If your change is generally useful, **please open a pull request** — new harness
and provider plugins, translations, fixes and documentation are all very
welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## 7. Working *on* this repository — the rules that will bite you

If your task is to change cc-hub rather than just run it:

- **Project language is English.** Source, comments, docs, commit messages.
  (`lang/de.json` and `lang/zh.json` are the exception, obviously.) There is a
  subagent for this: `.claude/agents/english-enforcer.md`.
- **No hardcoded UI strings.** Everything goes through `t('key')` /
  `window.CCHUB_I18N`, and `lang/en.json`, `de.json`, `zh.json` must carry the
  same key set — a unit test fails otherwise. Subagent:
  `.claude/agents/i18n-checker.md`.
- **The README exists in three languages** (`README.md`, `README.zh-CN.md`,
  `README.de.md`) and they are maintained **together**. Same for this file's
  currency: if you change setup, prompts, flows or plugin contracts, update
  `SETUP_WITH_AGENT.md` in the same commit.
- **Every directory with an `AGENTS.md` has a `CLAUDE.md` next to it containing
  exactly one line: `@AGENTS.md`.** Never write content into a `CLAUDE.md` in
  this project — a unit test enforces both halves.
- **Run the tests.** `node test/unit.mjs` (~1 s) and `node test/e2e.mjs` (~40 s)
  at minimum; `test/browser.mjs`, `test/proxy.mjs` and `test/deploy.mjs` when
  you touched `public/hub.js`, `vpn-proxy.mjs` or `bin/cchub-deploy`. The e2e
  suite is sandboxed — its own port, database, repo and tmux sessions — so it is
  safe to run next to a live hub.
- **Read `AGENTS.md` before you get creative.** In particular the "Pitfalls"
  section: every entry there is an hour somebody already lost. tmux targets need
  a trailing colon, a branch belongs to exactly one worktree, `--no-optional-locks`
  is a git-level flag, a `<form>` closes an open `<p>`, and a green test only
  proves the path the test took.

---

## 8. Where to look — the file map

| Question | File |
|---|---|
| Everything, in depth (architecture, decisions, pitfalls) | `AGENTS.md` |
| What a run *is*; forms, validation, agent lifecycle | `server/run-def.mjs` |
| Starting a run, schedules, budget gate | `server/scheduler.mjs` |
| Worktrees, prompt assembly, session launch | `server/runner.mjs`, `bin/cc-start` |
| Reports coming back in | `server/reports.mjs`, `bin/cc-report` |
| Watching from the outside; anomalies | `server/watcher.mjs`, `server/detect.mjs` |
| Merging a finished run into the base branch | `server/integrate.mjs` |
| Rate limits / provider outages | `server/incidents.mjs`, `server/harnesses/patterns.mjs` |
| Coding agent + provider plugins | `server/harnesses/`, `server/providers/`, `docs/plugins.md` |
| No-code flows | `server/flows/` + its own `AGENTS.md` |
| Pages, sidebar, live channel | `server/pages.mjs`, `server/events.mjs`, `public/hub.js` |
| TLS proxy, HTTP/2, the network edge | `vpn-proxy.mjs`, `test/proxy.mjs` |
| Deploying, rollback, health check | `bin/cchub-deploy`, `test/deploy.mjs` |
| Schema, migrations, the one place events are written | `server/db.mjs` |
| UI strings | `server/i18n.mjs`, `lang/*.json` |

---

## 9. A short checklist you can actually follow

```
[ ] asked the human for: VPN bind, ports, allowed hosts, certs, CLIs, keys
[ ] prerequisites verified (node ≥ 22, tmux, git, jq, curl, wg, one agent CLI)
[ ] setup/01 → 02 → 03 run, output read, not just executed
[ ] ~/.config/cc-hub/env filled in by the human; certificates in place
[ ] setup/04-firewall.sh run (or handed to the human with the exact command)
[ ] cchub-deploy --init --from "$PWD"  →  cchub status  →  cchub on
[ ] reachability verified FROM A VPN CLIENT, not from the server
[ ] Settings → Coding agents configured; at least one repo added
[ ] one small single run started and watched end to end
[ ] no ports, addresses, hostnames or keys ended up in a commit
    (./pruefe-vor-push.sh is green)
```

Report what you did, what you could not do, and every value you had to ask
for — **never the values themselves.**
