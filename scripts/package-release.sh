#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:?usage: package-release.sh VERSION ARCH}"
ARCH="${2:?usage: package-release.sh VERSION ARCH}"

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  echo "Invalid semantic version: $VERSION" >&2
  exit 1
fi

case "$ARCH" in
  arm64|x86_64) ;;
  *) echo "Unsupported macOS architecture: $ARCH" >&2; exit 1 ;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
NAME="koko-${VERSION}-darwin-${ARCH}"
STAGE="$DIST/$NAME"
BINARY="$ROOT/zig-out/bin/koko"

test -x "$BINARY" || { echo "Missing release binary: $BINARY" >&2; exit 1; }
test -d "$ROOT/browser" || { echo "Missing browser data directory: $ROOT/browser" >&2; exit 1; }
shopt -s nullglob
DYLIBS=("$ROOT"/vendor/curl-impersonate/*.dylib)
(( ${#DYLIBS[@]} > 0 )) || { echo "Missing curl-impersonate dylib" >&2; exit 1; }

rm -rf "$STAGE" "$DIST/$NAME.tar.gz"
mkdir -p "$STAGE/bin" "$STAGE/lib" "$STAGE/share/koko"
cp "$BINARY" "$STAGE/bin/koko"
cp -R "$ROOT/browser/." "$STAGE/share/koko/browser/"
cp -R "${DYLIBS[@]}" "$STAGE/lib/"

# The development binary points at the checkout's vendor directory. Rewrite
# only that loader path; the bundled dylibs retain their normal @rpath links.
if command -v install_name_tool >/dev/null 2>&1; then
  install_name_tool -delete_rpath "$ROOT/vendor/curl-impersonate" "$STAGE/bin/koko" 2>/dev/null || true
  install_name_tool -add_rpath "@loader_path/../lib" "$STAGE/bin/koko"
fi

tar -C "$DIST" -czf "$DIST/$NAME.tar.gz" "$NAME"
LC_ALL=C shasum -a 256 "$DIST/$NAME.tar.gz"
