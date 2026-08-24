#!/usr/bin/env bash
# pruefe-vor-push.sh — prüft die versionierten Dateien auf Werte, die nie öffentlich
# werden dürfen. Läuft von Hand und als pre-push-Hook (setup/02 installiert ihn).
#
# Zwei Musterquellen:
#   1. Generische Muster hier im Skript (private IPs, Key-Formate, Heimatpfade).
#   2. ~/.config/cc-hub/verbotene-muster — eine Regex je Zeile, '#' = Kommentar.
#      Bewusst AUSSERHALB des Repos: die Muster beschreiben genau die Werte, die
#      nicht ins Repo gehören, und dürfen deshalb selbst nicht darin stehen.
set -uo pipefail
cd "$(dirname "$0")"

MUSTER=(
    '10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}'            # private IPv4 (u. a. VPN)
    '192\.168\.[0-9]{1,3}\.[0-9]{1,3}'
    '172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3}'
    '/home/[a-z][a-z0-9]*'                               # echte Heimatpfade
    'sk-[A-Za-z0-9_-]{20,}'                              # API-Keys (OpenAI-Stil)
    'sk-ant-[A-Za-z0-9_-]{10,}'                          # Anthropic
    'gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}'
    'AKIA[0-9A-Z]{16}'                                   # AWS
    'xox[baprs]-[A-Za-z0-9-]{10,}'                       # Slack
    '[0-9]{8,10}:[A-Za-z0-9_-]{35}'                      # Telegram-Bot-Token
    '-----BEGIN( [A-Z]+)? PRIVATE KEY-----'
    '@(gmail|googlemail|gmx|web)\.'                      # private Mail-Adressen
)
if [[ -f "$HOME/.config/cc-hub/verbotene-muster" ]]; then
    while IFS= read -r zeile; do
        [[ -z "$zeile" || "$zeile" == \#* ]] && continue
        MUSTER+=("$zeile")
    done < "$HOME/.config/cc-hub/verbotene-muster"
else
    echo "HINWEIS: ~/.config/cc-hub/verbotene-muster fehlt — es gelten nur die generischen Muster." >&2
fi

# Geprüft wird der Commit-Stand (HEAD), nicht der Arbeitsbaum: das ist, was ein Push
# veröffentlichen würde. Dieses Skript nimmt sich selbst aus (es beschreibt die Muster).
BAUM="HEAD"
git rev-parse -q --verify HEAD >/dev/null || BAUM=""   # vor dem ersten Commit: Index

FUND=0
for m in "${MUSTER[@]}"; do
    if TREFFER="$(git grep -InE "$m" $BAUM -- . ':(exclude)pruefe-vor-push.sh' 2>/dev/null)" && [[ -n "$TREFFER" ]]; then
        echo "VERBOTENES MUSTER: $m"
        echo "$TREFFER" | head -10
        echo
        FUND=1
    fi
done

if (( FUND )); then
    echo "ABBRUCH: private Werte im Commit-Stand gefunden — nicht pushen." >&2
    exit 1
fi
echo "OK: keine verbotenen Muster im Commit-Stand."
