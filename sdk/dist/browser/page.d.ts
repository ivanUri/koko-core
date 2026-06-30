import type { CDPSession } from "../cdp/session.js";
import type { GotoWaitOptions } from "./waiter.js";
import { PageWaiter } from "./waiter.js";
import { NetworkTracker } from "./network.js";
import { type RouteHandler, type RoutePattern } from "./route.js";
import { Locator, type GetByRoleOptions, type GetByTextOptions, type LocatorOptions } from "./locator.js";
import type { ActionOptions, FillOptions, SelectOptions } from "./actions.js";
import { LPClient } from "./lp-client.js";
import { NodeHandle } from "./node-handle.js";
import type { DetectedForm, DialogOptions, FindElementOptions, GoogleExtractResult, GoogleSearchOptions, InteractiveElement, MarkdownOptions, NodeDetails, SemanticNode, SemanticTreeOptions, StructuredData } from "./lp-types.js";
export interface EvaluateOptions {
    timeout?: number;
}
export interface ExtractOptions {
    /** Expression that must become truthy before extract runs (TTFX probe). */
    ttfx?: string;
    /** Final extract expression; must returnByValue. */
    expression?: string;
    timeout?: number;
    pollMs?: number;
}
export interface ExtractResult {
    title?: string;
    linkCount?: number;
    htmlBytes?: number;
    [key: string]: unknown;
}
export interface TypeOptions {
    timeout?: number;
    clear?: boolean;
}
export interface PressOptions {
    timeout?: number;
}
export interface SearchOptions extends GotoWaitOptions {
    inputSelector?: string;
    settleMs?: number;
}
export interface ScreenshotOptions {
    timeout?: number;
    type?: "png" | "jpeg";
    quality?: number;
    fullPage?: boolean;
}
export interface PdfOptions {
    timeout?: number;
}
export interface ViewportSize {
    width: number;
    height: number;
}
export interface ClickOptions extends ActionOptions {
    waitForNavigation?: boolean | GotoWaitOptions;
}
export declare class Page {
    readonly session: CDPSession;
    readonly network: NetworkTracker;
    readonly waiter: PageWaiter;
    /** Velora LP domain — AI extraction and backend-node agent actions. */
    readonly agent: LPClient;
    private readonly routes;
    private initialized;
    private mainFrameId?;
    private readonly closeHooks;
    constructor(session: CDPSession);
    /** Register cleanup when page.close() runs (used by Browser/Context). */
    onClose(hook: () => void): void;
    init(): Promise<void>;
    goto(url: string, options?: GotoWaitOptions): Promise<void>;
    evaluate<T = unknown>(expressionOrFunction: string | Function, options?: EvaluateOptions): Promise<T>;
    /** Single round-trip HTML snapshot (doctype + outerHTML). */
    content(): Promise<string>;
    /**
     * Crawler helper: wait for a TTFX probe then run a structured extract expression.
     * Defaults match the Wikipedia crawl benchmark.
     */
    extract(options?: ExtractOptions): Promise<ExtractResult>;
    waitForSelector(selector: string, options?: {
        timeout?: number;
        visible?: boolean;
    }): Promise<void>;
    waitForFunction(fn: string | Function, options?: {
        timeout?: number;
        pollingMs?: number;
    }): Promise<void>;
    waitForNavigation(options?: GotoWaitOptions): Promise<void>;
    waitForURL(url: string | RegExp | ((current: string) => boolean), options?: {
        timeout?: number;
    }): Promise<void>;
    locator(selector: string, options?: LocatorOptions): Locator;
    getByRole(role: string, options?: GetByRoleOptions): Locator;
    getByText(text: string | RegExp, options?: GetByTextOptions): Locator;
    getByLabel(text: string | RegExp, options?: GetByTextOptions): Locator;
    getByPlaceholder(text: string | RegExp, options?: GetByTextOptions): Locator;
    getByAltText(text: string | RegExp, options?: GetByTextOptions): Locator;
    getByTitle(text: string | RegExp, options?: GetByTextOptions): Locator;
    getByTestId(testId: string | RegExp): Locator;
    click(selector: string, options?: ClickOptions): Promise<void>;
    fill(selector: string, text: string, options?: FillOptions): Promise<void>;
    hover(selector: string, options?: ActionOptions): Promise<void>;
    check(selector: string, options?: ActionOptions): Promise<void>;
    uncheck(selector: string, options?: ActionOptions): Promise<void>;
    selectOption(selector: string, values: SelectOptions["values"], options?: SelectOptions): Promise<string[]>;
    title(): Promise<string>;
    url(): Promise<string>;
    reload(options?: GotoWaitOptions): Promise<void>;
    goBack(options?: GotoWaitOptions): Promise<void>;
    goForward(options?: GotoWaitOptions): Promise<void>;
    screenshot(options?: ScreenshotOptions): Promise<Buffer>;
    pdf(options?: PdfOptions): Promise<Buffer>;
    addInitScript(source: string | Function): Promise<void>;
    setViewportSize(size: ViewportSize): Promise<void>;
    /** Intercept network requests (Playwright-style `page.route`). */
    route(pattern: RoutePattern, handler: RouteHandler): Promise<void>;
    unroute(pattern?: RoutePattern, handler?: RouteHandler): Promise<void>;
    type(selector: string, text: string, options?: TypeOptions): Promise<void>;
    press(key: string, options?: PressOptions): Promise<void>;
    markdown(options?: MarkdownOptions): Promise<string>;
    semanticTree(options?: SemanticTreeOptions): Promise<string | SemanticNode>;
    getInteractiveElements(options?: {
        nodeId?: number;
        timeout?: number;
    }): Promise<InteractiveElement[]>;
    getStructuredData(options?: {
        timeout?: number;
    }): Promise<StructuredData>;
    detectForms(options?: {
        timeout?: number;
    }): Promise<DetectedForm[]>;
    findElement(options: FindElementOptions): Promise<InteractiveElement[]>;
    getNodeDetails(backendNodeId: number, options?: {
        timeout?: number;
    }): Promise<NodeDetails>;
    links(options?: {
        timeout?: number;
    }): Promise<string[]>;
    node(backendNodeId: number): NodeHandle;
    waitForSelectorHandle(selector: string, options?: {
        timeout?: number;
    }): Promise<NodeHandle>;
    armDialog(options: DialogOptions): Promise<void>;
    /** Google SERP agent workflow: navigate + TTFX probe + top-N organic extract + block detection. */
    searchGoogle(options: GoogleSearchOptions): Promise<GoogleExtractResult>;
    search(searchPageUrl: string, query: string, options?: SearchOptions): Promise<void>;
    close(): Promise<void>;
    get frameId(): string | undefined;
    private historyStep;
}
