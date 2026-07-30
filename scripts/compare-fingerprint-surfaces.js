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
      return { index, chrome: left?.[index], velora: right?.[index] };
    }
  }
  return null;
}

function compare(chrome, velora) {
  const canvasChrome = chrome.asset("canvas-probe");
  const canvasVelora = velora.asset("canvas-probe");
  const fontsChrome = chrome.asset("fonts") || [];
  const fontsVelora = velora.asset("fonts") || [];
  const measureChrome = chrome.asset("measuretext");
  const measureVelora = velora.asset("measuretext");
  const audioChrome = chrome.asset("audio-probe");
  const audioVelora = velora.asset("audio-probe");
  const webglChrome = chrome.asset("webgl-probe");
  const webglVelora = velora.asset("webgl-probe");
  const windowChrome = chrome.asset("window-keys") || [];
  const windowVelora = velora.asset("window-keys") || [];
  const navigatorChrome = chrome.asset("navigator-keys") || [];
  const navigatorVelora = velora.asset("navigator-keys") || [];
  const htmlChrome = chrome.asset("html-element-keys");
  const htmlVelora = velora.asset("html-element-keys");
  const cssChrome = chrome.asset("css-computed-keys");
  const cssVelora = velora.asset("css-computed-keys");
  const webgl2Chrome = chrome.definition._future?.webgl2 || null;
  const webgl2Velora = velora.definition._future?.webgl2 || null;
  const webgpuChrome = chrome.definition._future?.webgpu || null;
  const webgpuVelora = velora.definition._future?.webgpu || null;

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
    velora: {
      id: velora.definition.id,
      capturedFrom: velora.definition.capturedFrom,
    },
    canvas: {
      exact: equal(canvasChrome, canvasVelora),
      chromeDataUrlLengths: canvasChrome?.map((entry) => entry.dataUrl.length) || [],
      veloraDataUrlLengths: canvasVelora?.map((entry) => entry.dataUrl.length) || [],
      firstDifference: firstArrayDifference(canvasChrome, canvasVelora),
    },
    fonts: {
      exact: equal(fontsChrome, fontsVelora),
      chromeCount: fontsChrome.length,
      veloraCount: fontsVelora.length,
      sharedCount: fontsChrome.length - setDifference(fontsChrome, fontsVelora).length,
      chromeOnlyCount: setDifference(fontsChrome, fontsVelora).length,
      veloraOnlyCount: setDifference(fontsVelora, fontsChrome).length,
      chromeOnlySample: setDifference(fontsChrome, fontsVelora).slice(0, 30),
      veloraOnlySample: setDifference(fontsVelora, fontsChrome).slice(0, 30),
    },
    measureText: {
      exact: equal(measureChrome, measureVelora),
      chromeCount: measureChrome?.length || 0,
      veloraCount: measureVelora?.length || 0,
      firstDifference: firstArrayDifference(measureChrome, measureVelora),
    },
    webgl1: {
      exact: equal(webglChrome, webglVelora),
    },
    webgl2: {
      exact: equal(webgl2Chrome, webgl2Velora),
      parameterDifferences: webgl2Parameters
        .filter((key) => webgl2Chrome?.[key] !== webgl2Velora?.[key])
        .map((key) => ({ key, chrome: webgl2Chrome?.[key], velora: webgl2Velora?.[key] })),
      extensionsExact: equal(webgl2Chrome?.extensions, webgl2Velora?.extensions),
    },
    webgpu: {
      exact: equal(webgpuChrome, webgpuVelora),
      chromeAvailable: webgpuChrome?.available ?? false,
      veloraAvailable: webgpuVelora?.available ?? false,
      chromeFeatureCount: webgpuChrome?.features?.length || 0,
      veloraFeatureCount: webgpuVelora?.features?.length || 0,
    },
    audio: {
      exact: equal(audioChrome, audioVelora),
      chromeError: audioChrome?.error || null,
      veloraError: audioVelora?.error || null,
      chromeSampleCount: audioChrome?.samples?.length || 0,
      veloraSampleCount: audioVelora?.samples?.length || 0,
    },
    apiShape: {
      window: {
        exact: equal(windowChrome, windowVelora),
        chromeCount: windowChrome.length,
        veloraCount: windowVelora.length,
      },
      navigator: {
        exact: equal(navigatorChrome, navigatorVelora),
        chromeCount: navigatorChrome.length,
        veloraCount: navigatorVelora.length,
      },
      htmlElement: {
        exact: equal(htmlChrome, htmlVelora),
        chromeCount: htmlChrome?.length || 0,
        veloraCount: htmlVelora?.length || 0,
        veloraCaptured: htmlVelora !== null,
      },
      cssComputed: {
        exact: equal(cssChrome, cssVelora),
        chromeCount: cssChrome?.length || 0,
        veloraCount: cssVelora?.length || 0,
        veloraCaptured: cssVelora !== null,
      },
    },
    stableReplay: {
      mathsExact: equal(chrome.asset("maths-baseline"), velora.asset("maths-baseline")),
      voicesExact: equal(chrome.asset("voices"), velora.asset("voices")),
    },
  };
}

function markdown(report) {
  const status = (value) => value ? "PASS" : "FAIL";
  return [
    "# Chrome / Velora fingerprint surface comparison",
    "",
    `Chrome: \`${report.chrome.id}\` from \`${report.chrome.capturedFrom}\`  `,
    `Velora: \`${report.velora.id}\` from \`${report.velora.capturedFrom}\``,
    "",
    "| Surface | Result | Evidence |",
    "|---|---:|---|",
    `| Canvas | ${status(report.canvas.exact)} | data URL lengths Chrome ${report.canvas.chromeDataUrlLengths.join(", ")}; Velora ${report.canvas.veloraDataUrlLengths.join(", ")} |`,
    `| Fonts | ${status(report.fonts.exact)} | Chrome ${report.fonts.chromeCount}; Velora ${report.fonts.veloraCount}; shared ${report.fonts.sharedCount} |`,
    `| measureText | ${status(report.measureText.exact)} | ${report.measureText.chromeCount} entries |`,
    `| WebGL 1 | ${status(report.webgl1.exact)} | Full probe equality |`,
    `| WebGL 2 | ${status(report.webgl2.exact)} | ${report.webgl2.parameterDifferences.length} parameter differences; extensions ${report.webgl2.extensionsExact ? "match" : "differ"} |`,
    `| WebGPU | ${status(report.webgpu.exact)} | available Chrome ${report.webgpu.chromeAvailable}; Velora ${report.webgpu.veloraAvailable} |`,
    `| Offline Audio | ${status(report.audio.exact)} | Chrome samples ${report.audio.chromeSampleCount}; Velora samples ${report.audio.veloraSampleCount}; Velora error: ${report.audio.veloraError || "none"} |`,
    `| Window keys | ${status(report.apiShape.window.exact)} | Chrome ${report.apiShape.window.chromeCount}; Velora ${report.apiShape.window.veloraCount} |`,
    `| Navigator keys | ${status(report.apiShape.navigator.exact)} | Chrome ${report.apiShape.navigator.chromeCount}; Velora ${report.apiShape.navigator.veloraCount} |`,
    `| HTMLElement keys | ${status(report.apiShape.htmlElement.exact)} | Chrome ${report.apiShape.htmlElement.chromeCount}; Velora ${report.apiShape.htmlElement.veloraCount} |`,
    `| CSS computed keys | ${status(report.apiShape.cssComputed.exact)} | Chrome ${report.apiShape.cssComputed.chromeCount}; Velora ${report.apiShape.cssComputed.veloraCount} |`,
    `| Math baseline | ${status(report.stableReplay.mathsExact)} | Full equality |`,
    `| Speech voices | ${status(report.stableReplay.voicesExact)} | Full equality |`,
    "",
  ].join("\n");
}

function main() {
  const [chromeDirectory, veloraDirectory, outputDirectory] = process.argv.slice(2);
  if (!chromeDirectory || !veloraDirectory || !outputDirectory) {
    throw new Error("usage: compare-fingerprint-surfaces.js <chrome-dir> <velora-dir> <output-dir>");
  }
  const result = compare(profile(path.resolve(chromeDirectory)), profile(path.resolve(veloraDirectory)));
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
