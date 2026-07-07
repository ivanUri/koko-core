#!/usr/bin/env bash
# Set ivanUri/velora GitHub description + topics (run once as ivanUri).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="$ROOT/.github/repo-profile.json"

if ! command -v gh >/dev/null; then
  echo "Install gh: brew install gh" >&2
  exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
  echo "Run: gh auth login   (account: ivanUri, SSH: github-ivan)" >&2
  exit 1
fi

DESC="$(jq -r '.description' "$PROFILE")"
HOME="$(jq -r '.homepage // ""' "$PROFILE")"

gh repo edit ivanUri/velora --description "$DESC" --homepage "$HOME"

while IFS= read -r topic; do
  gh repo edit ivanUri/velora --add-topic "$topic"
done < <(jq -r '.topics[]' "$PROFILE")

echo "Updated ivanUri/velora profile:"
gh repo view ivanUri/velora --json description,homepage,repositoryTopics --jq '{description, homepage, topics: [.repositoryTopics.nodes[].topic.name]}'