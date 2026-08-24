#!/usr/bin/env bash
# 01-npm-install.sh — dependencies for cc-hub (NO admin rights required).
# Installs node-pty (compiled with node-gyp; make/g++/python3 are present),
# ws and the static xterm.js files into ~/projects/cc-hub/node_modules.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> npm install (node-pty, ws, @xterm/xterm, @xterm/addon-fit)"
npm install --no-fund --no-audit \
    node-pty@1.1.0 ws@8 "@xterm/xterm@^6" "@xterm/addon-fit@^0.11"

echo "==> Done. Continue with: ./setup/02-install-scripts.sh"
