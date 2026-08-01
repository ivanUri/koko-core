import type { DocPageMap } from "./types";

export const coreConceptPages: DocPageMap = {
  "why-not-chromium": {
    slug: "why-not-chromium",
    title: "Why not Chromium?",
    description: "Why Velora builds a lightweight automation runtime instead of inheriting the full Chromium stack.",
    categoryId: 2,
    content: `
<p>Chromium is an excellent desktop browser, but it was not designed as a small, embeddable automation runtime. Most browser automation systems inherit Chromium's full browser stack even when they only need programmable page execution.</p>

<h2>Costs of the Chromium model</h2>
<ul>
  <li><strong>Large runtime footprint</strong> for every browser instance</li>
  <li><strong>Higher memory and CPU overhead</strong> at scale</li>
  <li><strong>Complex process, sandbox, profile, and lifecycle behavior</strong></li>
  <li><strong>Slower cold starts</strong> and heavier deployment artifacts</li>
  <li><strong>Difficult deep customization</strong> below the automation API layer</li>
  <li>Architecture optimized for <strong>interactive browsing</strong>, not machine-driven execution</li>
</ul>

<h2>What Velora focuses on</h2>
<p>Velora is not trying to be a full desktop-browser replacement. It targets the subset automation systems need most:</p>
<ul>
  <li>Deterministic navigation</li>
  <li>DOM and Web API execution</li>
  <li>Protocol control (CDP, MCP)</li>
  <li>Lifecycle correctness</li>
  <li>Embeddable multi-session runtime behavior</li>
</ul>

<h2>Benchmark evidence</h2>
<p>On local fixtures, Velora navigation is ~4× faster than Playwright bundled Chromium; Wikipedia crawl shows ~3× lower RSS per page. See <a href="/docs/microbench">Microbench</a> and <a href="/docs/crawl-wikipedia">Wikipedia crawl</a>.</p>

<blockquote>Velora treats the browser as programmable infrastructure: smaller, easier to control, easier to embed, and better suited for AI-native workloads.</blockquote>

<h2>Trade-offs</h2>
<p>Velora prioritizes runtime correctness and controllable browser behavior over desktop-browser feature parity. Not every Chrome feature or site compatibility edge case is replicated — the goal is reliable automation infrastructure, not human browsing UX.</p>
`,
  },

  architecture: {
    slug: "architecture",
    title: "Architecture layers",
    description: "How Velora separates engine internals, runtime services, protocols, and public APIs.",
    categoryId: 2,
    content: `
<p>Velora separates browser execution into explicit runtime layers so engine internals stay isolated, protocols stay modular, and public APIs stay stable.</p>

<h2>Layer model</h2>
<pre><code>Core Engine → Runtime → Protocols → Adapters → Public API</code></pre>

<h2>Repository layout</h2>
<pre><code>src/
  core/         # Browser engine, DOM, parser, JS bindings, Web APIs
  runtime/      # Lifecycle, services, network, storage, telemetry
  protocols/    # CDP and MCP protocol implementations
  adapters/     # CLI and server adapters
  public/       # Stable public API surface
  support/      # Shared utilities
  testing/      # Isolated test infrastructure

sdk/
  src/          # TypeScript CDP SDK and CLI helpers

code-check/
  lifecycle/    # Browser lifecycle and realm correctness tests
  suite/        # Fingerprint / bot-detection regression suite
  local/        # Offline HTML fixtures
  sites/        # Per-site integration scripts
  features/     # Per-engine feature checks</code></pre>

<h2>Core engine</h2>
<p>Low-level browser execution: HTML/CSS parsing, DOM, JavaScript via V8 bindings, and Web API implementations. Written in Zig for predictable memory behavior and embeddability.</p>

<h2>Runtime services</h2>
<p>Navigation lifecycle, network stack (libcurl), storage, telemetry, and multi-session coordination. This layer enforces ordering guarantees critical for automation.</p>

<h2>Protocols</h2>
<ul>
  <li><strong>CDP</strong> — Chrome DevTools Protocol domains including custom <code>LP.*</code> namespace</li>
  <li><strong>MCP</strong> — Model Context Protocol tools for AI agent integration</li>
</ul>

<h2>Adapters</h2>
<p>CLI entrypoints (<code>serve</code>, <code>mcp</code>) and server mode that expose protocols over HTTP/WebSocket.</p>

<h2>SDK</h2>
<p>TypeScript client that speaks CDP directly. Modules: <code>transport/</code>, <code>cdp/</code>, <code>browser/</code>, <code>cli/</code>.</p>
`,
  },

  lifecycle: {
    slug: "lifecycle",
    title: "Lifecycle correctness",
    description: "Navigation ordering, realm isolation, and teardown semantics that make automation reliable.",
    categoryId: 2,
    content: `
<p>Reliable automation depends heavily on browser lifecycle behavior. Flaky tests and agent failures often trace back to navigation ordering, execution context stability, or teardown races — not selector bugs.</p>

<h2>What Velora focuses on</h2>
<ul>
  <li><strong>Navigation ordering</strong> — deterministic event sequence from commit through load</li>
  <li><strong>Realm isolation</strong> — separate JavaScript realms for iframes and workers</li>
  <li><strong>WindowProxy semantics</strong> — correct cross-frame object identity</li>
  <li><strong>Execution context stability</strong> — contexts survive microtasks across navigations where spec requires</li>
  <li><strong>Teardown correctness</strong> — clean shutdown without hung CDP sessions</li>
  <li><strong>Deterministic event ordering</strong> — predictable microtask scheduling</li>
</ul>

<h2>Why it matters for AI agents</h2>
<p>Agents issue rapid sequences of navigate → extract → act. If lifecycle events reorder or contexts invalidate mid-flight, extraction returns stale DOM or actions target destroyed nodes. Velora instruments lifecycle explicitly rather than inheriting desktop-browser heuristics.</p>

<h2>Testing</h2>
<p>The <code>code-check/lifecycle/</code> suite exercises realm and navigation edge cases. Run lifecycle probes as part of regression before releases.</p>

<h2>SDK interaction</h2>
<ul>
  <li><code>waitUntil: "done"</code> — Velora-specific wait: load + network idle + document complete</li>
  <li><code>page.armDialog()</code> — pre-arm JS dialogs before evaluation (headless auto-dismiss breaks reactive CDP)</li>
  <li><code>page.type()</code> / <code>page.press()</code> — avoid <code>form.submit()</code> context-destroy races</li>
</ul>

<h2>Known gaps</h2>
<p>Velora is under active development. Some click paths (<code>LP.clickNode</code>) can hang on buttons that trigger full navigation without predictable CDP lifecycle events — track separately from fill health.</p>
`,
  },

  "multi-session": {
    slug: "multi-session",
    title: "Multi-session runtime",
    description: "Run isolated browser processes for crawl workers, agent pools, and scalable automation.",
    categoryId: 2,
    content: `
<p>Velora supports <strong>multi-session browser execution</strong> — multiple isolated browser instances that can run concurrently without sharing process state.</p>

<h2>Process model</h2>
<p>Each <code>velora serve</code> instance is an independent browser process with its own memory, targets, and CDP endpoint. This differs from Chromium's multi-tab single-process model where tabs share a browser process tree.</p>

<h2>Crawl worker pattern</h2>
<pre><code># Worker 1
zig-out/bin/velora serve --port 9222 --browser-profile chrome-macos-catalina

# Worker 2
zig-out/bin/velora serve --port 9223 --browser-profile chrome-macos-catalina

# Worker N...
</code></pre>

<p>SDK crawl helper:</p>
<pre><code>import { createCrawlWorker } from "@velora/sdk";

const worker = await createCrawlWorker("http://127.0.0.1:9222");
const result = await worker.crawl({ url: "https://en.wikipedia.org/wiki/Earth" });
// result.ttfexMs, result.extractMs, result.title, ...</code></pre>

<h2>Benchmark architecture</h2>
<p>The Wikipedia crawl benchmark compares:</p>
<table>
  <thead><tr><th></th><th>Velora</th><th>Chromium</th></tr></thead>
  <tbody>
    <tr><td>Parallelism unit</td><td>8 isolated <code>velora serve</code> processes</td><td>8 tabs in 1 browser</td></tr>
    <tr><td>Peak processes (8 workers)</td><td>8</td><td>~15 (browser + renderers + utilities)</td></tr>
    <tr><td>RSS / page</td><td>~8.5 MiB</td><td>~29.9 MiB</td></tr>
    <tr><td>Sessions / GB</td><td>~9</td><td>~2</td></tr>
  </tbody>
</table>

<h2>When to use multi-session</h2>
<ul>
  <li>High-concurrency crawling with isolation</li>
  <li>Agent pools where one bad page must not crash others</li>
  <li>Memory-bounded density testing</li>
  <li>Per-tenant or per-profile session separation</li>
</ul>

<h2>Session persistence</h2>
<pre><code>import { captureSessionState, restoreSessionState } from "@velora/sdk";

const state = await captureSessionState(page, "https://example.com");
await restoreSessionState(page, state);</code></pre>
`,
  },
};