#!/usr/bin/env bash
# pruefe-vor-push.sh — checks the versioned files for values that must never become
# public. Runs manually and as a pre-push hook (setup/02 installs it).
#
# Two pattern sources:
#   1. Generic patterns here in the script (private IPs, key formats, home paths).
#   2. ~/.config/cc-hub/verbotene-muster — one regex per line, '#' = comment.
#      Deliberately OUTSIDE the repo: the patterns describe exactly the values that
#      do not belong in the repo, and therefore must not appear in it themselves.
set -uo pipefail
cd "$(dirname "$0")"

MUSTER=(
    '10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}'            # private IPv4 (incl. VPN)
    '192\.168\.[0-9]{1,3}\.[0-9]{1,3}'
    '172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3}'
    '/home/[a-z][a-z0-9]*'                               # real home paths
    'sk-[A-Za-z0-9_-]{20,}'                              # API keys (OpenAI style)
    'sk-ant-[A-Za-z0-9_-]{10,}'                          # Anthropic
    'gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}'
    'AKIA[0-9A-Z]{16}'                                   # AWS
    'xox[baprs]-[A-Za-z0-9-]{10,}'                       # Slack
    '[0-9]{8,10}:[A-Za-z0-9_-]{35}'                      # Telegram bot tokens
    '-----BEGIN( [A-Z]+)? PRIVATE KEY-----'
    '@(gmail|googlemail|gmx|web)\.'                      # private email addresses
)
if [[ -f "$HOME/.config/cc-hub/verbotene-muster" ]]; then
    while IFS= read -r zeile; do
        [[ -z "$zeile" || "$zeile" == \#* ]] && continue
        MUSTER+=("$zeile")
    done < "$HOME/.config/cc-hub/verbotene-muster"
else
    echo "NOTE: ~/.config/cc-hub/verbotene-muster is missing — only the generic patterns apply." >&2
fi

# What is checked is the committed state (HEAD), not the working tree: that is what a
# push would publish. This script excludes itself (it describes the patterns).
BAUM="HEAD"
git rev-parse -q --verify HEAD >/dev/null || BAUM=""   # before the first commit: the index

FUND=0
for m in "${MUSTER[@]}"; do
    if TREFFER="$(git grep -InE "$m" $BAUM -- . ':(exclude)pruefe-vor-push.sh' 2>/dev/null)" && [[ -n "$TREFFER" ]]; then
        echo "FORBIDDEN PATTERN: $m"
        echo "$TREFFER" | head -10
        echo
        FUND=1
    fi
done

if (( FUND )); then
    echo "ABORT: private values found in the committed state — do not push." >&2
    exit 1
fi
echo "OK: no forbidden patterns in the committed state."
