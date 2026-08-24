#!/usr/bin/env bash
# 04-firewall.sh — ufw rules for cc-hub (REQUIRES SUDO — run once).
# Scheme: allow the VPN port only on the WireGuard interface (wg0),
# explicitly deny everything else on that port. The local hub port is left
# out: it only listens on 127.0.0.1 anyway.
set -euo pipefail

VPN_PORT="${CCHUB_VPN_PORT:-8790}"
VPN_BIND="${CCHUB_VPN_BIND:-}"

if [[ $EUID -ne 0 ]]; then
    echo "Please run with sudo:  sudo ./setup/04-firewall.sh" >&2
    exit 1
fi

echo "==> ufw: allow ${VPN_PORT}/tcp ONLY on wg0 (${VPN_BIND})"
ufw allow in on wg0 to any port "$VPN_PORT" proto tcp comment 'cc-hub VPN-Zugang'

echo "==> ufw: explicitly DENY ${VPN_PORT}/tcp everywhere else (defense in depth)"
ufw deny in to any port "$VPN_PORT" proto tcp comment 'Block external cc-hub'

echo "==> ufw status (excerpt)"
ufw status numbered | grep -E "${VPN_PORT}|wg0" || true

cat <<EOF

Done. Verify reachability (from a VPN client):
    curl -k https://${VPN_BIND}:${VPN_PORT}/status-403-expected-for-wrong-host

Important: the hub itself binds only to 127.0.0.1:${CCHUB_LOCAL_PORT:-8791} — without
the proxy (cchub on) the website is NOT reachable from outside, not even via VPN.
EOF
