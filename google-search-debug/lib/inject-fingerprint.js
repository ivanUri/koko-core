/**
 * Injected before any page script on Google Search navigations.
 * Logs fingerprint-related API usage to window.__veloraFpLog.
 */
(function () {
    if (window.__veloraFpInjected) return;
    window.__veloraFpInjected = true;

    const log = [];
    window.__veloraFpLog = log;

    const push = (type, detail) => {
        try {
            log.push({
                t: Date.now(),
                type,
                detail: detail == null ? null : String(detail).slice(0, 500),
            });
        } catch (_) {}
        if (log.length > 2000) log.splice(0, log.length - 1500);
    };

    const wrapGetter = (obj, prop, label) => {
        try {
            const desc = Object.getOwnPropertyDescriptor(obj, prop);
            if (!desc || !desc.get) return;
            const orig = desc.get;
            Object.defineProperty(obj, prop, {
                configurable: true,
                enumerable: desc.enumerable,
                get() {
                    push("getter", label || prop);
                    return orig.call(this);
                },
            });
        } catch (_) {}
    };

    wrapGetter(Navigator.prototype, "userAgent", "navigator.userAgent");
    wrapGetter(Navigator.prototype, "webdriver", "navigator.webdriver");
    wrapGetter(Navigator.prototype, "plugins", "navigator.plugins");
    wrapGetter(Navigator.prototype, "mimeTypes", "navigator.mimeTypes");
    wrapGetter(Navigator.prototype, "hardwareConcurrency", "navigator.hardwareConcurrency");
    wrapGetter(Navigator.prototype, "deviceMemory", "navigator.deviceMemory");

    const origFetch = window.fetch;
    if (typeof origFetch === "function") {
        window.fetch = function (input, init) {
            const url = typeof input === "string" ? input : input?.url || String(input);
            push("fetch", url);
            return origFetch.apply(this, arguments);
        };
    }

    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
        push("xhr", `${method} ${url}`);
        return origOpen.apply(this, arguments);
    };

    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function () {
        push("canvas.toDataURL", `${this.width}x${this.height}`);
        return origToDataURL.apply(this, arguments);
    };

    const origMeasureText = CanvasRenderingContext2D.prototype.measureText;
    CanvasRenderingContext2D.prototype.measureText = function (text) {
        push("canvas.measureText", String(text).slice(0, 80));
        return origMeasureText.apply(this, arguments);
    };

    const origGetParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (pname) {
        push("webgl.getParameter", pname);
        return origGetParameter.apply(this, arguments);
    };

    if (typeof WebGL2RenderingContext !== "undefined") {
        const origGetParameter2 = WebGL2RenderingContext.prototype.getParameter;
        WebGL2RenderingContext.prototype.getParameter = function (pname) {
            push("webgl2.getParameter", pname);
            return origGetParameter2.apply(this, arguments);
        };
    }

    const origGetBoundingClientRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
        const tag = this.tagName || "?";
        push("getBoundingClientRect", tag);
        return origGetBoundingClientRect.apply(this, arguments);
    };

    push("inject", "ready");
})();