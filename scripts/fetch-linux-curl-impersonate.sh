#!/usr/bin/env bash
# Download lexiforest libcurl-impersonate for Linux x86_64 into vendor (does not
# overwrite macOS dylib/.a). Safe for dual-platform trees.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VER="${CURL_IMPERSONATE_VERSION:-v2.0.0rc3}"
ARCH="${CURL_IMPERSONATE_LINUX_ARCH:-x86_64-linux-gnu}"
OUT="$ROOT/vendor/curl-impersonate/linux"
URL="https://github.com/lexiforest/curl-impersonate/releases/download/${VER}/libcurl-impersonate-${VER}.${ARCH}.tar.gz"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$OUT"
echo "Downloading $URL"
curl -fsSL -o "$TMP/lib.tgz" "$URL"
tar -xzf "$TMP/lib.tgz" -C "$TMP"
echo "=== archive layout ==="
find "$TMP" -maxdepth 3 -type f | head -80
echo "=== copy into $OUT ==="
# Prefer shared libs + headers if present
if [ -d "$TMP/lib" ] || [ -d "$TMP/include" ]; then
  rsync -a --delete "$TMP/" "$OUT/" 2>/dev/null || cp -a "$TMP"/* "$OUT/" 2>/dev/null || true
else
  # flat layout
  cp -a "$TMP"/* "$OUT/" 2>/dev/null || true
fi
# Normalize common names
find "$OUT" -type f | head -50
ls -la "$OUT"
file "$OUT"/libcurl-impersonate* 2>/dev/null || true
file "$OUT"/lib/libcurl* 2>/dev/null || true
echo DONE
