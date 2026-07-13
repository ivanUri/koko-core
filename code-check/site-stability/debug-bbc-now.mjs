#!/usr/bin/env node
import { createServer as createNetServer } from "node:net";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { resolve } from "node:path";

const REPO = "/Users/huydev/Desktop/velora";
const VELORA = resolve(REPO, "zig-out/bin/velora");
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
console.error("spawn velora", VELORA, "port", port);
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

let stderr = "";
proc.stderr.on("data", (d) => {
  const s = String(d);
  stderr += s;
  process.stderr.write(s);
});
proc.stdout.on("data", (d) => process.stderr.write(d));
proc.on("exit", (code, signal) => {
  console.error("\n[velora exited]", { code, signal });
});

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
  ws.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    }
  });
  ws.on("close", () => console.error("[ws closed]"));

  const call = (method, params = {}, sid = null, timeout = 30000) =>
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

  console.error("navigating BBC...");
  await call("Page.navigate", { url: "https://www.bbc.com/news" }, sessionId);
  await delay(12000);

  const expr = `(() => ({
    title: document.title,
    url: location.href,
    readyState: document.readyState,
    linkCount: document.querySelectorAll("a[href]").length,
    bodyText: (document.body?.innerText || "").slice(0, 300),
    htmlBytes: document.documentElement?.outerHTML?.length ?? 0,
  }))()`;

  const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true }, sessionId);
  console.log("EXTRACT", JSON.stringify(r.result?.value ?? r, null, 2));

  // console errors via evaluate if still alive
  const errs = await call(
    "Runtime.evaluate",
    {
      expression: `(() => {
        // best effort: look for next error boundary text
        return {
          nextErr: !!document.querySelector('.next-error-h1, [data-nextjs-dialog]'),
          h2: [...document.querySelectorAll('h1,h2')].slice(0,5).map(e => e.textContent.slice(0,80)),
        };
      })()`,
      returnByValue: true,
    },
    sessionId,
  );
  console.log("EXTRA", JSON.stringify(errs.result?.value ?? errs, null, 2));
} catch (e) {
  console.error("PROBE ERROR:", e.message);
  console.error("--- stderr tail ---");
  console.error(stderr.slice(-4000));
} finally {
  try {
    proc.kill("SIGKILL");
  } catch {}
  process.exit(0);
}
