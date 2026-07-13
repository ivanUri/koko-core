import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Resolve velora-connect checkout (sibling of velora by default). */
export function veloraConnectRoot() {
    if (process.env.VELORA_CONNECT_ROOT) return process.env.VELORA_CONNECT_ROOT;
    const sibling = resolve(__dirname, "../../../velora-connect");
    if (existsSync(resolve(sibling, "package.json"))) return sibling;
    throw new Error(
        "velora-connect not found. Clone beside velora (Desktop/velora-connect) or set VELORA_CONNECT_ROOT.",
    );
}

export async function importChromeCdp() {
    const root = veloraConnectRoot();
    const modPath = resolve(root, "scripts/lib/chrome-cdp.mjs");
    if (!existsSync(modPath)) {
        throw new Error(`missing ${modPath} — run npm run build in velora-connect`);
    }
    return import(modPath);
}