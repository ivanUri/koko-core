# Link.preload ArenaPool leak on image-heavy sites

> **Date:** 2026-07-22 · **Area:** HTMLLinkElement preload, ArenaPool · **Status:** Core fix landed

## Summary

Exporting `https://www.shein.com/` (redirects to `shein.com.vn`) under Debug panics on browser teardown with `ArenaPool leak` / `name = Link.preload` (often a dozen arenas). The page itself hydrates fine for tens of seconds and produces multi‑MB DOM, but process shutdown aborts the export script before a final write. Root cause: `fetchPreloadImage` acquired a scratch arena then **returned early on a duplicate preload URL without `releaseArena`**. The same ownership handoff pattern already used by `HTMLImageElement` was missing.

`site-export-velora.mjs` now also **flushes the best `documentElement.outerHTML` to disk incrementally** while the page grows, so a later CDP drop or teardown panic still leaves a usable dump.

## Problem

Observable on Shein (and any site with many `<link rel="preload" as="image">`):

1. Navigation and SPA hydration succeed (`outerHTML` grows past 3 MB, 100+ images with `src`).
2. On `SIGTERM` / browser deinit, Debug builds panic:

   ```
   ERROR bug : ArenaPool leak
         name = Link.preload
         count = 12
   ArenaPool: leaked arenas detected
   ```

3. CDP closes mid-final `Runtime.evaluate`; naive export scripts that only write once at the end lose the entire capture.

## Root Cause

In `Link.fetchPreloadImage`:

1. `frame.getArena(.small, "Link.preload")` for URL resolve + `PreloadLoad` storage.
2. Early exits when the same `href` is already loading/loaded:

   ```zig
   if (std.mem.eql(u8, prev, owned_url)) return; // leaked scratch
   ```

3. No `errdefer` / caller-owns handoff around `http_client.request` (unlike `Image.load`).

Duplicate preloads are common (SSR + client re-walk of `<head>`, React re-mounts). Each early return leaked one arena; Shein’s head has many image preloads → panic counts in the double digits.

## Solution

### Core — `Link.zig`

Mirror `Image.load` ownership:

- `caller_owns_scratch` + `errdefer` release.
- On same-URL early return: **`releaseArena` then return**.
- Handoff ownership to `PreloadLoad` immediately before `http_client.request`.
- Always clear `_preload_loading` and release in `done` / `error` / `shutdown` (even when `!deliverable`).
- Always dispatch resource `error` events (listeners, not only `onerror` property).

### Tooling — `scripts/site-export-velora.mjs`

- Score snapshots by `htmlLength` + images-with-`src`.
- When the score improves (or readiness is met), serialize and **`writeFileSync` immediately**.
- Final evaluate is best-effort; if CDP dies, the last on-disk HTML is kept.
- Report field `incrementalWrites` for diagnostics.

## Verification

```bash
cd /Users/huydev/Desktop/velora
zig build
node scripts/site-export-velora.mjs \
  --url "https://www.shein.com/" \
  --output artifacts/site-export/shein.com.html \
  --timeout-ms 90000 --min-wait-ms 12000 --min-images 5 --scroll
```

Expect: multi‑MB HTML with product images; process exit without `Link.preload` ArenaPool panic (after in-flight preloads finish or shutdown callbacks release).

## Lessons Learned

1. Scratch-arena HTTP loads need the **same acquire / early-return / errdefer / handoff** template everywhere (`Image`, `Link`, future media).
2. Export tooling should treat browser death as normal: **best-effort capture on disk**, not a single final evaluate.
3. Debug ArenaPool leak panics are a feature — they surface ownership bugs that soft-leak in Release.
