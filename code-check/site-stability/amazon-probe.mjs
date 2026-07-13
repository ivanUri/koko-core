import { createServer as createNetServer } from "node:net";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { resolve } from "node:path";
import { writeFileSync, appendFileSync } from "node:fs";

const REPO = "/Users/huydev/Desktop/velora";
const VELORA = resolve(REPO, "zig-out/bin/velora");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise((res, rej) => {
    const s = createNetServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });

const port = await freePort();
const logPath = "/tmp/amazon-stderr.log";
writeFileSync(logPath, "");
const proc = spawn(
  VELORA,
  ["serve", "--host", "127.0.0.1", "--port", String(port), "--log-level", "warn", "--browser-profile", "chrome-macos-catalina"],
  { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] },
);
proc.stderr.on("data", (d) => appendFileSync(logPath, d));
proc.stdout.on("data", (d) => appendFileSync(logPath, d));
proc.on("exit", (c, s) => console.error("[exit]", c, s));

const endpoint = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`${endpoint}/json/version`)).ok) break;
  } catch {}
  await delay(100);
}
const { webSocketDebuggerUrl } = await (await fetch(`${endpoint}/json/version`)).json();
const ws = new WebSocket(webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.once("open", res);
  ws.once("error", rej);
});
let id = 0;
const pending = new Map();
ws.on("message", (raw) => {
  const m = JSON.parse(String(raw));
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(m.error.message)) : res(m.result);
  }
});
const call = (method, params = {}, sid = null, timeout = 20000) =>
  new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, { res, rej });
    const p = { id: mid, method, params };
    if (sid) p.sessionId = sid;
    if (ws.readyState !== WebSocket.OPEN) return rej(new Error("ws closed"));
    ws.send(JSON.stringify(p));
    setTimeout(() => {
      if (pending.has(mid)) {
        pending.delete(mid);
        rej(new Error("timeout " + method));
      }
    }, timeout);
  });

const { targetId } = await call("Target.createTarget", { url: "about:blank" });
const { sessionId } = await call("Target.attachToTarget", { targetId, flatten: true });
await call("Page.enable", {}, sessionId);
await call("Runtime.enable", {}, sessionId);
await call("Network.enable", {}, sessionId).catch(() => {});

const responses = [];
ws.on("message", (raw) => {
  const m = JSON.parse(String(raw));
  if (m.method === "Network.responseReceived" && m.sessionId === sessionId) {
    const r = m.params?.response;
    if (r && (r.url.includes("amazon") || r.url === "https://www.amazon.com/" || r.mimeType?.includes("html"))) {
      responses.push({ url: r.url?.slice(0, 120), status: r.status, mime: r.mimeType, type: m.params.type });
    }
  }
});

console.error("navigate amazon");
const t0 = Date.now();
const nav = await call("Page.navigate", { url: "https://www.amazon.com" }, sessionId);
console.error("nav result", JSON.stringify(nav));

for (let i = 0; i < 12; i++) {
  await delay(1000);
  if (proc.exitCode !== null || proc.signalCode) {
    console.log(JSON.stringify({ alive: false, signal: proc.signalCode, i }));
    break;
  }
  try {
    const r = await call(
      "Runtime.evaluate",
      {
        expression: `(() => ({
          title: document.title,
          ready: document.readyState,
          url: location.href,
          links: document.querySelectorAll("a[href]").length,
          html: document.documentElement?.outerHTML?.length ?? 0,
          body: (document.body?.innerText || "").replace(/\\s+/g," ").trim().slice(0, 500),
          captcha: /captcha|robot|automated|sorry/i.test(document.title + (document.body?.innerText||"")),
          meta: [...document.querySelectorAll("meta")].slice(0,8).map(m=>m.outerHTML.slice(0,120)),
          scripts: document.scripts.length,
          h1: [...document.querySelectorAll("h1")].map(e=>e.textContent.trim().slice(0,80)),
        }))()`,
        returnByValue: true,
      },
      sessionId,
      8000,
    );
    const v = r.result?.value ?? r;
    console.error(`[${i}s]`, JSON.stringify({ ...v, ms: Date.now() - t0, net: responses.slice(-5) }, null, 0).slice(0, 1200));
    if ((v.html ?? 0) > 10000 && v.title) break;
  } catch (e) {
    console.error(`[${i}s] err`, e.message, "alive", !proc.signalCode && proc.exitCode === null);
  }
}

const s = (await import("fs")).readFileSync(logPath, "utf8");
const interesting = s
  .split("\n")
  .filter((l) => /error|warn|panic|script|http|navigate|abort|status|amazon|fail/i.test(l))
  .slice(-40);
console.error("--- log tail ---");
console.error(interesting.join("\n"));
try {
  proc.kill("SIGKILL");
} catch {}
