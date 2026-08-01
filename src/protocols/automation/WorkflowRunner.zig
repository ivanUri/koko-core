const std = @import("std");
const ToolRegistry = @import("ToolRegistry.zig");

pub const Error = error{
    InvalidWorkflow,
    UnsupportedVersion,
    UnknownTool,
    NonReplayableTool,
    OutOfMemory,
};

pub const ParsedStep = struct {
    action: ToolRegistry.Action,
    arguments: std.json.Value,
};

/// Replays a versioned workflow through a caller-provided executor. The
/// executor must expose `execute(Action, std.json.Value) !void`.
pub fn replay(
    allocator: std.mem.Allocator,
    raw: []const u8,
    executor: anytype,
) !void {
    const Workflow = struct {
        version: u32,
        steps: []const struct {
            tool: []const u8,
            arguments: std.json.Value,
        },
    };
    const parsed = std.json.parseFromSliceLeaky(Workflow, allocator, raw, .{
        .ignore_unknown_fields = false,
    }) catch return error.InvalidWorkflow;
    if (parsed.version != 1) return error.UnsupportedVersion;

    for (parsed.steps) |step| {
        const action = actionForPublicName(step.tool) orelse return error.UnknownTool;
        if (!action.policy().replayable) return error.NonReplayableTool;
        try executor.execute(action, step.arguments);
    }
}

fn actionForPublicName(name: []const u8) ?ToolRegistry.Action {
    if (std.mem.eql(u8, name, "goto") or std.mem.eql(u8, name, "navigate")) return .goto;
    if (std.mem.eql(u8, name, "extract")) return .extract;
    if (std.mem.eql(u8, name, "waitForSelector")) return .wait_for_selector;
    return null;
}

const testing = @import("../../testing/testing.zig");

test "WorkflowRunner rejects versions and non-replayable tools" {
    const Mock = struct {
        fn execute(_: *@This(), _: ToolRegistry.Action, _: std.json.Value) !void {}
    };
    var mock: Mock = .{};

    try testing.expectError(
        error.UnsupportedVersion,
        replay(testing.arena_allocator, "{\"version\":2,\"steps\":[]}", &mock),
    );
    try testing.expectError(
        error.UnknownTool,
        replay(testing.arena_allocator, "{\"version\":1,\"steps\":[{\"tool\":\"click\",\"arguments\":{}}]}", &mock),
    );
}

test "WorkflowRunner preserves deterministic step order" {
    const Mock = struct {
        seen: std.ArrayList(ToolRegistry.Action) = .empty,

        fn execute(self: *@This(), action: ToolRegistry.Action, _: std.json.Value) !void {
            try self.seen.append(testing.allocator, action);
        }
    };
    var mock: Mock = .{};
    defer mock.seen.deinit(testing.allocator);

    try replay(
        testing.arena_allocator,
        "{\"version\":1,\"steps\":[{\"tool\":\"goto\",\"arguments\":{\"url\":\"https://example.test\"}},{\"tool\":\"extract\",\"arguments\":{\"schema\":{}}}]}",
        &mock,
    );
    try testing.expectEqualSlices(
        ToolRegistry.Action,
        &.{ .goto, .extract },
        mock.seen.items,
    );
}
