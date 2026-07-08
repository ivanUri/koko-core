# WPT async/error batch — microtask checkpoint, uncaught exceptions, timers

> **Date:** 2026-07-05

## Summary

Ran 30 WPT suites covering `queueMicrotask`, timers, promise job queue, `unhandledrejection`, and `window.onerror` against Velora `:9223`. Initial batch: **14 Pass / 41 Fail / 3 Crash**. Root causes: missing V8 uncaught-exception reporting, microtask checkpoints aborted while root realm stayed `.initializing` after parse, and timer callbacks swallowing JS exceptions.

## Problem

| Symptom | Suites affected |
|---------|-----------------|
| `microtask.checkpoint_aborted` + `realm_state = initializing` | Most failing async tests |
| `Fail 0/1` (timeout) | `queue-microtask-exceptions`, timer `onerror` tests |
| `Crash 0/0` | `promise-job-entry*` (intermittent) |
| Partial pass | `queue-microtask.any` 4/5, `promise-rejection-events` 29/43 |

Velora never registered a V8 `MessageListener`, so exceptions from `queueMicrotask(() => { throw err })` and timer string bodies never reached `window.onerror` / `addEventListener('error')`.

`Execution.canEnterJs(.allow_draining)` allowed microtasks for **child** iframes during `.initializing` (Turnstile) but not the **root** frame after document parse — starving promise reactions during load.

## Root cause

1. **No embedder uncaught-exception path** — `PerformCheckpoint` ran but V8's `ReportMessageToEmbedder` had zero listeners; `Timers.zig` caught `JsException` and only logged.
2. **Over-strict root microtask gate** — `realm_state == .initializing` blocked checkpoints even when `_parse_state == .complete`.
3. **Promise entry settings for `window.open`** — `openPopup` resolved relative URLs against the relevant frame (`this`), not the HTML entry settings object. Fixed via `GetEnteredOrMicrotaskContext`.

## Fix

| File | Change |
|------|--------|
| `src/core/js/Env.zig` | `AddMessageListener` + `SetCaptureStackTraceForUncaughtExceptions`; `uncaughtExceptionCallback` → `reportUncaughtException` |
| `src/core/webapi/Window.zig` | `reportUncaughtException(message, filename, line, col, error)` shared by `reportError` |
| `src/core/webapi/WorkerGlobalScope.zig` | Same for worker `onerror` |
| `src/core/webapi/Timers.zig` | Timer/RAF/idle callbacks report uncaught via `TryCatch.exceptionValue` |
| `src/core/js/Execution.zig` | Allow `.initializing` + `realmParseComplete()` for microtask drain |
| `src/core/browser/Frame.zig` | `realmParseComplete()` helper |
| `src/core/js/TryCatch.zig` | `exceptionValue()` for live Error object |
| `vendor/v8-wrapper/src/binding.{h,cpp}` | `v8__Isolate__GetEnteredOrMicrotaskContext` |
| `src/core/js/Context.zig` | `getEntryFrame()` from entered/microtask context |
| `src/core/browser/Frame.zig` | `openPopup` URL base uses entry frame, not `this` frame |
| `src/core/webapi/Window.zig` | `postMessage` `MessageEvent.source` via `getIncumbent()` + `resolvePostMessageSourceFrame` fallbacks |

## Verified

| Run | Pass | Fail | Crash | Log |
|-----|------|------|-------|-----|
| Pre-fix | 14 | 41 | 3 | `wpt-async-error-20260705-100030.txt` |
| Post-fix | **19** | **36** | 3 | `wpt-async-error-20260705-102638.txt` |

**Fixed by patch:** `queue-microtask-exceptions` window+worker 1/1 (was 0/1), `missing-timeout-setinterval` window 2/2 (was 1/2).

**Still failing:** `runtime-error-in-setTimeout` 0/2 (string `setTimeout` body — separate eval path), `promise-rejection-events` 29/43, cross-realm exception tests.

**Promise-job fixes (2026-07-05):** `promise-job-entry` **6/6**, `promise-job-entry-different-function-realm` **5/5**, `promise-job-incumbent` **11/11**.

## Open (post-fix)

1. **`SetContinuationPreservedEmbedderData`** — proper backup-incumbent via V8 embedder API (current heuristic uses sibling-parent / entry-realm fallbacks in `resolvePostMessageSourceFrame`).
2. **`unhandledrejection` partial** — event dispatch / microtask ordering vs browsers.
3. **Worker `.any.worker.html`** variants — still unstable; run window-only first.
4. **Cross-realm exception reporting** — `settimeout-cross-realm-callback-report-exception`.

## Run command

```bash
cd /Users/huydev/Desktop/velora
WPT_ADDR=http://localhost:8000 CDP_WS=ws://127.0.0.1:9223 CONCURRENCY=1 \
  ./code-check/tmp/wpt-async-error-run.sh
```

## Related

- [`2026-07-04-wpt-runner-setup-and-fixes.md`](2026-07-04-wpt-runner-setup-and-fixes.md)
- [`../architecture/wpt-url-category-status.md`](../architecture/wpt-url-category-status.md)