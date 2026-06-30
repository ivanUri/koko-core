import { type ChildProcess } from "node:child_process";
import { Browser } from "./browser.js";
import type { BrowserConnectOptions } from "./browser.js";
export interface VeloraLaunchOptions extends BrowserConnectOptions {
    /** Velora antidetect profile id (maps to browser/profiles/<id>.json). */
    profile?: string;
    /** Random profile picked from this list per launch. */
    profilePool?: string[];
    /** Override runtime cookie jar path. */
    cookieJar?: string;
    /** CDP port (default: auto free port). */
    port?: number;
    /** Path to velora binary (default: <repo>/zig-out/bin/velora). */
    binary?: string;
    /** Repo root for profile resolution (default: auto-detect). */
    repoRoot?: string;
    host?: string;
    logLevel?: string;
}
export interface LaunchedVelora {
    browser: Browser;
    endpoint: string;
    port: number;
    profile?: string;
    process: ChildProcess;
    close(): Promise<void>;
}
export declare function launchVelora(options?: VeloraLaunchOptions): Promise<LaunchedVelora>;
