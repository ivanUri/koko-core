const std = @import("std");
const Session = @import("../core/browser/Session.zig");
const log = @import("../support/log.zig");

const KeyValue = struct { key: []const u8, value: []const u8 };

const JsonEntry = struct {
    origin: []const u8,
    local: []const KeyValue,
};

pub const storage_filename = "storage.json";

pub fn storageFilePath(dir: []const u8, buf: []u8) ?[]const u8 {
    return std.fmt.bufPrint(buf, "{s}/{s}", .{ dir, storage_filename }) catch null;
}

pub fn loadStorageDir(session: *Session, dir: []const u8) void {
    var path_buf: [512]u8 = undefined;
    const path = storageFilePath(dir, &path_buf) orelse return;
    loadStorage(session, path);
}

pub fn saveStorageDir(session: *Session, dir: []const u8) void {
    std.fs.cwd().makePath(dir) catch {};
    var path_buf: [512]u8 = undefined;
    const path = storageFilePath(dir, &path_buf) orelse return;
    saveStorage(session, path);
}

/// @deprecated Sidecar format; use loadStorageDir.
pub fn storagePathForCookieJar(cookie_jar_path: []const u8, allocator: std.mem.Allocator) ![]const u8 {
    return std.fmt.allocPrint(allocator, "{s}.storage.json", .{cookie_jar_path});
}

pub fn loadStorage(session: *Session, path: []const u8) void {
    _loadStorage(session, path) catch |err| {
        log.err(.app, "session_persist.loadStorage", .{ .path = path, .err = err });
    };
}

fn _loadStorage(session: *Session, path: []const u8) !void {
    const arena = try session.getArena(.medium, "session_persist.load");
    defer session.releaseArena(arena);

    const content = std.fs.cwd().readFileAlloc(arena, path, 4 * 1024 * 1024) catch |err| switch (err) {
        error.FileNotFound => return,
        else => return err,
    };

    const entries = try std.json.parseFromSliceLeaky([]const JsonEntry, arena, content, .{
        .ignore_unknown_fields = true,
    });

    // Storage belongs to the browsing session. Allocate it from the session
    // arena so keys, values, buckets and hash-map backing storage share one
    // lifetime and are reclaimed together on Session.deinit.
    const allocator = session.arena;
    for (entries) |entry| {
        const bucket = try session.storage_shed.getOrPut(allocator, entry.origin);
        for (entry.local) |kv| {
            const key_owned = try allocator.dupe(u8, kv.key);
            const val_owned = try allocator.dupe(u8, kv.value);
            const gop = try bucket.local._data.getOrPut(allocator, key_owned);
            if (!gop.found_existing) {
                gop.key_ptr.* = key_owned;
            } else {
                allocator.free(key_owned);
            }
            gop.value_ptr.* = val_owned;
            bucket.local._size += val_owned.len;
        }
    }
    log.info(.app, "session_persist.loadStorage", .{ .path = path, .origins = entries.len });
}

pub fn saveStorage(session: *Session, path: []const u8) void {
    _saveStorage(session, path) catch |err| {
        log.err(.app, "session_persist.saveStorage", .{ .path = path, .err = err });
    };
}

fn _saveStorage(session: *Session, path: []const u8) !void {
    // The JSON view is temporary; do not leave its owned slices on the app
    // allocator after every profile shutdown.
    const allocator = try session.getArena(.medium, "session_persist.save");
    defer session.releaseArena(allocator);
    var origins = try std.ArrayList(JsonEntry).initCapacity(allocator, 8);
    defer origins.deinit(allocator);

    var it = session.storage_shed._origins.iterator();
    while (it.next()) |kv| {
        var pairs = try std.ArrayList(KeyValue).initCapacity(allocator, 16);
        defer pairs.deinit(allocator);

        var lit = kv.value_ptr.*.local._data.iterator();
        while (lit.next()) |item| {
            try pairs.append(allocator, .{ .key = item.key_ptr.*, .value = item.value_ptr.* });
        }
        if (pairs.items.len == 0) continue;
        try origins.append(allocator, .{ .origin = kv.key_ptr.*, .local = try pairs.toOwnedSlice(allocator) });
    }

    if (origins.items.len == 0) return;

    if (std.fs.path.dirname(path)) |parent| {
        try std.fs.cwd().makePath(parent);
    }

    var file = try std.fs.cwd().createFile(path, .{});
    defer file.close();
    var buf: [8192]u8 = undefined;
    var writer = file.writer(&buf);
    try std.json.Stringify.value(origins.items, .{}, &writer.interface);
    try writer.interface.writeByte('\n');
    try writer.end();
    log.info(.app, "session_persist.saveStorage", .{ .path = path, .origins = origins.items.len });
}
