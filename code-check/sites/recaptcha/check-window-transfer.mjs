#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Browser } from "../../../sdk/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");
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

const PAGE = `<!doctype html>
<html><body>
<iframe id="child" src="about:blank"></iframe>
<script>
globalThis.__result = { msgs: [] };
window.addEventListener("message", (e) => {
    globalThis.__result.msgs.push({ data: e.data, ports: e.ports?.length ?? 0 });
    if (e.data === "pong" && e.ports?.[0]) {
        const port = e.ports[0];
        port.onmessage = (ev) => { globalThis.__result.pong = ev.data; };
        port.start();
        port.postMessage("ping");
    }
}, true);
const child = document.getElementById("child");
child.addEventListener("load", () => {
    child.contentWindow.eval(\`
        const ch = new MessageChannel();
        ch.port1.onmessage = (e) => {
            parent.postMessage("pong", "*", [ch.port2]);
            ch.port1.postMessage("got:" + e.data);
        };
        ch.port1.start();
        parent.postMessage("setup", "*", [ch.port1]);
    \`);
});
</script></body></html>`;

async function main() {
    const port = await getFreePort();
    const proc = spawn(veloraBin, [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", "chrome-macos-catalina", "--log-level", "error",
    ], { cwd: repoRoot, stdio: "ignore" });
    for (let i = 0; i < 40; i++) {
        try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch (_) {}
        await delay(100);
    }

    const browser = await Browser.connect(`http://127.0.0.1:${port}`);
    const page = await browser.newPage();
    await page.goto(`data:text/html,${encodeURIComponent(PAGE)}`, { waitUntil: "load", timeout: 30000 });

    let result = null;
    for (let i = 0; i < 40; i++) {
        await delay(250);
        result = await page.evaluate("globalThis.__result", { timeout: 5000 });
        if (result?.pong) break;
    }

    console.log(JSON.stringify(result, null, 2));
    await browser.close();
    proc.kill("SIGTERM");
    process.exit(result?.pong === "got:ping" ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });