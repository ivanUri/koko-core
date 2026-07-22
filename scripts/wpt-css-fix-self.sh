#!/usr/bin/env bash
set -euo pipefail
export LD_LIBRARY_PATH="${HOME}/velora/vendor/curl-impersonate/linux:${LD_LIBRARY_PATH:-}"

fuser -k 8000/tcp 2>/dev/null || true
sleep 0.2
cd /root/wpt-css-work/wpt
python3 -m http.server 8000 --bind 127.0.0.1 >/tmp/wpt-http.log 2>&1 &
sleep 0.4

cat > /root/wpt-css-work/wpt/selfcheck.html <<'HTML'
<!doctype html>
<title>selfcheck</title>
<script>
document.title =
  "self=" + (typeof self) +
  ";window=" + (typeof window) +
  ";globalThis=" + (typeof globalThis) +
  ";selfEqWin=" + (typeof self !== 'undefined' && self === window);
</script>
HTML

cd /root/velora
./zig-out/bin/velora fetch --wait-ms 1000 --dump html http://127.0.0.1:8000/selfcheck.html 2>/tmp/sc.err | head -c 500
echo
cat /tmp/sc.err

# Patch end of testharness to use globalThis fallback
TH=/root/wpt-css-work/wpt/resources/testharness.js
cp -a "$TH" "$TH.orig"
# replace final })(self); with globalThis
python3 - <<'PY'
from pathlib import Path
p=Path('/root/wpt-css-work/wpt/resources/testharness.js')
t=p.read_text()
if t.rstrip().endswith('})(self);') or '})(self);' in t[-80:]:
    t2=t.replace('})(self);','})(typeof self !== "undefined" ? self : globalThis);',1)
    # only last occurrence
    idx=t.rfind('})(self);')
    if idx!=-1:
        t=t[:idx]+'})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this));'+t[idx+len('})(self);'):]
    p.write_text(t)
    print('patched self fallback')
else:
    print('pattern not found, tail=',repr(t[-60:]))
PY

cat > /root/wpt-css-work/wpt/th-only2.html <<'HTML'
<!doctype html>
<title>th only2</title>
<script src="/resources/testharness.js"></script>
<script>
document.title = (typeof test === "function" ? "HAS_TEST" : "NO_TEST") + ":" + (typeof assert_true) + ":" + (typeof add_result_callback);
</script>
HTML

./zig-out/bin/velora fetch --wait-ms 2000 --dump html http://127.0.0.1:8000/th-only2.html 2>/tmp/th2.err | head -c 600
echo
echo ERR:
cat /tmp/th2.err
