#!/usr/bin/env bash
set -euo pipefail
export LD_LIBRARY_PATH="${HOME}/velora/vendor/curl-impersonate/linux:${LD_LIBRARY_PATH:-}"
export PATH="/usr/local/go/bin:/usr/bin:/bin:$PATH"

sed -i 's/\r$//' /mnt/d/velora/scripts/wpt-css-preprocess.py
python3 /mnt/d/velora/scripts/wpt-css-preprocess.py

# restore orig th if needed
if [ -f /root/wpt-css-work/wpt/resources/testharness.js.orig ]; then
  cp -a /root/wpt-css-work/wpt/resources/testharness.js.orig /root/wpt-css-work/wpt/resources/testharness.js
fi
# report patch
curl -fsSL "https://raw.githubusercontent.com/lightpanda-io/wpt/fork/resources/testharnessreport.js" \
  -o /root/wpt-css-work/wpt/resources/testharnessreport.js
python3 - <<'PY'
from pathlib import Path
p = Path("/root/wpt-css-work/wpt/resources/testharnessreport.js")
t = p.read_text()
if "completed:" not in t:
    t = t.replace("complete: false,", "complete: false,\n  completed: 0,", 1)
    t = t.replace(
        "report.cases[report.name(test)] = report.format(test);\n  report.update();",
        "report.cases[report.name(test)] = report.format(test);\n  report.completed = Object.keys(report.cases).length;\n  report.update();",
    )
    p.write_text(t)
PY

fuser -k 8000/tcp 2>/dev/null || true
fuser -k 9222/tcp 2>/dev/null || true
sleep 0.3
cd /root/wpt-css-work/wpt
python3 -m http.server 8000 --bind 127.0.0.1 >/tmp/wpt-http.log 2>&1 &
sleep 0.5
cd /root/velora
./zig-out/bin/velora serve --host 127.0.0.1 --port 9222 \
  --insecure-disable-tls-host-verification --log-level error >/tmp/velora-wpt.log 2>&1 &
sleep 1

cd /root/wpt-css-work/demo/wptrunner
echo "=== anb-parsing ==="
go run . -wpt-addr http://127.0.0.1:8000 -cdp ws://127.0.0.1:9222 -concurrency 1 \
  css/css-syntax/anb-parsing.html 2>&1 | tail -20
