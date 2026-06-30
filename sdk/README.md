# Velora SDK

TypeScript-first CDP SDK for Velora. It talks directly to the Chrome DevTools Protocol over WebSocket and does not use Playwright or Puppeteer internals.

The public API is modeled after [Playwright](https://playwright.dev/docs/api/class-playwright) so automation scripts port with minimal changes.

```ts
import { Browser } from "@velora/sdk";

const browser = await Browser.connect("http://127.0.0.1:9222");
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await context.newPage();

await page.goto("https://example.com", { waitUntil: "domcontentloaded" });
console.log(await page.title(), await page.url());

// Locators (Playwright-style)
await page.getByRole("link", { name: "More information" }).click();
await page.getByLabel("Search").fill("velora browser");
await page.getByRole("button", { name: "Search" }).click();

// Selector shortcuts
await page.click("button.submit");
await page.fill('textarea[name="q"]', "velora browser");
await page.press("Enter");

await browser.close();
```

## Velora-only features (not in Playwright)

Velora adds an **LP CDP domain** and **agent-oriented APIs** for AI automation and high-density crawling.

### Launch with antidetect profile

```ts
import { Browser } from "@velora/sdk";

const launched = await Browser.launch({
  profile: "chrome-local-huys-macbook-pro",
  cookieJar: "browser/profiles/sessions/my-session-cookies.json",
});
const page = await launched.browser.newPage();
// ...
await launched.close();
```

Profiles bundle UA, Sec-CH-UA, canvas/audio/WebGL probes, fonts, and cookie seeds — see `browser/profiles/`.

### AI extraction (token-efficient)

```ts
const md = await page.markdown();
const tree = await page.semanticTree({ format: "text", maxDepth: 4 });
const meta = await page.getStructuredData();
const forms = await page.detectForms();
const links = await page.links();
```

### Backend-node agent actions

Semantic tree / interactive scans return stable `backendNodeId` handles. Use `NodeHandle` instead of fragile CSS when driving agents:

```ts
const [search] = await page.findElement({ role: "combobox", name: "search" });
const input = page.node(search.backendNodeId!);
await input.fill("velora browser");

const submit = await page.waitForSelectorHandle('input[name="btnK"]');
await submit.click();
```

### Google SERP agent workflow

```ts
const serp = await page.searchGoogle({ query: "zig language tutorial", limit: 5 });
console.log(serp.results); // top organic { title, url }
```

Includes TTFX probe, block detection (`/sorry`, captcha), and `pathHint` diagnostics.

### Crawl extract + session persistence

```ts
import { createCrawlWorker, captureSessionState, restoreSessionState } from "@velora/sdk";

const worker = await createCrawlWorker("http://127.0.0.1:9222");
const result = await worker.crawl({ url: "https://en.wikipedia.org/wiki/Earth" });
// result.ttfexMs, result.extractMs, result.title, ...

const state = await captureSessionState(page, "https://example.com");
await restoreSessionState(page, state);
```

### Velora `waitUntil: "done"`

Default navigation wait (also MCP default): load + network idle + document complete. Stricter than Playwright `networkidle`.

```ts
await page.goto(url, { waitUntil: "done" });
```

### Proactive JavaScript dialogs

Pre-arm alert/confirm/prompt responses before triggering JS (Velora headless auto-dismiss breaks reactive CDP):

```ts
await page.armDialog({ accept: true, promptText: "hello" });
await page.evaluate("prompt('Name?')");
```

## API map (Playwright → Velora SDK)

| Playwright | Velora SDK | Notes |
|------------|------------|-------|
| `chromium.connectOverCDP()` | `Browser.connect()` | WebSocket CDP endpoint |
| `browser.newContext()` | `browser.newContext()` | Client-side page grouping |
| `context.newPage()` | `context.newPage()` | |
| `context.cookies()` | `context.cookies()` | |
| `context.addCookies()` | `context.addCookies()` | |
| `context.clearCookies()` | `context.clearCookies()` | |
| `context.addInitScript()` | `context.addInitScript()` | |
| `page.goto()` | `page.goto()` | `waitUntil`: none, commit, domcontentloaded, load, networkidle |
| `page.reload()` | `page.reload()` | |
| `page.goBack()` / `goForward()` | `page.goBack()` / `goForward()` | Via `history.back()` / `forward()` |
| `page.title()` / `url()` | `page.title()` / `url()` | |
| `page.locator()` | `page.locator()` | CSS selector |
| `page.getByRole()` | `page.getByRole()` | |
| `page.getByText()` | `page.getByText()` | |
| `page.getByLabel()` | `page.getByLabel()` | |
| `page.getByPlaceholder()` | `page.getByPlaceholder()` | |
| `page.getByAltText()` | `page.getByAltText()` | |
| `page.getByTitle()` | `page.getByTitle()` | |
| `page.getByTestId()` | `page.getByTestId()` | `data-testid` attribute |
| `locator.click()` | `locator.click()` | |
| `locator.fill()` | `locator.fill()` | |
| `locator.hover()` | `locator.hover()` | |
| `locator.check()` / `uncheck()` | `locator.check()` / `uncheck()` | |
| `locator.selectOption()` | `locator.selectOption()` | |
| `locator.textContent()` | `locator.textContent()` | |
| `locator.count()` / `first()` / `nth()` | same | |
| `page.click()` / `fill()` | `page.click()` / `fill()` | Selector sugar |
| `page.type()` | `page.type()` | Alias: `locator.fill()` |
| `page.press()` | `page.press()` | CDP `Input.dispatchKeyEvent` |
| `page.waitForSelector()` | `page.waitForSelector()` | |
| `page.waitForNavigation()` | `page.waitForNavigation()` | |
| `page.waitForURL()` | `page.waitForURL()` | string or RegExp |
| `page.waitForFunction()` | `page.waitForFunction()` | |
| `page.evaluate()` | `page.evaluate()` | |
| `page.content()` | `page.content()` | Single round-trip HTML |
| `page.screenshot()` | `page.screenshot()` | PNG/JPEG via CDP |
| `page.pdf()` | `page.pdf()` | |
| `page.addInitScript()` | `page.addInitScript()` | |
| `page.setViewportSize()` | `page.setViewportSize()` | |
| `page.search()` | `page.search()` | Velora helper: goto search page + type + Enter |
| `page.extract()` | `page.extract()` | Velora crawler helper (TTFX + structured extract) |
| `captureSessionState()` | `captureSessionState()` | Cookies + storage snapshot |
| `restoreSessionState()` | `restoreSessionState()` | |

### Velora-only SDK APIs

| API | Description |
|-----|-------------|
| `Browser.launch()` | Spawn Velora with `--browser-profile` / `--cookie-jar` |
| `page.agent` / `LPClient` | Low-level `LP.*` CDP namespace |
| `page.markdown()` | Token-efficient page text |
| `page.semanticTree()` | Pruned a11y DOM for LLMs |
| `page.getStructuredData()` | JSON-LD, OpenGraph, meta |
| `page.detectForms()` | Form schema + field `backendNodeId` |
| `page.getInteractiveElements()` | Clickable/focusable inventory |
| `page.findElement()` | Find by role/name → `backendNodeId` |
| `page.node()` / `NodeHandle` | Stable backend-node actions |
| `page.waitForSelectorHandle()` | CSS wait → `NodeHandle` |
| `page.searchGoogle()` | Google SERP extract + block detect |
| `page.armDialog()` | `LP.handleJavaScriptDialog` pre-arm |
| `waitUntil: "done"` | Velora parse + network idle wait |

### Not in SDK (use CDP client or MCP)

- `expect()` assertions — use your test runner (Node `assert`, Vitest, etc.)
- `page.route()` / request interception
- `frameLocator()` / iframe switching
- `keyboard` / `mouse` standalone objects
- `browser.newBrowserCDPSession()` tracing APIs
- `getByRole` with full accessibility tree parity (SDK uses DOM heuristics)

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
- `browser/`: Browser/Page/Context/Locator, wait strategies, network tracking, crawl helpers.
- `cli/`: `velora-fetch` built on the SDK.

## Build

```bash
npm run build
# or from repo root:
npm run build:sdk
```