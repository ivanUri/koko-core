#!/usr/bin/env bash
# Serve sparse WPT CSS, run wptrunner once, write only failing tests.
set -euo pipefail

export PATH="/usr/local/go/bin:/usr/local/bin:$PATH"
export LD_LIBRARY_PATH="${HOME}/velora/vendor/curl-impersonate/linux:${LD_LIBRARY_PATH:-}"

WORK=/root/wpt-css-work
WPT_DIR="$WORK/wpt"
DEMO_DIR="$WORK/demo"
OUT_DIR=/mnt/d/velora/code-check/wpt-css-results
WPT_PORT=8000
CDP_PORT=9222
VELORA_BIN=/root/velora/zig-out/bin/velora
FILTERS="${FILTERS:-css/css-syntax css/cssom css/css-variables}"
MAX_TESTS="${MAX_TESTS:-40}"

mkdir -p "$OUT_DIR"
FAIL_FILE="$OUT_DIR/failures.txt"
JSON_FILE="$OUT_DIR/results.json"
SUMMARY_FILE="$OUT_DIR/summary.txt"
RAW_FILE="$OUT_DIR/raw.log"

VELORA_PID=""
WPT_PID=""
cleanup() {
  [[ -n "${VELORA_PID:-}" ]] && kill "$VELORA_PID" 2>/dev/null || true
  [[ -n "${WPT_PID:-}" ]] && kill "$WPT_PID" 2>/dev/null || true
  pkill -f "velora serve.*${CDP_PORT}" 2>/dev/null || true
  pkill -f "http.server ${WPT_PORT}" 2>/dev/null || true
}
trap cleanup EXIT

echo "=== preprocess CSS HTML for script-order workaround ==="
python3 /mnt/d/velora/scripts/wpt-css-preprocess.py

echo "=== patch testharnessreport.js for wptrunner ==="
cp -a "$WPT_DIR/resources/testharnessreport.js" "$WPT_DIR/resources/testharnessreport.js.bak" 2>/dev/null || true
curl -fsSL "https://raw.githubusercontent.com/lightpanda-io/wpt/fork/resources/testharnessreport.js" \
  -o "$WPT_DIR/resources/testharnessreport.js"
if ! grep -q 'completed:' "$WPT_DIR/resources/testharnessreport.js"; then
  python3 - <<'PY'
from pathlib import Path
p = Path("/root/wpt-css-work/wpt/resources/testharnessreport.js")
t = p.read_text()
t = t.replace("complete: false,", "complete: false,\n  completed: 0,", 1)
t = t.replace(
    "report.cases[report.name(test)] = report.format(test);\n  report.update();",
    "report.cases[report.name(test)] = report.format(test);\n  report.completed = Object.keys(report.cases).length;\n  report.update();",
)
p.write_text(t)
print("patched completed counter")
PY
fi

echo "=== generate minimal MANIFEST.json ==="
python3 /mnt/d/velora/scripts/wpt-css-gen-manifest.py
ls -lh "$WPT_DIR/MANIFEST.json"

echo "=== start WPT static server :$WPT_PORT ==="
cd "$WPT_DIR"
# kill stale
pkill -f "http.server ${WPT_PORT}" 2>/dev/null || true
python3 -m http.server "$WPT_PORT" --bind 127.0.0.1 > /tmp/wpt-http.log 2>&1 &
WPT_PID=$!
sleep 1
curl -sf "http://127.0.0.1:${WPT_PORT}/MANIFEST.json" > /dev/null
curl -sf "http://127.0.0.1:${WPT_PORT}/resources/testharness.js" > /dev/null
echo "WPT server OK"

echo "=== start Velora :$CDP_PORT ==="
pkill -f "velora serve.*${CDP_PORT}" 2>/dev/null || true
cd /root/velora
"$VELORA_BIN" serve --host 127.0.0.1 --port "$CDP_PORT" \
  --insecure-disable-tls-host-verification --log-level error \
  > /tmp/velora-wpt.log 2>&1 &
VELORA_PID=$!
for i in $(seq 1 50); do
  curl -sf "http://127.0.0.1:${CDP_PORT}/json/version" >/dev/null 2>&1 && break
  sleep 0.2
done
curl -sf "http://127.0.0.1:${CDP_PORT}/json/version" >/dev/null
echo "Velora OK"

echo "=== select tests ==="
cd "$DEMO_DIR/wptrunner"
# shellcheck disable=SC2206
FILTER_ARR=($FILTERS)
# Note: wptrunner -list ignores CLI filters; filter client-side.
mapfile -t ALL < <(
  go run . -wpt-addr "http://127.0.0.1:${WPT_PORT}" -list 2>/dev/null \
    | while IFS= read -r url; do
        for f in "${FILTER_ARR[@]}"; do
          case "$url" in
            *"$f"*) echo "$url"; break ;;
          esac
        done
      done \
    | head -n "$MAX_TESTS"
)
echo "selected ${#ALL[@]} tests (MAX_TESTS=$MAX_TESTS filters=$FILTERS)"
printf '%s\n' "${ALL[@]}" > "$OUT_DIR/selected-tests.txt"
if [[ ${#ALL[@]} -eq 0 ]]; then
  echo "No tests selected" >&2
  exit 1
fi
head -5 "$OUT_DIR/selected-tests.txt"

echo "=== run wptrunner json (concurrency=2) ==="
# Pass selected URLs as contains-filters (exact path is fine)
set +e
go run . \
  -wpt-addr "http://127.0.0.1:${WPT_PORT}" \
  -cdp "ws://127.0.0.1:${CDP_PORT}" \
  -concurrency 2 \
  -json \
  "${ALL[@]}" > "$JSON_FILE" 2> "$RAW_FILE"
EC=$?
set -e
echo "wptrunner exit=$EC"
ls -lh "$JSON_FILE" "$RAW_FILE"
head -c 400 "$RAW_FILE" || true
echo

echo "=== parse failures only ==="
python3 - <<'PY'
import json
from pathlib import Path
out = Path("/mnt/d/velora/code-check/wpt-css-results")
jpath = out / "results.json"
fail_path = out / "failures.txt"
detail_path = out / "failures.detail.txt"
sum_path = out / "summary.txt"
lines_path = out / "summary-lines.txt"
text = jpath.read_text(encoding="utf-8", errors="replace").strip()
results = []
try:
    results = json.loads(text)
except Exception as e:
    print("json parse error:", e)
    t = text.rstrip().rstrip(",")
    if t.startswith("[") and not t.endswith("]"):
        t += "]"
    try:
        results = json.loads(t)
    except Exception as e2:
        print("salvage failed:", e2)
        # try NDJSON between brackets
        body = text
        if body.startswith("["):
            body = body[1:]
        if body.endswith("]"):
            body = body[:-1]
        results = []
        for chunk in body.split("\n{"):
            chunk = chunk.strip().strip(",")
            if not chunk:
                continue
            if not chunk.startswith("{"):
                chunk = "{" + chunk
            try:
                results.append(json.loads(chunk))
            except Exception:
                pass
        print("ndjson salvage count", len(results))

fails = []
detail_lines = []
summary_lines = []
passes = crashes = 0
for r in results:
    name = r.get("name") or "?"
    ok = bool(r.get("pass", False))
    crash = bool(r.get("crash", False))
    msg = r.get("message") or ""
    cases = r.get("cases") or []
    ok_n = sum(1 for c in cases if c.get("pass"))
    total = len(cases)
    status = "Crash" if crash else ("Pass" if ok and not any(not c.get("pass") for c in cases) else "Fail")
    summary_lines.append(f'{status} {ok_n}/{total}\t"{name}"')
    file_fail = crash or (not ok) or any(not c.get("pass", False) for c in cases)
    if not file_fail and total == 0 and not ok:
        file_fail = True
    if file_fail:
        fails.append(name)
        if crash:
            crashes += 1
        detail_lines.append(f"===== {name} =====")
        if msg:
            detail_lines.append(f"message: {msg}")
        for c in cases:
            if not c.get("pass", False):
                detail_lines.append(f"  FAIL {c.get('name','')}")
                if c.get("message"):
                    detail_lines.append(f"       {c.get('message')}")
        detail_lines.append("")
    else:
        passes += 1

fail_path.write_text("\n".join(fails) + ("\n" if fails else ""), encoding="utf-8")
detail_path.write_text("\n".join(detail_lines), encoding="utf-8")
lines_path.write_text("\n".join(summary_lines) + "\n", encoding="utf-8")
summary = (
    f"ran={len(results)}\n"
    f"pass={passes}\n"
    f"fail={len(fails)}\n"
    f"crash_count={crashes}\n"
    f"failures_file={fail_path}\n"
    f"detail_file={detail_path}\n"
)
sum_path.write_text(summary, encoding="utf-8")
print(summary)
print("=== FAILURES ONLY ===")
if fails:
    for f in fails:
        print(f)
else:
    print("(none)")
PY

echo "DONE -> $FAIL_FILE"
