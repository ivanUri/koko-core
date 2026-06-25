#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
PORT=19600
lsof -ti :"$PORT" | xargs kill -9 2>/dev/null || true
mkdir -p code-check/tmp/grok-cf

lldb -b \
  -o "run serve --host 127.0.0.1 --port $PORT --browser-profile chrome-macos-sonoma --log-level warn" \
  -o "bt 50" \
  -o "thread backtrace all" \
  -o quit \
  ./zig-out/bin/velora > code-check/tmp/grok-cf/bt.log 2>&1 &

for i in $(seq 1 40); do
  curl -sf "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1 && break
  sleep 0.5
done

node -e '
import { Browser } from "./sdk/dist/index.js";
const b = await Browser.connect("http://127.0.0.1:19600");
try {
  const p = await b.newPage();
  await p.goto("https://grok.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await new Promise((r) => setTimeout(r, 8000));
} finally { await b.close().catch(() => {}); }
' 2>/dev/null || true

wait || true
echo "=== BT ==="
rg -n 'stop reason|frame #|velora`' code-check/tmp/grok-cf/bt.log | head -60