# TLS impersonate — path to stable Google SERP

## Problem

Velora can load `google.com` and run JS (`navigator.webdriver: false`, UA/UA-CH match Chrome 120), but searches often redirect to:

`https://www.google.com/sorry/index?...`

The same `/sorry` page appears on **Playwright Chrome headless** from the same IP during automated tests. This is Google anti-bot, not a DOM/rendering bug.

## Root cause (confirmed)

| Layer | Velora today | What Google checks |
|-------|--------------|-------------------|
| JS fingerprint | OK (`chrome-macos-catalina` profile) | Secondary |
| HTTP headers (`Sec-CH-UA`, `Referer`, …) | OK (`Frame.headersForRequest`) | Secondary |
| **TLS handshake (JA3/JA4)** | **libcurl default** | **Primary** |
| IP / traffic reputation | Dev IP + repeated crawls | Primary |

HTTP stack: [`src/runtime/network/http.zig`](../src/runtime/network/http.zig) via libcurl.

On macOS arm64, Velora links vendored libcurl-impersonate **v2.0.0rc3** (`vendor/curl-impersonate/`, `curl 8.21.0-IMPERSONATE`).

- Base preset: `chrome146`
- **Chrome 150+ profiles:** same preset + runtime `CURLOPT_SSL_SIG_HASH_ALGS` with ML-DSA (`mldsa44:mldsa65:mldsa87:…`) → JA4 `t13d1516h2_8daaf6152771_806a8c22fdea` (matches headless Chrome 150)
- CLI wrapper: `vendor/curl-impersonate/curl_chrome150`

**Fork / source:** [lexiforest/curl-impersonate](https://github.com/lexiforest/curl-impersonate) (Velora also documents ivanUri fork for patch workflow). Docs: [curl-impersonate-fork.md](curl-impersonate-fork.md). Capture notes: `knowledge/fingerprint/tls/2026-07-17-chrome150-vs-chrome146-ja4-gap.md`.

## Spike procedure

1. Use vendored binaries under `vendor/curl-impersonate/` (or install the same release).
2. From the same machine/IP:

```bash
# Default curl — expect /sorry or redirect
curl -sI "https://www.google.com/search?q=test&hl=en" -A "Mozilla/5.0 ... Chrome/150..."

# curl-impersonate Chrome 150 JA4 (ML-DSA)
vendor/curl-impersonate/curl_chrome150 -sS "https://tls.peet.ws/api/all" | jq '.tls.ja4'
# expect: t13d1516h2_8daaf6152771_806a8c22fdea
```

3. If impersonate passes and default curl fails → TLS hypothesis confirmed.
4. Record JA3 fingerprints with a local tool (e.g. ja3er, tls.peet.ws) for both.

## Implementation options (Zig)

| Option | Effort | Notes |
|--------|--------|-------|
| Link curl-impersonate as HTTP backend | Medium | Fastest path to Google |
| BoringSSL + custom ClientHello | High | Full control, long project |
| Sidecar proxy (impersonate process) | Low | Operational complexity |

## Complementary work (not sufficient alone)

- Session/cookie persist (velora-sdk `session-state.ts`)
- Consent dismiss + `page.search()` type+Enter (velora-sdk `page.ts`)
- Residential proxy for production scale
- reCAPTCHA solver (fallback only)

## Runtime (no code-check harness)

Google document hops with `sg_ss=` use the `google-search` profile policy and
`scripts/chrome-google-transport.mjs` (real Chrome CDP network via **velora-sdk**). Build SDK first:

```bash
cd ../velora-sdk && npm install && npm run build
```

Prerequisite: Chrome with `--remote-debugging-port=9222`, or set `VELORA_CHROME_SPAWN=1`.