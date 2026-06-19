// Minimal window.chrome stub for Blink-like environments.
// Intentionally omits chrome.runtime to avoid hasBadChromeRuntime signals.

const std = @import("std");
const js = @import("../js/js.zig");

const Chrome = @This();

_pad: bool = false,

pub const init: Chrome = .{};

pub const LoadTimes = struct {
    requestTime: f64 = 0,
    startLoadTime: f64 = 0,
    commitLoadTime: f64 = 0,
    finishDocumentLoadTime: f64 = 0,
    finishLoadTime: f64 = 0,
    firstPaintTime: f64 = 0,
    firstPaintAfterLoadTime: f64 = 0,
    navigationType: []const u8 = "Other",
    wasFetchedViaSpdy: bool = false,
    wasNpnNegotiated: bool = true,
    npnNegotiatedProtocol: []const u8 = "h2",
    wasAlternateProtocolAvailable: bool = false,
    connectionInfo: []const u8 = "h2",
};

pub const Csi = struct {
    startE: u64 = 0,
    onloadT: u64 = 0,
    pageT: f64 = 0,
    tran: u32 = 15,
};

pub fn loadTimes(_: *const Chrome) LoadTimes {
    const now = @as(f64, @floatFromInt(std.time.timestamp()));
    return .{
        .requestTime = now - 0.4,
        .startLoadTime = now - 0.35,
        .commitLoadTime = now - 0.2,
        .finishDocumentLoadTime = now - 0.05,
        .finishLoadTime = now,
        .firstPaintTime = now - 0.1,
        .firstPaintAfterLoadTime = 0,
    };
}

pub fn csi(_: *const Chrome) Csi {
    const now_ms: u64 = @intCast(@max(std.time.milliTimestamp(), 0));
    return .{
        .startE = now_ms -| 400,
        .onloadT = now_ms,
        .pageT = 45.2,
        .tran = 15,
    };
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(Chrome);

    pub const Meta = struct {
        pub const name = "Chrome";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const loadTimes = bridge.function(Chrome.loadTimes, .{});
    pub const csi = bridge.function(Chrome.csi, .{});
};
