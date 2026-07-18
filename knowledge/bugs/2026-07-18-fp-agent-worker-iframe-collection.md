# Fingerprint playground: worker bootstrap, scheduler UAF, collection timeout

> **Audience:** Velora engineers fixing Fingerprint Pro agent collection under concurrent Worker + about:blank iframe + OfflineAudio.  
> **Sites:** `demo.fingerprint.com/playground` (repro).

## Summary

Next App Router CSR reaches `window.next.router`, and the Fingerprint agent loads (`…/web/v4/…` + `…/e?region=us` both 200). For a long time identify still failed with **Client timeout**, and probes often reported CDP **`[HANG]`**.

Three core defects stacked:

1. **Worker classic blob** mid-eval `postMessage([2])` entered the parent `Local.Scope` → `Script::Run` null / empty TryCatch.
2. **Nested `runMicrotasks` re-entry** performed multi-pass checkpoints while `checkpoint_active` → storms + instability.
3. **`Scheduler.runOneFromQueue` SIGSEGV** — `PriorityQueue.peek` on a freed queue after about:blank iframe / context teardown during `runMacrotasks` (React removes agent iframes ~100ms after append).

After the fixes below: **no segfault**, CDP stays responsive for full probe windows, worker mid-eval posts succeed, OfflineAudio completes. **Identify POST / visitor UI still missing** (Client timeout) — collection not finished.

## Problem

| Stage | Before | After (2026-07-18 evening) |
|-------|--------|----------------------------|
| Next CSR / router | OK | OK |
| Agent script + config GET | 200 | 200 |
| Worker blob 1637B | empty `JsException` | `postMessage mid-initial-eval` + flush OK |
| OfflineAudio startRendering | often mid-crash | flush.resolved OK (solo repro OK) |
| Engine stability | SIGSEGV in `Scheduler.peek` / CDP hang | **stable** full 30s poll |
| Identify POST / visitorId | missing | **still missing** → Client timeout |

## Root Cause

### Worker mid-eval parent Local

Agent blob ends with `postMessage([2])` during initial `Script::Run`. Marking `_bootstrap_complete` early made `receiveMessage` clone into the **parent** Local while the worker stack was live → empty TryCatch / `JsException`.

### Nested microtask re-entry

While `checkpoint_active`, nested `runMicrotasks` used to run multi-pass `PerformCheckpoint` (host-gated or not). Under agent bootstrap that multiplied with yb drains and timer callbacks → reentry spam and UAF risk.

### Scheduler UAF (crash stack)

```
Scheduler.runOneFromQueue (peek)
  ← Scheduler.run
  ← Frame.runOwnedScheduler
  ← Env.runMacrotasks
  ← Env.pumpSchedulerTasks
  ← Env.runMicrotasks
  ← Browser.runMacrotasksCdpSlice
```

`Env.destroyContext` **swap-removes** contexts and `deinit`s their schedulers. `runMacrotasks` iterated the live `contexts[]` array and could **run a freed PriorityQueue** when agent about:blank iframes were torn down mid-pump. `Scheduler.reset` did not stop an in-flight `run` loop.

## Solution (applied)

| Area | Change |
|------|--------|
| `Worker._initial_eval_active` | Queue mid-eval posts; clone to parent only on flush |
| `Worker.loadInitialScript` | `cancelTerminate` before eval; step markers for empty TryCatch |
| `Caller` worker path | Local-only microtask checkpoint at `call_depth==0` (no all-realm `runMicrotasks`) |
| `Env` nested worker shims | Skip eval-based WPT shims when `nested_v8` |
| `websocket_constructor_shim.js` | Early return if no `WebSocket` |
| `Env.runMicrotasks` re-entry | **Only** `checkpoint_pending = true` (no nested PerformCheckpoint) |
| `Scheduler._generation` | Bump on `reset`/`deinit`; `run`/`runOne` stop after current callback |
| `Env.runMacrotasks` / `runOneMacrotaskRound` | **Snapshot** context pointers; skip unregistered contexts |

## Verification

```bash
cd /Users/huydev/Desktop/velora
zig build -Dstrip=false   # stack traces for remaining crashes
node scripts/cdp-fingerprint-playground-probe.mjs --max-sec 35
```

Expect: no `Segmentation fault`, logs include `worker postMessage mid-initial-eval` and `OfflineAudioContext.flush.resolved`, full CDP polls complete. Still: `FingerprintError: Client timeout` and no identify POST.

## Follow-ups (iframe init still open)

### Confirmed agent signal

```
Error: Iframe initialization timed out, debugCounters: {"adb":0,"crs":1,"asib":0}
```

- `adb=0` — `document.body` was ready.
- `crs=1` — readyState poll ran once (not evidence of failure by itself; success path also ends at `crs=1` when onload already set `X=true`).
- `asib=0` — never entered the post-load `contentDocument.body` wait → **stuck on the load Promise**.

### Instrumentation (2026-07-18 late)

JS wrap of `appendChild` + `iframe.onload` on the live playground:

1. Agent `about:blank` iframe: onload wrapper runs **twice** with `prev-ok` during appendChild (`cw=true`, `rs=complete`).
2. Sentinel `Promise.resolve().then` / `queueMicrotask` scheduled around append run **~10ms after** append returns — not inside append’s native drain.
3. Isolated / post-settle agent-pattern iframe completes in ~50ms on the same engine.
4. Concurrent worker+OfflineAudio+iframe HTML fixture also succeeds.
5. Failure is **specific to agent script + Next hydration timing**, not Offline audio alone.

So Zig *does* invoke the property onload (agent resolve should run), yet the shared `ip` Promise still looks **pending** to `Promise.race` for 2s. Next investigations:

1. Whether agent `resolve` is a true V8 Promise resolve under re-entrancy (or a different thenable).
2. Whether `ip` is replaced/nullified between init and `Vu()`.
3. Whether pure-JS reactions land on a microtask queue that only drains on CDP `awaitPromise` (success path) but not after agent classic eval.
4. Force post-append `setTimeout(0)` macrotask that re-checks pending agent iframe state / extra `PerformCheckpoint` on the parent context only.

## Iframe settle fix (2026-07-18 evening)

**Root cause:** nested `pumpDueTimersNow` during `appendChild` consumed delay-0 deferred about:blank onload **before** the agent `readyState` poll, stranding shared `ip` (`crs=1`, `asib=0`).

**Core changes:**
- `Frame.pumpSameTurnPromiseContinuations` / `drainMicrotasksAfterDomInsertion`: never run scheduler while nested on V8 stack
- `Frame.iframeCompletedLoading`: schedule deferred load only (no nested timer pump)
- `Env.drainFingerprintYbMicrotasks`: nested-aware (schedule pumps, do not consume delay-0 load)
- `Frame.settleIframePromisesNow` + sparse `scheduleIframePromiseSettle` (0/10/50 ms)

**Verified:** identify `POST …/DBqbMN7zXxwl4Ei8?region=us&ci=js/4.1.2` often succeeds; worker mid-eval + OfflineAudio still OK.

**Still open:** playground UI bodyLen~248 (Next BAILOUT shell, no visitor chrome); POST not 100% of cold starts; strip `fp iframe *` warn logs later.

## Lessons

- Never enter the parent frame Local during worker classic eval.
- Nested microtask “fix everything” under `checkpoint_active` will hang or UAF; mark pending and let the outer loop continue.
- **Never iterate `Env.contexts` live across task callbacks that can `destroyContext`** — snapshot + generation-guard schedulers.
- Probe “hangs” with stripped binaries hide SIGSEGV; use `-Dstrip=false` and flush stderr on hard_limit.

## Fetch settle fix (2026-07-18 night)

**Root cause:** `Fetch.httpDoneCallback` called `releaseFetchResponse` and returned when `fetchJsUnavailable` was true, **without resolving or rejecting** the JS Promise. Short config/identify transfers that finished during realm init / mid-checkpoint left `fetch()` pending forever.

**Fix (`Fetch.zig`):**
- `settleFetchDone` + `scheduleDeferredFetchDone` retry when JS is temporarily unenterable
- Prefer full wire `_buf` as `Response` bytes if stream enqueue was skipped while gated
- Cap deferred retries then reject rather than hang

**Verified on playground:**
- `bodyLen` ~6400+ (was ~248)
- Visible text: `Your Visitor ID is 40IVQ6rg…`, Smart signals, tables populated
- Identify POST + event POST + ampl-api complete

**Still open:** occasional metric.fingerprinthub.com fetch TypeErrors; config GET may still race; strip temporary fp iframe warn logs.

## Timer interval drain (same night)

Fingerprint agent `Fw`/`hl` use `setInterval(1)` as a job queue. After `Response.arrayBuffer` resolves inside a timer callback, pure-JS `promise.then` reactions must run on that turn.

**Change (`Timers.zig`):** after each timer invoke, `drainAllRealmMicrotasks` + `performMicrotaskCheckpointFp` before `runMicrotasks(.timer_callback)`.

## End-to-end status

| Signal | Status |
|--------|--------|
| Identify POST | Usually yes |
| Visitor UI (`Your Visitor ID is …`) | **Proven** (bodyLen ~6500, tables ~34k) on some cold starts; still flaky without extra microtask hops |
| Config GET `…/e?region=us` | Often still pending in JS (HTTP 96B ok via curl) — deferred fetch settle may not always run |
| metric.fingerprinthub.com | TypeError (non-blocking; fallback `/api/event` works) |

Primary remaining races: config fetch settle reliability; post-`arrayBuffer` agent queue settlement under load.

## HAR comparison (Chrome success vs Velora)

Source: `/Users/huydev/Desktop/demo.fingerprint.com.har` (WebInspector).

Chrome pipeline (relative to agent script):
1. `GET …/web/v4/…` agent (~185KB)
2. `+452ms GET …/e?region=us` config 96B text/plain **completes**
3. `+1321ms POST …?ci=js/4.1.2` identify, body ~9KB compressed, response JSON with `visitor_id`
4. `+1911ms POST /api/event/v4/{event_id}` → full smart-signals JSON (~5KB) — **feeds playground UI**
5. `+4349ms POST /ampl-api/2/httpapi`

Velora today (typical cold start without CDP hooks):
- Agent + identify POST often 200 with `visitor_id` on wire
- Config GET frequently `loadingFailed: Shutdown` / JS `fetch` never settles
- **No `/api/event`** → React stays on "Running Device Intelligence", no "Your Visitor ID"
- Occasional success when fetch body methods get an extra async hop (CDP instrumentation) — proves pipeline *can* complete

Root themes: (1) fetch must not abort/hang on temporary `fetchJsUnavailable`; (2) do not re-enter agent JS from HTTP done_callback; (3) settle identify → agent get() → `/api/event` before UI can show Visitor ID.

## Config GET Shutdown (2026-07-18 late)

### Chrome vs Velora

Chrome (Playwright): agent → config 200 (96B) → identify 200 → `/api/event` 200 → **Visitor ID ~4s**.

Velora before this fix: config GET often CDP `loadingFailed: Shutdown` at start; identify sometimes still completed; UI stuck bodyLen~248.

### Root causes fixed

1. **`fetchSignalAborted` treated temporary `canEnterJs==false` as abort** → header_callback returned false → transfer abort. Fixed: only stale/dead realm or real AbortSignal counts as aborted.

2. **`abortFrame` on scheduleNavigation killed `.fetch`** (only skipped XHR). Added `skip_fetch` alongside `skip_xhr`; skip entire pre-abort for synthetic `about:blank`.

3. **`Worker.deinit` used `abortFrame(worker_id, .full)`** which killed in-flight `.fetch` sharing the synthetic worker `frame_id` (Fingerprint collection worker teardown raced config GET). Now `.full` + `skip_fetch` + `skip_xhr`; worker script response still aborted explicitly.

4. **Fetch resolve always forced `checkpoint_active`** so promise reactions never drained on the done path. Only suppress when already nested; always schedule deferred continue cascade.

5. **`httpShutdownCallback`** now rejects the JS Promise (or defers reject) instead of silent drop.

### Verified after fix

- Config GET **OK len=96** consistently (no Shutdown on `/e?region=us`).
- Identify POST **200** with `visitor_id` in JSON body.
- **Still open:** no `/api/event` and no Visitor UI (bodyLen~248) after identify settles — post-`get()` / React continuation race.

### Files

- `src/core/webapi/net/Fetch.zig`
- `src/core/browser/HttpClient.zig` (`AbortOpts.skip_fetch`)
- `src/core/browser/Frame.zig` (scheduleNavigation)
- `src/core/webapi/Worker.zig` (deinit abort opts)

## Post-identify /api/event (2026-07-18 night)

### Status after config fix

| Step | Status |
|------|--------|
| Config GET `/e?region=us` | **OK 96B** (no Shutdown) |
| Identify POST `ci=js/4.1.2` | **OK**, body includes `visitor_id` |
| `Response.arrayBuffer` after identify | Completes (`abDone=1`) |
| Shared iframe agent pattern (solo repro) | **Works** in ~100–350ms on playground |
| Agent live `ip` during collection | Still races `rX=2e3` with `crs=1,asib=0` |
| `/api/event` + Visitor UI | **Still missing** (bodyLen 248, Client timeout) |

### Diagnosis

1. Agent shared-iframe init races against **2s** (`const rX=2e3`) via `Promise.race([ip, kc(rX)])`.
2. Solo agent-identical iframe on playground succeeds (readyState complete, body present).
3. Live agent still emits many `Iframe initialization timed out {adb:0,crs:1,asib:0}` then `Client timeout`.
4. `asib=0` on timeout means load Promise never settled (not that body was missing after await — success path can also leave asib=0 when body is immediately ready).
5. `setInterval(1)` re-arm used to demote to **low_priority** (starvation risk); fixed to keep page timers high-priority. Temporary `validateJsEntry` fail no longer destroys intervals.
6. Dense iframe settle schedules + sync onload on fingerprint.com applied; not yet sufficient for full get()→event.

### Applied this pass

- `Frame.settleIframePromisesNow` / `scheduleIframePromiseSettle` denser + timer pump + clear suppression
- Fingerprint about:blank: sync property onload + settle (not only deferred)
- `Timers`: do not destroy interval on temporary JS gate
- `Scheduler`: re-arm `setInterval`/`setTimeout` on high_priority
- `ScriptManagerBase`: after FP agent classic script, full timer+settle drainage

### Still open

get() does not settle → no `/api/event` → React shell bodyLen~248. Next: why live agent `ip` await differs from solo identical pattern under concurrent OfflineAudio/worker; or post-identify Fw queue not completing after identify body is parsed.
