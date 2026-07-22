#!/usr/bin/env bash
set -euo pipefail
export PATH="/usr/local/bin:$HOME/.cargo/bin:/usr/bin:/bin:$PATH"
if [ -f "$HOME/.cargo/env" ]; then source "$HOME/.cargo/env"; fi

echo "zig=$(zig version)"
echo "cargo=$(cargo --version)"

# Ensure Linux curl-impersonate is present (does not touch macOS vendor files)
if [ ! -e /mnt/c/Users/Admin/velora/vendor/curl-impersonate/linux/libcurl-impersonate.so ]; then
  echo "=== fetch Linux curl-impersonate ==="
  sed -i 's/\r$//' /mnt/c/Users/Admin/velora/scripts/fetch-linux-curl-impersonate.sh
  bash /mnt/c/Users/Admin/velora/scripts/fetch-linux-curl-impersonate.sh
fi

echo "=== sync project to ~/velora ==="
mkdir -p "$HOME/velora"
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

# WSL-only override: zig's git+ fetch of depot_tools often hits ProtocolError to
# chromium.googlesource.com. Prebuilt V8 does not need depot_tools. The committed
# build.zig.zon keeps the real URL so macOS / source V8 builds are unchanged.
mkdir -p vendor/v8-wrapper/depot_tools_stub
echo "stub" > vendor/v8-wrapper/depot_tools_stub/README
cat > vendor/v8-wrapper/build.zig.zon <<'ZON'
.{
    .name = .v8,
    .version = "0.0.0",
    .fingerprint = 0x10be7411eb47d7c5,
    .minimum_zig_version = "0.15.2",
    .dependencies = .{
        .depot_tools = .{ .path = "depot_tools_stub" },
    },
    .paths = .{
        "src/",
        "build-tools/",
        "README",
        "LICENSE",
        "build.zig",
        "build.zig.zon",
    },
}
ZON

# Windows checkout is CRLF; zig fmt --check fails otherwise
echo "=== normalize LF for zig sources ==="
find src -name '*.zig' -print0 | xargs -0 -r sed -i 's/\r$//'
sed -i 's/\r$//' build.zig build.zig.zon 2>/dev/null || true

echo "=== zig build ReleaseFast (curl-impersonate linux) ==="
START=$(date +%s)
zig build -Doptimize=ReleaseFast -Dprebuilt_v8_path=v8/libc_v8.a
END=$(date +%s)
echo "BUILD_SECONDS=$((END - START))"
ls -lh zig-out/bin/

# Confirm build_config linked impersonate
if strings zig-out/bin/velora | grep -q curl_easy_impersonate; then
  echo "OK: binary references curl_easy_impersonate"
fi

export LD_LIBRARY_PATH="$HOME/velora/vendor/curl-impersonate/linux:${LD_LIBRARY_PATH:-}"
mkdir -p /mnt/c/Users/Admin/velora/zig-out/bin
cp -f zig-out/bin/velora /mnt/c/Users/Admin/velora/zig-out/bin/velora-linux
echo BUILD_OK
