export interface ProtocolErrorContext {
  method?: string;
  sessionId?: string;
  timeout?: number;
  payload?: unknown;
}

export class CDPError extends Error {
  readonly method?: string;
  readonly sessionId?: string;
  readonly timeout?: number;
  readonly payload?: unknown;

  constructor(message: string, context: ProtocolErrorContext = {}) {
    super(message);
    this.name = new.target.name;
    this.method = context.method;
    this.sessionId = context.sessionId;
    this.timeout = context.timeout;
    this.payload = context.payload;
  }
}

export class TimeoutError extends CDPError {}
export class ProtocolError extends CDPError {}
export class NavigationError extends CDPError {}
export class TargetClosedError extends CDPError {}
export class WebSocketClosedError extends CDPError {}
