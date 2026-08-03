// Single host-idle predicates for Runner / CDP (architecture Phase 3).
// See knowledge/architecture/2026-07-19-host-event-loop.md.

const js = @import("../js/js.zig");
const Frame = @import("Frame.zig");
const Browser = @import("Browser.zig");
const HttpClient = @import("HttpClient.zig");

const HostIdle = @This();

/// A visually useful document snapshot is stable when the loaded document's
/// DOM/layout generation has not changed for this interval. Network activity
/// is intentionally not part of this predicate: analytics, polling, WebSocket,
/// and RTC traffic must not keep a rendered document open forever.
pub const dom_stable_ms: u64 = 500;

pub const DomStability = struct {
    frame_identity: usize = 0,
    version: usize = 0,
    changed_at_ms: u64 = 0,

    pub fn reset(self: *DomStability) void {
        self.* = .{};
    }

    /// Observe the current rendered generation. Stability starts only after
    /// `load`: before that point parser/resource progress may legitimately
    /// pause without representing a useful completed visual snapshot.
    pub fn observe(self: *DomStability, frame: *const Frame, now_ms: u64) bool {
        return self.observeGeneration(
            frame._load_state == .complete,
            @intFromPtr(frame),
            frame.version,
            now_ms,
        );
    }

    fn observeGeneration(self: *DomStability, loaded: bool, frame_identity: usize, version: usize, now_ms: u64) bool {
        if (!loaded) {
            self.reset();
            return false;
        }

        if (self.frame_identity != frame_identity or self.version != version) {
            self.frame_identity = frame_identity;
            self.version = version;
            self.changed_at_ms = now_ms;
            return false;
        }

        return now_ms -| self.changed_at_ms >= dom_stable_ms;
    }
};

test "DOM stability starts after load and resets on generation or frame change" {
    const testing = @import("std").testing;
    var stability: DomStability = .{};

    try testing.expect(!stability.observeGeneration(false, 1, 10, 0));
    try testing.expect(!stability.observeGeneration(true, 1, 10, 100));
    try testing.expect(!stability.observeGeneration(true, 1, 10, 599));
    try testing.expect(stability.observeGeneration(true, 1, 10, 600));

    try testing.expect(!stability.observeGeneration(true, 1, 11, 700));
    try testing.expect(!stability.observeGeneration(true, 1, 11, 1199));
    try testing.expect(stability.observeGeneration(true, 1, 11, 1200));

    try testing.expect(!stability.observeGeneration(true, 2, 11, 1300));
}

/// HTTP activity units for networkIdle / networkAlmostIdle thresholds.
pub fn totalHttpActivity(http: *const HttpClient) usize {
    return http.totalHttpActivity();
}

/// No inflight HTTP/WS/RTC and no queued transfers (ready_queue, etc.).
pub fn isNetworkIdle(http: *const HttpClient) bool {
    return http.isNetworkIdle();
}

/// `wait_until=done`: network quiet, no pending script eval, no scheduled macrotasks.
pub fn isFullyIdle(http: *const HttpClient, frame: *Frame, browser: *Browser) bool {
    if (!http.isNetworkIdle()) return false;
    if (frame._script_manager.base.hasPendingJsWork()) return false;
    if (frame.hasPendingResourceLoadEvents()) return false;
    if (browser.msToNextMacrotask() != null) return false;
    // Due-now host tasks should already be reflected in msToNext==0, but
    // keep an explicit ready check for delay-0 storms mid-tick.
    if (js.EventLoop.hasReadyWork(&frame.js.execution)) return false;
    return true;
}
