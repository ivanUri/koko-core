const std = @import("std");
const URL = @import("../browser/URL.zig");
const http = @import("../../runtime/network/http.zig");

/// Origins that received `Accept-CH` for UA client hints.
pub const OriginSet = std.StringHashMapUnmanaged(void);

pub fn processAcceptHeaders(
    origins: *OriginSet,
    arena: std.mem.Allocator,
    response_url: [:0]const u8,
    iter: *http.HeaderIterator,
) !void {
    const origin = try URL.getOrigin(arena, response_url) orelse return;
    if (origins.contains(origin)) return;

    while (iter.next()) |hdr| {
        if (!std.ascii.eqlIgnoreCase(hdr.name, "accept-ch")) continue;
        const value = hdr.value;
        if (std.ascii.indexOfIgnoreCase(value, "sec-ch-ua") != null or
            std.ascii.indexOfIgnoreCase(value, "sec-ch-prefers") != null)
        {
            const key = try arena.dupe(u8, origin);
            try origins.put(arena, key, {});
            return;
        }
    }
}

pub fn enabledForUrl(origins: *const OriginSet, allocator: std.mem.Allocator, url: [:0]const u8) bool {
    const origin = URL.getOrigin(allocator, url) catch return false;
    const o = origin orelse return false;
    return origins.contains(o);
}
