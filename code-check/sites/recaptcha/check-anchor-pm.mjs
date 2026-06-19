#!/usr/bin/env node
// Load reCAPTCHA anchor page directly and observe postMessage + execute.
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Browser } from "../../../sdk/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");
const ANCHOR =
    "https://www.google.com/recaptcha/api2/anchor?ar=1&k=6LcR_okUAAAAAPYrPe-HK_0RULO1aZM15ENyM-Mf&co=aHR0cHM6Ly9hbnRjcHQuY29tOjQ0Mw..&hl=en&v=MerVUtRoajKEbP7pLiGXkL28&size=invisible&anchor-ms=20000&execute-ms=30000&cb=testcb";
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

const HOOK = `
globalThis.__anchor = { msgs: [], ports: null, portMsgs: [], errors: [] };
window.addEventListener("message", (e) => {
    const preview = typeof e.data === "string" ? e.data.slice(0, 80) : String(e.data);
    globalThis.__anchor.msgs.push({ preview, ports: e.ports?.length ?? 0, origin: e.origin });
    if (e.data === "recaptcha-setup" && e.ports?.[0]) {
        const port = e.ports[0];
        globalThis.__anchor.ports = 1;
        port.onmessage = (ev) => {
            globalThis.__anchor.portMsgs.push(String(ev.data).slice(0, 80));
        };
        port.start();
    }
}, true);
"hooked";
`;

async function main() {
    const port = await getFreePort();
    const proc = spawn(veloraBin, [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", "chrome-macos-catalina", "--log-level", "warn",
    ], { cwd: repoRoot, stdio: "ignore" });
    for (let i = 0; i < 40; i++) {
        try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch (_) {}
        await delay(100);
    }

    const browser = await Browser.connect(`http://127.0.0.1:${port}`);
    const page = await browser.newPage();
    await page.goto(ANCHOR, { waitUntil: "load", timeout: 90000 });
    await page.evaluate(HOOK, { timeout: 10000 });

    for (let i = 0; i < 30; i++) {
        await delay(500);
        const st = await page.evaluate("globalThis.__anchor", { timeout: 5000 });
        if (st?.ports) break;
    }

    // Simulate parent sending execute-style message (observed Chrome uses array payload)
    await page.evaluate(`
        window.postMessage(["execute", 0, "homepage", null], "*");
    `, { timeout: 5000 });

    await delay(3000);
    const result = await page.evaluate("globalThis.__anchor", { timeout: 5000 });
    console.log(JSON.stringify(result, null, 2));

    await browser.close();
    proc.kill("SIGTERM");
}

main().catch((e) => { console.error(e); process.exit(1); });