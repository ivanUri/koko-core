const std = @import("std");

pub const Session = struct {
    allocator: std.mem.Allocator,
    internal_session: *@import("../core/browser/Session.zig"),

    pub fn init(allocator: std.mem.Allocator, internal_session: *@import("../core/browser/Session.zig")) !*Session {
        const self = try allocator.create(Session);
        self.* = Session{
            .allocator = allocator,
            .internal_session = internal_session,
        };
        return self;
    }

    pub fn newPage(self: *Session) !*@import("Frame.zig").Frame {
        return try @import("Frame.zig").Frame.init(self.allocator, try self.internal_session.newPage());
    }

    pub fn close(self: *Session) void {
        self.internal_session.close();
    }

    pub fn deinit(self: *Session) void {
        self.allocator.destroy(self);
    }
};
