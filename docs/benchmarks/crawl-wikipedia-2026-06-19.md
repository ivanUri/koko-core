# Real-world crawl benchmark

> **2026-06-19T02:41:21.815Z** · 100 pages · concurrency 8 · Apple M1 (8 cores)

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
| Wall time | 13526 ms | 12314 ms | 1.10x |
| Throughput | 7.39 p/s | 8.12 p/s | 0.91x |
| Mean latency (total) | 993.7 ms | 825.6 ms | 1.20x |
| TTFX mean | 951.2 ms | 820.3 ms | 1.16x |
| TTFX median | 878.0 ms | 733.0 ms | — |
| DOM ready mean | 844.0 ms | 811.6 ms | — |
| Peak RSS | 984.1 MiB | 2699.6 MiB | 0.36x |
| Avg RSS | 867.4 MiB | 2022.0 MiB | 0.43x |
| RSS / page | 9.8 MiB | 27.0 MiB | 0.36x |
| **Sessions / GB** | 8 | 3 | 2.67x |
| **CPU-sec / page** | 0.5570 | 0.1534 | 3.63x |
| Peak CPU (Σ%) | 639.2% | 240.1% | 2.66x |
| Avg CPU (Σ%) | 412.8% | 125.3% | 3.29x |
| CPU core-equivalent (avg) | 4.13 | 1.25 | 3.29x |
| Peak process count | 8 | 15 | 0.53x |
| GPU helper processes | 0 | 0 | — |
| GPU helper RSS | 0.0 MiB | 0.0 MiB | — |
| Success rate | 100/100 | 100/100 | — |

### Cost & density takeaways

- **Memory:** Velora peak RSS is lower — better footprint per crawl worker at this concurrency.
- **Agent density:** Velora fits ~8 concurrent sessions per GB RAM vs Chromium ~3.
- **CPU cost per page:** Chromium uses less CPU-sec/page (Velora 0.5570 · Chromium 0.1534).
- **TTFX (time to first extraction):** Chromium reaches first extractable element faster (Velora 951.2 ms · Chromium 820.3 ms).
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
- Wall: 13526 ms · throughput 7.39 p/s
- Latency mean/median: 993.7 / 929.0 ms
- TTFX mean/median: 951.2 / 878.0 ms
- DOM ready mean: 844.0 ms
- Peak/avg RSS: 984.1 MiB / 867.4 MiB
- RSS/page: 9.8 MiB · sessions/GB: 8
- CPU-sec/page: 0.5570 · integrated CPU: 55.704 s
- Peak/avg CPU: 639.2% / 412.8%
- Peak processes: 8

<details><summary>Resource time series (downsampled)</summary>

| t (ms) | RSS (MiB) | CPU Σ% | processes |
| ---: | ---: | ---: | ---: |
| 52 | 0.8 | 0 | 1 |
| 264 | 390.75 | 140.2 | 8 |
| 335 | 443.13 | 176.6 | 8 |
| 421 | 491.63 | 221 | 8 |
| 540 | 508.03 | 240.5 | 8 |
| 659 | 517.36 | 158.3 | 8 |
| 772 | 528.27 | 99.3 | 8 |
| 831 | 556.8 | 130.8 | 8 |
| 917 | 574.2 | 130.8 | 8 |
| 1033 | 602.69 | 91.9 | 8 |
| 1117 | 621.19 | 179.1 | 8 |
| 1222 | 669.09 | 137.9 | 8 |
| 1318 | 780.97 | 271 | 8 |
| 1422 | 805.67 | 271 | 8 |
| 1546 | 837.25 | 207.5 | 8 |
| 1657 | 886.33 | 236.3 | 8 |
| 1749 | 900.88 | 366.2 | 8 |
| 1865 | 867.52 | 402.2 | 8 |
| 1952 | 877.86 | 442.2 | 8 |
| 2035 | 884.97 | 478.2 | 8 |
| 2135 | 892.47 | 447.7 | 8 |
| 2245 | 885.16 | 420.2 | 8 |
| 2370 | 878.47 | 448.6 | 8 |
| 2501 | 896.78 | 461.5 | 8 |
| 2551 | 896.41 | 461.5 | 8 |
| 2665 | 903.73 | 489.5 | 8 |
| 2807 | 902.73 | 545.9 | 8 |
| 2876 | 887.14 | 441.3 | 8 |
| 2958 | 888.86 | 478.5 | 8 |
| 3064 | 881.86 | 478.5 | 8 |
| 3160 | 880.05 | 491.1 | 8 |
| 3289 | 875.48 | 456.7 | 8 |
| 3382 | 876.67 | 450.8 | 8 |
| 3474 | 893.06 | 480.9 | 8 |
| 3567 | 903.38 | 480.9 | 8 |
| 3688 | 898.03 | 515.5 | 8 |
| 3758 | 904.47 | 551.2 | 8 |
| 3857 | 895.92 | 528 | 8 |
| 3960 | 872.39 | 461.9 | 8 |
| 4085 | 892.17 | 461.9 | 8 |
| 4190 | 908.63 | 516.9 | 8 |
| 4270 | 912.13 | 516.9 | 8 |
| 4365 | 906.38 | 540.1 | 8 |
| 4491 | 916.03 | 536.1 | 8 |
| 4571 | 916.86 | 534.1 | 8 |
| 4713 | 900.39 | 534.1 | 8 |
| 4821 | 923.03 | 526.1 | 8 |
| 4886 | 940.83 | 499.5 | 8 |
| 5020 | 945.22 | 511.4 | 8 |
| 5166 | 945.89 | 534.5 | 8 |
| 5300 | 943.89 | 567.2 | 8 |
| 5404 | 946.02 | 393.8 | 8 |
| 5487 | 941.39 | 396.6 | 8 |
| 5568 | 932.28 | 380.5 | 8 |
| 5661 | 922.52 | 380.5 | 8 |
| 5780 | 920.8 | 354.9 | 8 |
| 6033 | 928.7 | 368 | 8 |
| 6085 | 926.33 | 343.6 | 8 |
| 6181 | 933.91 | 343.6 | 8 |
| 6359 | 936.3 | 380.7 | 8 |
| 6450 | 934.78 | 372.6 | 8 |
| 6544 | 933.83 | 309.2 | 8 |
| 6630 | 933.08 | 258.2 | 8 |
| 6818 | 929.22 | 291.3 | 8 |
| 6910 | 935.05 | 335.9 | 8 |
| 6978 | 933.05 | 355 | 8 |
| 7062 | 935.52 | 355 | 8 |
| 7187 | 915.09 | 359.8 | 8 |
| 7302 | 921.41 | 390.1 | 8 |
| 7379 | 928.72 | 397 | 8 |
| 7564 | 931.89 | 418.7 | 8 |
| 7626 | 935.16 | 437.5 | 8 |
| 7782 | 936.09 | 466 | 8 |
| 7847 | 944.17 | 514.2 | 8 |
| 7935 | 940.47 | 514.2 | 8 |
| 8067 | 915.16 | 489.4 | 8 |
| 8146 | 921.41 | 496.9 | 8 |
| 8392 | 938.42 | 446.1 | 8 |
| 8467 | 945.31 | 344.8 | 8 |
| 8597 | 948.86 | 344.8 | 8 |
| 8664 | 951.17 | 355.8 | 8 |
| 8818 | 946.42 | 373.9 | 8 |
| 8887 | 941.33 | 434.1 | 8 |
| 8994 | 944.22 | 397 | 8 |
| 9143 | 943.5 | 370.8 | 8 |
| 9235 | 932.95 | 381.4 | 8 |
| 9327 | 939.88 | 381.4 | 8 |
| 9489 | 942.06 | 345.2 | 8 |
| 9651 | 943.16 | 313.7 | 8 |
| 9725 | 953.8 | 332.8 | 8 |
| 9815 | 953.7 | 332.8 | 8 |
| 9926 | 962.84 | 303.2 | 8 |
| 10008 | 950.3 | 347.1 | 8 |
| 10143 | 959.52 | 411.6 | 8 |
| 10201 | 956.02 | 463.5 | 8 |
| 10309 | 953.56 | 463.5 | 8 |
| 10441 | 939.11 | 460.4 | 8 |
| 10509 | 950.16 | 470.9 | 8 |
| 10660 | 957.53 | 446.1 | 8 |
| 10725 | 958.53 | 485.4 | 8 |
| 10814 | 956.47 | 504.3 | 8 |
| 10929 | 959.27 | 504.3 | 8 |
| 11043 | 955.44 | 502.2 | 8 |
| 11134 | 965.45 | 524 | 8 |
| 11264 | 967.58 | 544.4 | 8 |
| 11329 | 954.88 | 544.4 | 8 |
| 11421 | 964.31 | 567.6 | 8 |
| 11508 | 965.77 | 568.9 | 8 |
| 11606 | 955.09 | 571.4 | 8 |
| 11725 | 965.02 | 571 | 8 |
| 11820 | 969.23 | 540 | 8 |
| 11919 | 967.81 | 540 | 8 |
| 12026 | 967.8 | 560.4 | 8 |
| 12117 | 976.94 | 579.2 | 8 |
| 12223 | 962.61 | 567.1 | 8 |
| 12334 | 962 | 533.5 | 8 |
| 12437 | 968.92 | 533.5 | 8 |
| 12539 | 967.33 | 540.5 | 8 |
| 12625 | 971.3 | 582.3 | 8 |
| 12726 | 984.13 | 624.5 | 8 |
| 12834 | 981.38 | 639.2 | 8 |
| 12956 | 966.44 | 607.7 | 8 |
| 13025 | 955.45 | 531.8 | 8 |
| 13124 | 612.19 | 314.4 | 5 |
| 13229 | 614.19 | 369.1 | 5 |
| 13341 | 498.45 | 339.7 | 4 |
| 13419 | 249.52 | 163.2 | 3 |
| 13518 | 108.41 | 10.8 | 1 |

</details>

## Chromium detail

- Model: multi-tab-single-process, parallelism 8
- Wall: 12314 ms · throughput 8.12 p/s
- Latency mean/median: 825.6 / 740.0 ms
- TTFX mean/median: 820.3 / 733.0 ms
- DOM ready mean: 811.6 ms
- Peak/avg RSS: 2699.6 MiB / 2022.0 MiB
- RSS/page: 27.0 MiB · sessions/GB: 3
- CPU-sec/page: 0.1534 · integrated CPU: 15.340 s
- Peak/avg CPU: 240.1% / 125.3%
- Peak processes: 15

<details><summary>Resource time series (downsampled)</summary>

| t (ms) | RSS (MiB) | CPU Σ% | processes |
| ---: | ---: | ---: | ---: |
| 41 | 1.55 | 0 | 1 |
| 176 | 58.02 | 14.2 | 1 |
| 278 | 69.56 | 14.2 | 2 |
| 380 | 67.84 | 16.6 | 1 |
| 505 | 93.77 | 13.5 | 2 |
| 609 | 349.48 | 59.1 | 5 |
| 689 | 446.58 | 138.5 | 5 |
| 825 | 484.88 | 131.2 | 7 |
| 895 | 706.19 | 131.2 | 7 |
| 1017 | 795.48 | 172.4 | 8 |
| 1116 | 1090.48 | 191.7 | 11 |
| 1212 | 1360.44 | 210.4 | 14 |
| 1286 | 1596.41 | 227.1 | 15 |
| 1403 | 1587.81 | 227.1 | 15 |
| 1491 | 1592.67 | 150.7 | 15 |
| 1592 | 1606.02 | 110.3 | 15 |
| 1699 | 1629.98 | 92.1 | 15 |
| 1872 | 1802.8 | 133.4 | 15 |
| 1908 | 1804.63 | 228 | 15 |
| 2029 | 1848.13 | 228 | 15 |
| 2147 | 1879.66 | 240.1 | 15 |
| 2215 | 1890.17 | 217.2 | 15 |
| 2318 | 1904.78 | 211 | 15 |
| 2415 | 1930.53 | 175.5 | 15 |
| 2518 | 1935.59 | 175.5 | 15 |
| 2616 | 1937.47 | 139.9 | 15 |
| 2726 | 1942.94 | 100 | 15 |
| 2823 | 1964.2 | 111.2 | 15 |
| 2917 | 1972.42 | 147.6 | 15 |
| 3032 | 1974.91 | 147.6 | 15 |
| 3122 | 1989.33 | 125.7 | 15 |
| 3224 | 1995.53 | 151.9 | 15 |
| 3322 | 1997.05 | 118 | 15 |
| 3420 | 2001.28 | 97 | 15 |
| 3535 | 2004.66 | 97 | 15 |
| 3623 | 2031.45 | 91.6 | 15 |
| 3733 | 2056.45 | 134 | 15 |
| 3823 | 2092.67 | 173.5 | 15 |
| 3928 | 2095.73 | 136.3 | 15 |
| 4031 | 2111.84 | 136.3 | 15 |
| 4128 | 2133.34 | 124.3 | 15 |
| 4234 | 2153.25 | 155.2 | 15 |
| 4327 | 2158.38 | 165.1 | 15 |
| 4440 | 2174.03 | 133 | 15 |
| 4530 | 2196.3 | 133 | 15 |
| 4632 | 2204.03 | 167.1 | 15 |
| 4731 | 2205.52 | 149.1 | 15 |
| 4835 | 2206.52 | 106 | 15 |
| 4941 | 2219.44 | 71.8 | 15 |
| 5039 | 2245.2 | 167.7 | 15 |
| 5134 | 2253.84 | 167.7 | 15 |
| 5245 | 2262.08 | 152.9 | 15 |
| 5338 | 2278.7 | 153.5 | 15 |
| 5438 | 2279.44 | 144.4 | 15 |
| 5556 | 2298.17 | 134 | 15 |
| 5647 | 2311 | 134 | 15 |
| 5753 | 2312.89 | 185.3 | 15 |
| 5857 | 2326.66 | 185.7 | 15 |
| 5952 | 2322.61 | 171 | 15 |
| 6054 | 2318.73 | 157.8 | 15 |
| 6142 | 2317.06 | 157.8 | 15 |
| 6256 | 2328.59 | 131.6 | 15 |
| 6353 | 2346.89 | 144.5 | 15 |
| 6446 | 2355.38 | 186.3 | 15 |
| 6541 | 2355.63 | 228.4 | 15 |
| 6645 | 2356.2 | 228.4 | 15 |
| 6750 | 2372.11 | 164.1 | 15 |
| 6850 | 2374.86 | 166.1 | 15 |
| 6947 | 2380.3 | 128.6 | 15 |
| 7049 | 2383.88 | 111.1 | 15 |
| 7150 | 2386.53 | 111.1 | 15 |
| 7252 | 2387.36 | 82.2 | 15 |
| 7352 | 2388.34 | 59 | 15 |
| 7456 | 2396 | 58.1 | 15 |
| 7552 | 2404.5 | 93.3 | 15 |
| 7656 | 2414.72 | 133.5 | 15 |
| 7755 | 2420.73 | 132.5 | 15 |
| 7859 | 2429.06 | 116 | 15 |
| 7959 | 2441.92 | 119.9 | 15 |
| 8065 | 2450.75 | 123 | 15 |
| 8157 | 2463.03 | 133.7 | 15 |
| 8265 | 2474.11 | 133.7 | 15 |
| 8360 | 2480.8 | 132 | 15 |
| 8461 | 2484.72 | 121.6 | 15 |
| 8588 | 2499.33 | 122.7 | 15 |
| 8673 | 2513.84 | 152.2 | 15 |
| 8766 | 2533.45 | 152.2 | 15 |
| 8868 | 2536.55 | 143.2 | 15 |
| 8984 | 2541.05 | 106.8 | 15 |
| 9072 | 2542.42 | 94.8 | 15 |
| 9169 | 2552.7 | 92.1 | 15 |
| 9283 | 2559.3 | 92.1 | 15 |
| 9445 | 2564.02 | 87.6 | 15 |
| 9484 | 2571.86 | 94.4 | 15 |
| 9584 | 2582.64 | 119.6 | 15 |
| 9683 | 2583.63 | 108.5 | 15 |
| 9789 | 2584.52 | 77.3 | 15 |
| 9890 | 2592.09 | 77.3 | 15 |
| 9997 | 2615.23 | 81.5 | 15 |
| 10095 | 2626.67 | 151.2 | 15 |
| 10185 | 2647.56 | 164.5 | 15 |
| 10290 | 2648.2 | 128.7 | 15 |
| 10387 | 2649.42 | 128.7 | 15 |
| 10498 | 2656.22 | 96.1 | 15 |
| 10592 | 2662.31 | 129.7 | 15 |
| 10699 | 2668.39 | 117.2 | 15 |
| 10791 | 2671.84 | 128.7 | 15 |
| 10892 | 2687.52 | 128.7 | 15 |
| 10995 | 2689.38 | 127.5 | 15 |
| 11094 | 2699.63 | 89.1 | 15 |
| 11201 | 2470.25 | 83.4 | 14 |
| 11299 | 2000.42 | 86.6 | 12 |
| 11398 | 1756.52 | 82.4 | 11 |
| 11496 | 1472.31 | 69.4 | 10 |
| 11598 | 1474.64 | 85.5 | 10 |
| 11702 | 1475.7 | 65.9 | 10 |
| 11801 | 1476.11 | 52.1 | 10 |
| 11914 | 1475.92 | 52.1 | 10 |
| 12000 | 1244.61 | 28.7 | 9 |
| 12102 | 997.86 | 47.7 | 8 |
| 12205 | 1000.61 | 39.6 | 8 |
| 12305 | 1000.63 | 31.6 | 8 |

</details>

## Reproduce

```bash
zig build -Doptimize=ReleaseFast
npx playwright install chromium
npm run bench:crawl:wikipedia:publish
```

Raw JSON: `code-check/tmp/benchmarks/crawl-wikipedia.json`

