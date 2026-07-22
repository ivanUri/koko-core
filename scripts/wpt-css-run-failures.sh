#!/usr/bin/env bash
# Clone (if needed) a CSS-related WPT subset, run against Velora, save failures only.
set -euo pipefail

export PATH="/usr/local/go/bin:/usr/local/bin:$HOME/.cargo/bin:$PATH"
export LD_LIBRARY_PATH="${HOME}/velora/vendor/curl-impersonate/linux:${LD_LIBRARY_PATH:-}"

WIN_ROOT="/mnt/d/velora"
HOME_VELORA="${HOME}/velora"
WORK="${HOME}/wpt-css-work"
WPT_DIR="${WORK}/wpt"
DEMO_DIR="${WORK}/demo"
OUT_DIR="${WIN_ROOT}/code-check/wpt-css-results"
FAIL_FILE="${OUT_DIR}/failures.txt"
SUMMARY_FILE="${OUT_DIR}/summary.txt"
RAW_FILE="${OUT_DIR}/raw.log"
WPT_PORT=8000
CDP_PORT=9222
VELORA_PID=""
WPT_PID=""

mkdir -p "$WORK" "$OUT_DIR"

cleanup() {
  if [[ -n "${VELORA_PID:-}" ]] && kill -0 "$VELORA_PID" 2>/dev/null; then
    kill "$VELORA_PID" 2>/dev/null || true
    wait "$VELORA_PID" 2>/dev/null || true
  fi
  if [[ -n "${WPT_PID:-}" ]] && kill -0 "$WPT_PID" 2>/dev/null; then
    kill "$WPT_PID" 2>/dev/null || true
    wait "$WPT_PID" 2>/dev/null || true
  fi
  pkill -f "velora serve.*${CDP_PORT}" 2>/dev/null || true
  pkill -f "wpt serve" 2>/dev/null || true
  # python wpt.serve sometimes
  pkill -f "tools/serve/serve.py" 2>/dev/null || true
}
trap cleanup EXIT

echo "=== ensure go ==="
if ! command -v go >/dev/null 2>&1; then
  cd /tmp
  curl -fsSL -o go.tgz https://go.dev/dl/go1.24.5.linux-amd64.tar.gz
  rm -rf /usr/local/go
  tar -C /usr/local -xzf go.tgz
fi
echo "go=$(go version)"

echo "=== ensure python deps for wpt ==="
apt-get install -yq python3-pip python3-venv libssl-dev 2>/dev/null || true

echo "=== clone/update wptrunner (lightpanda demo) ==="
if [[ ! -d "$DEMO_DIR/.git" ]]; then
  git clone --depth=1 https://github.com/lightpanda-io/demo.git "$DEMO_DIR"
else
  git -C "$DEMO_DIR" pull --ff-only || true
fi

echo "=== clone sparse WPT CSS suites ==="
if [[ ! -d "$WPT_DIR/.git" ]]; then
  git clone --filter=blob:none --sparse --depth=1 \
    https://github.com/web-platform-tests/wpt.git "$WPT_DIR"
  cd "$WPT_DIR"
  git sparse-checkout set \
    resources \
    tools \
    common \
    css/css-syntax \
    css/cssom \
    css/css-variables \
    css/css-cascade \
    css/selectors \
    css/css-color \
    css/css-values \
    interfaces
else
  cd "$WPT_DIR"
  git pull --ff-only || true
fi

# Extra tools may be needed for manifest/serve
cd "$WPT_DIR"
if [[ ! -f MANIFEST.json ]] && [[ ! -f man.json ]]; then
  echo "=== generate WPT manifest (may take a while) ==="
  # Prefer ./wpt if present
  if [[ -x ./wpt ]]; then
    python3 ./wpt manifest --no-download || ./wpt manifest --no-download || true
  else
    python3 tools/manifest/update.py || true
  fi
fi

echo "=== start WPT HTTP server on :${WPT_PORT} ==="
cd "$WPT_DIR"
# Minimal local config if needed
if [[ ! -f config.local.json ]]; then
  cat > config.local.json <<'JSON'
{
  "browser_host": "localhost",
  "ports": {
    "http": [8000],
    "https": [8443],
    "ws": [8000],
    "wss": [8443]
  }
}
JSON
fi

# Start serve
python3 ./wpt serve --config config.local.json >/tmp/wpt-serve.log 2>&1 &
WPT_PID=$!
sleep 2

# Fallback: simple static server if wpt serve fails
if ! curl -sf "http://127.0.0.1:${WPT_PORT}/resources/testharness.js" >/dev/null 2>&1; then
  echo "wpt serve not ready, trying python http.server..."
  kill "$WPT_PID" 2>/dev/null || true
  # Serve from WPT root so paths like /css/... and /resources/... work
  python3 -m http.server "$WPT_PORT" --bind 127.0.0.1 >/tmp/wpt-http.log 2>&1 &
  WPT_PID=$!
  sleep 1
fi

if ! curl -sf "http://127.0.0.1:${WPT_PORT}/resources/testharness.js" >/dev/null 2>&1; then
  echo "ERROR: cannot serve WPT resources" >&2
  tail -50 /tmp/wpt-serve.log 2>/dev/null || true
  tail -50 /tmp/wpt-http.log 2>/dev/null || true
  exit 1
fi
echo "WPT server OK"

echo "=== start Velora CDP on :${CDP_PORT} ==="
# Prefer home copy binary (linux-native path)
VELORA_BIN="${HOME_VELORA}/zig-out/bin/velora"
if [[ ! -x "$VELORA_BIN" ]]; then
  VELORA_BIN="${WIN_ROOT}/zig-out/bin/velora-linux"
fi
cd "$HOME_VELORA"
"$VELORA_BIN" serve --host 127.0.0.1 --port "$CDP_PORT" \
  --insecure-disable-tls-host-verification --log-level error \
  >/tmp/velora-serve.log 2>&1 &
VELORA_PID=$!

for i in $(seq 1 40); do
  if curl -sf "http://127.0.0.1:${CDP_PORT}/json/version" >/dev/null 2>&1; then
    break
  fi
  sleep 0.3
done
if ! curl -sf "http://127.0.0.1:${CDP_PORT}/json/version" >/dev/null 2>&1; then
  echo "ERROR: velora failed to start" >&2
  tail -40 /tmp/velora-serve.log || true
  exit 1
fi
echo "Velora OK"

# CSS suites to run (paths relative to WPT root, as expected by wptrunner)
CSS_PATHS=(
  "css/css-syntax"
  "css/cssom"
  "css/css-variables"
  "css/css-cascade"
  "css/selectors"
  "css/css-color"
  "css/css-values"
)

echo "=== run wptrunner CSS suites ==="
cd "${DEMO_DIR}/wptrunner"
: > "$RAW_FILE"
: > "$FAIL_FILE"

# List test HTML files under sparse trees
TEST_LIST="${OUT_DIR}/tests.list"
: > "$TEST_LIST"
for p in "${CSS_PATHS[@]}"; do
  if [[ -d "${WPT_DIR}/${p}" ]]; then
    find "${WPT_DIR}/${p}" -type f \( -name '*.html' -o -name '*.any.html' -o -name '*.window.html' -o -name '*.worker.html' \) \
      ! -name '*-manual.html' \
      ! -path '*/support/*' \
      ! -path '*/resources/*' \
      | sed "s|^${WPT_DIR}/||" >> "$TEST_LIST"
  fi
done

TOTAL=$(wc -l < "$TEST_LIST" | tr -d ' ')
echo "Found $TOTAL candidate test files"
echo "Found $TOTAL candidate test files" > "$SUMMARY_FILE"

# Cap for first run if too many - user asked for some CSS tests
MAX_TESTS="${MAX_TESTS:-120}"
head -n "$MAX_TESTS" "$TEST_LIST" > "${TEST_LIST}.run"
RUN_COUNT=$(wc -l < "${TEST_LIST}.run" | tr -d ' ')
echo "Running $RUN_COUNT tests (MAX_TESTS=$MAX_TESTS)"
echo "Running $RUN_COUNT tests (MAX_TESTS=$MAX_TESTS)" >> "$SUMMARY_FILE"

# Check wptrunner flags
go run . -h 2>&1 | head -40 || true

PASS=0
FAIL=0
ERROR=0
SKIP=0

while IFS= read -r rel; do
  [[ -z "$rel" ]] && continue
  echo "---- $rel ----" | tee -a "$RAW_FILE"
  # Restart velora every test for stability (like p0 script)
  if ! kill -0 "$VELORA_PID" 2>/dev/null || ! curl -sf "http://127.0.0.1:${CDP_PORT}/json/version" >/dev/null 2>&1; then
    pkill -f "velora serve.*${CDP_PORT}" 2>/dev/null || true
    cd "$HOME_VELORA"
    "$VELORA_BIN" serve --host 127.0.0.1 --port "$CDP_PORT" \
      --insecure-disable-tls-host-verification --log-level error \
      >/tmp/velora-serve.log 2>&1 &
    VELORA_PID=$!
    sleep 0.8
  fi

  set +e
  OUT=$(cd "${DEMO_DIR}/wptrunner" && go run . \
    -wpt-addr "http://127.0.0.1:${WPT_PORT}" \
    -cdp "ws://127.0.0.1:${CDP_PORT}" \
    -summary \
    -concurrency 1 \
    "$rel" 2>&1)
  EC=$?
  set -e
  echo "$OUT" >> "$RAW_FILE"

  # Heuristics for result from wptrunner summary lines
  if echo "$OUT" | grep -qiE 'FAIL|failed|Error|panic|TIMEOUT|CRASH'; then
    # If summary says all pass, ignore word FAIL in test name
    if echo "$OUT" | grep -qiE 'Result:.*PASS|passed:.*[1-9]|OK\b' && ! echo "$OUT" | grep -qiE 'failed: *[1-9]|FAIL:|Result:.*FAIL'; then
      PASS=$((PASS + 1))
      echo "PASS $rel" >> "$RAW_FILE"
    else
      FAIL=$((FAIL + 1))
      echo "$rel" >> "$FAIL_FILE"
      # Also keep a short reason
      echo "----- $rel -----" >> "${OUT_DIR}/failures.detail.txt"
      echo "$OUT" | tail -30 >> "${OUT_DIR}/failures.detail.txt"
      echo >> "${OUT_DIR}/failures.detail.txt"
      echo "FAIL $rel"
    fi
  elif echo "$OUT" | grep -qiE 'SKIP|unsupported'; then
    SKIP=$((SKIP + 1))
    echo "SKIP $rel" >> "$RAW_FILE"
  elif [[ $EC -ne 0 ]]; then
    ERROR=$((ERROR + 1))
    echo "$rel" >> "$FAIL_FILE"
    echo "----- $rel (exit $EC) -----" >> "${OUT_DIR}/failures.detail.txt"
    echo "$OUT" | tail -30 >> "${OUT_DIR}/failures.detail.txt"
    echo >> "${OUT_DIR}/failures.detail.txt"
    echo "ERROR $rel exit=$EC"
  else
    PASS=$((PASS + 1))
    echo "PASS $rel" >> "$RAW_FILE"
  fi
done < "${TEST_LIST}.run"

{
  echo "total_candidates=$TOTAL"
  echo "ran=$RUN_COUNT"
  echo "pass=$PASS"
  echo "fail=$FAIL"
  echo "error=$ERROR"
  echo "skip=$SKIP"
  echo "failures_file=$FAIL_FILE"
} | tee -a "$SUMMARY_FILE"

echo "=== FAILURES ONLY ==="
if [[ -s "$FAIL_FILE" ]]; then
  cat "$FAIL_FILE"
else
  echo "(none)"
fi
echo "DONE"
