import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bin = resolve(REPO, "zig-out/bin/velora");
const getPort = () =>
  new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
    s.on("error", rej);
  });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const port = await getPort();
const proc = spawn(
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
    "info",
  ],
  { stdio: ["ignore", "ignore", "pipe"], cwd: REPO },
);
let err = "";
proc.stderr.on("data", (d) => {
  err += d;
});
const endpoint = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) {
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
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
  }
});
const call = (method, params = {}, sessionId, timeoutMs = 15000) => {
  const i = ++id;
  const payload = { id: i, method, params };
  if (sessionId) payload.sessionId = sessionId;
  ws.send(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("t " + method)), timeoutMs);
    pending.set(i, {
      resolve: (v) => {
        clearTimeout(t);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(t);
        reject(e);
      },
    });
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
await call(
  "Page.navigate",
  { url: "https://dovihome-sale.vercel.app/m/sale" },
  sessionId,
);

let last = null;
for (let i = 0; i < 20; i++) {
  await delay(500);
  const r = await call(
    "Runtime.evaluate",
    {
      expression: `({
    href: location.href,
    path: location.pathname,
    next: typeof window.next,
    nextV: window.next && window.next.version,
    router: !!(window.next && window.next.router),
    spinner: !!document.querySelector(".animate-spin"),
    inputs: document.querySelectorAll("input").length,
    password: !!document.querySelector("input[type=password]"),
    body: (document.body && document.body.innerText || "").slice(0, 250),
  })`,
      returnByValue: true,
    },
    sessionId,
  );
  last = r.result?.value;
  console.log(
    "P" + i,
    JSON.stringify({
      path: last.path,
      next: last.next,
      router: last.router,
      spinner: last.spinner,
      inputs: last.inputs,
      password: last.password,
      body: (last.body || "").slice(0, 90),
    }),
  );
  if (last.path === "/login" || last.password) break;
}
console.log("FINAL", JSON.stringify(last, null, 2));
console.log(
  err
    .split("\n")
    .filter((l) => /navigate |login|Recursive|Invariant|unhandled/i.test(l))
    .join("\n"),
);
const pass =
  last &&
  (last.path === "/login" || last.password === true || last.inputs > 0);
proc.kill("SIGKILL");
ws.close();
process.exit(pass ? 0 : 2);
