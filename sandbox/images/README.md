# The sandbox images

One base image, one layer per built-in coding agent, and one overlay that puts
an agent layer on top of a toolchain image somebody else owns. They are what a
sandboxed run runs inside (SANDBOX_RESEARCH.md §7.10).

> **All five were built for the first time on 2026-09-05**, against rootless
> Docker 29.8.0 on ubuntu 24.04/amd64, and the results — including the two
> installers that turned out to be wrong — are in
> [What the build measured](#what-the-build-measured). Everything a run really
> does was exercised against a real git worktree owned by the operator: status,
> log, fetch, add, commit, push, and a file written inside landing on the host
> owned by the operator. Nothing here is a claim about arm64, about podman or
> about a rootful daemon; those lines in the tables say so.

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
  --build-arg HERMES_VERSION=0.21.0 \
  -t freilauf/agent-hermes:0.21.0 sandbox/images
```

The build arg is `CLAUDE_VERSION`, `OPENCODE_VERSION`, `HERMES_VERSION` or
`CURSOR_VERSION` — the names the harness plugins' `sandbox.image.args` use, so
the hub can build these files without a translation table. The defaults in the
Dockerfiles are the versions those plugins pin, which are the ones measured on
this machine; **the plugin is the authority**, and the two are kept equal so
that an image and its declaration cannot say different things.

`HERMES_VERSION` is the odd one, and the first build proved why: **`0.21.0` is
not a git ref at all** — passing it as the branch failed with `Remote branch
0.21.0 not found in upstream origin`. hermes is a git checkout, not a release,
its tags are dated (`v2026.8.31`), and the running install sits thousands of
commits past the nearest one. So `HERMES_VERSION` names the image and is
*checked* against what the installed CLI reports, `HERMES_BRANCH` is `main`, and
`HERMES_COMMIT` — the sha `hermes --version` calls "upstream" — is the pin.
Moving the version means moving both, and the build fails if they disagree.

### Verifying a build

```bash
# 1. the CLI is there, at the version that was asked for
docker run --rm freilauf/agent-claude:2.1.261 claude --version
#    -> 2.1.261 (Claude Code)

# 2. WHO it runs as depends on the daemon, and the image must not decide it
docker run --rm freilauf/agent-claude:2.1.261 id -u
#    rootless daemon (no --user): -> 0, and 0 inside IS the hub user outside
#    rootful daemon: the hub passes --user <uid>:<gid> and this answers that uid

# 3. the whole working set, against a real worktree, which is the test that
#    matters — a writable bind mount is not the same as a usable git repository
docker run --rm -v "$PWD:$PWD" -w "$PWD" freilauf/agent-claude:2.1.261 bash -c '
  git status --porcelain >/dev/null && git log --oneline -1 >/dev/null && echo ok'
#    a `detected dubious ownership` here means the uid rule is being fought;
#    see "The uid question" below, and do NOT reach for safe.directory

# 4. no image of this family may carry one of the six redirecting variables
docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
  freilauf/agent-claude:2.1.261 |
  grep -E '^(XDG_(DATA|CONFIG|STATE)_HOME|CLAUDE_CONFIG_DIR|CURSOR_DATA_DIR|HERMES_HOME)='
#    -> no output. All five ship clean [measured]

# 5. the digest, which is what a run records in its `started` event
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

## The one variable family no image may set

**Never set `XDG_DATA_HOME`, `XDG_CONFIG_HOME` or `XDG_STATE_HOME` — nor
`CLAUDE_CONFIG_DIR`, `CURSOR_DATA_DIR` or `HERMES_HOME` — in any image a run
uses.** Not in the base, not in a harness layer, and not in the toolchain image
an overlay is built on.

A sandboxed run keeps all of its state in the per-run home the hub mounts at
`$HOME`: the seeded `auth.json`, the `plugins/freilauf.js` that reports
attention and API errors, claude's transcript, cursor's transcript, opencode's
session store. The hub seeds that directory before the start and reads it back
while the run goes — activity, tokens, the end of a turn.

It was **measured** (SANDBOX_RESEARCH.md §11a.4) that **XDG outranks `HOME` for
opencode**. So an image carrying one of these variables sends the CLI's state
somewhere else, and every consequence is silent: the seeded credentials are
never read, the reporting plugin never loads, and the hub's activity
measurement looks into an empty directory and concludes the agent is idle.
Nothing errors — the run simply stops reporting, which is the most expensive
shape a fault takes here, because every layer above it still reads as healthy.

Docker cannot unset an inherited `ENV` (`ENV VAR=` sets it *empty*, which for
several of these means something else again), so `overlay.Dockerfile`
**fails the build** and names the offending variable and its value. A toolchain
image that genuinely needs one of them can set it per command inside its own
`RUN` steps instead of as an image-wide `ENV`.

**The refusal was tested rather than assumed** (2026-09-05): a pretend toolchain
image carrying `ENV XDG_DATA_HOME=/opt/teamstate/share` fails the overlay build
at that step, and the message the operator reads is

```
This base image redirects a coding agent away from its HOME:
  XDG_DATA_HOME=/opt/teamstate/share
```

— the variable *and* its value, which is what makes it actionable; the same
build against a base without it succeeds. The sibling check was exercised too:
an alpine base is refused by name for `bash git curl ca-certificates`. And all
five shipped images were inspected for the six variables and carry **none** of
them (`docker image inspect` step 4 above).

Where a build needs a private HOME — the claude and hermes layers both install
with `HOME=/opt/<name>` — it is a shell assignment in front of that one
command, never an `ENV`.

`PLAYWRIGHT_BROWSERS_PATH` in the hermes layer is deliberately **not** a member
of this family and is deliberately an image-wide `ENV`: it names a read-only
program directory inside the image, not a place a coding agent keeps state.
See [What the build measured](#what-the-build-measured).

## The uid question, and the one rule these images keep

**No image in this family pins a `USER`. The caller decides, because only the
caller knows which daemon it is talking to.**

That is not a style choice; it is what the first real build had to fix. The
images were written ending in `USER agent` (uid 1000), and under a *rootless*
daemon that is precisely wrong — measured, against a real worktree owned by the
operator:

| what runs | uid inside | who owns the file it writes on the host |
|---|---|---|
| rootless, **no `--user`** (what the hub emits there) | `0(root)` | **the hub user** ✅ |
| rootless, `--user 1000:1000` (the *rootful* branch, mispaired) | `1000` | subordinate uid 100999, `UNKNOWN` ❌ |
| the image as first written (`USER agent`), no `--user` | `1000(agent)` | subordinate uid 100999, `UNKNOWN` ❌ |

The third row is the trap, and it is worth naming exactly: **`--user` is
*absent* under rootless, so `USER` in the Dockerfile is what wins by default.**
An image that pins one silently defeats the runtime's own decision. What it
looked like from inside was not subtle —

```
$ docker run --rm -v <wt>:<wt> -w <wt> freilauf/agent-base:24.04 \
    bash -c 'touch probe.txt; git status'
touch: cannot touch 'probe.txt': Permission denied
fatal: detected dubious ownership in repository at '<wt>'
```

— every sandboxed run would have died at its first write.

The rule the runtime states (`buildRunArgv()`, §7.7) and the images now obey:

- **rootful daemon** — the container's uid *is* the host's uid, so a run must
  be the hub's uid and **not root**: root in the container is root on every
  bind mount, and an escape from runc lands wherever the process already was.
  `buildRunArgv()` passes `--user <hub uid>:<hub gid>`.
- **rootless daemon** — the container's uid 0 *is* the hub user on the host
  (the `/etc/subuid` mapping), and container uid 1000 is a subordinate uid that
  owns nothing. So a run must be **container root**, and `buildRunArgv()`
  deliberately passes no `--user` at all.
- **podman rootless** — `--userns=keep-id`, which is the same statement in
  podman's own words. Not measured here; there is no podman on the build
  machine.

**The `git` half answers itself.** Under the correct pairing the uid inside and
the owner outside are the same number, so `detected dubious ownership` never
arises — verified rather than assumed, and the reason `safe.directory` is *not*
in any of these images: it would silence the message while the writes still
landed under a subordinate uid, which is the failure, not the warning.

There is **no third way**, and both alternatives were considered and rejected on
facts rather than taste:

- *an entrypoint that adapts* cannot — a container's uid is fixed at creation,
  and the runtime hardening (`--cap-drop ALL`, `--security-opt
  no-new-privileges`) removes every means of changing it from inside;
- *two tagged variants* cannot — `taggedImage()` names an image from the harness
  and its version and knows nothing of the daemon type.

`ARG UID` / `ARG GID` remain, and should still be built with the hub user's ids:
they create the `agent` account that `--user <uid>:<gid>` lands on under a
rootful daemon, so that the shell inside has a real passwd entry, a real `$HOME`
and a `whoami` that answers. `ubuntu:24.04` already ships a uid-1000 user called
`ubuntu`; the base renames it rather than deleting it. What changed is only that
the account is no longer made the *default*.

One consequence to be aware of when running an image **by hand on a rootful
daemon**: with no `--user` you are root on every bind mount. That is the hub's
job to pass, and it does; a human doing a `docker run` for a look around should
pass it too.

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

## What the build measured

Rootless Docker 29.8.0, ubuntu 24.04, amd64, 2026-09-05. Times are the layer on
top of the base for the four harness images (the base's own ~90 s comes on top
of each from cold); sizes are what `docker images` reports for the finished
image, so the base's 942 MB is included in every one of them.

| Image | Builds | Time | Size | CLI answers | Installer corrected? |
|---|---|---|---|---|---|
| base | ✅ | ~90 s cold | 942 MB | `node --version` → v22.22.1 | the `USER` pin — see above |
| claude | ✅ | ~50 s | 1.26 GB | `claude --version` → `2.1.261 (Claude Code)` | no |
| opencode | ✅ | ~30 s | 1.44 GB | `opencode --version` → `1.18.29` | **yes — the npm prefix** |
| cursor | ✅ | ~36 s | 1.68 GB | `cursor-agent --version` → `2026.09.02-c22c1a3` | no |
| hermes | ✅ | ~5 min | 5.33 GB | `hermes --version` → `Hermes Agent v0.21.0 (2026.8.31)` | **yes — the version is not a git ref** |
| overlay | ✅ | seconds | base + agent | the copied CLI answers on the overlay's PATH | see the opencode entry — the overlay is what exposed it |

Not measured, and therefore not claimed: **arm64** (only amd64 was built),
**podman**, and a **rootful daemon** (the machine runs rootless; the rootful
column of the uid table is the runtime's documented branch, exercised only in
its mispaired form).

### The two installers that were wrong

**opencode — `npm install -g` does not install into `/usr/local`.** NodeSource's
node lives in `/usr`, so `npm prefix -g` answers `/usr`, and a plain global
install put the launcher in `/usr/bin` and the package in
`/usr/lib/node_modules`. The image itself worked. The *overlay* did not:
`COPY --from=agent /opt /opt` and `/usr/local /usr/local` are the only two
directories it takes, so an overlay came out with **no `opencode` on its PATH at
all** — `exec: "opencode": executable file not found`. The fix is
`npm install -g --prefix /usr/local`, not a wider copy: `/usr/bin` belongs to
the operator's toolchain image and merging over it would overwrite their
binaries by name. (`opencode.exe` is a native ELF, so nothing in the copied tree
needs node to exist in the operator's base either.)

**hermes — `0.21.0` is not a git ref.** Passing the version as the branch failed
with `Remote branch 0.21.0 not found in upstream origin`. The pin is
`--branch main --commit <sha>`, and `HERMES_VERSION` is now checked against what
the installed CLI reports so the tag and the contents cannot drift apart.

### hermes: four guesses, and what the build actually found

The Dockerfile carried four open questions. All four are answered, and the first
one was wrong in a way worth keeping written down:

1. **The root layout is the installer's own, and it is exactly the split we
   wanted.** As root on Linux it puts the code at `/usr/local/lib/hermes-agent`,
   its uv-managed Python 3.11 under `/usr/local/share/uv`, and writes `hermes`,
   `hermes-agent` and `hermes-acp` straight into `/usr/local/bin`. Nothing needs
   symlinking afterwards, and everything sits in `/usr/local`, which is what the
   overlay copies. The guess here — `$HOME/.local/bin` plus a symlink — is the
   *non-root* layout.
2. **No TTY is wanted** with `--skip-setup`; the build ran through unattended.
3. **It does not fetch Node**: the base image's Node 22 satisfies it.
4. **`$HERMES_HOME` holds only data, never code.** With `HOME` pinned to
   `/opt/hermes` for the install command, the installer wrote `config.yaml`,
   `.env` and its data directories there and put no code in them. At run time
   `$HOME` is the per-run home, so hermes reads its state from
   `<run home>/.hermes` — which is what the plugin seeds — while the launchers
   hardcode absolute `/usr/local` paths for the interpreter and entrypoint, so
   the code is found whatever `HOME` is. `ENV HERMES_HOME` therefore stays
   unset, as it always had to.

And one thing nobody had asked: **the installer fetches a Playwright Chromium
with its apt dependencies.** That is most of hermes' size and most of its ten
minutes, and Playwright's default location is `$HOME/.cache/ms-playwright` —
a *build-time* home, which no run can ever reach, so hermes' browser tool would
have failed as if it had never been installed. The image therefore sets
`PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright` for both the install and the run.
That variable is **not** a member of the forbidden family below and does not
contradict it: those six redirect a coding agent's *state* away from the per-run
home, while this one names a read-only *program* directory — the same thing
Playwright's own images do with `/ms-playwright`. `--skip-browser` is the
installer's own way out for an operator who does not want a browser in the
sandbox.

The build-time caches are deleted in the same `RUN` (a later layer cannot shrink
an earlier one): 1.1 GB under the build-time `$HOME/.cache`, 157 MB of npm cache
and 49 MB of a tool download, none of which a run reads.

**hermes is by far the largest image at 5.33 GB**, and the reasons are worth
knowing before anyone treats that as a defect: 658 MB of Chromium and ffmpeg,
the X11/font/GTK apt dependencies `playwright install --with-deps` pulls in, a
403 MB `node_modules` and a 651 MB `.git` inside the checkout, plus a 250 MB
virtualenv and a uv-managed Python. `--skip-browser` is the one lever that
changes the order of magnitude.

### The working set a run really uses

A writable bind mount is not the same thing as a usable repository, so the test
was the whole set an agent performs, inside the image, with the mounts and the
hardening `buildRunArgv()` emits — `-v <fixture>:<fixture> -w <worktree> -e
HOME=<per-run home> --cap-drop ALL --security-opt no-new-privileges --init`,
against a git worktree of a real checkout with a bare `origin` beside it, all
owned by the operator:

| | result |
|---|---|
| `git status`, `git log` | OK — and **no `dubious ownership`**, because the uids match |
| `git fetch origin` | OK |
| `git add` + `git commit` | OK, and the commit is visible from the host afterwards |
| `git push origin <branch>` | OK |
| a file written by `bash`, by `node` and by `python3` | all three land on the host owned by **the operator**, not by a subordinate uid |
| the per-run `$HOME` | writable; `git config --global` lands in it |
| the worktree afterwards | clean on the host — nothing of the image's leaks in |

One neighbouring failure that is **not** an image bug, noted here because it
looks like one: the runtime's `--tmpfs /tmp` renders `/tmp` `noexec` (naming
tmpfs options *adds* to Docker's defaults instead of replacing them), so
anything that execs out of `/tmp` — some `npm ci` builds of native modules —
fails with exit 126. That flag is the runtime's, not this directory's.

### What still cannot be checked here

| Layer | Remaining risk |
|---|---|
| cursor | the download URL `https://downloads.cursor.com/lab/<version>/linux/<arch>/agent-cli-package.tar.gz` is undocumented and is Cursor's to change; it worked on 2026-09-05. If it 404s, run `https://cursor.com/install` once by hand and read the `DOWNLOAD_URL` it prints. |
| all four | the *pinned versions* age. The plugin is the authority (`sandbox.image.args`), the Dockerfile default is kept equal to it, and a unit test holds the README's build commands to both. |
| all four | only the `--version` handshake was exercised inside the container. No image has yet run a real agent turn against a provider. |

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
