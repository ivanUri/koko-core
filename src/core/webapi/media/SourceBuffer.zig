const std = @import("std");
const js = @import("../../js/js.zig");
const EventTarget = @import("../EventTarget.zig");

const SourceBuffer = @This();

_proto: *EventTarget,
_mime_type: []const u8 = "",
_updating: bool = false,
_buffered: f64 = 0,
_timestamp_offset: f64 = 0,
_append_window_start: f64 = 0,
_append_window_end: f64 = std.math.inf(f64),

pub fn getUpdating(self: *const SourceBuffer) bool {
    return self._updating;
}

pub fn getBuffered(self: *const SourceBuffer) f64 {
    return self._buffered;
}

pub fn getTimestampOffset(self: *const SourceBuffer) f64 {
    return self._timestamp_offset;
}

pub fn setTimestampOffset(self: *SourceBuffer, value: f64) void {
    self._timestamp_offset = value;
}

pub fn getAppendWindowStart(self: *const SourceBuffer) f64 {
    return self._append_window_start;
}

pub fn setAppendWindowStart(self: *SourceBuffer, value: f64) void {
    self._append_window_start = value;
}

pub fn getAppendWindowEnd(self: *const SourceBuffer) f64 {
    return self._append_window_end;
}

pub fn setAppendWindowEnd(self: *SourceBuffer, value: f64) void {
    self._append_window_end = value;
}

pub fn appendBuffer(_: *SourceBuffer, _: js.Value) void {}

pub fn abort(_: *SourceBuffer) void {}

pub fn remove(_: *SourceBuffer, _: f64, _: f64) void {}

pub const JsApi = struct {
    pub const bridge = js.Bridge(SourceBuffer);

    pub const Meta = struct {
        pub const name = "SourceBuffer";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
        pub const enumerable = false;
    };

    pub const Prototype = EventTarget;

    pub const updating = bridge.accessor(SourceBuffer.getUpdating, null, .{});
    pub const buffered = bridge.accessor(SourceBuffer.getBuffered, null, .{});
    pub const timestampOffset = bridge.accessor(SourceBuffer.getTimestampOffset, SourceBuffer.setTimestampOffset, .{});
    pub const appendWindowStart = bridge.accessor(SourceBuffer.getAppendWindowStart, SourceBuffer.setAppendWindowStart, .{});
    pub const appendWindowEnd = bridge.accessor(SourceBuffer.getAppendWindowEnd, SourceBuffer.setAppendWindowEnd, .{});
    pub const appendBuffer = bridge.function(SourceBuffer.appendBuffer, .{});
    pub const abort = bridge.function(SourceBuffer.abort, .{});
    pub const remove = bridge.function(SourceBuffer.remove, .{});
};
pub fn asEventTarget(self: *SourceBuffer) *EventTarget {
    return self._proto;
}
