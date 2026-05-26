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

const js = @import("../../js/js.zig");
const Frame = @import("../../browser/Frame.zig");

/// TextMetrics is the result of `CanvasRenderingContext2D.measureText`.
/// https://html.spec.whatwg.org/multipage/canvas.html#textmetrics
///
/// Velora is headless and has no font system, so all measurements are
/// returned as 0.0. This is the deterministic "no font available" answer:
/// callers see a real TextMetrics object with all spec-defined attributes,
/// rather than a missing method that would crash anything calling it.
const TextMetrics = @This();

_width: f64 = 0.0,

pub fn init(frame: *Frame) !*TextMetrics {
    return frame._factory.create(TextMetrics{});
}

pub fn getWidth(self: *const TextMetrics) f64 {
    return self._width;
}

fn zero(_: *const TextMetrics) f64 {
    return 0.0;
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(TextMetrics);

    pub const Meta = struct {
        pub const name = "TextMetrics";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const width = bridge.accessor(TextMetrics.getWidth, null, .{});
    pub const actualBoundingBoxLeft = bridge.accessor(TextMetrics.zero, null, .{});
    pub const actualBoundingBoxRight = bridge.accessor(TextMetrics.zero, null, .{});
    pub const actualBoundingBoxAscent = bridge.accessor(TextMetrics.zero, null, .{});
    pub const actualBoundingBoxDescent = bridge.accessor(TextMetrics.zero, null, .{});
    pub const fontBoundingBoxAscent = bridge.accessor(TextMetrics.zero, null, .{});
    pub const fontBoundingBoxDescent = bridge.accessor(TextMetrics.zero, null, .{});
    pub const emHeightAscent = bridge.accessor(TextMetrics.zero, null, .{});
    pub const emHeightDescent = bridge.accessor(TextMetrics.zero, null, .{});
    pub const hangingBaseline = bridge.accessor(TextMetrics.zero, null, .{});
    pub const alphabeticBaseline = bridge.accessor(TextMetrics.zero, null, .{});
    pub const ideographicBaseline = bridge.accessor(TextMetrics.zero, null, .{});
};
