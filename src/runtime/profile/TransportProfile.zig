const std = @import("std");
const Spoofing = @import("Spoofing.zig");

/// Maps browser profile → curl-impersonate TLS/JA3 target.
/// curl-impersonate ships through chrome146; Chrome 147–149 map to chrome146.
/// Chrome 150+ uses chrome146 base + ML-DSA sig algs (mldsa44/65/87) at runtime.
pub const Target = enum {
    chrome120,
    chrome131,
    chrome136,
    chrome142,
    chrome145,
    chrome146,
    /// Logical Chrome 150: curl target remains chrome146; ML-DSA applied after impersonate.
    chrome150,
    firefox144,
    firefox147,
    /// Safari 18.4-class (vendor curl-impersonate safari184).
    safari184,
    /// Safari 26.0-class (vendor curl-impersonate safari260).
    safari260,

    pub fn name(self: Target) [:0]const u8 {
        return switch (self) {
            .chrome120 => "chrome120",
            .chrome131 => "chrome131",
            .chrome136 => "chrome136",
            .chrome142 => "chrome142",
            .chrome145 => "chrome145",
            .chrome146 => "chrome146",
            .chrome150 => "chrome150",
            .firefox144 => "firefox144",
            .firefox147 => "firefox147",
            .safari184 => "safari184",
            .safari260 => "safari260",
        };
    }

    /// Value passed to curl_easy_impersonate / --impersonate (must exist in the vendor binary).
    pub fn curlImpersonate(self: Target) [:0]const u8 {
        return switch (self) {
            .chrome150 => "chrome146",
            else => self.name(),
        };
    }

    /// Chrome 150+ ClientHello prepends ML-DSA (0x0904/05/06) to the classic sig list.
    pub fn usesChrome150SigAlgs(self: Target) bool {
        return self == .chrome150;
    }

    pub fn isFirefox(self: Target) bool {
        return switch (self) {
            .firefox144, .firefox147 => true,
            else => false,
        };
    }

    pub fn isSafari(self: Target) bool {
        return switch (self) {
            .safari184, .safari260 => true,
            else => false,
        };
    }

    /// Chromium stack: chrome TLS knobs + optional h3 document force.
    pub fn isChromium(self: Target) bool {
        return !self.isFirefox() and !self.isSafari();
    }

    pub fn fromChromeMajor(major: u32) Target {
        return if (major >= 150)
            .chrome150
        else if (major >= 147)
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
        if (std.mem.eql(u8, raw, "chrome150")) return .chrome150;
        if (std.mem.eql(u8, raw, "firefox144")) return .firefox144;
        if (std.mem.eql(u8, raw, "firefox147")) return .firefox147;
        if (std.mem.eql(u8, raw, "safari184")) return .safari184;
        if (std.mem.eql(u8, raw, "safari260")) return .safari260;
        // Accept chromeNNN (e.g. chrome149) — map to nearest shipped impersonate profile.
        if (std.mem.startsWith(u8, raw, "chrome")) {
            const num = std.fmt.parseInt(u32, raw["chrome".len..], 10) catch return null;
            return fromChromeMajor(num);
        }
        if (std.mem.startsWith(u8, raw, "firefox")) {
            const num = std.fmt.parseInt(u32, raw["firefox".len..], 10) catch return null;
            return fromFirefoxMajor(num);
        }
        if (std.mem.startsWith(u8, raw, "safari")) {
            const rest = raw["safari".len..];
            // safari260 / safari18_4 style
            if (std.mem.eql(u8, rest, "260") or std.mem.eql(u8, rest, "26_0") or std.mem.eql(u8, rest, "26.0"))
                return .safari260;
            if (std.mem.eql(u8, rest, "184") or std.mem.eql(u8, rest, "18_4") or std.mem.eql(u8, rest, "18.4"))
                return .safari184;
            const num = std.fmt.parseInt(u32, rest, 10) catch return null;
            return if (num >= 260) .safari260 else .safari184;
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
        // Safari UA: "Version/26.0 Safari/605.1.15" without Chrome/
        if (std.mem.indexOf(u8, user_agent, "Safari/") != null and
            std.mem.indexOf(u8, user_agent, "Chrome/") == null and
            std.mem.indexOf(u8, user_agent, "Chromium/") == null)
        {
            if (extractSafariVersion(user_agent)) |maj| {
                return if (maj >= 26) .safari260 else .safari184;
            }
            return .safari260;
        }
        if (Spoofing.extractChromeVersion(user_agent)) |v| {
            return fromChromeMajor(v.major);
        }
        return .chrome146;
    }
};

fn extractSafariVersion(user_agent: []const u8) ?u32 {
    const needle = "Version/";
    const idx = std.mem.indexOf(u8, user_agent, needle) orelse return null;
    const start = idx + needle.len;
    const rest = user_agent[start..];
    const end = std.mem.indexOfAny(u8, rest, " .") orelse return null;
    return std.fmt.parseInt(u32, rest[0..end], 10) catch null;
}

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
    const ua150 = "Mozilla/5.0 Chrome/150.0.0.0 Safari/537.36";
    try testing.expectEqual(Target.chrome150, Target.resolve(null, ua150));
}

test "TransportProfile: explicit override" {
    try testing.expectEqual(Target.chrome136, Target.resolve("chrome136", ""));
    try testing.expectEqual(Target.chrome146, Target.resolve("chrome149", ""));
    try testing.expectEqual(Target.chrome150, Target.resolve("chrome150", ""));
    try testing.expectEqual(Target.firefox147, Target.resolve("firefox147", ""));
}

test "TransportProfile: chrome150 curl target and sig flag" {
    try testing.expectEqualStrings("chrome150", Target.chrome150.name());
    try testing.expectEqualStrings("chrome146", Target.chrome150.curlImpersonate());
    try testing.expect(Target.chrome150.usesChrome150SigAlgs());
    try testing.expect(!Target.chrome146.usesChrome150SigAlgs());
}

test "TransportProfile: derive Firefox from UA" {
    const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:147.0) Gecko/20100101 Firefox/147.0";
    try testing.expectEqual(Target.firefox147, Target.resolve(null, ua));
}

test "TransportProfile: derive Safari from UA" {
    const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
    try testing.expectEqual(Target.safari260, Target.resolve(null, ua));
    try testing.expectEqual(Target.safari260, Target.resolve("safari260", ""));
    try testing.expect(Target.safari260.isSafari());
    try testing.expect(!Target.safari260.isChromium());
}
