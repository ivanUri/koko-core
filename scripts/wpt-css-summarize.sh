#!/usr/bin/env bash
set -euo pipefail
OUT=/mnt/d/velora/code-check/wpt-css-results
echo "=== summary ==="
cat "$OUT/summary.txt"
echo "=== harness incomplete count ==="
grep -c 'no test suite completion' "$OUT/failures.detail.txt" || true
echo "=== failures list ==="
cat "$OUT/failures.txt"
echo "=== detail sample ==="
head -80 "$OUT/failures.detail.txt"
python3 - <<'PY'
import json
from pathlib import Path
out = Path("/mnt/d/velora/code-check/wpt-css-results")
r = json.loads(out.joinpath("results.json").read_text())
passes, fails, incomplete = [], [], []
for x in r:
    name = x.get("name","?")
    cases = x.get("cases") or []
    msg = x.get("message") or ""
    if any("never reaches the completion" in (c.get("message") or "") or c.get("name")=="no test suite completion" for c in cases) or "no progress" in msg:
        incomplete.append(name)
    elif x.get("pass"):
        passes.append(name)
    else:
        bad = [c for c in cases if not c.get("pass")]
        fails.append((name, len(bad), len(cases), msg[:80]))

print(f"\npass_files={len(passes)} fail_files={len(fails)} incomplete_files={len(incomplete)}")
print("PASS files:")
for p in passes: print(" ", p)
print("INCOMPLETE files:")
for p in incomplete: print(" ", p)

# rewrite failures.txt to exclude pure incompletes? User asked for failures - keep all fails.
# Also write failures.real.txt = assertion fails only
real = out/"failures.real.txt"
real.write_text("\n".join(n for n,_,_,_ in fails)+("\n" if fails else ""), encoding="utf-8")
inc = out/"failures.incomplete.txt"
inc.write_text("\n".join(incomplete)+("\n" if incomplete else ""), encoding="utf-8")
print("wrote", real, "and", inc)
PY
