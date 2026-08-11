# WSJ EmptyDocumentBody — DataDome 401 body skipped as “auth”

> **Date:** 2026-07-16

## Summary

`https://www.wsj.com/` failed with `EmptyDocumentBody` / empty navigation dump. CloudFront + **DataDome** returns **HTTP 401** with a small HTML interstitial (`Please enable JS…`, `var dd={…}`) and `x-datadome: protected` — **no** `WWW-Authenticate`.

Koko treated every 401/407 as an HTTP auth challenge: skipped the response body and invented a dummy `_auth_challenge`. Document navigation then finished with no HTML → `EmptyDocumentBody`.

## Root Cause

1. `HttpClient.dataCallback` skipped body when `status == 401 || 407` unconditionally (intended for Basic/Digest retries).
2. `detectAuthChallenge` set a dummy challenge when no parseable auth header existed.
3. `buildResponseHeader` reported status **407** whenever `_auth_challenge != null` (mislabeled 401).

Chrome still loads 401 HTML; bot walls depend on that JS running.

## Fix

- Skip 401/407 body only when `WWW-Authenticate` / `Proxy-Authenticate` parses as Basic/Digest.
- `detectAuthChallenge`: require parseable scheme; never invent dummy challenges.
- Report wire/server status for server challenges; keep 407 only for `source == .proxy`.

## Verification

| Check | After |
|-------|--------|
| `koko fetch https://www.wsj.com/` | dump ~785B, title `wsj.com`, no EmptyDocumentBody |
| CDP navigate | status **401**, DCL ~200ms, body DataDome interstitial text |
| Network | `x-datadome` path can proceed to run challenge JS (pass DD is separate) |

## Related

- `knowledge/bugs/2026-07-15-navigate-non2xx-cdp-hang.md` — deliver non-2xx HTML documents
- Bitbucket parse O(n²) — different class of failure
