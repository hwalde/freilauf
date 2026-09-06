#!/usr/bin/env bash
# wrap.sh — run a command inside this run's sandbox.
#
# It is deliberately thin. The container command line has exactly ONE author,
# `buildRunArgv()` in server/sandbox/runtime.mjs, and this script's whole job is
# to obtain that argv and `exec` it, so that the process the caller started IS
# the container client. That matters for tmux: `pane-died` carries the client's
# exit status and `pipe-pane` reads its output (SANDBOX_RESEARCH.md §7.1), so
# nothing may sit between the pane and the runtime — not even this script.
#
# Two callers, one path:
#   bin/fl-start --sandbox <sandbox.json>   wraps the harness command line
#   a human                                 does the same by hand, at 3am:
#
#     sandbox/wrap.sh --print ~/agents/runs/<id>/sandbox.json -- bash
#     sandbox/wrap.sh         ~/agents/runs/<id>/sandbox.json -- bash
#
#   The first prints the command line without running anything — which is also
#   the dry run (§7.12.5), and the only way to inspect a policy on a machine
#   that has no container runtime at all.
#
# Usage: wrap.sh [--print] <sandbox.json> [--env K=V]... [--env-inherit NAME]...
#                [--term VALUE] -- <cmd> [args...]
set -euo pipefail

err() { printf 'fl-sandbox: %s\n' "$*" >&2; }

PRINT=""
ARGS=()          # everything that is passed straight through to the printer
SEEN_CMD=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --print)   PRINT=1; shift ;;
        -h|--help)
            sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
            exit 0 ;;
        --)        SEEN_CMD=1; ARGS+=("$@"); break ;;
        *)         ARGS+=("$1"); shift ;;
    esac
done

[[ -n "$SEEN_CMD" ]] || { err "no command given — everything after -- is the command"; exit 2; }

# Where the printer lives. It sits NEXT TO this file on purpose: it imports the
# hub's own server/sandbox/runtime.mjs by a relative path, so the two cannot be
# separated. That is also why this script is not installed into ~/.local/bin
# like the fl-* scripts are — a copy there would have lost its module.
SELF="$(readlink -f "${BASH_SOURCE[0]}")"
CLI="${FREILAUF_SANDBOX_CLI:-$(dirname "$SELF")/runtime-cli.mjs}"
[[ -r "$CLI" ]] || { err "the argv printer is missing: $CLI"; exit 1; }

NODE="${FREILAUF_NODE:-node}"
command -v "$NODE" >/dev/null 2>&1 || {
    err "node is required to build the sandbox command line (looked for '$NODE')."
    err "Set FREILAUF_NODE to the interpreter the hub runs on."
    exit 1
}

# Read the argv NUL-separated, because an argument may contain anything at all —
# a newline inside a --settings JSON would otherwise split it in two.
# `mapfile -d ''` needs bash >= 4.4; Ubuntu 24.04 ships 5.2.
CMD=()
if ! mapfile -d '' -t CMD < <("$NODE" "$CLI" "${ARGS[@]}"); then
    err "could not build the sandbox command line."
    exit 1
fi
# A printer that failed writes its reason to stderr and nothing to stdout; the
# pipeline above hides its exit code, so the empty result is the signal.
(( ${#CMD[@]} )) || { err "the sandbox command line came out empty."; exit 1; }

# The environment the runtime CLI needs to reach the daemon the HUB means.
# Not cosmetic: this script runs in a tmux pane, and a `docker` with no
# DOCKER_HOST falls back to /var/run/docker.sock — the rootful socket, which on
# a rootless installation is absent or unreadable. Measured 2026-09-05: the pane
# died with "permission denied while trying to connect to the docker API at
# unix:///var/run/docker.sock" and the run's entire log was that one line.
# Empty output is the ordinary answer (a machine whose CLI finds its own daemon
# through a context), so it is not an error.
RTENV=()
if ! mapfile -d '' -t RTENV < <("$NODE" "$CLI" --print-env "${ARGS[@]}"); then
    err "could not resolve the container runtime's environment."
    exit 1
fi

if [[ -n "$PRINT" ]]; then
    # Shell-quoted on one line: what a human copies into a terminal to reproduce
    # the start by hand, and what a dry run shows. The environment is printed as
    # an `env` prefix so that the line really is reproducible — a copy that
    # talked to a different daemon than the run would be worse than no copy.
    (( ${#RTENV[@]} )) && { printf 'env'; for a in "${RTENV[@]}"; do printf ' %q' "$a"; done; printf ' '; }
    printf '%q' "${CMD[0]}"
    for a in "${CMD[@]:1}"; do printf ' %q' "$a"; done
    printf '\n'
    exit 0
fi

for kv in "${RTENV[@]:-}"; do [[ -n "$kv" ]] && export "${kv?}"; done

exec "${CMD[@]}"
