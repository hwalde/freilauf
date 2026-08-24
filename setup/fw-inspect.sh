#!/usr/bin/env bash
# fw-inspect.sh — READ-ONLY Firewall-Bestandsaufnahme (mit sudo ausführen).
# Sammelt alles über die bestehende ufw-Konfiguration, damit VOR dem Setzen der
# cc-hub-Regeln (04-firewall.sh) geprüft werden kann:
#   sudo ./setup/fw-inspect.sh
# Ändert NICHTS. Die Ausgabe kann 1:1 zurück an den Agenten gegeben werden.
set -uo pipefail

VPN_PORT="${CCHUB_VPN_PORT:-8790}"
LOCAL_PORT="${CCHUB_LOCAL_PORT:-8791}"

line() { printf '\n========== %s ==========\n' "$1"; }

if [[ $EUID -ne 0 ]]; then
    echo "Bitte mit sudo ausführen:  sudo ./setup/fw-inspect.sh" >&2
    exit 1
fi

line "1. SYSTEM"
uname -r
command -v ufw && ufw version

line "2. UFW STATUS VERBOSE"
ufw status verbose

line "3. UFW STATUS NUMBERED (Reihenfolge zählt!)"
ufw status numbered

line "4. ALLE REGELN MIT KOMMENTAR"
ufw status | grep -E '^\S|ALLOW|DENY|LIMIT|REJECT' || true

line "5. DEFAULT POLICIES"
ufw default 2>&1 | head -1 || true
grep -E '^(DEFAULT_INPUT_POLICY|DEFAULT_OUTPUT_POLICY|DEFAULT_FORWARD_POLICY|DEFAULT_APPLICATION_POLICY)' /etc/default/ufw || true

line "6. ROH-REGELN /etc/ufw/user.rules (IPv4+IPv6)"
grep -E 'ufw-(user|before|after)-(input|output|forward)' -A1 /etc/ufw/user.rules 2>/dev/null | head -80 || cat /etc/ufw/user.rules 2>/dev/null | head -120

line "7. USER6.RULES (Kurzcheck ob IPv6-Spiegel existiert)"
# ufw schreibt je Regel eine '### tuple ###'-Zeile — NICHT '<rule>' (das wäre ufw-Frontend-XML).
grep -E '^(IPV6|DEFAULT_)' /etc/default/ufw 2>/dev/null | grep '^IPV6' || echo "IPV6 nicht gesetzt"
printf 'Regeln in user6.rules: %s\n' "$(grep -c '### tuple ###' /etc/ufw/user6.rules 2>/dev/null || echo 0)"

line "8. INTERFACE wg0 (WireGuard)"
ip -br addr show wg0 2>/dev/null || echo "wg0 EXISTIERT NICHT"

line "9. LAUSCHENDE PORTE (cc-hub relevant)"
ss -tlnp | grep -E ":(${VPN_PORT}|${LOCAL_PORT})\\b" || echo "keine Treffer für ${VPN_PORT}/${LOCAL_PORT}"

line "10. BESTEHENDE REGELN FÜR DIESE PORTE (inkl. Kommentare)"
ufw status numbered | grep -E "${VPN_PORT}|${LOCAL_PORT}" || echo "noch keine Regeln für ${VPN_PORT}/${LOCAL_PORT}"

line "11. IPTABLES BACKEND"
update-alternatives --display iptables 2>/dev/null | grep -E 'link currently points|best version' || true
grep -E '^IPT_BACKEND' /etc/default/ufw 2>/dev/null || true
iptables --version

line "12. VORSCHAU: Was 04-firewall.sh hinzufügen WÜRDE (nicht ausgeführt!)"
cat <<EOF
  ufw allow in on wg0 to any port $VPN_PORT proto tcp comment 'cc-hub VPN-Zugang'
  ufw deny in to any port $VPN_PORT proto tcp
EOF
echo
echo "HINWEIS: Reihenfolge ist entscheidend — ufw wertet die ERSTE passende Regel aus."
echo "Das deny darf also NACH dem allow stehen (ufw sortiert allow-in-on-interface vor"
echo "generisches deny automatisch korrekt ein; das prüfen wir gegen die Nummern-Liste)."

line "FERTIG"
echo "Diese komplette Ausgabe bitte zurück an den Agenten geben."
