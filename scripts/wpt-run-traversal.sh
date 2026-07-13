#!/usr/bin/env bash
# Run dom/traversal WPT tests with velora restart before each file.
set -euo pipefail

VELORA_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VELORA_BIN="$VELORA_ROOT/zig-out/bin/velora"
WPT_RUN="$VELORA_ROOT/scripts/wpt-run.sh"
VELORA_PID=""

cleanup() {
  if [[ -n "${VELORA_PID:-}" ]] && kill -0 "$VELORA_PID" 2>/dev/null; then
    kill "$VELORA_PID" 2>/dev/null || true
    wait "$VELORA_PID" 2>/dev/null || true
  fi
  pkill -f "velora serve.*9222" 2>/dev/null || true
}
trap cleanup EXIT

restart_velora() {
  cleanup
  trap - EXIT
  pkill -f "velora serve.*9222" 2>/dev/null || true
  sleep 0.5
  (cd "$VELORA_ROOT" && "$VELORA_BIN" serve --host 127.0.0.1 --port 9222 \
    --insecure-disable-tls-host-verification --log-level error) &
  VELORA_PID=$!
  trap cleanup EXIT
  local i=0
  while ! curl -sf http://127.0.0.1:9222/json/version >/dev/null 2>&1; do
    sleep 0.3
    i=$((i + 1))
    if [[ $i -gt 40 ]]; then
      echo "velora failed to start" >&2
      return 1
    fi
  done
}

run_test() {
  local path="$1"
  restart_velora
  echo "========== $path =========="
  local out
  out=$("$WPT_RUN" "$path" 2>&1 | grep -oE 'Pass [0-9]+/[0-9]+|Fail [0-9]+/[0-9]+' | tail -1 || true)
  if [[ -z "$out" ]]; then
    echo "RESULT: ERROR $path"
  elif [[ "$out" == Pass* ]] || [[ "$(echo "$out" | sed -n 's/Fail \([0-9]*\)\/.*/\1/p')" == "0" ]]; then
    echo "RESULT: PASS $path ($out)"
  else
    echo "RESULT: FAIL $path ($out)"
  fi
}

TESTS=(
  "dom/traversal/NodeFilter-constants.html"
  "dom/traversal/TreeWalker-basic.html"
  "dom/traversal/TreeWalker-currentNode.html"
  "dom/traversal/TreeWalker-walking-outside-a-tree.html"
  "dom/traversal/TreeWalker-previousSiblingLastChildSkip.html"
  "dom/traversal/TreeWalker-previousNodeLastChildReject.html"
  "dom/traversal/TreeWalker-traversal-skip.html"
  "dom/traversal/TreeWalker-traversal-skip-most.html"
  "dom/traversal/TreeWalker-traversal-reject.html"
  "dom/traversal/TreeWalker-acceptNode-filter.html"
  "dom/traversal/TreeWalker-acceptNode-filter-cross-realm.html"
  "dom/traversal/TreeWalker-acceptNode-filter-cross-realm-null-browsing-context.html"
  "dom/traversal/TreeWalker-realm.html"
  "dom/traversal/TreeWalker-nextNode-detached-currentNode.window.js"
  "dom/traversal/NodeIterator.html"
  "dom/traversal/NodeIterator-removal.html"
  "dom/traversal/NodeIterator-removal-during-filtering.html"
)

for t in "${TESTS[@]}"; do
  run_test "$t"
done

echo ""
echo "=== TRAVERSAL DONE ==="