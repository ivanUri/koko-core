#!/usr/bin/env bash
set -euo pipefail
DIR="${1:-./logs}"
DAYS="${2:-7}"
if [[ ! -d "$DIR" ]]; then
  echo "missing: $DIR" >&2
  exit 1
fi
find "$DIR" -mindepth 1 -maxdepth 1 -type d ! -name latest -mtime +"$DAYS" -print -exec rm -rf {} +