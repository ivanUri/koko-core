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

const Allocator = std.mem.Allocator;

const js = @import("../js/js.zig");
const App = @import("../../runtime/App.zig");
const HttpClient = @import("HttpClient.zig");

const ArenaPool = App.ArenaPool;

const Session = @import("Session.zig");
const Page = @import("Page.zig");
const Notification = @import("../../runtime/Notification.zig");
const BatteryManager = @import("../webapi/BatteryManager.zig");

// Browser is an instance of the browser.
// You can create multiple browser instances.
// A browser contains only one session.
const Browser = @This();

env: js.Env,
app: *App,
session: ?Session,
allocator: Allocator,
arena_pool: *ArenaPool,
http_client: HttpClient,
battery_config: BatteryManager.Config,

// used by sessions to allocate pages.
page_pool: std.heap.MemoryPool(Page),

// Serializes CDP-driven browser ticks. Multiple CDP WebSocket threads must not
// run HttpClient.perform / V8 macrotasks concurrently on the same session.
tick_mutex: std.Thread.Mutex = .{},

const InitOpts = struct {
    env: js.Env.InitOpts = .{},
    battery_config: BatteryManager.Config = .{},
};

pub fn init(self: *Browser, app: *App, opts: InitOpts, cdp_client: ?HttpClient.CDPClient) !void {
    const allocator = app.allocator;

    var env = try js.Env.init(app, opts.env);
    errdefer env.deinit();

    self.* = .{
        .app = app,
        .env = env,
        .session = null,
        .allocator = allocator,
        .arena_pool = &app.arena_pool,
        .http_client = undefined,
        .battery_config = opts.battery_config,
        .page_pool = std.heap.MemoryPool(Page).init(allocator),
    };
    try self.http_client.init(allocator, &app.network, cdp_client);
    self.http_client.env = &self.env;
}

pub fn deinit(self: *Browser) void {
    self.closeSession();
    self.env.deinit();
    self.page_pool.deinit();
    self.http_client.deinit();
}

pub fn newSession(self: *Browser, notification: *Notification) !*Session {
    self.closeSession();
    self.session = @as(Session, undefined);
    const session = &self.session.?;
    try Session.init(session, self, notification);
    return session;
}

pub fn closeSession(self: *Browser) void {
    if (self.session) |*session| {
        session.deinit();
        self.session = null;
    }
}

pub fn runMicrotasks(self: *Browser) void {
    self.env.runMicrotasks(.unknown);
}

pub fn runMacrotasks(self: *Browser) !void {
    const env = &self.env;

    // HTML event loop: drain microtasks before the next macrotask turn. FP loader
    // yb() resumes on a microtask after its iframe Promise resolves; if a 2s race
    // timer runs first, load() rejects with crs:1/asib:0 despite a resolved iframe.
    env.runMicrotasks(.macrotask_loop);

    try self.env.runMacrotasks();
    env.pumpMessageLoop();

    // Timers / macrotask callbacks may queue more microtasks (promises, await).
    env.runMicrotasks(.macrotask_loop);
}

pub fn hasBackgroundTasks(self: *Browser) bool {
    return self.env.hasBackgroundTasks();
}

pub fn waitForBackgroundTasks(self: *Browser) void {
    self.env.waitForBackgroundTasks();
}

pub fn msToNextMacrotask(self: *Browser) ?u64 {
    return self.env.msToNextMacrotask();
}

pub fn msTo(self: *Browser) bool {
    return self.env.hasBackgroundTasks();
}

pub fn runIdleTasks(self: *const Browser) void {
    self.env.runIdleTasks();
}
