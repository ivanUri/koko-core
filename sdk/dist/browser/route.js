export class Route {
    session;
    requestId;
    request;
    handled = false;
    constructor(session, requestId, request) {
        this.session = session;
        this.requestId = requestId;
        this.request = request;
    }
    async continue(options = {}) {
        this.ensureOnce();
        const headers = options.headers
            ? Object.entries(options.headers).map(([name, value]) => ({ name, value }))
            : undefined;
        await this.session.send("Fetch.continueRequest", {
            requestId: this.requestId,
            url: options.url,
            postData: options.postData,
            headers,
        });
    }
    async abort(errorReason = "Aborted") {
        this.ensureOnce();
        await this.session.send("Fetch.failRequest", { requestId: this.requestId, errorReason });
    }
    async fulfill(options = {}) {
        this.ensureOnce();
        const headers = options.headers
            ? Object.entries(options.headers).map(([name, value]) => ({ name, value }))
            : options.contentType
                ? [{ name: "Content-Type", value: options.contentType }]
                : undefined;
        const body = options.body == null
            ? undefined
            : typeof options.body === "string"
                ? Buffer.from(options.body).toString("base64")
                : options.body.toString("base64");
        await this.session.send("Fetch.fulfillRequest", {
            requestId: this.requestId,
            responseCode: options.status ?? 200,
            responseHeaders: headers,
            body,
        });
    }
    ensureOnce() {
        if (this.handled)
            throw new Error("Route already handled");
        this.handled = true;
    }
}
export function matchesRoutePattern(url, pattern) {
    if (typeof pattern === "string")
        return url.includes(pattern) || pattern === "*";
    if (pattern instanceof RegExp)
        return pattern.test(url);
    return pattern(url);
}
export class RouteRegistry {
    session;
    fetchEnabled = false;
    handlers = [];
    unsubscribe;
    constructor(session) {
        this.session = session;
    }
    async route(pattern, handler) {
        this.handlers.push({ pattern, handler });
        await this.ensureFetchEnabled();
    }
    async unroute(pattern, handler) {
        if (pattern == null && handler == null) {
            this.handlers.length = 0;
            return;
        }
        for (let i = this.handlers.length - 1; i >= 0; i--) {
            const entry = this.handlers[i];
            if (pattern != null && entry.pattern !== pattern)
                continue;
            if (handler != null && entry.handler !== handler)
                continue;
            this.handlers.splice(i, 1);
        }
        if (this.handlers.length === 0) {
            this.unsubscribe?.();
            this.unsubscribe = undefined;
            await this.session.send("Fetch.disable").catch(() => undefined);
            this.fetchEnabled = false;
        }
    }
    dispose() {
        this.handlers.length = 0;
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        this.fetchEnabled = false;
    }
    async ensureFetchEnabled() {
        if (this.fetchEnabled)
            return;
        this.unsubscribe = this.session.on("Fetch.requestPaused", (event) => {
            void this.onRequestPaused(event);
        });
        await this.session.send("Fetch.enable", {
            patterns: [{ urlPattern: "*", requestStage: "Request" }],
        });
        this.fetchEnabled = true;
    }
    async onRequestPaused(event) {
        const url = event?.request?.url ?? "";
        const requestId = event?.requestId;
        if (!requestId)
            return;
        for (const { pattern, handler } of this.handlers) {
            if (!matchesRoutePattern(url, pattern))
                continue;
            const headers = {};
            const raw = event?.request?.headers ?? {};
            for (const [name, value] of Object.entries(raw)) {
                if (typeof value === "string")
                    headers[name] = value;
            }
            const route = new Route(this.session, requestId, {
                url,
                method: event?.request?.method ?? "GET",
                headers,
                postData: event?.request?.postData,
            });
            try {
                await handler(route);
            }
            catch {
                await route.continue().catch(() => undefined);
            }
            return;
        }
        await this.session.send("Fetch.continueRequest", { requestId }).catch(() => undefined);
    }
}
//# sourceMappingURL=route.js.map