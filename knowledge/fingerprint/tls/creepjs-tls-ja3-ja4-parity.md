# TLS / JA3 / JA4 parity (browserleaks)

## Summary

Velora's curl-impersonate transport (`chrome149` → `chrome146`) matches **real Chrome** on primary TLS/QUIC fingerprint signals: **JA4**, **JA3n**, **Akamai HTTP/2**, and **HTTP/3 (h3_hash / h3_text)**. Raw **JA3** and **JA4_o** differ per connection because Chrome 149 **permutes TLS extension order** on each handshake — same as curl-impersonate with `ssl_permute_extensions`.

---

## Probe

```bash
cd /Users/huydev/Desktop/velora
zig build install
node scripts/cdp-browserleaks-compare.mjs --profile chrome-local-huys-macbook-pro
```

Endpoints: `https://tls.browserleaks.com/json`, `https://quic.browserleaks.com/`

Report: `code-check/tmp/browserleaks-compare/report.json`

---

## Results (2026-06-29, MacBook profile)

| Signal | Velora vs Chrome |
|--------|------------------|
| **JA4** (TLS) | ✅ match |
| **JA4_r** | ✅ match |
| **JA3n** (normalized) | ✅ match |
| **Akamai** (HTTP/2 SETTINGS) | ✅ match |
| **QUIC JA4** | ✅ match |
| **h3_hash / h3_text** | ✅ match |
| JA3 (raw order) | ❌ varies each connection on **both** |
| JA4_o / JA4_ro | ❌ order-variant (same reason) |

Profile: `transport.impersonate: chrome149` → `curl_easy_impersonate("chrome149")` maps to nearest **chrome146** binary.

Stack: `src/runtime/network/http.zig` → `applyChromeTlsKnobs` (ALPS, GREASE, `ssl_permute_extensions`).

---

## Root cause of JA3 mismatch confusion

1. **`ssl_permute_extensions = 1`** — intentional; mirrors Chrome and curl-impersonate chrome146.
2. **Fixed `CURLOPT_TLS_EXTENSION_ORDER`** was tried — matched one Chrome snapshot but **broke** parity on the next Chrome connection (Chrome re-randomizes).
3. Three back-to-back Chrome probes to `tls.browserleaks.com` produced **three different JA3 hashes**.

**Implication:** Gate on **JA4 + JA3n + H3**, not raw JA3, for pass/fail.

---

## curl-chrome146 reference gap

Bundled `vendor/curl-impersonate/curl_chrome146` CLI also misses raw JA3 vs live Chrome (extension order / permute seed), but matches **JA4** and **h3_hash**. Velora and curl share the same transport layer.

---

## Lessons

- Modern bot detection increasingly uses **JA4** over JA3.
- Permuted extensions mean connection-level JA3 compare is flaky even when fingerprints are “the same browser.”
- Do not disable permute to chase raw JA3 — that diverges from Chrome behavior.
- HTTP/3 path is healthy: Velora negotiates **h3** with Chrome-identical `h3_text`.

---

## References

- `scripts/cdp-browserleaks-compare.mjs`
- `docs/tls-impersonate.md`
- `src/support/sys/libcurl.zig` — curl-impersonate CURLOPT surface
- `knowledge/captcha/detection/google-search-signal-inventory.md` — TLS layer in Google scoring