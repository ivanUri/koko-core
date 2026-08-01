import type { DocPageMap } from "./types";

export const sdkReferencePages: DocPageMap = {
  "browser-connect": {
    slug: "browser-connect",
    title: "Browser.connect()",
    description: "Attach to a running CDP server or launch Velora with Browser.launch().",
    categoryId: 4,
    content: `
<p>The SDK entry point is <code>Browser</code> — connect to an existing CDP server or spawn Velora with a profile.</p>

<h2>Browser.connect()</h2>
<pre><code>import { Browser } from "@velora/sdk";

const browser = await Browser.connect("http://127.0.0.1:9222");
const page = await browser.newPage();
await page.goto("https://example.com");
await browser.close();</code></pre>

<p>Equivalent to Playwright <code>chromium.connectOverCDP()</code>. Enables flattened target tracking by default.</p>

<h2>Browser.launch()</h2>
<p>Spawn Velora as a child process with profile and cookie jar — no manual <code>serve</code> step.</p>
<pre><code>const launched = await Browser.launch({
  profile: "chrome-macos-catalina",
  cookieJar: "browser/profiles/sessions/my-session-cookies.json",
});

const page = await launched.browser.newPage();
await page.goto("https://example.com");
await launched.close();</code></pre>

<h2>Contexts</h2>
<pre><code>const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
});
const page = await context.newPage();

// Cookies
const cookies = await context.cookies();
await context.addCookies([...]);
await context.clearCookies();

// Init scripts
await context.addInitScript("window.__VELORA__ = true");</code></pre>

<p>Contexts are client-side page groupings — useful for isolating cookies and init scripts across logical sessions.</p>

<h2>Crawl worker</h2>
<pre><code>import { createCrawlWorker } from "@velora/sdk";

const worker = await createCrawlWorker("http://127.0.0.1:9222");
const result = await worker.crawl({
  url: "https://en.wikipedia.org/wiki/Earth",
});
console.log(result.ttfexMs, result.title);</code></pre>

<h2>Performance notes</h2>
<ul>
  <li>Flattened session routing reduces WebSocket overhead for multi-target workflows</li>
  <li><code>NetworkTracker</code> prunes completed requests and resets on navigation</li>
</ul>
`,
  },

  "page-locators": {
    slug: "page-locators",
    title: "Page & Locators",
    description: "Playwright-style page methods, locators, and wait strategies.",
    categoryId: 4,
    content: `
<p>The SDK mirrors Playwright's page and locator API so existing automation scripts port with minimal edits.</p>

<h2>Navigation</h2>
<pre><code>await page.goto(url, { waitUntil: "domcontentloaded" });
await page.goto(url, { waitUntil: "done" }); // Velora-specific
await page.reload();
await page.goBack();
await page.goForward();</code></pre>

<p><code>waitUntil</code> options: <code>none</code>, <code>commit</code>, <code>domcontentloaded</code>, <code>load</code>, <code>networkidle</code>, <code>done</code>.</p>

<h2>Locators</h2>
<pre><code>await page.locator("button.submit").click();
await page.getByRole("button", { name: "Submit" }).click();
await page.getByText("Sign in").click();
await page.getByLabel("Email").fill("user@example.com");
await page.getByPlaceholder("Search...").fill("query");
await page.getByAltText("Logo").click();
await page.getByTitle("Close").click();
await page.getByTestId("submit-btn").click();</code></pre>

<h2>Locator actions</h2>
<pre><code>await locator.click();
await locator.fill("text");
await locator.hover();
await locator.check();
await locator.uncheck();
await locator.selectOption("value");
const text = await locator.textContent();
const count = await locator.count();
await locator.first().click();
await locator.nth(2).click();</code></pre>

<h2>Selector shortcuts</h2>
<pre><code>await page.click("button.submit");
await page.fill('textarea[name="q"]', "velora browser");
await page.press("Enter");
await page.type("input", "text"); // alias for fill</code></pre>

<h2>Wait strategies</h2>
<pre><code>await page.waitForSelector(".loaded");
await page.waitForNavigation();
await page.waitForURL(/dashboard/);
await page.waitForFunction(() => window.ready === true);</code></pre>

<p><code>waitForSelector()</code> uses <code>DOM.performSearch</code> when visibility is not required — faster for crawl workloads.</p>

<h2>Page utilities</h2>
<pre><code>const html = await page.content();
const title = await page.title();
const url = await page.url();
const png = await page.screenshot({ type: "png" });
const pdf = await page.pdf();
const result = await page.evaluate(() => document.title);</code></pre>
`,
  },

  "agent-apis": {
    slug: "agent-apis",
    title: "Agent extraction APIs",
    description: "Token-efficient extraction, semantic trees, NodeHandle, and Google SERP workflows.",
    categoryId: 4,
    content: `
<p>Velora-only SDK APIs live behind the <code>LP.*</code> CDP namespace — designed for AI agents and high-density crawling where Playwright's DOM queries are too verbose or fragile.</p>

<h2>Token-efficient extraction</h2>
<pre><code>const md = await page.markdown();
const tree = await page.semanticTree({ format: "text", maxDepth: 4 });
const meta = await page.getStructuredData();
const forms = await page.detectForms();
const links = await page.links();</code></pre>

<h2>NodeHandle (stable backend nodes)</h2>
<p>Semantic tree and form detection return <code>backendNodeId</code> handles — more stable than CSS for agent loops.</p>
<pre><code>const [search] = await page.findElement({ role: "combobox", name: "search" });
const input = page.node(search.backendNodeId!);
await input.fill("velora browser");

const submit = await page.waitForSelectorHandle('input[name="btnK"]');
await submit.click();</code></pre>

<h2>NodeHandle actions</h2>
<table>
  <thead><tr><th>Method</th><th>CDP backing</th></tr></thead>
  <tbody>
    <tr><td><code>fill(text)</code></td><td><code>LP.fillNode</code></td></tr>
    <tr><td><code>click()</code></td><td><code>LP.clickNode</code> ⚠️ hang risk on some buttons</td></tr>
    <tr><td><code>hover()</code></td><td><code>LP.hoverNode</code></td></tr>
    <tr><td><code>press(key)</code></td><td><code>LP.pressKey</code></td></tr>
    <tr><td><code>selectOption(v)</code></td><td><code>LP.selectOptionNode</code></td></tr>
    <tr><td><code>check()</code> / <code>uncheck()</code></td><td><code>LP.setCheckedNode</code></td></tr>
  </tbody>
</table>

<h2>Google SERP workflow</h2>
<pre><code>const serp = await page.searchGoogle({
  query: "zig language tutorial",
  limit: 5,
});
console.log(serp.results); // { title, url }[]
// Includes TTFX probe, block detection (/sorry, captcha), pathHint diagnostics</code></pre>

<h2>Session persistence</h2>
<pre><code>import { captureSessionState, restoreSessionState } from "@velora/sdk";

const state = await captureSessionState(page, "https://example.com");
await restoreSessionState(page, state);</code></pre>

<h2>JavaScript dialogs</h2>
<p>Pre-arm dialogs before triggering JS — headless auto-dismiss breaks reactive CDP:</p>
<pre><code>await page.armDialog({ accept: true, promptText: "hello" });
await page.evaluate("prompt('Name?')");</code></pre>

<h2>Crawl extract</h2>
<pre><code>const result = await page.extract();
// TTFX probe + structured extract optimized for crawlers</code></pre>
`,
  },

  "playwright-migration": {
    slug: "playwright-migration",
    title: "Playwright migration",
    description: "API mapping from Playwright to Velora SDK and known gaps.",
    categoryId: 4,
    content: `
<p>The Velora SDK public API is modeled after Playwright. Most scripts change only the import and connection line.</p>

<h2>Connection</h2>
<table>
  <thead><tr><th>Playwright</th><th>Velora SDK</th></tr></thead>
  <tbody>
    <tr><td><code>chromium.connectOverCDP(url)</code></td><td><code>Browser.connect(url)</code></td></tr>
    <tr><td><code>chromium.launch()</code></td><td><code>Browser.launch({ profile })</code></td></tr>
  </tbody>
</table>

<h2>Core API map</h2>
<table>
  <thead><tr><th>Playwright</th><th>Velora SDK</th><th>Notes</th></tr></thead>
  <tbody>
    <tr><td><code>browser.newContext()</code></td><td><code>browser.newContext()</code></td><td>Client-side grouping</td></tr>
    <tr><td><code>context.newPage()</code></td><td><code>context.newPage()</code></td><td></td></tr>
    <tr><td><code>page.goto()</code></td><td><code>page.goto()</code></td><td>+ <code>waitUntil: "done"</code></td></tr>
    <tr><td><code>page.locator()</code></td><td><code>page.locator()</code></td><td>CSS selector</td></tr>
    <tr><td><code>page.getByRole()</code></td><td><code>page.getByRole()</code></td><td>DOM heuristics</td></tr>
    <tr><td><code>locator.click()</code></td><td><code>locator.click()</code></td><td></td></tr>
    <tr><td><code>page.evaluate()</code></td><td><code>page.evaluate()</code></td><td></td></tr>
    <tr><td><code>page.screenshot()</code></td><td><code>page.screenshot()</code></td><td>PNG/JPEG via CDP</td></tr>
    <tr><td><code>page.pdf()</code></td><td><code>page.pdf()</code></td><td></td></tr>
    <tr><td><code>page.waitForSelector()</code></td><td><code>page.waitForSelector()</code></td><td>Uses performSearch</td></tr>
  </tbody>
</table>

<h2>Velora-only additions</h2>
<table>
  <thead><tr><th>API</th><th>Description</th></tr></thead>
  <tbody>
    <tr><td><code>page.markdown()</code></td><td>Token-efficient page text</td></tr>
    <tr><td><code>page.semanticTree()</code></td><td>Pruned a11y DOM</td></tr>
    <tr><td><code>page.findElement()</code></td><td>Role/name → backendNodeId</td></tr>
    <tr><td><code>page.node()</code></td><td>NodeHandle actions</td></tr>
    <tr><td><code>page.searchGoogle()</code></td><td>SERP extract + block detect</td></tr>
    <tr><td><code>page.armDialog()</code></td><td>Pre-arm JS dialogs</td></tr>
    <tr><td><code>page.extract()</code></td><td>Crawler-optimized extract</td></tr>
    <tr><td><code>captureSessionState()</code></td><td>Cookies + storage snapshot</td></tr>
  </tbody>
</table>

<h2>Not in SDK (use CDP or MCP)</h2>
<ul>
  <li><code>expect()</code> assertions — use Vitest, Node assert, etc.</li>
  <li><code>page.route()</code> / request interception</li>
  <li><code>frameLocator()</code> / iframe switching</li>
  <li><code>keyboard</code> / <code>mouse</code> standalone objects</li>
  <li><code>browser.newBrowserCDPSession()</code> tracing APIs</li>
  <li>Full <code>getByRole</code> accessibility tree parity</li>
</ul>

<h2>Migration checklist</h2>
<ol>
  <li>Replace <code>import { chromium }</code> with <code>import { Browser }</code></li>
  <li>Start Velora CDP server or use <code>Browser.launch()</code></li>
  <li>Swap <code>connectOverCDP</code> → <code>Browser.connect</code></li>
  <li>Optionally adopt <code>waitUntil: "done"</code> for stricter navigation</li>
  <li>Replace brittle selectors with <code>NodeHandle</code> for agent flows</li>
</ol>
`,
  },
};