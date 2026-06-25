#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/capture-and-curl-sgss.mjs >/dev/null
URL=$(cat /tmp/velora-sgss-url.txt)
lldb -b -o "run fetch --browser-profile chrome-local-huys-macbook-pro $(python3 -c 'import shlex,sys; print(shlex.quote(sys.argv[1]))' "$URL")" -o "bt all" -o "quit" -- zig-out/bin/velora