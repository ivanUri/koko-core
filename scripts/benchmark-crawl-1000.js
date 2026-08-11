#!/usr/bin/env node

/*
 * Deterministic crawl benchmark for the Koko CLI.
 *
 * Edit CONFIG to select the benchmark workload. The checked-in configuration
 * crawls 100 Vietnamese Wikipedia articles from the Wiki seed page.
 *
 * Examples:
 *   zig build -Doptimize=ReleaseFast
 *   node scripts/benchmark-crawl-1000.js
 *   node scripts/benchmark-crawl-1000.js
 */

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const defaultBinary = path.join(projectRoot, "zig-out", "bin", "koko");

// Persistent benchmark configuration. Change this block to change the default
// workload; command-line options remain available for one-off overrides.
const CONFIG = Object.freeze({
  count: 100,
  concurrency: 2,
  warmup: 0,
  urlsFile: "scripts/urls-wikipedia-100.txt",
  wikiSeed: null,
  outputDir: "tmp/benchmark-wikipedia-100",
  waitUntil: "domcontentloaded",
  waitMs: 5000,
  terminateMs: 15000,
  keepProfiles: false,
});

function usage() {
  return `Usage: node scripts/benchmark-crawl-1000.js [options]

Options:
  --count N           Number of pages (default: CONFIG.count).
  --concurrency N     Concurrent Koko processes (default: CONFIG.concurrency).
  --warmup N          Fixture warm-up pages, excluded from results (default: CONFIG.warmup).
  --urls FILE         One authorized http(s) URL per line; disables local fixture.
  --wiki-seed URL     Discover Vietnamese Wikipedia articles breadth-first from URL.
  --output-dir DIR    Result directory (default: CONFIG.outputDir).
  --wait-until EVENT  Koko wait target (default: CONFIG.waitUntil).
  --wait-ms N         Koko wait budget in milliseconds (default: CONFIG.waitMs).
  --terminate-ms N    Per-page hard deadline in milliseconds (default: CONFIG.terminateMs).
  --keep-profiles     Keep isolated per-worker profile directories for inspection.
  --help              Show this help.
`;
}

function positiveInt(value, option) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive integer`);
  }
  return parsed;
}

function nonNegativeInt(value, option) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${option} must be a non-negative integer`);
  }
  return parsed;
}

function parseArgs(argv) {
  const config = {
    ...CONFIG,
  };
  let countExplicit = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help") return { help: true };
    if (arg === "--keep-profiles") {
      config.keepProfiles = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
    switch (arg) {
      case "--count": config.count = positiveInt(value, arg); countExplicit = true; break;
      case "--concurrency": config.concurrency = positiveInt(value, arg); break;
      case "--warmup": config.warmup = nonNegativeInt(value, arg); break;
      case "--urls": config.urlsFile = value; break;
      case "--wiki-seed": config.wikiSeed = value; break;
      case "--output-dir": config.outputDir = value; break;
      case "--wait-until": config.waitUntil = value; break;
      case "--wait-ms": config.waitMs = positiveInt(value, arg); break;
      case "--terminate-ms": config.terminateMs = positiveInt(value, arg); break;
      default: throw new Error(`Unknown option: ${arg}`);
    }
  }
  config.countExplicit = countExplicit;
  return config;
}

async function discoverVietnameseWikipedia(seed, count) {
  const parsed = new URL(seed);
  if (parsed.hostname !== "vi.wikipedia.org" || !parsed.pathname.startsWith("/wiki/")) {
    throw new Error("--wiki-seed must be a vi.wikipedia.org/wiki/ article URL");
  }
  const initialTitle = decodeURIComponent(parsed.pathname.slice("/wiki/".length)).replaceAll("_", " ");
  if (!initialTitle) throw new Error("--wiki-seed must name an article");

  const seen = new Set();
  const pending = [initialTitle];
  const urls = [];
  while (pending.length && urls.length < count) {
    const title = pending.shift();
    if (seen.has(title)) continue;
    seen.add(title);
    urls.push(`https://vi.wikipedia.org/wiki/${encodeURIComponent(title.replaceAll(" ", "_"))}`);

    const api = new URL("https://vi.wikipedia.org/w/api.php");
    api.search = new URLSearchParams({
      action: "query",
      format: "json",
      prop: "links",
      plnamespace: "0",
      pllimit: "max",
      titles: title,
    }).toString();
    const response = await fetch(api, { headers: { "user-agent": "Koko benchmark URL discovery" } });
    if (!response.ok) throw new Error(`Wikipedia API returned HTTP ${response.status}`);
    const payload = await response.json();
    for (const page of Object.values(payload.query?.pages || {})) {
      for (const link of page.links || []) {
        if (typeof link.title === "string" && !seen.has(link.title)) pending.push(link.title);
      }
    }
  }
  if (urls.length < count) throw new Error(`Wikipedia discovery found only ${urls.length} articles`);
  return urls;
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}

function summarize(results, elapsedMs) {
  const succeeded = results.filter((result) => result.ok);
  const durations = succeeded.map((result) => result.elapsedMs);
  return {
    pages: results.length,
    succeeded: succeeded.length,
    failed: results.length - succeeded.length,
    successRate: results.length === 0 ? 0 : succeeded.length / results.length,
    elapsedMs,
    throughputPagesPerSecond: elapsedMs === 0 ? 0 : succeeded.length / (elapsedMs / 1000),
    latencyMs: {
      min: durations.length ? Math.min(...durations) : null,
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
      p99: percentile(durations, 0.99),
      max: durations.length ? Math.max(...durations) : null,
    },
  };
}

function loadUrls(file) {
  const absolute = path.resolve(projectRoot, file);
  const urls = fs.readFileSync(absolute, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  for (const url of urls) {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`URL must be http(s): ${url}`);
    }
  }
  if (urls.length === 0) throw new Error(`No URLs found in ${absolute}`);
  return { absolute, urls };
}

function createFixtureServer() {
  const server = http.createServer((request, response) => {
    const match = /^\/page\/(\d+)$/.exec(request.url || "");
    if (!match) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
      return;
    }
    const page = match[1];
    const rows = Array.from({ length: 40 }, (_, index) =>
      `<li data-row="${index}">fixture ${page}/${index}</li>`).join("");
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Koko crawl fixture ${page}</title></head><body><main id="content"><h1>Page ${page}</h1><ul>${rows}</ul></main><script>document.body.dataset.ready = String(document.querySelectorAll('li').length)</script></body></html>`;
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
      "content-length": Buffer.byteLength(html),
    });
    response.end(html);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function runPage(binary, config, url, worker, profileDir) {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const args = [
      "fetch",
      "--dump", "html",
      "--wait-until", config.waitUntil,
      "--wait-ms", String(config.waitMs),
      "--terminate-ms", String(config.terminateMs),
      // Each worker gets a separate profile. Ephemeral storage makes this a
      // crawl benchmark, not a SQLite writer-lock benchmark.
      "--storage-engine", "none",
      "--user-data-dir", profileDir,
      url,
    ];
    const child = spawn(binary, args, { cwd: projectRoot, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000).unref();
    }, config.terminateMs + 5000);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 4096) stderr += chunk.slice(0, 4096 - stderr.length);
    });
    child.once("error", (error) => finish({ error: error.message }));
    child.once("close", (code, signal) => finish({ code, signal }));

    function finish(exit) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        worker,
        url,
        elapsedMs: Math.round(performance.now() - startedAt),
        ok: exit.code === 0 && !exit.signal && !exit.error,
        exitCode: exit.code,
        signal: exit.signal,
        error: exit.error || (exit.code === 0 && !exit.signal ? null : stderr.trim() || `exit ${exit.signal || exit.code}`),
      });
    }
  });
}

async function runWorkers(binary, config, urls, profileRoot, progressLabel) {
  let next = 0;
  let completed = 0;
  const results = [];
  const workers = Array.from({ length: Math.min(config.concurrency, urls.length) }, async (_, worker) => {
    const profileDir = path.join(profileRoot, `worker-${worker + 1}`);
    fs.mkdirSync(profileDir, { recursive: true });
    while (true) {
      const index = next++;
      if (index >= urls.length) return;
      const result = await runPage(binary, config, urls[index], worker + 1, profileDir);
      results.push({ index, ...result });
      completed += 1;
      if (completed === urls.length || completed % 25 === 0) {
        process.stdout.write(`\r${progressLabel}: ${completed}/${urls.length}`);
      }
    }
  });
  await Promise.all(workers);
  process.stdout.write("\n");
  return results.sort((a, b) => a.index - b.index);
}

function markdownReport(report) {
  const { summary, config, source, environment } = report;
  const fmt = (value) => value === null ? "n/a" : String(value);
  const scopeNote = source.startsWith("local deterministic fixture")
    ? "The local fixture is deterministic; it does not represent internet latency, remote rate limits, or third-party anti-bot behavior."
    : "This is a live-network result and includes Wikipedia response time, remote rate limits, and changing page content.";
  return `# Koko crawl benchmark\n\n` +
    `- Run: ${report.startedAt}\n` +
    `- Source: ${source}\n` +
    `- Binary: \`${environment.binary}\`\n` +
    `- Platform: ${environment.platform}; Node ${environment.node}; ${environment.cpus} logical CPUs\n` +
    `- Config: ${config.count} pages, concurrency ${config.concurrency}, wait=${config.waitUntil}, wait-ms=${config.waitMs}, terminate-ms=${config.terminateMs}\n\n` +
    `| Metric | Result |\n|---|---:|\n` +
    `| Success | ${summary.succeeded}/${summary.pages} (${(summary.successRate * 100).toFixed(2)}%) |\n` +
    `| Wall time | ${(summary.elapsedMs / 1000).toFixed(2)} s |\n` +
    `| Throughput | ${summary.throughputPagesPerSecond.toFixed(2)} pages/s |\n` +
    `| Latency min / p50 / p95 / p99 / max | ${fmt(summary.latencyMs.min)} / ${fmt(summary.latencyMs.p50)} / ${fmt(summary.latencyMs.p95)} / ${fmt(summary.latencyMs.p99)} / ${fmt(summary.latencyMs.max)} ms |\n` +
    `| Failures | ${summary.failed} |\n\n` +
    `This measures one fresh Koko CLI process per page. ${scopeNote}\n`;
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  if (config.help) {
    process.stdout.write(usage());
    return;
  }
  const binary = path.resolve(process.env.KOKO_BINARY || defaultBinary);
  if (!fs.existsSync(binary)) throw new Error(`Koko binary not found: ${binary}\nBuild it with: zig build -Doptimize=ReleaseFast`);
  if (config.urlsFile && config.wikiSeed) throw new Error("Use either --urls or --wiki-seed, not both");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputDir = path.resolve(projectRoot, config.outputDir || path.join("tmp", `benchmark-crawl-${stamp}`));
  const profileRoot = path.join(outputDir, "profiles");
  fs.mkdirSync(outputDir, { recursive: true });

  let server;
  let source;
  let urls;
  try {
    if (config.wikiSeed) {
      urls = await discoverVietnameseWikipedia(config.wikiSeed, config.count);
      source = `Vietnamese Wikipedia breadth-first discovery from ${config.wikiSeed}`;
      fs.writeFileSync(path.join(outputDir, "urls.txt"), `${urls.join("\n")}\n`);
    } else if (config.urlsFile) {
      const loaded = loadUrls(config.urlsFile);
      if (!config.countExplicit) config.count = loaded.urls.length;
      if (loaded.urls.length < config.count) throw new Error(`URL file has ${loaded.urls.length} URLs, fewer than --count ${config.count}`);
      urls = loaded.urls.slice(0, config.count);
      source = `authorized URL file: ${loaded.absolute}`;
    } else {
      server = await createFixtureServer();
      const address = server.address();
      urls = Array.from({ length: config.count }, (_, index) => `http://127.0.0.1:${address.port}/page/${index + 1}`);
      source = `local deterministic fixture (${address.address}:${address.port})`;
    }

    console.log(`Koko crawl benchmark: ${config.count} pages, concurrency ${config.concurrency}`);
    console.log(`Source: ${source}`);
    console.log(`Results: ${outputDir}`);
    if (!config.urlsFile && config.warmup > 0) {
      const warmupUrls = urls.slice(0, Math.min(config.warmup, urls.length));
      console.log(`Warm-up: ${warmupUrls.length} page(s), excluded from results`);
      const warmup = await runWorkers(binary, config, warmupUrls, profileRoot, "Warm-up");
      const warmupFailures = warmup.filter((result) => !result.ok);
      if (warmupFailures.length) throw new Error(`Warm-up failed: ${warmupFailures[0].error}`);
    }

    const startedAt = new Date().toISOString();
    const started = performance.now();
    const results = await runWorkers(binary, config, urls, profileRoot, "Crawl");
    const summary = summarize(results, Math.round(performance.now() - started));
    const report = {
      startedAt,
      source,
      config: { ...config, outputDir },
      environment: { binary, node: process.version, platform: `${process.platform} ${process.arch}`, cpus: os.cpus().length },
      summary,
      results,
    };
    fs.writeFileSync(path.join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(path.join(outputDir, "report.md"), markdownReport(report));
    console.log(markdownReport(report));
    console.log(`Saved: ${path.join(outputDir, "report.json")}`);
    process.exitCode = summary.failed === 0 ? 0 : 1;
  } finally {
    if (server) await closeServer(server);
    if (!config.keepProfiles) fs.rmSync(profileRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
});
