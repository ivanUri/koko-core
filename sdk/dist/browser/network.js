import { withTimeout } from "../utils/timeout.js";
const DEFAULT_MAX_REQUESTS = 2048;
export class NetworkTracker {
    session;
    requests = new Map();
    inflight = new Set();
    cleanup = [];
    listeners = new Set();
    maxRequests = DEFAULT_MAX_REQUESTS;
    constructor(session) {
        this.session = session;
    }
    setMaxRequests(max) {
        this.maxRequests = Math.max(64, max);
        this.pruneCompleted();
    }
    notify() {
        for (const listener of this.listeners)
            listener();
    }
    async enable() {
        this.cleanup.push(this.session.on("Network.requestWillBeSent", (event) => this.onRequest(event)), this.session.on("Network.responseReceived", (event) => this.onResponse(event)), this.session.on("Network.loadingFinished", (event) => this.onDone(event.requestId)), this.session.on("Network.loadingFailed", (event) => this.onFailed(event)));
        await this.session.send("Network.enable").catch(() => undefined);
    }
    dispose() {
        for (const off of this.cleanup)
            off();
        this.cleanup = [];
        this.reset();
    }
    /** Clear tracked requests (e.g. at navigation start). */
    reset() {
        this.requests.clear();
        this.inflight.clear();
    }
    waitForIdle(options = {}) {
        const idleMs = options.idleMs ?? 500;
        const promise = new Promise((resolve) => {
            let timer;
            const finish = () => {
                this.listeners.delete(listener);
                if (timer)
                    clearTimeout(timer);
                resolve();
            };
            const listener = () => {
                if (this.inflight.size === 0) {
                    if (!timer)
                        timer = setTimeout(finish, idleMs);
                }
                else if (timer) {
                    clearTimeout(timer);
                    timer = undefined;
                }
            };
            this.listeners.add(listener);
            listener();
        });
        return withTimeout(promise, { timeout: options.timeout, label: "Waiting for network idle" });
    }
    onRequest(event) {
        const previous = this.requests.get(event.requestId);
        const redirectChain = previous ? [...previous.redirectChain, previous.url] : [];
        this.requests.set(event.requestId, {
            requestId: event.requestId,
            url: event.request?.url ?? "",
            method: event.request?.method,
            timestamp: event.timestamp,
            redirectChain,
        });
        this.inflight.add(event.requestId);
        this.pruneCompleted();
        this.notify();
    }
    onResponse(event) {
        const request = this.requests.get(event.requestId);
        if (!request)
            return;
        request.response = {
            url: event.response?.url ?? request.url,
            status: event.response?.status ?? 0,
            statusText: event.response?.statusText,
            headers: event.response?.headers,
        };
    }
    onDone(requestId) {
        this.inflight.delete(requestId);
        this.pruneCompleted();
        this.notify();
    }
    onFailed(event) {
        const request = this.requests.get(event.requestId);
        if (request)
            request.failureText = event.errorText;
        this.inflight.delete(event.requestId);
        this.pruneCompleted();
        this.notify();
    }
    pruneCompleted() {
        if (this.requests.size <= this.maxRequests)
            return;
        for (const [id, req] of this.requests) {
            if (this.inflight.has(id))
                continue;
            this.requests.delete(id);
            if (this.requests.size <= this.maxRequests)
                break;
        }
    }
}
//# sourceMappingURL=network.js.map