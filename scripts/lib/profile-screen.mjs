import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Load `screen` + `window` from browser profile JSON. */
export function loadProfileDisplay(repo, profileId) {
    const path = resolve(repo, `browser/templates/${profileId}.json`);
    const profile = JSON.parse(readFileSync(path, "utf8"));
    if (!profile.screen) throw new Error(`profile ${profileId} missing screen`);
    return { screen: profile.screen, window: profile.window ?? {} };
}

/**
 * Pin Chrome viewport to profile window size before creepjs loads.
 */
export async function applyChromeScreenEmulation(cdp, sid, { screen, window }) {
    const viewportW = window.innerWidth ?? screen.width;
    const viewportH = window.innerHeight ?? screen.availHeight ?? screen.height;
    await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: viewportW,
        height: viewportH,
        deviceScaleFactor: screen.devicePixelRatio ?? 1,
        mobile: false,
        screenWidth: screen.width,
        screenHeight: screen.height,
        screenOrientation: { type: "landscapePrimary", angle: 0 },
    }, sid);
}

/**
 * Probe-only: align window.screen with Velora profile (availHeight, colorDepth, …).
 * CDP emulation cannot set Mac menu-bar availHeight or depth 30 on all hosts.
 */
export function buildScreenSpoofScript(screen) {
    const w = screen.width;
    const h = screen.height;
    const aw = screen.availWidth ?? w;
    const ah = screen.availHeight ?? h;
    const cd = screen.colorDepth ?? 24;
    const pd = screen.pixelDepth ?? cd;
    const touch = screen.touch === true;
    return `(() => {
        const defs = {
            width: ${w},
            height: ${h},
            availWidth: ${aw},
            availHeight: ${ah},
            colorDepth: ${cd},
            pixelDepth: ${pd},
        };
        for (const [key, val] of Object.entries(defs)) {
            try {
                Object.defineProperty(window.screen, key, {
                    get: () => val,
                    configurable: true,
                    enumerable: true,
                });
            } catch (e) {}
        }
        try {
            Object.defineProperty(window.screen, "touch", {
                get: () => ${touch},
                configurable: true,
                enumerable: true,
            });
        } catch (e) {}
    })();`;
}

/** Apply emulation + screen spoof on a CDP session (Chrome probe scripts only). */
export async function applyChromeProfileScreen(cdp, sid, display) {
    await applyChromeScreenEmulation(cdp, sid, display);
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source: buildScreenSpoofScript(display.screen),
    }, sid);
}