const std = @import("std");
const js = @import("../../js/js.zig");
const Frame = @import("../../browser/Frame.zig");

const MediaRecorder = @This();

_state: State = .inactive,
_mime_type: []const u8 = "",

const State = enum(u8) {
    inactive = 0,
    recording = 1,
    paused = 2,
};

pub fn init(exec: *js.Execution) !*MediaRecorder {
    const arena = try exec.getArena(.tiny, "MediaRecorder");
    const self = arena.create(MediaRecorder) catch unreachable;
    self.* = .{};
    return self;
}

pub fn isTypeSupported(mime_type: []const u8) bool {
    const pos = std.mem.indexOfScalar(u8, mime_type, ';') orelse mime_type.len;
    const base = std.mem.trim(u8, mime_type[0..pos], &std.ascii.whitespace);

    if (std.ascii.eqlIgnoreCase(base, "video/webm")) return true;
    if (std.ascii.eqlIgnoreCase(base, "video/mp4")) return true;
    if (std.ascii.eqlIgnoreCase(base, "video/x-matroska")) return true;
    return false;
}

pub fn getState(self: *const MediaRecorder) []const u8 {
    return switch (self._state) {
        .inactive => "inactive",
        .recording => "recording",
        .paused => "paused",
    };
}

pub fn getMimeType(self: *const MediaRecorder) []const u8 {
    return self._mime_type;
}

pub fn start(_: *MediaRecorder, _: ?u32) void {}
pub fn stop(_: *MediaRecorder) void {}
pub fn pause(_: *MediaRecorder) void {}
pub fn resumeRecording(_: *MediaRecorder) void {}
pub fn requestData(_: *MediaRecorder) void {}

pub const JsApi = struct {
    pub const bridge = js.Bridge(MediaRecorder);

    pub const Meta = struct {
        pub const name = "MediaRecorder";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const constructor = bridge.constructor(MediaRecorder.init, .{});
    pub const isTypeSupported = bridge.function(MediaRecorder.isTypeSupported, .{ .static = true });
    pub const state = bridge.accessor(MediaRecorder.getState, null, .{});
    pub const mimeType = bridge.accessor(MediaRecorder.getMimeType, null, .{});
    pub const start = bridge.function(MediaRecorder.start, .{});
    pub const stop = bridge.function(MediaRecorder.stop, .{});
    pub const pause = bridge.function(MediaRecorder.pause, .{});
    pub const @"resume" = bridge.function(MediaRecorder.resumeRecording, .{});
    pub const requestData = bridge.function(MediaRecorder.requestData, .{});
};
