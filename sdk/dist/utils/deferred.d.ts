export interface Deferred<T> {
    promise: Promise<T>;
    resolve(value: T | PromiseLike<T>): void;
    reject(reason?: unknown): void;
}
export declare function createDeferred<T>(): Deferred<T>;
