//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

const std = @import("std");

const id = @import("../id.zig");
const CDP = @import("../CDP.zig");
const Node = @import("../Node.zig");

const dump = @import("../../../core/browser/dump.zig");
const js = @import("../../../core/js/js.zig");
const DOMNode = @import("../../../core/dom/Node.zig");
const Selector = @import("../../../core/webapi/selector/Selector.zig");
const String = @import("../../../support/string.zig").String;

const log = @import("../../../support/log.zig");
const Allocator = std.mem.Allocator;

pub fn processMessage(cmd: *CDP.Command) !void {
    const action = std.meta.stringToEnum(enum {
        enable,
        disable,
        getDocument,
        performSearch,
        getSearchResults,
        discardSearchResults,
        querySelector,
        querySelectorAll,
        resolveNode,
        describeNode,
        scrollIntoViewIfNeeded,
        getContentQuads,
        getBoxModel,
        requestChildNodes,
        getFrameOwner,
        getOuterHTML,
        requestNode,
        getAttributes,
        setAttributeValue,
        removeAttribute,
        removeNode,
        setNodeName,
        setNodeValue,
        setOuterHTML,
        setAttributesAsText,
        focus,
        getNodeForLocation,
        setFileInputFiles,
        hideHighlight,
        highlightNode,
        highlightRect,
        moveTo,
    }, cmd.input.action) orelse return error.UnknownMethod;

    switch (action) {
        .enable => return cmd.sendResult(null, .{}),
        .disable => return disable(cmd),
        .getDocument => return getDocument(cmd),
        .performSearch => return performSearch(cmd),
        .getSearchResults => return getSearchResults(cmd),
        .discardSearchResults => return discardSearchResults(cmd),
        .querySelector => return querySelector(cmd),
        .querySelectorAll => return querySelectorAll(cmd),
        .resolveNode => return resolveNode(cmd),
        .describeNode => return describeNode(cmd),
        .scrollIntoViewIfNeeded => return scrollIntoViewIfNeeded(cmd),
        .getContentQuads => return getContentQuads(cmd),
        .getBoxModel => return getBoxModel(cmd),
        .requestChildNodes => return requestChildNodes(cmd),
        .getFrameOwner => return getFrameOwner(cmd),
        .getOuterHTML => return getOuterHTML(cmd),
        .requestNode => return requestNode(cmd),
        .getAttributes => return getAttributes(cmd),
        .setAttributeValue => return setAttributeValue(cmd),
        .removeAttribute => return removeAttribute(cmd),
        .removeNode => return removeNode(cmd),
        .setNodeName => return setNodeName(cmd),
        .setNodeValue => return setNodeValue(cmd),
        .setOuterHTML => return setOuterHTML(cmd),
        .setAttributesAsText => return setAttributesAsText(cmd),
        .focus => return focus(cmd),
        .getNodeForLocation => return getNodeForLocation(cmd),
        .setFileInputFiles => return setFileInputFiles(cmd),
        .hideHighlight => return hideHighlight(cmd),
        .highlightNode => return highlightNode(cmd),
        .highlightRect => return highlightRect(cmd),
        .moveTo => return moveTo(cmd),
    }
}

fn disable(cmd: *CDP.Command) !void {
    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;

    // DOM node ids and search results belong to an enabled DOM agent. Releasing
    // them here also prevents detached documents from being retained by CDP.
    bc.node_search_list.reset();
    bc.node_registry.reset();
    return cmd.sendResult(null, .{});
}

// https://chromedevtools.github.io/devtools-protocol/tot/DOM/#method-getDocument
fn getDocument(cmd: *CDP.Command) !void {
    const Params = struct {
        // CDP documentation implies that 0 isn't valid, but it _does_ work in Chrome
        depth: i32 = 3,
        pierce: bool = false,
    };
    const params = try cmd.params(Params) orelse Params{};

    if (params.pierce) {
        log.warn(.not_implemented, "DOM.getDocument", .{ .param = "pierce" });
    }

    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    const frame = bc.session.currentFrame() orelse return error.FrameNotLoaded;

    const node = try bc.node_registry.register(frame.window._document.asNode());
    return cmd.sendResult(.{ .root = bc.nodeWriter(node, .{ .depth = params.depth }) }, .{});
}

// https://chromedevtools.github.io/devtools-protocol/tot/DOM/#method-performSearch
fn performSearch(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        query: []const u8,
        includeUserAgentShadowDOM: ?bool = null,
    })) orelse return error.InvalidParams;

    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    const frame = bc.session.currentFrame() orelse return error.FrameNotLoaded;
    const list = try Selector.querySelectorAll(frame.window._document.asNode(), params.query, frame);
    defer list.deinit(frame._page);

    const search = try bc.node_search_list.create(list._nodes);

    // dispatch setChildNodesEvents to inform the client of the subpart of node
    // tree covering the results.
    try dispatchSetChildNodes(cmd, list._nodes);

    return cmd.sendResult(.{
        .searchId = search.name,
        .resultCount = @as(u32, @intCast(search.node_ids.len)),
    }, .{});
}

// dispatchSetChildNodes send the setChildNodes event for the whole DOM tree
// hierarchy of each nodes.
// We dispatch event in the reverse order: from the top level to the direct parents.
// We should dispatch a node only if it has never been sent.
fn dispatchSetChildNodes(cmd: *CDP.Command, dom_nodes: []const *DOMNode) !void {
    const arena = cmd.arena;
    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    const session_id = bc.session_id orelse return error.SessionIdNotLoaded;

    var parents: std.ArrayList(*Node) = .empty;
    for (dom_nodes) |dom_node| {
        var current = dom_node;
        while (true) {
            const parent_node = current._parent orelse break;

            const node = try bc.node_registry.register(parent_node);
            if (node.set_child_nodes_event) {
                break;
            }
            try parents.append(arena, node);
            current = parent_node;
        }
    }

    const plen = parents.items.len;
    if (plen == 0) {
        return;
    }

    var i: usize = plen;
    // We're going to iterate in reverse order from how we added them.
    // This ensures that we're emitting the tree of nodes top-down.
    while (i > 0) {
        i -= 1;
        const node = parents.items[i];
        // Although our above loop won't add an already-sent node to `parents`
        // this can still be true because two nodes can share the same parent node
        // so we might have just sent the node a previous iteration of this loop
        if (node.set_child_nodes_event) continue;

        node.set_child_nodes_event = true;

        // If the node has no parent, it's the root node.
        // We don't dispatch event for it because we assume the root node is
        // dispatched via the DOM.getDocument command.
        const dom_parent = node.dom._parent orelse continue;

        // Retrieve the parent from the registry.
        const parent_node = try bc.node_registry.register(dom_parent);

        try cmd.sendEvent("DOM.setChildNodes", .{
            .parentId = parent_node.id,
            .nodes = .{bc.nodeWriter(node, .{})},
        }, .{
            .session_id = session_id,
        });
    }
}

// https://chromedevtools.github.io/devtools-protocol/tot/DOM/#method-discardSearchResults
fn discardSearchResults(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        searchId: []const u8,
    })) orelse return error.InvalidParams;

    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;

    bc.node_search_list.remove(params.searchId);
    return cmd.sendResult(null, .{});
}

// https://chromedevtools.github.io/devtools-protocol/tot/DOM/#method-getSearchResults
fn getSearchResults(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        searchId: []const u8,
        fromIndex: u32,
        toIndex: u32,
    })) orelse return error.InvalidParams;

    if (params.fromIndex > params.toIndex) {
        return error.BadIndices;
    }

    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;

    const search = bc.node_search_list.get(params.searchId) orelse {
        return error.SearchResultNotFound;
    };

    const node_ids = search.node_ids;

    if (params.fromIndex >= node_ids.len) return error.BadFromIndex;
    if (params.toIndex > node_ids.len) return error.BadToIndex;

    return cmd.sendResult(.{ .nodeIds = node_ids[params.fromIndex..params.toIndex] }, .{});
}

fn getAttributes(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        nodeId: ?Node.Id = null,
        backendNodeId: ?Node.Id = null,
        objectId: ?[]const u8 = null,
    })) orelse return error.InvalidParams;

    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    const node = try getNode(cmd.arena, bc, params.nodeId, params.backendNodeId, params.objectId);
    const element = node.dom.is(DOMNode.Element) orelse return error.NodeIsNotAnElement;
    const frame = bc.session.currentFrame() orelse return error.FrameNotLoaded;
    const names = try element.getAttributeNames(frame);
    const attributes = try cmd.arena.alloc([]const u8, names.len * 2);

    for (names, 0..) |name, index| {
        attributes[index * 2] = name;
        attributes[index * 2 + 1] = (try element.getAttribute(.wrap(name), frame)).?.str();
    }

    return cmd.sendResult(.{ .attributes = attributes }, .{});
}

fn setAttributeValue(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        nodeId: Node.Id,
        name: []const u8,
        value: []const u8,
    })) orelse return error.InvalidParams;

    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    const frame = bc.session.currentFrame() orelse return error.FrameNotLoaded;
    const node = try getNode(cmd.arena, bc, params.nodeId, null, null);
    const element = node.dom.is(DOMNode.Element) orelse return error.NodeIsNotAnElement;
    try element.setAttribute(.wrap(params.name), .wrap(params.value), frame);
    return cmd.sendResult(null, .{});
}

fn removeAttribute(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        nodeId: Node.Id,
        name: []const u8,
    })) orelse return error.InvalidParams;

    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    const frame = bc.session.currentFrame() orelse return error.FrameNotLoaded;
    const node = try getNode(cmd.arena, bc, params.nodeId, null, null);
    const element = node.dom.is(DOMNode.Element) orelse return error.NodeIsNotAnElement;
    try element.removeAttribute(.wrap(params.name), frame);
    return cmd.sendResult(null, .{});
}

fn removeNode(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        nodeId: Node.Id,
    })) orelse return error.InvalidParams;

    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    const frame = bc.session.currentFrame() orelse return error.FrameNotLoaded;
    const node = try getNode(cmd.arena, bc, params.nodeId, null, null);
    const parent = node.dom._parent orelse return error.NodeNotFound;
    _ = try parent.removeChild(node.dom, frame);
    return cmd.sendResult(null, .{});
}

fn setNodeValue(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        nodeId: Node.Id,
        value: []const u8,
    })) orelse return error.InvalidParams;

    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    const frame = bc.session.currentFrame() orelse return error.FrameNotLoaded;
    const node = try getNode(cmd.arena, bc, params.nodeId, null, null);
    try node.dom.setNodeValue(String.wrap(params.value), frame);
    return cmd.sendResult(null, .{});
}

fn setOuterHTML(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        nodeId: Node.Id,
        outerHTML: []const u8,
    })) orelse return error.InvalidParams;

    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    const frame = bc.session.currentFrame() orelse return error.FrameNotLoaded;
    const node = try getNode(cmd.arena, bc, params.nodeId, null, null);
    const element = node.dom.is(DOMNode.Element) orelse return error.NodeIsNotAnElement;
    try element.setOuterHTML(params.outerHTML, frame);
    return cmd.sendResult(null, .{});
}

fn setNodeName(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        nodeId: Node.Id,
        name: []const u8,
    })) orelse return error.InvalidParams;

    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    const frame = bc.session.currentFrame() orelse return error.FrameNotLoaded;
    const node = try getNode(cmd.arena, bc, params.nodeId, null, null);
    const element = node.dom.is(DOMNode.Element) orelse return error.NodeIsNotAnElement;
    const parent = node.dom._parent orelse return error.NoModificationAllowed;

    // Element stores specialized HTML implementations for many tag names, so
    // changing the tag in place would invalidate the concrete DOM object. Use
    // the existing document factory and move the live children instead.
    const replacement = try frame.document.createElement(params.name, null, frame);
    const names = try element.getAttributeNames(frame);
    for (names) |name| {
        const value = (try element.getAttribute(.wrap(name), frame)).?;
        try replacement.setAttribute(.wrap(name), value, frame);
    }
    while (node.dom.firstChild()) |child| {
        _ = try replacement.asNode().appendChild(child, frame);
    }
    _ = try parent.replaceChild(replacement.asNode(), node.dom, frame);
    return cmd.sendResult(null, .{});
}

fn setAttributesAsText(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        nodeId: Node.Id,
        text: []const u8,
        name: ?[]const u8 = null,
    })) orelse return error.InvalidParams;

    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    const frame = bc.session.currentFrame() orelse return error.FrameNotLoaded;
    const node = try getNode(cmd.arena, bc, params.nodeId, null, null);
    const element = node.dom.is(DOMNode.Element) orelse return error.NodeIsNotAnElement;

    // Parse with html5ever so quoting, entity decoding, duplicate handling and
    // malformed attribute recovery remain identical to normal HTML parsing.
    const fragment = try DOMNode.DocumentFragment.init(frame);
    const fragment_node = fragment.asNode();
    var source = std.Io.Writer.Allocating.init(frame.call_arena);
    try source.writer.print("<div {s}></div>", .{params.text});
    try frame.parseHtmlAsChildren(fragment_node, source.written());
    const parsed = fragment_node.firstChild() orelse return error.InvalidParams;
    const parsed_element = parsed.is(DOMNode.Element) orelse return error.InvalidParams;

    const old_names = try element.getAttributeNames(frame);
    for (old_names) |name| {
        try element.removeAttribute(.wrap(name), frame);
    }
    const new_names = try parsed_element.getAttributeNames(frame);
    for (new_names) |name| {
        const value = (try parsed_element.getAttribute(.wrap(name), frame)).?;
        try element.setAttribute(.wrap(name), value, frame);
    }

    return cmd.sendResult(null, .{});
}

// https://chromedevtools.github.io/devtools-protocol/tot/DOM/#method-focus
fn focus(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        nodeId: Node.Id,
    })) orelse return error.InvalidParams;

    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    const frame = bc.session.currentFrame() orelse return error.FrameNotLoaded;
    const node = bc.node_registry.lookup_by_id.get(params.nodeId) orelse return error.NodeNotFound;
    const element = node.dom.is(DOMNode.Element) orelse return error.NodeIsNotAnElement;
    try element.focus(frame);
    return cmd.sendResult(null, .{});
}

// https://chromedevtools.github.io/devtools-protocol/tot/DOM/#method-getNodeForLocation
fn getNodeForLocation(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        x: i32,
        y: i32,
        includeUserAgentShadowDOM: bool = false,
        ignorePointerEventsNone: bool = false,
    })) orelse return error.InvalidParams;

    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    const frame = bc.session.currentFrame() orelse return error.FrameNotLoaded;
    const element = (try frame.window._document.elementFromPoint(
        @floatFromInt(params.x),
        @floatFromInt(params.y),
        frame,
    )) orelse return error.NodeNotFound;

    if (params.includeUserAgentShadowDOM) {
        log.warn(.not_implemented, "DOM.getNodeForLocation", .{ .param = "includeUserAgentShadowDOM" });
    }
    if (params.ignorePointerEventsNone) {
        log.warn(.not_implemented, "DOM.getNodeForLocation", .{ .param = "ignorePointerEventsNone" });
    }

    const node = try bc.node_registry.register(element.asNode());
    return cmd.sendResult(.{ .backendNodeId = node.id }, .{});
}

// FileList is currently an intentionally immutable empty host object in the
// Web API layer. Do not manufacture a JS-only FileList here: doing so would
// make Runtime.evaluate observe state different from form submission and the
// native input control. The missing bridge belongs in Input/FileList (outside
// this domain's ownership) and is reported as an explicit capability error.
fn setFileInputFiles(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        files: []const []const u8,
        nodeId: Node.Id,
        backendNodeId: ?Node.Id = null,
    })) orelse return error.InvalidParams;
    _ = params.files;
    _ = params.backendNodeId;

    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    const node = bc.node_registry.lookup_by_id.get(params.nodeId) orelse return error.NodeNotFound;
    const input = node.dom.is(DOMNode.Element) orelse return error.NodeIsNotAnElement;
    if (input.is(DOMNode.Element.Html.Input) == null) return error.NodeIsNotAnInput;
    return cmd.sendError(-32000, "DOM.setFileInputFiles requires the native FileList bridge", .{});
}

// Headless Koko has no compositor overlay surface. The command is accepted as
// a lifecycle operation, but no geometry or paint event is fabricated.
fn hideHighlight(cmd: *CDP.Command) !void {
    return cmd.sendResult(null, .{});
}

fn highlightNode(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        nodeId: ?Node.Id = null,
        backendNodeId: ?Node.Id = null,
        objectId: ?[]const u8 = null,
        highlightConfig: struct {
            showInfo: ?bool = null,
            showStyles: ?bool = null,
            showRulers: ?bool = null,
            showExtensionLines: ?bool = null,
        },
    })) orelse return error.InvalidParams;
    _ = params.highlightConfig;

    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    _ = try getNode(cmd.arena, bc, params.nodeId, params.backendNodeId, params.objectId);
    return cmd.sendResult(null, .{});
}

fn highlightRect(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        color: ?struct { r: u8, g: u8, b: u8, a: ?f64 = null } = null,
        outlineColor: ?struct { r: u8, g: u8, b: u8, a: ?f64 = null } = null,
    })) orelse return error.InvalidParams;
    _ = params;
    return cmd.sendResult(null, .{});
}

// https://chromedevtools.github.io/devtools-protocol/tot/DOM/#method-moveTo
fn moveTo(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        nodeId: Node.Id,
        targetNodeId: Node.Id,
        insertBeforeNodeId: ?Node.Id = null,
    })) orelse return error.InvalidParams;

    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    const frame = bc.session.currentFrame() orelse return error.FrameNotLoaded;
    const source = bc.node_registry.lookup_by_id.get(params.nodeId) orelse return error.NodeNotFound;
    const target = bc.node_registry.lookup_by_id.get(params.targetNodeId) orelse return error.NodeNotFound;
    const target_element = target.dom.is(DOMNode.Element) orelse return error.NodeIsNotAnElement;
    if (source.dom == target.dom or source.dom.contains(target.dom)) return error.HierarchyRequest;

    const insert_before = if (params.insertBeforeNodeId) |id_| blk: {
        const n = bc.node_registry.lookup_by_id.get(id_) orelse return error.NodeNotFound;
        if (n.dom._parent != target.dom) return error.NotFound;
        break :blk n.dom;
    } else null;

    if (insert_before) |before| {
        _ = try target_element.asNode().insertBefore(source.dom, before, frame);
    } else {
        _ = try target_element.asNode().appendChild(source.dom, frame);
    }

    return cmd.sendResult(.{ .nodeId = source.id }, .{});
}

fn querySelector(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        nodeId: Node.Id,
        selector: []const u8,
    })) orelse return error.InvalidParams;

    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    const frame = bc.session.currentFrame() orelse return error.FrameNotLoaded;

    const node = bc.node_registry.lookup_by_id.get(params.nodeId) orelse {
        return cmd.sendError(-32000, "Could not find node with given id", .{});
    };

    const element = try Selector.querySelector(node.dom, params.selector, frame) orelse return error.NodeNotFoundForGivenId;
    const dom_node = element.asNode();
    const registered_node = try bc.node_registry.register(dom_node);

    // Dispatch setChildNodesEvents to inform the client of the subpart of node tree covering the results.
    var array = [1]*DOMNode{dom_node};
    try dispatchSetChildNodes(cmd, array[0..]);

    return cmd.sendResult(.{
        .nodeId = registered_node.id,
    }, .{});
}

fn querySelectorAll(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        nodeId: Node.Id,
        selector: []const u8,
    })) orelse return error.InvalidParams;

    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    const frame = bc.session.currentFrame() orelse return error.FrameNotLoaded;

    const node = bc.node_registry.lookup_by_id.get(params.nodeId) orelse {
        return cmd.sendError(-32000, "Could not find node with given id", .{});
    };

    const selected_nodes = try Selector.querySelectorAll(node.dom, params.selector, frame);
    defer selected_nodes.deinit(frame._page);

    const nodes = selected_nodes._nodes;

    const node_ids = try cmd.arena.alloc(Node.Id, nodes.len);
    for (nodes, node_ids) |selected_node, *node_id| {
        node_id.* = (try bc.node_registry.register(selected_node)).id;
    }

    // Dispatch setChildNodesEvents to inform the client of the subpart of node tree covering the results.
    try dispatchSetChildNodes(cmd, nodes);

    return cmd.sendResult(.{
        .nodeIds = node_ids,
    }, .{});
}

fn resolveNode(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        nodeId: ?Node.Id = null,
        backendNodeId: ?u32 = null,
        objectGroup: ?[]const u8 = null,
        executionContextId: ?u32 = null,
    })) orelse return error.InvalidParams;

    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    const frame = bc.session.currentFrame() orelse return error.FrameNotLoaded;

    var ls: ?js.Local.Scope = null;
    defer if (ls) |*_ls| {
        _ls.deinit();
    };

    if (params.executionContextId) |context_id| blk: {
        ls = undefined;
        frame.js.localScope(&ls.?);
        if (ls.?.local.debugContextId() == context_id) {
            break :blk;
        }
        // not the default scope, check the other ones
        for (bc.isolated_worlds.items) |isolated_world| {
            ls.?.deinit();
            ls = null;

            const ctx = (isolated_world.context orelse return error.ContextNotFound);
            ls = undefined;
            ctx.localScope(&ls.?);
            if (ls.?.local.debugContextId() == context_id) {
                break :blk;
            }
        } else return error.ContextNotFound;
    } else {
        ls = undefined;
        frame.js.localScope(&ls.?);
    }

    const input_node_id = params.nodeId orelse params.backendNodeId orelse return error.InvalidParam;
    const node = bc.node_registry.lookup_by_id.get(input_node_id) orelse return error.UnknownNode;

    // node._node is a *DOMNode we need this to be able to find its most derived type e.g. Node -> Element -> HTMLElement
    // So we use the Node.Union when retrieve the value from the environment
    const remote_object = try bc.inspector_session.getRemoteObject(
        &ls.?.local,
        params.objectGroup orelse "",
        node.dom,
    );
    defer remote_object.deinit();

    const arena = cmd.arena;
    return cmd.sendResult(.{ .object = .{
        .type = try remote_object.getType(arena),
        .subtype = try remote_object.getSubtype(arena),
        .className = try remote_object.getClassName(arena),
        .description = try remote_object.getDescription(arena),
        .objectId = try remote_object.getObjectId(arena),
    } }, .{});
}

fn describeNode(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        nodeId: ?Node.Id = null,
        backendNodeId: ?Node.Id = null,
        objectId: ?[]const u8 = null,
        depth: i32 = 1,
        pierce: bool = false,
    })) orelse return error.InvalidParams;

    if (params.pierce) {
        log.warn(.not_implemented, "DOM.describeNode", .{ .param = "pierce" });
    }
    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;

    const node = try getNode(cmd.arena, bc, params.nodeId, params.backendNodeId, params.objectId);

    return cmd.sendResult(.{ .node = bc.nodeWriter(node, .{ .depth = params.depth }) }, .{});
}

// An array of quad vertices, x immediately followed by y for each point, points clock-wise.
// Note Y points downward
// We are assuming the start/endpoint is not repeated.
const Quad = [8]f64;

const BoxModel = struct {
    content: Quad,
    padding: Quad,
    border: Quad,
    margin: Quad,
    width: i32,
    height: i32,
    // shapeOutside: ?ShapeOutsideInfo,
};

fn rectToQuad(rect: DOMNode.Element.DOMRect) Quad {
    return Quad{
        rect._x,
        rect._y,
        rect._x + rect._width,
        rect._y,
        rect._x + rect._width,
        rect._y + rect._height,
        rect._x,
        rect._y + rect._height,
    };
}

fn scrollIntoViewIfNeeded(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        nodeId: ?Node.Id = null,
        backendNodeId: ?u32 = null,
        objectId: ?[]const u8 = null,
        rect: ?DOMNode.Element.DOMRect = null,
    })) orelse return error.InvalidParams;
    // Only 1 of nodeId, backendNodeId, objectId may be set, but chrome just takes the first non-null

    // We retrieve the node to at least check if it exists and is valid.
    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    const node = try getNode(cmd.arena, bc, params.nodeId, params.backendNodeId, params.objectId);

    switch (node.dom._type) {
        .element => {
            const frame = bc.session.currentFrame() orelse return error.FrameNotLoaded;
            const element = node.dom.is(DOMNode.Element) orelse return error.NodeDoesNotHaveGeometry;
            try element.scrollIntoViewIfNeeded(null, node.dom.ownerFrame(frame));
        },
        .document => {},
        .cdata => {},
        else => return error.NodeDoesNotHaveGeometry,
    }

    return cmd.sendResult(null, .{});
}

fn getNode(arena: Allocator, bc: *CDP.BrowserContext, node_id: ?Node.Id, backend_node_id: ?Node.Id, object_id: ?[]const u8) !*Node {
    const input_node_id = node_id orelse backend_node_id;
    if (input_node_id) |input_node_id_| {
        return bc.node_registry.lookup_by_id.get(input_node_id_) orelse return error.NodeNotFound;
    }
    if (object_id) |object_id_| {
        const frame = bc.session.currentFrame() orelse return error.FrameNotLoaded;
        var ls: js.Local.Scope = undefined;
        frame.js.localScope(&ls);
        defer ls.deinit();

        // Retrieve the object from which ever context it is in.
        const parser_node = try bc.inspector_session.getNodePtr(arena, object_id_, &ls.local);
        return try bc.node_registry.register(@ptrCast(@alignCast(parser_node)));
    }
    return error.MissingParams;
}

// https://chromedevtools.github.io/devtools-protocol/tot/DOM/#method-getContentQuads
// Related to: https://drafts.csswg.org/cssom-view/#the-geometryutils-interface
fn getContentQuads(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        nodeId: ?Node.Id = null,
        backendNodeId: ?Node.Id = null,
        objectId: ?[]const u8 = null,
    })) orelse return error.InvalidParams;

    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    const frame = bc.session.currentFrame() orelse return error.FrameNotLoaded;

    const node = try getNode(cmd.arena, bc, params.nodeId, params.backendNodeId, params.objectId);

    // TODO likely if the following CSS properties are set the quads should be empty
    // visibility: hidden
    // display: none

    if (node.dom.is(DOMNode.Document)) |doc| {
        const wp = frame.windowProfile();
        const w: f64 = @floatFromInt(wp.inner_width);
        const h: f64 = @floatFromInt(wp.inner_height);
        const quad = rectToQuad(.{ ._x = 0, ._y = 0, ._width = w, ._height = h });
        _ = doc;
        return cmd.sendResult(.{ .quads = &.{quad} }, .{});
    }

    const Text = @import("../../../core/webapi/cdata/Text.zig");
    if (node.dom.is(Text)) |text| {
        if (text.getWholeText().len == 0) {
            const empty_quad: Quad = .{0} ** 8;
            return cmd.sendResult(.{ .quads = &.{empty_quad} }, .{});
        }
        if (text._proto.asNode().parentElement()) |parent_el| {
            const quad = rectToQuad(parent_el.getBoundingClientRect(frame));
            return cmd.sendResult(.{ .quads = &.{quad} }, .{});
        }
        const empty_quad: Quad = .{0} ** 8;
        return cmd.sendResult(.{ .quads = &.{empty_quad} }, .{});
    }

    const element = node.dom.is(DOMNode.Element) orelse return error.NodeIsNotAnElement;
    const quad = rectToQuad(element.getBoundingClientRect(frame));
    return cmd.sendResult(.{ .quads = &.{quad} }, .{});
}

fn getBoxModel(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        nodeId: ?Node.Id = null,
        backendNodeId: ?u32 = null,
        objectId: ?[]const u8 = null,
    })) orelse return error.InvalidParams;

    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    const frame = bc.session.currentFrame() orelse return error.FrameNotLoaded;

    const node = try getNode(cmd.arena, bc, params.nodeId, params.backendNodeId, params.objectId);

    // TODO implement for document or text
    const element = node.dom.is(DOMNode.Element) orelse return error.NodeIsNotAnElement;

    const rect = element.getBoundingClientRect(frame);
    const quad = rectToQuad(rect);
    const zero = [_]f64{0.0} ** 8;

    return cmd.sendResult(.{ .model = BoxModel{
        .content = quad,
        .padding = zero,
        .border = zero,
        .margin = zero,
        .width = @intFromFloat(rect._width),
        .height = @intFromFloat(rect._height),
    } }, .{});
}

fn requestChildNodes(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        nodeId: Node.Id,
        depth: i32 = 1,
        pierce: bool = false,
    })) orelse return error.InvalidParams;

    if (params.depth == 0) return error.InvalidParams;
    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    const session_id = bc.session_id orelse return error.SessionIdNotLoaded;
    const node = bc.node_registry.lookup_by_id.get(params.nodeId) orelse {
        return error.InvalidNode;
    };

    try cmd.sendEvent("DOM.setChildNodes", .{
        .parentId = node.id,
        .nodes = bc.nodeWriter(node, .{ .depth = params.depth, .exclude_root = true }),
    }, .{
        .session_id = session_id,
    });

    return cmd.sendResult(null, .{});
}

fn getFrameOwner(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        frameId: []const u8,
    })) orelse return error.InvalidParams;

    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    const frame_id = try id.parseFrameId(params.frameId);

    const frame = bc.session.findFrameByFrameId(frame_id) orelse {
        return cmd.sendError(-32000, "Frame with the given id does not belong to the target.", .{});
    };

    const node = try bc.node_registry.register(frame.window._document.asNode());
    return cmd.sendResult(.{ .nodeId = node.id, .backendNodeId = node.id }, .{});
}

fn getOuterHTML(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        nodeId: ?Node.Id = null,
        backendNodeId: ?Node.Id = null,
        objectId: ?[]const u8 = null,
        includeShadowDOM: bool = false,
    })) orelse return error.InvalidParams;

    if (params.includeShadowDOM) {
        log.warn(.not_implemented, "DOM.getOuterHTML", .{ .param = "includeShadowDOM" });
    }
    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    const frame = bc.session.currentFrame() orelse return error.FrameNotLoaded;

    const node = try getNode(cmd.arena, bc, params.nodeId, params.backendNodeId, params.objectId);

    var aw = std.Io.Writer.Allocating.init(cmd.arena);
    try dump.deep(node.dom, .{}, &aw.writer, frame);

    return cmd.sendResult(.{ .outerHTML = aw.written() }, .{});
}

fn requestNode(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        objectId: []const u8,
    })) orelse return error.InvalidParams;

    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    const node = try getNode(cmd.arena, bc, null, null, params.objectId);

    return cmd.sendResult(.{ .nodeId = node.id }, .{});
}

const testing = @import("../testing.zig");
test "cdp.dom: getSearchResults unknown search id" {
    var ctx = try testing.context();
    defer ctx.deinit();

    try ctx.processMessage(.{
        .id = 8,
        .method = "DOM.getSearchResults",
        .params = .{ .searchId = "Nope", .fromIndex = 0, .toIndex = 10 },
    });
    try ctx.expectSentError(-31998, "BrowserContextNotLoaded", .{ .id = 8 });
}

test "cdp.dom: search flow" {
    var ctx = try testing.context();
    defer ctx.deinit();

    _ = try ctx.loadBrowserContext(.{ .id = "BID-A", .url = "cdp/dom1.html" });

    try ctx.processMessage(.{
        .id = 12,
        .method = "DOM.performSearch",
        .params = .{ .query = "p" },
    });
    try ctx.expectSentResult(.{ .searchId = "0", .resultCount = 2 }, .{ .id = 12 });

    {
        // getSearchResults
        try ctx.processMessage(.{
            .id = 13,
            .method = "DOM.getSearchResults",
            .params = .{ .searchId = "0", .fromIndex = 0, .toIndex = 2 },
        });
        try ctx.expectSentResult(.{ .nodeIds = &.{ 1, 2 } }, .{ .id = 13 });

        // different fromIndex
        try ctx.processMessage(.{
            .id = 14,
            .method = "DOM.getSearchResults",
            .params = .{ .searchId = "0", .fromIndex = 1, .toIndex = 2 },
        });
        try ctx.expectSentResult(.{ .nodeIds = &.{2} }, .{ .id = 14 });

        // different toIndex
        try ctx.processMessage(.{
            .id = 15,
            .method = "DOM.getSearchResults",
            .params = .{ .searchId = "0", .fromIndex = 0, .toIndex = 1 },
        });
        try ctx.expectSentResult(.{ .nodeIds = &.{1} }, .{ .id = 15 });
    }

    try ctx.processMessage(.{
        .id = 16,
        .method = "DOM.discardSearchResults",
        .params = .{ .searchId = "0" },
    });
    try ctx.expectSentResult(null, .{ .id = 16 });

    // make sure the delete actually did something
    try ctx.processMessage(.{
        .id = 17,
        .method = "DOM.getSearchResults",
        .params = .{ .searchId = "0", .fromIndex = 0, .toIndex = 1 },
    });
    try ctx.expectSentError(-31998, "SearchResultNotFound", .{ .id = 17 });
}

test "cdp.dom: empty search result range is valid" {
    var ctx = try testing.context();
    defer ctx.deinit();

    _ = try ctx.loadBrowserContext(.{ .id = "BID-A", .url = "cdp/dom1.html" });

    try ctx.processMessage(.{
        .id = 20,
        .method = "DOM.performSearch",
        .params = .{ .query = "selector-that-does-not-match" },
    });
    try ctx.expectSentResult(.{ .searchId = "0", .resultCount = 0 }, .{ .id = 20 });

    try ctx.processMessage(.{
        .id = 21,
        .method = "DOM.getSearchResults",
        .params = .{ .searchId = "0", .fromIndex = 0, .toIndex = 0 },
    });
    try ctx.expectSentResult(.{ .nodeIds = &.{} }, .{ .id = 21 });
}

test "cdp.dom: querySelector unknown search id" {
    var ctx = try testing.context();
    defer ctx.deinit();

    _ = try ctx.loadBrowserContext(.{ .id = "BID-A", .url = "cdp/dom1.html" });

    try ctx.processMessage(.{
        .id = 9,
        .method = "DOM.querySelector",
        .params = .{ .nodeId = 99, .selector = "" },
    });
    try ctx.expectSentError(-32000, "Could not find node with given id", .{});

    try ctx.processMessage(.{
        .id = 9,
        .method = "DOM.querySelectorAll",
        .params = .{ .nodeId = 99, .selector = "" },
    });
    try ctx.expectSentError(-32000, "Could not find node with given id", .{});
}

test "cdp.dom: querySelector Node not found" {
    var ctx = try testing.context();
    defer ctx.deinit();

    _ = try ctx.loadBrowserContext(.{ .id = "BID-A", .url = "cdp/dom1.html" });

    try ctx.processMessage(.{ // Hacky way to make sure nodeId 1 exists in the registry
        .id = 3,
        .method = "DOM.performSearch",
        .params = .{ .query = "p" },
    });
    try ctx.expectSentResult(.{ .searchId = "0", .resultCount = 2 }, .{ .id = 3 });

    try ctx.processMessage(.{
        .id = 4,
        .method = "DOM.querySelector",
        .params = .{ .nodeId = 1, .selector = "a" },
    });
    try ctx.expectSentError(-31998, "NodeNotFoundForGivenId", .{ .id = 4 });

    try ctx.processMessage(.{
        .id = 5,
        .method = "DOM.querySelectorAll",
        .params = .{ .nodeId = 1, .selector = "a" },
    });
    try ctx.expectSentResult(.{ .nodeIds = &[_]u32{} }, .{ .id = 5 });
}

test "cdp.dom: querySelector Nodes found" {
    var ctx = try testing.context();
    defer ctx.deinit();

    _ = try ctx.loadBrowserContext(.{ .id = "BID-A", .url = "cdp/dom2.html" });

    try ctx.processMessage(.{ // Hacky way to make sure nodeId 1 exists in the registry
        .id = 3,
        .method = "DOM.performSearch",
        .params = .{ .query = "div" },
    });
    try ctx.expectSentResult(.{ .searchId = "0", .resultCount = 1 }, .{ .id = 3 });

    try ctx.processMessage(.{
        .id = 4,
        .method = "DOM.querySelector",
        .params = .{ .nodeId = 1, .selector = "p" },
    });
    try ctx.expectSentEvent("DOM.setChildNodes", null, .{});
    const query_result = (try ctx.getSentMessageById(4)).?.object.get("result").?.object;
    const paragraph_node_id = query_result.get("nodeId").?.integer;
    try testing.expect(paragraph_node_id > 0);

    try ctx.processMessage(.{
        .id = 5,
        .method = "DOM.querySelectorAll",
        .params = .{ .nodeId = 1, .selector = "p" },
    });
    try ctx.expectSentEvent("DOM.setChildNodes", null, .{});
    try ctx.expectSentResult(.{ .nodeIds = &.{paragraph_node_id} }, .{ .id = 5 });
}

test "cdp.dom: getBoxModel" {
    var ctx = try testing.context();
    defer ctx.deinit();

    _ = try ctx.loadBrowserContext(.{ .id = "BID-A", .url = "cdp/dom2.html" });

    try ctx.processMessage(.{ // Hacky way to make sure nodeId 1 exists in the registry
        .id = 3,
        .method = "DOM.getDocument",
    });

    try ctx.processMessage(.{
        .id = 4,
        .method = "DOM.querySelector",
        .params = .{ .nodeId = 1, .selector = "p" },
    });
    const query_result = (try ctx.getSentMessageById(4)).?.object.get("result").?.object;
    const paragraph_node_id = query_result.get("nodeId").?.integer;
    try testing.expect(paragraph_node_id > 0);

    // Box model on the <p> nodeId returned above.
    // Note: nodeId 6 is <head>, which is `display: none` per HTML Rendering
    // §15.3.1, so its box model is all-zeros — exercise a visible element.
    try ctx.processMessage(.{
        .id = 5,
        .method = "DOM.getBoxModel",
        .params = .{ .nodeId = paragraph_node_id },
    });
    const box_result = (try ctx.getSentMessageById(5)).?.object.get("result").?.object;
    const model = box_result.get("model").?.object;
    try testing.expect(model.get("content").?.array.items.len == 8);
    try testing.expect(model.get("width").?.integer > 0);
    try testing.expect(model.get("height").?.integer > 0);
}

test "cdp.dom: scrollIntoViewIfNeeded scrolls the target element" {
    var ctx = try testing.context();
    defer ctx.deinit();

    _ = try ctx.loadBrowserContext(.{ .id = "BID-SCROLL", .url = "cdp/dom_scroll_into_view.html" });
    const bc = ctx.cdp().browser_context.?;
    const frame = bc.session.currentFrame().?;
    try testing.expectEqual(@as(u32, 0), frame.window.getScrollY());

    try ctx.processMessage(.{
        .id = 3,
        .method = "DOM.getDocument",
    });
    try ctx.processMessage(.{
        .id = 4,
        .method = "DOM.querySelector",
        .params = .{ .nodeId = 1, .selector = "#target" },
    });
    try ctx.expectSentEvent("DOM.setChildNodes", null, .{});
    const query_result = (try ctx.getSentMessageById(4)).?.object.get("result").?.object;
    const target_node_id = query_result.get("nodeId").?.integer;

    try ctx.processMessage(.{
        .id = 5,
        .method = "DOM.scrollIntoViewIfNeeded",
        .params = .{ .nodeId = target_node_id },
    });
    try ctx.expectSentResult(null, .{ .id = 5 });
    try testing.expect(frame.window.getScrollY() > 0);
}
