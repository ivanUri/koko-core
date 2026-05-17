const std = @import("std");
const App = @import("../runtime/App.zig");

pub const Browser = struct {
    allocator: std.mem.Allocator,
    app: *App,
    internal_browser: *@import("../core/browser/Browser.zig"),

    pub fn init(allocator: std.mem.Allocator, app: *App) !*Browser {
        const self = try allocator.create(Browser);
        // Assuming app provides access to a browser, or we create one
        // For now, let's keep it simple
        self.* = Browser{
            .allocator = allocator,
            .app = app,
            .internal_browser = app.browser orelse return error.BrowserNotAvailable,
        };
        return self;
    }

    pub fn newSession(self: *Browser) !*@import("Session.zig").Session {
        return try @import("Session.zig").Session.init(self.allocator, self.internal_browser.newSession());
    }

    pub fn deinit(self: *Browser) void {
        self.allocator.destroy(self);
    }
};
