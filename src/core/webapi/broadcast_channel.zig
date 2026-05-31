// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

const js = @import("../js/js.zig");
const Frame = @import("../browser/Frame.zig");
const EventTarget = @import("EventTarget.zig");

pub fn registerTypes() []const type {
    return &.{BroadcastChannel};
}

pub const BroadcastChannel = struct {
    _proto: *EventTarget,
    _name: []const u8,
    _closed: bool = false,
    _on_message: ?js.Function.Global = null,

    pub fn constructor(name: []const u8, frame: *Frame) !*BroadcastChannel {
        return frame._factory.eventTarget(BroadcastChannel{
            ._proto = undefined,
            ._name = try frame.dupeString(name),
        });
    }

    pub fn asEventTarget(self: *BroadcastChannel) *EventTarget {
        return self._proto;
    }

    pub fn getName(self: *const BroadcastChannel) []const u8 {
        return self._name;
    }

    pub fn postMessage(self: *BroadcastChannel, _: js.Value.Temp) void {
        if (self._closed) return;
    }

    pub fn close(self: *BroadcastChannel) void {
        self._closed = true;
    }

    pub fn getOnMessage(self: *const BroadcastChannel) ?js.Function.Global {
        return self._on_message;
    }

    pub fn setOnMessage(self: *BroadcastChannel, cb: ?js.Function.Global) void {
        self._on_message = cb;
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(BroadcastChannel);
        pub const Meta = struct {
            pub const name = "BroadcastChannel";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const constructor = bridge.constructor(BroadcastChannel.constructor, .{});
        pub const name = bridge.accessor(BroadcastChannel.getName, null, .{});
        pub const postMessage = bridge.function(BroadcastChannel.postMessage, .{});
        pub const close = bridge.function(BroadcastChannel.close, .{});
        pub const onmessage = bridge.accessor(BroadcastChannel.getOnMessage, BroadcastChannel.setOnMessage, .{});
    };
};
