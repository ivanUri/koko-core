export type LoggerSink = (entry: LogEntry) => void;

export interface LogEntry {
  time: number;
  scope: string;
  message: string;
  data?: unknown;
}

export type LoggerOption = boolean | LoggerSink | Logger;

export class Logger {
  constructor(private readonly sink: LoggerSink = defaultSink) {}

  child(scope: string): ScopedLogger {
    return new ScopedLogger(scope, this.sink);
  }

  static from(option?: LoggerOption): Logger | undefined {
    if (!option) return undefined;
    if (option instanceof Logger) return option;
    if (typeof option === "function") return new Logger(option);
    return new Logger();
  }
}

export class ScopedLogger {
  constructor(private readonly scope: string, private readonly sink: LoggerSink) {}

  log(message: string, data?: unknown): void {
    this.sink({ time: Date.now(), scope: this.scope, message, data });
  }
}

function defaultSink(entry: LogEntry): void {
  const timestamp = new Date(entry.time).toISOString();
  if (entry.data === undefined) console.error(`[${timestamp}] [${entry.scope}] ${entry.message}`);
  else console.error(`[${timestamp}] [${entry.scope}] ${entry.message}`, entry.data);
}
