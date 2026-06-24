#!/usr/bin/env node
// Capture Chrome measureText baselines for antidetect profile fonts.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");
const fontsFile = resolve(repoRoot, "browser/profiles/assets/chrome-macos-sonoma-fonts.json");
const outFile = resolve(repoRoot, "browser/profiles/assets/chrome-macos-sonoma-measuretext.json");

const TEXTS = ["", "velora", "😀", "mmmmmmmmmmlli", "Cwm fjordbank glyphs vext quiz", "👾"];
const FONT_SIZE = 14;
const BATCH = 40;

const fonts = JSON.parse(readFileSync(fontsFile, "utf8"));
console.log(`fonts: ${fonts.length}, texts: ${TEXTS.length}`);

function probeScript(batchFonts, texts, size) {
    return `(() => {
        const fonts = ${JSON.stringify(batchFonts)};
        const texts = ${JSON.stringify(texts)};
        const size = ${size};
        const out = [];
        const c = document.createElement("canvas");
        const ctx = c.getContext("2d");
        for (const family of fonts) {
            const font = size + 'px "' + family + '"';
            for (const text of texts) {
                ctx.font = font;
                const m = ctx.measureText(text);
                out.push({
                    family,
                    text,
                    width: m.width,
                    actualBoundingBoxLeft: m.actualBoundingBoxLeft,
                    actualBoundingBoxRight: m.actualBoundingBoxRight,
                    actualBoundingBoxAscent: m.actualBoundingBoxAscent,
                    actualBoundingBoxDescent: m.actualBoundingBoxDescent,
                    fontBoundingBoxAscent: m.fontBoundingBoxAscent,
                    fontBoundingBoxDescent: m.fontBoundingBoxDescent,
                });
            }
        }
        return out;
    })()`;
}

async function main() {
    const browser = await chromium.launch({
        channel: "chrome",
        headless: true,
        args: ["--incognito"],
    });
    const all = [];
    try {
        const page = await browser.newContext().then((c) => c.newPage());
        await page.goto("about:blank");
        for (let i = 0; i < fonts.length; i += BATCH) {
            const batch = fonts.slice(i, i + BATCH);
            const chunk = await page.evaluate(probeScript(batch, TEXTS, FONT_SIZE));
            all.push(...chunk);
            process.stdout.write(`\r${Math.min(i + BATCH, fonts.length)}/${fonts.length}`);
        }
        console.log();
    } finally {
        await browser.close();
    }
    writeFileSync(outFile, JSON.stringify(all));
    console.log(`saved ${all.length} entries → ${outFile}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(2);
});