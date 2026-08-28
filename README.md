# cc-hub

Web UI for managing autonomous coding agents — **claude** (Claude Code),
**opencode**, **hermes** and **cursor** (cursor-agent). Agents run in tmux
sessions, every run in its own git worktree. The hub schedules runs
(cron/schedules), observes them, collects reports and notifies via Telegram.

```
Browser --https--> <wg-IP>:8790 --http--> 127.0.0.1:8791 --> tmux sessions
(via WireGuard)    vpn-proxy.mjs           server/hub.mjs      cc-<name>-<id>
                   cchub-vpn.service       cchub.service       cc-oc-/he-/cu-…
                   └─ both run from the deploy checkout ─┘
                      (~/agents/deploy/cc-hub, see below)
```

## What it does

- **Coding agents as plugins**: which CLIs the hub may drive — and which model
  providers each of them may use — is configured in the UI (Settings → Coding
  agents). The add dialog detects installed CLIs. New coding agents and
  providers are single plugin files ([docs/plugins.md](docs/plugins.md)).
- **Agents** as saved definitions (coding agent, model, reasoning effort,
  prompt, repo, schedule) — scheduled runs start automatically, single runs via
  a form.
- **Subscription usage** of Claude Code (5-hour/7-day windows) and Cursor
  (spent USD of the current cycle) directly in the overview, plus OpenRouter
  credits.
- **Outside-in observation**: tmux state, pipe-pane logs, harness transcripts
  and hooks. Rate limits and provider outages are detected even when the agent
  itself can no longer report (per-plugin log patterns, provider pulse,
  optional check LLM via OpenRouter).
- **Terminal in the browser** (xterm.js over WebSocket, read-only by default) —
  watch, push text in, answer help calls.
- **Reports**: agents report back via `cc-report` (done / failed / help /
  progress / branch / pr); fallback `inbox.jsonl` when the hub is unreachable.
- **Telegram**: notification on completion, help call, anomaly — with a link to
  the detail page (setup assistant in the settings).
- **No-code flows**: a graphical designer chains what happens after a run — send
  a message to running agents, start follow-up runs and wait for them, extract
  structured data from a report via LLM, branch, loop over a list, Telegram/HTTP.
  Flows are attached to an agent or a single run in its own form (optionally
  only for a certain outcome) and all start in parallel when that run ends
  ([server/flows/AGENTS.md](server/flows/AGENTS.md)).
- **Quota gate**: scheduled starts wait when the Claude subscription quota or
  the OpenRouter credits run low.
- **Multilingual UI**: English (default), German, Chinese — Settings → UI
  language; translations live in `lang/*.json`.

## Security model

The hub can control tmux — that is shell access. Therefore:

- `server/hub.mjs` binds **firmly to 127.0.0.1**; there is no direct path from
  the network.
- In front sits `vpn-proxy.mjs` (TLS), which binds **exclusively to the own
  WireGuard address** — `CCHUB_VPN_BIND` is mandatory, there is deliberately no
  default. WireGuard is the auth layer; there is no own login.
- Host allowlist + origin check (`CCHUB_ALLOWED_HOSTS`) as a fence against DNS
  rebinding and CSRF; `Sec-Fetch-Site: cross-site` is rejected.
- **Fail-closed**: `cchub-vpn.service` deliberately does not start automatically
  after a reboot (`cchub on` enables access); the ufw rules from
  `setup/04-firewall.sh` allow the VPN port only on `wg0` and deny it everywhere
  else.

**Never operate the hub without these layers in a reachable network.**

## Installation

Prerequisites: Linux with systemd (user units), Node.js ≥ 22 (`node:sqlite`),
tmux, git, jq, curl; at least one agent CLI (`claude`, `opencode`, `hermes` or
`cursor-agent`) on the PATH. Certificates e.g. with
[mkcert](https://github.com/FiloSottile/mkcert).

```bash
./setup/01-npm-install.sh       # node-pty, ws, xterm.js — for THIS checkout (tests, editing)
./setup/02-install-scripts.sh   # cc-start/-attach/-kill/-help/-report/-oc-sync-agents + cchub + cchub-deploy to ~/.local/bin
./setup/03-install-services.sh  # ~/.config/cc-hub/env (from env.example) + systemd units
sudo ./setup/04-firewall.sh     # ufw: VPN port only on wg0 (one-time)
```

Then set at least `CCHUB_VPN_BIND` and `CCHUB_ALLOWED_HOSTS` in
`~/.config/cc-hub/env` (see `env.example`), place the certificates, then create
the checkout the **service** runs from and bring the first version live:

```bash
cchub-deploy --init --from "$PWD"   # clones origin into ~/agents/deploy/cc-hub, deploys it
cchub status                        # hub process, VPN access, pipeline, sessions, deployed sha
cchub on                            # start the VPN proxy → website reachable over WireGuard
```

### Bringing a version live

The systemd units start `~/agents/deploy/cc-hub` — a clone that belongs to the
hub alone, always detached on one commit. The checkout you work in never runs a
service, so uncommitted work can never end up being served, and a restart can
never quietly load the state from before the last merge.

```bash
cchub deploy            # fetch, check out origin/main, deps (only if the lockfile moved),
                        # install the cc-* scripts, restart, health check — rollback if it fails
cchub deploy <ref>      # that commit instead
cchub-deploy --status   # deployed sha, origin sha, how far behind
cchub-deploy --rollback # back to the previously deployed commit
```

A failed deploy rolls back to the commit that was running and reports it via
Telegram. The running sha is printed in the sidebar of every page, so "is my
change live?" is a glance. `cchub restart` stays what it says: a restart, without
a deploy.

First step in the UI: add your coding agents under **Settings → Coding
agents** (a banner points there on a fresh installation). An optional seed file
`~/.config/cc-hub/coding-agents.json` pre-populates this on first start — handy
for scripted setups.

## Tests

```bash
node test/unit.mjs          # pure logic (cron, schedules, quota gate, parsers, plugin registries, i18n, docs) — ~1 s
node test/e2e.mjs           # complete hub in a sandbox, stub instead of real agents — ~30 s
node test/e2e.mjs --echt    # additionally ONE real run per harness (consumes quota)
node test/proxy.mjs         # the TLS proxy against a stub upstream — <1 s
node test/deploy.mjs        # bin/cchub-deploy against a bare origin, in a sandbox — ~3 s
```

The e2e suite starts a second hub on a free port with its own database, test
repo and `cc-start` stub — it touches neither production data nor foreign tmux
sessions.

## Contributing

**Contributions are very welcome!** Bug reports, plugin files for further
coding agents or providers, translations and documentation fixes alike — please
open an issue or pull request.

A few ground rules:

- Project language is **English** (source, comments, docs, commit messages).
- UI strings go through i18n (`lang/en.json` + `de.json` + `zh.json` — keys must
  stay in sync; a unit test enforces it).
- New coding agents/providers are plugins — see
  [docs/plugins.md](docs/plugins.md). Please don't hardcode harness specifics
  elsewhere.
- Run `node test/unit.mjs && node test/e2e.mjs` before submitting.
- No machine-specific values (real ports, hostnames, keys) in the repo —
  `./pruefe-vor-push.sh` checks the commit state before every push.

Developer knowledge (architecture decisions, harness quirks, known pitfalls)
lives in [AGENTS.md](AGENTS.md) — written for humans **and** coding agents
(`CLAUDE.md` simply includes it).
