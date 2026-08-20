import { existsSync } from "node:fs";
import { delimiter } from "node:path";
import { ChromiumCdpAdapter } from "./chromium-cdp.mjs";
import { KokoCdpAdapter } from "./koko-cdp.mjs";
import { LightpandaCdpAdapter } from "./lightpanda-cdp.mjs";
import { PlaywrightAdapter } from "./playwright.mjs";

const adapterTypes = [KokoCdpAdapter, ChromiumCdpAdapter, LightpandaCdpAdapter, PlaywrightAdapter];

function executableOnPath(name) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = `${directory}/${name}`;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function detectChrome(explicitPath) {
  if (explicitPath) {
    if (!existsSync(explicitPath)) throw new Error(`Chrome executable not found: ${explicitPath}`);
    return explicitPath;
  }
  const candidates = process.platform === "darwin"
    ? [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
      ]
    : [executableOnPath("google-chrome"), executableOnPath("chromium"), executableOnPath("chromium-browser")];
  const found = candidates.find((candidate) => candidate && existsSync(candidate));
  if (!found) throw new Error("Chrome/Chromium was not found; pass --chrome-bin <path>");
  return found;
}

export function createAdapterFactories(ids, options) {
  const types = new Map(adapterTypes.map((Adapter) => [Adapter.id, Adapter]));
  return ids.map((id) => {
    const Adapter = types.get(id);
    if (!Adapter) throw new Error(`Unknown baseline: ${id}`);
    return {
      id: Adapter.id,
      label: Adapter.label,
      create: () => new Adapter(options),
    };
  });
}

export const allAdapterIds = adapterTypes.map((Adapter) => Adapter.id);
