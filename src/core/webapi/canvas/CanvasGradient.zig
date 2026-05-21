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

const color = @import("../../browser/color.zig");
const Frame = @import("../../browser/Frame.zig");

/// CanvasGradient represents an opaque object describing a gradient.
/// It is returned by the `createLinearGradient()`, `createRadialGradient()`,
/// and `createConicGradient()` methods of `CanvasRenderingContext2D` (and the
/// equivalent offscreen context).
///
/// https://html.spec.whatwg.org/multipage/canvas.html#canvasgradient
///
/// Velora is headless: gradients are not rasterized, but the class still
/// holds the stops so it round-trips correctly and any spec-mandated
/// validation (offset/color parsing) is performed. The geometry kind/coords
/// are kept so future rendering work can consume them without changing the
/// public shape.
const CanvasGradient = @This();

pub const Kind = union(enum) {
    linear: Linear,
    radial: Radial,
    conic: Conic,

    pub const Linear = struct {
        x0: f64,
        y0: f64,
        x1: f64,
        y1: f64,
    };

    pub const Radial = struct {
        x0: f64,
        y0: f64,
        r0: f64,
        x1: f64,
        y1: f64,
        r1: f64,
    };

    pub const Conic = struct {
        start_angle: f64,
        x: f64,
        y: f64,
    };
};

pub const ColorStop = struct {
    offset: f64,
    color: color.RGBA,
};

_arena: std.mem.Allocator,
_kind: Kind,
_stops: std.ArrayListUnmanaged(ColorStop) = .empty,

pub fn createLinear(x0: f64, y0: f64, x1: f64, y1: f64, frame: *Frame) !*CanvasGradient {
    return create(.{ .linear = .{ .x0 = x0, .y0 = y0, .x1 = x1, .y1 = y1 } }, frame);
}

pub fn createRadial(x0: f64, y0: f64, r0: f64, x1: f64, y1: f64, r1: f64, frame: *Frame) !*CanvasGradient {
    if (r0 < 0 or r1 < 0) return error.DOMException;
    return create(.{ .radial = .{ .x0 = x0, .y0 = y0, .r0 = r0, .x1 = x1, .y1 = y1, .r1 = r1 } }, frame);
}

pub fn createConic(start_angle: f64, x: f64, y: f64, frame: *Frame) !*CanvasGradient {
    return create(.{ .conic = .{ .start_angle = start_angle, .x = x, .y = y } }, frame);
}

fn create(kind: Kind, frame: *Frame) !*CanvasGradient {
    const arena = try frame.getArena(.tiny, "CanvasGradient");
    errdefer frame.releaseArena(arena);

    return frame._factory.create(CanvasGradient{
        ._arena = arena,
        ._kind = kind,
    });
}

/// https://html.spec.whatwg.org/multipage/canvas.html#dom-canvasgradient-addcolorstop
///
/// Throws IndexSizeError if `offset` is outside [0, 1], and SyntaxError if
/// `color_str` cannot be parsed as a CSS color. Stops are stored in insertion
/// order (the spec allows duplicates and does not require sorting at
/// insertion time).
pub fn addColorStop(self: *CanvasGradient, offset: f64, color_str: []const u8) !void {
    if (!std.math.isFinite(offset) or offset < 0.0 or offset > 1.0) {
        return error.IndexSizeError;
    }
    const parsed = color.RGBA.parse(color_str) catch return error.SyntaxError;
    try self._stops.append(self._arena, .{ .offset = offset, .color = parsed });
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(CanvasGradient);

    pub const Meta = struct {
        pub const name = "CanvasGradient";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const addColorStop = bridge.function(CanvasGradient.addColorStop, .{ .dom_exception = true });
};
