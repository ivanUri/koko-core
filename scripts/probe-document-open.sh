#!/usr/bin/env bash
set -euo pipefail
KOKO_ROOT="${KOKO_ROOT:-$HOME/Desktop/koko}"
WPT_ROOT="${WPT_ROOT:-$HOME/Desktop/wpt-spa-tests}"
BIN="$KOKO_ROOT/zig-out/bin/koko"
LOG=/tmp/koko-open-probe.log
PIDF=/tmp/koko-open-probe.pid

# Stop previous probe only
if [[ -f "$PIDF" ]]; then
  kill "$(cat "$PIDF")" 2>/dev/null || true
  rm -f "$PIDF"
fi
sleep 0.5

cd "$KOKO_ROOT"
"$BIN" serve --host 127.0.0.1 --port 9222 \
  --insecure-disable-tls-host-verification --log-level warn \
  >"$LOG" 2>&1 &
echo $! >"$PIDF"
sleep 1.5

if ! curl -sf http://127.0.0.1:9222/json/version >/dev/null; then
  echo "CDP not ready"
  tail -30 "$LOG"
  exit 1
fi

TEST="${1:-/html/webappapis/dynamic-markup-insertion/opening-the-input-stream/url.window.html}"
cd "$WPT_ROOT"
WPT_ADDR=http://localhost:8000 CDP_WS=ws://127.0.0.1:9222 \
  ./koko-probe/bin/wptrunner -wpt-addr http://localhost:8000 -cdp ws://127.0.0.1:9222 \
  "$TEST" -json -concurrency 1 2>&1 | tail -50

echo "ALIVE=$(curl -sf http://127.0.0.1:9222/json/version >/dev/null && echo yes || echo no)"
echo "--- log ---"
tail -60 "$LOG"
