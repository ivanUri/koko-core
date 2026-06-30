#!/usr/bin/env bash
# Clone or update ivanUri/curl-impersonate (not vendored inside velora repo).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="${CURL_IMPERSONATE_REPO:-https://github.com/ivanUri/curl-impersonate.git}"
DIR="${CURL_IMPERSONATE_ROOT:-$ROOT/.velora-cache/curl-impersonate}"

if [[ ! -d "$DIR/.git" ]]; then
  mkdir -p "$(dirname "$DIR")"
  echo "==> Cloning $REPO → $DIR"
  git clone --branch main "$REPO" "$DIR"
else
  echo "==> Updating $DIR"
  git -C "$DIR" fetch origin main
  git -C "$DIR" checkout main
  git -C "$DIR" pull --ff-only origin main
fi

echo "$DIR"