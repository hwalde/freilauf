#!/usr/bin/env bash
# run-alive.sh — is the coding agent behind this run still there?
#
#   run-alive.sh <run-uuid>            one run
#   run-alive.sh --repo <id>           every unarchived run of a repo
#   run-alive.sh --status running      every run in that status
#
# Prints one line per run:
#   <short id>  <status>  <verdict>  <session>  <last activity>  <title>
#
# The point of this script is the gap between the two middle columns. `status`
# is what the run REPORTED; `verdict` is what the machine is doing right now,
# and they disagree constantly:
#
#   working        the pane is alive and the record says running/waiting_help
#   idle_in_tui    the pane is alive and the run is over — the NORMAL state of a
#                  finished claude, opencode or cursor run. The agent is still
#                  sitting there and can be given more work.
#   process_gone   the session exists, every pane in it is dead
#   no_session     the run never recorded a session name
#   unknown        tmux could not be asked, OR the session no longer exists.
#                  NEVER read this as "the agent is gone" — tmux answers "there
#                  is no server" and "I could not answer you" with the same exit
#                  code. Confirm with: tmux has-session -t "=<session>"
#
# Exit codes: 0 = at least one run printed, 1 = no run matched,
#             2 = usage or missing tool, 3 = the hub did not answer.
set -euo pipefail

usage() { sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; }

# Help must work on a machine where nothing else does — the tool checks come
# after it, never before.
case "${1:-}" in
    -h|--help) usage; exit 0 ;;
    '')        usage >&2; exit 2 ;;
esac
for tool in fl-api python3; do
    command -v "$tool" >/dev/null 2>&1 || { printf 'run-alive.sh: %s is not on PATH\n' "$tool" >&2; exit 2; }
done

declare -a IDS=() QUERY=()
case "$1" in
    --repo)   [[ -n "${2:-}" ]] || { usage >&2; exit 2; }; QUERY=(repo="$2" limit=200) ;;
    --status) [[ -n "${2:-}" ]] || { usage >&2; exit 2; }; QUERY=(status="$2" limit=200) ;;
    -*)       printf 'run-alive.sh: unknown option %s\n' "$1" >&2; usage >&2; exit 2 ;;
    *)        IDS=("$1") ;;
esac

# `fl-api` exits 1 on an HTTP error and 3 when the hub did not answer at all,
# and both have to reach the caller as themselves: "no run matched" would be a
# lie about a hub that is down or too old to know this route.
# It RETURNS rather than exits, because every call site below runs it inside a
# subshell (a pipeline, a command substitution) where an `exit` would end that
# subshell and leave the script running on an empty answer — which is exactly
# how "the hub is too old for this route" turns into "no run matched".
frage() {
    local out rc=0
    out="$(fl-api --raw "$@")" || rc=$?
    if [[ $rc -ne 0 ]]; then
        printf '%s\n' "$out" >&2
        if [[ $rc == 3 ]]; then
            printf 'run-alive.sh: the hub did not answer — `freilauf status` says whether it is up.\n' >&2
        else
            printf 'run-alive.sh: the hub refused %s — is it running the release that ships this skill?\n' "$1" >&2
        fi
        return 3
    fi
    printf '%s' "$out"
}

if [[ ${#QUERY[@]} -gt 0 ]]; then
    # The list endpoint carries no liveness — that costs a tmux call per run, so
    # it lives on the detail endpoint alone. Collect ids here, ask per run below.
    liste="$(frage /api/runs "${QUERY[@]}")" || exit 3
    mapfile -t IDS < <(printf '%s' "$liste" \
        | python3 -c 'import json,sys; [print(r["id"]) for r in json.load(sys.stdin).get("runs", [])]')
fi

[[ ${#IDS[@]} -gt 0 ]] || { echo 'no run matched' >&2; exit 1; }

printf '%-9s %-13s %-13s %-26s %-20s %s\n' SHORT STATUS VERDICT SESSION 'LAST ACTIVITY' TITLE
for id in "${IDS[@]}"; do
    # One run the detail endpoint will not serve must not end the listing: a
    # batch answer with one row missing is useful, an aborted batch is not.
    # (The endpoint takes the full 36-character uuid and nothing else.)
    if ! einer="$(frage "/api/runs/$id" 2>/dev/null)"; then
        printf '%-9s %s\n' "${id:0:8}" 'unavailable — the hub would not answer for this id'
        continue
    fi
    printf '%s' "$einer" | python3 -c '
import json, sys
d = json.load(sys.stdin)
if not d.get("ok"):
    print("%-9s %s" % (sys.argv[1][:8], d.get("error", "not found")))
    sys.exit(0)
r, l = d["run"], d["liveness"]
print("%-9s %-13s %-13s %-26s %-20s %s" % (
    r.get("short_id") or r["id"][:8], r.get("status") or "-", l.get("verdict") or "-",
    l.get("tmux_session") or "-", l.get("last_activity_at") or "-", (r.get("title") or "")[:60]))
' "$id"
done
