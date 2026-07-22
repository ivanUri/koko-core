#!/usr/bin/env bash
set -euo pipefail
export PATH="/usr/local/bin:/usr/bin:$PATH"
cd /tmp
for v in 8_15_0 8_16_0 8_17_0 8_18_0; do
  ver="${v//_/.}"
  url="https://github.com/curl/curl/releases/download/curl-${v}/curl-${ver}.tar.gz"
  echo "=== $v ==="
  if curl -fsSL -o "/tmp/curl-${ver}.tar.gz" "$url"; then
    tar -tzf "/tmp/curl-${ver}.tar.gz" | grep -E 'lib/(cf-ip-happy|curl_fopen|curl_share|multi_ntfy|ratelimit|vtls/apple|vssh/vssh|curlx/fopen|curlx/strcopy|curlx/strerr)\.c' || true
  else
    echo "download failed"
  fi
done
