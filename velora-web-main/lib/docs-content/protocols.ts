import type { DocPageMap } from "./types";

export const protocolPages: DocPageMap = {
  cdp: {
    slug: "cdp",
    title: "CDP server",
    description: "Chrome DevTools Protocol server for WebSocket automation clients.",
    categoryId: 3,
    content: `
<p>Velora implements a <strong>CDP-compatible runtime</strong> so standard automation clients can attach over WebSocket without custom drivers.</p>

<h2>Starting the server</h2>
<p>For everyday use, prefer <code>Browser.launch()</code> from the SDK — see <a href="/docs/quickstart">Quick start</a>. Run a standalone server when you need a long-lived CDP endpoint:</p>
<pre><code>velora serve --host 127.0.0.1 --port 9222</code></pre>
<p>From a dev checkout: <code>zig build run -- serve --host 127.0.0.1 --port 9222</code></p>

<h2>HTTP discovery</h2>
<table>
  <thead><tr><th>Endpoint</th><th>Purpose</th></tr></thead>
  <tbody>
    <tr><td><code>GET /json/version</code></td><td>Browser metadata + WebSocket debugger URL</td></tr>
    <tr><td><code>GET /json/list</code></td><td>List open page targets</td></tr>
    <tr><td><code>GET /json/new</code></td><td>Create new page target</td></tr>
  </tbody>
</table>

<h2>WebSocket session</h2>
<p>Clients connect to the <code>webSocketDebuggerUrl</code> from <code>/json/version</code>. Messages follow standard CDP JSON-RPC framing with method names like <code>Page.navigate</code>, <code>Runtime.evaluate</code>, <code>DOM.getDocument</code>.</p>

<h2>Flattened target tracking</h2>
<p>The Velora SDK enables flattened session routing by default on <code>Browser.connect()</code> — multiple targets can share one WebSocket with session IDs, matching modern Chromium CDP behavior.</p>

<h2>Standard domains</h2>
<ul>
  <li><code>Page</code> — navigation, screenshots, PDF</li>
  <li><code>Runtime</code> — JavaScript evaluation</li>
  <li><code>DOM</code> — node queries, performSearch</li>
  <li><code>Input</code> — keyboard and mouse dispatch</li>
  <li><code>Network</code> — request tracking</li>
</ul>

<h2>Velora-specific domain</h2>
<p>The custom <code>LP</code> namespace provides agent-oriented APIs. See <a href="/docs/lp-domain">LP CDP domain</a>.</p>

<h2>Third-party clients</h2>
<p>Any CDP client can connect — including Playwright <code>chromium.connectOverCDP()</code>, Puppeteer, or raw WebSocket scripts. For Playwright-shaped ergonomics, prefer the Velora SDK.</p>
`,
  },

  serve: {
    slug: "serve",
    title: "Run CDP server",
    description: "Launch Velora as a long-lived Chrome DevTools Protocol server.",
    categoryId: 3,
    content: `
<p>A standalone CDP server is useful for <strong>shared dev infrastructure</strong>, multi-client attachment, or manual debugging. For scripts and tests, <code>Browser.launch()</code> is simpler — it spawns Velora, waits for CDP, and connects in one call.</p>

<h2>Start the server</h2>
<pre><code>velora serve --host 127.0.0.1 --port 9222</code></pre>

<p>From a source checkout after <a href="/docs/build">building</a>:</p>
<pre><code>zig-out/bin/velora serve --host 127.0.0.1 --port 9222</code></pre>

<h2>Discovery endpoints</h2>
<ul>
  <li><code>GET /json/version</code> — browser version and WebSocket debugger URL</li>
  <li><code>GET /json/list</code> — open page targets</li>
  <li><code>GET /json/new</code> — create a new page target</li>
</ul>

<pre><code>curl http://127.0.0.1:9222/json/version
curl http://127.0.0.1:9222/json/list</code></pre>

<h2>Connect clients</h2>
<pre><code>import { Browser } from "@velora/sdk";
const browser = await Browser.connect("http://127.0.0.1:9222");</code></pre>

<h2>Profiles and cookies</h2>
<pre><code>velora serve \\
  --host 127.0.0.1 --port 9222 \\
  --browser-profile chrome-macos-catalina \\
  --cookie-jar browser/profiles/sessions/my-session-cookies.json</code></pre>

<p>See <a href="/docs/profiles">Profiles &amp; fingerprints</a> and <a href="/docs/multi-session">Multi-session runtime</a> for scaling patterns.</p>
`,
  },

  mcp: {
    slug: "mcp",
    title: "MCP tools",
    description: "Model Context Protocol integration for AI agents in Cursor and other MCP hosts.",
    categoryId: 3,
    content: `
<p>Velora implements <strong>MCP (Model Context Protocol)</strong> so AI agents can browse, extract, and act on pages through standardized tools — without writing custom CDP scripts for every workflow.</p>

<h2>Launch MCP server</h2>
<pre><code>zig-out/bin/velora mcp --browser-profile chrome-macos-catalina</code></pre>

<p>Cursor and other MCP hosts connect to the Velora MCP server and receive tools for navigation, extraction, and interaction.</p>

<h2>Tool semantics</h2>
<p>MCP tools mirror the SDK agent workflow ordering:</p>
<ol>
  <li>Navigate with <code>waitUntil: "done"</code> (default)</li>
  <li><code>LP.getSemanticTree</code> — pruned accessibility DOM for LLMs</li>
  <li><code>LP.detectForms</code> — form schema with <code>backendNodeId</code></li>
  <li><code>LP.fillNode</code> / <code>LP.clickNode</code> — stable backend-node actions</li>
  <li><code>LP.getMarkdown</code> — token-efficient page text</li>
</ol>

<h2>SDK parity</h2>
<p>The SDK example <code>sdk/examples/agent-semantic.mjs</code> runs the same agent loop without Cursor — useful for CI smoke tests. Cursor users should prefer <code>velora mcp</code> for daily agent work.</p>

<h2>When to use MCP vs SDK</h2>
<table>
  <thead><tr><th>Use MCP when</th><th>Use SDK when</th></tr></thead>
  <tbody>
    <tr><td>AI agent in Cursor/IDE</td><td>Programmatic test suites</td></tr>
    <tr><td>Exploratory browsing</td><td>CI pipelines and benchmarks</td></tr>
    <tr><td>No TypeScript project</td><td>Custom orchestration logic</td></tr>
  </tbody>
</table>

<h2>Implementation</h2>
<p>MCP server code lives in <code>src/protocols/mcp/</code> — router, tools, resources, and protocol handlers.</p>
`,
  },

  "lp-domain": {
    slug: "lp-domain",
    title: "LP CDP domain",
    description: "Velora's custom CDP namespace for AI extraction and stable backend-node actions.",
    categoryId: 3,
    content: `
<p><code>LP.*</code> is Velora's custom CDP domain for <strong>agent-oriented automation</strong> — token-efficient extraction, semantic DOM, and stable <code>backendNodeId</code> handles that survive better than fragile CSS selectors.</p>

<h2>Extraction APIs</h2>
<table>
  <thead><tr><th>CDP method</th><th>SDK equivalent</th><th>Description</th></tr></thead>
  <tbody>
    <tr><td><code>LP.getMarkdown</code></td><td><code>page.markdown()</code></td><td>Token-efficient page text</td></tr>
    <tr><td><code>LP.getSemanticTree</code></td><td><code>page.semanticTree()</code></td><td>Pruned a11y DOM for LLMs</td></tr>
    <tr><td><code>LP.getStructuredData</code></td><td><code>page.getStructuredData()</code></td><td>JSON-LD, OpenGraph, meta</td></tr>
    <tr><td><code>LP.detectForms</code></td><td><code>page.detectForms()</code></td><td>Form schema + field IDs</td></tr>
    <tr><td><code>LP.getInteractiveElements</code></td><td><code>page.getInteractiveElements()</code></td><td>Clickable/focusable inventory</td></tr>
  </tbody>
</table>

<h2>Node actions</h2>
<table>
  <thead><tr><th>CDP method</th><th>SDK equivalent</th></tr></thead>
  <tbody>
    <tr><td><code>LP.fillNode</code></td><td><code>page.node(id).fill()</code></td></tr>
    <tr><td><code>LP.clickNode</code></td><td><code>page.node(id).click()</code></td></tr>
    <tr><td><code>LP.hoverNode</code></td><td><code>page.node(id).hover()</code></td></tr>
    <tr><td><code>LP.pressKey</code></td><td><code>page.node(id).press()</code></td></tr>
    <tr><td><code>LP.selectOptionNode</code></td><td><code>page.node(id).selectOption()</code></td></tr>
    <tr><td><code>LP.setCheckedNode</code></td><td><code>page.node(id).check()</code> / <code>uncheck()</code></td></tr>
    <tr><td><code>LP.getNodeDetails</code></td><td><code>page.waitForSelectorHandle()</code></td></tr>
    <tr><td><code>LP.handleJavaScriptDialog</code></td><td><code>page.armDialog()</code></td></tr>
  </tbody>
</table>

<h2>Agent workflow example</h2>
<pre><code>const [search] = await page.findElement({ role: "combobox", name: "search" });
const input = page.node(search.backendNodeId!);
await input.fill("velora browser");

const submit = await page.waitForSelectorHandle('input[name="btnK"]');
await submit.click();</code></pre>

<h2>Navigation wait</h2>
<p><code>waitUntil: "done"</code> is the MCP default and LP-aware navigation wait — stricter than Playwright <code>networkidle</code>.</p>

<h2>Known limitations</h2>
<ul>
  <li><code>LP.clickNode</code> can hang on some submit buttons that trigger full navigation</li>
  <li>Do not infer click health from fill health — different synchronization paths</li>
</ul>

<p>Handlers implemented in <code>src/protocols/cdp/domains/lp.zig</code>.</p>
`,
  },

  profiles: {
    slug: "profiles",
    title: "Profiles & fingerprints",
    description: "Browser profiles for consistent UA, Sec-CH-UA, canvas, WebGL, fonts, and cookies.",
    categoryId: 3,
    content: `
<p>Velora <strong>browser profiles</strong> bundle fingerprint signals — user agent, Client Hints, canvas/audio/WebGL probes, fonts, voices, and cookie seeds — so automation sessions present consistent identity across runs.</p>

<h2>Profile location</h2>
<pre><code>browser/profiles/
  chrome-macos-catalina.json
  chrome-macos-sonoma.json
  chrome-windows-11.json
  chrome-local-huys-macbook-pro.json
  assets/          # per-profile probe baselines
  sessions/        # persisted cookie jars</code></pre>

<h2>Profile structure</h2>
<p>Each profile JSON includes:</p>
<ul>
  <li><code>navigator</code> — userAgent, platform, hardwareConcurrency, languages</li>
  <li><code>userAgentData</code> — Sec-CH-UA brands and platform metadata</li>
  <li><code>screen</code> — viewport and color depth</li>
  <li><code>webgl</code>, <code>canvas</code>, <code>audio</code> — probe references into <code>assets/</code></li>
  <li><code>policies</code> — e.g. <code>google-search</code> transport rules</li>
</ul>

<h2>Launch with profile</h2>
<pre><code># CDP server
zig-out/bin/velora serve \\
  --browser-profile chrome-macos-catalina \\
  --host 127.0.0.1 --port 9222

# SDK
const launched = await Browser.launch({
  profile: "chrome-macos-catalina",
  cookieJar: "browser/profiles/sessions/my-session-cookies.json",
});</code></pre>

<h2>Cookie persistence</h2>
<p>Use <code>--cookie-jar</code> to read/write session cookies across runs. Pair with <code>captureSessionState()</code> / <code>restoreSessionState()</code> for storage snapshots.</p>

<h2>Fingerprint probes</h2>
<table>
  <thead><tr><th>Probe</th><th>Command</th></tr></thead>
  <tbody>
    <tr><td>CreepJS vs Chrome</td><td><code>npm run test:creepjs:compare</code></td></tr>
    <tr><td>CreepJS local sections</td><td><code>npm run test:creepjs:local</code></td></tr>
    <tr><td>BrowserLeaks</td><td><code>npm run test:browserleaks</code></td></tr>
    <tr><td>Profile CDP smoke</td><td><code>npm run test:profile -- --profile chrome-macos-catalina</code></td></tr>
  </tbody>
</table>

<h2>Google Search policy</h2>
<p>Profiles with <code>google-search</code> policy use real Chrome network transport via <code>scripts/chrome-google-transport.mjs</code>. See repo <code>docs/tls-impersonate.md</code> and <code>google-search-debug/</code>.</p>
`,
  },
};