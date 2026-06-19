/**
 * Fingerprint / bot-detection regression cases for Velora.
 *
 * - local: fixtures under code-check/local/ (static HTTP)
 * - remote: live sites (need network; use --remote)
 * - script: standalone scripts under code-check/sites/
 */

export const LOCAL_CASES = [
    {
        id: "engine-blink",
        name: "V8/Blink engine fingerprint",
        kind: "local",
        path: "/engine/blink.html",
        timeoutMs: 15_000,
        waitMs: 500,
        collect: `(() => {
            const raw = document.getElementById('out')?.textContent || '';
            try {
                const data = JSON.parse(raw);
                const pass = data.IS_BLINK === true && data.id === 80;
                return {
                    pass,
                    summary: pass ? 'Blink engine id=80' : \`id=\${data.id} IS_BLINK=\${data.IS_BLINK}\`,
                    metrics: data,
                };
            } catch (e) {
                return { pass: false, summary: 'parse failed: ' + raw.slice(0, 200), error: String(e) };
            }
        })()`,
    },
    {
        id: "creepjs-local",
        name: "CreepJS local fixture",
        kind: "local",
        path: "/creepjs/index.html",
        timeoutMs: 120_000,
        waitMs: 2000,
        pollMs: 500,
        collect: `(() => {
            const header = document.querySelector('.fingerprint-header .ellipsis-all');
            const fuzzy = document.querySelector('#fuzzy-fingerprint .fuzzy-fp, .fuzzy-fp');
            const fpText = header ? header.textContent.trim() : '';
            const fuzzyText = fuzzy ? fuzzy.textContent.trim() : '';
            const computing = fpText.includes('Computing');
            const fpId = fpText.replace(/^FP ID:\\s*/i, '').trim();
            const hasFp = !computing && fpId.length > 10 && !/^0+$/.test(fpId.replace(/\\s/g, ''));
            const lies = document.querySelectorAll('[class*="lie"], .lies, .alert, .blocked').length;
            const pass = hasFp;
            return {
                pass,
                summary: hasFp ? ('FP ID computed (' + fpId.slice(0, 16) + '…)') : ('stuck: ' + fpText.slice(0, 80)),
                metrics: {
                    fpText: fpText.slice(0, 120),
                    fuzzyText: fuzzyText.slice(0, 80),
                    lieMarkers: lies,
                },
            };
        })()`,
    },
];

/** Shared smoke checks for https://browserleaks.com/ remote pages. */
// Static HTML on BrowserLeaks still contains "JavaScript Disabled" labels; the
// collect script itself proves JS is running.
const BL_JS_OK = `true`;
const BL_NO_WEBDRIVER = `navigator.webdriver !== true`;

export const BROWSERLEAKS_CASES = [
    {
        id: "browserleaks-javascript",
        name: "BrowserLeaks JavaScript / Navigator",
        kind: "remote",
        url: "https://browserleaks.com/javascript",
        timeoutMs: 60_000,
        waitMs: 4000,
        pollMs: 1000,
        collect: `(() => {
            const text = document.body?.innerText || '';
            const jsOk = ${BL_JS_OK};
            const ua = navigator.userAgent || '';
            const webdriver = navigator.webdriver;
            const hw = navigator.hardwareConcurrency;
            const pageReady = /userAgent/i.test(text) && ua.length > 10;
            const pass = jsOk && pageReady && ua.length > 0 && ${BL_NO_WEBDRIVER}
                && typeof hw === 'number' && hw > 0;
            return {
                pass,
                summary: pass ? ('navigator ok, UA ' + ua.slice(0, 48) + '…') : ('not ready: js=' + jsOk + ' uaLen=' + ua.length),
                metrics: {
                    jsOk,
                    ua: ua.slice(0, 160),
                    webdriver,
                    hardwareConcurrency: hw,
                    language: navigator.language,
                    textLen: text.length,
                },
            };
        })()`,
    },
    {
        id: "browserleaks-webrtc",
        name: "BrowserLeaks WebRTC leak test",
        kind: "remote",
        url: "https://browserleaks.com/webrtc",
        timeoutMs: 90_000,
        waitMs: 8000,
        pollMs: 1500,
        collect: `(() => {
            const text = document.body?.innerText || '';
            const jsOk = ${BL_JS_OK};
            const hasRtc = typeof RTCPeerConnection !== 'undefined';
            const leakReady = /RTCPeerConnection/i.test(text)
                && (/Local IP Address/i.test(text) || /Public IP Address/i.test(text) || /SDP Log/i.test(text));
            const pass = hasRtc && leakReady && text.length > 400;
            return {
                pass,
                summary: pass ? 'WebRTC page populated' : ('waiting: rtc=' + hasRtc + ' leak=' + leakReady),
                metrics: { jsOk, hasRtc, leakReady, textLen: text.length },
            };
        })()`,
    },
    {
        id: "browserleaks-canvas",
        name: "BrowserLeaks Canvas fingerprint",
        kind: "remote",
        url: "https://browserleaks.com/canvas",
        timeoutMs: 60_000,
        waitMs: 5000,
        pollMs: 1000,
        collect: `(() => {
            const text = document.body?.innerText || '';
            const jsOk = ${BL_JS_OK};
            let canvas2d = false;
            try {
                const c = document.createElement('canvas');
                canvas2d = !!(c.getContext && c.getContext('2d'));
            } catch (_) {}
            const hash = text.match(/[a-f0-9]{32}/i);
            const sigSection = /Canvas Fingerprint/i.test(text) && /Signature/i.test(text);
            const pass = canvas2d && sigSection && !!hash;
            return {
                pass,
                summary: pass ? ('canvas sig ' + (hash?.[0] || '').slice(0, 12) + '…') : 'canvas probe incomplete',
                metrics: { jsOk, canvas2d, sigSection, hash: hash?.[0] || null, textLen: text.length },
            };
        })()`,
    },
    {
        id: "browserleaks-webgl",
        name: "BrowserLeaks WebGL report",
        kind: "remote",
        url: "https://browserleaks.com/webgl",
        timeoutMs: 90_000,
        waitMs: 6000,
        pollMs: 1500,
        collect: `(() => {
            const text = document.body?.innerText || '';
            const jsOk = ${BL_JS_OK};
            let webgl = false;
            try {
                const c = document.createElement('canvas');
                webgl = !!(c.getContext('webgl') || c.getContext('experimental-webgl'));
            } catch (_) {}
            const reportHash = text.match(/[a-f0-9]{32}/i);
            const hasRenderer = /Renderer/i.test(text) || /Unmasked Renderer/i.test(text);
            const supports = /supports WebGL/i.test(text);
            const pass = webgl && supports && hasRenderer && !!reportHash;
            return {
                pass,
                summary: pass ? ('webgl hash ' + (reportHash?.[0] || '').slice(0, 12) + '…') : 'webgl report incomplete',
                metrics: { jsOk, webgl, supports, hasRenderer, hash: reportHash?.[0] || null, textLen: text.length },
            };
        })()`,
    },
    {
        id: "browserleaks-fonts",
        name: "BrowserLeaks font fingerprint",
        kind: "remote",
        url: "https://browserleaks.com/fonts",
        timeoutMs: 90_000,
        waitMs: 8000,
        pollMs: 1500,
        collect: `(() => {
            const text = document.body?.innerText || '';
            const jsOk = ${BL_JS_OK};
            const metricsSection = /Font Metrics/i.test(text);
            const glyphsSection = /Unicode Glyphs/i.test(text);
            const hash = text.match(/[a-f0-9]{32}/i);
            const pass = metricsSection && glyphsSection && !!hash && text.length > 300;
            return {
                pass,
                summary: pass ? ('font fp ' + (hash?.[0] || '').slice(0, 12) + '…') : 'font probe incomplete',
                metrics: { jsOk, metricsSection, glyphsSection, hash: hash?.[0] || null, textLen: text.length },
            };
        })()`,
    },
    {
        id: "browserleaks-client-hints",
        name: "BrowserLeaks Client Hints",
        kind: "remote",
        url: "https://browserleaks.com/client-hints",
        timeoutMs: 60_000,
        waitMs: 5000,
        pollMs: 1000,
        collect: `(() => {
            const text = document.body?.innerText || '';
            const jsOk = ${BL_JS_OK};
            const uad = navigator.userAgentData;
            const brands = uad?.brands?.length || 0;
            const platform = uad?.platform || '';
            const pageReady = /Client Hints/i.test(text) && /brands/i.test(text);
            const pass = pageReady && !!uad && brands > 0 && platform.length > 0;
            return {
                pass,
                summary: pass ? ('CH brands=' + brands + ' platform=' + platform) : 'client hints incomplete',
                metrics: {
                    jsOk,
                    brands,
                    platform,
                    mobile: uad?.mobile,
                    pageReady,
                    textLen: text.length,
                },
            };
        })()`,
    },
];

export const REMOTE_CASES = [
    ...BROWSERLEAKS_CASES,
    {
        id: "browserscan-bot",
        name: "BrowserScan bot detection",
        kind: "remote",
        url: "https://www.browserscan.net/bot-detection",
        timeoutMs: 90_000,
        waitMs: 12_000,
        collect: `(() => {
            const text = document.body?.innerText || '';
            const lower = text.toLowerCase();
            const botMention = lower.includes('bot') || lower.includes('automation') || lower.includes('webdriver');
            const passHint = lower.includes('normal') || lower.includes('human') || lower.includes('not detected');
            const failHint = lower.includes('detected') && !lower.includes('not detected');
            const title = document.title || '';
            const pass = passHint && !failHint;
            return {
                pass: pass || (!failHint && text.length > 200),
                summary: title || text.slice(0, 120).replace(/\\s+/g, ' '),
                metrics: { botMention, passHint, failHint, textLen: text.length },
            };
        })()`,
    },
    {
        id: "fingerprint-playground",
        name: "Fingerprint.com playground",
        kind: "remote",
        url: "https://demo.fingerprint.com/playground",
        timeoutMs: 90_000,
        waitMs: 10_000,
        collect: `(() => {
            const text = document.body?.innerText || '';
            const hasVisitor = /visitor/i.test(text) && /id/i.test(text);
            const hasRequest = /request/i.test(text);
            const err = text.toLowerCase().includes('error') || text.toLowerCase().includes('failed');
            const pass = hasVisitor && !err;
            return {
                pass,
                summary: pass ? 'playground rendered visitor/request hints' : text.slice(0, 150).replace(/\\s+/g, ' '),
                metrics: { hasVisitor, hasRequest, err },
            };
        })()`,
    },
];

export const SCRIPT_CASES = [
    {
        id: "dual-diagnostic",
        name: "Fingerprint dual diagnostic (worker + iframe probes)",
        kind: "script",
        script: "sites/fingerprint/dual-diagnostic.mjs",
        timeoutMs: 180_000,
    },
];