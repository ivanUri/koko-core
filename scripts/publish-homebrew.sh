#!/usr/bin/env bash
# Publish Velora to ivanUri/homebrew-tap (bottle in tap repo).
# Prereq: ./scripts/release-macos.sh, git remote git@github-ivan:ivanUri/homebrew-tap.git
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAP_DIR="${TAP_DIR:-$HOME/Desktop/homebrew-tap}"
VERSION="${1:-1.0.0}"
PLATFORM="${PLATFORM:-darwin-arm64}"
TARBALL="$ROOT/dist/velora-${VERSION}-${PLATFORM}.tar.gz"
BOTTLE_NAME="velora-${VERSION}-${PLATFORM}.tar.gz"

if [[ ! -f "$TARBALL" ]]; then
  echo "Missing tarball. Run: ./scripts/release-macos.sh $VERSION" >&2
  exit 1
fi

SHA256="$(shasum -a 256 "$TARBALL" | awk '{print $1}')"
echo "SHA256: $SHA256"

mkdir -p "$TAP_DIR/Formula"
cp "$ROOT/packaging/homebrew/velora.rb" "$TAP_DIR/Formula/velora.rb"

perl -i -pe "s|url \".*\"|url \"https://github.com/ivanUri/velora/releases/download/v${VERSION}/${BOTTLE_NAME}\"|" \
  "$TAP_DIR/Formula/velora.rb"
perl -i -pe "s|sha256 \".*\"|sha256 \"${SHA256}\"|" "$TAP_DIR/Formula/velora.rb"
perl -i -pe "s|version \".*\"|version \"${VERSION}\"|" "$TAP_DIR/Formula/velora.rb"

cd "$TAP_DIR"
git remote set-url origin git@github-ivan:ivanUri/homebrew-tap.git 2>/dev/null || true
git add Formula/velora.rb
git commit -m "velora ${VERSION} (${PLATFORM})"
git push origin main

echo ""
echo "Ensure GitHub Release exists:"
echo "  git tag v${VERSION} && git push git@github-ivan:ivanUri/velora.git v${VERSION}"
echo "  (triggers .github/workflows/release.yml)"

echo ""
echo "Done. Verify:"
echo "  brew update && brew upgrade velora   # or: brew install ivanUri/tap/velora"