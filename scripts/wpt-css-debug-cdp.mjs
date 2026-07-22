// Minimal CDP probe: open WPT page, dump console + report state
import WebSocket from "ws";

const CDP_HTTP = "http://127.0.0.1:9222";
const PAGE = process.argv[2] || "http://127.0.0.1:8000/css/css-syntax/anb-parsing.html";

async function getWsUrl() {
  const r = await fetch(`${CDP_HTTP}/json/version`);
  const j = await r.json();
  return j.webSocketDebuggerUrl;
}

function cdp(ws) {
  let id = 0;
  const pending = new Map();
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else if (msg.method) {
      if (msg.method === "Runtime.consoleAPICalled") {
        const args = (msg.params.args || []).map((a) => a.value ?? a.description ?? JSON.stringify(a));
        console.log("[console]", msg.params.type, ...args);
      }
      if (msg.method === "Runtime.exceptionThrown") {
        console.log("[exception]", msg.params.exceptionDetails?.text, msg.params.exceptionDetails?.exception?.description);
      }
    }
  });
  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      pending.set(i, { resolve, reject });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
}

const wsUrl = await getWsUrl();
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.on("open", r));
const send = cdp(ws);

await send("Target.setDiscoverTargets", { discover: true });
const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
const s = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const i = Math.floor(Math.random() * 1e9);
    const onMsg = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.sessionId === sessionId && msg.id === i) {
        ws.off("message", onMsg);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
      if (msg.sessionId === sessionId && msg.method === "Runtime.consoleAPICalled") {
        const args = (msg.params.args || []).map((a) => a.value ?? a.description);
        console.log("[console]", ...args);
      }
      if (msg.sessionId === sessionId && msg.method === "Runtime.exceptionThrown") {
        console.log("[exception]", JSON.stringify(msg.params.exceptionDetails, null, 2).slice(0, 2000));
      }
    };
    ws.on("message", onMsg);
    ws.send(JSON.stringify({ id: i, method, params, sessionId }));
  });

await s("Page.enable");
await s("Runtime.enable");
await s("Page.navigate", { url: PAGE });
await new Promise((r) => setTimeout(r, 8000));
const report = await s("Runtime.evaluate", {
  expression: `({
    hasReport: typeof report !== 'undefined',
    complete: typeof report !== 'undefined' ? report.complete : null,
    completed: typeof report !== 'undefined' ? report.completed : null,
    log: typeof report !== 'undefined' ? String(report.log).slice(0,500) : null,
    sheets: document.styleSheets.length,
    title: document.title,
    scripts: [...document.scripts].map(s=>s.src)
  })`,
  returnByValue: true,
});
console.log("STATE", JSON.stringify(report.result?.value, null, 2));
ws.close();
process.exit(0);
