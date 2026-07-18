#!/usr/bin/env node
/**
 * Probe document.currentScript + SPA login redirect (dovihome-sale).
 * Budget: max 20s — hang = exit 3.
 */
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import {
    createProbeBudget,
    parseMaxSecArg,
} from "./lib/cdp-probe-budget.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const VELORA_BIN = process.env.VELORA_BIN || resolve(REPO, "zig-out/bin/velora");
const TARGET =
    process.argv.find((a) => a.startsWith("http")) ||
    "https://dovihome-sale.vercel.app/m/sale";
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

class CdpClient {
    constructor(ws) {
        this.ws = ws;
        this.id = 0;
        this.pending = new Map();
        this.events = [];
        ws.on("message", (raw) => {
            const m = JSON.parse(raw.toString());
            if (m.id && this.pending.has(m.id)) {
                const { resolve, reject } = this.pending.get(m.id);
                this.pending.delete(m.id);
                if (m.error) reject(new Error(JSON.stringify(m.error)));
                else resolve(m.result);
                return;
            }
            if (m.method) this.events.push(m);
        });
    }
    call(method, params = {}, sessionId, timeoutMs = 10000) {
        const id = ++this.id;
        const payload = { id, method, params };
        if (sessionId) payload.sessionId = sessionId;
        this.ws.send(JSON.stringify(payload));
        return new Promise((resolve, reject) => {
            const t = setTimeout(
                () => reject(new Error("cdp timeout " + method)),
                timeoutMs,
            );
            this.pending.set(id, {
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
    }
    close() {
        try {
            this.ws.close();
        } catch {}
    }
}

let proc = null;
const cleanup = () => {
    if (proc && !proc.killed) {
        try {
            proc.kill("SIGKILL");
        } catch {}
    }
};
const budget = createProbeBudget(maxSec, cleanup);

async function evalJson(client, sessionId, expression) {
    const r = await client.call(
        "Runtime.evaluate",
        { expression, returnByValue: true, awaitPromise: true },
        sessionId,
        8000,
    );
    if (r.exceptionDetails) {
        throw new Error(
            r.exceptionDetails.text ||
                r.exceptionDetails.exception?.description ||
                "eval failed",
        );
    }
    return r.result?.value;
}

async function main() {
    const port = await getFreePort();
    const endpoint = `http://127.0.0.1:${port}`;
    proc = spawn(
        VELORA_BIN,
        [
            "serve",
            "--host",
            "127.0.0.1",
            "--port",
            String(port),
            "--browser-profile",
            "chrome-local-huys-macbook-pro",
            "--log-level",
            "warn",
        ],
        { stdio: ["ignore", "pipe", "pipe"], cwd: REPO },
    );
    let stderr = "";
    proc.stderr.on("data", (d) => {
        stderr += d.toString();
        if (stderr.length > 120000) stderr = stderr.slice(-80000);
    });
    proc.on("exit", (code, sig) => {
        console.log("velora_exit", code, sig);
    });

    for (let i = 0; i < 100; i++) {
        try {
            if ((await fetch(`${endpoint}/json/version`)).ok) break;
        } catch {}
        await delay(100);
        if (i === 99) throw new Error("cdp not ready");
    }
    console.log("cdp_ready", endpoint);

    const version = await (await fetch(`${endpoint}/json/version`)).json();
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
        ws.once("open", res);
        ws.once("error", rej);
    });
    const client = new CdpClient(ws);

    await client.call("Target.setDiscoverTargets", { discover: true }).catch(() => {});
    const { targetId } = await client.call("Target.createTarget", {
        url: "about:blank",
    });
    const { sessionId } = await client.call("Target.attachToTarget", {
        targetId,
        flatten: true,
    });
    await client.call("Page.enable", {}, sessionId);
    await client.call("Runtime.enable", {}, sessionId);
    console.log("attached", targetId);

    // Local probe via Runtime.evaluate on about:blank (inject script element)
    const localExpr = `(() => {
      const out = {};
      out.ctor = document.constructor && document.constructor.name;
      out.instHTML = document instanceof HTMLDocument;
      out.instDoc = document instanceof Document;
      out.onHtml = !!(Object.getOwnPropertyDescriptor(HTMLDocument.prototype, 'currentScript'));
      out.onDoc = !!(Object.getOwnPropertyDescriptor(Document.prototype, 'currentScript'));
      const dg = Object.getOwnPropertyDescriptor(Document.prototype, 'currentScript');
      const hg = Object.getOwnPropertyDescriptor(HTMLDocument.prototype, 'currentScript');
      out.docGet = dg && dg.get ? String(dg.get).slice(0, 120) : null;
      out.htmlGet = hg && hg.get ? String(hg.get).slice(0, 120) : null;
      out.now = document.currentScript;
      // classic inline via appendChild + text
      try {
        const s = document.createElement('script');
        s.text = 'window.__from_inline = document.currentScript && document.currentScript.tagName; window.__from_inline_inst = document.currentScript instanceof HTMLScriptElement;';
        document.documentElement.appendChild(s);
        out.from_inline = window.__from_inline;
        out.from_inline_inst = window.__from_inline_inst;
      } catch (e) { out.inline_err = String(e); }
      return out;
    })()`;
    try {
        const local = await evalJson(client, sessionId, localExpr);
        console.log("LOCAL", JSON.stringify(local, null, 2));
    } catch (e) {
        console.log("LOCAL_ERR", e.message);
    }

    // Navigate SPA
    console.log("nav", TARGET);
    const nav = await client.call(
        "Page.navigate",
        { url: TARGET },
        sessionId,
        15000,
    );
    console.log("nav_result", JSON.stringify(nav));

    let last = null;
    const t0 = Date.now();
    while (Date.now() - t0 < Math.min(11000, budget.remaining() - 1500)) {
        await delay(800);
        try {
            last = await evalJson(
                client,
                sessionId,
                `({
          href: location.href,
          ready: document.readyState,
          next: typeof window.next,
          turbo: Array.isArray(globalThis.TURBOPACK) ? 'array' : typeof globalThis.TURBOPACK,
          spinner: !!document.querySelector('.animate-spin'),
          title: document.title,
          body: (document.body && document.body.innerText || '').slice(0, 120)
        })`,
            );
            console.log("SNAP", JSON.stringify(last));
            if (last.href && String(last.href).includes("/login")) {
                console.log("REDIRECT_OK", last.href);
                break;
            }
        } catch (e) {
            console.log("snap_err", e.message);
        }
    }

    const bad = client.events
        .filter(
            (e) =>
                e.method === "Runtime.exceptionThrown" ||
                (e.method === "Runtime.consoleAPICalled" &&
                    (e.params?.type === "error" || e.params?.type === "warn")),
        )
        .map((e) => {
            if (e.method === "Runtime.exceptionThrown") {
                return {
                    t: "ex",
                    text: e.params?.exceptionDetails?.text,
                    desc: e.params?.exceptionDetails?.exception?.description,
                };
            }
            return {
                t: "log",
                type: e.params?.type,
                args: (e.params?.args || [])
                    .map((a) => a.value ?? a.description ?? "")
                    .join(" "),
            };
        });
    console.log("EXCEPTIONS", JSON.stringify(bad.slice(-30), null, 2));
    console.log("STDERR_TAIL", stderr.slice(-2500));

    budget.clear();
    client.close();
    cleanup();
    process.exit(0);
}

main().catch((e) => {
    console.error("FAIL", e);
    budget.clear();
    cleanup();
    process.exit(1);
});
