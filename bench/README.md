# Koko Browser Runtime Benchmark

This harness measures Koko as a browser runtime/API service against direct Chromium CDP and, optionally, Playwright Chromium. It uses deterministic loopback fixtures and stores every observation, including warmups, failures, and timeouts.

## Run

```sh
zig build benchmark -Doptimize=ReleaseFast -- --suite startup --baseline koko-cdp,chromium-cdp
zig build benchmark -Doptimize=ReleaseFast -- --quick
zig build benchmark -Doptimize=ReleaseFast -- --baseline all
zig build benchmark -Doptimize=ReleaseFast -- --suite real-sites
```

The default run uses five warmups and 30 measured observations for startup, navigation, and session lifecycle. Idle memory defaults to one warmup and five measured observations at 1, 4, 8, and 16 sessions because each observation launches a clean runtime. Use `--help` for all controls.

The Playwright adapter is deliberately secondary. Install the declared npm dependencies before selecting it:

```sh
npm install
```

`real-sites` is an explicitly selected integration lane and is never included in the deterministic default or `--suite all`. Its default catalog is `bench/real-sites.json`; provide another version-controlled JSON array with `--site-file`. It defaults to one warmup and three measured visits per site. Live-site latency must always be interpreted with HTTP status, final URL, DOM/text size, element count, response count, and success rate.

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
- Never publish ratios from different hosts, optimize modes, workloads, or success criteria as an A/B comparison.
