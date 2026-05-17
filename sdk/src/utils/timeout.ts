import { TimeoutError } from "../cdp/errors.js";

export interface TimeoutOptions {
  timeout?: number;
  label?: string;
  method?: string;
  sessionId?: string;
}

export function withTimeout<T>(promise: Promise<T>, options: TimeoutOptions = {}): Promise<T> {
  const timeout = options.timeout ?? 30_000;
  if (timeout <= 0 || !Number.isFinite(timeout)) return promise;

  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      reject(new TimeoutError(options.label ?? "Operation timed out", {
        timeout,
        method: options.method,
        sessionId: options.sessionId,
      }));
    }, timeout);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
