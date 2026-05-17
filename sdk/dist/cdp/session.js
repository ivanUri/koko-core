export class CDPSession {
    client;
    sessionId;
    targetId;
    constructor(client, sessionId, targetId) {
        this.client = client;
        this.sessionId = sessionId;
        this.targetId = targetId;
    }
    send(method, params, timeout) {
        return this.client.send(method, params, this.sessionId, timeout);
    }
    on(event, handler) {
        return this.client.onSession(this.sessionId, event, handler);
    }
    once(event, handler) {
        return this.client.onceSession(this.sessionId, event, handler);
    }
    waitFor(event, options) {
        return this.client.waitForSession(this.sessionId, event, options);
    }
    detach() {
        return this.client.detachSession(this.sessionId);
    }
}
//# sourceMappingURL=session.js.map