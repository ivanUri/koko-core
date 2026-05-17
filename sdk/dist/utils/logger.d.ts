export type LoggerSink = (entry: LogEntry) => void;
export interface LogEntry {
    time: number;
    scope: string;
    message: string;
    data?: unknown;
}
export type LoggerOption = boolean | LoggerSink | Logger;
export declare class Logger {
    private readonly sink;
    constructor(sink?: LoggerSink);
    child(scope: string): ScopedLogger;
    static from(option?: LoggerOption): Logger | undefined;
}
export declare class ScopedLogger {
    private readonly scope;
    private readonly sink;
    constructor(scope: string, sink: LoggerSink);
    log(message: string, data?: unknown): void;
}
