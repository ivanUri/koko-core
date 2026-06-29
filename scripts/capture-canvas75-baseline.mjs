#!/usr/bin/env node
/**
 * Capture CreepJS canvas 75×75 baselines from local Chrome.
 */
import { chromium } from "playwright";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");

const CREEP_CSS_FONT_FAMILY = `
	'Segoe Fluent Icons',
	'Ink Free',
	'Bahnschrift',
	'Segoe MDL2 Assets',
	'HoloLens MDL2 Assets',
	'Leelawadee UI',
	'Javanese Text',
	'Segoe UI Emoji',
	'Aldhabi',
	'Gadugi',
	'Myanmar Text',
	'Nirmala UI',
	'Lucida Console',
	'Cambria Math',
	'Bai Jamjuree',
	'Chakra Petch',
	'Charmonman',
	'Fahkwang',
	'K2D',
	'Kodchasan',
	'KoHo',
	'Sarabun',
	'Srisakdi',
	'Galvji',
	'MuktaMahee Regular',
	'InaiMathi Bold',
	'American Typewriter Semibold',
	'Futura Bold',
	'SignPainter-HouseScript Semibold',
	'PingFang HK Light',
	'Kohinoor Devanagari Medium',
	'Luminari',
	'Geneva',
	'Helvetica Neue',
	'Droid Sans Mono',
	'Dancing Script',
	'Roboto',
	'Ubuntu',
	'Liberation Mono',
	'Source Code Pro',
	'DejaVu Sans',
	'OpenSymbol',
	'Chilanka',
	'Cousine',
	'Arimo',
	'Jomolhari',
	'MONO',
	'Noto Color Emoji',
	sans-serif !important
`;

function parseArgs(argv) {
    const out = { profile: "chrome-local-huys-macbook-pro", chromePort: null };
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === "--profile") out.profile = argv[++i];
        else if (argv[i] === "--chrome-port") out.chromePort = Number(argv[++i]);
    }
    return out;
}

async function connectBrowser(chromePort) {
    if (chromePort) {
        const browser = await chromium.connectOverCDP(`http://127.0.0.1:${chromePort}`);
        const context = browser.contexts()[0] ?? (await browser.newContext());
        return { context, cleanup: () => browser.close().catch(() => {}) };
    }
    const tmp = mkdtempSync(join(tmpdir(), "velora-canvas75-"));
    const context = await chromium.launchPersistentContext(tmp, {
        channel: "chrome",
        headless: true,
        viewport: null,
        args: ["--disable-blink-features=AutomationControlled"],
    });
    return { context, cleanup: () => context.close().catch(() => {}) };
}

async function captureInPage(cssFontFamily) {
    const IS_WEBKIT = false;
    const paintCanvas = ({
        canvas,
        context,
        strokeText = false,
        cssFontFamily: fontFamily = "",
        area = { width: 50, height: 50 },
        rounds = 10,
        maxShadowBlur = 50,
        seed = 500,
        offset = 2001000001,
        multiplier = 15000,
    }) => {
        if (!context) return;
        context.clearRect(0, 0, canvas.width, canvas.height);
        canvas.width = area.width;
        canvas.height = area.height;
        const createPicassoSeed = ({ seed: s, offset: o, multiplier: m }) => {
            let current = Number(s) % Number(o);
            const getNextSeed = () => {
                current = (Number(m) * current) % Number(o);
                return current;
            };
            return { getNextSeed };
        };
        const picassoSeed = createPicassoSeed({ seed, offset, multiplier });
        const { getNextSeed } = picassoSeed;
        const patchSeed = (current, off, maxBound, computeFloat) => {
            const result = (((current - 1) / off) * (maxBound || 1)) || 0;
            return computeFloat ? result : Math.floor(result);
        };
        const addRandomCanvasGradient = (ctx, off, ar, colors, next) => {
            const { width, height } = ar;
            const g = ctx.createRadialGradient(
                patchSeed(next(), off, width),
                patchSeed(next(), off, height),
                patchSeed(next(), off, width),
                patchSeed(next(), off, width),
                patchSeed(next(), off, height),
                patchSeed(next(), off, width),
            );
            g.addColorStop(0, colors[patchSeed(next(), off, colors.length)]);
            g.addColorStop(1, colors[patchSeed(next(), off, colors.length)]);
            ctx.fillStyle = g;
        };
        const colors = [
            "#FF6633", "#FFB399", "#FF33FF", "#FFFF99", "#00B3E6",
            "#E6B333", "#3366E6", "#999966", "#99FF99", "#B34D4D",
            "#80B300", "#809900", "#E6B3B3", "#6680B3", "#66991A",
            "#FF99E6", "#CCFF1A", "#FF1A66", "#E6331A", "#33FFCC",
            "#66994D", "#B366CC", "#4D8000", "#B33300", "#CC80CC",
            "#66664D", "#991AFF", "#E666FF", "#4DB3FF", "#1AB399",
            "#E666B3", "#33991A", "#CC9999", "#B3B31A", "#00E680",
            "#4D8066", "#809980", "#E6FF80", "#1AFF33", "#999933",
            "#FF3380", "#CCCC00", "#66E64D", "#4D80CC", "#9900B3",
            "#E64D66", "#4DB380", "#FF4D4D", "#99E6E6", "#6666FF",
        ];
        const drawOutlineOfText = (ctx, off, ar, next) => {
            const { width, height } = ar;
            const fontSize = 2.99;
            ctx.font = `${height / fontSize}px ${fontFamily.replace(/!important/gm, "")}`;
            ctx.strokeText(
                "👾A",
                patchSeed(next(), off, width),
                patchSeed(next(), off, height),
                patchSeed(next(), off, width),
            );
        };
        const createCircularArc = (ctx, off, ar, next) => {
            const { width, height } = ar;
            ctx.beginPath();
            ctx.arc(
                patchSeed(next(), off, width),
                patchSeed(next(), off, height),
                patchSeed(next(), off, Math.min(width, height)),
                patchSeed(next(), off, 2 * Math.PI, true),
                patchSeed(next(), off, 2 * Math.PI, true),
            );
            ctx.stroke();
        };
        const createBezierCurve = (ctx, off, ar, next) => {
            const { width, height } = ar;
            ctx.beginPath();
            ctx.moveTo(patchSeed(next(), off, width), patchSeed(next(), off, height));
            ctx.bezierCurveTo(
                patchSeed(next(), off, width),
                patchSeed(next(), off, height),
                patchSeed(next(), off, width),
                patchSeed(next(), off, height),
                patchSeed(next(), off, width),
                patchSeed(next(), off, height),
            );
            ctx.stroke();
        };
        const createQuadraticCurve = (ctx, off, ar, next) => {
            const { width, height } = ar;
            ctx.beginPath();
            ctx.moveTo(patchSeed(next(), off, width), patchSeed(next(), off, height));
            ctx.quadraticCurveTo(
                patchSeed(next(), off, width),
                patchSeed(next(), off, height),
                patchSeed(next(), off, width),
                patchSeed(next(), off, height),
            );
            ctx.stroke();
        };
        const createEllipticalArc = (ctx, off, ar, next) => {
            if (!("ellipse" in ctx)) return;
            const { width, height } = ar;
            ctx.beginPath();
            ctx.ellipse(
                patchSeed(next(), off, width),
                patchSeed(next(), off, height),
                patchSeed(next(), off, Math.floor(width / 2)),
                patchSeed(next(), off, Math.floor(height / 2)),
                patchSeed(next(), off, 2 * Math.PI, true),
                patchSeed(next(), off, 2 * Math.PI, true),
                patchSeed(next(), off, 2 * Math.PI, true),
            );
            ctx.stroke();
        };
        const methods = [createCircularArc, createBezierCurve, createQuadraticCurve];
        if (!IS_WEBKIT) methods.push(createEllipticalArc);
        if (strokeText) methods.push(drawOutlineOfText);
        [...Array(rounds)].forEach(() => {
            addRandomCanvasGradient(context, offset, area, colors, getNextSeed);
            context.shadowBlur = patchSeed(getNextSeed(), offset, maxShadowBlur, true);
            context.shadowColor = colors[patchSeed(getNextSeed(), offset, colors.length)];
            methods[patchSeed(getNextSeed(), offset, methods.length)](context, offset, area, getNextSeed);
            context.fill();
        });
    };

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    const canvasCPU = document.createElement("canvas");
    const contextCPU = canvasCPU.getContext("2d", { desynchronized: true, willReadFrequently: true });

    const imageSizeMax = 75;
    paintCanvas({
        canvas,
        context,
        strokeText: true,
        cssFontFamily,
        area: { width: imageSizeMax, height: imageSizeMax },
        rounds: 10,
    });
    const canvas_75_data = canvas.toDataURL();

    paintCanvas({
        canvas,
        context,
        cssFontFamily,
        area: { width: imageSizeMax, height: imageSizeMax },
        rounds: 10,
    });
    const canvas_75_paint = canvas.toDataURL();

    paintCanvas({
        canvas: canvasCPU,
        context: contextCPU,
        cssFontFamily,
        area: { width: imageSizeMax, height: imageSizeMax },
        rounds: 10,
    });
    const canvas_75_paint_cpu = canvasCPU.toDataURL();

    const cLow = document.createElement("canvas");
    cLow.width = 2;
    cLow.height = 2;
    const ctxLow = cLow.getContext("2d");
    ctxLow.fillStyle = "#000";
    ctxLow.fillRect(0, 0, cLow.width, cLow.height);
    ctxLow.fillStyle = "#fff";
    ctxLow.fillRect(2, 2, 1, 1);
    ctxLow.beginPath();
    ctxLow.arc(0, 0, 2, 0, 1, true);
    ctxLow.closePath();
    ctxLow.fill();
    const canvas_2_low_entropy = Array.from(ctxLow.getImageData(0, 0, 2, 2).data);

    const fontStack = cssFontFamily.replace(/!important/gi, "").trim();

    const cText = document.createElement("canvas");
    cText.width = 50;
    cText.height = 50;
    const ctxText = cText.getContext("2d");
    ctxText.font = `50px ${fontStack}`;
    ctxText.fillText("A", 7, 37);
    const canvas_50_text = cText.toDataURL();

    const cEmoji = document.createElement("canvas");
    cEmoji.width = 50;
    cEmoji.height = 50;
    const ctxEmoji = cEmoji.getContext("2d");
    ctxEmoji.font = `35px ${fontStack}`;
    ctxEmoji.fillText("👾", 0, 37);
    const canvas_50_emoji = cEmoji.toDataURL();

    const fp = window.Fingerprint?.canvas2d;
    const canvas_mods_pixel_image = fp?.mods?.pixelImage ?? "";

    return {
        canvas_75_data,
        canvas_75_paint,
        canvas_75_paint_cpu,
        canvas_2_low_entropy,
        canvas_50_text,
        canvas_50_emoji,
        canvas_mods_pixel_image,
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const probesPath = join(REPO, "browser/profiles/assets", `${args.profile}-canvas-probes.json`);
    const cssFontFamily = CREEP_CSS_FONT_FAMILY;

    console.log(`Capturing canvas 75 baselines for ${args.profile}...`);
    const { context, cleanup } = await connectBrowser(args.chromePort);
    try {
        const page = context.pages()[0] ?? (await context.newPage());
        await page.goto("https://abrahamjuliot.github.io/creepjs/", { waitUntil: "domcontentloaded", timeout: 20000 });
        for (let i = 0; i < 40; i += 1) {
            const ready = await page.evaluate(() => !!window.Fingerprint?.canvas2d?.mods?.pixelImage);
            if (ready) break;
            await page.waitForTimeout(500);
        }
        const creepMods = await page.evaluate(() => window.Fingerprint?.canvas2d?.mods?.pixelImage ?? "");
        await page.goto("about:blank");
        const data = await page.evaluate(captureInPage, cssFontFamily);
        if (creepMods) data.canvas_mods_pixel_image = creepMods;

        const existing = JSON.parse(readFileSync(probesPath, "utf8"));
        const merged = { ...existing, ...data };
        writeFileSync(probesPath, JSON.stringify(merged, null, 2) + "\n");

        console.log(`canvas_75_data: ${data.canvas_75_data.length} chars`);
        console.log(`canvas_75_paint: ${data.canvas_75_paint.length} chars`);
        console.log(`canvas_75_paint_cpu: ${data.canvas_75_paint_cpu.length} chars`);
        console.log(`canvas_2_low_entropy: [${data.canvas_2_low_entropy.join(", ")}]`);
        console.log(`canvas_mods_pixel_image: ${data.canvas_mods_pixel_image?.length ?? 0} chars`);
        console.log(`Updated ${probesPath}`);
    } finally {
        await cleanup();
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});