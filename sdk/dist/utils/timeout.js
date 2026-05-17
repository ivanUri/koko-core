import { TimeoutError } from "../cdp/errors.js";
export function withTimeout(promise, options = {}) {
    const timeout = options.timeout ?? 30_000;
    if (timeout <= 0 || !Number.isFinite(timeout))
        return promise;
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
            reject(new TimeoutError(options.label ?? "Operation timed out", {
                timeout,
                method: options.method,
                sessionId: options.sessionId,
            }));
        }, timeout);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => {
        if (timer)
            clearTimeout(timer);
    });
}
export function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=timeout.js.map