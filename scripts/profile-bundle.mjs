#!/usr/bin/env node

import {
    copyFileSync,
    cpSync,
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

function defaultUserDataDir() {
    return process.platform === "darwin"
        ? join(homedir(), "Library", "Application Support", "velora")
        : join(homedir(), ".config", "velora");
}

function parseArgs(argv) {
    const out = {
        command: null,
        name: null,
        from: null,
        out: null,
        userDataDir: defaultUserDataDir(),
        veloraRoot: process.env.VELORA_ROOT ? resolve(process.env.VELORA_ROOT) : repoRoot,
    };
    const args = argv.slice(2);
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (!arg.startsWith("--") && out.command === null) out.command = arg;
        else if (arg === "--name") out.name = args[++i];
        else if (arg === "--from") out.from = resolve(args[++i]);
        else if (arg === "--out") out.out = resolve(args[++i]);
        else if (arg === "--user-data-dir") out.userDataDir = resolve(args[++i]);
        else if (arg === "--velora-root") out.veloraRoot = resolve(args[++i]);
        else throw new Error(`unknown argument: ${arg}`);
    }
    return out;
}

function readPreferences(profileDir) {
    const value = JSON.parse(readFileSync(join(profileDir, "Preferences.json"), "utf8"));
    if (value.version !== 3) throw new Error("profile preferences must use version 3");
    const fingerprint = value.fingerprint;
    if (!fingerprint) throw new Error("profile has no fingerprint id");
    return { fingerprint };
}

function fingerprintSource(opts, profileDir, id) {
    const embedded = join(profileDir, "fingerprint");
    if (existsSync(join(embedded, "fingerprint.json"))) return embedded;
    const installed = join(opts.veloraRoot, "browser", "fingerprints", id);
    if (existsSync(join(installed, "fingerprint.json"))) return installed;
    throw new Error(`fingerprint not found: ${id}`);
}

function exportProfile(opts) {
    if (!opts.name) throw new Error("--name required");
    const profileDir = join(opts.userDataDir, opts.name);
    if (!existsSync(profileDir)) throw new Error(`profile not found: ${profileDir}`);
    const prefs = readPreferences(profileDir);
    const source = fingerprintSource(opts, profileDir, prefs.fingerprint);
    const destination = opts.out ?? join(opts.userDataDir, `${opts.name}.velora-profile`);
    const staging = `${destination}.staging-${process.pid}`;

    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    cpSync(source, join(staging, "fingerprint"), { recursive: true });
    writeFileSync(join(staging, "Preferences.json"), `${JSON.stringify({
        version: 3,
        name: opts.name,
        fingerprint: prefs.fingerprint,
    }, null, 2)}\n`);

    const session = join(staging, "session");
    mkdirSync(session);
    const cookies = join(profileDir, "Cookies.json");
    if (existsSync(cookies)) copyFileSync(cookies, join(session, "Cookies.json"));
    const localStorage = join(profileDir, "Local Storage");
    if (existsSync(localStorage)) cpSync(localStorage, join(session, "Local Storage"), { recursive: true });

    rmSync(destination, { recursive: true, force: true });
    renameSync(staging, destination);
    console.log(`exported profile '${opts.name}' -> ${destination}`);
}

function importProfile(opts) {
    if (!opts.name) throw new Error("--name required");
    if (!opts.from) throw new Error("--from required");
    const fingerprint = join(opts.from, "fingerprint");
    if (!existsSync(join(fingerprint, "fingerprint.json"))) {
        throw new Error("bundle must contain fingerprint/fingerprint.json");
    }
    const sourcePrefs = readPreferences(opts.from);
    const destination = join(opts.userDataDir, opts.name);
    if (existsSync(destination)) throw new Error(`profile already exists: ${destination}`);
    const staging = `${destination}.staging-${process.pid}`;

    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    cpSync(fingerprint, join(staging, "fingerprint"), { recursive: true });
    writeFileSync(join(staging, "Preferences.json"), `${JSON.stringify({
        version: 3,
        name: opts.name,
        fingerprint: sourcePrefs.fingerprint,
    }, null, 2)}\n`);
    const session = join(opts.from, "session");
    if (existsSync(session)) cpSync(session, join(staging, "session"), { recursive: true });
    renameSync(staging, destination);
    console.log(`imported profile '${opts.name}' -> ${destination}`);
}

const opts = parseArgs(process.argv);
if (opts.command === "export") exportProfile(opts);
else if (opts.command === "import") importProfile(opts);
else throw new Error("command must be export or import");
