const std = @import("std");

/// Per-session seed for canvas/audio fingerprint variation. Stable for the session.
pub fn sessionSeed(profile_id: []const u8, nonce: u64) u64 {
    var hasher = std.hash.Wyhash.init(0);
    hasher.update(profile_id);
    hasher.update(std.mem.asBytes(&nonce));
    return hasher.final();
}

pub fn mixHash(hash: u32, seed: u64) u32 {
    const s: u32 = @truncate(seed);
    return hash ^ s ^ @as(u32, @truncate(seed >> 32));
}

pub fn audioOffset(seed: u64, index: usize) f32 {
    const mixed = seed ^ (@as(u64, @intCast(index)) *% 0x9E3779B97F4A7C15);
    const frac = @as(f32, @floatFromInt(@as(u32, @truncate(mixed % 997)))) / 997.0;
    return frac * 1e-8;
}

const testing = @import("../../testing/testing.zig");

test "FingerprintSeed: stable per session" {
    const a = sessionSeed("chrome-macos-sonoma", 42);
    const b = sessionSeed("chrome-macos-sonoma", 42);
    try testing.expectEqual(a, b);
    try testing.expect(a != sessionSeed("chrome-windows-11", 42));
}
