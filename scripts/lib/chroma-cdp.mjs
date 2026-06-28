/**
 * Chroma (Kameleo-custom browser) via CDP.
 *
 * Prerequisite — hoặc dùng spawnChroma():
 *   node Kameleo-decode/open-chroma-kameleo.js profile_01
 *   CHROMA_CDP=http://127.0.0.1:9300
 */
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");
const KAMELEO_DIR = resolve(repoRoot, "Kameleo-decode");

export const CHROMA_BIN = process.env.CHROMA_BIN
    || join(KAMELEO_DIR, "chroma-147-osx-arm64-2026_04_24T11_33/browser/Chroma.app/Contents/MacOS/Chroma");
export const CHROMA_WORKSPACE = process.env.CHROMA_WORKSPACE
    || join(KAMELEO_DIR, "profiles_standard");
export const CHROMA_EXT = process.env.CHROMA_EXT
    || join(KAMELEO_DIR, "q2zu3qe0.zyy");
export const DEFAULT_ENDPOINT = process.env.CHROMA_CDP || "http://127.0.0.1:9300";

const XOR_KEY = Buffer.from("55PdENvBRNBStL3TH9AxnH9bMhqNg7CH");
const require = createRequire(import.meta.url);
const KameleoHub = require(join(KAMELEO_DIR, "kameleo-hub.js"));

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export function normalizeEndpoint(endpoint) {
    return String(endpoint || DEFAULT_ENDPOINT).replace(/\/$/, "");
}

export async function cdpReady(endpoint = DEFAULT_ENDPOINT) {
    try {
        return (await fetch(`${normalizeEndpoint(endpoint)}/json/version`)).ok;
    } catch {
        return false;
    }
}

function readProfileBin(kppPath) {
    const filePath = join(kppPath, "profile.bin");
    if (!existsSync(filePath)) return null;
    const script = `
import sys, struct, msgpack, json
raw = open(sys.argv[1],'rb').read()
b0 = raw[0]
if b0 == 0xc7:
    payload = raw[3:3+raw[1]]
elif b0 == 0xc8:
    ext_len = struct.unpack('>H', raw[1:3])[0]
    payload = raw[4:4+ext_len]
else:
    sys.exit(1)
u = msgpack.Unpacker(raw=False, strict_map_key=False)
u.feed(payload)
u.unpack()
print(json.dumps(u.unpack(), ensure_ascii=False, default=str))
`;
    const r = spawnSync("python3", ["-c", script, filePath], { encoding: "utf8" });
    try { return JSON.parse(r.stdout); } catch { return null; }
}

function readOpts(kppPath) {
    try {
        const data = readFileSync(join(kppPath, "opts"));
        const plain = Buffer.from(data.map((b, i) => b ^ XOR_KEY[i % 32]));
        return JSON.parse(plain.toString("utf8").replace(/\0+$/, ""));
    } catch {
        return null;
    }
}

function buildProxyArg(profileBin) {
    const p = profileBin?.Proxy;
    if (!p || p.Value === 0 || !p.Extra?.Host) return null;
    return `${p.Extra.Scheme || "http"}://${p.Extra.Host}:${p.Extra.Port}`;
}

function buildChromaArgs(kppPath, cdpPort, hubPort, profileBin) {
    const proxy = buildProxyArg(profileBin);
    return [
        "--disable-background-networking",
        "--disable-backgrounding-occluded-windows",
        "--disable-client-side-phishing-detection",
        "--disable-default-apps",
        "--disable-features=",
        "--disable-hang-monitor",
        "--disable-popup-blocking",
        "--disable-prompt-on-repost",
        "--disable-sync",
        "--no-default-browser-check",
        "--no-first-run",
        "--no-service-autorun",
        "--enable-unsafe-swiftshader",
        ...(existsSync(CHROMA_EXT) ? [`--load-extension=${CHROMA_EXT}`] : []),
        `--remote-debugging-port=${cdpPort}`,
        `--user-data-dir=${join(kppPath, "browser")}`,
        `--kpp=${kppPath}`,
        "--no-sandbox",
        "--use-mock-keychain",
        ...(proxy ? [`--proxy-server=${proxy}`] : []),
        `--proxy-bypass-list=127.0.0.1:${hubPort};localhost:${hubPort}`,
    ];
}

async function injectHubCookie(cdpPort, hubPort, profileId) {
    for (let i = 0; i < 20; i++) {
        if (await cdpReady(`http://127.0.0.1:${cdpPort}`)) break;
        await delay(500);
    }
    if (!(await cdpReady(`http://127.0.0.1:${cdpPort}`))) return;

    const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
    const target = targets.find((t) => t.type === "page") || targets[0];
    if (!target?.webSocketDebuggerUrl) return;

    const WS = (await import("ws")).default;
    await new Promise((resolve, reject) => {
        const ws = new WS(target.webSocketDebuggerUrl);
        ws.on("open", () => {
            ws.send(JSON.stringify({
                id: 1,
                method: "Network.setCookie",
                params: {
                    name: "KameleoExtensionSettings",
                    value: JSON.stringify([hubPort, profileId]),
                    domain: "127.0.0.1",
                    path: "/",
                    secure: false,
                    httpOnly: false,
                },
            }));
        });
        ws.on("message", (raw) => {
            const msg = JSON.parse(String(raw));
            if (msg.id === 1) { ws.close(); resolve(); }
        });
        ws.on("error", reject);
        setTimeout(() => reject(new Error("hub cookie inject timeout")), 5000);
    }).catch(() => undefined);
}

export function listChromaProfiles() {
    if (!existsSync(CHROMA_WORKSPACE)) return [];
    return readdirSync(CHROMA_WORKSPACE)
        .filter((d) => statSync(join(CHROMA_WORKSPACE, d)).isDirectory()
            && existsSync(join(CHROMA_WORKSPACE, d, "opts")))
        .sort();
}

/**
 * Launch Chroma + Kameleo Hub for one profile.
 * @param {{ profile?: string, cdpPort?: number, hubPort?: number }} opts
 */
export async function spawnChroma(opts = {}) {
    const profileName = opts.profile || "profile_01";
    const kppPath = join(CHROMA_WORKSPACE, profileName);
    if (!existsSync(kppPath)) {
        throw new Error(`Chroma profile not found: ${kppPath}\nProfiles: ${listChromaProfiles().join(", ")}`);
    }
    if (!existsSync(CHROMA_BIN)) {
        throw new Error(`Chroma binary not found: ${CHROMA_BIN}`);
    }

    const cdpPort = Number(opts.cdpPort ?? 9300);
    const hubPort = Number(opts.hubPort ?? 54300);
    const endpoint = `http://127.0.0.1:${cdpPort}`;

    const profileBin = readProfileBin(kppPath);
    const profileOpts = readOpts(kppPath);
    const profileId = profileOpts?.profileId || profileBin?.Id || profileName;

    const hub = new KameleoHub(hubPort);
    await hub.start();

    const args = buildChromaArgs(kppPath, cdpPort, hubPort, profileBin);
    const proc = spawn(CHROMA_BIN, args, { stdio: "ignore", detached: false });

    for (let i = 0; i < 60; i++) {
        if (await cdpReady(endpoint)) break;
        await delay(200);
    }
    if (!(await cdpReady(endpoint))) {
        proc.kill("SIGTERM");
        await hub.stop().catch(() => undefined);
        throw new Error(`Chroma CDP not ready: ${endpoint}`);
    }

    await delay(1500);
    await injectHubCookie(cdpPort, hubPort, profileId);

    const cleanup = async () => {
        proc.kill("SIGTERM");
        await delay(200);
        await hub.stop().catch(() => undefined);
    };

    return { proc, hub, endpoint, profileName, profileId, cdpPort, hubPort, cleanup };
}

/**
 * Connect to running Chroma CDP, optionally spawn if unreachable.
 */
export async function connectChroma(opts = {}) {
    let endpoint = normalizeEndpoint(opts.endpoint || DEFAULT_ENDPOINT);
    let spawned = null;

    if (!(await cdpReady(endpoint))) {
        if (opts.spawn) {
            spawned = await spawnChroma({
                profile: opts.profile,
                cdpPort: opts.cdpPort ?? Number(new URL(endpoint).port || 9300),
                hubPort: opts.hubPort ?? 54300,
            });
            endpoint = spawned.endpoint;
        } else {
            throw new Error(
                `Chroma CDP not reachable: ${endpoint}\n`
                + `Start: node Kameleo-decode/open-chroma-kameleo.js ${opts.profile || "profile_01"}`,
            );
        }
    }

    return { endpoint, spawned, cleanup: spawned?.cleanup ?? (async () => undefined) };
}