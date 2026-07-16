#!/usr/bin/env node
/**
 * Bot/tampering surface probe (BotD-aligned) via raw CDP.
 * Budget: max 20s total.
 *
 *   node scripts/cdp-bot-signals-probe.mjs --profile chrome-local-huys-macbook-pro
 */
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import {
  createProbeBudget,
  killProcess,
  parseMaxSecArg,
  waitCdp,
} from "./lib/cdp-probe-budget.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const VELORA_BIN = resolve(REPO, "zig-out/bin/velora");

const EXPR = `(() => {
  const winHas = (k) => k in window;
  const cdcWin = Object.getOwnPropertyNames(window).filter((k) => /^cdc_|^\\$cdc_/.test(k));
  const cdcDoc = Object.getOwnPropertyNames(document).filter((k) => /^cdc_|^\\$cdc_/.test(k));
  let touchEvent = false;
  try { document.createEvent('TouchEvent'); touchEvent = true; } catch { touchEvent = false; }
  return {
    navigatorWebdriver: navigator.webdriver,
    windowHasWebdriver: winHas('webdriver'),
    windowWebdriverType: typeof window.webdriver,
    productSub: navigator.productSub,
    vendorSub: navigator.vendorSub,
    product: navigator.product,
    maxTouchPoints: navigator.maxTouchPoints,
    ontouchstartInWindow: 'ontouchstart' in window,
    touchEventCreate: touchEvent,
    pluginsLength: navigator.plugins?.length ?? null,
    pluginsIsPluginArray: navigator.plugins instanceof PluginArray,
    mimeTypesConsistent: (() => {
      try {
        let ok = Object.getPrototypeOf(navigator.mimeTypes) === MimeTypeArray.prototype;
        for (let i = 0; i < navigator.mimeTypes.length; i++) {
          ok = ok && Object.getPrototypeOf(navigator.mimeTypes[i]) === MimeType.prototype;
        }
        return ok;
      } catch { return false; }
    })(),
    pdfViewerEnabled: navigator.pdfViewerEnabled,
    chromeKeys: window.chrome ? Object.keys(window.chrome) : null,
    hasChromeRuntime: !!(window.chrome && 'runtime' in window.chrome),
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
    cdcWin,
    cdcDoc,
    seleniumMarkers: ['_selenium', '__webdriver_script_fn', 'callPhantom', 'domAutomation'].filter(winHas),
  };
})()`;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const out = { profile: "chrome-local-huys-macbook-pro", maxSec: parseMaxSecArg(argv, 20) };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--profile") out.profile = argv[++i];
  }
  return out;
}

async function getFreePort() {
  return new Promise((res, rej) => {
    const s = createNetServer();
    s.unref();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}, sessionId = null) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }
  close() {
    this.ws.close();
  }
}

function expect(name, cond, detail) {
  if (!cond) {
    console.error(`[FAIL] ${name}`, detail ?? "");
    return false;
  }
  console.log(`[OK] ${name}`, detail ?? "");
  return true;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(VELORA_BIN)) {
    console.error("missing binary:", VELORA_BIN);
    process.exit(2);
  }

  const port = await getFreePort();
  const endpoint = `http://127.0.0.1:${port}`;
  let proc = null;
  const cleanup = () => killProcess(proc);
  const budget = createProbeBudget(args.maxSec, cleanup);

  proc = spawn(
    VELORA_BIN,
    [
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--browser-profile",
      args.profile,
      "--log-level",
      "warn",
    ],
    { cwd: REPO, stdio: "ignore" },
  );

  let failed = 0;
  let client = null;
  try {
    await waitCdp(endpoint, budget.deadline);
    const version = await (await fetch(`${endpoint}/json/version`)).json();
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.once("open", res);
      ws.once("error", rej);
    });
    client = new CdpClient(ws);
    await client.send("Target.setDiscoverTargets", { discover: true }).catch(() => {});
    const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
    await client.send("Page.enable", {}, sessionId);
    await client.send("Runtime.enable", {}, sessionId);
    await delay(200);

    const evalResult = await client.send(
      "Runtime.evaluate",
      { expression: EXPR, returnByValue: true, awaitPromise: false },
      sessionId,
    );
    if (evalResult.exceptionDetails) {
      throw new Error(evalResult.exceptionDetails.text || "evaluate failed");
    }
    const v = evalResult.result?.value;
    if (!v) throw new Error("empty evaluate: " + JSON.stringify(evalResult));

    console.log(JSON.stringify(v, null, 2));

    const checks = [
      ["navigator.webdriver === false", v.navigatorWebdriver === false, v.navigatorWebdriver],
      [
        "window.webdriver absent",
        v.windowHasWebdriver === false && v.windowWebdriverType === "undefined",
        { has: v.windowHasWebdriver, type: v.windowWebdriverType },
      ],
      ["productSub", v.productSub === "20030107", v.productSub],
      ["vendorSub empty", v.vendorSub === "", v.vendorSub],
      ["maxTouchPoints number", typeof v.maxTouchPoints === "number", v.maxTouchPoints],
      ["ontouchstart not in window (desktop)", v.ontouchstartInWindow === false, v.ontouchstartInWindow],
      ["plugins length > 0", v.pluginsLength > 0, v.pluginsLength],
      ["plugins instanceof PluginArray", v.pluginsIsPluginArray === true, v.pluginsIsPluginArray],
      ["mimeTypes consistent", v.mimeTypesConsistent === true, v.mimeTypesConsistent],
      ["pdfViewerEnabled", v.pdfViewerEnabled === true, v.pdfViewerEnabled],
      ["chrome present", Array.isArray(v.chromeKeys) && v.chromeKeys.includes("app"), v.chromeKeys],
      ["no chrome.runtime (intentional)", v.hasChromeRuntime === false, v.hasChromeRuntime],
      ["outer size non-zero", v.outerWidth > 0 && v.outerHeight > 0, [v.outerWidth, v.outerHeight]],
      ["no cdc markers", v.cdcWin.length === 0 && v.cdcDoc.length === 0, { cdcWin: v.cdcWin, cdcDoc: v.cdcDoc }],
      ["no selenium markers", v.seleniumMarkers.length === 0, v.seleniumMarkers],
    ];

    for (const [name, ok, detail] of checks) {
      if (!expect(name, ok, detail)) failed += 1;
    }

    client.close();
  } catch (err) {
    console.error("[ERROR]", err);
    failed += 1;
  } finally {
    budget.clear();
    cleanup();
  }

  if (failed > 0) {
    console.error(`[DONE] ${failed} check(s) failed`);
    process.exit(1);
  }
  console.log("[DONE] all bot-surface checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
