# freilauf/agent-base — everything every sandboxed run needs and nothing that
# belongs to one coding agent. SANDBOX_RESEARCH.md §7.10.
#
#   docker build -f sandbox/images/base.Dockerfile \
#     --build-arg UID=$(id -u) --build-arg GID=$(id -g) \
#     -t freilauf/agent-base:24.04 sandbox/images
#
# UNBUILT AND UNTESTED — see README.md. The machine this was written on has no
# container runtime; every line here is derived from a measured installer or
# from the distribution's own package names, and the README says exactly which
# commands an operator runs to find out whether that was enough.
FROM ubuntu:24.04

# The agent runs as a NON-ROOT user, and its uid is the HUB's uid (§7.7). Both
# halves matter and for different reasons. Non-root, because root in the
# container is root on every bind mount, and an escape from a runc container
# lands wherever the process already was. The hub's uid, because the worktree,
# the run directory and the seeded home are bind-mounted from the host and are
# owned by the hub user: a container user with a different uid would see them
# as somebody else's files and could not write a single commit. There is no
# uid remapping in between — with rootless Docker or `podman --userns=keep-id`
# the container's uid maps back to the hub's uid on the host, which is the
# same statement from the other side.
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

# The hub mounts fl-report and fl-paths.sh from ~/.local/bin at the identical
# path (§7.11), and the PATH of the RUN itself carries that directory because
# the runtime puts it there (`binPaths` in the container's environment). This
# file is for the other shell: the one an operator gets from
# `docker exec -it fl-<id> bash -l` while debugging. The host home is not known
# at build time, so it is derived from $HOME instead of being baked in.
RUN printf '%s\n' 'case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) PATH="$HOME/.local/bin:$PATH" ;; esac' \
    > /etc/profile.d/freilauf-path.sh

USER agent
WORKDIR /home/agent
