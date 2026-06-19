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

async function main() {
    const port = await getFreePort();
    const proc = spawn(veloraBin, [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", "chrome-macos-catalina", "--log-level", "warn",
    ], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    const stderr = [];
    proc.stderr.on("data", (c) => stderr.push(c));
    await delay(1500);

    const browser = await Browser.connect(`http://127.0.0.1:${port}`);
    const page = await browser.newPage();

    const result = await page.evaluate(async () => {
        return new Promise((resolve) => {
            const out = { msgs: [], errors: [] };
            const w = new Worker("https://www.google.com/recaptcha/api2/webworker.js?hl=en&v=MerVUtRoajKEbP7pLiGXkL28");
            w.onmessage = (e) => out.msgs.push({ data: e.data, type: typeof e.data });
            w.onerror = (e) => out.errors.push({ msg: e.message, file: e.filename, line: e.lineno });
            setTimeout(() => resolve(out), 8000);
        });
    }, { timeout: 12000 });

    console.log(JSON.stringify(result, null, 2));
    const log = Buffer.concat(stderr).toString();
    const interesting = log.split("\n").filter((l) =>
        /Script execution|importScript|MessageChannel|worker script|exception:/i.test(l)
    );
    if (interesting.length) console.log("\nLOG:\n" + interesting.join("\n"));

    await browser.close();
    proc.kill("SIGTERM");
}

main().catch((e) => { console.error(e); process.exit(1); });