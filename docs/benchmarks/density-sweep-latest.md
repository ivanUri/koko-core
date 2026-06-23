# Agent density sweep — Velora vs Chromium

> **2026-06-23T08:17:42.561Z** · 24 pages/level · levels 1, 4, 8, 16, 32 · Apple M1 (8 cores)

## What this measures

How many **parallel URL sessions** each runtime can sustain on the same machine, at increasing concurrency.

- **Site:** en.wikipedia.org (live crawl, extract mode)
- **Velora:** N isolated `velora serve` processes (1 tab each)
- **Chromium:** N tabs in 1 Playwright Chromium browser
- **Key metric:** `sessions/GB` = how many concurrent workers fit in 1 GiB RAM at peak RSS
- **Budget table:** max tested concurrency whose peak RSS stays under 1/2/4/8 GB

Ratio **Velora/Chromium > 1** on sessions/GB means Velora fits more parallel URLs per GB.

## Scalability by concurrency

| Concurrency | Velora peak RSS | Chromium peak RSS | Velora sessions/GB | Chromium sessions/GB | Density ratio | Velora p/s | Chromium p/s |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 291.7 MiB | 1132.2 MiB | 3 | 0 | — | 0.03 | 3.19 |
| 4 | 1097.1 MiB | 1673.1 MiB | 3 | 2 | 1.50x | 1.13 | 3.97 |
| 8 | 1064.2 MiB | 2315.3 MiB | 7 | 3 | 2.33x | 1.31 | 4.26 |
| 16 | 1938.9 MiB | 3386.2 MiB | 8 | 4 | 2.00x | 1.77 | 4.13 |
| 32 | 2774.3 MiB | 4409.8 MiB | 8 | 5 | 1.60x | 1.62 | 3.61 |

## RAM budget — max concurrency (from measured peak RSS)

| RAM budget | Velora max concurrency | Chromium max concurrency |
| ---: | ---: | ---: |
| 1 GB | 1 | 0 |
| 2 GB | 16 | 4 |
| 4 GB | 32 | 16 |
| 8 GB | 32 | 32 |

## Takeaways

- At **concurrency 32**: Velora peak 2774 MiB vs Chromium 4410 MiB.
- **Sessions/GB** at 32: Velora **8** vs Chromium **5** (1.60x).
- At **concurrency 1**: density ratio n/a (Chromium peak RSS > 1 GB at c=1).
- Under **1 GB RAM**: Velora supports up to **1** parallel sessions vs Chromium **0**.
- Cold start is not measured here; this sweep focuses on **parallel URL capacity** under fixed hardware.

## Reproduce

```bash
zig build
npm run bench:density:publish
```

Raw JSON: `code-check/tmp/benchmarks/density-sweep.json`
