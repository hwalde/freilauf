#!/usr/bin/env bash
# deploy-after-merge.sh — the post-merge step: bring merged code live, but only
# when doing so cannot disturb anything that is running.
#
# Installed as the repository's `post-merge` hook by setup/02-install-scripts.sh,
# exactly the way `pruefe-vor-push.sh` is installed as `pre-push`: a symlink in
# `.git/hooks`, the script itself versioned in the repository.
#
# ---------------------------------------------------------------------------
# WHY THIS IS NOT `systemctl restart`
#
# The hub does not run from the checkout you merge in. `deploy/freilauf.service`
# starts `~/agents/deploy/freilauf/server/hub.mjs` — a checkout that nobody works
# in and that only `freilauf-deploy` ever writes to (the unit file says so, and
# says why). Restarting the unit right after a merge would therefore restart the
# hub on exactly the code it was already running: the full cost of a restart,
# none of the effect. The only thing that makes merged code live is a deploy, so
# a deploy is what this script decides about.
#
# ---------------------------------------------------------------------------
# WHY A MERGE IS NOT ENOUGH TO DEPLOY
#
# `git merge` in the hub's integration worktree is provisional. Its only way out
# is `git push origin HEAD:<base>` (server/integrate.mjs), and a merge that
# cannot be pushed is thrown away and escalated — the hook, however, runs
# BETWEEN the merge and the push. Deploying at that moment could publish a commit
# that is about to be discarded.
#
# Hence the origin check below: a commit is only deployed once it is provably an
# ancestor of `origin/<base>`, which is the same as saying the push has happened.
# Before that the answer is "pending", never "deploy".
#
# ---------------------------------------------------------------------------
# THE THREE ANSWERS
#
#   skipped   the merge touched only files the running hub never reads
#             (documentation, tests, CI) — no deploy, no restart, no risk
#   deployed  it has to ship, it is on origin, and nothing is running
#             → freilauf-deploy, detached, so a merge never waits for it
#   pending   it has to ship, but not now — recorded in a marker file that
#             `freilauf status` prints, so it cannot quietly stay behind
#
# A hook must never be the reason a merge fails: every step is guarded and the
# exit code is always 0.
#
# Usage: deploy-after-merge.sh [--help] [--dry-run]
#   Git passes the squash flag as $1 (0 or 1); it is accepted and ignored.
#   FREILAUF_POST_MERGE=off (or CCHUB_POST_MERGE=off) disables it entirely.

# No `set -e`: this script's whole job is to survive its own failures. `pipefail`
# would do the same damage through a pipe, so it stays off too.
set -u

SELF="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || printf '%s' "${BASH_SOURCE[0]}")"
SELF_DIR="$(dirname "$SELF")"

# The final line, in the shape the rest of this project uses: one line, parseable,
# always printed — including on every error path, which is why it goes through a
# trap rather than being written at each exit.
RESULT=error REASON=unknown CHANGED=0 RELEVANT=0 ACTIVE='?' SHA='?'
schlusszeile() {
    printf 'deploy-after-merge result=%s reason=%s changed=%s relevant=%s active=%s sha=%s\n' \
        "$RESULT" "$REASON" "$CHANGED" "$RELEVANT" "$ACTIVE" "$SHA"
}
trap 'schlusszeile' EXIT

usage() {
    sed -n '2,46p' "$SELF" | sed 's/^# \{0,1\}//'
}

DRY=0
for arg in "$@"; do
    case "$arg" in
        -h|--help) trap - EXIT; usage; exit 0 ;;
        --dry-run) DRY=1 ;;
        0|1)       ;;   # git's squash flag
        *)         ;;   # never argue with an unexpected argument, never fail
    esac
done

log() {
    printf '%s\n' "post-merge: $*"
    [[ -n "${LOGFILE:-}" ]] && printf '[%s] %s\n' "$(date '+%F %T')" "$*" >>"$LOGFILE" 2>/dev/null
    return 0
}

# ---------------------------------------------------------------- where things live
# `bin/fl-paths.sh` answers which name this installation uses — an installation
# that has not been migrated yet is still cc-hub everywhere. It sits next to the
# script it belongs to; under the hook symlink `readlink -f` has already led us
# back to the repository root.
if [[ -r "$SELF_DIR/bin/fl-paths.sh" ]]; then
    # shellcheck source=bin/fl-paths.sh
    . "$SELF_DIR/bin/fl-paths.sh"
else
    RESULT=error REASON=no-fl-paths
    log "bin/fl-paths.sh not found next to $SELF — doing nothing"
    exit 0
fi

if [[ "$(fl_env POST_MERGE on)" == off ]]; then
    RESULT=skipped REASON=disabled
    log "disabled by FREILAUF_POST_MERGE=off"
    exit 0
fi

DEPLOY_DIR="$(fl_deploy_dir)"
STATE_DIR="$(dirname "$DEPLOY_DIR")"
MARKER="$STATE_DIR/deploy-pending"
LOGFILE="$STATE_DIR/post-merge.log"
mkdir -p "$STATE_DIR" 2>/dev/null

# The marker is the whole point of the "pending" answer: a deploy that was owed
# and not carried out has to be VISIBLE, or the hub quietly runs old code for a
# week. `freilauf status` prints this file. Plain `key=value` lines so a human
# reading it and a script grepping it get the same thing.
merke() {
    local grund="$1" text="$2"
    [[ "$DRY" == 1 ]] && return 0
    {
        printf 'sha=%s\n'     "$SHA_FULL"
        printf 'short=%s\n'   "$SHA"
        printf 'subject=%s\n' "$(git log -1 --format=%s "$SHA_FULL" 2>/dev/null)"
        printf 'reason=%s\n'  "$grund"
        printf 'detail=%s\n'  "$text"
        printf 'files=%s\n'   "$RELEVANT"
        printf 'at=%s\n'      "$(date '+%F %T')"
    } >"$MARKER" 2>/dev/null
    return 0
}

# ---------------------------------------------------------------- the merge range
# The hook runs inside the worktree that was merged — which, for a run the hub
# integrated, is `~/agents/integrate/<repo>` and not the operator's checkout. Both
# are worktrees of the same repository and therefore share `.git/hooks`, so this
# script has to ask git where it actually is instead of assuming.
TOP="$(git rev-parse --show-toplevel 2>/dev/null)"
if [[ -z "$TOP" ]]; then
    RESULT=error REASON=not-a-worktree
    log "not inside a git worktree — doing nothing"
    exit 0
fi
cd "$TOP" 2>/dev/null || { RESULT=error REASON=cd-failed; log "cannot enter $TOP"; exit 0; }

SHA_FULL="$(git rev-parse HEAD 2>/dev/null)"
SHA="$(git rev-parse --short HEAD 2>/dev/null)"
[[ -n "$SHA" ]] || { RESULT=error REASON=no-head; log "no HEAD"; exit 0; }

# ORIG_HEAD is what git leaves behind for exactly this purpose. Falling back to the
# first parent keeps the script usable by hand and in a test, where nothing set it.
VORHER="$(git rev-parse --verify --quiet ORIG_HEAD 2>/dev/null)"
[[ -n "$VORHER" ]] || VORHER="$(git rev-parse --verify --quiet 'HEAD^1' 2>/dev/null)"
if [[ -z "$VORHER" ]]; then
    RESULT=skipped REASON=no-previous-commit
    log "no ORIG_HEAD and no first parent — nothing to compare"
    exit 0
fi

DATEIEN="$(git diff --name-only "$VORHER" "$SHA_FULL" 2>/dev/null)"
CHANGED="$(printf '%s' "$DATEIEN" | grep -c . 2>/dev/null)"
CHANGED="${CHANGED:-0}"

# ---------------------------------------------------------------- what has to ship
# The question is not "did something change" but "does the RUNNING hub ever read
# this file". Derived from the code, not from a feeling:
#
#   server/**         imported into the node process — only a restart reloads it
#   lang/*.json       read once at startup (server/i18n.mjs does readFileSync at
#                     import time), so a translation needs a restart too
#   public/**         served from disk and revalidated per request against
#                     mtime+size (server/web.mjs, serveStatic) — the CONTENT needs
#                     no restart, but the file still has to reach the deploy
#                     checkout, and freilauf-deploy has no way of putting it there
#                     without one. So it ships like the rest.
#   vpn-proxy.mjs     the VPN unit's process; `Requires=` on the hub unit makes a
#                     hub restart carry it along
#   package*.json     dependencies — `npm ci` is part of a deploy
#   deploy/*.service  the unit files themselves (a deploy installs and reloads them)
#   bin/**, setup/**  installed into ~/.local/bin by a deploy; fl-report and
#                     fl-start have to match the hub they talk to
#
# Everything else — the READMEs, docs/, test/, .github/, GATES.md, this script —
# is never read by the running hub. server/**'s comments point at docs/plugins.md,
# but a comment is not a read.
RELEVANTE="$(printf '%s\n' "$DATEIEN" | grep -E '^(server/|lang/|public/|bin/|setup/|deploy/[^/]+\.service$|vpn-proxy\.mjs$|package\.json$|package-lock\.json$)' 2>/dev/null)"
RELEVANT="$(printf '%s' "$RELEVANTE" | grep -c . 2>/dev/null)"
RELEVANT="${RELEVANT:-0}"

if [[ "$RELEVANT" == 0 ]]; then
    RESULT=skipped REASON=no-shipping-change
    log "$CHANGED file(s) merged, none of them shipped code — nothing to deploy"
    exit 0
fi

# ---------------------------------------------------------------- is it on origin?
BASE="$(git symbolic-ref --quiet --short HEAD 2>/dev/null)"
[[ -n "$BASE" ]] || BASE="$(fl_env DEPLOY_BASE main)"
git fetch --quiet origin 2>/dev/null
if ! git merge-base --is-ancestor "$SHA_FULL" "origin/$BASE" 2>/dev/null; then
    RESULT=pending REASON=not-on-origin
    merke "$REASON" "the commit is not on origin/$BASE yet (push still pending)"
    log "$RELEVANT shipping file(s), but $SHA is not on origin/$BASE yet — deploy pending"
    exit 0
fi

# ---------------------------------------------------------------- is anything running?
# The load-bearing question, and `runs.status` alone answers it wrongly: a run can
# be `done` and still be inside the integration (`finish_state`), and restarting
# into a running `git merge` is the one thing worth avoiding. Flow runs are asked
# for as well. Read straight out of SQLite, so this works whether or not the hub
# is up — and note that `tmux ls` is NOT the probe: `fl-start --keep` leaves
# sessions of finished runs standing, so tmux would answer "busy" forever.
#
# Anything unreadable counts as busy. A guard that cannot measure must not wave through.
aktive_laeufe() {
    local db; db="$(fl_db_file)"
    [[ -f "$db" ]] || { printf 'nodb'; return 0; }
    node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
try {
  const db = new DatabaseSync(process.argv[1], { readOnly: true });
  let n = db.prepare(
    "SELECT COUNT(*) c FROM runs WHERE status IN (?,?,?,?)" +
    " OR finish_state IN (?,?,?,?,?)"
  ).get("scheduled", "deferred", "running", "waiting_help",
        "checking", "awaiting_commit", "awaiting_merge", "merging", "check_failed").c;
  // Older databases have no flow_runs table; that is not an error, it is an
  // installation that predates flows.
  try {
    n += db.prepare("SELECT COUNT(*) c FROM flow_runs WHERE status IN (?,?)")
           .get("running", "waiting").c;
  } catch { /* no flows here */ }
  process.stdout.write(String(n));
} catch { process.stdout.write("err"); }
' "$db" 2>/dev/null || printf 'err'
}

ACTIVE="$(aktive_laeufe)"
if [[ ! "$ACTIVE" =~ ^[0-9]+$ ]]; then
    RESULT=pending REASON=state-unreadable
    merke "$REASON" "could not read the run state ($ACTIVE) — not deploying blind"
    log "run state unreadable ($ACTIVE) — deploy pending"
    exit 0
fi
if [[ "$ACTIVE" != 0 ]]; then
    RESULT=pending REASON=runs-active
    merke "$REASON" "$ACTIVE run(s) active — a restart would cut their terminals"
    log "$ACTIVE run(s) active — deploy pending, nothing restarted"
    exit 0
fi

# ---------------------------------------------------------------- the one hard guard
# `KillMode=process` is what keeps a restart from being a massacre: the tmux server
# and the pipe-pane loggers of every run really do sit in this unit's cgroup
# (measured with systemd-cgls), so with the systemd default a restart would take
# every agent session down with it. The unit file in deploy/ sets it and explains
# why — but this script is what pulls the trigger, so it verifies it rather than
# trusting that nobody edited the installed copy.
UNIT="$(fl_unit)"
KILLMODE="$(systemctl --user show "$UNIT" -p KillMode --value 2>/dev/null)"
if [[ "$KILLMODE" != process ]]; then
    RESULT=pending REASON=killmode
    merke "$REASON" "$UNIT has KillMode=${KILLMODE:-unknown}, not process — a restart would kill every agent session"
    log "$UNIT has KillMode=${KILLMODE:-unknown} instead of process — refusing to restart"
    exit 0
fi

if ! command -v freilauf-deploy >/dev/null 2>&1; then
    RESULT=pending REASON=no-deploy-tool
    merke "$REASON" "freilauf-deploy is not on the PATH — run setup/02-install-scripts.sh"
    log "freilauf-deploy not found — deploy pending"
    exit 0
fi

if [[ "$DRY" == 1 ]]; then
    RESULT=deployed REASON=dry-run
    log "would deploy $SHA now ($RELEVANT shipping file(s), no run active)"
    exit 0
fi

# Detached on purpose. A deploy is `npm ci`, a restart and a health check with up
# to 20 s of retrying; a hook that waited for it would freeze the operator's
# `git pull` — and, in the integration worktree, the hub's own merge loop.
rm -f "$MARKER" 2>/dev/null
log "$RELEVANT shipping file(s), no run active — deploying $SHA in the background"
setsid nohup freilauf-deploy --notify >>"$LOGFILE" 2>&1 </dev/null &
disown 2>/dev/null

RESULT=deployed REASON=started
exit 0
