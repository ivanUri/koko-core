const std = @import("std");
const Session = @import("../core/browser/Session.zig");
const Config = @import("Config.zig");
const cookies = @import("cookies.zig");
const session_persist = @import("session_persist.zig");
const log = @import("../support/log.zig");

fn cookieFileUsable(path: []const u8) bool {
    const file = std.fs.cwd().openFile(path, .{}) catch return false;
    defer file.close();
    const size = file.getEndPos() catch return false;
    return size > 2;
}

/// Load cookies + localStorage from the active profile directory.
pub fn bootstrapCookies(session: *Session, config: *const Config) void {
    var jar_buf: [512]u8 = undefined;
    if (config.cookieJarFile(&jar_buf)) |jar_path| {
        if (cookieFileUsable(jar_path)) {
            cookies.loadFromFile(session, jar_path);
            var ls_buf: [512]u8 = undefined;
            if (config.localStorageDir(&ls_buf)) |ls_dir| {
                session_persist.loadStorageDir(session, ls_dir);
            }
            log.info(.app, "profile_session.bootstrap", .{ .source = "profile", .path = jar_path });
        }
    }

    if (config.cookieCliOverride()) |cli_path| {
        cookies.loadFromFile(session, cli_path);
    }
}

fn ensureParentDir(path: []const u8) void {
    const parent = std.fs.path.dirname(path) orelse return;
    if (parent.len == 0) return;
    std.fs.cwd().makePath(parent) catch {};
}

/// Persist cookies + localStorage into the active profile directory.
pub fn persistCookies(session: *Session, config: *const Config) void {
    var jar_buf: [512]u8 = undefined;
    const jar_path = config.cookieJarFile(&jar_buf) orelse return;
    if (session.cookie_jar.cookies.items.len == 0) return;
    ensureParentDir(jar_path);
    cookies.saveToFile(&session.cookie_jar, jar_path);

    var ls_buf: [512]u8 = undefined;
    if (config.localStorageDir(&ls_buf)) |ls_dir| {
        session_persist.saveStorageDir(session, ls_dir);
    }
}
