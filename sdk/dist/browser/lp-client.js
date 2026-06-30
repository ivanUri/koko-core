import { ProtocolError } from "../cdp/errors.js";
export class LPClient {
    page;
    session;
    constructor(page, session) {
        this.page = page;
        this.session = session;
    }
    async markdown(options = {}) {
        const result = await this.session.send("LP.getMarkdown", options.nodeId != null ? { nodeId: options.nodeId } : {}, options.timeout);
        return result.markdown;
    }
    async semanticTree(options = {}) {
        const params = {};
        if (options.format === "text")
            params.format = "text";
        if (options.prune != null)
            params.prune = options.prune;
        if (options.interactiveOnly != null)
            params.interactiveOnly = options.interactiveOnly;
        if (options.backendNodeId != null)
            params.backendNodeId = options.backendNodeId;
        if (options.maxDepth != null)
            params.maxDepth = options.maxDepth;
        const result = await this.session.send("LP.getSemanticTree", params, options.timeout);
        return result.semanticTree;
    }
    async getInteractiveElements(options = {}) {
        const result = await this.session.send("LP.getInteractiveElements", options.nodeId != null ? { nodeId: options.nodeId } : {}, options.timeout);
        return result.elements ?? [];
    }
    async getStructuredData(options = {}) {
        const result = await this.session.send("LP.getStructuredData", {}, options.timeout);
        return result.structuredData;
    }
    async detectForms(options = {}) {
        const result = await this.session.send("LP.detectForms", {}, options.timeout);
        return result.forms ?? [];
    }
    async getNodeDetails(backendNodeId, options = {}) {
        const result = await this.session.send("LP.getNodeDetails", { backendNodeId }, options.timeout);
        return result.nodeDetails;
    }
    async findElement(options) {
        if (!options.role && !options.name) {
            throw new ProtocolError("findElement: at least one of role or name is required");
        }
        const elements = await this.getInteractiveElements({ timeout: options.timeout });
        return elements.filter((el) => {
            if (options.role && (!el.role || !equalsIgnoreCase(el.role, options.role)))
                return false;
            if (options.name && (!el.name || !containsIgnoreCase(el.name, options.name)))
                return false;
            return el.backendNodeId != null;
        });
    }
    async links(options = {}) {
        await this.page.init();
        return this.page.evaluate(`(() => {
      const out = [];
      const seen = new Set();
      for (const a of document.querySelectorAll('a[href]')) {
        const href = a.href;
        if (!href || seen.has(href)) continue;
        seen.add(href);
        out.push(href);
      }
      return out;
    })()`, { timeout: options.timeout });
    }
    async waitForSelectorNode(selector, options = {}) {
        const result = await this.session.send("LP.waitForSelector", { selector, timeout: options.timeout ?? 5000 }, options.timeout);
        return result.backendNodeId;
    }
    async armDialog(options) {
        await this.session.send("LP.handleJavaScriptDialog", { accept: options.accept, promptText: options.promptText }, options.timeout);
    }
    async clickNode(backendNodeId, options = {}) {
        await this.session.send("LP.clickNode", { backendNodeId }, options.timeout);
    }
    async fillNode(backendNodeId, text, options = {}) {
        await this.session.send("LP.fillNode", { backendNodeId, text }, options.timeout);
    }
    async scrollNode(backendNodeId, options = {}) {
        const params = {};
        if (backendNodeId != null)
            params.backendNodeId = backendNodeId;
        if (options.x != null)
            params.x = options.x;
        if (options.y != null)
            params.y = options.y;
        await this.session.send("LP.scrollNode", params, options.timeout);
    }
    async hoverNode(backendNodeId, options = {}) {
        await this.session.send("LP.hoverNode", { backendNodeId }, options.timeout);
    }
    async pressKey(key, options = {}) {
        const params = { key };
        if (options.backendNodeId != null)
            params.backendNodeId = options.backendNodeId;
        await this.session.send("LP.pressKey", params, options.timeout);
    }
    async selectOptionNode(backendNodeId, value, options = {}) {
        await this.session.send("LP.selectOptionNode", { backendNodeId, value }, options.timeout);
    }
    async setCheckedNode(backendNodeId, checked, options = {}) {
        await this.session.send("LP.setCheckedNode", { backendNodeId, checked }, options.timeout);
    }
}
function equalsIgnoreCase(a, b) {
    return a.toLowerCase() === b.toLowerCase();
}
function containsIgnoreCase(haystack, needle) {
    return haystack.toLowerCase().includes(needle.toLowerCase());
}
//# sourceMappingURL=lp-client.js.map