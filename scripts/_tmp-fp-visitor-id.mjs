#!/usr/bin/env node
/**
 * One-shot: open Fingerprint playground and print Visitor ID.
 *   node scripts/_tmp-fp-visitor-id.mjs --max-sec 25
 */
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import WebSocket from "ws";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createProbeBudget,
  killProcess,
  waitCdp,
  parseMaxSecArg,
} from "./lib/cdp-probe-budget.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = resolve(REPO, "zig-out/bin/velora");
const URL = "https://demo.fingerprint.com/playground";
const PROFILE = "chrome-local-huys-macbook-pro";
const MAX_SEC = parseMaxSecArg(process.argv.slice(2), 25);

const EXTRACT = `(() => {
  const body = (document.body && document.body.innerText) || "";
  const html = document.documentElement ? document.documentElement.outerHTML : "";
  const text = body.replace(/\\s+/g, " ").trim();
  const patterns = [
    /Visitor\\s*ID[:\\s]+([A-Za-z0-9_-]{8,})/i,
    /Your\\s+Visitor\\s+ID[:\\s]+([A-Za-z0-9_-]{8,})/i,
    /"visitorId"\\s*:\\s*"([A-Za-z0-9_-]{8,})"/i,
    /visitorId["'\\s:=]+([A-Za-z0-9_-]{8,})/i,
  ];
  let visitorId = null;
  for (const re of patterns) {
    const m = text.match(re) || html.match(re);
    if (m) {
      visitorId = m[1];
      break;
    }
  }
  if (!visitorId) {
    const all = [...document.querySelectorAll("p, span, div, dd, code, pre, h1, h2, h3, li, button")];
    for (const el of all) {
      const t = (el.textContent || "").replace(/\\s+/g, " ").trim();
      if (/visitor\\s*id/i.test(t)) {
        const m = t.match(/([A-Za-z0-9_-]{16,})/);
        if (m) {
          visitorId = m[1];
          break;
        }
      }
      if (/^visitor\\s*id$/i.test(t) && el.nextElementSibling) {
        const n = (el.nextElementSibling.textContent || "").trim();
        if (/^[A-Za-z0-9_-]{8,}$/.test(n)) {
          visitorId = n;
          break;
        }
      }
    }
  }
  const idx = text.toLowerCase().indexOf("visitor");
  const snippet = idx >= 0 ? text.slice(Math.max(0, idx - 30), idx + 140) : null;
  return {
    title: document.title,
    ready: document.readyState,
    textLen: text.length,
    hasVisitorLabel: /visitor\\s*id/i.test(text),
    visitorId,
    snippet,
    textHead: text.slice(0, 350),
    hasNext: typeof window.next !== "undefined",
  };
})()`;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((res, rej) => {
    const s = createNetServer();
    s.unref();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 1;
    this.pending = new Map();
    /** @type {{url:string,status:number,requestId:string}[]} */
    this.interesting = [];
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      if (msg.method === "Network.responseReceived") {
        const r = msg.params?.response;
        const url = r?.url || "";
        if (
          r?.status === 200 &&
          (url.includes("identify") ||
            url.includes("visitor") ||
            url.includes("fpjs") ||
            url.includes("fingerprint") ||
            url.includes("/e?") ||
            url.includes("/e/"))
        ) {
          this.interesting.push({
            url: url.slice(0, 200),
            status: r.status,
            requestId: msg.params.requestId,
          });
        }
      }
    });
  }
  send(method, params = {}, sessionId, timeoutMs = 20000) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const o = { id, method, params };
      if (sessionId) o.sessionId = sessionId;
      this.ws.send(JSON.stringify(o));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error("timeout " + method));
        }
      }, timeoutMs);
    });
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function evalJson(cdp, sessionId, expr) {
  const r = await cdp.send(
    "Runtime.evaluate",
    { expression: expr, returnByValue: true, awaitPromise: false },
    sessionId,
    10000
  );
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.text || "eval error");
  }
  return r.result?.value;
}

function parseVisitorFromJson(raw) {
  if (!raw || typeof raw !== "string") return null;
  const m =
    raw.match(/"visitorId"\s*:\s*"([A-Za-z0-9_-]+)"/i) ||
    raw.match(/"visitor_id"\s*:\s*"([A-Za-z0-9_-]+)"/i);
  return m ? m[1] : null;
}

const port = await freePort();
const endpoint = `http://127.0.0.1:${port}`;
let proc = null;
const cleanup = () => {
  killProcess(proc);
  proc = null;
};
const budget = createProbeBudget(MAX_SEC, cleanup);

try {
  proc = spawn(
    BIN,
    [
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--browser-profile",
      PROFILE,
      "--log-level",
      "warn",
      "--log-format",
      "pretty",
    ],
    { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] }
  );

  await waitCdp(endpoint, budget.deadline);
  const ver = await (await fetch(`${endpoint}/json/version`)).json();
  const ws = await new Promise((res, rej) => {
    const w = new WebSocket(ver.webSocketDebuggerUrl);
    w.once("open", () => res(w));
    w.once("error", rej);
  });
  const cdp = new Cdp(ws);
  await cdp.send("Target.setDiscoverTargets", { discover: true }).catch(() => {});
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Network.enable", {}, sessionId);

  console.log("[nav]", URL);
  await cdp.send("Page.navigate", { url: URL }, sessionId, 20000);

  let last = null;
  let networkVisitorId = null;
  const t0 = Date.now();
  for (let i = 0; i < 22; i++) {
    if (budget.remaining() < 2000) break;
    await delay(i === 0 ? 1500 : 1000);
    last = await evalJson(cdp, sessionId, EXTRACT);
    const t = Math.round((Date.now() - t0) / 1000);
    console.log(
      JSON.stringify({
        t,
        textLen: last?.textLen,
        hasVisitorLabel: last?.hasVisitorLabel,
        visitorId: last?.visitorId,
        ready: last?.ready,
        snippet: last?.snippet,
      })
    );

    // Pull network bodies for visitorId
    for (const item of cdp.interesting.slice(-12)) {
      if (item._seen) continue;
      item._seen = true;
      try {
        const body = await cdp.send(
          "Network.getResponseBody",
          { requestId: item.requestId },
          sessionId,
          4000
        );
        const raw = body.base64Encoded
          ? Buffer.from(body.body, "base64").toString("utf8")
          : body.body;
        const vid = parseVisitorFromJson(raw);
        if (vid) {
          networkVisitorId = vid;
          console.log("[network] visitorId=", vid, "url=", item.url);
        } else if (/visitor/i.test(raw)) {
          console.log("[network] body snippet", item.url.slice(0, 90), raw.slice(0, 220));
        }
      } catch {
        // body may already be discarded
      }
    }

    if (last?.visitorId || networkVisitorId) break;
  }

  const visitorId = last?.visitorId || networkVisitorId || null;
  console.log("\n=== RESULT ===");
  console.log(
    JSON.stringify(
      {
        visitorId,
        source: last?.visitorId ? "ui-text" : networkVisitorId ? "network-json" : null,
        title: last?.title,
        textLen: last?.textLen,
        hasVisitorLabel: last?.hasVisitorLabel,
        snippet: last?.snippet,
        textHead: last?.textHead,
        interestingResponses: cdp.interesting.length,
        elapsedSec: Math.round((Date.now() - t0) / 1000),
      },
      null,
      2
    )
  );

  if (visitorId) {
    console.log("\nVisitor ID:", visitorId);
  } else {
    console.log("\nVisitor ID: (not found)");
  }

  cdp.close();
  cleanup();
  budget.clear();
  process.exit(visitorId ? 0 : 2);
} catch (e) {
  console.error("FATAL", e);
  cleanup();
  budget.clear();
  process.exit(1);
}
