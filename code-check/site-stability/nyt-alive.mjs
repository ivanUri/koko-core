import { createServer as createNetServer } from "node:net";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
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
const proc = spawn(
  VELORA,
  ["serve", "--host", "127.0.0.1", "--port", String(port), "--log-level", "error", "--browser-profile", "chrome-macos-catalina"],
  { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] },
);
const logs = [];
proc.stderr.on("data", (d) => logs.push(String(d)));
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
const call = (method, params = {}, sid = null, timeout = 8000) =>
  new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, { res, rej });
    const p = { id: mid, method, params };
    if (sid) p.sessionId = sid;
    if (ws.readyState !== WebSocket.OPEN) return rej(new Error("ws closed " + method));
    ws.send(JSON.stringify(p));
    setTimeout(() => {
      if (pending.has(mid)) {
        pending.delete(mid);
        rej(new Error("timeout " + method));
      }
    }, timeout);
  });

const t0 = Date.now();
const { targetId } = await call("Target.createTarget", { url: "about:blank" });
const { sessionId } = await call("Target.attachToTarget", { targetId, flatten: true });
await call("Page.enable", {}, sessionId);
await call("Runtime.enable", {}, sessionId);
console.error("navigate");
await call("Page.navigate", { url: "https://www.nytimes.com" }, sessionId);

let last = null;
for (let i = 0; i < 20; i++) {
  await delay(1000);
  if (proc.exitCode !== null || proc.signalCode) {
    console.log(JSON.stringify({ alive: false, exit: proc.exitCode, signal: proc.signalCode, ms: Date.now() - t0, i }));
    break;
  }
  try {
    const r = await call(
      "Runtime.evaluate",
      {
        expression: `({title:document.title, ready:document.readyState, links:document.querySelectorAll('a[href]').length, html:(document.documentElement?.outerHTML||'').length, url:location.href})`,
        returnByValue: true,
      },
      sessionId,
      5000,
    );
    last = r.result?.value ?? r;
    console.error(`[${i}s]`, JSON.stringify(last));
    if ((last.links ?? 0) > 20 && (last.html ?? 0) > 20000) break;
  } catch (e) {
    console.error(`[${i}s] eval err:`, e.message, "alive=", proc.exitCode === null && !proc.signalCode);
  }
}

console.log(
  "RESULT",
  JSON.stringify({
    alive: proc.exitCode === null && !proc.signalCode,
    exit: proc.exitCode,
    signal: proc.signalCode,
    ms: Date.now() - t0,
    last,
  }),
);
try {
  proc.kill("SIGKILL");
} catch {}
