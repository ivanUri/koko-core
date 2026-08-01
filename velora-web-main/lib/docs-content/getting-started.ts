import type { DocPageMap } from "./types";

export const gettingStartedPages: DocPageMap = {
  quickstart: {
    slug: "quickstart",
    title: "Quick start",
    description:
      "Install the SDK, launch or connect to Velora, and automate a page in minutes — no compiler required.",
    categoryId: 1,
    content: `
<p>You do <strong>not</strong> need to compile Velora to get started. Install the TypeScript SDK, point it at a <code>velora</code> binary (local path or team-provided runtime), and write automation scripts. Building from source is only for engine contributors — see <a href="/docs/build">Build from source</a>.</p>

<h2>What you need</h2>
<ul>
  <li><strong>Node.js 18+</strong></li>
  <li>A <strong>Velora runtime binary</strong> — from your team, a local build, or <code>zig-out/bin/velora</code> if you already have the repo checked out</li>
</ul>

<h2>1. Install the SDK</h2>
<pre><code>npm install @velora/sdk</code></pre>

<h2>2. Launch and automate (recommended)</h2>
<p><code>Browser.launch()</code> spawns Velora, waits for CDP, and connects — one call, no manual <code>serve</code> step.</p>
<pre><code>import { Browser } from "@velora/sdk";

const launched = await Browser.launch({
  binary: "/path/to/velora", // required unless zig-out/bin/velora exists in repo root
});

const page = await launched.browser.newPage();
await page.goto("https://example.com", { waitUntil: "domcontentloaded" });
console.log(await page.title());

await launched.close();</code></pre>

<p>If you cloned the Velora repo and already ran <code>zig build</code>, omit <code>binary</code> — the SDK defaults to <code>zig-out/bin/velora</code> relative to the repo.</p>

<h2>3. Or connect to a running server</h2>
<p>When Velora is already running (shared dev server, CI, or cloud runtime):</p>
<pre><code>const browser = await Browser.connect("http://127.0.0.1:9222");
const page = await browser.newPage();
await page.goto("https://example.com");
await browser.close();</code></pre>

<p>Start a server manually only if you need long-lived infrastructure — see <a href="/docs/serve">Run CDP server</a>.</p>

<h2>4. Fetch a page from the terminal</h2>
<p>No script required — useful for smoke tests and pipelines:</p>
<pre><code>VELORA_CDP=http://127.0.0.1:9222 npx velora-fetch https://example.com</code></pre>

<h2>5. AI agents in Cursor</h2>
<p>For MCP-based agent workflows, run the MCP server and connect from your IDE:</p>
<pre><code>velora mcp --browser-profile chrome-macos-catalina</code></pre>
<p>Details: <a href="/docs/agents-mcp">Agents &amp; MCP</a>.</p>

<h2>Choose your path</h2>
<table>
  <thead><tr><th>Goal</th><th>Start here</th></tr></thead>
  <tbody>
    <tr><td>Automation scripts / tests</td><td><a href="/docs/sdk-quickstart">SDK quickstart</a></td></tr>
    <tr><td>AI agent in Cursor</td><td><a href="/docs/agents-mcp">Agents &amp; MCP</a></td></tr>
    <tr><td>Shell / CI one-liner</td><td><a href="/docs/velora-fetch">velora-fetch CLI</a></td></tr>
    <tr><td>Engine development</td><td><a href="/docs/build">Build from source</a></td></tr>
  </tbody>
</table>
`,
  },

  "sdk-quickstart": {
    slug: "sdk-quickstart",
    title: "SDK quickstart",
    description: "Connect to Velora and automate pages with the TypeScript SDK.",
    categoryId: 1,
    content: `
<p>The Velora SDK (<code>@velora/sdk</code>) talks directly to CDP over WebSocket. The public API is modeled after Playwright so scripts port with minimal changes.</p>

<h2>Install</h2>
<pre><code>npm install @velora/sdk</code></pre>

<h2>Launch Velora from Node</h2>
<p>Prefer <code>Browser.launch()</code> over manual <code>serve</code> — the SDK picks a free port, spawns the binary, and waits for CDP readiness.</p>
<pre><code>import { Browser } from "@velora/sdk";

const launched = await Browser.launch({
  binary: "/path/to/velora",
  profile: "chrome-macos-catalina", // optional antidetect profile
});

const page = await launched.browser.newPage();
await page.goto("https://example.com", { waitUntil: "domcontentloaded" });
console.log(await page.title(), await page.url());

await launched.close();</code></pre>

<h2>Connect to an existing CDP server</h2>
<pre><code>const browser = await Browser.connect("http://127.0.0.1:9222");
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
});
const page = await context.newPage();
await page.goto("https://example.com");
await browser.close();</code></pre>

<h2>Locators (Playwright-style)</h2>
<pre><code>await page.getByRole("link", { name: "More information" }).click();
await page.getByLabel("Search").fill("velora browser");
await page.getByRole("button", { name: "Search" }).click();</code></pre>

<h2>Velora-only navigation wait</h2>
<p><code>waitUntil: "done"</code> is stricter than Playwright <code>networkidle</code> — load + network idle + document complete. Default for MCP and crawl helpers.</p>
<pre><code>await page.goto(url, { waitUntil: "done" });</code></pre>

<h2>Next steps</h2>
<ul>
  <li><a href="/docs/browser-connect">Browser.connect()</a> — connection options and launch</li>
  <li><a href="/docs/agent-apis">Agent extraction APIs</a> — markdown, semantic tree, NodeHandle</li>
  <li><a href="/docs/playwright-migration">Playwright migration</a> — full API map</li>
</ul>
`,
  },

  "agents-mcp": {
    slug: "agents-mcp",
    title: "Agents & MCP",
    description: "Use Velora as an AI agent browser through MCP in Cursor and other hosts.",
    categoryId: 1,
    content: `
<p>The fastest way to use Velora as an <strong>AI agent browser</strong> is through <strong>MCP (Model Context Protocol)</strong> — no TypeScript project required. Cursor and other MCP hosts connect to Velora tools for navigate, extract, and act.</p>

<h2>Start the MCP server</h2>
<pre><code>velora mcp --browser-profile chrome-macos-catalina</code></pre>

<p>Point your MCP host at the Velora server. In Cursor, configure the Velora MCP server in your MCP settings.</p>

<h2>Typical agent loop</h2>
<p>MCP tools follow the same order as the SDK agent examples:</p>
<ol>
  <li>Navigate with <code>waitUntil: "done"</code> (default)</li>
  <li><code>LP.getSemanticTree</code> — pruned accessibility DOM for the LLM</li>
  <li><code>LP.detectForms</code> — form fields with stable <code>backendNodeId</code></li>
  <li><code>LP.fillNode</code> / <code>LP.clickNode</code> — act on nodes by ID, not fragile CSS</li>
  <li><code>LP.getMarkdown</code> — token-efficient page text for summarization</li>
</ol>

<h2>SDK parity without Cursor</h2>
<p>To verify the same semantics in CI:</p>
<pre><code>node sdk/examples/agent-semantic.mjs --profile chrome-macos-catalina</code></pre>

<h2>When to use MCP vs SDK</h2>
<table>
  <thead><tr><th>MCP</th><th>SDK</th></tr></thead>
  <tbody>
    <tr><td>Cursor / IDE agents</td><td>Test suites and pipelines</td></tr>
    <tr><td>Exploratory browsing</td><td>Custom orchestration logic</td></tr>
    <tr><td>No npm project needed</td><td>Programmatic control from Node/TS</td></tr>
  </tbody>
</table>

<h2>Learn more</h2>
<ul>
  <li><a href="/docs/mcp">MCP tools</a> — protocol details and implementation</li>
  <li><a href="/docs/lp-domain">LP CDP domain</a> — extraction and NodeHandle APIs</li>
  <li><a href="/docs/agent-apis">Agent extraction APIs</a> — SDK equivalents</li>
</ul>
`,
  },

  "velora-fetch": {
    slug: "velora-fetch",
    title: "velora-fetch CLI",
    description: "Fetch pages and structured extracts from the terminal without writing automation scripts.",
    categoryId: 1,
    content: `
<p><code>velora-fetch</code> is a CLI built on the Velora SDK. It connects to a running CDP server and fetches page HTML or structured extracts — useful for quick probes, CI checks, and shell pipelines.</p>

<h2>Prerequisites</h2>
<p>Velora must be reachable over CDP. Either launch from the SDK first, or start a server:</p>
<pre><code># Option A: SDK launch (see Quick start)
# Option B: long-lived server
velora serve --host 127.0.0.1 --port 9222</code></pre>

<h2>Fetch HTML</h2>
<pre><code>VELORA_CDP=http://127.0.0.1:9222 npx velora-fetch https://example.com</code></pre>

<p>Default wait: <code>domcontentloaded</code>. HTML is written to stdout.</p>

<h2>Structured extract (JSON)</h2>
<pre><code>VELORA_CDP=http://127.0.0.1:9222 npx velora-fetch \\
  https://en.wikipedia.org/wiki/Earth --extract</code></pre>

<p>The extract path uses the SDK <code>page.extract()</code> helper — optimized for crawler workloads with TTFX probe and structured fields (title, links, etc.).</p>

<h2>Environment variables</h2>
<table>
  <thead><tr><th>Variable</th><th>Description</th></tr></thead>
  <tbody>
    <tr><td><code>VELORA_CDP</code></td><td>CDP HTTP endpoint (e.g. <code>http://127.0.0.1:9222</code>)</td></tr>
  </tbody>
</table>

<h2>When to use SDK instead</h2>
<ul>
  <li>Multi-step flows (login, form fill, click chains)</li>
  <li>Agent APIs (<code>semanticTree</code>, <code>NodeHandle</code>)</li>
  <li>Session state capture/restore</li>
  <li>Profile launch via <code>Browser.launch()</code></li>
</ul>
`,
  },
};