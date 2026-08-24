#!/usr/bin/env bash
# 03-install-services.sh — systemd USER-Units für cc-hub (KEINE Admin-Rechte nötig).
# Installiert cchub.service (Hub, nur 127.0.0.1) und cchub-vpn.service (TLS-Proxy auf
# der eigenen WireGuard-Adresse). Der VPN-Zugang startet nach Reboot bewusst NICHT
# automatisch (fail-closed, Planung 4.8).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SYSTEMD_DIR="$HOME/.config/systemd/user"

echo "==> Konfiguration ~/.config/cc-hub/env"
# Ohne diese Datei scheitern beide Units: EnvironmentFile= ohne '-' ist Pflicht-Datei.
mkdir -p "$HOME/.config/cc-hub"
if [[ -f "$HOME/.config/cc-hub/env" ]]; then
    echo "    vorhanden — bleibt unverändert"
else
    install -m 600 "$ROOT/env.example" "$HOME/.config/cc-hub/env"
    echo "    aus env.example angelegt — ANPASSEN: mindestens CCHUB_VPN_BIND und"
    echo "    CCHUB_ALLOWED_HOSTS setzen, sonst startet der VPN-Proxy nicht."
fi

echo "==> Zertifikate (~/.local/certs/cc-hub: dev-cert.pem + dev-key.pem)"
mkdir -p "$HOME/.local/certs/cc-hub"
if [[ -f "$HOME/.local/certs/cc-hub/dev-cert.pem" && -f "$HOME/.local/certs/cc-hub/dev-key.pem" ]]; then
    echo "    vorhanden"
else
    cat <<'HINWEIS'
    FEHLEN NOCH — z. B. mit mkcert erzeugen (SANs: die VPN-IP und ggf. der Hostname
    aus CCHUB_ALLOWED_HOSTS):
      mkcert -cert-file ~/.local/certs/cc-hub/dev-cert.pem \
             -key-file  ~/.local/certs/cc-hub/dev-key.pem  <vpn-ip> [hostname]
      chmod 600 ~/.local/certs/cc-hub/*
HINWEIS
fi

echo "==> Run-/Worktree-Verzeichnisse anlegen"
mkdir -p "$HOME/agents/runs" "$HOME/agents/worktrees"

echo "==> User-Units installieren"
install -m 644 "$ROOT/deploy/cchub.service"     "$SYSTEMD_DIR/cchub.service"
install -m 644 "$ROOT/deploy/cchub-vpn.service" "$SYSTEMD_DIR/cchub-vpn.service"
systemctl --user daemon-reload

systemctl --user enable cchub.service >/dev/null   # Hub startet nach Reboot automatisch

echo "==> Starte Hub (Zugang bleibt aus — einschalten mit: cchub on)"
systemctl --user restart cchub.service
sleep 1
systemctl --user --no-pager status cchub.service | head -5 || true

cat <<'EOT'

Fertig — Status:  cchub status
Zugang freigeben: cchub on        (danach https://<vpn-ip>:<CCHUB_VPN_PORT> im Browser)
Firewall:         sudo ./setup/04-firewall.sh   (einmalig)
EOT
