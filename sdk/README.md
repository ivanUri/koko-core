# Velora SDK

TypeScript-first CDP SDK for Velora. It talks directly to the Chrome DevTools Protocol over WebSocket and does not use Playwright or Puppeteer internals.

```ts
import { Browser } from "@velora/sdk";

const browser = await Browser.connect("http://127.0.0.1:9222");
const page = await browser.newPage();
await page.goto("https://example.com", { waitUntil: "domcontentloaded" });
console.log(await page.content());

// Form-style search: type + Enter (not address-bar SERP navigate)
await page.type('textarea[name="q"]', "velora browser");
await page.press("Enter");
// or: await page.search("https://www.bing.com/", "velora browser");

await browser.close();
```

## Performance notes

- `Browser.connect()` enables flattened target tracking by default.
- `page.content()` uses a single `Runtime.evaluate` round-trip.
- `page.extract()` is optimized for crawler workloads (TTFX probe + structured extract).
- `waitForSelector()` uses `DOM.performSearch` when visibility is not required.
- `NetworkTracker` prunes completed requests and resets on navigation.
- `page.type()` / `page.press()` / `page.search()` avoid `form.submit()` context-destroy races.

## CLI

```bash
# HTML (default wait: domcontentloaded)
VELORA_CDP=http://127.0.0.1:9222 npx velora-fetch https://example.com

# Structured extract (JSON)
VELORA_CDP=http://127.0.0.1:9222 npx velora-fetch https://en.wikipedia.org/wiki/Earth --extract
```

## Modules

- `transport/`: WebSocket CDP transport with request ids, timeout handling and pending rejection on close.
- `cdp/`: client/session/event/error layer, including flattened session routing.
- `browser/`: Browser/Page/Context, wait strategies, network tracking, crawl helpers.
- `cli/`: `velora-fetch` built on the SDK.

## Build

```bash
npm run build
# or from repo root:
npm run build:sdk
```