#!/usr/bin/env bash
# 03-install-services.sh — systemd USER units for cc-hub (NO admin rights required).
# Installs cchub.service (hub, 127.0.0.1 only) and cchub-vpn.service (TLS proxy on
# the machine's own WireGuard address). The VPN access deliberately does NOT start
# automatically after a reboot (fail-closed, Planung 4.8).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SYSTEMD_DIR="$HOME/.config/systemd/user"

echo "==> Configuration ~/.config/cc-hub/env"
# Without this file both units fail: EnvironmentFile= without '-' is a mandatory file.
mkdir -p "$HOME/.config/cc-hub"
if [[ -f "$HOME/.config/cc-hub/env" ]]; then
    echo "    exists — left unchanged"
else
    install -m 600 "$ROOT/env.example" "$HOME/.config/cc-hub/env"
    echo "    created from env.example — ADJUST IT: set at least CCHUB_VPN_BIND and"
    echo "    CCHUB_ALLOWED_HOSTS, otherwise the VPN proxy will not start."
fi

echo "==> Certificates (~/.local/certs/cc-hub: dev-cert.pem + dev-key.pem)"
mkdir -p "$HOME/.local/certs/cc-hub"
if [[ -f "$HOME/.local/certs/cc-hub/dev-cert.pem" && -f "$HOME/.local/certs/cc-hub/dev-key.pem" ]]; then
    echo "    present"
else
    cat <<'HINWEIS'
    STILL MISSING — create them e.g. with mkcert (SANs: the VPN IP and, if used,
    the hostname from CCHUB_ALLOWED_HOSTS):
      mkcert -cert-file ~/.local/certs/cc-hub/dev-cert.pem \
             -key-file  ~/.local/certs/cc-hub/dev-key.pem  <vpn-ip> [hostname]
      chmod 600 ~/.local/certs/cc-hub/*
HINWEIS
fi

echo "==> Creating run/worktree directories"
mkdir -p "$HOME/agents/runs" "$HOME/agents/worktrees"

echo "==> Installing user units"
install -m 644 "$ROOT/deploy/cchub.service"     "$SYSTEMD_DIR/cchub.service"
install -m 644 "$ROOT/deploy/cchub-vpn.service" "$SYSTEMD_DIR/cchub-vpn.service"
systemctl --user daemon-reload

systemctl --user enable cchub.service >/dev/null   # hub starts automatically after reboot

echo "==> Starting hub (access stays off — enable with: cchub on)"
systemctl --user restart cchub.service
sleep 1
systemctl --user --no-pager status cchub.service | head -5 || true

cat <<'EOT'

Done — status:    cchub status
Enable access:    cchub on        (then https://<vpn-ip>:<CCHUB_VPN_PORT> in the browser)
Firewall:         sudo ./setup/04-firewall.sh   (one-time)
EOT
