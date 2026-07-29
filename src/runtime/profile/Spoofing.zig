const std = @import("std");

/// Cross-layer fingerprint consistency: UA version ↔ UA-CH brands ↔ platform/arch/touch.
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

/// High-entropy UA-CH exposes the same browser build through
/// `uaFullVersion` and the Chromium/Google Chrome entries of
/// `fullVersionList`. Profiles captured at different times must not be mixed.
pub fn fullVersionListMatches(
    ua_full_version: []const u8,
    full_version_list: []const Brand,
) bool {
    if (ua_full_version.len == 0 or full_version_list.len == 0) return true;
    var found_browser_brand = false;
    for (full_version_list) |brand| {
        if (std.mem.eql(u8, brand.brand, "Chromium") or
            std.mem.eql(u8, brand.brand, "Google Chrome"))
        {
            found_browser_brand = true;
            if (!std.mem.eql(u8, brand.version, ua_full_version)) return false;
        }
    }
    return found_browser_brand;
}

pub fn uaPlatformMatchesNavigator(user_agent: []const u8, navigator_platform: []const u8) bool {
    if (std.mem.eql(u8, navigator_platform, "MacIntel")) {
        return std.mem.indexOf(u8, user_agent, "Macintosh") != null;
    }
    if (std.mem.eql(u8, navigator_platform, "Win32")) {
        return std.mem.indexOf(u8, user_agent, "Windows") != null;
    }
    if (std.mem.eql(u8, navigator_platform, "Linux x86_64") or std.mem.eql(u8, navigator_platform, "Linux armv8l")) {
        return std.mem.indexOf(u8, user_agent, "Linux") != null;
    }
    return true;
}

/// UA-CH `architecture` vs navigator.platform pairs that real Chrome reports.
pub fn uaChArchitectureMatchesPlatform(navigator_platform: []const u8, architecture: []const u8) bool {
    if (architecture.len == 0) return true;
    if (std.mem.eql(u8, navigator_platform, "MacIntel")) {
        // Apple Silicon still reports MacIntel + architecture "arm"; Intel Mac uses "x86".
        return std.mem.eql(u8, architecture, "arm") or std.mem.eql(u8, architecture, "x86");
    }
    if (std.mem.eql(u8, navigator_platform, "Win32")) {
        return std.mem.eql(u8, architecture, "x86");
    }
    if (std.mem.startsWith(u8, navigator_platform, "Linux")) {
        return std.mem.eql(u8, architecture, "x86") or std.mem.eql(u8, architecture, "arm");
    }
    return true;
}

/// Mobile UA must expose touch points; pure desktop UA with maxTouchPoints 0 is OK.
/// Desktop UA with high touch counts is allowed (touch-screen laptops).
pub fn touchMatchesUserAgent(user_agent: []const u8, max_touch_points: u32) bool {
    const mobile = isMobileUserAgent(user_agent);
    if (mobile and max_touch_points == 0) return false;
    return true;
}

pub fn isMobileUserAgent(user_agent: []const u8) bool {
    if (std.mem.indexOf(u8, user_agent, "Mobile") != null) return true;
    if (std.mem.indexOf(u8, user_agent, "Android") != null) return true;
    if (std.mem.indexOf(u8, user_agent, "iPhone") != null) return true;
    if (std.mem.indexOf(u8, user_agent, "iPad") != null) return true;
    return false;
}

/// Chrome desktop PDF stack: pdfViewerEnabled true ⇔ at least one plugin present.
pub fn pdfViewerMatchesPlugins(pdf_viewer_enabled: bool, plugin_count: usize) bool {
    if (pdf_viewer_enabled and plugin_count == 0) return false;
    if (!pdf_viewer_enabled and plugin_count > 0) return false;
    return true;
}

/// UA-CH platform string vs navigator.platform (high-level OS family).
pub fn uaChPlatformMatchesNavigator(navigator_platform: []const u8, ua_ch_platform: []const u8) bool {
    if (ua_ch_platform.len == 0) return true;
    if (std.mem.eql(u8, navigator_platform, "MacIntel")) {
        return std.mem.eql(u8, ua_ch_platform, "macOS");
    }
    if (std.mem.eql(u8, navigator_platform, "Win32")) {
        return std.mem.eql(u8, ua_ch_platform, "Windows");
    }
    if (std.mem.startsWith(u8, navigator_platform, "Linux")) {
        return std.mem.eql(u8, ua_ch_platform, "Linux") or std.mem.eql(u8, ua_ch_platform, "Chrome OS");
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

test "Spoofing: full version list must use one browser build" {
    const matching = [_]Brand{
        .{ .brand = "Not;A=Brand", .version = "8.0.0.0" },
        .{ .brand = "Chromium", .version = "150.0.7871.187" },
        .{ .brand = "Google Chrome", .version = "150.0.7871.187" },
    };
    try testing.expect(fullVersionListMatches("150.0.7871.187", &matching));

    const mixed = [_]Brand{
        .{ .brand = "Chromium", .version = "150.0.7871.186" },
        .{ .brand = "Google Chrome", .version = "150.0.7871.187" },
    };
    try testing.expect(!fullVersionListMatches("150.0.7871.187", &mixed));
}

test "Spoofing: MacIntel accepts arm and x86 UA-CH arch" {
    try testing.expect(uaChArchitectureMatchesPlatform("MacIntel", "arm"));
    try testing.expect(uaChArchitectureMatchesPlatform("MacIntel", "x86"));
    try testing.expect(!uaChArchitectureMatchesPlatform("MacIntel", "arm64"));
    try testing.expect(uaChArchitectureMatchesPlatform("Win32", "x86"));
    try testing.expect(!uaChArchitectureMatchesPlatform("Win32", "arm"));
}

test "Spoofing: mobile UA requires touch points" {
    const mobile = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36";
    try testing.expect(!touchMatchesUserAgent(mobile, 0));
    try testing.expect(touchMatchesUserAgent(mobile, 5));
    const desktop = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36";
    try testing.expect(touchMatchesUserAgent(desktop, 0));
    try testing.expect(touchMatchesUserAgent(desktop, 1));
}

test "Spoofing: pdf viewer vs plugins" {
    try testing.expect(pdfViewerMatchesPlugins(true, 5));
    try testing.expect(pdfViewerMatchesPlugins(false, 0));
    try testing.expect(!pdfViewerMatchesPlugins(true, 0));
    try testing.expect(!pdfViewerMatchesPlugins(false, 3));
}
