#!/usr/bin/env node
// Capture Chrome canvas fingerprint baseline for Velora intelligent canvas.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");
const outDir = resolve(repoRoot, "browser/profiles/assets");
const outFile = resolve(outDir, "chrome-macos-sonoma-canvas-probe.txt");

const PROBE = `(() => {
    const c = document.createElement("canvas");
    c.width = 240; c.height = 60;
    const ctx = c.getContext("2d");
    ctx.font = "14px Arial";
    ctx.fillText("velora", 2, 2);
    return c.toDataURL();
})()`;

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
    const page = await browser.newPage();
    const dataUrl = await page.evaluate(PROBE);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(outFile, dataUrl);
    console.log(`saved ${outFile}`);
    console.log(`len=${dataUrl.length} tail=${dataUrl.slice(-32)}`);
} finally {
    await browser.close();
}