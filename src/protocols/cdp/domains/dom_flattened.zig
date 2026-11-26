//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.

const std = @import("std");

const CDP = @import("../CDP.zig");
const Node = @import("../Node.zig");
const DOMNode = @import("../../../core/dom/Node.zig");
const Frame = @import("../../../core/browser/Frame.zig");

const FlattenedWriter = struct {
    root: *const Node,
    depth: i32,
    registry: *Node.Registry,

    pub fn jsonStringify(self: *const FlattenedWriter, writer: anytype) error{WriteFailed}!void {
        writer.beginArray() catch return error.WriteFailed;
        self.writeNode(self.root, 0, writer) catch return error.WriteFailed;
        writer.endArray() catch return error.WriteFailed;
    }

    fn writeNode(self: *const FlattenedWriter, node: *const Node, depth: usize, writer: anytype) !void {
        try writer.beginObject();
        try self.writeNodeFields(node, writer);
        try writer.endObject();

        if (self.depth >= 0 and depth >= @as(usize, @intCast(self.depth))) return;
        var children = node.dom.childrenIterator();
        while (children.next()) |dom_child| {
            const child = try self.registry.register(dom_child);
            try self.writeNode(child, depth + 1, writer);
        }
    }

    fn writeNodeFields(self: *const FlattenedWriter, node: *const Node, writer: anytype) !void {
        try writer.objectField("nodeId");
        try writer.write(node.id);
        try writer.objectField("backendNodeId");
        try writer.write(node.id);

        if (node.dom._parent) |parent| {
            const registered_parent = try self.registry.register(parent);
            try writer.objectField("parentId");
            try writer.write(registered_parent.id);
        }

        if (node.dom.is(DOMNode.Element)) |element| {
            try writer.objectField("localName");
            try writer.write(element.getLocalName());
            if (element.hasAttributes()) {
                try writer.objectField("attributes");
                try writer.beginArray();
                var attributes = element.attributeIterator();
                while (attributes.next()) |attribute| {
                    try writer.write(attribute._name.str());
                    try writer.write(attribute._value.str());
                }
                try writer.endArray();
            }
        } else {
            try writer.objectField("localName");
            try writer.write("");
        }

        try writer.objectField("nodeType");
        try writer.write(node.dom.getNodeType());
        try writer.objectField("nodeName");
        var name_buffer: [Frame.BUF_SIZE]u8 = undefined;
        try writer.write(node.dom.getNodeName(&name_buffer));
        try writer.objectField("nodeValue");
        try writer.write(if (node.dom.getNodeValue()) |value| value.str() else "");
        try writer.objectField("childNodeCount");
        try writer.write(node.dom.getChildrenCount());
        try writer.objectField("documentURL");
        try writer.write(null);
        try writer.objectField("baseURL");
        try writer.write(null);
        try writer.objectField("xmlVersion");
        try writer.write("");
        try writer.objectField("compatibilityMode");
        try writer.write("NoQuirksMode");
    }
};

pub fn processMessage(cmd: *CDP.Command) !void {
    if (!std.mem.eql(u8, cmd.input.action, "getFlattenedDocument")) return error.UnknownMethod;

    const Params = struct {
        depth: i32 = -1,
        pierce: bool = false,
    };
    const params = (try cmd.params(Params)) orelse Params{};
    if (params.depth < -1) return error.InvalidParams;
    if (params.pierce) return error.NotImplemented;

    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    const frame = bc.session.currentFrame() orelse return error.FrameNotLoaded;
    const document = try bc.node_registry.register(frame.window._document.asNode());
    return cmd.sendResult(.{ .nodes = FlattenedWriter{
        .root = document,
        .depth = params.depth,
        .registry = &bc.node_registry,
    } }, .{});
}
