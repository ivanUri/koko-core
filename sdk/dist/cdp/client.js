import { WebSocketTransport } from "../transport/websocket.js";
import { withTimeout } from "../utils/timeout.js";
import { TargetClosedError, WebSocketClosedError } from "./errors.js";
import { CDPSession } from "./session.js";
export class CDPClient {
    transport;
    sessions = new Map();
    targetTrackingStarted = false;
    constructor(transport) {
        this.transport = transport;
        this.bindLifecycle();
    }
    static async connect(endpoint, options = {}) {
        return new CDPClient(await WebSocketTransport.connect(endpoint, options));
    }
    bindLifecycle() {
        this.transport.on("Target.attachedToTarget", (message) => {
            const params = (message.params ?? {});
            if (!params.sessionId)
                return;
            if (!this.sessions.has(params.sessionId)) {
                this.sessions.set(params.sessionId, new CDPSession(this, params.sessionId, params.targetInfo?.targetId));
            }
        });
        this.transport.on("Target.detachedFromTarget", (message) => {
            const params = (message.params ?? {});
            if (!params.sessionId)
                return;
            const session = this.sessions.get(params.sessionId);
            if (session)
                session.markClosed(new TargetClosedError("Target detached", { sessionId: params.sessionId }));
            this.sessions.delete(params.sessionId);
        });
        this.transport.on("__close", () => {
            const error = new WebSocketClosedError("Transport closed");
            for (const session of this.sessions.values())
                session.markClosed(error);
            this.sessions.clear();
        });
    }
    /** Enable global Target.* tracking (discover + auto-attach flatten). Call once after connect. */
    async enableTargetTracking(options = {}) {
        if (this.targetTrackingStarted)
            return;
        this.targetTrackingStarted = true;
        if (options.discover ?? true) {
            await this.send("Target.setDiscoverTargets", { discover: true }).catch(() => undefined);
        }
        if (options.autoAttach ?? true) {
            await this.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => undefined);
        }
    }
    send(method, params, sessionId, timeout) {
        return this.transport.send(method, params, { sessionId, timeout });
    }
    on(event, handler) {
        return this.transport.on(event, (message) => handler((message.params ?? {})));
    }
    once(event, handler) {
        return this.transport.once(event, (message) => handler((message.params ?? {})));
    }
    off(event, handler) {
        this.transport.off(event, handler);
    }
    onAny(handler) {
        return this.transport.onAny((event, payload) => {
            const message = payload;
            handler(event, message.params ?? message);
        });
    }
    waitFor(event, options = {}) {
        const promise = new Promise((resolve) => {
            const off = this.on(event, (payload) => {
                if (options.predicate && !options.predicate(payload))
                    return;
                off();
                resolve(payload);
            });
        });
        return withTimeout(promise, { timeout: options.timeout, label: `Waiting for ${event}` });
    }
    onSession(sessionId, event, handler) {
        return this.transport.on(`${sessionId}:${event}`, (message) => handler((message.params ?? {})));
    }
    onceSession(sessionId, event, handler) {
        return this.transport.once(`${sessionId}:${event}`, (message) => handler((message.params ?? {})));
    }
    waitForSession(sessionId, event, options = {}) {
        const promise = new Promise((resolve) => {
            const off = this.onSession(sessionId, event, (payload) => {
                if (options.predicate && !options.predicate(payload))
                    return;
                off();
                resolve(payload);
            });
        });
        return withTimeout(promise, { timeout: options.timeout, label: `Waiting for ${event}`, sessionId });
    }
    async createTarget(url = "about:blank") {
        const result = await this.send("Target.createTarget", { url });
        return result.targetId;
    }
    async attachToTarget(targetId) {
        const result = await this.send("Target.attachToTarget", { targetId, flatten: true });
        let session = this.sessions.get(result.sessionId);
        if (!session) {
            session = new CDPSession(this, result.sessionId, targetId);
            this.sessions.set(result.sessionId, session);
        }
        return session;
    }
    async newSession(url = "about:blank") {
        const targetId = await this.createTarget(url);
        return this.attachToTarget(targetId);
    }
    async detachSession(sessionId) {
        try {
            await this.send("Target.detachFromTarget", { sessionId });
        }
        finally {
            const session = this.sessions.get(sessionId);
            if (session)
                session.markClosed(new TargetClosedError("Session detached", { sessionId }));
            this.sessions.delete(sessionId);
        }
    }
    async closeTarget(targetId) {
        await this.send("Target.closeTarget", { targetId });
    }
    close() {
        const error = new WebSocketClosedError("Client closed");
        for (const session of this.sessions.values())
            session.markClosed(error);
        this.sessions.clear();
        this.transport.close();
    }
}
//# sourceMappingURL=client.js.map