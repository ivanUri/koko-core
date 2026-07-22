#!/usr/bin/env bash
set -euo pipefail
export PATH="/usr/local/go/bin:$PATH"
echo "=== selected ==="
head -20 /mnt/d/velora/code-check/wpt-css-results/selected-tests.txt
echo "=== detail head ==="
head -40 /mnt/d/velora/code-check/wpt-css-results/failures.detail.txt
echo "=== pass true count ==="
grep -o '"pass":true' /mnt/d/velora/code-check/wpt-css-results/results.json | wc -l
echo "=== list filter css/css-syntax ==="
fuser -k 8000/tcp 2>/dev/null || true
cd /root/wpt-css-work/wpt
python3 -m http.server 8000 --bind 127.0.0.1 >/tmp/wpt-http.log 2>&1 &
sleep 0.5
cd /root/wpt-css-work/demo/wptrunner
go run . -wpt-addr http://127.0.0.1:8000 -list css/css-syntax 2>/dev/null | head -15
echo "=== list filter css/cssom ==="
go run . -wpt-addr http://127.0.0.1:8000 -list css/cssom 2>/dev/null | head -10
