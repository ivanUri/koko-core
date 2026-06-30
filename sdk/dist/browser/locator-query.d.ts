/** Playwright-style locator query descriptors resolved at action time via Runtime.evaluate. */
export type LocatorQuery = {
    kind: "css";
    selector: string;
} | {
    kind: "role";
    role: string;
    name?: string | RegExp;
    exact?: boolean;
} | {
    kind: "text";
    text: string | RegExp;
    exact?: boolean;
} | {
    kind: "label";
    text: string | RegExp;
    exact?: boolean;
} | {
    kind: "placeholder";
    text: string | RegExp;
    exact?: boolean;
} | {
    kind: "alt";
    text: string | RegExp;
    exact?: boolean;
} | {
    kind: "title";
    text: string | RegExp;
    exact?: boolean;
} | {
    kind: "testId";
    testId: string | RegExp;
};
export interface LocatorResolveOptions {
    /** 0-based index when multiple elements match (default: 0 = first). */
    index?: number;
    /** When true, fail if more than one element matches. */
    strict?: boolean;
}
/** Build a self-contained IIFE that returns the matched element or throws. */
export declare function buildResolveExpression(queries: LocatorQuery[], options?: LocatorResolveOptions): string;
/** Count expression for locator.count(). */
export declare function buildCountExpression(queries: LocatorQuery[]): string;
