const std = @import("std");
const js = @import("../js/js.zig");
const Frame = @import("../browser/Frame.zig");

const MediaCapabilities = @This();

pub fn decodingInfo(_: *MediaCapabilities, _: js.Value, frame: *Frame) !js.Promise {
    const local = frame.js.local orelse return error.NotHandled;
    const result = local.newObject();
    _ = try result.set("supported", true, .{});
    _ = try result.set("smooth", true, .{});
    _ = try result.set("powerEfficient", true, .{});
    return local.resolvePromise(result);
}

pub fn encodingInfo(_: *MediaCapabilities, _: js.Value, frame: *Frame) !js.Promise {
    const local = frame.js.local orelse return error.NotHandled;
    const result = local.newObject();
    _ = try result.set("supported", false, .{});
    return local.resolvePromise(result);
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(MediaCapabilities);

    pub const Meta = struct {
        pub const name = "MediaCapabilities";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
        pub const empty_with_no_proto = true;
    };

    pub const decodingInfo = bridge.function(MediaCapabilities.decodingInfo, .{});
    pub const encodingInfo = bridge.function(MediaCapabilities.encodingInfo, .{});
};
