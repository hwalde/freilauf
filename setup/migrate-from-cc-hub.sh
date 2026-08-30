#!/usr/bin/env bash
# migrate-from-cc-hub.sh — move an installation from the old name (cc-hub) to
# this one (Freilauf). Also reachable as `freilauf-deploy --migrate`.
#
# The code released under the new name deliberately RUNS in the old layout: the
# server resolves every path new-then-old (server/paths.mjs), every environment
# variable FREILAUF_X-then-CCHUB_X (server/env.mjs), the shell scripts do the
# same through bin/fl-paths.sh, `~/.local/bin` keeps a shim under every old
# script name, and the deploy script restarts whichever unit is really running.
# Nothing forces this migration, and nothing breaks while it is postponed.
#
# What it does — every step guarded, so running it twice is a no-op:
#
#   1. stop cchub-vpn.service and cchub.service (remembering whether the VPN was on)
#   2. ~/.config/cc-hub          -> ~/.config/freilauf        (CCHUB_ -> FREILAUF_ in `env`)
#   3. ~/.local/share/cc-hub     -> ~/.local/share/freilauf   (cc-hub.db -> freilauf.db)
#   4. ~/agents/deploy/cc-hub    -> ~/agents/deploy/freilauf  (+ the deploy log,
#                                   + `origin` to github.com/hwalde/freilauf)
#   5. install + enable freilauf.service, disable + remove the old unit files
#   6. rewrite `cchub-deploy` / `cchub*.service` inside stored flow definitions
#   7. remove ~/.config/opencode/plugins/cc-hub.js and re-run 02-install-scripts.sh
#   8. start the hub again, and the VPN proxy if it was on
#
# Untouched on purpose: ~/agents/runs, ~/agents/worktrees, ~/agents/integrate and
# ~/agents/zusaetze (never named after the product), and the hub's own `repos`
# row called `cc-hub` — that row is the operator's checkout, and its name and
# path are theirs to change.
#
#   --dry-run   print every step, change nothing
#   -h|--help   this text
set -uo pipefail

DRY=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run) DRY=1 ;;
        -h|--help) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) printf 'unknown option: %s (try --help)\n' "$1" >&2; exit 2 ;;
    esac
    shift
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_ALT="${XDG_CONFIG_HOME:-$HOME/.config}/cc-hub"
CONFIG_NEU="${XDG_CONFIG_HOME:-$HOME/.config}/freilauf"
DATA_ALT="${XDG_DATA_HOME:-$HOME/.local/share}/cc-hub"
DATA_NEU="${XDG_DATA_HOME:-$HOME/.local/share}/freilauf"
DEPLOY_ALT="$HOME/agents/deploy/cc-hub"
DEPLOY_NEU="$HOME/agents/deploy/freilauf"
SYSTEMD_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
REPO_URL_PATH_ALT="hwalde/cc-hub"
REPO_URL_PATH_NEU="hwalde/freilauf"

SCHRITT=0
NOTIZEN=()

say()  { printf '%s\n' "$*"; }
step() { SCHRITT=$((SCHRITT + 1)); printf '\n[%d] %s\n' "$SCHRITT" "$*"; }
info() { printf '    %s\n' "$*"; }
note() { NOTIZEN+=("$*"); }

# Every change goes through here, so --dry-run is one rule and not thirty.
run() {
    if [[ $DRY == 1 ]]; then printf '    would: %s\n' "$*"; return 0; fi
    printf '    %s\n' "$*"
    "$@"
}

# systemctl is only asked when it is there — the migration has to be runnable
# (and testable) on a machine without a user session bus.
sc() {
    command -v systemctl >/dev/null 2>&1 || { info "no systemctl — skipping: systemctl --user $*"; return 0; }
    run systemctl --user "$@" || true
}
unit_active() {
    command -v systemctl >/dev/null 2>&1 || return 1
    [[ "$(systemctl --user is-active "$1" 2>/dev/null || true)" == active ]]
}

if [[ $DRY == 1 ]]; then
    say "DRY RUN — nothing is changed."
fi
say "Freilauf migration (cc-hub -> Freilauf), repository root: $ROOT"

# ------------------------------------------------------------------ 1. stop
step "Stop the old services"
VPN_WAR_AN=0
if unit_active cchub-vpn.service; then VPN_WAR_AN=1; info "cchub-vpn.service is active — access will be switched on again at the end"; fi
if unit_active cchub-vpn.service || unit_active cchub.service; then
    sc stop cchub-vpn.service
    sc stop cchub.service
else
    info "neither cchub.service nor cchub-vpn.service is active — nothing to stop"
fi

# ------------------------------------------------------- a directory, moved once
# Idempotent in both directions: nothing there is done, both there is refused
# rather than merged — two configuration directories is a state a script must
# not resolve on the operator's behalf.
verschiebe() {
    local was="$1" alt="$2" neu="$3"
    if [[ -e "$neu" && -e "$alt" ]]; then
        info "BOTH $alt and $neu exist — not touching either."
        note "$was: $alt and $neu both exist. Decide which one is real, remove the other, then run this again."
        return 1
    fi
    if [[ -e "$neu" ]]; then info "already at $neu"; return 1; fi
    if [[ ! -e "$alt" ]]; then info "nothing at $alt — nothing to move"; return 1; fi
    run mkdir -p "$(dirname "$neu")"
    run mv "$alt" "$neu" || return 1
    return 0
}

# ------------------------------------------------------------------ 2. config
step "Configuration: $CONFIG_ALT -> $CONFIG_NEU"
if verschiebe "configuration directory" "$CONFIG_ALT" "$CONFIG_NEU"; then
    info "moved (env, coding-agents.json, verbotene-muster and everything else came with it)"
fi
# The variable names inside `env`, and ONLY those: everything else in that file
# stays byte for byte what it was. Both names work either way (server/env.mjs),
# so this is tidiness rather than repair — but a file nobody ever rewrites is a
# file that still says CCHUB_ in five years.
if [[ -f "$CONFIG_NEU/env" ]]; then
    if grep -q '^[[:space:]]*CCHUB_' "$CONFIG_NEU/env" 2>/dev/null; then
        if [[ $DRY == 1 ]]; then
            info "would: rewrite CCHUB_ -> FREILAUF_ in $CONFIG_NEU/env ($(grep -c '^[[:space:]]*CCHUB_' "$CONFIG_NEU/env") line(s))"
        else
            cp -p "$CONFIG_NEU/env" "$CONFIG_NEU/env.bak-cc-hub"
            sed -i 's/^\([[:space:]]*\)CCHUB_CC_START=/\1FREILAUF_START_SCRIPT=/; s/^\([[:space:]]*\)CCHUB_CC_REPORT=/\1FREILAUF_REPORT_SCRIPT=/; s/^\([[:space:]]*\)CCHUB_/\1FREILAUF_/' "$CONFIG_NEU/env"
            info "rewrote CCHUB_ -> FREILAUF_ in $CONFIG_NEU/env (backup: env.bak-cc-hub)"
        fi
    else
        info "no CCHUB_ keys in $CONFIG_NEU/env"
    fi
fi

# ------------------------------------------------------------------ 3. data
step "Data: $DATA_ALT -> $DATA_NEU"
verschiebe "data directory" "$DATA_ALT" "$DATA_NEU" >/dev/null
# The database and its WAL companions. Renamed rather than left alone because
# `freilauf.db` is what a fresh installation creates, and one name is one thing
# to look for.
if [[ -f "$DATA_NEU/cc-hub.db" && ! -f "$DATA_NEU/freilauf.db" ]]; then
    for suffix in "" "-wal" "-shm"; do
        [[ -f "$DATA_NEU/cc-hub.db$suffix" ]] && run mv "$DATA_NEU/cc-hub.db$suffix" "$DATA_NEU/freilauf.db$suffix"
    done
    info "database renamed to freilauf.db"
elif [[ -f "$DATA_NEU/freilauf.db" ]]; then
    info "database is already called freilauf.db"
fi

# ------------------------------------------------------------------ 4. deploy
step "Deploy checkout: $DEPLOY_ALT -> $DEPLOY_NEU"
IN_DEPLOY=0
[[ "$ROOT" == "$DEPLOY_ALT" ]] && IN_DEPLOY=1
verschiebe "deploy checkout" "$DEPLOY_ALT" "$DEPLOY_NEU" >/dev/null
# This script may BE the one in the checkout that was just moved (that is what
# `freilauf-deploy --migrate` does). The open file survives a rename, but every
# path derived from it does not.
if [[ $IN_DEPLOY == 1 && -d "$DEPLOY_NEU" && $DRY == 0 ]]; then
    ROOT="$DEPLOY_NEU"
    info "this script came from the deploy checkout — continuing from $ROOT"
fi
# The deploy log lives NEXT TO the checkout, not inside it.
if [[ -f "$HOME/agents/deploy/cc-hub-deploy.log" ]]; then
    if [[ -f "$HOME/agents/deploy/freilauf-deploy.log" ]]; then
        info "both deploy logs exist — appending the old one to the new one"
        if [[ $DRY == 1 ]]; then info "would: cat cc-hub-deploy.log >> freilauf-deploy.log && rm cc-hub-deploy.log"
        else
            cat "$HOME/agents/deploy/cc-hub-deploy.log" >> "$HOME/agents/deploy/freilauf-deploy.log" \
                && rm -f "$HOME/agents/deploy/cc-hub-deploy.log"
        fi
    else
        run mv "$HOME/agents/deploy/cc-hub-deploy.log" "$HOME/agents/deploy/freilauf-deploy.log"
    fi
fi
# The GitHub repository was renamed too. Only the deploy checkout is ours to
# repoint — the operator's own working copy is theirs, and it gets a printed
# command instead. The scheme (https or ssh) is whatever was configured.
if [[ -d "$DEPLOY_NEU/.git" ]] && command -v git >/dev/null 2>&1; then
    ORIGIN_URL="$(git -C "$DEPLOY_NEU" remote get-url origin 2>/dev/null || true)"
    if [[ "$ORIGIN_URL" == *"$REPO_URL_PATH_ALT"* ]]; then
        run git -C "$DEPLOY_NEU" remote set-url origin "${ORIGIN_URL//$REPO_URL_PATH_ALT/$REPO_URL_PATH_NEU}"
        info "origin now points at ${ORIGIN_URL//$REPO_URL_PATH_ALT/$REPO_URL_PATH_NEU}"
    elif [[ -n "$ORIGIN_URL" ]]; then
        info "origin is $ORIGIN_URL — left alone"
    fi
fi

# ------------------------------------------------------------------ 5. units
step "systemd units"
if [[ -d "$ROOT/deploy" ]]; then
    run mkdir -p "$SYSTEMD_DIR"
    for f in "$ROOT"/deploy/*.service; do
        [[ -f "$f" ]] || continue
        run install -m 644 "$f" "$SYSTEMD_DIR/$(basename "$f")"
    done
else
    info "WARNING: $ROOT/deploy does not exist — no unit files installed"
    note "The unit files could not be installed from $ROOT/deploy. Run setup/03-install-services.sh from a checkout."
fi
sc disable cchub-vpn.service
sc disable cchub.service
for f in cchub.service cchub-vpn.service; do
    [[ -f "$SYSTEMD_DIR/$f" ]] && run rm -f "$SYSTEMD_DIR/$f"
done
sc daemon-reload
sc enable freilauf.service

# ------------------------------------------------------------------ 6. flows
# Best effort, and it has to be: a flow's command is free text an operator wrote,
# the DB may be busy, node's sqlite is experimental. Nothing here is worth
# failing a migration over — and the `cchub-deploy` shim keeps such a flow
# working either way.
step "Stored flows: cchub-deploy -> freilauf-deploy"
DB_FILE="$DATA_NEU/freilauf.db"
[[ -f "$DB_FILE" ]] || DB_FILE="$DATA_NEU/cc-hub.db"
if [[ -f "$DB_FILE" ]] && command -v node >/dev/null 2>&1; then
    if [[ $DRY == 1 ]]; then
        info "would: rewrite cchub-deploy / cchub*.service inside flows.definition in $DB_FILE"
    else
        node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite")
const db = new DatabaseSync(process.argv[1])
const swap = (s) => String(s ?? "")
  .replaceAll("cchub-deploy", "freilauf-deploy")
  .replaceAll("cchub-vpn.service", "freilauf-vpn.service")
  .replaceAll("cchub.service", "freilauf.service")
let n = 0
try {
  for (const row of db.prepare("SELECT id, name, definition FROM flows").all()) {
    const def = swap(row.definition)
    const name = row.name.includes("cc-hub") ? row.name.replaceAll("cc-hub", "Freilauf") : row.name
    if (def === row.definition && name === row.name) continue
    try { db.prepare("UPDATE flows SET definition=?, name=? WHERE id=?").run(def, name, row.id) }
    // A renamed flow can collide with an existing name (flows.name is UNIQUE).
    // The command is what matters; the label is cosmetic.
    catch { db.prepare("UPDATE flows SET definition=? WHERE id=?").run(def, row.id) }
    n++
  }
} catch (e) { process.stdout.write("flows not rewritten: " + e.message + "\n"); process.exit(0) }
process.stdout.write(n + " flow(s) rewritten\n")' "$DB_FILE" 2>/dev/null | sed 's/^/    /' \
        || info "flows could not be rewritten (best effort) — the cchub-deploy shim keeps them working"
    fi
else
    info "no database or no node — skipped"
fi

# ------------------------------------------------------- 7. scripts and plugin
step "Scripts in ~/.local/bin and the opencode plugin"
# opencode loads EVERY file in its plugin directory, so leaving the old one
# there would report every idle and every API error twice.
if [[ -f "$HOME/.config/opencode/plugins/cc-hub.js" ]]; then
    run rm -f "$HOME/.config/opencode/plugins/cc-hub.js"
else
    info "no old opencode plugin at ~/.config/opencode/plugins/cc-hub.js"
fi
if [[ -x "$ROOT/setup/02-install-scripts.sh" || -f "$ROOT/setup/02-install-scripts.sh" ]]; then
    if [[ $DRY == 1 ]]; then
        info "would: bash $ROOT/setup/02-install-scripts.sh  (fl-* scripts, libraries, old-name shims, opencode plugin)"
    else
        bash "$ROOT/setup/02-install-scripts.sh" | sed 's/^/    /' || \
            note "setup/02-install-scripts.sh failed — run it by hand."
    fi
else
    info "WARNING: $ROOT/setup/02-install-scripts.sh not found"
    note "Run setup/02-install-scripts.sh from a checkout so ~/.local/bin holds the fl-* scripts."
fi

# ------------------------------------------------------------------ 8. start
step "Start the hub again"
sc start freilauf.service
if [[ $VPN_WAR_AN == 1 ]]; then
    info "access was on before the migration"
    sc start freilauf-vpn.service
else
    info "access was off — leaving it off (fail-closed; switch on with: freilauf on)"
fi

# ------------------------------------------------------------------ what is left
note "Your own checkout is yours: if it still sits in ~/projects/cc-hub, move it and repoint its remote — git -C <checkout> remote set-url origin https://github.com/hwalde/freilauf.git"
note "~/agents/worktrees/cc-hub is named after the REPOSITORY row, not the product. The hub does not rename that row; if you rename the repo in the UI, new worktrees follow the new name."
note "The private pattern file for pruefe-vor-push.sh moved with the configuration directory (now <config>/verbotene-muster). If it is versioned in a private sister repo, that repo keeps its own name."
note "TLS certificates are still read from ~/.local/certs/cc-hub when that is what exists. Move them to ~/.local/certs/freilauf whenever you like — or set FREILAUF_CERT_DIR."
note "The old script names (cc-start, cc-report, cchub, …) stay installed as shims for one release, so runs that were in flight keep working. A later commit removes them."

printf '\n%s\n' "----------------------------------------------------------------"
if [[ $DRY == 1 ]]; then
    say "DRY RUN finished — nothing was changed. Run without --dry-run to do it."
else
    say "Migration finished. Check with:  freilauf status"
fi
say ""
say "Still yours to decide:"
for n in "${NOTIZEN[@]}"; do printf '  - %s\n' "$n"; done
