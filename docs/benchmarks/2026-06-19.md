# Velora vs Chromium Benchmark

> Generated from machine-readable results. Last run: **2026-06-19T02:15:40.101Z**

## Executive summary

- **Host:** Huys-MacBook-Pro.local (darwin arm64, 24.3.0)
- **CPU:** Apple M1 (8 cores)
- **Node:** v22.19.0 · **Playwright Chromium:** 1.60.0 (headless)
- **Velora profile:** `chrome-macos-catalina` · git `e6087ca7`
- **Startup ratio (Velora/Chromium):** **1.09x** (+9.2% vs Chromium)
- **Navigation geomean ratio:** **0.34x** (-65.7% vs Chromium)
- **JS workload geomean ratio:** **6.29x** (+528.5% vs Chromium)

Ratio **> 1.0** means Velora is slower; **< 1.0** means Velora is faster.

## Cold start

| Browser | Mean (ms) | Median (ms) | Min (ms) | Max (ms) | Errors |
| --- | ---: | ---: | ---: | ---: | ---: |
| Velora | 122.5 | 122.4 | 121.3 | 123.8 | 0 |
| Chromium | 112.2 | 111.3 | 108.6 | 116.1 | 0 |
| **Ratio (Velora/Chromium)** | **1.09x** |  |  |  |  |

## Static page navigation

Warmup: 1 · Measured repeats: 3

| Page | Velora mean | Chromium mean | Ratio | Velora err | Chromium err |
| --- | ---: | ---: | ---: | ---: | ---: |
| `dom-heavy.html` | 128.3 ms | 72.9 ms | 1.76x | 0 | 0 |
| `js-compute.html` | 5.0 ms | 38.6 ms | 0.13x | 0 | 0 |
| `minimal.html` | 4.5 ms | 38.4 ms | 0.12x | 0 | 0 |
| `mixed.html` | 25.0 ms | 48.7 ms | 0.51x | 0 | 0 |

**Geomean ratio:** 0.34x

## In-page JS workloads

| Workload | Page | Velora mean | Chromium mean | Ratio |
| --- | --- | ---: | ---: | ---: |
| dom-query | `dom-heavy.html` | 3.0 ms | 0.2 ms | 12.82x |
| json-loop | `js-compute.html` | 16.4 ms | 2.6 ms | 6.29x |
| hash-loop | `js-compute.html` | 4.9 ms | 1.6 ms | 3.08x |

**Geomean ratio:** 6.29x

## Methodology

- **Velora:** `zig-out/bin/velora serve` + CDP navigation/evaluate
- **Chromium:** Playwright bundled Chromium (`chromium.launch({ headless: true })`) — not Google Chrome desktop
- **Fixtures:** local static HTML in `velora-test/` (no CDN)
- **Navigation metric:** `Page.navigate` / `goto` until `domcontentloaded` + DOM size probe
- **JS metric:** in-page `performance.now()` for dom-query, JSON loop, FNV-style hash loop
- **Startup metric:** process spawn until browser ready (Velora: `/json/version`; Chromium: launch + `about:blank`)
- **Startup warmup/repeats:** 2/5

## Limitations

- Results are from a single machine run; CPU load affects numbers.
- Local static pages only — not representative of heavy SPAs or real sites.
- Playwright Chromium differs from installed Google Chrome.

## Reproduce

```bash
zig build
npm run bench:compare:publish
```

Raw JSON: `code-check/tmp/benchmarks/run.json`

