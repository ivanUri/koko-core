#!/usr/bin/env node
/** Checkbox click + log velora `input activation` lines from JSON stderr. */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Browser } from "../../../sdk/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");
const TARGET_URL = "https://2captcha.com/demo/cloudflare-turnstile";
const SCRIPT_TIMEOUT_MS = 75_000;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
    ]);
}

async function getFreePort() {
    return new Promise((res, rej) => {
        const s = createNetServer();
        s.listen(0, "127.0.0.1", () => {
            const { port } = s.address();
            s.close(() => res(port));
        });
        s.on("error", rej);
    });
}

async function waitForWidget(page, timeoutMs = 20_000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        const box = await page.evaluate(`(() => {
            const w = document.querySelector(".cf-turnstile");
            if (!w) return null;
            w.scrollIntoView({ block: "center", inline: "center" });
            const r = w.getBoundingClientRect();
            if (r.width < 10 || r.height < 10) return null;
            return {
                left: r.left, top: r.top, width: r.width, height: r.height,
                inView: r.top >= 0 && r.top < innerHeight,
                scrollY: scrollY,
            };
        })()`).catch(() => null);
        if (box) return box;
        await delay(500);
    }
    return null;
}

async function main() {
    if (!existsSync(veloraBin)) {
        throw new Error(`Build velora first: ${veloraBin}`);
    }

    const port = await getFreePort();
    const stderr = [];
    const proc = spawn(veloraBin, [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", "chrome-macos-catalina",
        "--log-level", "info", "--log-format", "pretty",
    ], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    proc.stderr.on("data", (c) => stderr.push(c));
    proc.on("exit", (code) => {
        if (code != null && code !== 0) {
            console.error(`[velora] exited with code ${code}`);
        }
    });

    const endpoint = `http://127.0.0.1:${port}`;
    let cdpReady = false;
    for (let i = 0; i < 160; i++) {
        if (proc.exitCode != null) break;
        try {
            const v = await fetch(`${endpoint}/json/version`);
            const l = await fetch(`${endpoint}/json/list`);
            if (v.ok && l.ok) {
                cdpReady = true;
                break;
            }
        } catch { /* retry */ }
        await delay(500);
    }
    if (!cdpReady) {
        const tail = Buffer.concat(stderr).toString("utf8").slice(-800);
        throw new Error(`CDP not ready at ${endpoint}${tail ? `\n${tail}` : ""}`);
    }

    const browser = await Browser.connect(endpoint);
    const page = await browser.newPage();
    await page.session.send("Input.enable").catch(() => {});

    console.log(`[goto] ${TARGET_URL}`);
    await withTimeout(
        page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 45_000 }),
        50_000,
        "goto",
    );

    const widget = await waitForWidget(page, 25_000);
    if (!widget) {
        console.log("[widget] not ready — skipping click");
    } else {
        const pt = {
            x: widget.left + 28,
            y: widget.top + widget.height / 2,
        };
        console.log("[click]", pt, `inView=${widget.inView ?? "?"} scrollY=${widget.scrollY ?? "?"}`);
        for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
            await withTimeout(
                page.session.send("Input.dispatchMouseEvent", {
                    type,
                    x: pt.x,
                    y: pt.y,
                    button: type === "mouseMoved" ? "none" : "left",
                    clickCount: type === "mousePressed" ? 1 : 0,
                }),
                15_000,
                `mouse.${type}`,
            );
            await delay(80);
        }
        await delay(4000);
    }

    console.log("--- activations ---");
    const logText = Buffer.concat(stderr).toString("utf8");
    const hits = logText.split("\n").filter((l) => /input activation/i.test(l));
    if (!hits.length) {
        console.log("(none)");
        const frameLines = logText.split("\n").filter((l) => /frame/i.test(l)).slice(-5);
        if (frameLines.length) {
            console.log("--- recent frame logs ---");
            for (const l of frameLines) console.log(l.trim().slice(0, 200));
        }
    } else {
        for (const line of hits) console.log(line.trim().slice(0, 400));
    }

    if (widget) {
        const tokenLen = await page.evaluate(() =>
            document.querySelector('[name="cf-turnstile-response"]')?.value?.length ?? 0
        ).catch((e) => {
            console.log(`[warn] token poll: ${e?.message ?? e}`);
            return -1;
        });
        console.log("tokenLen after checkbox", tokenLen);
    }

    proc.kill("SIGKILL");
}

try {
    await withTimeout(main(), SCRIPT_TIMEOUT_MS, "script");
} catch (err) {
    console.error("FAILED:", err?.message ?? err);
    process.exit(1);
}
process.exit(0);