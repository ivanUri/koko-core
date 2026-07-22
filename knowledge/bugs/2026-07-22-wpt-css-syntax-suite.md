# WPT CSS Syntax / Variables Suite — baseline on WSL

> **Date:** 2026-07-22 · **Area:** CSS syntax, An+B, charset, custom properties · **Status:** Baseline measured (1/40 pass)

## Summary

First structured CSS WPT pass against Velora on **Windows + WSL2**, using a sparse WPT checkout, lightpanda **wptrunner** over CDP, and ReleaseFast Velora with prebuilt V8 + Linux curl-impersonate. Focused on **`css/css-syntax`**, **`css/cssom`**, and **`css/css-variables`** (first 40 matching testharness files).

**Result:** 40 ran → **1 pass**, **39 fail** (33 assertion-level, 6 harness incomplete).

Full machine report and failure lists: [`code-check/wpt-css-results/REPORT.md`](../../code-check/wpt-css-results/REPORT.md).

## Problem

| Symptom | Cause |
|---------|-------|
| Entire files `0/1` with “never reaches the completion callback” | Classic external scripts (`testharness.js`) not blocking; inline `test()` runs before harness globals exist |
| An+B WPT mass failures | Selector / serialization keeps author form instead of CSSOM serialization rules |
| Charset subdirectory red | Encoding / `@charset` / BOM pipeline incomplete or not applied to stylesheet loads |
| Some files incomplete even after harness wait | Timeout / no progress (5–30s) — may be hang or missing feature mid-test |

## Solution (harness only — this pass)

No CSS engine fixes in this pass. Tooling only:

| Piece | Role |
|-------|------|
| `scripts/wpt-css-clone.sh` | Sparse WPT clone for CSS trees + resources |
| `scripts/wpt-css-gen-manifest.py` | Minimal `MANIFEST.json` for wptrunner without full `./wpt manifest` venv |
| `scripts/wpt-css-preprocess.py` | Wrap inline scripts until `test` / `assert_true` exist |
| `scripts/wpt-css-run-failsonly.sh` | Serve WPT, start Velora CDP, run wptrunner, write failures only |
| `scripts/wsl-setup-and-build.sh` | Zig/Rust + sync + ReleaseFast build on WSL |
| lightpanda `testharnessreport.js` | `report.complete` / `report.log` for runner |

## Category status (this snapshot)

| Category | Examples | Status |
|----------|----------|--------|
| A — infrastructure | script order, WSL build, wptrunner | Workarounds in place |
| B — An+B / serialization | `anb-parsing`, `anb-serialization` | Red |
| C — charset | `css-syntax/charset/*` | Red / incomplete |
| D — variables | `css-variable-change-style-001` | Red |
| E — tokenizer edge | unclosed, EOF, whitespace | Mostly red |

## Lessons learned

- **Classic script ordering is load-bearing for WPT** — if inline runs before external classic scripts, every testharness file looks like infrastructure failure.
- **wptrunner `-list` ignores path filters** — always filter client-side before capping with `MAX_TESTS`.
- **Separate “assertion fail” from “incomplete”** — otherwise CSS gaps hide behind harness noise.
- **Sparse WPT + generated MANIFEST** is enough for local CSS smoke; full `./wpt serve` + hosts is not required for this subset.

## How to re-run

```bash
# WSL
MAX_TESTS=40 FILTERS='css/css-syntax css/cssom css/css-variables' \
  bash /mnt/d/velora/scripts/wpt-css-run-failsonly.sh
```

Outputs under `code-check/wpt-css-results/`.

## References

- `code-check/wpt-css-results/REPORT.md`
- `code-check/wpt-css-results/failures.txt`
- `scripts/wpt-css-run-failsonly.sh`
- lightpanda demo `wptrunner`, lightpanda WPT `testharnessreport.js` patch

## Related knowledge

- [`2026-07-04-url-wpt-suite.md`](2026-07-04-url-wpt-suite.md) — runner / testharnessreport layout
- [`2026-07-08-wpt-dom-suite.md`](2026-07-08-wpt-dom-suite.md) — DOM WPT patterns
