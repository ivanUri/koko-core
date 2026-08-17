//! Opt-in network fulfillment for controlled execution replay.
//!
//! This layer is intentionally configured from an explicit local JSON file.
//! Its strict mode blocks every unmatched request, preventing a replay from
//! accidentally creating an external side effect.

const std = @import("std");

const http = @import("../http.zig");
const Client = @import("../../../core/browser/HttpClient.zig").Client;
const Request = @import("../../../core/browser/HttpClient.zig").Request;
const Layer = @import("../../../core/browser/HttpClient.zig").Layer;
const InterceptionLayer = @import("InterceptionLayer.zig");

const Self = @This();

const Header = struct { name: []const u8, value: []const u8 };
const Rule = struct {
    method: ?[]const u8 = null,
    url: []const u8,
    status: u16 = 200,
    headers: []const Header = &.{},
    body: ?[]const u8 = null,
};
const Document = struct {
    mode: enum { strict, fallback } = .strict,
    rules: []const Rule = &.{},
};

arena: std.heap.ArenaAllocator,
strict: bool = false,
rules: []const Rule = &.{},
next: Layer = undefined,

pub fn init(allocator: std.mem.Allocator, policy_path: ?[]const u8) !Self {
    var self: Self = .{ .arena = std.heap.ArenaAllocator.init(allocator) };
    errdefer self.arena.deinit();
    const path = policy_path orelse return self;
    const raw = try std.fs.cwd().readFileAlloc(self.arena.allocator(), path, 16 * 1024 * 1024);
    const document = try std.json.parseFromSliceLeaky(Document, self.arena.allocator(), raw, .{
        .ignore_unknown_fields = false,
    });
    self.strict = document.mode == .strict;
    self.rules = document.rules;
    return self;
}

pub fn deinit(self: *Self) void {
    self.arena.deinit();
}

pub fn enabled(self: *const Self) bool {
    return self.rules.len > 0 or self.strict;
}

pub fn layer(self: *Self) Layer {
    return .{ .ptr = self, .vtable = &.{ .request = request } };
}

fn request(ptr: *anyopaque, client: *Client, req: Request) anyerror!void {
    const self: *Self = @ptrCast(@alignCast(ptr));
    for (self.rules) |rule| {
        if (!matches(rule, req)) continue;
        const headers = try materializeHeaders(req.params.arena, rule.headers);
        return InterceptionLayer.fulfillDirect(client, req, rule.status, headers, rule.body);
    }
    if (self.strict) {
        req.error_callback(req.ctx, error.ExecutionReplayMiss);
        client.deinitRequest(req);
        return;
    }
    return self.next.request(client, req);
}

fn matches(rule: Rule, req: Request) bool {
    if (!std.mem.eql(u8, rule.url, req.params.url)) return false;
    if (rule.method) |method| return std.ascii.eqlIgnoreCase(method, @tagName(req.params.method));
    return true;
}

fn materializeHeaders(allocator: std.mem.Allocator, source: []const Header) ![]http.Header {
    const headers = try allocator.alloc(http.Header, source.len);
    for (source, headers) |header, *out| out.* = .{ .name = header.name, .value = header.value };
    return headers;
}

test "replay rule matches only its canonical method and URL" {
    const testing = std.testing;
    const rule = Rule{ .method = "GET", .url = "https://example.test/products" };
    try testing.expect(std.ascii.eqlIgnoreCase(rule.method.?, "get"));
    try testing.expect(std.mem.eql(u8, rule.url, "https://example.test/products"));
}
