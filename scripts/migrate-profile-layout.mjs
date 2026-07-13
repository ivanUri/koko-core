#!/usr/bin/env node
/**
 * Migrate legacy browser/profiles/sessions/* to Chrome-style user-data-dir layout.
 *
 * Usage:
 *   node scripts/migrate-profile-layout.mjs
 *   node scripts/migrate-profile-layout.mjs --user-data-dir ~/.velora-user-data
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");

function defaultUserDataDir() {
    if (process.platform === "darwin") {
        return join(homedir(), "Library", "Application Support", "velora");
    }
    return join(homedir(), ".config", "velora");
}

function parseArgs() {
    const args = process.argv.slice(2);
    let userDataDir = defaultUserDataDir();
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--user-data-dir" && args[i + 1]) {
            userDataDir = resolve(args[++i]);
        }
    }
    return { userDataDir };
}

function profileNameFromJar(filename) {
    const m = filename.match(/^(.+)-cookies\.json$/);
    return m ? m[1] : null;
}

function ensurePreferences(profileDir, name) {
    const prefsPath = join(profileDir, "Preferences.json");
    if (existsSync(prefsPath)) return;
    writeFileSync(
        prefsPath,
        JSON.stringify({ version: 1, name, template: name }, null, 2) + "\n",
    );
}

function migrate() {
    const { userDataDir } = parseArgs();
    const legacyDirs = [
        join(REPO, "browser", "profiles", "sessions"),
        join(REPO, "browser", "templates", "sessions"),
    ];

    let migrated = 0;
    for (const legacyDir of legacyDirs) {
        if (!existsSync(legacyDir)) continue;
        for (const file of readdirSync(legacyDir)) {
            if (!file.endsWith("-cookies.json")) continue;
            const profileName = profileNameFromJar(file);
            if (!profileName) continue;

            const profileDir = join(userDataDir, profileName);
            mkdirSync(profileDir, { recursive: true });
            ensurePreferences(profileDir, profileName);

            const destCookies = join(profileDir, "Cookies.json");
            if (!existsSync(destCookies)) {
                copyFileSync(join(legacyDir, file), destCookies);
                console.log(`[cookies] ${file} -> ${destCookies}`);
                migrated++;
            }

            const sidecar = join(legacyDir, `${file}.storage.json`);
            if (existsSync(sidecar)) {
                const lsDir = join(profileDir, "Local Storage");
                mkdirSync(lsDir, { recursive: true });
                const destStorage = join(lsDir, "storage.json");
                if (!existsSync(destStorage)) {
                    copyFileSync(sidecar, destStorage);
                    console.log(`[storage] ${file}.storage.json -> ${destStorage}`);
                }
            }
        }
    }

    console.log(migrated ? `Done. Migrated ${migrated} profile(s) to ${userDataDir}` : "Nothing to migrate.");
}

migrate();