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
# and it is the version measured on this machine (`hermes --version` → 0.21.0).
# What that name MEANS here is the awkward part, and the first real build
# settled it:
#
# hermes is NOT a released binary and not a versioned package. It is a git
# checkout plus a uv-managed virtualenv. Its installer pins with `--branch
# <name>` and `--commit <sha>`; there is no `--version`, and **`0.21.0` is not
# a git ref of any kind** — measured, the build failed with `Remote branch
# 0.21.0 not found in upstream origin` when the version was passed as the
# branch. The repository's tags are dated (`v2026.8.31`, which is the date
# `hermes --version` prints in brackets), and the running install is 5258
# commits past the nearest one, so a tag is not the version either.
#
# So the ONE pin that is unambiguous is the commit, and it is the default:
# f58fcc8118… is what this machine's hermes 0.21.0 calls its "upstream" sha.
# `HERMES_VERSION` names the image and is CHECKED against what the installed
# CLI reports, so the tag and the contents cannot drift apart silently; moving
# the pin means moving both. `HERMES_BRANCH` stays `main` because the installer
# clones a branch and then checks the commit out of it.
ARG HERMES_VERSION=0.21.0
ARG HERMES_BRANCH=main
ARG HERMES_COMMIT=f58fcc8118d9db092ad60d363d4a28520e08ac5a

# Read from https://hermes-agent.nousresearch.com/install.sh on 2026-09-05:
#   --skip-setup   does not run the interactive provider wizard (there is no
#                  terminal here, and the credentials belong to the run's
#                  seeded home, not to the image)
#   --commit SHA   pins the checkout after the clone
#   --branch NAME  which branch to clone
# The script clones https://github.com/NousResearch/hermes-agent.git, fetches
# its own `uv`, installs a Python 3.11 under it and writes a `hermes` wrapper.
#
# WHAT THE FIRST REAL BUILD MEASURED, replacing four guesses that were written
# here before there was a container runtime on the machine:
#  1. **The root layout is the installer's own, and it is exactly the split we
#     wanted.** Read from the script and confirmed by the build: as root on
#     Linux it puts the CODE at /usr/local/lib/hermes-agent, its uv-managed
#     Python under /usr/local/share/uv, and writes three launchers — `hermes`,
#     `hermes-agent`, `hermes-acp` — straight into /usr/local/bin. Nothing has
#     to be symlinked afterwards, and everything the run needs sits in
#     /usr/local, which is what `overlay.Dockerfile` copies. (The guess here was
#     $HOME/.local/bin plus a symlink, which is the NON-root layout.)
#  2. **No TTY is wanted** with --skip-setup; the build ran through unattended.
#  3. **Node is not fetched**: the base image's Node 22 satisfies it.
#  4. **`$HERMES_HOME` holds only DATA, never the code.** With HOME pinned to
#     /opt/hermes for this command, the installer wrote config.yaml, .env and
#     its data directories under /opt/hermes/.hermes and put no code there at
#     all. At run time $HOME is the per-run seeded home, so hermes reads its
#     STATE from <run home>/.hermes — the config.yaml with Freilauf's attention
#     hooks, the skills, the session store the watcher reads — while the
#     launchers hardcode the interpreter and entrypoint as absolute /usr/local
#     paths, so the code is found whatever HOME is. That is why HOME is pinned
#     for this one command and why `ENV HERMES_HOME` must never appear: it
#     would send every run's state back to one shared directory in the image
#     and silently break the seeding for all of them (see base.Dockerfile).
#
# TWO THINGS ABOUT THE BROWSER, both learned on the first successful build.
# hermes' installer fetches a **Playwright Chromium with its apt dependencies**
# — that is the bulk of this image and the bulk of the build's ten minutes, and
# `--skip-browser` is the installer's own way out for anyone who does not want
# hermes' browser tool inside the sandbox.
#
# Where it lands matters more than that it is fetched. Playwright's default is
# `$HOME/.cache/ms-playwright`, and $HOME at BUILD time is not $HOME at RUN time
# — a sandboxed run's home is the per-run directory the hub mounts, so a browser
# under the build-time home is one no run can ever find, and hermes' browser
# tool would fail as if it had never been installed. `PLAYWRIGHT_BROWSERS_PATH`
# therefore points at an image path for both the install and the run. It is NOT
# a member of the forbidden family in base.Dockerfile and does not contradict
# it: those variables redirect a coding agent's STATE away from the per-run home,
# while this one names a read-only program directory, the same way Playwright's
# own images use `/ms-playwright`. /opt is also what `overlay.Dockerfile` copies,
# so the browser survives into an overlay.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright

# The caches are deleted IN THIS RUN and not in one of their own — a later
# layer cannot shrink an earlier one, it only stacks a whitening on top. They
# are worth the line: measured on the first successful build, the installer
# left 1.1 GB under the build-time $HOME/.cache, 157 MB of npm cache and 49 MB
# of a tool download, none of which a run reads.
# $HOME/.hermes stays — it is 52 MB, it is data rather than cache, and it is
# where the bundled skills the installer fetched sit.
USER root
RUN set -eux; \
    mkdir -p /opt/hermes; \
    curl -fsSL https://hermes-agent.nousresearch.com/install.sh -o /tmp/hermes-install.sh; \
    if [ -n "${HERMES_COMMIT}" ]; then \
        HOME=/opt/hermes bash /tmp/hermes-install.sh --skip-setup \
            --branch "${HERMES_BRANCH}" --commit "${HERMES_COMMIT}"; \
    else \
        HOME=/opt/hermes bash /tmp/hermes-install.sh --skip-setup --branch "${HERMES_BRANCH}"; \
    fi; \
    rm -f /tmp/hermes-install.sh; \
    test -x /usr/local/bin/hermes; \
    HOME=/opt/hermes hermes --version | head -1 | grep -F "v${HERMES_VERSION}"; \
    rm -rf /opt/hermes/.cache /opt/hermes/.npm /opt/hermes/.cua-driver /root/.cache; \
    rm -rf /var/lib/apt/lists/*; \
    chmod -R a+rX /opt/hermes /usr/local/lib/hermes-agent /opt/ms-playwright

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
# NO `USER` LINE — see the block at the top of base.Dockerfile. Under a
# rootless daemon `--user` is absent, so a `USER` here would be what decides,
# and uid 1000 inside maps to a subordinate uid that owns none of the mounts.
WORKDIR /home/agent
