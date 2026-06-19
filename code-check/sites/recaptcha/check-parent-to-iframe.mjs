#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Browser } from "../../../sdk/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");
const TARGET = "https://antcpt.com/score_detector/";
const SITEKEY = "6LcR_okUAAAAAPYrPe-HK_0RULO1aZM15ENyM-Mf";
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
        "--browser-profile", "chrome-macos-catalina", "--log-level", "info",
    ], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    const stderr = [];
    proc.stderr.on("data", (c) => stderr.push(c.toString()));
    for (let i = 0; i < 40; i++) {
        try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch (_) {}
        await delay(100);
    }

    const browser = await Browser.connect(`http://127.0.0.1:${port}`);
    const page = await browser.newPage();
    await page.goto(TARGET, { waitUntil: "load", timeout: 90000 });

    const r = await page.evaluate(async () => {
        const out = { setup: false, iframe: false, manual: null, grecaptcha: null, err: null };
        await new Promise((resolve) => {
            const t = setTimeout(resolve, 10000);
            window.addEventListener("message", (e) => {
                if (e.data === "recaptcha-setup") {
                    out.setup = true;
                    clearTimeout(t);
                    resolve();
                }
            }, true);
        });

        const iframe = document.querySelector("iframe");
        out.iframe = !!iframe;
        const cw = iframe?.contentWindow;
        if (!cw) return out;

        // Manual postMessage mimicking execute dispatch
        try {
            cw.postMessage(["execute", 0, "homepage", null], "*");
            out.manual = "sent";
        } catch (e) {
            out.err = String(e);
            return out;
        }

        // Also try real grecaptcha.execute with short wait
        const t0 = Date.now();
        try {
            const token = await Promise.race([
                grecaptcha.execute("6LcR_okUAAAAAPYrPe-HK_0RULO1aZM15ENyM-Mf", { action: "homepage" }),
                new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 15000)),
            ]);
            out.grecaptcha = { len: token.length, prefix: token.slice(0, 20), ms: Date.now() - t0 };
        } catch (e) {
            out.grecaptcha = { err: String(e), ms: Date.now() - t0 };
        }
        return out;
    }, { timeout: 60000 });

    console.log(JSON.stringify(r, null, 2));
    const log = Buffer.concat(stderr).toString();
    const lines = log.split("\n").filter((l) => /worker|MessagePort|postMessage/i.test(l));
    console.log("\nLOG:\n" + lines.slice(-30).join("\n"));

    await browser.close();
    proc.kill("SIGTERM");
}

main().catch((e) => { console.error(e); process.exit(1); });