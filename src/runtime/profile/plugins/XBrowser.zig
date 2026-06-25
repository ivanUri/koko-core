const std = @import("std");
const HttpClient = @import("../../../core/browser/HttpClient.zig");

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

        var parsed = try std.json.parseFromSlice(JsonPlugin, allocator, bytes, .{});
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
    ) !void {
        const validation = try validationToken(allocator, &self.config, user_agent);
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
    }
};

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

test "XBrowser: loads plugin JSON" {
    var plugin = try Plugin.load(testing.allocator);
    defer plugin.deinit(testing.allocator);
    try testing.expectEqualStrings("stable", plugin.config.channel);
    try testing.expectEqualStrings("2026", plugin.config.year);
}
