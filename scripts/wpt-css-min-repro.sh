#!/usr/bin/env bash
set -euo pipefail
export PATH="/usr/local/go/bin:/usr/bin:/bin:$PATH"
export LD_LIBRARY_PATH="${HOME}/velora/vendor/curl-impersonate/linux:${LD_LIBRARY_PATH:-}"

fuser -k 8000/tcp 2>/dev/null || true
fuser -k 9222/tcp 2>/dev/null || true
sleep 0.3

# minimal harness page using WPT resources
mkdir -p /tmp/wptmin
cat > /tmp/wptmin/t.html <<'HTML'
<!doctype html>
<title>min</title>
<script src="http://127.0.0.1:8000/resources/testharness.js"></script>
<script src="http://127.0.0.1:8000/resources/testharnessreport.js"></script>
<script>
test(() => { assert_true(true); }, "true is true");
test(() => { assert_equals(1+1, 2); }, "1+1=2");
</script>
HTML

cd /root/wpt-css-work/wpt
python3 -m http.server 8000 --bind 127.0.0.1 >/tmp/wpt-http.log 2>&1 &
sleep 0.5
# also serve min via same server? copy into wpt tree
cp /tmp/wptmin/t.html /root/wpt-css-work/wpt/min-harness.html

cd /root/velora
./zig-out/bin/velora serve --host 127.0.0.1 --port 9222 \
  --insecure-disable-tls-host-verification --log-level warn \
  >/tmp/velora-wpt.log 2>&1 &
sleep 1

# also try fetch path
echo "=== fetch dump ==="
./zig-out/bin/velora fetch --wait-ms 3000 --dump html \
  http://127.0.0.1:8000/min-harness.html 2>/tmp/fetch.err | head -c 800
echo
echo "=== fetch err ==="
cat /tmp/fetch.err

echo "=== wptrunner min ==="
# inject min into manifest manually
python3 - <<'PY'
import json
from pathlib import Path
p=Path('/root/wpt-css-work/wpt/MANIFEST.json')
m=json.loads(p.read_text())
th=m.setdefault('items',{}).setdefault('testharness',{})
th['min-harness.html']=["0"*40,[None,{}]]
p.write_text(json.dumps(m))
print('manifest ok')
PY

cd /root/wpt-css-work/demo/wptrunner
go run . -wpt-addr http://127.0.0.1:8000 -cdp ws://127.0.0.1:9222 -concurrency 1 -verbose \
  min-harness.html 2>&1 | tail -30

echo "=== velora log ==="
cat /tmp/velora-wpt.log
