import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Browser } from "./browser.js";
import { delay } from "../utils/timeout.js";
import { ProtocolError } from "../cdp/errors.js";
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
async function getFreePort() {
    return new Promise((resolvePort, reject) => {
        const server = createServer();
        server.unref();
        server.on("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address();
            const port = typeof addr === "object" && addr ? addr.port : 0;
            server.close(() => resolvePort(port));
        });
    });
}
async function waitForCdp(endpoint, timeoutMs = 15_000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        try {
            const res = await fetch(`${endpoint}/json/version`);
            if (res.ok)
                return;
        }
        catch {
            // retry
        }
        await delay(100);
    }
    throw new ProtocolError(`CDP endpoint not ready: ${endpoint}`, { timeout: timeoutMs });
}
function pickProfile(options) {
    if (options.profile)
        return options.profile;
    if (options.profilePool?.length) {
        const idx = Math.floor(Math.random() * options.profilePool.length);
        return options.profilePool[idx];
    }
    return undefined;
}
function resolveBinary(options) {
    if (options.binary)
        return options.binary;
    const candidate = resolve(options.repoRoot ?? REPO_ROOT, "zig-out/bin/velora");
    if (!existsSync(candidate)) {
        throw new ProtocolError(`velora binary not found: ${candidate}. Run 'zig build' first.`);
    }
    return candidate;
}
export async function launchVelora(options = {}) {
    const host = options.host ?? "127.0.0.1";
    const port = options.port ?? await getFreePort();
    const profile = pickProfile(options);
    const binary = resolveBinary(options);
    const repoRoot = options.repoRoot ?? REPO_ROOT;
    const args = ["serve", "--host", host, "--port", String(port)];
    if (profile)
        args.push("--browser-profile", profile);
    if (options.cookieJar)
        args.push("--cookie-jar", options.cookieJar);
    if (options.logLevel)
        args.push("--log-level", options.logLevel);
    const proc = spawn(binary, args, { cwd: repoRoot, stdio: "ignore" });
    const endpoint = `http://${host}:${port}`;
    proc.on("error", (err) => {
        throw new ProtocolError(`failed to spawn velora: ${err.message}`);
    });
    await waitForCdp(endpoint);
    const browser = await Browser.connect(endpoint, options);
    return {
        browser,
        endpoint,
        port,
        profile,
        process: proc,
        async close() {
            await browser.close().catch(() => undefined);
            if (!proc.killed)
                proc.kill("SIGTERM");
        },
    };
}
//# sourceMappingURL=launch.js.map