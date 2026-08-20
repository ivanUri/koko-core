# Koko Browser Runtime Benchmark

This harness measures Koko as a browser runtime/API service against direct Chromium CDP and, optionally, Playwright Chromium. It uses deterministic loopback fixtures and stores every observation, including warmups, failures, and timeouts.

Lightpanda is an optional protocol-matched baseline. It receives the same
loopback fixture URL as Koko and Chromium, so navigation and DOM/JS results use
the same HTML and subresources rather than comparing unrelated live-site
response counts:

```sh
zig build benchmark -Doptimize=ReleaseFast -- \
  --suite navigation,dom-js,network \
  --baseline koko-cdp,chromium-cdp,lightpanda-cdp \
  --lightpanda-bin /private/tmp/koko-lightpanda/lightpanda \
  --warmup 1 --iterations 5 --allow-failures
```

To compare a text-only resource policy on the same live site, use
`--resource-policy text-only`. Koko blocks image and stylesheet transfers at
request admission; the Lightpanda adapter keeps external stylesheets disabled
and maps image blocking to its `--block-urls` facility:

```sh
node bench/runner.mjs --suite real-sites \
  --baseline koko-cdp,lightpanda-cdp \
  --koko-bin zig-out/bin/koko \
  --lightpanda-bin /path/to/lightpanda \
  --resource-policy text-only \
  --site-file bench/real-github-resource-policy.json \
  --real-warmup 0 --real-iterations 1 --optimize ReleaseFast
```

For a separate network-free comparison, serve one frozen exported HTML
document to every adapter. That isolates parser/DOM/JavaScript cost from
network scheduling and resource policy.

## Run

```sh
zig build benchmark -Doptimize=ReleaseFast -- --suite startup --baseline koko-cdp,chromium-cdp
zig build benchmark -Doptimize=ReleaseFast -- --quick
zig build benchmark -Doptimize=ReleaseFast -- --baseline all
zig build benchmark -Doptimize=ReleaseFast -- --suite real-sites
zig build benchmark -Doptimize=ReleaseFast -- --suite concurrency --density 1,4,8,16,32
zig build benchmark -Doptimize=ReleaseFast -- --suite long-run --long-run-iterations 1000
zig build benchmark -Doptimize=ReleaseFast -- --suite concurrency --baseline koko-cdp --density 16,32 --http-max-concurrent 64 --http-max-host-open 32
zig build benchmark -Doptimize=ReleaseFast -- --suite concurrency --baseline koko-cdp --density 64,128 --cdp-max-connections 128 --http-max-concurrent 128 --http-max-host-open 64
zig build benchmark -Doptimize=ReleaseFast -- --suite network,dom-js,agent --baseline koko-cdp --warmup 1 --iterations 5
zig build benchmark -Doptimize=ReleaseFast -- --suite idle-memory --baseline koko-cdp --density 1,10,50,100,250,500,1000 --active-sessions 1
```

The default run uses five warmups and 30 measured observations for startup, navigation, and session lifecycle. Idle memory defaults to one warmup and five measured observations at 1, 4, 8, and 16 sessions because each observation launches a clean runtime. The concurrency lane navigates all sessions at the same time; the long-run lane reuses one session for repeated navigations and records a final RSS stability observation. Use `--help` for all controls.

The Playwright adapter is deliberately secondary. Install the declared npm dependencies before selecting it:

```sh
npm install
```

`--suite all` includes deterministic network, DOM/JS and agent lanes in
addition to the session and concurrency lanes. The network lane uses only
loopback fixtures for tiny/large/redirect/delayed/streaming/many-resource and
cancellation behavior. The DOM/JS lane validates create/mutate, selectors and
async work. The agent lane models navigate -> inspect -> interact -> extract.

Optional deterministic regression gate:

```sh
node bench/runner.mjs --suite concurrency,network,dom-js,agent \
  --baseline koko-cdp --density 1,10,50 --iterations 5 --optimize ReleaseFast \
  --regression-against bench-results/summary/<previous-run>.json \
  --regression-threshold-pct 10 --regression-mode fail
```

The gate compares p95 duration, median RSS and median throughput for matching
deterministic groups. Real-site groups are never hard-gated.

`--density` accepts arbitrary positive session counts, including
1/10/50/100/250/500/1000. `--active-sessions 1` turns the idle lane into an
active-plus-idle isolation test: one session navigates while the remaining
sessions stay parked.

`real-sites` is an explicitly selected integration lane and is never included in the deterministic default or `--suite all`. Its default catalog is `bench/real-sites.json`; provide another version-controlled JSON array with `--site-file`. It defaults to one warmup and three measured visits per site. The response listener remains active for `--real-settle-ms` (default 1000 ms) after DCL, while DCL latency itself is unchanged. Live-site latency must always be interpreted with HTTP status, final URL, DOM/text size, element count, response counts at DCL and after settle, and success rate.

Results are written to `bench-results/`:

- `environment.json`: host, toolchain, binaries, commit, and exact options.
- `raw/<run-id>.jsonl`: immutable per-iteration observations.
- `summary/<run-id>.json`: descriptive statistics over non-warmup successes plus failure counts.
- `report.md`: human-readable comparison and measurement limitations.

## Fairness rules

- Build Koko with `ReleaseFast`; the build step passes the exact emitted binary to the runner.
- Use only the local fixtures in `bench/fixtures/`; live websites are separate integration experiments.
- Direct CDP is the primary protocol-matched Chromium baseline. Playwright quantifies driver overhead but is not substituted for direct CDP.
- Navigation measures through `DOMContentLoaded` and validates fixture completion outside the timed interval.
- Memory is summed over each runtime's complete process tree.
- Koko creates one browser context per CDP connection by core design. The density suite therefore compares N Koko client connections with N isolated Chromium contexts and reports that contract explicitly.
- `concurrency` measures simultaneous navigation, not just session allocation. `long-run` measures reuse and retained state; a passing navigation does not by itself prove long-run memory stability.
- `--http-max-concurrent` and `--http-max-host-open` are Koko-only sweep controls; record them in the environment and compare them separately from Chromium.
- `--cdp-max-connections` controls the Koko server admission limit for high-density experiments.
- Deterministic reports include min/p50/p95/p99/max/stddev distributions and
  optional regression-gate results. Concurrency reports also include
  pages/GB-RAM and pages/CPU-second efficiency signals.
- Never publish ratios from different hosts, optimize modes, workloads, or success criteria as an A/B comparison.
