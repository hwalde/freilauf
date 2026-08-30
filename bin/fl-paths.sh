# Freilauf — bash library: where things live, and which systemd unit runs the hub.
#
# The project was called cc-hub before this release, and an installation that
# has not run `setup/migrate-from-cc-hub.sh` yet still keeps its configuration
# in `~/.config/cc-hub`, its database in `~/.local/share/cc-hub` and its deploy
# checkout in `~/agents/deploy/cc-hub` — while systemd runs it as
# `cchub.service`. Every script in bin/ therefore asks THIS file instead of
# writing the fallback down again, which is what the counterpart on the server
# side (`server/env.mjs` + `server/paths.mjs`) does for the hub process.
#
# Sourced, not executed. No shebang, no `set -e`: it must not change the shell
# that reads it.

# ---------------------------------------------------------------- environment
# FREILAUF_<name>, else CCHUB_<name>, else the default. Written once here so a
# script never has to spell the old name out.
#   port="$(fl_env LOCAL_PORT 8791)"
fl_env() {
    local name="$1" default="${2:-}" neu alt
    neu="FREILAUF_$name"; alt="CCHUB_$name"
    if [[ -n "${!neu+x}" ]]; then printf '%s' "${!neu}"; return 0; fi
    if [[ -n "${!alt+x}" ]]; then printf '%s' "${!alt}"; return 0; fi
    printf '%s' "$default"
}

# ---------------------------------------------------------------- directories
# The new path when it exists, the old one when only that does, the new one
# otherwise — so a fresh installation never creates the old layout and a
# migrated one never looks back.
fl_pick_dir() {
    local neu="$1" alt="$2"
    if [[ -e "$neu" ]]; then printf '%s' "$neu"; return 0; fi
    if [[ -e "$alt" ]]; then printf '%s' "$alt"; return 0; fi
    printf '%s' "$neu"
}

fl_config_dir() {
    local base="${XDG_CONFIG_HOME:-$HOME/.config}"
    fl_pick_dir "$base/freilauf" "$base/cc-hub"
}

fl_data_dir() {
    local override base
    override="$(fl_env DATA_DIR)"
    [[ -n "$override" ]] && { printf '%s' "$override"; return 0; }
    base="${XDG_DATA_HOME:-$HOME/.local/share}"
    fl_pick_dir "$base/freilauf" "$base/cc-hub"
}

fl_deploy_dir() {
    local override
    override="$(fl_env DEPLOY_DIR)"
    [[ -n "$override" ]] && { printf '%s' "$override"; return 0; }
    fl_pick_dir "$HOME/agents/deploy/freilauf" "$HOME/agents/deploy/cc-hub"
}

# The database file. The directory may still be the old one; inside it the file
# may still carry the old name. Both are answered by the same rule.
fl_db_file() {
    local dir; dir="$(fl_data_dir)"
    fl_pick_dir "$dir/freilauf.db" "$dir/cc-hub.db"
}

fl_env_file() {
    local override; override="$(fl_env ENV_FILE)"
    [[ -n "$override" ]] && { printf '%s' "$override"; return 0; }
    printf '%s/env' "$(fl_config_dir)"
}

# ------------------------------------------------------------- systemd units
# Which unit really runs this hub. The migration installs and ENABLES
# `freilauf.service`; until it has run, `cchub.service` is the one that is
# actually up — and restarting anything else would leave the hub down. So the
# question is not which unit file exists (a deploy copies the new ones in long
# before the migration), it is which unit systemd is running or has been told
# to run.
fl__unit() {
    local neu="$1" alt="$2" s state
    command -v systemctl >/dev/null 2>&1 || { printf '%s' "$neu"; return 0; }
    for s in "$neu" "$alt"; do
        state="$(systemctl --user is-active "$s" 2>/dev/null || true)"
        case "$state" in active|activating|reloading) printf '%s' "$s"; return 0 ;; esac
    done
    for s in "$neu" "$alt"; do
        state="$(systemctl --user is-enabled "$s" 2>/dev/null || true)"
        case "$state" in enabled|enabled-runtime|static|linked) printf '%s' "$s"; return 0 ;; esac
    done
    printf '%s' "$neu"
}

# Asked at most once per process: two `systemctl is-active` calls are cheap but
# not free, and a script that only prints its help — or one that finds nothing to
# deploy — must not touch systemd at all.
FL_UNIT_CACHE=""
fl_unit() {
    [[ -n "$FL_UNIT_CACHE" ]] || FL_UNIT_CACHE="$(fl__unit freilauf.service cchub.service)"
    printf '%s' "$FL_UNIT_CACHE"
}

# The VPN unit follows the hub's family rather than being asked for itself: it
# is deliberately never enabled (fail-closed) and usually inactive, so asking it
# the same question would answer "the new one" on a machine that is still
# entirely old.
fl_vpn_unit() {
    case "$(fl_unit)" in
        cchub.service) printf 'cchub-vpn.service' ;;
        *)             printf 'freilauf-vpn.service' ;;
    esac
}

# The journal is addressed by unit name without the suffix.
fl_unit_short() { local u; u="$(fl_unit)"; printf '%s' "${u%.service}"; }
