#!/usr/bin/env node
/** Capture CreepJS svg metrics from Chrome creepjs page (max 20s). */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import os from "node:os";
import WebSocket from "ws";
import { DEFAULT_MAX_SEC } from "./lib/cdp-probe-budget.mjs";

const REPO = resolve(import.meta.dirname, "..");
const CREEPJS = "https://abrahamjuliot.github.io/creepjs/";
const OUT = resolve(REPO, "browser/profiles/assets/chrome-local-huys-macbook-pro-svg-baseline.json");
const PORT = 9344;
const PROFILE = resolve(os.tmpdir(), "svg-cap");
const MAX_SEC = DEFAULT_MAX_SEC;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const chromeExecutable = () => "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

class Cdp {
    constructor(ws) {
        this.ws = ws;
        this.id = 1;
        this.pending = new Map();
        ws.on("message", (raw) => {
            const msg = JSON.parse(String(raw));
            if (msg.id && this.pending.has(msg.id)) {
                const { resolve, reject } = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                if (msg.error) reject(new Error(msg.error.message));
                else resolve(msg.result);
            }
        });
    }
    send(method, params = {}) {
        const id = this.id++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }
    close() { this.ws.close(); }
}

const EXPR = `(() => {
    const svg = window.Fingerprint?.svg;
    if (!svg?.emojiSet) return null;
    const EMOJI_CODEPOINTS = ${JSON.stringify([
        [128512], [9786], [129333, 8205, 9794, 65039], [9832], [9784], [9895], [8265], [8505], [127987, 65039, 8205, 9895, 65039], [129394], [9785], [9760], [129489, 8205, 129456], [129487, 8205, 9794, 65039], [9975], [129489, 8205, 129309, 8205, 129489], [9752], [9968], [9961], [9972], [9992], [9201], [9928], [9730], [9969], [9731], [9732], [9976], [9823], [9937], [9000], [9993], [9999],
        [128105, 8205, 10084, 65039, 8205, 128139, 8205, 128104],
        [128104, 8205, 128105, 8205, 128103, 8205, 128102],
        [128104, 8205, 128105, 8205, 128102],
        [128512],
        [169], [174], [8482],
        [128065, 65039, 8205, 128488, 65039],
        [10002], [9986], [9935], [9874], [9876], [9881], [9939], [9879], [9904], [9905], [9888], [9762], [9763], [11014], [8599], [10145], [11013], [9883], [10017], [10013], [9766], [9654], [9197], [9199], [9167], [9792], [9794], [10006], [12336], [9877], [9884], [10004], [10035], [10055], [9724], [9642], [10083], [10084], [9996], [9757], [9997], [10052], [9878], [8618], [9775], [9770], [9774], [9745], [10036], [127344], [127359],
    ])};
    const EMOJIS = EMOJI_CODEPOINTS.map((c) => String.fromCodePoint(...c));
    const CSS_FONT_FAMILY = "'Segoe Fluent Icons','Ink Free','Bahnschrift','Segoe MDL2 Assets','HoloLens MDL2 Assets','Leelawadee UI','Javanese Text','Segoe UI Emoji','Aldhabi','Gadugi','Myanmar Text','Nirmala UI','Lucida Console','Cambria Math','Bai Jamjuree','Chakra Petch','Charmonman','Fahkwang','K2D','Kodchasan','KoHo','Sarabun','Srisakdi','Galvji','MuktaMahee Regular','InaiMathi Bold','American Typewriter Semibold','Futura Bold','SignPainter-HouseScript Semibold','PingFang HK Light','Kohinoor Devanagari Medium','Luminari','Geneva','Helvetica Neue','Droid Sans Mono','Dancing Script','Roboto','Ubuntu','Liberation Mono','Source Code Pro','DejaVu Sans','OpenSymbol','Chilanka','Cousine','Arimo','Jomolhari','MONO','Noto Color Emoji',sans-serif";
    const div = document.createElement("div");
    div.id = "svg-container";
    div.setAttribute("style", "position:absolute;left:-9999px;height:auto");
    div.innerHTML = '<style>.svgrect-emoji{font-family:' + CSS_FONT_FAMILY + ';font-size:200px!important;height:auto;position:absolute!important;transform:scale(1.000999)}</style><svg><g id="svgBox">' +
        EMOJIS.map((e) => '<text x="32" y="32" class="svgrect-emoji">' + e + '</text>').join("") + '</g></svg>';
    document.body.appendChild(div);
    const reduceToObject = (nativeObj) => Object.keys(nativeObj.__proto__).reduce((acc, key) => {
        const val = nativeObj[key];
        return typeof val === "function" ? acc : { ...acc, [key]: val };
    }, {});
    const svgBox = document.getElementById("svgBox");
    const svgElems = [...svgBox.getElementsByClassName("svgrect-emoji")];
    const pattern = new Set();
    const emojiSet = [];
    for (let i = 0; i < svgElems.length; i++) {
        const dim = '' + svgElems[i].getComputedTextLength();
        if (!pattern.has(dim)) { pattern.add(dim); emojiSet.push(EMOJIS[i]); }
    }
    const svgrectSystemSum = 0.00001 * [...pattern].map((x) => x.split(',').reduce((a, v) => a + (+v || 0), 0)).reduce((a, v) => a + v, 0);
    const perEmoji = svgElems.map((el) => ({
        computedTextLength: el.getComputedTextLength(),
        numberOfChars: el.getNumberOfChars(),
        extentOfChar0: reduceToObject(el.getExtentOfChar(0)),
        subStringLength0_10: el.getSubStringLength(0, 10),
    }));
    const bBox = reduceToObject(svgBox.getBBox());
    document.body.removeChild(div);
    return {
        creep: svg,
        bBox,
        perEmoji,
        emojiSet,
        svgrectSystemSum,
    };
})()`;

mkdirSync(PROFILE, { recursive: true });
const proc = spawn(chromeExecutable(), [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    "--no-first-run",
    "about:blank",
], { stdio: "ignore" });
const t0 = Date.now();
while (Date.now() - t0 < 15_000) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch {}
    await delay(100);
}
const pages = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
const cdp = new Cdp(ws);
await cdp.send("Runtime.enable");
await cdp.send("Page.navigate", { url: CREEPJS });

let data = null;
for (let i = 0; i < MAX_SEC * 10 && Date.now() - t0 < MAX_SEC * 1000; i += 1) {
    await delay(200);
    const r = await cdp.send("Runtime.evaluate", { expression: EXPR, returnByValue: true });
    if (r.result?.value?.perEmoji?.length) { data = r.result.value; break; }
}
cdp.close();
proc.kill("SIGKILL");

if (!data?.perEmoji?.length) {
    console.error("[HANG] svg baseline capture failed", data);
    process.exit(3);
}

const first = data.perEmoji[0];
const baseline = {
    bBox: data.bBox,
    computedTextLength: first.computedTextLength,
    subStringLength: first.subStringLength0_10,
    extentOfChar: first.extentOfChar0,
    perEmojiComputedTextLength: data.perEmoji.map((e) => e.computedTextLength),
    perEmojiNumberOfChars: data.perEmoji.map((e) => e.numberOfChars),
    emojiSet: data.emojiSet,
    svgrectSystemSum: data.svgrectSystemSum,
    creepFingerprint: data.creep,
};

writeFileSync(OUT, JSON.stringify(baseline, null, 2));
console.log(`saved ${OUT} perEmoji=${baseline.perEmojiComputedTextLength.length} emojiSet=${baseline.emojiSet.length} creepSum=${data.creep?.svgrectSystemSum}`);