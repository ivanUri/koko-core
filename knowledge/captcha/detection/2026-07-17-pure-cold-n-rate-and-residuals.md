# Pure cold path: N× rate, validation A/B, ECH, H3 PRIORITY residual

> **Date:** 2026-07-17  
> **Goal:** Unlock Google Search SERP on **empty jar** without Chrome cookies or Chrome sidecar.  
> **Artifacts:** `code-check/tmp/pure-n-rate/`

## Experiments run

| Experiment | Method | n | SERP rate | Result |
|------------|--------|--:|----------:|--------|
| Baseline empty jar | Velora serve, Cookie=0, h3 hop-1 | 4 | **0%** | all `knitsail_bootstrap` ~91 KB |
| X-Browser-Validation = Chrome live | `VELORA_X_BROWSER_VALIDATION=uemYFgH1pQp+…` | 3 | **0%** | still knitsail; wire shows override |
| CLI ECH+DoH | `curl_chrome150 --http3 --ech true --doh-url …` | 1 | 0% | knitsail ~91 KB (same as no-ECH) |
| CLI no-ECH h3 | `curl_chrome150 --http3` | 1 | 0% | knitsail ~91 KB |
| Fat X-Client-Data (HAR sei) | 40B multi-field protobuf | 3 | **0%** | on wire; still knitsail |
| Fat XCD + HAR validation | `DuYb5KQuki…` | 2 | **0%** | knitsail |
| Short XCD control | `CLaAywE=` | 2 | **0%** | knitsail |
| HAR-shaped cold CH | `VELORA_COLD_FULL_CH=1` + fat XCD + 7871.115 | 3 | **0%** | Downlink/RTT/form-factors on wire; knitsail |

Hop-1 constants across pure trials: **protocol=h3**, **cookieBytes=0**, brands 150. HAR learnings applied 2026-07-17 evening — **HTTP header surface alone still insufficient**.

## Closed pure deltas (not sufficient alone)

| Signal | Status vs cold Chrome |
|--------|------------------------|
| TCP JA4 / ML-DSA | match (earlier) |
| QUIC JA4 | match `q13d0311h3_55b375c5d22e_653d80c3fe9d` |
| Header order / brands / full-version | match (115 from live HAR Chrome) |
| X-Browser-Validation exact digest | **ruled out** (override A/B) |
| Fat vs short X-Client-Data | **ruled out** as sole unlock (both knitsail) |
| Downlink/RTT + form-factors on cold | **ruled out** alone (`VELORA_COLD_FULL_CH`) |
| OpenSERP-style URL params | ruled out (raw-url-ab) |
| ECH on hop-1 | ruled out alone |
| H3 GREASE frame | present |
| H3 PRIORITY type 0x0f0700 | written to outq; browserleaks may still omit `984832` |

## Code added for pure R&D

1. **`VELORA_X_BROWSER_VALIDATION`** / **`VELORA_X_CLIENT_DATA`** env overrides in `XBrowser.zig`.
2. **`VELORA_COLD_FULL_CH=1`** in `HttpProfile.zig` — sei-hop CH shape on cold docs.
3. **Harness** `code-check/tmp/pure-n-rate/run-pure-n.mjs`.
4. Profile **uaFullVersion `150.0.7871.115`** (live Chrome HAR build).
5. HAR extract: `code-check/tmp/chrome-har-sei-hop.json`.

## Remaining pure residuals (ordered)

1. **QUIC transport parameters / 0-RTT / preconnect** (below HTTP headers).
2. browserleaks `984832` vs Chrome packet capture (secondary fingerprint).
3. **IP / residential proxy N×** interaction.
4. Capture true cold omnibox HAR (HAR on disk was **sei replace**, not blank→search).

## Product gate (unchanged)

Empty-jar pure SERP still **open**. Production unlock remains:

- Chrome-issued cookie jar (guest Profile 57+ works), or  
- `--google-chrome-transport` hop-1 sidecar.

## Commands

```bash
# N× pure cold
node code-check/tmp/pure-n-rate/run-pure-n.mjs --n 5 --tag baseline

# Validation override A/B
VELORA_X_BROWSER_VALIDATION='uemYFgH1pQp+sN1z7tIZXI0g3PI=' \
  node code-check/tmp/pure-n-rate/run-pure-n.mjs --n 3 --tag val-chrome

# CLI ECH
vendor/curl-impersonate/curl_chrome150 --http3 --ech true \
  --doh-url https://cloudflare-dns.com/dns-query \
  -o /tmp/g.html -w '%{size_download}\n' \
  'https://www.google.com/search?q=velora&hl=en'
```
