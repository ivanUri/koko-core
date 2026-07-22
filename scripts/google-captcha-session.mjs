#!/usr/bin/env node
/**
 * Keep a Google CAPTCHA in the exact Velora page that encountered it.
 *
 * This is a manual handoff, not an automated CAPTCHA solver.  The process,
 * page, IP, fingerprint profile, cookie jar, and CDP session stay alive while
 * the operator interacts with the challenge.  On success Velora's normal
 * profile shutdown persists the cookies.
 *
 *   npm run google:captcha-session -- --q codex --profile my-profile
 *   npm run google:captcha-session -- --url 'https://www.google.com/search?q=codex'
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const VELORA = resolve(REPO, "zig-out/bin/velora");
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

function parseArgs(argv) {
  const opts = {
    endpoint: null,
    port: null,
    profile: "chrome-local-huys-macbook-pro",
    url: null,
    q: "codex",
    trace: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--endpoint") opts.endpoint = argv[++i];
    else if (arg === "--port") opts.port = Number(argv[++i]);
    else if (arg === "--profile") opts.profile = argv[++i];
    else if (arg === "--url") opts.url = argv[++i];
    else if (arg === "--q") opts.q = argv[++i];
    else if (arg === "--trace") opts.trace = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  opts.url ||= `https://www.google.com/search?q=${encodeURIComponent(opts.q)}`;
  return opts;
}

function usage() {
  console.log(`Usage:
  node scripts/google-captcha-session.mjs [--q text | --url URL]
       [--profile name] [--port number]
       [--endpoint http://127.0.0.1:9222]

Commands while the exact session is held:
  status            show URL, CAPTCHA and SERP state
  click             click the centre of the reCAPTCHA iframe/widget
  click <x> <y>     dispatch a real pointer click at viewport coordinates
  key <text>        type text through CDP Input events
  enter             press Enter
  reload            reload the same page
  cookies           show Google cookie names (values are never printed)
  diagnose          inspect Cloudflare state, DOM and loaded resources
  eval <expression> evaluate JavaScript in the held page
  source            save the loaded Cloudflare orchestrator for local analysis
  continue          finish only after the challenge has passed
  quit              close without claiming success`);
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

async function waitForServer(endpoint, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/json/version`);
      if (response.ok) return response.json();
    } catch {}
    await delay(100);
  }
  throw new Error(`Velora CDP did not start at ${endpoint}`);
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    ws.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.method) {
        for (const listener of this.listeners.get(message.method) || []) listener(message.params || {});
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) || [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  send(method, params = {}, sessionId = null, timeoutMs = 15_000) {
    const id = this.nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolveResult, reject) => {
      this.pending.set(id, { resolve: resolveResult, reject });
      this.ws.send(JSON.stringify(message));
      setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs).unref();
    });
  }
}

const STATE_EXPRESSION = `(() => {
  const q = (selector) => document.querySelector(selector);
  const text = (document.body?.innerText || '').toLowerCase();
  const href = location.href;
  const captcha = q('iframe[src*="recaptcha"]') || q('#recaptcha') || q('.g-recaptcha') ||
    q('iframe[src*="challenges.cloudflare.com"]') || q('iframe[src*="turnstile"]') ||
    q('.cf-turnstile') || q('[name="cf-turnstile-response"]');
  const rect = captcha?.getBoundingClientRect?.();
  const sorry = href.includes('/sorry') || text.includes('unusual traffic') ||
    text.includes('our systems have detected');
  const cloudflare = href.includes('/cdn-cgi/challenge-platform/') ||
    !!q('script[src*="/cdn-cgi/challenge-platform/"]') ||
    text.includes('verify you are human') || text.includes('performing security verification') ||
    text.includes('just a moment');
  const serp = !!(q('#rso') || q('#search') || q('#result-stats'));
  const challenge = sorry || cloudflare || !!captcha;
  const google = location.hostname.includes('google.');
  const passed = serp || (!google && !challenge && document.readyState === 'complete' && text.length > 40);
  return {
    href,
    title: document.title || '',
    readyState: document.readyState,
    sorry,
    cloudflare,
    challenge,
    recaptcha: !!captcha,
    serp,
    passed,
    captchaRect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
    bodyHead: (document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 240),
  };
})()`;

async function evaluate(cdp, sessionId, expression) {
  const response = await cdp.send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: false },
    sessionId,
  );
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || "evaluation failed");
  return response.result?.value;
}

async function click(cdp, sessionId, x, y) {
  const common = { x, y, button: "left", clickCount: 1 };
  await cdp.send("Input.dispatchMouseEvent", { ...common, type: "mouseMoved", button: "none" }, sessionId);
  await cdp.send("Input.dispatchMouseEvent", { ...common, type: "mousePressed" }, sessionId);
  await delay(70);
  await cdp.send("Input.dispatchMouseEvent", { ...common, type: "mouseReleased" }, sessionId);
}

async function key(cdp, sessionId, text) {
  for (const character of text) {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", text: character }, sessionId);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", text: character }, sessionId);
  }
}

function printState(state) {
  const verdict = state.passed ? "PASSED" : state.challenge ? "CAPTCHA" : "PENDING";
  console.log(`[${verdict}] ${state.href}`);
  console.log(`ready=${state.readyState} recaptcha=${state.recaptcha} sorry=${state.sorry}`);
  if (state.captchaRect) console.log(`captcha rect=${JSON.stringify(state.captchaRect)}`);
  if (state.bodyHead) console.log(state.bodyHead);
  return verdict;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return usage();
  if (!opts.endpoint && !existsSync(VELORA)) throw new Error(`missing binary: ${VELORA}; run zig build first`);

  const port = opts.port || (opts.endpoint ? null : await freePort());
  const endpoint = opts.endpoint || `http://127.0.0.1:${port}`;
  let child = null;
  if (!opts.endpoint) {
    child = spawn(VELORA, [
      "serve", "--host", "127.0.0.1", "--port", String(port),
      "--browser-profile", opts.profile, "--log-level", opts.trace ? "debug" : "warn",
      ...(opts.trace ? ["--log-filter-scopes", "js", "--log-filter-scopes", "frame"] : []),
    ], { cwd: REPO, stdio: ["ignore", "inherit", "inherit"] });
  }

  let completed = false;
  const stopChild = () => {
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
  };
  process.once("SIGINT", () => { stopChild(); process.exit(completed ? 0 : 130); });
  process.once("SIGTERM", stopChild);

  try {
    const version = await waitForServer(endpoint);
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolveOpen, reject) => {
      ws.once("open", resolveOpen);
      ws.once("error", reject);
    });
    const cdp = new Cdp(ws);
    const challengeResponses = [];
    cdp.on("Network.responseReceived", ({ requestId, response = {} }) => {
      if ((response.url || "").includes("/cdn-cgi/challenge-platform/")) {
        challengeResponses.push({ requestId, url: response.url });
      }
    });
    if (opts.trace) {
      cdp.on("Runtime.exceptionThrown", ({ exceptionDetails = {} }) => {
        const exception = exceptionDetails.exception || {};
        console.error("[trace:exception]", exception.description || exceptionDetails.text || "unknown");
      });
      cdp.on("Runtime.consoleAPICalled", ({ type, args = [] }) => {
        console.error(`[trace:console:${type}]`, args.map((arg) => arg.value ?? arg.description ?? "").join(" "));
      });
      cdp.on("Network.loadingFailed", ({ errorText, blockedReason, type }) => {
        console.error("[trace:loadingFailed]", { type, errorText, blockedReason });
      });
      cdp.on("Network.responseReceived", ({ type, response = {} }) => {
        const url = response.url || "";
        if (url.includes("cdn-cgi") || Number(response.status) >= 400) {
          console.error("[trace:response]", { type, status: response.status, url });
        }
      });
    }
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Network.enable", {}, sessionId);
    if (opts.trace) {
      cdp.on("Debugger.paused", ({ reason, data, callFrames = [] }) => {
        const top = callFrames[0] || {};
        console.error("[trace:paused]", {
          reason,
          description: data?.description,
          functionName: top.functionName,
          url: top.url,
          line: top.location?.lineNumber,
          column: top.location?.columnNumber,
        });
        cdp.send("Debugger.resume", {}, sessionId).catch((error) => console.error("[trace:resume]", error.message));
      });
      await cdp.send("Debugger.enable", {}, sessionId).catch((error) => console.error("[trace:debugger]", error.message));
      await cdp.send("Debugger.setPauseOnExceptions", { state: "all" }, sessionId)
        .catch((error) => console.error("[trace:pauseOnExceptions]", error.message));
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
        globalThis.__veloraCfTrace = [];
        const emit = (...args) => {
          globalThis.__veloraCfTrace.push({ t: performance.now(), args: args.map((arg) => String(arg)) });
          console.debug('[velora-cf-trace]', ...args);
        };
        addEventListener('error', (event) => emit('error', event.message, event.filename, event.lineno, event.colno));
        addEventListener('unhandledrejection', (event) => emit('unhandledrejection', String(event.reason?.stack || event.reason)));
        const wrapFunction = (object, name, label = name) => {
          const original = object?.[name];
          if (typeof original !== 'function') return;
          object[name] = new Proxy(original, {
            apply(target, thisArg, args) { emit(label, 'call'); return Reflect.apply(target, thisArg, args); },
            construct(target, args, newTarget) { emit(label, 'construct'); return Reflect.construct(target, args, newTarget); },
          });
        };
        wrapFunction(globalThis, 'fetch');
        wrapFunction(globalThis, 'Worker');
        wrapFunction(globalThis, 'WebSocket');
        wrapFunction(globalThis, 'requestAnimationFrame');
        wrapFunction(globalThis, 'queueMicrotask');
        wrapFunction(globalThis, 'PerformanceObserver');
        wrapFunction(WebAssembly, 'instantiate', 'WebAssembly.instantiate');
        wrapFunction(WebAssembly, 'compile', 'WebAssembly.compile');
        for (const name of ['digest', 'encrypt', 'decrypt', 'sign', 'verify', 'deriveBits', 'importKey', 'exportKey', 'generateKey']) {
          wrapFunction(crypto?.subtle, name, 'subtle.' + name);
        }
        if (globalThis.XMLHttpRequest) {
          wrapFunction(XMLHttpRequest.prototype, 'open', 'xhr.open');
          wrapFunction(XMLHttpRequest.prototype, 'send', 'xhr.send');
        }
        if (globalThis.HTMLFormElement) wrapFunction(HTMLFormElement.prototype, 'submit', 'form.submit');
        const setTimeoutOriginal = globalThis.setTimeout;
        globalThis.setTimeout = function(callback, timeout, ...args) {
          emit('setTimeout', timeout);
          return setTimeoutOriginal.call(this, callback, timeout, ...args);
        };
        const addEventListenerOriginal = EventTarget.prototype.addEventListener;
        EventTarget.prototype.addEventListener = function(type, listener, options) {
          if (['DOMContentLoaded', 'load', 'message', 'readystatechange', 'error'].includes(String(type))) {
            emit('addEventListener', this === window ? 'window' : this === document ? 'document' : this?.constructor?.name, type);
          }
          return addEventListenerOriginal.call(this, type, listener, options);
        };
        const appendChild = Node.prototype.appendChild;
        Node.prototype.appendChild = function(child) {
          if (child?.tagName === 'SCRIPT' || child?.tagName === 'IFRAME' || child?.tagName === 'FORM') {
            emit('appendChild', child.tagName, child.src || child.action || '');
          }
          return appendChild.call(this, child);
        };
        emit('installed');
      })()` }, sessionId).catch((error) => console.error("[trace:inject]", error.message));
    }

    console.log(`Velora endpoint: ${endpoint}`);
    console.log(`Target: ${targetId}`);
    console.log(`Profile: ${opts.profile}`);
    console.log(`Navigating: ${opts.url}`);
    await cdp.send("Page.navigate", { url: opts.url }, sessionId);

    let state = null;
    for (let i = 0; i < 180; i += 1) {
      await delay(500);
      try { state = await evaluate(cdp, sessionId, STATE_EXPRESSION); } catch { continue; }
      if (state.passed || state.challenge) break;
    }
    printState(state || { href: opts.url, readyState: "unknown", recaptcha: false, sorry: false, serp: false });

    if (state?.passed) {
      completed = true;
      console.log("Search succeeded; no CAPTCHA handoff was needed.");
    } else {
      console.log("\nSession is held open. Type 'help' for commands.");
      const readline = createInterface({ input: process.stdin, output: process.stdout, prompt: "captcha> " });
      readline.prompt();
      for await (const raw of readline) {
        const [command, ...args] = raw.trim().split(/\s+/);
        try {
          if (!command) {}
          else if (command === "help") usage();
          else if (command === "status") state = await evaluate(cdp, sessionId, STATE_EXPRESSION);
          else if (command === "click") {
            state = await evaluate(cdp, sessionId, STATE_EXPRESSION);
            const x = args.length >= 2 ? Number(args[0]) : state.captchaRect?.x + state.captchaRect?.width / 2;
            const y = args.length >= 2 ? Number(args[1]) : state.captchaRect?.y + state.captchaRect?.height / 2;
            if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("no CAPTCHA rect; use click <x> <y>");
            await click(cdp, sessionId, x, y);
            await delay(500);
            state = await evaluate(cdp, sessionId, STATE_EXPRESSION);
          } else if (command === "key") await key(cdp, sessionId, args.join(" "));
          else if (command === "enter") {
            await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, sessionId);
            await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, sessionId);
          } else if (command === "reload") await cdp.send("Page.reload", {}, sessionId);
          else if (command === "cookies") {
            const result = await cdp.send("Network.getAllCookies", {}, sessionId);
            const google = (result.cookies || []).filter((cookie) => cookie.domain.includes("google"));
            console.log(google.map((cookie) => ({ name: cookie.name, domain: cookie.domain, expires: cookie.expires })));
          } else if (command === "diagnose") {
            const diagnostic = await evaluate(cdp, sessionId, `(() => ({
              href: location.href,
              html: document.documentElement?.outerHTML?.slice(0, 6000) || '',
              scripts: [...document.scripts].map((s) => s.src || '[inline]').slice(0, 30),
              resources: performance.getEntriesByType('resource').map((e) => ({ name: e.name, initiatorType: e.initiatorType, duration: e.duration })).slice(-40),
              cfGlobals: Object.keys(globalThis).filter((key) => /cf|turnstile|challenge/i.test(key)).sort(),
              cfOpt: globalThis._cf_chl_opt || null,
              trace: globalThis.__veloraCfTrace || [],
              api: {
                crypto: typeof crypto,
                subtle: typeof crypto?.subtle,
                worker: typeof Worker,
                webAssembly: typeof WebAssembly,
                performanceObserver: typeof PerformanceObserver,
                requestAnimationFrame: typeof requestAnimationFrame,
                indexedDB: typeof indexedDB,
                cookie: document.cookie,
              },
            }))()`);
            console.log(JSON.stringify(diagnostic, null, 2));
          } else if (command === "eval") {
            console.log(await evaluate(cdp, sessionId, args.join(" ")));
          } else if (command === "source") {
            if (challengeResponses.length === 0) throw new Error("no Cloudflare response was captured");
            const latest = challengeResponses.at(-1);
            const response = await cdp.send("Network.getResponseBody", { requestId: latest.requestId }, sessionId);
            const body = response.base64Encoded ? Buffer.from(response.body, "base64").toString("utf8") : response.body;
            const outputDir = resolve(REPO, "code-check/tmp");
            mkdirSync(outputDir, { recursive: true });
            const output = resolve(outputDir, "cloudflare-challenge.js");
            writeFileSync(output, body);
            console.log({ output, bytes: body.length, url: latest.url });
          } else if (command === "continue") {
            state = await evaluate(cdp, sessionId, STATE_EXPRESSION);
            if (!state.passed || state.challenge) throw new Error("challenge has not passed yet");
            completed = true;
            readline.close();
            break;
          } else if (command === "quit" || command === "exit") {
            readline.close();
            break;
          } else console.log(`unknown command: ${command}`);
          if (state) printState(state);
        } catch (error) {
          console.error(error.message || error);
        }
        readline.prompt();
      }
    }

    ws.close();
    if (completed) console.log("Challenge passed in the same Velora session; profile cookies will now be persisted.");
  } finally {
    stopChild();
    if (child) await Promise.race([new Promise((resolveExit) => child.once("exit", resolveExit)), delay(3_000)]);
  }
  process.exitCode = completed ? 0 : 2;
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
