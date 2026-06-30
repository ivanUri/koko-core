#!/usr/bin/env bash
# Copy libcurl-impersonate artifacts from curl-impersonate build → vendor/curl-impersonate/
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FORK="${CURL_IMPERSONATE_ROOT:-$ROOT/.velora-cache/curl-impersonate}"
VENDOR="$ROOT/vendor/curl-impersonate"

DYLIB_DIR=""
for candidate in \
  "$FORK/build/deps/build/curl/lib" \
  "$FORK/deps/build/curl/lib" \
  "$FORK/vendor/curl-impersonate"; do
  if [[ -f "$candidate/libcurl-impersonate.dylib" || -f "$candidate/libcurl-impersonate.4.dylib" ]]; then
    DYLIB_DIR="$candidate"
    break
  fi
done

if [[ -z "$DYLIB_DIR" && -f "$FORK/vendor/curl-impersonate/libcurl-impersonate.dylib" ]]; then
  DYLIB_DIR="$FORK/vendor/curl-impersonate"
fi

if [[ -z "$DYLIB_DIR" ]]; then
  echo "libcurl-impersonate not found under $FORK" >&2
  echo "Run: ./scripts/build-vendor-curl.sh" >&2
  echo "Or clone: ./scripts/fetch-curl-impersonate.sh" >&2
  exit 1
fi

mkdir -p "$VENDOR"
cp -f "$DYLIB_DIR"/libcurl-impersonate*.dylib "$VENDOR/" 2>/dev/null || true
if [[ -f "$DYLIB_DIR/libcurl-impersonate.dylib" ]]; then
  cp -f "$DYLIB_DIR/libcurl-impersonate.dylib" "$VENDOR/"
fi

INCLUDE_SRC="$FORK/build/deps/build/curl/include"
if [[ -d "$INCLUDE_SRC/curl" ]]; then
  rm -rf "$VENDOR/include"
  mkdir -p "$VENDOR/include"
  cp -R "$INCLUDE_SRC/curl" "$VENDOR/include/"
fi

if [[ -f "$FORK/vendor/curl-impersonate/curl_ws_stub.c" ]]; then
  cp -f "$FORK/vendor/curl-impersonate/curl_ws_stub.c" "$VENDOR/"
elif [[ -f "$ROOT/vendor/curl-impersonate/curl_ws_stub.c" ]]; then
  :
else
  echo "warning: curl_ws_stub.c not found" >&2
fi

# Copy curl_chrome* CLI helpers if present
for bin in "$FORK"/build/deps/build/curl/src/curl_chrome* "$FORK"/bin/curl_chrome*; do
  [[ -e "$bin" ]] && cp -f "$bin" "$VENDOR/" 2>/dev/null || true
done

echo "Synced to $VENDOR"
ls -la "$VENDOR"/libcurl-impersonate*.dylib 2>/dev/null || ls -la "$VENDOR"/*.dylib