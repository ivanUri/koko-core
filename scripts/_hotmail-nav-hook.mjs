#!/usr/bin/env node
/**
 * Hook Fluent navigation after CheckAvailable:
 * - history.push/replace with full args
 * - capture isAvailable handling side-effects via path + password field
 * - dump usernameType-ish signals from DOM (domain dropdown)
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import WebSocket from "ws";
import { resolve } from "node:path";

const ROOT = "/Users/huydev/Desktop/velora";
const VELORA = resolve(ROOT, "zig-out/bin/velora");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
    s.on("error", rej);
  });
}
class Cdp {
  constructor(ws) {
    this.ws = ws; this.nextId = 1; this.pending = new Map();
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.id == null) return;
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id); clearTimeout(p.timer);
      if (m.error) p.reject(new Error(m.error.message));
      else p.resolve(m.result);
    });
  }
  send(method, params = {}, sessionId = null, timeoutMs = 12000) {
    const id = this.nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolveR, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve: resolveR, reject, timer });
      this.ws.send(JSON.stringify(message));
    });
  }
}
async function evalv(cdp, sid, expression, timeoutMs = 12000) {
  const r = await cdp.send("Runtime.evaluate", {
    expression, returnByValue: true, awaitPromise: false,
  }, sid, timeoutMs);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval fail");
  return r.result?.value;
}
async function lpClick(cdp, sid) {
  const marker = "n" + Date.now();
  const found = await evalv(cdp, sid, `(()=>{const b=[...document.querySelectorAll('button')].find(x=>/^\\s*next\\s*$/i.test((x.innerText||'').trim()))||document.querySelector('button[type=submit]');if(!b)return null;b.id='${marker}';return b.id})()`);
  if (!found) throw new Error("no next");
  const { elements = [] } = await cdp.send("LP.getInteractiveElements", {}, sid);
  const t = elements.find((e) => e.id === found);
  if (!t?.backendNodeId) throw new Error("no backend");
  const t0 = Date.now();
  await cdp.send("LP.clickNode", { backendNodeId: t.backendNodeId }, sid);
  return { id: found, ms: Date.now() - t0 };
}

const port = await freePort();
const child = spawn(VELORA, [
  "serve", "--host", "127.0.0.1", "--port", String(port),
  "--browser-profile", "chrome-local-huys-macbook-pro", "--log-level", "warn",
], { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"] });
const stop = () => { if (child.exitCode === null) child.kill("SIGTERM"); };
process.once("SIGINT", stop); process.once("SIGTERM", stop);

try {
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {}
    await sleep(200);
  }
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((o, e) => { ws.once("open", o); ws.once("error", e); });
  const cdp = new Cdp(ws);
  const { targetId } = await cdp.send("Target.createTarget", { url: "https://signup.live.com/?lic=1" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);

  for (let i = 0; i < 40; i++) {
    if (await evalv(cdp, sessionId, `!!document.querySelector('input[type=email]')`).catch(() => false)) break;
    if (i === 15) await cdp.send("Page.navigate", { url: "https://signup.live.com/?lic=1" }, sessionId).catch(() => {});
    await sleep(400);
  }

  // Install hooks BEFORE interaction
  await evalv(cdp, sessionId, `(() => {
    globalThis.__h = { hist: [], fetch: [], err: [], logs: [] };
    const wrap = (name, fn) => function(s, t, u) {
      const rec = {
        op: name,
        s: typeof s === 'object' ? JSON.stringify(s).slice(0, 80) : String(s),
        t: String(t ?? ''),
        u: u === undefined ? '<undef>' : String(u),
        before: location.pathname + location.search,
      };
      try {
        const r = fn.call(this, s, t, u);
        rec.after = location.pathname + location.search;
        globalThis.__h.hist.push(rec);
        return r;
      } catch (e) {
        rec.err = String(e && e.message || e);
        globalThis.__h.hist.push(rec);
        throw e;
      }
    };
    history.pushState = wrap('push', history.pushState.bind(history));
    history.replaceState = wrap('repl', history.replaceState.bind(history));
    addEventListener('error', e => globalThis.__h.err.push(String(e.message || e.error)));
    addEventListener('unhandledrejection', e => globalThis.__h.err.push('rej:' + String(e.reason && (e.reason.stack || e.reason.message) || e.reason)));
    const of = fetch;
    globalThis.fetch = function(...a) {
      const u = String(a[0]?.url || a[0]);
      const b = typeof a[1]?.body === 'string' ? a[1].body : null;
      const e = { u: u.slice(0, 120), req: (b || '').slice(0, 250), t: Date.now() };
      const p = Reflect.apply(of, this, a);
      p.then(async r => {
        e.status = r.status;
        try { e.resp = (await r.clone().text()).slice(0, 400); } catch (x) { e.respErr = String(x); }
        globalThis.__h.fetch.push(e);
      }, err => { e.err = String(err.message || err); globalThis.__h.fetch.push(e); });
      return p;
    };
    // Try to intercept console
    for (const k of ['log','warn','error']) {
      const o = console[k].bind(console);
      console[k] = (...args) => {
        try { globalThis.__h.logs.push({k, m: args.map(String).join(' ').slice(0, 200)}); } catch {}
        return o(...args);
      };
    }
    return { path: location.pathname, href: location.href };
  })()`).then(r => console.log('hooks', r));

  const full = `veloratest${Date.now()}@outlook.com`;
  await evalv(cdp, sessionId, `(()=>{const el=document.querySelector('input[type=email]');el.focus();try{el.select()}catch{};return true})()`);
  await cdp.send("Input.insertText", { text: full }, sessionId);
  await sleep(300);
  console.log('s1 val', await evalv(cdp, sessionId, `document.querySelector('input[type=email]')?.value`));

  let c = await lpClick(cdp, sessionId);
  console.log('s1 click', c);

  for (let i = 0; i < 15; i++) {
    await sleep(400);
    const ui = await evalv(cdp, sessionId, `(()=>{
      const t=document.body?.innerText||'';
      return {
        newEmail: /new email/i.test(t) || !!document.querySelector('input[aria-label*="New email" i]'),
        password: !!document.querySelector('input[type=password]'),
        path: location.pathname,
        domain: document.querySelector('#domainDropdownId')?.innerText,
        val: document.querySelector('input[type=email]')?.value,
      };
    })()`);
    if (ui.password || ui.newEmail) { console.log('ui', ui); break; }
  }

  const mid = await evalv(cdp, sessionId, `({path:location.pathname, hist:globalThis.__h.hist, fetch:globalThis.__h.fetch, err:globalThis.__h.err})`);
  console.log('after s1', JSON.stringify(mid, null, 2));

  // clear and do new-email next without refill
  await evalv(cdp, sessionId, `globalThis.__h.hist=[]; globalThis.__h.fetch=[]; globalThis.__h.err=[]; globalThis.__h.logs=[]; true`);
  c = await lpClick(cdp, sessionId);
  console.log('s2 click', c);

  for (let i = 0; i < 20; i++) {
    await sleep(400);
    const snap = await evalv(cdp, sessionId, `(()=>({
      path: location.pathname,
      href: location.href,
      password: !!document.querySelector('input[type=password]'),
      body: (document.body?.innerText||'').replace(/\\s+/g,' ').trim().slice(0,100),
      hist: globalThis.__h.hist,
      fetch: globalThis.__h.fetch,
      err: globalThis.__h.err,
      logs: globalThis.__h.logs?.slice(-10),
      inputs: [...document.querySelectorAll('input')].map(el=>({type:el.type,id:el.id,aria:el.getAttribute('aria-label')})),
    }))()`);
    if (i === 0 || i === 2 || i === 5 || snap.password || snap.path !== '/' || (snap.err && snap.err.length) || (snap.hist && snap.hist.length)) {
      console.log(`t=${(i + 1) * 400}`, JSON.stringify({
        path: snap.path, password: snap.password, body: snap.body?.slice(0, 70),
        hist: snap.hist, fetchN: snap.fetch?.length, fetch: snap.fetch, err: snap.err, inputs: snap.inputs, logs: snap.logs,
      }));
    }
    if (snap.password) {
      console.log('SUCCESS password');
      stop();
      process.exit(0);
    }
  }

  // Try forcing SPA path after API success
  console.log('force pushState password path...');
  const forced = await evalv(cdp, sessionId, `(()=>{
    history.pushState({forced:1}, '', '/SignUpPasswordCollection');
    // dispatch popstate so routers notice
    dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    return { path: location.pathname, href: location.href, password: !!document.querySelector('input[type=password]'), body: (document.body?.innerText||'').replace(/\\s+/g,' ').trim().slice(0,80) };
  })()`);
  console.log('forced', forced);
  await sleep(1000);
  console.log('after force', await evalv(cdp, sessionId, `({path:location.pathname,password:!!document.querySelector('input[type=password]'),inputs:[...document.querySelectorAll('input')].map(el=>({type:el.type,id:el.id})),body:(document.body?.innerText||'').replace(/\\s+/g,' ').trim().slice(0,100)})`));

  stop();
  process.exit(2);
} catch (e) {
  console.error(e);
  stop();
  process.exit(1);
}
