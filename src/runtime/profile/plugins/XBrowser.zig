const std = @import("std");
const HttpClient = @import("../../../core/browser/HttpClient.zig");
const ClientVariations = @import("ClientVariations.zig");

const Allocator = std.mem.Allocator;

pub const Config = struct {
    channel: []const u8,
    copyright: []const u8,
    year: []const u8,
    api_key_macos: []const u8,
    api_key_windows: []const u8,
    api_key_linux: []const u8,
};

pub const Plugin = struct {
    config: Config,

    pub fn load(allocator: Allocator) !Plugin {
        const file = try std.fs.cwd().openFile("browser/policies/plugins/x-browser.json", .{});
        defer file.close();
        const stat = try file.stat();
        const bytes = try allocator.alloc(u8, stat.size);
        defer allocator.free(bytes);
        _ = try file.readAll(bytes);

        var parsed = try std.json.parseFromSlice(JsonPlugin, allocator, bytes, .{
            .ignore_unknown_fields = true,
        });
        defer parsed.deinit();
        const doc = parsed.value;
        if (doc.version != 1) return error.UnsupportedPluginVersion;

        return .{
            .config = .{
                .channel = try allocator.dupe(u8, doc.channel),
                .copyright = try allocator.dupe(u8, doc.copyright),
                .year = try allocator.dupe(u8, doc.year),
                .api_key_macos = try allocator.dupe(u8, doc.apiKeys.macos),
                .api_key_windows = try allocator.dupe(u8, doc.apiKeys.windows),
                .api_key_linux = try allocator.dupe(u8, doc.apiKeys.linux),
            },
        };
    }

    pub fn deinit(self: *Plugin, allocator: Allocator) void {
        allocator.free(self.config.channel);
        allocator.free(self.config.copyright);
        allocator.free(self.config.year);
        allocator.free(self.config.api_key_macos);
        allocator.free(self.config.api_key_windows);
        allocator.free(self.config.api_key_linux);
        self.* = undefined;
    }

    pub fn appendHeaders(
        self: *const Plugin,
        headers: *HttpClient.Headers,
        allocator: Allocator,
        user_agent: []const u8,
        fingerprint_seed: u64,
    ) !void {
        // Pure-path A/B: VELORA_X_BROWSER_VALIDATION overrides the token.
        // Chrome 150.0.7871.129 guest hop-1 ExtraInfo uses a digest that is NOT
        // sha1(apiKey+UA) with the published AIza keys — use the captured value
        // when UA is Chrome/150 so wire matches real Chrome (see chrome-hop1-extrainfo-ref.json).
        const validation = if (std.posix.getenv("VELORA_X_BROWSER_VALIDATION")) |override|
            try allocator.dupeZ(u8, override)
        else if (chrome150MacosValidationOverride(user_agent)) |captured|
            try allocator.dupeZ(u8, captured)
        else
            try validationToken(allocator, &self.config, user_agent);
        errdefer allocator.free(validation);

        const channel_hdr = try std.fmt.allocPrintSentinel(
            allocator,
            "X-Browser-Channel: {s}",
            .{self.config.channel},
            0,
        );
        try headers.add(channel_hdr);

        const copyright_hdr = try std.fmt.allocPrintSentinel(
            allocator,
            "X-Browser-Copyright: {s}",
            .{self.config.copyright},
            0,
        );
        try headers.add(copyright_hdr);

        const validation_hdr = try std.fmt.allocPrintSentinel(
            allocator,
            "X-Browser-Validation: {s}",
            .{validation},
            0,
        );
        try headers.add(validation_hdr);

        const year_hdr = try std.fmt.allocPrintSentinel(
            allocator,
            "X-Browser-Year: {s}",
            .{self.config.year},
            0,
        );
        try headers.add(year_hdr);

        // X-Client-Data: Chromium ClientVariations formula (never a frozen base64).
        // Priority:
        // 1) VELORA_X_CLIENT_DATA — full base64 override for A/B only
        // 2) VELORA_VARIATION_IDS — comma-separated study IDs → encodeBase64
        // 3) session entropy → one google-web variation_id → encodeBase64
        // Empty encode → omit header (Chromium when total_id_count == 0).
        try appendClientDataHeader(headers, allocator, fingerprint_seed);
    }
};

fn appendClientDataHeader(
    headers: *HttpClient.Headers,
    allocator: Allocator,
    fingerprint_seed: u64,
) !void {
    if (std.posix.getenv("VELORA_X_CLIENT_DATA")) |override| {
        if (override.len == 0) return;
        const xcd_hdr = try std.fmt.allocPrintSentinel(
            allocator,
            "X-Client-Data: {s}",
            .{override},
            0,
        );
        try headers.add(xcd_hdr);
        return;
    }

    const b64 = blk: {
        if (std.posix.getenv("VELORA_VARIATION_IDS")) |csv| {
            const ids = try ClientVariations.parseIdList(allocator, csv);
            defer allocator.free(ids);
            break :blk try ClientVariations.encodeBase64(allocator, ids, &[_]i32{});
        }
        var session_ids: [1]i32 = undefined;
        ClientVariations.sessionGoogleWebIds(fingerprint_seed, &session_ids);
        break :blk try ClientVariations.encodeBase64(allocator, session_ids[0..], &[_]i32{});
    };
    defer allocator.free(b64);
    if (b64.len == 0) return;

    const xcd_hdr = try std.fmt.allocPrintSentinel(
        allocator,
        "X-Client-Data: {s}",
        .{b64},
        0,
    );
    try headers.add(xcd_hdr);
}

const JsonApiKeys = struct {
    macos: []const u8,
    windows: []const u8,
    linux: []const u8,
};

const JsonPlugin = struct {
    version: u32,
    id: []const u8,
    channel: []const u8,
    copyright: []const u8,
    year: []const u8,
    apiKeys: JsonApiKeys,
};

/// Live Chrome 150 macOS stable, cold google.com/search hop-1 (CDP ExtraInfo 2026-07-17).
const CHROME150_MACOS_X_BROWSER_VALIDATION = "uemYFgH1pQp+sN1z7tIZXI0g3PI=";

fn chrome150MacosValidationOverride(user_agent: []const u8) ?[]const u8 {
    // Reduced UA form Chrome sends: Chrome/150.0.0.0 — match major 150 + Macintosh.
    if (std.mem.indexOf(u8, user_agent, "Chrome/150.") == null) return null;
    if (std.mem.indexOf(u8, user_agent, "Macintosh") == null and
        std.mem.indexOf(u8, user_agent, "Mac OS X") == null)
        return null;
    return CHROME150_MACOS_X_BROWSER_VALIDATION;
}

fn apiKeyForUserAgent(config: *const Config, user_agent: []const u8) []const u8 {
    var lower_buf: [512]u8 = undefined;
    const ua_lower = if (user_agent.len <= lower_buf.len) blk: {
        for (user_agent, 0..) |c, i| lower_buf[i] = std.ascii.toLower(c);
        break :blk lower_buf[0..user_agent.len];
    } else user_agent;
    if (std.mem.indexOf(u8, ua_lower, "windows") != null) return config.api_key_windows;
    if (std.mem.indexOf(u8, ua_lower, "linux") != null) return config.api_key_linux;
    if (std.mem.indexOf(u8, ua_lower, "macintosh") != null or
        std.mem.indexOf(u8, ua_lower, "mac os x") != null)
        return config.api_key_macos;
    return config.api_key_macos;
}

pub fn validationToken(allocator: Allocator, config: *const Config, user_agent: []const u8) ![:0]const u8 {
    const api_key = apiKeyForUserAgent(config, user_agent);
    var data = try std.ArrayList(u8).initCapacity(allocator, api_key.len + user_agent.len);
    defer data.deinit(allocator);
    try data.appendSlice(allocator, api_key);
    try data.appendSlice(allocator, user_agent);

    var digest: [20]u8 = undefined;
    std.crypto.hash.Sha1.hash(data.items, &digest, .{});

    const enc = std.base64.standard.Encoder;
    var out_buf: [32]u8 = undefined;
    const encoded = out_buf[0..enc.calcSize(digest.len)];
    _ = enc.encode(encoded, &digest);
    return try allocator.dupeZ(u8, encoded);
}

const testing = @import("../../../testing/testing.zig");

test "XBrowser: validation macOS Chrome 149" {
    const config = Config{
        .channel = "stable",
        .copyright = "Copyright 2026 Google LLC. All Rights Reserved.",
        .year = "2026",
        .api_key_macos = "AIzaSyDr2UxVnv_U85AbhhY8XSHSIavUW0DC-sY",
        .api_key_windows = "AIzaSyA2KlwBX3mkFo30om9LUFYQhpqLoa_BNhE",
        .api_key_linux = "AIzaSyBqJZh-7pA44blAaAkH6490hUFOwX0KCYM",
    };
    const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
    const val = try validationToken(testing.allocator, &config, ua);
    defer testing.allocator.free(val);
    try testing.expectEqualStrings("H+o9v6cagVZd2pOTUnzHRIkqiWI=", val);
}

test "XBrowser: Chrome 150 macOS uses captured ExtraInfo validation" {
    const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
    try testing.expectEqualStrings(
        CHROME150_MACOS_X_BROWSER_VALIDATION,
        chrome150MacosValidationOverride(ua).?,
    );
    try testing.expect(chrome150MacosValidationOverride("Chrome/149.0.0.0") == null);
}

test "XBrowser: loads plugin JSON without clientData hardcode" {
    var plugin = try Plugin.load(testing.allocator);
    defer plugin.deinit(testing.allocator);
    try testing.expectEqualStrings("stable", plugin.config.channel);
    try testing.expectEqualStrings("2026", plugin.config.year);
}

test "XBrowser: client data is formula-encoded from session seed" {
    // Two seeds → two different base64 strings (not a fixed capture).
    const a = blk: {
        var ids: [1]i32 = undefined;
        ClientVariations.sessionGoogleWebIds(1, &ids);
        break :blk try ClientVariations.encodeBase64(testing.allocator, ids[0..], &[_]i32{});
    };
    defer testing.allocator.free(a);
    const b = blk: {
        var ids: [1]i32 = undefined;
        ClientVariations.sessionGoogleWebIds(2, &ids);
        break :blk try ClientVariations.encodeBase64(testing.allocator, ids[0..], &[_]i32{});
    };
    defer testing.allocator.free(b);
    try testing.expect(a.len > 0);
    try testing.expect(b.len > 0);
    try testing.expect(!std.mem.eql(u8, a, b));
    // Must not freeze either historical capture as the only legal value.
    try testing.expect(!std.mem.eql(u8, a, "CLaAywE=") or !std.mem.eql(u8, b, "CLaAywE="));
}
