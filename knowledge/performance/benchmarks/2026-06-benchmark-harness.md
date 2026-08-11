# Koko benchmark harness — microbench restore, crawl, density, ReleaseFast

> **Date:** 2026-06-29 – 2026-06-30 · **Area:** `code-check/bench/` · **Status:** Active harness; always use ReleaseFast for ratios

## Summary

Koko’s performance measurement lives in **`code-check/bench/`** — not in deleted `docs/benchmarks/` snapshots or the removed `benchmark-suite.mjs` orchestrator. The microbench runner (`compare-runner.mjs`) was accidentally deleted during a `curl-impersonate` cleanup on **2026-06-29** and restored the same day. A fresh **ReleaseFast** baseline on git `f17a19d9` showed Koko beating Playwright Chromium on navigation (geomean **0.22×**), near parity on startup (**1.04×**) and JS (**~1.05–1.20×**), with **`dom-heavy` navigation flipping from 6.28× slower (Jun 23) to 0.26–0.27× faster**.

Crawl (100 Wikipedia pages, c=8) and density sweep (c=1..32) confirm the win on live network workloads: throughput **1.34×**, TTFX **0.86×**, and at c=32 **24 sessions/GB** vs Chromium **5** (**4.80×** density).

**Critical rule:** compare ratios only after `zig build -Doptimize=ReleaseFast`. A Debug build on Jun 30 produced **dom-heavy 8.44×** slower — a build-mode artifact, not a regression.

---

## Problem

### Harness deletion blocked measurement

Commit `c73875d4` removed `compare-runner.mjs`, `compare-core.mjs`, fixtures, and `bench:compare:*` npm scripts. Engineers could read stale Markdown but could not reproduce or publish fresh numbers.

### Misleading baselines

Jun 23 published ratios (e.g. dom-query **72.48×**) reflected an older engine state. Optimization without reproducible measurement mis-prioritized work. Jun 30’s first ad-hoc suite run without ReleaseFast looked catastrophic (navigation geomean **3.49×**) while Jun 29 ReleaseFast showed Koko winning navigation.

---

## Root Cause

| Issue | Cause |
|-------|-------|
| Harness gone | Bench scripts adjacent to probe tooling; not CI-guarded |
| Jun 23 vs Jun 29 swing | html5ever, DOM insertion, selector, V8 bridge work between commits |
| Debug vs ReleaseFast | Debug Zig inflates hot DOM paths; Chromium always release-grade |

| Build | dom-heavy V/C ratio |
|-------|--------------------:|
| Debug (Jun 30) | **8.44×** slower |
| ReleaseFast (Jun 29) | **0.27×** faster |

---

## Solution — canonical commands

```bash
cd /Users/huydev/Desktop/koko

# Build for fair comparison
zig build -Doptimize=ReleaseFast

# Microbench (fixtures in koko-test/)
npm run bench:compare
npm run bench:compare:report    # writes code-check/tmp/benchmarks/compare.json

# Wikipedia crawl (100 pages, c=8)
npm run bench:crawl:wikipedia:fair:publish

# Agent density sweep (c=1..32)
npm run bench:density:publish

# Google agent compare (needs warmed profile cookie jar)
npm run bench:google:agent:publish
```

Raw JSON lands in `code-check/tmp/benchmarks/` (gitignored). Reports render to the same tmp tree; commit knowledge notes when publishing milestones.

### Jun 29 ReleaseFast highlights

| Workload | Koko/Chromium geomean |
|----------|------------------------:|
| Navigation | **0.22×** (faster) |
| Startup | **1.04×** |
| JS compute | **~1.05–1.20×** |
| dom-heavy nav | **0.26–0.27×** (was 6.28× Jun 23) |

Crawl: throughput **1.34×**, TTFX **0.86×**. Density c=32: **24 vs 5 sessions/GB**.

---

## Lessons Learned

1. **Protect bench scripts like tests** — deletion during hygiene is expensive.
2. **Always ReleaseFast** before ratio comparisons; document build flags in every note.
3. **Hop-1 / dom-heavy are canaries** — large swings usually mean parser/DOM hot paths, not network.
4. **Re-baseline after major engine changes** — Jun 23 numbers are not optimization targets.
5. **Google agent bench inherits cookie warmup** — see captcha investigation journey before blaming parse timeouts.

---

## References

- `code-check/bench/compare-runner.mjs`, `lib/compare-core.mjs`, `render-report.mjs`
- `code-check/bench/crawl-wikipedia-compare.mjs`, `density-sweep.mjs`
- `koko-test/{minimal,js-compute,mixed,dom-heavy}.html`
- `package.json` — `bench:compare:*`, `bench:crawl:*`, `bench:density:*`, `bench:google:agent:*`

---

## Related Knowledge

- [`../../captcha/detection/google-search-investigation-journey.md`](../../captcha/detection/google-search-investigation-journey.md) — cookie jar gate for Google agent bench
- [`../../sdk/2026-06-30-sdk-smoke-and-workflows.md`](../../sdk/2026-06-30-sdk-smoke-and-workflows.md) — SDK workflows (paused; CDP probes preferred)