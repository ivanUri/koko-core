#!/usr/bin/env bash
# Fetch curl-impersonate fork, build, apply Velora patches, sync → vendor/curl-impersonate/
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$("$ROOT/scripts/fetch-curl-impersonate.sh")"

echo "==> Building curl-impersonate in $DIR"
cd "$DIR"
make build
./scripts/apply-velora-patches.sh
make build

export CURL_IMPERSONATE_ROOT="$DIR"
"$ROOT/scripts/vendor-sync-curl.sh"