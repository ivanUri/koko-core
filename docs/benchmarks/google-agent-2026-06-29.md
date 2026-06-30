# Google agent search benchmark

> **2026-06-29T08:44:26.183Z** · 5 queries · concurrency 1 · extract top 5 · Apple M1 (8 cores)

## What this measures

- **Benchmark class:** `agent-search` — live Google Search → parse SERP → extract organic results
- **Workload:** agent turns `query → top N results` (title + URL)
- **Velora profile:** `chrome-local-huys-macbook-pro` (baked session cookies via profile seed)
- **Chromium:** Playwright headless, **no** Google session jar (cold guest baseline)
- **Inter-search gap:** 0 ms (rate-limit hygiene)

## Agent path quality

| Engine | Success | Short SERP | Long bootstrap | Blocked | Mean results | Mean TTFX |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Velora | 5/5 | 5 | 0 | 0 | 5.0 | 846.2 ms |

## Throughput & cost

| Metric | Velora |
| --- | ---:
| Wall time | 4603 ms |
| Throughput | 1.09 /s |
| Mean latency | 846.2 ms |
| Peak RSS | 2342.6 MiB |
| CPU-sec/search | 0.2598 |

## Sample extractions (Velora)

- **rust programming book - Google Search** (880 ms, short-serp)
  - #1: [The Rust Programming Language](https://doc.rust-lang.org/book/)
- **openstreetmap api - Google Search** (608 ms, short-serp)
  - #1: [API - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/API)
- **zig language tutorial - Google Search** (570 ms, short-serp)
  - #1: [Learn ⚡ Zig Programming Language](https://ziglang.org/learn/)
- **python asyncio guide - Google Search** (602 ms, short-serp)
  - #1: [Python's asyncio: A Hands-On Walkthrough](https://realpython.com/async-io-python/)
- **postgresql indexing - Google Search** (1571 ms, short-serp)
  - #1: [Documentation: 18: Chapter 11. Indexes](https://www.postgresql.org/docs/current/indexes.html)

## Reproduce

```bash
zig build -Doptimize=ReleaseFast
npm run bench:google:agent:publish
```

Raw JSON: `code-check/tmp/benchmarks/google-agent.json`
