# Velora SDK

TypeScript-first CDP SDK for Velora. It talks directly to the Chrome DevTools Protocol over WebSocket and does not use Playwright or Puppeteer internals.

```ts
import { Browser } from "@velora/sdk";

const browser = await Browser.connect("http://127.0.0.1:9222");
const page = await browser.newPage();
await page.goto("https://example.com", { waitUntil: "load" });
console.log(await page.content());
await browser.close();
```

The SDK is intentionally close to CDP: it provides transport, sessions, browser/page helpers, wait strategies, network tracking and robust HTML extraction while staying lightweight.

## CLI

```bash
VELORA_CDP=http://127.0.0.1:9222 npx velora-fetch https://example.com --wait-until networkidle
```

## Modules

- `transport/`: WebSocket CDP transport with request ids, timeout handling and pending rejection on close.
- `cdp/`: client/session/event/error layer, including flattened session routing.
- `browser/`: lightweight Browser/Page/Context abstraction plus wait and network tracking.
- `cli/`: small fetch example built on the SDK, not on Playwright.
