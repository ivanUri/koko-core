#!/usr/bin/env bash
set -euo pipefail
export PATH="/usr/local/bin:$HOME/.cargo/bin:$PATH"
if [ -f "$HOME/.cargo/env" ]; then source "$HOME/.cargo/env"; fi

echo "zig=$(zig version)"
echo "cargo=$(cargo --version)"

echo "=== sync project to ~/velora ==="
mkdir -p "$HOME/velora"
# Keep zig-cache / zig-out for incremental rebuild speed
rsync -a \
  --exclude zig-cache --exclude zig-out --exclude .velora-cache \
  --exclude node_modules \
  /mnt/c/Users/Admin/velora/ "$HOME/velora/"

cd "$HOME/velora"
mkdir -p v8
if [ ! -s v8/libc_v8.a ]; then
  if [ -s /mnt/c/Users/Admin/velora/v8/libc_v8.a ]; then
    cp /mnt/c/Users/Admin/velora/v8/libc_v8.a v8/libc_v8.a
  else
    curl -fsSL -o v8/libc_v8.a "https://github.com/lightpanda-io/zig-v8-fork/releases/download/v0.4.8/libc_v8_14.0.365.4_linux_x86_64.a"
  fi
fi

# Windows checkout is CRLF; zig fmt --check fails otherwise
echo "=== normalize LF for zig sources ==="
find src build.zig build.zig.zon -type f \( -name '*.zig' -o -name 'build.zig' -o -name 'build.zig.zon' \) -print0 2>/dev/null \
  | xargs -0 -r sed -i 's/\r$//'
sed -i 's/\r$//' build.zig build.zig.zon 2>/dev/null || true

echo "=== zig build ReleaseFast (timed) ==="
START=$(date +%s)
zig build -Doptimize=ReleaseFast -Dprebuilt_v8_path=v8/libc_v8.a
END=$(date +%s)
ELAPSED=$((END - START))
echo "BUILD_SECONDS=${ELAPSED}"
ls -lh zig-out/bin/
# keep a Windows-visible copy
mkdir -p /mnt/c/Users/Admin/velora/zig-out/bin
cp -f zig-out/bin/velora /mnt/c/Users/Admin/velora/zig-out/bin/velora-linux
echo BUILD_OK
