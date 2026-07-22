#!/usr/bin/env bash
set -euo pipefail
export LD_LIBRARY_PATH="${HOME}/velora/vendor/curl-impersonate/linux:${LD_LIBRARY_PATH:-}"
cd "${HOME}/velora"
./zig-out/bin/velora fetch --dump html https://example.com > /tmp/example.html 2> /tmp/example.err
EC=$?
echo "exit=$EC"
echo "=== stderr ==="
cat /tmp/example.err || true
echo "=== stdout ==="
cat /tmp/example.html
echo
echo "=== size ==="
wc -c /tmp/example.html
if grep -q "Example Domain" /tmp/example.html; then
  echo "SMOKE_OK"
else
  echo "SMOKE_FAIL"
  exit 1
fi
