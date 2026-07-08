#!/usr/bin/env bash
# Run P0 DOM abort/event WPT tests with velora restart before each file.
set -euo pipefail

VELORA_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VELORA_BIN="$VELORA_ROOT/zig-out/bin/velora"
WPT_RUN="$VELORA_ROOT/scripts/wpt-run.sh"
VELORA_PID=""

cleanup() {
  if [[ -n "${VELORA_PID:-}" ]] && kill -0 "$VELORA_PID" 2>/dev/null; then
    kill "$VELORA_PID" 2>/dev/null || true
    wait "$VELORA_PID" 2>/dev/null || true
  fi
  pkill -f "velora serve.*9222" 2>/dev/null || true
}
trap cleanup EXIT

restart_velora() {
  cleanup
  trap - EXIT
  pkill -f "velora serve.*9222" 2>/dev/null || true
  sleep 0.5
  "$VELORA_BIN" serve --host 127.0.0.1 --port 9222 \
    --insecure-disable-tls-host-verification --log-level error &
  VELORA_PID=$!
  trap cleanup EXIT
  local i=0
  while ! curl -sf http://127.0.0.1:9222/json/version >/dev/null 2>&1; do
    sleep 0.3
    i=$((i + 1))
    if [[ $i -gt 40 ]]; then
      echo "velora failed to start" >&2
      return 1
    fi
  done
}

run_test() {
  local path="$1"
  echo ""
  echo "========== $path =========="
  restart_velora
  "$WPT_RUN" "$path" 2>&1 || true
  if curl -sf http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
    echo "[OK] velora alive after $path"
  else
    echo "[WARN] velora dead after $path"
  fi
}

P0=(
  "dom/abort/event.any.html"
  "dom/abort/abort-signal-timeout.html"
  "dom/events/AddEventListenerOptions-signal.any.html"
  "dom/abort/abort-signal-any.any.html"
)

for t in "${P0[@]}"; do
  run_test "$t"
done

echo ""
echo "=== P0 DONE ==="