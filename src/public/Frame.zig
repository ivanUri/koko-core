const std = @import("std");

pub const Frame = struct {
    allocator: std.mem.Allocator,
    internal_frame: *@import("../core/browser/Frame.zig"),

    pub fn init(allocator: std.mem.Allocator, internal_frame: *@import("../core/browser/Frame.zig")) !*Frame {
        const self = try allocator.create(Frame);
        self.* = Frame{
            .allocator = allocator,
            .internal_frame = internal_frame,
        };
        return self;
    }

    pub fn goto(self: *Frame, url: []const u8) !void {
        // Implement goto via internal_frame
        _ = url;
        _ = self;
    }

    pub fn content(self: *Frame) ![]const u8 {
        // Return frame content
        _ = self;
        return "";
    }

    pub fn evalString(self: *Frame, code: []const u8) !void {
        // Evaluate JS
        _ = code;
        _ = self;
    }

    pub fn deinit(self: *Frame) void {
        self.allocator.destroy(self);
    }
};
