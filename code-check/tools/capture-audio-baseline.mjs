#!/usr/bin/env node
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");
const outFile = resolve(repoRoot, "browser/profiles/assets/chrome-macos-sonoma-audio-probe.json");

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
    const page = await browser.newPage();
    const result = await page.evaluate(async () => {
        const bufferLen = 5000;
        const ctx = new OfflineAudioContext(1, bufferLen, 44100);
        const analyser = ctx.createAnalyser();
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();
        const compressor = ctx.createDynamicsCompressor();
        oscillator.type = "triangle";
        oscillator.frequency.value = 10000;
        compressor.threshold.value = -50;
        gain.gain.value = 0.5;
        oscillator.connect(compressor);
        compressor.connect(analyser);
        analyser.connect(gain);
        gain.connect(ctx.destination);
        oscillator.start(0);
        const buffer = await ctx.startRendering();
        const data = buffer.getChannelData(0);
        const freq = new Float32Array(analyser.frequencyBinCount);
        analyser.getFloatFrequencyData(freq);
        return {
            samples: Array.from(data),
            freq: Array.from(freq),
            tailSum: Array.from(data).slice(4500).reduce((a, b) => a + Math.abs(b), 0),
        };
    });
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, JSON.stringify(result));
    console.log(`saved ${outFile} tailSum=${result.tailSum}`);
} finally {
    await browser.close();
}