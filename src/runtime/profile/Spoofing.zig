const std = @import("std");

/// Cross-layer fingerprint consistency: UA version ↔ UA-CH brands ↔ TLS target.
pub const ChromeVersion = struct {
    major: u32,
    full: []const u8,
};

pub fn extractChromeVersion(user_agent: []const u8) ?ChromeVersion {
    const needle = "Chrome/";
    const idx = std.mem.indexOf(u8, user_agent, needle) orelse return null;
    const start = idx + needle.len;
    const rest = user_agent[start..];
    const end = std.mem.indexOfAny(u8, rest, " .") orelse return null;
    const major_str = rest[0..end];
    const major = std.fmt.parseInt(u32, major_str, 10) catch return null;
    return .{ .major = major, .full = rest[0..@min(end + 10, rest.len)] };
}

pub const Brand = struct {
    brand: []const u8,
    version: []const u8,
};

pub fn chromeVersionFromBrands(brands: []const Brand) ?u32 {
    for (brands) |b| {
        if (std.mem.eql(u8, b.brand, "Google Chrome") or std.mem.eql(u8, b.brand, "Chromium")) {
            return std.fmt.parseInt(u32, b.version, 10) catch null;
        }
    }
    return null;
}

pub fn validateAntidetectConsistency(
    user_agent: []const u8,
    brands: []const Brand,
    ua_full_version: []const u8,
) !void {
    const ua_chrome = extractChromeVersion(user_agent) orelse return error.InvalidProfile;
    const brand_chrome = chromeVersionFromBrands(brands) orelse return error.InvalidProfile;

    if (ua_chrome.major != brand_chrome) return error.InvalidProfile;

    if (ua_full_version.len > 0) {
        var buf: [16]u8 = undefined;
        const prefix = try std.fmt.bufPrint(&buf, "{d}.", .{ua_chrome.major});
        if (!std.mem.startsWith(u8, ua_full_version, prefix)) return error.InvalidProfile;
    }
}

pub fn uaPlatformMatchesNavigator(user_agent: []const u8, navigator_platform: []const u8) bool {
    if (std.mem.eql(u8, navigator_platform, "MacIntel")) {
        return std.mem.indexOf(u8, user_agent, "Macintosh") != null;
    }
    if (std.mem.eql(u8, navigator_platform, "Win32")) {
        return std.mem.indexOf(u8, user_agent, "Windows") != null;
    }
    if (std.mem.eql(u8, navigator_platform, "Linux x86_64")) {
        return std.mem.indexOf(u8, user_agent, "Linux") != null;
    }
    return true;
}

const testing = @import("../../testing/testing.zig");

test "Spoofing: extract Chrome version" {
    const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
    const v = extractChromeVersion(ua).?;
    try testing.expectEqual(@as(u32, 131), v.major);
}

test "Spoofing: validate brand/UA consistency" {
    const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
    const brands = [_]Brand{
        .{ .brand = "Not_A Brand", .version = "24" },
        .{ .brand = "Chromium", .version = "131" },
        .{ .brand = "Google Chrome", .version = "131" },
    };
    try validateAntidetectConsistency(ua, &brands, "131.0.6778.86");
}
