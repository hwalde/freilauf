# The sandbox images

One base image, one layer per built-in coding agent, and one overlay that puts
an agent layer on top of a toolchain image somebody else owns. They are what a
sandboxed run runs inside (SANDBOX_RESEARCH.md §7.10).

> **These images have never been built.** The machine this was written on has
> no container runtime at all, which is also why the code around them was
> written to be checkable by reading. Every install command below was derived
> from a *measured* source — the vendor's own installer read on 2026-09-05, or
> the CLI installed on this machine — and the places where that was not enough
> say so, in the Dockerfile and again under [What is not verified](#what-is-not-verified).
> The first operator to run `docker build` is doing the verification, so this
> file names exactly what to run and what to look at.

## Building them

The base first; everything else is `FROM` it.

```bash
cd <the Freilauf checkout>

docker build -f sandbox/images/base.Dockerfile \
  --build-arg UID="$(id -u)" --build-arg GID="$(id -g)" \
  -t freilauf/agent-base:24.04 sandbox/images

docker build -f sandbox/images/claude.Dockerfile \
  --build-arg CLAUDE_VERSION=2.1.261 \
  -t freilauf/agent-claude:2.1.261 sandbox/images

docker build -f sandbox/images/opencode.Dockerfile \
  --build-arg OPENCODE_VERSION=1.18.29 \
  -t freilauf/agent-opencode:1.18.29 sandbox/images

docker build -f sandbox/images/cursor.Dockerfile \
  --build-arg CURSOR_VERSION=2026.09.02-c22c1a3 \
  -t freilauf/agent-cursor:2026.09.02-c22c1a3 sandbox/images

docker build -f sandbox/images/hermes.Dockerfile \
  --build-arg HERMES_COMMIT=f58fcc81 \
  -t freilauf/agent-hermes:f58fcc81 sandbox/images
```

The versions above are the ones installed on the machine this was written for.
The authority for what a hub actually builds is the harness plugin's
`sandbox.image.args` (`server/harnesses/<id>.mjs`), not this file — a version
written down twice is a version that will disagree with itself.

### Verifying a build

```bash
# 1. the CLI is there, at the version that was asked for
docker run --rm freilauf/agent-claude:2.1.261 claude --version

# 2. it is NOT root, and the uid is the hub's
docker run --rm freilauf/agent-claude:2.1.261 id
#    -> uid=1000(agent) gid=1000(agent)

# 3. a bind mount owned by the hub user is writable from inside
docker run --rm -v "$PWD:$PWD" -w "$PWD" freilauf/agent-claude:2.1.261 \
  bash -c 'touch .fl-probe && rm .fl-probe && echo writable'

# 4. the digest, which is what a run records in its `started` event
docker image inspect --format '{{index .RepoDigests 0}}' freilauf/agent-claude:2.1.261
```

### Seeing the command line without building anything

The whole runtime command line is built by one pure function
(`buildRunArgv()` in `server/sandbox/runtime.mjs`) and printed by
`sandbox/wrap.sh`, so a policy can be inspected on a machine with no Docker:

```bash
sandbox/wrap.sh --print ~/agents/runs/<run id>/sandbox.json -- bash
fl-start --sandbox ~/agents/runs/<run id>/sandbox.json --dry-run …
```

## The composition rule: who owns which layer

A Java repository needs a JDK and a Rust repository a toolchain, and keeping a
matrix of language images here would go stale the first time a team upgrades
its compiler. So **the operator owns the toolchain image and Freilauf owns the
agent layer**: `repos.sandbox_image` names the operator's image, and
`overlay.Dockerfile` copies the coding agent onto it.

```bash
docker build -f sandbox/images/overlay.Dockerfile \
  --build-arg BASE=registry.example.com/team/java21-build:2026-08 \
  --build-arg AGENT_IMAGE=freilauf/agent-claude:2.1.261 \
  --build-arg UID="$(id -u)" --build-arg GID="$(id -g)" \
  -t freilauf/agent-claude-myrepo:2.1.261 sandbox/images
```

The overlay **copies** the CLI out of the harness image rather than installing
it again: a second install would need the operator's base to have the vendor's
prerequisites and a network, and it would produce a different build of the same
"version". It refuses a base image that lacks `bash`, `git`, `curl`, a CA
bundle or `useradd`, and names the missing packages — Freilauf does not install
packages into somebody else's base.

## The uid question

`ARG UID` / `ARG GID` default to 1000 and should be built with **the hub user's**
ids. The reason is not tidiness (§7.7):

- the container user is **not root**, because root in the container is root on
  every bind mount, and an escape from a runc container lands wherever the
  process already was;
- its uid is **the hub's**, because the worktree, the run directory and the
  seeded home are bind mounts owned by the hub user. A different uid sees them
  as somebody else's files and cannot write a single commit.

With rootless Docker or `podman --userns=keep-id` the container's uid maps back
to the hub's uid on the host, which is the same statement from the other side.
`ubuntu:24.04` already ships a uid-1000 user called `ubuntu`; the base renames
it rather than deleting it.

## Playwright, Chromium and `--shm-size 1g`

A repository whose tests drive a browser needs two things the defaults do not
give it (§8.14):

- **`--shm-size 1g`.** Docker's default `/dev/shm` is **64 MB**. Chromium keeps
  renderer shared memory there and crashes — usually as a tab that dies with no
  message, which reads as a flaky test rather than as a misconfigured container.
  The sandbox profile carries it as `resources.shmSize`, defaulting to `1g`.
- **`chromiumSandbox: false`** in the Playwright config (which is already
  Playwright's own default for `chromium.launch()` under Docker). Chromium's
  own sandbox needs user namespaces the container does not hand it, and the
  container IS the sandbox here — nesting a second one buys nothing and fails
  in a way that looks like a browser bug.

`--init` (which the runtime always passes) is the third: a browser leaves
zombie processes, and PID 1 in a container reaps nothing unless it is an init.

None of this is installed here. A repository that needs a browser names its own
toolchain image and uses the overlay — Playwright's own
`mcr.microsoft.com/playwright` images are the obvious base.

## What is not verified

Everything below was read out of a real installer or a real installed CLI on
2026-09-05, and none of it was executed inside a container.

| Layer | How the CLI is installed | Confidence |
|---|---|---|
| claude | `curl -fsSL https://claude.ai/install.sh \| bash -s <version>` | **High.** The script's own argument validation accepts `stable`, `latest` or `X.Y.Z`; it installs under `$HOME/.local`, refuses `sudo` from a user shell but runs as plain root. Read from the live script. |
| opencode | `npm install -g opencode-ai@<version>` | **High.** The package name is the one the harness plugin's installHint gives, and the version installed on this machine matches `opencode-ai@1.18.29` exactly. The platform binary is an optional dependency, so an unpublished architecture fails at build time. |
| cursor | `curl` of `https://downloads.cursor.com/lab/<version>/linux/<arch>/agent-cli-package.tar.gz`, `tar --strip-components=1` | **Medium.** Read verbatim out of `https://cursor.com/install`, which is generated per request with the current version baked in and takes no version argument at all — hence the direct URL. That URL is undocumented and is Cursor's to change. If it 404s: run the installer once by hand and read the `DOWNLOAD_URL` it prints. |
| hermes | `curl -fsSL https://hermes-agent.nousresearch.com/install.sh \| bash -s -- --skip-setup --commit <sha>` | **Low — the one to build first.** hermes is a git checkout plus a uv-managed Python 3.11, not a released binary, so the pin is a commit sha (what `hermes --version` calls "upstream"). `--skip-setup`, `--commit` and `--branch` are the installer's own documented flags, read from the script. Three things could not be checked without a build: where the wrapper lands when the installer runs as root, whether anything still wants a TTY despite `--skip-setup`, and whether it insists on installing its own Node next to the base image's. |

The auto-updater switches are in the same shape:

| Variable | Where it comes from |
|---|---|
| `DISABLE_AUTOUPDATER`, `DISABLE_TELEMETRY`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | Claude Code's documented switches; the same three the harness plugin declares. |
| `OPENCODE_DISABLE_AUTOUPDATE` | present in the shipped opencode binary's own strings. Its effect was not measured. |
| `HERMES_SKIP_UPDATE_CHECK` | hermes' own repository sets it in its benchmark harness. hermes documents no "disable the updater" switch, so this is the closest thing there is. |
| `IS_SANDBOX` | **not set in any image, on purpose.** It is what makes claude treat the environment as a recognized sandbox (measured: exactly `IS_SANDBOX=1` or `CLAUDE_CODE_BUBBLEWRAP`, with no Docker detection anywhere), and it is a statement about the RUN — so it belongs in the claude plugin's `sandbox.env`, not in an image that somebody may also start by hand for something else. |

A CLI that updates itself inside a read-only container fails in a way that
looks like a network fault, which is why these are worth getting right even
though none of them is load-bearing for a first build.

## The first paint is 80×24 on an old engine

The initial terminal size is set at container creation (`ConsoleSize`, Docker
Engine ≥ 23.0 / API 1.42). On an older engine the container starts at 80×24 and
resizes on the first `SIGWINCH`, so a TUI's very first paint can be wrong until
something redraws (§8.17). `TERM`, `LANG`/`LC_ALL` and `COLORTERM` come from the
tmux pane at run time and are deliberately not baked into any image — a value
compiled in would be a claim about somebody else's terminal.
