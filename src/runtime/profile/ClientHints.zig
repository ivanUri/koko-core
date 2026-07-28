const std = @import("std");
const URL = @import("../../core/browser/URL.zig");
const http = @import("../network/http.zig");

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

/// High-entropy UA hints are Permissions-Policy controlled. Their default
/// allowlist is `self`, so an opted-in origin embedded through a cross-origin
/// ancestor does not receive them unless that ancestor explicitly delegates
/// the individual hint features.
///
/// Velora does not yet model per-feature Permissions-Policy delegation. This
/// helper therefore implements the standards-preserving default allowlist;
/// explicit delegation can be layered on without weakening the default.
pub fn defaultPolicyAllowsHighEntropy(frame_origin: ?[]const u8, ancestor_origin: ?[]const u8) bool {
    const frame = frame_origin orelse return false;
    const ancestor = ancestor_origin orelse return false;
    return std.mem.eql(u8, frame, ancestor);
}

test "high entropy client hints default to self in embedded contexts" {
    try std.testing.expect(defaultPolicyAllowsHighEntropy("https://example.test", "https://example.test"));
    try std.testing.expect(!defaultPolicyAllowsHighEntropy("https://widget.test", "https://example.test"));
    try std.testing.expect(!defaultPolicyAllowsHighEntropy(null, "https://example.test"));
}
