#!/bin/bash
# Reproduce grok.com crash and capture lldb backtrace.
set -euo pipefail
cd "$(dirname "$0")/../../.."
PORT=19600
BIN=./zig-out/bin/velora
LOG=code-check/tmp/grok-cf/crash.log
mkdir -p code-check/tmp/grok-cf

lsof -ti :$PORT | xargs kill -9 2>/dev/null || true

# Start velora under lldb; on crash, dump backtrace.
lldb -b \
  -o "run serve --host 127.0.0.1 --port $PORT --browser-profile chrome-macos-sonoma --log-level warn" \
  -o "bt all" \
  -o "thread backtrace all" \
  -o "quit" \
  "$BIN" > "$LOG" 2>&1 &
LLDB_PID=$!

READY=0
for i in $(seq 1 120); do
  if curl -sf "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
    READY=1
    echo "velora ready on :$PORT (${i})"
    break
  fi
  sleep 0.5
done
if [ "$READY" -eq 0 ]; then
  echo "velora not ready on :$PORT after 60s" >&2
  tail -30 "$LOG" >&2 || true
  exit 1
fi

node -e '
import { Browser } from "./sdk/dist/index.js";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await Browser.connect("http://127.0.0.1:'"$PORT"'");
try {
  const page = await browser.newPage();
  await page.goto("https://grok.com/", { waitUntil: "domcontentloaded", timeout: 120000 });
  for (let i = 0; i < 30; i++) {
    const s = await page.evaluate(`({ title: document.title, cf: document.cookie.includes("cf_clearance") })`).catch(() => null);
    if (!s) break;
    console.log(`[${i}] title=${s.title} cf=${s.cf}`);
    if (s.cf || s.title !== "Just a moment...") break;
    await delay(2000);
  }
} finally { await browser.close().catch(() => {}); }
' 2>&1 || true

wait $LLDB_PID 2>/dev/null || true
echo "=== BACKTRACE ==="
grep -A 80 "stop reason\|thread #\|velora\`" "$LOG" | head -120