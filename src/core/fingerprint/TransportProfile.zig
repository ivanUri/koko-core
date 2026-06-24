const std = @import("std");
const Spoofing = @import("Spoofing.zig");

/// Maps browser profile → curl-impersonate TLS/JA3 target.
/// curl-impersonate ships through chrome146; Chrome 147–149 map to chrome146 (nearest).
pub const Target = enum {
    chrome120,
    chrome131,
    chrome136,
    chrome142,
    chrome145,
    chrome146,
    firefox144,
    firefox147,

    pub fn name(self: Target) [:0]const u8 {
        return switch (self) {
            .chrome120 => "chrome120",
            .chrome131 => "chrome131",
            .chrome136 => "chrome136",
            .chrome142 => "chrome142",
            .chrome145 => "chrome145",
            .chrome146 => "chrome146",
            .firefox144 => "firefox144",
            .firefox147 => "firefox147",
        };
    }

    pub fn isFirefox(self: Target) bool {
        return switch (self) {
            .firefox144, .firefox147 => true,
            else => false,
        };
    }

    pub fn fromChromeMajor(major: u32) Target {
        return if (major >= 147)
            .chrome146
        else if (major >= 144)
            .chrome145
        else if (major >= 140)
            .chrome142
        else if (major >= 136)
            .chrome136
        else if (major >= 126)
            .chrome131
        else
            .chrome120;
    }

    pub fn fromFirefoxMajor(major: u32) Target {
        return if (major >= 147) .firefox147 else .firefox144;
    }

    pub fn parse(raw: []const u8) ?Target {
        if (std.mem.eql(u8, raw, "chrome120")) return .chrome120;
        if (std.mem.eql(u8, raw, "chrome131")) return .chrome131;
        if (std.mem.eql(u8, raw, "chrome136")) return .chrome136;
        if (std.mem.eql(u8, raw, "chrome142")) return .chrome142;
        if (std.mem.eql(u8, raw, "chrome145")) return .chrome145;
        if (std.mem.eql(u8, raw, "chrome146")) return .chrome146;
        if (std.mem.eql(u8, raw, "firefox144")) return .firefox144;
        if (std.mem.eql(u8, raw, "firefox147")) return .firefox147;
        // Accept chromeNNN (e.g. chrome149) — map to nearest shipped impersonate profile.
        if (std.mem.startsWith(u8, raw, "chrome")) {
            const num = std.fmt.parseInt(u32, raw["chrome".len..], 10) catch return null;
            return fromChromeMajor(num);
        }
        if (std.mem.startsWith(u8, raw, "firefox")) {
            const num = std.fmt.parseInt(u32, raw["firefox".len..], 10) catch return null;
            return fromFirefoxMajor(num);
        }
        return null;
    }

    pub fn resolve(explicit: ?[]const u8, user_agent: []const u8) Target {
        if (explicit) |raw| {
            if (parse(raw)) |t| return t;
        }
        if (extractFirefoxVersion(user_agent)) |major| {
            return fromFirefoxMajor(major);
        }
        if (Spoofing.extractChromeVersion(user_agent)) |v| {
            return fromChromeMajor(v.major);
        }
        return .chrome146;
    }
};

fn extractFirefoxVersion(user_agent: []const u8) ?u32 {
    const needle = "Firefox/";
    const idx = std.mem.indexOf(u8, user_agent, needle) orelse return null;
    const start = idx + needle.len;
    const rest = user_agent[start..];
    const end = std.mem.indexOfAny(u8, rest, " .") orelse return null;
    return std.fmt.parseInt(u32, rest[0..end], 10) catch null;
}

const testing = @import("../../testing/testing.zig");

test "TransportProfile: derive from UA" {
    const ua131 = "Mozilla/5.0 Chrome/131.0.0.0 Safari/537.36";
    try testing.expectEqual(Target.chrome131, Target.resolve(null, ua131));
    const ua149 = "Mozilla/5.0 Chrome/149.0.0.0 Safari/537.36";
    try testing.expectEqual(Target.chrome146, Target.resolve(null, ua149));
}

test "TransportProfile: explicit override" {
    try testing.expectEqual(Target.chrome136, Target.resolve("chrome136", ""));
    try testing.expectEqual(Target.chrome146, Target.resolve("chrome149", ""));
    try testing.expectEqual(Target.firefox147, Target.resolve("firefox147", ""));
}

test "TransportProfile: derive Firefox from UA" {
    const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:147.0) Gecko/20100101 Firefox/147.0";
    try testing.expectEqual(Target.firefox147, Target.resolve(null, ua));
}
