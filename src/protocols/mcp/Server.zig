const std = @import("std");

const App = @import("../../runtime/App.zig");
const testing = @import("../../testing/testing.zig");
const protocol = @import("protocol.zig");
const router = @import("router.zig");
const CDPNode = @import("../cdp/Node.zig");

const Self = @This();

allocator: std.mem.Allocator,
app: *App,

notification: *@import("../../runtime/Notification.zig"),
browser: @import("../../core/browser/Browser.zig"),
session: *@import("../../core/browser/Session.zig"),
node_registry: CDPNode.Registry,

writer: *std.io.Writer,
mutex: std.Thread.Mutex = .{},
aw: std.io.Writer.Allocating,

pub fn init(allocator: std.mem.Allocator, app: *App, writer: *std.io.Writer) !*Self {
    const notification = try @import("../../runtime/Notification.zig").init(allocator);
    errdefer notification.deinit();

    const self = try allocator.create(Self);
    errdefer allocator.destroy(self);

    self.* = .{
        .allocator = allocator,
        .app = app,
        .writer = writer,
        .browser = undefined,
        .aw = .init(allocator),
        .notification = notification,
        .session = undefined,
        .node_registry = CDPNode.Registry.init(allocator),
    };

    try self.browser.init(app, .{}, null);
    errdefer self.browser.deinit();

    self.session = try self.browser.newSession(self.notification);

    @import("../../runtime/profile_session.zig").bootstrapCookies(self.session, app.config);

    return self;
}

pub fn deinit(self: *Self) void {
    @import("../../runtime/profile_session.zig").persistCookies(self.session, self.app.config);

    self.node_registry.deinit();
    self.aw.deinit();
    self.browser.deinit();
    self.notification.deinit();

    self.allocator.destroy(self);
}

pub fn sendResponse(self: *Self, response: anytype) !void {
    self.mutex.lock();
    defer self.mutex.unlock();

    self.aw.clearRetainingCapacity();
    try std.json.Stringify.value(response, .{ .emit_null_optional_fields = false }, &self.aw.writer);
    try self.aw.writer.writeByte('\n');
    try self.writer.writeAll(self.aw.writer.buffered());
    try self.writer.flush();
}

pub fn sendResult(self: *Self, id: std.json.Value, result: anytype) !void {
    const GenericResponse = struct {
        jsonrpc: []const u8 = "2.0",
        id: std.json.Value,
        result: @TypeOf(result),
    };
    try self.sendResponse(GenericResponse{
        .id = id,
        .result = result,
    });
}

pub fn sendError(self: *Self, id: std.json.Value, code: protocol.ErrorCode, message: []const u8) !void {
    try self.sendResponse(protocol.Response{
        .id = id,
        .@"error" = protocol.Error{
            .code = @intFromEnum(code),
            .message = message,
        },
    });
}

test "MCP.Server - Integration: synchronous smoke test" {
    defer testing.reset();
    const allocator = testing.allocator;
    const app = testing.test_app;

    const input =
        \\{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test-client","version":"1.0.0"}}}
    ;

    var in_reader: std.io.Reader = .fixed(input);
    var out_alloc: std.io.Writer.Allocating = .init(testing.arena_allocator);
    defer out_alloc.deinit();

    var server = try Self.init(allocator, app, &out_alloc.writer);
    defer server.deinit();

    try router.processRequests(server, &in_reader);

    try testing.expectJson(.{ .jsonrpc = "2.0", .id = 1, .result = .{ .protocolVersion = "2024-11-05" } }, out_alloc.writer.buffered());
}

test "MCP.Server - Integration: ping request returns an empty result" {
    defer testing.reset();
    const allocator = testing.allocator;
    const app = testing.test_app;

    const input =
        \\{"jsonrpc":"2.0","id":"ping-1","method":"ping"}
    ;

    var in_reader: std.io.Reader = .fixed(input);
    var out_alloc: std.io.Writer.Allocating = .init(testing.arena_allocator);
    defer out_alloc.deinit();

    var server = try Self.init(allocator, app, &out_alloc.writer);
    defer server.deinit();

    try router.processRequests(server, &in_reader);

    try testing.expectJson(.{ .jsonrpc = "2.0", .id = "ping-1", .result = .{} }, out_alloc.writer.buffered());
}
