const std = @import("std");

const Frame = @import("../../browser/Frame.zig");
const Event = @import("../Event.zig");
const AudioBuffer = @import("../audio/audio.zig").AudioBuffer;

const String = @import("../../../support/string.zig").String;
const Allocator = std.mem.Allocator;

const OfflineAudioCompletionEvent = @This();
_proto: *Event,
_rendered_buffer: *AudioBuffer,

pub fn initTrusted(rendered_buffer: *AudioBuffer, frame: *Frame) !*OfflineAudioCompletionEvent {
    return initTrustedOnArena(rendered_buffer, frame);
}

pub fn initTrustedOnArena(rendered_buffer: *AudioBuffer, frame: *Frame) !*OfflineAudioCompletionEvent {
    const typ = String.wrap("complete");

    const event = try frame._factory.event(
        frame.arena,
        typ,
        OfflineAudioCompletionEvent{
            ._proto = undefined,
            ._rendered_buffer = rendered_buffer,
        },
    );

    Event.populatePrototypes(event, .{ .bubbles = false, .cancelable = false, .composed = false }, true);
    return event;
}

pub fn asEvent(self: *OfflineAudioCompletionEvent) *Event {
    return self._proto;
}

pub fn getRenderedBuffer(self: *const OfflineAudioCompletionEvent) *AudioBuffer {
    return self._rendered_buffer;
}

pub const JsApi = struct {
    const js = @import("../../js/js.zig");
    pub const bridge = js.Bridge(OfflineAudioCompletionEvent);

    pub const Meta = struct {
        pub const name = "OfflineAudioCompletionEvent";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const renderedBuffer = bridge.accessor(OfflineAudioCompletionEvent.getRenderedBuffer, null, .{});
};
