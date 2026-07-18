#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { createProbeBudget, parseMaxSecArg } from "./lib/cdp-probe-budget.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bin = resolve(REPO, "zig-out/bin/velora");
const maxSec = parseMaxSecArg(process.argv, 15);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const getPort = () =>
  new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
    s.on("error", rej);
  });

let proc = null;
const cleanup = () => {
  if (proc && !proc.killed) try { proc.kill("SIGKILL"); } catch {}
};
const budget = createProbeBudget(maxSec, cleanup);

const port = await getPort();
proc = spawn(
  bin,
  [
    "serve",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--browser-profile",
    "chrome-local-huys-macbook-pro",
    "--log-level",
    "warn",
  ],
  { stdio: "ignore", cwd: REPO },
);
const endpoint = `http://127.0.0.1:${port}`;
for (let i = 0; i < 80; i++) {
  try {
    if ((await fetch(endpoint + "/json/version")).ok) break;
  } catch {}
  await delay(100);
}
const version = await (await fetch(endpoint + "/json/version")).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.once("open", res);
  ws.once("error", rej);
});
let id = 0;
const pending = new Map();
ws.on("message", (raw) => {
  const m = JSON.parse(String(raw));
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  }
});
const call = (method, params = {}, sessionId) => {
  const i = ++id;
  const p = { id: i, method, params };
  if (sessionId) p.sessionId = sessionId;
  ws.send(JSON.stringify(p));
  return new Promise((resolve, reject) => {
    pending.set(i, { resolve, reject });
    setTimeout(() => reject(new Error("t " + method)), 10000);
  });
};
await call("Target.setDiscoverTargets", { discover: true }).catch(() => {});
const { targetId } = await call("Target.createTarget", { url: "about:blank" });
const { sessionId } = await call("Target.attachToTarget", {
  targetId,
  flatten: true,
});
await call("Page.enable", {}, sessionId);
await call("Runtime.enable", {}, sessionId);

// Use http fixture
const html = `<!doctype html><html><body>
<script id="a">
window.log=[];
function L(m){window.log.push(m+':cs='+(document.currentScript&&document.currentScript.id));}
async function reg(){
  L('reg-start');
  await Promise.resolve();
  L('after-micro-await');
  await window.chunkP;
  L('after-chunk');
  window.result={id:document.currentScript&&document.currentScript.id, is:document.currentScript instanceof HTMLScriptElement, null:document.currentScript===null};
}
window.chunkP=new Promise(r=>window.resolveChunk=r);
reg();
L('after-reg-call');
</script>
<script id="chunk">
L('chunk-run');
window.resolveChunk();
L('chunk-after-resolve');
Promise.resolve().then(()=>L('chunk-micro'));
</script>
<script id="final">
window.done=true;
</script>
</body></html>`;

// page.navigate to a blob via set document - use Runtime to write
await call(
  "Page.navigate",
  {
    url:
      "data:text/html;charset=utf-8," +
      encodeURIComponent(html),
  },
  sessionId,
);
await delay(2000);
const state = await call(
  "Runtime.evaluate",
  {
    expression: "JSON.stringify({log:window.log,result:window.result,done:window.done,href:location.href})",
    returnByValue: true,
  },
  sessionId,
);
console.log(state.result?.value);
budget.clear();
cleanup();
ws.close();
