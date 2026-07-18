# One-pass fingerprint/SERP fix: gate results (2026-07-17)

## Summary

Executed the planned one-pass workstream against Chrome 150 / browserleaks / Google Search.

**Shipped:**

1. **G1 TCP JA4** — **PASS.** Vendor curl-impersonate rebuilt with ML-DSA names;  
   `curl_chrome150` → `t13d1516h2_8daaf6152771_806a8c22fdea` (exact Chrome 150 target).
2. **G2 QUIC JA4** — **PASS** on `q13d0311h3_55b375c5d22e_653d80c3fe9d` after QUIC omits SCT/status and prefers HTTP3 sig list (no ML-DSA on QUIC).  
   H3 control: GREASE frames present; PRIORITY_UPDATE `984832` sometimes present (depends on control-stream path).
3. **G3 HTTP identity** — already cleaned earlier (full version 129, ExtraInfo `X-Browser-Validation`).
4. **Zig knobs** — fragile setopts use `curlEasySetoptOptional` so `BadFunctionArgument` does not abort navigations.
5. **Product SERP (thin jar)** — **profile55 still SERP** after vendor swap.

**Not closed:**

| Gate | Result |
|------|--------|
| **G5 cold empty SERP** | **FAIL** — still knitsail ~91 KB after ML-DSA + H3 |
| **G6 warm hop** | Homepage OK; search → `/sorry` under rate-limit from heavy testing |
| **ECH multi** | Still off (secondary; does not unlock SERP) |
| **G4 CDP stability** | Improved; intermittent navigate issues reduced with optional setopts |

## Implication

Matching browserleaks Chrome 150 **TCP+QUIC JA4 is necessary but not sufficient** for cold Google SERP on this host. Production path remains **thin guest cookie jar** (export Profile 55 / live) until residual signals (IP, behavior, ECH, etc.) are closed.

## Follow-up fixes (same day)

- `persistCookies` logs path + supports CLI jar flush (graceful SIGTERM).
- Product entrypoint: `npm run google:serp-product` (thin P55 jar / `--live-chrome-profile`).
- Durable reapply: `scripts/reapply-curl-fingerprint-patches.sh` after vendor clean rebuilds.
- Recheck: G1+G2 green including H3 `984832` 3/3; product SERP still OK.

## Commands

```bash
# G1
./vendor/curl-impersonate/curl_chrome150 -sS https://tls.browserleaks.com/json | jq .ja4

# G2
./vendor/curl-impersonate/curl_chrome150 --http3 -sSL https://quic.browserleaks.com/fp | jq '{ja4,h3_text}'

# SERP
npm run google:serp-matrix -- --only empty,profile55 --no-stop
```

## Vendor notes

- Source: `.velora-cache/curl-impersonate` v2.0.0rc3 with manual H3/nghttp3 + openssl QUIC guards.
- Sync: `./scripts/vendor-sync-curl.sh` then `cp` `src/curl-impersonate` into vendor.
- `clean-first` rebuilds drop manual patches — re-apply H3/openssl guards after clean.
- Patch path: `cf-ngtcp2.c` (not `curl_ngtcp2.c`); GREASE after `Curl_cf_ngtcp2_h3_init_ctrls`.
