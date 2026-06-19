# Agent extract: Hacker News

> **2026-06-19T02:45:21.770Z** · 100 pages · concurrency 8 · Apple M1 (8 cores)

## What this measures

- **Benchmark class:** `agent-extract` — network → HTML parse → DOM extract (not full browser fidelity)
- **Site:** https://news.ycombinator.com/ (live internet)
- **Workload:** 100 story pages (shared list: `/Users/huydev/Desktop/velora/code-check/tmp/benchmarks/hn-story-ids.json`)
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

> Agent extract: navigate live page → TTFX on first DOM hit → structured extract.

## Scalability comparison

Ratio **Velora / Chromium**. Values **< 1** mean Velora uses less (better for memory/CPU/time); **> 1** means Velora uses more.

| Metric | Velora | Chromium | Ratio (V/C) |
| --- | ---: | ---: | ---: |
| Wall time | 32514 ms | 104877 ms | 0.31x |
| Throughput | 3.08 p/s | 0.95 p/s | 3.23x |
| Mean latency (total) | 1650.7 ms | 6401.0 ms | 0.26x |
| TTFX mean | 1649.3 ms | 6398.4 ms | 0.26x |
| TTFX median | 1132.0 ms | 5502.0 ms | — |
| DOM ready mean | 1648.3 ms | 6395.6 ms | — |
| Peak RSS | 740.4 MiB | 2473.1 MiB | 0.30x |
| Avg RSS | 677.5 MiB | 2128.3 MiB | n/a |
| RSS / page | 7.4 MiB | 24.7 MiB | n/a |
| **Sessions / GB** | 11 | 3 | 3.67x |
| **CPU-sec / page** | 0.1037 | 0.1509 | 0.69x |
| Peak CPU (Σ%) | 278.0% | 221.6% | n/a |
| Avg CPU (Σ%) | 31.8% | 14.4% | n/a |
| CPU core-equivalent (avg) | 0.32 | 0.14 | n/a |
| Peak process count | 8 | 15 | n/a |
| GPU helper processes | 0 | 0 | — |
| GPU helper RSS | 0.0 MiB | 0.0 MiB | — |
| Success rate | 88/100 | 76/100 | — |

### Cost & density takeaways

- **Memory:** Velora peak RSS is lower — better footprint per crawl worker at this concurrency.
- **Agent density:** Velora fits ~11 concurrent sessions per GB RAM vs Chromium ~3.
- **CPU cost per page:** Velora uses less CPU-sec/page (Velora 0.1037 · Chromium 0.1509).
- **TTFX (time to first extraction):** Velora reaches first extractable element faster (Velora 1649.3 ms · Chromium 6398.4 ms).
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
- Wall: 32514 ms · throughput 3.08 p/s
- Latency mean/median: 1650.7 / 1133.0 ms
- TTFX mean/median: 1649.3 / 1132.0 ms
- DOM ready mean: 1648.3 ms
- Peak/avg RSS: 740.4 MiB / 677.5 MiB
- RSS/page: 7.4 MiB · sessions/GB: 11
- CPU-sec/page: 0.1037 · integrated CPU: 10.375 s
- Peak/avg CPU: 278.0% / 31.8%
- Peak processes: 8
- Failures:
  - hn-48586648: ttfx: extractable element not found
  - hn-48588304: ttfx: extractable element not found
  - hn-48545935: ttfx: extractable element not found
  - hn-48582794: ttfx: extractable element not found
  - hn-48592731: ttfx: extractable element not found
  - hn-48575997: ttfx: extractable element not found
  - hn-48566791: ttfx: extractable element not found
  - hn-48553265: ttfx: extractable element not found
  - hn-48580504: ttfx: extractable element not found
  - hn-48590590: ttfx: extractable element not found

<details><summary>Resource time series (downsampled)</summary>

| t (ms) | RSS (MiB) | CPU Σ% | processes |
| ---: | ---: | ---: | ---: |
| 28 | 0.77 | 0 | 1 |
| 262 | 488.38 | 278 | 8 |
| 465 | 572.59 | 231.3 | 8 |
| 663 | 603.59 | 159.8 | 8 |
| 869 | 612.16 | 134.3 | 8 |
| 1072 | 622.83 | 58.1 | 8 |
| 1272 | 632.42 | 40.4 | 8 |
| 1476 | 655.08 | 47.8 | 8 |
| 1677 | 676.73 | 58.9 | 8 |
| 1878 | 682.52 | 55.9 | 8 |
| 2081 | 688.41 | 78.6 | 8 |
| 2278 | 689.69 | 52.3 | 8 |
| 2483 | 688.06 | 36.7 | 8 |
| 2686 | 689.95 | 42.1 | 8 |
| 2886 | 688.23 | 37.7 | 8 |
| 3087 | 695.06 | 82.5 | 8 |
| 3294 | 695.28 | 47.9 | 8 |
| 3490 | 694.81 | 42.6 | 8 |
| 3697 | 697.7 | 60.1 | 8 |
| 3897 | 695.53 | 31.4 | 8 |
| 4102 | 695.73 | 37 | 8 |
| 4296 | 699.8 | 43.4 | 8 |
| 4502 | 699.47 | 36.3 | 8 |
| 4706 | 698.59 | 22.4 | 8 |
| 4908 | 699.25 | 10.1 | 8 |
| 5111 | 702.03 | 45.7 | 8 |
| 5308 | 701.69 | 23.9 | 8 |
| 5511 | 702.42 | 35.7 | 8 |
| 5713 | 706.17 | 53.7 | 8 |
| 5914 | 705.61 | 32.2 | 8 |
| 6119 | 705.8 | 26 | 8 |
| 6319 | 703.69 | 10.7 | 8 |
| 6522 | 704.56 | 12.4 | 8 |
| 6720 | 710.08 | 28.9 | 8 |
| 6921 | 713.05 | 77.9 | 8 |
| 7123 | 719.66 | 118.2 | 8 |
| 7327 | 719.03 | 101.1 | 8 |
| 7528 | 716.77 | 46.6 | 8 |
| 7727 | 715.08 | 29.8 | 8 |
| 7933 | 717.27 | 32.7 | 8 |
| 8129 | 710.45 | 37.5 | 8 |
| 8334 | 709.89 | 41.3 | 8 |
| 8534 | 708.31 | 59.2 | 8 |
| 8738 | 706.92 | 38.5 | 8 |
| 8940 | 708.63 | 24.3 | 8 |
| 9142 | 710.77 | 16.4 | 8 |
| 9343 | 711.86 | 8.6 | 8 |
| 9544 | 712.05 | 3.6 | 8 |
| 9744 | 712.16 | 3.9 | 8 |
| 9946 | 714.8 | 34.8 | 8 |
| 10147 | 714.8 | 14.3 | 8 |
| 10349 | 714.8 | 8.9 | 8 |
| 10552 | 714.8 | 4.4 | 8 |
| 10751 | 713.72 | 3.1 | 8 |
| 10954 | 713.75 | 4.2 | 8 |
| 11158 | 713.8 | 2.8 | 8 |
| 11354 | 717.95 | 10.1 | 8 |
| 11557 | 722.53 | 65.5 | 8 |
| 11758 | 727.58 | 79.2 | 8 |
| 11959 | 730.59 | 67.7 | 8 |
| 12165 | 727.83 | 52.4 | 8 |
| 12368 | 715.39 | 38.5 | 8 |
| 12569 | 715.03 | 18.4 | 8 |
| 12766 | 719.25 | 12 | 8 |
| 12967 | 723.8 | 67 | 8 |
| 13204 | 726.36 | 70.3 | 8 |
| 13406 | 721.77 | 32.4 | 8 |
| 13611 | 722.16 | 21.3 | 8 |
| 13811 | 722.16 | 9 | 8 |
| 14014 | 722.41 | 7.1 | 8 |
| 14212 | 715.41 | 22.6 | 8 |
| 14414 | 715.2 | 12.4 | 8 |
| 14612 | 716.39 | 19.6 | 8 |
| 14814 | 716.97 | 34.1 | 8 |
| 15019 | 715.88 | 31.9 | 8 |
| 15219 | 715.06 | 14.8 | 8 |
| 15424 | 715.06 | 6.6 | 8 |
| 15625 | 715.09 | 5.9 | 8 |
| 15826 | 715.45 | 4.6 | 8 |
| 16030 | 715.09 | 6.6 | 8 |
| 16228 | 715.34 | 6.1 | 8 |
| 16430 | 715.97 | 11 | 8 |
| 16630 | 715.91 | 7 | 8 |
| 16831 | 714.88 | 22.7 | 8 |
| 17040 | 716.16 | 33.3 | 8 |
| 17240 | 716.92 | 38.2 | 8 |
| 17443 | 717.17 | 44.1 | 8 |
| 17641 | 714.36 | 27.3 | 8 |
| 17853 | 711.41 | 19.6 | 8 |
| 18045 | 712.16 | 19.2 | 8 |
| 18245 | 713.19 | 11.8 | 8 |
| 18455 | 713.53 | 11.8 | 8 |
| 18648 | 714.17 | 21.3 | 8 |
| 18857 | 714.55 | 19.1 | 8 |
| 19056 | 715.45 | 15.6 | 8 |
| 19256 | 715.64 | 12.9 | 8 |
| 19462 | 715.64 | 5 | 8 |
| 19659 | 716.27 | 4 | 8 |
| 19863 | 716.73 | 2.6 | 8 |
| 20064 | 719.05 | 27.3 | 8 |
| 20262 | 723.53 | 30.5 | 8 |
| 20467 | 725.3 | 97.5 | 8 |
| 20667 | 722.58 | 49.9 | 8 |
| 20874 | 724.42 | 30.9 | 8 |
| 21077 | 724.73 | 14.3 | 8 |
| 21277 | 725.02 | 10 | 8 |
| 21503 | 725.77 | 5.5 | 8 |
| 21685 | 725.88 | 3.4 | 8 |
| 21890 | 725.88 | 2.7 | 8 |
| 22090 | 726.09 | 2.4 | 8 |
| 22294 | 726.33 | 2.2 | 8 |
| 22495 | 727.63 | 2 | 8 |
| 22692 | 730.88 | 8.7 | 8 |
| 22895 | 735.28 | 42.5 | 8 |
| 23099 | 738.3 | 75.3 | 8 |
| 23303 | 735.67 | 34.3 | 8 |
| 23501 | 731.89 | 21.6 | 8 |
| 23703 | 735.98 | 72.8 | 8 |
| 23910 | 740.41 | 120.8 | 8 |
| 24108 | 735.39 | 57.7 | 8 |
| 24313 | 733.05 | 26.5 | 8 |
| 24511 | 733.05 | 17.5 | 8 |
| 24714 | 733.16 | 8 | 8 |
| 24912 | 732.3 | 15.1 | 8 |
| 25113 | 737.09 | 69.1 | 8 |
| 25321 | 737.81 | 46.8 | 8 |
| 25520 | 735.13 | 33.8 | 8 |
| 25725 | 735.13 | 14.5 | 8 |
| 25927 | 735.13 | 6.6 | 8 |
| 26130 | 735.42 | 4.9 | 8 |
| 26334 | 735.42 | 3.3 | 8 |
| 26534 | 735.42 | 2.8 | 8 |
| 26738 | 735.5 | 2.4 | 8 |
| 26941 | 735.5 | 1.9 | 8 |
| 27140 | 735.67 | 2.3 | 8 |
| 27344 | 735.67 | 1.2 | 8 |
| 27542 | 735.67 | 1.8 | 8 |
| 27742 | 730.84 | 19.5 | 8 |
| 27947 | 730.84 | 17.3 | 8 |
| 28148 | 730.94 | 12.3 | 8 |
| 28350 | 730.94 | 5.8 | 8 |
| 28549 | 731.05 | 4.5 | 8 |
| 28749 | 724.92 | 2.8 | 8 |
| 28955 | 727.61 | 47 | 8 |
| 29152 | 726.22 | 32.8 | 8 |
| 29361 | 725.11 | 25.7 | 8 |
| 29560 | 725.13 | 13.4 | 8 |
| 29763 | 725.13 | 8.2 | 8 |
| 29962 | 727.38 | 40.5 | 8 |
| 30163 | 544.3 | 11 | 6 |
| 30363 | 546.69 | 20.7 | 6 |
| 30568 | 538.92 | 19.9 | 6 |
| 30772 | 273.08 | 0.9 | 3 |
| 30971 | 273.08 | 0.7 | 3 |
| 31174 | 273.19 | 1 | 3 |
| 31373 | 271.88 | 0.9 | 3 |
| 31577 | 183.23 | 36 | 2 |
| 31781 | 183.23 | 22.4 | 2 |
| 31982 | 183.23 | 8.8 | 2 |
| 32186 | 183.23 | 3.8 | 2 |
| 32386 | 92.7 | 2.1 | 1 |

</details>

## Chromium detail

- Model: multi-tab-single-process, parallelism 8
- Wall: 104877 ms · throughput 0.95 p/s
- Latency mean/median: 6401.0 / 5503.0 ms
- TTFX mean/median: 6398.4 / 5502.0 ms
- DOM ready mean: 6395.6 ms
- Peak/avg RSS: 2473.1 MiB / 2128.3 MiB
- RSS/page: 24.7 MiB · sessions/GB: 3
- CPU-sec/page: 0.1509 · integrated CPU: 15.090 s
- Peak/avg CPU: 221.6% / 14.4%
- Peak processes: 15
- Failures:
  - hn-48543311: ttfx: extractable element not found
  - hn-48585866: ttfx: extractable element not found
  - hn-48583897: ttfx: extractable element not found
  - hn-48584709: ttfx: extractable element not found
  - hn-48581070: ttfx: extractable element not found
  - hn-48586648: ttfx: extractable element not found
  - hn-48593416: ttfx: extractable element not found
  - hn-48581458: ttfx: extractable element not found
  - hn-48545935: ttfx: extractable element not found
  - hn-48592731: ttfx: extractable element not found

<details><summary>Resource time series (downsampled)</summary>

| t (ms) | RSS (MiB) | CPU Σ% | processes |
| ---: | ---: | ---: | ---: |
| 27 | 1.33 | 0 | 1 |
| 862 | 1635.88 | 221.6 | 15 |
| 1671 | 1659.67 | 27.3 | 15 |
| 2481 | 1675.69 | 12.3 | 15 |
| 3291 | 1677.47 | 7.7 | 15 |
| 4095 | 1696.56 | 11.2 | 15 |
| 4908 | 1697.58 | 8 | 15 |
| 5711 | 1797.88 | 78.4 | 15 |
| 6522 | 1824.91 | 17.6 | 15 |
| 7333 | 1831.92 | 15.6 | 15 |
| 8141 | 1844.48 | 11.4 | 15 |
| 8946 | 1854.38 | 12.8 | 15 |
| 9753 | 1863.61 | 14.9 | 15 |
| 10561 | 1864.09 | 7.6 | 15 |
| 11368 | 1871.19 | 7.9 | 15 |
| 12179 | 1879.38 | 11.1 | 15 |
| 12984 | 1881.27 | 9 | 15 |
| 13793 | 1885.16 | 9.6 | 15 |
| 14601 | 1885.45 | 7.6 | 15 |
| 15406 | 1887.13 | 8.2 | 15 |
| 16215 | 1931.66 | 13.4 | 15 |
| 17022 | 1942.45 | 16.3 | 15 |
| 17826 | 1961.66 | 22.8 | 15 |
| 18632 | 1964.56 | 7.8 | 15 |
| 19439 | 1964.5 | 8.1 | 15 |
| 20251 | 1965.81 | 7.3 | 15 |
| 21056 | 1987.75 | 33.5 | 15 |
| 21860 | 2005.91 | 13.3 | 15 |
| 22671 | 2026.28 | 30.2 | 15 |
| 23479 | 2031.58 | 28.2 | 15 |
| 24286 | 2044.14 | 19.7 | 15 |
| 25095 | 2063.16 | 18.7 | 15 |
| 25904 | 2065.33 | 8.8 | 15 |
| 26708 | 2068.41 | 8 | 15 |
| 27518 | 2089.88 | 11.1 | 15 |
| 28321 | 2091.06 | 7.5 | 15 |
| 29130 | 2093.61 | 7.1 | 15 |
| 29936 | 2095.78 | 7.6 | 15 |
| 30744 | 2132.22 | 23.3 | 15 |
| 31553 | 2037.22 | 9.2 | 14 |
| 32362 | 2043.69 | 14 | 14 |
| 33169 | 2047.39 | 11.4 | 14 |
| 33979 | 2053.69 | 9.9 | 14 |
| 34785 | 2055.2 | 9.7 | 14 |
| 35594 | 2056.73 | 8.4 | 14 |
| 36402 | 2110.66 | 51.3 | 14 |
| 37207 | 2111.97 | 8.9 | 14 |
| 38016 | 2120.61 | 15 | 14 |
| 38819 | 2122.97 | 8.1 | 14 |
| 39630 | 2128.5 | 19.5 | 14 |
| 40440 | 2132.5 | 13.7 | 14 |
| 41246 | 2140.92 | 13.6 | 14 |
| 42049 | 2156.53 | 24.6 | 14 |
| 42856 | 2163.92 | 13 | 14 |
| 43664 | 2164.86 | 6.9 | 14 |
| 44485 | 2165.8 | 6.3 | 14 |
| 45282 | 2168.42 | 15.8 | 14 |
| 46088 | 2168.59 | 6.5 | 14 |
| 46896 | 2169.66 | 7.5 | 14 |
| 47706 | 2170.86 | 6.3 | 14 |
| 48512 | 2173.75 | 8.2 | 14 |
| 49317 | 2175.36 | 7.4 | 14 |
| 50124 | 2215.05 | 28.3 | 14 |
| 50930 | 2216.39 | 16.6 | 14 |
| 51736 | 2228.59 | 20.2 | 14 |
| 52551 | 2231.97 | 8.4 | 14 |
| 53355 | 2233.44 | 8.5 | 14 |
| 54162 | 2258.55 | 18.8 | 14 |
| 54968 | 2263.67 | 10.2 | 14 |
| 55777 | 2264.34 | 7.6 | 14 |
| 56582 | 2265.45 | 7.1 | 14 |
| 57384 | 2279.97 | 34.5 | 14 |
| 58195 | 2285.59 | 10.6 | 14 |
| 58996 | 2296.25 | 14.4 | 14 |
| 59805 | 2297.59 | 7.2 | 14 |
| 60612 | 2302.91 | 13.1 | 14 |
| 61415 | 2304.84 | 7.7 | 14 |
| 62226 | 2307.17 | 11.8 | 14 |
| 63033 | 2311.98 | 21.9 | 14 |
| 63840 | 2347.56 | 24.3 | 14 |
| 64647 | 2353.38 | 16.9 | 14 |
| 65454 | 2353.3 | 7 | 14 |
| 66264 | 2362.8 | 17.6 | 14 |
| 67071 | 2362.27 | 13.2 | 14 |
| 67876 | 2368.05 | 15.5 | 14 |
| 68686 | 2368.77 | 7.8 | 14 |
| 69488 | 2373.3 | 7.3 | 14 |
| 70297 | 2373.25 | 7.8 | 14 |
| 71106 | 2373.58 | 8.3 | 14 |
| 71908 | 2372.64 | 11.2 | 14 |
| 72719 | 2374.83 | 11.1 | 14 |
| 73522 | 2408.97 | 12.9 | 14 |
| 74329 | 2416.83 | 18.8 | 14 |
| 75142 | 2418.7 | 9.8 | 14 |
| 75947 | 2401.34 | 8.4 | 14 |
| 76755 | 2403.22 | 8.1 | 14 |
| 77565 | 2404.92 | 9.1 | 14 |
| 78368 | 2441.31 | 25 | 14 |
| 79179 | 2442.14 | 6.9 | 14 |
| 79984 | 2445.86 | 8.7 | 14 |
| 80790 | 2446.78 | 29.2 | 14 |
| 81596 | 2447.11 | 9.8 | 14 |
| 82406 | 2448.02 | 11.1 | 14 |
| 83213 | 2448.47 | 8.5 | 14 |
| 84020 | 2447.63 | 6.7 | 14 |
| 84826 | 2448.5 | 6.3 | 14 |
| 85635 | 2449.72 | 7.7 | 14 |
| 86440 | 2451.25 | 9.4 | 14 |
| 87247 | 2451.31 | 7.2 | 14 |
| 88054 | 2453.81 | 7.8 | 14 |
| 88862 | 2456.09 | 9.5 | 14 |
| 89668 | 2459.08 | 10 | 14 |
| 90477 | 2462.19 | 9.9 | 14 |
| 91284 | 2465.66 | 8.9 | 14 |
| 92089 | 2464.05 | 11 | 14 |
| 92897 | 2464.92 | 7.3 | 14 |
| 93705 | 2465.72 | 8 | 14 |
| 94513 | 2465.72 | 8.6 | 14 |
| 95318 | 2473.03 | 24.5 | 14 |
| 96121 | 2275.3 | 16.7 | 13 |
| 96931 | 2088.19 | 24.4 | 12 |
| 97737 | 1728.7 | 54.7 | 10 |
| 98543 | 1777.94 | 16.4 | 11 |
| 99354 | 1814.66 | 1.6 | 11 |
| 100158 | 1807.77 | 0.5 | 11 |
| 100969 | 1807.78 | 0.7 | 11 |
| 101777 | 1812.42 | 2.1 | 11 |
| 102582 | 1812.38 | 0.4 | 11 |
| 103390 | 1353.69 | 11.9 | 9 |
| 104198 | 1091.55 | 5.6 | 8 |

</details>

## Reproduce

```bash
zig build -Doptimize=ReleaseFast
npx playwright install chromium
npm run bench:crawl:wikipedia:publish
```

Raw JSON: `code-check/tmp/benchmarks/crawl-wikipedia.json`

