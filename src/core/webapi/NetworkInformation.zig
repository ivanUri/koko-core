const std = @import("std");
const js = @import("../js/js.zig");
const HttpProfile = @import("../../runtime/profile/HttpProfile.zig");

const NetworkInformation = @This();

// NetworkInformation for navigator.connection
// https://wicg.github.io/netinfo/
//
// Chrome desktop (wifi/ethernet): `type` is "wifi"/"ethernet", `downlinkMax` is
// Infinity (no cellular max). CreepJS / NetInfo consumers use
// `'downlinkMax' in NetworkInformation.prototype` — the property must exist.

pub fn getEffectiveType(_: *const NetworkInformation) []const u8 {
    return "4g";
}

pub fn getDownlink(_: *const NetworkInformation) f64 {
    return HttpProfile.in_session_downlink;
}

pub fn getRtt(_: *const NetworkInformation) f64 {
    return @floatFromInt(HttpProfile.in_session_rtt);
}

pub fn getSaveData(_: *const NetworkInformation) bool {
    return false;
}

/// Connection type (Chrome: `navigator.connection.type`).
pub fn getType(_: *const NetworkInformation) []const u8 {
    return "wifi";
}

/// Max downlink Mbps for the underlying technology. Chrome returns `Infinity`
/// for wifi/ethernet (no cellular radio max). Cellular profiles would use a
/// finite Mbps value later — keep Infinity for desktop wifi default.
pub fn getDownlinkMax(_: *const NetworkInformation) f64 {
    return std.math.inf(f64);
}

pub fn addEventListener(_: *NetworkInformation, _: []const u8, _: js.Value) void {}
pub fn removeEventListener(_: *NetworkInformation, _: []const u8, _: js.Value) void {}

pub const JsApi = struct {
    pub const bridge = js.Bridge(NetworkInformation);

    pub const Meta = struct {
        pub const name = "NetworkInformation";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
        pub const empty_with_no_proto = true;
    };

    pub const effectiveType = bridge.accessor(NetworkInformation.getEffectiveType, null, .{});
    pub const downlink = bridge.accessor(NetworkInformation.getDownlink, null, .{});
    pub const downlinkMax = bridge.accessor(NetworkInformation.getDownlinkMax, null, .{});
    pub const rtt = bridge.accessor(NetworkInformation.getRtt, null, .{});
    pub const saveData = bridge.accessor(NetworkInformation.getSaveData, null, .{});
    // Spec/Chrome attribute is `type`, not `connectionType`.
    pub const @"type" = bridge.accessor(NetworkInformation.getType, null, .{});
    pub const addEventListener = bridge.function(NetworkInformation.addEventListener, .{});
    pub const removeEventListener = bridge.function(NetworkInformation.removeEventListener, .{});
};
