#!/usr/bin/env bash
set -euo pipefail
cd /root/wpt-css-work/wpt

echo "=== expand sparse checkout for tools/docs ==="
git sparse-checkout set \
  resources \
  tools \
  common \
  interfaces \
  docs \
  css/css-syntax \
  css/cssom \
  css/css-variables \
  css/css-cascade \
  css/selectors \
  css/css-color \
  css/css-values

# Ensure docs/commands.json exists
ls docs/commands.json 2>/dev/null || git sparse-checkout add docs

python3 -m pip install --break-system-packages requests html5lib 2>/dev/null || true

echo "=== generate manifest via tools/manifest ==="
# Direct path avoids full wpt CLI command registry
if [ -f tools/manifest/update.py ]; then
  python3 tools/manifest/update.py -p MANIFEST.json -v 2>&1 | tail -50
elif [ -f tools/manifest/__main__.py ]; then
  python3 -m tools.manifest -p MANIFEST.json 2>&1 | tail -50
else
  python3 ./wpt manifest --no-download -p MANIFEST.json 2>&1 | tail -50
fi

ls -lh MANIFEST.json
python3 - <<'PY'
import json
m=json.load(open('MANIFEST.json'))
th=m.get('items',{}).get('testharness',{})
def count(node):
    n=0
    if not isinstance(node, dict):
        return 1
    for v in node.values():
        if isinstance(v, dict):
            n+=count(v)
        else:
            n+=1
    return n
print('version', m.get('version'))
print('testharness count', count(th))
print('css count', count(th.get('css',{})))
print('css children', list(th.get('css',{}).keys())[:40])
PY
