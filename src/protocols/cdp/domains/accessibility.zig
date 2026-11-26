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

const GetFullAXTreeParams = struct {
    depth: ?i32 = null,
    frameId: ?[]const u8 = null,
};

const QueryAXTreeParams = struct {
    nodeId: ?Node.Id = null,
    backendNodeId: ?Node.Id = null,
    objectId: ?[]const u8 = null,
    accessibleName: ?[]const u8 = null,
    role: ?[]const u8 = null,
};

pub fn processMessage(cmd: *CDP.Command) !void {
    const action = std.meta.stringToEnum(enum {
        enable,
        disable,
        getFullAXTree,
        queryAXTree,
    }, cmd.input.action) orelse return error.UnknownMethod;

    switch (action) {
        .enable => return enable(cmd),
        .disable => return disable(cmd),
        .getFullAXTree => return getFullAXTree(cmd),
        .queryAXTree => return queryAXTree(cmd),
    }
}
fn enable(cmd: *CDP.Command) !void {
    return cmd.sendResult(null, .{});
}

fn disable(cmd: *CDP.Command) !void {
    return cmd.sendResult(null, .{});
}

fn getFullAXTree(cmd: *CDP.Command) !void {
    const params = (try cmd.params(GetFullAXTreeParams)) orelse GetFullAXTreeParams{};

    const max_depth: ?usize = if (params.depth) |depth| blk: {
        if (depth < 0) return error.InvalidParams;
        break :blk @intCast(depth);
    } else null;

    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    const session = bc.session;

    const frame = blk: {
        const frame_id = params.frameId orelse {
            break :blk session.currentFrame() orelse return error.FrameNotLoaded;
        };
        break :blk session.findFrameByFrameId(try id.parseFrameId(frame_id)) orelse {
            return cmd.sendError(-32000, "Frame with the given id does not belong to the target.", .{});
        };
    };

    const doc = frame.window._document.asNode();
    const node = try bc.node_registry.register(doc);

    const temp_arena = try frame.getArena(.medium, "AXNode");
    defer frame.releaseArena(temp_arena);

    return cmd.sendResult(.{ .nodes = try bc.axnodeWriter(temp_arena, node, .{ .max_depth = max_depth }) }, .{});
}

fn queryAXTree(cmd: *CDP.Command) !void {
    const params = (try cmd.params(QueryAXTreeParams)) orelse return error.InvalidParams;

    if (params.objectId != null) {
        return cmd.sendError(-32602, "Accessibility.queryAXTree objectId is not supported.", .{});
    }

    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    const root = blk: {
        const root_id = params.backendNodeId orelse params.nodeId orelse {
            return cmd.sendError(-32602, "Accessibility.queryAXTree requires nodeId or backendNodeId.", .{});
        };
        break :blk bc.node_registry.lookup_by_id.get(root_id) orelse {
            return cmd.sendError(-32000, "No node with the given id found.", .{});
        };
    };

    const frame = bc.session.currentFrame() orelse return error.FrameNotLoaded;
    const temp_arena = try frame.getArena(.medium, "AXNode.queryAXTree");
    defer frame.releaseArena(temp_arena);

    // Reuse AXNode.Writer for role/name computation and visibility pruning. The
    // writer emits the complete AX subtree; queryAXTree then returns only the
    // matching AX nodes, as required by the CDP contract.
    const writer = try bc.axnodeWriter(temp_arena, root, .{});
    const encoded = try std.json.Stringify.valueAlloc(cmd.arena, .{ .nodes = writer }, .{});
    const tree = try std.json.parseFromSliceLeaky(std.json.Value, cmd.arena, encoded, .{});
    const all_nodes = tree.object.get("nodes").?.array.items;
    const matches = try cmd.arena.alloc(std.json.Value, all_nodes.len);
    var match_count: usize = 0;

    for (all_nodes) |node| {
        if (!matchesQuery(node, params.accessibleName, params.role)) continue;
        matches[match_count] = node;
        match_count += 1;
    }

    return cmd.sendResult(.{ .nodes = matches[0..match_count] }, .{});
}

fn matchesQuery(node: std.json.Value, accessible_name: ?[]const u8, role: ?[]const u8) bool {
    if (node != .object) return false;

    if (accessible_name) |expected| {
        const name = node.object.get("name") orelse return false;
        if (name != .object) return false;
        const value = name.object.get("value") orelse return false;
        if (value != .string or !std.mem.eql(u8, value.string, expected)) return false;
    }

    if (role) |expected| {
        const role_value = node.object.get("role") orelse return false;
        if (role_value != .object) return false;
        const value = role_value.object.get("value") orelse return false;
        if (value != .string or !std.mem.eql(u8, value.string, expected)) return false;
    }

    return true;
}

test "Accessibility.queryAXTree matches AX role and accessible name" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const node = try std.json.parseFromSliceLeaky(
        std.json.Value,
        arena.allocator(),
        "{\"role\":{\"value\":\"checkbox\"},\"name\":{\"value\":\"Wifi enabled\"}}",
        .{},
    );

    try std.testing.expect(matchesQuery(node, "Wifi enabled", "checkbox"));
    try std.testing.expect(matchesQuery(node, null, "checkbox"));
    try std.testing.expect(!matchesQuery(node, "Bluetooth enabled", "checkbox"));
    try std.testing.expect(!matchesQuery(node, "Wifi enabled", "button"));
    try std.testing.expect(matchesQuery(node, null, null));
}
