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

const js = @import("../js/js.zig");
const Frame = @import("../browser/Frame.zig");
const EventTarget = @import("EventTarget.zig");

pub fn registerTypes() []const type {
    return &.{
        Screen,
        Orientation,
    };
}

const Screen = @This();

_proto: *EventTarget,
_orientation: ?*Orientation = null,

pub fn asEventTarget(self: *Screen) *EventTarget {
    return self._proto;
}

pub fn getOrientation(self: *Screen, frame: *Frame) !*Orientation {
    if (self._orientation) |orientation| {
        return orientation;
    }
    const orientation = try Orientation.init(frame);
    self._orientation = orientation;
    return orientation;
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(Screen);

    pub const Meta = struct {
        pub const name = "Screen";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub fn getWidth(_: *const Screen, frame: *Frame) u32 {
        return frame.identityProfile().screen.width;
    }

    pub fn getHeight(_: *const Screen, frame: *Frame) u32 {
        return frame.identityProfile().screen.height;
    }

    pub fn getAvailWidth(_: *const Screen, frame: *Frame) u32 {
        return frame.identityProfile().screen.avail_width;
    }

    pub fn getAvailHeight(_: *const Screen, frame: *Frame) u32 {
        return frame.identityProfile().screen.avail_height;
    }

    pub fn getColorDepth(_: *const Screen, frame: *Frame) u32 {
        return frame.identityProfile().screen.color_depth;
    }

    pub fn getPixelDepth(_: *const Screen, frame: *Frame) u32 {
        return frame.identityProfile().screen.pixel_depth;
    }

    pub const width = bridge.accessor(getWidth, null, .{});
    pub const height = bridge.accessor(getHeight, null, .{});
    pub const availWidth = bridge.accessor(getAvailWidth, null, .{});
    pub const availHeight = bridge.accessor(getAvailHeight, null, .{});
    pub const colorDepth = bridge.accessor(getColorDepth, null, .{});
    pub const pixelDepth = bridge.accessor(getPixelDepth, null, .{});
    pub const orientation = bridge.accessor(Screen.getOrientation, null, .{});
};

pub const Orientation = struct {
    _proto: *EventTarget,

    pub fn init(frame: *Frame) !*Orientation {
        return frame._factory.eventTarget(Orientation{
            ._proto = undefined,
        });
    }

    pub fn asEventTarget(self: *Orientation) *EventTarget {
        return self._proto;
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(Orientation);

        pub const Meta = struct {
            pub const name = "ScreenOrientation";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };

        pub const angle = bridge.property(0, .{ .template = false });
        pub const @"type" = bridge.property("landscape-primary", .{ .template = false });
    };
};
