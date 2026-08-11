#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, "utf8"));
}

function profile(directory) {
  const definition = readJson(path.join(directory, "fingerprint.json"));
  const id = definition.id;
  const asset = (suffix) => {
    const filename = path.join(directory, "assets", `${id}-${suffix}.json`);
    return fs.existsSync(filename) ? readJson(filename) : null;
  };
  return { directory, definition, asset };
}

function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function setDifference(left, right) {
  const other = new Set(right || []);
  return (left || []).filter((value) => !other.has(value));
}

function firstArrayDifference(left, right) {
  const count = Math.max(left?.length || 0, right?.length || 0);
  for (let index = 0; index < count; index += 1) {
    if (!equal(left?.[index], right?.[index])) {
      return { index, chrome: left?.[index], koko: right?.[index] };
    }
  }
  return null;
}

function compare(chrome, koko) {
  const canvasChrome = chrome.asset("canvas-probe");
  const canvasKoko = koko.asset("canvas-probe");
  const fontsChrome = chrome.asset("fonts") || [];
  const fontsKoko = koko.asset("fonts") || [];
  const measureChrome = chrome.asset("measuretext");
  const measureKoko = koko.asset("measuretext");
  const audioChrome = chrome.asset("audio-probe");
  const audioKoko = koko.asset("audio-probe");
  const webglChrome = chrome.asset("webgl-probe");
  const webglKoko = koko.asset("webgl-probe");
  const windowChrome = chrome.asset("window-keys") || [];
  const windowKoko = koko.asset("window-keys") || [];
  const navigatorChrome = chrome.asset("navigator-keys") || [];
  const navigatorKoko = koko.asset("navigator-keys") || [];
  const htmlChrome = chrome.asset("html-element-keys");
  const htmlKoko = koko.asset("html-element-keys");
  const cssChrome = chrome.asset("css-computed-keys");
  const cssKoko = koko.asset("css-computed-keys");
  const webgl2Chrome = chrome.definition._future?.webgl2 || null;
  const webgl2Koko = koko.definition._future?.webgl2 || null;
  const webgpuChrome = chrome.definition._future?.webgpu || null;
  const webgpuKoko = koko.definition._future?.webgpu || null;

  const webgl2Parameters = [
    "maxColorAttachments",
    "maxDrawBuffers",
    "maxSamples",
    "max3dTextureSize",
    "maxArrayTextureLayers",
    "maxTextureSize",
    "maxVertexUniformVectors",
    "maxFragmentUniformVectors",
  ];

  return {
    chrome: {
      id: chrome.definition.id,
      capturedFrom: chrome.definition.capturedFrom,
    },
    koko: {
      id: koko.definition.id,
      capturedFrom: koko.definition.capturedFrom,
    },
    canvas: {
      exact: equal(canvasChrome, canvasKoko),
      chromeDataUrlLengths: canvasChrome?.map((entry) => entry.dataUrl.length) || [],
      kokoDataUrlLengths: canvasKoko?.map((entry) => entry.dataUrl.length) || [],
      firstDifference: firstArrayDifference(canvasChrome, canvasKoko),
    },
    fonts: {
      exact: equal(fontsChrome, fontsKoko),
      chromeCount: fontsChrome.length,
      kokoCount: fontsKoko.length,
      sharedCount: fontsChrome.length - setDifference(fontsChrome, fontsKoko).length,
      chromeOnlyCount: setDifference(fontsChrome, fontsKoko).length,
      kokoOnlyCount: setDifference(fontsKoko, fontsChrome).length,
      chromeOnlySample: setDifference(fontsChrome, fontsKoko).slice(0, 30),
      kokoOnlySample: setDifference(fontsKoko, fontsChrome).slice(0, 30),
    },
    measureText: {
      exact: equal(measureChrome, measureKoko),
      chromeCount: measureChrome?.length || 0,
      kokoCount: measureKoko?.length || 0,
      firstDifference: firstArrayDifference(measureChrome, measureKoko),
    },
    webgl1: {
      exact: equal(webglChrome, webglKoko),
    },
    webgl2: {
      exact: equal(webgl2Chrome, webgl2Koko),
      parameterDifferences: webgl2Parameters
        .filter((key) => webgl2Chrome?.[key] !== webgl2Koko?.[key])
        .map((key) => ({ key, chrome: webgl2Chrome?.[key], koko: webgl2Koko?.[key] })),
      extensionsExact: equal(webgl2Chrome?.extensions, webgl2Koko?.extensions),
    },
    webgpu: {
      exact: equal(webgpuChrome, webgpuKoko),
      chromeAvailable: webgpuChrome?.available ?? false,
      kokoAvailable: webgpuKoko?.available ?? false,
      chromeFeatureCount: webgpuChrome?.features?.length || 0,
      kokoFeatureCount: webgpuKoko?.features?.length || 0,
    },
    audio: {
      exact: equal(audioChrome, audioKoko),
      chromeError: audioChrome?.error || null,
      kokoError: audioKoko?.error || null,
      chromeSampleCount: audioChrome?.samples?.length || 0,
      kokoSampleCount: audioKoko?.samples?.length || 0,
    },
    apiShape: {
      window: {
        exact: equal(windowChrome, windowKoko),
        chromeCount: windowChrome.length,
        kokoCount: windowKoko.length,
      },
      navigator: {
        exact: equal(navigatorChrome, navigatorKoko),
        chromeCount: navigatorChrome.length,
        kokoCount: navigatorKoko.length,
      },
      htmlElement: {
        exact: equal(htmlChrome, htmlKoko),
        chromeCount: htmlChrome?.length || 0,
        kokoCount: htmlKoko?.length || 0,
        kokoCaptured: htmlKoko !== null,
      },
      cssComputed: {
        exact: equal(cssChrome, cssKoko),
        chromeCount: cssChrome?.length || 0,
        kokoCount: cssKoko?.length || 0,
        kokoCaptured: cssKoko !== null,
      },
    },
    stableReplay: {
      mathsExact: equal(chrome.asset("maths-baseline"), koko.asset("maths-baseline")),
      voicesExact: equal(chrome.asset("voices"), koko.asset("voices")),
    },
  };
}

function markdown(report) {
  const status = (value) => value ? "PASS" : "FAIL";
  return [
    "# Chrome / Koko fingerprint surface comparison",
    "",
    `Chrome: \`${report.chrome.id}\` from \`${report.chrome.capturedFrom}\`  `,
    `Koko: \`${report.koko.id}\` from \`${report.koko.capturedFrom}\``,
    "",
    "| Surface | Result | Evidence |",
    "|---|---:|---|",
    `| Canvas | ${status(report.canvas.exact)} | data URL lengths Chrome ${report.canvas.chromeDataUrlLengths.join(", ")}; Koko ${report.canvas.kokoDataUrlLengths.join(", ")} |`,
    `| Fonts | ${status(report.fonts.exact)} | Chrome ${report.fonts.chromeCount}; Koko ${report.fonts.kokoCount}; shared ${report.fonts.sharedCount} |`,
    `| measureText | ${status(report.measureText.exact)} | ${report.measureText.chromeCount} entries |`,
    `| WebGL 1 | ${status(report.webgl1.exact)} | Full probe equality |`,
    `| WebGL 2 | ${status(report.webgl2.exact)} | ${report.webgl2.parameterDifferences.length} parameter differences; extensions ${report.webgl2.extensionsExact ? "match" : "differ"} |`,
    `| WebGPU | ${status(report.webgpu.exact)} | available Chrome ${report.webgpu.chromeAvailable}; Koko ${report.webgpu.kokoAvailable} |`,
    `| Offline Audio | ${status(report.audio.exact)} | Chrome samples ${report.audio.chromeSampleCount}; Koko samples ${report.audio.kokoSampleCount}; Koko error: ${report.audio.kokoError || "none"} |`,
    `| Window keys | ${status(report.apiShape.window.exact)} | Chrome ${report.apiShape.window.chromeCount}; Koko ${report.apiShape.window.kokoCount} |`,
    `| Navigator keys | ${status(report.apiShape.navigator.exact)} | Chrome ${report.apiShape.navigator.chromeCount}; Koko ${report.apiShape.navigator.kokoCount} |`,
    `| HTMLElement keys | ${status(report.apiShape.htmlElement.exact)} | Chrome ${report.apiShape.htmlElement.chromeCount}; Koko ${report.apiShape.htmlElement.kokoCount} |`,
    `| CSS computed keys | ${status(report.apiShape.cssComputed.exact)} | Chrome ${report.apiShape.cssComputed.chromeCount}; Koko ${report.apiShape.cssComputed.kokoCount} |`,
    `| Math baseline | ${status(report.stableReplay.mathsExact)} | Full equality |`,
    `| Speech voices | ${status(report.stableReplay.voicesExact)} | Full equality |`,
    "",
  ].join("\n");
}

function main() {
  const [chromeDirectory, kokoDirectory, outputDirectory] = process.argv.slice(2);
  if (!chromeDirectory || !kokoDirectory || !outputDirectory) {
    throw new Error("usage: compare-fingerprint-surfaces.js <chrome-dir> <koko-dir> <output-dir>");
  }
  const result = compare(profile(path.resolve(chromeDirectory)), profile(path.resolve(kokoDirectory)));
  const out = path.resolve(outputDirectory);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "surface-comparison.json"), `${JSON.stringify(result, null, 2)}\n`);
  fs.writeFileSync(path.join(out, "SURFACE_REPORT.md"), `${markdown(result)}\n`);
  console.log(out);
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
