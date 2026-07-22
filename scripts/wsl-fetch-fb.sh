#!/usr/bin/env bash
set -uo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
cd /root/velora || exit 1
export LD_LIBRARY_PATH="/root/velora/vendor/curl-impersonate/linux:${LD_LIBRARY_PATH:-}"

echo "=== libs ==="
ldd ./zig-out/bin/velora | grep -i curl || true
nm -D ./zig-out/bin/velora 2>/dev/null | grep curl_easy_impersonate || true
# Also check dynamic undefined
nm -D ./zig-out/bin/velora 2>/dev/null | grep ' U curl_easy_impersonate' || true

echo "=== fetch example.com ==="
./zig-out/bin/velora fetch --dump html --wait-until load --wait-ms 10000 https://example.com > /tmp/ex.out 2> /tmp/ex.err
echo "example EXIT=$?"
grep -oE '<title>[^<]*</title>' /tmp/ex.out | head -3 || true
tail -5 /tmp/ex.err || true

echo "=== fetch facebook.com ==="
./zig-out/bin/velora fetch --dump html --wait-until load --wait-ms 25000 https://www.facebook.com/ > /tmp/fb.out 2> /tmp/fb.err
echo "facebook EXIT=$?"
echo "sizes:"; wc -c /tmp/fb.out /tmp/fb.err
echo "stderr:"; cat /tmp/fb.err
echo "titles:"; grep -oE '<title>[^<]*</title>' /tmp/fb.out | head -10 || true
echo "stdout head:"; head -c 1000 /tmp/fb.out; echo
echo "markers:"; grep -oiE 'facebook|login|checkpoint|sorry|error|blocked' /tmp/fb.out | sort | uniq -c | head -20 || true
