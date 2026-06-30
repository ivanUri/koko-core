# Agent density sweep — Velora vs Chromium

> **2026-06-29T08:30:59.580Z** · 24 pages/level · levels 1, 4, 8, 16, 32 · Apple M1 (8 cores)

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
| 1 | 72.8 MiB | 1055.1 MiB | 14 | 0 | — | 5.19 | 4.36 |
| 4 | 275.6 MiB | 1701.0 MiB | 14 | 2 | 7.00x | 10.92 | 6.61 |
| 8 | 490.2 MiB | 2051.6 MiB | 16 | 3 | 5.33x | 9.92 | 3.75 |
| 16 | 678.3 MiB | 3445.0 MiB | 24 | 4 | 6.00x | 12.54 | 6.15 |
| 32 | 998.2 MiB | 4195.6 MiB | 24 | 5 | 4.80x | 18.88 | 1.53 |

## RAM budget — max concurrency (from measured peak RSS)

| RAM budget | Velora max concurrency | Chromium max concurrency |
| ---: | ---: | ---: |
| 1 GB | 32 | 0 |
| 2 GB | 32 | 4 |
| 4 GB | 32 | 16 |
| 8 GB | 32 | 32 |

## Takeaways

- At **concurrency 32**: Velora peak 998 MiB vs Chromium 4196 MiB.
- **Sessions/GB** at 32: Velora **24** vs Chromium **5** (4.80x).
- At **concurrency 1**: density ratio n/a (Chromium peak RSS > 1 GB at c=1).
- Under **1 GB RAM**: Velora supports up to **32** parallel sessions vs Chromium **0**.
- Cold start is not measured here; this sweep focuses on **parallel URL capacity** under fixed hardware.

## Reproduce

```bash
zig build
npm run bench:density:publish
```

Raw JSON: `code-check/tmp/benchmarks/density-sweep.json`
