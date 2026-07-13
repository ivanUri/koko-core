#!/usr/bin/env bash
set -euo pipefail
t="${1:?test name like MutationObserver-sanity}"
VELORA_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
killall velora 2>/dev/null || true
sleep 1
cd "$VELORA_ROOT"
./zig-out/bin/velora serve --host 127.0.0.1 --port 9222 --insecure-disable-tls-host-verification --log-level error &
pid=$!
trap 'kill $pid 2>/dev/null || true' EXIT
for _ in $(seq 1 15); do
  curl -s http://127.0.0.1:9222/json/version >/dev/null && break
  sleep 1
done
cd "$HOME/Desktop/demo/wptrunner"
exec go run . -wpt-addr http://localhost:8000 -cdp ws://127.0.0.1:9222 -summary -concurrency 1 "/dom/nodes/${t}.html"