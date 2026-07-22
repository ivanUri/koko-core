#!/usr/bin/env bash
set -euo pipefail
WORK=/root/wpt-css-work
WPT_DIR="$WORK/wpt"
mkdir -p "$WORK"

if [ ! -d "$WPT_DIR/.git" ]; then
  echo "=== sparse clone WPT ==="
  git clone --filter=blob:none --sparse --depth=1 \
    https://github.com/web-platform-tests/wpt.git "$WPT_DIR"
  cd "$WPT_DIR"
  git sparse-checkout set \
    resources \
    tools \
    common \
    interfaces \
    css/css-syntax \
    css/cssom \
    css/css-variables \
    css/css-cascade \
    css/selectors \
    css/css-color \
    css/css-values
else
  cd "$WPT_DIR"
  echo "=== WPT already present ==="
fi

# Count tests
find css -type f \( -name '*.html' \) 2>/dev/null | wc -l
echo "=== sample tests ==="
find css/css-syntax css/cssom -type f -name '*.html' 2>/dev/null | head -20
ls resources | head
ls tools | head
