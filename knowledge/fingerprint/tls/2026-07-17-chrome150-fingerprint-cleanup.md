# Chrome 150 fingerprint cleanup (header + TLS knobs)

> **Audience:** Koko engineers working on Google Search cold path and antidetect wire parity.  
> **Date:** 2026-07-17

## Summary

We cleaned Koko’s **Chrome 150 surface** against a live CDP ExtraInfo capture (`code-check/tmp/chrome-hop1-extrainfo-ref.json`). Header identity (UA-CH full version, grease brand order, `X-Browser-Validation`) now matches hop-1 Chrome 150. TLS still uses curl-impersonate **chrome146** as the ClientHello base, with Chrome 150 ML-DSA sigalgs applied on **h2 when the vendor understands the names**, and a safe fallback when it does not.

Empty-jar Google Search remains **knitsail** (~91 KB). Thin guest jars (Profile 55 / fail-thin) still **SERP**. Cleaning HTTP identity alone does not unlock cold SERP — stack/TLS JA4+ECH and cookie state remain the gates.

## Problem

Mismatches observed between Koko wire and Chrome 150 cold search:

| Signal | Chrome 150 hop-1 | Koko (before) |
|--------|------------------|-----------------|
| `uaFullVersion` | `150.0.7871.129` | `150.0.7871.115` |
| `X-Browser-Validation` | `uemYFgH1pQp+sN1z7tIZXI0g3PI=` | sha1(AIza…+UA) ≠ Chrome |
| TCP ML-DSA (0x0904…) | present | setopt could **fail** (unknown `mldsa44` on some vendor builds) |

## Changes

1. **Profile / catalog** `chrome-local-huys-macbook-pro`: `uaFullVersion` → `150.0.7871.129` (grease-first brands already correct).
2. **`XBrowser.zig`**: for Macintosh + `Chrome/150.*`, use captured ExtraInfo validation token; env `KOKO_X_BROWSER_VALIDATION` still overrides.
3. **`http.zig` `applyChromeTlsKnobs`**: try Chrome150 ML-DSA list on h2; on setopt failure log `chrome150_mldsa_sigalgs_fallback` and use chrome146 list (do not kill the request).
4. **`vendor/curl-impersonate/curl_chrome150`**: detect ML-DSA support; fall back; force Chrome/150 UA.

## Verification (matrix 2026-07-17T11-52-47)

| Case | Verdict | Notes |
|------|---------|-------|
| empty | knitsail ~91k | cold still fails |
| fail-thin | serp_ok ~353k | thin jar |
| profile55 | serp_ok ~359k | thin jar |

Wire after fix includes:

- `Sec-Ch-Ua-Full-Version-List` … `150.0.7871.129`
- `X-Browser-Validation: uemYFgH1pQp+sN1z7tIZXI0g3PI=`

## Remaining (not closed by this cleanup)

- **Vendor ML-DSA**: current stock binary often rejects `mldsa44` → TCP JA4 still chrome146-class until rebuild with ML-DSA-aware BoringSSL/curl-impersonate.
- **ECH multi** still unsafe in Koko curl multi.
- **Cold empty SERP** still needs deeper stack parity (or warm cookie pipeline).

## Bottom line

Fingerprint **HTTP identity** is cleaned to Chrome 150 hop-1. Fingerprint **TLS JA4** needs vendor ML-DSA; product Search still relies on guest cookies for hop-1 SERP until cold path closes.
