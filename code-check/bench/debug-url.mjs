#!/usr/bin/env node
/**
 * Single-URL CDP debug probe (stderr + lifecycle events).
 * Usage: node code-check/bench/debug-url.mjs https://go.dev/
 */
import { spawn } from "node:child_process";
import { mkdirSync, createWriteStream, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import puppeteer from "puppeteer-core";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BIN = process.env.VELORA_BIN ?? join(ROOT, "zig-out/bin/velora");
const HOST = process.env.HOST ?? "127.0.0.1";
const URL = process.argv[2];
const NAV_MS = Number(process.env.NAV_TIMEOUT_MS ?? 12_000);

if (!URL) {
  console.error("Usage: node code-check/bench/debug-url.mjs <url>");
  process.exit(1);
}

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, HOST, () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
    s.on("error", rej);
  });
}

async function waitCdp(port) {
  const u = `http://${HOST}:${port}/json/version`;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(u);
      if (r.ok) return await r.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("CDP not ready");
}

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = join(ROOT, "code-check/tmp/debug-url", stamp);
  mkdirSync(outDir, { recursive: true });
  const stderrPath = join(outDir, "velora.stderr.log");
  const port = await freePort();

  const proc = spawn(BIN, ["serve", "--host", HOST, "--port", String(port), "--log-level", "warn"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const errStream = createWriteStream(stderrPath);
  proc.stdout?.pipe(errStream);
  proc.stderr?.pipe(errStream);

  const version = await waitCdp(port);
  const ws = version.webSocketDebuggerUrl;
  const browser = await puppeteer.connect({ browserWSEndpoint: ws, protocolTimeout: 30_000 });
  const page = await browser.newPage();

  const events = [];
  const client = await page.createCDPSession();
  for (const ev of ["Page.frameNavigated", "Page.domContentEventFired", "Page.loadEventFired"]) {
    client.on(ev, (p) => events.push({ t: Date.now(), ev, p }));
  }

  const t0 = Date.now();
  let gotoErr = null;
  try {
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: NAV_MS });
  } catch (e) {
    gotoErr = e?.message ?? String(e);
  }

  let snap = null;
  try {
    snap = await page.evaluate(() => ({
      href: location.href,
      readyState: document.readyState,
      title: document.title,
      bodyLen: (document.body?.innerText ?? "").length,
    }));
  } catch (e) {
    snap = { error: e?.message ?? String(e) };
  }

  const report = {
    url: URL,
    ms: Date.now() - t0,
    gotoErr,
    snap,
    events,
    stderr: stderrPath,
  };
  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  await browser.disconnect();
  proc.kill("SIGKILL");
  console.log(`\nlogs: ${outDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});