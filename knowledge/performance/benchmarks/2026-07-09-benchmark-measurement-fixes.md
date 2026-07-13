# Benchmark harness measurement fixes — ReleaseFast preflight, TTFX, DOM-ready

> **Date:** 2026-07-09 · **Area:** `code-check/bench/` · **Status:** Fixed harness skew; re-baseline ratios after this commit

## Summary

Several benchmark harness bugs made published Velora/Chromium ratios unreliable: Debug builds could invert navigation geomeans (documented 8.44× slower vs 0.27× faster on dom-heavy), density-lane TTFX for Velora counted full `goto`+extract instead of first extractable hit, `fetchPage` silently continued when `domContentEventFired` never fired, and microbench Velora navigation did not wait for DOM ready while Chromium did.

This change enforces **ReleaseFast preflight**, unifies density-lane Velora timing on **raw CDP `fetchPage`**, rejects DOM-ready timeouts, and aligns microbench navigation with `domcontentloaded`.

---

## Problem

| Bug | Symptom |
|-----|---------|
| No ReleaseFast gate | `npm run bench:*` could run against Debug `zig-out/bin/velora` |
| Density TTFX (Velora SDK path) | `ttfexMs` included navigation; unfair vs Chromium `fetchPage` |
| `fetchPage` DOM race | 12s timeout → proceed without DOM event |
| Microbench nav asymmetry | Velora: `Page.navigate` only; Chromium: `goto(domcontentloaded)` |

---

## Solution

1. **`scripts/bench-preflight.mjs`** — `zig build -Doptimize=ReleaseFast` + writes `zig-out/bin/velora.build.json`
2. **`assertReleaseFastBinary()`** in `lib/compare-core.mjs` — all bench entry points fail fast without ReleaseFast meta
3. **`prebench:*`** in `package.json` → `npm run bench:preflight` (replaces SDK-only prebench)
4. **Density `crawlVelora`** — multi-process workers use CDP `fetchPage` (removed SDK `page.extract` timing path)
5. **`fetchPage`** — throws if `domContentEventFired` / `loadEventFired` not received within timeout
6. **`runVeloraNavigate` / `runVeloraJs`** — wait for `Page.domContentEventFired` via CDP event listener
7. **Metadata** — `veloraOptimizeMode`, `benchmarkAssumptions` in JSON reports; `--nav-mode fresh|reuse` for microbench

---

## Reproduce

```bash
cd /Users/huydev/Desktop/velora
npm run bench:preflight
npm run bench:compare
npm run bench:crawl:wikipedia:density:publish
```

Debug build without preflight should fail:

```bash
zig build
npm run bench:compare   # expects ReleaseFast preflight error
```

---

## Lessons Learned

1. **Always gate ratios on build mode** — embed optimize in sidecar + assert before any publish script.
2. **Same measurement stack per lane** — density throughput/RSS can differ by architecture, but TTFX must use identical CDP phases on both engines.
3. **Never silent timeout in DOM gates** — false-green DOM-ready poisons crawl latency columns.
4. **Re-baseline after harness fixes** — Jun 2026 published crawl TTFX for Velora density lane is not comparable post-fix.

---

## References

- `code-check/bench/lib/compare-core.mjs`, `lib/crawl-wikipedia.mjs`
- `scripts/bench-preflight.mjs`
- [`2026-06-benchmark-harness.md`](2026-06-benchmark-harness.md)