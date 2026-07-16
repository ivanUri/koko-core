# SPA soft-nav: async chunk downloaded but never evaluated

> **Audience:** Velora engineers fixing Next/App Router client auth redirects and dynamic script inject.  
> **Sites:** `dovihome-sale.vercel.app` (and any SPA that injects classic `async` scripts after `fetch` / RSC).

## Summary

Unauthenticated visits to a Next App Router sale route stayed on a spinner under Velora even after bootstrap and RSC worked. Instrumentation showed `router.replace("/login")`, a successful `fetch` of `/login?_rsc=…`, and injection of the login chunk (`0n6l…js`, often a **cache hit**), but **no `executing script` for that chunk**. Lightpanda completed the same flow: password field and login UI.

The residual bug was not HTTP navigation (no 302) and not `document.currentScript` (already fixed). It was ScriptManager dropping or never resuming evaluation when an async classic script completed while curl/V8 was still nested. Lightpanda’s simpler pattern—`evaluate_pending` + move completed async scripts to `ready_scripts`—never loses that work.

## Problem

| Stage | Chrome / Lightpanda | Velora (before) |
|-------|---------------------|-----------------|
| Document | HTTP 200 `/m/sale` | same |
| Bootstrap | `window.next` + router | often OK after earlier fixes |
| Soft-nav | `replace("/login")` + RSC + login chunk eval | RSC 200 + chunk download; **no eval** |
| UI | login form / pathname `/login` | spinner, empty body, path stuck |

Probes: `scripts/cdp-dovi-login-verify.mjs`. Lightpanda harness: Desktop `lightpanda/check-redirect.js`.

## Root Cause

Velora correctly refuses to `Script.eval` on a nested V8 stack or inside a libcurl transfer callback (`canEvalScriptsFromHttpCallback` — needed for `IsOnCentralStack` / reentrancy). When the login chunk’s `doneCallback` ran in that unsafe window it:

1. Left the completed script in `async_scripts` (only drained if it was the **head** and `canEval` was true).
2. Called `scheduleDeferredEvaluate` — but `evaluate()` / `evaluatePendingWhenCentral` **returned without reschedule** when still unsafe or when `is_evaluating` was set.
3. Nested `evaluate()` during inject windows used bare `is_evaluating = was` restore with **no** “pending retry” (Lightpanda’s `evaluate_pending` + `endEvaluationWindow`).

So the chunk was complete forever and never ran. SPA soft-nav hung waiting on that module factory.

Lightpanda (`browser-lightpanda` `ScriptManagerBase`):

- On async complete: `async_scripts` → `ready_scripts`, then `evaluate()`.
- Nested `evaluate()`: `evaluate_pending = true`; `endEvaluationWindow` re-drains.

Velora must keep `canEval` (architecture differs: heavier antidetect + V8 central-stack constraints) but must **not drop** pending work.

## Solution

Surgical changes only (`src/core/browser/ScriptManagerBase.zig`, `ScriptManager.zig`):

1. **`evaluate_pending` + `endEvaluationWindow`** — nested/inject windows set pending; outer unlock retries (or schedules deferred eval).
2. **Frame `.async` `doneCallback`** — move to `ready_scripts` like `import_async` / Lightpanda (completion not blocked by incomplete head of `async_scripts`).
3. **`scheduleDeferredEvaluate` / `evaluatePendingWhenCentral`** — if still unsafe, set pending and queue (debounced via `deferred_evaluate_queued`; 1ms reschedule when still on nested stack to avoid 0-delay storms inside `runOwnedScheduler`).
4. Keep **`canEvalScriptsFromHttpCallback`** — do not eval scripts mid-transfer or mid-V8 callback.

After fix: `0n6l…js` logs `executing script`, login password field appears, spinner clears. Pathname may still lag `location` vs Lightpanda in some probes; functional auth UI is the primary pass criterion.

## Verification

```bash
cd /Users/huydev/Desktop/velora
zig build -Doptimize=ReleaseSafe
node scripts/cdp-dovi-login-verify.mjs   # expect password:true / EXIT 0
```

## Lessons

- **Never silent-drop deferred script eval** when a safety gate fails — reschedule or set a pending flag.
- **Completed async scripts belong on a ready queue** independent of in-flight downloads.
- Learning from Lightpanda should be **pattern-level** (pending + ready list), not a full architecture merge: Velora’s curl/V8 guards stay.
