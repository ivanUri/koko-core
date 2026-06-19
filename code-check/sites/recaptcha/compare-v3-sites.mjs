#!/usr/bin/env node
// Side-by-side reCAPTCHA v3 diagnostic: antcpt vs appspot demo.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Browser } from "../../../sdk/dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");

const SITES = [
    {
        name: "antcpt",
        url: "https://antcpt.com/score_detector/",
        sitekey: "6LcR_okUAAAAAPYrPe-HK_0RULO1aZM15ENyM-Mf",
        action: "homepage",
        verify: async (token) => {
            const resp = await fetch("https://antcpt.com/score_detector/verify.php", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ "g-recaptcha-response": token }),
            });
            const text = await resp.text();
            try { return JSON.parse(text); } catch { return { raw: text.slice(0, 200) }; }
        },
    },
    {
        name: "appspot",
        url: "https://recaptcha-demo.appspot.com/recaptcha-v3-request-scores.php",
        sitekey: "6LdKlZEpAAAAAAOQjzC2v_d36tWxCl6dWsozdSy9",
        action: "examples/v3scores",
        verify: async (token) => {
            const u = `https://recaptcha-demo.appspot.com/recaptcha-v3-verify.php?action=examples/v3scores&token=${encodeURIComponent(token)}`;
            const resp = await fetch(u);
            const text = await resp.text();
            try { return JSON.parse(text); } catch { return { raw: text.slice(0, 200) }; }
        },
    },
];

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

async function spawnVelora() {
    const port = await getFreePort();
    const proc = spawn(veloraBin, [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", "chrome-macos-catalina", "--log-level", "warn",
    ], { cwd: repoRoot, stdio: "ignore" });
    const endpoint = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 80; i++) {
        try { if ((await fetch(`${endpoint}/json/version`)).ok) break; } catch (_) {}
        await delay(100);
    }
    return { proc, endpoint };
}

function diagScript(sitekey, action) {
    return `(async () => {
        const msgs = [];
        window.addEventListener("message", (e) => {
            let preview = "";
            try {
                const d = e.data;
                if (typeof d === "string") preview = d.slice(0, 100);
                else if (Array.isArray(d)) preview = JSON.stringify(d).slice(0, 100);
                else preview = JSON.stringify(d)?.slice(0, 100) ?? String(d);
            } catch (_) { preview = "?"; }
            msgs.push({ origin: e.origin?.slice(0, 40), preview });
        }, true);

        await new Promise((r) => setTimeout(r, 5000));

        let cfg = null;
        try {
            const c = globalThis.___grecaptcha_cfg;
            cfg = c ? {
                hasClients: !!c.clients,
                clientCount: c.clients ? Object.keys(c.clients).length : 0,
                hasIsolated: !!c.isolated,
            } : null;
        } catch (_) {}

        const iframes = [...document.querySelectorAll("iframe")].map((f) => ({
            src: (f.src || "").replace(/^https?:\\/\\//, "").slice(0, 90),
            w: f.offsetWidth,
            h: f.offsetHeight,
        }));

        let autoToken = null;
        let autoErr = null;
        let autoMs = null;
        const autoT0 = Date.now();
        try {
            autoToken = await Promise.race([
                grecaptcha.execute(${JSON.stringify(sitekey)}, { action: ${JSON.stringify(action)} }),
                new Promise((_, rej) => setTimeout(() => rej(new Error("timeout_30s")), 30000)),
            ]);
            autoMs = Date.now() - autoT0;
        } catch (e) { autoErr = String(e); autoMs = Date.now() - autoT0; }

        return {
            grecaptcha: typeof grecaptcha,
            cfg,
            iframes,
            msgCount: msgs.length,
            msgs: msgs.slice(0, 15),
            autoTokenLen: autoToken?.length ?? 0,
            autoTokenPrefix: autoToken?.slice(0, 16) ?? null,
            autoErr,
            autoMs,
            isStubToken: autoToken?.startsWith("HF") ?? false,
        };
    })()`;
}

async function runSite(browser, site) {
    const page = await browser.newPage();
    const net = [];
    page.session.on("Network.responseReceived", (p) => {
        const u = p.response?.url || "";
        if (/recaptcha|gstatic/i.test(u)) {
            net.push({ status: p.response?.status, url: u.replace(/^https?:\/\//, "").slice(0, 100) });
        }
    });

    console.log(`\n========== ${site.name} ==========`);
    console.log(`[goto] ${site.url}`);
    await page.goto(site.url, { waitUntil: "load", timeout: 90_000 });

    const diag = await page.evaluate(diagScript(site.sitekey, site.action), { timeout: 120_000 });
    console.log("[diag]", JSON.stringify(diag, null, 2));

    if (diag.autoTokenLen > 0) {
        const verify = await site.verify(
            await page.evaluate(`grecaptcha.execute(${JSON.stringify(site.sitekey)}, {action:${JSON.stringify(site.action)}})`, { timeout: 60_000 })
        ).catch(async () => {
            // use token from diag - need to get it from page
            return { error: "no_token_for_verify" };
        });

        // verify using fresh execute from node side won't work - verify from page context
        const verifyInPage = await page.evaluate(`(async () => {
            const token = await grecaptcha.execute(${JSON.stringify(site.sitekey)}, { action: ${JSON.stringify(site.action)} });
            ${site.name === "antcpt" ? `
            const resp = await fetch("verify.php", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ "g-recaptcha-response": token }),
            });
            ` : `
            const resp = await fetch('/recaptcha-v3-verify.php?action=${site.action}&token=' + encodeURIComponent(token));
            `}
            const text = await resp.text();
            let json = null;
            try { json = JSON.parse(text); } catch (_) {}
            return {
                tokenLen: token.length,
                tokenPrefix: token.slice(0, 16),
                isStub: token.startsWith("HF"),
                verifyStatus: resp.status,
                verify: json ?? text.slice(0, 300),
            };
        })()`, { timeout: 90_000 });
        console.log("[verify-in-page]", JSON.stringify(verifyInPage, null, 2));
    }

    console.log("[network]", net.slice(0, 12));
    await page.close().catch(() => {});
    return diag;
}

async function main() {
    if (!existsSync(veloraBin)) throw new Error("zig build first");
    const { proc, endpoint } = await spawnVelora();
    const browser = await Browser.connect(endpoint);
    try {
        for (const site of SITES) {
            await runSite(browser, site);
        }
    } finally {
        await browser.close().catch(() => {});
        proc.kill("SIGTERM");
    }
}

main().catch((e) => { console.error(e); process.exit(1); });