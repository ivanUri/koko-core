# Iframe unload: visibilitychange lifecycle + parser iframe src gap

## Summary

Extended iframe teardown lifecycle beyond `pagehide`/`unload` (keepalive fix) to include the Page Visibility API: `document.hidden`, `document.visibilityState`, and `visibilitychange` on nested frames.

A separate blocker prevents `page-visibility/iframe-unload.html` from passing: parser-inserted `<iframe src="...">` on the test page stays at `about:blank` (`readyState: loading`) and never navigates to its `src`.

## Changes

### `Document.zig`

- Added `_visibility_hidden` with `getHidden()`, `getVisibilityState()`, `markVisibilityHidden()`.
- Replaced static `bridge.attribute` stubs with live accessors for `hidden` and `visibilityState`.

### `Frame.zig` — `fireUnloadLifecycleEvents`

- Recurse into `child_frame.child_frames` before firing events on the parent (nested iframes get their own lifecycle).
- Order per unload: `visibilitychange` (Document, bubbles) → `pagehide` → `unload`.
- `markVisibilityHidden()` runs before dispatch so handlers read `visibilityState === "hidden"`.

### `EventManagerBase.zig`

- `hasListeners` / `remove` lookup uses `String.wrap(typ)` instead of comptime `.wrap(typ)` so event names longer than 12 bytes (e.g. `visibilitychange`) match registered listeners.

## Additional fixes (2026-07-07 session 2)

### Parser iframe `src` → `Session.upgradeIframeFromAboutBlank`

- html5ever `nodeComplete` may run before `src` is bound; reconcile after parse now calls `processFrameNavigation` immediately instead of relying on a queued drain that could be skipped.
- `Frame.drainQueuedNavigationsAfterParse()` loops `processQueuedNavigation` + HTTP tick after reconcile.

### Cross-frame `addEventListener` routing

- `EventTarget.addEventListener` / `removeEventListener` / `dispatchEvent` now resolve the **target owner's** `EventManager` via `ownerFrameForTarget`, not `exec.context.global`.
- `Node.ownerFrame`: document nodes return `document._frame` (previously fell through to the entry settings frame).

## Verified

| Test | Result |
|------|--------|
| `fetch/api/basic/keepalive.any.html` | 14/14 (regression OK) |

### Parser iframe `onload` never fires (`docsLoaded` stays 0)

Probe (`scripts/cdp-iframe-lifecycle-probe.mjs`) showed `window[0]` loads `iframe-with-subframes.html` with 2 nested frames, but `docsLoaded === 0` and async_test stayed `Not Run`.

Root cause: `queueSyncIframeLoad` runs for parser-inserted `about:blank` iframes, but `flushPendingSyncIframeLoads()` only ran from JS `appendChild` — not after HTML parse. `notifyParentLoadComplete` then skips `iframeCompletedLoading` when `_sync_load_queued`, so `onload="parent.parent.startTest()"` never runs and parent `documentIsComplete` may never drain `_pending_loads`.

Fix: `Frame.scheduleDeferredSyncIframeFlush()` — queue flush on the next scheduler turn from `frameDoneCallback` after `staticScriptsDone()`. Synchronous flush inside HTTP `done_callback` caused cross-frame `onload` to crash V8 (`cast causes pointer to be null`); `appendChild` still sync-flushes (Fingerprint yb timing).

## Verified (2026-07-07)

| Test | Result |
|------|--------|
| `page-visibility/iframe-unload.html` | 1/1 Pass |
| `fetch/api/basic/keepalive.any.html` | 14/14 (regression OK) |
| `page-visibility/test_attributes_exist.html` | 4/4 |
| `page-visibility/test_child_document.html` | 14/14 |
| `page-visibility/test_read_only.html` | 4/4 |
| `page-visibility/test_default_view.html` | 4/7 |
| `page-visibility/unload.html` | 0/1 (needs `window.close()`) |
| `page-visibility/unload-bubbles.html` | 0/1 (needs `window.close()`) |
| `page-visibility/minimize.html` | 0/3 (testdriver `minimize_window`) |

## Next

1. Popup `window.close()` lifecycle for `page-visibility/unload.html` / `unload-bubbles.html`.
2. `test_default_view.html` remaining 3 failures (iframe visibility inheritance edge cases).
3. Re-run `page-visibility/onvisibilitychange.html` (hung in batch — investigate separately).

## Probe

```bash
# MCP eval after loading test page (waitUntil: done):
# window[0].location.href === "about:blank", window[0].document.querySelectorAll('iframe').length === 0

# Direct load of nested resource works:
# http://localhost:8000/page-visibility/resources/iframe-with-subframes.html → childFrames: 2
```