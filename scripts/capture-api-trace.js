#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const CDP_HTTP = option("cdp", "http://127.0.0.1:9222").replace(/\/+$/, "");
const TARGET_URL = option("url", "https://browser-compat.turnstile.workers.dev/");
const OUTPUT = path.resolve(option("out", "exports/api-trace.json"));
const WAIT_MS = Number(option("wait-ms", "12000"));
const PRELOAD = fs.readFileSync(path.join(__dirname, "api-trace-preload.js"), "utf8");
const EXTRA_PRELOAD_PATH = option("extra-preload", null);
const PRELOAD_ONLY = process.argv.includes("--preload-only");
const HTML_OUTPUT = option("html-out", null);
const EXTRA_PRELOAD = EXTRA_PRELOAD_PATH
  ? fs.readFileSync(path.resolve(EXTRA_PRELOAD_PATH), "utf8")
  : "";

function getJson(route) {
  return new Promise((resolve, reject) => {
    http.get(`${CDP_HTTP}${route}`, (response) => {
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    }).on("error", reject);
  });
}

function connect(url) {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket === "undefined") {
      reject(new Error("capture-api-trace.js requires Node.js 22+ (global WebSocket)"));
      return;
    }
    const socket = new WebSocket(url);
    let nextId = 1;
    const pending = new Map();
    const listeners = new Set();
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      if (message.id && pending.has(message.id)) {
        const handler = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) handler.reject(new Error(message.error.message));
        else handler.resolve(message.result);
        return;
      }
      for (const listener of listeners) listener(message);
    });
    socket.addEventListener("error", () => reject(new Error("CDP WebSocket error")));
    socket.addEventListener("open", () => resolve({
      send(method, params = {}, sessionId = null) {
        const id = nextId++;
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        return new Promise((resolveCommand, rejectCommand) => {
          pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
        });
      },
      listen(listener) { listeners.add(listener); },
      close() { socket.close(); },
    }));
  });
}

async function main() {
  new URL(TARGET_URL);
  if (!Number.isFinite(WAIT_MS) || WAIT_MS < 0) throw new Error("--wait-ms must be a non-negative number");
  const targets = await getJson("/json/list");
  const target = targets.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
  let cdp;
  let sessionId = null;
  if (target) {
    cdp = await connect(target.webSocketDebuggerUrl);
  } else {
    // Velora exposes the browser websocket before a page exists. Chrome can
    // use this path too, which keeps the tracer independent of target startup.
    const version = await getJson("/json/version");
    if (!version.webSocketDebuggerUrl) throw new Error(`No CDP websocket at ${CDP_HTTP}`);
    cdp = await connect(version.webSocketDebuggerUrl);
    const created = await cdp.send("Target.createTarget", { url: "about:blank" });
    const attached = await cdp.send("Target.attachToTarget", { targetId: created.targetId, flatten: true });
    sessionId = attached.sessionId;
  }
  const contexts = new Map();
  cdp.listen((message) => {
    if (sessionId && message.sessionId && message.sessionId !== sessionId) return;
    if (message.method === "Runtime.executionContextCreated") {
      const context = message.params.context;
      contexts.set(context.id, {
        id: context.id,
        name: context.name || "",
        origin: context.origin || "",
        auxData: context.auxData || {},
      });
    } else if (message.method === "Runtime.executionContextDestroyed") {
      contexts.delete(message.params.executionContextId);
    } else if (message.method === "Runtime.executionContextsCleared") {
      contexts.clear();
    }
  });

  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Page.enable", {}, sessionId);
  const preloadSource = PRELOAD_ONLY ? EXTRA_PRELOAD : `${PRELOAD}\n${EXTRA_PRELOAD}`;
  if (preloadSource) {
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: preloadSource }, sessionId);
  }
  await cdp.send("Page.navigate", { url: TARGET_URL }, sessionId);
  await new Promise((resolve) => setTimeout(resolve, WAIT_MS));

  if (HTML_OUTPUT) {
    const response = await cdp.send("Runtime.evaluate", {
      expression: "document.documentElement.outerHTML",
      returnByValue: true,
    }, sessionId);
    const htmlPath = path.resolve(HTML_OUTPUT);
    fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
    fs.writeFileSync(htmlPath, response.result?.value || "");
  }

  const realms = [];
  for (const context of contexts.values()) {
    try {
      const response = await cdp.send("Runtime.evaluate", {
        contextId: context.id,
        expression: "globalThis.__veloraApiTrace ? globalThis.__veloraApiTrace.snapshot() : null",
        returnByValue: true,
      }, sessionId);
      const trace = response.result?.value;
      if (trace) {
        realms.push({ context, trace: { ...trace, children: undefined } });
        for (const childTrace of trace.children || []) {
          realms.push({
            context: { id: null, name: "iframe-postmessage", origin: childTrace.origin, auxData: {} },
            trace: { ...childTrace, children: undefined },
          });
        }
      }
    } catch (error) {
      realms.push({ context, error: error.message });
    }
  }

  // Velora and Chrome may expose cross-origin iframes as separate CDP targets
  // rather than execution contexts in the page session. Attach after the
  // observation window and read their already-installed preload trace.
  try {
    const targetResult = await cdp.send("Target.getTargets", {}, sessionId);
    for (const child of targetResult.targetInfos || []) {
      if (child.type !== "iframe" || child.attached) continue;
      try {
        const attached = await cdp.send("Target.attachToTarget", {
          targetId: child.targetId,
          flatten: true,
        }, sessionId);
        const childSession = attached.sessionId;
        await cdp.send("Runtime.enable", {}, childSession);
        const response = await cdp.send("Runtime.evaluate", {
          expression: "globalThis.__veloraApiTrace ? globalThis.__veloraApiTrace.snapshot() : null",
          returnByValue: true,
        }, childSession);
        const trace = response.result?.value;
        if (trace) realms.push({
          context: { id: null, name: "iframe-target", origin: child.url, auxData: { targetId: child.targetId } },
          trace,
        });
      } catch (error) {
        realms.push({
          context: { id: null, name: "iframe-target", origin: child.url, auxData: { targetId: child.targetId } },
          error: error.message,
        });
      }
    }
  } catch {}
  cdp.close();

  const artifact = {
    version: 1,
    capturedAt: new Date().toISOString(),
    cdp: CDP_HTTP,
    url: TARGET_URL,
    waitMs: WAIT_MS,
    realms,
  };
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, `${JSON.stringify(artifact, null, 2)}\n`);
  const eventCount = realms.reduce((sum, realm) => sum + (realm.trace?.events.length || 0), 0);
  console.log(`Captured ${eventCount} events from ${realms.length} realms: ${OUTPUT}`);
}

main().catch((error) => {
  console.error(`API trace failed: ${error.message}`);
  process.exitCode = 1;
});
