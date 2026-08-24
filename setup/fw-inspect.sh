#!/usr/bin/env bash
# fw-inspect.sh — READ-ONLY firewall inventory (run with sudo).
# Collects everything about the existing ufw configuration so it can be reviewed
# BEFORE the cc-hub rules are applied (04-firewall.sh):
#   sudo ./setup/fw-inspect.sh
# Changes NOTHING. The output can be handed back to the agent 1:1.
set -uo pipefail

VPN_PORT="${CCHUB_VPN_PORT:-8790}"
LOCAL_PORT="${CCHUB_LOCAL_PORT:-8791}"

line() { printf '\n========== %s ==========\n' "$1"; }

if [[ $EUID -ne 0 ]]; then
    echo "Please run with sudo:  sudo ./setup/fw-inspect.sh" >&2
    exit 1
fi

line "1. SYSTEM"
uname -r
command -v ufw && ufw version

line "2. UFW STATUS VERBOSE"
ufw status verbose

line "3. UFW STATUS NUMBERED (order matters!)"
ufw status numbered

line "4. ALL RULES WITH COMMENTS"
ufw status | grep -E '^\S|ALLOW|DENY|LIMIT|REJECT' || true

line "5. DEFAULT POLICIES"
ufw default 2>&1 | head -1 || true
grep -E '^(DEFAULT_INPUT_POLICY|DEFAULT_OUTPUT_POLICY|DEFAULT_FORWARD_POLICY|DEFAULT_APPLICATION_POLICY)' /etc/default/ufw || true

line "6. RAW RULES /etc/ufw/user.rules (IPv4+IPv6)"
grep -E 'ufw-(user|before|after)-(input|output|forward)' -A1 /etc/ufw/user.rules 2>/dev/null | head -80 || cat /etc/ufw/user.rules 2>/dev/null | head -120

line "7. USER6.RULES (quick check whether the IPv6 mirror exists)"
# ufw writes one '### tuple ###' line per rule — NOT '<rule>' (that would be ufw frontend XML).
grep -E '^(IPV6|DEFAULT_)' /etc/default/ufw 2>/dev/null | grep '^IPV6' || echo "IPV6 not set"
printf 'Rules in user6.rules: %s\n' "$(grep -c '### tuple ###' /etc/ufw/user6.rules 2>/dev/null || echo 0)"

line "8. INTERFACE wg0 (WireGuard)"
ip -br addr show wg0 2>/dev/null || echo "wg0 DOES NOT EXIST"

line "9. LISTENING PORTS (relevant to cc-hub)"
ss -tlnp | grep -E ":(${VPN_PORT}|${LOCAL_PORT})\\b" || echo "no matches for ${VPN_PORT}/${LOCAL_PORT}"

line "10. EXISTING RULES FOR THESE PORTS (incl. comments)"
ufw status numbered | grep -E "${VPN_PORT}|${LOCAL_PORT}" || echo "no rules yet for ${VPN_PORT}/${LOCAL_PORT}"

line "11. IPTABLES BACKEND"
update-alternatives --display iptables 2>/dev/null | grep -E 'link currently points|best version' || true
grep -E '^IPT_BACKEND' /etc/default/ufw 2>/dev/null || true
iptables --version

line "12. PREVIEW: what 04-firewall.sh WOULD add (not executed!)"
cat <<EOF
  ufw allow in on wg0 to any port $VPN_PORT proto tcp comment 'cc-hub VPN-Zugang'
  ufw deny in to any port $VPN_PORT proto tcp
EOF
echo
echo "NOTE: order is decisive — ufw evaluates the FIRST matching rule."
echo "So the deny may come AFTER the allow (ufw automatically sorts allow-in-on-interface"
echo "before a generic deny correctly; we verify that against the numbered list)."

line "DONE"
echo "Please hand this complete output back to the agent."
