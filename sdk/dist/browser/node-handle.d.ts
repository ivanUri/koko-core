import type { LPClient } from "./lp-client.js";
import type { GotoWaitOptions } from "./waiter.js";
/** Minimal page surface to avoid import cycles. */
export interface NodeHandlePage {
    init(): Promise<void>;
    readonly agent: LPClient;
    waitForNavigation(options?: GotoWaitOptions): Promise<void>;
}
export interface NodeActionOptions {
    timeout?: number;
}
export interface NodePressOptions extends NodeActionOptions {
    waitForNavigation?: boolean | GotoWaitOptions;
}
/**
 * Stable backend-node handle for Velora agent actions.
 * Unlike CSS locators, backendNodeId survives semantic tree / interactive element scans.
 */
export declare class NodeHandle {
    readonly page: NodeHandlePage;
    readonly backendNodeId: number;
    constructor(page: NodeHandlePage, backendNodeId: number);
    click(options?: NodeActionOptions): Promise<void>;
    fill(text: string, options?: NodeActionOptions): Promise<void>;
    hover(options?: NodeActionOptions): Promise<void>;
    scroll(options?: {
        x?: number;
        y?: number;
        timeout?: number;
    }): Promise<void>;
    selectOption(value: string, options?: NodeActionOptions): Promise<void>;
    check(options?: NodeActionOptions): Promise<void>;
    uncheck(options?: NodeActionOptions): Promise<void>;
    setChecked(checked: boolean, options?: NodeActionOptions): Promise<void>;
    press(key: string, options?: NodePressOptions): Promise<void>;
    details(options?: NodeActionOptions): Promise<import("./lp-types.js").NodeDetails>;
}
