#!/usr/bin/env node
// Merge Kameleo profile_01 fingerprint reference into Velora chrome-macos-sonoma profile.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repo = resolve(__dirname, "../..");
const kameleoOpts = resolve(repo, "Kameleo-decode/profiles_standard/profile_01/opts.decoded.json");
const profilePath = resolve(repo, "browser/profiles/chrome-macos-sonoma.json");
const fontsOut = resolve(repo, "browser/profiles/assets/chrome-macos-sonoma-fonts.json");
const voicesOut = resolve(repo, "browser/profiles/assets/chrome-macos-sonoma-voices.json");

const k = JSON.parse(readFileSync(kameleoOpts, "utf8"));
const profile = JSON.parse(readFileSync(profilePath, "utf8"));

// Fonts: Kameleo macOS list + generic fallbacks Velora already used for CSS.
const generic = [
    ".AppleSystemUIFont",
    "-apple-system",
    "BlinkMacSystemFont",
    "system-ui",
    "sans-serif",
    "serif",
    "monospace",
    "cursive",
    "fantasy",
];
const fontSet = new Set(k.fonts);
for (const g of generic) fontSet.add(g);
const fonts = [...fontSet].sort((a, b) => a.localeCompare(b));

writeFileSync(fontsOut, JSON.stringify(fonts, null, 2));

const voices = k.speechSynthesisVoice.map((v) => ({
    name: v.name,
    lang: v.lang,
    localService: v.localService,
    default: v.default ?? false,
}));
writeFileSync(voicesOut, JSON.stringify(voices, null, 2));

profile.navigator.languages = ["en-US", "en"];
profile.screen = {
    width: k.screen.width,
    height: k.screen.height,
    availWidth: k.screen.availWidth,
    availHeight: k.screen.availHeight,
    devicePixelRatio: 1.0,
    colorDepth: k.screen.colorDepth,
    pixelDepth: k.screen.colorDepth,
    touch: false,
};
profile.window = {
    innerWidth: k.screen.availWidth,
    innerHeight: k.screen.availHeight - 25,
    outerWidth: k.screen.width + 2,
    outerHeight: k.screen.height,
};
profile.userAgentData.platformVersion = k.userAgent.metadata.platformVersion;
profile.userAgentData.uaFullVersion = k.userAgent.metadata.fullVersion;
profile.fontsFile = "browser/profiles/assets/chrome-macos-sonoma-fonts.json";
profile.speechVoicesFile = "browser/profiles/assets/chrome-macos-sonoma-voices.json";
delete profile.fonts;

writeFileSync(profilePath, JSON.stringify(profile, null, 2) + "\n");

console.log(`fonts: ${fonts.length} → ${fontsOut}`);
console.log(`voices: ${voices.length} → ${voicesOut}`);
console.log(`profile updated: ${profilePath}`);
console.log(`languages: ${profile.navigator.languages.join(",")}`);
console.log(`screen: ${profile.screen.width}x${profile.screen.height} depth=${profile.screen.colorDepth}`);