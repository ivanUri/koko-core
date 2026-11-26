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
const CDP = @import("../CDP.zig");
const Node = @import("../Node.zig");
const DOMNode = @import("../../../core/dom/Node.zig");
const Frame = @import("../../../core/browser/Frame.zig");
const ComputedStyleProps = @import("../../../core/webapi/css/computed_style_properties.zig");

const ComputedStyle = struct {
    name: []const u8,
    value: []const u8,
};

pub fn processMessage(cmd: *CDP.Command) !void {
    const action = std.meta.stringToEnum(enum {
        enable,
        getComputedStyleForNode,
    }, cmd.input.action) orelse return error.UnknownMethod;

    switch (action) {
        .enable => return cmd.sendResult(null, .{}),
        .getComputedStyleForNode => return getComputedStyleForNode(cmd),
    }
}

/// https://chromedevtools.github.io/devtools-protocol/tot/CSS/#method-getComputedStyleForNode
///
/// This intentionally reads the same Stylo-backed serialization used by
/// Window.getComputedStyle().  It does not fall back to the retired handwritten
/// cascade or synthesize defaults when Stylo cannot answer a property.
fn getComputedStyleForNode(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        nodeId: Node.Id,
    })) orelse return error.InvalidParams;

    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    const registered = bc.node_registry.lookup_by_id.get(params.nodeId) orelse {
        return error.NodeNotFound;
    };
    const element = registered.dom.is(DOMNode.Element) orelse return error.NodeIsNotAnElement;
    const frame = element.asNode().ownerFrame(bc.session.currentFrame() orelse return error.FrameNotLoaded);

    const prepare_status = frame.styleEngine().prepareForLayout();
    if (prepare_status != .ok and prepare_status != .ready) {
        return error.NotImplemented;
    }

    var computed_list: std.ArrayListUnmanaged(ComputedStyle) = .empty;
    for (ComputedStyleProps.names) |property| {
        if (try readComputedValue(cmd, frame, element.asNode(), property)) |value| {
            try computed_list.append(cmd.arena, .{ .name = property, .value = value });
        }
    }
    if (computed_list.items.len == 0) return error.NotImplemented;

    return cmd.sendResult(.{ .computedStyle = computed_list.items }, .{});
}

fn readComputedValue(
    cmd: *CDP.Command,
    frame: *Frame,
    node: *DOMNode,
    property: []const u8,
) !?[]const u8 {
    const node_id = frame.styleNodeId(node);
    var output = try cmd.arena.alloc(u8, 4096);
    var result = frame.styleEngine().computedValue(node_id, property, output);
    if (result.status == .output_buffer_too_small and result.bytes_written > output.len) {
        output = try cmd.arena.alloc(u8, result.bytes_written);
        result = frame.styleEngine().computedValue(node_id, property, output);
    }
    if (!result.isOk()) return null;
    return try cmd.arena.dupe(u8, output[0..result.bytes_written]);
}
