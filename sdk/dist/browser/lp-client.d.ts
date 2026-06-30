import type { CDPSession } from "../cdp/session.js";
import type { DetectedForm, DialogOptions, FindElementOptions, InteractiveElement, MarkdownOptions, NodeDetails, ScrollOptions, SemanticNode, SemanticTreeOptions, StructuredData } from "./lp-types.js";
import type { Page } from "./page.js";
export declare class LPClient {
    private readonly page;
    private readonly session;
    constructor(page: Page, session: CDPSession);
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
    getNodeDetails(backendNodeId: number, options?: {
        timeout?: number;
    }): Promise<NodeDetails>;
    findElement(options: FindElementOptions): Promise<InteractiveElement[]>;
    links(options?: {
        timeout?: number;
    }): Promise<string[]>;
    waitForSelectorNode(selector: string, options?: {
        timeout?: number;
    }): Promise<number>;
    armDialog(options: DialogOptions): Promise<void>;
    clickNode(backendNodeId: number, options?: {
        timeout?: number;
    }): Promise<void>;
    fillNode(backendNodeId: number, text: string, options?: {
        timeout?: number;
    }): Promise<void>;
    scrollNode(backendNodeId: number | undefined, options?: ScrollOptions): Promise<void>;
    hoverNode(backendNodeId: number, options?: {
        timeout?: number;
    }): Promise<void>;
    pressKey(key: string, options?: {
        backendNodeId?: number;
        timeout?: number;
    }): Promise<void>;
    selectOptionNode(backendNodeId: number, value: string, options?: {
        timeout?: number;
    }): Promise<void>;
    setCheckedNode(backendNodeId: number, checked: boolean, options?: {
        timeout?: number;
    }): Promise<void>;
}
