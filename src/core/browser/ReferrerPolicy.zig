const std = @import("std");
const URL = @import("URL.zig");
const Allocator = std.mem.Allocator;

pub const Policy = enum {
    @"strict-origin-when-cross-origin",
    no_referrer,
    origin,
    @"origin-when-cross-origin",
    @"same-origin",

    pub fn parse(value: []const u8) Policy {
        if (std.ascii.eqlIgnoreCase(value, "no-referrer")) return .no_referrer;
        if (std.ascii.eqlIgnoreCase(value, "origin")) return .origin;
        if (std.ascii.eqlIgnoreCase(value, "same-origin")) return .@"same-origin";
        if (std.ascii.eqlIgnoreCase(value, "origin-when-cross-origin")) return .@"origin-when-cross-origin";
        return .@"strict-origin-when-cross-origin";
    }
};

pub fn sanitizeReferrerUrl(allocator: Allocator, referrer_url: []const u8) ![:0]const u8 {
    const ref_z = try allocator.dupeZ(u8, referrer_url);
    if (!std.mem.startsWith(u8, ref_z, "http")) {
        const hash_end = std.mem.indexOfScalar(u8, ref_z, '#') orelse ref_z.len;
        return try allocator.dupeZ(u8, ref_z[0..hash_end]);
    }

    const protocol = URL.getProtocol(ref_z);
    const host = URL.getHost(ref_z);
    const pathname = URL.getPathname(ref_z);
    const search = URL.getSearch(ref_z);
    const path = if (pathname.len == 0) "/" else pathname;
    return try std.fmt.allocPrintSentinel(allocator, "{s}//{s}{s}{s}", .{ protocol, host, path, search }, 0);
}

pub fn computeReferer(
    allocator: Allocator,
    policy: Policy,
    referrer_url: []const u8,
    request_url: []const u8,
) !?[:0]const u8 {
    const ref_z = try sanitizeReferrerUrl(allocator, referrer_url);
    const req_z = try allocator.dupeZ(u8, request_url);
    return switch (policy) {
        .no_referrer => null,
        .origin => blk: {
            const origin = URL.getOrigin(allocator, ref_z) catch return null;
            const o = origin orelse return null;
            break :blk try std.fmt.allocPrintSentinel(allocator, "{s}/", .{o}, 0);
        },
        .@"same-origin" => blk: {
            if (!originsMatch(allocator, ref_z, req_z)) return null;
            break :blk try allocator.dupeZ(u8, ref_z);
        },
        .@"origin-when-cross-origin" => blk: {
            if (!originsMatch(allocator, ref_z, req_z)) {
                const origin = URL.getOrigin(allocator, ref_z) catch return null;
                const o = origin orelse return null;
                break :blk try std.fmt.allocPrintSentinel(allocator, "{s}/", .{o}, 0);
            }
            break :blk try allocator.dupeZ(u8, ref_z);
        },
        .@"strict-origin-when-cross-origin" => try allocator.dupeZ(u8, ref_z),
    };
}

fn originsMatch(allocator: Allocator, a_url: [:0]const u8, b_url: [:0]const u8) bool {
    const a_origin = URL.getOrigin(allocator, a_url) catch return false;
    const b_origin = URL.getOrigin(allocator, b_url) catch return false;
    return std.mem.eql(u8, a_origin orelse return false, b_origin orelse return false);
}
