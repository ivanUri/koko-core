#!/usr/bin/env node
/**
 * capture-fingerprint.js
 *
 * Kết nối Chrome đang mở (qua CDP) và export toàn bộ fingerprint surface
 * ra một thư mục fingerprint tự chứa của Velora.
 *
 * Cách dùng:
 *   1. Mở Chrome với remote debugging:
 *      /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
 *        --remote-debugging-port=9222 --no-first-run --user-data-dir=/tmp/chrome-probe
 *
 *   2. Chạy script:
 *      node scripts/capture-fingerprint.js [profile-id] [cdp-url]
 *
 *      Ví dụ:
 *      node scripts/capture-fingerprint.js chrome-windows-11 http://127.0.0.1:9222
 *
 *   3. Output sẽ nằm trong:
 *      browser/fingerprints/{profile-id}/fingerprint.json
 *      browser/fingerprints/{profile-id}/assets/...
 *
 * Yêu cầu: Node.js 18+ (WebSocket built-in từ Node 21+, dùng ws lib cho Node cũ hơn).
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");

// ─── Config ──────────────────────────────────────────────────────────────────

const PROFILE_ID = process.argv[2] || "chrome-probe";
const CDP_HTTP   = (process.argv[3] || "http://127.0.0.1:9222").replace(/\/+$/, "");
const VELORA_ROOT = path.resolve(__dirname, "..");
const FINAL_DIR  = path.join(VELORA_ROOT, "browser", "fingerprints", PROFILE_ID);
const OUT_DIR    = `${FINAL_DIR}.staging-${process.pid}`;
const ASSETS_DIR = path.join(OUT_DIR, "assets");

// ─── WebSocket — hỗ trợ cả Node built-in (browser API) lẫn gói ws ────────────

function getWS() {
  // Node 21+ có globalThis.WebSocket nhưng dùng browser EventTarget API
  if (typeof globalThis.WebSocket !== "undefined") return { cls: globalThis.WebSocket, browserApi: true };
  try { return { cls: require("ws"), browserApi: false }; } catch { return null; }
}

// ─── CDP helpers ─────────────────────────────────────────────────────────────

function cdpFetch(urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`${CDP_HTTP}${urlPath}`, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

function connectCDP(wsUrl) {
  return new Promise((resolve, reject) => {
    const wsInfo = getWS();
    if (!wsInfo) {
      return reject(new Error(
        "Không có WebSocket. Cài: npm install ws\n" +
        "Hoặc dùng Node.js 22+"
      ));
    }
    const { cls: WS, browserApi } = wsInfo;
    const ws = new WS(wsUrl);
    let idCounter = 1;
    const pending = new Map();

    const client = {
      send(method, params = {}) {
        const id = idCounter++;
        return new Promise((res, rej) => {
          pending.set(id, { res, rej });
          ws.send(JSON.stringify({ id, method, params }));
        });
      },
      close() { ws.close(); },
    };

    function onMessage(raw) {
      const data = typeof raw === "string" ? raw
        : raw.data !== undefined ? raw.data   // browser MessageEvent
        : raw.toString();
      const msg = JSON.parse(data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
      }
    }

    if (browserApi) {
      // Node 21+ built-in WebSocket: browser EventTarget API
      ws.addEventListener("open", () => resolve(client));
      ws.addEventListener("message", onMessage);
      ws.addEventListener("error", (e) => reject(new Error(e.message || "WebSocket error")));
    } else {
      // ws npm package: Node EventEmitter API
      ws.on("open", () => resolve(client));
      ws.on("message", onMessage);
      ws.on("error", reject);
    }
  });
}

async function evalJS(cdp, expression) {
  const res = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    timeout: 20000,
  });
  if (res.exceptionDetails) {
    const msg = res.exceptionDetails.exception?.description || JSON.stringify(res.exceptionDetails);
    throw new Error(msg);
  }
  return res.result?.value ?? null;
}

// ─── Probe scripts ────────────────────────────────────────────────────────────

const SCRIPTS = {

navigator: `(() => {
  const n = navigator;
  return {
    userAgent: n.userAgent,
    platform: n.platform,
    languages: Array.from(n.languages),
    hardwareConcurrency: n.hardwareConcurrency,
    deviceMemory: n.deviceMemory ?? null,
    maxTouchPoints: n.maxTouchPoints,
    vendor: n.vendor,
    pdfViewerEnabled: n.pdfViewerEnabled ?? null,
    appVersion: n.appVersion,
    cookieEnabled: n.cookieEnabled,
    doNotTrack: n.doNotTrack,
    onLine: n.onLine,
  };
})()`,

uaData: `(async () => {
  if (!navigator.userAgentData) return null;
  const ua = navigator.userAgentData;
  const high = await ua.getHighEntropyValues([
    "platform","platformVersion","architecture","bitness",
    "model","uaFullVersion","fullVersionList","formFactors","wow64"
  ]).catch(() => ({}));
  return {
    brands: ua.brands.map(b => ({ brand: b.brand, version: b.version })),
    mobile: ua.mobile,
    platform: ua.platform,
    platformVersion: high.platformVersion ?? "",
    architecture: high.architecture ?? "",
    bitness: high.bitness ?? "",
    model: high.model ?? "",
    uaFullVersion: high.uaFullVersion ?? "",
    fullVersionList: (high.fullVersionList ?? []).map(b => ({ brand: b.brand, version: b.version })),
    formFactors: high.formFactors ?? [],
    wow64: high.wow64 ?? false,
    prefersColorScheme: window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  };
})()`,

screen: `(() => {
  const s = screen;
  return {
    width: s.width, height: s.height,
    availWidth: s.availWidth, availHeight: s.availHeight,
    devicePixelRatio: window.devicePixelRatio,
    colorDepth: s.colorDepth, pixelDepth: s.pixelDepth,
    touch: navigator.maxTouchPoints > 0,
    isExtended: s.isExtended ?? null,
    orientation: s.orientation ? { type: s.orientation.type, angle: s.orientation.angle } : null,
  };
})()`,

window: `(() => ({
  innerWidth: window.innerWidth, innerHeight: window.innerHeight,
  outerWidth: window.outerWidth, outerHeight: window.outerHeight,
  screenX: window.screenX, screenY: window.screenY,
}))()`,

timezone: `(() => ({
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  locale: Intl.DateTimeFormat().resolvedOptions().locale,
  offset: new Date().getTimezoneOffset(),
}))()`,

plugins: `(() => Array.from(navigator.plugins).map(p => ({
  name: p.name, filename: p.filename, description: p.description,
  mimeType: p[0] ? { type: p[0].type, suffixes: p[0].suffixes } : null,
})))()`,

webgl1: `(() => {
  const c = document.createElement("canvas");
  const gl = c.getContext("webgl") || c.getContext("experimental-webgl");
  if (!gl) return null;
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  const ani = gl.getExtension("EXT_texture_filter_anisotropic");
  const dbo = gl.getExtension("WEBGL_draw_buffers");
  const g = (e) => { try { return gl.getParameter(e); } catch { return null; } };
  const exts = gl.getSupportedExtensions() || [];
  for (const e of exts) gl.getExtension(e);
  const prec = {};
  for (const sType of ["VERTEX_SHADER","FRAGMENT_SHADER"]) {
    prec[sType] = {};
    for (const p of ["LOW_FLOAT","MEDIUM_FLOAT","HIGH_FLOAT","LOW_INT","MEDIUM_INT","HIGH_INT"]) {
      try {
        const f = gl.getShaderPrecisionFormat(gl[sType], gl[p]);
        prec[sType][p] = f ? { rangeMin: f.rangeMin, rangeMax: f.rangeMax, precision: f.precision } : null;
      } catch {}
    }
  }
  return {
    version: g(gl.VERSION), vendor: g(gl.VENDOR), renderer: g(gl.RENDERER),
    shadingLanguageVersion: g(gl.SHADING_LANGUAGE_VERSION),
    unmaskedVendor: dbg ? g(dbg.UNMASKED_VENDOR_WEBGL) : null,
    unmaskedRenderer: dbg ? g(dbg.UNMASKED_RENDERER_WEBGL) : null,
    maxTextureSize: g(gl.MAX_TEXTURE_SIZE),
    maxCubeMapTextureSize: g(gl.MAX_CUBE_MAP_TEXTURE_SIZE),
    maxRenderbufferSize: g(gl.MAX_RENDERBUFFER_SIZE),
    maxVertexAttribs: g(gl.MAX_VERTEX_ATTRIBS),
    maxVertexUniformVectors: g(gl.MAX_VERTEX_UNIFORM_VECTORS),
    maxVaryingVectors: g(gl.MAX_VARYING_VECTORS),
    maxCombinedTextureImageUnits: g(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS),
    maxVertexTextureImageUnits: g(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS),
    maxTextureImageUnits: g(gl.MAX_TEXTURE_IMAGE_UNITS),
    maxFragmentUniformVectors: g(gl.MAX_FRAGMENT_UNIFORM_VECTORS),
    maxDrawBuffers: dbo ? g(dbo.MAX_DRAW_BUFFERS_WEBGL) : null,
    maxTextureMaxAnisotropy: ani ? g(ani.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : null,
    maxViewportDims: Array.from(g(gl.MAX_VIEWPORT_DIMS) || []),
    aliasedLineWidthRange: Array.from(g(gl.ALIASED_LINE_WIDTH_RANGE) || []),
    aliasedPointSizeRange: Array.from(g(gl.ALIASED_POINT_SIZE_RANGE) || []),
    extensions: exts,
    shaderPrecision: prec,
  };
})()`,

webgl2: `(() => {
  const c = document.createElement("canvas");
  const gl = c.getContext("webgl2");
  if (!gl) return null;
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  const g = (e) => { try { return gl.getParameter(e); } catch { return null; } };
  return {
    version: g(gl.VERSION), vendor: g(gl.VENDOR), renderer: g(gl.RENDERER),
    unmaskedVendor: dbg ? g(dbg.UNMASKED_VENDOR_WEBGL) : null,
    unmaskedRenderer: dbg ? g(dbg.UNMASKED_RENDERER_WEBGL) : null,
    maxColorAttachments: g(gl.MAX_COLOR_ATTACHMENTS),
    maxDrawBuffers: g(gl.MAX_DRAW_BUFFERS),
    maxSamples: g(gl.MAX_SAMPLES),
    max3dTextureSize: g(gl.MAX_3D_TEXTURE_SIZE),
    maxArrayTextureLayers: g(gl.MAX_ARRAY_TEXTURE_LAYERS),
    maxTextureSize: g(gl.MAX_TEXTURE_SIZE),
    maxVertexUniformVectors: g(gl.MAX_VERTEX_UNIFORM_VECTORS),
    maxFragmentUniformVectors: g(gl.MAX_FRAGMENT_UNIFORM_VECTORS),
    extensions: gl.getSupportedExtensions() || [],
  };
})()`,

canvas: `(() => {
  const results = [];
  function probe(w, h, fn) {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    fn(ctx, w, h);
    results.push({ width: w, height: h, dataUrl: c.toDataURL() });
  }
  // Probe 1: text + rect
  probe(280, 60, (ctx) => {
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#f60"; ctx.fillRect(125, 1, 62, 20);
    ctx.fillStyle = "#069"; ctx.font = "11pt no-real-font-kqvmmdmm";
    ctx.fillText("Cwm fjordbank glyphs vext quiz 😂", 2, 15);
    ctx.fillStyle = "rgba(102,204,0,0.7)"; ctx.font = "18pt Arial";
    ctx.fillText("Cwm fjordbank glyphs vext quiz 😂", 4, 45);
  });
  // Probe 2: emoji color-mix
  probe(100, 100, (ctx) => {
    ctx.globalCompositeOperation = "multiply";
    ["#f2f","#0ff","#ff0"].forEach((c, i) => {
      ctx.fillStyle = c; ctx.beginPath();
      ctx.arc(40+i*15, 40+i*10, 30, 0, Math.PI*2); ctx.fill();
    });
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#000"; ctx.font = "20px Arial";
    ctx.fillText("🌈👾", 10, 90);
  });
  // Probe 3: gradient + shadow
  probe(220, 30, (ctx) => {
    const g = ctx.createLinearGradient(0, 0, 220, 0);
    g.addColorStop(0, "rgb(255,0,0)"); g.addColorStop(.5, "rgb(0,255,0)"); g.addColorStop(1, "rgb(0,0,255)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, 220, 30);
    ctx.shadowBlur = 4; ctx.shadowColor = "rgba(0,0,0,0.5)";
    ctx.fillStyle = "#fff"; ctx.font = "bold 14px Georgia";
    ctx.fillText("velora probe", 10, 20);
  });
  return results;
})()`,

audio: `(async () => {
  try {
    const ctx = new OfflineAudioContext(1, 44100, 44100);
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(10000, ctx.currentTime);
    const comp = ctx.createDynamicsCompressor();
    osc.connect(comp); comp.connect(ctx.destination);
    osc.start(0); osc.stop(ctx.currentTime + 0.1);
    const buf = await ctx.startRendering();
    return {
      sampleRate: buf.sampleRate,
      length: buf.length,
      numberOfChannels: buf.numberOfChannels,
      samples: Array.from(buf.getChannelData(0).slice(4500, 4600)),
    };
  } catch(e) { return { error: e.message }; }
})()`,

fonts: `(async () => {
  // Local Font Access is Chrome's authoritative view of installed font faces.
  // Preserve family, full face name, and PostScript name because CSS local()
  // accepts any of them. The canvas candidate probe remains a portable
  // fallback for browsers/origins where local-fonts permission is unavailable.
  if (typeof queryLocalFonts === "function") {
    try {
      const entries = await queryLocalFonts();
      const names = new Set();
      for (const entry of entries) {
        for (const name of [entry.family, entry.fullName, entry.postscriptName]) {
          if (typeof name === "string" && name.trim()) names.add(name.trim());
        }
      }
      if (names.size) return Array.from(names).sort((a, b) => a.localeCompare(b));
    } catch (error) {
      console.warn("Local Font Access unavailable; using candidate fallback:", error?.message || error);
    }
  }
  const list = [
    "-apple-system","BlinkMacSystemFont","system-ui","Helvetica Neue","Helvetica",
    "Arial","Arial Black","Georgia","Times New Roman","Courier New","Verdana",
    "Trebuchet MS","Impact","Comic Sans MS","Palatino","Garamond","Bookman",
    "Avant Garde","Optima","Gill Sans","Futura","American Typewriter",
    "Baskerville","Didot","Hoefler Text","Lucida Grande","Geneva","Monaco",
    "Menlo","SF Pro Display","SF Pro Text","New York","Luminari","Zapfino",
    "Chalkboard","Chalkboard SE","Marker Felt","Snell Roundhand",
    "Apple Color Emoji","Apple SD Gothic Neo","PingFang SC","PingFang TC",
    "PingFang HK","Hiragino Sans","Hiragino Mincho ProN",
    "Segoe UI","Segoe UI Semibold","Segoe UI Light","Segoe UI Symbol",
    "Segoe Print","Segoe Script","Calibri","Cambria","Candara","Consolas",
    "Constantia","Corbel","Franklin Gothic Medium","Gabriola","Bahnschrift",
    "Leelawadee UI","Malgun Gothic","Microsoft JhengHei","Microsoft YaHei",
    "NSimSun","SimSun","MingLiU-ExtB","MS Gothic","MS Mincho",
    "Yu Gothic","Ebrima","Gadugi","Javanese Text","Nirmala UI",
    "Sylfaen","Traditional Arabic","Wingdings","Wingdings 2","Wingdings 3",
    "Webdings","Symbol","Tahoma",
    "Ubuntu","Liberation Sans","Liberation Serif","Liberation Mono",
    "DejaVu Sans","DejaVu Serif","DejaVu Sans Mono","Noto Sans","Noto Serif",
    "Noto Mono","Roboto","Droid Sans","Droid Serif","Droid Sans Mono",
    "FreeSans","FreeSerif","FreeMono","Cantarell","Open Sans","Lato",
    "sans-serif","serif","monospace","cursive","fantasy",
  ];
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d");
  const s = "mmmmmmmmmmlli";
  const bases = ["monospace","sans-serif","serif"];
  const bw = {};
  for (const b of bases) { ctx.font = "72px " + b; bw[b] = ctx.measureText(s).width; }
  return list.filter(f => bases.some(b => {
    ctx.font = "72px '" + f + "', " + b;
    return ctx.measureText(s).width !== bw[b];
  }));
})()`,

measureText: `(() => {
  const fonts = [
    "-apple-system",".AppleSystemUIFont","system-ui","Arial","Helvetica",
    "Times New Roman","Courier New","Georgia","Verdana","Menlo","Monaco",
    "Calibri","Segoe UI","Tahoma","Impact","Comic Sans MS",
    "sans-serif","serif","monospace",
  ];
  const texts = [
    "","velora","😀","mmmmmmmmmmlli",
    "Cwm fjordbank glyphs vext quiz","👾",
    "The quick brown fox","0123456789",
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  ];
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d");
  ctx.textBaseline = "alphabetic";
  return fonts.flatMap(family => {
    ctx.font = "16px " + family;
    return texts.map(text => {
      const m = ctx.measureText(text);
      return {
        family, text,
        width: m.width,
        actualBoundingBoxLeft: m.actualBoundingBoxLeft,
        actualBoundingBoxRight: m.actualBoundingBoxRight,
        actualBoundingBoxAscent: m.actualBoundingBoxAscent,
        actualBoundingBoxDescent: m.actualBoundingBoxDescent,
        fontBoundingBoxAscent: m.fontBoundingBoxAscent,
        fontBoundingBoxDescent: m.fontBoundingBoxDescent,
      };
    });
  });
})()`,

voices: `(async () => {
  let voices = speechSynthesis.getVoices();
  if (!voices.length) {
    await new Promise(r => { speechSynthesis.onvoiceschanged = r; setTimeout(r, 2500); });
    voices = speechSynthesis.getVoices();
  }
  return voices.map(v => ({
    name: v.name, lang: v.lang, voiceURI: v.voiceURI,
    default: v.default, localService: v.localService,
  }));
})()`,

windowKeys: `(() => { const keys = []; for (const k in window) keys.push(k); return keys; })()`,

navigatorKeys: `(() => { const keys = []; for (const k in navigator) keys.push(k); return keys; })()`,

htmlElementKeys: `(() => { const el = document.createElement("div"); const keys = []; for (const k in el) keys.push(k); return keys; })()`,

cssKeys: `(() => {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const s = window.getComputedStyle(el);
  const enumerable = []; for (const k in s) enumerable.push(k);
  const ownNames = Object.getOwnPropertyNames(s);
  document.body.removeChild(el);
  return { enumerable, ownNames };
})()`,

maths: `(() => {
  const ops = [
    ["sin",[.5]],["cos",[.5]],["tan",[.5]],["asin",[.5]],["acos",[.5]],
    ["atan",[.5]],["atan2",[1,2]],["sinh",[1]],["cosh",[1]],["tanh",[1]],
    ["asinh",[1]],["acosh",[1.5]],["atanh",[.5]],["exp",[1]],["expm1",[1]],
    ["log",[2]],["log2",[3]],["log10",[1000]],["sqrt",[2]],["cbrt",[8]],
    ["pow",[2,.1]],["hypot",[3,4]],["imul",[0xffffffff,5]],
    ["clz32",[1000]],["round",[.5]],["trunc",[-3.7]],["fround",[1.337]],
  ];
  return ops.map(([fn, args]) => {
    let r; try { r = Math[fn](...args); } catch { r = null; }
    return { fn, args, result: r };
  });
})()`,

clientRects: `(() => {
  const el = document.createElement("div");
  el.style.cssText = "position:fixed;top:0;left:0;width:200px;height:100px;font-size:16px;font-family:Arial";
  el.textContent = "Velora fingerprint probe";
  document.body.appendChild(el);
  const r = el.getBoundingClientRect();
  const cr = Array.from(el.getClientRects()).map(x => ({
    x: x.x, y: x.y, width: x.width, height: x.height,
  }));
  document.body.removeChild(el);
  return { rect: { x: r.x, y: r.y, width: r.width, height: r.height }, clientRects: cr };
})()`,

svg: `(() => {
  try {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    Object.assign(svg.style, { position:"fixed", top:"0", left:"0" });
    svg.setAttribute("width","200"); svg.setAttribute("height","100");
    document.body.appendChild(svg);
    const t = document.createElementNS(ns, "text");
    t.setAttribute("x","10"); t.setAttribute("y","50");
    t.setAttribute("font-family","Arial"); t.setAttribute("font-size","20");
    t.textContent = "Velora";
    svg.appendChild(t);
    const b = t.getBBox();
    const len = t.getComputedTextLength();
    document.body.removeChild(svg);
    return { x: b.x, y: b.y, width: b.width, height: b.height, computedTextLength: len };
  } catch(e) { return { error: e.message }; }
})()`,

webgpu: `(async () => {
  if (!navigator.gpu) return null;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { available: false };
    const info = adapter.info || await (adapter.requestAdapterInfo?.()) || {};
    const features = adapter.features ? Array.from(adapter.features) : [];
    const limits = {};
    if (adapter.limits) {
      try {
        const proto = Object.getPrototypeOf(adapter.limits);
        for (const k of Object.getOwnPropertyNames(proto)) {
          if (k !== "constructor") { try { limits[k] = adapter.limits[k]; } catch {} }
        }
      } catch {}
    }
    return {
      available: true,
      vendor: info.vendor ?? null,
      architecture: info.architecture ?? null,
      device: info.device ?? null,
      description: info.description ?? null,
      isFallbackAdapter: adapter.isFallbackAdapter ?? null,
      features,
      limits,
    };
  } catch(e) { return { error: e.message }; }
})()`,

mediaDevices: `(async () => {
  if (!navigator.mediaDevices) return null;
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    return devs.map(d => ({
      kind: d.kind,
      label: d.label || "",
      deviceId: d.deviceId ? d.deviceId.slice(0,8)+"..." : "",
      groupId: d.groupId ? d.groupId.slice(0,8)+"..." : "",
    }));
  } catch(e) { return { error: e.message }; }
})()`,

battery: `(async () => {
  if (!navigator.getBattery) return null;
  try {
    const b = await navigator.getBattery();
    return { charging: b.charging, chargingTime: b.chargingTime, dischargingTime: b.dischargingTime, level: b.level };
  } catch(e) { return { error: e.message }; }
})()`,

bluetooth: `(async () => {
  if (!navigator.bluetooth) return { available: false };
  try {
    const a = await navigator.bluetooth.getAvailability();
    return { available: a };
  } catch(e) { return { available: false, error: e.message }; }
})()`,

};

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n🔍 Velora Fingerprint Capture");
  console.log(`   Profile : ${PROFILE_ID}`);
  console.log(`   CDP     : ${CDP_HTTP}`);
  console.log(`   Output  : ${OUT_DIR}\n`);

  // Get page targets
  const targets = await cdpFetch("/json/list");
  const pages = (Array.isArray(targets) ? targets : [])
    .filter(t => t.type === "page" && t.webSocketDebuggerUrl);
  if (!pages.length) {
    throw new Error(
      "Không tìm thấy page target.\n" +
      "Đảm bảo Chrome đang chạy với --remote-debugging-port=9222"
    );
  }
  const target = pages[0];
  console.log(`📌 Target : ${target.title || "(no title)"}`);
  console.log(`   URL    : ${target.url}\n`);

  const cdp = await connectCDP(target.webSocketDebuggerUrl);

  // queryLocalFonts() requires an explicit local-fonts permission on a secure
  // origin. localhost is secure-context eligible; grant only for the current
  // capture target and leave non-HTTP targets on the portable fallback.
  try {
    const captureOrigin = new URL(target.url).origin;
    if (captureOrigin !== "null") {
      await cdp.send("Browser.grantPermissions", {
        origin: captureOrigin,
        permissions: ["localFonts"],
      });
    }
  } catch (error) {
    console.warn(`  ⚠️  local-fonts permission: ${error.message}`);
  }

  const results = {};
  const run = async (key, label) => {
    process.stdout.write(`  Probing ${label}... `);
    try {
      results[key] = await evalJS(cdp, SCRIPTS[key]);
      console.log("✅");
    } catch (e) {
      results[key] = null;
      console.log(`⚠️  ${e.message.slice(0, 100)}`);
    }
  };

  console.log("⚡ Running probes:\n");

  // Run sequentially to avoid overloading the tab
  await run("navigator",        "navigator");
  await run("uaData",           "userAgentData (high-entropy)");
  await run("screen",           "screen");
  await run("window",           "window dimensions");
  await run("timezone",         "timezone / locale");
  await run("plugins",          "navigator.plugins");
  await run("webgl1",           "WebGL 1.0");
  await run("webgl2",           "WebGL 2.0");
  await run("canvas",           "canvas probes (3x)");
  await run("audio",            "audio fingerprint");
  await run("fonts",            "font detection");
  await run("measureText",      "measureText baseline");
  await run("voices",           "speech synthesis voices");
  await run("windowKeys",       "window property keys");
  await run("navigatorKeys",    "navigator property keys");
  await run("htmlElementKeys",  "HTMLElement property keys");
  await run("cssKeys",          "CSS computed keys");
  await run("maths",            "Math baselines");
  await run("clientRects",      "client rects");
  await run("svg",              "SVG baseline");
  await run("webgpu",           "WebGPU adapter info");
  await run("mediaDevices",     "media devices");
  await run("battery",          "battery");
  await run("bluetooth",        "bluetooth");

  cdp.close();

  // ─── Write assets ───────────────────────────────────────────────────────
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
  console.log(`\n💾 Writing files to ${OUT_DIR}\n`);

  const px = PROFILE_ID;
  const assetRef = {}; // tracks which asset files were written

  function writeAsset(name, data, pretty = false) {
    const file = `${px}-${name}`;
    const fullPath = path.join(ASSETS_DIR, file);
    fs.writeFileSync(fullPath, pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data), "utf8");
    console.log(`  ✅ assets/${file}`);
    assetRef[name] = `assets/${file}`;
    return `assets/${file}`;
  }

  if (results.audio)            writeAsset("audio-probe.json", results.audio, true);
  if (results.fonts)            writeAsset("fonts.json", results.fonts, true);
  if (results.measureText)      writeAsset("measuretext.json", results.measureText);
  if (results.voices)           writeAsset("voices.json", results.voices, true);
  if (results.webgl1)           writeAsset("webgl-probe.json", results.webgl1, true);
  if (results.windowKeys)       writeAsset("window-keys.json", results.windowKeys, true);
  if (results.navigatorKeys)    writeAsset("navigator-keys.json", results.navigatorKeys, true);
  if (results.htmlElementKeys)  writeAsset("html-element-keys.json", results.htmlElementKeys, true);
  if (results.cssKeys) {
    writeAsset("css-enumerable-keys.json", {
      indexed: results.cssKeys.enumerable.filter((key) => /^\d+$/.test(key)),
      named: results.cssKeys.enumerable.filter((key) => !/^\d+$/.test(key)),
    }, true);
    writeAsset("css-computed-keys.json", results.cssKeys.ownNames, true);
  }
  if (results.maths)            writeAsset("maths-baseline.json", results.maths.map((entry) => ({
    method: entry.fn,
    args: entry.args,
    result: entry.result,
  })), true);
  if (results.clientRects)      writeAsset("client-rects.json", results.clientRects, true);
  if (results.svg)              writeAsset("svg-baseline.json", results.svg, true);
  if (results.webgpu)           writeAsset("webgpu.json", results.webgpu, true);
  if (results.mediaDevices)     writeAsset("media-devices.json", results.mediaDevices, true);

  // ─── Build fingerprint.json ─────────────────────────────────────────────
  const fp = {
    version: 1,
    id: PROFILE_ID,
    mode: "antidetect",
    capturedAt: new Date().toISOString(),
    capturedFrom: target.url,

    // Transport — fill in manually based on UA
    transport: {
      impersonate: (() => {
        const ua = results.navigator?.userAgent || "";
        const chrome = ua.match(/Chrome\/(\d+)/);
        if (chrome) return `chrome${chrome[1]}`;
        const ff = ua.match(/Firefox\/(\d+)/);
        if (ff) return `firefox${ff[1]}`;
        if (ua.includes("Safari") && !ua.includes("Chrome")) return "safari260";
        return "chrome146";
      })(),
    },

    navigator: results.navigator ? {
      userAgent: results.navigator.userAgent,
      platform: results.navigator.platform,
      languages: results.navigator.languages,
      hardwareConcurrency: results.navigator.hardwareConcurrency,
      deviceMemory: results.navigator.deviceMemory,
      maxTouchPoints: results.navigator.maxTouchPoints,
      vendor: results.navigator.vendor,
      pdfViewerEnabled: results.navigator.pdfViewerEnabled,
      appVersion: results.navigator.appVersion,
    } : undefined,

    userAgentData: results.uaData || undefined,

    plugins: (results.plugins || []).map((plugin) => ({
      name: plugin.name,
      filename: plugin.filename,
      description: plugin.description,
      mimeType: plugin.mimeType?.type || "",
      mimeSuffixes: plugin.mimeType?.suffixes || "",
    })),

    screen: results.screen || undefined,
    window: results.window || undefined,
    timezone: results.timezone?.timezone || "UTC",
    locale: results.timezone?.locale || "en-US",
    timezoneOffset: results.timezone?.offset ?? 0,

    webgl: results.webgl1 ? {
      version: results.webgl1.version,
      vendor: results.webgl1.vendor,
      renderer: results.webgl1.renderer,
      shadingLanguageVersion: results.webgl1.shadingLanguageVersion,
      unmaskedVendor: results.webgl1.unmaskedVendor,
      unmaskedRenderer: results.webgl1.unmaskedRenderer,
      maxTextureSize: results.webgl1.maxTextureSize,
      maxCubeMapTextureSize: results.webgl1.maxCubeMapTextureSize,
      maxRenderbufferSize: results.webgl1.maxRenderbufferSize,
      maxVertexAttribs: results.webgl1.maxVertexAttribs,
      maxVertexUniformVectors: results.webgl1.maxVertexUniformVectors,
      maxVaryingVectors: results.webgl1.maxVaryingVectors,
      maxCombinedTextureImageUnits: results.webgl1.maxCombinedTextureImageUnits,
      maxVertexTextureImageUnits: results.webgl1.maxVertexTextureImageUnits,
      maxTextureImageUnits: results.webgl1.maxTextureImageUnits,
      maxFragmentUniformVectors: results.webgl1.maxFragmentUniformVectors,
      maxDrawBuffers: results.webgl1.maxDrawBuffers,
      maxTextureMaxAnisotropy: results.webgl1.maxTextureMaxAnisotropy,
      maxViewportDims: results.webgl1.maxViewportDims,
      aliasedLineWidthRange: results.webgl1.aliasedLineWidthRange,
      aliasedPointSizeRange: results.webgl1.aliasedPointSizeRange,
      extensions: results.webgl1.extensions,
      extensions2: results.webgl2?.extensions || [],
      shaderPrecision: results.webgl1.shaderPrecision,
    } : undefined,

    // Asset pointers
    audioProbe: results.audio ? {
      dataFile: assetRef["audio-probe.json"],
    } : undefined,

    fontsFile: assetRef["fonts.json"],

    speechVoicesFile: assetRef["voices.json"],

    measureTextBaseline: results.measureText ? {
      dataFile: assetRef["measuretext.json"],
    } : undefined,

    webglProbe: results.webgl1 ? {
      dataFile: assetRef["webgl-probe.json"],
    } : undefined,

    windowKeys: results.windowKeys ? {
      dataFile: assetRef["window-keys.json"],
    } : undefined,

    navigatorKeys: results.navigatorKeys ? {
      dataFile: assetRef["navigator-keys.json"],
    } : undefined,

    htmlElementKeys: results.htmlElementKeys ? {
      dataFile: assetRef["html-element-keys.json"],
    } : undefined,

    cssComputedKeys: results.cssKeys ? {
      enumerableKeysFile: assetRef["css-enumerable-keys.json"],
      dataFile: assetRef["css-computed-keys.json"],
    } : undefined,

    mathsBaseline: results.maths ? {
      dataFile: assetRef["maths-baseline.json"],
    } : undefined,

    clientRectsBaseline: results.clientRects ? {
      dataFile: assetRef["client-rects.json"],
    } : undefined,

    svgBaseline: results.svg ? {
      dataFile: assetRef["svg-baseline.json"],
    } : undefined,

    // Extra fields (not yet implemented in Velora engine — reserved for future)
    _future: {
      webgpu: results.webgpu,
      webgl2: results.webgl2,
      mediaDevices: results.mediaDevices,
      battery: results.battery,
      bluetooth: results.bluetooth,
      screenIsExtended: results.screen?.isExtended ?? null,
      wow64: results.uaData?.wow64 ?? null,
      formFactors: results.uaData?.formFactors ?? [],
    },
  };

  const fpPath = path.join(OUT_DIR, "fingerprint.json");
  fs.writeFileSync(fpPath, JSON.stringify(fp, null, 2), "utf8");
  console.log(`\n  ✅ fingerprint.json`);

  fs.rmSync(FINAL_DIR, { recursive: true, force: true });
  fs.renameSync(OUT_DIR, FINAL_DIR);
  console.log(`  ✅ published atomically to ${FINAL_DIR}`);

  console.log("\n✅ Done!\n");
  if (results.fonts)          console.log(`   Fonts detected   : ${results.fonts.length}`);
  if (results.voices)         console.log(`   Speech voices    : ${results.voices.length}`);
  if (results.windowKeys)     console.log(`   Window keys      : ${results.windowKeys.length}`);
  if (results.cssKeys)        console.log(`   CSS computed     : ${results.cssKeys.ownNames.length}`);
  if (results.webgpu?.available) console.log(`   WebGPU vendor    : ${results.webgpu.vendor || "?"}`);
  if (results.uaData)         console.log(`   formFactors      : ${JSON.stringify(results.uaData.formFactors)}`);
  if (results.uaData)         console.log(`   wow64            : ${results.uaData.wow64}`);
  console.log();
}

main().catch((e) => {
  console.error("\n❌ Error:", e.message);
  if (e.message.includes("ECONNREFUSED") || e.message.includes("WebSocket")) {
    console.error(`
Khởi động Chrome với remote debugging:

  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome \\
    --remote-debugging-port=9222 \\
    --no-first-run \\
    --user-data-dir=/tmp/chrome-probe

Sau đó mở 1 tab bất kỳ rồi chạy lại script.
`);
  }
  process.exitCode = 1;
});
