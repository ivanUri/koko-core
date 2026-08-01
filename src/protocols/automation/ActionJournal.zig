const std = @import("std");
const ToolRegistry = @import("ToolRegistry.zig");

const Self = @This();

pub const workflow_version: u32 = 1;

pub const Step = struct {
    action: ToolRegistry.Action,
    public_name: []u8,
    arguments_json: []u8,
};

allocator: std.mem.Allocator,
steps: std.ArrayList(Step) = .empty,
recording: bool = false,

pub fn init(allocator: std.mem.Allocator) Self {
    return .{ .allocator = allocator };
}

pub fn deinit(self: *Self) void {
    self.clear();
    self.steps.deinit(self.allocator);
}

pub fn start(self: *Self) void {
    self.clear();
    self.recording = true;
}

pub fn stop(self: *Self) void {
    self.recording = false;
}

pub fn isRecording(self: *const Self) bool {
    return self.recording;
}

pub fn clear(self: *Self) void {
    for (self.steps.items) |step| {
        self.allocator.free(step.public_name);
        self.allocator.free(step.arguments_json);
    }
    self.steps.clearRetainingCapacity();
}

/// Record only a successfully completed, registry-approved operation.
pub fn append(
    self: *Self,
    action: ToolRegistry.Action,
    public_name: []const u8,
    arguments: ?std.json.Value,
    successful: bool,
) !bool {
    if (!self.recording or !successful or !action.policy().recordable) return false;

    const name = try self.allocator.dupe(u8, public_name);
    errdefer self.allocator.free(name);
    const arguments_json = if (arguments) |value|
        try std.json.Stringify.valueAlloc(self.allocator, value, .{})
    else
        try self.allocator.dupe(u8, "{}");
    errdefer self.allocator.free(arguments_json);

    try self.steps.append(self.allocator, .{
        .action = action,
        .public_name = name,
        .arguments_json = arguments_json,
    });
    return true;
}

pub fn writeJson(self: *const Self, writer: *std.Io.Writer) !void {
    try writer.print("{{\"version\":{d},\"steps\":[", .{workflow_version});
    for (self.steps.items, 0..) |step, index| {
        if (index != 0) try writer.writeByte(',');
        try writer.writeAll("{\"tool\":");
        try std.json.Stringify.value(step.public_name, .{}, writer);
        try writer.writeAll(",\"arguments\":");
        try writer.writeAll(step.arguments_json);
        try writer.writeByte('}');
    }
    try writer.writeAll("]}");
}

pub fn jsonAlloc(self: *const Self, allocator: std.mem.Allocator) ![]u8 {
    var output: std.Io.Writer.Allocating = .init(allocator);
    errdefer output.deinit();
    try self.writeJson(&output.writer);
    return output.toOwnedSlice();
}

pub fn writeJavaScript(self: *const Self, writer: *std.Io.Writer) !void {
    try writer.writeAll("const page = new Page();\n");
    var last_result: ?usize = null;
    for (self.steps.items, 0..) |step, index| {
        switch (step.action) {
            .goto => {
                var arena = std.heap.ArenaAllocator.init(self.allocator);
                defer arena.deinit();
                const value = try std.json.parseFromSliceLeaky(std.json.Value, arena.allocator(), step.arguments_json, .{});
                const url = if (value == .object) value.object.get("url") else null;
                if (url == null or url.? != .string) return error.InvalidWorkflow;
                try writer.writeAll("await page.goto(");
                try std.json.Stringify.value(url.?.string, .{}, writer);
                try writer.writeAll(");\n");
            },
            .extract => {
                var arena = std.heap.ArenaAllocator.init(self.allocator);
                defer arena.deinit();
                const value = try std.json.parseFromSliceLeaky(std.json.Value, arena.allocator(), step.arguments_json, .{});
                const schema = if (value == .object) value.object.get("schema") else null;
                if (schema == null or schema.? != .object) return error.InvalidWorkflow;
                try writer.print("const result{d} = page.extract(", .{index});
                try std.json.Stringify.value(schema.?, .{}, writer);
                try writer.writeAll(");\n");
                last_result = index;
            },
            .wait_for_selector => {
                var arena = std.heap.ArenaAllocator.init(self.allocator);
                defer arena.deinit();
                const value = try std.json.parseFromSliceLeaky(std.json.Value, arena.allocator(), step.arguments_json, .{});
                const selector = if (value == .object) value.object.get("selector") else null;
                if (selector == null or selector.? != .string) return error.InvalidWorkflow;
                try writer.writeAll("await page.waitForSelector(");
                try std.json.Stringify.value(selector.?.string, .{}, writer);
                if (value.object.get("timeout")) |timeout| {
                    try writer.writeAll(", { timeout: ");
                    try std.json.Stringify.value(timeout, .{}, writer);
                    try writer.writeAll(" }");
                }
                try writer.writeAll(");\n");
            },
            else => return error.NonReplayableTool,
        }
    }
    if (last_result) |index| {
        try writer.print("return result{d};\n", .{index});
    } else {
        try writer.writeAll("return null;\n");
    }
}

pub fn javascriptAlloc(self: *const Self, allocator: std.mem.Allocator) ![]u8 {
    var output: std.Io.Writer.Allocating = .init(allocator);
    errdefer output.deinit();
    try self.writeJavaScript(&output.writer);
    return output.toOwnedSlice();
}

const testing = @import("../../testing/testing.zig");

test "ActionJournal records successful replayable operations only" {
    defer testing.reset();
    var journal = Self.init(testing.allocator);
    defer journal.deinit();
    journal.start();

    const goto_args = try std.json.parseFromSliceLeaky(std.json.Value, testing.arena_allocator,
        \\{"url":"https://example.test"}
    , .{});
    try testing.expect(try journal.append(.goto, "goto", goto_args, true));
    try testing.expect(!try journal.append(.click, "click", null, true));
    try testing.expect(!try journal.append(.extract, "extract", null, false));
    try testing.expectEqual(@as(usize, 1), journal.steps.items.len);
}

test "ActionJournal exports versioned JSON and deterministic JavaScript" {
    defer testing.reset();
    var journal = Self.init(testing.allocator);
    defer journal.deinit();
    journal.start();

    const goto_args = try std.json.parseFromSliceLeaky(std.json.Value, testing.arena_allocator,
        \\{"url":"https://example.test"}
    , .{});
    const extract_args = try std.json.parseFromSliceLeaky(std.json.Value, testing.arena_allocator,
        \\{"schema":{"title":{"selector":"h1","text":true}}}
    , .{});
    const wait_args = try std.json.parseFromSliceLeaky(std.json.Value, testing.arena_allocator,
        \\{"selector":"h1","timeout":250}
    , .{});
    _ = try journal.append(.goto, "goto", goto_args, true);
    _ = try journal.append(.extract, "extract", extract_args, true);
    _ = try journal.append(.wait_for_selector, "waitForSelector", wait_args, true);

    const json = try journal.jsonAlloc(testing.allocator);
    defer testing.allocator.free(json);
    try testing.expectJson(.{ .version = 1 }, json);
    try testing.expect(std.mem.indexOf(u8, json, "\"tool\":\"extract\"") != null);

    const script = try journal.javascriptAlloc(testing.allocator);
    defer testing.allocator.free(script);
    try testing.expect(std.mem.indexOf(u8, script, "await page.goto(\"https://example.test\")") != null);
    try testing.expect(std.mem.indexOf(u8, script, "page.extract({\"title\"") != null);
    try testing.expect(std.mem.indexOf(u8, script, "page.waitForSelector(\"h1\", { timeout: 250 })") != null);
    try testing.expect(std.mem.indexOf(u8, script, "return result1") != null);
}
