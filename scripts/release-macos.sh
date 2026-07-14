#!/usr/bin/env bash
# Package velora + libcurl-impersonate for macOS Homebrew / GitHub Releases.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  VERSION="$(grep -E '^\s*\.version\s*=' build.zig.zon | sed -E 's/.*"([^"]+)".*/\1/')"
  VERSION="${VERSION%-dev}"
fi

ARCH="$(uname -m)"
case "$ARCH" in
  arm64) PLATFORM="darwin-arm64" ;;
  x86_64) PLATFORM="darwin-x86_64" ;;
  *) echo "Unsupported arch: $ARCH" >&2; exit 1 ;;
esac

echo "==> Building V8 snapshot..."
zig build -Doptimize=ReleaseFast snapshot_creator -- src/snapshot.bin

echo "==> Building velora (ReleaseFast + embedded snapshot)..."
# @embedFile in Snapshot.zig is relative to src/core/js/
zig build -Doptimize=ReleaseFast -Dsnapshot_path=../../snapshot.bin

BIN="$ROOT/zig-out/bin/velora"
DYLIB_DIR="$ROOT/vendor/curl-impersonate"
if [[ ! -x "$BIN" ]]; then
  echo "Missing binary: $BIN" >&2
  exit 1
fi
if [[ ! -f "$DYLIB_DIR/libcurl-impersonate.4.8.0.dylib" ]]; then
  echo "Missing libcurl-impersonate dylib in $DYLIB_DIR" >&2
  echo "Build curl-impersonate first (see docs/tls-impersonate.md)." >&2
  exit 1
fi

STAGE="velora-${VERSION}-${PLATFORM}"
OUT_DIR="$ROOT/dist/${STAGE}"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR/bin" "$OUT_DIR/lib" "$OUT_DIR/share/velora"

cp "$BIN" "$OUT_DIR/bin/velora"
chmod +x "$OUT_DIR/bin/velora"

cp "$DYLIB_DIR/libcurl-impersonate.4.8.0.dylib" "$OUT_DIR/lib/"
(
  cd "$OUT_DIR/lib"
  ln -sf libcurl-impersonate.4.8.0.dylib libcurl-impersonate.4.dylib
  ln -sf libcurl-impersonate.4.dylib libcurl-impersonate.dylib
)

mkdir -p "$OUT_DIR/share/velora/browser"
cp browser/velora.json "$OUT_DIR/share/velora/browser/"
cp -R browser/templates "$OUT_DIR/share/velora/browser/"
if [[ -d browser/catalog ]]; then
  cp -R browser/catalog "$OUT_DIR/share/velora/browser/"
fi
cp -R browser/policies "$OUT_DIR/share/velora/browser/"

# Homebrew installs to <prefix>/bin and <prefix>/lib — point velora at ../lib
install_name_tool -delete_rpath "$DYLIB_DIR" "$OUT_DIR/bin/velora" 2>/dev/null || true
install_name_tool -add_rpath "@executable_path/../lib" "$OUT_DIR/bin/velora"
install_name_tool -change "@rpath/libcurl-impersonate.4.dylib" "@executable_path/../lib/libcurl-impersonate.4.dylib" "$OUT_DIR/bin/velora" 2>/dev/null || true

mkdir -p "$ROOT/dist"
TARBALL="$ROOT/dist/${STAGE}.tar.gz"
tar -czf "$TARBALL" -C "$ROOT/dist" "$STAGE"

echo ""
echo "Created: $TARBALL"
echo "SHA256:  $(shasum -a 256 "$TARBALL" | awk '{print $1}')"
echo ""
echo "Next:"
echo "  1. gh release create v${VERSION} $TARBALL"
echo "  2. Update packaging/homebrew/velora.rb url + sha256"
echo "  3. Push formula to github.com/ivanUri/homebrew-tap"