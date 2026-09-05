# freilauf/agent-base — everything every sandboxed run needs and nothing that
# belongs to one coding agent. SANDBOX_RESEARCH.md §7.10.
#
#   docker build -f sandbox/images/base.Dockerfile \
#     --build-arg UID=$(id -u) --build-arg GID=$(id -g) \
#     -t freilauf/agent-base:24.04 sandbox/images
#
# BUILT AND MEASURED on 2026-09-05 (rootless Docker 29.8.0, ubuntu 24.04):
# ~90 s cold, 942 MB, `node --version` v22.22.1 inside. See README.md for the
# per-image table and for what is still unverified.
FROM ubuntu:24.04

# ┌──────────────────────────────────────────────────────────────────────────┐
# │ THIS IMAGE PINS NO `USER`, AND THAT IS THE WHOLE RULE. THE CALLER DECIDES.│
# └──────────────────────────────────────────────────────────────────────────┘
#
# What a run needs is one thing said in two ways, because the two daemon types
# spell it differently (§7.7). The files a run touches — the worktree, the run
# directory, the seeded home — are bind mounts owned by the HUB user on the
# host, so the process inside has to arrive at that host uid or it cannot write
# a single commit:
#
#   rootful daemon   the container's uid IS the host's uid, so the run must be
#                    the hub's uid and NOT root — root in the container is root
#                    on every bind mount, and an escape from runc lands
#                    wherever the process already was. `buildRunArgv()` passes
#                    `--user <hub uid>:<hub gid>`.
#   rootless daemon  the container's uid 0 IS the hub user on the host (the
#                    /etc/subuid mapping), and container uid 1000 is a
#                    subordinate uid that owns nothing. So the run must be
#                    container ROOT. `buildRunArgv()` deliberately passes NO
#                    `--user` at all.
#
# `--user` being ABSENT under rootless is exactly why a `USER` line here is not
# a harmless default: it is what wins. Measured against a rootless daemon whose
# `/etc/subuid` gives the hub user the usual 65536 subordinate ids
# (`<operator>:100000:65536`), on a real worktree owned by that user, with the
# image as it was first written, ending in `USER agent`:
#
#   $ docker run --rm -v <wt>:<wt> -w <wt> freilauf/agent-base:24.04 \
#       bash -c 'id -u; touch probe.txt; git status'
#   1000
#   touch: cannot touch 'probe.txt': Permission denied
#   fatal: detected dubious ownership in repository at '<wt>'
#
# Both failures are the same fact seen twice: uid 1000 inside mapped to 100999
# on the host, so every operator-owned file was somebody else's. With no `USER`
# the same command runs as container root, writes files owned by the hub user
# on the host, and git raises nothing — the uids MATCH, which is why the answer
# is the uid and never `safe.directory` (that would only silence the symptom
# while the writes still landed under a subordinate uid).
#
# There is no third way. An entrypoint that "adapts" cannot: a container's uid
# is fixed at creation, and the runtime hardening (`--cap-drop ALL`,
# `--security-opt no-new-privileges`) removes every means of changing it from
# the inside. Two tagged variants cannot either: `taggedImage()` names an image
# from the harness and its version and knows nothing of the daemon type.
#
# The `agent` user below still exists — `--user 1000:1000` on a rootful daemon
# must land on a real passwd entry with a real home, or the shell inside has no
# `$HOME`, no `~` and a `whoami` that fails. It is simply not made the default.
ARG UID=1000
ARG GID=1000

# ubuntu:24.04 already ships a uid 1000 user called `ubuntu`. Renaming it is
# cheaper and less surprising than deleting it, and it keeps /home tidy.
RUN set -eux; \
    if getent group "${GID}" >/dev/null; then \
        groupmod -n agent "$(getent group "${GID}" | cut -d: -f1)"; \
    else \
        groupadd -g "${GID}" agent; \
    fi; \
    if getent passwd "${UID}" >/dev/null; then \
        usermod -l agent -d /home/agent -m -g "${GID}" "$(getent passwd "${UID}" | cut -d: -f1)"; \
    else \
        useradd -u "${UID}" -g "${GID}" -m -d /home/agent -s /bin/bash agent; \
    fi

# The toolchain a coding agent assumes it has. `git curl ca-certificates jq
# python3 bash ripgrep` are what the hub's own scripts and every agent reach
# for; `build-essential` because npm packages with native modules are normal in
# the repositories this runs against; `less` because git pipes into a pager and
# a missing one makes `git log` fail in a way nobody expects. No tini: the
# runtime is started with `--init`, which is Docker's own (§7.1).
RUN set -eux; \
    export DEBIAN_FRONTEND=noninteractive; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        bash ca-certificates curl git jq less python3 python3-venv ripgrep \
        build-essential openssh-client unzip xz-utils; \
    rm -rf /var/lib/apt/lists/*

# Node is the hub's own version (22), and it is pinned: an image that installs
# "the current LTS" is a different image every month, which is the opposite of
# what a digest in the run's event log is for. NodeSource rather than the
# distribution's package, because ubuntu 24.04 ships Node 18.
ARG NODE_MAJOR=22
RUN set -eux; \
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o /tmp/nodesource.sh; \
    bash /tmp/nodesource.sh; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends nodejs; \
    rm -f /tmp/nodesource.sh; \
    rm -rf /var/lib/apt/lists/*; \
    node --version

# C.UTF-8 is in glibc itself, so no locale package and no locale-gen is needed.
# TERM and COLORTERM are deliberately NOT set here — they come from the tmux
# pane at run time (§8.17), and a value baked in would be a lie about somebody
# else's terminal.
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8

# npm's update notifier writes to the cache and prints a box into a TUI; inside
# a read-only container the first is an error and the second is corruption of
# somebody's screen. The per-harness auto-updaters are switched off in the
# harness layers, where the variable names differ per vendor.
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
ENV NPM_CONFIG_FUND=false

# The harness layers install into /usr/local, so the CLI is found whatever the
# run's HOME is remounted to.
ENV PATH=/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin

# NOT SET HERE, AND NEVER TO BE SET IN ANY IMAGE OF THIS FAMILY:
#   XDG_DATA_HOME  XDG_CONFIG_HOME  XDG_STATE_HOME
#   CLAUDE_CONFIG_DIR  CURSOR_DATA_DIR  HERMES_HOME
#
# Measured (SANDBOX_RESEARCH.md §11a.4): **XDG outranks HOME for opencode.** A
# run's whole state — the seeded `auth.json`, the `freilauf.js` reporting
# plugin, the session store the hub reads activity and tokens out of — lives in
# the per-run home the hub mounts at $HOME. An image that sets one of these
# sends the CLI somewhere else, and every consequence is of the silent kind:
# the seeded credentials are never read, the plugin never loads, and the hub's
# activity measurement and API-error channel look into an empty directory and
# conclude the agent is idle. Nothing fails; the run just stops reporting,
# which is the most expensive shape a fault can take here.
#
# The rule is the same one that makes the whole per-run home work: HOME is the
# single statement about where a run's state lives, and a second statement can
# only disagree with it. `overlay.Dockerfile` refuses a base image that carries
# any of them.

# The hub mounts fl-report and fl-paths.sh from ~/.local/bin at the identical
# path (§7.11), and the PATH of the RUN itself carries that directory because
# the runtime puts it there (`binPaths` in the container's environment). This
# file is for the other shell: the one an operator gets from
# `docker exec -it fl-<id> bash -l` while debugging. The host home is not known
# at build time, so it is derived from $HOME instead of being baked in.
RUN printf '%s\n' 'case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) PATH="$HOME/.local/bin:$PATH" ;; esac' \
    > /etc/profile.d/freilauf-path.sh

# NO `USER` LINE — see the block at the top of this file. The default user is
# therefore root, which is what a rootless daemon must have (container root is
# the hub user on the host) and what a rootful one overrides with `--user`.
# WORKDIR is a courtesy for `docker run … bash -l` by hand; every run gets `-w`
# pointing at its worktree.
WORKDIR /home/agent
