// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

const std = @import("std");

const js = @import("../../js/js.zig");
const Frame = @import("../../browser/Frame.zig");

const Event = @import("../Event.zig");
const UIEvent = @import("UIEvent.zig");
const TouchList = @import("TouchList.zig");

const String = @import("../../../support/string.zig").String;
const Allocator = std.mem.Allocator;

const TouchEvent = @This();

_proto: *UIEvent,
_touches: *TouchList,
_target_touches: *TouchList,
_changed_touches: *TouchList,
_alt_key: bool = false,
_meta_key: bool = false,
_ctrl_key: bool = false,
_shift_key: bool = false,

pub const TouchEventOptions = struct {
    touches: ?*TouchList = null,
    targetTouches: ?*TouchList = null,
    changedTouches: ?*TouchList = null,
    altKey: bool = false,
    metaKey: bool = false,
    ctrlKey: bool = false,
    shiftKey: bool = false,
};

pub const Options = Event.inheritOptions(
    TouchEvent,
    TouchEventOptions,
);

pub fn init(typ: []const u8, _opts: ?Options, frame: *Frame) !*TouchEvent {
    const arena = try frame.getArena(.tiny, "TouchEvent");
    errdefer frame.releaseArena(arena);
    const type_string = try String.init(arena, typ, .{});
    return initWithTrusted(arena, type_string, _opts, false, frame);
}

fn initWithTrusted(arena: Allocator, typ: String, _opts: ?Options, trusted: bool, frame: *Frame) !*TouchEvent {
    const opts = _opts orelse Options{};
    const empty_touches = try TouchList.init(frame);
    const event = try frame._factory.uiEvent(
        arena,
        typ,
        TouchEvent{
            ._proto = undefined,
            ._touches = opts.touches orelse empty_touches,
            ._target_touches = opts.targetTouches orelse empty_touches,
            ._changed_touches = opts.changedTouches orelse empty_touches,
            ._alt_key = opts.altKey,
            ._meta_key = opts.metaKey,
            ._ctrl_key = opts.ctrlKey,
            ._shift_key = opts.shiftKey,
        },
    );

    Event.populatePrototypes(event, opts, trusted);
    return event;
}

pub fn asEvent(self: *TouchEvent) *Event {
    return self._proto.asEvent();
}

pub fn getTouches(self: *TouchEvent) *TouchList {
    return self._touches;
}

pub fn getTargetTouches(self: *TouchEvent) *TouchList {
    return self._target_touches;
}

pub fn getChangedTouches(self: *TouchEvent) *TouchList {
    return self._changed_touches;
}

pub fn getAltKey(self: *const TouchEvent) bool {
    return self._alt_key;
}

pub fn getMetaKey(self: *const TouchEvent) bool {
    return self._meta_key;
}

pub fn getCtrlKey(self: *const TouchEvent) bool {
    return self._ctrl_key;
}

pub fn getShiftKey(self: *const TouchEvent) bool {
    return self._shift_key;
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(TouchEvent);

    pub const Meta = struct {
        pub const name = "TouchEvent";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const constructor = bridge.constructor(TouchEvent.init, .{});
    pub const touches = bridge.accessor(TouchEvent.getTouches, null, .{});
    pub const targetTouches = bridge.accessor(TouchEvent.getTargetTouches, null, .{});
    pub const changedTouches = bridge.accessor(TouchEvent.getChangedTouches, null, .{});
    pub const altKey = bridge.accessor(TouchEvent.getAltKey, null, .{});
    pub const metaKey = bridge.accessor(TouchEvent.getMetaKey, null, .{});
    pub const ctrlKey = bridge.accessor(TouchEvent.getCtrlKey, null, .{});
    pub const shiftKey = bridge.accessor(TouchEvent.getShiftKey, null, .{});
};
