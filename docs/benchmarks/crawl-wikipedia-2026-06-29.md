# Real-world crawl benchmark

> **2026-06-29T08:30:31.311Z** · 100 pages · concurrency 8 · Apple M1 (8 cores)

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
| Wall time | 8911 ms | 11965 ms | 0.74x |
| Throughput | 11.22 p/s | 8.36 p/s | 1.34x |
| Mean latency (total) | 648.0 ms | 829.4 ms | 0.78x |
| TTFX mean | 648.0 ms | 751.8 ms | 0.86x |
| TTFX median | 585.0 ms | 702.0 ms | — |
| DOM ready mean | 644.8 ms | 437.4 ms | — |
| Peak RSS | 852.8 MiB | 2988.0 MiB | 0.29x |
| Avg RSS | 617.1 MiB | 2241.5 MiB | 0.28x |
| RSS / page | 8.5 MiB | 29.9 MiB | 0.29x |
| **Sessions / GB** | 9 | 2 | 4.50x |
| **CPU-sec / page** | 0.0883 | 0.1510 | 0.58x |
| Peak CPU (Σ%) | 208.6% | 234.5% | 0.89x |
| Avg CPU (Σ%) | 98.8% | 126.2% | 0.78x |
| CPU core-equivalent (avg) | 0.99 | 1.26 | 0.78x |
| Peak process count | 8 | 15 | 0.53x |
| GPU helper processes | 0 | 0 | — |
| GPU helper RSS | 0.0 MiB | 0.0 MiB | — |
| Success rate | 100/100 | 100/100 | — |

### Cost & density takeaways

- **Memory:** Velora peak RSS is lower — better footprint per crawl worker at this concurrency.
- **Agent density:** Velora fits ~9 concurrent sessions per GB RAM vs Chromium ~2.
- **CPU cost per page:** Velora uses less CPU-sec/page (Velora 0.0883 · Chromium 0.1510).
- **TTFX (time to first extraction):** Velora reaches first extractable element faster (Velora 648.0 ms · Chromium 751.8 ms).
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
- Wall: 8911 ms · throughput 11.22 p/s
- Latency mean/median: 648.0 / 585.0 ms
- TTFX mean/median: 648.0 / 585.0 ms
- DOM ready mean: 644.8 ms
- Peak/avg RSS: 852.8 MiB / 617.1 MiB
- RSS/page: 8.5 MiB · sessions/GB: 9
- CPU-sec/page: 0.0883 · integrated CPU: 8.831 s
- Peak/avg CPU: 208.6% / 98.8%
- Peak processes: 8

<details><summary>Resource time series (downsampled)</summary>

| t (ms) | RSS (MiB) | CPU Σ% | processes |
| ---: | ---: | ---: | ---: |
| 32 | 4.92 | 0 | 1 |
| 159 | 206.75 | 12.5 | 8 |
| 260 | 317.11 | 112 | 8 |
| 362 | 319.95 | 143.8 | 8 |
| 463 | 326.55 | 103 | 8 |
| 563 | 332.13 | 79.1 | 8 |
| 665 | 335.39 | 79.1 | 8 |
| 762 | 337.08 | 55.6 | 8 |
| 866 | 341.48 | 43.7 | 8 |
| 964 | 351.42 | 33.4 | 8 |
| 1064 | 359.34 | 46.2 | 8 |
| 1166 | 364.61 | 46.2 | 8 |
| 1268 | 372.8 | 43 | 8 |
| 1370 | 383.64 | 40.3 | 8 |
| 1468 | 406.05 | 46 | 8 |
| 1566 | 428.52 | 98.2 | 8 |
| 1668 | 447.78 | 98.2 | 8 |
| 1773 | 491.19 | 97.9 | 8 |
| 1876 | 525.98 | 171.3 | 8 |
| 1969 | 552.13 | 195.2 | 8 |
| 2069 | 564.25 | 164.2 | 8 |
| 2169 | 569.13 | 164.2 | 8 |
| 2272 | 580.2 | 147.9 | 8 |
| 2371 | 587.98 | 150.7 | 8 |
| 2471 | 591.5 | 144.6 | 8 |
| 2573 | 601.13 | 129.4 | 8 |
| 2672 | 638.09 | 129.4 | 8 |
| 2772 | 638.41 | 157.3 | 8 |
| 2874 | 628.66 | 139.6 | 8 |
| 2975 | 649.06 | 120.8 | 8 |
| 3076 | 670.38 | 144.8 | 8 |
| 3176 | 667.95 | 144.8 | 8 |
| 3279 | 668.34 | 123.1 | 8 |
| 3379 | 666.38 | 80.8 | 8 |
| 3479 | 679.3 | 80.1 | 8 |
| 3578 | 679.66 | 116.7 | 8 |
| 3678 | 687.23 | 116.7 | 8 |
| 3780 | 679.94 | 121.1 | 8 |
| 3879 | 683.92 | 106.3 | 8 |
| 3981 | 693.47 | 102.3 | 8 |
| 4081 | 691.52 | 112.8 | 8 |
| 4182 | 706.61 | 112.8 | 8 |
| 4281 | 719.17 | 116.8 | 8 |
| 4382 | 720.23 | 111.1 | 8 |
| 4481 | 703.25 | 88.8 | 8 |
| 4583 | 688.05 | 80.4 | 8 |
| 4681 | 703.58 | 80.4 | 8 |
| 4792 | 744.41 | 127.9 | 8 |
| 4882 | 748.5 | 208.6 | 8 |
| 4981 | 751.81 | 165.8 | 8 |
| 5082 | 757.42 | 133.8 | 8 |
| 5184 | 761.73 | 133.8 | 8 |
| 5283 | 748.78 | 106.3 | 8 |
| 5383 | 758.17 | 100.3 | 8 |
| 5481 | 757.22 | 106.1 | 8 |
| 5584 | 763.13 | 108.8 | 8 |
| 5684 | 764.92 | 108.8 | 8 |
| 5783 | 771.66 | 98.7 | 8 |
| 5884 | 775.55 | 80.9 | 8 |
| 5985 | 770.36 | 92.4 | 8 |
| 6088 | 775.44 | 95.6 | 8 |
| 6186 | 781.28 | 95.6 | 8 |
| 6290 | 782.91 | 100.6 | 8 |
| 6385 | 774.81 | 79.5 | 8 |
| 6488 | 779.13 | 88.1 | 8 |
| 6588 | 794.98 | 131.4 | 8 |
| 6692 | 792.95 | 137.9 | 8 |
| 6788 | 793.03 | 137.9 | 8 |
| 6887 | 800.45 | 142.6 | 8 |
| 6990 | 808.56 | 113 | 8 |
| 7093 | 815.11 | 106.6 | 8 |
| 7191 | 819.48 | 99.6 | 8 |
| 7294 | 822.3 | 99.6 | 8 |
| 7392 | 822.23 | 94.9 | 8 |
| 7494 | 809.84 | 75.5 | 8 |
| 7595 | 818.36 | 81.4 | 8 |
| 7698 | 839.06 | 111.5 | 8 |
| 7797 | 852.81 | 111.5 | 8 |
| 7897 | 847.2 | 138.6 | 8 |
| 7996 | 839.94 | 102.7 | 8 |
| 8099 | 800.78 | 83 | 8 |
| 8199 | 808.56 | 77.5 | 8 |
| 8300 | 523.47 | 53.9 | 5 |
| 8403 | 511.25 | 21 | 5 |
| 8501 | 498.69 | 6.8 | 5 |
| 8604 | 306.03 | 2.6 | 3 |
| 8702 | 186.95 | 1.2 | 2 |
| 8805 | 186.95 | 1.2 | 2 |
| 8906 | 95.44 | 0.1 | 1 |

</details>

## Chromium detail

- Model: multi-tab-single-process, parallelism 8
- Wall: 11965 ms · throughput 8.36 p/s
- Latency mean/median: 829.4 / 796.0 ms
- TTFX mean/median: 751.8 / 702.0 ms
- DOM ready mean: 437.4 ms
- Peak/avg RSS: 2988.0 MiB / 2241.5 MiB
- RSS/page: 29.9 MiB · sessions/GB: 2
- CPU-sec/page: 0.1510 · integrated CPU: 15.103 s
- Peak/avg CPU: 234.5% / 126.2%
- Peak processes: 15

<details><summary>Resource time series (downsampled)</summary>

| t (ms) | RSS (MiB) | CPU Σ% | processes |
| ---: | ---: | ---: | ---: |
| 28 | 0.03 | 0 | 1 |
| 154 | 50.58 | 0 | 1 |
| 255 | 61.3 | 12.8 | 1 |
| 358 | 69.22 | 19.6 | 2 |
| 458 | 78.89 | 19.4 | 2 |
| 558 | 79.94 | 10.7 | 1 |
| 665 | 113.13 | 32 | 3 |
| 770 | 386.53 | 32 | 5 |
| 867 | 449.3 | 115.3 | 5 |
| 962 | 471.91 | 122.8 | 5 |
| 1073 | 713.44 | 147.2 | 7 |
| 1179 | 910.03 | 184 | 9 |
| 1280 | 1169.08 | 184 | 12 |
| 1371 | 1486.63 | 206.4 | 14 |
| 1466 | 1647.33 | 210.4 | 15 |
| 1571 | 1647.75 | 163.1 | 15 |
| 1673 | 1647.92 | 106.8 | 15 |
| 1776 | 1654.84 | 106.8 | 15 |
| 1872 | 1662.69 | 80.1 | 15 |
| 1981 | 1689.66 | 58.6 | 15 |
| 2074 | 1745.13 | 83.3 | 15 |
| 2178 | 1782.33 | 93.9 | 15 |
| 2275 | 1798.05 | 93.9 | 15 |
| 2375 | 1833.42 | 101.4 | 15 |
| 2477 | 1914.53 | 126 | 15 |
| 2576 | 1977.53 | 208.6 | 15 |
| 2684 | 2053.42 | 222.8 | 15 |
| 2778 | 2088.31 | 222.8 | 15 |
| 2880 | 2093.75 | 234.5 | 15 |
| 2981 | 2108.41 | 166.5 | 15 |
| 3085 | 2114.58 | 150.8 | 15 |
| 3185 | 2134.08 | 126.4 | 15 |
| 3291 | 2143.83 | 120.4 | 15 |
| 3384 | 2164.69 | 120.4 | 15 |
| 3489 | 2193.11 | 137.2 | 15 |
| 3589 | 2206.33 | 163.2 | 15 |
| 3691 | 2212.52 | 125.2 | 15 |
| 3792 | 2227.5 | 119.1 | 15 |
| 3890 | 2241.47 | 119.1 | 15 |
| 4002 | 2253.88 | 121 | 15 |
| 4089 | 2276.95 | 120.6 | 15 |
| 4192 | 2293.89 | 118.1 | 15 |
| 4301 | 2319.97 | 167.3 | 15 |
| 4394 | 2336.81 | 167.3 | 15 |
| 4496 | 2342.53 | 165 | 15 |
| 4597 | 2349.09 | 167.5 | 15 |
| 4701 | 2365.58 | 129.3 | 15 |
| 4798 | 2374.91 | 130.7 | 15 |
| 4898 | 2383.28 | 130.7 | 15 |
| 4997 | 2389.09 | 139.9 | 15 |
| 5103 | 2392.36 | 120.6 | 15 |
| 5197 | 2404.53 | 122.2 | 15 |
| 5303 | 2408.34 | 113.5 | 15 |
| 5405 | 2416.64 | 113.5 | 15 |
| 5504 | 2428.2 | 109.1 | 15 |
| 5603 | 2434.08 | 142.7 | 15 |
| 5705 | 2446.41 | 137 | 15 |
| 5811 | 2454.34 | 160.3 | 15 |
| 5914 | 2473.58 | 160.3 | 15 |
| 6005 | 2492.06 | 189.9 | 15 |
| 6110 | 2503.55 | 195.9 | 15 |
| 6207 | 2511.16 | 171.9 | 15 |
| 6307 | 2521.81 | 140.1 | 15 |
| 6414 | 2526.86 | 129.3 | 15 |
| 6512 | 2539.95 | 158.5 | 15 |
| 6613 | 2555.14 | 194 | 15 |
| 6719 | 2555.86 | 231.5 | 15 |
| 6816 | 2560.16 | 174.4 | 15 |
| 6916 | 2575.38 | 159.4 | 15 |
| 7020 | 2585.27 | 159.4 | 15 |
| 7118 | 2582.86 | 194.4 | 15 |
| 7232 | 2595.61 | 169.5 | 15 |
| 7320 | 2610.42 | 175.2 | 15 |
| 7430 | 2613.7 | 136.6 | 15 |
| 7528 | 2625.73 | 136.6 | 15 |
| 7624 | 2643.58 | 144.7 | 15 |
| 7726 | 2652.33 | 161.4 | 15 |
| 7823 | 2657.41 | 142.4 | 15 |
| 7929 | 2665.84 | 110.3 | 15 |
| 8028 | 2680.34 | 110.3 | 15 |
| 8134 | 2683.17 | 117.2 | 15 |
| 8228 | 2692.16 | 118.7 | 15 |
| 8327 | 2704.25 | 128.2 | 15 |
| 8431 | 2710.78 | 121.2 | 15 |
| 8532 | 2713.45 | 121.2 | 15 |
| 8631 | 2729.77 | 95.9 | 15 |
| 8732 | 2740.52 | 123 | 15 |
| 8834 | 2749.75 | 128.7 | 15 |
| 8934 | 2758.22 | 104.4 | 15 |
| 9036 | 2764.11 | 104.4 | 15 |
| 9139 | 2766.5 | 106.8 | 15 |
| 9239 | 2774.69 | 114.3 | 15 |
| 9338 | 2782.55 | 114.9 | 15 |
| 9435 | 2793.45 | 104.4 | 15 |
| 9551 | 2802.41 | 98.1 | 15 |
| 9639 | 2808.34 | 98.1 | 15 |
| 9741 | 2821.27 | 93.5 | 15 |
| 9843 | 2824.14 | 100.4 | 15 |
| 9954 | 2835.59 | 101.4 | 15 |
| 10040 | 2852.94 | 123.2 | 15 |
| 10142 | 2858.55 | 123.2 | 15 |
| 10245 | 2868.44 | 107.8 | 15 |
| 10346 | 2872.91 | 113.4 | 15 |
| 10446 | 2880.94 | 96.3 | 15 |
| 10557 | 2887.48 | 114.5 | 15 |
| 10645 | 2898.08 | 114.5 | 15 |
| 10751 | 2899.81 | 122.4 | 15 |
| 10846 | 2901.55 | 117.6 | 15 |
| 10946 | 2918.28 | 114 | 15 |
| 11055 | 2933.61 | 137.1 | 15 |
| 11150 | 2940.73 | 137.1 | 15 |
| 11265 | 2945.19 | 122.5 | 15 |
| 11350 | 2957.22 | 122.6 | 15 |
| 11452 | 2966.69 | 108 | 15 |
| 11554 | 2970.72 | 112.6 | 15 |
| 11657 | 2980.92 | 112.6 | 15 |
| 11753 | 2985 | 99.7 | 15 |
| 11856 | 2988.02 | 81 | 15 |
| 11959 | 1955.55 | 76.6 | 11 |

</details>

## Reproduce

```bash
zig build -Doptimize=ReleaseFast
npx playwright install chromium
npm run bench:crawl:wikipedia:publish
```

Raw JSON: `code-check/tmp/benchmarks/crawl-wikipedia.json`

