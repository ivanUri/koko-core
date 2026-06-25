#!/usr/bin/env node
/** Export final DOM + document response bodies after Velora Google search. */
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const VELORA_BIN = resolve(REPO, "zig-out/bin/velora");
const OUT_DIR = resolve(REPO, "code-check/sites/google/exports");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function hopKind(url) {
    if (url.includes("sg_ss=")) return "sg_ss";
    if (url.includes("sei=")) return "sei";
    if (url.includes("/search")) return "search";
    return "other";
}

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

async function main() {
    if (!existsSync(VELORA_BIN)) throw new Error("run zig build first");
    mkdirSync(OUT_DIR, { recursive: true });

    const profile = process.argv.includes("--profile")
        ? process.argv[process.argv.indexOf("--profile") + 1]
        : "chrome-local-huys-macbook-pro";
    const query = process.argv.includes("--query")
        ? process.argv[process.argv.indexOf("--query") + 1]
        : "coingloo.com";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");

    const port = await getFreePort();
    const proc = spawn(VELORA_BIN, [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", profile, "--log-level", "warn",
    ], { cwd: REPO, stdio: "ignore", env: { ...process.env, VELORA_ROOT: REPO } });

    try {
        for (let i = 0; i < 80; i += 1) {
            try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {}
            await delay(100);
        }

        const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
        const ws = new WebSocket(version.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });

        const pending = new Map();
        let nextId = 1;
        const send = (method, params = {}, sessionId = null) => {
            const id = nextId++;
            const payload = { id, method, params };
            if (sessionId) payload.sessionId = sessionId;
            return new Promise((resolve, reject) => {
                pending.set(id, { resolve, reject });
                ws.send(JSON.stringify(payload));
            });
        };
        ws.on("message", (raw) => {
            const msg = JSON.parse(String(raw));
            if (msg.id && pending.has(msg.id)) {
                const { resolve, reject } = pending.get(msg.id);
                pending.delete(msg.id);
                if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
                else resolve(msg.result);
            }
        });

        await send("Target.setDiscoverTargets", { discover: true });
        const { targetId } = await send("Target.createTarget", { url: "about:blank" });
        const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
        await send("Page.enable", {}, sessionId);
        await send("Network.enable", {}, sessionId);
        await send("Runtime.enable", {}, sessionId);

        const docs = [];
        ws.on("message", (raw) => {
            const msg = JSON.parse(String(raw));
            if (msg.method !== "Network.requestWillBeSent" || msg.sessionId !== sessionId) return;
            if (msg.params?.type !== "Document") return;
            const url = msg.params.request?.url || "";
            if (!url.includes("google.com")) return;
            docs.push({
                kind: hopKind(url),
                url,
                requestId: msg.params.requestId,
            });
        });

        const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=vi`;
        await send("Page.navigate", { url: searchUrl }, sessionId);

        const deadline = Date.now() + 12000;
        while (Date.now() < deadline) {
            const sgss = docs.find((d) => d.kind === "sg_ss");
            if (sgss) {
                try {
                    await send("Network.getResponseBody", { requestId: sgss.requestId }, sessionId);
                    sgss.bodyReady = true;
                    break;
                } catch {}
            }
            await delay(300);
        }
        await delay(500);

        const snap = await send("Runtime.evaluate", {
            expression: `({
                href: location.href,
                title: document.title,
                ready: document.readyState,
                html: document.documentElement.outerHTML,
                text: document.body ? document.body.innerText.slice(0, 8000) : "",
                hasSerp: !!document.getElementById("center_col"),
                hasSorry: location.pathname.includes("/sorry"),
                hasSgSs: location.href.includes("sg_ss="),
            })`,
            returnByValue: true,
        }, sessionId);
        const page = snap.result?.value || {};

        const bodies = {};
        for (const doc of docs) {
            try {
                const res = await send("Network.getResponseBody", { requestId: doc.requestId }, sessionId);
                const raw = res.base64Encoded
                    ? Buffer.from(res.body, "base64").toString("utf8")
                    : res.body;
                bodies[doc.kind] = { url: doc.url, len: raw.length, html: raw };
            } catch (err) {
                bodies[doc.kind] = { url: doc.url, error: String(err.message || err) };
            }
        }

        const meta = {
            exportedAt: new Date().toISOString(),
            profile,
            query,
            searchUrl,
            finalHref: page.href,
            finalTitle: page.title,
            docs: docs.map((d) => ({ kind: d.kind, url: d.url.slice(0, 200), requestId: d.requestId })),
            pageProbe: {
                ready: page.ready,
                hasSerp: page.hasSerp,
                hasSorry: page.hasSorry,
                hasSgSs: page.hasSgSs,
            },
        };

        const base = `${OUT_DIR}/velora-google-${stamp}`;
        writeFileSync(`${base}-meta.json`, JSON.stringify(meta, null, 2));
        writeFileSync(`${base}-dom.html`, page.html || "<!-- empty -->");
        writeFileSync(`${base}-dom.txt`, page.text || "");
        for (const [kind, info] of Object.entries(bodies)) {
            if (info.html) writeFileSync(`${base}-response-${kind}.html`, info.html);
        }

        console.log("Exported:");
        console.log(`  DOM:        ${base}-dom.html`);
        console.log(`  meta:       ${base}-meta.json`);
        for (const kind of ["search", "sei", "sg_ss"]) {
            const p = `${base}-response-${kind}.html`;
            if (existsSync(p)) console.log(`  ${kind}:  ${p}`);
        }
        console.log(`\nFinal: ${page.title}`);
        console.log(`URL:   ${(page.href || "").slice(0, 120)}`);
        console.log(`SERP:  ${page.hasSerp}  sorry: ${page.hasSorry}  sg_ss: ${page.hasSgSs}`);
    } finally {
        proc.kill("SIGTERM");
        await delay(200);
    }
}

main().catch((e) => { console.error(e); process.exit(2); });