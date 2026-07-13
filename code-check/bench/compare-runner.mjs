#!/usr/bin/env node
// Benchmark Velora vs Playwright Chromium: startup, navigation, JS workloads.

import { resolve, dirname } from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import {
    JS_WORKLOADS,
    assertReleaseFastBinary,
    collectHtmlFiles,
    collectMeta,
    connectCDP,
    createVeloraPage,
    delay,
    ensureDir,
    fmt,
    geomean,
    getFreePort,
    measureChromiumStartup,
    measureVeloraStartup,
    ratio,
    repoRoot,
    runBrowserBench,
    runChromeJs,
    runChromeNavigate,
    runVeloraJs,
    runVeloraNavigate,
    spawnVelora,
    startStaticServer,
    stopProcess,
    testRoot,
    waitForServer,
    writeJsonFile,
} from "./lib/compare-core.mjs";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const tmpDir = resolve(repoRoot, "code-check/tmp/benchmarks");

const defaults = {
    host: "127.0.0.1",
    report: resolve(tmpDir, "run.json"),
    log: resolve(repoRoot, "code-check/tmp/logs/benchmark-compare.log"),
    repeats: 3,
    warmup: 1,
    startupRepeats: 5,
    startupWarmup: 2,
    timeoutMs: 10000,
    serverTimeoutMs: 8000,
    commandTimeoutMs: 15000,
    settleMs: 0,
    httpTimeoutMs: 30000,
    logLevel: "warn",
    logFormat: "pretty",
    browserProfile: "chrome-macos-catalina",
    navMode: "reuse",
};

function usage() {
    return `Usage: npm run bench:compare -- [paths...] [options]

Benchmark Velora vs Playwright Chromium (startup, navigation, JS workloads).

Options:
  --report <path>         JSON report (default: ${defaults.report})
  --log <path>            Velora log path
  --repeats <n>           Measured iterations (default: ${defaults.repeats})
  --warmup <n>            Warmup iterations (default: ${defaults.warmup})
  --startup-repeats <n>   Startup measured iterations (default: ${defaults.startupRepeats})
  --startup-warmup <n>    Startup warmup iterations (default: ${defaults.startupWarmup})
  --timeout <ms>          Navigation timeout (default: ${defaults.timeoutMs})
  --profile <name>        Velora browser profile (default: ${defaults.browserProfile})
  --nav-mode reuse|fresh  Velora page per iteration (default: ${defaults.navMode})
  --help                  Show this help
`;
}

function parseArgs(argv) {
    const options = { ...defaults, paths: [] };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const next = () => {
            if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
            i += 1;
            return argv[i];
        };
        switch (arg) {
            case "--report": options.report = resolve(next()); break;
            case "--log": options.log = resolve(next()); break;
            case "--repeats": options.repeats = Number(next()); break;
            case "--warmup": options.warmup = Number(next()); break;
            case "--startup-repeats": options.startupRepeats = Number(next()); break;
            case "--startup-warmup": options.startupWarmup = Number(next()); break;
            case "--timeout": options.timeoutMs = Number(next()); break;
            case "--profile": options.browserProfile = next(); break;
            case "--nav-mode": options.navMode = next(); break;
            case "--help":
            case "-h": options.help = true; break;
            default:
                if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
                options.paths.push(arg);
        }
    }
    if (options.repeats < 1) throw new Error("--repeats must be >= 1");
    if (!["reuse", "fresh"].includes(options.navMode)) throw new Error("--nav-mode must be reuse or fresh");
    return options;
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        console.log(usage());
        return;
    }
    assertReleaseFastBinary();

    ensureDir(tmpDir);
    ensureDir(resolve(options.report, ".."));
    ensureDir(resolve(options.log, ".."));

    const files = collectHtmlFiles(options.paths).filter((file) => file !== "endless.html");
    if (files.length === 0) throw new Error("No .html files found in velora-test");

    const staticPort = await getFreePort(options.host);
    const veloraPort = await getFreePort(options.host);
    const staticServer = await startStaticServer(options.host, staticPort);
    const baseUrl = `http://${options.host}:${staticPort}`;
    const cdpEndpoint = `http://${options.host}:${veloraPort}`;

    const stdoutChunks = [];
    const stderrChunks = [];
    let proc = spawnVelora(veloraPort, options, stdoutChunks, stderrChunks);

    let cdp;
    let veloraPage;
    const restartVelora = async () => {
        if (cdp) cdp.close();
        await stopProcess(proc);
        proc = spawnVelora(veloraPort, options, stdoutChunks, stderrChunks);
        await waitForServer(`${cdpEndpoint}/json/version`, options.serverTimeoutMs);
        cdp = await connectCDP(cdpEndpoint, options);
        veloraPage = await createVeloraPage(cdp);
    };

    const { chromium } = require("playwright");

    try {
        console.log("=== Startup (CDP / browser ready) ===");
        const veloraStartup = await measureVeloraStartup(options);
        const chromiumStartup = await measureChromiumStartup(chromium, options);
        const startupRatio = ratio(veloraStartup.summary.meanMs, chromiumStartup.summary.meanMs);
        console.log(
            `velora    mean=${fmt(veloraStartup.summary.meanMs)} ms median=${fmt(veloraStartup.summary.medianMs)} ms`,
        );
        console.log(
            `chromium  mean=${fmt(chromiumStartup.summary.meanMs)} ms median=${fmt(chromiumStartup.summary.medianMs)} ms ratio=${startupRatio == null ? "n/a" : `${startupRatio.toFixed(2)}x`}`,
        );

        await restartVelora();
        const browser = await chromium.launch({ headless: true });

        const navItems = files.map((file) => ({ file, url: `${baseUrl}/${file.split("/").map(encodeURIComponent).join("/")}` }));

        console.log(`\n=== Navigation (${files.length} pages, repeats=${options.repeats}, warmup=${options.warmup}) ===`);
        console.log("Velora");
        const veloraNav = await runBrowserBench(
            "velora",
            navItems,
            async (item, opts) => {
                if (opts.navMode === "fresh") {
                    veloraPage = await createVeloraPage(cdp);
                }
                const result = await runVeloraNavigate(cdp, veloraPage, item.url, opts);
                if (!result.ok && /websocket|not open/i.test(result.error || "")) {
                    await restartVelora().catch(() => undefined);
                }
                return result;
            },
            options,
        );

        console.log("Chromium");
        const chromiumNav = await runBrowserBench(
            "chromium",
            navItems,
            async (item, opts) => {
                const result = await runChromeNavigate(browser, item.url, opts);
                if (result.page) await result.page.close().catch(() => undefined);
                return result;
            },
            options,
        );

        const navigation = files.map((file, index) => {
            const v = veloraNav[index].summary;
            const c = chromiumNav[index].summary;
            return {
                file,
                veloraMeanMs: v.meanMs,
                veloraMedianMs: v.medianMs,
                chromiumMeanMs: c.meanMs,
                chromiumMedianMs: c.medianMs,
                ratio: ratio(v.meanMs, c.meanMs),
                veloraErrors: v.errors,
                chromiumErrors: c.errors,
            };
        });

        const jsItems = JS_WORKLOADS.map((w) => ({
            name: w.name,
            page: w.page,
            url: `${baseUrl}/${w.page.split("/").map(encodeURIComponent).join("/")}`,
            call: w.call,
        }));

        console.log(`\n=== JS workloads (repeats=${options.repeats}, warmup=${options.warmup}) ===`);
        console.log("Velora");
        const veloraJs = await runBrowserBench(
            "velora",
            jsItems,
            async (item, opts) => {
                if (opts.navMode === "fresh") {
                    veloraPage = await createVeloraPage(cdp);
                }
                const result = await runVeloraJs(cdp, veloraPage, item.url, item.call, opts);
                if (!result.ok && /websocket|not open/i.test(result.error || "")) {
                    await restartVelora().catch(() => undefined);
                }
                return result;
            },
            options,
            "name",
        );

        console.log("Chromium");
        const chromiumJs = await runBrowserBench(
            "chromium",
            jsItems,
            (item, opts) => runChromeJs(browser, item.url, item.call, opts),
            options,
            "name",
        );

        const jsWorkload = jsItems.map((item, index) => {
            const v = veloraJs[index].summary;
            const c = chromiumJs[index].summary;
            return {
                name: item.name,
                page: item.page,
                veloraMeanMs: v.meanMs,
                veloraMedianMs: v.medianMs,
                chromiumMeanMs: c.meanMs,
                chromiumMedianMs: c.medianMs,
                ratio: ratio(v.meanMs, c.meanMs),
                veloraErrors: v.errors,
                chromiumErrors: c.errors,
            };
        });

        await browser.close().catch(() => undefined);

        const navigationGeomeanRatio = geomean(navigation.map((r) => r.ratio));
        const jsGeomeanRatio = geomean(jsWorkload.map((r) => r.ratio));

        console.log("\n=== Summary ===");
        for (const row of navigation) {
            console.log(
                `${row.file.padEnd(40)} velora=${fmt(row.veloraMeanMs)} chromium=${fmt(row.chromiumMeanMs)} ratio=${row.ratio == null ? "n/a" : `${row.ratio.toFixed(2)}x`}`,
            );
        }
        console.log(`Navigation geomean ratio: ${navigationGeomeanRatio == null ? "n/a" : `${navigationGeomeanRatio.toFixed(2)}x`}`);
        console.log(`JS geomean ratio: ${jsGeomeanRatio == null ? "n/a" : `${jsGeomeanRatio.toFixed(2)}x`}`);

        const report = {
            meta: collectMeta(options),
            baseUrl,
            testRoot,
            startup: {
                velora: veloraStartup.summary,
                chromium: chromiumStartup.summary,
                ratio: startupRatio,
                veloraSamples: veloraStartup.samples,
                chromiumSamples: chromiumStartup.samples,
            },
            navigation: {
                rows: navigation,
                velora: veloraNav,
                chromium: chromiumNav,
                geomeanRatio: navigationGeomeanRatio,
            },
            jsWorkload: {
                rows: jsWorkload,
                velora: veloraJs,
                chromium: chromiumJs,
                geomeanRatio: jsGeomeanRatio,
            },
            summary: {
                startupRatio,
                navigationGeomeanRatio,
                jsGeomeanRatio,
            },
        };

        writeJsonFile(options.report, report);

        const dated = resolve(tmpDir, `${report.meta.date}.json`);
        writeJsonFile(dated, report);

        console.log(`\nsaved report: ${options.report}`);
        console.log(`saved dated:  ${dated}`);
    } finally {
        if (cdp && veloraPage) {
            await cdp.send("Target.closeTarget", { targetId: veloraPage.targetId }, undefined, options.commandTimeoutMs).catch(() => undefined);
        }
        if (cdp) cdp.close();
        await new Promise((resolvePromise) => staticServer.close(resolvePromise));
        await stopProcess(proc);
        writeFileSync(
            options.log,
            `--- VELORA STDOUT ---\n${Buffer.concat(stdoutChunks)}\n--- VELORA STDERR ---\n${Buffer.concat(stderrChunks)}\n`,
        );
    }
}

main().catch((err) => {
    console.error(err.stack || err.message);
    process.exitCode = 1;
});