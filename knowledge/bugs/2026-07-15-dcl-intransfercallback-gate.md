# DCL stuck after parse: `canEval` blocked lifecycle inside HTTP `done_callback`

> **Symptoms:** `document.readyState` stays `loading`; title/body populated; CDP never emits `Page.domContentEventFired`. Bench subset (go.dev, netlify, …) timed out at 12s while Lightpanda passed in 1–3s.

## Root cause

Velora gated `Script.eval` on `HttpClient.inTransferCallback()`. `frameDoneCallback` runs inside that callback chain. Flow was:

```text
frameDoneCallback → staticScriptsDone() → evaluate()
  → defer head complete but canEval == false
  → return before tailHook → no documentIsLoaded
```

Lightpanda calls `staticScriptsDone()` and `evaluate()` from the same chain with **no** `inTransferCallback` gate. Defer/module heads must drain there so `tail_hook` fires DCL.

Deferred HTML parse (`scheduleDeferredDocumentParse`) was a secondary issue on some sites, but go.dev proved parse ran while lifecycle never completed.

## Fix

1. **`canEvalScriptsFromHttpCallback`**: only gate on `anyContextOnV8Stack()` (unsafe nested V8), not `inTransferCallback`. HttpClient reentrancy stays on `ready_queue`.
2. **`frameDoneCallback`**: synchronous HTML parse + `staticScriptsDone()` (Lightpanda `frameDoneCallback` parity).
3. **`doneCallback`**: `evaluate()` directly (LP), not only `scheduleDeferredEvaluate`.
4. **Lifecycle poll**: `queueDeferredEvaluateOnly(100)` when waiting on incomplete defer head; 2.5s `scheduleLifecycleEvalFallback`; raise `max_defer_evals_per_invoke` to 32.
5. **`cancelOwnedSchedulerWork`**: clear `deferred_evaluate_queued` when scheduler is reset.

## Verification

```bash
cd /Users/huydev/Desktop/velora && zig build -Doptimize=ReleaseSafe
# CDP: go.dev → DCL ~2.2s, readyState interactive
cd /Users/huydev/Desktop/velora-run && URLS=urls-dcl-fail.txt node test-100-urls.mjs
# 9/20 OK (was 6/20); remaining fails mostly Transport closed (GTM stack) or snapshot timeout
```

## Trade-off

Running defer/GTM scripts inside the document `done_callback` can trigger `Maximum call stack size exceeded` on heavy tag managers → process crash / Transport closed on some URLs. Watchdog + scheduler deferral for non-lifecycle eval may be needed as follow-up.