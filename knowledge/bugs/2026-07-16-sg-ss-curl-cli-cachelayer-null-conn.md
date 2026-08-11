# Google `sg_ss` hop crash: CacheLayer assumes curl Connection

> **Date:** 2026-07-16 · **Area:** HTTP cache layer + Google Knitsail `sg_ss` · **Status:** Fixed

## Summary

After Knitsail successfully encoded and navigated to `/search?q=…&sg_ss=*…`, Koko crashed with **`attempt to use null value`** during the CLI document transport path. Root cause: `CacheLayer.headerCallback` always did `transfer._conn.?`, but `CurlCliTransport` (used for multi-kB `sg_ss=` document hops) never attaches a libcurl `Connection`. Fix: when `_conn` is null, skip connection-backed cache metadata and forward the response.

Post-fix: engine no longer dies; the hop completes and Google may return `/sorry` (HTTP 429 unusual traffic) depending on IP/`sg_ss` content — a separate antibot issue from the null crash.

## Problem

Debug timeline on antidetect profile `chrome-local-huys-macbook-pro`:

1. Bootstrap knitsail HTML loads; DCL ~0.6–2s; `pageT` freeze ~192.6; `trustedTypes` present.
2. VM emits navigation to `…&sg_ss=*…`.
3. `DEBUG http : sg_ss curl cli transport`
4. **Crash** — CDP `Transport closed`, process exits.

Stack (unstripped Debug):

```
CacheLayer.zig:361  const conn = transfer._conn.?;
HttpClient.zig:1412 completeCliDocument → header_callback
HttpClient.zig:1379 makeSyncEasyRequest
```

## Root Cause

`HttpClient.shouldSyncEasyPerform` routes document URLs containing `sg_ss=` through `CurlCliTransport.fetchSgSsDocument` (subprocess `curl_chrome146`) because in-process multi stalls on large query strings. That path:

- Calls `start_callback` then CLI fetch then `completeCliDocument`
- Sets **injected** response headers on `transfer.response_header`
- **Never** sets `transfer._conn`

`CacheLayer.headerCallback` assumed every response had a live curl easy handle for Vary / Cache-Control / ETag extraction and panics on null `_conn`.

## Solution

```zig
// CacheLayer.zig — headerCallback
const conn = transfer._conn orelse {
    return self.forward.forwardHeader(response);
};
```

CLI hops still deliver status/body via injected headers; caching for those responses is skipped (acceptable: one-shot `sg_ss` payloads).

## Verification

```bash
cd /Users/huydev/Desktop/koko && zig build -Doptimize=Debug -Dstrip=false
cd /Users/huydev/Desktop/koko-run
node google-knitsail-debug.mjs
```

Expected after fix:

- No process crash on `sg_ss` hop
- Network shows CLI fetch completing (often `429` → `/sorry/index` under automated IP)
- Final snapshot `verdict: sorry` or SERP; `readyState` interactive/complete

## Related

- [Knitsail DCL during parse](./2026-07-15-google-knitsail-dcl-during-parse.md)
- SerpBase: [Knitsail / SG_SS](https://serpbase.dev/blog/google-knitsail-and-sg-ss-generation-logic-and-its-role-in-distinguishing-automa)
- `CurlCliTransport.zig`, `HttpClient.makeSyncEasyRequest`
