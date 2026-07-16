# Navigation timeouts: DCL never fires (`readyState` stuck `loading`)

> **Audience:** Velora engineers comparing site parity with Lightpanda / Chrome.  
> **Symptoms:** Puppeteer `waitUntil: "domcontentloaded"` times out; CDP never emits `Page.domContentEventFired`; `document.readyState` stays `"loading"` even when `title`/`body` already have content.

## Summary

Bench vs Lightpanda showed dozens of “Navigation timeout” / empty failures. Live CDP probes proved the document often **parsed** (title, body text) but never left `readyState=loading` and never fired DCL/load. Lightpanda completed the same URLs in 1–3s with `readyState` interactive/complete.

Root cause was **not** primarily “sites too slow.” It was ScriptManager lifecycle: Velora gated the entire `evaluate()` path on `canEvalScriptsFromHttpCallback()` / early returns, so **`tailHook` → `documentIsLoaded` (DCL) was skipped**, while incomplete script-slice chains never resumed. Lightpanda’s `evaluate()` always runs under one `is_evaluating` window and **always** reaches `tail_hook` once parse is done and defer scripts are finished.

## Problem

| Observation | Meaning |
|-------------|---------|
| `title` set, `bodyLen > 0`, `rs: loading` for 8–12s | HTML parse ran; lifecycle incomplete |
| No `Page.domContentEventFired` | `documentIsLoaded` / notification never ran |
| Lightpanda OK on same URL | Content is reachable; host bug |
| Puppeteer timeout ~5s | Waiting for DCL event that never comes |

Secondary bench noise: hard-reset after every fail produced `Navigating frame was detached` / `Target closed` — harness artifact, not the DCL root cause.

## Root Cause

### 1. `canEval` gated whole `evaluate()` including DCL

`canEvalScriptsFromHttpCallback()` (no nested V8 / curl transfer callback) is correct for **running script bodies** (V8 `IsOnCentralStack`). Applying it as a **function-level early return** meant:

```text
staticScriptsDone → evaluate() → !canEval → queue deferred / return
// never reaches tailHook → readyState stays loading
```

Lightpanda has **no** such gate on `evaluate()`; it always drains ready/defer queues and calls `tail_hook`.

### 2. One-script slice chain could stall

An earlier Velora path used `evaluateOneScript` + scheduled slices for CDP interleaving. If the chain broke mid-way (incomplete head, scheduler suppressed, dropped pending), **no DCL**. Lightpanda calls full `evaluate()` from `staticScriptsDone`.

### 3. Ordered async drain stuck on module imports

`async_scripts` holds both classic `async` scripts and ES module fetches. Treating a non-complete **import** as the ordered head blocked draining classic async and deferred lifecycle progress.

## Solution (bugfix only)

### ScriptManagerBase.zig (evaluate / DCL)

1. **`staticScriptsDone` → full `evaluate()`** (same as LP).
2. **`evaluate()` structure**: single `is_evaluating` + `endEvaluationWindow`; loop ready → frame-async → defer; then **`tail_hook`** when parse done and defer finished.
3. **`canEval` only around `Script.eval`**, not around DCL.
4. **`doneCallback`**: set `complete = true` **before** deliverable checks; always schedule resume.
5. **`deliverableFrameScript`**: remove `navigationCritical` gate (it dropped done during commit).
6. **Frame script `errorCallback`**: schedule deferred evaluate after remove (do not leave incomplete heads).
7. Bound evaluate pending-loop (64 passes) to avoid freezes.

### Frame.zig (parse → scripts)

8. After deferred HTML parse completes, call **`staticScriptsDone()` synchronously** (Lightpanda), instead of `scheduleDeferredStaticScriptsDone` + hope the next hop is pumped. Missing that hop left GitHub/DDG/eBay with parse done but **zero** `executing script` and no DCL.

### eBay hung module eval (follow-up)

`ebay.com` still parsed and ran classic scripts, then spun forever inside a
`type=module` bundle (`discoveryplatformweb/*.js`) with **no** `waitForImport`
timeout (hang was pure V8, not HTTP). Fixes:

1. **`waitForImport`**: re-lookup map entry each tick (Lightpanda); 3s fail-fast; mark `.err`.
2. **Script eval watchdog thread**: `TerminateExecution` after 2.5s (module) / 8s (remote classic).
3. **After watchdog**: drop remaining incomplete defer heads and still fire DCL so CDP/`readyState` recover.

Architecture kept: deferred HTML parse off HTTP doneCallback, V8 kExplicit, curl reentrancy demotion, antidetect.

## Verification

```bash
cd /Users/huydev/Desktop/velora && zig build -Doptimize=ReleaseSafe
# CDP: example.com, duckduckgo.com, github.com, ebay.com → readyState interactive|complete + DCL
```

## Lessons

- **Lifecycle events (DCL/load) must not share the same gate as “is it safe to run arbitrary JS now.”**
- When diverging from Lightpanda ScriptManager for Velora-only safety, gate the **eval call site**, not the **document state machine**.
- Site-bench “timeout” often means **missing CDP lifecycle**, not network RTT.
