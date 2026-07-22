#!/usr/bin/env bash
set -euo pipefail
export PATH="/usr/local/bin:$HOME/.cargo/bin:/usr/bin:/bin:$PATH"
if [ -f "$HOME/.cargo/env" ]; then source "$HOME/.cargo/env"; fi
cd "$HOME/velora"

echo "=== machine ==="
nproc
free -h | head -2
ls -lh v8/libc_v8.a zig-out/bin/velora 2>/dev/null || true

echo "=== warm rebuild (no source change) ==="
/usr/bin/time -f "TIME real=%e user=%U sys=%S" zig build -Doptimize=ReleaseFast -Dprebuilt_v8_path=v8/libc_v8.a

echo "=== force zig recompile only (touch one file) ==="
touch src/velora.zig
/usr/bin/time -f "TIME real=%e user=%U sys=%S" zig build -Doptimize=ReleaseFast -Dprebuilt_v8_path=v8/libc_v8.a
