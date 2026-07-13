# BBC first-load SIGSEGV: Script.deliverable UAF on aborted frame script fetch

## Summary

`https://www.bbc.com/news` crashed Velora on the **first** `Page.navigate` (~3s after navigation) with SIGSEGV and CDP WebSocket close. lldb showed the fault in `Script.deliverable` while handling an HTTP `Abort` for `emp.bbci.co.uk/.../bump-4.js`. The script manager still held a `Script` whose `fe.frame` pointer was stale after frame teardown during navigation abort.

The fix gates `deliverable()` on `LoadGuard.isFinished()`, routes frame-script deliverability through `manager.owner.parentFrame()` instead of `fe.frame`, and prefers `shutdown_callback` over `error_callback` in `HttpClient.abortChromeJobsAttributed` when a script fetch is torn down.

## Problem

- **Symptom:** 100% repro on first BBC navigate; `ws closed` / velora SIGSEGV; not a timeout.
- **Trigger log:** `script fetch error err=Abort req=https://emp.bbci.co.uk/emp/bump-4/bump-4.js extra=frame status=200`
- **Backtrace (ReleaseFast + lldb):** `Script.deliverable` → `Script.errorCallback` → `InterceptionLayer.errorCallback` → `HttpClient.processMessages`

Distinct from the re-navigate teardown bugs documented in [`2026-07-09-renavigate-page-teardown.md`](2026-07-09-renavigate-page-teardown.md): this crash happens before any second navigation.

## Root Cause

When navigation aborts in-flight subresource loads, `HttpClient` invokes terminal callbacks (`error_callback` with `Abort`) on worker threads. For frame-attached scripts, `Script.deliverable()` read live fields from `fe.frame` (`realm_state`, `isGoingAway()`) after the frame had been torn down or superseded. `LoadGuard.isDeliverableForRealm` was meant to prevent delivery, but `deliverable()` still dereferenced the frame pointer first.

Using `error_callback` on abort also re-entered script delivery paths instead of the idempotent `shutdown_callback` path.

## Solution

**`src/core/browser/ScriptManagerBase.zig`**

- `deliverable()`: return false when `guard.isFinished()` or `manager.shutdown`.
- Frame scripts: `deliverableFrameScript()` uses `manager.owner.parentFrame()` and null-checks before reading realm / going-away state.
- `deinit()` / `shutdownCallback()`: early-out when guard already finished.

**`src/core/browser/HttpClient.zig`**

- `abortChromeJobsAttributed`: call `shutdown_callback` when present instead of `error_callback` (three call sites).

## Verification

```bash
cd /Users/huydev/Desktop/velora
npm install
node scripts/bbc-crash-repro.mjs                    # exit 0, ~338k HTML bytes
node scripts/bbc-crash-repro.mjs  # x3             # 3/3 exit 0
node code-check/site-stability/debug-reload.mjs "https://www.bbc.com/news"  # 2/2, velora alive
```

Observed title: `BBC News - Breaking news, video and the latest top stories from the U.S. and around the world`.

## Related Knowledge

- [`2026-07-09-renavigate-page-teardown.md`](2026-07-09-renavigate-page-teardown.md) — second-navigate BBC crashes (Page teardown, attributed abort)
- [`2026-07-09-load-guard-navigation-gate.md`](../architecture/2026-07-09-load-guard-navigation-gate.md) — LoadGuard deliverability model