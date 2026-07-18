# Cookie Store API wired to jar + JSON/CHIPS metadata

**Date:** 2026-07-19  
**Area:** cookies architecture (A/B/C plan)

## Changes

1. **`window.cookieStore`** (`cookie_store.zig`) now uses `Session.cookie_jar`:
   - `get` / `getAll` — non-HttpOnly cookies visible to the document URL
   - `set` — builds a cookie line, `Cookie.parse`, `addWithTopLevel` (same rules as `document.cookie`)
   - `delete` — removes matching non-HttpOnly cookies
   - Shares jar with HTTP, CDP, and `document.cookie` (single source of truth)

2. **JSON Cookies.json** round-trip fields (optional, back-compat):
   - `partitioned`, `partitionSite`
   - `sourceSecure`, `sourcePort`
   - Load still defaults to HTTPS:443 when absent (Chrome profile exports)

3. **CDP `Network.deleteCookies`**:
   - When `partitionKey` is set, only deletes CHIPS cookies whose `partition_site` matches
   - When absent, deletes by name/domain/path as before (Puppeteer-friendly)

## Verify

```bash
# cookieStore set/get/delete + document.cookie interop
# (local CDP probe; see agent session)

zig build check
npm run test:event-loop
```

## Not in this change

- CookieChangeEvent emission on jar mutation
- Full 3PCD HTTP third-party blocking
