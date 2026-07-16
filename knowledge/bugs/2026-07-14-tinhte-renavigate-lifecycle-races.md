# Tinhte.vn re-navigate: nested V8 + lifecycle teardown races

## Summary

Rapid re-navigation to `https://tinhte.vn/` fails reliably after **~10 successful loads** (`10/100` in `demo.mjs`, `10/15` in shorter probes). Wikipedia-style re-nav (v1.0.2 CDP gates) is fixed; tinhte exposes **additional** races tied to heavy ad/analytics scripts, WebSockets, IntersectionObserver, and `document.write` during SPA-style re-nav.

Velora then crashes with `Segmentation fault at address 0xaaaaaaaaaaaaaaaa` (freed-memory UAF) while the outgoing realm is `draining` at `epoch=1`.

## Root causes found

### 1. `should_pump` typo — timers during HTML parse (critical)

`ScriptManagerBase` defer after script eval used:

```zig
const should_pump = !frame.isDocumentParsing() or !Frame.isGoogleKnitsailHost(frame.url);
```

The negation on `isGoogleKnitsailHost` inverted the intent: **every non-Google site pumped `scheduler.run()` during parser-inserted script eval**, causing V8 `IsOnCentralStack` fatals and intermittent early crashes.

**Fix:** `or Frame.isGoogleKnitsailHost(frame.url)` (no negation).

### 2. Reentrant CDP from `syncRequest`

While a parser-inserted script blocked in `syncRequest`, inbound CDP (`Page.navigate`) was still drained via `blocking_read`, calling `Frame.init` / V8 context creation on a nested stack.

**Fix:** Gate `syncRequest` CDP reads with `Env.blocksInboundCdp()`; extend that gate with `anyContextOnV8Stack()`.

### 3. XHR / WebSocket / DOM timer pumps on nested stacks

- XHR `httpHeaderDoneCallback` dispatched `readystatechange` during curl `perform` while `call_depth > 0`.
- `pumpSameTurnPromiseContinuations` called `scheduler.runOne()` after `insertBefore` without central-stack entry.
- `pumpSchedulerTasks` from `syncRequest` ran while V8 nested.

**Fixes:** `canDispatchXhrEvents` (`strict_active` + `call_depth == 0`), defer nested timer pumps, skip scheduler pump when any context is on V8 stack.

### 4. IntersectionObserver + document.write on re-nav

- IO `disconnect()` did not always `unregisterIntersectionObserver` (stale list entries).
- `document.write` streaming parser kept running on draining realms → html5ever panic → segfault.

**Fixes:** IO disconnect always unregisters; `prepareForOutgoingAbort` calls `document.cancelStreamingParser()`; block `document.write` when realm not active; parser callbacks no-op when realm not active.

### 5. Stale `Runner.frame` → RTC UAF on teardown (nav ~11)

`Runner._tick` captured `frame` at tick start, then ran macrotasks / `http_client.tick` where
`commitPendingPage` could swap active pages. Post-macrotask `frame.drainRtcEvents()` still
iterated `_rtc_peer_connections` on the **outgoing** page whose arena was freed → segfault
`0xaaaaaaaaaaaaaaaa` in `Frame.drainRtcEvents` (confirmed via lldb Debug).

**Fixes:**
- Refresh `self.frame = session.pendingOrCurrentFrame()` before `drainRtcEvents` and load-idle checks.
- `Frame.drainRtcEvents`: no-op when `realm_state` is `.draining` / `.dead`.
- `Frame.prepareForOutgoingAbort`: call `closeRtcPeerConnections()` early on outgoing nav.

### 6. Inspector context group reset during pending-root commit — `Promise was collected`

Single navigation to tinhte.vn (and any pending-root swap) could fail CDP with
`ProtocolError: Promise was collected` on `Runtime.evaluate` / `awaitPromise` while the
document body was still downloading. Velora did not crash (`exit=0`); V8 Inspector discarded
in-flight promise handlers.

**Root cause:** `Session.commitPendingPage` step 1 dispatches `frame_remove` →
`page.zig::frameRemove` → `resetContextGroup()`. That nukes the entire inspector context
group. The **replacement** pending page already has a live main-world V8 context in the same
group (scripts run during body download), but `contextCreated` was deferred until body
complete (`flushPendingFrameNavigatedObservers`). Nuclear reset discarded inspector promises
on the live replacement context.

**Architectural fix (Chrome-aligned swap, not a promise suppress hack):**

1. **`frameRemove`:** When `session.pendingPage() != null` (pending-root commit), skip
   `resetContextGroup()`. Call `Env.notifyInspectorContextDestroyed` on the outgoing main
   context only; isolated worlds still `removeContext()` (per-context `contextDestroyed`).
2. **`frameCreated` (in_commit):** Publish `Runtime.executionContextCreated` for the new main
   frame + isolated worlds at header time via shared `publishInspectorExecutionContexts`.
3. **`frameNavigated`:** Skip duplicate `contextCreated` when `Frame._inspector_context_published`.
4. **`Context` / `Env`:** Track `_inspector_destroyed_notified` so late `destroyContext` on the
   outgoing page does not double-notify the inspector.

**Verify:**

```bash
cd /Users/huydev/Desktop/velora-run
VELORA_BIN=~/Desktop/velora/zig-out/bin/velora node tinhte-once-probe.mjs
# OK title=Tinhte.vn - ...
```

CDP trace shows `executionContextDestroyed` + `executionContextCreated` at `Page.navigate` ack,
then `Runtime.evaluate` succeeds.

### 7. Fetch/XHR missing `attribution_frame` — header UAF on re-nav (2026-07-14 session 2)

After lifecycle gates above, stress still crashed around nav 2–11:

```
Segmentation fault at address 0x223a226c72752293
Fetch.zig:219 in httpHeaderDoneCallback → isTaskOwnerStale
HttpClient headerDoneCallback ← curl_multi_perform
```

**Root cause:** `abortTransfersAttributedTo` only kills transfers with
`params.attribution_frame == frame` (or `ctx == frame`). Scripts/images set
`attribution_frame`; **Fetch and XHR did not**. Fallback `ctx == frame` is false
because `ctx` is `*Fetch` / `*XMLHttpRequest`. Outgoing renav therefore left
analytics/ad fetches alive; after page arena free (or during teardown races),
`header_callback` walked a freed `Fetch._exec`.

Additionally `abortOutgoingSubresources` used `{ .skip_xhr = true }`, so even
attributed XHR would have been skipped. `protect_from_abort` already covers
batchexecute without a blanket skip.

**Fixes:**
- `Fetch.zig` / `XMLHttpRequest.zig`: set `attribution_frame` to the owning frame.
- `Session.abortOutgoingSubresources`: abort with default opts (no `skip_xhr`).
- `RealmLifecycleKernel`: gate hot microtask reentry/dead-realm traces behind
  `trace_enabled` (info/error spam was producing multi‑GB logs and starving the event loop).

### 8. Deferred HTML parse vs CDP re-nav — `Frame.appendNew` UAF (session 2 cont.)

After (7), SDK `demo.mjs` still died around nav 2–11:

```
Segmentation fault at address 0xaaaaaaaaaaaaaaaa
Frame.appendNew ← Parser._appendCallback ← html5ever
← DeferDocumentParseCallback.run ← Scheduler.runOne
← Runner.drainDeferredDocumentParse
```

**Root cause:** Body-complete schedules `DeferDocumentParseCallback`. While
html5ever walks the tree, `pollCdpDuringLongWork` can process `Page.navigate`.
Outgoing abort did not clear the frame scheduler, and parser append/create
did not re-check realm after the CDP poll — so parse continued into a
draining/freed frame.

**Fixes:**
- `prepareForOutgoingAbort`: `js.scheduler.reset()` + clear `_document_parse_scheduled`.
- `DeferDocumentParseCallback`: wrap parse in `enterNavigationCritical`; re-check
  `navDeliverable` before post-parse script/load work.
- `Parser` create/append: re-check `_realm_state == .active` after `pollCdpDuringLongWork`.
- `Frame.appendNew`: no-op when realm not active.

## Remaining / non-fatal issues

- Site JS: `ReferenceError: IDBIndex is not defined` (IndexedDB incomplete) breaks
  firebase-analytics; other inline scripts throw `JsException`.
- CLI `velora fetch --dump html` can still return only `<!DOCTYPE html>` while
  CDP load works — separate dump/timing path.
- Nested `IsOnCentralStack` on deferred async scripts is largely gated; re-check
  under Debug if new sites regress.

## Verification

```bash
cd /Users/huydev/Desktop/velora
zig build -Doptimize=ReleaseSafe -Dstrip=false
cd ../velora-run
DEMO_PAGES=30 VELORA_BIN=~/Desktop/velora/zig-out/bin/velora node demo.mjs
# 30/30 ok (×3 runs)

DEMO_PAGES=50 node tinhte-crash-capture.mjs
# done ok=50/50, velora exit=0, titles present
```

## Files touched

- `src/core/browser/ScriptManagerBase.zig` — `should_pump` logic
- `src/core/js/Env.zig` — `anyContextOnV8Stack`, `blocksInboundCdp`, `contextBlocksTimerPump`, `pumpSchedulerTasks`
- `src/core/browser/HttpClient.zig` — `syncRequest` CDP gate
- `src/core/webapi/net/XMLHttpRequest.zig` — `canDispatchXhrEvents` + `attribution_frame`
- `src/core/webapi/net/Fetch.zig` — `attribution_frame` + safer header abort gate
- `src/core/webapi/net/WebSocket.zig` — poll depth + event guards
- `src/core/browser/Frame.zig` — parser cancel, RTC teardown, nested timer defer, scheduler reset on outgoing abort, deferred-parse nav critical
- `src/core/browser/Runner.zig` — refresh frame ptr after macrotasks before RTC drain
- `src/core/dom/Document.zig` — `cancelStreamingParser`, write guard
- `src/core/parser/Parser.zig` — inactive-realm guards after CDP poll
- `src/core/webapi/IntersectionObserver.zig` — disconnect unregister
- `src/protocols/cdp/domains/page.zig` — surgical inspector teardown + early `contextCreated`
- `src/core/js/Env.zig` — `notifyInspectorContextDestroyed`
- `src/core/js/Context.zig` — `_inspector_destroyed_notified`
- `src/core/browser/Session.zig` — outgoing abort includes XHR/fetch
- `src/runtime/RealmLifecycleKernel.zig` — gate hot microtask traces