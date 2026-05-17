const std = @import("std");
const App = @import("../runtime/App.zig");

pub const Runtime = struct {
    allocator: std.mem.Allocator,
    config: Config,
    app: *App,

    pub const Config = struct {
        port: u16 = 0,
        address: []const u8 = "127.0.0.1",
        // Additional configs as needed
    };

    pub fn init(allocator: std.mem.Allocator, config: Config) !*Runtime {
        const self = try allocator.create(Runtime);

        self.* = Runtime{
            .allocator = allocator,
            .config = config,
            .app = try App.init(allocator),
        };

        return self;
    }

    pub fn start(self: *Runtime) !void {
        // map to internal app start
        try self.app.start();
    }

    pub fn run(self: *Runtime) !void {
        // map to internal app run
        try self.app.run();
    }

    pub fn stop(self: *Runtime) void {
        self.app.stop();
    }

    pub fn deinit(self: *Runtime) void {
        self.app.deinit();
        self.allocator.destroy(self);
    }

    pub fn createBrowser(self: *Runtime) !*@import("Browser.zig").Browser {
        // Wrapper for browser
        return try @import("Browser.zig").Browser.init(self.allocator, self.app);
    }
};
