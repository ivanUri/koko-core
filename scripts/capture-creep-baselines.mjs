#!/usr/bin/env node
/**
 * Capture CreepJS-specific baselines from local Chrome:
 *   - measureText (10px CSS_FONT_FAMILY + EMOJIS)
 *   - audio (OfflineAudioContext graph without GainNode)
 *   - webgl (readPixels from 256×256 OffscreenCanvas draw probe)
 *
 * Usage:
 *   node scripts/capture-creep-baselines.mjs
 *   node scripts/capture-creep-baselines.mjs --profile chrome-local-huys-macbook-pro
 *   node scripts/capture-creep-baselines.mjs --chrome-port 9222
 */

import { chromium } from "playwright";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

const CREEP_EMOJI_CODES = [
    [128512], [9786], [129333, 8205, 9794, 65039], [9832], [9784], [9895], [8265], [8505],
    [127987, 65039, 8205, 9895, 65039], [129394], [9785], [9760], [129489, 8205, 129456],
    [129487, 8205, 9794, 65039], [9975], [129489, 8205, 129309, 8205, 129489], [9752], [9968],
    [9961], [9972], [9992], [9201], [9928], [9730], [9969], [9731], [9732], [9976], [9823],
    [9937], [9000], [9993], [9999],
    [128105, 8205, 10084, 65039, 8205, 128139, 8205, 128104],
    [128104, 8205, 128105, 8205, 128103, 8205, 128102],
    [128104, 8205, 128105, 8205, 128102],
    [128512], [169], [174], [8482], [128065, 65039, 8205, 128488, 65039],
    [10002], [9986], [9935], [9874], [9876], [9881], [9939], [9879], [9904], [9905], [9888],
    [9762], [9763], [11014], [8599], [10145], [11013], [9883], [10017], [10013], [9766], [9654],
    [9197], [9199], [9167], [9792], [9794], [10006], [12336], [9877], [9884], [10004], [10035],
    [10055], [9724], [9642], [10083], [10084], [9996], [9757], [9997], [10052], [9878], [8618],
    [9775], [9770], [9774], [9745], [10036], [127344], [127359],
];

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
    const tmp = mkdtempSync(join(tmpdir(), "velora-creep-capture-"));
    const context = await chromium.launchPersistentContext(tmp, {
        channel: "chrome",
        headless: false,
        viewport: null,
        args: ["--disable-blink-features=AutomationControlled"],
    });
    return { context, cleanup: () => context.close().catch(() => {}) };
}

async function captureInPage({ creepCssFontFamily, creepEmojiCodes }) {
    const creepEmojis = creepEmojiCodes.map((codes) => String.fromCodePoint(...codes));
    const creepFontStack = creepCssFontFamily.replace(/!important/gi, "").trim();

    const measureText = [];
    {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        ctx.font = `10px ${creepFontStack}`;
        const font = ctx.font;
        for (const text of ["", ...creepEmojis]) {
            const m = ctx.measureText(text);
            measureText.push({
                font,
                family: "creep-css-font",
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

    const audio = await (async () => {
        const bufferLen = 5000;
        const ctx = new OfflineAudioContext(1, bufferLen, 44100);
        const analyser = ctx.createAnalyser();
        const osc = ctx.createOscillator();
        const comp = ctx.createDynamicsCompressor();
        osc.type = "triangle";
        osc.frequency.value = 10000;
        comp.threshold.value = -50;
        comp.knee.value = 40;
        comp.attack.value = 0;
        osc.connect(comp);
        comp.connect(analyser);
        comp.connect(ctx.destination);
        osc.start(0);
        const buffer = await ctx.startRendering();
        const data = buffer.getChannelData(0);
        const freq = new Float32Array(analyser.frequencyBinCount);
        analyser.getFloatFrequencyData(freq);
        const timeDomain = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(timeDomain);
        const tail = [...data].slice(4500, bufferLen);
        const sampleSum = tail.reduce((a, n) => a + Math.abs(n), 0);
        return { samples: Array.from(data), freq: Array.from(freq), timeDomain: Array.from(timeDomain), tailSum: sampleSum };
    })();

    const draw = (gl) => {
        if (!gl) return null;
        gl.clear(gl.COLOR_BUFFER_BIT);
        const vertexPosBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, vertexPosBuffer);
        const vertices = new Float32Array([-0.9, -0.7, 0, 0.8, -0.7, 0, 0, 0.5, 0]);
        gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
        const program = gl.createProgram();
        const vertexShader = gl.createShader(gl.VERTEX_SHADER);
        gl.shaderSource(vertexShader, `
            attribute vec2 attrVertex;
            varying vec2 varyinTexCoordinate;
            uniform vec2 uniformOffset;
            void main(){
                varyinTexCoordinate = attrVertex + uniformOffset;
                gl_Position = vec4(attrVertex, 0, 1);
            }
        `);
        gl.compileShader(vertexShader);
        gl.attachShader(program, vertexShader);
        const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);
        gl.shaderSource(fragmentShader, `
            precision mediump float;
            varying vec2 varyinTexCoordinate;
            void main() {
                gl_FragColor = vec4(varyinTexCoordinate, 1, 1);
            }
        `);
        gl.compileShader(fragmentShader);
        gl.attachShader(program, fragmentShader);
        gl.linkProgram(program);
        gl.useProgram(program);
        const vertexPosAttrib = gl.getAttribLocation(program, "attrVertex");
        const offsetUniform = gl.getUniformLocation(program, "uniformOffset");
        gl.enableVertexAttribArray(vertexPosAttrib);
        gl.vertexAttribPointer(vertexPosAttrib, 3, gl.FLOAT, false, 0, 0);
        gl.uniform2f(offsetUniform, 1, 1);
        gl.drawArrays(gl.LINE_LOOP, 0, 3);
        return gl;
    };

    const getWebGLData = (canvas, contextType) => {
        const gl = canvas.getContext(contextType);
        if (!gl) return null;
        draw(gl);
        const { drawingBufferWidth, drawingBufferHeight } = gl;
        let dataURI = "";
        if (gl.canvas.constructor.name === "OffscreenCanvas") {
            const htmlCanvas = document.createElement("canvas");
            const htmlGl = htmlCanvas.getContext(contextType);
            draw(htmlGl);
            dataURI = htmlCanvas.toDataURL();
        } else {
            dataURI = gl.canvas.toDataURL();
        }
        const width = Math.floor(drawingBufferWidth / 15);
        const height = Math.floor(drawingBufferHeight / 6);
        const pixels = new Uint8Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        return { dataURI, pixels: [...pixels], readWidth: width, readHeight: height, drawingBufferWidth, drawingBufferHeight };
    };

    const canvas = new OffscreenCanvas(256, 256);
    const canvas2 = new OffscreenCanvas(256, 256);
    const webgl = getWebGLData(canvas, "webgl");
    const webgl2 = getWebGLData(canvas2, "webgl2");

    return { measureText, audio, webgl, webgl2 };
}

function mergeMeasureText(existing, creepEntries) {
    const key = (e) => `${e.font || e.family}\0${e.text}`;
    const map = new Map();
    for (const e of existing) map.set(key(e), e);
    for (const e of creepEntries) map.set(key(e), e);
    return [...map.values()];
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const prefix = args.profile;
    const assetsDir = join(REPO, "browser/profiles/assets");
    const measurePath = join(assetsDir, `${prefix}-measuretext.json`);
    const audioPath = join(assetsDir, `${prefix}-audio-probe.json`);
    const webglPath = join(assetsDir, `${prefix}-webgl-probe.json`);
    const windowKeysPath = join(assetsDir, `${prefix}-window-keys.json`);
    const htmlElementKeysPath = join(assetsDir, `${prefix}-html-element-keys.json`);
    const mathsBaselinePath = join(assetsDir, `${prefix}-maths-baseline.json`);

    console.log(`Capturing CreepJS baselines for profile: ${prefix}`);

    const { context, cleanup } = await connectBrowser(args.chromePort);
    try {
        const page = context.pages()[0] ?? (await context.newPage());
        await page.goto("about:blank");
        await page.waitForTimeout(300);

        const data = await page.evaluate(captureInPage, {
            creepCssFontFamily: CREEP_CSS_FONT_FAMILY,
            creepEmojiCodes: CREEP_EMOJI_CODES,
        });

        const existingMeasure = existsSync(measurePath)
            ? JSON.parse(readFileSync(measurePath, "utf8"))
            : [];
        const mergedMeasure = mergeMeasureText(existingMeasure, data.measureText);
        writeFileSync(measurePath, JSON.stringify(mergedMeasure));
        console.log(`measureText: ${data.measureText.length} creep entries → ${mergedMeasure.length} total`);

        writeFileSync(audioPath, JSON.stringify({
            samples: data.audio.samples,
            freq: data.audio.freq,
            timeDomain: data.audio.timeDomain,
            tailSum: data.audio.tailSum,
        }));
        console.log(`audio: tailSum≈${data.audio.tailSum.toFixed(2)} samples=${data.audio.samples.length} timeDomain=${data.audio.timeDomain.length}`);

        const existingWebgl = existsSync(webglPath)
            ? JSON.parse(readFileSync(webglPath, "utf8"))
            : {};
        writeFileSync(webglPath, JSON.stringify({
            ...existingWebgl,
            readWidth: data.webgl.readWidth,
            readHeight: data.webgl.readHeight,
            drawingBufferWidth: data.webgl.drawingBufferWidth,
            drawingBufferHeight: data.webgl.drawingBufferHeight,
            pixels: data.webgl.pixels,
            pixels2: data.webgl2?.pixels ?? [],
            dataURI: data.webgl.dataURI,
            dataURI2: data.webgl2?.dataURI ?? "",
        }));
        console.log(`webgl: pixels=${data.webgl.pixels.length} (${data.webgl.readWidth}×${data.webgl.readHeight})`);
        console.log(`webgl2: pixels2=${data.webgl2?.pixels?.length ?? 0}`);

        await page.goto("https://abrahamjuliot.github.io/creepjs/", { waitUntil: "domcontentloaded", timeout: 15000 });

        const creepData = await page.waitForFunction(() => {
            const fp = window.Fingerprint;
            if (!fp?.maths?.data || !fp?.headless || !fp?.canvasWebgl?.parameters) return null;
            const htmlKeys = [];
            for (const key in document.documentElement) htmlKeys.push(key);
            const filter = (k) => !/_|\d{3,}/.test(k);
            return {
                windowKeys: Object.getOwnPropertyNames(window).filter(filter),
                htmlElementKeys: htmlKeys,
                mathsData: fp.maths.data,
                webglParameters: fp.canvasWebgl.parameters,
                headless: {
                    systemFonts: fp.headless.systemFonts,
                    platformEstimate: fp.headless.platformEstimate,
                },
            };
        }, { timeout: 20000 }).then((h) => h.jsonValue());

        const webglMerged = existsSync(webglPath)
            ? JSON.parse(readFileSync(webglPath, "utf8"))
            : {};
        webglMerged.parameters = creepData.webglParameters;
        writeFileSync(webglPath, JSON.stringify(webglMerged));
        console.log(`webgl parameters: ${Object.keys(creepData.webglParameters).length}`);

        writeFileSync(windowKeysPath, JSON.stringify(creepData.windowKeys));
        console.log(`windowKeys: ${creepData.windowKeys.length}`);

        writeFileSync(htmlElementKeysPath, JSON.stringify(creepData.htmlElementKeys));
        console.log(`htmlElementKeys: ${creepData.htmlElementKeys.length}`);

        const creepJs = readFileSync(join(REPO, "code-check/sites/creep/creep.js"), "utf8");
        const fnsStart = creepJs.indexOf("const fns = [");
        const fnsEnd = creepJs.indexOf("];\n            const data = {};", fnsStart);
        const fnsSource = creepJs.slice(fnsStart + "const fns = ".length, fnsEnd + 1);
        const creepMathFns = new Function("Math", "n", "bigN", `return ${fnsSource}`)(
            Math,
            0.123,
            5.860847362277284e+38,
        );

        const mathsCases = [];
        for (const row of creepMathFns) {
            const [method, args, expr] = row;
            if (method === "polyfill") continue;
            const entry = creepData.mathsData[expr];
            if (!entry || typeof entry.result === "undefined") continue;
            mathsCases.push({ method, args, result: entry.result });
        }
        writeFileSync(mathsBaselinePath, JSON.stringify(mathsCases));
        console.log(`maths: ${mathsCases.length} cases, headless systemFonts=${creepData.headless.systemFonts}`);
    } finally {
        await cleanup();
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});