# cc-hub

**English** · [中文](README.zh-CN.md) · [Deutsch](README.de.md)

**A web UI that runs your coding agents for you — scheduled, unattended, and
watched from the outside.** Claude Code, opencode, hermes and cursor-agent each
work in their own git worktree inside their own tmux session; cc-hub starts
them, watches them, collects their reports, merges their work and pings you on
Telegram when something needs you.

> ### 🤖 Setting it up? Let your agent do it.
> You already use a coding agent. Point it at
> **[SETUP_WITH_AGENT.md](SETUP_WITH_AGENT.md)** — a guide written *for* agents
> that explains the system, asks you the handful of questions it cannot guess,
> and installs it. *"Read SETUP_WITH_AGENT.md and set this up for me."*

```
Browser --https--> <wg-IP>:8790 --http--> 127.0.0.1:8791 --> tmux sessions
(via WireGuard)    vpn-proxy.mjs           server/hub.mjs      cc-<name>-<id>
                   cchub-vpn.service       cchub.service       cc-oc-/he-/cu-…
                   └─ both run from the deploy checkout ─┘
                      (~/agents/deploy/cc-hub, see below)
```

## Why you might want this

You have a coding agent that works well when you are sitting in front of it.
cc-hub is what you use when you are not:

- **Give it a task and walk away.** A run gets its own worktree and its own tmux
  session, so runs never step on each other and you can attach to any of them
  later and read the whole screen.
- **Schedule work.** "Every night at 2, look at the open issues." An *agent* is a
  saved run definition plus a name and a schedule; a *single run* is the same
  form without them.
- **Know when it went wrong — even when the agent can't tell you.** An agent
  that hit a rate limit cannot report anything, so the hub watches from outside:
  tmux state, logs, transcripts, hooks, provider pulse.
- **A finished run means the work is on `main`.** Optionally the hub does the
  merging itself, checks the run's claim before believing it, and sends the
  still-living agent back to fix what is missing.
- **One place for four CLIs — and for a fifth nobody here has heard of.** Which
  coding agents the hub may drive, and which model providers each may use, is a
  setting, not a code change; and a coding agent or provider that ships as a
  plugin package needs no change to this repository at all.

## What's in the box

- **A five-step Welcome wizard** on first visit: what is installed on this
  machine, the first coding agent, the first model provider, and which model
  answers the hub's own small questions. Skippable, and switchable off for good.
- **Coding agents and model providers are plugins** — claude, opencode, hermes,
  cursor and OpenRouter/DeepSeek/OpenCode Zen ship with it, and a **third party
  can drop a package on the machine** (`CCHUB_PLUGIN_DIR`) that joins them at
  startup. A plugin may bring its own API-key handling, its own budget-gate
  thresholds, and a launch declaration that lets the tmux starter run a CLI
  nobody here has ever heard of ([docs/plugins.md](docs/plugins.md)).
- **One Plugins page** (Settings → Plugins) installs, configures, enables and
  removes them, and shows what a startup scan found on the machine. A provider's
  key can live in an environment variable of your choosing — or be entered right
  there, for a machine where adding a variable is awkward.
- **The hub's own small questions** — naming a run, judging whether a log line is
  a real outage, reading a report, suggesting worktree extras — go to whichever
  model source you pick per job. That includes **a coding agent on a
  subscription you already pay for**, which is what lets the hub run useful with
  no API key anywhere.
- **Agents and single runs** from one form: coding agent, model, reasoning
  effort, prompt, repo, branch rule, schedule. A **Quick Run** button on every
  page starts one from a saved favorite in two fields.
- **Terminal in the browser** (xterm.js over WebSocket, read-only by default) —
  watch a run, type into it, answer a help call.
- **Reports** via `cc-report` (done / failed / help / progress / branch / pr),
  with an `inbox.jsonl` fallback when the hub is unreachable. A finished run
  can report again — type follow-up work into its session, and the agent's
  next `cc-report done` is merged, triggers the flows and reaches Telegram as
  a *follow-up report*. A checkbox under the terminal silences Telegram for a
  run you are watching anyway.
- **Integration**: the hub merges finished runs into the base branch itself,
  serially per repo, in a worktree of its own — dirty worktree, conflict or a
  failing merge check escalate to the agent first and to you only if it cannot
  fix it.
- **Incidents**: rate limits and provider outages are detected through several
  independent channels and raised once, not five times.
- **Subscription usage** — Claude's 5-hour and 7-day windows, Cursor's spend for
  the current cycle, OpenRouter and DeepSeek credits — in the sidebar of every
  page, and a **budget gate** that defers starts before they burn into an empty
  quota. What a run draws from decides which gate is asked, and only that:
  Claude's general week gates every claude run, a per-model week only the runs
  on that model, a cursor run the cursor period usage, a DeepSeek run its own
  balance. Each gate is **optional** with its own threshold (Settings → Budget
  gates), and a deferred run can be **started anyway** from its detail page.
  The same sidebar says what every tmux session on the machine costs in
  memory, re-measured every eight minutes: a session outlives its agent on
  purpose, so that bill runs quietly. A configurable **tmux cleanup agent**
  (Settings → tmux cleanup, the same agent+provider+model selection as the run
  forms) ends the oldest inactive sessions when the memory exceeds a threshold,
  down to a target you choose — or on demand, from the sidebar's tmux block and
  from a box on the Sessions page.
- **No-code flows**: a graphical designer for what happens after a run — message
  running agents, start follow-up runs and wait for them, extract structured
  data from a report via LLM, branch, loop, Telegram, HTTP, shell command
  ([server/flows/AGENTS.md](server/flows/AGENTS.md)).
- **Telegram** notifications with a link straight to the run.
- **Multilingual UI**: English (default), 中文, Deutsch — Settings → UI language.
- **One clock and one number format**: every time — sidebar included — is shown
  in the timezone chosen under Settings → Time and numbers (auto: German →
  Europe/Berlin, Chinese → Asia/Shanghai, English → the server's timezone);
  numbers and percentages use the UI language's separators.

## Security model — please read this one

The hub can control tmux. **That is shell access.** So:

- `server/hub.mjs` binds **firmly to `127.0.0.1`**; there is no direct path from
  the network.
- In front sits `vpn-proxy.mjs` (TLS), which binds **exclusively to your own
  WireGuard address**. `CCHUB_VPN_BIND` is mandatory — there is deliberately no
  default. **WireGuard is the auth layer; cc-hub has no login of its own.**
- Host allowlist + origin check (`CCHUB_ALLOWED_HOSTS`) fence off DNS rebinding
  and CSRF; `Sec-Fetch-Site: cross-site` is rejected.
- **Fail-closed**: `cchub-vpn.service` deliberately does *not* start after a
  reboot (`cchub on` enables access), and `setup/04-firewall.sh` allows the VPN
  port only on `wg0`, denying it everywhere else.

**Never run the hub in a reachable network without these layers.**

## Installation

Prerequisites: Linux with systemd (user units), Node.js ≥ 22 (`node:sqlite`),
tmux, git, jq, curl, a WireGuard interface, and at least one agent CLI
(`claude`, `opencode`, `hermes`, `cursor-agent`) on the `PATH`. Certificates
e.g. with [mkcert](https://github.com/FiloSottile/mkcert).

```bash
./setup/01-npm-install.sh       # node-pty, ws, xterm.js — for THIS checkout (tests, editing)
./setup/02-install-scripts.sh   # cc-start/-attach/-kill/-help/-report + cchub + cchub-deploy → ~/.local/bin
./setup/03-install-services.sh  # ~/.config/cc-hub/env (from env.example) + systemd units
sudo ./setup/04-firewall.sh     # ufw: VPN port only on wg0 (one-time)
```

Then set at least `CCHUB_VPN_BIND` and `CCHUB_ALLOWED_HOSTS` in
`~/.config/cc-hub/env` (see [`env.example`](env.example)), place the
certificates, and bring the first version live:

```bash
cchub-deploy --init --from "$PWD"   # clones into ~/agents/deploy/cc-hub, deploys it
cchub status                        # hub process, VPN access, pipeline, sessions, deployed sha
cchub on                            # start the VPN proxy → reachable over WireGuard
```

**First thing in the UI:** a **Welcome wizard** — the first visit to `/` lands
there. It walks through what is installed on the machine, your first coding
agent, your first model provider and the model that answers the hub's own small
questions; "Do not show this again" retires it. Everything it does is also
reachable later under **Settings → Plugins**, where a banner points on a fresh
install. An optional seed file `~/.config/cc-hub/coding-agents.json`
pre-populates the coding agents on first start, which is what makes a scripted
setup reproducible.

> Verify reachability **from a VPN client**, never with `curl` on the server
> itself: that request travels over `lo` and says nothing about your firewall.

### Bringing a version live

The systemd units start `~/agents/deploy/cc-hub` — a clone that belongs to the
hub alone, always detached on one commit. The checkout you work in never runs a
service, so uncommitted work can never end up being served.

```bash
cchub deploy            # fetch, check out origin/main, deps (only if the lockfile moved),
                        # reinstall the cc-* scripts, restart, health check — rollback if it fails
cchub deploy <ref>      # that commit instead
cchub-deploy --status   # deployed sha, origin sha, how far behind
cchub-deploy --rollback # back to the previously deployed commit
```

A failed deploy rolls back to the commit that was running and tells you on
Telegram. The running sha is printed in the sidebar of every page, so *"is my
change live?"* is a glance. `cchub restart` stays what it says — a restart,
without a deploy.

## Tests

```bash
node test/unit.mjs          # pure logic (cron, schedules, quota gate, parsers, registries, i18n, docs) — ~1 s
node test/e2e.mjs           # complete hub in a sandbox, stub instead of real agents — ~40 s
node test/e2e.mjs --echt    # additionally ONE real run per harness (consumes quota)
node test/browser.mjs       # public/hub.js in a real Chromium — ~10 s (needs playwright)
node test/proxy.mjs         # vpn-proxy.mjs against a stub upstream — <1 s
node test/deploy.mjs        # bin/cchub-deploy against a bare origin — ~3 s
```

The e2e suite starts a second hub on a free port with its own database, test
repo and `cc-start` stub — it touches neither production data nor foreign tmux
sessions, so it is safe to run next to a live hub.

## Make it yours

cc-hub is one operator's workflow turned into code, published because it might
save you a month. **Fork it, change it, rip parts out.** The seams meant to be
pulled on: **coding agent and model provider plugins — including packages that
live outside this repository entirely**, the platform prompt suffix, per-repo
prompts, opt-in extra skills in `~/agents/zusaetze/`, the model source behind
the hub's own questions, and the no-code flows.
[SETUP_WITH_AGENT.md](SETUP_WITH_AGENT.md) has the table;
[docs/plugins.md](docs/plugins.md) has the plugin contract in full.

## Contributing

**Pull requests are very welcome** — bug reports, plugin files for further
coding agents or providers, translations, documentation fixes alike. The ground
rules and the pre-submit checklist are in [CONTRIBUTING.md](CONTRIBUTING.md).

Developer knowledge — architecture decisions, harness quirks, and a long list of
pitfalls that already cost somebody an afternoon — lives in
[AGENTS.md](AGENTS.md), written for humans **and** coding agents.

## License

[CC BY 4.0](LICENSE) — use it, change it, ship it commercially. Just give
credit: name **Herbert Walde**, link back to
<https://github.com/hwalde/cc-hub>, link the license, and say if you changed
something.
