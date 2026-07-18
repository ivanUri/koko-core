#!/usr/bin/env bash
# Apply Velora H3/QUIC fingerprint patches into a curl-impersonate build tree.
# Run AFTER first `make build` so ExternalProject sources exist under build/deps.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FORK="${CURL_IMPERSONATE_ROOT:-$ROOT/.velora-cache/curl-impersonate}"
PATCH_DIR="$ROOT/vendor/curl-impersonate-patches"

if [[ ! -d "$FORK" ]]; then
  echo "curl-impersonate root not found: $FORK" >&2
  exit 1
fi

find_src() {
  local name="$1"
  # Prefer ExternalProject source trees
  local c
  for c in \
    "$FORK/build/deps/src/$name" \
    "$FORK/build/deps/build/$name" \
    "$FORK/deps/src/$name" \
    "$FORK/deps/build/$name"; do
    if [[ -d "$c" ]]; then
      echo "$c"
      return 0
    fi
  done
  # fuzzy
  local hit
  hit="$(find "$FORK/build" -maxdepth 5 -type d -name "$name" 2>/dev/null | head -1 || true)"
  if [[ -n "$hit" ]]; then
    echo "$hit"
    return 0
  fi
  return 1
}

apply_patch() {
  local tree="$1"
  local patch="$2"
  local strip="${3:-1}"
  if [[ ! -f "$patch" ]]; then
    echo "missing patch $patch" >&2
    exit 1
  fi
  echo "==> patch -p$strip -d $tree < $(basename "$patch")"
  if patch -p"$strip" -d "$tree" --forward --dry-run <"$patch" >/dev/null 2>&1; then
    patch -p"$strip" -d "$tree" --forward <"$patch"
  elif patch -p"$strip" -d "$tree" --reverse --dry-run <"$patch" >/dev/null 2>&1; then
    echo "    (already applied)"
  else
    echo "    trying fuzzy..."
    patch -p"$strip" -d "$tree" --forward <"$patch" || {
      echo "FAILED: $patch on $tree" >&2
      exit 1
    }
  fi
}

CURL_SRC="$(find_src curl || find_src curl-8_21_0 || true)"
# ExternalProject often uses curl-curl-8_21_0
if [[ -z "${CURL_SRC:-}" ]]; then
  CURL_SRC="$(find "$FORK/build" -maxdepth 6 -type d -name 'curl*' 2>/dev/null | while read -r d; do
    [[ -f "$d/lib/vtls/openssl.c" ]] && echo "$d" && break
  done)"
fi
NGHTTP3_SRC="$(find_src nghttp3 || true)"
if [[ -z "${NGHTTP3_SRC:-}" ]]; then
  NGHTTP3_SRC="$(find "$FORK/build" -maxdepth 6 -type d -name 'nghttp3*' 2>/dev/null | while read -r d; do
    [[ -f "$d/lib/nghttp3_conn.c" || -f "$d/lib/includes/nghttp3/nghttp3.h" ]] && echo "$d" && break
  done)"
fi

echo "CURL_SRC=${CURL_SRC:-MISSING}"
echo "NGHTTP3_SRC=${NGHTTP3_SRC:-MISSING}"

if [[ -z "${CURL_SRC:-}" || ! -f "$CURL_SRC/lib/vtls/openssl.c" ]]; then
  echo "Could not locate curl openssl.c under $FORK/build" >&2
  find "$FORK/build" -name 'openssl.c' 2>/dev/null | head -10
  exit 1
fi
if [[ -z "${NGHTTP3_SRC:-}" ]]; then
  echo "Could not locate nghttp3 source" >&2
  exit 1
fi

# H3 control-stream GREASE + PRIORITY_UPDATE 0x0f0700
# Upstream renamed curl_ngtcp2.c → cf-ngtcp2.c; patch targets cf-ngtcp2.c.
# Skip if already present (idempotent).
if grep -q 'nghttp3_conn_submit_chrome_priority_update' "$CURL_SRC/lib/vquic/cf-ngtcp2.c" 2>/dev/null; then
  echo "==> H3 GREASE/PRIORITY already in cf-ngtcp2.c (skip curl patch)"
else
  apply_patch "$CURL_SRC" "$PATCH_DIR/velora-h3-fingerprint-curl.patch" 1
fi
if grep -q 'nghttp3_conn_submit_chrome_priority_update' "$NGHTTP3_SRC/lib/includes/nghttp3/nghttp3.h" 2>/dev/null \
  || grep -q 'submit_chrome_priority' "$NGHTTP3_SRC/lib/includes/nghttp3/nghttp3.h" 2>/dev/null; then
  echo "==> nghttp3 chrome priority APIs already present (skip nghttp3 patch)"
else
  apply_patch "$NGHTTP3_SRC" "$PATCH_DIR/velora-h3-fingerprint-nghttp3.patch" 1
fi

# QUIC ClientHello: omit SCT + status_request; prefer HTTP3 sig prefs
# These may need fuzz if line context drifted — try apply.
if ! apply_patch "$CURL_SRC" "$PATCH_DIR/velora-quic-chrome150-hello.patch" 1; then
  echo "warning: hello patch may need manual apply" >&2
fi
if ! apply_patch "$CURL_SRC" "$PATCH_DIR/velora-quic-http3-sig-prefs.patch" 1; then
  echo "warning: http3 sig prefs patch may need manual apply" >&2
fi

echo "==> Velora curl patches applied"
