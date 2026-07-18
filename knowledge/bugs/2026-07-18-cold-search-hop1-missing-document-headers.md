# Cold Google search hop-1 missing Accept / Sec-Fetch document headers

> **Date:** 2026-07-18 · **Area:** `Frame.headersForRequest` + `HttpProfile` · **Status:** Fixed (wire); pure cold SERP may still hit `/sorry` under hot IP

## Summary

Cold Velora Google Search (home → `/search` with session cookies) sent a **skeleton** request on hop-1: Host, UA, Accept-Encoding, Accept-Language, Cookie, Sec-Ch-Ua, X-Browser — **no `Accept` document list, no `Sec-Fetch-*`, no `Upgrade-Insecure-Requests`**. In-session `sei=` hops already used the full Chrome 150 document list. Wire capture (`VELORA_WIRE_HEADERS`) made the asymmetry obvious.

Root cause: for document navigations with `omit_sec_fetch_user=false` (cold first hop), the code path used thin `appendCurlImpersonateDocumentOverrides`, assuming **curl-impersonate default_headers** would supply Accept/Sec-Fetch. Those defaults were **not present** on the captured request.

**Fix:** always emit full `appendChromeHeaders` / Chrome 150 Accept-first document headers for document navigations.

After fix, hop-1 wire shows Accept, Sec-Fetch-Dest/Mode/Site/User, UIR. Cold `/sorry` may still occur on a **hot lab IP** (Layer 1 rate) even with correct headers — cookie-mint from Chrome remains the reliable Layer-0 unlock.

---

## Problem

| Hop | Before fix (wire) | After fix |
|-----|-------------------|-----------|
| initial `/search?q=` | No Accept, no Sec-Fetch, no UIR | Accept + Sec-Fetch + UIR |
| `sei=` | Full Chrome list | Full Chrome list (unchanged) |

User-visible cold path: home mints NID ~220 → search → knitsail/sg_ss → often `/sorry`. Missing hop-1 metadata made the client look less like Chrome navigate.

---

## Root Cause

```zig
// Frame.headersForRequest — document navigation, curl_impersonate build
if (opts.omit_sec_fetch_user) {
    // sei/sg_ss: full Chrome headers  ✅
    try HttpProfile.appendChromeHeaders(...);
} else {
    // cold hop: thin overrides only  ❌
    try HttpProfile.appendCurlImpersonateDocumentOverrides(...);
}
```

`appendCurlImpersonateDocumentOverrides` only added Accept-Language, Sec-Ch-Ua, and optional Sec-Fetch-Site — not the document Accept / Dest / Mode / User / UIR stack.

Policy `curlDefaultsOnly: never` did **not** help: the thin path was chosen by `omit_sec_fetch_user == false`, not by `curl_defaults_only`.

---

## Solution

In `src/core/browser/Frame.zig`, document navigations always call `HttpProfile.appendChromeHeaders` (full Accept-first list). `omit_sec_fetch_user` still controls Sec-Fetch-User and referer shaping for in-session hops.

---

## Verification

```bash
VELORA_WIRE_HEADERS=1 VELORA_WIRE_HEADERS_FILE=/tmp/wire.ndjson \
  # serve + navigate home then search
# expect hop=initial: hasAccept, hasSecFetchDest, hasSecFetchUser, hasUIR

node scripts/watch-nid-session.mjs --create-profile --profile cold-test --q velora
```

Post-fix (2026-07-18, lab IP after many searches):

- Wire hop-1: **Accept + Sec-Fetch + UIR present** (regression fixed).
- watch-nid cold: still `tier=sorry` + SG_SS on this IP — treat as rate/trust residual, not missing Accept.

---

## Related

- [Chrome 150 Accept-first order](../captcha/detection/) / HttpProfile comments
- [SerpBase knitsail / SG_SS](../captcha/detection/2026-07-17-serpbase-knitsail-sg-ss-lessons.md)
- [Pure cold N× residuals](../captcha/detection/2026-07-17-pure-cold-n-rate-and-residuals.md)
- `scripts/watch-nid-session.mjs`
