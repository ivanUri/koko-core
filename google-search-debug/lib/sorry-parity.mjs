/**
 * Sorry / flag-parity analysis for Chrome vs Velora Google Search captures.
 */

function safeUrl(url) {
    try {
        return new URL(url);
    } catch {
        return null;
    }
}

export function parseSorryContinue(sorryOrFinalUrl) {
    const u = safeUrl(sorryOrFinalUrl);
    if (!u) return null;
    const cont = u.searchParams.get("continue");
    if (!cont) return null;
    const inner = safeUrl(cont);
    return {
        raw: cont,
        len: cont.length,
        innerHost: inner?.host ?? null,
        innerPath: inner?.pathname ?? null,
        hasSgSs: cont.includes("sg_ss="),
        hasSei: cont.includes("sei="),
        sgSsLen: (() => {
            if (!inner) return null;
            const v = inner.searchParams.get("sg_ss");
            return v ? v.length : null;
        })(),
        sei: inner?.searchParams.get("sei") ?? null,
        query: inner?.searchParams.get("q") ?? null,
    };
}

export function documentTimeline(network) {
    return (network || [])
        .filter((r) => r.type === "Document")
        .map((r, i) => ({
            i,
            status: r.status ?? null,
            protocol: r.protocol ?? null,
            path: r.path ?? null,
            url: (r.url || "").slice(0, 160),
            hasSgSs: (r.url || "").includes("sg_ss="),
            hasSei: (r.url || "").includes("sei="),
            isSorry: (r.url || "").includes("/sorry"),
            isSearch: (r.path || "") === "/search",
            isRecaptcha: (r.url || "").includes("/recaptcha/"),
        }));
}

const RECAPTCHA_MARKERS = [
    "/recaptcha/enterprise.js",
    "/recaptcha/enterprise/anchor",
    "/recaptcha/enterprise/bframe",
    "/recaptcha/enterprise/webworker.js",
    "recaptcha__en.js",
    "styles__ltr.css",
];

export function recaptchaChain(network) {
    const hits = [];
    for (const r of network || []) {
        const u = r.url || "";
        for (const m of RECAPTCHA_MARKERS) {
            if (u.includes(m)) {
                hits.push({
                    marker: m,
                    status: r.status ?? null,
                    protocol: r.protocol ?? null,
                    type: r.type,
                    url: u.slice(0, 120),
                });
                break;
            }
        }
    }
    return hits;
}

export function networkSignature(network) {
    return (network || []).map((r) => {
        const u = r.url || "";
        let tag = r.type || "?";
        if (u.includes("/sorry")) tag += ":sorry";
        else if (u.includes("sg_ss=")) tag += ":sg_ss";
        else if (u.includes("sei=")) tag += ":sei";
        else if (u.includes("/recaptcha/")) tag += ":recaptcha";
        else if (r.path === "/search") tag += ":search";
        return `${r.status ?? "-"}|${r.protocol ?? "-"}|${tag}|${(r.path || u).slice(0, 80)}`;
    });
}

export function diffStringLists(chrome, velora) {
    const c = chrome || [];
    const v = velora || [];
    const max = Math.max(c.length, v.length);
    const rows = [];
    for (let i = 0; i < max; i += 1) {
        const cc = c[i] ?? null;
        const vv = v[i] ?? null;
        if (cc === vv) continue;
        rows.push({ i, chrome: cc, velora: vv });
    }
    return rows;
}

export function analyzeSorryCapture(capture) {
    const sorryUrl = capture.finalUrl?.includes("/sorry")
        ? capture.finalUrl
        : (capture.network || []).findLast((r) => (r.url || "").includes("/sorry"))?.url
            ?? capture.finalUrl;
    return {
        label: capture.label,
        finalUrl: capture.finalUrl,
        sorryUrl,
        continue: parseSorryContinue(sorryUrl),
        documentTimeline: documentTimeline(capture.network),
        recaptchaChain: recaptchaChain(capture.network),
        networkSignature: networkSignature(capture.network),
        networkTotal: capture.network?.length ?? 0,
        htmlLen: capture.htmlLen ?? capture.html?.length ?? 0,
        dom: capture.sorryDom ?? capture.dom ?? null,
        exceptions: capture.exceptions?.length ?? 0,
        documentResponses: capture.documentResponses ?? [],
    };
}

export function diffSorryParity(chrome, velora) {
    const c = analyzeSorryCapture(chrome);
    const v = analyzeSorryCapture(velora);
    const rows = [];
    const add = (field, cv, vv) => {
        if (JSON.stringify(cv) === JSON.stringify(vv)) return;
        rows.push({ field, chrome: cv, velora: vv });
    };

    add("networkTotal", c.networkTotal, v.networkTotal);
    add("htmlLen", c.htmlLen, v.htmlLen);
    add("documentHopCount", c.documentTimeline.length, v.documentTimeline.length);
    add("recaptchaHitCount", c.recaptchaChain.length, v.recaptchaChain.length);
    add("continue.hasSgSs", c.continue?.hasSgSs, v.continue?.hasSgSs);
    add("continue.hasSei", c.continue?.hasSei, v.continue?.hasSei);
    add("continue.sgSsLen", c.continue?.sgSsLen, v.continue?.sgSsLen);
    add("continue.len", c.continue?.len, v.continue?.len);
    add("dom.bodyLen", c.dom?.bodyLen, v.dom?.bodyLen);
    add("dom.hasCaptcha", c.dom?.hasCaptcha, v.dom?.hasCaptcha);
    add("dom.hasRecaptchaIframe", c.dom?.hasRecaptchaIframe, v.dom?.hasRecaptchaIframe);
    add("dom.scriptCount", c.dom?.scriptCount, v.dom?.scriptCount);
    add("dom.iframeCount", c.dom?.iframeCount, v.dom?.iframeCount);
    add("dom.title", c.dom?.title?.slice(0, 120), v.dom?.title?.slice(0, 120));
    add("exceptions", c.exceptions, v.exceptions);

    const sigDiff = diffStringLists(c.networkSignature, v.networkSignature);
    const docDiff = diffStringLists(
        c.documentTimeline.map((d) => `${d.status}|${d.protocol}|${d.isSorry ? "sorry" : d.isSearch ? "search" : d.isRecaptcha ? "recaptcha" : "doc"}`),
        v.documentTimeline.map((d) => `${d.status}|${d.protocol}|${d.isSorry ? "sorry" : d.isSearch ? "search" : d.isRecaptcha ? "recaptcha" : "doc"}`),
    );
    const recapDiff = diffStringLists(
        c.recaptchaChain.map((r) => `${r.marker}|${r.status}|${r.protocol}`),
        v.recaptchaChain.map((r) => `${r.marker}|${r.status}|${r.protocol}`),
    );

    return {
        summary: rows,
        networkSignatureDiff: sigDiff.slice(0, 30),
        documentTimelineDiff: docDiff,
        recaptchaChainDiff: recapDiff,
        chrome: c,
        velora: v,
    };
}

export const EXTRACT_SORRY_DOM = `(() => {
    const iframes = [...document.querySelectorAll("iframe")].map((el) => ({
        src: (el.src || "").slice(0, 120),
        id: el.id || null,
        w: el.width,
        h: el.height,
    }));
    const scripts = document.scripts.length;
    const hasRecaptchaIframe = iframes.some((f) => /recaptcha/i.test(f.src));
    const hasCaptcha = !!(
        document.querySelector("#captcha")
        || document.querySelector('form[action*="sorry"]')
        || hasRecaptchaIframe
        || document.title.toLowerCase().includes("unusual traffic")
    );
    const inputs = [...document.querySelectorAll('input[type="hidden"]')].map((el) => ({
        name: el.name || null,
        valueLen: (el.value || "").length,
        valuePreview: (el.value || "").slice(0, 48),
    }));
    return {
        title: document.title,
        href: location.href,
        readyState: document.readyState,
        bodyLen: document.body?.innerHTML?.length || 0,
        scriptCount: scripts,
        iframeCount: iframes.length,
        iframes,
        hasCaptcha,
        hasRecaptchaIframe,
        hiddenInputs: inputs,
        hasSearchResults: !!document.querySelector("#search, #rso, .MjjYud"),
    };
})()`;