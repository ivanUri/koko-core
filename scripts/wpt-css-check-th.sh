#!/usr/bin/env bash
set -euo pipefail
export LD_LIBRARY_PATH="${HOME}/velora/vendor/curl-impersonate/linux:${LD_LIBRARY_PATH:-}"
export PATH="/usr/bin:/bin:$PATH"

fuser -k 8000/tcp 2>/dev/null || true
fuser -k 9222/tcp 2>/dev/null || true
sleep 0.3

cd /root/wpt-css-work/wpt
python3 -m http.server 8000 --bind 127.0.0.1 >/tmp/wpt-http.log 2>&1 &
sleep 0.5

# only load testharness.js
cat > /root/wpt-css-work/wpt/th-only.html <<'HTML'
<!doctype html>
<title>th only</title>
<script src="/resources/testharness.js"></script>
<script>
document.title = (typeof test === "function" ? "HAS_TEST" : "NO_TEST") + ":" + (typeof assert_true);
</script>
HTML

cd /root/velora
./zig-out/bin/velora fetch --wait-ms 2000 --dump html \
  http://127.0.0.1:8000/th-only.html 2>/tmp/th.err | head -c 1000
echo
echo "===err==="
cat /tmp/th.err
# check size of testharness
wc -c /root/wpt-css-work/wpt/resources/testharness.js
head -5 /root/wpt-css-work/wpt/resources/testharness.js
# any obvious module syntax?
grep -n "export \|import \|type=\"" /root/wpt-css-work/wpt/resources/testharness.js | head
