const std = @import("std");

pub const Mode = enum {
    off,
    fast,

    pub fn parse(raw: []const u8) ?Mode {
        if (std.mem.eql(u8, raw, "off")) return .off;
        if (std.mem.eql(u8, raw, "fast")) return .fast;
        return null;
    }
};

pub const Policy = struct {
    mode: Mode = .off,

    pub fn blockScripts(self: Policy) bool {
        return self.mode == .fast;
    }

    pub fn defaultWaitUntil(self: Policy) @import("Config.zig").WaitUntil {
        return if (self.mode == .fast) @import("Config.zig").WaitUntil.domcontentloaded else .done;
    }
};

test "AutomationPolicy.fast blocks scripts" {
    try std.testing.expect((Policy{ .mode = .fast }).blockScripts());
    try std.testing.expect(!(Policy{ .mode = .off }).blockScripts());
}

test "AutomationPolicy.fast prefers domcontentloaded" {
    const WaitUntil = @import("Config.zig").WaitUntil;
    try std.testing.expectEqual(WaitUntil.domcontentloaded, (Policy{ .mode = .fast }).defaultWaitUntil());
    try std.testing.expectEqual(WaitUntil.done, (Policy{ .mode = .off }).defaultWaitUntil());
}
