# freilauf/agent-hermes — the base image plus one pinned hermes.
#
#   docker build -f sandbox/images/hermes.Dockerfile \
#     --build-arg BASE=freilauf/agent-base:24.04 \
#     --build-arg HERMES_COMMIT=f58fcc81 \
#     -t freilauf/agent-hermes:f58fcc81 sandbox/images
#
# UNBUILT AND UNTESTED, and the least certain of the four — see README.md.
ARG BASE=freilauf/agent-base:24.04
FROM ${BASE}

# hermes is NOT a released binary and not a versioned package: it is a git
# checkout plus a uv-managed virtualenv (measured on this machine —
# `hermes --version` reports "Install method: git", the checkout under
# ~/.hermes/hermes-agent and its own Python 3.11). Its installer accordingly
# pins with `--commit <sha>` and `--branch <name>`, not with a semver; the sha
# is what `hermes --version` calls "upstream".
ARG HERMES_COMMIT=
ARG HERMES_BRANCH=main

# Read from https://hermes-agent.nousresearch.com/install.sh on 2026-09-05:
#   --skip-setup   does not run the interactive provider wizard (there is no
#                  terminal here, and the credentials belong to the run's
#                  seeded home, not to the image)
#   --commit SHA   pins the checkout after the clone
#   --branch NAME  which branch to clone
# The script clones https://github.com/NousResearch/hermes-agent.git, fetches
# its own `uv`, installs a Python 3.11 under it and writes a `hermes` wrapper.
#
# THREE THINGS TO VERIFY ON THE FIRST REAL BUILD, because they could not be
# measured without Docker:
#  1. where the wrapper lands when the installer runs as root (on this machine
#     it is $HOME/.local/bin/hermes, so HOME is pinned to /opt/hermes and the
#     result is symlinked, exactly as the claude layer does);
#  2. whether it insists on a TTY anywhere despite --skip-setup;
#  3. whether it wants to install Node for its browser tool — the base image
#     already has Node 22, which should satisfy it.
USER root
RUN set -eux; \
    mkdir -p /opt/hermes; \
    curl -fsSL https://hermes-agent.nousresearch.com/install.sh -o /tmp/hermes-install.sh; \
    if [ -n "${HERMES_COMMIT}" ]; then \
        HOME=/opt/hermes bash /tmp/hermes-install.sh --skip-setup --branch "${HERMES_BRANCH}" --commit "${HERMES_COMMIT}"; \
    else \
        HOME=/opt/hermes bash /tmp/hermes-install.sh --skip-setup --branch "${HERMES_BRANCH}"; \
    fi; \
    rm -f /tmp/hermes-install.sh; \
    hermes_bin="$(command -v hermes || echo /opt/hermes/.local/bin/hermes)"; \
    test -x "$hermes_bin"; \
    ln -sf "$hermes_bin" /usr/local/bin/hermes; \
    chmod -R a+rX /opt/hermes

# hermes updates itself by pulling its own checkout, which inside a container
# is both pointless and a way to make two runs of one image behave differently.
# `HERMES_SKIP_UPDATE_CHECK=1` is hermes' own variable — it is what hermes'
# repository sets in its benchmark harness (evals/…/runtime_bench.py) to keep a
# run from checking. UNVERIFIED beyond that: it was read out of the source, not
# measured against a build, and hermes has no documented "disable the updater"
# switch of the kind claude and opencode ship.
ENV HERMES_SKIP_UPDATE_CHECK=1

# The attention hooks live in ~/.hermes/config.yaml (setup/02-install-scripts.sh
# writes them on the host). In a sandbox that file is part of the run's seeded
# home, which the harness plugin writes — nothing about it belongs in the image.
USER agent
WORKDIR /home/agent
