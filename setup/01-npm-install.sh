#!/usr/bin/env bash
# 01-npm-install.sh — dependencies for Freilauf (NO admin rights required).
# Installs node-pty (compiled with node-gyp; make/g++/python3 are present),
# ws and the static xterm.js files into the node_modules of THIS checkout —
# the one you are working in.
#
# The service does NOT run from here. It runs from its own deploy checkout, which
# `freilauf-deploy --init` creates and whose dependencies it installs itself
# (`npm ci --omit=dev`, only when package-lock.json changed). So this script is for
# the working copy: tests, editing, running the hub by hand.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> npm install (node-pty, ws, @xterm/xterm, @xterm/addon-fit)"
npm install --no-fund --no-audit \
    node-pty@1.1.0 ws@8 "@xterm/xterm@^6" "@xterm/addon-fit@^0.11"

echo "==> Done. Continue with: ./setup/02-install-scripts.sh"
echo "    (the service's own checkout comes later: freilauf-deploy --init --from \"\$PWD\")"
