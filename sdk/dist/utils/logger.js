export class Logger {
    sink;
    constructor(sink = defaultSink) {
        this.sink = sink;
    }
    child(scope) {
        return new ScopedLogger(scope, this.sink);
    }
    static from(option) {
        if (!option)
            return undefined;
        if (option instanceof Logger)
            return option;
        if (typeof option === "function")
            return new Logger(option);
        return new Logger();
    }
}
export class ScopedLogger {
    scope;
    sink;
    constructor(scope, sink) {
        this.scope = scope;
        this.sink = sink;
    }
    log(message, data) {
        this.sink({ time: Date.now(), scope: this.scope, message, data });
    }
}
function defaultSink(entry) {
    const timestamp = new Date(entry.time).toISOString();
    if (entry.data === undefined)
        console.error(`[${timestamp}] [${entry.scope}] ${entry.message}`);
    else
        console.error(`[${timestamp}] [${entry.scope}] ${entry.message}`, entry.data);
}
//# sourceMappingURL=logger.js.map