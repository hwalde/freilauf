# Running agents in a sandbox — a design study for Freilauf

> **Status:** research and design, nothing implemented. Written 2026-09-02 against the
> hub as it is on `main` at that date. Facts are tagged **[measured]** (observed on the
> development machine or in this repository), **[documented]** (a primary source, URL
> given) or **[inferred]** (reasoning from the two; verify before relying on it).
> The private planning document is not needed to read this one.
>
> **Revised 2026-09-05** against the recovery design (`freilauf-tmux.service`
> owning the tmux server, `resumeRun()` picking a lost session back up in a new
> one, `launch.resume` as the machine-readable resume form). Where this document
> used to describe resume mechanics of its own — `respawn-pane` in the same
> session, a `sandbox.resume` flag, the human `resumeCommand()` as if it were
> executable — it now refers to those; the sandbox adds nothing to how a run comes
> back, only what has to be standing around it when it does (§7.11, §7.12.4).

## 0. The short version

**What is asked for.** Companies want to let a coding agent run unattended
(`--permission-mode dontAsk`, `--auto`, `--yolo`, `--force`) instead of approving
every shell command by hand, and they will only do that behind a boundary they
configured *before* the agent started. Freilauf should therefore be able to run a
run's agent inside a sandbox — **optionally**, per repository as the default, and
per agent or single run as an override in either direction — with the boundary
(network, filesystem, resources, secrets) configurable at the same two levels, for
**every** coding agent the hub can drive, on Linux, open source, Docker allowed as a
prerequisite.

**What this document recommends.**

1. **The sandbox is a container around the whole agent process; tmux stays on the
   host.** The pane command of the tmux session becomes
   `docker run -it --rm --init --name fl-<run id> … <image> <agent command>` instead of
   the bare agent command. Everything the hub does with tmux today — `pipe-pane`
   log, `pane-died` hook, `send-keys` for goals and messages, `capture-pane`, the
   browser terminal, `fl-attach`/`fl-kill` — keeps working unchanged, because the
   pane's process is the `docker` client, which relays the container's raw TTY
   bytes in both directions (§7.1, §8.2). This is the one placement that is generic
   across claude, opencode, hermes, cursor and any external plugin: it wraps a
   command line, and a command line is what every harness already hands to
   `fl-start`. The tmux server itself is the one `freilauf-tmux.service` owns, so
   a hub restart never takes a sandboxed run's session down either (§7.11).
2. **A sandboxed run works in a clone of its own, not in a linked worktree.** A
   linked worktree's `.git` is a file pointing into the operator's checkout, so the
   container would need that checkout's `.git` mounted **read-write** — and with it
   the operator's hooks, config and refs, which is the one thing a sandbox must not
   hand to an untrusted agent (§7.4). The clone borrows objects from the operator's
   repo through a read-only mount (`objects/info/alternates`), fetches from it as
   `origin`, and the integrator collects the result with one `git fetch` before the
   merge path it already has.
3. **Network policy lives in an egress proxy outside the container, never in the
   container.** `open` / `none` / `allowlist`; the allowlist is enforced by a proxy
   on an internal Docker network the container has no other route out of, so a
   blocked host is a 403 the agent can read, and — the key property — **the policy
   can be widened while the agent is running**, without restarting anything (§7.5,
   §7.12). The reference engine is `iron-proxy` (Apache-2.0, single Go binary):
   default-deny allowlist, per-request JSON audit log, hot reload, and credential
   injection so provider keys never enter the container. A minimal hub-native
   CONNECT proxy is the fallback for installations that do not want a second
   binary.
4. **The hub talks to the agent through a unix socket with a per-run token**, not
   through `127.0.0.1:<port>` (§7.6). Today `FL_RUN_ID` is the only authentication
   the report endpoint has, and the hub's whole API — kill, send, settings with
   tokens in them — sits on the same port. A container cannot reach the host's
   loopback anyway; the socket is what makes `fl-report` work at all, and the token
   is what stops a sandboxed agent from operating the hub.
5. **Policy layering: hub → repo → agent/run, and lower layers may only narrow what
   the hub layer locks.** The hub operator can set "sandbox required" and lock
   fields (a per-run override may then add denies but not remove allows), the repo
   sets the default and the profile, the agent or run says `inherit | on | off` and
   may carry overrides (§7.3). Every choice that *weakens* the boundary is a named
   event on the run (`sandbox:bypassed {by}`), never a silent setting.
6. **"The sandbox blocks something the agent needs" is designed as a first-class
   flow**, because a misconfigured sandbox that nobody notices is worse than no
   sandbox (§7.12): proxy denials become `sandbox:blocked` events with one-click
   *allow for this run / for this repo*; the prompt tells the agent it is sandboxed
   and gives it `fl-report access "<what and why>"` as the way to ask; the proxy's
   403 body says the same; the log scanner recognises `EACCES`/`EROFS`/proxy
   refusals; and a repo can run in **audit-only mode** first, which logs what would
   have been blocked and proposes an allowlist. Network and resource limits change
   live (`docker update`); a filesystem change needs a new container, for which
   the run is **resumed** through the hub's own `resumeRun()` — a new tmux
   session, the harness's resume form (`fl-start --resume`, `launch.resume` for
   an external plugin), the same clone and the same per-run home — so the agent
   keeps its conversation (§7.12.4).
7. **The container is hardened the boring way**: non-root user with the hub's own
   uid, `--cap-drop ALL`, `--security-opt no-new-privileges`, default seccomp and
   AppArmor, `--read-only` root with tmpfs, `--pids-limit`, `--memory`, `--cpus`,
   a pinned image digest recorded in the run's events (§7.10, §7.11). gVisor
   (`--runtime=runsc`), Podman and a bubblewrap/`sandbox-runtime` "light" mode are
   later runtime options behind the same abstraction; Docker Sandboxes (Docker's
   own microVM product) is a pattern to copy, not a base to build on (§4).

**What it costs.** Phase 1 (container runtime, clone layout, network modes,
profile at repo and run level, kill/reconcile, tests) is the bulk: roughly a new
`server/sandbox/` module of the size of `integrate.mjs`, a `fl-start --sandbox`
branch, one seam in every place the hub touches a worktree or an agent's home
directory, and a `docker` shim for the e2e suite (§10). The hub's own machine does
**not** have Docker installed [measured], so the feature ships behind discovery,
like a coding agent that is not on the `PATH`.

---

## 1. Requirements

### 1.1 From the brief

| # | Requirement | Where it is answered |
|---|---|---|
| R1 | Optional — an installation without Docker, and a repo that does not want it, work exactly as today | §7.3, §7.11 (discovery), §10 |
| R2 | Per repository: whether runs are sandboxed **by default** | §7.3 |
| R3 | Per agent and per single run: override the default in **either** direction | §7.3, §7.13 |
| R4 | Generic — works with every coding agent, built-in and external plugins | §7.1, §7.9 |
| R5 | Configurable boundary: network, files, and "whatever else a sandbox configures" — at repo level as default, per run individually | §7.2 |
| R6 | Secret handling is part of it | §7.8 |
| R7 | Docker may be assumed; the plugin system says per agent whether the sandbox can be chosen | §7.9 |
| R8 | What companies additionally require | §5, §6 |
| R9 | Our architecture — worktree, tmux, the hub's own reads and writes | §2, §7.4, §7.6, §7.11, §8 |
| R10 | Edge cases, above all: the sandbox blocks something the agent legitimately needs — how the user notices, how it is loosened without throwing the agent away | §7.12, §8 |
| R11 | Open source, Linux | §4 |

### 1.2 Derived from the enterprise research (§5)

The mature products — Claude Code's sandbox and managed settings, Codex CLI's
`requirements.toml`, Cursor's run modes, GitHub Copilot's coding-agent firewall,
Docker Sandboxes, Daytona, E2B, Modal, Vercel Sandbox — converge on one list, and
so do the analysts (Anthropic's CISO guide, Gartner, martinfowler.com, Simon
Willison). A self-hosted sandbox is credible when it offers:

- **E1 Deny-by-default egress** with an allowlist the agent cannot reconfigure, and
  an audit trail of every allowed and denied connection.
- **E2 No ambient credentials**: the environment the agent loop runs in holds no
  secret worth stealing; keys are injected at the network boundary.
- **E3 Least-privilege filesystem**: only the run's working copy, read-only
  everything else, protected paths (`.git/hooks`, `.git/config`, shell rc files,
  the agent's own settings) never writable.
- **E4 Ephemeral by default**: one environment per run, removed when the run is
  over, opt-in retention for debugging.
- **E5 Resource quotas**: CPU, memory, pids, disk, wall time — a runaway agent is a
  cost problem before it is a security problem.
- **E6 Audit of what the agent did**: commands, network calls, image digest,
  mounts, policy decisions; exportable; ideally tamper-evident.
- **E7 Image provenance**: pinned by digest, CLI version pinned, auto-update off.
- **E8 Non-root, no Docker socket, no privileged flags**, a real kernel boundary as
  an option (gVisor / microVM).
- **E9 Separation of duties and policy-as-code**: a security role sets the floor
  in one place; teams and runs may tighten, not loosen; every weakening is a
  logged, named exception (break-glass), not a setting.
- **E10 Human-in-the-loop escalation and a kill switch**: a blocked need becomes a
  question a human can answer with one click, and the whole thing can be stopped
  at once.
- **E11 A compliance story that is a control matrix, not a claim**: which control
  evidences which clause (SOC 2, ISO 27001/42001, NIST AI RMF, EU AI Act human
  oversight and logging), published, not asserted.
- **E12 Content inspection (DLP) is out of scope for the sandbox itself** — no
  vendor ships it; the honest answer is a seam for the company's own inspecting
  proxy.

---

## 2. What exists today: the run-start path, mapped for interception

There is **no isolation code anywhere in the repository** [measured]: a grep for
`docker|container|bwrap|firejail|seccomp|podman|nsjail|chroot|unshare` outside
`node_modules` finds only the flow engine's `component: 'container'`, a bracket
matcher's comment, and the test suite's use of the word "sandbox" for its own
fixtures. The current "safety story" is the per-CLI auto-approve flag plus whatever
policy the operator wrote into the CLI's own config in the host home
(`fl-start:133-148`): claude `--permission-mode dontAsk` (with `permissions.allow`
in `~/.claude/settings.json`), opencode `--auto` (with `permission` in
`~/.config/opencode/opencode.json`), hermes `--yolo`, cursor `--force --trust` —
the last two with no fence at all.

### 2.1 The single choke point

`launchRun()` in `server/runner.mjs` (lines 418–543) ends in exactly one process
spawn that becomes the agent:

```js
sh(env('START_SCRIPT') ?? `${HOME}/.local/bin/fl-start`, args, { timeout: 120_000 })   // runner.mjs:526
```

`bin/fl-start` then assembles the harness command (`cmd_autonomous()`,
`fl-start:570-599`), writes the prompt and a launcher script to `$TMPDIR`, and runs

```bash
tmux new-session -d -x $W -y $H "${ENV_ARGS[@]}" -s "$SESSION" -c "$WORKDIR" bash "$LF"   # fl-start:813
```

The launcher does `cd <workdir>`, reads the prompt into `FL_PROMPT`, and `exec`s the
CLI, so the CLI is the pane's own process and `pane-died` means what it means. The
`--env KEY=VAL` arguments become `tmux new-session -e` pairs — the only channel by
which anything (provider keys, `OPENCODE_CONFIG_CONTENT`, `FL_RUN_ID`, `FL_HUB_URL`)
reaches the agent, because a tmux session inherits nothing (`opencode.mjs:240-244`).

**The seam already exists and is already stubbed:** `FREILAUF_START_SCRIPT`
(`env.mjs:29`) is what the e2e sandbox replaces with `test/sandbox-env.mjs`'s stub,
which parses the same options, creates a real tmux session and prints the one line
`runner.mjs:529` parses. A sandbox mode is, at this seam, one more branch inside
`fl-start` that wraps `<cmd>` in a container command — or one more argument
(`--sandbox <spec.json>`) that tells it to.

### 2.2 The twelve places the hub reaches across the boundary

Everything else the hub does happens **outside** the agent and would have to reach
*into* the container, or be made to work across a bind mount. This table is the
checklist for the implementer; each row is a file the design has to change or a
mount it has to make.

| # | What | Where | Consequence for a container |
|---|---|---|---|
| 1 | Worktree at `~/agents/worktrees/<repo>/<short id>-<branch>`, a **linked** worktree whose `.git` is a file `gitdir: <repo.path>/.git/worktrees/<name>` | `makeWorktree()` `runner.mjs:295-330` | useless inside a container unless the operator checkout's `.git` is mounted too — the central problem, §7.4 |
| 2 | Worktree extras, `mode: 'link'` = an **absolute host symlink** (e.g. `node_modules → ~/projects/<repo>/node_modules`) | `applyExtras()` `runner.mjs:341-350` | dangling unless the source is mounted at the identical path |
| 3 | Files written into the worktree before start: only cursor's `.cursor/hooks.json`, with the **absolute host path** of `fl-report` | `writeHarnessHooks()` `runner.mjs:228-239`, `cursor.mjs:83-95` | the path must exist inside the container |
| 4 | claude's hooks travel inline as `--settings <json>` and call bare `fl-report` (PATH) | `claudeSettingsJson()` `runner.mjs:359-377` | `~/.local/bin` must be on the container's PATH |
| 5 | `prompt.md` interpolates host paths: `{workdir}`, `{report_file}` = `~/agents/runs/<id>/report.md` | `platformSuffix()` `runner.mjs:117-149` | the run directory must be mounted read-write at the same path |
| 6 | `FL_HUB_URL=http://127.0.0.1:<port>`; `fl-report` needs `curl` + `python3`; fallback `~/agents/runs/<id>/inbox.jsonl` | `runner.mjs:494-505`, `fl-report:144-171` | loopback is unreachable from a container: §7.6 |
| 7 | Activity and cost measurement read **host home** state keyed on the workdir path: `~/.claude/projects/<slug>/<run id>.jsonl`, `~/.local/share/opencode/opencode.db`, `~/.cursor/projects/<slug>/agent-transcripts/…`, `~/.hermes/state.db` | `measureActivity()` `watcher.mjs:514-597`, `cursor-transcript.mjs` | the agent's home must be a per-run directory the hub can read: §7.7 |
| 8 | Auth material in the host home: `~/.claude/.credentials.json`, `~/.claude.json` (trust flag written by `fl-start:649-673`), `~/.claude/settings.json`, opencode `auth.json` + the `freilauf.js` plugin, `~/.hermes/config.yaml` + `.env`, `~/.config/cursor/auth.json` | §12 of the architecture map; `fl-start:134-140` | seeded into the per-run home or injected at the proxy: §7.7, §7.8 |
| 9 | Host git against the worktree: `rev-parse HEAD`, `--no-optional-locks status --porcelain`, `rev-list --count`, `diff --name-only`, and the rescue path `add -A` / `commit` / `checkout -- .` / `clean -fd` | `integrate.mjs:301, 327, 1072, 1438, 1485-1493` | once the agent is untrusted, its `.git` is hostile to host git (config-driven command execution): §7.4.4 |
| 10 | RSS accounting sums the **process tree under the pane pid** | `sessions.mjs:351-379` | the pane pid is the `docker` client; ask `docker stats` instead |
| 11 | The browser terminal spawns `tmux attach-session` on the host | `terminal.mjs:41-79` | unchanged when tmux stays on the host |
| 12 | Session end = `tmux kill-session`; `reconcileClosedSession()` turns it into a run event; a session the hub did NOT end is handed to `resumeRun()` by the watcher | `sessions.mjs:555-580`, `watcher.mjs` | must also stop the container by name; a container can outlive its client; and a resume has to bring the container, the network and the proxy back with the session: §7.11 |

Two more surfaces are not on the agent's path but matter for the trust story:

- `repos.merge_check` is an operator shell string run as `bash -lc` **on the host**
  in the integration worktree, i.e. it executes the merged result of the agent's
  work (`integrate.mjs:883`). Under a sandbox regime this check must run in the
  sandbox too, otherwise `node test/unit.mjs` is host code execution for whatever
  the agent committed (§8.7).
- The flow step `shell_command` runs on the host by design (`actions.mjs:272-285`);
  it is the operator's tool, not the agent's, and stays as it is — but a flow that
  runs a command *in a run's sandbox* is a natural later step (§10).

### 2.3 The run definition, and where a new field goes

The AGENTS.md rule for `keep_on_branch` is the template: the form block, `runDefFromForm`,
`defFromAgent`, `saveAgent` (INSERT and UPDATE), `createRun`, `RUN_DEF_FLOW_FIELDS`
/ `defFromFlowProps`, two `addColumn()` lines in `db.mjs`, and `pickQuickFields`'s
allowlist in `web.mjs` — the one place a field falls off silently. `runEditAllowed()`
in `run-edit.mjs` decides what a status allows to be edited. The repo form is
`repoEdit()` / `repoSave()` in `pages.mjs` with `integrationFields()` /
`integrationFromForm()` as the block a sandbox section would sit next to. §7.13 lists
the columns.

### 2.4 What this machine has [measured, 2026-09-02]

| Thing | State | Why it matters |
|---|---|---|
| Docker / Podman | **not installed** | the feature must be discoverable and absent-safe; the e2e suite needs a shim |
| `bwrap` 0.9.0 | installed, **fails**: `bwrap: setting up uid map: Permission denied`; `unshare -rn` fails the same way | Ubuntu 24.04 restricts unprivileged user namespaces through AppArmor (`kernel.apparmor_restrict_unprivileged_userns = 1`); only `unprivileged_userns` and `lxc-usernsexec` profiles are present, none for `bwrap` — so Claude Code's own sandbox, Anthropic's `srt`, Codex's sandbox and cursor's bubblewrap fallback are all dead on this host until an operator installs a profile (§4.6, §8.11) |
| Landlock | in `/sys/kernel/security/lsm` (`lockdown,capability,landlock,yama,apparmor`) | cursor's Landlock sandbox and `landrun` would work; Landlock cannot name hosts, only ports |
| cgroup v2 | `cgroup2fs` on `/sys/fs/cgroup` | rootless Docker resource limits are possible with systemd delegation |
| tmux 3.4, git 2.43.0, node 22 | | git 2.43 has no `worktree.useRelativePaths` (2.48+) |
| claude 2.1.258 | `--permission-mode` = `acceptEdits, auto, bypassPermissions, manual, dontAsk, plan`; the binary carries the whole `sandbox` settings vocabulary (`allowedDomains`, `denyWrite`, `enableWeakerNestedSandbox`, `autoAllowBashIfSandboxed`, …) | §3.1 |
| cursor-agent 2026.08.25 | `--sandbox <enabled|disabled>`; ships a 4.6 MB `cursorsandbox` binary ("Sandboxing helper for Everysphere shell-exec", `--policy <json>`, `--preflight-only`; strings: landlock, seccomp, bubblewrap, proxy) | §3.4 |
| hermes 0.20.5 | seven terminal backends (`tools/environments/`: local, docker, ssh, singularity, modal, daytona, vercel_sandbox); `hermes egress` manages an **iron-proxy** credential-injection firewall; `--yolo`, `--safe-mode` | §3.3, §4.5 |
| opencode 1.18.26 | no sandbox; `permission` config only | §3.2 |

---

## 3. What the four coding agents bring themselves — and why the generic layer must not depend on it

Each CLI has *something*, and the four somethings do not line up: two sandbox
**commands** (claude, cursor), one sandboxes **tool calls elsewhere** (hermes), one
has **permissions only** (opencode). None of them sandboxes *the agent process*, and
that process is what holds the credentials, reads the prompt and talks to the hub.
The generic layer therefore wraps the process; the native sandboxes become
per-plugin knobs (§7.9) that are mostly switched **off** inside the container,
because two boundaries are not stronger than one — they are two things that break.

### 3.1 Claude Code: `sandbox` settings, bubblewrap, and the `sandbox-runtime` (`srt`)

**Documented** (https://code.claude.com/docs/en/sandboxing,
https://code.claude.com/docs/en/settings-reference,
https://code.claude.com/docs/en/sandbox-environments):

- The built-in sandbox covers **Bash commands and their children only**; "built-in
  file tools, MCP servers, and hooks still run directly on your host". Linux needs
  `bubblewrap` and `socat`; the network namespace is removed and traffic goes to a
  proxy **outside** the sandbox over a unix socket. DNS resolution succeeds
  (`getaddrinfo`), raw UDP/53 is blocked.
- Settings under `"sandbox"`: `enabled`, `autoAllowBashIfSandboxed`,
  `excludedCommands` (`docker *` is the documented example — "docker is incompatible
  with the sandbox"), `allowUnsandboxedCommands`, `failIfUnavailable`;
  `network.allowedDomains|deniedDomains|strictAllowlist|allowManagedDomainsOnly|
  httpProxyPort|socksProxyPort|tlsTerminate|allowLocalBinding|allowUnixSockets`;
  `filesystem.allowWrite|denyWrite|denyRead|allowRead|disabled`;
  `credentials.envVars|files` with `mode: "deny" | "mask"` (a sentinel inside, the
  proxy substitutes the real value on `injectHosts` — requires `tlsTerminate`);
  `enableWeakerNestedSandbox` (inside an unprivileged container bwrap cannot mount a
  fresh `/proc`; the flag bind-mounts the outer one and "considerably weakens
  security"); `ignoreViolations`.
- Protected paths that `allowWrite` can never reopen: `.claude/*`, `.mcp.json`,
  shell rc files, `.gitconfig`, `.git/hooks`, `.git/config`, `~/.claude`,
  `~/.claude.json`, `.credentials.json`. In a linked worktree, writes to the shared
  `.git` are allowed **except `hooks/` and `config`** — the rule §7.4 copies.
- Blocked hosts are reported in the command's result; a new domain prompts; in
  `dontAsk` the prompt is a **denial**; the agent may retry with
  `dangerouslyDisableSandbox` unless `allowUnsandboxedCommands: false`. Settings
  files are watched and `permissions` and the filesystem lists are **hot-reloaded**
  into the running session.
- `--dangerously-skip-permissions` / `bypassPermissions` "is blocked when running as
  root … The check is skipped automatically inside a recognized sandbox"; Anthropic's
  own recipe for unattended runs is: inside a container/VM/`srt`, **as a non-root
  user**, with egress restricted, `DISABLE_AUTOUPDATER=1`, version pinned, no
  `~/.ssh`/cloud credentials mounted (https://code.claude.com/docs/en/devcontainer).
- `@anthropic-ai/sandbox-runtime` (`srt`, Apache-2.0,
  https://github.com/anthropics/sandbox-runtime, v0.0.75 on 2026-09-01) is the same
  mechanism as a **process-agnostic CLI**: `srt <any command>`, settings in
  `~/.srt-settings.json` (`network.allowedDomains/deniedDomains/allowUnixSockets/
  allowLocalBinding/tlsTerminate`, `filesystem.denyRead/allowRead/allowWrite/denyWrite`,
  `enableWeakerNestedSandbox`). Denials: HTTP 403 with `X-Proxy-Error:
  blocked-by-sandbox-runtime` and the reason in the body, SOCKS refusal, a
  `<sandbox_violations>` block on stderr. As a **library**, `SandboxManager.updateConfig()`
  is "a live swap … takes effect on the next connection" for the network policy;
  filesystem changes need `reset()` + `initialize()` (a new bwrap = a new process).
  Linux: literal paths only, no globs; `allowUnixSockets` is ignored (seccomp cannot
  filter by path); needs unprivileged user namespaces — "cannot run as root or in
  strict AppArmor environments"; the Ubuntu 24.04 failure is issue #74.
- The reference devcontainer's `init-firewall.sh` is the other pattern: `iptables -P
  OUTPUT DROP`, an ipset of resolved domains (`registry.npmjs.org`, `api.anthropic.com`,
  `sentry.io`, `statsig.com`, GitHub's published ranges), needs `NET_ADMIN`/`NET_RAW`,
  verified by "example.com must fail, api.github.com must succeed".
- Claude Code's own required hosts: `api.anthropic.com`, `claude.ai`, `claude.com`,
  `platform.claude.com` (OAuth refresh), `downloads.claude.ai`, `registry.npmjs.org`;
  optional telemetry hosts can be silenced with `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`
  (https://code.claude.com/docs/en/network-config).

**Measured here:** bwrap fails on this host (§2.4), so neither the built-in sandbox
nor `srt` runs without the AppArmor profile. Inside our container the built-in
sandbox would additionally need `enableWeakerNestedSandbox` plus a container
AppArmor profile with `userns,` and a seccomp profile allowing `clone(CLONE_NEWUSER)`
— i.e. we would have to *weaken* the outer boundary to keep the inner one.

**Consequence.** Inside the Freilauf sandbox, claude runs with
`--permission-mode bypassPermissions` (the mode Anthropic itself prescribes for
sandboxes; refuses root, so the container user must be non-root) and
`sandbox.enabled: false` in the per-run settings — or `enableWeakerNestedSandbox:
true` if a repo insists on the inner layer (§7.9). Outside the sandbox nothing
changes. The `srt` **library** is the candidate for a Docker-free "light" runtime
later (§4.6, §10 phase 4), and its proxy semantics (403 with a machine-readable
reason, live `updateConfig`) are what §7.5 and §7.12 copy.

### 3.2 OpenCode: permissions, no sandbox

**Documented** (https://opencode.ai/docs/permissions/, https://opencode.ai/docs/cli/,
https://opencode.ai/docs/config/, https://opencode.ai/docs/server/): `permission`
maps tools (`bash`, `edit`, `read`, `webfetch`, `external_directory`, `doom_loop`, …)
and command patterns to `allow | ask | deny`; `--auto` "only changes requests that
would otherwise ask" — an explicit `deny` still holds. Config precedence ends with
`OPENCODE_CONFIG_CONTENT` (which the hub already uses for provider pinning and
effort) and `OPENCODE_PERMISSION` (inline permissions JSON). The TUI and the server
are one process; tools run where the server runs. State: `~/.local/share/opencode/`
(`auth.json`, `opencode.db`, `log/`), `~/.cache/opencode`, `~/.config/opencode/`
(`opencode.jsonc`, `plugins/`). Network: `models.dev`, `opencode.ai` (Zen), the
chosen provider.

**Measured here:** the hub installs `~/.config/opencode/plugins/freilauf.js` as the
bridge from `session.idle`/`session.error` to `fl-report`
(`setup/02-install-scripts.sh:55-95`); opencode loads every file in that directory.
The per-run home (§7.7) must carry it, or a sandboxed opencode run never reports an
API error.

**Consequence.** Nothing to switch off; `OPENCODE_CONFIG_CONTENT` can carry a
per-run `permission` block as defence in depth (e.g. `bash: { "docker *": "deny" }`).
The freilauf.js plugin and `auth.json` go into the seeded home; the API key can be
proxy-injected because opencode addresses providers over HTTPS with a bearer
header.

### 3.3 Hermes Agent: seven terminal backends and an egress proxy — but for its tools, not itself

**Documented and measured** (`~/.hermes/hermes-agent/tools/environments/`,
https://hermes-agent.nousresearch.com/docs/user-guide/features/tools,
https://hermes-agent.nousresearch.com/docs/user-guide/egress/iron-proxy): hermes
stays on the host and sends **terminal tool calls** to `terminal.backend: local |
docker | ssh | singularity | modal | daytona | vercel_sandbox`. The docker backend is
the most complete prior art in our own agent set for hardening flags — its
`_BASE_SECURITY_ARGS` are

```
--cap-drop ALL --cap-add DAC_OVERRIDE --cap-add CHOWN --cap-add FOWNER
--security-opt no-new-privileges
--tmpfs /tmp:rw,nosuid,size=512m --tmpfs /var/tmp:rw,noexec,nosuid,size=256m
```

plus `--pids-limit 256` (gated on cgroup delegation), `--shm-size 1g` (Chromium and
PyTorch crash at Docker's 64 MB default), `--network=none` when `docker_network:
false`, labels for an **orphan reaper** that removes exited hermes-tagged
containers, and podman as a drop-in when docker is absent. `hermes egress` sets up
**iron-proxy** (§4.5): the container gets `HTTPS_PROXY=http://host.docker.internal:9090`,
a CA mounted read-only, `NODE_EXTRA_CA_CERTS`/`SSL_CERT_FILE`/`REQUESTS_CA_BUNDLE`,
and *proxy tokens* in place of real keys; non-allowlisted hosts get a 403 before any
byte leaves the host; `hermes egress reload` hot-reloads the rules.

**Consequence.** For the generic layer, hermes is a process like any other:
`hermes chat -q … --yolo` runs inside our container with `terminal.backend: local`
(the container *is* the boundary; hermes' docs say the same about its own docker
backend: "Dangerous command checks are skipped because the container itself is the
security boundary"). Its `~/.hermes` (config, `.env`, `state.db`, skills) is
seeded into the per-run home. What we **take** from hermes is the reference flag
set, the orphan reaper, and the iron-proxy integration pattern.

### 3.4 Cursor CLI: `cursorsandbox` (Landlock + seccomp, bwrap fallback)

**Documented** (https://cursor.com/docs/agent/security/run-modes,
https://cursor.com/docs/reference/sandbox, https://cursor.com/blog/agent-sandboxing,
https://cursor.com/docs/cli/reference/configuration): a per-command sandbox shared
with the IDE; Linux needs "Kernel 6.2 or later with Landlock v3" plus unprivileged
user namespaces; `~/.cursor/sandbox.json` and `<project>/.cursor/sandbox.json`
(network `default: "deny"`, `allow`/`deny` patterns, private ranges and cloud
metadata blocked by default; filesystem `workspace_readwrite | workspace_readonly |
insecure_none`, protected `.git/hooks`, `.git/config`, `.cursor/*.json`); `--sandbox
enabled|disabled` and `sandbox.mode` / `sandbox.networkAccess` in
`~/.cursor/cli-config.json`; "Cursor will indicate when a command runs outside the
sandbox and ask for your approval". Enterprise network list: `api2.cursor.sh`,
`api3.cursor.sh`, `api4.cursor.sh`, `api5.cursor.sh` + `agent.api5.cursor.sh`,
`repo42.cursor.sh`, `*.gcpp.cursor.sh`, `authentication.cursor.sh`,
`marketplace.cursorapi.com`, `downloads.cursor.com`, `cursor-cdn.com`
(https://cursor.com/docs/enterprise/network-configuration). Auth: `agent login` or
`CURSOR_API_KEY`; the token file location is undocumented — this repo measured
`~/.config/cursor/auth.json`.

**Measured here:** `cursorsandbox --help` shows `--policy <json>` ("filesystem policy,
optional network filtering policy, and the network-strict flag") and
`--preflight-only` ("exits 0 on success, 2 if unsupported"). Its preflight cannot be
run without a policy file, and on this host user namespaces are blocked, so the
bwrap fallback would fail; Landlock alone might still enforce (`CURSOR_SANDBOX_LANDLOCK_STATUS`
says which).

**Consequence.** Inside our container run `cursor-agent --sandbox disabled`: nested
Landlock is harmless but nested bwrap fails, and cursor's "ask to run outside the
sandbox" is a prompt that `--force` answers anyway. `~/.config/cursor/auth.json`
and `~/.cursor` (transcripts — the hub's activity source and `finishByTurnEnd()`
channel) live in the per-run home.

### 3.5 Why the agent-native sandboxes are not the generic layer

- They cover **commands**, not the process: the process still reads the host's
  credentials, its own settings and every file the user can read, and it runs the
  file-edit tools unsandboxed (claude, cursor).
- They are **four different policy vocabularies** with four different UIs, so
  "configure the boundary once at repo level" is impossible on top of them.
- Two of the four (claude's bwrap, cursor's bwrap fallback) **do not work on this
  host** as shipped, and would need a sudo step the hub cannot perform.
- opencode has none, hermes' is for tool calls only, and an **external plugin** may
  have anything or nothing. R4 says generic.

They remain valuable as **inner** layers where a repo wants defence in depth, and
their *designs* — 403-with-reason, live allowlist, protected paths, "ask the human
instead of widening" — are what §7 builds.

---

## 4. The landscape: sandbox technologies on Linux

Legend for the verdict column: **base** = the thing to build on, **option** = worth
a runtime flag later, **pattern** = copy its design, **no** = rejected for this hub.

| Technology | Isolation | Network policy | Filesystem policy | Root / kernel needs | License, state (2026-09) | Verdict |
|---|---|---|---|---|---|---|
| **Docker Engine (runc) with hardening flags** | namespaces, cgroups, seccomp, AppArmor, capabilities | `--network none`, `--internal` networks, proxy sidecar | bind mounts, `--read-only`, tmpfs | rootful daemon (docker group = root-equivalent) or **rootless** | Apache-2.0; ubiquitous | **base** (§7.1) |
| **Rootless Docker** | same + the daemon runs in the operator's user namespace: an escape lands in the operator's uid, not root | same; userspace networking (slirp4netns/pasta) | files owned by the operator appear as **root** inside — the ownership problem disappears if the agent runs as container uid 0 | Ubuntu 24.04 needs an AppArmor profile for `rootlesskit` (bundled with the `.deb`, manual with the install script); cgroup limits only with cgroup v2 + systemd delegation (`Delegate=cpu cpuset io memory pids`); **no AppArmor on containers**, no overlay networks | Docker docs | **recommended daemon posture** (§7.11) |
| **Podman (rootless)** | as above; `--userns=keep-id` maps the caller's uid to the same uid inside | pasta default since 5.0 | `:U`, `:idmap` volume flags | daemonless; `podman.socket` + `loginctl enable-linger` for a systemd-driven hub; Ubuntu 24.04 ships **4.9.3** | Apache-2.0 | **option** behind `sandbox_runtime` (hermes treats it as a drop-in) |
| **gVisor `runsc`** | user-space kernel; syscalls never reach the host kernel | netstack (own stack) or `--network host` | gofer / directfs | `apt install runsc`, `--runtime=runsc`; no KVM needed (systrap) | Apache-2.0, monthly releases | **option** (`profile.runtime: runsc`): a real kernel boundary at the cost of slower `npm ci`/git, **inotify blind to host-side edits on bind mounts** (issue #8089), `--file-access=shared` for worktrees the hub also touches, embedded-DNS friction with sidecars, Chromium untested |
| **Kata Containers / Firecracker** | microVM per container | own | virtiofs (**no inotify**) | `/dev/kvm`; no `--net=host`; no AppArmor; Docker integration via a deprecated shim path | Apache-2.0 | **no** for per-run sandboxes on a small hub; the upgrade path for regulated environments |
| **Sysbox** | system container (always-on userns, virtualised procfs, Docker-in-Docker without `--privileged`) | Docker's | Docker's | rootful only; forbids nested user namespaces; v0.7.1 supports Ubuntu 24.04 | Apache-2.0, best-effort since Docker's acquisition | **option** only for repos that need Docker *inside* the agent (compose-based tests) |
| **Docker Sandboxes (`sbx`, formerly `docker sandbox`)** | microVM per sandbox with its own dockerd; KVM on Linux (Ubuntu 24.04+, `kvm` group); host-side deny-by-default proxy; credentials injected by the host proxy, `~/.config/*` never visible inside; agents `claude, codex, copilot, cursor, gemini, kiro, opencode, droid, shell`; workspace at the same absolute path; three git strategies (direct, `--clone`, host worktree with **no git inside**); presets Open / Balanced / Locked Down; `sbx policy allow network <host>` "takes effect immediately"; org governance is a paid tier | | | | CLI free incl. commercial use, **not open source** | **pattern**, not base: no custom agent, no Linux-without-KVM, not OSS; but its policy model (host-side proxy, live allow, credential injection, same-path mounts) is exactly what §7 builds with Docker Engine |
| **bubblewrap** (`bwrap`) | user/pid/net/mount namespaces, seccomp | binary: `--unshare-net` or shared; filtering needs a proxy outside (srt, Codex, Greywall, ai-jail all add one) | any bind layout, `--ro-bind` | unprivileged user namespaces — **blocked by default on Ubuntu 24.04** without an AppArmor profile; 0.12.0 (2026-08-26) removed the setuid mode | LGPL-2.1+ | **option** as the Docker-free "light" runtime via `srt` (§4.6) |
| **Anthropic `sandbox-runtime` (`srt`)** | bwrap + seccomp + unix-socket proxies | allow/deny domains, 403 with reason, live `updateConfig` (library) | allow/deny paths, mandatory deny list | as bwrap; "cannot run as root" | Apache-2.0, beta, v0.0.75 | **option** (light runtime); **pattern** for §7.5/§7.12 |
| **Landlock** (`landrun`) | kernel LSM, self-restriction | **ports only**, no hosts | path rights | none (ABI 4+ = kernel 5.16+; here 6.8) | GPL kernel, landrun MIT | second layer at most; cannot express "allow api.anthropic.com" |
| **nsjail / firejail** | namespaces + seccomp (+ cgroups) | on/off | config-driven | nsjail unprivileged with userns; firejail is **setuid root** by design (CVE history) | Apache-2.0 / GPL | **no** (firejail: wrong trust model for an agent host; nsjail: config-heavy, same userns caveat) |
| **iron-proxy** (`ironsh/iron-proxy`, by Paradigm) | not a sandbox: an **egress firewall** — MITM HTTPS proxy + DNS server; default-deny allowlist (domain globs, CIDRs), upstream deny CIDRs (loopback, RFC 1918, cloud metadata) against SSRF/rebinding, **secrets transform** (workload sends a proxy token, the proxy swaps in the real credential, sources: env, file, AWS SM/SSM, 1Password), WebSocket/SSE, PostgreSQL MITM, per-request JSON audit with the transform trace, management API `POST /v1/reload` (atomic, keeps the old pipeline if the new config is invalid), `warn: true` audit-only mode | | | single Go binary, Docker image, ≈600 stars, first release April 2026; hermes' `hermes egress` wraps it | Apache-2.0 | **base for the network engine** (§7.5), with a hub-native CONNECT proxy as the fallback |
| **Coder Boundary** | egress-only jail (nsjail or Landlock "landjail") + transparent proxy | domain/method/path allow rules, default deny | none | nsjail path needs sudo; landjail bypassable by proxy-ignorant tools | MIT, v0.10.0 | **pattern** (rule syntax `--allow "method=GET,HEAD domain=api.example.com"`) |
| **Greywall, ai-jail, nono** | bwrap/Landlock/seccomp wrappers written for exactly "wrap `claude`/`opencode` in a TUI" | proxy with dashboard (Greywall), all-or-nothing (ai-jail), credential proxies (nono) | per-command maps | userns | Apache-2.0 / GPL-3.0 / Apache-2.0; small projects | **pattern** (Greywall's `--learning` profile generation → §7.12 audit-only mode) |
| **microsandbox, BoxLite** | libkrun / KVM microVMs, OCI images, host/port allowlists, secrets scoped to hosts | | | `/dev/kvm` | Apache-2.0, beta | **no** for now (KVM, image must contain the agent; loses the worktree model) — the same shape as Docker Sandboxes, open source |
| **Kubernetes `agent-sandbox` (SIG), E2B infra, Daytona, Modal, Vercel Sandbox, OpenHands runtime** | cluster/cloud shapes | | | | various; Daytona's open repo is **no longer maintained** (moved private June 2026) | **no** (not a single-host tmux hub); Modal's `updateNetworkPolicy()` semantics — immediate, kills newly-forbidden connections — are the reference for live policy |

### 4.1 Why Docker Engine (and not Docker Sandboxes, gVisor or bwrap) is the base

- **It is the only one of the four that is both allowed by the brief, open source,
  present on any Linux server a company already runs, and free of the Ubuntu
  user-namespace problem** (a rootful daemon does not need unprivileged userns;
  rootless Docker ships its AppArmor profile).
- It wraps **a command line**, which is the contract every harness already has with
  `fl-start` (§2.1), and it keeps tmux on the host (§7.1).
- Its hardening flags answer E3, E5, E8 directly; its networks answer E1 with a
  proxy; `docker update` answers "raise the limit without restarting" (§7.12).
- gVisor plugs into the same command (`--runtime=runsc`) — a later flag, not a
  different design. bwrap/`srt` plugs into the same seam (`fl-start` wraps the
  command) — a later runtime, not a different design.
- Docker Sandboxes solves the same problem end to end, but for its own list of
  agents, on KVM, with a proprietary CLI and a paid governance tier; the value for
  us is that Docker's own product validates every design choice in §7 (same-path
  mounts, host-side proxy, live allowlist, credential injection, "no git inside a
  worktree" — which is exactly the problem §7.4 solves differently).

### 4.2 Docker on Ubuntu 24.04: what the operator has to do once

Documented in Docker's rootless troubleshooting page
(https://raw.githubusercontent.com/docker/docs/main/content/manuals/engine/security/rootless/troubleshoot.md):

> Ubuntu 24.04 and later enables restricted unprivileged user namespaces by
> default, which prevents unprivileged processes in creating user namespaces unless
> an AppArmor profile is configured to allow programs to use unprivileged user
> namespaces. If you install `docker-ce-rootless-extras` using the deb package …
> the AppArmor profile for `rootlesskit` is already bundled … If you install the
> rootless extras using the installation script, however, you must add an AppArmor
> profile for `rootlesskit` manually.

Known limitations of rootless mode (same source): storage drivers `overlay2`
(kernel ≥ 5.11), `fuse-overlayfs`, `btrfs`, `vfs`; "cgroup is supported only when
running with cgroup v2 and systemd"; **AppArmor, checkpoint, overlay network, SCTP
not supported**; ports < 1024 and `ping` need sysctls; `--cap-add` only governs the
container's own user namespace. Resource flags "are supported only when running
with cgroup v2 and systemd … typically, only `memory` and `pids` controllers are
delegated to non-root users by default" — `cpu` needs
`/etc/systemd/system/user@.service.d/delegate.conf` with `Delegate=cpu cpuset io
memory pids` (https://raw.githubusercontent.com/docker/docs/main/content/manuals/engine/security/rootless/tips.md).

UID mapping (https://raw.githubusercontent.com/docker/docs/main/content/manuals/engine/security/rootless/uid-gid-mapping.md):
"In rootless mode, container UID 0 is mapped to the host UID of the user running
rootless Docker … files owned by your host user appear as owned by `root` inside
the container." Container uid *n* ≥ 1 maps to `subuid + (n − 1)`, so a non-root
container user writes files that appear on the host as a 100000-range uid — which
the hub's `git status` and worktree cleanup would then see as foreign. §7.7 draws
the consequence: **rootful daemon → run the agent as the hub's uid; rootless daemon
→ run the agent as container root, which is the hub's uid.**

### 4.3 The nested-sandbox conflict, stated once

Chromium's own sandbox, bubblewrap (Claude Code's sandbox, `srt`, Codex, cursor's
fallback) all want to `clone(CLONE_NEWUSER)` and `mount` **inside** the container.
Docker's default seccomp profile masks the namespace flags out of `clone` and gates
`unshare`/`setns`/`mount` on `CAP_SYS_ADMIN`
(https://github.com/moby/profiles/blob/main/seccomp/default.json); the
`docker-default` AppArmor template has `deny mount,` and no `userns` rule
(https://github.com/moby/profiles/blob/main/apparmor/template.go); Ubuntu 24.04
restricts userns on top. So: **choose one boundary.** Either the container is the
sandbox — Playwright's Chromium runs with its default `chromiumSandbox: false`,
Claude Code's sandbox is off or `enableWeakerNestedSandbox`, cursor's is
`--sandbox disabled` — or the container is opened (custom seccomp allowing
`clone/unshare/setns/mount`, `apparmor=unconfined` or a profile with `userns,` and
`mount,`) and the outer wall loses exactly the syscalls that break out of
containers. §7.2 exposes this as `profile.innerSandbox: off | weak | full`, default
`off`, with `full` only sensible together with `runtime: runsc`.

### 4.4 Playwright, node-pty, inotify, `npm ci` — will the toolchain work?

- **`npm ci` with native modules (node-pty, better-sqlite3)** needs `python3`,
  `make`, `g++` in the image and **no capability at all when run as a non-root user**;
  as root, npm drops to the directory owner's uid for lifecycle scripts, which needs
  `CAP_SETUID/SETGID` — one more reason for a non-root container user
  (https://docs.npmjs.com/cli/v9/using-npm/scripts).
- **inotify across a bind mount works on the same kernel** (inode-based; Docker
  Engine, Podman) and does **not** work across a VM boundary (Docker Desktop, Docker
  Sandboxes' virtiofs, Kata) or under gVisor for host-side edits. Dev servers and
  watchers inside the container see the agent's own edits everywhere; they see the
  *hub's* edits only under runc/Podman. `fs.inotify.max_user_watches` is a host
  sysctl, not namespaced.
- **Chromium/Playwright**: `--shm-size 1g` (hermes' finding; Docker's 64 MB default
  crashes renderers) and `--init`; Playwright's own seccomp profile only adds
  `clone/setns/unshare` for Chromium's userns sandbox — unnecessary with the
  default `chromiumSandbox: false`.
- **git** needs nothing; the ownership check (`safe.directory`, three checks:
  worktree, git dir, gitfile) never fires when the container's uid equals the
  file owner's (§7.7).

### 4.5 iron-proxy in one page

Repository https://github.com/ironsh/iron-proxy (also `paradigmxyz/iron-proxy`),
Apache-2.0. Two coordinated services: a DNS server that resolves every name to the
proxy's address, and an HTTP/HTTPS proxy that terminates TLS with leaf
certificates minted from a local CA, runs a transform pipeline, and forwards
upstream. Three enforcement levels are documented — DNS only ("easy to bypass: the
workload can hardcode IPs"), DNS + nftables (only the proxy is reachable), and
TPROXY. For our use the Docker network itself is the enforcement (§7.5): the agent
container's only route is the proxy, and the proxy is addressed as an explicit
`HTTPS_PROXY`, so DNS interception is not needed.

Configuration is one YAML; the parts we would generate per run:

```yaml
proxy:
  tunnel_listen: ":8080"            # HTTP CONNECT entry the container's HTTPS_PROXY points at
transforms:
  - name: allowlist
    config:
      domains: ["api.anthropic.com", "*.npmjs.org"]   # default deny; 403 otherwise
      # warn: true                                     # audit-only: allow, but log "would block"
  - name: secrets
    config:
      secrets:
        - source: { type: env, var: OPENROUTER_API_KEY }
          proxy_value: "fl-token-<random>"             # what the container sees
          match_headers: ["Authorization"]
          require: true
          rules: [{ host: "openrouter.ai" }]
log: { level: info }                                    # one JSON line per request, with the transform trace
management:
  listen: "127.0.0.1:<port>"                            # POST /v1/reload — atomic hot reload
  api_key_env: IRON_MANAGEMENT_API_KEY
```

Upstream deny CIDRs default to loopback, link-local, RFC 1918, IPv6 ULA and the
cloud metadata addresses — the SSRF fence a company would otherwise have to write.
Every request logs `host, method, path, action, status_code, duration_ms,
request_transforms[…]` including which secret was swapped in which header; rejected
requests carry `rejected_by`. Known limits (from hermes' integration notes):
signature-based auth (AWS SigV4, GCP OAuth) bypasses header substitution; a Node
process can bypass the CA bundle with raw sockets (mitigated by `NODE_OPTIONS=--use-openssl-ca`);
one bind per daemon. That last one is why §7.5 runs **one proxy container per
sandboxed run**.

### 4.6 The Docker-free "light" runtime, for later

`srt` (or plain bwrap with the hub's proxy) wraps the same command at the same seam:
`srt --settings <run>/srt-settings.json -- <agent cmd>`. Same paths as the host, so
none of §7.4/§7.7 applies — the hub reads everything where it reads it today. The
price: unprivileged user namespaces (an operator-installed AppArmor profile on
Ubuntu 24.04), a weaker boundary (shared kernel, the whole host filesystem readable
unless denied path by path, literal paths only), and Anthropic's own "beta research
preview" label. It is the right answer for a developer's laptop and the wrong one
for the brief's enterprise case; it earns a place as `profile.runtime: srt` in
phase 4 (§10), not before.

---

## 5. What companies require, and how the mature products answer

The full survey (with URLs) is condensed here into the parts that changed the
design. The pattern across vendors is uniform enough to be treated as the
specification.

### 5.1 Threat model, in the words the sources use

- **Prompt injection → exfiltration**: Simon Willison's "lethal trifecta" — private
  data, untrusted content, the ability to communicate externally
  (https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/). A coding agent has
  all three by default: the repo, the web/dependencies, and the API it must reach.
  martinfowler.com's agentic-security piece: "Any internet access can exfiltrate
  data" — even an image URL (https://martinfowler.com/articles/agentic-ai-security.html).
- **Ambient credentials**: Anthropic's CISO guide (2026-07-17): "The environment the
  agent loop runs in should never hold a credential worth stealing" and "All traffic
  leaving the agent's execution environment should pass through a proxy that
  environment cannot reconfigure or bypass" (https://claude.com/blog/ciso-guide-to-agentic-ai).
- **Supply chain via install scripts**: `npm install`/`pip install` lifecycle
  scripts run with the agent's rights; Docker's own warning about "implicit
  execution files (hooks, CI configs, Makefiles, package.json scripts) [that] can be
  modified by agents and later executed locally" (https://docs.docker.com/ai/sandboxes/security)
  — which is our `merge_check` problem (§8.7).
- **The agent's own API credential** is a target too, and the one thing the
  sandbox cannot withhold — hence injection at the proxy rather than a key in the
  environment.
- **Domain fronting and "allowed" exfil hosts**: hostname allowlisting decides on
  the client-supplied name and does not inspect content; Claude Code, Vercel and
  E2B all document it ("Blocked connections may appear successful from inside the
  sandbox" — E2B). `github.com` on an allowlist is a paste-bin. The honest answer
  is a seam for the company's own inspecting proxy (E12).

### 5.2 The product answers, side by side

| Requirement | Claude Code (local / web) | Codex CLI / cloud | Cursor local / cloud | Copilot coding agent | Docker Sandboxes | Cloud sandboxes (E2B, Modal, Vercel, Daytona) |
|---|---|---|---|---|---|---|
| Egress default | no domains pre-allowed; prompt or `strictAllowlist`; web: *Trusted* preset | CLI network **off** in the sandbox; cloud: off in the agent phase, *Common dependencies* preset of ~70 domains, GET/HEAD/OPTIONS-only option | `network.default: "deny"`, private ranges and cloud metadata blocked; cloud: allow-all / default+allowlist / allowlist-only | firewall **on** with a recommended allowlist; org: *Enabled / Disabled / Let repositories decide*, plus per-repo custom rules | deny-by-default proxy; *Open / Balanced / Locked Down* | E2B **on by default** (`allowOut/denyOut`); Modal off-able (`block_network`, domain allowlist); Vercel `allow-all` default, SNI matching; Daytona tier-locked, `networkBlockAll` |
| Blocked → user | violation in the command result; new domain prompts; in `dontAsk` it is a denial | approval prompt "run outside the sandbox"; `/permissions` mid-session | "surface the sandbox constraint responsible … recommend that the agent escalate"; ask to run outside | **a warning in the PR body with the blocked address and the command** | `sbx policy check network <url>`; `sbx policy log` | Modal: logged to the sandbox's output stream |
| Live relaxation | `permissions` and the filesystem lists are hot-reloaded into the running session; `srt` library `updateConfig()` live for network | mode change mid-session documented; domain list live: not documented | not documented | next run | `sbx policy allow network <host>` — "changes take effect immediately" | Modal `updateNetworkPolicy()` immediate, terminates newly-forbidden connections; Vercel live |
| Credentials | `credentials.envVars/files` `deny`/`mask` + `injectHosts`; web: proxy authenticates for the session, `GH_TOKEN` reads `proxy-injected` | cloud: secrets only in the setup phase, removed before the agent phase | cloud: Runtime Secrets redacted from transcript and commits | only secrets in the `copilot` environment; no push rights beyond its branch | "API keys are injected into HTTP headers by the host-side proxy. Credential values never enter the VM" | E2B workload identity (SPIFFE JWT swapped by the proxy); Vercel `transform` brokering; Daytona egress substitution |
| Filesystem | cwd + `$TMPDIR`; protected paths; shared `.git` writable except `hooks/`, `config` | `read-only / workspace-write / danger-full-access`; `.git`, `.codex` protected | workspace rw/ro/none; protected `.git/hooks`, `.git/config`, `.ssh`; overlayfs hides `.cursorignore` files | repo only | workspace only; `--clone` gives a private clone with the host repo read-only at `/run/sandbox/source` | own filesystem |
| Policy layering | managed-settings.json (`/etc/claude-code/…`, MDM, server-polled): `disableBypassPermissionsMode`, `allowManagedPermissionRulesOnly`, `allowManagedDomainsOnly`, `allowManagedReadPathsOnly`; arrays merge, booleans managed-wins; project scope cannot set `filesystem.disabled`, `mask`, `tlsTerminate`, `bypassPermissions` | `requirements.toml` (`allowed_sandbox_modes`, `allowed_approval_policies`, `allowed_permission_profiles`, `[experimental_network] managed_allowed_domains_only`, `permissions.filesystem.deny_read` "cannot be weakened"): "the local client falls back to a compatible value and notifies the user"; `managed_config.toml` = soft defaults; `.codex/config.toml` only in **trusted** projects and never for provider/auth/hooks keys | "User config < Workspace config < Team admin < Hardcoded rules"; deny lists union; "Restrictive settings win" | org sets each control to Enabled / Disabled / Let repositories decide | governance tier: "only organization allow rules grant access … local deny rules still apply on top" | Daytona: tier 1–2 restrictions "cannot be overridden at the sandbox level" |
| Audit | OTEL events (`tool_result`, `tool_decision`, `api_request`…), **content redacted by default**, `OTEL_LOG_TOOL_DETAILS=1` opt-in; `ConfigChange` hook | — | SIEM export (Enterprise), HSM-signed commits | session logs linked from signed commits | `sbx policy log`; governance audit logs | Modal blocked-connection log |
| Resources | none locally; web VM limits | none locally | none locally | Actions limits | not documented | E2B 1 h/24 h caps; Daytona 1 vCPU/1 GiB/3 GiB defaults; Vercel timeouts |
| Non-root / kernel | `bypassPermissions` refuses root; bwrap; devcontainer runs as `node` | bwrap | Landlock + seccomp; cloud: Firecracker | ephemeral Actions VM | microVM, "The agent has full control inside the VM, including sudo access" | Firecracker (E2B, Vercel), gVisor (Modal, Anthropic Managed Agents) |

### 5.3 What the table says for Freilauf

1. **Nobody sandboxes by trusting the agent's own judgement.** Docker: "An LLM
   deciding its own security boundaries is not a security model." The policy is
   set *before* the run; the agent gets a way to *ask*, not a way to *change*.
2. **The "default per repo, override per run" layering has three precedents that
   agree on the rule**: a higher layer can lock; a lower layer can always add a
   deny and never remove an allow (Claude's `allowManaged*Only`, Cursor's "deny
   lists union", Docker's "local deny rules still apply on top"). Codex adds the
   UX detail that matters for us: when a lower layer conflicts with a lock, the
   client "falls back to a compatible value and notifies the user" — a run whose
   override is refused must say so, not silently run with the repo default.
3. **Every product that runs unattended surfaces a block to a human in the place
   the human already looks** — Copilot writes it into the PR, Docker into the
   policy log, Claude into the tool result. For Freilauf that place is the run's
   event list, the incident sidebar and the notification channel (§7.12).
4. **Live relaxation exists exactly where the policy lives in a proxy outside the
   boundary** (Docker Sandboxes, Modal, Vercel, `srt` as a library) and nowhere for
   filesystem policy, which is baked into the namespace at start. §7.12 follows
   that split.
5. **Audit is redacted by default everywhere, and nobody is tamper-evident.** A
   hash-chained JSONL export is cheap and would be a differentiator (§7.14).
6. **Resource limits are a cloud-sandbox feature; local sandboxes don't meter.**
   Docker gives them to us for free (§7.2).

---

## 6. Freilauf's own threat model

What the sandbox is *for*, in this hub, stated as assets and the paths to them.
Everything in §7 is justified by a row here.

| Asset | How an unsandboxed run reaches it today | What the sandbox must do |
|---|---|---|
| **The host** (every file the hub user can read, every process, other repos, `~/.ssh`, cloud credentials, the hub's own SQLite with tokens in plaintext — `store.mjs:205-208`) | the agent *is* a process of the hub user | a container with only the run's directories mounted (§7.4, §7.7); non-root inside; no Docker socket |
| **The operator's checkout** (`repo.path`, its `.git`: hooks, config, refs, reflog, remotes) | the linked worktree's `.git` file points into it; `git branch -f`, `update-ref`, a planted `post-checkout` hook, `core.fsmonitor` in config | never mount it writable; a clone with read-only alternates (§7.4) |
| **The base branch on origin** | the hub pushes `repos.base` (`pushOperatorBase()`) and merges tips it trusts; a moved local `main` or a hostile tip would ride that | the integrator only ever fetches a tip out of the clone, then the existing gate applies (§7.4.3) |
| **The hub itself** (`http://127.0.0.1:<port>`: kill any run, send text into any session, `POST /api/runs/<id>/edit`, settings incl. `telegram_token` and credentials) | `FL_HUB_URL` is handed to the agent; `FL_RUN_ID` is the only "auth" the report route has | a unix socket exposing **only** the report API, with a per-run token (§7.6) — worth doing for unsandboxed runs too |
| **Provider and subscription credentials** (`OPENROUTER_API_KEY` in the tmux env; `~/.claude/.credentials.json`; cursor's `auth.json`) | in the environment / home of the agent | proxy injection so the container holds a placeholder (§7.8); at minimum, per-run copies with the hub's credential resolution, never the operator's whole home |
| **The network** (everything reachable from the host: internal services on the VPN, cloud metadata, the hub's own proxy) | unrestricted | `--internal` network, egress only through the proxy, upstream deny CIDRs (§7.5) |
| **Other runs** (their worktrees, their tmux sessions, their containers) | same user, same tmux server | a per-run container sees only its own mounts; tmux is not inside |
| **Machine resources** (memory — the sessions page exists because thirty sessions once held 15 GB; CPU; disk; forks) | none | cgroup limits per run, `docker update` to raise them live (§7.2, §7.12) |
| **The record** (events, reports, incidents: "everything a run does is a report, an event or an incident you can read afterwards", README) | the agent can write into `~/agents/runs/<id>/` today | the run dir stays writable (reports, inbox); the hub's events are written by the hub; the proxy log is the hub's (§7.14) |

What the sandbox is **not** for: it does not judge the *content* of the agent's
work (that is the finish gate, the merge check and the human), it does not
inspect outbound payloads (E12), and it does not replace the VPN-only exposure of
the hub (README, "Security model").

---

## 7. The design

### 7.1 Placement: a container around the agent, tmux on the host

Three placements were on the table.

**(a) tmux on the host, the pane command is `docker run -it …`.** Chosen. The pane's
process is the Docker CLI, which allocates a TTY in the container, relays the
container's raw TTY bytes unchanged in both directions (the attach API's
`application/vnd.docker.raw-stream`), converts the pane's `SIGWINCH` into the
resize API (initial size set at creation on Engine ≥ 23.0 / API 1.42
`ConsoleSize`), and exits with the container's exit code
(`cli/command/container/run.go`, `waitExitOrRemoved`). Consequences, all measured
against the CLI source and Docker's docs by the transport research:

- `pipe-pane -o … cat >> log.txt` sees the container's output → the log scanner
  (`detect.mjs`, `logPatterns`) needs no change.
- `send-keys -l` with bracketed paste, `capture-pane`, the goal delivery and
  `sendToSession()` work as today: tmux learns bracketed-paste mode from the pane's
  output stream, and the stream is the container's.
- `pane-died` fires with the container's exit status; `remain-on-exit` keeps the
  last screen; the browser terminal attaches to the host tmux as before.
- **One byte is intercepted on the input side**: the Docker CLI's detach sequence
  (`Ctrl-P Ctrl-Q` by default) — a bare `Ctrl-P` is held back until the next key,
  and the sequence detaches the pane while the container keeps running. Always
  pass `--detach-keys 'ctrl-^,ctrl-^'` (or another combination no TUI uses).
- **The container can outlive its client.** Killing the pane sends SIGHUP to the
  Docker CLI; with `--sig-proxy` (default, and since docker/cli PR #1841 also in
  TTY mode) the CLI forwards it to the container's PID 1 — but a PID 1 without a
  handler for that signal never receives it (pid_namespaces(7)), and Node installs
  handlers for SIGTERM/SIGINT but **not SIGHUP**. So: `--init` (tini as PID 1
  forwards and reaps), a fixed `--name fl-<run id>`, and the hub **always stops a
  run by `docker stop <name>`**, never by killing the pane alone (§7.11).
- `docker exec` is the way to run *another* process inside (git for the finish
  gate, `pkill`, a health probe); it does not type into the agent's TUI, and there
  is no API to signal an exec'd process — which is why (b) below is wrong.

**(b) A long-lived container with `docker exec -it` as the pane command.** Rejected:
nothing on the host can signal an exec'd process (moby #9098, #35703 — open since
2014/2017), so `pane-died` would mean "client gone", every kill would have to be a
`docker stop` anyway, and the agent's end would have to be detected from inside.
It only pays off together with (c).

**(c) tmux inside the container.** Rejected: every hub-side tmux call
(`terminal.mjs`, `sessions.mjs`, `goal.mjs`, `watcher.mjs`, `fl-attach`, `fl-kill`)
would need a `docker exec` indirection, two tmux servers would have to be
reconciled, the `pipe-pane` log and the `pane-died` hook would run inside and reach
the hub only through mounts, and every image would need `tmux`. The one advantage
— the agent's screen survives a host tmux death — is not worth doubling the
control surface, and it has shrunk since `resumeRun()` exists: a host tmux death
now ends in the agent being resumed in a new session (its conversation is in the
per-run home, §7.7), not in an aborted run.

**(d) A process sandbox (bwrap/`srt`) instead of a container.** Not rejected,
deferred (§4.6): same seam, weaker boundary, blocked on this host today.

### 7.2 The sandbox profile: what is configurable

A profile is one JSON document. It is stored as a named entity
(`sandbox_profiles`), referenced by a repo as its default, and overlaid by
agent/run overrides (§7.3). Every field has a default so that `{}` is a valid,
sensible profile. Names are chosen to read the same in the UI, the JSON, the flow
designer and the events.

```jsonc
{
  "runtime": "docker",                 // docker | podman (same CLI) | runsc (docker --runtime=runsc) | srt (phase 4)
  "image": {
    "ref": "freilauf/agent-claude:2.1.258",   // built by the hub from sandbox/images/, or an operator image
    "digest": null,                    // resolved at first use, then pinned and recorded in the run's events
    "pull": "if-missing"               // if-missing | always | never
  },
  "user": "hub",                       // hub = the hub's own uid:gid (rootful daemon) or root (rootless daemon) — see §7.7
  "network": {
    "mode": "allowlist",               // open | none | allowlist
    "engine": "iron-proxy",            // iron-proxy | builtin (CONNECT proxy, no TLS, no injection)
    "allow": ["api.anthropic.com", "*.npmjs.org", "github.com", "objects.githubusercontent.com"],
    "deny": [],                        // wins over allow
    "presets": ["harness", "provider", "git-host", "package-registries"],   // expanded by the hub, see §7.5.3
    "auditOnly": false,                // true = allow everything, log what would have been blocked (rollout mode)
    "methods": null,                   // e.g. ["GET","HEAD","OPTIONS"] — Codex/Devin "limited" mode, iron-proxy path/method rules
    "denyUpstreamCidrs": "default",    // loopback, link-local, RFC 1918, ULA, cloud metadata — iron-proxy defaults
    "tlsTerminate": true               // needed for header injection and method rules; CA is per hub, mounted read-only
  },
  "filesystem": {
    "worktree": "rw",                  // always rw; here for completeness
    "repoGit": "ro",                   // the operator checkout's .git, read-only, for alternates + fetch (§7.4)
    "extras": "ro",                    // link-mode worktree extras: ro | rw | copy
    "readOnlyRoot": true,              // --read-only + tmpfs /tmp, /var/tmp, /run, $HOME/.cache
    "tmpfsSizes": { "/tmp": "2g", "$HOME/.cache": "2g" },   // $HOME = the run's home (§7.7)
    "extraMounts": [                   // operator-declared, validated against sandbox_allowed_mount_roots (hub setting)
      { "source": "~/datasets/fixtures", "target": "/data/fixtures", "mode": "ro" }
    ],
    "protected": ["`.git/hooks`", "`.git/config`"]   // always read-only inside the clone, like Claude Code / Cursor
  },
  "resources": {
    "memory": "8g", "memorySwap": "8g", "cpus": 4, "pidsLimit": 4096,
    "shmSize": "1g", "diskTmpfs": "2g",
    "maxRuntimeMinutes": null          // hard kill; null = the run's expected_minutes ladder only
  },
  "secrets": {
    "mode": "inject",                  // inject (proxy substitutes placeholders) | env (as today) | none
    "gitFetch": "mirror"               // mirror (fetch from the mounted read-only .git; no credential at all) | none
  },
  "innerSandbox": "off",               // off | weak | full — the harness's own sandbox inside the container (§4.3)
  "harness": {                         // per-harness knobs the plugin declares; the profile may override
    "claude": { "permissionMode": "bypassPermissions" },
    "cursor": { "sandbox": "disabled" }
  },
  "retention": "run",                  // run = remove the container when the run's session is closed; keep = like session_keep_hours
  "audit": { "proxyLog": true, "dockerEvents": true, "export": "jsonl" }
}
```

What is **not** in the profile because it is not a sandbox concern: the prompt,
the branch rule, the duration, the model — they stay in the run definition.

### 7.3 Layering: hub → repo → agent/run, and who may loosen what

Four layers, resolved once at launch into `runs.sandbox_spec` (frozen, like every
other definition field — repo config is read live *until* launch, the same rule as
`repos.prompt`):

| Layer | Stored where | May set | May not |
|---|---|---|---|
| **Hub policy** (operator / security role) | `settings`: `sandbox_mode` = `off` (feature hidden) \| `available` \| `default_on` \| `required`; `sandbox_lock` = JSON list of profile paths that lower layers may only *narrow* (e.g. `network.deny`, `network.allow`, `secrets.mode`, `filesystem.extraMounts`, `resources.memory`); `sandbox_allowed_mount_roots`; `sandbox_runtime`; `sandbox_allow_bypass` (may a run opt out at all) | everything | — |
| **Repo** | `repos.sandbox_default` (`inherit` = hub's `sandbox_mode` decides \| `on` \| `off`), `repos.sandbox_profile_id`, `repos.sandbox_overrides` JSON | the default and the profile for its runs; overrides that narrow locked fields or set unlocked ones | loosen a locked field; opt out when the hub says `required` |
| **Agent** | `agents.sandbox` (`inherit` \| `on` \| `off`), `agents.sandbox_profile_id` (nullable = repo's), `agents.sandbox_overrides` | the same, one level down | the same |
| **Single run** | `runs.sandbox` (resolved 0/1), `runs.sandbox_profile_id`, `runs.sandbox_overrides`; editable while `scheduled`/`deferred` (`runEditAllowed()`) | the same | the same |

**Narrowing rule** (the Claude/Cursor/Docker rule): for a locked path, a lower layer
may append to `deny` lists and to `denyRead`-style lists, remove entries from
`allow` lists, lower numeric limits, and switch `auditOnly` from true to false —
never the reverse. `resolveSandboxSpec(hub, repo, agentOrRun)` applies the layers in
order and returns `{ spec, refused: [{ path, by, wanted, kept }] }`; a non-empty
`refused` becomes a `sandbox:override_refused` event on the run and a warning in
the form (Codex's "falls back to a compatible value and notifies the user").

**Opting out is a break-glass event.** When the hub says `default_on` and a run
says `off`, the run starts unsandboxed and carries `sandbox:bypassed {by: 'run'|
'agent'|'repo', user?}`; the overview row shows it; the notification names it.
When the hub says `required`, `off` is refused at the form (`problems`), exactly
like a branch rule the worktree cannot satisfy. `sandbox_allow_bypass = 0` makes
`required` the only mode in which the field is even offered.

**UI placement.** Repo form: a "Sandbox" block next to "Integration" — default
on/off/inherit, profile select, folded overrides, a "Dry run" button (§7.12.5) and
the audit-only switch. Agent form and single-run form: the run-definition block
gets a `sandbox` tri-state select plus a folded override editor, rendered by
`runDefFields()` and shown only for harnesses whose plugin declares `sandbox`
(`data-sandbox-harnesses`, the `goalFields` mechanism). Quick Run: takes the repo
default, no field (a favorite may carry the tri-state — it is setup, not task).
Settings → Sandbox: the hub layer, the profile editor, discovery results, image
builds.

### 7.4 The working copy: why a sandboxed run gets a clone, and how the integrator collects it

#### 7.4.1 The problem, measured

A linked worktree is wired in both directions [measured, git 2.43]:

```
<worktree>/.git                                   → "gitdir: <repo.path>/.git/worktrees/<name>"   (absolute)
<repo.path>/.git/worktrees/<name>/commondir       → "../.."                                         (relative, hard-coded)
<repo.path>/.git/worktrees/<name>/gitdir          → "<worktree>/.git"                               (absolute)
```

Per-worktree state (`HEAD`, `index`, `logs/HEAD`, `ORIG_HEAD`) lives **inside the
operator's `.git`**, under `worktrees/<name>/`; everything shared (`objects/`,
`refs/`, `packed-refs`, `config`, `hooks/`) lives one level up. So even `git add`
needs write access under `<repo.path>/.git`, and a read-only mount fails at the
first `index.lock` (Codex issue #27418 is exactly that error). Mounting only the
worktree directory gives `fatal: not a git repository` (reproduced); Docker
Sandboxes documents the same and simply forbids git inside a host worktree.

Mounting `<repo.path>/.git` **read-write at the same path** makes the worktree work
with zero configuration (the gitworktree.org "dual mount", devcontainers CLI 0.81's
`--mount-git-worktree-common-dir`). It also hands the agent:

- `.git/hooks/` — a `post-checkout` or `pre-commit` hook runs **on the host** the
  next time the operator or the hub runs git there;
- `.git/config` — `core.fsmonitor`, `core.sshCommand`, `diff.external` are commands
  git executes; a `git status` by the hub on the host would run them;
- `refs/heads/*` and `packed-refs` — `git update-ref refs/heads/main <x>` moves the
  operator's `main`; the hub's `pushOperatorBase()` then pushes it as a fast-forward;
- `objects/` — `git gc --prune=now` after deleting refs removes objects other
  worktrees rely on.

Masking `hooks/` and `config` with read-only overlays (what Claude Code's sandbox
does) closes two of the four. It does not close the refs, and it leaves the hub
running git on the host against a directory the agent writes into. For a sandbox
whose premise is "the agent is not trusted", that is the wrong shape.

#### 7.4.2 The layout: a per-run clone with read-only alternates

For a sandboxed run, `makeWorktree()` gets a sibling, `makeSandboxClone(repo, run)`:

```
~/agents/worktrees/<repo>/<short id>-<branch>/        # same place, same naming — the rest of the hub does not care
  .git/                                               # a full, private repository (HEAD, index, refs, hooks, config: all the agent's)
  .git/objects/info/alternates → <repo.path>/.git/objects   # borrow the operator's objects, read-only
```

Creation, on the host, before the container starts:

```bash
git init -q <target>
git -C <target> remote add origin <repo.path>
git -C <target> config remote.origin.fetch '+refs/remotes/origin/*:refs/remotes/origin/*'   # origin/<base> means what it means everywhere else
git -C <target> config --add remote.origin.fetch '+refs/heads/*:refs/remotes/local/*'       # the operator's local branches, for "existing branch" mode
printf '%s\n' "<repo.path>/.git/objects" > <target>/.git/objects/info/alternates
git -C <target> fetch -q origin                                                             # cheap: everything is already in the alternate
git -C <target> checkout -q --detach origin/<base>          # branch modes as in makeWorktree(): -b <name> from origin/<name> or origin/<base>
```

Inside the container, `<repo.path>/.git` is bind-mounted **read-only** at the same
path (nothing else of the operator's checkout), so `git fetch origin` in the clone
works exactly as the platform rule tells the agent ("`git fetch origin && git merge
origin/main`"), and alternates resolve. Read-only means: no hook, no config, no
ref of the operator's is writable; the operator's `.git/config` itself is masked
with an empty file (`-v <hub>/empty:<repo.path>/.git/config:ro`) because a remote
URL may carry a token. Alternates need `objects/` only, but `fetch` needs
`refs/`, `packed-refs` and `HEAD` too; mounting the whole `.git` read-only is the
simplest true statement.

Trade-offs, honestly:

- **"A branch belongs to exactly one worktree" is no longer enforced by git** for
  clones. The hub keeps enforcing it by policy (`branchWorktree()` stays; a clone
  registers the branch it works on in `runs.branch_expected` as today).
- **Disk**: a clone's `.git` is a few files; objects are borrowed. New objects the
  agent creates live in the clone until the integrator fetches them (below).
- **`git worktree prune` and `cleanupWorktrees()`** must not touch clones the
  wrong way: `git -C repo.path worktree remove` is replaced by `rm -rf` of the
  clone for `runs.worktree_kind = 'clone'`; the dirt check runs inside the sandbox
  (§7.4.4).
- **Alternates warning** (git-clone docs): deleting refs in the source and then
  gc'ing can orphan objects the clone needs. The source is the operator's repo,
  which the hub fetches into and never gcs aggressively; the window is the run's
  lifetime; the integrator's fetch (below) copies the tip's objects into
  `repo.path` anyway.
- git 2.43 has no `worktree.useRelativePaths` (2.48+), which would let a linked
  worktree be mounted anywhere — but it would still need the operator's `.git`
  writable. Not a way out.

#### 7.4.3 Collecting the result: one fetch, then the integrator as it is

`integrate.mjs` reads a run's tip with `git -C <workdir> rev-parse HEAD` and needs
that object reachable from `repo.path` (`merge-tree` there, `merge` in the
integration worktree). For a clone the tip's new objects live in the clone, so one
new step precedes the finish gate:

```bash
git -C <repo.path> fetch -q <clone path> HEAD:refs/freilauf/runs/<run id>   # or refs/heads/<branch> when the run has one
```

`tipOf(run)` for a clone then returns `refs/freilauf/runs/<id>`'s sha; everything
after — dry run, merge, merge check, push, backup branch (`git -C repo.path push
origin <tip>:refs/heads/<ref>` already exists), conflict runs (a fresh clone of its
own from the same tip) — is unchanged. `collectRunTip(run)` becomes the one
function that hides the difference: a no-op for a linked worktree, the fetch for a
clone. The ref namespace `refs/freilauf/runs/*` is cleaned when the run's worktree
is (`cleanupWorktrees()`).

A local fetch runs `git-upload-pack` **in the clone**, i.e. against a repository the
agent controls. What that process honours from the clone's config is a short,
protected list (`uploadpack.packObjectsHook` is only read from protected
configuration); it runs no hooks; the alternates file can only point at object
directories. This is the one host-side git operation on agent-controlled data the
design keeps, and it should be run with `GIT_CONFIG_NOSYSTEM=1` and `-c
uploadpack.allowAnySHA1InWant=false` for good measure — or, belt and braces, from
inside the container (`docker exec … git bundle create` + `git fetch <bundle>` on
the host), which the implementer may prefer.

#### 7.4.4 The hub's other git calls on the working copy go through the sandbox

`dirtyFiles()`, `rev-parse HEAD`, `rev-list --count`, `diff --name-only`, and the
rescue path (`add -A` / `commit` / `checkout -- .` / `clean -fd`) all run
`git -C <workdir>` on the host today. On a clone whose `.git/config` the agent
writes, that is command execution on the host (`core.fsmonitor` and friends).
Therefore a seam:

```js
// server/sandbox/exec.mjs
export async function runGit(run, args, opts)   // unsandboxed run → sh('git', ['-C', run.workdir_effective, ...args])
                                                // sandboxed run   → sh('docker', ['exec', '-u', user, `fl-${run.id}`, 'git', '-C', workdir, ...args])
```

Every `git -C <workdir>` in `integrate.mjs`, `watcher.mjs` (`cleanupWorktrees`) and
`runner.mjs` (`base_sha`) goes through it. A `docker exec` needs the container to be
alive, which it is for as long as the run's session is (the agent's TUI keeps PID 1
running); for a container that is gone, `runGit` falls back to the host with the
hardened environment (`-c core.hooksPath=/dev/null -c core.fsmonitor=false
GIT_CONFIG_NOSYSTEM=1`) — the dirt of a dead run is a display fact, not a merge
decision.

### 7.5 Network: an internal network, one egress proxy per run, and a policy that can change while the run is going

#### 7.5.1 Modes

| `network.mode` | What the container gets | When |
|---|---|---|
| `open` | the default bridge, unrestricted egress | a repo that only wants filesystem/resource isolation; the "off" of the network half |
| `none` | `--network none` — loopback only | a local-model setup, or a run that must not talk at all; the agent's own API is unreachable, so this is only meaningful with an in-container model (out of scope) |
| `allowlist` | a per-run **internal** Docker network with exactly two members: the agent container and the proxy container; the agent has `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` pointing at the proxy and **no default route**; the proxy is on the internal network *and* on the bridge | the enterprise mode, and the default of every preset profile |

The internal network is `docker network create --internal fl-net-<run id>` — "no
default route, firewall rules block external traffic"; on Docker ≥ 28 add
`-o com.docker.network.bridge.gateway_mode_ipv4=isolated` so the bridge has no host
address either and the host is unreachable from the container
(https://docs.docker.com/engine/network/port-publishing/). Tools that ignore proxy
variables fail closed — which is the honest outcome, and the same one `srt`,
Codex and Docker Sandboxes accept. `NO_PROXY` is empty; the hub is reached over a
unix socket, not the network (§7.6).

DNS: on an internal network Docker's embedded resolver answers container names
and nothing external; agents resolve nothing themselves because they hand
hostnames to the proxy in `CONNECT`. Tools that insist on resolving first
(`dig`, `nslookup`, raw sockets) fail, as under `srt`.

#### 7.5.2 The engine: iron-proxy per run, with a built-in fallback

One `iron-proxy` container per sandboxed run (`fl-proxy-<run id>`, image pinned by
digest, `--read-only`, no mounts but its generated config and the hub's CA), because
iron-proxy has one ruleset per daemon and a per-run allowlist is the whole point.
The hub:

1. writes `~/agents/runs/<id>/proxy.yaml` from the resolved `network` section
   (§4.5 shows the shape) and, when `secrets.mode = inject`, the `secrets`
   transform with a per-run placeholder per credential (§7.8);
2. starts the proxy first, then the agent container with
   `HTTPS_PROXY=http://fl-proxy-<id>:8080` and the CA path in
   `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`,
   `GIT_SSL_CAINFO` (the hermes list, plus git);
3. tails the proxy's JSON log into the run's audit stream and turns rejections
   into `sandbox:blocked` events (§7.12);
4. on a policy change rewrites `proxy.yaml` and calls `POST /v1/reload` on the
   management listener (bound to the internal network, key from the run's
   secret) — atomic, no dropped connections, effective for the next connection.

A `builtin` engine — a ~200-line HTTP CONNECT proxy inside the hub process, one
listener per run on the bridge, policy in memory, events straight into
`addEvent()` — is the fallback for installations that do not want a second
binary. It cannot terminate TLS, so it offers `allow`/`deny`/`auditOnly` but not
`methods` or credential injection; the profile editor greys those out when
`engine: builtin`. It is also the natural first implementation for phase 1, with
iron-proxy in phase 3 (§10) — the spec's `engine` field is what makes the order a
choice rather than a rewrite.

Why not the alternatives: `squid`/`tinyproxy` give an allowlist and a log but no
injection and no per-request JSON; Coder Boundary brings its own jail and wants
sudo for it; Anthropic's `srt` proxy is a Node library tied to unix-socket
delivery; a self-written MITM with injection is exactly the code iron-proxy already
is, with a CA to look after.

#### 7.5.3 Presets, so an allowlist is not typed by hand

`network.presets` expands at resolution time from declarations the hub already
has or can add in one place each:

| Preset | Source | Examples |
|---|---|---|
| `harness` | the harness plugin's new `sandbox.domains` (§7.9) | claude: `api.anthropic.com`, `claude.ai`, `platform.claude.com`, `downloads.claude.ai`; cursor: `api2.cursor.sh` … `*.cursor.sh`; opencode: `opencode.ai`, `models.dev`; hermes: `inference.nousresearch.com` |
| `provider` | the provider plugin's `sandbox.domains` | `openrouter.ai`, `api.deepseek.com`, `opencode.ai` |
| `git-host` | derived from `git -C repo.path remote get-url origin` | `github.com`, `objects.githubusercontent.com`, `codeload.github.com` |
| `package-registries` | a static list in `server/sandbox/presets.mjs`, the union of Codex's "Common dependencies", Copilot's recommended allowlist and Claude's devcontainer | `registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`, `proxy.golang.org`, `crates.io`, `static.crates.io`, `repo1.maven.org`, `plugins.gradle.org`, `rubygems.org`, `deb.debian.org`, `archive.ubuntu.com` |

The resolved list is what the run's events record — a preset is a convenience
for the form, not a thing that changes meaning after the fact.

#### 7.5.4 Telemetry and "non-essential" traffic

`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_AUTOUPDATER=1`,
`DISABLE_TELEMETRY=1` (claude), `OPENCODE_DISABLE_AUTOUPDATE=1`,
`DO_NOT_TRACK=1` go into every sandboxed environment by default; the plugin
declares which of them exist (`sandbox.env`). A sandboxed run never updates its
own CLI — the image pins it (§7.10).

### 7.6 The hub ↔ agent channel: a unix socket and a per-run token

`fl-report` posts to `FL_HUB_URL = http://127.0.0.1:<port>`. From a container,
`127.0.0.1` is the container; on an internal network the host is unreachable by
design. Three options were weighed: bind the hub on the Docker bridge gateway too
(a second network listener on a process that "binds firmly to 127.0.0.1" — no);
`host.docker.internal:host-gateway` (same objection, and it needs a host route
the internal network deliberately lacks); or a **unix socket**. The socket wins,
and it carries a second improvement the hub should have had anyway:

- `hub.mjs` listens additionally on `$XDG_RUNTIME_DIR/freilauf/hub.sock` (fallback
  `~/.local/share/freilauf/hub.sock`, `FREILAUF_HUB_SOCKET`), through a **separate
  `http.createServer` with a tiny router**: `POST /api/runs/<id>/report`,
  `GET /api/runs/<id>/sandbox` (what am I allowed to reach — for the agent's own
  diagnosis), and nothing else. The full API stays on 127.0.0.1.
- Every run gets `runs.report_token` (random, 0600 in the run dir and in the
  environment as `FL_RUN_TOKEN`); the socket router requires it in an
  `Authorization` header and refuses a token that does not match the id in the
  path. The 127.0.0.1 route accepts the token when present and keeps working
  without it for one transition release, then requires it too — a claude
  subprocess spawned by the agent (§"A hook report from a foreign claude session")
  inherits the token like it inherits `FL_RUN_ID`, so `fremdeClaudeSession()` stays
  the guard it is.
- `fl-report` learns `FL_HUB_SOCKET`: `curl --unix-socket "$FL_HUB_SOCKET" http://hub/api/runs/$RUN_ID/report`.
  The inbox fallback (`~/agents/runs/<id>/inbox.jsonl`) works unchanged because the
  run directory is mounted read-write.
- The socket is bind-mounted into the agent container at the same path (a socket
  file can be bind-mounted; the container user must be able to connect: mode 0660,
  same uid — §7.7). `FL_HUB_URL` is **not** set in a sandboxed environment.
- `fl-report` itself, `fl-paths.sh` and `fl-harness-tags.sh` are bind-mounted
  read-only from `~/.local/bin` at the same path (cursor's `hooks.json` carries the
  absolute path; claude's inline hooks rely on `PATH`), and the image carries
  `bash`, `curl`, `python3`, `jq`, `git`. Alternatively the image installs the
  scripts from the deploy checkout at build time; mounting keeps them in step with
  the hub the way `setup/02-install-scripts.sh` does for the host.

The hub's own `fl-report done` answer (the finish gate's message) travels back the
same way and is printed into the agent's turn as today.

### 7.7 The agent's home, its state, and the uid question

**Home.** The container's `HOME` is `~/agents/runs/<id>/home`, bind-mounted
read-write at the same path, so:

- the hub's activity sources become `agentHome(run) + '/.claude/projects/<slug>/<run id>.jsonl'`
  etc. — one indirection in `measureActivity()`, `cursor-transcript.mjs`,
  `claudeTranskriptPfad()`, the opencode and hermes SQLite readers,
  `resumeCommand()`, and the two id lookups `resumeRun()` makes before it can
  launch a resume form (cursor's transcript basename, opencode's root session
  through `opencode-store.mjs`); unsandboxed runs return the host home;
- the claude transcript slug is derived from the **workdir path**, which is the same
  inside and outside — nothing else about the slug rule changes;
- seeded before start by the plugin (`sandbox.seedHome`, §7.9): claude's
  `.claude.json` with `hasCompletedOnboarding` and the project's `hasTrustDialogAccepted`
  (what `fl-start`'s `trust_workdir()` writes into the host file today) and
  `.claude/settings.json` (permissions, `sandbox.enabled: false` unless
  `innerSandbox`), opencode's `~/.config/opencode/opencode.json` + `plugins/freilauf.js`
  + `~/.local/share/opencode/auth.json` (or a placeholder key, §7.8), hermes'
  `~/.hermes/config.yaml` + `.env` + `SOUL.md`/`AGENTS.md` if the operator wants them,
  cursor's `~/.config/cursor/auth.json` + `~/.cursor/cli-config.json`;
- **never** the operator's whole `~/.claude` (skills, plugins, `settings.local.json`,
  history — the opt-in idea behind `~/agents/zusaetze/` applies with full force in
  a sandbox; the extra skills chosen for the run are mounted read-only at
  `~/agents/zusaetze/<name>` as today).

**uid.** Bind-mounted files must be readable and writable by the process inside and
by the hub outside, and `git` refuses to work in a repository owned by another
uid unless `safe.directory` says so. The rule is one line per daemon type:

| Daemon | Run the agent as | Why |
|---|---|---|
| rootful Docker (`docker` group) | `--user <hub uid>:<hub gid>` with a passwd entry (image built with `--build-arg UID`, or `fixuid`/entrypoint), `HOME` set explicitly | files stay owned by the hub user; `bypassPermissions` needs non-root |
| rootless Docker | container **root** (uid 0), which *is* the hub user on the host | Docker's documented mapping; a non-root container user would write host files as `subuid + n − 1` |
| Podman rootless | `--userns=keep-id` (the hub uid maps to itself) | Podman's documented answer to exactly this |

`userns-remap` on a rootful daemon is **not** used: bind-mounted files appear as
`nobody` and Docker exposes no per-container id-mapped mount (moby #52061 closed
unmerged, roadmap #398 unanswered); Podman's `:idmap` exists if anyone needs it.

**claude as container root under rootless Docker.** `--dangerously-skip-permissions`
refuses root "unless inside a recognized sandbox" — what "recognized" means is
undocumented; the plugin's `seedHome` can set `IS_SANDBOX`-style hints, but this
must be **measured** before rootless Docker is recommended for claude (§11).
Rootful Docker with `--user` has no such question.

### 7.8 Secrets

Three modes, per profile, per credential kind:

| `secrets.mode` | What the container holds | How the request is authenticated | Needs |
|---|---|---|---|
| `env` | the real key in the environment (`docker run -e`), as `fl-start --env` does today | the CLI sends it | nothing new; the weakest, and the phase-1 default |
| `inject` | a **placeholder** (`fl-token-<random>`) in the environment or the seeded auth file | the proxy's `secrets` transform swaps it for the real value **only** on requests to the credential's declared hosts (`Authorization`, `x-api-key`, or the plugin-declared header) | `network.mode: allowlist`, `engine: iron-proxy`, `tlsTerminate: true`; the plugin declares `credentials[].injection = { header, hosts }` |
| `none` | nothing | — | a subscription CLI whose auth file is seeded (§7.7) — and then that file *is* a credential in the container; `inject` applies to it too where the CLI's auth is a bearer token |

What the real value is, is answered where it is answered today:
`credentialValue(pluginId, key)` — stored value, operator-named variable, declared
`envKeys` — and the proxy's config is generated from that, so a key stored in the
UI is honoured in the sandbox the way `pluginHasCredential()` made it honoured in
the form. The proxy container reads the real values from its own environment
(`docker run -e` on the proxy, or a 0600 file mount), never the agent container.

Per CLI:

- **claude**: the OAuth token pair in `.credentials.json` is refreshed by the CLI
  and a copy per run risks invalidating the host session's refresh token on
  rotation [inferred — to measure, §11]. The documented alternative is
  `CLAUDE_CODE_OAUTH_TOKEN` (a long-lived token from `claude setup-token`) stored as
  a hub credential of the claude plugin and **injected** (`Authorization: Bearer`
  to `api.anthropic.com`), so no credentials file enters the container at all;
  `env` mode passes it as a variable. OAuth refresh (`platform.claude.com`) is then
  not needed by the run.
- **cursor**: `CURSOR_API_KEY` (documented) — injectable (`api2.cursor.sh` …);
  Docker Sandboxes intercepts the OAuth poll at `api2.cursor.sh/auth/poll` instead,
  which shows an OAuth-based path exists but is undocumented — `env` with the API
  key is the reliable one.
- **opencode / hermes**: `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, `OPENCODE_API_KEY`
  are bearer headers to one host each — the textbook injection case.
- **git**: no credential in the sandbox, ever. Fetching is from the mounted
  read-only `.git` of the operator's checkout, which the hub keeps fresh
  (`makeWorktree()` fetches origin before every run; the integrator fetches per
  job); pushing is the hub's (`nothing lives only on this machine`). A repo that
  wants the agent to `git fetch` a **different** remote gets a read-only deploy
  key or fine-grained token injected by the proxy on `github.com` — later.

What `inject` does not cover, stated as the vendors state it: signature-based auth
(AWS SigV4 — Claude Code's `awsPairs` does it, iron-proxy does not), raw-socket
clients that bypass the CA bundle (`NODE_OPTIONS=--use-openssl-ca` mitigates for
Node), and a placeholder the agent decides to paste into a commit — harmless,
because it is worthless outside the proxy, which is the entire argument for the
pattern.

### 7.9 The plugin system: what a harness and a provider declare

A new optional block on the harness descriptor, validated by `validateDescriptor()`
and documented in `docs/plugins.md` next to `launch`:

```js
sandbox: {
  supported: true,                       // false/absent → the form does not offer the sandbox for this harness
  image: { dockerfile: 'sandbox/images/claude.Dockerfile', args: { CLAUDE_VERSION: '2.1.258' } },  // or { ref: 'ghcr.io/…@sha256:…' }
  domains: ['api.anthropic.com', 'claude.ai', 'platform.claude.com', 'downloads.claude.ai'],
  env: { DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1' },
  credentials: [{ key: 'oauth_token', envKeys: ['CLAUDE_CODE_OAUTH_TOKEN'], injection: { header: 'Authorization', prefix: 'Bearer ', hosts: ['api.anthropic.com'] } }],
  seedHome: ({ home, run, ctx, spec }) => [{ path: '.claude.json', content: … }, { path: '.claude/settings.json', content: … }],
  stateDirs: ['.claude/projects'],       // what the hub reads back — documented, so an implementer knows why they are mounted rw
  launchOverrides: ({ spec }) => ({ mode: 'bypassPermissions' }),   // what changes on the command line inside a sandbox
  innerSandbox: { off: { settings: { sandbox: { enabled: false } } }, weak: { settings: { sandbox: { enabled: true, enableWeakerNestedSandbox: true } } } },
  // no `resume` field: whether a run can be picked back up is `launch.resume`'s answer
  // (fl-start's own for the four built-ins) — the one `resumeRun()` reads, see §7.12.4
}
```

For the four built-ins: claude as above; opencode (`domains: ['opencode.ai',
'models.dev']`, seed `auth.json` + config + `plugins/freilauf.js`); hermes
(`domains` from its provider, seed `~/.hermes`; force `terminal.backend: local`;
it has no resume form, so `resumeRun()` relaunches it fresh — §7.12.4); cursor
(`domains` = the enterprise list, seed `auth.json`, `launchOverrides: { sandbox:
'disabled' }`). Whether a coding agent can be picked back up is **not** declared
here: `fl-start` knows the resume form of the four built-ins and an external
plugin declares `launch.resume` (an args template with `{resume_id}`) — the one
answer `resumeRun()` reads, whether the session was lost to a reboot or replaced
by a reconfiguration. A second flag next to it would be a second statement about
one fact. Provider plugins get `sandbox: { domains: [...], credentials: [{ key:
'api_key', injection: { header: 'Authorization', prefix: 'Bearer ', hosts: [...]
} }] }`.

An **external** plugin without `sandbox` is simply not offered the option, the
same way one without `launch` cannot start a run. `launchable(harness)` gains a
sibling `sandboxable(harness)` asked at form time, so a repo whose default is
"sandbox on" and an agent whose plugin cannot be sandboxed meet in a readable
form problem — or, under `sandbox_mode: required`, a refusal.

`fl-start` grows `--sandbox <spec.json>`: the hub resolves the spec, writes it into
the run directory (0600, like `launch.json`), and `fl-start` wraps `<cmd>` with the
runtime's command line built from it (`sandbox/wrap.sh`, sourced by `fl-start`, so
a human can also start a sandboxed session by hand). The four built-in `case`
branches and the `--spec` path both go through the wrapper — nothing harness-
specific lives in it.

### 7.10 Images

`sandbox/images/` in this repository:

- `base.Dockerfile`: `ubuntu:24.04` (or a Docker Hardened Image / distroless base
  where the toolchain allows), non-root user `agent` with `ARG UID=1000 GID=1000`,
  `git curl ca-certificates jq python3 bash ripgrep tini`-less (we use `--init`),
  `build-essential` for native modules, Node 22 (the hub's own version), locale
  `C.UTF-8`, `TERM`/`COLORTERM` passed at run time.
- `<harness>.Dockerfile` per built-in: `FROM freilauf/agent-base`, install the CLI
  at the **pinned** version the plugin declares (`claude` native installer with a
  version, `opencode` release binary, `cursor-agent` installer, `hermes` via
  `pipx`/`uv`), `DISABLE_AUTOUPDATER=1` baked in.
- **Composition for a repo's own toolchain**: `repos.sandbox_image` may name an
  operator image (a Java repo needs a JDK, a Rust repo a toolchain). The hub builds
  `freilauf/agent-<harness>-<repo>` as `FROM <operator image>` + the harness layer
  (`overlay.Dockerfile` with `ARG BASE`), so the company owns the toolchain and
  Freilauf owns the agent. Detecting `.devcontainer/devcontainer.json` and using
  its `image`/`build` is the obvious later convenience.
- Builds happen lazily on first use (`docker build` with the cache, a settings
  page button, and `docker image inspect` for the digest), the digest is written
  into `runs.sandbox_spec.image.digest` and into the `started` event. A missing
  image is a readable refusal at launch (`failRun()` with the build log), never a
  hang.

### 7.11 Lifecycle, tmux, reconciliation

**The pane command**, assembled by `sandbox/wrap.sh` from the spec (rootful daemon
shown; the rootless variant drops `--user` and the podman variant adds
`--userns=keep-id`):

```bash
docker run -it --rm --init \
  --name "fl-$RUN_ID" --label freilauf.run="$RUN_ID" --label freilauf.hub="$HUB_ID" \
  --detach-keys 'ctrl-^,ctrl-^' --stop-timeout 30 \
  --user "$UID:$GID" -e HOME="$HOME_DIR" -e USER=agent \
  --cap-drop ALL --security-opt no-new-privileges \
  --read-only --tmpfs /tmp:rw,nosuid,size=2g --tmpfs /run:rw,noexec,nosuid,size=64m --tmpfs "$HOME_DIR/.cache:rw,nosuid,size=2g" \
  --pids-limit 4096 --memory 8g --memory-swap 8g --cpus 4 --shm-size 1g \
  --network "fl-net-$RUN_ID" \
  -e HTTPS_PROXY="http://fl-proxy-$RUN_ID:8080" -e HTTP_PROXY="http://fl-proxy-$RUN_ID:8080" -e ALL_PROXY="http://fl-proxy-$RUN_ID:8080" \
  -e SSL_CERT_FILE=/etc/freilauf/ca.crt -e NODE_EXTRA_CA_CERTS=/etc/freilauf/ca.crt -e GIT_SSL_CAINFO=/etc/freilauf/ca.crt \
  -e TERM="$TERM" -e LANG=C.UTF-8 -e LC_ALL=C.UTF-8 -e COLORTERM=truecolor \
  -e FL_RUN_ID="$RUN_ID" -e FL_RUN_TOKEN="$TOKEN" -e FL_HUB_SOCKET=/run/freilauf/hub.sock \
  "${ENV_ARGS[@]}" \
  -v "$WORKDIR:$WORKDIR" \
  -v "$REPO_GIT:$REPO_GIT:ro" -v "$EMPTY:$REPO_GIT/config:ro" \
  -v "$RUN_DIR:$RUN_DIR" -v "$HOME_DIR:$HOME_DIR" \
  -v "$HUB_SOCKET:/run/freilauf/hub.sock" \
  -v "$HOME/.local/bin/fl-report:$HOME/.local/bin/fl-report:ro" -v "$HOME/.local/bin/fl-paths.sh:$HOME/.local/bin/fl-paths.sh:ro" \
  -v "$CA_CRT:/etc/freilauf/ca.crt:ro" \
  "${EXTRA_MOUNTS[@]}" \
  -w "$WORKDIR" \
  "$IMAGE@$DIGEST" "${CMD[@]}"
```

(`$HOME` above is the host home; paths inside the container are the same strings.
`--user` needs a passwd entry; the image provides `agent` at build-time `UID`, or
`-v /etc/passwd:/etc/passwd:ro` is the crude alternative.)

**Start order** in `launchRun()`: resolve spec → clone → seed home → write
`sandbox.json` + `proxy.yaml` → `docker network create` → start proxy → `fl-start
--sandbox` (tmux + `docker run`) → `deliverGoal()` as today. Any failure before the
tmux session exists is `failRun()` with the reason and removes what was created;
`tmux_or_die()`'s pattern extends to the containers. A **resume**
(`runs.resume_pending`, §7.12.4) walks the same order with every step
idempotent: the spec is read from `runs.sandbox_spec` as it stands in the row
(a lost session keeps its frozen spec, a reconfiguration wrote the new one
before calling), clone and home exist and are left alone, the network is created
and the proxy started only where they are missing, a container still holding
the name `fl-<id>` is stopped first, and `fl-start --sandbox --resume` wraps the
harness's resume form instead of its fresh one.

**Events**: `started` carries `sandbox: { runtime, image, digest, network.mode,
resolvedAllow, mounts, resources, secrets.mode, user }`; `sandbox:proxy_started`,
`sandbox:blocked`, `sandbox:policy_changed {by, diff}`, `sandbox:override_refused`,
`sandbox:bypassed`, `sandbox:container_gone`, `sandbox:restarting {reason, diff}`
(§7.12; the way back is `resumeRun()`'s own `resumed` event, not a second one)
— all through `addEvent()`, so the live channel and the run's history get them
for free.

**Ending a run.** `killSessions()` and `/api/runs/<id>/kill` do `docker stop
fl-<id>` (SIGTERM → 30 s → SIGKILL) **before** `tmux kill-session`, then
`docker network rm`; `--rm` removes the container, the proxy is stopped with it.
`reconcileClosedSession()` learns a second question, `containerGone(run)`: a
container that is gone while the session stands means the agent died
(`pane_dead` will say so); a session that is gone while the container stands is
the client-died case (§7.1) — stop the container, write `sandbox:container_gone`.
Which of the two ends the run is the recovery design's rule, not the sandbox's:
a session the hub closed on purpose (kill route, sessions page, retention,
archive, a flow's `kill_run`) is reconciled as an end, a session that went away
by itself is handed to `resumeRun()` — and for a sandboxed run that resume stops
the orphaned container before it starts the next one (start order above).

**Reconciliation and orphans.** The watcher pass gains `reconcileContainers()`:
`docker ps -a --filter label=freilauf.hub=<id> --format …` versus the runs table —
a container whose run is terminal and whose session is closed is stopped and
removed (hermes' orphan reaper, with its rule "running containers are never
reaped" for a run still in flight); a run that says sandboxed whose container is
gone gets the event. `tmuxVerdict()`'s lesson applies: "docker did not answer" is
`unreachable`, not "no containers" — a daemon restart must not end every
sandboxed run.

**Hub restart / deploy.** The tmux server belongs to `freilauf-tmux.service`,
a unit of its own that the hub is ordered after and that `freilauf-deploy` never
restarts (`KillMode=process` on the hub unit stays as belt and braces); the
sessions and their `docker` clients are children of that server, not of the hub,
so a deploy leaves sandboxed runs running exactly as it leaves the others. The
proxy containers are Docker's, not the hub's. After a restart the first watcher
pass runs at once and its reconciliation re-adopts them by label.

**Server reboot, or a lost tmux server.** The sessions go, the `docker` clients
with them, and through `--init` the agents inside — `--rm` removes the
containers, the proxies with them; the per-run networks are persisted by the
daemon and survive. What survives on disk is everything a resume needs: the
clone, the run directory and the per-run home with the agent's own transcript
or session store. `resumeRun()` then does for a sandboxed run what it does for
any other, through the idempotent start order above — with one condition that
is the sandbox's alone: the first watcher pass after a boot runs immediately,
and a rootless `docker.service` user unit may not be listening yet. A resume
that cannot *ask* the daemon must wait for the next pass, exactly as
`tmuxVerdict()`'s `unreachable` waits — never `failRun()` a run for a daemon
that is still booting (§11).

**Retention.** `session_keep_hours` closes the tmux session and, with it, the
container (the client exits; PID 1 gets SIGHUP through `--init`; `docker stop` as
the belt). `archive_session_*` the same. `profile.retention: keep` maps to the
same clock without the stop — the container is left for `docker exec` debugging
until the clock runs out.

**Resource display.** `listSessions()` recognises a pane whose command is `docker`
and asks `docker stats --no-stream --format '{{.MemUsage}} {{.CPUPerc}}' fl-<id>`
instead of walking the process tree; the sessions page shows a "sandboxed" badge
and the image; `sessionMemory()` adds container memory to the machine total.

**`fl-attach` / `fl-kill`.** Attach is unchanged (host tmux). `fl-kill` reads the
run id from the session name's tag and runs `docker stop` on `fl-<id>` when a
container of that name exists — one `docker ps --filter name=` per kill, fail-soft
without Docker.

### 7.12 "The sandbox blocks something the agent needs": noticing it, and loosening it without losing the agent

This is the edge case the brief singles out, and the one a sandbox feature lives or
dies on: a policy written before the run is wrong for some run, the agent hits the
wall, and either nobody notices (the run fails an hour later with a report that
says "could not install dependencies") or the fix costs the run. The design has
five parts.

#### 7.12.1 Noticing: four channels, each with a test

| Channel | What it sees | Becomes |
|---|---|---|
| **Proxy denials** (network) | every 403 the proxy issued: host, method, count, first/last time — from iron-proxy's JSON log or the builtin proxy's memory | `sandbox:blocked {host, count}` events, deduplicated per host per 10 minutes (the incident module's own throttle idea), and an incident `sandbox_blocked` in the **Noticed** group — yellow, because a single denial may be exactly what the policy intended; red after N distinct hosts or when the agent has been silent since (the `bewerteLogTreffer()` veto in reverse: work *after* the denial says the agent coped) |
| **The log scanner** (filesystem, resources, docker-in-docker) | `EACCES`, `EROFS` / `Read-only file system`, `ENOSPC` on a tmpfs, `Cannot connect to the Docker daemon`, `Could not resolve host`, `ENETUNREACH`, `403 Forbidden` together with the proxy's marker string — a new `sandbox` pattern family in `harnesses/patterns.mjs`, applied only to sandboxed runs | `anomaly:sandbox_denied` with the line, yellow, same exception list and same "work after the hit vetoes escalation" rule as the incident scanner — an agent reading its own error handling must not turn its run red |
| **The agent asks** | a new report kind `fl-report access "<what and why>"` — the prompt tells the agent to use it (below) | `help`-like: incident in **Needs you**, notification with the text, run stays `running` (the agent is told to continue with what it can do meanwhile, or to wait — its choice, stated in the report) |
| **The proxy tells the agent** | the 403 body: `Freilauf sandbox: <host> is not on this run's allowlist. If you need it, run: fl-report access "<host>: <why>"` — `srt`'s `X-Proxy-Error` idea with the instruction in the text | the model reads its tool output; the instruction is in the place it looks |

The prompt gets a **Sandbox** section in `platformSuffix()` (between the platform
rules and the harness's own lines — the same slot logic as the operator's suffix):
"You are running in a sandbox. Working copy: `{workdir}` (read-write). Network:
allowlist — `{resolved allow list}`; other hosts answer 403. Memory `{memory}`, CPU
`{cpus}`. If you need a host, a path or more resources, do not work around the
sandbox: run `fl-report access "<what you need and why>"` and continue with what
you can; a human decides and the change reaches you without a restart where
possible." A sentence the agent can act on beats a wall it hits five times.

#### 7.12.2 Deciding: one click, three scopes

The incident and the notification carry the same three buttons the merge ladder
has for a blocked run: **Allow for this run** (`runs.sandbox_overrides` gains the
host; the proxy reloads; event `sandbox:policy_changed {by: user, add: [host]}`),
**Allow for this repo** (the repo's overrides or its profile gain it; this run
reloads too), **Deny and tell the agent** (a message into the session: "`<host>`
stays blocked; do without it" — through `sendToSession()`, with the `waiting_help`
guard the send route already has). A locked field (§7.3) greys the repo button out
and says why. Telegram's inline buttons are how the same choice reaches the phone
(`notify.mjs` messages already carry `url`/`linkLabel`; a second link is a
notifier-side rendering question).

#### 7.12.3 Applying: what changes live, what needs a restart

| Change | Live? | How |
|---|---|---|
| network allow/deny, methods, audit-only → enforce | **yes** | rewrite `proxy.yaml`, `POST /v1/reload` (iron-proxy: atomic, keeps serving) or swap the builtin proxy's in-memory policy; effective for the next connection — the agent's retry succeeds. Modal terminates newly-forbidden connections on tightening; iron-proxy does not — a tightening applies to new connections, which is acceptable |
| memory, cpus, pids limit | **yes** | `docker update --memory … --cpus … --pids-limit … fl-<id>` (documented for running containers); the event records old and new |
| a new mount, a wider tmpfs, `readOnlyRoot`, a different image, `user`, `innerSandbox` | **no** — Docker cannot add a mount to a running container | **reconfigure and resume** (below) |
| secrets mode | no | reconfigure and resume |

#### 7.12.4 Reconfigure and resume: the agent keeps its conversation

For the changes that need a new container, the run is **resumed**, not thrown
away — and the mechanism is not the sandbox's. The recovery design's
`resumeRun()` already does everything a reconfiguration needs: it closes the
books on the old session, launches the harness's **resume form** through the
same `fl-start` (`--resume <id>`, the continuation text as the ordinary `-f`
prompt file; claude `--resume <run id> "<text>"` — the session id *is* the run
id, found in the seeded home; cursor `--resume <chatId>`; opencode
`--session <root session id>`; an external plugin
through its `launch.resume` template), re-arms the log pipe and the pane-died
hook on the new session, re-delivers the goal, and writes `resumed {attempt,
session}`. A `respawn-pane` in the old session with a hand-typed continuation
line would be a second copy of exactly that path, and the one thing it would
have bought — the same session name — is not worth it: `runs.tmux_session` is
rewritten by the launch, the live channel swaps the page, and the browser
terminal reattaches by run, not by name. So:

1. The new spec is written into `runs.sandbox_spec` and the row is marked
   `resume_pending` **first**, then `sandbox:restarting {reason, diff}` — in that
   order, so a watcher pass that finds the session gone in the next second sees a
   run already on its way and does not start a second resume with the old spec.
   The hub types nothing into the session (an agent mid-tool-call is
   interrupted either way).
2. `docker stop fl-<id>` (30 s grace, SIGKILL after), then the tmux session is
   closed. The clone, the run dir and the home — with the agent's
   transcript/session store — are bind mounts and survive.
3. `resumeRun(runId, { reason: 'sandbox_reconfigure' })` — a **direct** call by
   the sandbox module, not the watcher's discovery path: the rule "the hub does
   not resume a session it ended itself" is about the watcher not undoing a
   deliberate kill, and a caller that closed the session in order to resume it
   is the opposite case. `launchRun()` then walks the sandbox start order (§7.11)
   with the spec from the row, and the resume form runs inside the **new**
   container. The continuation text names what changed — "The sandbox was
   reconfigured: `<diff>`. Continue." — in place of the recovery design's
   "interrupted by a server restart" sentence.
4. For a coding agent with no resume form (an external plugin without
   `launch.resume`; hermes has one since 0.21 — `--in <workdir> --resume <id>`,
   the id out of its `state.db`), `resumeRun()` relaunches it fresh with the original prompt
   in the same clone — its commits and its working state are there — and the
   event says so; the operator is told that the conversation is lost. Prepending
   the run's `progress` reports and the log tail as a "what you had done" section
   is the obvious improvement to that fresh launch, and it belongs in
   `resumeRun()` for every harness without a resume form, not in the sandbox.
5. `resumed {attempt, session}` is `resumeRun()`'s own event; the watcher's
   clocks (`expected_minutes`, follow-up commission) keep running — a
   reconfiguration is not a new run, and the seconds the container was down are
   what `started_at` shifts by.

The same mechanism is the **break-glass**: "Continue without the sandbox" writes
`runs.sandbox = 0`, stops the container, closes the session and calls
`resumeRun()` the same way, so `launchRun()` starts the plain resume form in the
same clone on the host, with `sandbox:bypassed {by: user, reason}` — an explicit,
named, notified act, available only when `sandbox_allow_bypass` permits it. The
resume form has to find the conversation in the **run's** home, so that launch
keeps `HOME=<run home>` in the session's environment and re-seeds the
credentials in `env` mode (they were placeholders under `inject`); where that
cannot be made to work for a harness, the break-glass is a fresh launch and says
so.

#### 7.12.5 Preventing: dry run and audit-only mode

- **Dry run** (repo form and profile editor): start the image with the resolved
  spec and no agent, run inside it `git -C <clone> status`, `git fetch origin`,
  `fl-report progress "dry run"` over the socket, one `curl -I` per resolved allow
  entry through the proxy, one to a host that must fail, `df` on every tmpfs, and
  print the table. Claude's devcontainer verifies its firewall the same way
  ("example.com must fail, api.github.com must succeed"); making it a button is the
  difference between a policy someone tested and one someone hopes is right.
- **Audit-only** (`network.auditOnly: true`, iron-proxy `warn: true`): everything is
  allowed, every would-be denial is logged and counted per host. After a few runs
  the repo page shows "hosts these runs reached that are not on the allowlist" with
  an **Adopt** button that writes them into the profile — Greywall's `--learning`
  and Copilot's "recommended allowlist", grown from a repo's own traffic. This is
  the rollout path an enterprise actually follows: observe, then enforce.

### 7.13 Data model, forms, and the places a new field touches

**Tables** (all via `addColumn()`, one new table):

```sql
CREATE TABLE IF NOT EXISTS sandbox_profiles (
  id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, spec TEXT NOT NULL DEFAULT '{}',
  builtin INTEGER NOT NULL DEFAULT 0, created_at TEXT, updated_at TEXT);
-- repos:   sandbox_default TEXT NOT NULL DEFAULT 'inherit' CHECK(inherit|on|off) — no CHECK, the value set is a registry-like list in run-def
--          sandbox_profile_id INTEGER, sandbox_overrides TEXT DEFAULT '{}', sandbox_image TEXT
-- agents:  sandbox TEXT NOT NULL DEFAULT 'inherit', sandbox_profile_id INTEGER, sandbox_overrides TEXT DEFAULT '{}'
-- runs:    sandbox INTEGER NOT NULL DEFAULT 0, sandbox_profile_id INTEGER, sandbox_overrides TEXT DEFAULT '{}',
--          sandbox_spec TEXT (frozen at launch), sandbox_container TEXT, sandbox_home TEXT, worktree_kind TEXT DEFAULT 'worktree',
--          report_token TEXT
-- settings keys: sandbox_mode, sandbox_lock, sandbox_allow_bypass, sandbox_runtime, sandbox_allowed_mount_roots, sandbox_proxy_engine, sandbox_ca_dir
```

Built-in profiles seeded once (`builtin = 1`, editable copy on write): **Balanced**
(allowlist with the four presets, inject, 8g/4cpu, `innerSandbox: off`), **Locked
down** (harness + provider domains only, no registries), **Open network**
(filesystem and resources only), **Audit** (Balanced with `auditOnly: true`) — the
Docker Sandboxes trio plus the rollout mode.

**The run-definition checklist** (the `keep_on_branch` list, applied):
`runDefFields()` (a `sandboxFields()` block with `data-sandbox-harnesses`),
`runDefFromForm()` (tri-state + overrides JSON validated by `validateSandboxOverrides()`
against the lock), `defFromAgent()`, `saveAgent()` (INSERT and UPDATE), `createRun()`,
`RUN_DEF_FLOW_FIELDS` / `defFromFlowProps()` (a `sandbox` select and an `sandboxOverrides`
textarea for the "start single run" step; the "start agent" step inherits),
`addColumn()` ×2, `pickQuickFields()` — **not** added (Quick Run takes the repo
default; a favorite carries the tri-state via `runSetupFromForm()` because it is
setup, not task), `rememberRunChoice()` — not added, `runEditAllowed()` — `sandbox`
and `sandbox_overrides` editable while `scheduled`/`deferred` (no session yet),
overrides' *live* subset editable while `running` through the §7.12 buttons rather
than the edit card. `resolveSandboxSpec()` runs in `startRun()` next to
`resolveRouting()` — before `createRun()`, so the frozen spec is in the row from
the first moment; `launchRun()` reads it, the way it reads `or_routing`.

**Pages**: Settings → Sandbox (hub layer, profiles, discovery, images, CA);
repo form block; agent/run form block; run detail "Sandbox" line (image digest,
network mode, resolved allowlist folded, blocked hosts with the three buttons,
"Reconfigure…", "Continue without the sandbox"); overview status cell suffix
(`sandboxed` / `bypassed`); sessions page badge; Plugins page: which coding agents
declare `sandbox`. i18n keys for all of it in three languages (the i18n test
enforces it).

**Discovery**: `scanSystem()` records `docker` (or `podman`) on the `PATH`, its
version, rootless or not (`docker info --format '{{.SecurityOptions}}'`), `runsc`
registered as a runtime, and the userns sysctl; the Plugins page and the Welcome
wizard show "Sandbox: available / not available (install Docker)"; `sandbox_mode`
cannot be set above `off` while nothing is found — the same shape as an
unconfigured coding agent.

**Tests**: `test/sandbox-env.mjs` gets a `docker` shim on the PATH (the
`test/deploy.mjs` pattern: a script that logs its argv to a file and answers what
the test dictates — `run` executes the command on the host in the same directory,
`stop`/`ps`/`network`/`update`/`stats`/`exec` are recorded and faked), so the e2e
suite asserts the exact flags a profile produces, the clone layout, the socket
report path with a token, the refusal of a loosening override, the events, the
reconcile of an "orphan", and the `docker update` on a live limit change. A real
Docker run per harness joins `--echt` for hosts that have it. `test/unit.mjs`
covers `resolveSandboxSpec()` (layering and narrowing), preset expansion, the
proxy config generator, the log-scanner patterns and the wrapper's argv builder.

### 7.14 Audit

Per sandboxed run, in `~/agents/runs/<id>/`: `sandbox.json` (the spec as launched,
digest included), `proxy.yaml`, `egress.jsonl` (the proxy's per-request log,
tailed from the container), `docker-events.jsonl` (`docker events --filter
container=fl-<id>` for the run's lifetime — start, die, oom, exec_create),
`detektor.jsonl` as today, and the events table. What the agent *did* is in the
harness's own transcript in the run's home (`stateDirs`), which is now
per run and therefore part of the record rather than a file in the operator's home.

Export: `GET /api/runs/<id>/audit.jsonl` streams all of it as one **hash-chained**
JSONL (`prev_hash` per line, first line = the run id and the hub's sha), so a
copy handed to an auditor is tamper-evident — the one requirement no vendor
answers (§5.3). Optionally forwarded per run to an OTEL collector the operator
names; Claude Code's own OTEL events (`CLAUDE_CODE_ENABLE_TELEMETRY`,
`OTEL_LOG_TOOL_DETAILS`) can be switched on per profile for installations that
want command-level detail from the agent's side as well.

---

## 8. Edge cases, one by one

1. **Docker missing / daemon down / rootless without cgroup delegation.** Discovery
   says so; a `required` hub refuses starts with a readable problem; an
   `available` hub starts unsandboxed and writes `sandbox:bypassed {by: 'unavailable'}`
   — never silently. A daemon that stops mid-run: `reconcileContainers()` gets
   `unreachable`, does nothing, a global incident `docker_unreachable` (the
   `tmux_unreachable` twin).
2. **Retry of a failed sandboxed run.** `makeSandboxClone()` reuses an existing
   clone directory like `makeWorktree()` does (`existsSync(target) → return`); the
   container name `fl-<id>` is reused after a `docker rm -f` of the leftover; a new
   `report_token` is issued (the old session is gone with its token).
3. **Two runs on one repo.** Two clones, two networks, two proxies; the operator's
   `.git` is mounted read-only into both; alternates are read-only sharing —
   nothing to coordinate. `max_parallel` counts as today.
4. **Conflict run for a sandboxed original.** Inherits the original's resolved
   spec (`resolver_run_id` link), works in a fresh clone from the same tip on
   `resolve/<short id>`; the finish gate is the same; `isResolverRun()` rules
   unchanged.
5. **Follow-up commission.** Works as long as the container stands, which is as
   long as the agent's TUI does — all four since hermes 0.21 (`-q` seeds an
   interactive session on a TTY and stays; an older hermes exited, and its
   container went with it). The commission's clock and the `telegram_on` box
   are unaffected.
6. **`waiting_help` inside a sandbox.** Unchanged: the answer is typed through the
   pane; the goal-delivery guard and the "main has moved" exclusion apply as before.
7. **`merge_check` runs the agent's code on the host.** With `merge_mode: hub` and a
   sandboxed run, the check should run in the sandbox image too: `docker run --rm
   … -v <integration worktree>:… <image> bash -lc "<merge_check>"` with the same
   network policy. A repo setting `merge_check_sandboxed` (default = the repo's
   sandbox default) — phase 2. Until then the doc says plainly that a merge check is
   host execution of merged code.
8. **Link-mode worktree extras.** Mounted read-only at the identical path inside
   (`filesystem.extras: ro`); an agent that needs to `npm install` gets `copy` or a
   per-run named volume (`rw` = mount the operator's `node_modules` writable — the
   trust question again, so it is a per-repo choice and off by default). Copy-mode
   extras are files in the clone and need nothing.
9. **`cleanupWorktrees()` and `git worktree prune`.** Clones are removed with `rm
   -rf` after the dirt check through `runGit()`; `refs/freilauf/runs/<id>` is deleted
   in `repo.path`; `worktree prune` never sees a clone.
10. **Disk.** tmpfs sizes count against `--memory`; a clone's new objects and the
    agent's build outputs live on the host disk under `~/agents/worktrees` as today
    — `resources.diskTmpfs` bounds only the temp space. A real disk quota needs a
    volume with `--storage-opt size=` (overlay2 on xfs with pquota) — documented as
    an operator option, not implemented.
11. **Ubuntu 24.04 user namespaces.** Irrelevant for a rootful daemon; a one-time
    AppArmor profile for `rootlesskit` (bundled with the `.deb`); required per
    binary for any bwrap-based inner or light sandbox — the setup guide says which
    file, the hub never runs `sudo`.
12. **The `docker` group is root.** Any process of the hub user can `docker run
    -v /:/host --privileged`. The sandbox protects the host from the *agent*, not
    from the hub; and an agent that could reach the Docker socket would be root —
    hence no socket mount ever, `excludedCommands`-style `docker *` in the
    opencode/claude permission blocks, and the recommendation of rootless Docker
    (an escape lands in the hub's uid) in the setup guide.
13. **Nested Docker for a repo whose tests need it.** Not in a runc sandbox (needs
    the socket or `--privileged`); Sysbox is the documented answer
    (`runtime: sysbox-runc`, rootful only) — a later runtime option, per repo.
14. **Playwright / Chromium.** `--shm-size 1g`, `chromiumSandbox: false` (Playwright's
    default), `--init`; documented in the image's README. Under `runsc` untested.
15. **inotify-based dev servers.** Work under runc/podman for the agent's own edits
    and the hub's; under `runsc` only for the agent's own; a note in the profile
    editor next to `runtime`.
16. **Time.** The container shares the host clock; `expected_minutes`, the
    overrun ladder and `maxRuntimeMinutes` (a hard `docker stop` + `aborted` with
    reason) are the hub's as today.
17. **Terminal size and colours.** `-e TERM=$TERM` from the tmux pane, `C.UTF-8`
    locale, `COLORTERM=truecolor`; the initial size is set at creation on Engine ≥
    23.0 — the "80×24 first paint" race of older engines is a documented
    limitation to name in the setup guide.
18. **The agent presses the detach keys by accident.** Overridden to a chord no TUI
    uses; if it still happens, the pane dies with exit 0 while the container runs
    — `reconcileClosedSession()` + `containerGone()` see the mismatch, stop the
    container and write `sandbox:container_gone {reason: 'client detached'}`.
19. **The proxy dies.** The agent's next request fails with a connection error, not
    a 403; the watcher's `reconcileContainers()` sees `fl-proxy-<id>` gone while the
    run is going, restarts it with the same config (`sandbox:proxy_restarted`), and
    the agent's retry succeeds. The internal network guarantees nothing leaked in
    between.
20. **A repo default changes while runs are scheduled.** Read live until launch,
    like `repos.prompt`; a running run keeps its frozen spec; the run-detail line
    shows the spec it runs with.
21. **The agent edits its own `.claude/settings.json` in the clone** (a project
    settings file that could re-enable hooks or MCP servers). Claude's protected-path
    rule covers this in its sandbox; in ours the container's own filesystem is the
    agent's — the guard is that nothing in the clone is executed on the host
    (§7.4.4, §8.7) and that the hub's hooks come from `--settings` on the command
    line, which project settings cannot override for the hooks the hub installs
    (measure: claude's precedence between `--settings` and project files).
22. **Secrets in `docker inspect`.** `-e` values are visible to anyone who can run
    `docker inspect` — i.e. the hub's user, who has them anyway; with `inject` they
    are placeholders. The proxy container's real values are passed the same way;
    an operator who minds mounts them as a 0600 file instead (`file` source).

---

## 9. Alternatives considered and rejected

| Alternative | Why not |
|---|---|
| Use each agent's native sandbox as the boundary | four vocabularies, commands-only coverage, two of them dead on this host, nothing for opencode or external plugins (§3.5) |
| Docker Sandboxes (`sbx`) as the runtime | proprietary CLI, KVM required, fixed agent list, VM per run, governance paid; every design idea in it is reproduced with Docker Engine here (§4.1) |
| gVisor as the default runtime | slower syscall-heavy toolchains, inotify blind to host-side edits, embedded-DNS friction; right as an opt-in `runtime` for repos that want a kernel boundary (§4) |
| Kata / Firecracker / microsandbox | KVM, VM per run, no worktree model, virtiofs without inotify; the upgrade path for regulated environments, not the base (§4) |
| tmux inside the container / `docker exec` pane | doubles the control surface; nothing can signal an exec'd process (§7.1) |
| Mount the operator's `.git` read-write | hooks, config, refs and objects of the operator's checkout in an untrusted agent's hands; the hub's host git on agent-written config (§7.4.1) |
| Bind the hub on the Docker bridge for `fl-report` | a network listener on the process that binds firmly to loopback; the unix socket needs no network at all and brings the per-run token (§7.6) |
| A hub-written MITM proxy with credential injection | iron-proxy already is that code, with a CA, audit and hot reload; the builtin CONNECT proxy is the right size for what the hub should own (§7.5.2) |
| `userns-remap` | bind-mounted worktrees show up as `nobody`; Docker has no per-container id mapping (§7.7) |
| Docker socket in the sandbox for repos that need Docker | root on the host; Sysbox is the answer for that repo class (§8.13) |
| Policy in OPA/Rego | no agent-sandbox vendor uses it; JSON with a lock list and a narrowing rule is what Claude, Cursor and Docker ship, and what the flow designer can render (§5.3) |

---

## 10. Implementation plan

Sized against modules that exist: `integrate.mjs` is ~1,600 lines, `runner.mjs`
~550, `fl-start` ~850. Each phase is shippable on its own and off by default.

**Phase 0 — seams that are right regardless of the sandbox** (small, low risk):
`agentHome(run)` indirection in the four activity readers, `resumeCommand()` and
the id lookups `resumeRun()` makes (cursor's transcript basename, opencode's root
session); `runGit(run, args)` in `integrate.mjs`/`watcher.mjs`/`runner.mjs`; `collectRunTip(run)`
before the finish gate (a no-op today); the unix-socket report listener with a
per-run `report_token` and `fl-report`'s `FL_HUB_SOCKET`; `scanSystem()` records
Docker. Tests for each.

**Phase 1 — the sandbox, minimum viable** (the bulk): `server/sandbox/` (spec
resolution and layering, clone layout, profile store, docker wrapper argv,
builtin CONNECT proxy, container reconciliation, events), `sandbox/wrap.sh` +
`fl-start --sandbox`, `sandbox/images/` for the four built-ins, the DB columns, the
run-definition checklist, the repo form block, Settings → Sandbox with discovery
and the four built-in profiles, kill/reconcile/retention, sessions page badge and
`docker stats`, the e2e `docker` shim and the unit tests, `docs/plugins.md` (the
`sandbox` declaration), `SETUP_WITH_AGENT.md` and the three READMEs (install
Docker, rootless recommendation, Ubuntu 24.04 profile), `AGENTS.md` (this design's
rules, condensed). Secrets `env` mode only; `network.mode` open/none/allowlist via
the builtin engine.

**Phase 2 — the blocked-need flow**: proxy denials → events/incidents → the three
buttons and live reload; `docker update` for limits; the `access` report kind and
the prompt's Sandbox section; the log-scanner family; the dry run; audit-only mode
with Adopt; reconfigure-and-resume through `resumeRun()` (the sandbox start order
made idempotent, the direct caller with its own reason and continuation text);
`merge_check_sandboxed`.

**Phase 3 — enterprise hardening**: iron-proxy engine with TLS termination and
credential injection (`secrets.mode: inject`, plugin `injection` declarations,
per-hub CA), `sandbox_lock` narrowing with refusal events, break-glass
`sandbox_allow_bypass`, hash-chained audit export, OTEL forwarding, `methods`
restriction, `maxRuntimeMinutes`.

**Phase 4 — runtimes and images**: `runtime: runsc`, Podman, Sysbox for
Docker-in-Docker repos, the `srt` light runtime, operator/devcontainer image
composition, per-run named volumes for `rw` extras.

---

## 11. Open questions to measure before building (in the order they block)

1. **Claude as container root under rootless Docker**: does `bypassPermissions`
   accept root "inside a recognized sandbox", and what makes a sandbox recognised?
   Decides whether rootless Docker can be the recommended daemon for claude runs
   (§7.7). Fallback: rootful daemon with `--user`.
2. **OAuth token copies**: does a second `.credentials.json` refreshing its token
   invalidate the host session's refresh token? Decides whether
   `CLAUDE_CODE_OAUTH_TOKEN` is required for sandboxed claude runs or merely
   recommended (§7.8).
3. **A resume before the Docker daemon answers**: after a reboot the first
   watcher pass runs at once (recovery design, change 5), and a rootless
   `docker.service` user unit may still be starting. Confirm that `resumeRun()`
   leaves such a run `resume_pending` for the next pass instead of `failRun()`,
   and whether `freilauf.service` should be ordered after the daemon's unit on a
   rootless installation (§7.11). (The former question here — does `pipe-pane`
   survive `respawn-pane` — is gone with the respawn: `fl-start` arms the pipe on
   every session it creates, a resume included.)
4. **The resume form from a seeded home** — `claude --resume <run id>` with the
   transcript under `<run home>/.claude/projects/<slug>/`, `opencode -s <root
   session id>` with the per-run `opencode.db`, `cursor-agent --resume <chatId>`:
   does each CLI find its conversation when the home differs from the original
   host layout? The recovery design measures the forms on the host; this is the
   same question one bind mount further in.
5. **`--settings` vs project `.claude/settings.json`** precedence for hooks (§8.21).
6. **iron-proxy under load and with SSE**: Anthropic's streaming responses, cursor's
   HTTP/2 endpoints (`repo42.cursor.sh` is HTTP/2 only — does a CONNECT tunnel
   carry it? yes for a tunnel; for TLS termination iron-proxy must speak h2 to the
   client — verify), the management API on an internal network.
7. **`git fetch <clone>` from a hostile clone**: confirm that `git-upload-pack`
   honours nothing executable from the clone's `.git/config` in git 2.43, or do the
   bundle variant (§7.4.3).
8. **cursor-agent's transcript path** inside the seeded home (`~/.cursor/projects/<slug>/…`)
   — the slug rule (`cursor-transcript.mjs:35`) is derived from the workdir, which
   is identical; confirm cursor does not also hash the home.
9. **Docker ≥ 28 `gateway_mode_ipv4=isolated`** availability on the target
   installations; without it the host bridge address is reachable from the
   container (the hub does not listen there, but other host services might).
10. **Resource-limit delegation** on the operator's systemd user session for
    rootless Docker (`cgroup.controllers` shows `memory pids` only by default).

---

## 12. Sources

Primary documentation and repositories consulted (all fetched 2026-09-02):

- Claude Code: https://code.claude.com/docs/en/sandboxing ·
  https://code.claude.com/docs/en/settings-reference ·
  https://code.claude.com/docs/en/sandbox-environments ·
  https://code.claude.com/docs/en/permission-modes ·
  https://code.claude.com/docs/en/devcontainer ·
  https://code.claude.com/docs/en/network-config ·
  https://code.claude.com/docs/en/managed-settings ·
  https://code.claude.com/docs/en/monitoring-usage ·
  https://code.claude.com/docs/en/cloud-environments ·
  https://github.com/anthropics/claude-code/blob/main/.devcontainer/init-firewall.sh ·
  https://github.com/anthropics/sandbox-runtime (README, `sandbox-manager.ts`,
  `request-filter.ts`, `linux-violation-monitor.ts`, issue #74) ·
  https://www.anthropic.com/engineering/claude-code-sandboxing ·
  https://claude.com/blog/ciso-guide-to-agentic-ai
- OpenAI Codex: https://learn.chatgpt.com/docs/sandboxing ·
  https://learn.chatgpt.com/docs/config-file/config-reference ·
  https://learn.chatgpt.com/docs/config-file/config-basic ·
  https://learn.chatgpt.com/docs/enterprise/managed-configuration ·
  https://learn.chatgpt.com/docs/agent-approvals-security ·
  https://learn.chatgpt.com/docs/permissions ·
  https://learn.chatgpt.com/docs/cloud/internet-access ·
  https://github.com/openai/codex/blob/main/codex-rs/linux-sandbox/README.md ·
  https://github.com/openai/codex/blob/main/codex-cli/scripts/run_in_container.sh ·
  https://github.com/openai/codex/issues/27418
- Cursor: https://cursor.com/docs/agent/security/run-modes ·
  https://cursor.com/docs/reference/sandbox · https://cursor.com/blog/agent-sandboxing ·
  https://cursor.com/docs/cli/reference/parameters ·
  https://cursor.com/docs/cli/reference/configuration ·
  https://cursor.com/docs/enterprise/network-configuration ·
  https://cursor.com/docs/cloud-agent/security-network · https://cursor.com/docs/hooks
- OpenCode: https://opencode.ai/docs/permissions/ · https://opencode.ai/docs/cli/ ·
  https://opencode.ai/docs/config/ · https://opencode.ai/docs/server/ ·
  https://opencode.ai/docs/providers/ · https://docs.docker.com/ai/sandboxes/agents/opencode/
- Hermes Agent: https://hermes-agent.nousresearch.com/docs/user-guide/features/tools ·
  https://hermes-agent.nousresearch.com/docs/user-guide/security/ ·
  https://hermes-agent.nousresearch.com/docs/user-guide/egress/iron-proxy ·
  https://hermes-agent.nousresearch.com/docs/user-guide/configuration ·
  local source `tools/environments/docker.py`, `tools/terminal_tool.py`
- iron-proxy: https://github.com/ironsh/iron-proxy · https://github.com/paradigmxyz/iron-proxy
- Docker: https://docs.docker.com/reference/cli/docker/container/run/ ·
  https://docs.docker.com/reference/cli/docker/container/attach/ ·
  https://docs.docker.com/reference/cli/docker/container/exec/ ·
  https://docs.docker.com/reference/cli/docker/container/stop/ ·
  https://docs.docker.com/engine/security/seccomp/ ·
  https://docs.docker.com/engine/security/apparmor/ ·
  https://docs.docker.com/engine/security/userns-remap/ ·
  https://docs.docker.com/engine/security/rootless/ (and `troubleshoot.md`,
  `tips.md`, `uid-gid-mapping.md` in `docker/docs`) ·
  https://docs.docker.com/engine/containers/resource_constraints/ ·
  https://docs.docker.com/engine/network/drivers/none/ ·
  https://docs.docker.com/reference/cli/docker/network/create/ ·
  https://docs.docker.com/engine/network/port-publishing/ ·
  https://docs.docker.com/engine/release-notes/28/ ·
  https://github.com/moby/profiles (seccomp `default.json`, AppArmor `template.go`) ·
  https://github.com/moby/moby/issues/42441 · https://github.com/moby/moby/issues/48130 ·
  https://github.com/moby/moby/pull/52061 · https://github.com/docker/roadmap/issues/398 ·
  https://github.com/docker/cli/pull/1841 · https://github.com/docker/cli/issues/5489 ·
  https://github.com/moby/moby/issues/9098 · https://github.com/moby/moby/issues/35703 ·
  https://github.com/moby/moby/issues/28872 · https://github.com/moby/moby/pull/20848 ·
  https://github.com/moby/moby/pull/43593 · https://github.com/docker/cli/issues/3554 ·
  https://raw.githubusercontent.com/docker/cli/master/cli/command/container/{run,attach,start,exec,tty,signals}.go ·
  https://raw.githubusercontent.com/moby/term/master/proxy.go
- Docker Sandboxes: https://docs.docker.com/ai/sandboxes/install/ ·
  https://docs.docker.com/ai/sandboxes/architecture/ ·
  https://docs.docker.com/ai/sandboxes/usage/ ·
  https://docs.docker.com/ai/sandboxes/workflows/git/ ·
  https://docs.docker.com/ai/sandboxes/security ·
  https://docs.docker.com/ai/sandboxes/security/policy/ ·
  https://docs.docker.com/ai/sandboxes/governance ·
  https://docs.docker.com/ai/sandboxes/agents/ ·
  https://www.docker.com/blog/why-microvms-the-architecture-behind-docker-sandboxes/
- gVisor: https://gvisor.dev/docs/user_guide/install/ ·
  https://gvisor.dev/docs/user_guide/compatibility/ ·
  https://gvisor.dev/docs/user_guide/compatibility/linux/amd64/ ·
  https://gvisor.dev/docs/user_guide/filesystem/ · https://gvisor.dev/docs/user_guide/faq/ ·
  https://gvisor.dev/docs/architecture_guide/performance/ ·
  https://github.com/google/gvisor/issues/8089
- Kata, Sysbox, Podman, bubblewrap, Landlock, nsjail, firejail, Boundary,
  Greywall, ai-jail, nono, microsandbox, BoxLite, agent-sandbox:
  https://github.com/kata-containers/kata-containers (docs/Limitations.md,
  docs/design/inotify.md) · https://github.com/nestybox/sysbox (limitations.md,
  distro-compat.md) · https://docs.podman.io/en/latest/markdown/podman-run.1.html ·
  https://github.com/containers/podman/blob/main/docs/tutorials/rootless_tutorial.md ·
  https://github.com/containers/bubblewrap · https://man.archlinux.org/man/bwrap.1 ·
  https://docs.kernel.org/userspace-api/landlock.html · https://github.com/Zouuup/landrun ·
  https://github.com/google/nsjail · https://github.com/netblue30/firejail ·
  https://github.com/coder/boundary · https://github.com/greyhavenhq/greywall ·
  https://github.com/akitaonrails/ai-jail · https://github.com/always-further/nono ·
  https://github.com/zerocore-ai/microsandbox · https://github.com/boxlite-ai/boxlite ·
  https://github.com/kubernetes-sigs/agent-sandbox · https://github.com/daytonaio/daytona
- git: https://git-scm.com/docs/git-worktree · https://git-scm.com/docs/gitrepository-layout ·
  https://git-scm.com/docs/git-clone · https://git-scm.com/docs/git#_environment_variables ·
  https://raw.githubusercontent.com/git/git/master/Documentation/config/safe.adoc ·
  https://github.com/devcontainers/cli/pull/1127 · https://github.com/devcontainers/cli/issues/1243 ·
  https://github.com/nektos/act/issues/6074 · https://www.gitworktree.org/guides/devcontainer ·
  https://github.com/anthropics/claude-code/issues/80278
- Ubuntu 24.04 user namespaces: https://documentation.ubuntu.com/release-notes/24.04/ ·
  https://bugs.launchpad.net/ubuntu/+source/apparmor/+bug/2046477 ·
  https://discourse.ubuntu.com/t/spec-unprivileged-user-namespace-restrictions-via-apparmor-in-ubuntu-23-10/37626 ·
  https://github.com/anthropic-experimental/sandbox-runtime/issues/74 ·
  https://github.com/anthropics/claude-code/issues/55585
- Enterprise and analysts: https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/ ·
  https://martinfowler.com/articles/agentic-ai-security.html ·
  https://martinfowler.com/articles/pushing-ai-autonomy.html ·
  https://northflank.com/blog/how-to-sandbox-ai-agents ·
  https://www.computerweekly.com/news/366649589/Gartner-Deploy-sandboxes-to-rein-in-AI-agents ·
  https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/customize-the-agent-firewall ·
  https://docs.github.com/en/copilot/reference/copilot-allowlist-reference ·
  https://docs.github.com/en/copilot/concepts/agents/cloud-agent/risks-and-mitigations ·
  https://docs.devin.ai/cli/sandbox · https://www.daytona.io/docs/en/network-limits/ ·
  https://docs.e2b.dev/sandbox/internet-access · https://docs.e2b.dev/sandbox/workload-identity.md ·
  https://modal.com/docs/guide/sandbox-networking · https://vercel.com/docs/sandbox/concepts/firewall ·
  https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes ·
  https://pluto.security/blog/inside-claude-managed-agents/ ·
  https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/sandbox.md ·
  https://playwright.dev/docs/docker · https://docs.npmjs.com/cli/v9/using-npm/scripts ·
  https://nodejs.org/api/process.html#signal-events ·
  https://man7.org/linux/man-pages/man7/pid_namespaces.7.html ·
  https://github.com/krallin/tini/blob/master/README.md
