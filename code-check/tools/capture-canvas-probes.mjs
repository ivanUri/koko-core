#!/usr/bin/env node
// Capture Chrome canvas probe baselines for Velora intelligent canvas.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");
const outFile = resolve(repoRoot, "browser/profiles/assets/chrome-macos-sonoma-canvas-probes.json");

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

    // CreepJS paintCanvas 75×75 (strokeText then plain)
    {
        const c = document.createElement("canvas");
        const ctx = c.getContext("2d");
        paintCanvas({ canvas: c, context: ctx, strokeText: true, area: { width: 75, height: 75 } });
        out.canvas_75_data = c.toDataURL();
        paintCanvas({ canvas: c, context: ctx, area: { width: 75, height: 75 } });
        out.canvas_75_paint = c.toDataURL();
    }

    // Google / env-compare standard
    {
        const c = document.createElement("canvas");
        c.width = 240; c.height = 60;
        const ctx = c.getContext("2d");
        ctx.font = "14px Arial";
        ctx.fillText("velora", 2, 2);
        out.canvas_240_velora = c.toDataURL();
    }

    // CreepJS text / emoji
    {
        const c = document.createElement("canvas");
        c.width = 50; c.height = 50;
        const ctx = c.getContext("2d");
        ctx.font = "50px " + cssFont;
        ctx.fillText("A", 7, 37);
        out.canvas_50_text = c.toDataURL();
    }
    {
        const c = document.createElement("canvas");
        c.width = 50; c.height = 50;
        const ctx = c.getContext("2d");
        ctx.font = "35px " + cssFont;
        ctx.fillText("👾", 0, 37);
        out.canvas_50_emoji = c.toDataURL();
    }

    // CreepJS low-entropy 2×2 arc
    {
        const c = document.createElement("canvas");
        c.width = 2; c.height = 2;
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.fillStyle = "#fff";
        ctx.fillRect(2, 2, 1, 1);
        ctx.beginPath();
        ctx.arc(0, 0, 2, 0, 1, true);
        ctx.closePath();
        ctx.fill();
        out.canvas_2_low_entropy = [...ctx.getImageData(0, 0, 2, 2).data];
    }

    return out;
})()`;

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--incognito"] });
try {
    const page = await browser.newPage();
    const probes = await page.evaluate(PROBES);
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, JSON.stringify(probes, null, 2));
    console.log(`saved ${outFile}`);
    for (const [k, v] of Object.entries(probes)) {
        console.log(`  ${k}: len=${String(v).length} tail=${String(v).slice(-24)}`);
    }
} finally {
    await browser.close();
}