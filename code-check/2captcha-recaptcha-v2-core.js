// In-page diagnostic for 2captcha reCAPTCHA v2 demo.
// Executed by: velora fetch --wait-script-file (core, no CDP).
// Set globalThis.__veloraDiagMode = "probe" | "core_click" before this script.

(function veloraRecaptchaDiag() {
    const TAG = "VELORA_DIAG:";

    if (!globalThis.__veloraRecaptchaDiag) {
        globalThis.__veloraRecaptchaDiag = {
            t0: Date.now(),
            phase: 0,
            injectStarted: false,
            domClickAt: 0,
            report: null,
        };
    }
    const state = globalThis.__veloraRecaptchaDiag;
    const mode = globalThis.__veloraDiagMode || "probe";
    const elapsed = () => Date.now() - state.t0;

    function sitekey() {
        const el = document.querySelector("[data-sitekey]");
        return el ? el.getAttribute("data-sitekey") : null;
    }

    function recaptchaIframes() {
        return [...document.querySelectorAll("iframe")].filter((f) => {
            const src = f.src || f.getAttribute("src") || "";
            return /recaptcha/i.test(src);
        });
    }

    function widgetIframe() {
        return (
            document.querySelector(".g-recaptcha iframe") ||
            document.querySelector('iframe[src*="recaptcha/api2/anchor"]') ||
            recaptchaIframes()[0] ||
            null
        );
    }

    function tokenState() {
        const ta = document.querySelector('textarea[name="g-recaptcha-response"]');
        const val = ta && ta.value ? ta.value : "";
        return { length: val.length, preview: val.slice(0, 48) };
    }

    function challengeIframe() {
        return document.querySelector(
            'iframe[src*="bframe"], iframe[src*="recaptcha/api2/bframe"]'
        );
    }

    function describeEl(el) {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
            tag: el.tagName,
            id: el.id || null,
            className: el.className || null,
            src: el.src || el.getAttribute("src") || null,
            rect: { left: r.left, top: r.top, width: r.width, height: r.height },
        };
    }

    function hitTestAtCheckbox(iframe) {
        if (!iframe) return { error: "no_iframe" };
        const r = iframe.getBoundingClientRect();
        const x = r.left + 28;
        const y = r.top + r.height / 2;
        const top = document.elementFromPoint(x, y);
        const stack = document.elementsFromPoint
            ? document.elementsFromPoint(x, y).map((n) => n.tagName).slice(0, 6)
            : [];
        return {
            clickX: x,
            clickY: y,
            topElement: describeEl(top),
            stack,
            hitsIframe: !!(top && top.tagName === "IFRAME"),
            hitsCheckboxInsideIframe: false,
        };
    }

    function iframeAccessProbe(iframe) {
        if (!iframe) return { error: "no_iframe" };
        let contentDocument = null;
        let contentDocumentError = null;
        try {
            contentDocument = iframe.contentDocument;
        } catch (e) {
            contentDocumentError = String(e);
        }
        const cw = iframe.contentWindow;
        return {
            hasContentWindow: !!cw,
            contentDocumentAccessible: contentDocument != null,
            contentDocumentError,
            crossOrigin: contentDocument == null && !!cw,
        };
    }

    function grecaptchaRenderReady() {
        return typeof grecaptcha === "object" && typeof grecaptcha.render === "function";
    }

    function maybeInjectGrecaptcha() {
        const sk = sitekey();
        if (!sk || grecaptchaRenderReady() || state.injectStarted) return;
        state.injectStarted = true;
        const s = document.createElement("script");
        s.src =
            "https://www.google.com/recaptcha/api.js?onload=__veloraInjectRecaptchaLoad&render=explicit";
        globalThis.__veloraInjectRecaptchaLoad = function () {
            try {
                const host = document.querySelector(".g-recaptcha") || document.body;
                state.injectWidgetId = grecaptcha.render(host, { sitekey: sk });
                state.injectOk = true;
            } catch (e) {
                state.injectOk = false;
                state.injectError = String(e);
            }
        };
        s.onerror = function () {
            state.injectOk = false;
            state.injectError = "script_load_error";
        };
        s.async = true;
        document.head.appendChild(s);
    }

    function domClickIframe(iframe) {
        if (!iframe) return { ok: false, reason: "no_iframe" };
        const r = iframe.getBoundingClientRect();
        const x = r.left + 28;
        const y = r.top + r.height / 2;
        iframe.dispatchEvent(
            new MouseEvent("click", {
                bubbles: true,
                cancelable: true,
                composed: true,
                clientX: x,
                clientY: y,
            })
        );
        return { ok: true, x, y };
    }

    function analyzeRootCauses(r) {
        const causes = [];

        if (r.recaptchaIframeCount === 0) {
            if (r.grecaptcha === "undefined") {
                causes.push({
                    id: "widget_not_loaded",
                    detail: "grecaptcha is undefined and no recaptcha iframe exists in the parent document.",
                });
            } else {
                causes.push({
                    id: "widget_not_rendered",
                    detail:
                        "grecaptcha exists but the widget iframe was never inserted into the DOM. " +
                        "The 2captcha SPA likely did not call grecaptcha.render(), or render failed.",
                });
            }
        }

        if (r.injectGrecaptcha && r.injectGrecaptcha.attempted && r.injectGrecaptcha.ok === false) {
            causes.push({
                id: "grecaptcha_render_broken",
                detail: "Manual grecaptcha.render() failed: " + (r.injectGrecaptcha.error || "unknown"),
            });
        }

        if (r.mode === "probe" && r.hitTest && r.hitTest.hitsIframe) {
            causes.push({
                id: "element_from_point_stops_at_iframe",
                detail:
                    "Parent document.elementFromPoint returns the IFRAME (expected). " +
                    "DOM-level clicks on the iframe element do not reach the checkbox inside the child frame.",
            });
        }

        if (r.iframeAccess && r.iframeAccess.crossOrigin) {
            causes.push({
                id: "cross_origin_iframe",
                detail:
                    "recaptcha iframe is cross-origin; parent JS cannot access contentDocument. " +
                    "Clicks must be routed into the child Frame, not only the iframe element.",
            });
        }

        if (r.domClick && r.domClick.ok && r.tokenAfterDomClick.length === 0 && !r.challengeVisible) {
            causes.push({
                id: "dom_click_on_iframe_ineffective",
                detail: "Click event on iframe element in parent document did not produce a token.",
            });
        }

        if (
            r.mode === "core_click" &&
            r.tokenAfterDomClick.length === 0 &&
            !r.challengeVisible &&
            r.recaptchaIframeCount > 0
        ) {
            causes.push({
                id: "core_click_no_token",
                detail:
                    "Core triggerMouseClick at parent-frame coords did not produce token or challenge.",
            });
        }

        return causes;
    }

    function buildVerdict(r) {
        if (r.tokenAfterDomClick.length > 0 || r.tokenBeforeDomClick.length > 0) return "token_received";
        if (r.recaptchaIframeCount === 0) return "widget_missing";
        if (r.challengeVisible) return "image_challenge_shown";
        if (r.mode === "core_click") return "core_clicked_but_no_token";
        if (r.domClick && r.domClick.ok) return "dom_clicked_but_no_token";
        return "widget_present_but_not_interactive";
    }

    function finalizeReport(base) {
        const r = Object.assign({}, base, {
            tokenAfterDomClick: tokenState(),
            challengeVisible: !!challengeIframe(),
            elapsedMs: elapsed(),
        });
        r.rootCauses = analyzeRootCauses(r);
        r.verdict = buildVerdict(r);
        return r;
    }

    // phase 0: initial SPA boot wait
    if (state.phase === 0) {
        if (elapsed() < 8_000) return false;
        state.phase = 1;
        return false;
    }

    // phase 1: wait for widget or attempt inject
    if (state.phase === 1) {
        const iframes = recaptchaIframes();
        const hasIframe = iframes.length > 0;
        if (!hasIframe) maybeInjectGrecaptcha();
        if (!hasIframe && elapsed() < 45_000) return false;

        state.phase = 2;
        return false;
    }

    // phase 2: capture pre-click state + DOM click (probe mode only)
    if (state.phase === 2) {
        const iframe = widgetIframe();
        state.baseReport = {
            mode,
            url: location.href,
            title: document.title,
            grecaptcha: typeof grecaptcha,
            grecaptchaCfg: typeof globalThis.___grecaptcha_cfg,
            webdriver: navigator.webdriver,
            userAgent: navigator.userAgent,
            sitekey: sitekey(),
            iframeCount: document.querySelectorAll("iframe").length,
            recaptchaIframeCount: recaptchaIframes().length,
            iframe: describeEl(iframe),
            tokenBeforeDomClick: tokenState(),
            hitTest: hitTestAtCheckbox(iframe),
            iframeAccess: iframeAccessProbe(iframe),
            injectGrecaptcha: {
                attempted: state.injectStarted,
                ok: state.injectOk,
                error: state.injectError,
                widgetId: state.injectWidgetId,
            },
            recaptchaIframes: recaptchaIframes().map((f) => describeEl(f)),
        };

        if (mode === "probe") {
            state.domClick = domClickIframe(iframe);
            state.domClickAt = Date.now();
        } else {
            state.domClick = { ok: false, skipped: true, reason: "core_click_mode" };
            state.domClickAt = Date.now();
        }

        state.phase = 3;
        return false;
    }

    // phase 3: post-click poll
    if (state.phase === 3) {
        if (Date.now() - state.domClickAt < 12_000) return false;

        const report = finalizeReport(Object.assign({}, state.baseReport, {
            domClick: state.domClick,
        }));
        state.report = report;
        const payload = TAG + JSON.stringify(report);
        console.log(payload);
        let pre = document.getElementById("velora-diag-report");
        if (!pre) {
            pre = document.createElement("pre");
            pre.id = "velora-diag-report";
            pre.style.display = "none";
            document.documentElement.appendChild(pre);
        }
        pre.textContent = payload;
        state.phase = 4;
        return true;
    }

    return true;
})();