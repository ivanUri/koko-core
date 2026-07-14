# Re-navigate crash: reentrant CDP during `commitPendingPage`

## Summary

Multi-page CDP flows (`example.com` → Wikipedia → HN) intermittently crashed Velora with `Transport closed` / `SIGTRAP` / segfault. The root cause was **reentrant inbound CDP** processed from HTTP callbacks while `commitPendingPage` or `initiateRootNavigation` was tearing down the active page.

## Problem

- SDK `demo.mjs` and `stress-renavigate.mjs` failed on the 2nd+ `Page.navigate`.
- Velora process exited (`SIGTRAP` / segfault); CDP WebSocket closed → SDK reported `Transport closed`.
- Failure was intermittent (~40–60% on rapid re-nav) and site-agnostic.

## Root Cause

`HttpClient.serviceInboundCdpIfReadable()` drains the CDP socket from inside curl/HTTP callbacks (`frameHeaderDoneCallback`, `frameDoneCallback`, script loads). That can run **`Page.navigate` reentrantly** while:

1. `frameHeaderDoneCallback` is in `commitPendingPage`, or
2. `initiateRootNavigation` is discarding a pending page.

`Env.blocksInboundCdp()` only blocked during `is_evaluating` scripts — not during navigation teardown. Concurrent `Page.navigate` then raced `discardPendingPage` / `commitPendingPage` → UAF / assert trap.

## Fix

1. **Profile bootstrap UAF** (`ProfileSnapshot.catalogFingerprintPath`): stopped `allocator.free(root)` on `BrowserRoot.get()` — the cached install root must never be freed by callers.

2. **Reentrant CDP during HTTP callbacks**:
   - `Session`: `_navigation_critical_depth` with `enterNavigationCritical` / `leaveNavigationCritical`; wrap `initiateRootNavigation` and `commitPendingPage`.
   - `HttpClient`: `_transfer_callback_depth` around header/data/done callbacks; `serviceInboundCdpIfReadable` returns when `performing`, `inTransferCallback()`, or `session.navigationCritical()`.
   - `Env.blocksInboundCdp()`: true when `navigationCritical()`.
   - `Env` microtask checkpoint loop: skip contexts while `navigationCritical()`.
   - `ScriptManagerBase`: defer `evaluate` / async script drain while `navigationCritical()`; `deliverableFrameScript` returns false during commit (prevents script `eval` from HTTP `doneCallback` racing `destroyPage`).

Inbound CDP, microtask checkpoints, and script eval are deferred until the critical section ends.

## Second root cause: nested `pumpDueTimersNow` (V8 `IsOnCentralStack`)

After the CDP reentrancy gates, `demo.mjs` still crashed on the 2nd navigation to Wikipedia with:

```
Fatal error: Check failed: IsOnCentralStack().
```

Stack: `HttpCtx.doneCallback` → `Script.eval` → `appendChild` → `setTimeout(≤10)` → `Timers.schedule` → `Frame.pumpDueTimersNow(0)` → `ScheduleCallback.run` → V8 fatal.

`Timers.schedule` coerces nested `setTimeout(≤10ms)` to delay 0 and synchronously pumps due timers so Fingerprint `yb()` readyState polls resolve same-turn. That is unsafe on heavy sites (Wikipedia): timer callbacks must run on V8's **central stack**, not from nested HTML-parse / HTTP-callback JS.

### Additional fix

- `Timers.zig`: only call `pumpDueTimersNow` synchronously on `fingerprint.com`; other origins defer via `scheduleDeferredMacrotaskPump(0)`.
- `Frame.pumpDueTimersNow`: if `call_depth > 0` and not fingerprint, defer instead of running timer callbacks inline.

## Verification

```bash
cd /Users/huydev/Desktop/velora
zig build install -Doptimize=ReleaseSafe
node code-check/site-stability/stress-renavigate.mjs "https://en.wikipedia.org/wiki/Earth" --cycles 20
cd ../velora-run && node demo.mjs   # 100/100 ok
VELORA_PORT=<port> CYCLES=5 node scripts/repro-multi-nav.mjs
```

## Files

- `src/core/browser/Session.zig` — navigation critical section
- `src/core/js/Env.zig` — `blocksInboundCdp` gate
- `src/core/browser/HttpClient.zig` — `serviceInboundCdpIfReadable` (unchanged call site; now gated)
- `src/core/browser/ScriptManagerBase.zig` — defer script eval during navigation critical
- `src/core/webapi/Timers.zig` — restrict sync timer pump to fingerprint.com
- `src/core/browser/Frame.zig` — `pumpDueTimersNow` central-stack guard