//! Best-effort process resource sampling for admission decisions.
//!
//! Sampling is intentionally separate from ResourceController: the controller
//! remains deterministic and testable, while this module owns OS-specific
//! process accounting. Linux exposes current RSS/VMS through /proc; other
//! platforms retain the portable RSS high-water signal and leave VMS unset.

const std = @import("std");
const builtin = @import("builtin");
const ResourceController = @import("ResourceController.zig");

const linux_page_size: u64 = std.heap.page_size_min;

pub fn sample(process_io: std.Io) ResourceController.ResourceSample {
    const rss_high_water_bytes = residentBytesFromRusage();
    return .{
        .rss_current_bytes = currentResidentBytes(process_io) orelse rss_high_water_bytes,
        .rss_high_water_bytes = rss_high_water_bytes,
        .vms_current_bytes = currentVirtualMemoryBytes(process_io),
    };
}

fn currentResidentBytes(process_io: std.Io) ?u64 {
    if (comptime builtin.os.tag != .linux) return null;
    return readStatmField(process_io, 1);
}

fn currentVirtualMemoryBytes(process_io: std.Io) u64 {
    if (comptime builtin.os.tag != .linux) return 0;
    return readStatmField(process_io, 0) orelse 0;
}

fn readStatmField(process_io: std.Io, index: usize) ?u64 {
    var file = std.Io.Dir.openFileAbsolute(process_io, "/proc/self/statm", .{}) catch return null;
    defer file.close(process_io);

    var buffer: [128]u8 = undefined;
    const length = file.readPositionalAll(process_io, &buffer, 0) catch return null;
    const pages = parseStatmField(buffer[0..length], index) orelse return null;
    return pages * linux_page_size;
}

fn parseStatmField(contents: []const u8, index: usize) ?u64 {
    var fields = std.mem.tokenizeAny(u8, contents, " \t\r\n");
    var current: usize = 0;
    while (fields.next()) |field| : (current += 1) {
        if (current != index) continue;
        return std.fmt.parseInt(u64, field, 10) catch return null;
    }
    return null;
}

fn residentBytesFromRusage() u64 {
    const usage = std.posix.getrusage(0);
    const raw: u64 = if (usage.maxrss <= 0) 0 else @intCast(usage.maxrss);
    return switch (builtin.os.tag) {
        .macos, .ios, .watchos, .tvos => raw,
        else => raw * 1024,
    };
}

test "statm fields are parsed as page counts" {
    try std.testing.expectEqual(@as(?u64, 123), parseStatmField("123 45 6 7 8 9 10", 0));
    try std.testing.expectEqual(@as(?u64, 45), parseStatmField("123 45 6 7 8 9 10", 1));
    try std.testing.expectEqual(@as(?u64, null), parseStatmField("123 45", 3));
}
