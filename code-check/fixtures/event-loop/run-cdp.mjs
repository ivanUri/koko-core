#!/usr/bin/env node
/**
 * D7: MessageChannel + fetch-then-MC under CDP serve (host spin parity).
 *   node code-check/fixtures/event-loop/run-cdp.mjs
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createNetServer } from "node:net";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "../../..");
const BIN = join(REPO, "zig-out/bin/velora");
const FIXTURE_DIR = __dirname;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((res, rej) => {
    const s = createNetServer();
    s.unref();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
}

async function startStatic(port) {
  const server = createServer((req, res) => {
    const name = (req.url || "/").replace(/^\//, "").split("?")[0] || "index.html";
    try {
      const body = readFileSync(join(FIXTURE_DIR, name));
      const ct = name.endsWith(".html") ? "text/html; charset=utf-8" : "text/plain; charset=utf-8";
      res.writeHead(200, { "Content-Type": ct });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("missing");
    }
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  return server;
}

async function main() {
  const staticPort = await freePort();
  const staticServer = await startStatic(staticPort);
  const cdpPort = await freePort();

  const proc = spawn(
    BIN,
    ["serve", "--host", "127.0.0.1", "--port", String(cdpPort), "--log-level", "warn"],
    { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] }
  );
  const kill = () => {
    try {
      proc.kill("SIGKILL");
    } catch {}
    try {
      staticServer.close();
    } catch {}
  };
  const wall = setTimeout(() => {
    console.error("[HANG] run-cdp");
    kill();
    process.exit(3);
  }, 45000);

  try {
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).ok) break;
      } catch {}
      await delay(100);
    }
    const ver = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json();
    const ws = await new Promise((res, rej) => {
      const w = new WebSocket(ver.webSocketDebuggerUrl);
      w.once("open", () => res(w));
      w.once("error", rej);
    });
    let id = 0;
    const pending = new Map();
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message || JSON.stringify(msg.error))) : res(msg.result);
      }
    });
    const send = (method, params = {}, sessionId, to = 10000) => {
      const i = ++id;
      return new Promise((res, rej) => {
        const t = setTimeout(() => {
          pending.delete(i);
          rej(new Error("to " + method));
        }, to);
        pending.set(i, {
          res: (v) => {
            clearTimeout(t);
            res(v);
          },
          rej: (e) => {
            clearTimeout(t);
            rej(e);
          },
        });
        ws.send(JSON.stringify(sessionId ? { id: i, method, params, sessionId } : { id: i, method, params }));
      });
    };

    const fixtures = [
      "el-a-messagechannel-chain.html",
      "el-e-fetch-then-messagechannel.html",
      "el-k-xhr-completion-during-script.html",
      "el-l-cdp-large-spa-click.html",
      "el-n-cdp-press-hold.html",
    ];
    let failed = 0;
    for (const file of fixtures) {
      const url = `http://127.0.0.1:${staticPort}/${file}`;
      await send("Target.setDiscoverTargets", { discover: true }).catch(() => {});
      const { targetId } = await send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
      await send("Page.enable", {}, sessionId);
      await send("Runtime.enable", {}, sessionId);
      await send("Page.navigate", { url }, sessionId, 15000).catch((e) => console.log("nav", e.message));
      if (file === "el-l-cdp-large-spa-click.html") {
        let point = null;
        for (let i = 0; i < 40 && !point; i++) {
          await delay(100);
          const r = await send("Runtime.evaluate", {
            expression: `(() => { if (!window.__elReady) return null; const r = document.querySelector('#next span').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`,
            returnByValue: true,
          }, sessionId, 5000).catch(() => null);
          point = r?.result?.value || null;
        }
        if (point) {
          const common = { x: point.x, y: point.y, button: "left", clickCount: 1 };
          await send("Input.dispatchMouseEvent", { ...common, type: "mouseMoved", button: "none" }, sessionId);
          await send("Input.dispatchMouseEvent", { ...common, type: "mousePressed" }, sessionId);
          await send("Input.dispatchMouseEvent", { ...common, type: "mouseReleased" }, sessionId);
        }
      }
      if (file === "el-n-cdp-press-hold.html") {
        for (let i = 0; i < 40; i++) {
          const ready = await send("Runtime.evaluate", {
            expression: "!!window.__elReady",
            returnByValue: true,
          }, sessionId, 5000).catch(() => null);
          if (ready?.result?.value) break;
          await delay(100);
        }
        const common = { x: 10, y: 10, button: "left", clickCount: 1 };
        await send("Input.dispatchMouseEvent", { ...common, type: "mousePressed" }, sessionId);
        await delay(300);
        const observed = await send("Runtime.evaluate", {
          expression: "window.__downObservedBeforeRelease = window.__downAt !== null",
          returnByValue: true,
        }, sessionId, 5000);
        if (!observed?.result?.value) console.log("press was not observed before release");
        await send("Input.dispatchMouseEvent", { ...common, type: "mouseReleased" }, sessionId);
      }
      let ok = false;
      let last = null;
      for (let i = 0; i < 40; i++) {
        await delay(150);
        try {
          const r = await send(
            "Runtime.evaluate",
            {
              expression: `({done:!!window.__elDone, title:document.title, el:window.__el||null, events:window.__events||null})`,
              returnByValue: true,
            },
            sessionId,
            5000
          );
          last = r.result?.value;
          if (last?.done) {
            try {
              const j = JSON.parse(last.title);
              ok = !!j.ok;
            } catch {
              ok = !!(last.el && last.el.ok);
            }
            break;
          }
        } catch (e) {
          last = { err: e.message };
        }
      }
      console.log(ok ? "PASS" : "FAIL", "cdp", file, last);
      if (!ok) failed++;
      await send("Target.closeTarget", { targetId }).catch(() => {});
    }
    ws.close();
    kill();
    clearTimeout(wall);
    process.exit(failed ? 1 : 0);
  } catch (e) {
    console.error(e);
    kill();
    clearTimeout(wall);
    process.exit(1);
  }
}

main();
