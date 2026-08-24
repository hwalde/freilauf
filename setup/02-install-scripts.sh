#!/usr/bin/env bash
# 02-install-scripts.sh — installiert die cc-hub-Scripte nach ~/.local/bin
# und das opencode-Plugin. KEINE Admin-Rechte nötig.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> cc-Scripte nach ~/.local/bin"
mkdir -p "$HOME/.local/bin"
for s in cc-start cc-attach cc-kill cc-help cc-report cchub; do
    install -m 755 "$ROOT/bin/$s" "$HOME/.local/bin/$s"
    echo "    $s"
done

echo "==> opencode-Plugin (session.idle / session.error → cc-report)"
mkdir -p "$HOME/.config/opencode/plugins"
cat > "$HOME/.config/opencode/plugins/cc-hub.js" <<'EOF'
// cc-hub-Plugin: meldet idle/error eines opencode-Laufs an den Hub (Planung 7.1).
//
// WICHTIG zur Form: opencode erwartet eine FABRIK — eine Funktion, die die Hooks
// zurueckgibt. Exportiert die Datei stattdessen direkt einen 'event'-Hook, scheitert
// der config-Hook ("undefined is not an object (evaluating 'N.config')") und opencode
// stirbt danach beim Auflisten der Provider mit "Unexpected server error".
// Das legt opencode KOMPLETT lahm, auch ausserhalb von cc-hub.
export const CcHub = async ({ $ }) => {
  const runId = process.env.CC_RUN_ID
  // Ohne CC_RUN_ID laeuft opencode nicht unter cc-hub — dann bleibt alles unberuehrt.
  if (!runId) return {}

  const melden = async (...args) => {
    try { await $`cc-report ${args}`.quiet().nothrow() } catch { /* Meldung ist Beiwerk */ }
  }

  return {
    event: async ({ event }) => {
      if (event?.type === 'session.idle') await melden('_idle')
      // session.error: Rate-Limit, Provider-Fehler, Auth … Frueher ging das als 'failed'
      // an den Hub und beendete den Lauf — auch wenn opencode nach dem Retry weiterlief
      // (z. B. Fehler in einer Subagent-Session). Jetzt: Vorfall oeffnen, Lauf laeuft
      // weiter; stirbt der Prozess wirklich, faengt das der Watcher ueber pane_dead.
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

echo "==> Zusatz-Skills nach ~/agents/zusaetze (opt-in je Agent/Lauf, KEIN Auto-Laden)"
# Bewusst NICHT unter .claude/skills: dort wuerde jede claude-Instanz den Skill
# automatisch laden. cc-hub bietet die Ordner hier als Haekchen im Formular an und
# schreibt bei Auswahl einen Verweis auf die SKILL.md in den Prompt.
# Commit-gepinnt: Updates sind eine bewusste Entscheidung (Pin anheben), kein Zufall.
UNLAZY_PIN="754d9a68109e39b836cc72a39fb9a823f9d6b613"
ZUSAETZE="$HOME/agents/zusaetze"
mkdir -p "$ZUSAETZE"
if [[ ! -d "$ZUSAETZE/unlazy/.git" ]]; then
  git clone -q https://github.com/Leonxlnx/unlazy "$ZUSAETZE/unlazy"
fi
git -C "$ZUSAETZE/unlazy" fetch -q origin
git -C "$ZUSAETZE/unlazy" checkout -q "$UNLAZY_PIN"
echo "    unlazy @ $(git -C "$ZUSAETZE/unlazy" rev-parse --short HEAD) OK"

echo "==> Fertig. Weiter mit: ./setup/03-install-services.sh"
