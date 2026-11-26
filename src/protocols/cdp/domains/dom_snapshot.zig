//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This diagnostic adapter snapshots Koko's authoritative Zig DOM. Computed
// style values are read from Stylo; this file never invents CSS values.

const std = @import("std");

const CDP = @import("../CDP.zig");
const DOMNode = @import("../../../core/dom/Node.zig");
const Frame = @import("../../../core/browser/Frame.zig");

const NodeTable = struct {
    parentIndex: []const i32,
    nodeType: []const u8,
    nodeName: []const u32,
    nodeValue: []const u32,
};

const LayoutTable = struct {
    nodeIndex: []const u32,
    styles: []const []const u32,
};

const DocumentSnapshot = struct {
    documentURL: u32,
    title: u32,
    baseURL: u32,
    nodes: NodeTable,
    layout: LayoutTable,
};

pub fn processMessage(cmd: *CDP.Command) !void {
    if (!std.mem.eql(u8, cmd.input.action, "captureSnapshot")) return error.UnknownMethod;

    const Params = struct {
        computedStyles: []const []const u8 = &.{},
        includePaintOrder: bool = false,
        includeDOMRects: bool = false,
        includeBlendedBackgroundColors: bool = false,
        includeTextColorOpacities: bool = false,
    };
    const params = (try cmd.params(Params)) orelse Params{};
    _ = params.includePaintOrder;
    _ = params.includeDOMRects;
    _ = params.includeBlendedBackgroundColors;
    _ = params.includeTextColorOpacities;

    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    const frame = bc.session.currentFrame() orelse return error.FrameNotLoaded;
    const document = frame.window._document.asNode();

    var nodes: std.ArrayListUnmanaged(*DOMNode) = .empty;
    var parents: std.ArrayListUnmanaged(i32) = .empty;
    try collectNodes(cmd.arena, document, -1, &nodes, &parents);

    var strings: std.ArrayListUnmanaged([]const u8) = .empty;
    var string_ids: std.StringHashMapUnmanaged(u32) = .empty;
    const document_url = try intern(cmd.arena, &strings, &string_ids, frame.url);
    const title = try intern(cmd.arena, &strings, &string_ids, (frame.getTitle() catch null) orelse "");
    const base_url = try intern(cmd.arena, &strings, &string_ids, frame.base());

    const parent_index = try cmd.arena.alloc(i32, nodes.items.len);
    const node_type = try cmd.arena.alloc(u8, nodes.items.len);
    const node_name = try cmd.arena.alloc(u32, nodes.items.len);
    const node_value = try cmd.arena.alloc(u32, nodes.items.len);
    var name_buffer: [Frame.BUF_SIZE]u8 = undefined;
    for (nodes.items, 0..) |node, index| {
        parent_index[index] = parents.items[index];
        node_type[index] = node.getNodeType();
        node_name[index] = try intern(cmd.arena, &strings, &string_ids, node.getNodeName(&name_buffer));
        node_value[index] = try intern(cmd.arena, &strings, &string_ids, if (node.getNodeValue()) |value| value.str() else "");
    }

    var layout_node_index: std.ArrayListUnmanaged(u32) = .empty;
    var layout_styles: std.ArrayListUnmanaged([]const u32) = .empty;
    if (params.computedStyles.len > 0) {
        const prepare_status = frame.styleEngine().prepareForLayout();
        if (prepare_status != .ok and prepare_status != .ready) return error.NotImplemented;
    }

    for (nodes.items, 0..) |node, index| {
        _ = node.is(DOMNode.Element) orelse continue;
        try layout_node_index.append(cmd.arena, @intCast(index));
        const style_ids = try cmd.arena.alloc(u32, params.computedStyles.len);
        for (params.computedStyles, 0..) |property, style_index| {
            const value = try readComputedValue(cmd, frame, node, property);
            style_ids[style_index] = try intern(cmd.arena, &strings, &string_ids, value);
        }
        try layout_styles.append(cmd.arena, style_ids);
    }

    const documents = try cmd.arena.alloc(DocumentSnapshot, 1);
    documents[0] = .{
        .documentURL = document_url,
        .title = title,
        .baseURL = base_url,
        .nodes = .{
            .parentIndex = parent_index,
            .nodeType = node_type,
            .nodeName = node_name,
            .nodeValue = node_value,
        },
        .layout = .{
            .nodeIndex = layout_node_index.items,
            .styles = layout_styles.items,
        },
    };

    return cmd.sendResult(.{ .documents = documents, .strings = strings.items }, .{});
}

fn collectNodes(
    arena: std.mem.Allocator,
    node: *DOMNode,
    parent_index: i32,
    nodes: *std.ArrayListUnmanaged(*DOMNode),
    parents: *std.ArrayListUnmanaged(i32),
) !void {
    const index = nodes.items.len;
    try nodes.append(arena, node);
    try parents.append(arena, parent_index);
    var children = node.childrenIterator();
    while (children.next()) |child| {
        if (index > @as(usize, std.math.maxInt(i32))) return error.OutOfMemory;
        try collectNodes(arena, child, @intCast(index), nodes, parents);
    }
}

fn intern(
    arena: std.mem.Allocator,
    strings: *std.ArrayListUnmanaged([]const u8),
    ids: *std.StringHashMapUnmanaged(u32),
    value: []const u8,
) !u32 {
    if (ids.get(value)) |existing| return existing;
    const copy = try arena.dupe(u8, value);
    const index: u32 = @intCast(strings.items.len);
    try strings.append(arena, copy);
    try ids.put(arena, copy, index);
    return index;
}

fn readComputedValue(
    cmd: *CDP.Command,
    frame: *Frame,
    node: *DOMNode,
    property: []const u8,
) ![]const u8 {
    const node_id = frame.styleNodeId(node);
    var output = try cmd.arena.alloc(u8, 4096);
    var result = frame.styleEngine().computedValue(node_id, property, output);
    if (result.status == .output_buffer_too_small and result.bytes_written > output.len) {
        output = try cmd.arena.alloc(u8, result.bytes_written);
        result = frame.styleEngine().computedValue(node_id, property, output);
    }
    if (!result.isOk()) return error.NotImplemented;
    return try cmd.arena.dupe(u8, output[0..result.bytes_written]);
}
