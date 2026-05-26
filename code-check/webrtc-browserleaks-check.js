#!/usr/bin/env node
// webrtc-browserleaks-check.js
// Truy cập https://browserleaks.com/webrtc qua CDP, chờ WebRTC chạy xong, export HTML ra file.
//
// Usage:
//   node code-check/webrtc-browserleaks-check.js [--port=60954]

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const CDP_PORT = (() => {
  const a = process.argv.find((x) => x.startsWith("--port="));
  return a ? parseInt(a.split("=")[1]) : 60954;
})();

const TARGET_URL = "https://browserleaks.com/webrtc";
const OUT_HTML = path.resolve(__dirname, "webrtc-browserleaks-result.html");
const WAIT_MS = 12000;

// ── minimal CDP over WebSocket ────────────────────────────────────────────────
class CDP {
  constructor(ws) {
    this._ws = ws;
    this._id = 1;
    this._cb = new Map();
    this._events = new Map();
    ws.on("message", (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (m.id && this._cb.has(m.id)) {
        const { res, rej } = this._cb.get(m.id);
        this._cb.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      }
      if (m.method) {
        const handlers = this._events.get(m.method) || [];
        handlers.forEach((h) => h(m.params));
      }
    });
  }
  send(method, params = {}) {
    const id = this._id++;
    return new Promise((res, rej) => {
      this._cb.set(id, { res, rej });
      this._ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this._cb.has(id)) {
          this._cb.delete(id);
          rej(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }
  on(event, handler) {
    if (!this._events.has(event)) this._events.set(event, []);
    this._events.get(event).push(handler);
  }
  close() { try { this._ws.close(); } catch {} }
}

function fetchJson(url) {
  return new Promise((res, rej) => {
    http.get(url, (r) => {
      let d = "";
      r.on("data", (c) => (d += c));
      r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on("error", rej);
  });
}

function openWs(url) {
  const WebSocket = require("ws");
  const ws = new WebSocket(url);
  return new Promise((res, rej) => {
    ws.once("open", () => res(ws));
    ws.once("error", rej);
  });
}

async function main() {
  const WebSocket = require("ws");

  // 1. Thử /json/list trước (target-based CDP như Chrome)
  let wsUrl = null;
  let useBrowserWs = false;

  try {
    const targets = await fetchJson(`http://localhost:${CDP_PORT}/json/list`);
    const target = targets.find((t) => t.type === "page") || targets[0];
    if (target && target.webSocketDebuggerUrl) {
      wsUrl = target.webSocketDebuggerUrl;
      console.log(`[CDP] Target found: ${wsUrl}`);
    }
  } catch {}

  // 2. Nếu không có target, thử browser-level WS (Velora style)
  if (!wsUrl) {
    try {
      const ver = await fetchJson(`http://localhost:${CDP_PORT}/json/version`);
      if (ver.webSocketDebuggerUrl) {
        wsUrl = ver.webSocketDebuggerUrl;
        useBrowserWs = true;
        console.log(`[CDP] Browser WS: ${wsUrl}`);
      }
    } catch {}
  }

  if (!wsUrl) throw new Error(`Không tìm thấy CDP endpoint trên port ${CDP_PORT}`);

  // 3. Kết nối
  const ws = await openWs(wsUrl);
  const cdp = new CDP(ws);

  // 4. Nếu là browser-level, tạo target mới
  if (useBrowserWs) {
    console.log(`[CDP] Tạo page target...`);
    await cdp.send("Target.setDiscoverTargets", { discover: true });
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    console.log(`[CDP] targetId: ${targetId}`);

    // Lấy wsDebuggerUrl cho target vừa tạo
    await new Promise((r) => setTimeout(r, 500));
    const targets2 = await fetchJson(`http://localhost:${CDP_PORT}/json/list`);
    const t = targets2.find((x) => x.id === targetId || x.targetId === targetId);
    if (t && t.webSocketDebuggerUrl) {
      cdp.close();
      const ws2 = await openWs(t.webSocketDebuggerUrl);
      const cdp2 = new CDP(ws2);
      await runTest(cdp2);
      cdp2.close();
    } else {
      // Velora có thể dùng session-based attach
      console.log(`[CDP] Thử attachToTarget session...`);
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
      console.log(`[CDP] sessionId: ${sessionId}`);
      // Dùng session trên cùng WS
      await runTestWithSession(cdp, sessionId);
      cdp.close();
    }
  } else {
    await runTest(cdp);
    cdp.close();
  }
}

async function runTest(cdp) {
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  console.log(`[NAV] Đang mở ${TARGET_URL} ...`);
  await cdp.send("Page.navigate", { url: TARGET_URL });

  console.log(`[WAIT] Chờ ${WAIT_MS / 1000}s để WebRTC gather hoàn tất...`);
  await new Promise((r) => setTimeout(r, WAIT_MS));

  const { result } = await cdp.send("Runtime.evaluate", {
    expression: "document.documentElement.outerHTML",
    returnByValue: true,
  });

  saveHtml(result.value);
}

async function runTestWithSession(cdp, sessionId) {
  // Gửi CDP command qua sessionId (flatten mode)
  function sendSession(method, params = {}) {
    const id = cdp._id++;
    return new Promise((res, rej) => {
      cdp._cb.set(id, { res, rej });
      cdp._ws.send(JSON.stringify({ id, method, params, sessionId }));
      setTimeout(() => {
        if (cdp._cb.has(id)) { cdp._cb.delete(id); rej(new Error(`timeout: ${method}`)); }
      }, 30000);
    });
  }

  await sendSession("Page.enable");
  await sendSession("Runtime.enable");

  console.log(`[NAV] Đang mở ${TARGET_URL} (session ${sessionId})...`);
  await sendSession("Page.navigate", { url: TARGET_URL });

  console.log(`[WAIT] Chờ ${WAIT_MS / 1000}s...`);
  await new Promise((r) => setTimeout(r, WAIT_MS));

  const { result } = await sendSession("Runtime.evaluate", {
    expression: "document.documentElement.outerHTML",
    returnByValue: true,
  });

  saveHtml(result.value);
}

function saveHtml(html) {
  if (!html) { console.error("[WARN] HTML rỗng"); return; }
  fs.writeFileSync(OUT_HTML, html, "utf8");
  console.log(`[OK] Đã lưu: ${OUT_HTML} (${(html.length / 1024).toFixed(1)} KB)`);
  console.log(`[OPEN] open "${OUT_HTML}"`);
}

main().catch((e) => {
  console.error("[FATAL]", e.message);
  process.exit(1);
});
