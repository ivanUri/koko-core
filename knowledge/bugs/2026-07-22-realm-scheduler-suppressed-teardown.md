# realm.scheduler_suppressed: Teardown vs Runaway

> **Date:** 2026-07-22 · **Area:** realm lifecycle, microtask circuit breaker, signup.live.com · **Status:** Fixed

## Summary

`ERROR frame : realm.scheduler_suppressed` appeared on almost every root navigation (including Hotmail `signup.live.com`). That log was treated as a load failure, but **most calls were intentional teardown containment**, not microtask runaway.

Fix: `suppressScheduler` now takes a reason:

| Reason | Caller | Log level |
|--------|--------|-----------|
| `.teardown` | Session re-nav / clean-slate / commit | Debug only (no ERROR) |
| `.runaway` | Env microtask checkpoint budget | `ERROR realm.scheduler_suppressed` |

Also: `markRealmReadyForPublication` **clears** suppression so a published document never inherits a stuck circuit breaker (Fluent SPA needs microtask checkpoints to hydrate).

## Problem

Hotmail probe / clean-slate `about:blank` → `signup.live.com`:

```
ERROR frame : realm.scheduler_suppressed
  realm_state = initializing | draining
```

Then openSignup reloaded 3× and sometimes reported `emailInput=false`.

Session had been calling the same `suppressScheduler()` used by the **runaway microtask circuit breaker**, which always `log.err`s. Teardown suppress is expected every navigation.

## Solution

### `Frame.suppressScheduler(reason)`

```zig
pub const SuppressReason = enum { teardown, runaway };
```

- **teardown**: set flag; debug log only in Debug builds  
- **runaway**: set flag + `RealmLifecycleKernel.traceSchedulerSuppressed` (ERROR)

### Call sites

- `Session.zig` (iframe/popup re-nav, clean-slate, commitPendingPage): `.teardown`
- `Env.zig` (MAX_CHECKPOINT_PASSES): `.runaway`
- `markRealmReadyForPublication`: clear `_scheduler_suppressed`

## Verification

```bash
zig build
# navigate about:blank → signup.live.com
# ERROR_suppress_count 0
# PAGE email:true title:"Create your Microsoft account"
node scripts/hotmail-register-velora.mjs --profile chrome-local-huys-macbook-pro --probe-email-step
```

## Files

- `src/core/browser/Frame.zig`
- `src/core/browser/Session.zig`
- `src/core/js/Env.zig`
