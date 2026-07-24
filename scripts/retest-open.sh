#!/usr/bin/env bash
set -euo pipefail
ROOT="$HOME/Desktop/velora"
WPT="$HOME/Desktop/wpt-spa-tests"
PORT=9223
LOG=/tmp/vnew.log
PIDF=/tmp/vnew.pid

if [[ -f "$PIDF" ]]; then
  kill "$(cat "$PIDF")" 2>/dev/null || true
  rm -f "$PIDF"
fi
sleep 0.3

cd "$ROOT"
# shellcheck disable=SC2091
"$ROOT/zig-out/bin/velora" serve --host 127.0.0.1 --port "$PORT" \
  --insecure-disable-tls-host-verification --log-level warn >"$LOG" 2>&1 &
echo $! >"$PIDF"
sleep 2
curl -sf "http://127.0.0.1:${PORT}/json/version" | head -c 120 || { echo fail_start; cat "$LOG"; exit 1; }
echo

cd "$WPT"
./velora-probe/bin/wptrunner -wpt-addr http://localhost:8000 -cdp "ws://127.0.0.1:${PORT}" \
  -concurrency 1 -json \
  /html/webappapis/dynamic-markup-insertion/opening-the-input-stream/url.window.html \
  /html/browsers/history/the-location-interface/location_hash_set_empty_string.html \
  /fetch/api/headers/headers-combine.any.html \
  2>&1 | tail -40

echo "ALIVE=$(curl -sf "http://127.0.0.1:${PORT}/json/version" >/dev/null && echo yes || echo no)"
echo "--- log ---"
cat "$LOG"
