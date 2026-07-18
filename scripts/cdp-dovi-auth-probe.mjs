#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { createProbeBudget, parseMaxSecArg } from "./lib/cdp-probe-budget.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const VELORA_BIN = resolve(REPO, "zig-out/bin/velora");
const TARGET = process.argv.find((a) => a.startsWith("http")) || "https://dovihome-sale.vercel.app/m/sale";
const maxSec = parseMaxSecArg(process.argv, 20);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

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

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result);
        return;
      }
      if (m.method) this.events.push(m);
    });
  }
  call(method, params = {}, sessionId, timeoutMs = 12000) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout " + method)), timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
    });
  }
}

let proc = null;
const cleanup = () => { if (proc && !proc.killed) try { proc.kill("SIGKILL"); } catch {} };
const budget = createProbeBudget(maxSec, cleanup);

async function ev(client, sid, expression) {
  const r = await client.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: false }, sid);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
}

async function main() {
  const port = await getFreePort();
  const endpoint = `http://127.0.0.1:${port}`;
  proc = spawn(VELORA_BIN, ["serve","--host","127.0.0.1","--port",String(port),"--browser-profile","chrome-local-huys-macbook-pro","--log-level","info"], { cwd: REPO, stdio: ["ignore","pipe","pipe"] });
  let stderr = "";
  proc.stderr.on("data", d => { stderr += d.toString(); if (stderr.length > 200000) stderr = stderr.slice(-120000); });

  for (let i=0;i<100;i++){ try { if ((await fetch(endpoint+"/json/version")).ok) break; } catch{} await delay(100); if(i===99) throw new Error("no cdp"); }
  const version = await (await fetch(endpoint+"/json/version")).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res,rej)=>{ws.once("open",res);ws.once("error",rej);});
  const client = new Cdp(ws);
  await client.call("Target.setDiscoverTargets",{discover:true}).catch(()=>{});
  const { targetId } = await client.call("Target.createTarget",{url:"about:blank"});
  const { sessionId } = await client.call("Target.attachToTarget",{targetId, flatten:true});
  await client.call("Page.enable",{},sessionId);
  await client.call("Runtime.enable",{},sessionId);
  await client.call("Network.enable",{},sessionId).catch(()=>{});
  await client.call("Page.navigate",{url:TARGET},sessionId);

  const t0 = Date.now();
  let last = null;
  while (Date.now()-t0 < 12000) {
    await delay(1000);
    try {
      last = await ev(client, sessionId, `(() => {
        const next = window.next || null;
        const routerKeys = next ? Object.keys(next) : [];
        let tree = null;
        try { tree = window.history.state && window.history.state.__PRIVATE_NEXTJS_INTERNALS_TREE; } catch {}
        const scripts = [...document.scripts].map(s => (s.src||'').split('/').pop()).slice(0,20);
        const links = [...document.querySelectorAll('a')].map(a => a.getAttribute('href')).slice(0,15);
        const inputs = [...document.querySelectorAll('input,button')].map(el => ({tag:el.tagName,type:el.type,name:el.name,text:(el.innerText||el.value||'').slice(0,40)})).slice(0,20);
        return {
          href: location.href,
          ready: document.readyState,
          title: document.title,
          nextVersion: next && next.version,
          nextAppDir: next && next.appDir,
          nextKeys: routerKeys,
          hasLoginText: /đăng nhập|login|sign in/i.test(document.body?document.body.innerText:''),
          hasSaleText: /quản lý đơn|spinner|loading/i.test(document.body?document.body.innerText:''),
          bodySlice: (document.body&&document.body.innerText||'').slice(0,250),
          htmlLen: document.documentElement.outerHTML.length,
          scriptCount: document.scripts.length,
          scripts,
          links,
          inputs,
          cookie: document.cookie,
          localKeys: Object.keys(localStorage||{}),
          sessionKeys: Object.keys(sessionStorage||{}),
          historyTree: !!tree,
          turboType: typeof globalThis.TURBOPACK,
        };
      })()`);
      console.log("SNAP", JSON.stringify(last, null, 2));
      if (last.href && last.href.includes("/login")) break;
    } catch (e) { console.log("err", e.message); }
  }

  const net = client.events.filter(e => e.method === "Network.responseReceived" || e.method === "Network.requestWillBeSent")
    .map(e => {
      if (e.method === "Network.requestWillBeSent") return {t:"req", url: e.params?.request?.url, type: e.params?.type};
      return {t:"res", url: e.params?.response?.url, status: e.params?.response?.status, mime: e.params?.response?.mimeType};
    })
    .filter(x => x.url && !x.url.includes("favicon") && !x.url.includes("woff"));
  console.log("NET", JSON.stringify(net.slice(0,80), null, 2));

  const ex = client.events.filter(e => e.method === "Runtime.exceptionThrown" || e.method === "Runtime.consoleAPICalled")
    .map(e => {
      if (e.method === "Runtime.exceptionThrown") return {t:"ex", d: e.params?.exceptionDetails?.exception?.description || e.params?.exceptionDetails?.text};
      const args = (e.params?.args||[]).map(a=>a.value??a.description??"").join(" ");
      return {t:e.params?.type, args: args.slice(0,300)};
    });
  console.log("LOGS", JSON.stringify(ex.slice(-40), null, 2));
  console.log("STDERR_MATCHES");
  for (const line of stderr.split("\n")) {
    if (/error|warn|suppress|Invariant|currentScript|login|navigate|script fetch|eval script|Recursive|IsOnCentral/i.test(line))
      console.log(line.slice(0, 300));
  }

  budget.clear(); client.ws.close(); cleanup();
}
main().catch(e => { console.error(e); budget.clear(); cleanup(); process.exit(1); });
