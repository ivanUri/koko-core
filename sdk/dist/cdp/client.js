import { WebSocketTransport } from "../transport/websocket.js";
import { withTimeout } from "../utils/timeout.js";
import { CDPSession } from "./session.js";
export class CDPClient {
    transport;
    sessions = new Map();
    constructor(transport) {
        this.transport = transport;
    }
    static async connect(endpoint, options = {}) {
        return new CDPClient(await WebSocketTransport.connect(endpoint, options));
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
        const session = new CDPSession(this, result.sessionId, targetId);
        this.sessions.set(result.sessionId, session);
        return session;
    }
    async newSession(url = "about:blank") {
        const targetId = await this.createTarget(url);
        return this.attachToTarget(targetId);
    }
    async detachSession(sessionId) {
        await this.send("Target.detachFromTarget", { sessionId });
        this.sessions.delete(sessionId);
    }
    async closeTarget(targetId) {
        await this.send("Target.closeTarget", { targetId });
    }
    close() {
        this.transport.close();
        this.sessions.clear();
    }
}
//# sourceMappingURL=client.js.map