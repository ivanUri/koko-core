# QUIC/H3 gap: Chrome 150 vs curl-impersonate (post TCP JA4 fix)

> **Date:** 2026-07-17  
> **Artifacts:** `code-check/tmp/tls-chrome150-spike/chrome150-*-bl.json`, `curl150-*-bl.json`  
> **Context:** TCP JA4 already matches Chrome 150 after ML-DSA wiring; cold Google Search still knitsail on **h3**.

## Summary

On this machine, **TLS over HTTP/2 is solved** (JA4 / JA3n / Akamai match Chrome 150).  
**QUIC/HTTP3 is not.** Google Search cold hop-1 uses **h3**, so the remaining demotion surface is **QUIC ClientHello + H3 control frames**, not TCP JA4 and not cookies.

Real Chrome 150 cold search: **Cookie=0**, **protocol=h3**, **SERP** (~800 KB).  
`curl_chrome150 --http3` and Koko cold: **Cookie=0**, **h3**, still **knitsail** (~91 KB).

---

## Method

| Client | Endpoint |
|--------|----------|
| Chrome 150 fresh profile (CDP) | `tls.browserleaks.com/json`, `quic.browserleaks.com/json` |
| `vendor/curl-impersonate` v2.0.0rc3 + chrome150 knobs | same |

---

## TLS (h2) — MATCH after ML-DSA

| Signal | Chrome 150 | curl chrome150 knobs | |
|--------|------------|----------------------|--|
| JA4 | `t13d1516h2_8daaf6152771_806a8c22fdea` | same | ✅ |
| JA4_r sigs | `0904,0905,0906,0403,…` | same | ✅ |
| JA3n / Akamai | match | match | ✅ |

---

## QUIC (h3) — DIFF (root of Search cold path)

| Signal | Chrome 150 | curl-impersonate (stock v2rc3 / chrome150 wrap) |
|--------|------------|--------------------------------------------------|
| **QUIC JA4** | `q13d0311h3_55b375c5d22e_653d80c3fe9d` | `q13d0313h3_55b375c5d22e_3fbb976dcacb` (or `…_05ee…` without ML-DSA) |
| **Ext count prefix** | `q13d0311` (**11** extensions) | `q13d0313` (**13** extensions) |
| **Extra extensions (curl only)** | — | **`0005`** (status_request), **`0012`** (SCT) |
| **Sig algs** | classic + trailing **`0201`** (rsa_pkcs1_sha1); **no** 0904/05/06 | default classic; **with TCP ML-DSA injected → also 0904/05/06 on QUIC** (worse) |
| **h3_text** | `1:65536;6:262144;7:100;51:1;GREASE\|GREASE\|984832\|m,a,s,p` | `1:65536;6:262144;7:100;51:1;GREASE\|m,a,s,p` |
| **h3 control frames** | GREASE frame + **PRIORITY_UPDATE `984832` (=0x0f0700)** | missing in stock prebuilt (Koko patches not in v2rc3 tarball) |

### QUIC JA4_r breakdown

```
Chrome: q13d0311h3 _ 1301,1302,1303 _ 000a,000d,001b,002b,002d,0033,0039,44cd,fe0d _ 0403,0804,0401,0503,0805,0501,0806,0601,0201
curl:   q13d0313h3 _ 1301,1302,1303 _ 0005,000a,000d,0012,001b,002b,002d,0033,0039,44cd,fe0d _ [0904,0905,0906,]0403,…
```

Cipher hash middle component **matches** (`55b375c5d22e`). Divergence is **extension set** + **sig list** + **h3 SETTINGS/frames fingerprint**.

---

## Critical library behavior

`CURLOPT_HTTP3_SIG_HASH_ALGS` **does not override** `CURLOPT_SSL_SIG_HASH_ALGS` / `CURLOPT_SSL_SIGNATURE_ALGORITHMS` on this build: if TCP ML-DSA is set, **QUIC also advertises ML-DSA**.

Therefore for **h3** hops (Google Search document):

- Do **not** set ML-DSA on `ssl_sig_hash_algs`.
- Use classic list only.

Koko `applyChromeTlsKnobs` is **version-aware**: ML-DSA only when `ProfileHttpVersion == .h2` and target is chrome150.

---

## Why cookies looked like the answer

Mature Profile 45 jar → SERP on hop-1 (trust bypass).  
Chrome cold **without** cookies → SERP.  
So cookie is a **crutch**, not the cold-path root. Remaining score gap is below HTTP headers — now localized to **QUIC/H3 fingerprint**.

---

## What still needs vendor / fork work

| Gap | Fix layer | Notes |
|-----|-----------|-------|
| QUIC ext **0005 + 0012** present | BoringSSL / curl-impersonate QUIC ClientHello template | Chrome omits status_request + SCT on QUIC |
| Trailing sig **0201** | Optional | Chrome has it; low priority vs ext set |
| **h3 GREASE + PRIORITY_UPDATE 0x0f0700** | Re-apply `vendor/curl-impersonate-patches/koko-h3-fingerprint-*.patch` on v2.0.0rc3 build | Stock release tarball lacks frames; `h3_text` misses `GREASE\|984832` |
| ECH on QUIC | CLI works with `--ech true --doh-url …`; multi crashes | Secondary; ECH alone did not unlock SERP earlier |

---

## Koko code changes from this spike

1. `http.zig` `applyChromeTlsKnobs(…, version)` — ML-DSA **only on h2**.  
2. **H3 knobs (setopt, stock v2.0.0rc3):** disable `TLS_SIGNED_CERT_TIMESTAMPS` + `TLS_STATUS_REQUEST`; set SSL/HTTP3 sig list to classic + `rsa_pkcs1_sha1`.  
3. Verified via C probe against browserleaks: **QUIC JA4 + ja4_r exact match** Chrome 150:
   - `q13d0311h3_55b375c5d22e_653d80c3fe9d`
4. `h3_text` still missing control `GREASE|984832` (PRIORITY_UPDATE frame); stock prebuilt cannot emit it without source rebuild.

### Cold Google after QUIC JA4 match

| Client | QUIC JA4 | Google empty-jar |
|--------|----------|------------------|
| Chrome 150 | match | **SERP** |
| libcurl setopts (above) | **match** | still **knitsail** ~91 KB |
| Koko cold (same knobs) | h3 hop | still **knitsail** |

**Conclusion:** browserleaks QUIC JA4 parity is **necessary but not sufficient** for Google Search cold. Remaining candidates: H3 PRIORITY_UPDATE `0x0f0700`, ECH on google.com, QUIC transport params, or non-fingerprint signals.

---

## Gate for “cold Search unlocked”

Empty-jar Google hop-1:

- protocol **h3**
- QUIC JA4 = Chrome `q13d0311h3_55b375c5d22e_653d80c3fe9d` ✅ (achieved)
- h3_text includes `GREASE|984832` (optional remaining)
- htmlLen **> ~250 KB**, no knitsail ❌ (still open)


## Update 2026-07-17 evening — H3 PRIORITY_UPDATE rebuild

Ported Koko patches onto **lexiforest v2.0.0rc3** source tree (file rename `curl_ngtcp2.c` → `cf-ngtcp2.c`):

| Component | Change |
|-----------|--------|
| nghttp3 | `nghttp3_conn_submit_grease`, `nghttp3_conn_submit_chrome_priority_update`, empty-frame writer |
| curl `cf-ngtcp2.c` | After control stream bind: GREASE frame + PRIORITY_UPDATE type `0x0f0700` data `u=0, i` |
| openssl | Prefer `STRING_HTTP3_SIG_HASH_ALGS` on QUIC; omit SCT/status_request on QUIC (already) |

### browserleaks (`curl_chrome150 --http3`)

| Signal | Chrome 150 target | After rebuild |
|--------|-------------------|---------------|
| QUIC JA4 | `q13d0311h3_55b375c5d22e_653d80c3fe9d` | **match** |
| h3_text | `…GREASE\|GREASE\|984832\|m,a,s,p` | **match** on `/fp` |

### Cold Google empty jar (Koko serve)

Still **knitsail** ~91 KB, hop-1 **h3**, Cookie=0, X-Client-Data present.

**Gate still open:** fingerprint parity (JA4 + PRIORITY_UPDATE) is **not sufficient** alone for cold SERP on this host/IP. Remaining candidates: ECH, QUIC transport parameters, connection coalescing / 0-RTT, or non-TLS signals.

Artifacts: `code-check/tmp/pure-cold-h3-priority/`
