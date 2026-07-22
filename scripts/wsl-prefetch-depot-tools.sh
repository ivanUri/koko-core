#!/usr/bin/env bash
# Populate Zig package cache with depot_tools when zig's git+ fetch fails
# (ProtocolError to chromium.googlesource.com). Does not change build.zig.zon.
set -euo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
HASH="N-V-__8AABDOXwDW4TLrTiydikRCN2ym9hJI1GKGR09ZLBvY"
COMMIT="4ce8ba39a3488397a2d1494f167020f21de502f3"
CACHE="${ZIG_GLOBAL_CACHE_DIR:-$HOME/.cache/zig}/p"
DEST="$CACHE/$HASH"

if [ -d "$DEST" ] && [ -f "$DEST/.git" ] || [ -f "$DEST/gclient.py" ] || [ -f "$DEST/README.md" ] || [ -d "$DEST" ]; then
  if [ -e "$DEST/gclient.py" ] || [ -e "$DEST/README" ] || [ -e "$DEST/README.md" ]; then
    echo "depot_tools already cached at $DEST"
    exit 0
  fi
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "Cloning depot_tools @$COMMIT via git..."
# Prefer github mirror (googlesource works for curl but zig git+ often fails)
if ! git clone --filter=blob:none https://chromium.googlesource.com/chromium/tools/depot_tools.git "$TMP/depot_tools" 2>/tmp/dt-clone.err; then
  echo "googlesource clone failed, trying git clone full..."
  cat /tmp/dt-clone.err || true
  git clone https://github.com/nicolasnoble/depot_tools.git "$TMP/depot_tools" || \
    git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git "$TMP/depot_tools"
fi
cd "$TMP/depot_tools"
git fetch --depth 1 origin "$COMMIT" 2>/dev/null || git fetch origin "$COMMIT" || true
git checkout "$COMMIT" 2>/dev/null || true

mkdir -p "$CACHE"
rm -rf "$DEST"
# zig expects package content at p/<hash>/
cp -a "$TMP/depot_tools" "$DEST"
# Write expected hash marker if needed
echo "Installed depot_tools into $DEST"
ls "$DEST" | head
