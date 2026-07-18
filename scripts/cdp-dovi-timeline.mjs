import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import WebSocket from "ws";

const bin = resolve("zig-out/bin/velora");
const getPort = () => new Promise((res, rej) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
  s.on("error", rej);
});
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const port = await getPort();
const proc = spawn(bin, ["serve","--host","127.0.0.1","--port",String(port),"--browser-profile","chrome-local-huys-macbook-pro","--log-level","info"], { stdio: ["ignore","ignore","pipe"], cwd: resolve(".") });
let err = "";
proc.stderr.on("data", (d) => { err += d; if (err.length > 200000) err = err.slice(-120000); });
const endpoint = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) { try { if ((await fetch(endpoint + "/json/version")).ok) break; } catch {} await delay(100); }
const version = await (await fetch(endpoint + "/json/version")).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
let id = 0; const pending = new Map();
ws.on("message", (raw) => {
  const m = JSON.parse(String(raw));
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
  }
});
const call = (method, params = {}, sessionId, timeoutMs = 15000) => {
  const i = ++id; const payload = { id: i, method, params };
  if (sessionId) payload.sessionId = sessionId;
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

await call("Page.addScriptToEvaluateOnNewDocument", {
  source: `
(function(){
  const tl = window.__tl = [];
  const mark = (m, extra) => { try { tl.push(Object.assign({t: performance.now()|0, m}, extra||{})); } catch(e){} };
  mark('boot-hook');
  let _next;
  Object.defineProperty(window, 'next', {
    configurable: true, enumerable: true,
    get(){ return _next; },
    set(v){ mark('next-set', { keys: v && typeof v==='object' ? Object.keys(v) : null, ver: v && v.version }); _next = v; }
  });
  let _tp;
  Object.defineProperty(window, 'TURBOPACK', {
    configurable: true, enumerable: true,
    get(){ return _tp; },
    set(v){
      mark('tp-set', { isArr: Array.isArray(v), keys: v && typeof v==='object' ? Object.keys(v).slice(0,6) : null, hasPush: !!(v&&v.push) });
      _tp = v;
      if (v && typeof v.push === 'function' && !Array.isArray(v)) {
        const orig = v.push.bind(v);
        v.push = function(x){
          mark('tp-push-fn', { hasCs: !!(document.currentScript), src: document.currentScript && (document.currentScript.src||'').split('/').pop(), n: Array.isArray(x)?x.length:1 });
          try { return orig(x); } catch(e) { mark('tp-push-err', { err: String(e&&e.message||e) }); throw e; }
        };
      }
    }
  });
  window.addEventListener('error', e => mark('error', { msg: e.message, file: (e.filename||'').split('/').pop() }));
  window.addEventListener('unhandledrejection', e => mark('rej', { msg: String(e.reason && (e.reason.message||e.reason)).slice(0,200) }));
  const ofetch = window.fetch;
  if (ofetch) {
    window.fetch = function(input, init){
      const u = typeof input==='string' ? input : (input && input.url) || '';
      if (u.includes('login') || u.includes('_rsc') || u.includes('_next')) mark('fetch', { u: u.slice(0,120) });
      return ofetch.apply(this, arguments).then(r => { if (u.includes('login')||u.includes('_rsc')) mark('fetch-done', { u: u.slice(0,80), status: r.status }); return r; });
    };
  }
})();
`,
}, sessionId);

await call("Page.navigate", { url: "https://dovihome-sale.vercel.app/m/sale" }, sessionId);
await delay(8000);
const r = await call("Runtime.evaluate", {
  expression: `({
    href: location.href,
    nextType: typeof window.next,
    next: window.next ? {version: window.next.version, appDir: window.next.appDir, turbopack: window.next.turbopack} : null,
    tp: { isArr: Array.isArray(TURBOPACK), keys: TURBOPACK && Object.keys(TURBOPACK).slice(0,8), len: TURBOPACK && TURBOPACK.length },
    bodyLen: (document.body && document.body.innerText || '').length,
    tl: (window.__tl || []).slice(0, 80),
  })`,
  returnByValue: true,
}, sessionId);
console.log(JSON.stringify(r.result?.value, null, 2));
console.log('---stderr---');
console.log(err.split('\n').filter(l => /Recursive|Invariant|unhandled|eval script|scriptAdded/i.test(l)).join('\n') || '(none)');
proc.kill('SIGKILL'); ws.close();
