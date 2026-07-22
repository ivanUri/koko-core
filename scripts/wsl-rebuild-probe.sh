#!/usr/bin/env bash
set -euo pipefail
export PATH="/usr/local/bin:$HOME/.cargo/bin:/usr/bin:/bin:$PATH"
if [ -f "$HOME/.cargo/env" ]; then source "$HOME/.cargo/env"; fi
cd "$HOME/velora"

echo "=== content change rebuild (Frame.zig) ==="
cp src/core/browser/Frame.zig /tmp/Frame.zig.bak
printf '\n// rebuild-probe\n' >> src/core/browser/Frame.zig
/usr/bin/time -f "TIME real=%e user=%U sys=%S" zig build -Doptimize=ReleaseFast -Dprebuilt_v8_path=v8/libc_v8.a
mv /tmp/Frame.zig.bak src/core/browser/Frame.zig
echo "restored Frame.zig"
