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

## Spike procedure

1. Install [curl-impersonate](https://github.com/lwthiker/curl-impersonate) (chrome120 profile).
2. From the same machine/IP:

```bash
# Default curl — expect /sorry or redirect
curl -sI "https://www.google.com/search?q=test&hl=en" -A "Mozilla/5.0 ... Chrome/120..."

# curl-impersonate — compare status/location
curl_chrome120 -sI "https://www.google.com/search?q=test&hl=en"
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

- Session/cookie persist ([`sdk/src/browser/session-state.ts`](../sdk/src/browser/session-state.ts))
- Consent dismiss + `page.search()` type+Enter ([`sdk/src/browser/page.ts`](../sdk/src/browser/page.ts))
- Residential proxy for production scale
- reCAPTCHA solver (fallback only)

## Test commands

```bash
npm run build:sdk
npm run test:site:google
```

Report fields in `code-check/tmp/google-search/report.json`:

- `engineOk` — homepage + search box
- `blockedSorry` — Google anti-bot
- `serpOk` — real results