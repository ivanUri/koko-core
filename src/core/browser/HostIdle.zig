// Single host-idle predicates for Runner / CDP (architecture Phase 3).
// See knowledge/architecture/2026-07-19-host-event-loop.md.

const js = @import("../js/js.zig");
const Frame = @import("Frame.zig");
const Browser = @import("Browser.zig");
const HttpClient = @import("HttpClient.zig");

const HostIdle = @This();

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
    if (browser.msToNextMacrotask() != null) return false;
    // Due-now host tasks should already be reflected in msToNext==0, but
    // keep an explicit ready check for delay-0 storms mid-tick.
    if (js.EventLoop.hasReadyWork(&frame.js.execution)) return false;
    return true;
}
