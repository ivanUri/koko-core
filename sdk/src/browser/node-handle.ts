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
export class NodeHandle {
  constructor(
    readonly page: NodeHandlePage,
    readonly backendNodeId: number,
  ) {}

  async click(options: NodeActionOptions = {}): Promise<void> {
    await this.page.init();
    await this.page.agent.clickNode(this.backendNodeId, options);
  }

  async fill(text: string, options: NodeActionOptions = {}): Promise<void> {
    await this.page.init();
    await this.page.agent.fillNode(this.backendNodeId, text, options);
  }

  async hover(options: NodeActionOptions = {}): Promise<void> {
    await this.page.init();
    await this.page.agent.hoverNode(this.backendNodeId, options);
  }

  async scroll(options: { x?: number; y?: number; timeout?: number } = {}): Promise<void> {
    await this.page.init();
    await this.page.agent.scrollNode(this.backendNodeId, options);
  }

  async selectOption(value: string, options: NodeActionOptions = {}): Promise<void> {
    await this.page.init();
    await this.page.agent.selectOptionNode(this.backendNodeId, value, options);
  }

  async check(options: NodeActionOptions = {}): Promise<void> {
    await this.setChecked(true, options);
  }

  async uncheck(options: NodeActionOptions = {}): Promise<void> {
    await this.setChecked(false, options);
  }

  async setChecked(checked: boolean, options: NodeActionOptions = {}): Promise<void> {
    await this.page.init();
    await this.page.agent.setCheckedNode(this.backendNodeId, checked, options);
  }

  async press(key: string, options: NodePressOptions = {}): Promise<void> {
    await this.page.init();
    const nav = options.waitForNavigation
      ? this.page.waitForNavigation(typeof options.waitForNavigation === "object" ? options.waitForNavigation : {})
      : undefined;
    nav?.catch(() => undefined);
    await this.page.agent.pressKey(key, { backendNodeId: this.backendNodeId, timeout: options.timeout });
    if (nav) await nav;
  }

  async details(options: NodeActionOptions = {}): Promise<import("./lp-types.js").NodeDetails> {
    await this.page.init();
    return this.page.agent.getNodeDetails(this.backendNodeId, options);
  }
}