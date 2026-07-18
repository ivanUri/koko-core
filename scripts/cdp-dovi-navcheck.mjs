#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { createProbeBudget, parseMaxSecArg } from "./lib/cdp-probe-budget.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bin = resolve(REPO, "zig-out/bin/velora");
const maxSec = parseMaxSecArg(process.argv, 20);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const getPort = () => new Promise((res, rej) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
  s.on("error", rej);
});

let proc = null;
const cleanup = () => { if (proc && !proc.killed) try { proc.kill("SIGKILL"); } catch {} };
const budget = createProbeBudget(maxSec, cleanup);

const port = await getPort();
proc = spawn(bin, ["serve","--host","127.0.0.1","--port",String(port),"--browser-profile","chrome-local-huys-macbook-pro","--log-level","info"], { cwd: REPO, stdio: ["ignore","ignore","pipe"] });
let stderr = "";
proc.stderr.on("data", (d) => { stderr += d; if (stderr.length > 150000) stderr = stderr.slice(-100000); });
const endpoint = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) { try { if ((await fetch(endpoint + "/json/version")).ok) break; } catch {} await delay(100); }
const version = await (await fetch(endpoint + "/json/version")).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
let id = 0; const pending = new Map(); const events = [];
ws.on("message", (raw) => {
  const m = JSON.parse(String(raw));
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
  else if (m.method) events.push(m);
});
const call = (method, params = {}, sessionId, timeoutMs = 12000) => {
  const i = ++id; const payload = { id: i, method, params }; if (sessionId) payload.sessionId = sessionId;
  ws.send(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("t " + method)), timeoutMs);
    pending.set(i, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
  });
};
await call("Target.setDiscoverTargets", { discover: true }).catch(() => {});
const { targetId } = await call("Target.createTarget", { url: "about:blank" });
const { sessionId } = await call("Target.attachToTarget", { targetId, flatten: true });
await call("Page.enable", {}, sessionId);
await call("Runtime.enable", {}, sessionId);
await call("Network.enable", {}, sessionId).catch(() => {});
await call("Page.navigate", { url: "https://dovihome-sale.vercel.app/m/sale" }, sessionId);

for (let i = 0; i < 14; i++) {
  await delay(800);
  try {
    const r = await call("Runtime.evaluate", {
      expression: `(() => {
        const n = window.next;
        return {
          href: location.href,
          path: location.pathname,
          ready: document.readyState,
          typeofNext: typeof n,
          nextJson: n ? JSON.stringify(n) : null,
          nextNames: n ? Object.getOwnPropertyNames(n) : null,
          bodyLen: document.body ? document.body.innerText.length : -1,
          body: (document.body && document.body.innerText || '').slice(0, 200),
          htmlHasLogin: /login|đăng nhập/i.test(document.documentElement.innerHTML),
          tree: !!(history.state && history.state.__PRIVATE_NEXTJS_INTERNALS_TREE),
          turbo: typeof TURBOPACK,
          scripts: document.scripts.length,
        };
      })()`,
      returnByValue: true,
    }, sessionId);
    console.log("T" + i, JSON.stringify(r.result?.value));
    if (r.result?.value?.path === "/login" || (r.result?.value?.href || "").includes("/login")) {
      console.log("OK_REDIRECT");
      break;
    }
  } catch (e) {
    console.log("err", e.message);
  }
}

const bad = events.filter(e => e.method === "Runtime.exceptionThrown" || (e.method === "Runtime.consoleAPICalled" && e.params?.type === "error"))
  .map(e => e.method === "Runtime.exceptionThrown"
    ? (e.params?.exceptionDetails?.exception?.description || e.params?.exceptionDetails?.text)
    : (e.params?.args || []).map(a => a.value ?? a.description).join(" "));
console.log("EX", JSON.stringify(bad.slice(-15), null, 2));
const scriptLines = stderr.split("\n").filter((l) => /executing script|eval script|unhandled|Invariant|suppress|currentScript/i.test(l));
console.log("SCRIPT_LINES", scriptLines.length);
console.log("STDERR", scriptLines.slice(-40).join("\n"));
budget.clear(); cleanup(); ws.close();
