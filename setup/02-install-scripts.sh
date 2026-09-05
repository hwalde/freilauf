#!/usr/bin/env bash
# 02-install-scripts.sh — installs the Freilauf scripts into ~/.local/bin
# and the opencode plugin. NO admin rights required.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

BIN="$HOME/.local/bin"
echo "==> fl-* scripts into ~/.local/bin"
mkdir -p "$BIN"
for s in fl-start fl-attach fl-kill fl-help fl-report fl-api fl-notify fl-panel fl-oc-sync-agents fl-session-cleanup fl-tmux-server freilauf freilauf-deploy; do
    install -m 755 "$ROOT/bin/$s" "$BIN/$s"
    echo "    $s"
done
# Sourced by the scripts above, never executed — hence 644 and no shebang. They
# have to land next to them, because that is where they look for them.
for lib in fl-harness-tags.sh fl-paths.sh; do
    install -m 644 "$ROOT/bin/$lib" "$BIN/$lib"
    echo "    $lib (library)"
done

# ---------------------------------------------------------------- old names
# The project was called cc-hub, and its scripts cc-start/cc-report/… . A rename
# cannot reach the places those names are written down: the prompt of a run that
# is in flight right now, the `.cursor/hooks.json` and claude settings inside its
# worktree, an operator's shell history, a cron line. So every old name stays
# reachable as a one-line shim for one transition release, and a later commit
# deletes this block.
#
# `$0` is the shim's own path, so `dirname` finds the real script next to it —
# no PATH lookup, and therefore no chance of a shim calling itself.
echo "==> deprecated shims under the old names (one transition release)"
shim() {
    local alt="$1" neu="$2"
    cat > "$BIN/$alt" <<SHIM
#!/usr/bin/env bash
# DEPRECATED: '$alt' is the old name of '$neu' (cc-hub -> Freilauf).
# It exists so runs and habits from before the rename keep working; use '$neu'.
exec "\$(dirname "\$0")/$neu" "\$@"
SHIM
    chmod 755 "$BIN/$alt"
    echo "    $alt -> $neu"
}
shim cc-start           fl-start
shim cc-attach          fl-attach
shim cc-kill            fl-kill
shim cc-help            fl-help
shim cc-report          fl-report
shim cc-notify          fl-notify
shim cc-oc-sync-agents  fl-oc-sync-agents
shim cc-session-cleanup fl-session-cleanup
shim cchub              freilauf
shim cchub-deploy       freilauf-deploy

echo "==> opencode plugin (session.idle / session.error → fl-report)"
mkdir -p "$HOME/.config/opencode/plugins"
# The plugin used to be called cc-hub.js and exported CcHub. Leaving it behind
# would not be harmless: opencode loads EVERY file in this directory, so both
# would run and every idle and every API error would be reported twice.
rm -f "$HOME/.config/opencode/plugins/cc-hub.js"
cat > "$HOME/.config/opencode/plugins/freilauf.js" <<'EOF'
// Freilauf plugin: reports idle/error of an opencode run to the hub (Planung 7.1).
//
// IMPORTANT about the shape: opencode expects a FACTORY — a function that returns
// the hooks. If the file instead exports an 'event' hook directly, the config hook
// fails ("undefined is not an object (evaluating 'N.config')") and opencode then
// dies while listing the providers with "Unexpected server error".
// That cripples opencode COMPLETELY, even outside of Freilauf.
export const Freilauf = async ({ $ }) => {
  // FL_RUN_ID is what a run started by this hub carries; CC_RUN_ID is what a run
  // started before the rename carries, and such a session can still be alive.
  const runId = process.env.FL_RUN_ID ?? process.env.CC_RUN_ID
  // Without one, opencode is not running under Freilauf — then leave everything untouched.
  if (!runId) return {}

  const melden = async (...args) => {
    try { await $`fl-report ${args}`.quiet().nothrow() } catch { /* reporting is best-effort */ }
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

# ---------------------------------------------------------------- git hooks
# Both hooks are versioned in the repository and LINKED rather than copied, so a
# later change to the script is live without reinstalling anything:
#   pre-push     pruefe-vor-push.sh    — keeps private values out of a push
#   post-merge   deploy-after-merge.sh — decides whether a merge may go live now
#
# OPT-IN, and that is not politeness — it is the only correct behaviour. This
# script is not only run by hand: `freilauf-deploy` runs it on every deploy
# (bin/freilauf-deploy, install_scripts) and `setup/migrate-from-cc-hub.sh` runs it
# during a migration — the latter with the OPERATOR'S checkout as $ROOT, because
# that is where the migration script lives. Installing hooks as a side effect of
# either would arm a post-merge deploy on a machine whose owner never asked for
# one, and test/deploy.mjs (which exercises --migrate) would reach out of its
# sandbox and arm it on the developer's own repository. It did, before this was
# a flag.
#
# So: `bash setup/02-install-scripts.sh --hooks`, once, deliberately.
INSTALL_HOOKS="${FREILAUF_INSTALL_HOOKS:-0}"
for arg in "$@"; do
    case "$arg" in
        --hooks)    INSTALL_HOOKS=1 ;;
        --no-hooks) INSTALL_HOOKS=0 ;;
    esac
done

# An existing hook that is a real file belongs to the operator and is left alone —
# a setup script that silently overwrites someone's own hook is one nobody runs twice.
link_hook() {
    local name="$1" script="$2" ziel="$HOOKS/$1"
    if [[ -e "$ziel" && ! -L "$ziel" ]]; then
        echo "    $name: left alone (there is already a hook of your own there)"
        return 0
    fi
    ln -sfn "$ROOT/$script" "$ziel"
    echo "    $name -> $script"
}

if [[ "$INSTALL_HOOKS" != 1 ]]; then
    echo "==> git hooks: not installed (add --hooks to link pre-push and post-merge)"
# shellcheck source=../bin/fl-paths.sh
elif . "$ROOT/bin/fl-paths.sh" && [[ "$ROOT" == "$(fl_deploy_dir)" ]]; then
    echo "==> git hooks: skipped (this is the deploy checkout, nothing is merged here)"
elif HOOK_BASE="$(git -C "$ROOT" rev-parse --git-common-dir 2>/dev/null)" && [[ -n "$HOOK_BASE" ]]; then
    [[ "$HOOK_BASE" == /* ]] || HOOK_BASE="$ROOT/$HOOK_BASE"
    HOOKS="$HOOK_BASE/hooks"
    echo "==> git hooks into $HOOKS"
    mkdir -p "$HOOKS"
    link_hook pre-push   pruefe-vor-push.sh
    link_hook post-merge deploy-after-merge.sh
else
    echo "==> git hooks: skipped ($ROOT is not a git checkout)"
fi

echo "==> Extra skills into ~/agents/zusaetze (opt-in per agent/run, NO auto-loading)"
# Deliberately NOT under .claude/skills: there, every claude instance would load the
# skill automatically. Freilauf offers these folders as checkboxes in the form and, on
# selection, writes a reference to the SKILL.md into the prompt.
# Commit-pinned: updates are a deliberate decision (bump the pin), not an accident.
#
# This block needs the NETWORK, and since freilauf-deploy runs this script on every
# deploy it must not be able to fail one: a GitHub that is briefly unreachable
# would otherwise take a healthy hub down and roll it back. Hence fail-soft, plus
# FREILAUF_SKIP_EXTRAS=1 for a run that must not touch the network at all (tests).
UNLAZY_PIN="754d9a68109e39b836cc72a39fb9a823f9d6b613"
ZUSAETZE="$HOME/agents/zusaetze"
if [[ "${FREILAUF_SKIP_EXTRAS:-0}" == 1 ]]; then
  echo "    skipped (FREILAUF_SKIP_EXTRAS=1)"
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
