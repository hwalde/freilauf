# The sandbox

Running a coding agent unattended means running it with `--permission-mode
dontAsk`, `--auto`, `--yolo` or `--force` — nobody approves shell commands at
three in the morning. Until now that agent was a process of the hub's own user,
in the hub's own home directory, with the hub's own network. The sandbox is the
option to put a boundary around it that was configured **before** the run
started.

It is **off by default and optional in every direction**. An installation with
no container runtime, or one that simply never switches it on, behaves exactly
as it did — the sandbox module is not even imported on the launch path of an
unsandboxed run.

This document is the operator's reference. The plugin side of it — the
`sandbox` declaration a coding agent or a model provider carries, the seeded
home, `launchOverrides`, `innerSandbox` — is in
[docs/plugins.md](plugins.md), "The sandbox declaration". The design study
behind all of it, including everything that was measured on a real machine
before a line was written, is [SANDBOX_RESEARCH.md](../SANDBOX_RESEARCH.md);
its **§11a** is the section to read if you want to know which of the claims
below rest on a measurement and which on a reading.

**And read [What this sandbox does not do](#what-this-sandbox-does-not-do)
before you rely on any of it.** A boundary whose limits are not written down is
a boundary somebody will eventually trust for something it never promised.

---

## What it is

A sandboxed run's agent runs **inside a container**; tmux stays on the host. The
pane command of the run's tmux session becomes a `docker run …` around the
agent's ordinary command line, so everything the hub already does with tmux —
the log pipe, the `pane-died` hook, typed goals and messages, `capture-pane`,
the browser terminal, `fl-attach`, `fl-kill` — keeps working unchanged. That is
also why it works for **every** coding agent, including ones that arrive as a
plugin: it wraps a command line, and a command line is what every harness hands
to `fl-start` anyway.

Four other things follow from it, and each has its own section below:

- the run works in a **clone of its own**, not in a linked worktree;
- the **network policy lives outside the container**, in an egress proxy, so it
  can be widened while the agent is running;
- the hub and the agent talk over a **unix socket with a per-run token**
  instead of `127.0.0.1:<port>`;
- what the boundary is, is one JSON document — a **profile** — that four layers
  may narrow and only the top layer may widen.

---

## Switching it on

### 1. A container runtime

Docker (or Podman) is a **prerequisite only if you want the sandbox**. Nothing
in Freilauf needs it otherwise, and the hub never runs `sudo` — installing a
runtime is the human's job, once.

On Ubuntu 24.04, the rootless variant is the recommended one:

```bash
sudo apt-get install -y docker.io uidmap dbus-user-session
dockerd-rootless-setuptool.sh install          # as the hub's own user, no sudo
systemctl --user enable --now docker.service
loginctl enable-linger "$USER"                 # so it survives a reboot with nobody logged in
docker info | grep -i rootless
```

**Why rootless.** With rootful Docker, membership of the `docker` group is
equivalent to root on the host — anyone who can talk to that socket can mount
`/` into a container. Rootless keeps the daemon in the hub user's own user
namespace, so a container escape lands where the hub already was, which is the
worst case the sandbox is designed against anyway. Rootful Docker works and the
hub uses it happily; it just makes the `docker` group part of your threat
model.

**What rootless costs on this kind of host** [measured on Ubuntu 24.04,
systemd 255]: the user slice delegates `cpu memory pids` and **not** `cpuset`
or `io`. So `--memory`, `--pids-limit` and `--cpus` are honoured out of the
box, and CPU pinning and disk-IO limits are not — they need a
`/etc/systemd/system/user@.service.d/delegate.conf` drop-in, which is a root
step. Discovery reads the delegated controllers and the hub offers the limits
that are actually available rather than a field that would fail at `docker
run`.

### 2. Tell the hub

**Settings → Sandbox.** The page starts with what discovery found — the
runtime, its version, whether it is rootless, which container runtimes it can
name. While nothing is found, the hub-level mode **cannot be set above `off`**,
and that is enforced in the save and not only greyed out in the select.

| `sandbox_mode` | What it means |
|---|---|
| `off` | the feature is hidden entirely. This is the default, and it is what every installation is until somebody changes it |
| `available` | repos and runs may ask for a sandbox; nothing does by itself |
| `default_on` | a repo that says nothing gets one |
| `required` | every run is sandboxed, and no lower layer may say `off` |

Next to it on the same page:

- **`sandbox_allow_bypass`** (default **on**) — may a lower layer opt out of a
  sandbox a higher one wanted, and may the operator press "Continue without the
  sandbox" on a running run. Default on, because an installation that never
  configured this must not discover that it cannot start a run any more.
- **`sandbox_lock`** — the spec paths the hub locks (one per line, e.g.
  `network.allow`, `secrets.mode`). See [the one rule](#the-layers-and-the-one-rule).
- **`sandbox_allowed_mount_roots`** — the host directories a profile may mount
  at all. Empty means none; nothing outside the run's own directories can be
  mounted by anybody below the hub layer.
- **`sandbox_runtime`** — `docker` or `podman`, or whatever discovery listed.
- **`sandbox_proxy_engine`** — `builtin` or `iron-proxy`; the page prints what
  the chosen engine can do, and a field the engine cannot honour is
  **disabled**, not merely dimmed (a disabled input does not travel with the
  POST, so a configured CA directory survives an engine switch and comes back).
- **`sandbox_ca_dir`**, **`sandbox_image_registry`** — the CA the TLS-terminating
  engine mints from, and the registry prefix the shipped images are named under.

The same page carries the profile editor and one build button per shipped image.

### 3. Build the images

The images are in `sandbox/images/` — one base, one layer per built-in coding
agent, and an overlay that puts an agent layer on top of a toolchain image you
own. Build them from the Settings page, or by hand as
[`sandbox/images/README.md`](../sandbox/images/README.md) describes. That file
is also where the honest part lives: **they have never been built**, because
the machine they were written on has no container runtime. Every install
command in them was derived from a measured source and the confidence per layer
is tabulated there — hermes is the one to build first.

### 4. Verify a policy before a run depends on it

`sandbox/wrap.sh --print` and the **Dry run** button under the repo form both
resolve a policy and show what would actually be run, without starting an
agent:

```bash
sandbox/wrap.sh --print ~/agents/runs/<run id>/sandbox.json -- bash
fl-start --sandbox ~/agents/runs/<run id>/sandbox.json --dry-run …
```

The whole runtime command line comes out of one pure function, so a policy can
be inspected on a machine that has no Docker at all.

---

## The layers, and the one rule

The boundary is one JSON document with every field defaulted, so `{}` is a
valid profile and nothing downstream ever has to ask whether a field is there.
Four layers contribute to it:

| Layer | Where | What it says |
|---|---|---|
| **hub** | Settings → Sandbox | the mode, the locked paths, the mountable roots, the runtime and the engine |
| **repo** | the repo form, "Sandbox" block | the default (`inherit` / `on` / `off`), a profile, an image, audit-only, and free-form overrides |
| **agent** | the agent form | the same tri-state, a profile of its own, overrides |
| **run** | the single-run form, and the run's own edit card before it starts | the same again |

**A lower layer may only ever NARROW what a higher one locked.** For a locked
path a lower layer may append to a deny-shaped list, remove entries from an
allow-shaped list, lower a numeric limit, switch `auditOnly` from true to
false, or tighten a mode (`open` → `allowlist` → `none`, `rw` → `ro`, `weak` →
`off`). Never the reverse. Anything else is **refused** — the higher layer's
value stands, the attempt becomes a `sandbox:override_refused` event on the run
and a warning in the form. Never silently: a boundary that falls back to a
weaker value without saying so is worse than one that refuses.

The refusal is all-or-nothing per path. A half-honoured list — "we kept the
three entries you were allowed to remove and put back the two you added" —
would be a fourth value that no layer wrote and neither the form nor the event
could name.

A lock entry locks itself and everything under it: writing `network` locks
`network.allow` too, so nobody has to enumerate a subtree.

A path that is **not** locked is simply overwritten by the lower layer. That is
what layers are for — narrowing is enforced only where a lock covers the path.
Today the only locks in force are the ones the **hub** setting names: the
resolver supports a lock per layer, and nothing below the hub layer sets one.

The default for a locked path that has no rule of its own is **`fixed`**: no
change at all. `runtime`, `image.*`, `user`, `network.engine`, `audit.export`
and anything a plugin adds fall into it. The paths with a rule are the mode
orders above, the allow-shaped lists (`network.allow`, `network.presets`,
`filesystem.extraMounts` — may shrink), the deny-shaped ones (`network.deny`,
`network.denyUpstreamCidrs`, `filesystem.protected` — may grow), the numbers
and sizes (may only go down), and the booleans that have a safe direction
(`network.auditOnly` may only become `false`; `network.tlsTerminate`,
`filesystem.readOnlyRoot` and the two `audit` flags may only become `true`).

### The tri-state

`inherit` / `on` / `off` at repo, agent and run level. `off` is not offered at
all when the hub mode is `required` or when `sandbox_allow_bypass` is off — a
select that offers what the endpoint would refuse is a form that lies.

A coding agent whose plugin carries no `sandbox` declaration **cannot be
sandboxed**, and the form says so instead of hiding the block: the field is
disabled and carries the reason. That is the same shape as an absent `launch`
declaration meaning "cannot start a run".

---

## The four built-in profiles

Seeded by the hub, marked `builtin`. **Editing one writes a copy** (`builtin =
0`) rather than changing it, so a later release can still correct the hub's own
defaults and an operator who tuned one keeps their edit. Both claims are true
and they are kept apart rather than one of them winning.

| Profile | Network | Secrets | Limits | For |
|---|---|---|---|---|
| **Balanced** | allowlist through iron-proxy, TLS terminated; presets `harness`, `provider`, `git-host`, `package-registries` | `inject` | 8 GB / 4 CPU | the ordinary case |
| **Locked down** | allowlist, iron-proxy, TLS terminated; presets `harness`, `provider` only — **no package registry** | `inject` | 4 GB / 2 CPU | a run that must be given every dependency rather than fetching one |
| **Open network** | `open`, built-in engine, no TLS termination | `env` | 8 GB / 4 CPU | the repository whose build reaches half the internet and where an allowlist would be a week of whack-a-mole. The container is still a container |
| **Audit** | Balanced, but `auditOnly` — nothing is blocked, everything that *would* have been is written down | `inject` | 8 GB / 4 CPU | the mode you roll out in |

The defaults underneath them, for a profile that says nothing: `network.mode
allowlist`, `network.engine builtin`, `secrets.mode env`, worktree `rw`, the
operator's `.git` `ro`, extras `ro`, read-only root filesystem with tmpfs at
`/tmp` (2 GB) and `$HOME/.cache` (2 GB), memory 8 GB, 4 CPUs, `pidsLimit` 4096,
`shmSize` 1 GB, `innerSandbox off`, `retention run`, audit on.

**Three of the four built-ins ask for `iron-proxy` and `secrets.mode: inject`,
and that combination does not start a run today.** The proxy layer has no way
of being handed the substitution table, so `inject` fails at launch with a
readable refusal rather than putting the real key inside a container the
profile promised held only a placeholder. Until that is finished, the profile
to use is **Open network**, or a copy of Balanced with `secrets.mode` set to
`env` and `network.engine` to `builtin`. See
[What this sandbox does not do](#credential-injection-is-not-finished).

---

## The network

### Three modes

| `network.mode` | Meaning |
|---|---|
| `open` | the container has ordinary egress. The filesystem and the resource limits are the whole wall |
| `none` | no egress at all |
| `allowlist` | the container's only route out is an egress proxy on an internal network, and the proxy answers **403** for a host that is not on the list |

The allowlist is the union of the profile's own `network.allow` and the
**presets** it names:

| Preset | What it expands to |
|---|---|
| `harness` | the hosts the run's own coding agent needs, from that plugin's `sandbox.domains` |
| `provider` | the same for the model provider the run uses |
| `git-host` | the host of the repository's own `origin` — read from the remote URL, so a self-hosted forge is covered without being typed |
| `package-registries` | the usual language registries |

A run's resolved list is printed on its detail page, folded, with the count.
The expansion happens **once, at launch, and is frozen into the run** — a run
keeps the hosts it started with, whatever a plugin declares later.

**A `deny` entry wins over everything, and is asked first.** That is how you
carve a hole out of a preset without abandoning it.

### How a host is matched

On the **name**, exactly, with two glob forms:

- `example.com` matches that host and nothing else;
- `*.example.com` matches any sub-domain and **not** `example.com` itself;
- `.example.com` matches `example.com` **and** its sub-domains;
- `*` matches everything;
- a pattern with a `*` anywhere else matches nothing — it is not a regex.

A port and a trailing root dot are stripped before the comparison, and the
match is case-insensitive.

### The upstream address fence

Regardless of the allowlist, the proxy refuses to connect to a resolved address
inside `denyUpstreamCidrs`, whose default covers loopback, all three RFC 1918
ranges, RFC 6598 CGNAT (where Alibaba's metadata service lives), IPv4 and IPv6
link-local (`169.254.169.254` — the AWS/GCP/Azure metadata address), and IPv6
unique-local. An allowlisted name that resolves into one of those does not
become a route to the host's own network.

The name is resolved, **every** returned address is checked, and the connection
is then made **by address** — so nothing can change between the check and the
connect. One blocked address refuses the whole name. **Audit-only does not lift
this fence**: it is a rollout mode for the allowlist, not permission to hand the
container the cloud metadata service.

### The two engines

| | `builtin` | `iron-proxy` |
|---|---|---|
| CONNECT allowlist, 403 with a readable body, audit log | yes | yes |
| terminate TLS | **no** | yes |
| inject a credential so the key never enters the container | **no** | yes |
| restrict HTTP methods | **no** | yes |

`tlsTerminate` is the root of the other two: without it the proxy sees a CONNECT
line and encrypted bytes, so there is no method to judge and no header to swap a
credential into.

**`secrets.mode: inject` on the built-in engine is refused, not downgraded.**
The hub does not quietly run the weaker mode and let a profile that says
"the key never enters the container" put the key in the container. The profile
editor greys the fields the chosen engine cannot honour, and the policy
builder refuses the combination outright.

---

## What the container actually is

Named from the run, so nothing has to remember anything: the agent container is
`fl-<run id>`, its egress proxy `fl-proxy-<run id>`, its network
`fl-net-<run id>`, and its own `HOME` is `~/agents/runs/<run id>/home`. Labels
`freilauf.run` and `freilauf.hub` say whose it is.

Always passed: `--cap-drop ALL`, `--security-opt no-new-privileges`, `--init`
(without an init as PID 1 the agent survives its own pane), `--rm` unless the
profile says `retention: keep`, `--stop-timeout 30`, and
`--detach-keys ctrl-^,ctrl-^` — Docker's default `Ctrl-P Ctrl-Q` would be eaten
before it reached the agent's TUI, and every TUI uses `Ctrl-P`.

The container user is **not root**: rootful Docker gets `--user <hub
uid>:<hub gid>`, podman gets `--userns=keep-id`, and under rootless Docker no
flag is needed because container root already *is* the hub user. The reason is
the bind mounts: root in the container is root on every one of them, and a
different uid could not write a single commit into the worktree.

The mounts, in order — host path to container path, which is the same path in
every case except the socket:

| Host | In the container | Mode |
|---|---|---|
| the run's clone | the same path, and the working directory | `rw` |
| the operator's `<repo>/.git` | the same path | `ro` |
| a minimal masked `config` | over that `.git/config` | `ro` |
| `~/agents/runs/<id>` | the same path — this is where `report.md` goes | `rw` |
| `~/agents/runs/<id>/home` | the same path, and `$HOME` | `rw` |
| the hub's report socket | `/run/freilauf/hub.sock` | `rw` |
| the directories of `fl-report` and `fl-start` | the same paths, and on `PATH` | `ro` |
| the proxy CA, where there is one | `/etc/freilauf/ca.crt` | `ro` |
| the repo's worktree extras | as configured | `ro` by default |

A mount whose target would **cover** one of the hub's own is refused by name; a
mount *inside* one is the ordinary case. `--read-only` root is the default, with
tmpfs at `/tmp` and `$HOME/.cache` — deliberately **not** `noexec`, because
`npm ci`, `pip install` and every build script in the world execute out of
`/tmp`.

An empty limit produces **no flag at all**: `--memory 0` is a refusal from the
daemon and `--cpus 0` is a container that cannot run.
`resources.maxRuntimeMinutes` is not a runtime flag — no runtime has one — so
the hub's own clock enforces it: container stopped, session killed, run aborted,
`sandbox:max_runtime` on the record, one notification. It is never resumed.

### "The daemon did not answer" is not "there are no containers"

The same rule the hub already applies to tmux. A runtime command answers one of
three things: **`ok`** (its output is the truth), **`no_daemon`** (there is
demonstrably no daemon, so there are no containers — the empty truth), and
**`unreachable`** (the hub learned nothing: a timeout, a failed fork, a missing
binary, a socket in a broken state, a daemon still coming up after a reboot).
Only a positive answer may end a run. On `unreachable` the hub does nothing and
asks again next pass, and after three consecutive silences it raises the global
incident **`docker_unreachable`**, which resolves itself the moment the daemon
answers. Nothing is stopped or reaped on the strength of a question that was
never answered.

The same instinct covers a resume: a launch that failed because the *runtime
could not be asked* is "could not try", not "tried and died" — it leaves the
resume pending, does not count against the resume cap, and is retried on the
next watcher pass. A rootless daemon that is thirty seconds behind the hub after
a reboot therefore costs nothing.

## When the sandbox blocks something the agent needed

A misconfigured sandbox nobody notices is worse than no sandbox, so this is
designed as a first-class path rather than as an error.

**The agent is told, before it starts.** A sandboxed run's prompt carries a
`SANDBOX` section — a fact about the machine it is on, not an instruction —
naming its working copy, its network mode and the hosts it can reach, its
memory and CPU, whether the root filesystem is read-only, and this:

> If you need a host, a path or more resources, do NOT try to work around the
> sandbox: run `fl-report access "<what you need and why>"` and carry on with
> what you CAN do.

`fl-report access` is a report kind `fl-report` accepts and forwards. Working
*around* the boundary is precisely what the sandbox exists to prevent, so the
prompt names the way through it instead.

> **Today the hub does not act on it yet.** `handleReport()` has no `access`
> case, so the report is refused, filed in `inbox.jsonl`, replayed once and
> dropped. The agent is told to ask and its asking currently reaches nobody.
> Until that lands, the channel that actually works is the `sandbox:blocked`
> event and the buttons below — watch the run's page, not your notifications.

**The proxy's 403 body says the same thing** — it names the host and points at
`fl-report access`, in the operator's language.

**You get three buttons.** Every denial becomes a `sandbox:blocked` event, and
the run's detail page lists the hosts that were turned away with a count. Next
to each:

| Button | What it does |
|---|---|
| **Allow for this run** | writes the host into the run's own overrides **and** pushes the new list to the live proxy, without restarting anything. Only while the run is in flight |
| **Allow for this repo** | the same, into the repository's overrides, so the next run has it too |
| **Deny and tell the agent** | records the decision **and types it into the session** — *"`<host>` stays blocked — do without it and carry on with what you can"* — so the agent stops walking into the same wall |

Both halves of "allow" are deliberate: persisting without applying would leave
the agent hitting the same wall until it is restarted, and applying without
persisting would lose the decision at the next resume. And the third button
exists because a refusal is an **answer**, where silence is a wall the agent
hits again in a minute.

Both "allow" buttons are **greyed out with the reason** when `network.allow` is
locked by the hub layer — a button that is going to be refused is better
disabled than clicked.

**Network and resource changes are live; a filesystem change is not.**
`Reconfigure…` on the run page takes a fresh overrides document; where it can be
applied to the running container it is, and where it cannot the run is
**resumed** through the hub's ordinary resume path — a new tmux session, the
harness's own resume form, the same clone and the same per-run home, so the
agent keeps its conversation.

### Audit-only, and growing an allowlist out of it

Tick **audit-only** on the repo (or use the **Audit** profile) and nothing is
blocked: every request that would have been denied is written to the run's
`egress.jsonl` as a `would_deny` line. The repo form then grows a block —
*"hosts these runs reached that are not on the allowlist"* — built from the
repository's own traffic, with the count, the number of runs and when it was
last seen, every row ticked, and one **Adopt** button that writes them into the
repo's `network.allow`.

That is the rollout an enterprise actually follows: observe first, enforce
second. The two readings come out of the **same file**, which is the point — if
"what was blocked" and "what would have been blocked" came from two sources
they would eventually disagree.

### The break-glass

**"Continue without the sandbox"** on a running run. It is offered only where
`sandbox_allow_bypass` permits it, it asks for confirmation first, and it says
in its own hint that it is recorded: the run gets a `sandbox:bypassed {by}`
event, the overview's status cell says *bypassed* from then on, and the run's
page says it for as long as the run exists. Every choice that **weakens** the
boundary is a named event, never a silent setting — that is the rule the whole
layering rests on.

Where the hub forbids it, the page says so instead of hiding the button.

---

## The audit trail

Four files per run, in `~/agents/runs/<id>/`:

| File | What |
|---|---|
| `sandbox.json` | the resolved spec — the policy everything else has to be read against |
| `proxy.yaml` | the configuration the proxy really ran on |
| `egress.jsonl` | one line per request the proxy saw, `deny` or `would_deny` included |
| `docker-events.jsonl` | the container's own lifecycle |

**`GET /api/runs/<id>/audit.jsonl`** (the *Export audit* button on the run page)
folds all four into one hash-chained JSONL stream: the spec and the proxy config
first, then everything with a timestamp in time order, each line carrying the
hash of the previous one and of its own canonical content. A header names the
run and the hub's running sha — "which code produced this" is the first question
anybody reading an audit asks — and a footer names the line count, which is what
makes a **truncated** file detectable at all: a chain whose last lines were cut
off is internally consistent right up to the cut. `verifyAuditChain()` is the
check somebody handed the file would run.

A line that is not JSON is carried through as `{ raw }` rather than dropped: a
broken line in an audit is itself a fact.

The events table carries `sandbox:blocked` for the same denials and is what the
live channel hangs on. Both exist because they answer at different times — the
event during the run, the file afterwards, and the file survives a database
whose run was archived away.

---

## The clone, and how work gets back

A sandboxed run does **not** get a linked git worktree. A linked worktree's
`.git` is a file pointing into the operator's checkout, so the container would
need that checkout's `.git` mounted read-write — and with it the operator's
hooks, config, refs and reflog, which is the one thing a sandbox must not hand
to an untrusted agent.

Instead the run gets a **clone of its own**. It borrows objects from the
operator's repository through a read-only mount
(`objects/info/alternates`) — measured: a 3.1 MB object store cost the clone
16 KB — and fetches from it as `origin`. The operator's `.git/config` is masked
by a **minimal replacement**, not an empty file: `core.repositoryformatversion`
and the whole `[extensions]` block are copied over and everything else dropped,
because on a `sha256` repository an emptied config makes `git log` fail and
`git ls-remote` answer **exit 0 with an all-zero sha** — a silent wrong answer,
which is worse than an error.

The integrator collects the result with one `git fetch` out of the clone into
the hub's own repository, and then everything downstream — the merge-base, the
`merge-tree` dry run, the merge itself, the backup branch, a conflict run's
start point — is the path it already had.

**Host git is never run inside an agent-owned clone.** That was measured, and
the measurement is the reason the rule is absolute rather than a denylist:
`git fetch` *from* a hostile clone executed nothing (all seven planted config
commands and twelve hooks stayed silent), but `git status`, `git diff`,
`git add`/`commit` and `git checkout` run *inside* it fired `core.fsmonitor`,
`diff.external` and four hooks immediately — and hardening those three keys away
still left a `filter.<name>.clean` driver running, selected by a
`.gitattributes` the agent commits. git 2.43 has at least seven repo-local ways
to name a command and there is no `GIT_CONFIG_NOLOCAL`. **A denylist of config
keys is not a boundary and is not described as one here.**

So: everything that reads a sandboxed run's working copy goes through one seam
(`runGit()`), which runs it in the container or refuses. The two commands
measured inert — `rev-parse` and `rev-list --count` — plus the collecting fetch
are the only host-side exceptions. Where the operator's own **rescue** buttons
(commit-and-merge, discard-and-merge) must write in a clone whose container is
gone, the clone's `.git/config` is renamed aside for the duration of the call
**and** `core.hooksPath=/dev/null` is passed; that combination was verified
inert against all eight commands.

And the honest consequence: **the dirt of a dead sandboxed run is reported as
unknown, never as measured** — which is exactly why the finish gate now has a
third answer besides clean and dirty (see the changelog entry for 2026-09-05).

---

## The report socket

A container cannot reach the host's `127.0.0.1` anyway, so `fl-report` inside a
sandbox talks to the hub over a **unix socket** — `$XDG_RUNTIME_DIR/freilauf/hub.sock`,
or the data directory — with a **per-run token** in an `Authorization: Bearer`
header. That is worth having beyond the sandbox: `FL_RUN_ID` used to be the only
authentication the report route had, and the hub's whole API — kill any run, type
into any session, read settings with the notification token and provider
credentials in them — sits on the same port.

The socket serves an **allowlist of exactly two routes**, deliberately a
what-is-served list rather than a blocklist: `POST /api/runs/<id>/report`, and
`GET /api/runs/<id>/sandbox`, which lets a sandboxed agent read its own policy
so it can make sense of a 403. Both require the token, and it must match the run
in the path.

Every run gets a token — sandboxed or not, minted by a database trigger — but
today only a **sandboxed** run is given the socket and the token in its
environment; an unsandboxed run still gets `FL_HUB_URL` and reports over
loopback. **The `127.0.0.1` report route deliberately still accepts a report with
no token at all**, for one transition release: an agent that is mid-run right
now was started by a hub that knew no token, and breaking that would silence
every run in flight the moment the release is deployed. Runs from before the
column keep a NULL token for the same reason.

`fl-report` chooses socket, then loopback, then `inbox.jsonl` — and the inbox
path is now taken from the configured runs directory rather than from `$HOME`,
which inside a container is the run's seeded home where `agents/runs` does not
exist. The last fallback a report has used to write into nowhere, silently.

---

## What this sandbox does not do

Everything above is what it *does*. This section is what it does not, and it is
the section to read twice. Where a limit rests on something that was measured,
it says so; where it rests on a reading or an inference, it says that instead.

### It does not inspect what the agent sends

The allowlist decides on the **hostname the client asked for**, and on nothing
else. It does not look at a request body, a URL path, a header or a response.
So:

- **An allowed host is an exfiltration path.** `github.com` on an allowlist is a
  paste-bin: an agent that can push a branch can push your source anywhere that
  host will take it. The same is true of any package registry, any model
  provider's API, and any host you adopted from an audit run because a build
  needed it once.
- **Content inspection (DLP) is deliberately out of scope.** It is not a missing
  feature; it is a different product, and a proxy that pretended to do it badly
  would be worse than one that does not claim to.
- With the built-in engine there is no TLS termination at all, so the proxy sees
  a CONNECT line and encrypted bytes — it cannot judge a method or a path even
  in principle.

The boundary is about *where* the agent can reach, not about *what* it says
there.

### It protects the host from the agent, not the hub from anything

The hub can control tmux, and that is shell access. The sandbox does not change
that and is not meant to: it is a wall between the **agent** and the host, built
and configured by the hub, which stands on the host side of it.

- **The `docker` group is root-equivalent.** With rootful Docker, anything that
  can talk to the daemon socket can mount `/` into a privileged container. The
  hub talks to that daemon. So a sandbox on a rootful installation does not
  reduce what a compromised *hub* can do — only what a compromised *agent* can.
  Rootless Docker is recommended for exactly this reason, and even there an
  escape lands in the hub's own uid, which is where the agent already was
  without a sandbox.
- Freilauf still has **no login of its own**; WireGuard is the auth layer. The
  sandbox is not a substitute for the README's security model, it is a layer
  underneath it.

### Code from a run still executes on the host at merge time

`repos.merge_check` — the command that has to be green before a merge is pushed
— runs in the hub's **integration worktree, on the host**, on the merged result,
which includes the agent's code. So does everything the repository's own
tooling does there. The repo form has a **`merge_check_sandboxed`** checkbox
that moves it into a container; **without that box ticked, a sandboxed run's
code runs unsandboxed the moment it is merged.** The same is true of anything
you wire behind a `run_merged` flow's `shell_command` step, which is a command
on the hub machine by definition.

### Credential injection is not finished

`secrets.mode: inject` is designed to swap a placeholder for the real credential
in the request's own header, at a TLS-terminating proxy, so the container never
holds a key. **It does not work yet.** The proxy layer exports nothing that can
be handed the substitution table, so a profile asking for it **fails at launch**
with a readable reason. That is the right failure — falling back to `env` would
put the operator's real key inside the very container the profile promised held
nothing but a placeholder, and it would be told to somebody who picked the
strict profile in order to be safe — but it does mean that **three of the four
built-in profiles (Balanced, Locked down, Audit) cannot start a run as
shipped.** Copy one and set `secrets.mode` to `env` (and `network.engine` to
`builtin`), or use **Open network**, until this lands.

The **iron-proxy integration itself is UNVERIFIED against the binary**: it is
not installed on the machine this was written on, so the config's YAML key
names, the deny half of the allowlist (`deny_domains` is written *in the hope
that it exists*), the hot-reload endpoint's request shape and the audit log's
field names were all transcribed from documentation and have never been parsed
by iron-proxy. The hub warns about the deny half at runtime. A live policy
reload of iron-proxy additionally refuses today, because nothing sets the
management URL the reload posts to. `network.engine: iron-proxy` should be
treated as unexercised.

And even when it does work, injection covers exactly **one** class: a
credential carried verbatim in a request header (a bearer token, an API-key
header). It **cannot** cover a scheme where the client signs the request with
the secret — **AWS SigV4** is the obvious one, and so is any HMAC-signed
request. The signature is computed over the method, path, headers and body hash
*before* the request reaches the proxy, from a key the client must already hold.
Such a credential either enters the container (`secrets.mode: env`) or the run
cannot use that service. There is no third answer, and there is no
signing hook anywhere in the code. The same goes for OAuth flows that mint or
refresh a token, credentials carried in a query string or a body, and mTLS
client certificates.

### Runtimes that are named but not implemented

`runtime` accepts four values and three of them exist:

| value | state |
|---|---|
| `docker` | implemented, and what everything was designed and tested against |
| `runsc` (gVisor) | implemented as the same `docker` CLI plus `--runtime=runsc`; it presumes the daemon has gVisor registered. Discovery lists the runtimes the daemon knows |
| `podman` | implemented, with `--userns=keep-id` in place of `--user` |
| `srt` | **not implemented.** It is an accepted spec value and refused at launch with *"Freilauf cannot drive the runtime … yet"* |

A **bubblewrap "light" mode is not a runtime here at all.** The only thing in
the spec that resembles it is `innerSandbox` (`off` / `weak` / `full`), which
configures the coding agent's **own** sandbox inside the container — and all
four built-in profiles set it to `off`, because that sandbox wants
`clone(CLONE_NEWUSER)` and `mount`, which the container's own seccomp and
AppArmor deny; turning it on means opening the outer wall to save the inner one.
On a host with `kernel.apparmor_restrict_unprivileged_userns = 1` (Ubuntu
24.04's default) the question does not arise anyway: `unshare -rn true` and a
`bwrap` smoke test both fail with a uid-map permission error [measured].

### Two smaller gaps worth knowing

- **`docker-events.jsonl` is declared and never written.** `audit.dockerEvents`
  defaults to `true`, the export folds the file in, and nothing in the hub
  produces it. The audit's real content today is the spec, the proxy config and
  the egress log.
- **The audit chain is not a signature.** It proves that the copy you were
  handed was not edited after export; it does not prove the hub recorded the
  truth, and there is no key, so somebody who re-runs the chaining gets a valid
  file again. The exported file says so on its own header line.

### The images have never been built

The machine all of this was written on has **no container runtime at all**
[measured: `docker` and `podman` absent at both scopes, no unit files]. So every
Dockerfile in `sandbox/images/` is **unbuilt and untested**. The install
commands were derived from a measured source — the vendor's own installer read
on 2026-09-05, or the CLI installed on that machine — and
[`sandbox/images/README.md`](../sandbox/images/README.md) tabulates the
confidence per layer honestly: claude and opencode **high**, cursor **medium**
(its download URL is undocumented and Cursor's to change), hermes **low** and
the one to build first, with three specific things about it that could not be
checked without a build. The first operator to run `docker build` is doing the
verification.

The same is true of everything that could only be observed *inside* a container.
The unit and e2e suites drive a **`docker` shim**, not Docker.

### What rests on a reading rather than a measurement

[SANDBOX_RESEARCH.md §11a](../SANDBOX_RESEARCH.md) is the full account. The
short version, because it is what the boundary's edges are made of:

**Measured, on this machine, with real git / tmux / the real CLIs:**

- `git fetch` from a hostile clone executes nothing; host git *inside* one
  executes plenty, and the minimal-config mask plus `core.hooksPath=/dev/null`
  is inert against all of it. This is the clone rule above.
- The clone layout works, including under a read-only source and a masked
  config; the `[extensions]` correction above came out of it.
- All four coding-agent CLIs relocate cleanly with `HOME`, and **`XDG_DATA_HOME`
  outranks `HOME` for opencode** — which is why no image may set the XDG or
  CLI-home variables (`sandbox/images/README.md` has a section on exactly this,
  and `overlay.Dockerfile` fails a build that would).
- The tmux transport survives a PTY relay: pipe-pane, capture-pane, bracketed
  paste, `pane-died` with the inner exit status, `remain-on-exit`. But
  `pane_current_command` reports the transport, and **RSS accounting through the
  pane tree under-reported a workload twenty-fold** (10.4 MB for 210.3 MB) — so
  a sandboxed session's memory is asked of the runtime, and marked *unknown*
  where it cannot be.
- The user slice delegates `cpu memory pids` and not `cpuset` or `io`.
- Claude's project-slug rule replaces every non-alphanumeric character, not just
  `/` (a latent hub bug, fixed in the same work).

**Read out of a shipped binary, not executed:**

- **`--settings` outranks a project `.claude/settings.json`** — but a repository
  file carrying `disableAllHooks: true` switches off **every** hook, the hub's
  included, and the hub's only symptom would be a run that reports nothing. The
  answer is `--setting-sources user` on the launch line, which is a lever
  claude's own tooling uses; it is a mitigation read from a binary, not a
  guarantee from a vendor. Note the scope: `fl-start` passes it for a
  **sandboxed** claude run only — an unsandboxed run is still exposed to a
  repository that switches every hook off, which is the state it was always in.
- **Claude refuses to run as root outside a "recognized sandbox", and being in a
  container is explicitly not enough** — the predicate tests `IS_SANDBOX=1` or
  `CLAUDE_CODE_BUBBLEWRAP` and consults its own Docker detection nowhere. The
  hub sets `IS_SANDBOX=1` for a sandboxed claude run and does **not** depend on
  it: the default is a non-root container user with the hub's uid, where the
  question does not arise. `IS_SANDBOX` is documented nowhere and is
  Anthropic's to change.

**Not answered at all, and what the design does instead:**

- **Whether a second copy of `~/.claude/.credentials.json` refreshing its token
  invalidates the host session.** Answering it needs a throwaway account, so it
  was not answered. The design is never exposed to it: a subscription CLI gets
  `secrets.mode: env` with an OAuth token variable, the seeded home carries no
  credentials file, and **nothing may copy `~/.claude/.credentials.json` into a
  run home "for now"**.
- **iron-proxy under load, and with server-sent events.** TLS termination and
  header injection are opt-in per profile and not the phase-1 default; a profile
  that cannot reach its proxy fails the start with a readable problem rather
  than starting unproxied.
- **Whether the daemon can isolate the container network's gateway.** Where it
  cannot, the internal network is used anyway and the profile page says plainly
  that the host bridge address is reachable. The hub's own socket is a unix
  socket in the run directory rather than a TCP port, so the hub is not on the
  other side of that gateway either way.

### And the things it was never for

It does not judge the **content** of the agent's work — that is the finish gate,
the merge check and you. It does not replace the VPN-only exposure of the hub.
It does not stop an agent doing something stupid inside its own working copy;
it stops that from being something stupid on your machine.

---

## Where to look

| Question | File |
|---|---|
| The spec, the layers and the narrowing rule | `server/sandbox/spec.mjs` |
| The four built-in profiles and the copy-on-write rule | `server/sandbox/profiles.mjs` |
| Presets, and how a host is matched | `server/sandbox/presets.mjs` |
| The container runtime, discovery, the command line | `server/sandbox/runtime.mjs` |
| The built-in egress proxy, engines, the CIDR fence | `server/sandbox/proxy.mjs` |
| iron-proxy: config, credential injection | `server/sandbox/ironproxy.mjs` |
| The audit files, the hash chain, the export | `server/sandbox/audit.mjs` |
| The clone, and collecting a run's tip | `server/sandbox/clone.mjs` |
| `agentHome()` and `runGit()` — the two seams | `server/sandbox/exec.mjs` |
| The lifecycle: plan, prepare, reconfigure, stop | `server/sandbox/index.mjs` |
| The pages, the three buttons, adopt, dry run | `server/sandbox/pages.mjs` |
| The report socket and the per-run token | `server/hub-socket.mjs`, `bin/fl-report` |
| The one author of the container command line, and its printer | `server/sandbox/runtime.mjs`, `sandbox/wrap.sh`, `sandbox/runtime-cli.mjs` |
| The images, and what is not verified about them | `sandbox/images/README.md` |
| What a coding agent or provider declares | [`docs/plugins.md`](plugins.md) |
| The design, and what was measured before it | [`SANDBOX_RESEARCH.md`](../SANDBOX_RESEARCH.md), §11a |
