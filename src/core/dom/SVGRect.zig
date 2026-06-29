// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

const SVGRect = @This();

const js = @import("../js/js.zig");
const Frame = @import("../browser/Frame.zig");
const DOMRectReadOnly = @import("DOMRectReadOnly.zig");

_proto: *DOMRectReadOnly,

pub fn init(x: f64, y: f64, width: f64, height: f64, frame: *Frame) !*SVGRect {
    return frame._factory.svgRect(x, y, width, height);
}

pub fn getX(self: *const SVGRect) f64 {
    return self._proto.getX();
}

pub fn getY(self: *const SVGRect) f64 {
    return self._proto.getY();
}

pub fn getWidth(self: *const SVGRect) f64 {
    return self._proto.getWidth();
}

pub fn getHeight(self: *const SVGRect) f64 {
    return self._proto.getHeight();
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(SVGRect);

    pub const Meta = struct {
        pub const name = "SVGRect";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    // Chrome SVGRect.prototype only exposes x/y/width/height. CreepJS
    // reduceToObject reads Object.keys(instance.__proto__); extra DOMRect
    // edge getters on this prototype double-count geometry sums.
    pub const x = bridge.accessor(SVGRect.getX, null, .{});
    pub const y = bridge.accessor(SVGRect.getY, null, .{});
    pub const width = bridge.accessor(SVGRect.getWidth, null, .{});
    pub const height = bridge.accessor(SVGRect.getHeight, null, .{});
};
