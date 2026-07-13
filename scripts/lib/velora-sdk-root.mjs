import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Resolve velora-sdk checkout (sibling of velora by default). */
export function veloraSdkRoot() {
    if (process.env.VELORA_SDK_ROOT) return process.env.VELORA_SDK_ROOT;
    const sibling = resolve(__dirname, "../../../velora-sdk");
    if (existsSync(resolve(sibling, "package.json"))) return sibling;
    throw new Error(
        "velora-sdk not found. Clone beside velora (Desktop/velora-sdk) or set VELORA_SDK_ROOT.",
    );
}

export async function importChromeCdp() {
    const root = veloraSdkRoot();
    const modPath = resolve(root, "scripts/lib/chrome-cdp.mjs");
    if (!existsSync(modPath)) {
        throw new Error(`missing ${modPath} — run: cd velora-sdk && npm install && npm run build`);
    }
    return import(modPath);
}