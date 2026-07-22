const std = @import("std");
const js = @import("../../js/js.zig");
const Frame = @import("../../browser/Frame.zig");
const Page = @import("../../browser/Page.zig");
const Execution = js.Execution;
const EventTarget = @import("../EventTarget.zig");

const MediaSource = @This();

_proto: *EventTarget,
_ready_state: u16 = 0, // 0=closed, 1=open, 2=ended
_duration: f64 = std.math.nan(f64),
_source_buffers: std.ArrayListUnmanaged(*SourceBuffer) = .empty,
_arena: std.mem.Allocator,

const SourceBuffer = @import("SourceBuffer.zig");

pub fn init(exec: *js.Execution) !*MediaSource {
    const arena = try exec.getArena(.tiny, "MediaSource");
    errdefer exec.releaseArena(arena);
    return exec._factory.eventTargetWithAllocator(arena, MediaSource{
        ._proto = undefined,
        ._arena = arena,
    });
}

pub fn asEventTarget(self: *MediaSource) *EventTarget {
    return self._proto;
}

pub fn getReadyState(self: *const MediaSource) u16 {
    return self._ready_state;
}

pub fn getDuration(self: *const MediaSource) f64 {
    return self._duration;
}

pub fn getSourceBuffers(self: *MediaSource, frame: *Frame) !js.Array {
    const local = frame.js.local orelse return error.NotHandled;
    const arr = local.newArray(@intCast(self._source_buffers.items.len));
    for (self._source_buffers.items, 0..) |sb, i| {
        _ = try arr.set(@intCast(i), sb, .{});
    }
    return arr;
}

pub fn getActiveSourceBuffers(_: *MediaSource, frame: *Frame) !js.Array {
    const local = frame.js.local orelse return error.NotHandled;
    const arr = local.newArray(0);
    return arr;
}

pub fn addSourceBuffer(self: *MediaSource, mime_type: []const u8, frame: *Frame) !*SourceBuffer {
    const sb = try frame._factory.eventTargetWithAllocator(self._arena, SourceBuffer{
        ._proto = undefined,
        ._mime_type = try self._arena.dupe(u8, mime_type),
    });
    try self._source_buffers.append(self._arena, sb);
    return sb;
}

pub fn removeSourceBuffer(self: *MediaSource, sb: *SourceBuffer) void {
    for (self._source_buffers.items, 0..) |item, i| {
        if (item == sb) {
            _ = self._source_buffers.orderedRemove(i);
            break;
        }
    }
}

pub fn endOfStream(self: *MediaSource, _: ?[]const u8) void {
    self._ready_state = 2;
}

pub fn isTypeSupported(mime_type: []const u8) bool {
    const pos = std.mem.indexOfScalar(u8, mime_type, ';') orelse mime_type.len;
    const base = std.mem.trim(u8, mime_type[0..pos], &std.ascii.whitespace);

    if (std.ascii.eqlIgnoreCase(base, "video/webm")) return true;
    if (std.ascii.eqlIgnoreCase(base, "video/mp4")) return true;
    if (std.ascii.eqlIgnoreCase(base, "audio/webm")) return true;
    if (std.ascii.eqlIgnoreCase(base, "audio/mp4")) return true;
    if (std.ascii.eqlIgnoreCase(base, "audio/mpeg")) return true;
    if (std.ascii.eqlIgnoreCase(base, "audio/aac")) return true;
    return false;
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(MediaSource);

    pub const Meta = struct {
        pub const name = "MediaSource";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
        pub const enumerable = false;
    };

    pub const Prototype = EventTarget;

    pub const constructor = bridge.constructor(MediaSource.init, .{});
    pub const readyState = bridge.accessor(MediaSource.getReadyState, null, .{});
    pub const duration = bridge.accessor(MediaSource.getDuration, null, .{});
    pub const sourceBuffers = bridge.accessor(MediaSource.getSourceBuffers, null, .{});
    pub const activeSourceBuffers = bridge.accessor(MediaSource.getActiveSourceBuffers, null, .{});
    pub const addSourceBuffer = bridge.function(MediaSource.addSourceBuffer, .{});
    pub const removeSourceBuffer = bridge.function(MediaSource.removeSourceBuffer, .{});
    pub const endOfStream = bridge.function(MediaSource.endOfStream, .{});
    pub const isTypeSupported = bridge.function(MediaSource.isTypeSupported, .{ .static = true });
};
