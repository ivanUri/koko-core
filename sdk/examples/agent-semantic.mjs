#!/usr/bin/env node
/**
 * MCP-style AI agent workflow using SDK LP APIs (no Cursor required).
 *
 * Mirrors the MCP tool chain: goto → semantic_tree → findElement → NodeHandle actions.
 *
 * Usage:
 *   npm run example:agent
 *   node sdk/examples/agent-semantic.mjs --launch
 */

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { Browser } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, "fixtures/agent-form.html");

function parseArgs(argv) {
  const out = {
    launch: !process.env.VELORA_CDP,
    profile: process.env.VELORA_PROFILE ?? "chrome-local-huys-macbook-pro",
    endpoint: process.env.VELORA_CDP ?? null,
    dumpTree: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--launch") out.launch = true;
    else if (a === "--endpoint") { out.endpoint = argv[++i]; out.launch = false; }
    else if (a === "--profile") out.profile = argv[++i];
    else if (a === "--dump-tree") out.dumpTree = true;
    else if (a === "--help") {
      console.log("Usage: node sdk/examples/agent-semantic.mjs [--launch] [--dump-tree]");
      process.exit(0);
    }
  }
  return out;
}

function assertButtonHandle(id) {
  if (id == null) throw new Error("button missing backendNodeId");
}

function pickMeta(props, key) {
  if (Array.isArray(props)) return props.find((p) => p.key === key)?.value;
  if (props && typeof props === "object") return props[key];
  return undefined;
}

async function serveFixture() {
  const html = readFileSync(FIXTURE, "utf8");
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise((res, rej) => server.listen(0, "127.0.0.1", (err) => (err ? rej(err) : res())));
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

/**
 * Agent loop — same decision pattern as MCP velora tools.
 */
async function runAgent(page, goalUrl) {
  console.log("\n[agent] goto");
  await page.goto(goalUrl, { waitUntil: "done" });

  console.log("[agent] semantic_tree (text, depth=5)");
  const tree = await page.semanticTree({ format: "text", maxDepth: 5 });
  if (process.env.DUMP_TREE === "1") console.log(tree);

  console.log("[agent] structuredData");
  const meta = await page.getStructuredData();
  const ogTitle = pickMeta(meta.openGraph, "og:title");
  console.log(`  og:title = ${ogTitle ?? "(none)"}`);

  console.log("[agent] detectForms");
  const forms = await page.detectForms();
  console.log(`  forms=${forms.length} fields=${forms[0]?.fields?.length ?? 0}`);

  const field = forms[0]?.fields?.find((f) => f.name === "q" && f.backendNodeId);
  if (!field?.backendNodeId) throw new Error("form field q missing backendNodeId");

  console.log("[agent] NodeHandle.fill (from detectForms)");
  await page.node(field.backendNodeId).fill("velora agent demo");

  const filled = await page.evaluate(`document.getElementById("q")?.value || ""`);
  if (!filled.includes("velora")) throw new Error(`fill did not apply: ${filled}`);

  console.log("[agent] findElement role=button name=search");
  const buttons = await page.findElement({ role: "button", name: "search" });
  if (!buttons.length) throw new Error("no submit button");
  assertButtonHandle(buttons[0].backendNodeId);

  const finalUrl = await page.url();
  const md = await page.markdown();
  return {
    finalUrl,
    markdownBytes: md.length,
    treeLines: String(tree).split("\n").length,
    formFields: forms[0]?.fields?.length ?? 0,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.dumpTree) process.env.DUMP_TREE = "1";

  let launched = null;
  let fixture = null;

  try {
    if (args.launch) {
      if (!existsSync(resolve(__dirname, "../../zig-out/bin/velora"))) {
        throw new Error("zig build first");
      }
      launched = await Browser.launch({ profile: args.profile, logLevel: "warn" });
      console.log(`launched ${launched.endpoint}`);
    } else {
      launched = { browser: await Browser.connect(args.endpoint), close: async () => {} };
      console.log(`attach ${args.endpoint}`);
    }

    fixture = await serveFixture();
    const page = await launched.browser.newPage();
    const result = await runAgent(page, fixture.url);

    console.log("\n--- agent result ---");
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await fixture?.close().catch(() => undefined);
    if (launched?.close) await launched.close().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});