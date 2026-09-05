#!/usr/bin/env bash
# 03-install-services.sh — systemd USER units for Freilauf (NO admin rights required).
# Installs freilauf.service (hub, 127.0.0.1 only) and freilauf-vpn.service (TLS proxy on
# the machine's own WireGuard address). The VPN access deliberately does NOT start
# automatically after a reboot (fail-closed, Planung 4.8).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SYSTEMD_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
# shellcheck source=../bin/fl-paths.sh
. "$ROOT/bin/fl-paths.sh"

# An installation that still lives under the old name keeps its configuration
# where it is: `setup/migrate-from-cc-hub.sh` is what moves it, and running this
# script must not quietly create a second, empty config directory next to a
# working one.
CONFIG_DIR="$(fl_config_dir)"
CERT_DIR="$(fl_pick_dir "$HOME/.local/certs/freilauf" "$HOME/.local/certs/cc-hub")"

echo "==> Configuration $CONFIG_DIR/env"
# Without this file both units fail: EnvironmentFile= without '-' is a mandatory file.
mkdir -p "$CONFIG_DIR"
if [[ -f "$CONFIG_DIR/env" ]]; then
    echo "    exists — left unchanged"
else
    install -m 600 "$ROOT/env.example" "$CONFIG_DIR/env"
    echo "    created from env.example — ADJUST IT: set at least FREILAUF_VPN_BIND and"
    echo "    FREILAUF_ALLOWED_HOSTS, otherwise the VPN proxy will not start."
fi

echo "==> Certificates ($CERT_DIR: dev-cert.pem + dev-key.pem)"
mkdir -p "$CERT_DIR"
if [[ -f "$CERT_DIR/dev-cert.pem" && -f "$CERT_DIR/dev-key.pem" ]]; then
    echo "    present"
else
    cat <<HINWEIS
    STILL MISSING — create them e.g. with mkcert (SANs: the VPN IP and, if used,
    the hostname from FREILAUF_ALLOWED_HOSTS):
      mkcert -cert-file $CERT_DIR/dev-cert.pem \
             -key-file  $CERT_DIR/dev-key.pem  <vpn-ip> [hostname]
      chmod 600 $CERT_DIR/*
HINWEIS
fi

echo "==> Creating run/worktree directories"
mkdir -p "$HOME/agents/runs" "$HOME/agents/worktrees"

echo "==> Installing user units"
mkdir -p "$SYSTEMD_DIR"
install -m 644 "$ROOT/deploy/freilauf.service"      "$SYSTEMD_DIR/freilauf.service"
install -m 644 "$ROOT/deploy/freilauf-vpn.service"  "$SYSTEMD_DIR/freilauf-vpn.service"
install -m 644 "$ROOT/deploy/freilauf-tmux.service" "$SYSTEMD_DIR/freilauf-tmux.service"
systemctl --user daemon-reload

# The tmux server gets a unit of its own, whatever the hub's unit is called: a
# server spawned by the hub lives in the hub's cgroup, and a restart of the hub
# could then take every agent session with it. bin/fl-tmux-server waits for a
# server somebody else already spawned and adopts the socket when it exits, so
# enabling this on a running installation disturbs nothing.
echo "==> tmux server unit (freilauf-tmux.service)"
systemctl --user enable --now freilauf-tmux.service >/dev/null 2>&1 \
    && echo "    enabled and started" \
    || echo "    could not be enabled — agent sessions keep living wherever tmux was spawned"

# Without lingering, a user's systemd units start at the first LOGIN, not at
# boot — and a hub machine is exactly the machine nobody logs into after a
# reboot. `enable-linger` needs no root for one's own user.
echo "==> Lingering (units start at boot, not at first login)"
if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || true)" == yes ]]; then
    echo "    already on"
elif loginctl enable-linger "$USER" >/dev/null 2>&1; then
    echo "    enabled"
else
    echo "    could not be enabled — run: loginctl enable-linger $USER"
    echo "    (without it the hub and the tmux server only start when you log in after a reboot)"
fi

# Which unit really runs this hub. On a machine that has not been migrated yet
# that is still `cchub.service`, and enabling and starting the new one beside it
# would give the same database two hubs. `setup/migrate-from-cc-hub.sh` is the
# one step that hands the job over.
UNIT="$(fl_unit)"
if [[ "$UNIT" != "freilauf.service" ]]; then
    echo "    NOTE: this installation is still run by $UNIT (the old name)."
    echo "    The new unit files are in place; hand the job over with:"
    echo "        ./setup/migrate-from-cc-hub.sh --dry-run     # look first"
    echo "        ./setup/migrate-from-cc-hub.sh"
else
    systemctl --user enable freilauf.service >/dev/null   # hub starts automatically after reboot
fi

echo "==> Starting hub (access stays off — enable with: freilauf on)"
systemctl --user restart "$UNIT"
sleep 1
systemctl --user --no-pager status "$UNIT" | head -5 || true

cat <<'EOT'

Done — status:    freilauf status
Enable access:    freilauf on        (then https://<vpn-ip>:<FREILAUF_VPN_PORT> in the browser)
Firewall:         sudo ./setup/04-firewall.sh   (one-time)
EOT
