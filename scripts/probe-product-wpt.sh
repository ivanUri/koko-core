#!/usr/bin/env bash
# Targeted product WPT smoke after core fixes (not full suite).
set -euo pipefail
VELORA_ROOT="${VELORA_ROOT:-$HOME/Desktop/velora}"
WPT_ROOT="${WPT_ROOT:-$HOME/Desktop/wpt-spa-tests}"
BIN="$VELORA_ROOT/zig-out/bin/velora"
LOG=/tmp/velora-product-wpt.log
PIDF=/tmp/velora-product-wpt.pid

if [[ -f "$PIDF" ]]; then
  kill "$(cat "$PIDF")" 2>/dev/null || true
  rm -f "$PIDF"
  sleep 0.5
fi

cd "$VELORA_ROOT"
"$BIN" serve --host 127.0.0.1 --port 9222 \
  --insecure-disable-tls-host-verification --log-level warn \
  >"$LOG" 2>&1 &
echo $! >"$PIDF"
sleep 1.5
curl -sf http://127.0.0.1:9222/json/version >/dev/null || {
  echo "CDP not ready"; tail -20 "$LOG"; exit 1
}

cd "$WPT_ROOT"
export WPT_ADDR=http://localhost:8000 CDP_WS=ws://127.0.0.1:9222
RUNNER=./velora-probe/bin/wptrunner

run_one() {
  local t="$1"
  echo "==== $t ===="
  "$RUNNER" -wpt-addr "$WPT_ADDR" -cdp "$CDP_WS" -concurrency 1 -json "$t" 2>&1 | tail -8
  if curl -sf http://127.0.0.1:9222/json/version >/dev/null; then
    echo "  velora: ALIVE"
  else
    echo "  velora: DEAD"
    tail -15 "$LOG" || true
    # restart for next tests
    cd "$VELORA_ROOT"
    "$BIN" serve --host 127.0.0.1 --port 9222 \
      --insecure-disable-tls-host-verification --log-level warn \
      >"$LOG" 2>&1 &
    echo $! >"$PIDF"
    sleep 1.5
    cd "$WPT_ROOT"
  fi
}

# Headers iterable / basic
run_one /fetch/api/headers/headers-record.any.html
run_one /fetch/api/headers/headers-combine.any.html
run_one /fetch/api/headers/headers-errors.any.html

# location.hash empty (product SPA)
run_one /html/browsers/history/the-location-interface/location_hash_set_empty_string.html

# document.open path that previously process-killed
run_one /html/webappapis/dynamic-markup-insertion/opening-the-input-stream/url.window.html
run_one /html/webappapis/dynamic-markup-insertion/document-write/iframe_001.html

echo "=== DONE ==="
curl -sf http://127.0.0.1:9222/json/version >/dev/null && echo final_alive=yes || echo final_alive=no
