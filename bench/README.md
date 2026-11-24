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
zig build benchmark -Doptimize=ReleaseFast -- --suite network,dom-js,heavy-site,context-recycle,agent --baseline koko-cdp --warmup 1 --iterations 5
zig build benchmark -Doptimize=ReleaseFast -- --suite idle-memory --baseline koko-cdp --density 1,10,50,100,250,500,1000 --active-sessions 1
```

The default run uses five warmups and 30 measured observations for startup, navigation, and session lifecycle. Idle memory defaults to one warmup and five measured observations at 1, 4, 8, and 16 sessions because each observation launches a clean runtime. The concurrency lane navigates all sessions at the same time; the long-run lane reuses one session for repeated navigations and records a final RSS stability observation. Scale-oriented observations also record virtual memory size (VMS) and thread count; VMS is address-space reservation, not resident RAM, but it is important for high-isolate-density capacity planning. Use `--help` for all controls.

The Playwright adapter is deliberately secondary. Install the declared npm dependencies before selecting it:

```sh
npm install
```

`--suite all` includes deterministic network, DOM/JS, heavy-site, context-recycle
and agent lanes in addition to the session and concurrency lanes. The network lane uses only
loopback fixtures for tiny/large/redirect/delayed/streaming/many-resource and
cancellation behavior. The DOM/JS lane validates create/mutate, selectors and
async work. The agent lane models navigate -> inspect -> interact -> extract.

To probe the pre-upgrade admission boundary directly, use the Linux binary and
Node runtime:

```sh
node bench/handshake-admission.mjs zig-out/bin/koko 2 8 9333
```

The probe keeps eight TCP sockets open without sending a WebSocket handshake
and verifies that no more than two remain pending. This exercises the
transport-only path; V8/browser initialization must occur only after a
successful upgrade.

Both admission probes emit one self-describing JSON object. Add `--output` to
persist the exact probe artifact (the parent directory is created if needed):

```sh
node bench/handshake-admission.mjs zig-out/bin/koko 2 8 9333 8 \
  --hold-ms 800 --output bench-results/admission/handshake-off.json
node bench/active-admission.mjs zig-out/bin/koko 2 4 9343 \
  --output bench-results/admission/active-off.json
```

The artifact records the resolved binary path, capture time, probe options,
duration, before/after process status, and admission counts. Keep one artifact
per V8 profile and binary; stdout remains JSON for shell/CI pipelines.


Optional deterministic regression gate:

```sh
node bench/runner.mjs --suite concurrency,network,dom-js,agent \
  --baseline koko-cdp --density 1,10,50 --iterations 5 --optimize ReleaseFast \
  --regression-against bench-results/summary/<previous-run>.json \
  --regression-threshold-pct 10 --regression-mode fail
```

The gate compares p95 duration, median RSS, median per-session VMS when
available, and median throughput for matching deterministic groups. This
prevents a scale regression that only appears as virtual-address reservation
from being hidden by a stable RSS result. Real-site groups are never hard-gated.

For CI, prefer the standalone summary-only gate after the benchmark has
finished. It does not launch a browser, run a suite, or contact a live site;
it compares two existing summary files and writes JSON/Markdown artifacts.
Use a CI temporary directory for `--output` so generated reports are not added
to the repository:

```sh
node bench/regression-gate.mjs \
  --baseline "$CI_BASELINE_SUMMARY" \
  --current "$CI_CURRENT_SUMMARY" \
  --output "$RUNNER_TEMP/koko-regression-gate" \
  --threshold-pct 10 --mode fail
```

Exit codes are `0` for pass (and warn-mode violations), `1` for a threshold
violation in fail mode, and `2` for invalid/inconclusive input. The output
directory contains `report.json` and `report.md`; unmatched current groups are
inconclusive by default, preventing a typo or incompatible baseline from
silently passing. `--allow-missing` disables that check when intentionally
comparing a subset. The `real-sites` suite is always listed as excluded and
cannot fail this gate.

Use `--koko-label v8-pointer-compression-on` or
`--koko-label v8-pointer-compression-off` when comparing separately built
artifacts. The label is stored in `environment.json` and the Markdown report
so a density profile cannot be mistaken for the heavy-site profile.

`--density` accepts arbitrary positive session counts, including
1/10/50/100/250/500/1000. `--active-sessions 1` turns the idle lane into an
active-plus-idle isolation test: one session navigates while the remaining
sessions stay parked.

## V8 density A/B

Run the benchmark under Linux/WSL with Node.js 22+ when the Koko executable is
an ELF binary; Windows Node cannot spawn that binary directly, and the process
tree sampler requires Linux/macOS `ps`. Keep the profile label and output
directory distinct:

```sh
node bench/runner.mjs \
  --suite startup,session-lifecycle,idle-memory,concurrency,network,dom-js,heavy-site,context-recycle,agent,long-run \
  --baseline koko-cdp --koko-bin .koko-cache/koko-v8pc-on \
  --koko-label v8-pointer-compression-on --optimize ReleaseFast \
  --density 1,4,8,16 --output bench-results-v8-on-full

node bench/runner.mjs \
  --suite startup,session-lifecycle,idle-memory,concurrency,network,dom-js,heavy-site,context-recycle,agent,long-run \
  --baseline koko-cdp --koko-bin .koko-cache/koko-v8pc-off \
  --koko-label v8-pointer-compression-off --optimize ReleaseFast \
  --density 1,4,8,16 --output bench-results-v8-off-full
```

Use the opposite summary with `--regression-against` to verify the expected
trade-off: ON should trigger VMS regressions against OFF, while OFF should
trigger RSS regressions against ON. These are intentional profile differences,
not a reason to combine the two artifacts into one baseline.

`real-sites` is an explicitly selected integration lane and is never included in the deterministic default or `--suite all`. Its default catalog is `bench/real-sites.json`; provide another version-controlled JSON array with `--site-file`. It defaults to one warmup and three measured visits per site. The response listener remains active for `--real-settle-ms` (default 1000 ms) after DCL, while DCL latency itself is unchanged. Live-site latency must always be interpreted with HTTP status, final URL, DOM/text size, element count, response counts at DCL and after settle, and success rate.

Results are written to `bench-results/`:

- `environment.json`: host, toolchain, binaries, commit, and exact options.
- `raw/<run-id>.jsonl`: immutable per-iteration observations.
- `summary/<run-id>.json`: descriptive statistics over non-warmup successes plus failure counts.
- `report.md`: human-readable comparison and measurement limitations.

## Startup attribution

Koko exposes a process-level startup breakdown in `/json/version` under
`kokoStartup`. The startup suite copies these values into each observation as
`appStartupMs`, `appPlatformMs`, `appSnapshotMs`, `appStorageMs`,
`appNetworkMs`, `appDirMs`, `appTelemetryMs`, and `appArenaPoolMs`. These values
cover `App.init`; `firstSessionMs` and `firstNavigationMs` remain separate so
Browser/V8/session costs are not mixed into process startup.
The startup lane also records the first CDP session stages (`connect`, browser
context, target creation, attach, and domain enable) so cold-start regressions
can be attributed to the runtime phase that changed.
Markdown reports include these stage medians in a dedicated `Cold-start
attribution` table while retaining end-to-end p95 as the gate metric.

The HTTP easy-handle pool is lazy: App.init allocates capacity but creates curl
handles only when the first transfer needs one. This improves cold-start and
idle-server footprint; first-request latency must therefore be interpreted
alongside the startup and network lanes.

`/json/version` also exposes `kokoBuild.v8PointerCompression` and
`kokoBuild.v8MissingShims`, allowing a benchmark client to verify the V8 build
variant and compatibility-shim mode at runtime.

## Fairness rules

- Build Koko with `ReleaseFast`; the build step passes the exact emitted binary to the runner.
- Use only the local fixtures in `bench/fixtures/`; live websites are separate integration experiments.
- Direct CDP is the primary protocol-matched Chromium baseline. Playwright quantifies driver overhead but is not substituted for direct CDP.
- Navigation measures through `DOMContentLoaded` and validates fixture completion outside the timed interval.
- Memory is summed over each runtime's complete process tree. Reports distinguish RSS (resident RAM) from VMS (virtual address-space reservation); VMS is especially relevant when each CDP connection owns a V8 isolate.
- Koko creates one browser context per CDP connection by core design. The density suite therefore compares N Koko client connections with N isolated Chromium contexts and reports that contract explicitly.
- `concurrency` measures simultaneous navigation, not just session allocation. `long-run` measures reuse and retained state; a passing navigation does not by itself prove long-run memory stability.
- `--http-max-concurrent` and `--http-max-host-open` are Koko-only sweep controls; record them in the environment and compare them separately from Chromium.
- `--cdp-max-connections` controls the Koko server admission limit for high-density experiments.
- `--cdp-max-pending-connections` independently bounds sockets before WebSocket upgrade; pending sockets do not consume the upgraded-session quota.
- `--cdp-thread-stack-mb` controls the native stack reserved per Koko CDP worker; the default and minimum are 4 MiB instead of Zig's 16 MiB default. Koko derives a safe V8 JS stack limit from this reservation.
- Pending handshakes are multiplexed by one transport-only coordinator and transfer the connection to the configured full CDP worker stack after upgrade. The handshake-admission lane reports RSS/VMS/thread counts before and during the pending flood.
- `--worker-max-pages` and `--worker-max-rss` select the Koko isolate-recycle policy for profile comparisons. Use `0` to disable either limit; the production defaults remain controlled by the Koko binary.
- A source V8 build can be compared with `-Dv8_enable_pointer_compression=false` for high-isolate-density experiments. The option is intentionally explicit: it trades pointer size/heap efficiency for avoiding V8's large per-isolate virtual cage reservation. A prebuilt `v8/libc_v8.a` is not rebuilt by this switch.
- When linking a source-built V8 archive that exports the current wrapper symbols, also pass `-Dv8_missing_shims=false`; the default remains enabled for the checked-in prebuilt archive.
- Deterministic reports include min/p50/p95/p99/max/stddev distributions and
  optional regression-gate results. Concurrency reports also include
  pages/GB-RAM and pages/CPU-second efficiency signals.
- Never publish ratios from different hosts, optimize modes, workloads, or success criteria as an A/B comparison.
