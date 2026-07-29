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
const builtin = @import("builtin");

const CDP = @import("../CDP.zig");

pub fn processMessage(cmd: *CDP.Command) !void {
    const action = std.meta.stringToEnum(enum {
        enable,
        runIfWaitingForDebugger,
        evaluate,
        addBinding,
        callFunctionOn,
        releaseObject,
        getProperties,
    }, cmd.input.action) orelse return error.UnknownMethod;

    switch (action) {
        .runIfWaitingForDebugger => return cmd.sendResult(null, .{}),
        else => return sendInspector(cmd, action),
    }
}

fn sendInspector(cmd: *CDP.Command, action: anytype) !void {
    // save script in file at debug mode
    if (builtin.mode == .Debug) {
        try logInspector(cmd, action);
    }

    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;

    // All frame targets share one V8 Inspector session. V8 therefore uses the
    // root context when Runtime.evaluate omits contextId, even when the CDP
    // command arrived on an attached iframe session. CDP target semantics say
    // the default execution context belongs to that target. Bind an otherwise
    // unscoped evaluate to the frame selected by CDP.dispatch.
    if (action == .evaluate) {
        if (try bindEvaluateToSelectedFrame(cmd, bc)) |scoped_json| {
            bc.callInspector(scoped_json);
            return;
        }
    }

    // the result to return is handled directly by the inspector.
    bc.callInspector(cmd.input.json);
}

fn bindEvaluateToSelectedFrame(cmd: *CDP.Command, bc: *CDP.BrowserContext) !?[]const u8 {
    const selected_frame_id = bc.frameIdForSession(cmd.input.session_id) orelse return null;
    const main_frame = bc.session.currentFrame() orelse return null;
    if (selected_frame_id == main_frame._frame_id) return null;

    var message = try std.json.parseFromSliceLeaky(std.json.Value, cmd.arena, cmd.input.json, .{});
    const root = switch (message) {
        .object => |*object| object,
        else => return null,
    };
    const params_value = root.getPtr("params") orelse return null;
    const params = switch (params_value.*) {
        .object => |*object| object,
        else => return null,
    };
    if (params.contains("contextId")) return null;

    const frame = bc.frameForId(selected_frame_id) orelse return error.FrameNotLoaded;
    var ls: @import("../../../core/js/js.zig").Local.Scope = undefined;
    frame.js.localScope(&ls);
    defer ls.deinit();

    const context_id = bc.inspector_session.inspector.getContextId(&ls.local);
    try params.put("contextId", .{ .integer = context_id });
    const scoped_json = try std.json.Stringify.valueAlloc(cmd.arena, message, .{});
    return scoped_json;
}

fn logInspector(cmd: *CDP.Command, action: anytype) !void {
    const script = switch (action) {
        .evaluate => blk: {
            const params = (try cmd.params(struct {
                expression: []const u8,
                // contextId: ?u8 = null,
                // returnByValue: ?bool = null,
                // awaitPromise: ?bool = null,
                // userGesture: ?bool = null,
            })) orelse return error.InvalidParams;

            break :blk params.expression;
        },
        .callFunctionOn => blk: {
            const params = (try cmd.params(struct {
                functionDeclaration: []const u8,
                // objectId: ?[]const u8 = null,
                // executionContextId: ?u8 = null,
                // arguments: ?[]struct {
                //     value: ?[]const u8 = null,
                //     objectId: ?[]const u8 = null,
                // } = null,
                // returnByValue: ?bool = null,
                // awaitPromise: ?bool = null,
                // userGesture: ?bool = null,
            })) orelse return error.InvalidParams;

            break :blk params.functionDeclaration;
        },
        else => return,
    };
    const id = cmd.input.id orelse return error.RequiredId;
    const name = try std.fmt.allocPrint(cmd.arena, "id_{d}.js", .{id});

    var dir = try std.fs.cwd().makeOpenPath(".zig-cache/tmp", .{});
    defer dir.close();

    const f = try dir.createFile(name, .{});
    defer f.close();
    try f.writeAll(script);
}

test "cdp.runtime: iframe evaluate receives selected context id" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var parsed = try std.json.parseFromSliceLeaky(
        std.json.Value,
        arena.allocator(),
        "{\"id\":7,\"method\":\"Runtime.evaluate\",\"params\":{\"expression\":\"location.href\"}}",
        .{},
    );

    const params_value = parsed.object.getPtr("params").?;
    const params = &params_value.object;
    try std.testing.expect(!params.contains("contextId"));
    try params.put("contextId", .{ .integer = 42 });
    try std.testing.expectEqual(@as(i64, 42), params.get("contextId").?.integer);
}
