# NetworkInformation.downlinkMax + macOS ActiveText system colors

**Date:** 2026-07-19  
**Area:** WebAPI surface (architecture, not site specials)

## Problem

CreepJS `likeHeadlessRating` stayed at 25% with four flags:

| Flag | Cause |
|------|--------|
| `noDownlinkMax` | `'downlinkMax' in NetworkInformation.prototype` was false — property missing |
| `hasKnownBgColor` | `getComputedStyle(...).backgroundColor` for `ActiveText` was Phantom pure `rgb(255, 0, 0)` |
| `noContentIndex` | Desktop Chrome has no `window.ContentIndex` — **intentional**, keep |
| `noContactsManager` | Chrome Mac: no `window.ContactsManager` (only `navigator.contacts`) — **intentional**, keep |

## Fix (generic)

1. **`NetworkInformation`**: expose `downlinkMax` (Infinity for wifi default, Chrome desktop behavior) and rename JS attribute `connectionType` → `type` (NetInfo / Chrome).
2. **CSS system colors**: map `ActiveText` to macOS systemRed-ish `rgb(255, 59, 48)` and slightly more Mac-like `LinkText`; table is platform defaults, not a per-site hash.
3. **HttpClient**: reject non-`http(s)` URLs before `curl_easy_setopt` URL (generic scheme gate; fewer `UrlMalformat` storms from SPA resolvers). Use `force_fresh_connection` for easy reinit (no `sg_ss=` substring).

## Not fixed here

- YouTube Polymer feed hydration / arena leak on fetch teardown — separate work.
- `ContentIndex` / global `ContactsManager` must stay off for Mac profiles.

## Verify

```bash
zig build check && zig build
node scripts/cdp-creepjs-bot-probe.mjs --max-sec 25
# expect: noDownlinkMax false, hasKnownBgColor false when ActiveText resolved
```
