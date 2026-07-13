import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Resolve velora-connect checkout (sibling of velora by default). */
export function veloraConnectRoot() {
    if (process.env.VELORA_CONNECT_ROOT) return process.env.VELORA_CONNECT_ROOT;
    const sibling = resolve(__dirname, "../../../velora-connect");
    if (existsSync(resolve(sibling, "sdk/package.json"))) return sibling;
    throw new Error(
        "velora-connect not found. Clone beside velora (Desktop/velora-connect) or set VELORA_CONNECT_ROOT.",
    );
}

export function veloraConnectSdkDir() {
    return resolve(veloraConnectRoot(), "sdk");
}

export async function importChromeCdp() {
    const sdkDir = veloraConnectSdkDir();
    const modPath = resolve(sdkDir, "scripts/lib/chrome-cdp.mjs");
    if (!existsSync(modPath)) {
        throw new Error(`missing ${modPath} — run: cd velora-connect/sdk && npm install && npm run build`);
    }
    return import(modPath);
}