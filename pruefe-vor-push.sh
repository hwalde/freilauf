#!/usr/bin/env bash
# pruefe-vor-push.sh — checks the versioned files for values that must never become
# public. Runs manually and as a pre-push hook (setup/02 installs it).
#
# Two pattern sources:
#   1. Generic patterns here in the script (private IPs, key formats, home paths).
#   2. <config>/verbotene-muster — one regex per line, '#' = comment.
#      <config> is ~/.config/freilauf, or ~/.config/cc-hub while an installation
#      still lives under the old name (bin/fl-paths.sh answers which).
#      Deliberately OUTSIDE the repo: the patterns describe exactly the values that
#      do not belong in the repo, and therefore must not appear in it themselves.
set -uo pipefail
# Where this script really lives — NOT `dirname "$0"`. setup/02 installs it as a
# SYMLINK at .git/hooks/pre-push, and for a symlinked hook `$0` is the link, so
# `dirname` answered `.git/hooks`: the `. bin/fl-paths.sh` below failed, the
# private pattern file was never loaded, and `git grep -- .` scanned a pathspec
# outside the work tree. The hook then printed "OK: no forbidden patterns" and
# exited 0 while checking essentially nothing — a false green on the one guard
# that keeps this repository's private values out of a public push (measured
# 2026-09-04). `readlink -f` resolves the link, so the hook and a manual run
# both land in the checkout.
WURZEL="$(dirname "$(readlink -f "$0")")"
cd "$WURZEL"

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
# shellcheck source=bin/fl-paths.sh
. "$WURZEL/bin/fl-paths.sh"
MUSTERDATEI="$(fl_config_dir)/verbotene-muster"
if [[ -f "$MUSTERDATEI" ]]; then
    while IFS= read -r zeile; do
        [[ -z "$zeile" || "$zeile" == \#* ]] && continue
        MUSTER+=("$zeile")
    done < "$MUSTERDATEI"
else
    echo "NOTE: $MUSTERDATEI is missing — only the generic patterns apply." >&2
fi

# What is checked is the committed state (HEAD), not the working tree: that is what a
# push would publish. This script excludes itself (it describes the patterns).
BAUM="HEAD"
git rev-parse -q --verify HEAD >/dev/null || BAUM=""   # before the first commit: the index

# Exceptions, and why they are shaped the way they are.
#
# Some of the generic patterns above legitimately occur in public code. The
# SSRF fence in server/sandbox/proxy.mjs must NAME the RFC 1918 ranges in order
# to refuse them, and the sandbox images must name the container's own home —
# `/home/agent` is a path inside a container image, not anybody's home.
# Rewriting those to slip past a regex would be obfuscation: the constant is
# the point, and a reader of that file should see the range it blocks.
#
# So exceptions exist, and three rules keep them from becoming the hole the
# whole script is here to prevent:
#   1. an exception names a FILE and an EXACT string, never a pattern to switch
#      off — it can excuse `10.0.0.0/8` in one file and still catch this
#      installation's `10.0.0.1` in the same line;
#   2. every excused hit is PRINTED. The one failure this script has already
#      had was a false green (see the header), so an exception that hid its own
#      work would be the same bug wearing a different hat;
#   3. the file lives IN the repo and is reviewed like code. It may only ever
#      hold values that are safe to publish — which is exactly why an
#      installation's private values stay in the file outside the repo.
AUSNAHMEN="$WURZEL/pruefe-ausnahmen.txt"
declare -a AUSNAHME_PFAD=() AUSNAHME_TEXT=()
if [[ -f "$AUSNAHMEN" ]]; then
    while IFS=$'\t' read -r pfad text _rest; do
        [[ -z "${pfad:-}" || "$pfad" == \#* ]] && continue
        [[ -z "${text:-}" ]] && continue
        AUSNAHME_PFAD+=("$pfad")
        AUSNAHME_TEXT+=("$text")
    done < "$AUSNAHMEN"
fi

# Is this one `path:line:content` hit excused? Both halves must match: the file
# against the glob, and the content must CONTAIN the exact excused string.
entschuldigt() {
    local treffer="$1" datei inhalt i
    datei="${treffer#*:}"; datei="${treffer%%:*}"
    # `HEAD:path:line:content` when scanning a commit, `path:line:content` otherwise.
    [[ "$treffer" == HEAD:* ]] && treffer="${treffer#HEAD:}"
    datei="${treffer%%:*}"
    inhalt="${treffer#*:}"; inhalt="${inhalt#*:}"
    for i in "${!AUSNAHME_PFAD[@]}"; do
        # shellcheck disable=SC2053  — the left side is a glob on purpose.
        [[ "$datei" == ${AUSNAHME_PFAD[$i]} ]] || continue
        [[ "$inhalt" == *"${AUSNAHME_TEXT[$i]}"* ]] && return 0
    done
    return 1
}

FUND=0
ENTSCHULDIGT=0
for m in "${MUSTER[@]}"; do
    TREFFER="$(git grep -InE "$m" $BAUM -- . ':(exclude)pruefe-vor-push.sh' ':(exclude)pruefe-ausnahmen.txt' 2>/dev/null)" || continue
    [[ -z "$TREFFER" ]] && continue
    OFFEN=""
    while IFS= read -r zeile; do
        [[ -z "$zeile" ]] && continue
        if entschuldigt "$zeile"; then
            echo "excused: $zeile"
            ENTSCHULDIGT=$((ENTSCHULDIGT + 1))
        else
            OFFEN+="$zeile"$'\n'
        fi
    done <<< "$TREFFER"
    if [[ -n "$OFFEN" ]]; then
        echo "FORBIDDEN PATTERN: $m"
        echo "$OFFEN" | head -10
        echo
        FUND=1
    fi
done
(( ENTSCHULDIGT )) && echo "($ENTSCHULDIGT hit(s) excused by pruefe-ausnahmen.txt — read them, they are not hidden.)"

if (( FUND )); then
    echo "ABORT: private values found in the committed state — do not push." >&2
    exit 1
fi
echo "OK: no forbidden patterns in the committed state."
