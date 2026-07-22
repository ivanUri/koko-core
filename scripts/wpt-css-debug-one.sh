#!/usr/bin/env bash
set -euo pipefail
export PATH="/usr/local/go/bin:$PATH"
export LD_LIBRARY_PATH="${HOME}/velora/vendor/curl-impersonate/linux:${LD_LIBRARY_PATH:-}"

# kill previous listeners carefully by port
fuser -k 8000/tcp 2>/dev/null || true
fuser -k 9222/tcp 2>/dev/null || true
sleep 0.5

cd /root/wpt-css-work/wpt
python3 -m http.server 8000 --bind 127.0.0.1 >/tmp/wpt-http.log 2>&1 &
WPT_PID=$!
sleep 1
echo "testharness:"
curl -sI http://127.0.0.1:8000/resources/testharness.js | head -3
echo "page:"
curl -sI http://127.0.0.1:8000/css/css-syntax/anb-parsing.html | head -3

cd /root/velora
./zig-out/bin/velora serve --host 127.0.0.1 --port 9222 \
  --insecure-disable-tls-host-verification --log-level warn \
  >/tmp/velora-wpt.log 2>&1 &
VELORA_PID=$!
for i in $(seq 1 30); do
  curl -sf http://127.0.0.1:9222/json/version >/dev/null && break
  sleep 0.2
done

echo "=== wptrunner one test ==="
cd /root/wpt-css-work/demo/wptrunner
go run . -wpt-addr http://127.0.0.1:8000 -cdp ws://127.0.0.1:9222 -concurrency 1 -verbose \
  css/css-syntax/anb-parsing.html 2>&1 | tail -60

echo "=== velora log tail ==="
tail -30 /tmp/velora-wpt.log || true

kill $VELORA_PID 2>/dev/null || true
kill $WPT_PID 2>/dev/null || true
