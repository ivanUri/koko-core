const std = @import("std");
const HttpClient = @import("../../core/browser/HttpClient.zig");
const XBrowser = @import("plugins/XBrowser.zig");

const Allocator = std.mem.Allocator;

pub const Registry = struct {
    x_browser: XBrowser.Plugin,

    pub fn init(allocator: Allocator) !Registry {
        return .{
            .x_browser = try XBrowser.Plugin.load(allocator),
        };
    }

    pub fn deinit(self: *Registry, allocator: Allocator) void {
        self.x_browser.deinit(allocator);
        self.* = undefined;
    }

    pub fn append(
        self: *const Registry,
        plugin_id: []const u8,
        headers: *HttpClient.Headers,
        allocator: Allocator,
        user_agent: []const u8,
    ) !void {
        if (std.mem.eql(u8, plugin_id, "x-browser")) {
            try self.x_browser.appendHeaders(headers, allocator, user_agent);
            return;
        }
    }
};
