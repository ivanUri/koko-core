#!/usr/bin/env node
// Compare creepjs-style canvas probes: Velora vs Chrome (local, no network).
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { Browser } from "../../sdk/dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");
const CSS_FONT = 'Arial, "Helvetica Neue", Helvetica, sans-serif';

const PROBES = `(() => {
    const cssFont = ${JSON.stringify(CSS_FONT)};
    const out = {};
    const paintCanvas = ({ canvas, context, strokeText = false, area = { width: 75, height: 75 }, rounds = 10, seed = 500, offset = 2001000001, multiplier = 15000 }) => {
        context.clearRect(0, 0, canvas.width, canvas.height);
        canvas.width = area.width; canvas.height = area.height;
        let current = Number(seed) % Number(offset);
        const getNextSeed = () => { current = (Number(multiplier) * current) % Number(offset); return current; };
        const patchSeed = (current, offset, maxBound, computeFloat) => {
            const result = (((current - 1) / offset) * (maxBound || 1)) || 0;
            return computeFloat ? result : Math.floor(result);
        };
        const colors = ['#FF6633','#FFB399','#FF33FF','#FFFF99','#00B3E6','#E6B333','#3366E6','#999966','#99FF99','#B34D4D','#80B300','#809900','#E6B3B3','#6680B3','#66991A','#FF99E6','#CCFF1A','#FF1A66','#E6331A','#33FFCC','#66994D','#B366CC','#4D8000','#B33300','#CC80CC','#66664D','#991AFF','#E666FF','#4DB3FF','#1AB399','#E666B3','#33991A','#CC9999','#B3B31A','#00E680','#4D8066','#809980','#E6FF80','#1AFF33','#999933','#FF3380','#CCCC00','#66E64D','#4D80CC','#9900B3','#E64D66','#4DB380','#FF4D4D','#99E6E6','#6666FF'];
        const drawOutlineOfText = (context, offset, area, getNextSeed) => {
            const { width, height } = area;
            context.font = (height / 2.99) + 'px ' + cssFont;
            context.strokeText('👾A', patchSeed(getNextSeed(), offset, width), patchSeed(getNextSeed(), offset, height), patchSeed(getNextSeed(), offset, width));
        };
        const createCircularArc = (context, offset, area, getNextSeed) => {
            const { width, height } = area;
            context.beginPath();
            context.arc(patchSeed(getNextSeed(), offset, width), patchSeed(getNextSeed(), offset, height), patchSeed(getNextSeed(), offset, Math.min(width, height)), patchSeed(getNextSeed(), offset, 2 * Math.PI, true), patchSeed(getNextSeed(), offset, 2 * Math.PI, true));
            context.stroke();
        };
        const createBezierCurve = (context, offset, area, getNextSeed) => {
            const { width, height } = area;
            context.beginPath();
            context.moveTo(patchSeed(getNextSeed(), offset, width), patchSeed(getNextSeed(), offset, height));
            context.bezierCurveTo(patchSeed(getNextSeed(), offset, width), patchSeed(getNextSeed(), offset, height), patchSeed(getNextSeed(), offset, width), patchSeed(getNextSeed(), offset, height), patchSeed(getNextSeed(), offset, width), patchSeed(getNextSeed(), offset, height));
            context.stroke();
        };
        const createQuadraticCurve = (context, offset, area, getNextSeed) => {
            const { width, height } = area;
            context.beginPath();
            context.moveTo(patchSeed(getNextSeed(), offset, width), patchSeed(getNextSeed(), offset, height));
            context.quadraticCurveTo(patchSeed(getNextSeed(), offset, width), patchSeed(getNextSeed(), offset, height), patchSeed(getNextSeed(), offset, width), patchSeed(getNextSeed(), offset, height));
            context.stroke();
        };
        const createEllipticalArc = (context, offset, area, getNextSeed) => {
            const { width, height } = area;
            context.beginPath();
            context.ellipse(patchSeed(getNextSeed(), offset, width), patchSeed(getNextSeed(), offset, height), patchSeed(getNextSeed(), offset, Math.floor(width / 2)), patchSeed(getNextSeed(), offset, Math.floor(height / 2)), patchSeed(getNextSeed(), offset, 2 * Math.PI, true), patchSeed(getNextSeed(), offset, 2 * Math.PI, true), patchSeed(getNextSeed(), offset, 2 * Math.PI, true));
            context.stroke();
        };
        const methods = [createCircularArc, createBezierCurve, createQuadraticCurve, createEllipticalArc];
        if (strokeText) methods.push(drawOutlineOfText);
        for (let i = 0; i < rounds; i++) {
            const { width, height } = area;
            const canvasGradient = context.createRadialGradient(patchSeed(getNextSeed(), offset, width), patchSeed(getNextSeed(), offset, height), patchSeed(getNextSeed(), offset, width), patchSeed(getNextSeed(), offset, width), patchSeed(getNextSeed(), offset, height), patchSeed(getNextSeed(), offset, width));
            canvasGradient.addColorStop(0, colors[patchSeed(getNextSeed(), offset, colors.length)]);
            canvasGradient.addColorStop(1, colors[patchSeed(getNextSeed(), offset, colors.length)]);
            context.fillStyle = canvasGradient;
            context.shadowBlur = patchSeed(getNextSeed(), offset, 50, true);
            context.shadowColor = colors[patchSeed(getNextSeed(), offset, colors.length)];
            methods[patchSeed(getNextSeed(), offset, methods.length)](context, offset, area, getNextSeed);
            context.fill();
        }
    };
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    paintCanvas({ canvas, context: ctx, strokeText: true, area: { width: 75, height: 75 } });
    out.dataURI = canvas.toDataURL();
    paintCanvas({ canvas, context: ctx, area: { width: 75, height: 75 } });
    out.paintURI = canvas.toDataURL();
    ctx.clearRect(0,0,canvas.width,canvas.height);
    canvas.width=50; canvas.height=50;
    ctx.font='50px '+cssFont; ctx.fillText('A',7,37);
    out.textURI = canvas.toDataURL();
    ctx.clearRect(0,0,canvas.width,canvas.height);
    canvas.width=50; canvas.height=50;
    ctx.font='35px '+cssFont; ctx.fillText('👾',0,37);
    out.emojiURI = canvas.toDataURL();
    canvas.width=240; canvas.height=60;
    ctx.font='14px Arial'; ctx.fillText('velora',2,2);
    out.velora240 = canvas.toDataURL().slice(-32);
    canvas.width=2; canvas.height=2;
    ctx.fillStyle='#000'; ctx.fillRect(0,0,2,2);
    ctx.fillStyle='#fff'; ctx.fillRect(2,2,1,1);
    ctx.beginPath(); ctx.arc(0,0,2,0,1,true); ctx.closePath(); ctx.fill();
    out.lowEntropy = [...ctx.getImageData(0,0,2,2).data].join('');
    return out;
})()`;

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

async function veloraProbe() {
    const port = await getFreePort();
    const proc = spawn(veloraBin, [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", "chrome-macos-sonoma", "--log-level", "warn",
    ], { cwd: repoRoot, stdio: "ignore" });
    const endpoint = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 40; i++) {
        try { if ((await fetch(`${endpoint}/json/version`)).ok) break; } catch {}
        await delay(100);
    }
    const browser = await Browser.connect(endpoint);
    try {
        const page = await browser.newPage();
        await page.goto("about:blank");
        await delay(300);
        return await page.evaluate(PROBES);
    } finally {
        await browser.close().catch(() => {});
        proc.kill("SIGTERM");
    }
}

async function chromeProbe() {
    const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--incognito"] });
    try {
        const page = await browser.newPage();
        await page.goto("about:blank");
        return await page.evaluate(PROBES);
    } finally {
        await browser.close();
    }
}

async function main() {
    if (!existsSync(veloraBin)) throw new Error("zig build first");
    const [v, c] = await Promise.all([veloraProbe(), chromeProbe()]);
    let diffs = 0;
    for (const k of Object.keys(c)) {
        const match = v[k] === c[k];
        if (!match) {
            diffs++;
            console.log(`DIFF ${k} v.len=${String(v[k]).length} c.len=${String(c[k]).length}`);
            if (k.endsWith("URI") || k === "velora240") {
                console.log(`  v tail: ${String(v[k]).slice(-48)}`);
                console.log(`  c tail: ${String(c[k]).slice(-48)}`);
            } else {
                console.log(`  v: ${v[k]}`);
                console.log(`  c: ${c[k]}`);
            }
        } else {
            console.log(`MATCH ${k}`);
        }
    }
    console.log(`\ntotal diffs: ${diffs}`);
    process.exit(diffs > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });