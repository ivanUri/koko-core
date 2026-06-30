#!/usr/bin/env node
/**
 * End-to-end smoke test for @velora/sdk Velora-specific APIs.
 *
 * Usage:
 *   npm run test:sdk:smoke
 *   node scripts/sdk-smoke.mjs --profile chrome-local-huys-macbook-pro
 *   node scripts/sdk-smoke.mjs --endpoint http://127.0.0.1:9222
 *   node scripts/sdk-smoke.mjs --with-google
 */

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Browser,
  captureSessionState,
  restoreSessionState,
} from "../sdk/dist/index.js";
import {
  createProbeBudget,
  parseMaxSecArg,
  killProcess,
} from "./lib/cdp-probe-budget.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const FIXTURE = resolve(REPO, "sdk/examples/fixtures/agent-form.html");
const WIKI_URL = "https://en.wikipedia.org/wiki/Earth";
const DEFAULT_PROFILE = "chrome-local-huys-macbook-pro";

function parseArgs(argv) {
  const out = {
    profile: process.env.VELORA_PROFILE ?? DEFAULT_PROFILE,
    endpoint: process.env.VELORA_CDP ?? null,
    withGoogle: false,
    keep: false,
    maxSec: parseMaxSecArg(argv, 45),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--profile") out.profile = argv[++i];
    else if (a === "--endpoint") out.endpoint = argv[++i];
    else if (a === "--with-google") out.withGoogle = true;
    else if (a === "--keep") out.keep = true;
    else if (a === "--max-sec") out.maxSec = Number(argv[++i]);
    else if (a === "--help") {
      console.log(`Usage: node scripts/sdk-smoke.mjs [--profile ID] [--endpoint URL] [--with-google] [--max-sec N]`);
      process.exit(0);
    }
  }
  return out;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function serveFixture() {
  const html = readFileSync(FIXTURE, "utf8");
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise((res, rej) => server.listen(0, "127.0.0.1", (err) => (err ? rej(err) : res())));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise((res) => server.close(() => res())),
  };
}

async function runCheck(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    const ms = Date.now() - t0;
    console.log(`  OK   ${name} (${ms}ms)`);
    return { name, ok: true, ms };
  } catch (err) {
    const ms = Date.now() - t0;
    console.log(`  FAIL ${name} (${ms}ms): ${err?.message ?? err}`);
    return { name, ok: false, ms, error: err?.message ?? String(err) };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const veloraBin = resolve(REPO, "zig-out/bin/velora");
  if (!args.endpoint && !existsSync(veloraBin)) {
    throw new Error("zig-out/bin/velora missing — run zig build first");
  }

  let launched = null;
  let fixture = null;
  let proc = null;
  const budget = createProbeBudget(args.maxSec, ({ signal }) => {
    killProcess(proc ?? launched?.process, signal);
  });

  try {
    if (args.endpoint) {
      const browser = await Browser.connect(args.endpoint);
      launched = { browser, close: () => browser.close() };
      console.log(`attach: ${args.endpoint}`);
    } else {
      launched = await Browser.launch({ profile: args.profile, logLevel: "warn" });
      proc = launched.process;
      console.log(`launch: ${launched.endpoint} profile=${launched.profile ?? args.profile}`);
    }

    fixture = await serveFixture();
    const page = await launched.browser.newPage();
    const results = [];

    results.push(await runCheck("goto:done", async () => {
      await page.goto(WIKI_URL, { waitUntil: "done", timeout: budget.remaining() });
      const title = await page.title();
      assert(title.includes("Earth"), `unexpected title: ${title}`);
    }));

    results.push(await runCheck("markdown", async () => {
      const md = await page.markdown({ timeout: budget.remaining() });
      assert(md.length > 200, "markdown too short");
      assert(/Earth/i.test(md), "markdown missing Earth");
    }));

    results.push(await runCheck("semanticTree:text", async () => {
      const tree = await page.semanticTree({ format: "text", maxDepth: 4, timeout: budget.remaining() });
      assert(typeof tree === "string" && tree.length > 50, "semantic tree empty");
    }));

    results.push(await runCheck("structuredData", async () => {
      const data = await page.getStructuredData({ timeout: budget.remaining() });
      assert(Array.isArray(data.jsonLd), "jsonLd missing");
    }));

    results.push(await runCheck("links", async () => {
      const links = await page.links({ timeout: budget.remaining() });
      assert(links.length > 5, "expected wiki links");
    }));

    results.push(await runCheck("extract:wiki", async () => {
      const data = await page.extract({ timeout: budget.remaining() });
      assert(data.title && data.linkCount > 0, "wiki extract failed");
    }));

    results.push(await runCheck("agent:fixture", async () => {
      await page.goto(fixture.url, { waitUntil: "done", timeout: budget.remaining() });
      const forms = await page.detectForms({ timeout: budget.remaining() });
      assert(forms.length >= 1, "no forms detected");
      const field = forms[0].fields.find((f) => f.name === "q" && f.backendNodeId);
      assert(field, "search field missing backendNodeId");
      await page.node(field.backendNodeId).fill("velora sdk smoke");
      const value = await page.evaluate(`document.getElementById("q")?.value || ""`);
      assert(value.includes("velora"), `fill did not apply: ${value}`);
      const [btn] = await page.findElement({ role: "button", name: "search" });
      assert(btn?.backendNodeId, "submit button not found");
    }));

    results.push(await runCheck("waitForSelectorHandle", async () => {
      const handle = await page.waitForSelectorHandle("#q", { timeout: 5000 });
      await handle.fill("handle path");
      const details = await handle.details();
      assert(details.tagName === "input", `expected input, got ${details.tagName}`);
    }));

    results.push(await runCheck("sessionState", async () => {
      const state = await captureSessionState(page);
      assert(state.version === 1, "bad session version");
      assert(Array.isArray(state.cookies), "cookies missing");
    }));

    if (args.withGoogle) {
      results.push(await runCheck("searchGoogle", async () => {
        const serp = await page.searchGoogle({
          query: "wikipedia earth",
          limit: 3,
          timeout: budget.remaining(),
        });
        assert(serp.results.length >= 1, "no google results");
      }));
    } else {
      console.log("  SKIP searchGoogle (pass --with-google to enable)");
    }

    const failed = results.filter((r) => !r.ok);
    const report = {
      pass: failed.length === 0,
      profile: args.profile,
      endpoint: args.endpoint ?? launched.endpoint,
      checks: results,
      skipped: args.withGoogle ? [] : ["searchGoogle"],
    };
    console.log("\n--- summary ---");
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.pass ? 0 : 1;
  } finally {
    budget.clear();
    await fixture?.close().catch(() => undefined);
    if (launched) await launched.close().catch(() => undefined);
    if (proc && !args.keep) killProcess(proc, "SIGTERM");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});