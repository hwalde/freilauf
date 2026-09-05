# Setting up Freilauf — a guide written for coding agents

**You are a coding agent (Claude Code, opencode, cursor-agent, …) and someone
asked you to install, understand or adapt Freilauf. This file is for you.**

Humans: hand this file to your agent — *"read SETUP_WITH_AGENT.md and set this
up for me"* — and answer the handful of questions it will ask. Everything here
is also readable by a human, it is just written for the reader who can run the
commands.

This document is deliberately short on internals. When you need those, the map
at the end tells you which file to open. Two rules before anything else:

- **Never invent machine-specific values.** Ports, IP addresses, hostnames,
  certificate paths and API keys are things you *ask the human for* — see
  [Questions for the human](#2-questions-for-the-human).
- **Adapt this project.** Freilauf is one operator's opinions turned into code.
  It is a starting point, not a product with a support contract — see
  [Make it yours](#make-it-yours).

---

## 1. The mental model — read this before running anything

Freilauf is a **web UI that runs other coding agents for you**, unattended.
Six facts and you can reason about the whole system:

1. **A run is one agent working on one task.** It gets its own **git worktree**
   under `~/agents/worktrees/` and its own **tmux session** — so several runs
   never collide, and you can attach to any of them and watch.
2. **An agent and a single run are the same thing.** They share one *run
   definition* (coding agent, provider, model, effort, prompt, branch rule, …).
   An "agent" is just a run definition that also has a name and a schedule.
   This lives in `server/run-def.mjs`, and there is exactly one way from a
   definition to a running run: `startRun()` in `server/scheduler.mjs`.
 3. **The agent reports back with `bin/fl-report`** (`done`, `failed`, `help`,
    `progress`, `branch`, `pr`). The hub also watches from the outside — tmux
    state, logs, transcripts, hooks — because an agent that hit a rate limit
    cannot report anything. A run that is already over can report **again**:
    the operator types follow-up work into the agent's session, the agent runs
    `fl-report done` once more, and the hub treats it as a *follow-up report* —
    same checks, same merge, same flows, announced as "FOLLOW-UP REPORT #n". The
    prompt tells the agent so (`FOLLOWUP_RULES` in `server/runner.mjs`).
 4. **A report has a short and a detailed half.** The prompt asks the agent for
    two files: a *short* report (what the task was and the result, compact, in
    simple language) that becomes the notification **text**, and a *detailed*
    report (the full write-up, also in simple language) that travels as the
    attached **document** (`fl-report done --file … --detail …`). Both optional:
    a run without a detail behaves exactly as before, and the document then
    carries the full report again.
4. **The hub does the merging, not the agent** (when a repo is set to
   `merge_mode = hub`). A run is `done` when its work is on the base branch.
   If the worktree is dirty or the merge conflicts, the still-living agent is
   told to fix it, and only then a human. `server/integrate.mjs`.
5. **Coding agents and model providers are plugins** — built-ins under
   `server/harnesses/` and `server/providers/`, external packages in
   `FREILAUF_PLUGIN_DIR` (default `~/.local/share/freilauf/plugins`), loaded at
   startup. A plugin may bring its own credentials, its own budget-gate
   thresholds, the ability to answer the hub's own small questions, and a
   `launch` declaration that lets `bin/fl-start` start a CLI nobody shipped
   here. Adding support for a new CLI is adding a package, not editing ten call
   sites. [`docs/plugins.md`](docs/plugins.md). One provider plugin may also
   declare **best-provider routing**: for OpenRouter the form can select the
   serving provider automatically (quantization, region and price requirements,
   cached per model) instead of pinning one tag by hand.
6. **The service runs from its own checkout** (`~/agents/deploy/freilauf`), never
   from the directory a human edits in. `freilauf deploy` moves it forward, health
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
| **Which WireGuard address should the UI bind to?** (`FREILAUF_VPN_BIND`) | There is deliberately no default. Without a value the proxy refuses to start — that is the fence against ending up on `0.0.0.0`. |
| **Which two ports?** (`FREILAUF_VPN_PORT`, `FREILAUF_LOCAL_PORT`) | The values in `env.example` are placeholders. Pick something free and unremarkable. |
| **Which hostnames may address it?** (`FREILAUF_ALLOWED_HOSTS`) | Rebinding/CSRF fence. Only the VPN IP and names whose DNS the operator controls. Every name must also be in the certificate. |
| **Do certificates exist, or should you create them?** | `~/.local/certs/freilauf/dev-cert.pem` + `dev-key.pem`, e.g. via [mkcert](https://github.com/FiloSottile/mkcert), SANs = the VPN IP and any hostname above. |
| **Which coding agent CLIs are installed and licensed?** | `claude`, `opencode`, `hermes`, `cursor-agent` — the hub only offers what the operator configures. |
| **Which API keys, if any?** | `OPENROUTER_API_KEY` etc. **Ask for them to be pasted into `~/.config/freilauf/env` by the human** — or, if that machine makes environment variables awkward, let the human enter them in the UI under Settings → Plugins. Do not read them, echo them, or put them in a commit, a log or your report. |
| **Any external plugin packages to install?** (`FREILAUF_PLUGIN_DIR`) | Optional. Default `~/.local/share/freilauf/plugins`; a missing directory is the normal case. Only set it if the human already has packages somewhere else. |
| **Notifications?** | **Optional, and nothing depends on them.** Freilauf runs fully with no channel configured — it schedules, watches, merges and records exactly the same, it just stays quiet. If the human does want one, it is set up in the UI afterwards (Settings → Notifications), and any credential it needs is entered there, not by you. |

If the human does not know, say what the value is *for* and offer the safe
default (VPN-only, fail-closed). Do not proceed on a guess for
`FREILAUF_VPN_BIND` or `FREILAUF_ALLOWED_HOSTS`.

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
./setup/02-install-scripts.sh   # fl-* + freilauf + freilauf-deploy → ~/.local/bin, opencode plugin, hermes hooks, extra skills
./setup/03-install-services.sh  # ~/.config/freilauf/env (from env.example) + systemd user units + enable-linger
```

The second script also installs what the coding agents need to tell the hub
whether they are working or waiting for input (`docs/plugins.md`, "Attention"):
the opencode plugin under `~/.config/opencode/plugins/`, and two shell hooks it
**appends** to `~/.hermes/config.yaml` when that file has no `hooks:` block yet.
If it already has one, the script prints the two entries to merge by hand and
changes nothing — a config full of the operator's comments is not a file a
script rewrites. Claude and cursor need nothing installed: their hooks travel
with every run.

The third script installs **three** user units — the hub, the VPN proxy and
`freilauf-tmux.service`, the tmux server every agent session lives in — and
runs `loginctl enable-linger` for the user. Both matter for a machine nobody
logs into: without lingering a user's units start at the first *login*, not at
boot, and without the tmux unit the first run after a reboot would spawn the
tmux server inside the hub's own cgroup. If `enable-linger` fails (it needs no
root, but some systems restrict it), print the command and let the human run it.

Now **the human edits `~/.config/freilauf/env`** with the answers from section 2
(at minimum `FREILAUF_VPN_BIND` and `FREILAUF_ALLOWED_HOSTS`) and places the
certificates. API keys may go in the same file, or be entered in the UI later
(Settings → Plugins) — the hub resolves a stored value first, then a variable
the operator named, then the plugin's own declared variables. External plugin
packages, if any, go into `FREILAUF_PLUGIN_DIR` (default
`~/.local/share/freilauf/plugins`, created by nobody — a missing directory is
normal); `--spec`-launched coding agents need `jq`, which is already a
prerequisite. Then the firewall, which needs root:

```bash
sudo ./setup/04-firewall.sh     # ufw: the VPN port only on wg0, denied everywhere else
```

If you cannot run `sudo`, print the command and let the human run it. Say so
rather than skipping it — without this rule the port is only protected by the
bind address.

Finally, create the checkout the **service** runs from and bring it live:

```bash
freilauf-deploy --init --from "$PWD"   # clone into ~/agents/deploy/freilauf and deploy it
freilauf status                        # hub process, VPN access, pipeline, sessions, deployed sha
freilauf on                            # start the TLS proxy → reachable over WireGuard
```

**Verify from a VPN client, not from the server.** `curl` against the VPN IP
from the machine itself travels over `lo` and proves nothing about the
firewall. This is a real trap and it is in `AGENTS.md` under "Pitfalls".

Troubleshooting, in the order that pays off: `freilauf status` → `freilauf logs` →
`systemctl --user status freilauf.service`. A hub that will not start is almost
always a missing value in `~/.config/freilauf/env` or a missing certificate.

### Optional: the sandbox

**Skip this section unless the human asked for it.** Freilauf can run a run's
agent inside a container. It is **off by default**, a container runtime is a
prerequisite **only if you want it**, and an installation that never switches it
on behaves exactly as described above. Do not install Docker "to be safe".

If the human does want it, on Ubuntu 24.04 — **the hub never runs `sudo`, so the
first line is one you print and hand over, and the rest run as the hub's own
user:**

```bash
sudo apt-get install -y docker.io uidmap dbus-user-session   # give this to the human
dockerd-rootless-setuptool.sh install
systemctl --user enable --now docker.service
loginctl enable-linger "$USER"      # already done by setup/03, harmless twice
docker info | grep -i rootless
```

**`DOCKER_HOST` does not have to be set, and here is why it is worth setting
anyway.** `dockerd-rootless-setuptool.sh` does not export anything — it creates a
docker *context*, which the CLI reads out of `$HOME/.docker`. So the CLI finds
the rootless daemon only while `HOME` is set, and a library that reads no
contexts (any Docker client for Node, Python or Go) falls back to
`/var/run/docker.sock` — which on such a host still EXISTS as a file, refuses
with `EACCES` because nobody is in the `docker` group, and therefore looks like a
broken daemon rather than like the wrong one. The hub does not depend on any of
that: it resolves `$XDG_RUNTIME_DIR/docker.sock` itself, checks that something
answers there before it believes a `docker` on the `PATH`, and hands the same
endpoint to every command it runs. Setting it makes the same answer true for
every other tool on the machine, including a shell you debug in — one line in
`~/.config/freilauf/env` (**print it for the human; the file is theirs**):

```
DOCKER_HOST=unix:///run/user/1000/docker.sock
```

with `1000` replaced by `id -u` of the hub's user. Do not point it at
`/var/run/docker.sock` on a rootless installation. The hub resolves the endpoint
itself and hands it to the container client it starts in the run's tmux pane, so
a run does not depend on this line — it is for the human's own `docker` and for
anything else on the machine. (It did depend on it until 2026-09-05: the pane
inherits nothing of what the hub resolved and fell back to the rootful socket,
which on a rootless installation is absent or unreadable, so the pane died half
a second after the start and that one permission error was the whole run log.)

**What such a host can and cannot fence.** Rootless Docker enforces only the
cgroup controllers systemd delegated to the user; measured on Ubuntu 24.04 that
is `cpu memory pids` — so `--memory`, `--pids-limit` and `--cpus` (the three the
shipped profiles use) hold, while `cpuset` and io limits would be **refused**.
The hub reads both the delegation file and `docker info`'s own `CPUSet` /
`MemoryLimit` / `PidsLimit` / `CpuCfsQuota` flags and reports them under
**Settings → Sandbox**; a limit that is not listed there is one this host cannot
apply, whatever a profile says.

**AppArmor:** Ubuntu 24.04 sets
`kernel.apparmor_restrict_unprivileged_userns = 1`, and rootless Docker works
under it anyway because the distribution ships
`/etc/apparmor.d/rootlesskit` (`flags=(unconfined)` with a `userns,` rule).
Nothing needs to be installed for the container boundary. Do not diagnose this
with `aa-status`: as an ordinary user it prints "You do not have enough
privilege to read the profile set" and still **exits 0**. And note that under a
rootless daemon containers carry **no AppArmor confinement at all** — the
boundary there is the user namespace, seccomp, `--cap-drop ALL` and
`no-new-privileges`, not a container profile.

**Under a rootless daemon the container runs as uid 0, and that is correct.**
Container root *is* the hub user on the host through the subuid map, so files
the agent writes come out owned by the operator and git's `safe.directory` check
never fires. Pass no `--user` there (the hub does not) and do not "fix" this
with a non-root image: a container user of 1000 maps to host `100999` and cannot
write into the run's own directories at all [measured].

**Recommend rootless, and say why.** With rootful Docker, membership of the
`docker` group is equivalent to root on the host — anything that can talk to that
socket can mount `/` into a privileged container, and the hub talks to that
socket. Rootless keeps the daemon in the hub user's own namespace, so a container
escape lands in the uid the agent was already running as without a sandbox.
Rootful works; it just puts the `docker` group in the threat model.

**Then tell the human the one thing that will otherwise bite them.** Under a
rootless daemon, **`network.mode: allowlist` with the built-in proxy engine
cannot work** — the hub's listener would have to bind the run network's gateway,
and rootlesskit keeps every bridge in a network namespace of its own
(`--detach-netns`), so that address does not exist on the host. Measured three
ways on 2026-09-05; the account is in `docs/sandbox.md` under *"The built-in
proxy engine does not work under a rootless daemon"*. The hub now **does**
detect the combination — the launch refuses with the cause and the ways out, and
Settings → Sandbox says the same next to the engine picker — but the profile
editor does not warn while you are writing one, so pass the consequences on
anyway:

- three of the four shipped profiles — **Balanced**, **Locked down** and
  **Audit** — ask for exactly that combination, so on a rootless daemon they
  fail at launch, now with a message that names the cause;
- the profile that works there today is **Open network** (`mode: open`), and
  `mode: none` works too;
- an enforced allowlist on a rootless daemon needs `engine: iron-proxy`, whose
  proxy is a container — the right shape, and a binary that exists on no machine
  here and has never been run. Do not switch a profile to it on somebody's
  behalf;
- a **rootful** daemon does not have this problem, at the cost above.

### What has to be true, and how to check each

The two setup scripts this installation was built with live in the operator's
`$HOME`, not in this repository, so there is nothing here to run. This is what
they establish; check each one, print what you found, and hand the root steps to
the human:

| What has to be true | How to check it | If it is not |
|---|---|---|
| rootless Docker installed for the hub's user | `docker version --format '{{.Server.Version}}'` | `sudo apt-get install -y docker.io uidmap dbus-user-session` (human), then `dockerd-rootless-setuptool.sh install` as the hub user |
| the daemon is really the **rootless** one | `docker info --format '{{json .SecurityOptions}}'` contains `name=rootless` | you are talking to a rootful daemon or to nothing; check `DOCKER_HOST` |
| the socket answers | `test -S "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/docker.sock"` and `docker info >/dev/null` | the user unit is not running: `systemctl --user status docker.service` |
| it survives a reboot with nobody logged in | `systemctl --user is-enabled docker.service` → `enabled`, and `loginctl show-user "$USER" -p Linger` → `Linger=yes` | `systemctl --user enable --now docker.service`; `loginctl enable-linger "$USER"` (`setup/03` already does the second) |
| subuid/subgid ranges exist for the hub user | `grep "^$USER:" /etc/subuid /etc/subgid` | a root step: `sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 "$USER"` |
| unprivileged user namespaces are permitted | `docker run --rm alpine true` succeeds | on Ubuntu 24.04 the distribution's `/etc/apparmor.d/rootlesskit` is what permits it; if it is missing, that is the root step |
| the cgroup controllers the profiles need are delegated | `cat /sys/fs/cgroup/user.slice/user-$(id -u).slice/cgroup.controllers` contains `cpu memory pids` | a `/etc/systemd/system/user@.service.d/delegate.conf` drop-in, which is a root step. Without them `--memory`/`--cpus`/`--pids-limit` are refused |
| `DOCKER_HOST` agrees with all of the above | `echo "$DOCKER_HOST"` | print the line above for the human to put in `~/.config/freilauf/env`. The hub does not need it; every other tool does |

Two checks that look right and are not, so do not use them: **`aa-status
--enabled`** exits **0** as an ordinary user with no output at all, which says
only that the module is loaded and nothing about containers (under a rootless
daemon containers are unconfined, and `--security-opt apparmor=…` is accepted
and ignored); and **`docker network inspect --format '{{.Gateway}}'`** on an
isolated internal network prints the literal string `invalid IP` rather than an
empty value, so a correctly isolated network read that way looks broken.

Then, in the UI: **Settings → Sandbox**. The page prints what it found and
**refuses to be switched on above `off` while it has found nothing** — that
refusal is enforced in the save, so do not try to work around it. Build the
shipped images from that page, or by hand as `sandbox/images/README.md`
describes. The base image **does** build and real containers have been run from
it (that is what the mount set, the resource fences and the network modes were
measured in). The layer above is proven for **exactly one** coding agent:
**opencode has done a whole run in its image** — work committed, reported and
merged into `origin/main`, on 2026-09-05, under a rootless daemon with
`network.mode: open`. **claude, cursor and hermes have never had their CLI
started in a container**, so building one of those images successfully does not
yet mean a run in it will work. `sandbox/images/README.md` is the file that
tracks the per-image state and what is unverified about each; believe it over
any summary, and expect the first real sandboxed run of each remaining harness
to be the thing that finds the mistakes in its layer — the first opencode one
found five, all of which the test suite had reported green, because a `docker`
shim cannot say whether an account exists inside an image or whether a mount
point came out a socket.

**Verify a policy before a real run depends on it.** The whole container command
line is produced by one pure function and can be printed without a runtime:

```bash
sandbox/wrap.sh --print ~/agents/runs/<run id>/sandbox.json -- bash
```

and the **Dry run** button under a repo's form resolves that repo's policy and
shows what it would do, without starting an agent.

Two things to tell the human rather than let them find out: all four shipped
profiles pass credentials into the container as environment variables, and the
mode that keeps the keys out of it (`secrets: inject`, through `iron-proxy`) is
**built but has never been run against the real binary** — do not switch a
profile to it on their behalf. And the sandbox decides on hostnames and inspects
no content, so an allowed host is a way out. Both, and
everything else it does not do, are in **[docs/sandbox.md](docs/sandbox.md)**;
what a coding-agent plugin has to declare to be sandboxable is in
**[docs/plugins.md](docs/plugins.md)**.

### Restarts, reboots and OS updates

The hub survives its own restarts (every deploy is one): agent sessions live
in the tmux unit, not in the hub's, and everything the hub was waiting on —
deferred and planned runs, the finish gate, pending goals, waiting flows — is
in the database and is picked up within seconds of a start. A **server
reboot** ends every tmux session; the hub then **resumes** every run that was
still working, in a new session (claude, cursor and opencode continue their
conversation, hermes is started afresh with its task and told what it had
already committed), and catches up the cron and weekly slots the downtime
swallowed (Settings → "Catch up missed schedule slots", default 6 hours).
Details: `AGENTS.md`, "Surviving restarts".

So the rules for the machine are short. Unattended package upgrades are fine
and need nothing from you — they do not kill user processes. Leave
`Unattended-Upgrade::Automatic-Reboot` **off**. When a reboot is due (a kernel
update), run **`freilauf drain [minutes]`** first: it switches the pipeline
off, tells every running agent in its own session to commit and report within
the window, and waits until nothing is working any more; then reboot, and
`freilauf undrain` afterwards. Never stop `freilauf-tmux.service` by hand — that
IS the reboot for the agents.

One more tmux setting is worth leaving alone: `set-clipboard` (default
`external`). It is what makes tmux hand a copied selection to its client, and
that is how marking text in the browser terminal ends up in the operator's
clipboard. With `set-clipboard off` in somebody's `~/.tmux.conf` that path is
gone and only Shift+drag still copies. The hub does not touch the option — it
is a tmux **server** option and therefore the operator's, not ours.

### Upgrading an installation that still says cc-hub

This project was called **cc-hub** until recently, and everything about it was
named accordingly: `~/.config/cc-hub`, `~/.local/share/cc-hub/cc-hub.db`,
`~/agents/deploy/cc-hub`, `cchub.service`, the `CCHUB_*` variables, the
`cc-start`/`cc-report`/… scripts, `CC_RUN_ID` inside a run, and `cc-` as the
tmux session prefix.

**Nothing forces you to change any of it.** The code released under the new name
reads both: every path resolves new-then-old, every variable
`FREILAUF_X`-then-`CCHUB_X`, `~/.local/bin` keeps a shim under every old script
name, sessions of both prefixes are listed and attachable, and the deploy script
restarts whichever unit is really running. A deploy onto an un-migrated
installation is an ordinary deploy.

When you want the names to match, that is one command:

```bash
freilauf-deploy --migrate --dry-run   # prints every step, changes nothing
freilauf-deploy --migrate             # or: ./setup/migrate-from-cc-hub.sh
```

It stops the old services, moves the three directories (rewriting `CCHUB_` →
`FREILAUF_` inside `env` and keeping a backup), renames the database and the
deploy log, repoints the deploy checkout's `origin` at
`github.com/hwalde/freilauf`, installs and enables `freilauf.service`, removes
the old unit files, rewrites `cchub-deploy` inside stored flows, deletes the old
opencode plugin file, reinstalls the scripts and starts the hub — switching VPN
access back on only if it was on. It is idempotent, and it refuses rather than
merges if it finds both an old and a new directory.

It does **not** touch `~/agents/runs`, `~/agents/worktrees`, `~/agents/integrate`
or `~/agents/zusaetze` (those were never named after the product), your own
checkout, or the hub's repository row called `cc-hub` — that row is your
checkout, and its name is yours. It prints what is left for you at the end.

---

## 4. First five minutes in the UI

The hub starts empty on purpose, and the first thing a browser sees says so:

0. **The Welcome wizard.** `GET /` redirects to `/welcome` — six server-
   rendered steps that walk through what is installed on this machine, the first
   coding agent, the first model provider, the source for the hub's own small
   questions and whether to install Freilauf's own agent skills. During the first walkthrough the only way out is the "Leave the
   setup for now" card on step 1 (a session answer). Afterwards `/welcome` is an
   ordinary page: every step carries a **"Do not show this again"** checkbox
   that switches the greeting off for good, and next to the primary button a
   "Save and back to Freilauf" that stores the checkbox on the way out — the
   ways off the page are submits of the form the box is in, never links beside
   it. Nothing in it can create a state the rest
   of the hub chokes on — it writes through the same functions the Plugins page
   uses — so the fastest correct path is to answer it rather than skip it.
1. **Settings → Plugins** (`/settings/plugins`; the old Settings → Coding agents
   URL redirects here). Nothing runs until at least one coding agent is
   configured and enabled. One card per coding agent — enabled switch, install
   state, and the model providers it may use — one per model provider, and the
   external packages with their versions and any load errors. This is also where
   a provider gets a credential without touching the environment: either the
   **name** of the variable to read, or the value itself. *(A banner nags on
   every page until a coding agent is configured.)*
2. **Repos → add a repository.** Path, base branch, and — this is the useful
   part — an optional **repo prompt** that is added to *every* run of that repo,
   plus `merge_mode`. Start with `merge_mode = off` (agents keep their work on
   their branch) and switch to `hub` once you trust the setup; `hub` is what
   turns "the agent says it is done" into "the work is on `main`". For the
   **worktree extras** (files a worktree needs but git does not carry — a `.env`,
   a linked `node_modules`) the form offers **Find worktree extras**: a model
   looks at the repository and suggests the list. Which model answers is chosen
   under **Settings → Worktree extras**, and it may be any configured model
   provider *or* a coding agent on its own subscription; without a usable source
   the button says why. The suggestion **replaces** the current list — it never
   extends it.
   Each row also carries **Deactivate** and **Delete**. Deactivating is the one
   to reach for: the repo vanishes from every repo dropdown and starts nothing
   new, while every run, agent and report it owns stays intact and reachable —
   and one click brings it back. Deleting is permanent, takes the runs, agents,
   events and incidents with it, refuses while any run is still going or
   planned, and makes you type the repo's name; it never touches your git
   checkout, the worktrees or the run directories. Its confirmation offers
   deactivating instead.
3. **Start a single run.** Small, boring task, a repo you do not mind. Watch it
   in the browser terminal. This is the fastest way to learn what the system
   does — much faster than reading `AGENTS.md`.
4. **Then make it an agent**: same form plus a name and a schedule.
 5. **Settings → Notifications** (`/settings/notifications`) — *optional, and
    genuinely so.* One card per notification channel the hub can drive: enabled
    flag, its settings, its credentials, a "send test message" button and, when
    the plugin brings one, a link to its own setup assistant. Telegram is the
    only channel that ships (its assistant walks through the BotFather token,
    the chat id and a test message; the old `/telegram-setup` address redirects
    there). **With no channel configured Freilauf runs fully and quietly** — it
    schedules, watches, merges, records and reports exactly the same, it just
    says nothing out loud. Nothing nags about it, nothing errors, and no step of
    the Welcome wizard requires it. Another channel is a plugin package with
    `"kind": "notifier"` (see `docs/plugins.md`).
 6. **Settings → Freilauf skills** (`/settings/skills`) — *optional, and asked
    once in the wizard.* Freilauf ships agent skills of its own under `skills/`
    that teach any coding agent how to drive the hub: find and read runs, create
    and edit agents and repositories, build flows, read the status sidebar, pick
    a model. Two switches: install them at user level, and keep them up to date.
    Switching the first one on copies them into the smallest set of directories
    that covers every coding agent you configured — for the four shipped ones
    that is `~/.claude/skills` (claude, cursor and opencode all read it) and
    `~/.hermes/skills`. Which directories a coding agent reads is part of its
    **plugin** (`skills: { user, project }`, see `docs/plugins.md`), so a fifth
    coding agent brings its own and needs no change here. Switching it off
    removes exactly the copies Freilauf wrote — each carries a marker file — and
    leaves a skill of your own under the same name alone.
 7. Optional: **Settings → Favorites**
    (the setup half of a run under a name, feeds the Quick Run button in the
    header), **Settings → tmux cleanup** (a special agent that ends the oldest
    inactive tmux sessions to free memory — a threshold starts it by itself,
    a target says how far it must free, and the small button in the sidebar's
    tmux block plus the box on the Sessions page start it by hand),
    **Settings → UI language** (English, 中文, Deutsch) and **Settings → Time
    and numbers** (the timezone every displayed time — sidebar included — is
    shown in, defaulting to the UI language; numbers and percentages follow
    the UI language's separators).

Nothing about the pipeline switch is subtle: `freilauf pipeline off` stops
*scheduled* starts. Manual starts always work — a limit that overrules a
deliberate decision is a limit people work around.

---

## 5. Keeping your machine's values out of the repository

Freilauf is developed with a **private sister repository** that holds everything
machine- and operator-specific, and the public repo stays free of it. Copy the
pattern if you fork — it is small and it works:

- `CLAUDE.local.md` next to `CLAUDE.md`, **gitignored**: the real ports, the VPN
  address, hostnames, certificate paths. Claude Code loads both files, so your
  agent has the full picture while the public repo has none of it.
- `~/.config/freilauf/env` — the only place API keys live. Never in the repo, and
  `chmod 600`.
- `~/.config/freilauf/coding-agents.json` — an optional **seed**: on first start
  with an empty configuration, the hub creates your coding agents and providers
  from it. This is what makes a fresh machine reproducible.
- `pruefe-vor-push.sh` — a pre-push hook that greps the **committed** state for
  private IPs, home paths, key formats and bot tokens. Its generic patterns
  are in the script; the operator's own patterns live *outside* the repo, in
  `~/.config/freilauf/verbotene-muster`, because a list of secret values is itself
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
| drive a coding agent CLI that is not supported | a **plugin package** in `FREILAUF_PLUGIN_DIR` — a `plugin.json` plus a descriptor with a `launch` declaration, and `bin/fl-start --spec` starts it without a line of bash. Inside this repo instead: a file in `server/harnesses/` plus a `case` in `fl-start` → [`docs/plugins.md`](docs/plugins.md) |
| use another model provider | a plugin package of the same shape, or a file in `server/providers/` → same doc |
| be notified somewhere other than Telegram — Slack, a webhook, e-mail, a script | a **notifier plugin**: the same package shape with `"kind": "notifier"`, a descriptor whose minimum is `id`, `label` and `async send(message, ctx)`, and whatever `settings` / `credentials` it needs. Inside this repo instead: a file in `server/notifiers/`. Configure it under Settings → Notifications → [`docs/plugins.md`](docs/plugins.md) |
| not be notified at all | do nothing — that is the default, and it is a complete installation |
| have the hub's own small questions answered by something else | Settings → the source picker on each of Run titles / Incident check / Worktree extras: any plugin declaring `llm`, including a **coding agent on your existing subscription** (marked, because a session per question is slower and dearer) |
| keep those questions working when the provider is down | the **fallback picker** next to each source: a second source the question goes to when the first is unreachable, before any retry begins. `agent:claude` (print-only mode) needs no model and no key — a zero-config fallback |
| give a provider a key without touching the environment | Settings → **Plugins**: name a different environment variable, or store the value |
| change what every agent is told | Settings → **Platform prompt suffix** (added, never replacing the platform rules), or a **repo prompt** per repository |
| point the notification links at your own hostname | Settings → **Notification links**: a `Public hostname` (the name that matches your certificate), and the port follows the live VPN port automatically. Without one, `FREILAUF_PUBLIC_URL` (a full URL, in `~/.config/freilauf/env`) or the local address answers — `publicBase()` in `server/util.mjs` |
| give agents an opt-in capability | drop a folder with a `SKILL.md` into `~/agents/zusaetze/` — it appears as a checkbox in the run forms. Deliberately *not* `.claude/skills`, so nothing loads automatically |
| teach your coding agents how to drive Freilauf itself | Settings → **Freilauf skills** installs the agent skills under `skills/` into the directories your configured coding agents read. Where those are is a **plugin declaration** (`skills: { user, project }`), so a new coding agent brings its own — `server/skills.mjs`, [`docs/plugins.md`](docs/plugins.md) |
| run an agent inside a boundary rather than as yourself | **Settings → Sandbox** — off by default, needs a container runtime, configured hub → repo → agent → run with a lower level only ever able to narrow what a higher one locked. Start with the **Audit** shape (watch what a run reaches), then enforce — but read the rootless caveat first: Audit is one of the three profiles whose allowlist the built-in engine cannot deliver under a rootless daemon. → [`docs/sandbox.md`](docs/sandbox.md) |
| put a project away without losing its history | **Repos → Deactivate**: gone from every dropdown, starts nothing new, everything it owns kept and reachable, reversible in one click. `POST /repos/toggle` (`id`, `active=1\|0`) is the same thing from a script — `server/pages.mjs`, and the "Putting a repository away" section in [`AGENTS.md`](AGENTS.md) |
| script the hub from a shell or from inside a run | `fl-api` — `fl-api /api/runs repo=3 status=running`, `fl-api /api/runs/<id>`, `fl-api -X POST /api/runs/<id>/title title=…`. The read-only half is `server/read-api.mjs`; every write still goes through the ordinary POST routes, which validate |
| show your project's own numbers in the sidebar | **panels** — the project pushes (`fl-panel set findings --total 33 --item "bug=17:red"`, or a tool of yours piping JSON in), Freilauf renders them with the time they were measured and never learns what they mean. Push it from a run before it reports, or from a `run_merged` flow → [`docs/panels.md`](docs/panels.md) |
| do something after a run finishes or a merge lands | **no-code flows** — a graphical designer, no code needed: message running agents, start follow-up runs and wait, extract data from a report via LLM, branch, loop, notify, HTTP, shell command → [`server/flows/AGENTS.md`](server/flows/AGENTS.md) |
| change when a run is allowed to start | Settings → **Budget gates** — the fieldset is generated from whichever plugins declare a `gate`, so a new one appears there by itself; else `repos.max_parallel` — `server/scheduler.mjs`; a deferred run can be started anyway from its detail page |
| change a run that is not over | the "Edit this run" card on its detail page: the expected duration of a running run, plus the prompt, the repo, the branch rule and — for a planned run — its start time of one that has not started yet — `server/run-edit.mjs` decides what a status allows |
| add a UI language | a new `lang/<code>.json` with the same keys, plus the language list — see `server/i18n.mjs` |

If your change is generally useful, **please open a pull request** — new harness
and provider plugins, translations, fixes and documentation are all very
welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## 7. Working *on* this repository — the rules that will bite you

If your task is to change Freilauf rather than just run it:

- **Project language is English.** Source, comments, docs, commit messages.
  (`lang/de.json` and `lang/zh.json` are the exception, obviously.) There is a
  subagent for this: `.claude/agents/english-enforcer.md`.
- **No hardcoded UI strings.** Everything goes through `t('key')` /
  `window.FREILAUF_I18N`, and `lang/en.json`, `de.json`, `zh.json` must carry the
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
  you touched `public/hub.js`, `vpn-proxy.mjs` or `bin/freilauf-deploy`. The e2e
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
| Starting a run, schedules, budget gate | `server/scheduler.mjs`, `server/quota.mjs` |
| Worktrees, prompt assembly, session launch | `server/runner.mjs`, `bin/fl-start` |
| Reports coming back in | `server/reports.mjs`, `bin/fl-report` |
| Watching from the outside; anomalies | `server/watcher.mjs`, `server/detect.mjs` |
| Merging a finished run into the base branch | `server/integrate.mjs` |
| Rate limits / provider outages | `server/incidents.mjs`, `server/harnesses/patterns.mjs` |
| Plugins — coding agents, model providers, notification channels: the contract, in depth | **`docs/plugins.md`** (the one document to hand an agent for this), `server/harnesses/`, `server/providers/`, `server/notifiers/` |
| Saying something to a human — the facade, the page, the CLI | `server/notify.mjs`, `server/notifications.mjs`, `bin/fl-notify` |
| Loading, validating, storing and configuring plugins | `server/plugins/` (`registry`, `loader`, `manifest`, `store`, `install`, `discovery`, `settings`, `context`, `web`) |
| The hub's own LLM calls: sources, fallback chain, structured output, alerts | `server/llm/` (`index` = `llmJson()`, `job` = the per-job chain planner, `sources`, `schema`, `json`, `alerts`) |
| The first-run wizard | `server/welcome.mjs` |
| The agent skills Freilauf ships, and where they get installed | `skills/`, `server/skills.mjs`, the `skills` declaration in `docs/plugins.md` |
| The read-only JSON API those skills talk to | `server/read-api.mjs`, `bin/fl-api` |
| A project's own numbers in the sidebar | `server/panels.mjs`, `bin/fl-panel`, **`docs/panels.md`** |
| No-code flows | `server/flows/` + its own `AGENTS.md` |
| Running an agent in a container: profiles, layering, network, audit, and what it does **not** do | **`docs/sandbox.md`**, `server/sandbox/`, `sandbox/images/README.md` |
| The report socket and the per-run token | `server/hub-socket.mjs`, `bin/fl-report` |
| Pages, sidebar, live channel | `server/pages.mjs`, `server/events.mjs`, `public/hub.js` |
| TLS proxy, HTTP/2, the network edge | `vpn-proxy.mjs`, `test/proxy.mjs` |
| Deploying, rollback, health check | `bin/freilauf-deploy`, `test/deploy.mjs` |
| Schema, migrations, the one place events are written | `server/db.mjs` |
| UI strings | `server/i18n.mjs`, `lang/*.json` |

---

## 9. A short checklist you can actually follow

```
[ ] asked the human for: VPN bind, ports, allowed hosts, certs, CLIs, keys
[ ] prerequisites verified (node ≥ 22, tmux, git, jq, curl, wg, one agent CLI)
[ ] setup/01 → 02 → 03 run, output read, not just executed
[ ] ~/.config/freilauf/env filled in by the human; certificates in place
[ ] setup/04-firewall.sh run (or handed to the human with the exact command)
[ ] freilauf-deploy --init --from "$PWD"  →  freilauf status  →  freilauf on
[ ] reachability verified FROM A VPN CLIENT, not from the server
[ ] Welcome wizard answered (or deliberately skipped)
[ ] Settings → Plugins: at least one coding agent enabled, its providers ticked,
    credentials present (environment variable or stored value)
[ ] a model source chosen for the hub's own questions (run titles at minimum)
[ ] Settings → Freilauf skills answered (install them, or deliberately not)
[ ] sandbox: left off (the default), OR a runtime installed by the human,
    every row of "What has to be true" checked, Settings → Sandbox switched
    on, images built, a policy dry-run verified, and docs/sandbox.md's limits
    passed on — including that on a rootless daemon three of the four shipped
    profiles cannot start a run (built-in proxy engine), and that only the
    opencode image has ever carried a real run
[ ] at least one repo added
[ ] one small single run started and watched end to end
[ ] no ports, addresses, hostnames or keys ended up in a commit
    (./pruefe-vor-push.sh is green)
```

Report what you did, what you could not do, and every value you had to ask
for — **never the values themselves.**
