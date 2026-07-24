# Iframe product fixes: named access, unload-nav, contentDocument, about:srcdoc

> **Audience:** Velora engineers  
> **Date:** 2026-07-23  
> **Scope:** Window named browsing contexts, iframe same-origin document exposure, unload navigation ignore, about:srcdoc block, document.open stability follow-up

## Summary

After product WPT triage of iframe/nav/open failures, we landed several core browsing-context fixes:

1. **Window named access** (`window.x` / `contentWindow.x`) — lookup used the *caller* realm’s frame; parent reading `frame.contentWindow.x` never saw child names. Fixed via creation-context of `this`.
2. **contentDocument cross-origin** — return `null` when child `Origin*` ≠ parent (opaque / different origin).
3. **Unload-started navigation ignore** — `_unload_running` during unload/pagehide; `fireUnloadForNavigation` before iframe re-nav teardown.
4. **about:srcdoc location/open block** — schedule opaque-about error navigation instead of reloading srcdoc.
5. **window.name / close** — name reflects iframe attribute; empty after discard; `closed` immediate with deferred opener clear.
6. **document.open stability** — prior double-deinit / arena fixes retained.

CDP smoke: `length===2`, `w.x`/`w.y` objects, `w.x===w[0]`. Process remains alive after open suite smoke.

Full `the-iframe-element` WPT still mostly **harness stall** (5s no progress / invalid report) — page loads (`readyState=complete`) but testharness often never finishes. MANIFEST was missing new paths (fixed: +262 entries).

## Code

| Area | Files |
|------|--------|
| Named access | `src/core/js/bridge.zig` (`unknownWindowPropertyCallback`), `Frame.findNamedChildWindow` |
| contentDocument | `src/core/webapi/element/html/IFrame.zig` |
| Unload nav | `Frame._unload_running`, `Session.processFrameNavigation` + `fireUnloadForNavigation` |
| about:srcdoc | `Frame.scheduleNavigation` + `opaque_about_error` NavigateOpts |
| name/close | `Window.getName`/`setName`/`close` |
| MANIFEST | `wpt-spa-tests/MANIFEST.json` inject for semantics/iframe trees |

## Verify

```bash
cd /Users/huydev/Desktop/velora && zig build
# named access CDP: length 2, x/y objects
# suite (after MANIFEST inject):
cd /Users/huydev/Desktop/wpt-spa-tests
python3 velora-probe/run.py --suite iframe --batch-size 2 --force
```

## Follow-up

1. Why testharness stalls on many iframe-element HTML files (`tests` undefined / no completion).
2. about:srcdoc block still TypeError on some location assign paths (not pure opaque doc).
3. unload-nav still `?pass` → `""` in some runs (nav may not complete).
4. window.close WPT close-method still incomplete vs full discard timing.
