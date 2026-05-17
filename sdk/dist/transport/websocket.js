import WebSocket from "ws";
import { EventBus } from "../cdp/events.js";
import { ProtocolError, WebSocketClosedError } from "../cdp/errors.js";
import { Logger } from "../utils/logger.js";
export class WebSocketTransport {
    socket;
    nextId = 1;
    pending = new Map();
    events = new EventBus();
    defaultTimeout;
    logger;
    closed = false;
    constructor(socket, options = {}) {
        this.socket = socket;
        this.defaultTimeout = options.defaultTimeout ?? 30_000;
        this.logger = Logger.from(options.logger)?.child("transport");
        this.bindSocket();
    }
    static async connect(endpoint, options = {}) {
        const wsEndpoint = await resolveWebSocketEndpoint(endpoint);
        const socket = new WebSocket(wsEndpoint);
        await new Promise((resolve, reject) => {
            socket.once("open", resolve);
            socket.once("error", reject);
        });
        return new WebSocketTransport(socket, options);
    }
    send(method, params, options = {}) {
        if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
            return Promise.reject(new WebSocketClosedError("WebSocket is not open", { method, sessionId: options.sessionId }));
        }
        const id = this.nextId++;
        const payload = { id, method };
        if (params !== undefined)
            payload.params = params;
        if (options.sessionId)
            payload.sessionId = options.sessionId;
        this.logger?.log("send", payload);
        this.socket.send(JSON.stringify(payload));
        return new Promise((resolve, reject) => {
            const timeout = options.timeout ?? this.defaultTimeout;
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new ProtocolError(`CDP command timed out: ${method}`, {
                    method,
                    sessionId: options.sessionId,
                    timeout,
                    payload,
                }));
            }, timeout);
            this.pending.set(id, {
                method,
                sessionId: options.sessionId,
                payload,
                timer,
                resolve: resolve,
                reject,
            });
        });
    }
    on(event, handler) {
        return this.events.on(event, handler);
    }
    once(event, handler) {
        return this.events.once(event, handler);
    }
    onAny(handler) {
        return this.events.onAny(handler);
    }
    off(event, handler) {
        this.events.off(event, handler);
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        this.socket.close();
        this.rejectAll(new WebSocketClosedError("WebSocket closed"));
        this.events.removeAll();
    }
    bindSocket() {
        this.socket.on("message", (data) => this.handleMessage(data.toString()));
        this.socket.on("close", () => {
            this.closed = true;
            this.rejectAll(new WebSocketClosedError("WebSocket closed"));
            this.events.emit("__close", {});
        });
        this.socket.on("error", (error) => {
            this.rejectAll(new WebSocketClosedError(error.message));
            this.events.emit("__error", error);
        });
    }
    handleMessage(raw) {
        let message;
        try {
            message = JSON.parse(raw);
        }
        catch (error) {
            this.events.emit("__parseError", { raw, error });
            return;
        }
        this.logger?.log("recv", message);
        if (message.id !== undefined) {
            const pending = this.pending.get(message.id);
            if (!pending)
                return;
            this.pending.delete(message.id);
            clearTimeout(pending.timer);
            if (message.error) {
                pending.reject(new ProtocolError(message.error.message, {
                    method: pending.method,
                    sessionId: pending.sessionId,
                    payload: message,
                }));
            }
            else {
                pending.resolve(message.result ?? {});
            }
            return;
        }
        if (message.method) {
            this.events.emit(message.method, message);
            if (message.sessionId)
                this.events.emit(`${message.sessionId}:${message.method}`, message);
        }
    }
    rejectAll(error) {
        for (const [id, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.reject(error);
            this.pending.delete(id);
        }
    }
}
async function resolveWebSocketEndpoint(endpoint) {
    if (endpoint.startsWith("ws://") || endpoint.startsWith("wss://"))
        return endpoint;
    const base = endpoint.replace(/\/$/, "");
    const res = await fetch(`${base}/json/version`);
    if (!res.ok)
        throw new Error(`Unable to resolve CDP endpoint: ${res.status} ${res.statusText}`);
    const json = await res.json();
    if (!json.webSocketDebuggerUrl)
        throw new Error("CDP /json/version did not include webSocketDebuggerUrl");
    return json.webSocketDebuggerUrl;
}
//# sourceMappingURL=websocket.js.map