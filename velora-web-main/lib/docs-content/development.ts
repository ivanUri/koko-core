import type { DocPageMap } from "./types";

export const developmentPages: DocPageMap = {
  requirements: {
    slug: "requirements",
    title: "Requirements (Zig, V8)",
    description: "Toolchain and system dependencies for building Velora.",
    categoryId: 6,
    content: `
<p>Velora requires a specific toolchain stack. Versions are pinned for reproducible builds.</p>

<h2>Required</h2>
<table>
  <thead><tr><th>Dependency</th><th>Version / notes</th></tr></thead>
  <tbody>
    <tr><td>Zig</td><td><strong>0.15.2</strong> — other versions may fail to compile</td></tr>
    <tr><td>V8</td><td>Linked at build time — platform setup in build docs</td></tr>
    <tr><td>libcurl</td><td>Network stack for page loads</td></tr>
    <tr><td>Rust toolchain</td><td>Required native dependencies</td></tr>
    <tr><td>Node.js</td><td>SDK, CLI, benchmarks, and code-check scripts</td></tr>
  </tbody>
</table>

<h2>Optional (benchmarks)</h2>
<ul>
  <li>Playwright Chromium — <code>npx playwright install chromium</code></li>
  <li>npm dependencies — <code>npm install</code> at repo root</li>
</ul>

<h2>Platform notes</h2>
<ul>
  <li><strong>macOS arm64</strong> — primary development platform (Apple Silicon)</li>
  <li><strong>Linux</strong> — supported with platform-specific V8 setup</li>
  <li>First build can take several minutes while V8 and deps compile</li>
</ul>

<h2>Verify installation</h2>
<pre><code>zig version    # expect 0.15.2
zig build
zig-out/bin/velora --help
node --version
npm run build:sdk</code></pre>
`,
  },

  build: {
    slug: "build",
    title: "Build from source",
    description: "Compile the Velora browser runtime with Zig — for engine contributors, not everyday SDK users.",
    categoryId: 6,
    content: `
<p>Building Velora from source is for <strong>engine development and contributors</strong>. If you only want to automate pages or run agents, use the <a href="/docs/quickstart">Quick start</a> with the SDK and a prebuilt <code>velora</code> binary — no compiler required.</p>

<h2>Prerequisites</h2>
<ul>
  <li><strong>Zig 0.15.2</strong> — pinned version; other Zig releases may not compile</li>
  <li><strong>V8</strong> — JavaScript engine linked at build time</li>
  <li><strong>libcurl</strong> — network stack for page loads</li>
  <li><strong>Rust toolchain</strong> — required native dependencies in the build graph</li>
  <li><strong>Node.js</strong> — for the TypeScript SDK and benchmark scripts</li>
</ul>
<p>See <a href="/docs/requirements">Requirements</a> for the full toolchain list.</p>

<h2>Clone and build</h2>
<pre><code>git clone https://github.com/ivanUri/velora
cd velora
zig build</code></pre>

<p>On success:</p>
<pre><code>zig-out/bin/velora</code></pre>

<h2>Verify</h2>
<pre><code>zig-out/bin/velora --help
zig build run -- --help</code></pre>

<h2>Build the SDK</h2>
<pre><code>npm run build:sdk</code></pre>

<p>After building, <code>Browser.launch()</code> finds <code>zig-out/bin/velora</code> automatically when run from the repo.</p>

<h2>Common issues</h2>
<ul>
  <li><strong>Wrong Zig version</strong> — install exactly 0.15.2</li>
  <li><strong>Missing V8</strong> — follow platform-specific setup in the repo build docs</li>
  <li><strong>Slow first build</strong> — V8 compilation can take several minutes on first run</li>
</ul>
`,
  },

  "code-check": {
    slug: "code-check",
    title: "code-check tests",
    description: "Lifecycle tests, fingerprint suite, and site integration scripts.",
    categoryId: 6,
    content: `
<p><code>code-check/</code> is Velora's integration and regression test infrastructure — separate from unit tests in <code>src/testing/</code>.</p>

<h2>Directory layout</h2>
<pre><code>code-check/
  lifecycle/    # Browser lifecycle and realm correctness
  suite/        # Fingerprint / bot-detection regression
  local/        # Offline HTML fixtures (CreepJS, engine probe)
  sites/        # Per-site integration scripts
  features/     # Per-engine feature checks (canvas, webgl, worker)
  bench/        # Benchmark runners and report renderers</code></pre>

<h2>Lifecycle tests</h2>
<p>Exercise navigation ordering, realm isolation, WindowProxy semantics, and teardown correctness. Critical for automation stability — run before releases.</p>

<h2>Fingerprint suite</h2>
<pre><code>npm run test:creepjs:compare
npm run test:creepjs:local
npm run test:browserleaks
npm run test:profile -- --profile chrome-macos-catalina</code></pre>

<h2>Site integrations</h2>
<p>Per-site scripts in <code>code-check/sites/</code> for real-world regression (Turnstile, Google SERP skeleton, etc.).</p>

<h2>Local fixtures</h2>
<p>Offline HTML in <code>code-check/local/</code> and <code>velora-test/</code> — no network required for core probes.</p>

<h2>Benchmarks</h2>
<p>See <a href="/docs/reproduce">Reproduce locally</a> for <code>npm run bench:*</code> commands.</p>
`,
  },

  "cdp-probes": {
    slug: "cdp-probes",
    title: "CDP probes",
    description: "Profile smoke probes and CDP debugging scripts with timeout budgets.",
    categoryId: 6,
    content: `
<p>CDP probe scripts validate profile launches, navigation, and extraction paths against a running Velora server. They are the fastest way to debug regressions without full test suites.</p>

<h2>Profile CDP smoke</h2>
<pre><code>npm run test:profile -- --profile chrome-macos-catalina</code></pre>
<p>Runs <code>scripts/cdp-profile-probe.mjs</code> — navigates, extracts, and verifies CDP health for a profile.</p>

<h2>Probe timeout rule</h2>
<p>All <code>scripts/cdp-*.mjs</code> probes enforce a <strong>20 second maximum</strong> (<code>--max-sec</code>, default 20):</p>
<ul>
  <li><strong>&gt;20s = hang</strong> → SIGKILL velora, exit code 3, <code>[HANG]</code> marker</li>
  <li><strong>No retry</strong> on the same hung command</li>
  <li>Helper: <code>scripts/lib/cdp-probe-budget.mjs</code></li>
</ul>

<h2>Manual CDP inspection</h2>
<pre><code># Start server
zig build run -- serve --port 9222

# Check targets
curl http://127.0.0.1:9222/json/version
curl http://127.0.0.1:9222/json/list</code></pre>

<h2>Google offline fixtures</h2>
<p>Use <code>code-check/tmp/google-serp-skeleton.html</code> for offline Google SERP probes — not live google.com in CI.</p>

<h2>Connect with Playwright CDP</h2>
<p>For comparison debugging, attach Playwright directly:</p>
<pre><code>import { chromium } from "playwright";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");</code></pre>

<h2>When probes hang</h2>
<ol>
  <li>Check if Velora process is alive (<code>/json/version</code>)</li>
  <li>Kill stale <code>velora serve</code> processes</li>
  <li>Re-run with <code>--max-sec 20</code> — do not increase timeout to mask hangs</li>
  <li>File a bug with probe output and profile ID</li>
</ol>
`,
  },

  contributing: {
    slug: "contributing",
    title: "Contributing",
    description: "How to contribute to Velora, knowledge notes, and licensing.",
    categoryId: 6,
    content: `
<p>Velora is under active development. Contributions to engine correctness, protocol behavior, SDK ergonomics, and benchmarks are welcome.</p>

<h2>Getting started</h2>
<ol>
  <li>Fork / clone the repo</li>
  <li>Install toolchain — see <a href="/docs/requirements">Requirements</a></li>
  <li><code>zig build</code> and verify <code>zig-out/bin/velora</code></li>
  <li>Run relevant <code>code-check/</code> probes before submitting changes</li>
</ol>

<h2>Development priorities</h2>
<ul>
  <li>Browser lifecycle correctness</li>
  <li>Automation stability and anti-flake execution</li>
  <li>Realm and navigation semantics</li>
  <li>CDP behavior consistency</li>
  <li>MCP integration and agent tooling</li>
  <li>Multi-session runtime infrastructure</li>
</ul>

<h2>Knowledge notes</h2>
<p>After important fixes or discoveries, add an English note in <code>knowledge/</code>:</p>
<ul>
  <li>Template: <code>knowledge/_template.md</code></li>
  <li>Bugs: <code>knowledge/bugs/YYYY-MM-DD-*.md</code></li>
  <li>Publish to this blog: <code>npm run blog:publish -- &lt;path&gt;.md</code></li>
</ul>

<h2>SDK changes</h2>
<p>SDK changes should maintain Playwright API parity where claimed. Velora-only APIs belong behind <code>LP.*</code> or clearly marked SDK methods. Run SDK smoke tests after LP handler changes.</p>

<h2>Benchmarks</h2>
<p>Include benchmark results when claiming performance improvements. Run <code>npm run bench:compare:publish</code> and attach the generated report diff.</p>

<h2>License</h2>
<p>Velora is licensed under <strong>AGPL-3.0</strong>. See <code>LICENSE</code> and <code>LICENSING.md</code> in the repo. Commercial licensing inquiries: see <a href="/license">License page</a>.</p>

<h2>Security</h2>
<p>Report vulnerabilities privately to <code>security@velora.io</code> — do not file public issues. See <a href="/security">Security page</a>.</p>
`,
  },
};