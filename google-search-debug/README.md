# Google Search Debug

Workspace riêng cho bypass / trace Google Search. Tách khỏi `scripts/cdp-*` (CreepJS fingerprint).

Production path không đổi:

- Policy: `browser/policies/google-search.json`
- Transport: `scripts/chrome-google-transport.mjs` + `GoogleChromeTransport.zig`

## Quick start

```bash
# Compare Velora vs Chrome (cùng query)
npm run google:compare -- --query test --max-sec 60

# Sorry flag-parity (HTML + request graph + recaptcha chain)
npm run google:sorry-parity -- --query test --max-sec 30

# Trace một bên
npm run google:trace -- --engine chrome --query test --chrome-spawn
npm run google:trace -- --engine velora --profile chrome-local-huys-macbook-pro --query test

# Export HTML + hidden inputs
node google-search-debug/scripts/export-response.mjs --engine velora --query test
```

## Chrome prerequisites

**Real Google Chrome only** — not Chromium, not Playwright. Compare/trace scripts spawn Chrome by default (`assertGoogleChromeBin` + `assertGoogleChromeCdp`).

Optional attach to an already-running Google Chrome:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222
npm run google:compare -- --query test --chrome-attach --chrome-endpoint http://127.0.0.1:9222
```

## Output

Reports → `google-search-debug/tmp/` (gitignored)

## Layout

| Path | Role |
|------|------|
| `lib/capture-search.mjs` | CDP capture: network, DOM, fp inject logs |
| `lib/inject-fingerprint.js` | Pre-document hook (fetch, canvas, webgl, rects) |
| `lib/parse-serp.mjs` | URL/DOM analysis + diff |
| `scripts/compare-search.mjs` | Velora vs Chrome |
| `scripts/trace-search.mjs` | Single engine trace |
| `scripts/export-response.mjs` | HTML export |
| `scripts/get-renderer-pid.mjs` | Tab lookup for Frida |
| `frida/` | Native hooks (Phase 2) |

## Timeout

SERP probes default **60s** (`--max-sec`). Khác rule 20s của CreepJS probes.

## Frida

See [frida/README.md](frida/README.md).