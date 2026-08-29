#!/usr/bin/env bash
# 02-install-scripts.sh — installs the cc-hub scripts into ~/.local/bin
# and the opencode plugin. NO admin rights required.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> cc scripts into ~/.local/bin"
mkdir -p "$HOME/.local/bin"
for s in cc-start cc-attach cc-kill cc-help cc-report cc-oc-sync-agents cchub cchub-deploy cc-session-cleanup; do
    install -m 755 "$ROOT/bin/$s" "$HOME/.local/bin/$s"
    echo "    $s"
done

echo "==> opencode plugin (session.idle / session.error → cc-report)"
mkdir -p "$HOME/.config/opencode/plugins"
cat > "$HOME/.config/opencode/plugins/cc-hub.js" <<'EOF'
// cc-hub plugin: reports idle/error of an opencode run to the hub (Planung 7.1).
//
// IMPORTANT about the shape: opencode expects a FACTORY — a function that returns
// the hooks. If the file instead exports an 'event' hook directly, the config hook
// fails ("undefined is not an object (evaluating 'N.config')") and opencode then
// dies while listing the providers with "Unexpected server error".
// That cripples opencode COMPLETELY, even outside of cc-hub.
export const CcHub = async ({ $ }) => {
  const runId = process.env.CC_RUN_ID
  // Without CC_RUN_ID, opencode is not running under cc-hub — then leave everything untouched.
  if (!runId) return {}

  const melden = async (...args) => {
    try { await $`cc-report ${args}`.quiet().nothrow() } catch { /* reporting is best-effort */ }
  }

  return {
    event: async ({ event }) => {
      if (event?.type === 'session.idle') await melden('_idle')
      // session.error: rate limit, provider failure, auth … This used to go to the hub
      // as 'failed' and ended the run — even when opencode kept running after the retry
      // (e.g. an error in a subagent session). Now: open an incident, the run keeps
      // going; if the process really dies, the watcher catches that via pane_dead.
      if (event?.type === 'session.error') {
        const e = event.properties?.error ?? event.error
        const text = typeof e === 'string' ? e
          : e?.data?.message ?? e?.message ?? e?.name ?? JSON.stringify(e ?? 'session.error')
        await melden('_api_error', 'unknown', String(text).slice(0, 300))
      }
    },
  }
}
EOF

echo "==> Extra skills into ~/agents/zusaetze (opt-in per agent/run, NO auto-loading)"
# Deliberately NOT under .claude/skills: there, every claude instance would load the
# skill automatically. cc-hub offers these folders as checkboxes in the form and, on
# selection, writes a reference to the SKILL.md into the prompt.
# Commit-pinned: updates are a deliberate decision (bump the pin), not an accident.
#
# This block needs the NETWORK, and since cchub-deploy runs this script on every
# deploy it must not be able to fail one: a GitHub that is briefly unreachable
# would otherwise take a healthy hub down and roll it back. Hence fail-soft, plus
# CCHUB_SKIP_EXTRAS=1 for a run that must not touch the network at all (tests).
UNLAZY_PIN="754d9a68109e39b836cc72a39fb9a823f9d6b613"
ZUSAETZE="$HOME/agents/zusaetze"
if [[ "${CCHUB_SKIP_EXTRAS:-0}" == 1 ]]; then
  echo "    skipped (CCHUB_SKIP_EXTRAS=1)"
else
  mkdir -p "$ZUSAETZE"
  if extras_ok=$(
    set -e
    if [[ ! -d "$ZUSAETZE/unlazy/.git" ]]; then
      git clone -q https://github.com/Leonxlnx/unlazy "$ZUSAETZE/unlazy"
    fi
    git -C "$ZUSAETZE/unlazy" fetch -q origin
    git -C "$ZUSAETZE/unlazy" checkout -q "$UNLAZY_PIN"
    git -C "$ZUSAETZE/unlazy" rev-parse --short HEAD
  ); then
    echo "    unlazy @ $extras_ok OK"
  else
    echo "    WARNING: unlazy could not be updated (network?) — leaving it as it is"
  fi
fi

echo "==> Done. Continue with: ./setup/03-install-services.sh"
