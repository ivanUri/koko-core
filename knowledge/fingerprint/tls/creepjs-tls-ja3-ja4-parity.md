# TLS / JA3 / JA4 Parity (browserleaks)

## Summary

Koko's HTTP transport uses **curl-impersonate** (`chrome149` profile → nearest `chrome146` binary) so outbound TLS, HTTP/2, and HTTP/3 handshakes resemble real Chrome on macOS. Automated probes against [browserleaks.com](https://browserleaks.com/) show **JA4**, **JA3n** (normalized JA3), **Akamai HTTP/2 SETTINGS**, and **QUIC h3_hash / h3_text** match live Chrome. Raw **JA3** and **JA4_o** hashes differ connection-to-connection on **both** Koko and Chrome because Chrome 149 **permutes TLS extension order** per handshake—the same behavior curl-impersonate enables via `ssl_permute_extensions`.

For antidetect browsers, TLS fingerprinting sits below JavaScript: CreepJS and similar tools never see the handshake, but Google Search, Cloudflare, and payment gateways often score **JA4 before `navigator.webdriver`**. Koko treats TLS parity as a first-class profile concern alongside CreepJS section hashes.

---

## Problem

Early Koko builds used stock libcurl. Document navigation and CreepJS probes could look Chrome-like in JS, yet automated Google Search and `tls.browserleaks.com` comparisons showed:

- JA3 / JA4 strings that did not match Chrome 149 on the same machine
- Missing or wrong HTTP/2 **Akamai** fingerprint (SETTINGS frame layout)
- No HTTP/3 negotiation or mismatched **h3_text** when QUIC was enabled

Engineers also chased **raw JA3** equality and saw “flaky” results: one probe matched, the next did not, even against live Chrome. That created false regressions and tempted fixes (fixed extension order) that would **diverge** from real browser behavior.

---

## Root Cause

Three layers interact:

### 1. Transport stack choice

Koko's network layer (`src/runtime/network/http.zig`) delegates TLS to vendored **curl-impersonate** (`vendor/curl-impersonate/`, profile max `chrome146`). Profile field `transport.impersonate: chrome149` maps to `curl_easy_impersonate("chrome149")`, which resolves to the nearest supported impersonation profile. Stock curl cannot reproduce Chrome's cipher suites, extension set, GREASE, ALPS, or permuted extension ordering.

### 2. Extension permutation (JA3 confusion)

Chrome 149+ randomizes TLS ClientHello **extension order** per connection (`ssl_permute_extensions` in BoringSSL). curl-impersonate mirrors this with `CURLOPT_SSL_PERMUTE_EXTENSIONS` (wired in `applyChromeTlsKnobs`).

Implications:

| Signal | Stable across connections? | Use for pass/fail? |
|--------|---------------------------|-------------------|
| **JA4** | Yes (order-independent digest) | ✅ Yes |
| **JA3n** | Yes (normalized) | ✅ Yes |
| **JA3** (raw) | No on Chrome 149+ | ❌ No |
| **JA4_o** / **JA4_ro** | No (order-sensitive variants) | ❌ No |

Koko briefly tried a **fixed** `CURLOPT_TLS_EXTENSION_ORDER`. That matched one Chrome snapshot but failed the next Chrome connection—Chrome re-randomizes. Three back-to-back Chrome probes to `tls.browserleaks.com` produced **three different JA3 hashes**.

### 3. Reference tooling gap

The bundled `vendor/curl-impersonate/curl_chrome146` CLI shares Koko's transport layer. It also misses raw JA3 vs live Chrome on extension order but matches **JA4** and **h3_hash**. Comparing Koko only to a static JA3 string from an old blog post is misleading.

---

## Investigation

### Primary probe (Koko vs Chrome CDP)

```bash
cd /Users/huydev/Desktop/koko
zig build install
node scripts/cdp-browserleaks-compare.mjs --profile chrome-local-huys-macbook-pro
```

Endpoints:

- `https://tls.browserleaks.com/json` — TLS 1.2/1.3 ClientHello signals
- `https://quic.browserleaks.com/` — HTTP/3 / QUIC fingerprint

Report: `code-check/tmp/browserleaks-compare/report.json`

The script launches Koko and real Chrome with the same profile policy, fetches both endpoints, and diffs normalized fields.

### Results (2026-06-29, MacBook profile)

| Signal | Koko vs Chrome |
|--------|------------------|
| **JA4** (TLS) | ✅ match |
| **JA4_r** | ✅ match |
| **JA3n** (normalized) | ✅ match |
| **Akamai** (HTTP/2 SETTINGS) | ✅ match |
| **QUIC JA4** | ✅ match |
| **h3_hash / h3_text** | ✅ match |
| JA3 (raw order) | ❌ varies each connection on **both** |
| JA4_o / JA4_ro | ❌ order-variant (same reason) |

### Code trace

| Component | Path |
|-----------|------|
| HTTP client + impersonate init | `src/runtime/network/http.zig` |
| Chrome TLS knobs (ALPS, GREASE, permute) | `applyChromeTlsKnobs` in `http.zig` |
| libcurl CURLOPT surface | `src/support/sys/libcurl.zig` |
| Profile transport field | `browser/profiles/chrome-local-huys-macbook-pro.json` |

### Relationship to CreepJS

CreepJS does not hash TLS. CreepJS section parity (navigator, css, fonts, etc.) is necessary but **not sufficient** for sites that terminate TLS at the edge and score the handshake independently. See `knowledge/captcha/detection/google-search-investigation-journey.md` for how Google layers TLS with session cookies and JS fingerprint signals.

---

## Solution

1. **Keep curl-impersonate as the HTTP backend** with `transport.impersonate` aligned to the Chrome major version in the JS profile (e.g. Chrome 149 UA → `chrome149` impersonate).
2. **Gate TLS regression tests on JA4 + JA3n + H3**, not raw JA3. Document this in runbooks so CI does not flake on permutation.
3. **Do not disable `ssl_permute_extensions`** to chase raw JA3—that produces a static fingerprint no real Chrome 149 user exhibits.
4. **Re-run browserleaks compare** after curl-impersonate vendor bumps or Zig HTTP refactors.

`applyChromeTlsKnobs` sets ALPS, GREASE, and extension permutation to match the impersonate profile. HTTP/3 path negotiates **h3** with Chrome-identical `h3_text` when the profile enables QUIC.

---

## Lessons Learned

- **Modern bot detection prefers JA4 over JA3.** JA4 was designed to be stable despite extension reordering; JA3 was not.
- **Connection-level raw JA3 compare is flaky even when fingerprints are “the same browser.”** Treat mismatches as expected unless JA3n also diverges.
- **TLS and JS fingerprints must match the same Chrome major version.** A Chrome 149 navigator with a Chrome 120 TLS stack is a common antidetect failure mode.
- **Antidetect validation needs two probe classes:** CreepJS (in-page) and browserleaks / ja3er (transport). Koko's `cdp-browserleaks-compare.mjs` automates the second.
- **Disabling permute “to stabilize tests” ships a detectable artifact**—detectors can compare JA3 variance distribution against known Chrome builds.

---

## References

- `scripts/cdp-browserleaks-compare.mjs` — automated Koko vs Chrome TLS compare
- `docs/tls-impersonate.md` — Google `/sorry` investigation and spike procedure
- `src/runtime/network/http.zig` — `applyChromeTlsKnobs`, impersonate init
- `src/support/sys/libcurl.zig` — curl-impersonate CURLOPT bindings
- `vendor/curl-impersonate/` — vendored binaries and version pin
- [browserleaks TLS](https://tls.browserleaks.com/json) / [QUIC](https://quic.browserleaks.com/)
- `knowledge/captcha/detection/google-search-investigation-journey.md` — TLS as Layer 2 wire hygiene

---

## Related Knowledge

- [CreepJS probe display requirements (1680×1050)](../creepjs-probe-1680-display.md) — in-page fingerprint harness (orthogonal to TLS)
- [CreepJS navigator parity](../navigator/creepjs-navigator-parity.md) — UA / `userAgentData` must align with TLS Chrome version
- [Google Search investigation journey](../../captcha/detection/google-search-investigation-journey.md) — end-to-end antidetect probe stack