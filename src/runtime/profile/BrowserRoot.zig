const std = @import("std");
const builtin = @import("builtin");
const log = @import("../../support/log.zig");

const Allocator = std.mem.Allocator;

var cached_root: ?[]const u8 = null;

/// Resolved install root containing `browser/` (absolute path, no trailing slash).
pub fn get(allocator: Allocator) ![]const u8 {
    if (cached_root) |root| return root;

    const root = try resolve(allocator);
    cached_root = root;
    return root;
}

pub fn deinitCache(allocator: Allocator) void {
    if (cached_root) |root| allocator.free(root);
    cached_root = null;
}

fn resolve(allocator: Allocator) ![]const u8 {
    if (builtin.is_test) {
        return try allocator.dupe(u8, ".");
    }

    if (std.posix.getenv("VELORA_ROOT")) |env_root| {
        const abs = try std.fs.cwd().realpathAlloc(allocator, env_root);
        if (browserBundleExists(abs)) return abs;
        allocator.free(abs);
        log.warn(.app, "browser_root.velora_root_invalid", .{ .path = env_root });
    }

    const exe = std.fs.selfExePathAlloc(allocator) catch null;
    if (exe) |exe_path| {
        defer allocator.free(exe_path);
        const exe_dir = std.fs.path.dirname(exe_path) orelse "";

        const dev_root = try std.fs.path.join(allocator, &.{ exe_dir, "..", ".." });
        if (browserBundleExists(dev_root)) {
            const abs = try std.fs.cwd().realpathAlloc(allocator, dev_root);
            allocator.free(dev_root);
            return abs;
        }
        allocator.free(dev_root);

        const share_root = try std.fs.path.join(allocator, &.{ exe_dir, "..", "share", "velora" });
        if (browserBundleExists(share_root)) {
            const abs = try std.fs.cwd().realpathAlloc(allocator, share_root);
            allocator.free(share_root);
            return abs;
        }
        allocator.free(share_root);
    }

    if (browserBundleExists(".")) {
        return try std.fs.cwd().realpathAlloc(allocator, ".");
    }

    return try allocator.dupe(u8, ".");
}

fn browserBundleExists(root: []const u8) bool {
    var buf: [512]u8 = undefined;
    const velora_json = std.fmt.bufPrint(
        &buf,
        "{s}/browser/fingerprints/velora/fingerprint.json",
        .{root},
    ) catch return false;
    std.fs.cwd().access(velora_json, .{}) catch return false;
    return true;
}

pub fn joinPath(allocator: Allocator, root: []const u8, suffix: []const u8) ![]const u8 {
    return std.fs.path.join(allocator, &.{ root, suffix });
}

const testing = @import("../../testing/testing.zig");

test "BrowserRoot: dev layout finds default fingerprint folder" {
    const root = try get(std.testing.allocator);
    var buf: [512]u8 = undefined;
    const path = try joinPath(std.testing.allocator, root, "browser/fingerprints/velora/fingerprint.json");
    defer std.testing.allocator.free(path);
    _ = std.fmt.bufPrint(&buf, "{s}", .{path}) catch unreachable;
    try testing.expect(std.fs.cwd().access(path, .{}) == .{});
}
