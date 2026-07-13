#!/usr/bin/env node
import { createServer as createNetServer } from "node:net";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const VELORA = resolve(REPO, "zig-out/bin/velora");
const URL = process.argv[2] || "https://www.nytimes.com";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  return new Promise((res, rej) => {
    const s = createNetServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

async function waitCdp(endpoint) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${endpoint}/json/version`)).ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error("CDP not ready");
}

const port = await freePort();
const endpoint = `http://127.0.0.1:${port}`;
const proc = spawn(
  VELORA,
  [
    "serve",
    "--host", "127.0.0.1",
    "--port", String(port),
    "--log-level", "warn",
    "--browser-profile", "chrome-macos-catalina",
  ],
  { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] },
);

const logs = [];
proc.stderr.on("data", (d) => {
  const s = String(d);
  logs.push(s);
  if (/console\.error|IndexSize|TypeError|segfault|panic|ArenaPool|Application error|SIG|abort|FATAL|exception/i.test(s)) {
    process.stderr.write(s.slice(0, 800));
  }
});
proc.on("exit", (code, signal) => console.error("\n[velora exit]", { code, signal }));

try {
  await waitCdp(endpoint);
  const { webSocketDebuggerUrl } = await (await fetch(`${endpoint}/json/version`)).json();
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.once("open", res);
    ws.once("error", rej);
  });

  let id = 0;
  const pending = new Map();
  const jsErrors = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
      return;
    }
  });
  ws.on("close", () => console.error("[ws closed]"));

  const call = (method, params = {}, sid = null, timeout = 35000) =>
    new Promise((res, rej) => {
      const mid = ++id;
      pending.set(mid, { res, rej });
      const p = { id: mid, method, params };
      if (sid) p.sessionId = sid;
      if (ws.readyState !== WebSocket.OPEN) return rej(new Error("ws not open for " + method));
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
  await call("Runtime.enable", {}, sessionId);
  await call("Page.enable", {}, sessionId);

  // capture console via evaluate hook after load; also enable Runtime for exceptions if possible
  await call(
    "Page.addScriptToEvaluateOnNewDocument",
    {
      source: `window.__veloraErrs=[];
window.addEventListener('error',e=>window.__veloraErrs.push({t:'error',m:String(e.message),f:e.filename,l:e.lineno}));
window.addEventListener('unhandledrejection',e=>window.__veloraErrs.push({t:'rejection',m:String(e.reason)}));
const ce=console.error; console.error=function(){try{window.__veloraErrs.push({t:'console',m:[...arguments].map(String).join(' ').slice(0,300)})}catch(x){} return ce.apply(this,arguments)};`,
    },
    sessionId,
  ).catch(() => {});

  console.error("navigating", URL);
  const t0 = Date.now();
  await call("Page.navigate", { url: URL }, sessionId);
  await delay(15000);

  const r = await call(
    "Runtime.evaluate",
    {
      expression: `(() => ({
        title: document.title,
        url: location.href,
        readyState: document.readyState,
        linkCount: document.querySelectorAll("a[href]").length,
        htmlBytes: document.documentElement?.outerHTML?.length ?? 0,
        bodyBytes: document.body?.innerHTML?.length ?? 0,
        bodyText: (document.body?.innerText || "").replace(/\\s+/g," ").trim().slice(0,400),
        h1: [...document.querySelectorAll("h1")].slice(0,5).map(e=>e.textContent.trim().slice(0,80)),
        nextErr: /application error|client-side exception/i.test(document.title+document.body?.innerText),
        cloudflare: /just a moment|cf-browser-verification|challenge-platform/i.test(document.title+document.body?.innerText),
        paywall: /subscribe|log in|create a free account|you.ve reached your limit/i.test((document.body?.innerText||"").slice(0,2000)),
        errs: (window.__veloraErrs||[]).slice(0,15),
        errCount: (window.__veloraErrs||[]).length,
      }))()`,
      returnByValue: true,
    },
    sessionId,
  );

  const v = r.result?.value ?? r;
  console.log("\n=== NYTimes probe ===");
  console.log(JSON.stringify({ ...v, ms: Date.now() - t0 }, null, 2));

  // status classification
  let status = "OK";
  if (v.nextErr) status = "CLIENT_ERROR";
  else if (v.cloudflare) status = "BOT_CHALLENGE";
  else if ((v.linkCount ?? 0) < 5 && (v.htmlBytes ?? 0) < 5000) status = "THIN_OR_BLOCKED";
  else if ((v.linkCount ?? 0) < 20) status = "SPARSE";
  console.log("\nSTATUS:", status);
  console.log("process signal:", proc.signalCode, "exit:", proc.exitCode);
} catch (e) {
  console.error("PROBE ERROR:", e.message);
  console.error("process:", proc.exitCode, proc.signalCode);
  const joined = logs.join("");
  console.error("--- stderr interesting ---");
  console.error(
    joined
      .split("\n")
      .filter((l) => /error|panic|segfault|Arena|abort|crash|exception|TypeError|IndexSize/i.test(l))
      .slice(-40)
      .join("\n"),
  );
} finally {
  try {
    proc.kill("SIGKILL");
  } catch {}
}
