# Re-navigate segfault: Page teardown ordering and frame_id collision

## Summary

BBC (and other heavy SPAs) crashed on the **second** `Page.navigate` with `RC.release on already-released NodeList` followed by segfault. Three independent core bugs contributed; all are site-agnostic.

## Root causes

### 1. Weak finalizers before identity invalidation (`Page.deinit`)

`frame.deinit()` → `destroyContext` → `pumpMessageLoop` ran **before** `FinalizerCallback.Identity.done = true`. V8 weak callbacks could `releaseRef` NodeList instances while the `force_deinit` sweep still held the same objects.

**Fix:** Invalidate all FC identities **before** `self.frame.deinit()` in `Page.deinit`.

### 2. Iterator dependent refcount (`NodeList` / `iterator.zig`)

Collection iterators `acquireRef` the parent `NodeList`. Unordered `force_deinit` could tear down the parent first; child iterator `deinit` then double-released the parent.

**Fix:** `NodeList.isLive()` / `Iterator.isLive()`; `iterator.zig` skips parent `releaseRef` when parent RC is already zero. `NodeList.Iterator.deinit` uses `releaseRef` not `deinit`.

### 3. `abortFrame(frame_id)` killed the new active page (`commitPendingPage`)

Pending and active root pages **reuse** `frame_id`. Destroying the old active frame called `abortFrame(self._frame_id)`, aborting in-flight transfers belonging to the **new** active page (same id, different `Frame*`).

**Fix:** `RequestParams.attribution_frame` + `HttpClient.abortTransfersAttributedTo(frame)`. Frame/script/image/link requests set attribution. `Frame.deinit` and `abortOutgoingSubresources` use attributed abort.

### 4. Discarded pending page freed while transfer still held `ctx`

Superseding root navigation calls `discardPendingPage` while the previous pending document transfer may still be inside `curl_multi_perform` with `req.ctx = &pending.frame`.

**Fix:** Defer destroy when `hasLiveTransferWithCtx(&page.frame)`; park in `_zombie_pending_pages`; `reapZombiePendingPages()` from `HttpClient` after `transfer.deinit`.

## Verification

```bash
cd /Users/huydev/Desktop/koko
zig build
node code-check/site-stability/debug-reload.mjs "https://www.bbc.com/news"  # 2/2, koko alive
```

## Files

- `src/core/browser/Page.zig` — identity invalidation order
- `src/core/webapi/collections/NodeList.zig`, `iterator.zig` — dependent RC
- `src/core/browser/HttpClient.zig` — `attribution_frame`, `abortTransfersAttributedTo`, zombie reap hooks
- `src/core/browser/Frame.zig`, `Session.zig` — attributed abort + zombie pending pages
- `src/core/browser/ScriptManager*.zig`, `Image.zig`, `Link.zig` — set `attribution_frame`

## Related

- [`knowledge/architecture/2026-07-09-load-guard-navigation-gate.md`](../architecture/2026-07-09-load-guard-navigation-gate.md)