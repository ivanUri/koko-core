//! Low-cost counters for concurrency investigations.
//!
//! These counters deliberately do not alter scheduling or ownership. They are
//! kept in the runtime so future benchmark/diagnostic adapters can consume the
//! same measurements instead of inferring queue pressure from wall time alone.

const std = @import("std");

pub const Snapshot = struct {
    arena_acquires: u64,
    arena_reuses: u64,
    arena_releases: u64,
    arena_evictions: u64,
    network_submissions: u64,
    network_queue_high_water: u64,
    network_active_high_water: u64,
    network_completions: u64,
};

const ScaleMetrics = @This();

arena_acquires: std.atomic.Value(u64) = .init(0),
arena_reuses: std.atomic.Value(u64) = .init(0),
arena_releases: std.atomic.Value(u64) = .init(0),
arena_evictions: std.atomic.Value(u64) = .init(0),
network_submissions: std.atomic.Value(u64) = .init(0),
network_queue_high_water: std.atomic.Value(u64) = .init(0),
network_active_high_water: std.atomic.Value(u64) = .init(0),
network_completions: std.atomic.Value(u64) = .init(0),

pub fn snapshot(self: *const ScaleMetrics) Snapshot {
    return .{
        .arena_acquires = self.arena_acquires.load(.monotonic),
        .arena_reuses = self.arena_reuses.load(.monotonic),
        .arena_releases = self.arena_releases.load(.monotonic),
        .arena_evictions = self.arena_evictions.load(.monotonic),
        .network_submissions = self.network_submissions.load(.monotonic),
        .network_queue_high_water = self.network_queue_high_water.load(.monotonic),
        .network_active_high_water = self.network_active_high_water.load(.monotonic),
        .network_completions = self.network_completions.load(.monotonic),
    };
}

pub fn recordHighWater(counter: *std.atomic.Value(u64), value: usize) void {
    const candidate: u64 = @intCast(value);
    var current = counter.load(.monotonic);
    while (candidate > current) {
        current = counter.cmpxchgWeak(current, candidate, .monotonic, .monotonic) orelse return;
    }
}

test "scale metrics keeps monotonic high-water marks" {
    var metrics: ScaleMetrics = .{};
    recordHighWater(&metrics.network_queue_high_water, 4);
    recordHighWater(&metrics.network_queue_high_water, 2);
    recordHighWater(&metrics.network_queue_high_water, 9);
    try std.testing.expectEqual(@as(u64, 9), metrics.snapshot().network_queue_high_water);
}
