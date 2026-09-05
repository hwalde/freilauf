# freilauf/agent-hermes — the base image plus one pinned hermes.
#
#   docker build -f sandbox/images/hermes.Dockerfile \
#     --build-arg BASE=freilauf/agent-base:24.04 \
#     --build-arg HERMES_VERSION=0.21.0 \
#     -t freilauf/agent-hermes:0.21.0 sandbox/images
#
# UNBUILT AND UNTESTED, and the least certain of the four — see README.md.
ARG BASE=freilauf/agent-base:24.04
FROM ${BASE}

# `HERMES_VERSION` is the name the harness plugin's `sandbox.image.args` uses,
# and the default is the version pinned there and measured on this machine
# (`hermes --version` → 0.21.0). What that name MEANS here is the awkward part,
# and it is worth stating rather than hiding:
#
# hermes is NOT a released binary and not a versioned package. It is a git
# checkout plus a uv-managed virtualenv — measured on this machine, where
# `hermes --version` reports "Install method: git", a checkout under
# ~/.hermes/hermes-agent and its own Python 3.11. Its installer pins with
# `--branch <name>` (a tag is a valid branch argument to `git clone`) and
# `--commit <sha>`; there is no `--version`. So the version is passed as the
# branch/tag, and `HERMES_COMMIT` is there for the exact pin — the sha is what
# `hermes --version` calls "upstream" (f58fcc81 for 0.21.0 on this machine),
# and it is the only form that is unambiguous.
#
# UNVERIFIED: whether the repository carries a tag for 0.21.0 at all, and
# whether it is spelled `0.21.0` or `v0.21.0`. If the clone fails on the tag,
# build with `--build-arg HERMES_BRANCH=main --build-arg HERMES_COMMIT=<sha>`;
# `HERMES_VERSION` then only names the image.
ARG HERMES_VERSION=0.21.0
ARG HERMES_BRANCH=
ARG HERMES_COMMIT=

# Read from https://hermes-agent.nousresearch.com/install.sh on 2026-09-05:
#   --skip-setup   does not run the interactive provider wizard (there is no
#                  terminal here, and the credentials belong to the run's
#                  seeded home, not to the image)
#   --commit SHA   pins the checkout after the clone
#   --branch NAME  which branch to clone
# The script clones https://github.com/NousResearch/hermes-agent.git, fetches
# its own `uv`, installs a Python 3.11 under it and writes a `hermes` wrapper.
#
# FOUR THINGS TO VERIFY ON THE FIRST REAL BUILD, because none of them could be
# measured without Docker:
#  1. where the wrapper lands when the installer runs as root (on this machine
#     it is $HOME/.local/bin/hermes, so HOME is pinned to /opt/hermes for the
#     install command alone and the result is symlinked, as the claude layer
#     does);
#  2. whether it insists on a TTY anywhere despite --skip-setup;
#  3. whether it wants to install Node for its browser tool — the base image
#     already has Node 22, which should satisfy it;
#  4. **the split.** The installer puts the CHECKOUT under `$HERMES_HOME`,
#     which it derives as `$HOME/.hermes` — so here it lands in
#     /opt/hermes/.hermes. At run time $HOME is the per-run seeded home, so
#     hermes will look for its STATE (config.yaml with Freilauf's attention
#     hooks, skills, the session store the watcher reads) under
#     <run home>/.hermes, which is exactly right and is what the plugin seeds.
#     The generated `hermes` launcher hardcodes the interpreter and entrypoint
#     as absolute build-time paths (read from the installer), so the code is
#     found regardless. What is NOT known is whether hermes also expects its
#     own checkout beneath $HERMES_HOME at run time. If it does, the fix is a
#     link written by the plugin's `seedHome` into the run's home — NOT an
#     `ENV HERMES_HOME` here, which would send every run's state back to a
#     single shared directory in the image and silently break the seeding for
#     all of them (see the block in base.Dockerfile).
USER root
RUN set -eux; \
    mkdir -p /opt/hermes; \
    branch="${HERMES_BRANCH:-${HERMES_VERSION:-main}}"; \
    curl -fsSL https://hermes-agent.nousresearch.com/install.sh -o /tmp/hermes-install.sh; \
    if [ -n "${HERMES_COMMIT}" ]; then \
        HOME=/opt/hermes bash /tmp/hermes-install.sh --skip-setup --branch "$branch" --commit "${HERMES_COMMIT}"; \
    else \
        HOME=/opt/hermes bash /tmp/hermes-install.sh --skip-setup --branch "$branch"; \
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
# home, which the harness plugin writes — nothing about it belongs in the image,
# and `HERMES_HOME` is deliberately left unset so that `~` keeps meaning the
# run's own home.
USER agent
WORKDIR /home/agent
