#!/usr/bin/env bash
set -euo pipefail
VELORA_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WPT_RUN="$VELORA_ROOT/scripts/wpt-run.sh"

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

printf "%-72s %8s %s\n" "FILE" "RESULT" "DETAIL"
printf "%-72s %8s %s\n" "----" "------" "------"

for t in "${TESTS[@]}"; do
  out=$("$WPT_RUN" "$t" 2>&1 | grep -oE 'Pass [0-9]+/[0-9]+|Fail [0-9]+/[0-9]+' | tail -1 || true)
  if [[ -z "$out" ]]; then
    printf "%-72s %8s %s\n" "$t" "ERROR" "no result"
    continue
  fi
  fails=$(echo "$out" | sed -n 's/Fail \([0-9]*\)\/.*/\1/p')
  if [[ "$out" == Pass* ]] || [[ "$fails" == "0" ]]; then
    printf "%-72s %8s %s\n" "$t" "PASS" "$out"
  else
    printf "%-72s %8s %s\n" "$t" "FAIL" "$out"
  fi
done