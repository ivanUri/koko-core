# Cancel-on-nav ownership model

## Goal

Root re-navigation must never leave **document-owned** network, scheduler, or
parser work running against a freed or draining page. Fixes for tinhte.vn (and
similar heavy sites) are expressed as this contract, not as one-off guards.

## Ownership

| Work | Owner key | Abort / cancel path |
|------|-----------|---------------------|
| Document navigation | `attribution_frame` (= Frame) | `protect_from_abort` until commit; `.full` on discard |
| Script / image / CSS | `attribution_frame` | `abortTransfersAttributedTo` on outgoing abort |
| Fetch / XHR | `attribution_frame` via `Execution.attributionFrame()` | same; `protect_from_abort` only for batchexecute |
| sendBeacon | frame + `keepalive=true` | skips normal abort; must not use page arena after unload |
| Worker script load | parent document frame | aborted with parent re-nav |
| Deferred HTML parse / script slices / timer pumps | Frame scheduler | `cancelOwnedSchedulerWork` / `prepareForOutgoingAbort` |
| document.write stream | Document | `cancelStreamingParser` |

## Sequence (root re-nav)

```
Page.navigate
  → Session.initiateRootNavigation
    → abortOutgoingSubresources(active)
         1. prepareForOutgoingAbort   // draining + scheduler reset + IO/RTC teardown
         2. abortTransfersAttributedTo(frame)
         3. http tick(0)              // finish kill callbacks before script arena free
         4. script_manager.reset
         5. recurse child frames
    → allocate pending Page, start document transfer
  → (headers) commitPendingPage
         destroy old Page only after network/scripts for it are inert
```

## Rules for new code

1. **Every** `HttpClient.request` / `syncRequest` for a subresource must set
   `attribution_frame` (Debug panics via `ensureRequestAttribution` if missing).
   Prefer `exec.attributionFrame()` or the owning `*Frame`. Copy attribution
   through layer re-issues (e.g. robots.txt fetch).
2. Document-owned scheduler work: use `Frame.runOwnedSchedulerOne` /
   `runOwnedScheduler` / `canRunOwnedScheduler`. Draining/dead flushes the queue
   (`cancelOwnedSchedulerWork`).
3. **Deferred document parse** sets `_document_parse_active`. While set,
   `pollCdpDuringLongWork` is a no-op so `Page.navigate` cannot tear down the
   realm mid-html5ever (null createElement → tree-builder corruption). CDP is
   serviced again after parse returns.
4. Do not run worker message pumps / extra macrotasks from inside `Script.eval`
   or nested V8 (`is_evaluating`, `call_depth`, `anyContextOnV8Stack`) — defer
   with `scheduleDeferredMacrotaskPump` (V8 `IsOnCentralStack`).
5. Prefer TaskOwner epoch checks for async JS delivery (MO, IO, fetch resolve);
   prefer attribution + kill for curl callbacks (object may be freed).

## Verification (tinhte re-nav)

```bash
# capture with stderr
DEMO_PAGES=30 node tinhte-crash-capture.mjs   # 30/30, exit 0
# SDK Browser.launch
# 20/20 domcontentloaded renav
```

## Related

- `knowledge/bugs/2026-07-14-tinhte-renavigate-lifecycle-races.md`
- `src/runtime/RealmLifecycleKernel.zig`
- `Frame.prepareForOutgoingAbort`, `HttpClient.ensureRequestAttribution`
