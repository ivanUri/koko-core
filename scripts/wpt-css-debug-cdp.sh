#!/usr/bin/env bash
set -euo pipefail
export PATH="/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export LD_LIBRARY_PATH="${HOME}/velora/vendor/curl-impersonate/linux:${LD_LIBRARY_PATH:-}"
export DEBIAN_FRONTEND=noninteractive

if ! command -v node >/dev/null 2>&1; then
  apt-get update -yq
  apt-get install -yq nodejs npm
fi
node --version
npm --version

cd /root/velora
if [ ! -d node_modules/ws ]; then
  npm install ws --no-save || npm install ws
fi

fuser -k 8000/tcp 2>/dev/null || true
fuser -k 9222/tcp 2>/dev/null || true
sleep 0.5

cd /root/wpt-css-work/wpt
python3 -m http.server 8000 --bind 127.0.0.1 >/tmp/wpt-http.log 2>&1 &
sleep 1

cd /root/velora
./zig-out/bin/velora serve --host 127.0.0.1 --port 9222 \
  --insecure-disable-tls-host-verification --log-level warn \
  >/tmp/velora-wpt.log 2>&1 &
sleep 1

sed -i 's/\r$//' /mnt/d/velora/scripts/wpt-css-debug-cdp.mjs
node /mnt/d/velora/scripts/wpt-css-debug-cdp.mjs 2>&1 || true
echo "---log---"
cat /tmp/velora-wpt.log
