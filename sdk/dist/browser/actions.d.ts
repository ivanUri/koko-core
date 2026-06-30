import type { Page } from "./page.js";
import { type LocatorQuery, type LocatorResolveOptions } from "./locator-query.js";
export interface ActionOptions {
    timeout?: number;
}
export interface FillOptions extends ActionOptions {
    /** Clear existing value before filling (default: true). */
    clear?: boolean;
}
export interface SelectOptionValue {
    value?: string;
    label?: string;
    index?: number;
}
export interface SelectOptions extends ActionOptions {
    values?: string | string[] | SelectOptionValue | SelectOptionValue[];
}
export declare function locatorClick(page: Page, queries: LocatorQuery[], options?: ActionOptions, resolveOptions?: LocatorResolveOptions): Promise<void>;
export declare function locatorHover(page: Page, queries: LocatorQuery[], options?: ActionOptions, resolveOptions?: LocatorResolveOptions): Promise<void>;
export declare function locatorFill(page: Page, queries: LocatorQuery[], text: string, options?: FillOptions, resolveOptions?: LocatorResolveOptions): Promise<void>;
export declare function locatorCheck(page: Page, queries: LocatorQuery[], checked: boolean, options?: ActionOptions, resolveOptions?: LocatorResolveOptions): Promise<void>;
export declare function locatorSelectOption(page: Page, queries: LocatorQuery[], values: SelectOptions["values"], options?: ActionOptions, resolveOptions?: LocatorResolveOptions): Promise<string[]>;
