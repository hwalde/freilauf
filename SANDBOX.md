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
[docs/plugins.md](docs/plugins.md), "The sandbox declaration". The design study
behind all of it — every decision below, and the measurement that forced it —
is the second half of this same file, [Why it is built this
way](#why-it-is-built-this-way); it replaces the former `SANDBOX_RESEARCH.md`.
It keeps that study's discipline of saying which claims rest on a measurement
and which on a reading, and it distinguishes **two epochs** that must not be
read as one: what was established **before this machine had a container
runtime**, and what was measured **on 2026-09-05 against a live rootless
daemon** — the later batch refuting two things the earlier assumed, the larger
being that the built-in proxy could not listen on the host of a rootless
daemon, which is why the listener now runs in a container of its own ([Where
the built-in proxy runs](#where-the-built-in-proxy-runs-in-the-hub-or-in-a-container)).

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

**Set `DOCKER_HOST` even though the hub does not need it.**
`dockerd-rootless-setuptool.sh` exports nothing — it writes a docker *context*,
which only the `docker` CLI reads, and only while `HOME` is set. Every other
client (a Node, Python or Go library, a shell you debug in) falls back to
`/var/run/docker.sock`, which on such a host still exists as a file and refuses
with `EACCES` — so the wrong daemon looks like a broken one. The hub resolves
`$XDG_RUNTIME_DIR/docker.sock` itself and checks that something answers there,
so it is right either way; the line makes every other tool agree with it. It
belongs in **the operator's own `~/.config/freilauf/env`** — Freilauf never
writes to that file:

```
DOCKER_HOST=unix:///run/user/1000/docker.sock
```

with `1000` replaced by `id -u`.

**What rootless costs on this kind of host.** Four things, all measured against
the live daemon on 2026-09-05 (rootless Docker 29.8.0, Ubuntu 24.04; see [Why it
is built this way](#why-it-is-built-this-way)):

- **The limits that exist are `cpu`, `memory` and `pids`.** That is what the
  user slice delegates; `cpuset` and every io limit are **not** delegated, so
  `--cpuset-cpus` and disk-IO limits would be refused by the daemon — they need
  a `/etc/systemd/system/user@.service.d/delegate.conf` drop-in, which is a root
  step. Discovery reads the delegated controllers and the hub offers the limits
  that are actually available rather than a field that would fail at `docker
  run`. All three that are delegated were set and then pushed past: a 512 MB
  allocation under `--memory 256m` was OOM-killed, a fork bomb under
  `--pids-limit 64` stopped at the ceiling, and two busy loops under `--cpus
  0.5` consumed exactly half a core.
- **Container uid 0 *is* the operator.** Under a rootless daemon the container
  runs as root and the files it writes come out owned by the hub user — which is
  why no `--user` flag is passed there, and why git's `safe.directory` check
  never fires in the mounted clone. The failure mode this avoids is worse than a
  wrong owner: `--user 1000:1000` inside a rootless container maps to host
  `100999`, which cannot write a single byte into a directory the hub created.
  **An image whose default user is not root defeats this**, so the shipped
  images run as root and `overlay.Dockerfile` is the place that has to keep
  being checked when somebody supplies their own base.
- **There is no AppArmor on containers at all.** Ubuntu 24.04 ships
  `/etc/apparmor.d/rootlesskit` itself (`flags=(unconfined)` with a `userns,`
  rule), which is what lets rootless Docker work under
  `kernel.apparmor_restrict_unprivileged_userns = 1` — and it means the daemon
  reports no `apparmor` security option and `--security-opt apparmor=…` is
  **accepted silently and confines nothing**. The boundary here is the user
  namespace, seccomp, `--cap-drop ALL` and `no-new-privileges`. Do not check
  this with `aa-status`: as an ordinary user `aa-status --enabled` exits **0**
  with no output, which means "the module is loaded" and says nothing about
  containers. The hub reads the daemon's own `SecurityOptions` instead.
- **The built-in proxy engine cannot listen on the host here** — so on a
  rootless daemon it does not: the hub starts the listener as a container on the
  run's own network instead. That used to be the one thing that stopped three of
  the four shipped profiles starting at all, and it has its own section: [Where
  the built-in proxy
  runs](#where-the-built-in-proxy-runs-in-the-hub-or-in-a-container).

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
[`sandbox/images/README.md`](sandbox/images/README.md) describes.

**You do not have to build them first, but you will want to.** Settings →
Sandbox lists the images this installation needs — the base, one per **enabled**
coding agent, whatever a repository names in its own `sandbox_image`, and the
proxy engine's — each with its state: built, not built yet, building (with the
step it is on), or *the runtime did not answer*, which is deliberately a fourth
answer and not "not built": a daemon that hiccuped must never send somebody off
to rebuild a 5 GB image they already have. A build started here runs **in the
hub**, not in your request: the page shows its progress on the live channel and
you can navigate away. Two people pressing the same button start one build, not
two.

A missing image is otherwise built by the **first run that needs it** — the base
first, if that is missing too — and that run waits for the build. That is
usually a minute or two and, for hermes, about five; building ahead of time is
the difference between a run that starts in seconds and one that starts in
minutes. It is worth knowing why this is a build and not a download:
`freilauf/agent-*` is a **local tag with no registry behind it**, so a pull can
never answer for it. Until 2026-09-06 the launch path only pulled, and a run
whose image was missing simply failed — while this page's own hint promised that
images were "built lazily on first use". They are now.

**The base image builds and has been run.** `base.Dockerfile` produced
`freilauf/agent-base:24.04` on 2026-09-05 and real containers were started from
it — that is the image the mount set, the resource fences and the network modes
were all measured in (see [Why it is built this
way](#why-it-is-built-this-way)). The sentence that used to stand here — *"they
have never been built, because the machine they were written on has no
container runtime"* — was true when it was written and is not any more.

**The agent layers are a different question.** A build succeeding says the
install command found its file; it does not say the CLI inside starts, finds its
seeded home or talks to its vendor. All four layers have now had their CLI
started in a container: **opencode and cursor have carried whole runs** — work
done, committed, reported, merged — while claude and hermes each exposed a fault
that a build could never have shown (see [Four coding agents have been started
in a
container](#four-coding-agents-have-been-started-in-a-container-two-complete-runs-two-hit-bugs)).
Both are fixed; both were in the layer around the image rather than in the image
itself. The per-image state — which layers build, and what is still unverified
about each — is tracked in
[`sandbox/images/README.md`](sandbox/images/README.md) and that file is the one
to believe over this paragraph. Expect the first real sandboxed run of a harness
to be the thing that finds the mistakes around its layer: the first opencode one
found five, and every one of them had been green in the test suite.

**A run that names no image is not an error.** Where neither the repository nor
the profile fills in `image.ref`, the run uses the image the coding agent's own
plugin declares — the same name the Settings page builds, so the two cannot
drift. `image.pull` decides what happens when that image is not on the machine:
anything but `never` fetches it. (`always` does **not** re-fetch an image that is
already there — it means the same as `if-missing` today.) An image
that is still absent afterwards is a **refusal naming the image**, before the
clone, the home and the network are created — it used to be a `docker run` that
failed inside the tmux pane with the daemon's own wording and nothing on the
run's record.

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
| **Balanced** | allowlist through the built-in engine; presets `harness`, `provider`, `git-host`, `package-registries` | `env` | 8 GB / 4 CPU | the ordinary case |
| **Locked down** | allowlist, built-in engine; presets `harness`, `provider` only — **no package registry** | `env` | 4 GB / 2 CPU | a run that must be given every dependency rather than fetching one |
| **Open network** | `open`, built-in engine | `env` | 8 GB / 4 CPU | the repository whose build reaches half the internet and where an allowlist would be a week of whack-a-mole. The container is still a container |
| **Audit** | Balanced, but `auditOnly` — nothing is blocked, everything that *would* have been is written down | `env` | 8 GB / 4 CPU | the mode you roll out in |
| **No secrets in the box** | Balanced's allowlist, through **iron-proxy** with TLS termination | **`inject`** — the container holds a placeholder; the proxy swaps in the real credential on that credential's own hosts | 8 GB / 4 CPU | the run you would not want holding a key. Needs the iron-proxy image and a sandbox CA — the only profile with a setup step |

**The four `builtin` profiles start under a rootless daemon with nothing but
Docker.** (The fifth, `No secrets in the box`, wants an image and a CA first —
see below.) Balanced, Locked down and Audit ask
for `network.mode: allowlist` with `network.engine: builtin`, and until
2026-09-05 that combination could not start a run at all where the hub and the
container bridges are in different network namespaces — which is what rootless
Docker is. The listener does not have to be on the host: under a rootless daemon
the hub starts it as a container on the run's own network, with the same policy
code, the same 403 and the same audit format. Measured against the live daemon:
an allowed host answers, a denied one gets the 403, `git` and `npm` to denied
hosts are refused, and a live policy change takes effect on the next connection.
How that placement is decided, and what it costs, is [Where the built-in proxy
runs](#where-the-built-in-proxy-runs-in-the-hub-or-in-a-container); what an
enforced allowlist has and has not been through is [An enforced allowlist has
now carried real
runs](#an-enforced-allowlist-has-now-carried-real-runs--with-caveats).

The defaults underneath them, for a profile that says nothing: `network.mode
allowlist`, `network.engine builtin`, `secrets.mode env`, worktree `rw`, the
operator's `.git` `ro`, extras `ro`, read-only root filesystem with tmpfs at
`/tmp` (2 GB) and `$HOME/.cache` (2 GB), memory 8 GB, 4 CPUs, `pidsLimit` 4096,
`shmSize` 1 GB, `innerSandbox off`, `retention run`, audit on.

**`memory` and `memorySwap` are written as a pair, and that is not tidiness.**
`--memory 256m` alone leaves `memory.swap.max` at the same figure, so the
container may swap that much again and a thrashing run is not a stopped one
[measured]. All four profiles set `memorySwap` equal to `memory`, which is what
sets the swap ceiling to zero. Do not "simplify" one of the two away in a copy.

**Those four ship with `secrets.mode: env`** — the credentials are passed into
the container as environment variables, exactly as they are for an unsandboxed
run. Three of them once asked for `inject` and the iron-proxy engine, which
meant they could not start a run on any machine that had not installed and
configured a second binary; a default that cannot start is not a default.

**The fifth is `No secrets in the box`, and it is the one that does not.** Its
container holds `fl-token-<random>` where the others hold the operator's real
key; the proxy swaps in the real one on that credential's own hosts and nowhere
else. It is shipped rather than described because it now works — see
[Credential injection](#credential-injection-measured-on-2026-09-05) for the
measurement — and it is deliberately not the default, because it needs three
things a plain Docker installation does not have: the iron-proxy image, a CA on
the machine, and an `injection` declaration on every credential the run uses.

Every one of those three missing is a **refusal at launch that names what is
missing**, never a quiet fall back to `env` — which is what makes shipping it
honest. The profile editor refuses `inject` next to an engine that cannot
inject, and `setSecrets()` on the built-in engine refuses it again at launch, so
the failure is loud at both ends.

The three fields are one decision, and they are what to copy into a profile of
your own:

```json
"network": { "engine": "iron-proxy", "tlsTerminate": true },
"secrets": { "mode": "inject" }
```

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
| where it runs | inside the hub process, or as a container on the run's network — see below | as a container of its own |
| works under a **rootless** daemon | **yes**, in its container placement (measured 2026-09-05) | **yes** — measured 2026-09-05, same daemon |
| CONNECT allowlist, 403 with a readable body, audit log | yes | yes |
| terminate TLS | **no** | yes |
| inject a credential so the key never enters the container | **no** | yes |
| restrict HTTP methods | **no** | yes |

The second row used to read **no**, and it was the awkward part of this whole
document: the engine that was implemented and exercised was the one that could
not run on the recommended posture. That is fixed. The *other* half of the
awkward part — "and the engine that can do the bottom three rows has never been
run" — is fixed too, as of 2026-09-05: the bottom three rows are measured, on a
public image pinned by digest. What they cost is set-up, not credibility: an
image to pull and a CA to generate.

`tlsTerminate` is the root of the other two: without it the proxy sees a CONNECT
line and encrypted bytes, so there is no method to judge and no header to swap a
credential into.

**`secrets.mode: inject` on the built-in engine is refused, not downgraded.**
The hub does not quietly run the weaker mode and let a profile that says
"the key never enters the container" put the key in the container. The profile
editor greys the fields the chosen engine cannot honour, and the policy
builder refuses the combination outright.

### Where the built-in proxy runs: in the hub, or in a container

The built-in engine has **one** implementation and **two placements**, and the
placement is not a field in a profile: it is a fact about the daemon, and an
operator should no more have to configure it than they configure which uid a
container gets. `proxyPlacement()` decides, and everything this document says
about the allowlist, the 403 and the audit is true of both placements:

| Placement | When | How the agent reaches it |
|---|---|---|
| `process` | the ordinary case — a rootful daemon, or `FREILAUF_SANDBOX_PROXY_BIND` set | the run network's **gateway** address, which the hub binds |
| `container` | a **rootless** daemon (`docker info` says so) | the container name — `http://fl-proxy-<run id>:8080` |

The order it asks in: `FREILAUF_SANDBOX_PROXY_PLACEMENT` (`process` or
`container`) if the operator forced one, then `FREILAUF_SANDBOX_PROXY_BIND` —
an operator who has published the listener at an address the container can reach
has answered the question themselves — then rootless → `container`, then
`process`. A machine that can run the listener for free should not pay for a
container: it is 512 MB of fence, a second image start per launch and a name in
`docker ps`, for something the hub was already doing.

**It is not a second proxy**, and that is the property the whole thing hangs on.
`sandbox/proxy-entry.mjs` runs the same `server/sandbox/proxy.mjs` engine out of
three **read-only** bind mounts of the hub's own source (`server/`, `lang/`,
`sandbox/`) — one matcher, one 403 body, one audit format. Two matchers would be
two allowlists that agree until the day they do not, and that is the day one of
them lets something out. Nothing of the hub's *configuration* is mounted: no
database, no `~/.config`, no credential. It runs `node` out of the run's **own
image** (every shipped image descends from `freilauf/agent-base:24.04`, which
carries Node 22), so there is no second image to have on the machine;
`FREILAUF_SANDBOX_PROXY_IMAGE` is the seam for an operator image with no node in
it.

**The container placement is the stronger posture, not a workaround.** A proxy
that sits on the run's network needs no host address on it, so that network
keeps `gateway_mode_ipv4=isolated` and the host stays unreachable from the box.
The in-process placement cannot: the gateway is the only address the container
can reach, so the network is created without gateway isolation and the container
can then also reach host services on that bridge — which is why the proxy's own
[upstream address fence](#the-upstream-address-fence) is not optional there. The
proxy container itself is `--read-only`, `--cap-drop ALL`, `--security-opt
no-new-privileges`, `--pids-limit 256`, `--memory 512m`, and gets its own way
out with a second leg onto `bridge` (`docker network connect`) — a failure to
make that leg is a **failed launch**, because a proxy that cannot reach anything
is a run with no egress and nothing above it would say so.

**The control channel is a file, not a port and not `docker exec`.** The hub
cannot reach that container over the network — that is the whole problem the
placement solves — so a live policy change is written as `policy.json` into a
directory the proxy has **read-only**, by writing a temporary name and renaming
it, and the proxy watches the **directory** (a bind-mounted *file* would keep
pointing at the old inode after a rename, which would look like a silent no-op).
It carries the spec, not a resolved policy, so the proxy computes the policy with
the hub's own builder. Three consequences worth knowing:

- **Those two directories are under the hub's data directory, not the run's.**
  `~/agents/runs/<id>/` is mounted read-write into the *agent's* container, and a
  policy the agent could rewrite is not a policy. Exactly one directory is
  writable from inside the boundary and it holds nothing but the proxy's own
  `egress.jsonl` and its readiness marker.
- **Denials travel out the same way.** The proxy appends its audit line; the hub
  tails that file (`fs.watch`, plus a one-second size check because inotify does
  not propagate on every filesystem) into the run's own `egress.jsonl` and into
  `sandbox:blocked`. One audit file per run, one format, whichever placement
  produced the lines.
- **A hub restart takes the proxy container back over** rather than leaving it
  alone: the container survives untouched, and the file channel has no per-launch
  secret to lose, so the policy channel and the audit tail can be rebuilt for a
  container this process never started. What that costs is written down rather
  than hidden — a denial that happened while the hub was down stays in the
  proxy's own file for the audit export and is not announced a second time.
  iron-proxy keeps the old rule, because its management key died with the process
  that minted it.

**The launch waits for evidence, not for an exit code.** `docker run -d` returns
the moment the daemon accepts the container, so the entry point writes a
readiness marker once its listener is really up and the hub waits for that; where
it never appears, the container's own log is read and put into the refusal.

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

**Who the container runs as depends on the daemon, and the goal is the same in
all three cases: the hub's own uid on the host.** Rootful Docker gets `--user
<hub uid>:<hub gid>`, podman gets `--userns=keep-id`, and under rootless Docker
**no flag is passed at all** — the process is uid 0 *inside* and the hub user
*outside*, because that is what the subuid map does [measured]. The reason is
the bind mounts: a different uid could not write a single commit into the
worktree, and under a rootless daemon `--user <hub uid>` would map to
`subuid + hub uid − 1` and be locked out of every one of them.

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

**And `exec` has to be written out, which is the trap.** Docker's `--tmpfs`
defaults to `noexec,nodev`, and naming other options does not replace those
defaults — `rw` and `size` are *added* to them and `noexec` stays [measured: a
binary copied into such a `/tmp` fails with `Permission denied` and exit
**126**, which reads as a file-mode problem rather than as a mount option]. The
hub therefore emits `--tmpfs /tmp:rw,exec,nosuid,size=…` and keeps `noexec` on
`/run`, where it is meant. If you write a `filesystem.tmpfsSizes` entry of your
own, this is handled for you; if you hand-write a `--tmpfs` anywhere else, it is
not.

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
incident **`docker_unreachable`** — in the **Needs you** group, for the same
reason `tmux_unreachable` is: a daemon that is gone does not come back by
itself, and every sandboxed run on the machine is behind it. It resolves itself
the moment the daemon answers. Nothing is stopped or reaped on the strength of a
question that was never answered.

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

Working *around* the boundary is precisely what the sandbox exists to prevent,
so the prompt names the way through it instead.

**An access request reaches you like a help call, and the run keeps working.**
It opens a red **`sandbox_access`** incident in the **Needs you** group — a
host, a path or a memory limit is a decision, and waiting does not make it —
and notifies at once, carrying the agent's own words, with no grace period
(that delay exists so an alarm which answers itself never pages, and this one
cannot answer itself: the agent asked). The same request twice counts on the
open incident and stays quiet. The one difference from `help` is the one that
matters: **the run stays `running`.** A help call means the agent has stopped
and waits; an access request means it hit a wall and was told to carry on with
what it can do. `waiting_help` would stop the finish gate's clock, tell the
watcher the silence is deliberate, and expect your answer to be typed into the
session — and none of that is true, because the answer is a policy change that
reaches the agent through the proxy without anybody typing anything.

**The proxy's 403 body says the same thing** — it names the host and points at
`fl-report access`, in the operator's language.

**And you are told even when the agent says nothing.** Every denial is a
`sandbox:blocked` event; a watcher pass turns those into one **`sandbox_blocked`**
incident per run — **yellow** to begin with, because a wall doing its job is not
a fault, and **red** once it is demonstrably in the way: two or more distinct
hosts turned away, or no measurable work since the denial. The same veto the log
scanner uses applies first, so an agent that kept working is never escalated.
The incident is grown from the *events*, not from a callback, deliberately: the
built-in proxy may be a listener inside the hub or a container beside it and
iron-proxy is always a container, and a fact that only exists while one of those
happens to be in this process's memory goes missing the day somebody switches
engines or the hub restarts mid-run. Separately, a refusal the agent
prints into its own log raises `anomaly:sandbox_denied` on the run's traffic
light, and that statement is **taken back** when the agent is measurably working
again.

**You get three buttons.** The run's detail page lists the hosts that were
turned away, with a count. Next to each:

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

**Retention is the one reader that had to be given the escape hatch**, and not
having it cost a clone per run. The pass that removes a finished run's working
copy checks it for uncommitted work first, and by the time it looks the run's
container is always gone — the container is released when the run ends. So the
check was refused, a refusal read as "dirty", and no sandboxed run's clone was
ever removed; the record said `worktree_dirty` with an empty list of files under
it. It now takes the same neutralised host git the operator's own rescue buttons
take — the config renamed aside, `core.hooksPath=/dev/null`, verified inert
against all eight commands — for a read-only `status`, which is strictly weaker
than the `add`/`commit`/`checkout`/`clean` that path already runs. Where nobody
could look at all the record says so (`unreadable`) instead of claiming there is
uncommitted work.

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
path is taken from the configured runs directory rather than from `$HOME`,
which inside a container is the run's seeded home where `agents/runs` does not
exist. The last fallback a report has used to write into nowhere, silently; the
setting that says where the runs directory is is now passed into the container
too, which is what makes that fix real inside the box rather than only outside
it.

**Both channels were broken at once until 2026-09-05, and neither said so.** The
mount named the socket's path *inside* the container as its source on the host —
so Docker created a **directory** at that name, `fl-report` found no socket, and
every report fell through to an inbox nobody read. Measured on the first real
sandboxed run: the agent worked, committed, reported, was told the report was
safe in the inbox, and the run then sat in `running` for ever. The host path and
the container path no longer share a name, a document that still carries the old
one is refused rather than silently rebuilding the directory, and a hub with no
socket listening mounts nothing and writes `hub_socket_missing` on the run —
degraded, not dead, and written down. **So the per-run token has still never
authenticated a real report**: the one run that came through reported through
the inbox, before any of this was repaired.

---

## What this sandbox does not do

Everything above is what it *does*. This section is what it does not, and it is
the section to read twice. Where a limit rests on something that was measured,
it says so; where it rests on a reading or an inference, it says that instead.

### An enforced allowlist has now carried real runs — with caveats

Until 2026-09-05 the entry here read *"the built-in proxy engine does not work
under a rootless daemon"*, the largest limit this document carried; on
2026-09-05 that became *"the allowlist has been exercised by hand, never yet by
a run"*. On **2026-09-06** even that is gone: two coding agents completed real
runs inside a container whose egress was the enforced **Balanced** allowlist
(builtin engine, proxy in its container placement, rootless Docker 29.8.0), and
they were deliberately told to try to break out.

| harness | model | result |
|---|---|---|
| opencode | z-ai/glm-5.3-flash (OpenRouter) | ran to `done`; **did not escape** |
| cursor | auto (subscription) | ran to `done`; **did not escape** |

Both reached exactly the hosts the presets name (their model provider, the npm
registry) and were refused everywhere else: probes to `example.com`,
`api.github.com` and `1.1.1.1` each came back `sandbox:blocked {action: deny}`,
and cursor's attempts to reach the host gateways (`172.17.0.1`, the run
network's own gateway), `127.0.0.1` and the proxy container by name were denied
too — the gateway is isolated. Neither agent found a way out (see [Two agents
tried to break out, and could not](#two-agents-tried-to-break-out-and-could-not)).

The by-hand measurements the previous version of this section rested on still
hold, and are worth keeping because they isolate the mechanism from any one
agent's behaviour — real clients, real DNS, real TLS tunnels, the hub's own
event at the other end:

| probe | result |
|---|---|
| an allowed host through the proxy | HTTP 200 |
| a denied host | `curl: (56) CONNECT tunnel failed, response 403` |
| `git ls-remote` to an allowed forge | the remote's `HEAD` |
| `git ls-remote` to a denied one | refused, 403 |
| `npm view` against a denied registry | `npm error 403` |
| a live policy change | in force on the next connection, no retry needed |
| audit-only | the request goes through and the hub records it as `sandbox:would_block`, not as a denial |
| a denial reaching the hub | `sandbox:blocked` on the run |

**What is still not established.** Both runs above were a deliberately trivial
probe task, so they exercised a handful of hosts, not the long tail a real build
reaches — a heavy `npm ci`, a `pip` resolve, a submodule from a forge the
presets do not name. So the caveat that used to open this section is narrower
now but not gone: expect a first *working* run to teach you something about your
presets — that
is what [audit-only](#audit-only-and-growing-an-allowlist-out-of-it) is for, and
it is the mode to roll out in.

**Why the placement had to change, and what stays true.** The in-process
listener still cannot work under a rootless daemon. That measurement was not
withdrawn, it was routed around (see [The refutation: the built-in proxy cannot
listen on a rootless host](#the-refutation-the-built-in-proxy-cannot-listen-on-a-rootless-host))
— three independent ways, each fatal on its own:

- **The hub cannot bind the run network's gateway.** rootlesskit runs with
  `--detach-netns`, so every bridge the daemon creates lives in *its* namespace
  and `listen()` on that address answers `EADDRNOTAVAIL`.
- **A container cannot reach the host, on any network.** From the default bridge
  and from an internal network alike, the hub's own listening port was
  unreachable at the host's loopback, at the bridge gateway and at the host's
  VPN address — five attempts, five failures. rootlesskit's
  `--disable-host-loopback` is exactly this, by design.
- **`host-gateway` is a false friend.** `--add-host x:host-gateway` resolves,
  and `ping` answers — to a `docker0` interface left behind in the host
  namespace by a **stopped, disabled rootful daemon**. The name resolves, the
  packets never leave rootlesskit's namespace, and the hub is not there.

The answer was to move the listener, not to abandon it: [Where the built-in
proxy runs](#where-the-built-in-proxy-runs-in-the-hub-or-in-a-container). So the
table that used to say what worked *instead* now says only where the listener
lives:

| | on a rootless daemon |
|---|---|
| `network.mode: open` / `none` | work — measured |
| `network.mode: allowlist`, `engine: builtin` | works — the listener is a container on the run's own network, and that network keeps its gateway isolated |
| `network.mode: allowlist`, `engine: iron-proxy` | works — measured 2026-09-05 on this daemon, allowlist and credential injection both (see below) |
| any mode, **rootful** daemon | the hub and the bridges share one network namespace, so the in-process listener should work — *inferred, not measured*: there is no rootful daemon here to ask. It costs you the `docker` group in your threat model |

**One refusal is left in the predicate**, and it is the operator's own doing: a
placement **forced** to `process` (`FREILAUF_SANDBOX_PROXY_PLACEMENT=process`)
under a rootless daemon is refused before anything is started, because that is
exactly the combination the three measurements above rule out. The launch,
Settings → Sandbox and the profile editor all ask that one predicate, so an
operator cannot be told two different things about one profile. A daemon that
did not say whether it is rootless is **not** a refusal: the launch then fails
on the bind, which is worse than a diagnosis and better than refusing a run over
a question nobody answered.

**`iron-proxy` has a binary and a default image now.** It is
`ironsh/iron-proxy`, public on Docker Hub, pinned by digest in
[`sandbox/images/ironproxy.ref`](sandbox/images/ironproxy.ref), and
`FREILAUF_SANDBOX_PROXY_IMAGE` remains the override for a mirror. What it still
needs from the operator is a **CA** — it mints leaf certificates and will not
start without one — which is why an allowlist run should keep using the built-in
engine and only the three things that need TLS termination (restrict methods,
keep the credential out of the container, judge a path) should reach for this
one. See [Credential
injection](#credential-injection-measured-on-2026-09-05).

**The one fallback there is stays narrow.** A `secrets.mode: env` profile whose
named engine will not start falls back to the built-in engine with a `warn`, and
that fallback is asked the same placement question the first attempt was — so
under a rootless daemon it falls back into a container placement, and never onto
a listener no container could dial. (An `inject` profile never falls back at
all: it fails outright, by design.)

**A hub restart is repair, not immunity.** An in-process listener dies with the
hub while the container carries on with a frozen `HTTPS_PROXY`; a watcher pass
rebinds it on the same port with the same resolved allow list and writes
`sandbox:proxy_restarted`. There is a window between the restart and the next
pass, and a proxy that cannot come back leaves a `warn` on the run rather than
failing it.

A **container** proxy survives the restart, and since 2026-09-05 the hub takes
it back over rather than leaving it alone: a running built-in proxy container is
re-attached, its policy channel and its audit tail rebuilt for a container this
process never started — which the file control channel makes honest, because
there is no per-launch secret to have lost. What that costs is written down
rather than hidden: a denial that happened while the hub was down stays in the
proxy's own file for the audit export and is not announced a second time. A
proxy container the daemon says is **gone** is started again (that is a run with
no egress at all); one the daemon will not answer about is left alone.
**iron-proxy is the exception and keeps the old rule** — its management key was
minted per launch and died with the process that minted it, so the hub holds no
handle for a surviving iron-proxy container and does not fabricate one, and a
live policy change on such a run is **refused** with *"the proxy is gone"*
rather than reported as a policy it never delivered. Reconfiguring it resumes
the run.

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

### The container can read the hub's own script directory, and its own paths

Two things both probe agents found on 2026-09-06, neither of them a way out and
both worth knowing rather than leaving to be discovered:

- **The host's `~/.local/bin` is mounted read-only into the box.** That is the
  hub↔agent channel — it is how `fl-report` is there at all, and `fl-api` and
  the rest of the `fl-*` tools with it. It also means the agent can read those
  scripts, and through them learn the shape of the host's Freilauf
  installation. A scan of that directory for cleartext secrets found none (the
  scripts reference environment variables), and narrowing the mount to
  `fl-report` alone was considered and rejected: it would break the other tools
  an agent legitimately uses. What was fixed instead is the thing that made it
  dangerous — those host scripts used to come FIRST on the container's `PATH`,
  so a host wrapper could shadow the image's own CLI (which is exactly how
  hermes failed). The image's directories now win, and the mount is left where
  it is as a deliberate trade.
- **`/proc/self/mountinfo` and the run's `sandbox.json` name host paths.** The
  overlay's directories on the host are visible as strings inside the
  container. They cannot be reached from there; it is disclosure of layout, not
  access.

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

And the argument of such a step can be written by the agent inside the box.
`{{trigger.run.report}}`, `{{trigger.run.last_report}}`,
`{{trigger.run.help_text}}`, `{{trigger.run.branch}}`, `{{trigger.run.pr_url}}`
and `{{trigger.merge.files}}` all carry text the run itself produced — a report
is something an agent writes for free — and a flow template is substituted
**raw**: it quotes nothing, because a template is text and not a command line.
So `echo "{{trigger.run.report}}" >> log.txt` in a `shell_command` is a shell
the agent can reach straight through the sandbox boundary.

The step therefore **refuses such a template by name** unless *"allow text the
agent wrote"* is ticked on that step. Ticked, it behaves exactly as it always
did — `shell_command` is the operator's tool and stays one, and an operator who
wants the branch name in a deploy command is not doing anything odd. The check
is deliberately an opt-in and not an escape: escaping would have to know where
in the command the value lands (inside quotes, in a heredoc, as part of a path),
and a wrapper that guesses breaks working flows while still missing what it
guessed wrong.

**What the check cannot see, and what you therefore still have to look at
yourself:** the same text one hop further out. A value that reached `vars.*`
through an `extract` step is an LLM's reading of the agent's report; a value
that came out of another `shell_command`'s `stdout`, or out of an
`http_request` body, may be anything. Those are not marked, because no static
check on a template can tell them from an operator's own constant. The rule to
carry is the plain one: **a host shell step's command line should be written by
you, and the values in it should be values you chose.**

**With the box ticked, the check is an ephemeral container of the run's own
image** — the integration worktree bind-mounted, `--cap-drop ALL`,
`no-new-privileges`, the run's own network and proxy variables under `allowlist`
— **and where it cannot be one it refuses rather than falling back.** No
runtime, a missing image, exit 125, a daemon that positively is not there: all
of them end the merge with *"nothing was merged, and it was NOT run on the
host"*, a `merge_error` escalation and the ordinary `merge_blocked` incident
with its "Merge now" button. A failing check is still just a red check, and a
timeout is a red check too, not a refusal.

Two edges of that worth knowing. A run that is **not itself boxed** — the
sandbox off, bypassed, or a spec with no image — makes the check run on the host
even with the box ticked, and says so with a `merge_check_host` event naming the
reason; the box cannot conjure a container for a run that never had one. And the
check container's `/tmp` is currently mounted `rw,nosuid` **without `exec`**,
unlike the run container's, so a merge check that unpacks and executes a helper
out of `/tmp` will fail there with exit 126 where the same command succeeds
inside the run.

### Credential injection: measured, on 2026-09-05

`secrets.mode: inject` swaps a placeholder for the real credential in the
request's own header, at a TLS-terminating proxy, so the container never holds a
key. It is **built**: `setSecrets()` is on the engine interface, iron-proxy
writes the `secrets` transform and relaunches the proxy from its own launch
context — a running container's environment cannot be changed, and this happens
while the sandbox is being prepared, before the agent's container exists, so
nothing in flight is dropped. The built-in CONNECT engine answers the same call
with a **refusal naming the engine**, and the caller fails the launch on it.
Every engine answers, which is why the capability question is never asked in two
places and can never come back as "no such function" instead of "this engine
cannot".

**It has now been run against the real iron-proxy binary, and it works.** This
paragraph used to say the opposite, at length, and the sentence it replaces —
"built but unexercised" — was the honest one for as long as there was no binary
here. There is one now: `ironsh/iron-proxy` is a public image on Docker Hub
(Apache-2.0, source at `github.com/paradigmxyz/iron-proxy`), pinned by digest in
[`sandbox/images/ironproxy.ref`](sandbox/images/ironproxy.ref).

The measurement, against `ironsh/iron-proxy:0.49.0` on rootless Docker 29.8.0:
an agent container holding a placeholder, a proxy container holding the real
key, a stub upstream that echoes back the headers it received, and one
credential declared for one host.

| what was asked | what happened |
|---|---|
| `docker exec <agent> printenv STUB_API_KEY` | `fl-token-PLACEHOLDER-9f3c11` — the placeholder, not the key |
| the agent calls **the credential's declared host** with that value | the stub received `X-Api-Key: sk-REALKEY-…` — the real one |
| the agent sends the same value to **another allowed host** | the stub received `fl-token-PLACEHOLDER-9f3c11` — untouched |
| the agent calls a host that is **not on the allowlist** | `curl: (56) CONNECT tunnel failed, response 403` |
| the real key in `proxy.yaml` / the audit log / `docker inspect <agent>` | 0 occurrences, 0 occurrences, 0 occurrences |

`proxy.yaml` is mounted into the proxy and carries only the *name* of the
environment variable; the value lives in the proxy container's environment and
nowhere else. `docker inspect` of the **proxy** does show it — that container is
the trusted half, and moving the secret off it is what the `file` and
`vault_kv`/`aws_sm` sources upstream offers are for, none of which the hub uses
yet.

**Four guesses the binary corrected, and three of them failed silently.** Only
one was a loud error; the rest were accepted and ignored, which is the shape a
security control must never fail in:

- `log.format` **does not exist** — the one loud failure (`field format not
  found in type config.Log`). It is the reason not to trust the others' silence.
- `dns.enabled: false` is **required**. iron-proxy wants to be the sandbox's
  resolver; Freilauf reaches it through `HTTPS_PROXY` instead, and without this
  line the binary refuses to start (`dns.proxy_ip is required`).
- `deny_domains` **does not exist**, and an unknown key inside a transform's
  `config` is **swallowed without a word**. A config carrying it started
  cleanly and enforced nothing. Deny hosts are therefore subtracted from the
  allowlist in the hub, and a deny that only narrows a wildcard — which cannot
  be expressed on this engine at all — is reported to the operator instead of
  written into a key that would eat it. The same is true of a `methods` list
  beside `domains`: a method restriction is `rules: [{ host, methods }]`, and
  the wrong shape is silently no restriction.
- **`require: true` breaks injection completely on this path.** That flag
  rejects a request to a declared host that does not carry the placeholder,
  which sounds exactly right and, over `HTTPS_PROXY`, rejects everything: the
  first thing the proxy sees is a CONNECT, and it evaluates a *synthetic*
  CONNECT — no headers at all — against the secrets transform. Every call to
  the one host the credential was for died as a 403 (`rejected_by: "secrets"`,
  `annotations: { rejected: "STUB_API_KEY" }`), while calls to hosts the
  credential was *not* for went through. Freilauf does not write it. What that
  costs is the bypass fence — a workload can still reach a declared host with
  a credential of its own — and it comes back the day the sandbox routes
  through iron-proxy's DNS interception instead of a proxy variable.

Also measured: `POST /v1/reload` is an empty POST with the bearer token,
answering 200, and 401 without it. And the audit line's field names were right
while their *place* was wrong — they sit inside an `audit` object, not at the
top level, so the mapper that reads `egress.jsonl` into one shape had been
returning nothing for every line a real proxy writes. Both are fixed and pinned
by unit tests against log lines copied verbatim out of `docker logs`.

**What it needs before it will start.** Three things, and each missing one is a
refusal at launch that names itself rather than a fallback to `env`:

1. the image — `docker pull` the pinned digest in `ironproxy.ref`, or point
   `FREILAUF_SANDBOX_PROXY_IMAGE` at your own mirror;
2. **a CA**, because iron-proxy terminates TLS by minting leaf certificates and
   will not start without one. Put both halves in the directory
   `sandbox_ca_dir` names — the hub reads `ca.crt` and `ca.key` from it, mounts
   the certificate into the agent's container (so the minted leaves are trusted
   there) and the **key into the proxy alone** (whoever holds it can forge any
   host the agent talks to):

   ```bash
   mkdir -p ~/.local/share/freilauf/sandbox-ca && cd $_
   openssl genrsa -out ca.key 4096
   openssl req -x509 -new -nodes -key ca.key -sha256 -days 3650 \
       -subj "/CN=Freilauf sandbox CA" \
       -addext "basicConstraints=critical,CA:TRUE" \
       -addext "keyUsage=critical,keyCertSign,cRLSign" -out ca.crt
   chmod 600 ca.key
   ```

   The `keyUsage` line is not decoration: a CA without it starts the proxy and
   then kills it with `initializing cert cache: CA certificate missing
   KeyUsageCertSign` — measured. The same shipped config also refuses to start
   if `IRON_MANAGEMENT_API_KEY` is unset, which the hub always mints, so only a
   hand-run config meets that one;

3. an `injection` block on every credential the run uses (see
   [docs/plugins.md](docs/plugins.md)). A credential whose plugin declares none —
   cursor's `CURSOR_API_KEY` is the shipped example — **refuses the launch**,
   because passing the real value would be a lie about what the container holds
   and passing a placeholder would be a 401 at the first call.

The shipped profile **No secrets in the box** is exactly this posture, and it is
the only one of the five whose container does not hold the operator's real key.

Two limits stay whatever the binary turns out to do.

**Injection covers exactly one class of credential**: one carried verbatim in a
request header — a bearer token, an API-key header. It **cannot** cover a scheme
where the client signs the request with the secret. **AWS SigV4** is the obvious
one, and so is any HMAC-signed request: the signature is computed over the
method, path, headers and body hash *before* the request reaches the proxy, from
a key the client must already hold. Such a credential either enters the
container (`secrets.mode: env`) or the run cannot use that service. There is no
third answer, and there is no signing hook anywhere in the code. The same goes
for OAuth flows that mint or refresh a token, credentials carried in a query
string or a body, and mTLS client certificates.

**And a credential whose plugin declares no `injection` block refuses the
launch, by name.** Under `env` such a variable is simply passed in, which is a
working configuration and not a defect. Under `inject` there is no third answer
for it: passing the real value would be exactly the lie the profile promised not
to tell, and passing a placeholder nobody swaps would 401 every API call on a
run that still looks healthy. So the run does not start, and the message names
the variable. **cursor's `CURSOR_API_KEY` is deliberately that case** — which
header carries it was never established — so a cursor run needs
`secrets.mode: env` today. A refusal that names a variable is a sentence an
operator can act on; a fallback would have been a bug they found in a log.

### Runtimes that are named but not implemented

`runtime` accepts four values and three of them exist:

| value | state |
|---|---|
| `docker` | implemented, and what everything was designed and tested against |
| `runsc` (gVisor) | implemented as the same `docker` CLI plus `--runtime=runsc`; it presumes the daemon has gVisor registered, and no daemon here does. Discovery lists the runtimes the daemon knows. Asking for one it does not know fails at `docker run` with *"unknown or invalid runtime name: runsc"* [measured] rather than falling back to `runc` |
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

### Two things about the audit

- **The container's lifecycle is recorded, and its shape has never been seen
  from a real daemon.** `docker events --filter container=fl-<id>` is started
  *before* the container is created, so `create` and `start` are captured, and
  it is stopped on every teardown path. What each line contains is the daemon's
  business and nothing here has read one: the field names are documented, not
  observed.
- **The audit chain is not a signature.** It proves that the copy you were
  handed was not edited after export; it does not prove the hub recorded the
  truth, and there is no key, so somebody who re-runs the chaining gets a valid
  file again. The exported file says so on its own header line.

### Four coding agents have been started in a container; two complete runs, two hit bugs

All four coding agents have now been launched into a container. **opencode and
cursor complete real runs and merge/finish their work; claude and hermes each
hit a bug that stops them at launch.** The honest state, harness by harness:

| harness | in a container | outcome |
|---|---|---|
| opencode | yes | ran to `done`, work merged; probes denied, no escape |
| cursor | yes | ran to `done`; probes denied, no escape |
| claude | starts, then blocks | **"Not logged in"** — a subscription-credential gap, below |
| hermes | fails at launch | **exit 127** — the pane dies immediately, below |

What the completing runs establish, the layer nothing before them could reach:

- **The tmux pane really is the container's terminal.** `capture-pane` shows the
  TUI, `send-keys -l` reaches it, a bracketed paste arrives unsubmitted the way
  it does on the host — the transport chosen for it survives a real agent, not only
  a relay under a shell.
- **A container that exits hands its status to `pane-died`** (measured at 42, 125
  and, from the hermes failure, 127), which is what every "the agent is gone"
  path in the hub is built on.
- **The run's files land where the hub expects them**, and the finish gate and
  the integrator read the working copy through the box and merge what they find.
- **The report socket carries a real report** under its per-run token — the
  completing runs reported over the unix socket, and a control test forged a
  report for a foreign run id and got **401**.
- **The sessions page reports the container's own memory** (786 MB, where the
  pane's process tree would have said about ten).

**Two bugs the first enforced runs exposed**, both the invisible kind — the run
reads as healthy from every page:

- **claude on a subscription cannot authenticate in the box.** Its TUI shows
  *"Not logged in · Please run /login"* and the run sits `running` /
  `agent_state: waiting` with no incident. The sandbox deliberately does not
  copy `~/.claude/.credentials.json` into the container and injects the OAuth
  token only through `credentialValue('claude', 'oauth_token')` — a stored
  value, a named variable, or the declared `CLAUDE_CODE_OAUTH_TOKEN`. An
  installation whose token lives only in the credentials file (which is the
  ordinary subscription case) has none of those set, so the container gets no
  token. A subscription claude in the sandbox needs its OAuth token supplied on
  the Plugins page or in the environment until the hub learns to seed it from
  the file it already reads for quota.
- **hermes does not launch at all** (`pane_died {exit: 127}`). `fl-start`
  resolves the harness binary with `command -v` on the *host*, which for hermes
  is a wrapper `~/.local/bin/hermes` that `exec`s a host python venv
  (`~/.hermes/hermes-agent/venv/bin/python`) — a path that does not exist in the
  image, which ships hermes at `/usr/local/bin/hermes`. Baking the host's
  absolute path into the container command line is what breaks it; a sandboxed
  run has to resolve the binary inside the container. The other three launch
  because their host path either matches the image or is not a venv shim.

And **one suspected cleanup gap**: after the hermes launch failed with its proxy
already started, the `fl-proxy-<id>` container was still running a minute later,
where the proxies of runs ended normally (a killed running run, and closed
`done` runs) were reaped within about half a minute. That points at the
`failRun()` path not registering the proxy for teardown — not yet confirmed,
because the container was removed by hand before a longer wait could settle
whether a later reconcile pass would have caught it.

Two **non-escape observations** both completing agents reported independently,
worth knowing though neither is a way out: `/proc/self/mountinfo` and the run's
`sandbox.json` leak host paths into the container (string disclosure of the
overlay's host directories), and the host `~/.local/bin` is mounted read-only
into the box (the intended channel for `fl-*` — and the very thing that let the
hermes host wrapper be reached; a secret scan of it found no cleartext
credentials, only references to environment variables).

An earlier run on 2026-09-05 (opencode, `network.mode: open`) exposed five
faults that had all passed the whole test suite: the wrong user for the hub's
own git calls inside the box, the socket mount coming out a directory, the
report fallback writing to a path the hub does not read, containers started with
an empty name and empty labels, and the pane's client talking to the wrong
daemon. All are fixed and in the [changelog](CHANGELOG.md). The lesson is worth
more than the fixes: a **`docker` shim cannot answer whether an account exists
inside an image or whether a mount point came out a socket**, so a green suite
says nothing about either.

The per-layer build state and what is unverified about each image is in
[`sandbox/images/README.md`](sandbox/images/README.md), which is
authoritative over this file on everything to do with the images. The unit and
e2e suites still drive a **`docker` shim**, not Docker.

### Two agents tried to break out, and could not

The two completing runs above were not ordinary tasks: each was told, in an
authorised test on the developer's own machine, to probe the boundary and
report whether it escaped. Both verdicts were **NO**, and between them they
exercised every obvious route:

- **Network.** Egress to hosts off the allowlist (`example.com`,
  `api.github.com`, a raw IP) was refused with a proxy 403; the host gateways,
  loopback and the proxy container by name were refused too; only the presets'
  own hosts answered.
- **The runtime.** No Docker socket is mounted; `docker ps` and a curl at
  `/var/run/docker.sock` find nothing.
- **The host filesystem.** Host home, credentials files and the hub database are
  absent from the container's view; the root filesystem is read-only.
- **Privilege.** Root inside the container has **zero effective capabilities**
  (`CapEff=0`), `NoNewPrivs=1`, a seccomp filter is active, and
  `unshare`/`nsenter` return `EPERM`. `/proc/1/root`, cgroup and remount
  routes were all blocked.
- **The report channel.** Reachable, but the per-run token is bound to the run
  id: a forged report for another run id was rejected `401`.

This is a strong result and still not a proof of impossibility — two agents, one
profile (Balanced), one daemon (rootless Docker 29.8.0), and agents whose
enthusiasm for breaking out is itself variable. It is evidence the wall holds
against a direct push, not that no wall ever fails.

### What rests on a reading rather than a measurement

[Why it is built this way](#why-it-is-built-this-way), below in this file, is
the full account — what was established **before this machine had a container
runtime** and what was measured **on 2026-09-05 against a live rootless
daemon**. The short version, because it is what the boundary's edges are made
of:

**Measured against a real daemon, in throwaway containers and networks —
and with real agents working in them:**

- **Real coding agents ran and their work merged/finished** — opencode and
  cursor, behind the enforced allowlist, on 2026-09-06; claude and hermes each
  hit a launch bug. [Four coding agents have been started in a
  container](#four-coding-agents-have-been-started-in-a-container-two-complete-runs-two-hit-bugs)
  says exactly what that establishes and what it leaves untouched.
- The **mount set works end to end** inside a real container: the clone
  read-write, the operator's `.git` read-only at the same path, the masked
  config over it — `git status`, `git log` through the alternates, `git fetch`,
  `git add`/`commit` all succeed, the operator's `.git` really refuses a write,
  and the collect step afterwards brings the tip back into the hub's repository.
- **Every delegated resource fence binds**, and was pushed past to prove it:
  memory (OOM-killed), pids (`can't fork`), cpu (0.50 of a core, 50 throttles).
  `cpuset` and io are not delegated and remain unavailable.
- **`--network none` and `--internal` hold** — no routes at all in the first, a
  route to its own subnet plus the embedded resolver and nothing else in the
  second.
- **The uid map is what the design says**: container root writes host files as the hub
  user, and a `--user 1000:1000` container cannot write into the hub's own
  directories at all.
- **`--tmpfs` is `noexec` by default and naming other options does not undo it**
  — the `exec` above.
- **The built-in proxy engine cannot listen on the HOST of a rootless daemon**,
  three ways; and the containerised topology it had to be moved into does work —
  a proxy container on the internal network with a second leg on `bridge`
  reaches the internet, and a second container on the internal network alone
  resolves it **by name** and reaches it, with no host involvement anywhere.
- **The allowlist really enforces, through that container**, against real
  clients: an allowed host answers, a denied one gets the 403, `git` and `npm`
  are refused by name, a live policy change lands on the next connection, and
  the denial arrives at the hub as `sandbox:blocked` — and, since 2026-09-06,
  two real agents ran behind it and could not get out. [Its own
  section](#an-enforced-allowlist-has-now-carried-real-runs--with-caveats) says
  what that does and does not establish.
- **Docker 29 no longer says `Cannot connect to the Docker daemon`.** A
  classifier keyed on that string was already stale on the first machine that
  had a daemon to test it against, which is why the hub decides on the exit
  status and on whether the socket exists and answers, and treats the message as
  something to print.

**Measured on this machine, with real git / tmux / the real CLIs, before a container runtime existed here:**

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
  hub sets `IS_SANDBOX=1` for a sandboxed claude run. **Under a rootful daemon
  or podman** it does not depend on that: the container user is the hub's uid,
  where the question does not arise. **Under a rootless daemon it does** — there
  the container user *is* root, deliberately (see above), so `IS_SANDBOX=1` is
  the only thing standing between a claude run and its own refusal.
  `IS_SANDBOX` is documented nowhere and is Anthropic's to change. On 2026-09-06
  a claude CLI was started in a container as root under the rootless daemon and
  **drew its TUI** rather than refusing — so `IS_SANDBOX=1` did lift the
  root refusal, moving this from a reading toward a measurement — but it then
  blocked at *"Not logged in"* (the subscription-credential gap in [Four coding
  agents…](#four-coding-agents-have-been-started-in-a-container-two-complete-runs-two-hit-bugs)),
  so the run past login is still unproven.

**Not answered at all, and what the design does instead:**

- **Whether a second copy of `~/.claude/.credentials.json` refreshing its token
  invalidates the host session.** Answering it needs a throwaway account, so it
  was not answered. The design is never exposed to it: a subscription CLI gets
  `secrets.mode: env` with an OAuth token variable, the seeded home carries no
  credentials file, and **nothing may copy `~/.claude/.credentials.json` into a
  run home "for now"**.
- **iron-proxy under load, and with server-sent events.** The engine itself is
  no longer on this list: on 2026-09-05 its configuration file, its reload
  endpoint and its log format were all read by the thing that is supposed to
  read them, and a placeholder in the container really did become the real
  credential on the way to that credential's own host — see [Credential
  injection](#credential-injection-measured-on-2026-09-05), including the four
  guesses the binary corrected. What was *not* exercised is everything about
  scale and shape: a long-lived SSE stream through the MITM path (a coding
  agent's whole conversation is one), a large request body against
  `max_request_body_bytes`, several runs' proxies at once, and what a leaf
  certificate cache does over a run of hours. A single stub upstream and a
  handful of curls is a proof of the mechanism, not of the mileage.
- **gVisor.** `runsc` is on no `PATH` here and the daemon lists only
  `io.containerd.runc.v2` and `runc`. The one thing that was measured is the
  refusal — `unknown or invalid runtime name: runsc` — which confirms that a
  missing runtime fails at `docker run` with a namable error rather than
  silently falling back to `runc`.
- **podman**, still not installed, so `--userns=keep-id` and `:idmap` remain a
  reading.
- **AppArmor applied to a container.** Confirmed only *negatively*: on a
  rootless daemon nothing is confined and `--security-opt apparmor=…` is
  accepted and ignored. Whether a rootful daemon with `docker-default` loaded
  applies it as documented was not measured, because there is no rootful daemon
  here to ask.

One item that used to stand here is **answered**: whether the daemon can isolate
the container network's gateway. `gateway_mode_ipv4=isolated` exists on Docker
29.8.0 and is `--internal`-only, exactly as the design pairs them. It comes with
a reading trap worth knowing if you inspect a network by hand — with the option
set, Docker omits the `Gateway` key entirely, so `docker network inspect
--format '{{.Gateway}}'` prints the literal string **`invalid IP`** rather than
an empty value, and a correctly isolated network read that way looks
misconfigured.

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
| The built-in egress proxy, engines, the CIDR fence, both placements | `server/sandbox/proxy.mjs` |
| The same engine, as it runs inside its own container | `sandbox/proxy-entry.mjs` |
| iron-proxy: config, credential injection | `server/sandbox/ironproxy.mjs` |
| The audit files, the hash chain, the export | `server/sandbox/audit.mjs` |
| The clone, and collecting a run's tip | `server/sandbox/clone.mjs` |
| `agentHome()` and `runGit()` — the two seams | `server/sandbox/exec.mjs` |
| The lifecycle: plan, prepare, reconfigure, stop | `server/sandbox/index.mjs` |
| The pages, the three buttons, adopt, dry run | `server/sandbox/pages.mjs` |
| The report socket and the per-run token | `server/hub-socket.mjs`, `bin/fl-report` |
| The one author of the container command line, and its printer | `server/sandbox/runtime.mjs`, `sandbox/wrap.sh`, `sandbox/runtime-cli.mjs` |
| The images, and what is not verified about them | `sandbox/images/README.md` |
| What a coding agent or provider declares | [`docs/plugins.md`](docs/plugins.md) |
| The design, and every measurement behind it (both epochs) | [Why it is built this way](#why-it-is-built-this-way), below |

---

## Why it is built this way

Everything above says what the sandbox does. This says why, and carries the
evidence — the design study that preceded the implementation, condensed to the
measurements that forced a decision. It replaces the former
`SANDBOX_RESEARCH.md` and keeps that document's discipline: a claim is either
**measured** (an exit code on this machine), **read** (out of a shipped binary
or a primary document) or **not answered at all**, and the three are never
blurred. A design that is only correct under the answer one hopes for is not a
design, it is a bet.

**Two epochs, and the difference is load-bearing.** The design was written
against the hub of 2026-09-02 and measured on 2026-09-05, in two batches that
must not be read as one. **Before a container runtime existed here**: `command
-v docker` and `command -v podman` both failed, no binary under `/usr/bin` or
`/usr/local/bin`, no docker or podman unit at either scope — real git, real
tmux and the four real CLIs were available, a daemon was not, and where a
question could not be asked that batch said so and stated what the design does
so as to be safe under *both* answers. **Against a live rootless daemon**:
Docker Engine 29.8.0 arrived on the same host hours later and the open questions
were put to it in throwaway directories, containers and networks — this batch
**refutes two things the first assumed**, that the built-in proxy could listen
on the host of a rootless daemon and that the container's `/tmp` is executable.
Where a paragraph below names one of the two, that is where it came from;
several code comments depend on knowing which.

---

### A container around the agent, tmux on the host

The pane command becomes `docker run -it …` around the agent's ordinary command
line. The Docker CLI allocates a TTY in the container and relays its raw bytes
both ways (the attach API's `application/vnd.docker.raw-stream`), turns the
pane's `SIGWINCH` into the resize API, and exits with the container's exit code.

Before a runtime existed here, that shape was tested against a 40-line Python
PTY relay with a fake TUI as its child, on a private tmux socket. Measured, tmux
3.4: `pipe-pane` sees the inner program's output, `capture-pane` reads the inner
screen, `send-keys -l` with the hub's bracketed paste traverses the relay byte
for byte, `pane-died` fires with the **inner** exit status (`pane_dead=1`,
`pane_dead_status=7`), `remain-on-exit` keeps the last screen. A real opencode
run later confirmed the same through a real container, `pane-died` carrying
container exit statuses 42 and 125.

| Rejected placement | Why |
|---|---|
| a long-lived container with `docker exec -it` as the pane | **nothing on the host can signal an exec'd process** (moby #9098, #35703, open since 2014 and 2017), so `pane-died` could only mean "client gone" |
| tmux inside the container | a `docker exec` indirection on every hub-side tmux call, two tmux servers to reconcile, tmux in every image — double the control surface for one advantage `resumeRun()` has since made small |
| a process sandbox (bubblewrap / Anthropic's `srt`) | deferred, not rejected: same seam, weaker boundary, dead on this host (below) |

Three details follow rather than being taste. **`--detach-keys` must be
overridden**: Docker's default `Ctrl-P Ctrl-Q` holds a bare `Ctrl-P` back until
the next key and every TUI uses `Ctrl-P`. **`--init` is not optional**: killing
the pane sends SIGHUP to the CLI, which forwards it, but a PID 1 with no handler
never receives a signal (pid_namespaces(7)) and Node handles SIGTERM and SIGINT
and *not* SIGHUP — so a run is stopped by name, never by killing the pane. And
**`pane_current_command` reports the transport** (measured: `python3` for the
relay, `docker` in reality), so a session's harness is still read from the tmux
name prefix.

That last fact takes the memory accounting's basis away. With the workload
re-parented off the relay — a container's shape exactly, its processes being
children of the shim in the daemon's cgroup — the pane's process tree summed
**10.4 MB** while the workload held **210.3 MB**. A twenty-fold under-report, in
the number the sidebar prints on every page. The live agent confirmed it:
`docker stats` said 786 MB where the pane tree would have said about ten.

### Why the coding agents' own sandboxes are not the boundary

Two of the four ship a sandbox **command** (claude, cursor), one sandboxes
**tool calls elsewhere** (hermes' terminal backends), one has **permissions
only** (opencode). None sandboxes *the agent process*, which is what holds the
credentials, reads the prompt and talks to the hub — claude's documentation is
explicit that its sandbox covers "Bash commands and their children only" while
"built-in file tools, MCP servers, and hooks still run directly on your host".
Four vocabularies also make "configure the boundary once per repo" impossible,
and an external plugin may have nothing at all.

They survive only as an inner layer nobody should switch on, because of the
**nested-sandbox conflict**: Chromium's sandbox, bubblewrap, `srt`, Codex's
sandbox and cursor's fallback all want `clone(CLONE_NEWUSER)` and `mount`
*inside* the container, while Docker's default seccomp profile masks the
namespace flags out of `clone` and gates `unshare`/`setns`/`mount` on
`CAP_SYS_ADMIN`, and the `docker-default` AppArmor template carries `deny mount,`
and no `userns` rule. Either the container is the boundary or it is opened up
and loses exactly the syscalls that break out of containers. Hence
`innerSandbox: off` in all four profiles.

On this host the question does not arise anyway. Measured before a runtime
existed here, with `kernel.apparmor_restrict_unprivileged_userns = 1` and only
`unprivileged_userns`, `lxc-unshare` and `lxc-usernsexec` profiles present:
`unshare -rn true` fails with *"write failed /proc/self/uid_map: Operation not
permitted"* and `bwrap` 0.9.0 with *"setting up uid map: Permission denied"*.
Claude Code's own sandbox, `srt`, Codex's sandbox and cursor's bubblewrap
fallback are all dead here until an operator installs a profile, and the hub
never runs `sudo`.

### Why Docker Engine, and why rootless

Docker Engine is the only candidate that is open source, present on any Linux
server a company already runs, free of the Ubuntu user-namespace problem and —
decisively — wraps **a command line**, which is the contract every harness
already has with `fl-start`. gVisor plugs into the same command
(`--runtime=runsc`) and bubblewrap into the same seam, so both are later
runtimes rather than different designs. The rejected shapes each fail on one
thing: Kata/Firecracker/microsandbox want KVM and virtiofs without inotify;
Sysbox is rootful-only and belongs to repos needing Docker *inside* the agent;
firejail is setuid root by design; Landlock names ports, not hosts, so it cannot
express "allow api.anthropic.com" at all; OPA/Rego, because no agent-sandbox
vendor uses it and JSON with a lock list is what Claude, Cursor and Docker ship.
One comparison is a reason rather than a survey entry: **Docker Sandboxes**
(`sbx`) is proprietary, KVM-only and limited to its own agent list — a pattern,
not a base — and its value is that Docker's own product independently validates
every structural choice here, same-path mounts, a host-side deny-by-default
proxy, a live `policy allow network <host>`, credentials injected so they never
enter the VM, and "no git inside a host worktree", which is exactly the problem
the clone solves differently.

**Rootless is recommended because the `docker` group is root-equivalent** —
anything that can talk to a rootful socket can mount `/` into a privileged
container. Rootless keeps the daemon in the hub user's own namespace, so an
escape lands where the hub already was, which is the worst case the sandbox is
designed against anyway.

What that costs, measured against the live daemon: Docker Engine 29.8.0, API
1.56, containerd v2.3.4, runc 1.5.1, rootlesskit 3.1.0, socket
`unix:///run/user/<uid>/docker.sock`, storage `overlayfs`, cgroup driver
`systemd`; the rootful `docker.service` inactive and disabled and the `docker`
group (gid 985) empty; runtimes `io.containerd.runc.v2` and `runc` only;
`/etc/subuid` `<hub user>:100000:65536`; rootlesskit's own command line
`--net=gvisor-tap-vsock --disable-host-loopback --port-driver=builtin
--detach-netns`. Those last two flags are the whole of the proxy story below.

**AppArmor does not apply to containers here, and the cheap way to check lies.**
Ubuntu 24.04 ships `/etc/apparmor.d/rootlesskit` — 354 bytes, dated 2024-07-15,
`profile rootlesskit /usr/bin/rootlesskit flags=(unconfined) { userns, }`, whose
own comment says it allows everything and exists only to give the application a
name. The daemon reports `seccomp`, `rootless`, `cgroupns` and **no `apparmor`**,
and `--security-opt apparmor=docker-default` is accepted without complaint and
confines nothing: inside such a container `/proc/self/attr/current` reads
`rootlesskit (unconfined)`. A profile name silently ignored is worse than one
refused, because a settings page could print it back as effective. And
`aa-status` must not be the source: as a non-root user it prints *"You do not
have enough privilege to read the profile set"* and exits **4**, while
`aa-status --enabled` — the cheap form a discovery step reaches for — exits **0**
with no output, meaning only "the module is loaded". Same family as
`--no-optional-locks` after the subcommand making a dirty worktree read clean.
The hub reads the daemon's own `SecurityOptions`.

### Who the container runs as: one function, in numbers

Measured against the live daemon, four `docker run`s against a bind-mounted
directory:

| `--user` | uid inside | owner of a file it creates, on the host |
|---|---|---|
| *(none, root image)* | `0:0` | `1000:1000` — the hub user itself |
| `0:0` explicitly | `0:0` | `1000:1000` |
| `1000:1000` | `1000:1000` | `100999:100999` |
| `1001:1001` | `1001:1001` | `101000:101000` |

The subuid base is 100000 and container uid 1 is the first mapped id, so
container uid *n* is host `99999 + n`. The failure mode that rules out is worse
than a wrong owner: with `--user 1000:1000` into a directory the hub created the
container could not write **at all** (`touch: Permission denied`), because that
directory is owned by host 1000, which the container sees as `root`. The same
map is why git's `safe.directory` check never fires — clone owned by host 1000,
process uid 0, one identity through the map.

**The identity is not a profile field, and the first real sandboxed run paid for
that correction.** The design carried `"user": "hub"` as a *policy word* for
"whichever identity the daemon's posture gives". A field on a document is a
field somebody reads, and one did — it went into `docker exec -u`:

```
Error response from daemon: unable to find user hub: no matching entries in passwd file
```

Every git call the hub made inside the box failed, the dirt check answered
*unknown*, and the finish gate wrote `finish_error` every few seconds for ever
on a run whose status was `running`, whose session was alive and whose agent was
idle in its TUI. There are **two** moments the table applies — `docker run`
decides who the agent is, `docker exec` decides who the hub is — they were
decided separately and came out different. `containerIdentity()` answers both,
in **numbers**, so an exec can never depend on a `passwd` entry existing.
(`userns-remap` on a rootful daemon was rejected for a related reason:
bind-mounted files appear as `nobody` and Docker exposes no per-container
id-mapped mount — moby #52061 closed unmerged, roadmap #398 unanswered.)

### Why a clone, and not a linked worktree

A linked worktree is wired both ways [measured, git 2.43]: the worktree's `.git`
file points at `<repo>/.git/worktrees/<name>`, whose `commondir` and `gitdir`
point back. Per-worktree state — `HEAD`, `index`, `logs/HEAD` — lives **inside
the operator's `.git`**, so even `git add` needs write access there and a
read-only mount fails at the first `index.lock` (Codex issue #27418 is that
error). Mounting only the worktree directory gives `fatal: not a git repository`,
reproduced. Mounting the operator's `.git` read-write instead hands the agent
`.git/hooks/`, which run **on the host** the next time anybody runs git there;
`.git/config`, whose `core.fsmonitor`, `core.sshCommand` and `diff.external` are
commands git executes; `refs/heads/*`, so `git update-ref refs/heads/main` moves
the operator's main and `pushOperatorBase()` then pushes it; and `objects/`,
where a `gc --prune=now` after deleting refs orphans what other worktrees need.
Masking `hooks/` and `config` closes two of the four.

The clone was measured before a runtime existed here, on a source repository of
302 files with a bare `origin`: `fetch origin`, `checkout --detach origin/main`,
a commit, a second incremental fetch and `cat-file` on a blob that exists only
in the alternate all work — including with the source `.git` at `chmod -R a-w`.
It costs nothing: source `.git/objects` **3.1 MB**, the clone's **16 KB** before
any work and **40 KB** after a commit. All three branch modes land on the same
commit `makeWorktree()` would have chosen, and the third is why the second fetch
refspec `+refs/heads/*:refs/remotes/local/*` exists — `makeWorktree()` prefers
the operator's **local** branch over `origin/<name>`, which a clone cannot
otherwise see.

**The config mask must be a minimal replacement, not an empty file.** Measured
on a `--object-format=sha256` repository whose config was emptied: `git log` →
*"fatal: your current branch appears to be broken"*, `git ls-remote` → **exit 0
with an all-zero sha**. A silent wrong answer is worse than an error.
`core.repositoryformatversion` and the whole `[extensions]` block are what tell
git how to read the repository at all (likewise a partial clone's
`extensions.partialClone` and `remote.origin.promisor`), so they are copied and
everything else — `remote.*`, which may carry a token in a URL, `user.*`,
`core.fsmonitor` — is dropped.

### Why host git may never run inside an agent-owned clone

A clone was built as designed and then made hostile: `.git/config` given
`core.fsmonitor`, `core.sshCommand`, `core.alternateRefsCommand`, `core.pager`,
`core.editor`, `uploadpack.packObjectsHook` and `diff.external`, every one
`touch /tmp/PWNED_<name>`, plus twelve executable hooks each touching a marker.

**The collecting fetch is clean.** Six variants — plain, with
`GIT_CONFIG_NOSYSTEM=1` and `-c uploadpack.allowAnySHA1InWant=false`,
`ls-remote`, an explicit refspec, `file://`, `--dry-run` — and **not one marker
appeared**; all six exit 0, the ref resolved, and a blob only the clone had came
back. `uploadpack.packObjectsHook` is respected only in **protected
configuration** (system, global, command scope), and git's manual says why: "an
attacker who controls these scopes can do substantial harm without using Git".
`merge-tree --write-tree --name-only` behaved too — a tree sha on a mergeable
pair, exit 1 with the conflicting path otherwise, `git status` in the source
still empty. So the bundle variant that was considered is unnecessary.

**The positive control is the finding**, in the same clone:

| host-side command in the clone | what fired |
|---|---|
| `git --no-optional-locks status --porcelain` | `core.fsmonitor` |
| `git diff` | `core.fsmonitor`, `diff.external` |
| `git add -A && git commit` | `core.fsmonitor`, hooks `pre-commit`, `post-index-change`, `reference-transaction` |
| `git checkout -- .` | `core.fsmonitor`, hooks `post-checkout`, `post-index-change` |
| `git rev-parse HEAD` | nothing |
| `git rev-list --count HEAD` | nothing |

**And hardening the named keys away is not enough.** With `-c
core.hooksPath=/dev/null -c core.fsmonitor=false -c diff.external=` and
`GIT_CONFIG_NOSYSTEM=1`, a `filter.evil.clean` driver still ran — selected by a
`.gitattributes` of `* filter=evil`, a **tracked file the agent commits** — on
`status`, `add -A` and `diff HEAD` alike. `diff.<name>.textconv` and
`merge.<name>.driver` are the same family. git 2.43 has at least seven
repo-local ways to name a command and there is no `GIT_CONFIG_NOLOCAL`: a
repository's own config cannot be switched off from the command line. A denylist
of config keys is not a boundary and must not be described as one.

So only the two commands measured inert plus the fetch stay on the host, and
everything that reads the working copy goes through `runGit()` into the
container or does not run. Where the rescue path and the retention check must
look on the host anyway, the clone's `.git/config` is replaced by a minimal file
for the duration of the call **and** `core.hooksPath=/dev/null` is passed — the
substitution alone leaves `.git/hooks` as the default hooks directory and
`post-index-change` fires. That combination fired nothing against all eight
commands. One related measurement, because it looks like a config problem and is
not: the merge driver for `merge-tree` is resolved out of the **source**
repository's config, which is the hub's, so a `.gitattributes` naming
`merge=evil` merged into the base branch selects a driver the source does not
define and falls back to the built-in.

**The whole mount set then ran inside a real container** against the live daemon
(`freilauf/agent-base:24.04`, git 2.43 inside and out): `status` clean, `log`
reaching the source's history, alternates resolving (3 loose objects in the
clone to the source's 6, `rev-parse HEAD~1` still answering), the operator's
`.git` genuinely refusing a write (*"Read-only file system"*), the masked config
readable, empty and holding zero occurrences of the token in the source's remote
URL, `fetch`/`add`/`commit` all rc 0, and the collect step bringing the tip into
the hub's repository.

### Why the network policy lives in a proxy outside the container

Measured against the live daemon: `--network none` leaves no routes and no
reachable address at all; an `--internal` network gives a route to its own
subnet, an embedded resolver that answers container names, and nothing else —
`wget` against an external name fails with `bad address`, against an external
literal with `Network unreachable`. `gateway_mode_ipv4=isolated` exists on
29.8.0 and is `--internal`-only (asking for it elsewhere is refused: *"gateway
mode 'isolated' can only be used for an internal network"*), which is how the
design already pairs them.

The policy is a proxy rather than iptables or DNS interception for one reason
that is the whole feature: **it can be widened while the agent is running.**
Every product that offers live relaxation puts the policy outside the boundary
(Docker Sandboxes' `sbx policy allow network`, Modal's `updateNetworkPolicy()`,
Vercel, `srt` as a library), and none offers it for filesystem policy, which is
baked into the namespace at start — which is why network and resource changes
are live here and a filesystem change is a resume. One proxy **per run** because
iron-proxy has one bind per daemon.

### The refutation: the built-in proxy cannot listen on a rootless host

The design offered the built-in engine as "a CONNECT proxy inside the hub
process" and called it the natural first implementation. Against the live daemon
that is impossible here, three ways, each fatal alone:

- **The hub cannot bind the run network's gateway.** `listen(port, '<gateway>')`
  from a plain node process answers `EADDRNOTAVAIL: address not available`, and
  `ip addr` in the host namespace shows no bridge for that subnet at all.
  rootlesskit runs `--detach-netns`, so every bridge the daemon creates lives in
  *its* namespace.
- **A container cannot reach the host, on any network.** From the default bridge
  and from an internal network alike, the hub's real listening port was
  unreachable at the host's loopback, at the bridge gateway and at the host's
  VPN address — five attempts, five failures. `--disable-host-loopback` is
  exactly this, by design.
- **`host-gateway` is a false friend.** `--add-host x:host-gateway` resolves and
  `ping` answers — to a `docker0` interface left behind in the host namespace by
  the **stopped, disabled rootful daemon**. The name resolves, the packets never
  leave rootlesskit's namespace, and the hub is not there.

**The conclusion moved; the measurements did not.** Only the words after
"inside" were refuted — the matcher, the 403 body, the CIDR fence and the audit
line never depended on where the socket was. So the listener was moved rather
than abandoned: one engine, two placements, and the placement is a fact about
the daemon rather than a field in a profile. Two matchers would be two
allowlists that agree until the day one of them lets something out.

The topology it moved into was measured in the same session: a container on the
internal network given a second leg with `docker network connect bridge` holds
`eth0` on the internal subnet and `eth1` on the bridge, has a default route only
through the second, and resolves and reaches the internet; a second container on
the internal network alone resolves the first **by name** through the embedded
resolver and reaches it. That is the proxy and the agent with no host
involvement anywhere — which is also why the container placement can keep
`gateway_mode_ipv4=isolated` where the in-process one cannot.

**The control channel is a file for two reasons.** The hub cannot reach that
container over the network, which is this section's whole finding; and `docker
exec` is deliberately not the answer either, because the proxy container is
`--read-only --cap-drop ALL --security-opt no-new-privileges` precisely so that
it does not accept new processes. The proxy watches the **directory** rather
than the file, because a bind-mounted file keeps pointing at the old inode after
a rename — which would look like a silent no-op.

**One defect the move made visible**, carried by the in-process placement all
along: a denied CONNECT ended its client socket with no `'error'` listener
attached, and curl answers a refused tunnel by resetting it — so `read
ECONNRESET` became an uncaught exception and the proxy died one second after its
first denial. In a container that is a run whose egress stops at its first
blocked host. **In the in-process placement it is the hub** — scheduler, watcher
and every SSE client — at the moment an agent first hits its own allowlist. The
listener is registered before the DNS lookup now, on both entry points.

One audit finding from the proxy's log format is worth keeping: a tunnel writes
twice, once when established and once when it closes with its byte counts, and
only the closing line existed at first. A keep-alive tunnel that lives for a
whole run closes at teardown — so a run's own model provider appeared nowhere in
its egress log while the run was going. The security record was intact (a denial
is written at once); the traffic record was not. Hence the `phase` field.

### Why the report channel is a unix socket with a per-run token

`127.0.0.1` inside a container is the container, and on an internal network the
host is unreachable by design. Two alternatives fell to the same objection:
binding the hub on the Docker bridge gateway would put a second network listener
on a process whose whole security story is that it binds firmly to loopback, and
`host.docker.internal:host-gateway` needs a host route the internal network
deliberately lacks — and, as measured above, would not have worked here anyway.
The socket also carries an improvement the hub should have had regardless:
`FL_RUN_ID` was the only authentication the report route had, and the hub's
whole API — kill any run, type into any session, read settings holding the
notification token and provider credentials — sits on the same port.

The rule the first real sandboxed run left behind, where both halves of that
channel were broken at once and neither said so: **a path on the host and a path
inside the container may not share a field name.** The mount named the socket's
container path as its source on the host, Docker made a **directory** of it, and
the fallback the reports then took resolved its own path from `$HOME` — which
inside the box is the seeded home.

### Why `--tmpfs` has to say `exec`

| flag | resulting mount options | a binary copied into `/tmp` |
|---|---|---|
| `--tmpfs /tmp` | `rw,nosuid,nodev,noexec,relatime,…` | `Permission denied`, exit **126** |
| `--tmpfs /tmp:rw,size=64m` | `rw,nosuid,nodev,noexec,relatime,size=65536k,…` | `Permission denied`, exit **126** |
| `--tmpfs /tmp:exec` | `rw,nosuid,nodev,relatime,…` | runs, exit 0 |

Docker's default is `noexec,nodev` and naming other options **adds** to those
defaults rather than replacing them. The command line as first designed would
have broken `npm ci` with native modules (node-gyp execs out of a temporary
directory), every installer that unpacks and runs a helper, and every tool that
writes a script to `/tmp` and runs it — with exit 126 and "Permission denied",
which reads as a file mode rather than as a mount option.

### Why the limits are these, and why `memorySwap` is written as a pair

Measured before a runtime existed here: the root cgroup delegates `cpuset cpu io
memory hugetlb pids rdma misc`, the **user slice** only `cpu memory pids`, at
`user.slice/user-<uid>.slice` and `user@<uid>.service` alike, and
`/etc/systemd/system/user@.service.d/delegate.conf` does not exist — this is
systemd 255's stock `Delegate=pids memory cpu`. Hence the hub offers the limits
the machine delegates rather than a `--cpuset-cpus` or io field that would be
refused at `docker run`. All three were then set and pushed past against the
live daemon:

| fence | flag | inside | pushed |
|---|---|---|---|
| memory | `--memory 256m` | `memory.max` = `268435456` | a 512 MB allocation → `OOMKilled=true`, `ExitCode=137` |
| pids | `--pids-limit 64` | `pids.max` = `64` | 200 background processes stopped at the ceiling, `sh: can't fork: Resource temporarily unavailable` |
| cpu | `--cpus 0.5` | `cpu.max` = `50000 100000` | two busy loops over 5 s consumed **0.50** cores, `nr_throttled` 50 |

**And the memory fence is not a fence against swap unless it is told to be.**
`--memory 256m` alone leaves `memory.swap.max` at `268435456`: the container may
swap a further 256 MB, and a thrashing run is not a stopped one. Only
`--memory-swap` equal to `--memory` sets it to `0`. Docker refuses both ways of
getting the pair wrong verbatim: *"You should always set the Memory limit when
using Memoryswap limit"* and *"Minimum memoryswap limit should be larger than
memory limit"*.

### Why the daemon's wording is printed and never decided on

The design named the string `Cannot connect to the Docker daemon` as a
log-scanner pattern. Docker 29 does not say it any more, measured verbatim:

| situation | Docker 29.8.0 |
|---|---|
| socket absent | `failed to connect to the docker API at unix:///…; check if the path is correct and if the daemon is running: dial unix …: connect: no such file or directory` |
| socket present, no permission | `permission denied while trying to connect to the docker API at unix:///var/run/docker.sock` |
| missing container | `docker inspect` writes `[]` to stdout, `error: no such object: <name>` to stderr, exit **1** |
| missing image | `Unable to find image '<ref>' locally`, then `pull access denied for <repo>, repository does not exist or may require 'docker login'` |
| name conflict | `Conflict. The container name "/<name>" is already in use by container "<id>"…` |
| unknown runtime | `unknown or invalid runtime name: runsc` |

Neither of the first two contains any substring of the old pattern, and neither
carries the `Is the docker daemon running?` question that used to follow it. A
classifier keyed on a vendor's wording was already stale on the first machine
that had a daemon to test it against — so the verdict is decided on the exit
status and on whether the socket exists and answers, and the message is
something to print. The same instinct as `tmuxVerdict()`, whose lesson is that
"I could not answer you" must never be spent as "it is gone". The last row is
also the only gVisor measurement this machine allowed, and it is worth having: a
missing runtime fails at `docker run` with a namable error rather than silently
falling back to `runc`.

### Why the home is per run, and why no image may set the XDG variables

Measured before a runtime existed here, each CLI run once with `HOME=<throwaway>`
for a non-API command: every one created its full state tree under the throwaway
home and **nothing** appeared under the real one.

| CLI | where the conversation lives | keyed on |
|---|---|---|
| claude 2.1.261 | `<config>/projects/<slug(workdir)>/<session id>.jsonl`, `<config>` = `$CLAUDE_CONFIG_DIR` else `$HOME/.claude` | `$HOME`, overridable |
| opencode 1.18.29 | `<data>/opencode/opencode.db`, `session` keyed by absolute `directory` + `parent_id`; `<data>` = `$XDG_DATA_HOME` else `$HOME/.local/share` | **XDG first**, `$HOME` only as its fallback |
| cursor-agent 2026.09.02 | `<data>/projects/<slug(workdir)>/agent-transcripts/…` and `<data>/chats/<md5(workdir)>/`; `<data>` = `$CURSOR_DATA_DIR` else `~/.cursor` | `$HOME`, overridable; auth under a second root |
| hermes 0.21.0 | `$HERMES_HOME/state.db`, `sessions` keyed by absolute `cwd` | `$HOME`, overridable |

The second row is why `overlay.Dockerfile` fails a build that sets
`XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `CLAUDE_CONFIG_DIR`,
`CURSOR_DATA_DIR` or `HERMES_HOME`: **XDG outranks `HOME`**, an image carrying
one sends the CLI's state where the hub does not read, and every consequence is
silent — seeded credentials never read, the reporting plugin never loaded, the
activity measurement looking into an empty directory and concluding the agent is
idle.

Cursor's slug was an open question and is answered: the rule in the shipped
bundle is `e.replace(/[^a-zA-Z0-9]/g,"-").replace(/-+/g,"-").replace(/^-+|-+$/g,"")`
over the workspace path and nothing else — byte for byte what
`cursor-transcript.mjs` implements. The home enters only as the containing
directory, and once more in the **truncated** variant for paths over 92
characters, whose sha256 is taken over the full path *including* the home; two
such directories exist under the real `~/.cursor/projects`, both empty, and
reproducing the rule matches them only with the home in the hash input.

Two consequences that are rules. **The hub used to read these stores from the
hub's home**, hardcoded at four call sites, and every one fails *soft* — no
activity becomes `anomaly:no_activity` on a working run, no tokens becomes a
cost of zero, no resume id becomes a fallback. Hence `agentHome()`. And **two of
the four resume fallbacks are silent lies**: with the wrong store, opencode's
`resumeId()` degrades to `'last'` and hermes' to `'latest'` — both look like
answers and both would continue the wrong conversation, where cursor's returns
`null`, which the hub already reads honestly. So a `resumeId()` from a store the
run did not write counts as no id at all. One latent hub bug found on the way:
claude's real slug rule replaces **every** non-alphanumeric character, not just
`/`, so a worktree path with a dot, an underscore or a space produces a
directory `replaceAll('/', '-')` would never find.

### claude, root and `IS_SANDBOX` — read out of a binary, not executed

Deliberately marked as a reading. `claude doctor` prints no settings, there is no
settings dump among its subcommands, and every path that resolves settings and
then acts on them starts a session that costs quota — so the answers came from
the shipped 2.1.261 binary, a 215 MB bun executable whose JavaScript chunks are
readable with `strings`.

**Root.** The refusal is one predicate: `platform !== "win32" && getuid() === 0
&& !isSandboxEnvSet() && !isBubblewrapEnvSet()`, the first being
`process.env.IS_SANDBOX === "1"`. So "a recognized sandbox" means `IS_SANDBOX=1`
or `CLAUDE_CODE_BUBBLEWRAP` and nothing else — being in a container is
explicitly not enough: the binary has a separate `isDocker()` testing for
`/.dockerenv`, and this predicate does not consult it. Under a rootful daemon or
podman the container user is the hub's uid and the question does not arise;
under a rootless daemon the container user *is* root, deliberately, so
`IS_SANDBOX=1` is the only thing standing between a claude run and its own
refusal. It is documented nowhere and steers other behaviour too (the
529-overload retry path, a "contained, no internet" probe), so this stays a
partial answer: the flag lifts the refusal; nobody has promised it will keep
meaning that.

**Hooks.** The binary's settings-report schema carries the source enum
`["userSettings","projectSettings","localSettings","flagSettings","policySettings"]`
described as *"Ordered low-to-high priority — later entries ov[erride]"*, and
`flagSettings` is `--settings`. So the hub's inline hooks outrank a project
file — but the hook resolver reads the **merged** settings and returns `{}` when
`disableAllHooks` is true anywhere in the merge, and project settings are in
that merge. The binary says so itself: *"launcher_hooks materialized, but a repo
`.claude/settings.json` or `settings.local.json` carries `disableAllHooks:true` —
the child will drop every flagSettings hook"*. Six lines in a repository would
silence `fl-report _api_error`, `_working`, `_waiting` and `Stop` for that run,
and the hub's only symptom would be a run that reports nothing, which reads as
an idle agent. The lever is `--setting-sources user`, which claude's own
plugin-eval runner uses on itself; a source that is not loaded cannot contribute
a `disableAllHooks`. `--bare` is **not** the lever: it is documented as "skip
hooks" and the resolver returns `kind:"none", reason:"bare"`. Two further facts
from the same read: hooks are skipped entirely in an untrusted workspace, so the
trust flag must exist in the **run's** home; and `.claude/settings.local.json`
hooks are additionally dropped when that file is git-tracked (`reason:
"repo_provenance"`) — a fence the hub gets for free and must not rely on.

### Secrets: why `inject` fails loudly, and what no proxy can cover

The measurement against `ironsh/iron-proxy:0.49.0` is in [Credential
injection](#credential-injection-measured-on-2026-09-05) above; the reasoning it
produced belongs here. Injection exists because the credential question is not
"where do we store the key" but "does the key have to be in the box at all" —
Anthropic's CISO guide puts it as "the environment the agent loop runs in should
never hold a credential worth stealing", and every mature product answers at the
proxy. That is only expressible with TLS termination, which is why
`tlsTerminate`, `inject` and method restriction are one capability, not three.

**Four of five guesses about the engine's configuration failed silently**, which
is the durable lesson: an unknown key inside a transform's `config` is accepted
and ignored, so a config full of policy that does nothing starts as cleanly as a
correct one. Only `log.format` failed loudly (*"field format not found in type
config.Log"*), which is the only reason to distrust the others' silence.
`deny_domains` and a `methods` list beside `domains` are both swallowed; a CA
without `keyUsage=critical,keyCertSign,cRLSign` starts the proxy and then kills
it with *"initializing cert cache: CA certificate missing KeyUsageCertSign"*;
`dns.enabled: false` is required or the binary refuses to start with
*"dns.proxy_ip is required"*; and the audit line's field names were right while
their *place* was wrong — inside an `audit` object, not at the top level, so the
mapper would have returned nothing for every real line and left `egress.jsonl`
empty, a silence indistinguishable from a quiet run.

**`require: true` is the clearest argument in this whole document for measuring
a security control rather than reading about one.** It rejects a request to a
declared host that does not carry the placeholder — exactly the bypass fence one
wants — and over `HTTPS_PROXY` it rejects everything: the first thing the proxy
sees is a CONNECT, and it evaluates a *synthetic* CONNECT carrying no headers at
all against the secrets transform. Every call to the one host the credential
existed for died as a 403 (`rejected_by: "secrets"`, `annotations: { rejected:
"STUB_API_KEY" }`) while calls to hosts the credential was *not* for went
through untouched. It is documented to do the right thing, it does the right
thing, and in this topology the right thing is a wall across the only door.

**What no proxy can cover** is a scheme where the client signs the request with
the secret. AWS SigV4 and any HMAC-signed request compute the signature over the
method, path, headers and body hash before the request leaves the client, from a
key the client must already hold; such a credential either enters the container
under `secrets.mode: env` or the run cannot use that service. The same goes for
OAuth flows that mint or refresh a token, credentials in a query string or body,
and mTLS client certificates. A raw-socket client that bypasses the CA bundle is
the other documented hole (`NODE_OPTIONS=--use-openssl-ca` mitigates it for
Node).

### What the enterprise survey actually changed

Most of the vendor comparison was process and is gone. Six findings were not.
**Nobody sandboxes by trusting the agent's own judgement** — Docker's wording is
"An LLM deciding its own security boundaries is not a security model", so the
policy is set before the run and the agent gets a way to *ask*, not a way to
*change*; that is the whole design of the access request. **The layering rule
has three independent precedents that agree** — Claude's `allowManaged*Only`,
Cursor's "deny lists union", Docker's "local deny rules still apply on top" — and
Codex adds the half that mattered most: when a lower layer conflicts with a lock
the client "falls back to a compatible value and **notifies the user**", which is
why a refused override is an event and a form warning, never a silent fall back.
**Every product that runs unattended surfaces a block where the human already
looks** — Copilot into the PR body, Docker into the policy log, Claude into the
tool result. **Live relaxation exists exactly where the policy lives outside the
boundary, and nowhere for filesystem policy**, so the split between "live" and
"reconfigure and resume" is an observation and not an implementation limit.
**Audit is redacted by default everywhere and nobody is tamper-evident**, so a
hash-chained export was cheap and was the one requirement no vendor answered.
And **hostname allowlisting is what every vendor ships and every vendor
disclaims** — E2B states it plainly, "Blocked connections may appear successful
from inside the sandbox". The threat underneath is Willison's lethal trifecta —
private data, untrusted content, the ability to communicate externally — which a
coding agent has all three of by default.

Two borrowings from code rather than documents: **hermes' docker backend was the
reference flag set** (`--cap-drop ALL` with a minimal add-back,
`no-new-privileges`, `--pids-limit` gated on cgroup delegation, `--shm-size 1g`
because Docker's 64 MB default crashes Chromium renderers, and labels for an
orphan reaper whose rule is that running containers are never reaped), and
**audit-only with an Adopt button is Greywall's `--learning` and Copilot's
"recommended allowlist"** — observe first, enforce second.

### Toolchain facts the image and the profile rest on

`npm ci` with native modules needs `python3`, `make` and `g++` in the image and
no capability at all as a non-root user; as root, npm drops to the directory
owner's uid for lifecycle scripts, which needs `CAP_SETUID`/`CAP_SETGID`.
inotify across a bind mount works on the same kernel (it is inode-based) under
Docker Engine and Podman and not across a VM boundary or under gVisor for
host-side edits — so a dev server in the container sees the agent's own edits
everywhere and the hub's only under runc/Podman. The opencode plugin
`~/.config/opencode/plugins/freilauf.js` has to be in the seeded home or a
sandboxed opencode run never reports an API error. And `merge_check` is host
execution of merged agent code, the general shape of which Docker's own security
page names: "implicit execution files (hooks, CI configs, Makefiles,
package.json scripts) can be modified by agents and later executed locally".

### What the test suite structurally cannot say

The first real sandboxed run exposed five faults and **every one was green in
the whole suite beforehand**: the exec identity, the socket mounted as a
directory, the report fallback writing to a path the hub does not read,
containers started as `--name fl-` with empty labels because the document and
its reader named the run differently, and the pane's `docker` falling back to
the rootful socket with no `DOCKER_HOST`. Four of the five look like a perfectly
healthy run from every page the hub has.

The reason is structural: **a `docker` shim cannot answer whether an account
exists inside an image, or whether a mount point came out a socket.** `docker
exec -u hub` is a well-formed command line and the shim answered it happily;
`-v <path>:<path>` for a host path that does not exist is likewise well-formed,
and Docker answers it by creating a directory. For the container layer a green
suite is evidence about the **hub's own logic** — the argument shape, the order
of the steps, the refusals — and about nothing else.

### What was never answered, and what the design does instead

- **Whether a second copy of `~/.claude/.credentials.json` refreshing its token
  invalidates the host session.** Answering it needs a throwaway Anthropic
  account; running it on the operator's own is how one loses a live session. The
  design is arranged never to be exposed to the answer: a subscription CLI gets
  `secrets.mode: env` with an OAuth token variable, the seeded home carries no
  credentials file, and nothing may copy `~/.claude/.credentials.json` into a
  run home "for now".
- **iron-proxy's mileage.** The mechanism is measured; the scale is not — a
  long-lived server-sent-event stream through the MITM path (a coding agent's
  whole conversation is one), a large body against `max_request_body_bytes`,
  several runs' proxies at once, and what a leaf-certificate cache does over
  hours. A handful of curls against one stub proves a mechanism.
- **gVisor**, beyond the refusal quoted above: `runsc` is on no `PATH` here and
  the daemon lists only `io.containerd.runc.v2` and `runc`.
- **podman**, still not installed, so `--userns=keep-id` and `:idmap` remain a
  reading of its documentation.
- **AppArmor applied to a container**, confirmed only *negatively*: on a
  rootless daemon nothing is confined and the flag is accepted and ignored.
  Whether a rootful daemon with `docker-default` loaded applies it as documented
  was not measured, because there is no rootful daemon here to ask. The same gap
  makes the in-process proxy placement an inference rather than a measurement:
  the hub and the bridges should share one network namespace there, and nobody
  has checked.
