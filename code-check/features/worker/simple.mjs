#!/usr/bin/env node

const { spawn } = require("node:child_process");
const net = require("node:net");
const http = require("node:http");
const { existsSync, mkdirSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");

const repoRoot = resolve(__dirname, "../..");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");

const CONFIG = {
  outDir: resolve(repoRoot, "code-check/tmp/simple-worker-test"),
  htmlFile: "page.html",
  logFile: "page.log",
  workerFile: "worker.js",
  loadTimeoutMs: 15000,
  resultTimeoutMs: 5000,
  timeoutMs: 30000,
  logLevel: "info",
};

const workerScript = `
console.log("[worker] top-level start");
self.__workerBooted = true;

const workerScopeReport = {
  type: "worker-scope-report",
  typeofSelf: typeof self,
  constructorName: self?.constructor?.name ?? null,
  typeofPostMessage: typeof postMessage,
  typeofAddEventListener: typeof addEventListener,
  typeofNavigator: typeof navigator,
  typeofWorkerGlobalScope: typeof WorkerGlobalScope,
};

console.log("[worker] scope", workerScopeReport);

for (const [key, value] of Object.entries(workerScopeReport)) {
  if (key === "type") continue;
  const unexpected = (
    (key === "typeofSelf" && value !== "object") ||
    (key === "typeofPostMessage" && value !== "function") ||
    (key === "typeofAddEventListener" && value !== "function") ||
    (key === "typeofNavigator" && value !== "object") ||
    (key === "typeofWorkerGlobalScope" && value !== "function")
  );
  if (unexpected) {
    console.log("[worker] unexpected global", key, value);
  }
}

try {
  postMessage({
    phase: "boot",
    booted: self.__workerBooted === true,
    scope: workerScopeReport,
  });
  console.log("[worker] boot message posted");
} catch (error) {
  console.log("[worker] boot message failed", {
    message: error?.message ?? String(error),
  });
}

self.onmessage = (event) => {
  console.log("[worker] received message", {
    data: event.data,
    type: event.type,
  });

  const payload = event.data;
  self.postMessage({
    type: "worker-response",
    phase: "response",
    received: payload,
    navigator: {
      userAgent: self.navigator?.userAgent ?? null,
      platform: self.navigator?.platform ?? null,
      hardwareConcurrency: self.navigator?.hardwareConcurrency ?? null,
      deviceMemory: self.navigator?.deviceMemory ?? null,
    },
    hasSelf: typeof self,
    hasPostMessage: typeof self.postMessage,
  });

  console.log("[worker] response posted");
};

console.log("[worker] onmessage installed");
console.log("[worker] top-level end");
`;

const pageHtml = `<!doctype html>
<html lang="en">
  <body>
    <pre id="log">booting...</pre>
    <script>
      const log = document.getElementById("log");
      const lines = [];
      const add = (...args) => {
        const text = args.map((value) => {
          if (typeof value === "string") return value;
          try {
            return JSON.stringify(value);
          } catch {
            return String(value);
          }
        }).join(" ");
        lines.push(text);
        log.textContent = lines.join("\\n");
        console.log(text);
      };

      window.__workerTestResult = null;
      window.__workerProbeState = {
        boot: null,
        response: null,
        complete: false,
        startedAt: Date.now(),
      };
      const workerEvents = [];
      let nextMessageId = 1;
      const finalize = (result) => {
        window.__workerTestResult = result;
        window.__workerProbeState.complete = true;
      };
      add("[page] creating worker");

      let worker;
      try {
        worker = new Worker("/worker.js");
      } catch (error) {
        add("[page] worker constructor failed", {
          message: error?.message ?? String(error),
        });
        finalize({
          ok: false,
          stage: "constructor",
          error: {
            message: error?.message ?? String(error),
          },
          workerEvents,
          probeState: window.__workerProbeState,
        });
      }

      if (worker) {
        let bootProbeTimer;
        let responseProbeTimer;
        const updateCompletion = () => {
          if (window.__workerProbeState.complete) return;
          if (window.__workerProbeState.boot && window.__workerProbeState.response) {
            finalize({
              ok: true,
              stage: "response",
              boot: window.__workerProbeState.boot,
              response: window.__workerProbeState.response,
              workerEvents,
              probeState: window.__workerProbeState,
            });
          }
        };

worker.onmessage = (event) => {
  workerEvents.push({
    kind: "message",
    data: event.data,
    at: Date.now(),
  });

  add("[page] worker.onmessage", event.data);

  if (event.data?.phase === "boot") {
    clearTimeout(bootProbeTimer);

    window.__workerProbeState.boot = event.data;

    add("[page] boot phase received");

    const outbound = {
      hello: "world",
      time: Date.now(),
      messageId: nextMessageId++,
    };

    add("[page] posting after boot", outbound);

    try {
      worker.postMessage(outbound);

      add("[page] postMessage completed");

      window.__workerSendProbe = {
        posted: true,
        messageId: outbound.messageId,
        at: Date.now(),
      };
    } catch (error) {
      add("[page] postMessage threw", {
        message: error?.message ?? String(error),
      });

      finalize({
        ok: false,
        stage: "postmessage-error",
        error: {
          message: error?.message ?? String(error),
        },
        workerEvents,
        probeState: window.__workerProbeState,
      });

      return;
    }

    return;
  }

  if (event.data?.phase === "response") {
    clearTimeout(responseProbeTimer);

    window.__workerProbeState.response = event.data;

    add("[page] response phase received");

    updateCompletion();

    return;
  }

  finalize({
    ok: false,
    stage: "unexpected-message",
    data: event.data,
    workerEvents,
    probeState: window.__workerProbeState,
  });
};

        worker.onerror = (event) => {
          clearTimeout(bootProbeTimer);
          clearTimeout(responseProbeTimer);
          workerEvents.push({
            kind: "error",
            message: event.message,
            filename: event.filename,
            lineno: event.lineno,
            colno: event.colno,
            type: event.type,
            at: Date.now(),
          });
          add("[page] worker.onerror", {
            message: event.message,
            filename: event.filename,
            lineno: event.lineno,
            colno: event.colno,
            type: event.type,
          });
          finalize({
            ok: false,
            stage: "runtime",
            error: {
              message: event.message,
              filename: event.filename,
              lineno: event.lineno,
              colno: event.colno,
              type: event.type,
            },
            workerEvents,
            probeState: window.__workerProbeState,
          });
        };

        worker.onmessageerror = (event) => {
          clearTimeout(bootProbeTimer);
          clearTimeout(responseProbeTimer);
          workerEvents.push({ kind: "messageerror", type: event.type, at: Date.now() });
          add("[page] worker.onmessageerror", { type: event.type });
          finalize({
            ok: false,
            stage: "messageerror",
            error: { type: event.type },
            workerEvents,
            probeState: window.__workerProbeState,
          });
        };

        bootProbeTimer = setTimeout(() => {
          if (window.__workerProbeState.complete) return;
          add("[page] boot probe timeout", { workerEvents });
          finalize({
            ok: false,
            stage: "boot-timeout",
            workerEvents,
            probeState: window.__workerProbeState,
          });
        }, 1000);

        responseProbeTimer = setTimeout(() => {
          if (window.__workerProbeState.complete) return;
          add("[page] response probe timeout", {
            boot: window.__workerProbeState.boot,
            workerEvents,
          });
          finalize({
            ok: false,
            stage: window.__workerProbeState.boot ? "response-timeout" : "boot-timeout",
            workerEvents,
            probeState: window.__workerProbeState,
            sent: window.__workerSendProbe,
          });
        }, 3000);

    
  
        add("[page] waiting for boot phase before posting message");
      }
    </script>
  </body>
</html>`;

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function getFreePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = net.createServer();
    server.unref();
    server.on("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address !== "string" ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

async function waitFor(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { }
    await delay(50);
  }
  throw new Error(`waitFor timed out: ${url}`);
}

class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.eventListeners = new Map();
    this.closed = false;
    ws.addEventListener("close", () => {
      this.closed = true;
      for (const pending of this.pending.values()) {
        pending.reject(new Error("ws closed"));
      }
      this.pending.clear();
    });
    ws.addEventListener("message", (event) => this.onMessage(event));
  }

  onMessage(event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    if (message.id != null && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result || {});
      return;
    }

    if (message.method) {
      const key = `${message.method}|${message.sessionId || ""}`;
      const listeners = this.eventListeners.get(key);
      if (listeners) {
        for (const listener of listeners) listener(message.params || {});
      }
    }
  }

  onEvent(method, sessionId, callback) {
    const key = `${method}|${sessionId || ""}`;
    let listeners = this.eventListeners.get(key);
    if (!listeners) {
      listeners = [];
      this.eventListeners.set(key, listeners);
    }
    listeners.push(callback);
    return () => {
      const index = listeners.indexOf(callback);
      if (index >= 0) listeners.splice(index, 1);
    };
  }

  send(method, params = {}, sessionId, timeoutMs = 30000) {
    if (this.closed) {
      return Promise.reject(new Error(`ws closed before ${method}`));
    }

    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;

    return new Promise((resolveSend, rejectSend) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectSend(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer);
          resolveSend(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectSend(error);
        },
      });

      this.ws.send(JSON.stringify(payload));
    });
  }
}

async function pageEval(client, sessionId, expression, timeoutMs = 15000) {
  const result = await client.send(
    "Runtime.evaluate",
    {
      expression,
      returnByValue: true,
      awaitPromise: true,
      timeout: timeoutMs,
    },
    sessionId,
    timeoutMs + 1000,
  );

  if (result.exceptionDetails) {
    throw new Error(`eval threw: ${result.exceptionDetails.text || JSON.stringify(result.exceptionDetails)}`);
  }

  return result?.result?.value;
}

function startServer() {
  return http.createServer((req, res) => {
    if (!req.url || req.url === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(pageHtml);
      return;
    }

    if (req.url === "/worker.js") {
      res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
      res.end(workerScript);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  });
}

async function waitForWorkerResult(client, sessionId) {
  const start = Date.now();
  while (Date.now() - start < CONFIG.resultTimeoutMs) {
    const result = await pageEval(
      client,
      sessionId,
      "window.__workerTestResult === undefined ? null : window.__workerTestResult",
      3000,
    );
    if (result) return result;
    await delay(100);
  }
  return null;
}

async function main() {
  if (!existsSync(veloraBin)) {
    console.error(`velora binary not found: ${veloraBin}`);
    console.error("build first: zig build -Doptimize=ReleaseFast");
    process.exit(1);
  }

  if (!existsSync(CONFIG.outDir)) {
    mkdirSync(CONFIG.outDir, { recursive: true });
  }

  const htmlPath = resolve(CONFIG.outDir, CONFIG.htmlFile);
  const logPath = resolve(CONFIG.outDir, CONFIG.logFile);

  const appServer = startServer();
  appServer.listen(0, "127.0.0.1");
  await new Promise((resolveListen, rejectListen) => {
    appServer.once("listening", resolveListen);
    appServer.once("error", rejectListen);
  });

  const appAddress = appServer.address();
  if (!appAddress || typeof appAddress === "string") {
    throw new Error("Failed to resolve app server address");
  }

  const testUrl = `http://127.0.0.1:${appAddress.port}`;
  const port = await getFreePort();
  const veloraArgs = [
    "serve",
    "--host", "127.0.0.1",
    "--port", String(port),
    "--log-level", CONFIG.logLevel,
    "--log-format", "pretty",
    "--http-timeout", String(CONFIG.timeoutMs),
  ];

  console.log("=== simple worker test ===");
  console.log(`[server] test page: ${testUrl}`);
  console.log(`[velora] launching ${veloraBin}`);
  console.log(`[velora] args=${veloraArgs.join(" ")}`);

  const stderrChunks = [];
  const proc = spawn(veloraBin, veloraArgs, {
    cwd: repoRoot,
    stdio: ["ignore", "ignore", "pipe"],
  });

  let exited = null;
  proc.on("exit", (code, signal) => {
    exited = { code, signal };
    console.log(`\n[velora exit] code=${code} signal=${signal}`);
  });
  proc.stderr.on("data", (chunk) => stderrChunks.push(chunk));

  const flushLog = () => {
    try {
      writeFileSync(logPath, Buffer.concat(stderrChunks).toString());
    } catch (error) {
      console.error(`[velora] failed to write log: ${error.message}`);
    }
  };

  const cleanup = async () => {
    flushLog();
    console.log(`[velora] log saved: ${logPath}`);

    await new Promise((resolveClose) => appServer.close(resolveClose));

    if (!exited) {
      proc.kill("SIGTERM");
      await new Promise((resolveExit) => proc.once("exit", resolveExit));
    }
  };

  let ws;
  try {
    await waitFor(`http://127.0.0.1:${port}/json/version`, 5000);
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolveOpen, rejectOpen) => {
      ws.addEventListener("open", resolveOpen, { once: true });
      ws.addEventListener("error", rejectOpen, { once: true });
    });

    const client = new CdpClient(ws);
    const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
    await client.send("Page.enable", {}, sessionId);
    await client.send("Runtime.enable", {}, sessionId);

    const loadOnce = new Promise((resolveLoad) => {
      const off = client.onEvent("Page.loadEventFired", sessionId, () => {
        off();
        resolveLoad();
      });
    });

    console.log(`[load] navigating to ${testUrl}`);
    const nav = await client.send("Page.navigate", { url: testUrl }, sessionId, CONFIG.timeoutMs);
    if (nav.errorText) {
      throw new Error(`navigate error: ${nav.errorText}`);
    }

    await Promise.race([
      loadOnce,
      delay(CONFIG.loadTimeoutMs).then(() => {
        throw new Error(`load event did not fire within ${CONFIG.loadTimeoutMs}ms`);
      }),
    ]);

    const result = await waitForWorkerResult(client, sessionId);
    const html = (await pageEval(
      client,
      sessionId,
      "document.documentElement && document.documentElement.outerHTML",
      15000,
    )) || "";
    writeFileSync(htmlPath, html);

    console.log("\n=== worker result ===");
    if (result?.ok) {
      console.log("status: PASS");
      console.log(JSON.stringify(result, null, 2));
    } else if (result) {
      console.log("status: FAIL");
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = 1;
    } else {
      console.log("status: TIMEOUT");
      console.log(`No worker result after ${CONFIG.resultTimeoutMs}ms`);
      process.exitCode = 1;
    }

    console.log(`html saved: ${htmlPath}`);
    console.log(`log saved:  ${logPath}`);
  } catch (error) {
    console.error("[worker-test] error:", error.message);
    process.exitCode = 1;
  } finally {
    try {
      ws && ws.close();
    } catch { }
    await cleanup();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
