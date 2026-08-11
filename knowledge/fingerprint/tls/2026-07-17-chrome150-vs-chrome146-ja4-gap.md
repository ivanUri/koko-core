# Chrome 150 vs curl-impersonate chrome146 — JA4 / sig-alg gap

> **Audience:** Koko engineers working on TLS impersonate / Google cold SERP.  
> **Artifacts:** `code-check/tmp/tls-chrome150-spike/` (peet.ws captures + `DIFF-SUMMARY.json`).

## Summary

Live capture on macOS arm64 (**Google Chrome 150.0.7871.129** vs vendored **`curl_chrome146`**) against `https://tls.peet.ws/api/all` shows a **narrow, structural TLS gap**:

- **Cipher suites** (non-GREASE) and **JA4 cipher hash** match: `8daaf6152771`.
- **HTTP/2 Akamai fingerprint** matches exactly: `52d84b11737d980aef856699f885ca86`.
- **Signature algorithms do not.** Chrome 150 prepends **ML-DSA** codes `0x0904`, `0x0905`, `0x0906` (IANA 2308–2310). That alone flips the **JA4 third component**.

So Koko can already match Chrome 150 on H2 SETTINGS/PRIORITY and most of ClientHello, but **cannot mint a Chrome-150 JA4** while still bound to curl-impersonate’s chrome146 profile. Header-only UA/`sec-ch-ua` alignment cannot close this.

Upstream agrees: [lexiforest/curl-impersonate#277](https://github.com/lexiforest/curl-impersonate/pull/277) adds `chrome149` as a clone of chrome146 and **deliberately omits Chrome 150** until `parse_sig_algs` / `kSignatureAlgorithmNames` support ML-DSA. PR #275 only bumped **BoringSSL to the Chrome 150 tree** — it did not ship a `chrome150` impersonate target.

---

## Problem

Cold Google SERP analysis already suspected “TLS below HTTP headers” after UA/brands/header-order work. The open question was whether chrome146 is “close enough” to Chrome 150 or whether a real ClientHello delta remains.

Observable need:

- Quantify JA3/JA4 / peetprint / sig-algs / H2 Akamai for **real Chrome 150 on this machine** vs **`vendor/curl-impersonate/curl_chrome146`**.
- Decide if a Koko-side profile alias (`chrome150 → chrome146`) is fine, or if fork work is required.

---

## Root Cause

Chrome 150 ClientHello **signature_algorithms** list is:

```
0x0904, 0x0905, 0x0906,
ecdsa_secp256r1_sha256, rsa_pss_rsae_sha256, rsa_pkcs1_sha256,
ecdsa_secp384r1_sha384, rsa_pss_rsae_sha384, rsa_pkcs1_sha384,
rsa_pss_rsae_sha512, rsa_pkcs1_sha512
```

chrome146 (curl-impersonate) is the **same list without the three ML-DSA codes**.

JA4 shape: `t13d…h2_<cipher_hash>_<sig_ext_hash>`

| Source | JA4 |
|--------|-----|
| curl_chrome146 | `t13d1516h2_8daaf6152771_d8a2da3f94cd` |
| Chrome 150 headless (no PSK ext) | `t13d1516h2_8daaf6152771_806a8c22fdea` |
| Chrome 150 headed (fresh profile) | `t13d1517h2_8daaf6152771_a87ad97598a9` |

- Middle hash **identical** → cipher suite set matches.
- Third hash **always differs** → sig algs.
- Headed `t13d1517` vs headless `t13d1516` is an **extra extension `0x0029` (pre_shared_key)** on headed samples (session/resumption surface). ML-DSA remains the stable product gap for impersonate.

Extension **order** permutes every connection (GREASE shuffle); do not treat order diffs as a version gap.

---

## Investigation

### Method

1. **chrome146:** `./vendor/curl-impersonate/curl_chrome146 -sS https://tls.peet.ws/api/all` (3 samples).
2. **Chrome 150 headless:** CDP `Page.navigate` → body text.
3. **Chrome 150 headed:** isolated `--user-data-dir`, CDP `Network.getResponseBody` on document navigation (avoids truncated `innerText` on large ECH fields).

Chrome binary: `/Applications/Google Chrome.app` → **150.0.7871.129**.

### Results matrix

| Signal | chrome146 | Chrome 150 | Verdict |
|--------|-----------|------------|---------|
| JA4 cipher hash | `8daaf6152771` | `8daaf6152771` | Match |
| JA4 full | `…_d8a2da3f94cd` | `…_806a8c22fdea` / `…_a87ad97598a9` | **Diff (sig / +psk)** |
| `signature_algorithms` | 8 classic | **ML-DSA + 8 classic** | **Primary gap** |
| Non-GREASE ciphers | TLS 1.3 AES/CHACHA + ECDHE… | same | Match |
| supported_groups | GREASE, X25519MLKEM768, X25519, P-256, P-384 | same | Match |
| ALPS `application_settings` (17613) | h2 | h2 | Match |
| H2 Akamai | `1:65536;2:0;4:6291456;6:262144\|15663105\|0\|m,a,s,p` | same | Match |
| JA3 hash | varies (permute) | varies | Not a stable compare |

### Artifacts

```
code-check/tmp/tls-chrome150-spike/
  DIFF-SUMMARY.json
  chrome146-peet-{1,2,3}.json
  chrome150-headless-peet.json
  chrome150-fresh-nav{1,2}.json
  chrome150-headed-peet.json
```

Reproduce:

```bash
# chrome146
./vendor/curl-impersonate/curl_chrome146 -sS https://tls.peet.ws/api/all | jq '.tls|{ja4,ja4_r,ja3_hash}, .http2.akamai_fingerprint_hash'

# Chrome 150: headless CDP or headed + Network.getResponseBody on same URL
```

---

## Solution / PoC B (verified 2026-07-17)

**PoC succeeded without a custom fork rebuild.**

### Recipe

```bash
# 1) curl-impersonate ≥ v2.0.0rc3 (BoringSSL chrome-150 + ML-DSA name table)
#    arm64 macOS release: curl-impersonate-v2.0.0rc3.arm64-macos.tar.gz
# 2) chrome146 base + runtime sig-alg list:
curl-impersonate --impersonate chrome146 \
  --signature-hashes 'mldsa44:mldsa65:mldsa87:ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha384:rsa_pkcs1_sha384:rsa_pss_rsae_sha512:rsa_pkcs1_sha512' \
  https://tls.peet.ws/api/all
```

Wrapper: `code-check/tmp/tls-chrome150-spike/curl_chrome150`  
Binaries: `code-check/tmp/tls-chrome150-spike/curl-v2rc3/`

### Match matrix (PoC vs Chrome 150 headless)

| Field | Result |
|-------|--------|
| `ja4` | **exact** `t13d1516h2_8daaf6152771_806a8c22fdea` |
| `ja4_r` | **exact** (incl. `0904,0905,0906,…`) |
| `peetprint_hash` | **exact** `67c3e9111bed9e7f03d2f21d6d88994b` |
| H2 Akamai hash | **exact** (already matched on chrome146) |
| 3× sample stability | JA4 stable |

Upstream already ships:

- `SSL_SIGN_ML_DSA_{44,65,87}` = `0x0904/05/06` in BoringSSL
- `kSignatureAlgorithmNames[]` entries `mldsa44/65/87` in curl.patch

**Koko vendor today (older dylib)** still errors: `Unknown signature hash algorithm: 'mldsa44'`. Must **upgrade vendor to ≥ v2.0.0rc3** (or rebuild current fork main) before `CURLOPT_SSL_SIG_HASH_ALGS` can accept ML-DSA.

### Koko wiring (applied 2026-07-17)

1. **Vendor** `vendor/curl-impersonate` → **v2.0.0rc3** (`curl 8.21.0-IMPERSONATE`) + `curl_chrome150` wrapper.
2. **`libcurl.zig`:** `CHROME150_SSL_SIG_HASH_ALGS = "mldsa44:mldsa65:mldsa87:" ++ CHROME146_…`
3. **`http.zig` `applyChromeTlsKnobs`:** after impersonate, set `ssl_sig_hash_algs` + `http3_sig_hash_algs` from transport target.
4. **`TransportProfile.Target.chrome150`:** `curlImpersonate() → "chrome146"`, `fromChromeMajor(>=150)`, UA Chrome/150 auto-maps.
5. **`CurlCliTransport`:** prefers `vendor/curl-impersonate/curl_chrome150`.

Headed Chrome often adds `0x0029` PSK → `t13d1517…`; impersonate targets the **cold** headless/first-hop JA4 (`t13d1516…`).

---

## Lessons Learned

1. **JA4 third component is the smoking gun** for Chrome 150 vs 146 — not ciphers, not H2.
2. **chrome149 ≠ chrome150.** Skipping versions is fine when fingerprints are identical; 150 is a real TLS change (ML-DSA).
3. **Headed vs headless** can differ on PSK/`0x0029` (extension count in JA4 prefix). Always capture both when scoring “real Chrome.”
4. **Akamai H2 is already solved** for this pair — further cold-SERP demotion is not explained by H2 SETTINGS/WINDOW/header pseudo-order from the impersonate defaults alone.
5. Upstream commercial note: ML-DSA support is the gate; bumping BoringSSL alone (#275) is necessary but not sufficient for a `chrome150` target.
