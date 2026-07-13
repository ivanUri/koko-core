#!/usr/bin/env node
/**
 * Velora profile bundle — self-contained fingerprint snapshot + optional session.
 *
 *   node scripts/profile-bundle.mjs publish --template chrome-local-huys-macbook-pro [--version 1]
 *   node scripts/profile-bundle.mjs export --name <profile> [--out path] [--user-data-dir ...]
 *   node scripts/profile-bundle.mjs import --from <bundle-dir> --name <profile> [--user-data-dir ...]
 *
 * Bundle layout (directory):
 *   manifest.json
 *   fingerprint.json      # template JSON with asset paths -> assets/<basename>
 *   assets/
 *   session/              # optional (Cookies.json, Local Storage/)
 */

import {
    copyFileSync,
    cpSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const FORMAT = "velora-profile-bundle";
const FORMAT_VERSION = 1;

function defaultUserDataDir() {
    if (process.platform === "darwin") {
        return join(homedir(), "Library", "Application Support", "velora");
    }
    return join(homedir(), ".config", "velora");
}

function usage(code = 1) {
    console.error(`Usage:
  node scripts/profile-bundle.mjs publish --template <id> [--version N] [--velora-root PATH]
  node scripts/profile-bundle.mjs export --name <profile> [--out DIR] [--user-data-dir PATH] [--velora-root PATH]
  node scripts/profile-bundle.mjs import --from <bundle-dir> --name <profile> [--user-data-dir PATH]
`);
    process.exit(code);
}

function parseArgs(argv) {
    const out = {
        cmd: null,
        template: null,
        name: null,
        from: null,
        out: null,
        version: 1,
        userDataDir: defaultUserDataDir(),
        veloraRoot: process.env.VELORA_ROOT ? resolve(process.env.VELORA_ROOT) : REPO,
    };
    const args = argv.slice(2);
    if (!args.length) usage();
    let i = 0;
    while (i < args.length && args[i].startsWith("--")) {
        const a = args[i];
        if (a === "--velora-root") out.veloraRoot = resolve(args[++i]);
        else if (a === "--user-data-dir") out.userDataDir = resolve(args[++i]);
        else if (a === "--help") usage(0);
        else break;
        i++;
    }
    if (i >= args.length) usage();
    out.cmd = args[i++];
    for (; i < args.length; i++) {
        const a = args[i];
        if (a === "--template") out.template = args[++i];
        else if (a === "--name") out.name = args[++i];
        else if (a === "--from") out.from = resolve(args[++i]);
        else if (a === "--out") out.out = resolve(args[++i]);
        else if (a === "--version") out.version = Number(args[++i]);
        else if (a === "--user-data-dir") out.userDataDir = resolve(args[++i]);
        else if (a === "--velora-root") out.veloraRoot = resolve(args[++i]);
        else if (a === "--help") usage(0);
        else throw new Error(`Unknown arg: ${a}`);
    }
    return out;
}

function templateJsonPath(veloraRoot, templateId) {
    if (templateId === "velora") return join(veloraRoot, "browser/velora.json");
    const modern = join(veloraRoot, "browser/templates", `${templateId}.json`);
    if (existsSync(modern)) return modern;
    const legacy = join(veloraRoot, "browser/profiles", `${templateId}.json`);
    if (existsSync(legacy)) return legacy;
    throw new Error(`Template not found: ${templateId}`);
}

function isAssetPathString(s) {
    return typeof s === "string"
        && s.length > 0
        && (s.endsWith(".json") || s.endsWith(".txt"))
        && !s.startsWith("assets/");
}

function collectAssetPaths(value, acc = new Set()) {
    if (typeof value === "string") {
        if (isAssetPathString(value)) acc.add(value);
        return acc;
    }
    if (Array.isArray(value)) {
        for (const v of value) collectAssetPaths(v, acc);
        return acc;
    }
    if (value && typeof value === "object") {
        for (const v of Object.values(value)) collectAssetPaths(v, acc);
    }
    return acc;
}

function resolveAssetSource(veloraRoot, relPath) {
    const candidates = [
        resolve(veloraRoot, relPath),
        resolve(REPO, relPath),
        resolve(relPath),
    ];
    for (const p of candidates) {
        if (existsSync(p) && statSync(p).isFile()) return p;
    }
    throw new Error(`Asset not found: ${relPath}`);
}

function rewriteFingerprintPaths(obj, pathMap) {
    if (typeof obj === "string") {
        return pathMap.get(obj) ?? obj;
    }
    if (Array.isArray(obj)) {
        return obj.map((v) => rewriteFingerprintPaths(v, pathMap));
    }
    if (obj && typeof obj === "object") {
        const out = {};
        for (const [k, v] of Object.entries(obj)) {
            out[k] = rewriteFingerprintPaths(v, pathMap);
        }
        return out;
    }
    return obj;
}

function buildSnapshotFromTemplate(veloraRoot, templateId, version, destDir) {
    const templatePath = templateJsonPath(veloraRoot, templateId);
    const raw = JSON.parse(readFileSync(templatePath, "utf8"));
    const assetPaths = [...collectAssetPaths(raw)].sort();

    const assetsDir = join(destDir, "assets");
    mkdirSync(assetsDir, { recursive: true });

    const pathMap = new Map();
    for (const rel of assetPaths) {
        const src = resolveAssetSource(veloraRoot, rel);
        const name = basename(rel);
        let destName = name;
        let n = 1;
        while (existsSync(join(assetsDir, destName))) {
            const ext = name.includes(".") ? `.${name.split(".").pop()}` : "";
            const stem = ext ? name.slice(0, -ext.length) : name;
            destName = `${stem}-${n}${ext}`;
            n++;
        }
        copyFileSync(src, join(assetsDir, destName));
        pathMap.set(rel, `assets/${destName}`);
    }

    const fingerprint = rewriteFingerprintPaths(raw, pathMap);
    if (!fingerprint.version) fingerprint.version = 1;
    fingerprint.id = fingerprint.id ?? templateId;

    const manifest = {
        format: FORMAT,
        formatVersion: FORMAT_VERSION,
        created: new Date().toISOString(),
        template: { id: templateId, version },
        profile: { name: templateId },
    };

    writeFileSync(join(destDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(join(destDir, "fingerprint.json"), `${JSON.stringify(fingerprint, null, 2)}\n`);
    return manifest;
}

function catalogDir(veloraRoot, templateId, version) {
    return join(veloraRoot, "browser/catalog", templateId, String(version));
}

function publish(opts) {
    if (!opts.template) throw new Error("--template required");
    const dest = catalogDir(opts.veloraRoot, opts.template, opts.version);
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    const manifest = buildSnapshotFromTemplate(opts.veloraRoot, opts.template, opts.version, dest);
    console.log(`published ${manifest.template.id}@${manifest.template.version} -> ${dest}`);
    console.log(`  assets: ${readdirSync(join(dest, "assets")).length} file(s)`);
}

function exportProfile(opts) {
    if (!opts.name) throw new Error("--name required");
    const profileDir = join(opts.userDataDir, opts.name);
    if (!existsSync(profileDir)) throw new Error(`Profile not found: ${profileDir}`);

    const prefsPath = join(profileDir, "Preferences.json");
    let templateId = opts.name;
    let templateVersion = 1;
    if (existsSync(prefsPath)) {
        const prefs = JSON.parse(readFileSync(prefsPath, "utf8"));
        templateId = prefs.template ?? templateId;
        templateVersion = prefs.template_version ?? prefs.templateVersion ?? 1;
    }

    const snapshotDir = join(profileDir, "snapshot");
    if (existsSync(join(snapshotDir, "fingerprint.json"))) {
        templateId = JSON.parse(readFileSync(join(snapshotDir, "manifest.json"), "utf8")).template?.id ?? templateId;
    } else if (!existsSync(catalogDir(opts.veloraRoot, templateId, templateVersion))) {
        mkdirSync(snapshotDir, { recursive: true });
        buildSnapshotFromTemplate(opts.veloraRoot, templateId, templateVersion, snapshotDir);
    }

    const outDir = opts.out ?? join(opts.userDataDir, `${opts.name}.velora-profile`);
    if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });

    const srcSnapshot = existsSync(join(profileDir, "snapshot", "fingerprint.json"))
        ? join(profileDir, "snapshot")
        : catalogDir(opts.veloraRoot, templateId, templateVersion);

    cpSync(srcSnapshot, join(outDir, "snapshot"), { recursive: true });

    const sessionDir = join(outDir, "session");
    mkdirSync(sessionDir, { recursive: true });
    const cookies = join(profileDir, "Cookies.json");
    if (existsSync(cookies)) copyFileSync(cookies, join(sessionDir, "Cookies.json"));
    const ls = join(profileDir, "Local Storage");
    if (existsSync(ls)) cpSync(ls, join(sessionDir, "Local Storage"), { recursive: true });

    const bundleManifest = {
        format: FORMAT,
        formatVersion: FORMAT_VERSION,
        created: new Date().toISOString(),
        profile: { name: opts.name, template: templateId, template_version: templateVersion },
        exported_from: profileDir,
    };
    writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(bundleManifest, null, 2)}\n`);
    writeFileSync(join(outDir, "Preferences.json"), `${JSON.stringify({
        version: 2,
        name: opts.name,
        template: templateId,
        template_version: templateVersion,
        snapshot: "snapshot",
    }, null, 2)}\n`);

    console.log(`exported profile '${opts.name}' -> ${outDir}`);
}

function importProfile(opts) {
    if (!opts.from) throw new Error("--from required");
    if (!opts.name) throw new Error("--name required");
    if (!existsSync(opts.from)) throw new Error(`Bundle not found: ${opts.from}`);

    const bundleManifestPath = join(opts.from, "manifest.json");
    const bundleManifest = existsSync(bundleManifestPath)
        ? JSON.parse(readFileSync(bundleManifestPath, "utf8"))
        : {};

    let snapshotSrc = join(opts.from, "snapshot");
    if (!existsSync(join(snapshotSrc, "fingerprint.json"))) {
        if (existsSync(join(opts.from, "fingerprint.json"))) snapshotSrc = opts.from;
        else throw new Error("Bundle missing snapshot/ or fingerprint.json");
    }

    const snapManifestPath = join(snapshotSrc, "manifest.json");
    const snapManifest = existsSync(snapManifestPath)
        ? JSON.parse(readFileSync(snapManifestPath, "utf8"))
        : {};

    const templateId = bundleManifest.profile?.template
        ?? snapManifest.template?.id
        ?? opts.name;
    const templateVersion = bundleManifest.profile?.template_version
        ?? snapManifest.template?.version
        ?? 1;

    const profileDir = join(opts.userDataDir, opts.name);
    if (existsSync(profileDir)) throw new Error(`Profile already exists: ${profileDir} (delete first)`);

    mkdirSync(profileDir, { recursive: true });
    cpSync(snapshotSrc, join(profileDir, "snapshot"), { recursive: true });

    const prefs = {
        version: 2,
        name: opts.name,
        template: templateId,
        template_version: templateVersion,
        snapshot: "snapshot",
        created: new Date().toISOString(),
    };
    writeFileSync(join(profileDir, "Preferences.json"), `${JSON.stringify(prefs, null, 2)}\n`);

    const sessionDir = join(opts.from, "session");
    if (existsSync(sessionDir)) {
        const cookies = join(sessionDir, "Cookies.json");
        if (existsSync(cookies)) copyFileSync(cookies, join(profileDir, "Cookies.json"));
        const ls = join(sessionDir, "Local Storage");
        if (existsSync(ls)) cpSync(ls, join(profileDir, "Local Storage"), { recursive: true });
    }

    console.log(`imported bundle -> ${profileDir}`);
    console.log(`  template: ${templateId}@${templateVersion}`);
}

function main() {
    const opts = parseArgs(process.argv);
    if (opts.cmd === "publish") publish(opts);
    else if (opts.cmd === "export") exportProfile(opts);
    else if (opts.cmd === "import") importProfile(opts);
    else usage();
}

main();