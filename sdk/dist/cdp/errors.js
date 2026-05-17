export class CDPError extends Error {
    method;
    sessionId;
    timeout;
    payload;
    constructor(message, context = {}) {
        super(message);
        this.name = new.target.name;
        this.method = context.method;
        this.sessionId = context.sessionId;
        this.timeout = context.timeout;
        this.payload = context.payload;
    }
}
export class TimeoutError extends CDPError {
}
export class ProtocolError extends CDPError {
}
export class NavigationError extends CDPError {
}
export class TargetClosedError extends CDPError {
}
export class WebSocketClosedError extends CDPError {
}
//# sourceMappingURL=errors.js.map