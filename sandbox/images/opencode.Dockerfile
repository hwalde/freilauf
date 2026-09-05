# freilauf/agent-opencode — the base image plus one pinned opencode.
#
#   docker build -f sandbox/images/opencode.Dockerfile \
#     --build-arg BASE=freilauf/agent-base:24.04 \
#     --build-arg OPENCODE_VERSION=1.18.29 \
#     -t freilauf/agent-opencode:1.18.29 sandbox/images
#
# UNBUILT AND UNTESTED — see README.md.
ARG BASE=freilauf/agent-base:24.04
FROM ${BASE}

ARG OPENCODE_VERSION=1.18.29

# npm rather than the `opencode.ai/install` shell script, and that is a
# deliberate trade: the npm package takes a version, the installer takes
# whatever is current. `opencode-ai` is the package name the harness plugin's
# own installHint names (server/harnesses/opencode.mjs), and `npm i -g` puts
# the launcher in /usr/local/bin, which survives the run's HOME being mounted
# over. The package ships a platform-specific binary as an optional
# dependency; on a machine whose architecture opencode does not publish for,
# this step is where the build fails, loudly, which is the right place.
USER root
RUN set -eux; \
    npm install -g --no-fund --no-audit "opencode-ai@${OPENCODE_VERSION}"; \
    npm cache clean --force; \
    opencode --version

# opencode checks for a newer release on start and writes into its cache to do
# it. Under a read-only root with a tmpfs cache that is at best wasted seconds
# and at worst a line of noise in the TUI on every start.
ENV OPENCODE_DISABLE_AUTOUPDATE=1

# opencode is the CLI the XDG rule was measured on (SANDBOX_RESEARCH.md
# §11a.4): **XDG_DATA_HOME / XDG_CONFIG_HOME outrank HOME for it.** So neither
# is set here, and neither may be set by an operator's base image underneath —
# an opencode that writes its state anywhere but the per-run home never reads
# the seeded `auth.json`, never loads `plugins/freilauf.js`, and leaves the
# hub's activity and token measurement reading an empty session store. The full
# reasoning is in base.Dockerfile; overlay.Dockerfile fails the build over it.

# NO `USER` LINE — see the block at the top of base.Dockerfile. Under a
# rootless daemon `--user` is absent, so a `USER` here would be what decides,
# and uid 1000 inside maps to a subordinate uid that owns none of the mounts.
WORKDIR /home/agent
