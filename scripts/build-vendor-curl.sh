#!/usr/bin/env bash
# Fetch curl-impersonate, build, apply Velora H3/QUIC patches, rebuild, sync → vendor/
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export CURL_IMPERSONATE_REPO="${CURL_IMPERSONATE_REPO:-https://github.com/lexiforest/curl-impersonate.git}"
# Prefer tagged release matching Chrome 150 BoringSSL unless overridden
export CURL_IMPERSONATE_REF="${CURL_IMPERSONATE_REF:-v2.0.0rc3}"

DIR="${CURL_IMPERSONATE_ROOT:-}"
if [[ -z "$DIR" ]]; then
  DIR="$ROOT/.velora-cache/curl-impersonate"
  export CURL_IMPERSONATE_ROOT="$DIR"
fi

if [[ ! -d "$DIR/.git" ]]; then
  echo "==> Cloning $CURL_IMPERSONATE_REPO ($CURL_IMPERSONATE_REF) → $DIR"
  git clone --depth 1 --branch "$CURL_IMPERSONATE_REF" "$CURL_IMPERSONATE_REPO" "$DIR"
else
  echo "==> Updating $DIR to $CURL_IMPERSONATE_REF"
  git -C "$DIR" fetch --depth 1 origin "refs/tags/$CURL_IMPERSONATE_REF:refs/tags/$CURL_IMPERSONATE_REF" 2>/dev/null \
    || git -C "$DIR" fetch --depth 1 origin "$CURL_IMPERSONATE_REF" || true
  git -C "$DIR" checkout "$CURL_IMPERSONATE_REF" 2>/dev/null \
    || git -C "$DIR" checkout -B "velora-$CURL_IMPERSONATE_REF" "origin/$CURL_IMPERSONATE_REF" 2>/dev/null \
    || true
fi

echo "==> Building curl-impersonate (pass 1 — fetch deps + compile)"
cd "$DIR"
# macOS arm64: may need to disable asm on some hosts; leave default
make build JOBS="${JOBS:-$(sysctl -n hw.ncpu 2>/dev/null || echo 4)}"

echo "==> Applying Velora H3/QUIC patches"
"$ROOT/scripts/apply-velora-curl-patches.sh"

echo "==> Building curl-impersonate (pass 2 — patched)"
# Force curl/nghttp3 rebuild after patches
rm -f build/deps/build/curl/src/curl-impersonate 2>/dev/null || true
# touch patched files so cmake rebuilds
find build -path '*curl*/lib/vquic/curl_ngtcp2.c' -exec touch {} \; 2>/dev/null || true
find build -path '*curl*/lib/vtls/openssl.c' -exec touch {} \; 2>/dev/null || true
find build -path '*nghttp3*/lib/nghttp3_conn.c' -exec touch {} \; 2>/dev/null || true
make build JOBS="${JOBS:-$(sysctl -n hw.ncpu 2>/dev/null || echo 4)}"

export CURL_IMPERSONATE_ROOT="$DIR"
"$ROOT/scripts/vendor-sync-curl.sh"

# Install chrome150 wrapper (TCP ML-DSA + H3 classic)
cat > "$ROOT/vendor/curl-impersonate/curl_chrome150" <<'EOF'
#!/usr/bin/env bash
# Chrome 150: TCP ML-DSA sigs; QUIC uses chrome146 http3_sig_hash_algs (classic+sha1)
# after Velora openssl patch prefers HTTP3 list on TRNSPRT_QUIC.
dir=${0%/*}
TLS_SIGS="mldsa44:mldsa65:mldsa87:ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha384:rsa_pkcs1_sha384:rsa_pss_rsae_sha512:rsa_pkcs1_sha512"
H3_SIGS="ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha384:rsa_pkcs1_sha384:rsa_pss_rsae_sha512:rsa_pkcs1_sha512:rsa_pkcs1_sha1"
exec "$dir/curl-impersonate" --compressed --impersonate "chrome146" \
  --signature-hashes "$TLS_SIGS" \
  --http3-sig-hash-algs "$H3_SIGS" \
  "$@"
EOF
chmod +x "$ROOT/vendor/curl-impersonate/curl_chrome150"

echo "==> Done. Smoke: vendor/curl-impersonate/curl_chrome150 --http3 -sS https://quic.browserleaks.com/json | head"
