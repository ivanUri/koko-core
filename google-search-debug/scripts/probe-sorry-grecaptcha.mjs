#!/usr/bin/env node
/**
 * Probe grecaptcha state on Google /sorry page (Velora vs Chrome).
 */
import { captureSorryParity } from "../lib/capture-sorry-parity.mjs";
import {
    buildSearchUrl,
    getFreePort,
    spawnVelora,
    resolveGoogleChromeSession,
    killProc,
    connectCdp,
} from "../lib/cdp.mjs";
import { parseMaxSecArg } from "../../scripts/lib/cdp-probe-budget.mjs";

const PROBE = `(() => ({
    href: location.href,
    grecaptcha: typeof grecaptcha,
    grecaptchaKeys: typeof grecaptcha === "object" && grecaptcha ? Object.keys(grecaptcha).slice(0, 20) : null,
    enterprise: typeof grecaptcha?.enterprise,
    cfg: typeof ___grecaptcha_cfg,
    cfgClients: ___grecaptcha_cfg?.clients ? Object.keys(___grecaptcha_cfg.clients).length : null,
    recaptchaDiv: !!document.getElementById("recaptcha"),
    recaptchaChildCount: document.getElementById("recaptcha")?.childElementCount ?? 0,
    iframeCount: document.querySelectorAll("iframe").length,
    scriptCount: document.scripts.length,
    readyState: document.readyState,
}))()`;

async function probeEndpoint(endpoint, url, maxSec) {
    const capture = await captureSorryParity({ endpoint, url, label: "probe", maxSec, injectFingerprint: false });
    const conn = await connectCdp(endpoint);
    const { client, sessionId } = conn;
    try {
        const res = await client.send("Runtime.evaluate", { expression: PROBE, returnByValue: true }, sessionId);
        return { capture: { network: capture.network.length, finalUrl: capture.finalUrl, hasIframe: capture.sorryDom?.hasRecaptchaIframe }, grecaptcha: res.result?.value };
    } finally {
        client.close();
    }
}

async function main() {
    const maxSec = parseMaxSecArg(process.argv.slice(2), 25);
    const url = buildSearchUrl("test", { hl: "en" });
    let veloraProc = null;
    let chromeProc = null;
    try {
        const veloraPort = await getFreePort();
        const velora = await spawnVelora("chrome-local-huys-macbook-pro", veloraPort);
        veloraProc = velora.proc;
        const chrome = await resolveGoogleChromeSession({ profileDir: `/tmp/velora-google-debug-chrome-${Date.now()}` });
        chromeProc = chrome.proc;

        const [v, c] = await Promise.all([
            probeEndpoint(velora.endpoint, url, maxSec),
            probeEndpoint(chrome.endpoint, url, maxSec),
        ]);
        console.log(JSON.stringify({ velora: v, chrome: c }, null, 2));
    } finally {
        killProc(veloraProc);
        killProc(chromeProc);
    }
}

main().catch((e) => { console.error(e); process.exit(2); });