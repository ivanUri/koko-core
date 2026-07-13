#!/usr/bin/env bash
set -euo pipefail

VELORA_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VELORA_BIN="${VELORA_BIN:-$VELORA_ROOT/zig-out/bin/velora}"
WPTRUNNER="${WPTRUNNER:-$HOME/Desktop/demo/wptrunner}"
WPT_ADDR="${WPT_ADDR:-http://localhost:8000}"
CDP="${CDP:-ws://127.0.0.1:9222}"

tests=(
  MutationObserver-attributes
  MutationObserver-callback-arguments
  MutationObserver-characterData
  MutationObserver-childList
  MutationObserver-cross-realm-callback-report-exception
  MutationObserver-disconnect
  MutationObserver-document
  MutationObserver-inner-outer
  MutationObserver-nested-crash
  MutationObserver-sanity
  MutationObserver-takeRecords
  MutationObserver-textContent
)

stop_velora() {
  if pgrep -x velora >/dev/null 2>&1; then
    killall velora 2>/dev/null || true
    sleep 1
  fi
}

start_velora() {
  cd "$VELORA_ROOT"
  "$VELORA_BIN" serve --host 127.0.0.1 --port 9222 --insecure-disable-tls-host-verification --log-level error &
  local pid=$!
  for _ in $(seq 1 15); do
    if curl -s http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
      echo "$pid"
      return 0
    fi
    sleep 1
  done
  echo "velora failed to start (pid $pid)" >&2
  return 1
}

for t in "${tests[@]}"; do
  stop_velora
  pid=$(start_velora)
  echo "=== /dom/nodes/${t}.html ==="
  (
    cd "$WPTRUNNER"
    go run . -wpt-addr "$WPT_ADDR" -cdp "$CDP" -summary -concurrency 1 "/dom/nodes/${t}.html" 2>&1 \
      | grep -E '^(Pass|Fail|Crash)' || true
  )
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  sleep 1
done

stop_velora