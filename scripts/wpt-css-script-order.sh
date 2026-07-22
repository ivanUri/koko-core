#!/usr/bin/env bash
set -euo pipefail
export LD_LIBRARY_PATH="${HOME}/velora/vendor/curl-impersonate/linux:${LD_LIBRARY_PATH:-}"

fuser -k 8000/tcp 2>/dev/null || true
sleep 0.2
cd /root/wpt-css-work/wpt
python3 -m http.server 8000 --bind 127.0.0.1 >/tmp/wpt-http.log 2>&1 &
sleep 0.4

# restore original testharness
if [ -f resources/testharness.js.orig ]; then
  cp -a resources/testharness.js.orig resources/testharness.js
fi

cat > order.html <<'HTML'
<!doctype html>
<title>order</title>
<script src="/resources/testharness.js" onerror="document.title='SRC_ERR'" onload="document.title='SRC_LOAD:'+ (typeof test)"></script>
<script>
document.title = "inline1:" + (typeof test);
setTimeout(function(){
  document.title = "later:" + (typeof test) + ":" + (typeof assert_true);
}, 1500);
</script>
HTML

# tiny external script
echo 'window.__tiny=42;' > tiny.js
cat > tiny.html <<'HTML'
<!doctype html>
<title>tiny</title>
<script src="/tiny.js"></script>
<script>document.title = "tiny=" + window.__tiny;</script>
HTML

cd /root/velora
echo "=== order wait 3s ==="
./zig-out/bin/velora fetch --wait-ms 3000 --dump html http://127.0.0.1:8000/order.html 2>/tmp/o.err | grep -o '<title>[^<]*</title>'
echo ERR:; cat /tmp/o.err
echo "=== tiny ==="
./zig-out/bin/velora fetch --wait-ms 1000 --dump html http://127.0.0.1:8000/tiny.html 2>/tmp/t.err | grep -o '<title>[^<]*</title>'
echo ERR:; cat /tmp/t.err

# Check if network got the script
echo "=== access log from simple server? ==="
# curl the file itself is fine
curl -s -o /dev/null -w "%{http_code} %{size_download}\n" http://127.0.0.1:8000/resources/testharness.js
