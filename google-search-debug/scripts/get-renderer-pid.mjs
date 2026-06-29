#!/usr/bin/env node
/**
 * Resolve renderer process PID for a Chrome CDP tab (Frida attach).
 *
 *   node google-search-debug/scripts/get-renderer-pid.mjs
 *   node google-search-debug/scripts/get-renderer-pid.mjs --url-contains google.com/search
 */
import { normalizeEndpoint, DEFAULT_ENDPOINT } from "../lib/cdp.mjs";

function parseArgs(argv) {
    const out = {
        endpoint: process.env.CHROME_CDP || DEFAULT_ENDPOINT,
        urlContains: "google.com",
    };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === "--endpoint") out.endpoint = argv[++i];
        else if (a === "--url-contains") out.urlContains = argv[++i];
    }
    return out;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const base = normalizeEndpoint(args.endpoint);
    const list = await (await fetch(`${base}/json/list`)).json();
    const matches = list.filter((t) => {
        const u = t.url || "";
        return u.includes(args.urlContains) && t.type === "page";
    });

    if (!matches.length) {
        console.error(`No tab matching "${args.urlContains}" on ${base}`);
        console.error("Open Google Search in Chrome first.");
        process.exit(1);
    }

    const tab = matches[matches.length - 1];
    const out = {
        endpoint: base,
        id: tab.id,
        title: tab.title,
        url: tab.url,
        webSocketDebuggerUrl: tab.webSocketDebuggerUrl,
        /** Chrome /json/list does not expose OS pid; use Frida spawn or `ps` by title. */
        note: "Use `ps aux | grep Chrome` or attach Frida by browser name; for exact PID enable --remote-debugging-pipe or Target.getBrowserContexts + system tools.",
    };
    console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
    console.error(e);
    process.exit(2);
});