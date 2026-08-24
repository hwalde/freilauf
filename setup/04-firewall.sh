#!/usr/bin/env bash
# 04-firewall.sh — ufw-Regeln für cc-hub (BENÖTIGT SUDO — einmalig ausführen).
# Schema: VPN-Port nur auf dem WireGuard-Interface (wg0) erlauben,
# alles andere auf dem Port explizit verbieten. Der lokale Hub-Port bleibt
# außen vor: er lauscht ohnehin nur auf 127.0.0.1.
set -euo pipefail

VPN_PORT="${CCHUB_VPN_PORT:-8790}"
VPN_BIND="${CCHUB_VPN_BIND:-}"

if [[ $EUID -ne 0 ]]; then
    echo "Bitte mit sudo ausführen:  sudo ./setup/04-firewall.sh" >&2
    exit 1
fi

echo "==> ufw: ${VPN_PORT}/tcp NUR auf wg0 (${VPN_BIND}) erlauben"
ufw allow in on wg0 to any port "$VPN_PORT" proto tcp comment 'cc-hub VPN-Zugang'

echo "==> ufw: ${VPN_PORT}/tcp überall sonst explizit VERBIETEN (Defense-in-depth)"
ufw deny in to any port "$VPN_PORT" proto tcp comment 'Block external cc-hub'

echo "==> ufw status (Auszug)"
ufw status numbered | grep -E "${VPN_PORT}|wg0" || true

cat <<EOF

Fertig. Erreichbarkeit prüfen (von einem VPN-Client):
    curl -k https://${VPN_BIND}:${VPN_PORT}/status-403-erwartet-bei-falschem-host

Wichtig: Der Hub selbst bindet nur an 127.0.0.1:${CCHUB_LOCAL_PORT:-8791} — ohne den
Proxy (cchub on) ist die Website von außen NICHT erreichbar, auch nicht über VPN.
EOF
