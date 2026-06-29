#!/usr/bin/env node
/**
 * Clone Kameleo Chroma profile → Velora antidetect profile (CDP probe on real Chroma).
 *
 * Usage:
 *   node scripts/clone-chroma-profile.mjs
 *   node scripts/clone-chroma-profile.mjs --kameleo-profile profile_01
 *   node scripts/clone-chroma-profile.mjs --id chroma-profile-01 --chroma-endpoint http://127.0.0.1:9300
 */
import { chromium } from "playwright";
import { createServer as createNetServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnChroma } from "./lib/chroma-cdp.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const KAMELEO = resolve(REPO, "Kameleo-decode/profiles_standard");

const MEASURE_FAMILIES = [
    "-apple-system", ".AppleSystemUIFont", "Arial", "Helvetica",
    "Times New Roman", "Courier New", "Georgia", "Menlo", "Monaco", "Verdana",
];
const MEASURE_TEXTS = ["", "velora", "😀", "mmmmmmmmmmlli", "Cwm fjordbank glyphs vext quiz", "👾"];

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function getFreePort() {
    return new Promise((res, rej) => {
        const s = createNetServer();
        s.unref();
        s.on("error", rej);
        s.listen(0, "127.0.0.1", () => {
            const { port } = s.address();
            s.close(() => res(port));
        });
    });
}

function parseArgs(argv) {
    const out = {
        id: "chroma-profile-01",
        kameleoProfile: "profile_01",
        chromaEndpoint: process.env.CHROMA_CDP || null,
        spawn: true,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === "--id") out.id = argv[++i];
        else if (a === "--kameleo-profile") out.kameleoProfile = argv[++i];
        else if (a === "--chroma-endpoint") { out.chromaEndpoint = argv[++i]; out.spawn = false; }
        else if (a === "--no-spawn") out.spawn = false;
    }
    return out;
}

function loadKameleoProfile(name) {
    const dir = join(KAMELEO, name);
    const optsPath = join(dir, "opts.decoded.json");
    const profilePath = join(dir, "profile.json");
    if (!existsSync(optsPath)) throw new Error(`missing ${optsPath}`);
    const opts = JSON.parse(readFileSync(optsPath, "utf8"));
    const profile = existsSync(profilePath) ? JSON.parse(readFileSync(profilePath, "utf8")) : null;
    return { dir, opts, profile };
}

// Same capture routine as clone-chrome-profile.mjs — must run inside Chroma page.
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
            version: p(g.VERSION), vendor: p(g.VENDOR), renderer: p(g.RENDERER),
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

    const mkCanvas = (w, h, draw) => r(() => {
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        draw(c.getContext("2d"));
        return c.toDataURL();
    });

    const canvas240 = mkCanvas(240, 60, (ctx) => {
        ctx.textBaseline = "top"; ctx.font = "14px Arial";
        ctx.fillStyle = "#f60"; ctx.fillRect(0, 0, 120, 20);
        ctx.fillStyle = "#069"; ctx.fillText("velora", 2, 2);
    });
    const canvas50text = mkCanvas(50, 50, (ctx) => {
        ctx.textBaseline = "top"; ctx.font = "14px Arial"; ctx.fillText("velora", 2, 2);
    });
    const canvas50emoji = mkCanvas(50, 50, (ctx) => {
        ctx.textBaseline = "top"; ctx.font = "14px Arial"; ctx.fillText("😀", 2, 2);
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
        osc.type = "triangle"; osc.frequency.value = 10000;
        comp.threshold.value = -50; gain.gain.value = 0.5;
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
                family, text, width: m.width,
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
    probe.style.cssText = "position:absolute;visibility:hidden;font-size:72px";
    probe.textContent = "mmmmmmmmmmlli";
    document.body.appendChild(probe);
    for (const font of fontList) {
        let detected = false;
        for (const base of ["monospace", "sans-serif", "serif"]) {
            probe.style.fontFamily = '"' + font + '",' + base;
            const w = probe.offsetWidth;
            probe.style.fontFamily = base;
            if (w !== probe.offsetWidth) { detected = true; break; }
        }
        if (detected) availableFonts.push(font);
    }
    probe.remove();

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
        brands: navigator.userAgentData?.brands || [],
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
            width: screen.width, height: screen.height,
            availWidth: screen.availWidth, availHeight: screen.availHeight,
            devicePixelRatio: devicePixelRatio,
            colorDepth: screen.colorDepth, pixelDepth: screen.pixelDepth,
            touch: navigator.maxTouchPoints > 0,
        },
        window: {
            innerWidth: innerWidth, innerHeight: innerHeight,
            outerWidth: outerWidth, outerHeight: outerHeight,
        },
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        locale: Intl.DateTimeFormat().resolvedOptions().locale,
        webgl: gl,
        plugins: [...navigator.plugins].map((p) => ({
            name: p.name, filename: p.filename, description: p.description,
            mimeType: p[0]?.type || "application/pdf", mimeSuffixes: p[0]?.suffixes || "pdf",
        })),
        voices: speechSynthesis.getVoices().map((v) => ({
            name: v.name, lang: v.lang, localService: v.localService, default: v.default,
        })),
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

function buildVeloraProfile(profileId, kameleo, live) {
    const { opts, profile } = kameleo;
    const fp = profile?.Fingerprint;
    const uaMeta = opts.userAgent?.metadata ?? {};
    const langs = (opts.languages || "en-US,en").split(",").map((s) => s.trim());
    const major = fp?.Browser?.Major ?? Number((opts.userAgent?.full || "").match(/Chrome\/(\d+)/)?.[1] || 149);

    const screen = {
        width: live.screen.width ?? opts.screen?.width ?? 1440,
        height: live.screen.height ?? opts.screen?.height ?? 900,
        availWidth: live.screen.availWidth ?? opts.screen?.availWidth ?? 1440,
        availHeight: live.screen.availHeight ?? opts.screen?.availHeight ?? 869,
        devicePixelRatio: live.screen.devicePixelRatio ?? 1,
        colorDepth: live.screen.colorDepth ?? opts.screen?.colorDepth ?? 30,
        pixelDepth: live.screen.pixelDepth ?? opts.screen?.colorDepth ?? 30,
        touch: live.screen.touch ?? false,
    };

    return {
        version: 1,
        id: profileId,
        mode: "antidetect",
        policies: ["google-search"],
        personaId: (uaMeta.architecture || live.uaData.architecture) === "x86" ? "macos_catalina_intel" : "macos_sonoma_intel",
        transport: { impersonate: `chrome${major}` },
        navigator: {
            userAgent: opts.userAgent?.reduced || live.userAgent,
            platform: opts.platform || live.platform,
            languages: langs,
            hardwareConcurrency: opts.hardwareConcurrency ?? live.hardwareConcurrency,
            deviceMemory: opts.deviceMemory ?? live.deviceMemory,
            maxTouchPoints: opts.maxTouchPoints ?? live.maxTouchPoints,
            vendor: live.vendor,
            pdfViewerEnabled: live.pdfViewerEnabled,
            appVersion: live.appVersion,
        },
        userAgentData: {
            brands: uaMeta.brandVersionList || live.brands,
            platform: uaMeta.platform || live.uaData.platform,
            platformVersion: uaMeta.platformVersion || live.uaData.platformVersion,
            architecture: uaMeta.architecture || live.uaData.architecture,
            bitness: uaMeta.bitness || live.uaData.bitness,
            uaFullVersion: uaMeta.fullVersion || live.uaData.uaFullVersion || fp?.Browser?.Version,
            mobile: uaMeta.mobile ?? live.uaData.mobile,
            prefersColorScheme: live.colorScheme,
        },
        plugins: live.plugins,
        screen,
        window: live.window,
        webgl: {
            version: live.webgl?.version ?? "",
            vendor: live.webgl?.vendor ?? "",
            renderer: live.webgl?.renderer ?? "",
            shadingLanguageVersion: live.webgl?.shadingLanguageVersion ?? "",
            unmaskedVendor: live.webgl?.unmaskedVendor ?? opts.webgl?.["37445"] ?? "",
            unmaskedRenderer: live.webgl?.unmaskedRenderer ?? opts.webgl?.["37446"] ?? "",
            maxTextureSize: live.webgl?.maxTextureSize ?? 16384,
            maxCubeMapTextureSize: live.webgl?.maxCubeMapTextureSize ?? 16384,
            maxRenderbufferSize: live.webgl?.maxRenderbufferSize ?? 16384,
            maxVertexAttribs: live.webgl?.maxVertexAttribs ?? 16,
            maxVertexUniformVectors: live.webgl?.maxVertexUniformVectors ?? 1024,
            maxVaryingVectors: live.webgl?.maxVaryingVectors ?? 30,
            maxCombinedTextureImageUnits: live.webgl?.maxCombinedTextureImageUnits ?? 32,
            maxVertexTextureImageUnits: live.webgl?.maxVertexTextureImageUnits ?? 16,
            maxTextureImageUnits: live.webgl?.maxTextureImageUnits ?? 16,
            maxFragmentUniformVectors: live.webgl?.maxFragmentUniformVectors ?? 1024,
            maxDrawBuffers: live.webgl?.maxDrawBuffers ?? 8,
            maxTextureMaxAnisotropy: live.webgl?.maxTextureMaxAnisotropy ?? 16,
            maxViewportDims: live.webgl?.maxViewportDims ?? [16384, 16384],
            aliasedLineWidthRange: live.webgl?.aliasedLineWidthRange ?? [1, 1],
            aliasedPointSizeRange: live.webgl?.aliasedPointSizeRange ?? [1, 511],
            extensions: live.webgl?.extensions ?? [],
        },
        timezone: opts.timezone || live.timezone,
        locale: opts.language || live.locale?.split("@")[0] || langs[0],
        canvasProbe: {
            dataUrlFile: `browser/profiles/assets/${profileId}-canvas-probe.txt`,
            probesFile: `browser/profiles/assets/${profileId}-canvas-probes.json`,
        },
        audioProbe: { dataFile: `browser/profiles/assets/${profileId}-audio-probe.json` },
        fontsFile: `browser/profiles/assets/${profileId}-fonts.json`,
        speechVoicesFile: `browser/profiles/assets/${profileId}-voices.json`,
        measureTextBaseline: { dataFile: `browser/profiles/assets/${profileId}-measuretext.json` },
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const kameleo = loadKameleoProfile(args.kameleoProfile);
    const fontList = kameleo.opts.fonts || kameleo.profile?.Fingerprint?.Fonts || [];

    console.log(`Kameleo profile: ${args.kameleoProfile}`);
    console.log(`Velora profile id: ${args.id}`);
    console.log(`Fonts to probe: ${fontList.length}`);

    let cleanup = async () => undefined;
    let endpoint = args.chromaEndpoint;
    if (args.spawn) {
        const port = await getFreePort();
        const hubPort = await getFreePort();
        const launched = await spawnChroma({ profile: args.kameleoProfile, cdpPort: port, hubPort });
        cleanup = launched.cleanup;
        endpoint = launched.endpoint;
        console.log(`Chroma CDP: ${endpoint}`);
    } else {
        console.log(`Chroma CDP: ${endpoint} (attach)`);
    }

    try {
        const browser = await chromium.connectOverCDP(endpoint);
        const context = browser.contexts()[0] ?? await browser.newContext();
        const page = await context.newPage();
        await page.goto("about:blank");
        await delay(800);

        const live = await page.evaluate(captureFingerprint, {
            fontList,
            measureFamilies: MEASURE_FAMILIES,
            measureTexts: MEASURE_TEXTS,
        });
        await browser.close().catch(() => undefined);

        if (!live?.canvas) throw new Error(`capture failed: ${JSON.stringify(live)?.slice(0, 300)}`);

        const profile = buildVeloraProfile(args.id, kameleo, live);
        const assetsDir = join(REPO, "browser/profiles/assets");
        mkdirSync(assetsDir, { recursive: true });

        writeFileSync(join(REPO, profile.canvasProbe.probesFile), JSON.stringify(live.canvas, null, 2));
        writeFileSync(join(REPO, profile.canvasProbe.dataUrlFile), live.canvas.canvas_240_velora);
        writeFileSync(join(REPO, profile.audioProbe.dataFile), JSON.stringify({
            samples: live.audio.samples, freq: live.audio.freq,
        }));
        writeFileSync(join(REPO, profile.fontsFile), JSON.stringify(live.fonts, null, 2));
        writeFileSync(join(REPO, profile.speechVoicesFile), JSON.stringify(
            live.voices.map((v) => ({
                name: v.name, lang: v.lang, localService: v.localService, defaultVoice: v.default,
            })), null, 2,
        ));
        writeFileSync(join(REPO, profile.measureTextBaseline.dataFile), JSON.stringify(live.measureText));

        const profilePath = join(REPO, `browser/profiles/${args.id}.json`);
        writeFileSync(profilePath, JSON.stringify(profile, null, 2) + "\n");

        console.log("\n── Captured from Chroma ──");
        console.log(`  screen: ${live.screen.width}x${live.screen.height} cd=${live.screen.colorDepth}`);
        console.log(`  window: inner=${live.window.innerWidth}x${live.window.innerHeight} outer=${live.window.outerWidth}x${live.window.outerHeight}`);
        console.log(`  deviceMemory: ${live.deviceMemory}  hw: ${live.hardwareConcurrency}`);
        console.log(`  languages: ${live.languages.join(", ")}`);
        console.log(`  timezone: ${live.timezone}`);

        console.log(`\nWrote: browser/profiles/${args.id}.json`);
        console.log(`Assets: browser/profiles/assets/${args.id}-*`);
        console.log(`\nUse:`);
        console.log(`  zig-out/bin/velora serve --browser-profile ${args.id}`);
        console.log(`  node scripts/cdp-creepjs-compare.mjs --profile ${args.id}`);
    } finally {
        if (args.spawn) await cleanup();
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});