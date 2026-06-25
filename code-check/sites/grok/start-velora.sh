#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
PORT="${1:-19600}"
lsof -ti :"$PORT" | xargs kill -9 2>/dev/null || true
exec lldb -b \
  -o "run serve --host 127.0.0.1 --port $PORT --browser-profile chrome-macos-sonoma --log-level warn" \
  -o "process detach" \
  -o quit \
  ./zig-out/bin/velora