#!/usr/bin/env bash
# 01-npm-install.sh — Abhängigkeiten für cc-hub (KEINE Admin-Rechte nötig).
# Installiert node-pty (kompiliert mit node-gyp; make/g++/python3 sind vorhanden),
# ws und die statischen xterm.js-Dateien in ~/projects/cc-hub/node_modules.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> npm install (node-pty, ws, @xterm/xterm, @xterm/addon-fit)"
npm install --no-fund --no-audit \
    node-pty@1.1.0 ws@8 "@xterm/xterm@^6" "@xterm/addon-fit@^0.11"

echo "==> Fertig. Weiter mit: ./setup/02-install-scripts.sh"
