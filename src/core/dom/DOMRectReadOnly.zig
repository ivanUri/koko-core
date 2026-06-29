// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

const DOMRectReadOnly = @This();

const js = @import("../js/js.zig");
const Frame = @import("../browser/Frame.zig");
const DOMRect = @import("DOMRect.zig");

_x: f64,
_y: f64,
_width: f64,
_height: f64,
/// SVGRect / getBBox surfaces keep full f64 (CreepJS sums raw getter values).
_skip_quantize: bool = false,

pub fn init(x: f64, y: f64, width: f64, height: f64, frame: *Frame) !*DOMRectReadOnly {
    return frame._factory.create(DOMRectReadOnly{
        ._x = x,
        ._y = y,
        ._width = width,
        ._height = height,
    });
}

pub fn fromDomRect(rect: DOMRect, frame: *Frame) !*DOMRectReadOnly {
    return init(rect._x, rect._y, rect._width, rect._height, frame);
}

pub fn getX(self: *const DOMRectReadOnly) f64 {
    if (self._skip_quantize) return self._x;
    return self.getLeft();
}

pub fn getY(self: *const DOMRectReadOnly) f64 {
    if (self._skip_quantize) return self._y;
    return self.getTop();
}

pub fn getWidth(self: *const DOMRectReadOnly) f64 {
    if (self._skip_quantize) return self._width;
    return DOMRect.quantizeCoord(self._width);
}

pub fn getHeight(self: *const DOMRectReadOnly) f64 {
    if (self._skip_quantize) return self._height;
    return DOMRect.quantizeCoord(self._height);
}

pub fn getTop(self: *const DOMRectReadOnly) f64 {
    if (self._skip_quantize) {
        if (self._height < 0) return self._y + self._height;
        return self._y;
    }
    if (self._height < 0) return DOMRect.quantizeCoord(self._y + self._height);
    return DOMRect.quantizeCoord(self._y);
}

pub fn getLeft(self: *const DOMRectReadOnly) f64 {
    if (self._skip_quantize) {
        if (self._width < 0) return self._x + self._width;
        return self._x;
    }
    if (self._width < 0) return DOMRect.quantizeCoord(self._x + self._width);
    return DOMRect.quantizeCoord(self._x);
}

pub fn getRight(self: *const DOMRectReadOnly) f64 {
    return self.getLeft() + self.getWidth();
}

pub fn getBottom(self: *const DOMRectReadOnly) f64 {
    return self.getTop() + self.getHeight();
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(DOMRectReadOnly);

    pub const Meta = struct {
        pub const name = "DOMRectReadOnly";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const constructor = bridge.constructor(DOMRectReadOnly.init, .{});
    pub const x = bridge.accessor(DOMRectReadOnly.getX, null, .{});
    pub const y = bridge.accessor(DOMRectReadOnly.getY, null, .{});
    pub const width = bridge.accessor(DOMRectReadOnly.getWidth, null, .{});
    pub const height = bridge.accessor(DOMRectReadOnly.getHeight, null, .{});
    pub const top = bridge.accessor(DOMRectReadOnly.getTop, null, .{});
    pub const right = bridge.accessor(DOMRectReadOnly.getRight, null, .{});
    pub const bottom = bridge.accessor(DOMRectReadOnly.getBottom, null, .{});
    pub const left = bridge.accessor(DOMRectReadOnly.getLeft, null, .{});
    pub const toJSON = bridge.function(DOMRectReadOnly.toJSON, .{});
};

pub fn toJSON(self: *const DOMRectReadOnly) struct {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    top: f64,
    right: f64,
    bottom: f64,
    left: f64,
} {
    return .{
        .x = self.getX(),
        .y = self.getY(),
        .width = self.getWidth(),
        .height = self.getHeight(),
        .top = self.getTop(),
        .right = self.getRight(),
        .bottom = self.getBottom(),
        .left = self.getLeft(),
    };
}
