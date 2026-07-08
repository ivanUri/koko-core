# WPT Fetch Suite — body streaming, cache, redirects, forbidden headers

> **Date:** 2026-07-06 – 2026-07-07 · **Area:** `Fetch.zig`, `HttpClient.zig`, HTTP cache · **Status:** Partial green; keepalive/json stream ongoing

## Summary

The Fetch implementation needed layered fixes across **request body upload**, **response body streaming** (`ReadableStream`), **conditional GET / HTTP cache**, **redirect header rebuild**, **forbidden header names**, **CORS/mode/integrity**, and **keepalive** semantics. This note consolidates six incremental WPT fix rounds into one narrative.

## Problem

| Cluster | Symptom |
|---------|---------|
| Body upload | `request-upload` stalls; null body mishandled |
| Streaming | `response.body` stream not tee'd; backpressure wrong |
| Cache | `If-None-Match` / `304` not wired |
| Redirects | POST→GET body strip; Referer/Cookie order on curl-impersonate hops |
| Security | Forbidden headers leaked on `no-cors`; integrity checks missing |
| Keepalive | `response.json()` on detached streams; beacon lifetime |

## Root Cause

Fetch sits above curl-impersonate and CDP interception — fixes must align **wire headers**, **jar cookies**, and **JS stream objects** simultaneously. Cache validators lived only in navigation path, not subresource Fetch. Redirect policy refresh hooks were missing for Google-style header rebuilds.

## Solution (by layer)

| File | Fixes |
|------|-------|
| `Fetch.zig` / redirect state | Method/body on 303; referrer policy; stream lock |
| `HttpClient.zig` | `revalidate_etag`, `revalidate_last_modified`; redirect_header_rebuild |
| `InterceptionLayer` | Forbidden header filter per mode |
| Cache layer | 304 short-circuit into fulfilled response |
| Streams | `response.json()` consumes body once; keepalive flag on transfer |

## Lessons Learned

- Fix **P0 wire correctness** (headers, redirects) before stream ergonomics — WPT fails early on forbidden `User-Agent` before body tests run.
- **curl-impersonate** requires manual Cookie/Referer ordering — share dedupe logic with CDP (`network.zig`).
- Run fetch WPT in **manifest batches** (`code-check/wpt-fetch/lists/`) when restarting harness — lists preserved, results ephemeral.

## References

- `src/core/webapi/net/Fetch.zig`, `src/core/browser/HttpClient.zig`
- WPT: `/fetch/`

## Related Knowledge

- [`2026-07-08-wpt-cookie-suite.md`](2026-07-08-wpt-cookie-suite.md) — jar + CDP header dedupe
- [`2026-07-workers-wpt-suite.md`](2026-07-workers-wpt-suite.md) — `fetch()` from workers