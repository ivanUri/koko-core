# WPT URL Suite — URL, URLSearchParams, runner setup, idlharness

> **Date:** 2026-07-04 · **Area:** `URL.zig`, `URLSearchParams`, wptrunner · **Status:** Category A URL largely green

## Summary

First major WPT push covered the **`url/`** tree: `URL` constructor canonicalization, `origin`/`protocol` parsing, statics (`canParse`, `parse`), `URLSearchParams` construction + serialization, `application/x-www-form-urlencoded` + `FormData` integration, and **wptrunner infrastructure** on macOS without `/etc/hosts` sudo. Also fixed **frame navigation reentrancy** (`frame_navigated` from HTTP callbacks → V8 fatal).

## Problem

| Symptom | Cause |
|---------|-------|
| V8 fatal during URL tests | Synchronous `frame_navigated` CDP event inside libcurl header callback |
| `URLSearchParams` `0/0` | Constructor throw not observed by test harness; TaggedOpaque crash |
| Serialization `a=b&c` vs `a=b&c=` | Dropped `=` for empty values |
| IDL harness failures | Missing `@@` shims; static methods on `URL` |
| `canParse` / `parse` | Wrong exception types; invalid base handling |

## Solution

| File | Change |
|------|--------|
| `CDP.zig` / `Frame.zig` | Defer `frame_navigated` until out of HTTP callback |
| `URLSearchParams.zig` | Empty value `=`; throw propagation; TaggedOpaque ctor guard |
| `URL.zig` | Canonicalize drive URLs; `origin` tuple; statics per spec |
| `wpt/config.local.json` | `check_subdomains: false` for local dev |
| `wpt/resources/testharnessreport.js` | Patched `report` global for wptrunner |

## Runner setup (canonical)

```bash
# WPT server
cd wpt && ./wpt serve --config config.local.json

# Velora CDP
./zig-out/bin/velora serve --host 127.0.0.1 --port 9222 \
  --insecure-disable-tls-host-verification --log-level error

# Single test
cd ~/Desktop/demo/wptrunner
go run . -wpt-addr http://localhost:8000 -cdp ws://127.0.0.1:9222 \
  -summary -concurrency 1 url/urlsearchparams-append
```

Use **`-concurrency 1`** until multi-target CDP is stable.

## Category status (architecture snapshot)

| Category | Examples | Status |
|----------|----------|--------|
| A — infrastructure | runner, navigation defer | Fixed |
| B — pure algorithms | URL parse, SearchParams | Mostly green |
| C — IDL/shim | `@@` constructors | Ongoing per interface |
| D — cross-module | URL + Fetch + workers | See fetch/worker suites |

## Lessons Learned

- **Never emit CDP navigation events from curl callbacks** — always defer to main loop.
- **Empty URLSearchParams values need trailing `=`** — serializers are picky in WPT.
- Official WPT clone + patched `testharnessreport.js` is the supported layout; fork backups are optional.

## References

- `src/core/webapi/URL.zig`, `net/URLSearchParams.zig`
- `wpt/`, `~/Desktop/demo/wptrunner`
- `scripts/wpt-run.sh`

## Related Knowledge

- [`2026-07-websocket-wpt-suite.md`](2026-07-websocket-wpt-suite.md) — URL coercion in WebSocket ctor
- [`2026-07-fetch-wpt-suite.md`](2026-07-fetch-wpt-suite.md) — `application/x-www-form-urlencoded`