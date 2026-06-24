const std = @import("std");
const URL = @import("../browser/URL.zig");
const HttpClient = @import("../browser/HttpClient.zig");
const Profile = @import("Profile.zig");
const ProfileStore = @import("ProfileStore.zig");

/// Chrome-like HTTP header order for document and subresource requests.
/// Matches curl-impersonate chrome146 ordering when `curl_impersonate` is linked.
pub const document_accept =
    "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7";

pub const firefox_document_accept =
    "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";

pub const subresource_accept = "Accept: */*";
pub const accept_encoding = "Accept-Encoding: gzip, deflate, br";
pub const accept_encoding_zstd = "Accept-Encoding: gzip, deflate, br, zstd";
pub const document_priority = "Priority: u=0, i";

/// Chrome document navigation defaults (HAR-aligned).
pub const document_downlink: f64 = 10;
pub const document_rtt: u32 = 50;

pub const RequestContext = struct {
    request_url: [:0]const u8,
    resource_type: HttpClient.RequestParams.ResourceType,
    frame_origin: ?[]const u8 = null,
    prior_origin: ?[]const u8 = null,
    is_document_navigation: bool = false,
    origin: ?[]const u8 = null,
};

pub fn secFetchDest(resource_type: HttpClient.RequestParams.ResourceType) []const u8 {
    return switch (resource_type) {
        .document => "document",
        .script => "script",
        .image => "image",
        .fetch, .xhr, .beacon => "empty",
    };
}

pub fn secFetchMode(resource_type: HttpClient.RequestParams.ResourceType) []const u8 {
    return switch (resource_type) {
        .document => "navigate",
        .script, .beacon, .image => "no-cors",
        .fetch, .xhr => "cors",
    };
}

pub fn secFetchSite(ctx: RequestContext) []const u8 {
    if (ctx.is_document_navigation) {
        const origin = ctx.prior_origin orelse return "none";
        if (!std.mem.startsWith(u8, ctx.request_url, origin)) return "cross-site";
        if (std.mem.eql(u8, URL.getHost(ctx.request_url), URL.getHost(origin))) return "same-origin";
        return "cross-site";
    }

    const origin = ctx.frame_origin orelse return "none";
    if (!std.mem.startsWith(u8, ctx.request_url, origin)) return "cross-site";
    if (std.mem.eql(u8, URL.getHost(ctx.request_url), URL.getHost(origin))) return "same-origin";
    return "cross-site";
}

pub const StaticHeaders = struct {
    user_agent_header: [:0]const u8,
    sec_ch_ua_header: [:0]const u8,
    accept_language_header: [:0]const u8,
};

pub const ChromeHeadersOpts = struct {
    full_client_hints: bool = false,
    brands: []const ProfileStore.Brand = &.{},
    color_scheme: []const u8 = "light",
    /// Guest Chrome omnibox search omits Sec-Fetch-User (www.google.com.har).
    omit_sec_fetch_user: bool = false,
};

fn isBrowserBrand(brand: []const u8) bool {
    return std.mem.indexOf(u8, brand, "Chrome") != null or std.mem.indexOf(u8, brand, "Chromium") != null;
}

fn brandFullVersion(allocator: std.mem.Allocator, brand: ProfileStore.Brand, ua_full_version: []const u8) ![]const u8 {
    if (isBrowserBrand(brand.brand)) return ua_full_version;
    if (std.mem.indexOfScalar(u8, brand.version, '.') != null) return brand.version;
    return try std.fmt.allocPrint(allocator, "{s}.0.0.0", .{brand.version});
}

fn appendFullVersionListHeader(
    headers: *HttpClient.Headers,
    allocator: std.mem.Allocator,
    brands: []const ProfileStore.Brand,
    ua_full_version: []const u8,
) !void {
    var list = try std.ArrayList(u8).initCapacity(allocator, 128);
    errdefer list.deinit(allocator);
    try list.appendSlice(allocator, "Sec-Ch-Ua-Full-Version-List:");
    for (brands, 0..) |brand, i| {
        const sep = if (i == 0) " " else ", ";
        try list.appendSlice(allocator, sep);
        const full_ver = try brandFullVersion(allocator, brand, ua_full_version);
        try list.writer(allocator).print("\"{s}\";v=\"{s}\"", .{ brand.brand, full_ver });
    }
    try list.append(allocator, 0);
    const slice = try list.toOwnedSlice(allocator);
    try headers.add(slice[0 .. slice.len - 1 :0]);
}

fn appendHighEntropyClientHintsAfterSecChUa(
    headers: *HttpClient.Headers,
    allocator: std.mem.Allocator,
    identity: *const Profile.IdentityProfile,
    brands: []const ProfileStore.Brand,
) !void {
    const arch_hdr = try std.fmt.allocPrintSentinel(
        allocator,
        "Sec-Ch-Ua-Arch: \"{s}\"",
        .{identity.ua_architecture},
        0,
    );
    try headers.add(arch_hdr);

    const bitness_hdr = try std.fmt.allocPrintSentinel(
        allocator,
        "Sec-Ch-Ua-Bitness: \"{s}\"",
        .{identity.ua_bitness},
        0,
    );
    try headers.add(bitness_hdr);

    try headers.add("Sec-Ch-Ua-Form-Factors: \"Desktop\"");

    const full_ver_hdr = try std.fmt.allocPrintSentinel(
        allocator,
        "Sec-Ch-Ua-Full-Version: \"{s}\"",
        .{identity.ua_full_version},
        0,
    );
    try headers.add(full_ver_hdr);

    try appendFullVersionListHeader(headers, allocator, brands, identity.ua_full_version);
}

/// Chrome 149 document navigation order (from real Chrome HAR).
fn appendChromeDocumentNavigationHeaders(
    headers: *HttpClient.Headers,
    allocator: std.mem.Allocator,
    identity: *const Profile.IdentityProfile,
    static: *const StaticHeaders,
    ctx: RequestContext,
    opts: ChromeHeadersOpts,
) !void {
    try headers.add(document_accept);
    try headers.add(accept_encoding_zstd);
    try headers.add(static.accept_language_header);

    if (opts.full_client_hints) {
        const downlink_hdr = try std.fmt.allocPrintSentinel(
            allocator,
            "Downlink: {d:.2}",
            .{document_downlink},
            0,
        );
        try headers.add(downlink_hdr);
    }

    try headers.add(document_priority);

    if (opts.full_client_hints) {
        const rtt_hdr = try std.fmt.allocPrintSentinel(allocator, "RTT: {d}", .{document_rtt}, 0);
        try headers.add(rtt_hdr);

        const color_hdr = try std.fmt.allocPrintSentinel(
            allocator,
            "Sec-Ch-Prefers-Color-Scheme: {s}",
            .{opts.color_scheme},
            0,
        );
        try headers.add(color_hdr);
    }

    try headers.add(static.sec_ch_ua_header);

    if (opts.full_client_hints) {
        try appendHighEntropyClientHintsAfterSecChUa(headers, allocator, identity, opts.brands);
    }

    const mobile_hdr = try std.fmt.allocPrintSentinel(
        allocator,
        "Sec-Ch-Ua-Mobile: {s}",
        .{if (identity.ua_mobile) "?1" else "?0"},
        0,
    );
    try headers.add(mobile_hdr);

    if (opts.full_client_hints) {
        try headers.add("Sec-Ch-Ua-Model: \"\"");
    }

    const platform_hdr = try std.fmt.allocPrintSentinel(
        allocator,
        "Sec-Ch-Ua-Platform: \"{s}\"",
        .{identity.ua_data_platform},
        0,
    );
    try headers.add(platform_hdr);

    if (opts.full_client_hints) {
        const platform_ver_hdr = try std.fmt.allocPrintSentinel(
            allocator,
            "Sec-Ch-Ua-Platform-Version: \"{s}\"",
            .{identity.platform_version},
            0,
        );
        try headers.add(platform_ver_hdr);
        try headers.add("Sec-Ch-Ua-Wow64: ?0");
    }

    const site = secFetchSite(ctx);
    const mode = secFetchMode(ctx.resource_type);
    const dest = secFetchDest(ctx.resource_type);

    const dest_hdr = try std.fmt.allocPrintSentinel(allocator, "Sec-Fetch-Dest: {s}", .{dest}, 0);
    try headers.add(dest_hdr);

    const mode_hdr = try std.fmt.allocPrintSentinel(allocator, "Sec-Fetch-Mode: {s}", .{mode}, 0);
    try headers.add(mode_hdr);

    const site_hdr = try std.fmt.allocPrintSentinel(allocator, "Sec-Fetch-Site: {s}", .{site}, 0);
    try headers.add(site_hdr);

    if (!opts.omit_sec_fetch_user) {
        try headers.add("Sec-Fetch-User: ?1");
    }

    if (std.mem.startsWith(u8, ctx.request_url, "https://")) {
        try headers.add("Upgrade-Insecure-Requests: 1");
    }

    try headers.add(static.user_agent_header);
    try appendChromeXBrowserHeaders(headers);
}

/// Chrome-internal navigation markers (guest Chrome HAR, coingloo.com SERP).
fn appendChromeXBrowserHeaders(headers: *HttpClient.Headers) !void {
    try headers.add("X-Browser-Channel: stable");
    try headers.add("X-Browser-Copyright: Copyright 2026 Google LLC. All Rights Reserved.");
    try headers.add("X-Browser-Validation: 0B09MqvCV801Pqs3w59rL0XpySY=");
    try headers.add("X-Browser-Year: 2026");
}

/// Append Chrome-ordered client hints + fetch metadata. Referer is set via CURLOPT_REFERER
/// when curl-impersonate is active — do not add it here in that mode.
pub fn appendChromeHeaders(
    headers: *HttpClient.Headers,
    allocator: std.mem.Allocator,
    identity: *const Profile.IdentityProfile,
    static: *const StaticHeaders,
    ctx: RequestContext,
    opts: ChromeHeadersOpts,
) !void {
    if (!std.mem.startsWith(u8, ctx.request_url, "http")) return;

    if (ctx.resource_type == .document) {
        return appendChromeDocumentNavigationHeaders(headers, allocator, identity, static, ctx, opts);
    }

    try headers.add(static.sec_ch_ua_header);

    if (opts.full_client_hints) {
        try appendHighEntropyClientHintsAfterSecChUa(headers, allocator, identity, opts.brands);
    }

    const mobile_hdr = try std.fmt.allocPrintSentinel(
        allocator,
        "Sec-Ch-Ua-Mobile: {s}",
        .{if (identity.ua_mobile) "?1" else "?0"},
        0,
    );
    try headers.add(mobile_hdr);

    if (opts.full_client_hints) {
        try headers.add("Sec-Ch-Ua-Model: \"\"");
    }

    const platform_hdr = try std.fmt.allocPrintSentinel(
        allocator,
        "Sec-Ch-Ua-Platform: \"{s}\"",
        .{identity.ua_data_platform},
        0,
    );
    try headers.add(platform_hdr);

    if (opts.full_client_hints) {
        const platform_ver_hdr = try std.fmt.allocPrintSentinel(
            allocator,
            "Sec-Ch-Ua-Platform-Version: \"{s}\"",
            .{identity.platform_version},
            0,
        );
        try headers.add(platform_ver_hdr);
        try headers.add("Sec-Ch-Ua-Wow64: ?0");

        const color_hdr = try std.fmt.allocPrintSentinel(
            allocator,
            "Sec-Ch-Prefers-Color-Scheme: {s}",
            .{opts.color_scheme},
            0,
        );
        try headers.add(color_hdr);
    }

    try headers.add(static.user_agent_header);
    try headers.add(subresource_accept);

    const site = secFetchSite(ctx);
    const mode = secFetchMode(ctx.resource_type);
    const dest = secFetchDest(ctx.resource_type);

    const site_hdr = try std.fmt.allocPrintSentinel(allocator, "Sec-Fetch-Site: {s}", .{site}, 0);
    try headers.add(site_hdr);

    const mode_hdr = try std.fmt.allocPrintSentinel(allocator, "Sec-Fetch-Mode: {s}", .{mode}, 0);
    try headers.add(mode_hdr);

    const dest_hdr = try std.fmt.allocPrintSentinel(allocator, "Sec-Fetch-Dest: {s}", .{dest}, 0);
    try headers.add(dest_hdr);

    try headers.add(accept_encoding_zstd);
    try headers.add(static.accept_language_header);

    if (ctx.origin) |origin| {
        const origin_hdr = try std.fmt.allocPrintSentinel(allocator, "Origin: {s}", .{origin}, 0);
        try headers.add(origin_hdr);
    }
}

/// Firefox document/subresource headers — no Sec-CH-UA client hints.
pub fn appendFirefoxHeaders(
    headers: *HttpClient.Headers,
    allocator: std.mem.Allocator,
    static: *const StaticHeaders,
    ctx: RequestContext,
) !void {
    if (!std.mem.startsWith(u8, ctx.request_url, "http")) return;

    const is_document = ctx.resource_type == .document;

    try headers.add(static.user_agent_header);
    try headers.add(if (is_document) firefox_document_accept else subresource_accept);
    try headers.add(static.accept_language_header);
    try headers.add(accept_encoding);

    if (is_document and std.mem.startsWith(u8, ctx.request_url, "https://")) {
        try headers.add("Upgrade-Insecure-Requests: 1");
    }

    const dest = secFetchDest(ctx.resource_type);
    const mode = secFetchMode(ctx.resource_type);
    const site = secFetchSite(ctx);

    const dest_hdr = try std.fmt.allocPrintSentinel(allocator, "Sec-Fetch-Dest: {s}", .{dest}, 0);
    try headers.add(dest_hdr);

    const mode_hdr = try std.fmt.allocPrintSentinel(allocator, "Sec-Fetch-Mode: {s}", .{mode}, 0);
    try headers.add(mode_hdr);

    const site_hdr = try std.fmt.allocPrintSentinel(allocator, "Sec-Fetch-Site: {s}", .{site}, 0);
    try headers.add(site_hdr);

    if (is_document) {
        try headers.add("Sec-Fetch-User: ?1");
    }

    if (!is_document) {
        if (ctx.origin) |origin| {
            const origin_hdr = try std.fmt.allocPrintSentinel(allocator, "Origin: {s}", .{origin}, 0);
            try headers.add(origin_hdr);
        }
    }
}

/// Fallback header order when curl-impersonate is unavailable (still Chrome-like).
pub fn appendFallbackHeaders(
    headers: *HttpClient.Headers,
    allocator: std.mem.Allocator,
    identity: *const Profile.IdentityProfile,
    static: *const StaticHeaders,
    ctx: RequestContext,
    referer_header: [:0]const u8,
) !void {
    if (referer_header.len > 0) {
        try headers.add(referer_header);
    }

    const mobile_hdr = try std.fmt.allocPrintSentinel(
        allocator,
        "Sec-Ch-Ua-Mobile: {s}",
        .{if (identity.ua_mobile) "?1" else "?0"},
        0,
    );
    try headers.add(mobile_hdr);

    const platform_hdr = try std.fmt.allocPrintSentinel(
        allocator,
        "Sec-Ch-Ua-Platform: \"{s}\"",
        .{identity.ua_data_platform},
        0,
    );
    try headers.add(platform_hdr);

    if (!std.mem.startsWith(u8, ctx.request_url, "http")) return;

    const is_document = ctx.resource_type == .document;
    try headers.add(if (is_document) document_accept else subresource_accept);

    if (!is_document) {
        if (ctx.origin) |origin| {
            const origin_hdr = try std.fmt.allocPrintSentinel(allocator, "Origin: {s}", .{origin}, 0);
            try headers.add(origin_hdr);
        }
    }

    const dest = secFetchDest(ctx.resource_type);
    const mode = secFetchMode(ctx.resource_type);
    const site = secFetchSite(ctx);

    const dest_hdr = try std.fmt.allocPrintSentinel(allocator, "Sec-Fetch-Dest: {s}", .{dest}, 0);
    try headers.add(dest_hdr);

    const mode_hdr = try std.fmt.allocPrintSentinel(allocator, "Sec-Fetch-Mode: {s}", .{mode}, 0);
    try headers.add(mode_hdr);

    const site_hdr = try std.fmt.allocPrintSentinel(allocator, "Sec-Fetch-Site: {s}", .{site}, 0);
    try headers.add(site_hdr);

    if (is_document) {
        try headers.add("Sec-Fetch-User: ?1");
        if (std.mem.startsWith(u8, ctx.request_url, "https://")) {
            try headers.add("Upgrade-Insecure-Requests: 1");
        }
    }

    try headers.add(static.sec_ch_ua_header);
    try headers.add(static.user_agent_header);
    try headers.add(accept_encoding);
    try headers.add(static.accept_language_header);
}

const testing = @import("../../testing/testing.zig");

test "HttpProfile: secFetchSite same-origin" {
    const ctx = RequestContext{
        .request_url = "https://www.google.com/search",
        .resource_type = .document,
        .frame_origin = "https://www.google.com",
        .is_document_navigation = false,
    };
    try testing.expectEqualStrings("same-origin", secFetchSite(ctx));
}

test "HttpProfile: brandFullVersion maps Not A Brand to x.0.0.0" {
    const alloc = testing.allocator;
    const ver = try brandFullVersion(alloc, .{ .brand = "Not)A;Brand", .version = "24" }, "149.0.7827.104");
    try testing.expectEqualStrings("24.0.0.0", ver);
    const chrome_ver = try brandFullVersion(alloc, .{ .brand = "Google Chrome", .version = "149" }, "149.0.7827.104");
    try testing.expectEqualStrings("149.0.7827.104", chrome_ver);
}
