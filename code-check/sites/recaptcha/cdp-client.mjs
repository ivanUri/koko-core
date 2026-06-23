/** Minimal CDP client — no SDK. Uses `ws` from repo root package.json. */
import { WebSocket } from "ws";

export class CdpClient {
    constructor(ws) {
        this.ws = ws;
        this.nextId = 1;
        this.pending = new Map();
        this.eventListeners = new Map();
        this.closed = false;
        ws.addEventListener("close", () => {
            this.closed = true;
            for (const p of this.pending.values()) p.reject(new Error("ws closed"));
            this.pending.clear();
        });
        ws.addEventListener("message", (ev) => this._onMessage(ev));
    }

    _onMessage(ev) {
        let m;
        try {
            m = JSON.parse(ev.data);
        } catch {
            return;
        }
        if (m.id != null && this.pending.has(m.id)) {
            const p = this.pending.get(m.id);
            this.pending.delete(m.id);
            if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`));
            else p.resolve(m.result ?? {});
            return;
        }
        if (m.method) {
            const key = `${m.method}|${m.sessionId ?? ""}`;
            const subs = this.eventListeners.get(key);
            if (subs) for (const cb of subs) cb(m.params ?? {});
        }
    }

    onEvent(method, sessionId, cb) {
        const key = `${method}|${sessionId ?? ""}`;
        let list = this.eventListeners.get(key);
        if (!list) {
            list = [];
            this.eventListeners.set(key, list);
        }
        list.push(cb);
        return () => {
            const i = list.indexOf(cb);
            if (i >= 0) list.splice(i, 1);
        };
    }

    send(method, params = {}, sessionId = null, timeoutMs = 30_000) {
        if (this.closed) return Promise.reject(new Error(`ws closed before ${method}`));
        const id = this.nextId++;
        const payload = { id, method, params };
        if (sessionId) payload.sessionId = sessionId;
        return new Promise((res, rej) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                rej(new Error(`${method} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            this.pending.set(id, {
                method,
                resolve: (v) => {
                    clearTimeout(timer);
                    res(v);
                },
                reject: (e) => {
                    clearTimeout(timer);
                    rej(e);
                },
            });
            this.ws.send(JSON.stringify(payload));
        });
    }
}

export async function connectCdp(endpoint) {
    const v = await (await fetch(`${endpoint}/json/version`)).json();
    const ws = new WebSocket(v.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
        ws.addEventListener("open", res, { once: true });
        ws.addEventListener("error", rej, { once: true });
    });
    return new CdpClient(ws);
}

export async function openPage(client, url) {
    const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
    await client.send("Page.enable", {}, sessionId).catch(() => {});
    await client.send("Runtime.enable", {}, sessionId).catch(() => {});
    await client.send("Network.enable", {}, sessionId).catch(() => {});
    await client.send("Page.navigate", { url }, sessionId);
    return { sessionId, targetId };
}

export async function evaluate(client, sessionId, expression, timeoutMs = 30_000) {
    const { result, exceptionDetails } = await client.send(
        "Runtime.evaluate",
        { expression, returnByValue: true, awaitPromise: true },
        sessionId,
        timeoutMs,
    );
    if (exceptionDetails) {
        const msg = exceptionDetails.exception?.description ?? exceptionDetails.text ?? "evaluate failed";
        throw new Error(msg);
    }
    return result?.value;
}