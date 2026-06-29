const std = @import("std");
const js = @import("../js/js.zig");

const NetworkInformation = @This();

// NetworkInformation stub for navigator.connection
// https://wicg.github.io/netinfo/

pub fn getEffectiveType(_: *const NetworkInformation) []const u8 {
    return "4g";
}

pub fn getDownlink(_: *const NetworkInformation) f64 {
    return @import("../../runtime/profile/HttpProfile.zig").in_session_downlink;
}

pub fn getRtt(_: *const NetworkInformation) f64 {
    return @floatFromInt(@import("../../runtime/profile/HttpProfile.zig").in_session_rtt);
}

pub fn getSaveData(_: *const NetworkInformation) bool {
    return false;
}

pub fn getConnectionType(_: *const NetworkInformation) []const u8 {
    return "wifi";
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
    pub const rtt = bridge.accessor(NetworkInformation.getRtt, null, .{});
    pub const saveData = bridge.accessor(NetworkInformation.getSaveData, null, .{});
    pub const connectionType = bridge.accessor(NetworkInformation.getConnectionType, null, .{});
    pub const addEventListener = bridge.function(NetworkInformation.addEventListener, .{});
    pub const removeEventListener = bridge.function(NetworkInformation.removeEventListener, .{});
};
