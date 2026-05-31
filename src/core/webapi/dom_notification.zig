// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

const js = @import("../js/js.zig");
const Frame = @import("../browser/Frame.zig");
const EventTarget = @import("EventTarget.zig");

pub fn registerTypes() []const type {
    return &.{DomNotification};
}

pub const DomNotification = struct {
    _proto: *EventTarget,
    _title: []const u8,
    _body: []const u8 = "",

    pub fn constructor(title: []const u8, frame: *Frame) !*DomNotification {
        return frame._factory.eventTarget(DomNotification{
            ._proto = undefined,
            ._title = title,
        });
    }

    pub fn permission(frame: *Frame) []const u8 {
        _ = frame;
        return "default";
    }

    pub fn requestPermission(_: ?js.Value, frame: *Frame) !js.Promise {
        const local = frame.js.local orelse return error.NotHandled;
        return local.resolvePromise("default");
    }

    pub fn getTitle(self: *const DomNotification) []const u8 {
        return self._title;
    }

    pub fn getBody(self: *const DomNotification) []const u8 {
        return self._body;
    }

    pub fn close(self: *DomNotification) void {
        _ = self;
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(DomNotification);
        pub const Meta = struct {
            pub const name = "Notification";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const constructor = bridge.constructor(DomNotification.constructor, .{});
        pub const permission = bridge.function(struct {
            fn f(_: *DomNotification, frame: *Frame) []const u8 {
                return DomNotification.permission(frame);
            }
        }.f, .{ .static = true });
        pub const requestPermission = bridge.function(struct {
            fn f(_: *DomNotification, opts: ?js.Value, frame: *Frame) !js.Promise {
                return DomNotification.requestPermission(opts, frame);
            }
        }.f, .{ .static = true });
        pub const title = bridge.accessor(DomNotification.getTitle, null, .{});
        pub const body = bridge.accessor(DomNotification.getBody, null, .{});
        pub const close = bridge.function(DomNotification.close, .{});
    };
};
