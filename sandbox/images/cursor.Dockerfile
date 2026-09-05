# freilauf/agent-cursor — the base image plus one pinned cursor-agent.
#
#   docker build -f sandbox/images/cursor.Dockerfile \
#     --build-arg BASE=freilauf/agent-base:24.04 \
#     --build-arg CURSOR_VERSION=2026.09.02-c22c1a3 \
#     -t freilauf/agent-cursor:2026.09.02-c22c1a3 sandbox/images
#
# UNBUILT AND UNTESTED — see README.md.
ARG BASE=freilauf/agent-base:24.04
FROM ${BASE}

# The version is cursor's own build id, exactly as `cursor-agent --version`
# prints it and as `cursor-agent models` expects the CLI to be.
ARG CURSOR_VERSION=2026.09.02-c22c1a3
ARG CURSOR_ARCH=x64

# NOT `curl https://cursor.com/install | bash`, and the reason is measured
# rather than aesthetic: that script is GENERATED per request with the current
# version baked into it (read on 2026-09-05 — it contains no version argument
# and no version environment variable at all). Piping it into a build would
# produce a differently-versioned image every day under one tag, which is the
# opposite of what pinning is for.
#
# What the script does, and what is reproduced here verbatim, is fetch
#   https://downloads.cursor.com/lab/<version>/linux/<arch>/agent-cli-package.tar.gz
# and untar it with --strip-components=1; the executable inside is called
# `cursor-agent`. That URL is undocumented and is Cursor's to change; if this
# step stops working, run the installer once by hand, read the DOWNLOAD_URL it
# prints, and update this file.
USER root
RUN set -eux; \
    case "${CURSOR_ARCH}" in x64|arm64) ;; *) echo "unsupported CURSOR_ARCH: ${CURSOR_ARCH}" >&2; exit 1 ;; esac; \
    mkdir -p "/opt/cursor-agent/${CURSOR_VERSION}"; \
    curl -fsSL "https://downloads.cursor.com/lab/${CURSOR_VERSION}/linux/${CURSOR_ARCH}/agent-cli-package.tar.gz" \
      | tar --strip-components=1 -xzf - -C "/opt/cursor-agent/${CURSOR_VERSION}"; \
    test -x "/opt/cursor-agent/${CURSOR_VERSION}/cursor-agent"; \
    ln -sf "/opt/cursor-agent/${CURSOR_VERSION}/cursor-agent" /usr/local/bin/cursor-agent; \
    ln -sf "/opt/cursor-agent/${CURSOR_VERSION}/cursor-agent" /usr/local/bin/agent; \
    chmod -R a+rX /opt/cursor-agent

# Two things Freilauf relies on for cursor, both worth knowing here: the run is
# launched with `--force --trust` (fl-start), and the hub writes a
# `.cursor/hooks.json` into the workspace whose `stop` hook calls fl-report —
# so the mounted ~/.local/bin has to be on the PATH inside, which it is.
#
# The version pin is repeated as a label rather than as an environment
# variable: cursor-agent reads no such variable, and an ENV that nothing reads
# is a promise to a future reader that is not kept.
LABEL freilauf.cursor.version="${CURSOR_VERSION}"

USER agent
WORKDIR /home/agent
