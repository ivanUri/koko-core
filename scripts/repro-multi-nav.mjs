#!/usr/bin/env node
/**
 * Minimal multi-nav repro for lldb attach. Usage:
 *   VELORA_PORT=9222 node scripts/repro-multi-nav.mjs
 */
import { createServer } from "node:net";

const port = Number(process.env.VELORA_PORT || 9222);
const endpoint = `http://127.0.0.1:${port}`;
const sites = (process.env.SITES || "https://example.com,https://en.wikipedia.org/wiki/Earth,https://news.ycombinator.com").split(",");

async function waitCdp() {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${endpoint}/json/version`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("CDP not ready");
}

await waitCdp();
const { webSocketDebuggerUrl } = await (await fetch(`${endpoint}/json/version`)).json();
const ws = new WebSocket(webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener("open", res, { once: true });
  ws.addEventListener("error", rej, { once: true });
});

let nextId = 1;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  }
});
const send = (method, params = {}, sessionId) => {
  const id = nextId++;
  const payload = { id, method, params };
  if (sessionId) payload.sessionId = sessionId;
  ws.send(JSON.stringify(payload));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
};

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
await send("Page.enable", {}, sessionId);
await send("Runtime.enable", {}, sessionId);

for (let cycle = 1; cycle <= Number(process.env.CYCLES || 20); cycle++) {
  for (const url of sites) {
    console.error(`[cycle ${cycle}] goto ${url}`);
    await send("Page.navigate", { url }, sessionId);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("load timeout")), 30_000);
      const handler = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.method === "Page.loadEventFired" && msg.sessionId === sessionId) {
          clearTimeout(t);
          ws.removeEventListener("message", handler);
          resolve();
        }
      };
      ws.addEventListener("message", handler);
    });
    await send("Runtime.evaluate", { expression: "document.title", returnByValue: true }, sessionId);
    console.error(`  ok: ${url}`);
  }
}
console.error("done");