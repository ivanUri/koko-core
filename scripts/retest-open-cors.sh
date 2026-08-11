#!/usr/bin/env bash
set -euo pipefail
ROOT="$HOME/Desktop/koko"
WPT="$HOME/Desktop/wpt-spa-tests"
PORT=9227
LOG=/tmp/v-open-cors.log
PIDF=/tmp/v-open-cors.pid

if [[ -f "$PIDF" ]]; then
  kill "$(cat "$PIDF")" 2>/dev/null || true
  rm -f "$PIDF"
fi
sleep 0.3

cd "$ROOT"
"$ROOT/zig-out/bin/koko" serve --host 127.0.0.1 --port "$PORT" \
  --insecure-disable-tls-host-verification --log-level warn >"$LOG" 2>&1 &
echo $! >"$PIDF"
sleep 2
curl -sf "http://127.0.0.1:${PORT}/json/version" >/dev/null || { echo start_fail; cat "$LOG"; exit 1; }

cd "$WPT"
./koko-probe/bin/wptrunner -wpt-addr http://localhost:8000 -cdp "ws://127.0.0.1:${PORT}" \
  -concurrency 1 -json \
  /html/webappapis/dynamic-markup-insertion/opening-the-input-stream/url.window.html \
  /fetch/api/cors/cors-preflight.any.html \
  /fetch/api/headers/headers-combine.any.html \
  2>&1 | tee /tmp/wpt-open-cors-out.txt | tail -60

echo "ALIVE=$(curl -sf "http://127.0.0.1:${PORT}/json/version" >/dev/null && echo yes || echo no)"
echo "--- koko log (last 40) ---"
tail -40 "$LOG"
