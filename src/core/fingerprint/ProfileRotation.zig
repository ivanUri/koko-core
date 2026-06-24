const std = @import("std");

/// Pick one profile name from a comma-separated pool (e.g. "chrome-macos-sonoma,chrome-windows-11").
pub fn pickFromPool(
    allocator: std.mem.Allocator,
    pool: []const u8,
    rng: std.Random,
) ![]const u8 {
    var names = try std.ArrayList([]const u8).initCapacity(allocator, 4);
    defer names.deinit(allocator);

    var it = std.mem.splitScalar(u8, pool, ',');
    while (it.next()) |part| {
        const trimmed = std.mem.trim(u8, part, " \t\r\n");
        if (trimmed.len > 0) try names.append(allocator, trimmed);
    }
    if (names.items.len == 0) return error.EmptyProfilePool;
    const idx = rng.intRangeAtMost(usize, 0, names.items.len - 1);
    return try allocator.dupe(u8, names.items[idx]);
}

const testing = @import("../../testing/testing.zig");

test "ProfileRotation: pick from pool" {
    var buf: [8]u8 = undefined;
    var prng = std.Random.DefaultPrng.init(1234);
    const name = try pickFromPool(std.testing.allocator, "chrome-macos-sonoma,chrome-windows-11", prng.random(&buf));
    defer std.testing.allocator.free(name);
    try testing.expect(std.mem.eql(u8, name, "chrome-macos-sonoma") or std.mem.eql(u8, name, "chrome-windows-11"));
}
