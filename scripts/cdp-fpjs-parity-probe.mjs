#!/usr/bin/env node
/**
 * FingerprintJS-aligned client surface probe (OSS sources in fingerprintjs-master).
 * Budget: max 20s. Hang → SIGKILL, exit 3.
 *
 *   node scripts/cdp-fpjs-parity-probe.mjs --profile chrome-local-huys-macbook-pro
 */
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import {
  createProbeBudget,
  killProcess,
  parseMaxSecArg,
  waitCdp,
} from "./lib/cdp-probe-budget.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const VELORA_BIN = resolve(REPO, "zig-out/bin/velora");
const OUT = join(REPO, "code-check/tmp/fpjs-parity");

// Mirrors fingerprintjs-master/src/sources/{fonts,font_preferences,webgl,audio,architecture}.ts
const EXPR = `(() => {
  const testString = 'mmMwWLliI0O&1';
  const textSize = '48px';
  const baseFonts = ['monospace', 'sans-serif', 'serif'];
  const fontList = [
    'Helvetica Neue', 'Menlo', 'Arial', 'Geneva', 'Courier New', 'Verdana',
    'Times New Roman', 'Georgia', 'Monaco', 'Tahoma', 'Lucida Grande',
    'Arial Unicode MS', 'Gill Sans', 'Futura', 'Optima', 'Palatino',
  ];

  // --- fonts (offsetWidth/Height vs base) ---
  const holder = document.body;
  const spansContainer = document.createElement('div');
  spansContainer.style.setProperty('visibility', 'hidden', 'important');
  spansContainer.style.fontSize = textSize;
  const createSpan = (fontFamily) => {
    const span = document.createElement('span');
    span.style.position = 'absolute';
    span.style.top = '0';
    span.style.left = '0';
    span.style.fontFamily = fontFamily;
    span.textContent = testString;
    spansContainer.appendChild(span);
    return span;
  };
  const baseSpans = baseFonts.map(createSpan);
  const fontsSpans = {};
  for (const f of fontList) {
    fontsSpans[f] = baseFonts.map((b) => createSpan("'" + f + "'," + b));
  }
  holder.appendChild(spansContainer);
  const defaultWidth = {}, defaultHeight = {};
  for (let i = 0; i < baseFonts.length; i++) {
    defaultWidth[baseFonts[i]] = baseSpans[i].offsetWidth;
    defaultHeight[baseFonts[i]] = baseSpans[i].offsetHeight;
  }
  const detectedFonts = fontList.filter((font) =>
    baseFonts.some((b, i) =>
      fontsSpans[font][i].offsetWidth !== defaultWidth[b] ||
      fontsSpans[font][i].offsetHeight !== defaultHeight[b]
    )
  );
  spansContainer.remove();

  // --- fontPreferences (getBoundingClientRect width, non-absolute) ---
  const prefText = 'mmMwWLliI0fiflO&1';
  const presets = {
    default: {},
    apple: { font: '-apple-system-body' },
    serif: { fontFamily: 'serif' },
    sans: { fontFamily: 'sans-serif' },
    mono: { fontFamily: 'monospace' },
    min: { fontSize: '1px' },
    system: { fontFamily: 'system-ui' },
  };
  const prefBox = document.createElement('div');
  prefBox.style.cssText = 'position:absolute;left:-9999px;width:4000px;visibility:hidden';
  const prefEls = {};
  for (const [k, style] of Object.entries(presets)) {
    const el = document.createElement('span');
    el.textContent = prefText;
    el.style.whiteSpace = 'nowrap';
    for (const [n, v] of Object.entries(style)) el.style[n] = v;
    prefBox.appendChild(document.createElement('br'));
    prefBox.appendChild(el);
    prefEls[k] = el;
  }
  holder.appendChild(prefBox);
  const fontPreferences = {};
  for (const [k, el] of Object.entries(prefEls)) {
    fontPreferences[k] = el.getBoundingClientRect().width;
  }
  prefBox.remove();

  // --- webGlBasics + extensions (FPJS logic) ---
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
  let webGlBasics = null;
  let webGlExtensions = null;
  if (gl && typeof gl.getParameter === 'function') {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    webGlBasics = {
      version: gl.getParameter(gl.VERSION)?.toString() || '',
      vendor: gl.getParameter(gl.VENDOR)?.toString() || '',
      vendorUnmasked: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)?.toString() : '',
      renderer: gl.getParameter(gl.RENDERER)?.toString() || '',
      rendererUnmasked: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)?.toString() : '',
      shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION)?.toString() || '',
    };
    const extensions = gl.getSupportedExtensions();
    const unsupportedExtensions = [];
    const extensionParameters = [];
    const validExtensionParams = new Set([34047, 35723, 36063, 34852, 34853, 34854, 34229, 36392, 36795, 38449]);
    if (extensions) {
      for (const name of extensions) {
        const extension = gl.getExtension(name);
        if (!extension) {
          unsupportedExtensions.push(name);
          continue;
        }
        const keys = Object.keys(Object.getPrototypeOf(extension) || {});
        for (const constant of keys) {
          if (!/^[A-Z0-9_x]+$/.test(constant)) continue;
          const code = extension[constant];
          extensionParameters.push(
            constant + '=' + code + (validExtensionParams.has(code) ? '=' + gl.getParameter(code) : '')
          );
        }
      }
    }
    extensionParameters.sort();
    webGlExtensions = {
      extensionsLen: extensions?.length ?? 0,
      unsupportedExtensions,
      extensionParametersSample: extensionParameters.slice(0, 12),
      extensionParametersLen: extensionParameters.length,
    };
  }

  // --- OfflineAudio sampleRate (FPJS uses 44100) ---
  let offlineAudio = null;
  try {
    const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ctx = new AC(1, 5000, 44100);
    offlineAudio = { sampleRate: ctx.sampleRate, length: ctx.length, channels: ctx.numberOfChannels };
  } catch (e) {
    offlineAudio = { err: String(e) };
  }

  // --- architecture (x86 NaN sign) ---
  const f = new Float32Array(1);
  const u8 = new Uint8Array(f.buffer);
  f[0] = Infinity;
  f[0] = f[0] - f[0];
  const architecture = u8[3];

  // --- native toString (iframe clean) ---
  let iframeNative = null;
  try {
    const ifr = document.createElement('iframe');
    ifr.style.display = 'none';
    document.body.appendChild(ifr);
    const w = ifr.contentWindow;
    const clean = w.Function.prototype.toString;
    iframeNative = {
      opn: clean.call(Object.getOwnPropertyNames),
      keys: clean.call(Object.keys),
      eval: clean.call(eval),
      opnNative: /\\[native code\\]/.test(clean.call(Object.getOwnPropertyNames)),
      evalNative: /\\[native code\\]/.test(clean.call(eval)),
      keysNative: /\\[native code\\]/.test(clean.call(Object.keys)),
    };
    ifr.remove();
  } catch (e) {
    iframeNative = { err: String(e) };
  }

  const allPrefsSame = Object.values(fontPreferences).every(
    (v, _, arr) => Math.abs(v - arr[0]) < 0.01
  );

  return {
    fonts: {
      baseWidths: defaultWidth,
      baseHeights: defaultHeight,
      detected: detectedFonts,
      detectedCount: detectedFonts.length,
    },
    fontPreferences,
    fontPreferencesAllEqual: allPrefsSame,
    webGlBasics,
    webGlExtensions,
    offlineAudio,
    architecture,
    iframeNative,
    checks: {
      fontsDetected: detectedFonts.length >= 3,
      fontPrefsDiffer: !allPrefsSame && fontPreferences.mono > 0,
      noUnsupportedExt: (webGlExtensions?.unsupportedExtensions?.length ?? 99) === 0,
      webgl1Version: !!webGlBasics?.version?.startsWith('WebGL 1.0'),
      offline44100: offlineAudio?.sampleRate === 44100,
      architecture127: architecture === 127,
      iframeOpnNative: !!iframeNative?.opnNative,
      iframeEvalNative: !!iframeNative?.evalNative,
      iframeKeysNative: !!iframeNative?.keysNative,
    },
  };
})()`;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const out = { profile: "chrome-local-huys-macbook-pro", maxSec: parseMaxSecArg(argv, 20) };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--profile") out.profile = argv[++i];
  }
  return out;
}

async function freePort() {
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
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}, sessionId, timeoutMs = 15000) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const o = { id, method, params };
      if (sessionId) o.sessionId = sessionId;
      this.ws.send(JSON.stringify(o));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error("timeout " + method));
        }
      }, timeoutMs);
    });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(VELORA_BIN)) {
    console.error("missing binary:", VELORA_BIN);
    process.exit(2);
  }
  mkdirSync(OUT, { recursive: true });
  const port = await freePort();
  let proc = null;
  const cleanup = () => killProcess(proc);
  const budget = createProbeBudget(args.maxSec, cleanup);

  proc = spawn(
    VELORA_BIN,
    [
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--browser-profile",
      args.profile,
      "--log-level",
      "warn",
    ],
    { cwd: REPO, stdio: "ignore" },
  );

  let failed = 0;
  try {
    await waitCdp(`http://127.0.0.1:${port}`, budget.deadline);
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.once("open", res);
      ws.once("error", rej);
    });
    const cdp = new Cdp(ws);
    await cdp.send("Target.setDiscoverTargets", { discover: true }).catch(() => {});
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);
    await delay(200);
    await cdp.send("Page.navigate", { url: "https://example.com/" }, sessionId);
    await delay(2000);
    const r = await cdp.send(
      "Runtime.evaluate",
      { expression: EXPR, returnByValue: true },
      sessionId,
    );
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || "eval failed");
    const v = r.result?.value;
    writeFileSync(join(OUT, "REPORT.json"), JSON.stringify(v, null, 2));
    console.log(JSON.stringify(v, null, 2));
    console.log("\n=== CHECKS ===");
    for (const [k, ok] of Object.entries(v.checks || {})) {
      const mark = ok ? "OK" : "FAIL";
      console.log(`[${mark}] ${k}`, ok);
      if (!ok) failed += 1;
    }
    ws.close();
  } catch (e) {
    console.error("[ERROR]", e);
    failed += 1;
  } finally {
    budget.clear();
    cleanup();
  }
  if (failed > 0) {
    console.error(`[DONE] ${failed} check(s) failed`);
    process.exit(1);
  }
  console.log("[DONE] all FPJS parity checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
