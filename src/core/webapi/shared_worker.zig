// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

const js = @import("../js/js.zig");
const Frame = @import("../browser/Frame.zig");
const EventTarget = @import("EventTarget.zig");

pub fn registerTypes() []const type {
    return &.{SharedWorker};
}

pub const SharedWorker = struct {
    _proto: *EventTarget,
    _port: ?*@import("MessagePort.zig") = null,

    pub fn constructor(url: []const u8, _: ?[]const u8, frame: *Frame) !*SharedWorker {
        _ = url;
        return frame._factory.eventTarget(SharedWorker{
            ._proto = undefined,
        });
    }

    pub fn getPort(self: *SharedWorker, frame: *Frame) !*@import("MessagePort.zig") {
        if (self._port) |p| return p;
        const p = try @import("MessagePort.zig").init(frame);
        self._port = p;
        return p;
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(SharedWorker);
        pub const Meta = struct {
            pub const name = "SharedWorker";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const constructor = bridge.constructor(SharedWorker.constructor, .{});
        pub const port = bridge.accessor(SharedWorker.getPort, null, .{});
    };
};
