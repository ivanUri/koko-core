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

const DOMRect = @This();

const std = @import("std");
const js = @import("../js/js.zig");
const Frame = @import("../browser/Frame.zig");

_x: f64,
_y: f64,
_width: f64,
_height: f64,
/// CreepJS emoji pattern sum uses layout f64, not f32-quantized dims.
_emoji_dims: bool = false,

/// Match Chrome DOMRect float32 serialization (CreepJS strict math checks).
pub fn quantizeCoord(v: f64) f64 {
    return @floatCast(@as(f32, @floatCast(v)));
}

pub fn init(x: f64, y: f64, width: f64, height: f64, frame: *Frame) !*DOMRect {
    return frame._factory.create(DOMRect{
        ._x = x,
        ._y = y,
        ._width = width,
        ._height = height,
    });
}

pub fn getX(self: *const DOMRect) f64 {
    return self.getLeft();
}

pub fn getY(self: *const DOMRect) f64 {
    return self.getTop();
}

pub fn getWidth(self: *const DOMRect) f64 {
    if (self._emoji_dims) return self._width;
    return quantizeCoord(self._width);
}

pub fn getHeight(self: *const DOMRect) f64 {
    if (self._emoji_dims) return self._height;
    return quantizeCoord(self._height);
}

pub fn getTop(self: *const DOMRect) f64 {
    if (self._height < 0) return quantizeCoord(self._y + self._height);
    return quantizeCoord(self._y);
}

pub fn getLeft(self: *const DOMRect) f64 {
    if (self._width < 0) return quantizeCoord(self._x + self._width);
    return quantizeCoord(self._x);
}

/// Derive right/bottom from left/top + width/height so CreepJS
/// `right - left == width` holds exactly in JS (no float drift).
pub fn getRight(self: *const DOMRect) f64 {
    return self.getLeft() + self.getWidth();
}

pub fn getBottom(self: *const DOMRect) f64 {
    return self.getTop() + self.getHeight();
}

pub fn snap(self: DOMRect) DOMRect {
    return .{
        ._x = quantizeCoord(self._x),
        ._y = quantizeCoord(self._y),
        ._width = quantizeCoord(self._width),
        ._height = quantizeCoord(self._height),
    };
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(DOMRect);

    pub const Meta = struct {
        pub const name = "DOMRect";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const constructor = bridge.constructor(DOMRect.init, .{});
    pub const x = bridge.accessor(DOMRect.getX, null, .{});
    pub const y = bridge.accessor(DOMRect.getY, null, .{});
    pub const width = bridge.accessor(DOMRect.getWidth, null, .{});
    pub const height = bridge.accessor(DOMRect.getHeight, null, .{});
    pub const top = bridge.accessor(DOMRect.getTop, null, .{});
    pub const right = bridge.accessor(DOMRect.getRight, null, .{});
    pub const bottom = bridge.accessor(DOMRect.getBottom, null, .{});
    pub const left = bridge.accessor(DOMRect.getLeft, null, .{});
};
