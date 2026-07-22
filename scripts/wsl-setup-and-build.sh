#!/usr/bin/env bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
export PATH="/usr/local/bin:$HOME/.cargo/bin:/usr/bin:/bin:$PATH"
if [ -f "$HOME/.cargo/env" ]; then
  # shellcheck source=/dev/null
  source "$HOME/.cargo/env"
fi

WIN_ROOT="/mnt/d/velora"
HOME_ROOT="$HOME/velora"

echo "=== toolchain ==="
if ! command -v cargo >/dev/null 2>&1; then
  echo "Installing Rust..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
  # shellcheck source=/dev/null
  source "$HOME/.cargo/env"
fi

if ! command -v zig >/dev/null 2>&1 || [ "$(zig version 2>/dev/null || true)" != "0.15.2" ]; then
  echo "Installing Zig 0.15.2..."
  cd /tmp
  curl -fsSL -O "https://ziglang.org/download/0.15.2/zig-x86_64-linux-0.15.2.tar.xz"
  tar -xf zig-x86_64-linux-0.15.2.tar.xz
  rm -rf /usr/local/lib/zig-x86_64-linux-0.15.2
  mv zig-x86_64-linux-0.15.2 /usr/local/lib/
  ln -sfn /usr/local/lib/zig-x86_64-linux-0.15.2/zig /usr/local/bin/zig
fi

echo "zig=$(zig version)"
echo "cargo=$(cargo --version)"
echo "win_root=$WIN_ROOT"
test -d "$WIN_ROOT"
test -f "$WIN_ROOT/build.zig"

# Fetch Linux curl-impersonate into the Windows tree if missing
if [ ! -e "$WIN_ROOT/vendor/curl-impersonate/linux/libcurl-impersonate.so" ]; then
  echo "=== fetch Linux curl-impersonate ==="
  sed -i 's/\r$//' "$WIN_ROOT/scripts/fetch-linux-curl-impersonate.sh"
  # Patch script to use D: path if it hardcodes C:
  if grep -q '/mnt/c/Users/Admin/velora' "$WIN_ROOT/scripts/fetch-linux-curl-impersonate.sh"; then
    bash "$WIN_ROOT/scripts/fetch-linux-curl-impersonate.sh" || true
  fi
  # Run from repo root so relative paths work
  cd "$WIN_ROOT"
  bash scripts/fetch-linux-curl-impersonate.sh
fi

echo "=== sync project to $HOME_ROOT ==="
mkdir -p "$HOME_ROOT"
rsync -a \
  --exclude zig-cache --exclude zig-out --exclude .velora-cache \
  --exclude node_modules \
  "$WIN_ROOT/" "$HOME_ROOT/"

cd "$HOME_ROOT"
mkdir -p v8
if [ ! -s v8/libc_v8.a ]; then
  if [ -s "$WIN_ROOT/v8/libc_v8.a" ]; then
    cp "$WIN_ROOT/v8/libc_v8.a" v8/libc_v8.a
  else
    echo "=== download prebuilt V8 ==="
    curl -fsSL -o v8/libc_v8.a \
      "https://github.com/lightpanda-io/zig-v8-fork/releases/download/v0.4.8/libc_v8_14.0.365.4_linux_x86_64.a"
  fi
fi
ls -lh v8/libc_v8.a

# WSL-only override: prebuilt V8 does not need depot_tools
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

echo "=== normalize LF for zig sources ==="
find src -name '*.zig' -print0 | xargs -0 -r sed -i 's/\r$//'
sed -i 's/\r$//' build.zig build.zig.zon 2>/dev/null || true

echo "=== zig build ReleaseFast ==="
START=$(date +%s)
zig build -Doptimize=ReleaseFast -Dprebuilt_v8_path=v8/libc_v8.a
END=$(date +%s)
echo "BUILD_SECONDS=$((END - START))"
ls -lh zig-out/bin/

if strings zig-out/bin/velora | grep -q curl_easy_impersonate; then
  echo "OK: binary references curl_easy_impersonate"
fi

mkdir -p "$WIN_ROOT/zig-out/bin"
cp -f zig-out/bin/velora "$WIN_ROOT/zig-out/bin/velora-linux"
# also copy any companion libs if present
if [ -d vendor/curl-impersonate/linux ]; then
  mkdir -p "$WIN_ROOT/zig-out/lib"
  cp -a vendor/curl-impersonate/linux/. "$WIN_ROOT/zig-out/lib/" 2>/dev/null || true
fi

echo "BUILD_OK"
echo "binary: $WIN_ROOT/zig-out/bin/velora-linux"
