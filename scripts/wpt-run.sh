#!/usr/bin/env bash
# Run WPT testharness tests against a local Velora CDP server.
#
# Setup (once):
#   git clone --depth=1 https://github.com/web-platform-tests/wpt.git wpt
#   cd wpt && ./wpt manifest
#   # testharnessreport.js is patched for wptrunner (see wpt/resources/)
#   git clone --depth=1 https://github.com/lightpanda-io/demo.git ~/Desktop/demo
#
# Servers:
#   cd wpt && ./wpt serve --config config.local.json
#   ./zig-out/bin/velora serve --host 127.0.0.1 --port 9222 --insecure-disable-tls-host-verification
set -euo pipefail

VELORA_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WPT_ADDR="${WPT_ADDR:-http://localhost:8000}"
CDP_WS="${CDP_WS:-ws://127.0.0.1:9222}"
CONCURRENCY="${CONCURRENCY:-1}"
WPTRUNNER="${WPTRUNNER:-$HOME/Desktop/demo/wptrunner}"

if [[ ! -d "$WPTRUNNER" ]]; then
  echo "wptrunner not found at $WPTRUNNER" >&2
  echo "Clone: git clone --depth=1 https://github.com/lightpanda-io/demo.git ~/Desktop/demo" >&2
  exit 1
fi

cd "$WPTRUNNER"
exec go run . \
  -wpt-addr "$WPT_ADDR" \
  -cdp "$CDP_WS" \
  -summary \
  -concurrency "$CONCURRENCY" \
  "$@"