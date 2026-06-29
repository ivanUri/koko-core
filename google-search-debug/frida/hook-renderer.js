/**
 * Frida — hook fingerprint APIs in Chrome renderer.
 *
 * Usage:
 *   frida -n "Google Chrome Helper (Renderer)" -l google-search-debug/frida/hook-renderer.js
 *   frida -p <PID> -l google-search-debug/frida/hook-renderer.js
 */
"use strict";

const COOLDOWN_MS = 5000;
const lastLog = {};

function shouldLog(key) {
    const now = Date.now();
    if (lastLog[key] && now - lastLog[key] < COOLDOWN_MS) return false;
    lastLog[key] = now;
    return true;
}

function emit(type, detail) {
    const key = `${type}:${detail}`;
    if (!shouldLog(key)) return;
    console.log(JSON.stringify({ t: Date.now(), type, detail }));
}

function hookExport(moduleName, exportName, label) {
    const addr = Module.findExportByName(moduleName, exportName);
    if (!addr) return;
    Interceptor.attach(addr, {
        onEnter() {
            emit("native", label || exportName);
        },
    });
}

// CoreText / font paths (macOS)
if (Process.platform === "darwin") {
    hookExport("CoreText", "CTFontCreateWithNameAndSize", "CTFontCreateWithNameAndSize");
    hookExport("CoreGraphics", "CGContextShowGlyphsAtPositions", "CGContextShowGlyphsAtPositions");
}

// Generic exports sometimes used by Blink canvas
hookExport(null, "glGetIntegerv", "glGetIntegerv");
hookExport(null, "glReadPixels", "glReadPixels");

// ObjC messaging for getBoundingClientRect-style layout (noisy — cooldown helps)
if (ObjC.available) {
    try {
        const UIView = ObjC.classes.UIView;
        if (UIView) {
            // macOS WebKit may not use UIView; guard only
        }
    } catch (_) {}
}

console.log(JSON.stringify({
    t: Date.now(),
    type: "frida",
    detail: `hook-renderer loaded pid=${Process.id} arch=${Process.arch}`,
}));