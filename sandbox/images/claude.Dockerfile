# freilauf/agent-claude — the base image plus one pinned Claude Code.
#
#   docker build -f sandbox/images/claude.Dockerfile \
#     --build-arg BASE=freilauf/agent-base:24.04 \
#     --build-arg CLAUDE_VERSION=2.1.261 \
#     -t freilauf/agent-claude:2.1.261 sandbox/images
#
# UNBUILT AND UNTESTED — see README.md.
ARG BASE=freilauf/agent-base:24.04
FROM ${BASE}

# The version is an ARG and never a default of "latest": the digest of this
# image goes into the run's `started` event, and an image that quietly changes
# under a fixed tag makes that record a lie. The default is the version pinned
# in the harness plugin (`sandbox.image.args` in server/harnesses/claude.mjs)
# and measured on this machine; the plugin is the authority, and the two are
# kept equal so an image and its declaration cannot say different things.
# `stable` and `latest` are the installer's own words and work here too, for a
# machine that deliberately wants to follow the release train.
ARG CLAUDE_VERSION=2.1.261

# Measured against https://claude.ai/install.sh on 2026-09-05: the script takes
# ONE positional argument, `stable | latest | X.Y.Z`, downloads from
# downloads.claude.ai/claude-code-releases and installs into
# $HOME/.local/share/claude/versions/<version> with a symlink at
# $HOME/.local/bin/claude. It refuses to run under `sudo` from a user shell but
# is happy as plain root, which is what a container build is.
#
# So it is installed once, into a home of its own under /opt, and linked into
# /usr/local/bin — NOT into /root or /home/agent. The run's HOME is a per-run
# directory bind-mounted at a path chosen by the hub (§7.7); a CLI installed
# under the build-time home would disappear behind that mount.
# `HOME=/opt/claude` is set for THIS command only — it is a shell assignment in
# front of the installer, not an ENV. It must never become one: at run time
# HOME is the per-run seeded home, and that is the whole point (§7.7). Nor is
# CLAUDE_CONFIG_DIR set anywhere, for the same reason — see the block in
# base.Dockerfile.
USER root
RUN set -eux; \
    mkdir -p /opt/claude; \
    HOME=/opt/claude bash -c 'curl -fsSL https://claude.ai/install.sh | bash -s "$0"' "${CLAUDE_VERSION}"; \
    test -x /opt/claude/.local/bin/claude; \
    ln -sf /opt/claude/.local/bin/claude /usr/local/bin/claude; \
    chmod -R a+rX /opt/claude

# The updater writes into the installation directory, which is root-owned here
# and read-only at run time anyway; without this the agent's first turn spends
# itself on an update that cannot work (§7.5.4). The two telemetry switches are
# the ones the harness plugin declares — they are set here as well so that an
# image started by hand behaves like one the hub starts.
ENV DISABLE_AUTOUPDATER=1 \
    DISABLE_TELEMETRY=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

# Deliberately NOT set here: `IS_SANDBOX=1`. Measured in the shipped 2.1.261
# binary (SANDBOX_RESEARCH.md §11a.7), claude's "am I in a recognized sandbox"
# predicate is exactly `IS_SANDBOX=1` or `CLAUDE_CODE_BUBBLEWRAP` — it does not
# detect Docker — and that is what lets `bypassPermissions` run as root. It is
# a statement about the RUN, so it belongs in the harness plugin's
# `sandbox.env` (server/harnesses/claude.mjs), which is where every other
# claude variable of a sandboxed run comes from. Setting it here as well would
# make two authors of one fact, and the image would then also claim it of a
# `docker run` somebody does by hand for a completely different purpose.

USER agent
WORKDIR /home/agent
