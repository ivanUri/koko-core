#!/usr/bin/env bash
set -euo pipefail
export PATH="/usr/local/bin:$HOME/.cargo/bin:$PATH"
if [ -f "$HOME/.cargo/env" ]; then source "$HOME/.cargo/env"; fi

# Work on Linux copy
rsync -a --delete \
  --exclude zig-cache --exclude zig-out --exclude .velora-cache --exclude node_modules \
  /mnt/c/Users/Admin/velora/ "$HOME/velora/"
cd "$HOME/velora"

# Ensure prebuilt V8 still present after rsync exclude of nothing for v8
mkdir -p v8
if [ ! -s v8/libc_v8.a ]; then
  cp /mnt/c/Users/Admin/velora/v8/libc_v8.a v8/libc_v8.a
fi

echo "=== zig fetch curl 8.18.0 ==="
# Update the curl dependency in build.zig.zon and print hash
zig fetch --save=curl https://github.com/curl/curl/releases/download/curl-8_18_0/curl-8.18.0.tar.gz
echo "=== build.zig.zon curl entry ==="
grep -A4 'curl' build.zig.zon | head -20

# Copy updated zon back to Windows tree so it persists
cp build.zig.zon /mnt/c/Users/Admin/velora/build.zig.zon

echo "=== snapshot_creator ==="
zig build -Doptimize=ReleaseFast -Dprebuilt_v8_path=v8/libc_v8.a snapshot_creator -- src/snapshot.bin
ls -lh src/snapshot.bin

echo "=== zig build ReleaseFast ==="
zig build -Doptimize=ReleaseFast -Dsnapshot_path=../../snapshot.bin -Dprebuilt_v8_path=v8/libc_v8.a
ls -lh zig-out/bin/
echo BUILD_OK
