/**
 * Parse Google SERP URL + DOM snapshot into structured signals.
 */

export function analyzeUrl(url) {
    const u = String(url || "");
    let parsed = null;
    try {
        parsed = new URL(u);
    } catch {
        return {
            url: u,
            valid: false,
            isSorry: u.includes("/sorry"),
            hasSgSs: u.includes("sg_ss="),
            hasSei: u.includes("sei="),
            host: null,
            path: null,
            query: null,
        };
    }
    return {
        url: u,
        valid: true,
        host: parsed.host,
        path: parsed.pathname,
        query: parsed.searchParams.get("q"),
        hl: parsed.searchParams.get("hl"),
        isSorry: parsed.pathname.includes("/sorry"),
        hasSgSs: parsed.searchParams.has("sg_ss") || u.includes("sg_ss="),
        hasSei: parsed.searchParams.has("sei"),
        isSearch: parsed.pathname === "/search",
    };
}

/** Parse Google-specific degradation signals from HTML or network. */
export function analyzeGoogleSignals({ html = "", network = [], consoleLines = [], exceptions = [] } = {}) {
    const h = String(html || "");
    const gen204 = [];
    for (const r of network || []) {
        const u = r.url || "";
        if (!u.includes("gen_204")) continue;
        const err = u.match(/[?&]e=([^&]+)/)?.[1];
        const cad = u.match(/[?&]cad=([^&]+)/)?.[1];
        gen204.push({ url: u, cad: cad ? decodeURIComponent(cad) : null, err: err ? decodeURIComponent(err) : null });
    }
    const sgBe = gen204.find((g) => g.cad === "sg_b_e");
    const sgTrbl = gen204.find((g) => g.cad === "sg_trbl");
    return {
        hasNoscriptFallback: h.includes("/httpservice/retry/enablejs"),
        hasSgRel: h.includes("SG_REL") || h.includes("emsg=SG_REL"),
        hasSgBe: !!sgBe,
        sgBeError: sgBe?.err || null,
        hasSgTrbl: !!sgTrbl,
        hasInlineBootstrap: h.includes("window.google") && h.includes("sg_b_e"),
        gen204,
        consoleErrorCount: (consoleLines || []).filter((c) => c.type === "error").length,
        exceptionCount: (exceptions || []).length,
        firstException: exceptions?.[0]?.text || null,
    };
}

export function summarizeNetwork(requests) {
    const hosts = {};
    const types = {};
    const notable = [];
    for (const r of requests) {
        hosts[r.host] = (hosts[r.host] || 0) + 1;
        types[r.type] = (types[r.type] || 0) + 1;
        const path = r.path || "";
        if (
            path.includes("gen_204")
            || path.includes("/complete/search")
            || path.includes("/async/")
            || path.includes("/sorry")
            || r.url?.includes("sg_ss=")
        ) {
            notable.push({
                url: r.url,
                status: r.status,
                type: r.type,
                protocol: r.protocol,
            });
        }
    }
    return { total: requests.length, hosts, types, notable };
}

export function diffSessions(chrome, velora) {
    const rows = [];
    const add = (field, c, v) => {
        if (JSON.stringify(c) === JSON.stringify(v)) return;
        rows.push({ field, chrome: c, velora: v });
    };

    add("finalUrl", chrome.serp?.url, velora.serp?.url);
    add("isSorry", chrome.serp?.isSorry, velora.serp?.isSorry);
    add("hasSgSs", chrome.serp?.hasSgSs, velora.serp?.hasSgSs);
    add("hasSei", chrome.serp?.hasSei, velora.serp?.hasSei);
    add("documentStatus", chrome.document?.status, velora.document?.status);
    add("documentProtocol", chrome.document?.protocol, velora.document?.protocol);
    add("title", chrome.dom?.title, velora.dom?.title);
    add("hasCaptcha", chrome.dom?.hasCaptcha, velora.dom?.hasCaptcha);
    add("hiddenInputCount", chrome.dom?.hiddenInputs?.length, velora.dom?.hiddenInputs?.length);
    add("networkTotal", chrome.networkSummary?.total, velora.networkSummary?.total);
    add("fpLogCount", chrome.fpLogs?.length, velora.fpLogs?.length);
    add("google.sgBeError", chrome.googleSignals?.sgBeError, velora.googleSignals?.sgBeError);
    add("google.hasSgRel", chrome.googleSignals?.hasSgRel, velora.googleSignals?.hasSgRel);
    add("google.hasSgTrbl", chrome.googleSignals?.hasSgTrbl, velora.googleSignals?.hasSgTrbl);
    add("google.exceptionCount", chrome.googleSignals?.exceptionCount, velora.googleSignals?.exceptionCount);
    add("google.consoleErrorCount", chrome.googleSignals?.consoleErrorCount, velora.googleSignals?.consoleErrorCount);

    const chromeFpTypes = countFpTypes(chrome.fpLogs);
    const veloraFpTypes = countFpTypes(velora.fpLogs);
    for (const t of new Set([...Object.keys(chromeFpTypes), ...Object.keys(veloraFpTypes)])) {
        add(`fp.${t}`, chromeFpTypes[t] || 0, veloraFpTypes[t] || 0);
    }

    return rows;
}

function countFpTypes(logs) {
    const out = {};
    for (const e of logs || []) {
        out[e.type] = (out[e.type] || 0) + 1;
    }
    return out;
}

export const EXTRACT_DOM = `(() => {
    const inputs = [...document.querySelectorAll('input[type="hidden"]')].map((el) => ({
        name: el.name || null,
        id: el.id || null,
        valueLen: (el.value || "").length,
        valuePreview: (el.value || "").slice(0, 64),
    }));
    const hasCaptcha = !!(
        document.querySelector('#captcha')
        || document.querySelector('form[action*="sorry"]')
        || document.title.toLowerCase().includes('unusual traffic')
    );
    const resultStats = document.querySelector('#result-stats')?.innerText?.slice(0, 200) || null;
    return {
        title: document.title,
        readyState: document.readyState,
        hasCaptcha,
        resultStats,
        hiddenInputs: inputs,
        bodyLen: document.body?.innerHTML?.length || 0,
        hasSearchResults: !!document.querySelector('#search, #rso, .MjjYud'),
    };
})()`;

export const READ_FP_LOGS = `(() => window.__veloraFpLog ? [...window.__veloraFpLog] : [])()`;

export const READ_LOCATION = `(() => ({ href: location.href, readyState: document.readyState }))()`;