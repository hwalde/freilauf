# freilauf/agent-<harness>-<repo> — the composition rule of §7.10, in one file:
# **the operator owns the toolchain image, Freilauf owns the agent layer.**
#
# A Java repository needs a JDK, a Rust repository a toolchain, and neither is
# Freilauf's business to guess or to maintain. So the repo names its own image
# (`repos.sandbox_image`) and this Dockerfile puts the coding agent on top of
# it — rather than the other way round, which would mean maintaining a matrix
# of language images here and would go stale the first time a team upgrades
# their compiler.
#
#   docker build -f sandbox/images/overlay.Dockerfile \
#     --build-arg BASE=registry.example.com/team/java21-build:2026-08 \
#     --build-arg AGENT_IMAGE=freilauf/agent-claude:2.1.261 \
#     --build-arg UID=$(id -u) --build-arg GID=$(id -g) \
#     -t freilauf/agent-claude-myrepo:2.1.261 sandbox/images
#
# BUILT AND MEASURED on 2026-09-05 against a pretend operator toolchain image
# (ubuntu:24.04 + bash/git/curl/ca-certificates, ending in a `USER` of its own):
# it refuses a base carrying XDG_DATA_HOME and NAMES the variable and its value,
# it refuses an alpine base for the packages it lacks, and the built overlay
# runs as root with the copied CLI on its PATH. The copy rule found a real
# defect in the opencode layer on that first build — see README.md.

ARG BASE
ARG AGENT_IMAGE

# The coding agent is COPIED out of the harness image rather than installed
# again: an install step here would need the operator's base to have curl, a
# network, and whatever the vendor's installer wants — and it would produce a
# DIFFERENT build of the CLI than the one the harness image was pinned to, so
# two runs of "the same" version could differ.
FROM ${AGENT_IMAGE} AS agent

FROM ${BASE}
ARG UID=1000
ARG GID=1000

USER root

# What this layer assumes of the operator's image, checked here rather than
# discovered at 3am inside a run: without these the agent cannot clone, cannot
# talk TLS and cannot run the hub's own scripts. The failure names the packages
# instead of the missing file, because the reader is somebody else's build
# engineer, not us.
RUN set -eux; \
    missing=""; \
    for b in bash git curl; do command -v "$b" >/dev/null 2>&1 || missing="$missing $b"; done; \
    [ -e /etc/ssl/certs/ca-certificates.crt ] || [ -e /etc/pki/tls/certs/ca-bundle.crt ] \
        || missing="$missing ca-certificates"; \
    if [ -n "$missing" ]; then \
        echo "This base image is missing:$missing" >&2; \
        echo "Add them to the toolchain image — Freilauf's agent layer does not" >&2; \
        echo "install packages into somebody else's base." >&2; \
        exit 1; \
    fi

# The one thing an operator's image can do that breaks a run SILENTLY, so it is
# a build failure rather than a discovery at 3am. Measured (§11a.4): **XDG
# outranks HOME for opencode.** A base image that carries XDG_DATA_HOME,
# XDG_CONFIG_HOME, XDG_STATE_HOME, CLAUDE_CONFIG_DIR, CURSOR_DATA_DIR or
# HERMES_HOME sends the CLI's state somewhere other than the per-run home the
# hub seeds and reads back — and then the seeded credentials are never read,
# the reporting plugin never loads, and the hub's activity measurement looks
# into an empty directory and calls the agent idle. Nothing errors; the run
# just stops reporting.
#
# Docker has no way to UNSET an inherited ENV (`ENV VAR=` sets it empty, which
# for several of these means something else again), so the honest answer is to
# refuse and say which variable and what it is set to.
RUN set -eux; \
    bad=""; \
    for v in XDG_DATA_HOME XDG_CONFIG_HOME XDG_STATE_HOME CLAUDE_CONFIG_DIR CURSOR_DATA_DIR HERMES_HOME; do \
        eval "val=\${$v:-}"; \
        [ -z "$val" ] || bad="$bad\n  $v=$val"; \
    done; \
    if [ -n "$bad" ]; then \
        printf 'This base image redirects a coding agent away from its HOME:%b\n' "$bad" >&2; \
        echo "A sandboxed run keeps ALL of its state in the per-run home Freilauf" >&2; \
        echo "mounts at \$HOME. XDG_* outranks HOME for opencode, so a run built on" >&2; \
        echo "this base would silently stop reporting. Remove them from the" >&2; \
        echo "toolchain image; a build that needs them can set them per command." >&2; \
        exit 1; \
    fi

# The same uid rule as the base image, and for the same reason (§7.7): the
# worktree, the run directory and the seeded home are bind mounts owned by the
# hub user. `useradd`/`groupadd` are shadow-utils and are on every glibc base;
# an image that has neither (alpine's busybox `adduser`) says so here.
RUN set -eux; \
    command -v useradd >/dev/null 2>&1 || { \
        echo "This base image has no useradd (shadow-utils)." >&2; \
        echo "Create a user with uid ${UID} and gid ${GID} in the toolchain image itself." >&2; \
        exit 1; }; \
    if getent group "${GID}" >/dev/null; then \
        groupmod -n agent "$(getent group "${GID}" | cut -d: -f1)" || true; \
    else \
        groupadd -g "${GID}" agent; \
    fi; \
    if getent passwd "${UID}" >/dev/null; then \
        usermod -l agent -d /home/agent -m -g "${GID}" "$(getent passwd "${UID}" | cut -d: -f1)" || true; \
    else \
        useradd -u "${UID}" -g "${GID}" -m -d /home/agent -s /bin/bash agent; \
    fi

# /opt holds the CLI itself in the claude, cursor and hermes layers; /usr/local
# holds the symlinks and, for opencode, the npm global tree. Both are MERGED
# into whatever the operator's image already has there rather than replacing
# it — a `COPY` of a directory adds and overwrites by name, it does not delete.
COPY --from=agent /opt /opt
COPY --from=agent /usr/local /usr/local

# An ENV of the harness image does NOT survive `COPY --from`, so the switches
# the harness layers set are repeated here. The union of all four is harmless:
# a variable a CLI does not know is a variable it does not read.
ENV DISABLE_AUTOUPDATER=1 \
    DISABLE_TELEMETRY=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    OPENCODE_DISABLE_AUTOUPDATE=1 \
    HERMES_SKIP_UPDATE_CHECK=1 \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

# NO `USER` LINE, and here it also has to UNDO one: an operator's toolchain
# image may well end in a `USER` of its own, and that would be what a rootless
# run arrives as, since `buildRunArgv()` passes no `--user` there. `USER root`
# above is therefore load-bearing in this file and not merely a build-step
# convenience — it is the last word, and it hands the decision back to the
# caller. See the block at the top of base.Dockerfile for the measurement.
WORKDIR /home/agent
