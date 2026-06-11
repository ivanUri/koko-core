#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const { resolve } = require("node:path");

const repoRoot = resolve(__dirname, "..");
const suiteRunner = resolve(__dirname, "wpt-suite-runner.js");
const defaultRoot = "wpt/html/browsers";

function hasExplicitRoot(argv) {
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === "--root") return true;
        if (arg.startsWith("--root=")) return true;
    }
    return false;
}

function usage() {
    return `Usage: node code-check/wpt-browsers-runner.js [options]\n\nRuns the WPT suite runner with a default root of ${defaultRoot}.\n\nExamples:\n  node code-check/wpt-browsers-runner.js\n  node code-check/wpt-browsers-runner.js --limit 20\n  node code-check/wpt-browsers-runner.js --root wpt/html/browsers/browsing-the-web/back-forward-cache\n`;
}

function main() {
    const argv = process.argv.slice(2);
    if (argv.includes("--help") || argv.includes("-h")) {
        console.log(usage());
    }

    const forwardedArgs = hasExplicitRoot(argv) ? argv : ["--root", defaultRoot, ...argv];
    const result = spawnSync(process.execPath, [suiteRunner, ...forwardedArgs], {
        cwd: repoRoot,
        stdio: "inherit",
    });

    if (result.error) throw result.error;
    if (typeof result.status === "number") process.exitCode = result.status;
    else if (result.signal) process.kill(process.pid, result.signal);
}

main();
