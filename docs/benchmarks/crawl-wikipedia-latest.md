# Real-world crawl benchmark

> **2026-06-19T05:06:52.899Z** · 100 pages · concurrency 8 · Apple M1 (8 cores)

## What this measures

- **Benchmark class:** `crawler-runtime` — network → HTML parse → DOM extract (not full browser fidelity)
- **Site:** https://en.wikipedia.org/ (live internet)
- **Workload:** 100 article URLs (shared list: `/Users/huydev/Desktop/velora/code-check/tmp/benchmarks/wikipedia-titles.json`)
- **Mode:** `extract` (title + wiki links via `querySelector`)
- **Velora:** 8× `velora serve` (multi-process)
- **Chromium:** 8 tabs, 1 browser (multi-tab-single-process)
- **Resource sampling:** every 100ms via process tree (RSS, CPU%, process count)
- **GPU:** utilization not available headless; we log GPU helper process count + RSS if spawned

## Architecture (read before comparing process count)

| | Velora | Chromium |
| --- | --- | --- |
| Parallelism unit | 8 isolated `velora serve` processes | 8 tabs in 1 browser |
| OS process model | 1 process tree per worker (summed) | browser + N renderers + GPU + network + utility + crashpad |
| This run (peak procs) | 8 | 15 |
| Note | Velora: N isolated velora serve processes (1 tab each). RSS sums worker trees. | Chromium: N tabs in one browser; OS sees browser + renderer + GPU + network + utility processes. |

Peak process count and peak RSS are **not apples-to-apples** across architectures. Use **RSS/page**, **sessions/GB**, and **CPU-sec/page** for cost comparisons.

## Limitations (crawler vs AI browser runtime)

Wikipedia articles are mostly static HTML. This workload does **not** stress:

- WebGL / Canvas / heavy JS frameworks
- SPA routing or React hydration
- Service workers, bot detection (reCAPTCHA, Cloudflare)
- Agent workflows (search → click → extract, login, forms)

> Network + HTML parse + DOM extract. Not a full browser fidelity benchmark (no WebGL/SPA/hydration).

## Scalability comparison

Ratio **Velora / Chromium**. Values **< 1** mean Velora uses less (better for memory/CPU/time); **> 1** means Velora uses more.

| Metric | Velora | Chromium | Ratio (V/C) |
| --- | ---: | ---: | ---: |
| Wall time | 7031 ms | 5067 ms | 1.39x |
| Throughput | 14.22 p/s | 19.74 p/s | 0.72x |
| Mean latency (total) | 515.0 ms | 295.5 ms | 1.74x |
| TTFX mean | 514.3 ms | 252.0 ms | 2.04x |
| TTFX median | 433.0 ms | 214.0 ms | — |
| DOM ready mean | 511.8 ms | 210.0 ms | — |
| Peak RSS | 547.3 MiB | 2983.4 MiB | 0.18x |
| Avg RSS | 447.1 MiB | 1919.9 MiB | 0.23x |
| RSS / page | 5.5 MiB | 29.8 MiB | 0.18x |
| **Sessions / GB** | 14 | 2 | 7.00x |
| **CPU-sec / page** | 0.0595 | 0.1111 | 0.54x |
| Peak CPU (Σ%) | 125.6% | 371.0% | 0.34x |
| Avg CPU (Σ%) | 84.9% | 222.2% | 0.38x |
| CPU core-equivalent (avg) | 0.85 | 2.22 | 0.38x |
| Peak process count | 8 | 15 | 0.53x |
| GPU helper processes | 0 | 0 | — |
| GPU helper RSS | 0.0 MiB | 0.0 MiB | — |
| Success rate | 100/100 | 100/100 | — |

### Cost & density takeaways

- **Memory:** Velora peak RSS is lower — better footprint per crawl worker at this concurrency.
- **Agent density:** Velora fits ~14 concurrent sessions per GB RAM vs Chromium ~2.
- **CPU cost per page:** Velora uses less CPU-sec/page (Velora 0.0595 · Chromium 0.1111).
- **TTFX (time to first extraction):** Chromium reaches first extractable element faster (Velora 514.3 ms · Chromium 252.0 ms).
- **Processes:** Velora runs 8 browser processes; Chromium packs 8 tabs into ~15 OS processes (multi-process Chrome).
- **CPU:** Σ% can exceed 100% on multi-core; core-equivalent ≈ avg CPU% / 100.
- **Cost model:** `tasks × cpu_sec_per_task × $/CPU-sec` + `sessions / sessions_per_GB × $/GB-RAM`.

## Planned benchmarks (AI browser runtime)

| Suite | Workload | Key metrics |
| --- | --- | --- |
| Agent Search | 100 Google searches → open first result → extract | tasks/sec, CPU-sec/task, blocks, success rate |
| Agent Density | sweep concurrency 1→32 in 1 GB RAM budget | sessions/GB curve |
| Browser Compatibility | CreepJS, WPT, real sites | pass rate, fingerprint score |
| Bot / Stealth | reCAPTCHA v3, Cloudflare, hCaptcha | score, block rate |
| Agent Automation | 1000 form submissions | success rate, latency |
| Hacker News / GitHub | live SERP-like pages | TTFX, extract latency |

## Velora detail

- Model: multi-process, parallelism 8
- Wall: 7031 ms · throughput 14.22 p/s
- Latency mean/median: 515.0 / 433.0 ms
- TTFX mean/median: 514.3 / 433.0 ms
- DOM ready mean: 511.8 ms
- Peak/avg RSS: 547.3 MiB / 447.1 MiB
- RSS/page: 5.5 MiB · sessions/GB: 14
- CPU-sec/page: 0.0595 · integrated CPU: 5.946 s
- Peak/avg CPU: 125.6% / 84.9%
- Peak processes: 8

<details><summary>Resource time series (downsampled)</summary>

| t (ms) | RSS (MiB) | CPU Σ% | processes |
| ---: | ---: | ---: | ---: |
| 30 | 9.58 | 0 | 1 |
| 161 | 221.8 | 22.5 | 8 |
| 259 | 243.08 | 106.5 | 8 |
| 365 | 245.06 | 92.5 | 8 |
| 464 | 245.41 | 60 | 8 |
| 568 | 245.42 | 60 | 8 |
| 665 | 252.44 | 37 | 8 |
| 766 | 268.66 | 28.2 | 8 |
| 868 | 290.89 | 26 | 8 |
| 971 | 310.8 | 35.3 | 8 |
| 1074 | 324.06 | 35.3 | 8 |
| 1172 | 367.73 | 51.6 | 8 |
| 1276 | 391.84 | 87 | 8 |
| 1374 | 405.3 | 105.2 | 8 |
| 1482 | 427.88 | 98.7 | 8 |
| 1578 | 443.27 | 122.2 | 8 |
| 1679 | 449.53 | 124.1 | 8 |
| 1781 | 455.05 | 116.7 | 8 |
| 1884 | 457.19 | 110.5 | 8 |
| 1983 | 468.55 | 115.9 | 8 |
| 2089 | 476.83 | 115.7 | 8 |
| 2189 | 474.27 | 115.7 | 8 |
| 2292 | 476.36 | 107.7 | 8 |
| 2390 | 492.48 | 102.9 | 8 |
| 2490 | 488.14 | 123.8 | 8 |
| 2595 | 496.75 | 116.2 | 8 |
| 2692 | 503.78 | 116.2 | 8 |
| 2793 | 509.56 | 111.1 | 8 |
| 2896 | 492.33 | 83.6 | 8 |
| 3003 | 490.95 | 72.5 | 8 |
| 3101 | 507.33 | 97.4 | 8 |
| 3198 | 507.03 | 97.4 | 8 |
| 3304 | 507.47 | 125.6 | 8 |
| 3402 | 504.52 | 114.1 | 8 |
| 3501 | 513.88 | 111.5 | 8 |
| 3605 | 512.14 | 102.5 | 8 |
| 3711 | 504.48 | 77.2 | 8 |
| 3810 | 507.86 | 77.2 | 8 |
| 3913 | 524.58 | 96.5 | 8 |
| 4012 | 526.36 | 119.2 | 8 |
| 4111 | 526.75 | 93.4 | 8 |
| 4212 | 532.63 | 95.1 | 8 |
| 4314 | 529.95 | 95.1 | 8 |
| 4416 | 524.8 | 77.2 | 8 |
| 4518 | 531.58 | 81.4 | 8 |
| 4620 | 530.73 | 90.4 | 8 |
| 4721 | 525.8 | 85.4 | 8 |
| 4822 | 538.58 | 85.4 | 8 |
| 4924 | 541.7 | 106.6 | 8 |
| 5029 | 532.08 | 91.4 | 8 |
| 5130 | 525.7 | 65.4 | 8 |
| 5229 | 536.86 | 90.1 | 8 |
| 5333 | 541.03 | 91.2 | 8 |
| 5435 | 534.08 | 91.2 | 8 |
| 5539 | 536.77 | 84.6 | 8 |
| 5637 | 543.88 | 99 | 8 |
| 5740 | 540.77 | 106.3 | 8 |
| 5842 | 539.36 | 97.9 | 8 |
| 5945 | 547.25 | 97.9 | 8 |
| 6043 | 541.5 | 114.1 | 8 |
| 6145 | 533.67 | 99.5 | 8 |
| 6254 | 542.23 | 96.7 | 8 |
| 6350 | 543.78 | 99.8 | 8 |
| 6453 | 543.77 | 94.5 | 8 |
| 6553 | 465.98 | 60.2 | 7 |
| 6652 | 398.97 | 32.8 | 6 |
| 6755 | 263.89 | 13 | 4 |
| 6858 | 190.17 | 1.9 | 3 |
| 6959 | 128.23 | 1.1 | 2 |

</details>

## Chromium detail

- Model: multi-tab-single-process, parallelism 8
- Wall: 5067 ms · throughput 19.74 p/s
- Latency mean/median: 295.5 / 258.0 ms
- TTFX mean/median: 252.0 / 214.0 ms
- DOM ready mean: 210.0 ms
- Peak/avg RSS: 2983.4 MiB / 1919.9 MiB
- RSS/page: 29.8 MiB · sessions/GB: 2
- CPU-sec/page: 0.1111 · integrated CPU: 11.111 s
- Peak/avg CPU: 371.0% / 222.2%
- Peak processes: 15

<details><summary>Resource time series (downsampled)</summary>

| t (ms) | RSS (MiB) | CPU Σ% | processes |
| ---: | ---: | ---: | ---: |
| 27 | 1.39 | 0 | 1 |
| 172 | 56.69 | 11.9 | 1 |
| 255 | 65.05 | 11.9 | 1 |
| 358 | 78.86 | 16 | 2 |
| 459 | 78.28 | 9.5 | 1 |
| 565 | 110.91 | 17.3 | 3 |
| 668 | 376.86 | 104.7 | 5 |
| 765 | 452.33 | 104.7 | 5 |
| 883 | 542.11 | 127 | 7 |
| 976 | 722.78 | 141.3 | 7 |
| 1086 | 932.53 | 170.6 | 9 |
| 1195 | 1283.38 | 195.5 | 13 |
| 1284 | 1617 | 195.5 | 15 |
| 1373 | 1644.05 | 218 | 15 |
| 1478 | 1650.36 | 153.9 | 15 |
| 1583 | 1658.44 | 108.7 | 15 |
| 1684 | 1687.66 | 96 | 15 |
| 1873 | 1865.66 | 130.9 | 15 |
| 1910 | 1944.45 | 130.9 | 15 |
| 2010 | 1991.56 | 258.2 | 15 |
| 2127 | 2043.64 | 245 | 15 |
| 2208 | 2083.83 | 275.2 | 15 |
| 2326 | 2148.06 | 253.7 | 15 |
| 2413 | 2183.05 | 253.7 | 15 |
| 2572 | 2278.86 | 266 | 15 |
| 2628 | 2334.02 | 343.5 | 15 |
| 2713 | 2357.77 | 371 | 15 |
| 2820 | 2398.86 | 326.8 | 15 |
| 2930 | 2439.55 | 300.9 | 15 |
| 3037 | 2462.73 | 300.9 | 15 |
| 3116 | 2490.88 | 312.3 | 15 |
| 3251 | 2530.77 | 294 | 15 |
| 3331 | 2561.88 | 347.8 | 15 |
| 3414 | 2566.2 | 349.7 | 15 |
| 3536 | 2602.31 | 349.7 | 15 |
| 3617 | 2637.8 | 326.4 | 15 |
| 3726 | 2647.61 | 315.1 | 15 |
| 3830 | 2689.66 | 296.7 | 15 |
| 3919 | 2729.05 | 332.4 | 15 |
| 4048 | 2752.83 | 332.4 | 15 |
| 4125 | 2791.64 | 280.2 | 15 |
| 4240 | 2812.13 | 290 | 15 |
| 4337 | 2863.72 | 298.5 | 15 |
| 4428 | 2885.69 | 314.2 | 15 |
| 4562 | 2901.11 | 314.2 | 15 |
| 4633 | 2927.14 | 268.2 | 15 |
| 4727 | 2932 | 280.1 | 15 |
| 4842 | 2972.91 | 226 | 15 |
| 4936 | 2983.41 | 258.7 | 15 |
| 5040 | 2223.64 | 182.4 | 12 |

</details>

## Reproduce

```bash
zig build -Doptimize=ReleaseFast
npx playwright install chromium
npm run bench:crawl:wikipedia:publish
```

Raw JSON: `code-check/tmp/benchmarks/crawl-wikipedia.json`

