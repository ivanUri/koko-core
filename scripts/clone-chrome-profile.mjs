#!/usr/bin/env node
/**
 * Clone local Google Chrome fingerprint into a Velora antidetect profile.
 *
 * Usage:
 *   node scripts/clone-chrome-profile.mjs
 *   node scripts/clone-chrome-profile.mjs --id chrome-local-m1
 *   node scripts/clone-chrome-profile.mjs --chrome-port 9222   # attach to running Chrome
 *
 * Without --chrome-port: launches a separate Chrome (channel) instance so your
 * main Chrome session can stay open. Reads languages from your Default profile prefs.
 */

import { chromium } from "playwright";
import { execFileSync, spawnSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
import { tmpdir, homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const CHROME_PREFS = join(
    homedir(),
    "Library/Application Support/Google/Chrome/Default/Preferences",
);
const CHROME_LOCAL_STATE = join(
    homedir(),
    "Library/Application Support/Google/Chrome/Local State",
);

const MEASURE_FAMILIES = [
    "-apple-system",
    ".AppleSystemUIFont",
    "Arial",
    "Helvetica",
    "Times New Roman",
    "Courier New",
    "Georgia",
    "Menlo",
    "Monaco",
    "Verdana",
];
const MEASURE_TEXTS = ["", "velora", "😀", "mmmmmmmmmmlli", "Cwm fjordbank glyphs vext quiz", "👾"];

const MAC_FONTS = [
    "Academy Engraved LET", "Al Bayan", "Al Nile", "American Typewriter", "Andale Mono",
    "Apple Chancery", "Apple Color Emoji", "Apple SD Gothic Neo", "Apple Symbols",
    "AppleGothic", "AppleMyungjo", "Arial", "Arial Black", "Arial Hebrew", "Arial Narrow",
    "Arial Rounded MT Bold", "Arial Unicode MS", "Avenir", "Avenir Next", "Avenir Next Condensed",
    "Ayuthaya", "Baghdad", "Bangla Sangam MN", "Baskerville", "Beirut", "Big Caslon",
    "Bodoni 72", "Bodoni 72 Oldstyle", "Bodoni 72 Smallcaps", "Bradley Hand", "Brush Script MT",
    "Chalkboard", "Chalkboard SE", "Chalkduster", "Charter", "Cochin", "Comic Sans MS",
    "Copperplate", "Corsiva Hebrew", "Courier", "Courier New", "Damascus", "DecoType Naskh",
    "Devanagari MT", "Devanagari Sangam MN", "Didot", "Diwan Kufi", "Diwan Thuluth",
    "Euphemia UCAS", "Farah", "Farisi", "Futura", "Galvji", "Geeza Pro", "Geneva",
    "Georgia", "Gill Sans", "Gujarati MT", "Gujarati Sangam MN", "Gurmukhi MN",
    "Gurmukhi MT", "Gurmukhi Sangam MN", "Heiti SC", "Heiti TC", "Helvetica",
    "Helvetica Neue", "Herculanum", "Hiragino Kaku Gothic Pro", "Hiragino Kaku Gothic ProN",
    "Hiragino Maru Gothic Pro", "Hiragino Mincho Pro", "Hiragino Mincho ProN",
    "Hiragino Sans", "Hiragino Sans GB", "Hoefler Text", "Impact", "InaiMathi",
    "Iowan Old Style", "Kailasa", "Kannada MN", "Kannada Sangam MN", "Kefa",
    "Khmer MN", "Khmer Sangam MN", "Kohinoor Bangla", "Kohinoor Devanagari",
    "Kohinoor Gujarati", "Kohinoor Telugu", "Krungthep", "KufiStandardGK", "Lao MN",
    "Lao Sangam MN", "Lucida Grande", "Luminari", "Malayalam MN", "Malayalam Sangam MN",
    "Marion", "Marker Felt", "Menlo", "Microsoft Sans Serif", "Mishafi", "Monaco",
    "Mshtakan", "MuktaMahee", "Muna", "Myanmar MN", "Myanmar Sangam MN", "Nadeem",
    "New Peninim MT", "Noteworthy", "Noto Nastaliq Urdu", "Optima", "Oriya MN",
    "Oriya Sangam MN", "Palatino", "Papyrus", "Party LET", "Phosphate", "PingFang HK",
    "PingFang SC", "PingFang TC", "Plantagenet Cherokee", "PT Mono", "PT Sans",
    "PT Sans Caption", "PT Sans Narrow", "PT Serif", "PT Serif Caption", "Raanana",
    "Rockwell", "Sana", "Sathu", "Savoye LET", "Seravek", "SignPainter", "Silom",
    "Sinhala MN", "Sinhala Sangam MN", "Skia", "Snell Roundhand", "STHeiti",
    "STIXGeneral", "STIXIntegralsD", "STIXIntegralsSm", "STIXNonUnicode",
    "STIXSizeFiveSym", "STIXSizeFourSym", "STIXSizeOneSym", "STIXSizeThreeSym",
    "STIXSizeTwoSym", "STIXVariants", "Sukhumvit Set", "Symbol", "Tahoma",
    "Tamil MN", "Tamil Sangam MN", "Telugu MN", "Telugu Sangam MN", "Thonburi",
    "Times", "Times New Roman", "Trattatello", "Trebuchet MS", "Verdana",
    "Waseem", "Webdings", "Wingdings", "Wingdings 2", "Wingdings 3", "Zapfino",
    ".AppleSystemUIFont", "-apple-system", "BlinkMacSystemFont", "system-ui",
    "sans-serif", "serif", "monospace", "cursive", "fantasy",
];

function parseArgs(argv) {
    const out = { id: null, chromePort: null };
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === "--id") out.id = argv[++i];
        if (argv[i] === "--chrome-port") out.chromePort = Number(argv[++i]);
    }
    return out;
}

function chromeVersion() {
    try {
        const out = execFileSync(
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            ["--version"],
            { encoding: "utf8" },
        ).trim();
        const m = out.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)/);
        if (!m) throw new Error(out);
        return {
            major: Number(m[1]),
            full: `${m[1]}.${m[2]}.${m[3]}.${m[4]}`,
            short: `${m[1]}.0.0.0`,
        };
    } catch (e) {
        throw new Error(`Google Chrome not found: ${e.message}`);
    }
}

function readChromePrefs() {
    const out = { languages: ["en-US", "en"], colorScheme: "light" };
    if (!existsSync(CHROME_PREFS)) return out;
    try {
        const prefs = JSON.parse(readFileSync(CHROME_PREFS, "utf8"));
        if (prefs.intl?.accept_languages) {
            out.languages = prefs.intl.accept_languages.split(",").map((s) => s.trim());
        }
        const theme = prefs.browser?.theme?.color_scheme;
        if (theme === 1) out.colorScheme = "dark";
        if (theme === 0) out.colorScheme = "light";
    } catch {}
    return out;
}

function deviceMemoryGiB() {
    const bytes = Number(execFileSync("sysctl", ["-n", "hw.memsize"], { encoding: "utf8" }).trim());
    const gb = bytes / (1024 ** 3);
    let step = 0.25;
    let picked = step;
    while (step <= gb) {
        picked = step;
        step *= 2;
    }
    return picked;
}

function macOSPlatformVersion() {
    try {
        const ver = execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim();
        const parts = ver.split(".");
        while (parts.length < 3) parts.push("0");
        return parts.slice(0, 3).join(".");
    } catch {
        return "";
    }
}

function screenInfo() {
    // Primary display via system_profiler (matches user's 1920x1080 setup).
    try {
        const out = execFileSync("system_profiler", ["SPDisplaysDataType"], { encoding: "utf8" });
        const res = out.match(/Resolution:\s*(\d+)\s*x\s*(\d+)/);
        if (res) {
            const w = Number(res[1]);
            const h = Number(res[2]);
            return { width: w, height: h, availHeight: h - 31 };
        }
    } catch {}
    return { width: 1920, height: 1080, availHeight: 1049 };
}

async function captureFingerprint({ fontList, measureFamilies, measureTexts }) {
    const r = (fn, fb = null) => { try { return fn(); } catch (e) { return fb ?? String(e); } };

    const uad = navigator.userAgentData;
        const he = uad ? await uad.getHighEntropyValues([
            "architecture", "bitness", "model", "platformVersion", "uaFullVersion", "fullVersionList",
        ]) : {};

        const gl = r(() => {
            const c = document.createElement("canvas");
            const g = c.getContext("webgl");
            if (!g) return null;
            const dbg = g.getExtension("WEBGL_debug_renderer_info");
            const p = (x) => g.getParameter(x);
            return {
                version: p(g.VERSION),
                vendor: p(g.VENDOR),
                renderer: p(g.RENDERER),
                shadingLanguageVersion: p(g.SHADING_LANGUAGE_VERSION),
                unmaskedVendor: dbg ? p(dbg.UNMASKED_VENDOR_WEBGL) : p(g.VENDOR),
                unmaskedRenderer: dbg ? p(dbg.UNMASKED_RENDERER_WEBGL) : p(g.RENDERER),
                maxTextureSize: p(g.MAX_TEXTURE_SIZE),
                maxCubeMapTextureSize: p(g.MAX_CUBE_MAP_TEXTURE_SIZE),
                maxRenderbufferSize: p(g.MAX_RENDERBUFFER_SIZE),
                maxVertexAttribs: p(g.MAX_VERTEX_ATTRIBS),
                maxVertexUniformVectors: p(g.MAX_VERTEX_UNIFORM_VECTORS),
                maxVaryingVectors: p(g.MAX_VARYING_VECTORS),
                maxCombinedTextureImageUnits: p(g.MAX_COMBINED_TEXTURE_IMAGE_UNITS),
                maxVertexTextureImageUnits: p(g.MAX_VERTEX_TEXTURE_IMAGE_UNITS),
                maxTextureImageUnits: p(g.MAX_TEXTURE_IMAGE_UNITS),
                maxFragmentUniformVectors: p(g.MAX_FRAGMENT_UNIFORM_VECTORS),
                maxDrawBuffers: p(g.MAX_DRAW_BUFFERS),
                maxTextureMaxAnisotropy: g.getExtension("EXT_texture_filter_anisotropic")
                    ? p(g.getExtension("EXT_texture_filter_anisotropic").MAX_TEXTURE_MAX_ANISOTROPY_EXT) : 16,
                maxViewportDims: Array.from(p(g.MAX_VIEWPORT_DIMS)),
                aliasedLineWidthRange: Array.from(p(g.ALIASED_LINE_WIDTH_RANGE)),
                aliasedPointSizeRange: Array.from(p(g.ALIASED_POINT_SIZE_RANGE)),
                extensions: g.getSupportedExtensions() || [],
            };
        });

        const canvas240 = r(() => {
            const c = document.createElement("canvas");
            c.width = 240; c.height = 60;
            const ctx = c.getContext("2d");
            ctx.textBaseline = "top";
            ctx.font = "14px Arial";
            ctx.fillStyle = "#f60";
            ctx.fillRect(0, 0, 120, 20);
            ctx.fillStyle = "#069";
            ctx.fillText("velora", 2, 2);
            return c.toDataURL();
        });

        const canvas50text = r(() => {
            const c = document.createElement("canvas");
            c.width = 50; c.height = 50;
            const ctx = c.getContext("2d");
            ctx.textBaseline = "top";
            ctx.font = "14px Arial";
            ctx.fillText("velora", 2, 2);
            return c.toDataURL();
        });

        const canvas50emoji = r(() => {
            const c = document.createElement("canvas");
            c.width = 50; c.height = 50;
            const ctx = c.getContext("2d");
            ctx.textBaseline = "top";
            ctx.font = "14px Arial";
            ctx.fillText("😀", 2, 2);
            return c.toDataURL();
        });

        const canvas2 = r(() => {
            const c = document.createElement("canvas");
            c.width = 2; c.height = 2;
            const ctx = c.getContext("2d");
            ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, 1, 1);
            ctx.fillStyle = "#808080"; ctx.fillRect(1, 0, 1, 1);
            ctx.fillStyle = "#bfbfbf"; ctx.fillRect(0, 1, 1, 1);
            ctx.fillStyle = "#404040"; ctx.fillRect(1, 1, 1, 1);
            return Array.from(ctx.getImageData(0, 0, 2, 2).data);
        });

        const audio = await (async () => {
            const ctx = new OfflineAudioContext(1, 5000, 44100);
            const analyser = ctx.createAnalyser();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            const comp = ctx.createDynamicsCompressor();
            osc.type = "triangle";
            osc.frequency.value = 10000;
            comp.threshold.value = -50;
            gain.gain.value = 0.5;
            osc.connect(comp); comp.connect(analyser); analyser.connect(gain); gain.connect(ctx.destination);
            osc.start(0);
            const buffer = await ctx.startRendering();
            const data = buffer.getChannelData(0);
            const freq = new Float32Array(analyser.frequencyBinCount);
            analyser.getFloatFrequencyData(freq);
            return { samples: Array.from(data), freq: Array.from(freq) };
        })();

    const measureText = [];
    for (const family of measureFamilies) {
        for (const text of measureTexts) {
                const c = document.createElement("canvas");
                const ctx = c.getContext("2d");
                ctx.font = '14px "' + family + '"';
                const m = ctx.measureText(text);
            measureText.push({
                family,
                text,
                width: m.width,
                actualBoundingBoxLeft: m.actualBoundingBoxLeft || 0,
                actualBoundingBoxRight: m.actualBoundingBoxRight || 0,
                actualBoundingBoxAscent: m.actualBoundingBoxAscent || 0,
                actualBoundingBoxDescent: m.actualBoundingBoxDescent || 0,
                fontBoundingBoxAscent: m.fontBoundingBoxAscent || 0,
                fontBoundingBoxDescent: m.fontBoundingBoxDescent || 0,
            });
        }
    }

    const availableFonts = [];
    const probe = document.createElement("span");
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    probe.style.fontSize = "72px";
    probe.textContent = "mmmmmmmmmmlli";
    document.body.appendChild(probe);
    const baseFonts = ["monospace", "sans-serif", "serif"];
    for (const font of fontList) {
        let detected = false;
        for (const base of baseFonts) {
            probe.style.fontFamily = '"' + font + '",' + base;
            const w = probe.offsetWidth;
            probe.style.fontFamily = base;
            if (w !== probe.offsetWidth) { detected = true; break; }
        }
        if (detected) availableFonts.push(font);
    }
    probe.remove();

    const voices = speechSynthesis.getVoices().map((v) => ({
        name: v.name,
        lang: v.lang,
        localService: v.localService,
        default: v.default,
    }));

    const plugins = [...navigator.plugins].map((p) => ({
        name: p.name,
        filename: p.filename,
        description: p.description,
        mimeType: p[0]?.type || "application/pdf",
        mimeSuffixes: p[0]?.suffixes || "pdf",
    }));

    return {
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        vendor: navigator.vendor,
        languages: [...navigator.languages],
        language: navigator.language,
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: navigator.deviceMemory ?? null,
        maxTouchPoints: navigator.maxTouchPoints,
        pdfViewerEnabled: navigator.pdfViewerEnabled ?? true,
        appVersion: navigator.appVersion,
        brands: uad?.brands || [],
        uaData: {
            platform: uad?.platform || "macOS",
            mobile: uad?.mobile || false,
            architecture: he.architecture || "arm",
            bitness: he.bitness || "64",
            platformVersion: he.platformVersion || "",
            uaFullVersion: he.uaFullVersion || "",
            fullVersionList: he.fullVersionList || [],
        },
        colorScheme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
        screen: {
            width: screen.width,
            height: screen.height,
            availWidth: screen.availWidth,
            availHeight: screen.availHeight,
            devicePixelRatio: devicePixelRatio,
            colorDepth: screen.colorDepth,
            pixelDepth: screen.pixelDepth,
            touch: navigator.maxTouchPoints > 0,
        },
        window: {
            innerWidth: innerWidth,
            innerHeight: innerHeight,
            outerWidth: outerWidth,
            outerHeight: outerHeight,
        },
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        locale: Intl.DateTimeFormat().resolvedOptions().locale,
        webgl: gl,
        plugins,
        voices,
        fonts: availableFonts,
        measureText,
        canvas: {
            canvas_240_velora: canvas240,
            canvas_50_text: canvas50text,
            canvas_50_emoji: canvas50emoji,
            canvas_2_low_entropy: canvas2,
        },
        audio,
    };
}

async function connectBrowser(chromePort) {
    if (chromePort) {
        const browser = await chromium.connectOverCDP(`http://127.0.0.1:${chromePort}`);
        const context = browser.contexts()[0] ?? (await browser.newContext());
        return { browser, context, cleanup: () => browser.close().catch(() => {}) };
    }

    const tmp = mkdtempSync(join(tmpdir(), "velora-chrome-clone-"));
    const context = await chromium.launchPersistentContext(tmp, {
        channel: "chrome",
        headless: false,
        viewport: null,
        args: ["--disable-blink-features=AutomationControlled"],
    });
    return {
        browser: context.browser(),
        context,
        cleanup: () => context.close().catch(() => {}),
    };
}

function inferPersonaId(arch) {
    return arch === "x86" ? "macos_catalina_intel" : "macos_sonoma_intel";
}

function notABrandVersion(brands) {
    for (const b of brands) {
        if (/not.*brand/i.test(b.brand)) return b.version;
    }
    return "24";
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const ver = chromeVersion();
    const prefs = readChromePrefs();
    const screen = screenInfo();
    const mem = deviceMemoryGiB();
    const cpus = Number(execFileSync("sysctl", ["-n", "hw.ncpu"], { encoding: "utf8" }).trim());
    const profileId = args.id ?? `chrome-local-${hostname().split(".")[0].toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

    console.log(`Chrome ${ver.full}`);
    console.log(`Profile id: ${profileId}`);
    console.log(`Languages: ${prefs.languages.join(", ")}`);
    console.log(`Screen: ${screen.width}x${screen.height}`);

    const { context, cleanup } = await connectBrowser(args.chromePort);
    try {
        const page = context.pages()[0] ?? (await context.newPage());
        await page.goto("about:blank");
        await page.waitForTimeout(500);

        const data = await page.evaluate(captureFingerprint, {
            fontList: MAC_FONTS,
            measureFamilies: MEASURE_FAMILIES,
            measureTexts: MEASURE_TEXTS,
        });
        if (!data?.canvas) {
            throw new Error(`Fingerprint capture failed: ${JSON.stringify(data)?.slice(0, 500)}`);
        }

        const assetsDir = join(REPO, "browser/profiles/assets");
        mkdirSync(assetsDir, { recursive: true });
        const prefix = profileId;

        const canvasProbePath = `browser/profiles/assets/${prefix}-canvas-probes.json`;
        writeFileSync(
            join(REPO, canvasProbePath),
            JSON.stringify(data.canvas, null, 2),
        );

        const canvasTxtPath = `browser/profiles/assets/${prefix}-canvas-probe.txt`;
        writeFileSync(join(REPO, canvasTxtPath), data.canvas.canvas_240_velora);

        const audioPath = `browser/profiles/assets/${prefix}-audio-probe.json`;
        writeFileSync(
            join(REPO, audioPath),
            JSON.stringify({ samples: data.audio.samples, freq: data.audio.freq }, null, 0),
        );

        const fontsPath = `browser/profiles/assets/${prefix}-fonts.json`;
        writeFileSync(join(REPO, fontsPath), JSON.stringify(data.fonts, null, 2));

        const voicesPath = `browser/profiles/assets/${prefix}-voices.json`;
        writeFileSync(
            join(REPO, voicesPath),
            JSON.stringify(
                data.voices.map((v) => ({
                    name: v.name,
                    lang: v.lang,
                    localService: v.localService,
                    defaultVoice: v.default,
                })),
                null,
                2,
            ),
        );

        const measurePath = `browser/profiles/assets/${prefix}-measuretext.json`;
        writeFileSync(join(REPO, measurePath), JSON.stringify(data.measureText));

        const uaFull = data.uaData.uaFullVersion || ver.full;
        const chromeBrand = data.brands.find((b) => /chrome/i.test(b.brand) && !/chromium/i.test(b.brand))
            ?? { brand: "Google Chrome", version: String(ver.major) };

        const profile = {
            version: 1,
            id: profileId,
            mode: "antidetect",
            policies: ["google-search"],
            personaId: inferPersonaId(data.uaData.architecture),
            transport: { impersonate: `chrome${ver.major}` },
            navigator: {
                userAgent: data.userAgent,
                platform: data.platform,
                languages: prefs.languages.length ? prefs.languages : data.languages,
                hardwareConcurrency: data.hardwareConcurrency || cpus,
                deviceMemory: data.deviceMemory ?? mem,
                maxTouchPoints: data.maxTouchPoints,
                vendor: data.vendor,
                pdfViewerEnabled: data.pdfViewerEnabled,
                appVersion: data.appVersion,
            },
            userAgentData: {
                brands: data.brands.length ? data.brands : [
                    { brand: "Google Chrome", version: String(ver.major) },
                    { brand: "Chromium", version: String(ver.major) },
                    { brand: "Not)A;Brand", version: notABrandVersion(data.brands) },
                ],
                platform: data.uaData.platform,
                platformVersion: data.uaData.platformVersion || macOSPlatformVersion(),
                architecture: data.uaData.architecture,
                bitness: data.uaData.bitness,
                uaFullVersion: uaFull,
                mobile: data.uaData.mobile,
                prefersColorScheme: data.colorScheme || prefs.colorScheme,
            },
            plugins: data.plugins.map((p) => ({
                name: p.name,
                filename: p.filename,
                description: p.description,
                mimeType: p.mimeType,
                mimeSuffixes: p.mimeSuffixes,
            })),
            screen: {
                width: data.screen.width,
                height: data.screen.height,
                availWidth: data.screen.availWidth,
                availHeight: data.screen.availHeight,
                devicePixelRatio: data.screen.devicePixelRatio,
                colorDepth: data.screen.colorDepth,
                pixelDepth: data.screen.pixelDepth,
                touch: data.screen.touch,
            },
            window: {
                innerWidth: data.window.innerWidth,
                innerHeight: data.window.innerHeight,
                outerWidth: data.window.outerWidth,
                outerHeight: data.window.outerHeight,
            },
            webgl: {
                version: data.webgl?.version ?? "",
                vendor: data.webgl?.vendor ?? "",
                renderer: data.webgl?.renderer ?? "",
                shadingLanguageVersion: data.webgl?.shadingLanguageVersion ?? "",
                unmaskedVendor: data.webgl?.unmaskedVendor ?? "",
                unmaskedRenderer: data.webgl?.unmaskedRenderer ?? "",
                maxTextureSize: data.webgl?.maxTextureSize ?? 16384,
                maxCubeMapTextureSize: data.webgl?.maxCubeMapTextureSize ?? 16384,
                maxRenderbufferSize: data.webgl?.maxRenderbufferSize ?? 16384,
                maxVertexAttribs: data.webgl?.maxVertexAttribs ?? 16,
                maxVertexUniformVectors: data.webgl?.maxVertexUniformVectors ?? 4096,
                maxVaryingVectors: data.webgl?.maxVaryingVectors ?? 31,
                maxCombinedTextureImageUnits: data.webgl?.maxCombinedTextureImageUnits ?? 32,
                maxVertexTextureImageUnits: data.webgl?.maxVertexTextureImageUnits ?? 16,
                maxTextureImageUnits: data.webgl?.maxTextureImageUnits ?? 16,
                maxFragmentUniformVectors: data.webgl?.maxFragmentUniformVectors ?? 1024,
                maxDrawBuffers: data.webgl?.maxDrawBuffers ?? 8,
                maxTextureMaxAnisotropy: data.webgl?.maxTextureMaxAnisotropy ?? 16,
                maxViewportDims: data.webgl?.maxViewportDims ?? [16384, 16384],
                aliasedLineWidthRange: data.webgl?.aliasedLineWidthRange ?? [1, 1],
                aliasedPointSizeRange: data.webgl?.aliasedPointSizeRange ?? [1, 1024],
                extensions: data.webgl?.extensions ?? [],
            },
            timezone: data.timezone,
            locale: data.locale?.split("@")[0] || prefs.languages[0] || "en-US",
            canvasProbe: {
                dataUrlFile: canvasTxtPath,
                probesFile: canvasProbePath,
            },
            audioProbe: { dataFile: audioPath },
            fontsFile: fontsPath,
            speechVoicesFile: voicesPath,
            measureTextBaseline: { dataFile: measurePath },
        };

        const profilePath = join(REPO, `browser/profiles/${profileId}.json`);
        writeFileSync(profilePath, JSON.stringify(profile, null, 2) + "\n");

        console.log(`\nWrote profile: browser/profiles/${profileId}.json`);
        console.log(`Assets prefix: browser/profiles/assets/${prefix}-*`);
        console.log(`\nUse with Velora:`);
        console.log(`  zig-out/bin/velora serve --browser-profile ${profileId}`);
    } finally {
        await cleanup();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});