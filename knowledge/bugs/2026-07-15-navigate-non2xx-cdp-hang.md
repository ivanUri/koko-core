# Page.navigate hang on non-2xx document (Stack Overflow 403)

## Summary

`Page.navigate` to sites that return real HTTP error documents (e.g. Stack Overflow **403** Cloudflare challenge) never completed the CDP command. Clients timed out at ~12s with empty snapshots (`readyState=null`, still `about:blank`).

Two bugs compounded:

1. **Header gate too strict** — `frameHeaderDoneCallback` rejected every `status ∉ [200,299]`, aborting the transfer before commit/parse. Chrome still loads 4xx/5xx HTML.
2. **CDP failure not delivered** — On pending-root failures (including the resulting `WriteError`/`Abort`), `frameErrorCallback` discarded the pending page **without** `frame_navigation_failed`, so the original `Page.navigate` `cdp_id` was never answered.

## Evidence

Probe before fix (`https://stackoverflow.com/`):

```
Network.responseReceived status=403 text/html
Network.loadingFailed WriteError / Shutdown
WARN frame: navigate header bad status
ERROR frame: navigate failed err=WriteError
Page.navigate → timeout 12000ms
Runtime sample: href=about:blank
```

## Fix (`Frame.zig`)

1. Reject only **missing status** and **status == 0** (curl ghost / ebay hang class). Log and **proceed** for other non-2xx document responses so challenge/error HTML can parse and fire DCL.
2. Always resolve stranded CDP navigations:
   - `completePendingCdpNavigateFailureMsg` on missing/0 status before `return false`.
   - Pending-root `frameErrorCallback`: call `completePendingCdpNavigateFailure` before `discardPendingPage`.
   - Abort / active-page error paths: complete if `cdp_id` still set.

## Verification

After rebuild:

| URL | Page.navigate | DCL | Snapshot |
|-----|---------------|-----|----------|
| `https://stackoverflow.com/` | **ok ~220ms** | ~450ms | `title=Just a moment...`, html≈27KB (CF challenge) |
| `https://example.com/` | ok | ok | normal |

Harness `CDP command timed out: Page.navigate` for SO-class sites should drop; content may still be a bot challenge page (not full SO UI) until Turnstile/fingerprint path succeeds.

## Related

- `knowledge/bugs/2026-07-10-ebay-empty-document-cdp-navigate-hang.md` — status=0 empty stub; keep rejecting status 0 only.
- Lifecycle DCL work (2026-07-15) — orthogonal; this bug never reached post-parse lifecycle.
