# Re-nav parse SIGABRT: isConnected UAF after Google knitsail

## Summary

Sequential navigation **Google Search → other site** (Bing, etc.) aborted the process (`SIGABRT` / segfault). Batch harnesses then reported later URLs (Wikipedia) as `Transport closed` or `Waiting for Page.domContentEventFired` even though cold loads of those sites were fine.

## Stack

```
Node.isConnected  (walk root._parent)
Frame._insertNodeRelative
Frame.appendNew
Parser._appendCallback
html5ever parse (deferred document parse)
```

Segfault at a garbage parent address while inserting during **main document** HTML parse.

## Root cause

`_insertNodeRelative` always called `parent.isConnected()` / `child.isConnected()` even when:

- `from_parser == true` and `_parse_mode == .document`

On that path the connected flag is **not needed for mutation observers** (`should_notify` is false). Walking `_parent` during foster-parenting / post re-nav heap pressure still walked freed or inconsistent parent chains after the previous document (Google knitsail SERP) was torn down.

Debug also used `unreachable` when html5ever re-appended a node that already had a parent — another SIGABRT source.

## Fix

1. **Frame._insertNodeRelative** — only call `isConnected` when `should_notify` is true. For document parse, treat inserted elements as connected (spec-fast path already documented in comments).
2. **Parser._appendCallback** — disconnect reparented children without `unreachable` in debug; avoid `isConnected` on document parse reconnect.
3. **Node.isConnected** — depth cap + trivial cycle guard.
4. **prepareForOutgoingAbort** — clear knitsail lifecycle flags so SERP timers cannot fire on a departing realm.

## Verification

```
google.com/search?q=velora → bing.com  (no crash, DCL)
google → search → bing → ddg → wikipedia  (sequential same process)
```

demo.mjs vs test-100-urls.mjs discrepancy was collateral process death, not Wikipedia-specific.
