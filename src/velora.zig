const std = @import("std");
pub const Runtime = @import("public/Runtime.zig").Runtime;
pub const Browser = @import("core/browser/Browser.zig");
pub const Session = @import("core/browser/Session.zig");
pub const Frame = @import("core/browser/Frame.zig");
pub const Config = @import("runtime/Config.zig");
pub const RealmLifecycleKernel = @import("runtime/RealmLifecycleKernel.zig");
pub const App = @import("runtime/App.zig");
pub const Network = @import("runtime/network/Network.zig");
pub const Notification = @import("runtime/Notification.zig");
pub const cookies = @import("runtime/cookies.zig");
pub const Server = @import("adapters/server/Server.zig");
pub const log = @import("support/log.zig");
pub const crash_handler = @import("support/crash_handler.zig");
pub const String = @import("support/string.zig").String;
pub const js = @import("core/js/js.zig");
pub const dump = @import("core/browser/dump.zig");
pub const markdown = @import("core/browser/markdown.zig");
pub const links = @import("core/browser/links.zig");
pub const actions = @import("core/browser/actions.zig");
pub const forms = @import("core/browser/forms.zig");
pub const interactive = @import("core/browser/interactive.zig");
pub const structured_data = @import("core/browser/structured_data.zig");
pub const SemanticTree = @import("core/semantic/SemanticTree.zig");
pub const CDP = @import("protocols/cdp/CDP.zig");
pub const MCP = @import("protocols/mcp.zig");
pub const mcp = @import("protocols/mcp.zig");
pub const URL = @import("core/browser/URL.zig");
pub const build_config = @import("build_config");

pub const FetchOpts = struct {
    wait_ms: u32 = 0,
    wait_until: Config.WaitUntil = .done,
    wait_script: ?[:0]const u8 = null,
    wait_selector: ?[:0]const u8 = null,
    click_selector: ?[:0]const u8 = null,
    click_offset_x: u16 = 28,
    click_offset_y: ?u16 = null,
    dump_mode: ?Config.DumpFormat = null,
    dump: dump.Opts = .{},
    writer: ?*std.Io.Writer = null,
};

pub fn fetch(_: *App, browser: *Browser, url: [:0]const u8, opts: FetchOpts) !void {
    const session = if (browser.session) |*session| session else return error.SessionNotAvailable;
    log.debug(.app, "fetch create page", .{ .url = url });
    const frame = try session.createPage();
    log.debug(.app, "fetch navigate start", .{ .url = url });
    try frame.navigate(url, .{});
    log.debug(.app, "fetch navigate submitted", .{ .url = url, .frame_url = frame.url });

    var runner = try session.runner(.{});
    log.debug(.app, "fetch wait start", .{ .url = url, .wait_ms = opts.wait_ms, .wait_until = opts.wait_until });
    try runner.wait(.{ .ms = opts.wait_ms, .until = opts.wait_until });
    const active_frame = session.currentFrame() orelse return error.SessionNotAvailable;
    log.debug(.app, "fetch wait done", .{ .url = url, .frame_url = active_frame.url });
    if (opts.wait_selector) |selector| {
        log.debug(.app, "fetch wait selector start", .{ .url = url, .selector = selector, .wait_ms = opts.wait_ms });
        _ = try runner.waitForSelector(selector, opts.wait_ms);
        log.debug(.app, "fetch wait selector done", .{ .url = url, .selector = selector });
    }
    if (opts.click_selector) |selector| {
        log.debug(.app, "fetch click start", .{ .url = url, .selector = selector });
        const el = try runner.waitForSelector(selector, opts.wait_ms);
        try el.scrollIntoViewIfNeeded(true, active_frame);
        const rect = el.getBoundingClientRect(active_frame);
        const x = rect.getLeft() + @as(f64, @floatFromInt(opts.click_offset_x));
        const y = rect.getTop() + (@as(f64, @floatFromInt(opts.click_offset_y orelse 0)) + if (opts.click_offset_y == null) rect.getHeight() / 2 else 0);
        log.info(.app, "fetch core click", .{
            .selector = selector,
            .x = x,
            .y = y,
            .left = rect.getLeft(),
            .top = rect.getTop(),
            .width = rect.getWidth(),
            .height = rect.getHeight(),
        });
        try active_frame.triggerMouseClick(x, y);
        log.debug(.app, "fetch click done", .{ .url = url, .selector = selector });
        std.Thread.sleep(500 * std.time.ns_per_ms);
    }
    if (opts.wait_script) |script| {
        log.debug(.app, "fetch wait script start", .{ .url = url, .wait_ms = opts.wait_ms });
        try runner.waitForScript(script, opts.wait_ms);
        log.debug(.app, "fetch wait script done", .{ .url = url });
    }

    const writer = opts.writer orelse return;
    const dump_frame = session.currentFrame() orelse return error.SessionNotAvailable;
    log.debug(.app, "fetch dump start", .{ .url = url, .frame_url = dump_frame.url, .dump_mode = opts.dump_mode });
    switch (opts.dump_mode orelse return) {
        .html, .wpt => try dump.root(dump_frame.document, opts.dump, writer, dump_frame),
        .markdown => try markdown.dump(dump_frame.document.asNode(), .{}, writer, dump_frame),
        .semantic_tree, .semantic_tree_text => {},
    }
    log.debug(.app, "fetch dump done", .{ .url = url, .frame_url = dump_frame.url });
}

pub fn RC(comptime T: type) type {
    return struct {
        const Self = @This();

        count: T = 1,

        pub fn init(count: T) Self {
            return .{ .count = count };
        }

        pub fn acquire(self: *Self) void {
            self.count += 1;
        }

        pub fn release(self: *Self, owner: anytype, page: anytype) void {
            self.count -= 1;
            if (self.count == 0) {
                owner.deinit(page);
            }
        }
    };
}

pub fn assert(ok: bool, comptime msg: []const u8, args: anytype) void {
    if (ok) return;
    log.err(.app, msg, args);
    std.debug.assert(ok);
}
