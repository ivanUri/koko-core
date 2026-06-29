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

/// Load cookies for a new session: runtime jar → profile seed → CLI --cookie override.
pub fn bootstrapCookies(session: *Session, config: *const Config) void {
    if (config.cookieJarFile()) |jar_path| {
        if (cookieFileUsable(jar_path)) {
            cookies.loadFromFile(session, jar_path);
            var storage_buf: [512]u8 = undefined;
            if (std.fmt.bufPrint(&storage_buf, "{s}.storage.json", .{jar_path})) |storage_path| {
                session_persist.loadStorage(session, storage_path);
            } else |_| {}
        }
    }

    if (session.cookie_jar.cookies.items.len == 0) {
        if (config.profileCookieSeedFile()) |seed_path| {
            cookies.loadFromFile(session, seed_path);
            log.info(.app, "profile_session.bootstrap", .{ .source = "seed", .path = seed_path });
        }
    } else if (config.profileCookieSeedFile()) |seed_path| {
        log.debug(.app, "profile_session.bootstrap", .{
            .note = "runtime jar loaded",
            .seed_unused = seed_path,
        });
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

/// Persist runtime jar + sidecar storage when profile or CLI configures a jar path.
pub fn persistCookies(session: *Session, config: *const Config) void {
    const jar_path = config.cookieJarFile() orelse return;
    if (session.cookie_jar.cookies.items.len == 0) return;
    ensureParentDir(jar_path);
    cookies.saveToFile(&session.cookie_jar, jar_path);
    var storage_buf: [512]u8 = undefined;
    const storage_path = std.fmt.bufPrint(&storage_buf, "{s}.storage.json", .{jar_path}) catch return;
    session_persist.saveStorage(session, storage_path);
}
