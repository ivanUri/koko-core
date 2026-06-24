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

const CanvasGradient = @import("CanvasGradient.zig");
const ImageData = @import("../ImageData.zig");
const TextMetrics = @import("TextMetrics.zig");

/// This class doesn't implement a `constructor`.
/// It can be obtained with a call to `OffscreenCanvas#getContext`.
/// https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvasRenderingContext2D
const OffscreenCanvasRenderingContext2D = @This();
/// Fill color.
/// TODO: Add support for `CanvasGradient` and `CanvasPattern`.
_fill_style: color.RGBA = color.RGBA.Named.black,
/// Current font (CSS font shorthand). See CanvasRenderingContext2D._font.
_font: []const u8 = "10px sans-serif",

pub fn getFillStyle(self: *const OffscreenCanvasRenderingContext2D, frame: *Frame) ![]const u8 {
    var w = std.Io.Writer.Allocating.init(frame.call_arena);
    try self._fill_style.format(&w.writer);
    return w.written();
}

pub fn setFillStyle(
    self: *OffscreenCanvasRenderingContext2D,
    value: []const u8,
) !void {
    // Prefer the same fill_style if fails.
    self._fill_style = color.RGBA.parse(value) catch self._fill_style;
}

pub fn getFont(self: *const OffscreenCanvasRenderingContext2D) []const u8 {
    return self._font;
}

pub fn setFont(self: *OffscreenCanvasRenderingContext2D, value: []const u8, frame: *Frame) !void {
    self._font = try frame.dupeString(value);
}

const WidthOrImageData = union(enum) {
    width: u32,
    image_data: *ImageData,
};

pub fn createImageData(
    _: *const OffscreenCanvasRenderingContext2D,
    width_or_image_data: WidthOrImageData,
    /// If `ImageData` variant preferred, this is null.
    maybe_height: ?u32,
    /// Can be used if width and height provided.
    maybe_settings: ?ImageData.ConstructorSettings,
    frame: *Frame,
) !*ImageData {
    switch (width_or_image_data) {
        .width => |width| {
            const height = maybe_height orelse return error.TypeError;
            return ImageData.init(width, height, maybe_settings, frame);
        },
        .image_data => |image_data| {
            return ImageData.init(image_data._width, image_data._height, null, frame);
        },
    }
}

pub fn putImageData(_: *const OffscreenCanvasRenderingContext2D, _: *ImageData, _: f64, _: f64, _: ?f64, _: ?f64, _: ?f64, _: ?f64) void {}

pub fn getImageData(
    _: *const OffscreenCanvasRenderingContext2D,
    _: i32, // sx
    _: i32, // sy
    sw: i32,
    sh: i32,
    frame: *Frame,
) !*ImageData {
    if (sw <= 0 or sh <= 0) {
        return error.IndexSizeError;
    }
    return ImageData.init(@intCast(sw), @intCast(sh), null, frame);
}

pub fn save(_: *OffscreenCanvasRenderingContext2D) void {}
pub fn restore(_: *OffscreenCanvasRenderingContext2D) void {}
pub fn scale(_: *OffscreenCanvasRenderingContext2D, _: f64, _: f64) void {}
pub fn rotate(_: *OffscreenCanvasRenderingContext2D, _: f64) void {}
pub fn translate(_: *OffscreenCanvasRenderingContext2D, _: f64, _: f64) void {}
pub fn transform(_: *OffscreenCanvasRenderingContext2D, _: f64, _: f64, _: f64, _: f64, _: f64, _: f64) void {}
pub fn setTransform(_: *OffscreenCanvasRenderingContext2D, _: f64, _: f64, _: f64, _: f64, _: f64, _: f64) void {}
pub fn resetTransform(_: *OffscreenCanvasRenderingContext2D) void {}
pub fn setStrokeStyle(_: *OffscreenCanvasRenderingContext2D, _: []const u8) void {}
pub fn clearRect(_: *OffscreenCanvasRenderingContext2D, _: f64, _: f64, _: f64, _: f64) void {}
pub fn fillRect(_: *OffscreenCanvasRenderingContext2D, _: f64, _: f64, _: f64, _: f64) void {}
pub fn strokeRect(_: *OffscreenCanvasRenderingContext2D, _: f64, _: f64, _: f64, _: f64) void {}
pub fn beginPath(_: *OffscreenCanvasRenderingContext2D) void {}
pub fn closePath(_: *OffscreenCanvasRenderingContext2D) void {}
pub fn moveTo(_: *OffscreenCanvasRenderingContext2D, _: f64, _: f64) void {}
pub fn lineTo(_: *OffscreenCanvasRenderingContext2D, _: f64, _: f64) void {}
pub fn quadraticCurveTo(_: *OffscreenCanvasRenderingContext2D, _: f64, _: f64, _: f64, _: f64) void {}
pub fn bezierCurveTo(_: *OffscreenCanvasRenderingContext2D, _: f64, _: f64, _: f64, _: f64, _: f64, _: f64) void {}
pub fn arc(_: *OffscreenCanvasRenderingContext2D, _: f64, _: f64, _: f64, _: f64, _: f64, _: ?bool) void {}
pub fn ellipse(
    _: *OffscreenCanvasRenderingContext2D,
    _: f64,
    _: f64,
    _: f64,
    _: f64,
    _: f64,
    _: f64,
    _: f64,
    _: ?bool,
) void {}
pub fn arcTo(_: *OffscreenCanvasRenderingContext2D, _: f64, _: f64, _: f64, _: f64, _: f64) void {}
pub fn rect(_: *OffscreenCanvasRenderingContext2D, _: f64, _: f64, _: f64, _: f64) void {}
pub fn fill(_: *OffscreenCanvasRenderingContext2D) void {}
pub fn stroke(_: *OffscreenCanvasRenderingContext2D) void {}
pub fn clip(_: *OffscreenCanvasRenderingContext2D) void {}
pub fn fillText(_: *OffscreenCanvasRenderingContext2D, _: []const u8, _: f64, _: f64, _: ?f64) void {}
pub fn strokeText(_: *OffscreenCanvasRenderingContext2D, _: []const u8, _: f64, _: f64, _: ?f64) void {}
pub fn measureText(self: *OffscreenCanvasRenderingContext2D, text: []const u8, frame: *Frame) !*TextMetrics {
    // Use heuristic measurement based on character counting and font size
    return TextMetrics.init(text, self._font, frame);
}

pub fn createLinearGradient(
    _: *OffscreenCanvasRenderingContext2D,
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
    frame: *Frame,
) !*CanvasGradient {
    return CanvasGradient.createLinear(x0, y0, x1, y1, frame);
}

pub fn createRadialGradient(
    _: *OffscreenCanvasRenderingContext2D,
    x0: f64,
    y0: f64,
    r0: f64,
    x1: f64,
    y1: f64,
    r1: f64,
    frame: *Frame,
) !*CanvasGradient {
    return CanvasGradient.createRadial(x0, y0, r0, x1, y1, r1, frame);
}

pub fn createConicGradient(
    _: *OffscreenCanvasRenderingContext2D,
    start_angle: f64,
    x: f64,
    y: f64,
    frame: *Frame,
) !*CanvasGradient {
    return CanvasGradient.createConic(start_angle, x, y, frame);
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(OffscreenCanvasRenderingContext2D);

    pub const Meta = struct {
        pub const name = "OffscreenCanvasRenderingContext2D";

        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const font = bridge.accessor(OffscreenCanvasRenderingContext2D.getFont, OffscreenCanvasRenderingContext2D.setFont, .{});
    pub const globalAlpha = bridge.property(1.0, .{ .template = false, .readonly = false });
    pub const globalCompositeOperation = bridge.property("source-over", .{ .template = false, .readonly = false });
    pub const strokeStyle = bridge.property("#000000", .{ .template = false, .readonly = false });
    pub const lineWidth = bridge.property(1.0, .{ .template = false, .readonly = false });
    pub const lineCap = bridge.property("butt", .{ .template = false, .readonly = false });
    pub const lineJoin = bridge.property("miter", .{ .template = false, .readonly = false });
    pub const miterLimit = bridge.property(10.0, .{ .template = false, .readonly = false });
    pub const textAlign = bridge.property("start", .{ .template = false, .readonly = false });
    pub const textBaseline = bridge.property("alphabetic", .{ .template = false, .readonly = false });

    pub const fillStyle = bridge.accessor(OffscreenCanvasRenderingContext2D.getFillStyle, OffscreenCanvasRenderingContext2D.setFillStyle, .{});
    pub const createImageData = bridge.function(OffscreenCanvasRenderingContext2D.createImageData, .{ .dom_exception = true });

    pub const putImageData = bridge.function(OffscreenCanvasRenderingContext2D.putImageData, .{ .noop = true });
    pub const getImageData = bridge.function(OffscreenCanvasRenderingContext2D.getImageData, .{ .dom_exception = true });
    pub const save = bridge.function(OffscreenCanvasRenderingContext2D.save, .{ .noop = true });
    pub const restore = bridge.function(OffscreenCanvasRenderingContext2D.restore, .{ .noop = true });
    pub const scale = bridge.function(OffscreenCanvasRenderingContext2D.scale, .{ .noop = true });
    pub const rotate = bridge.function(OffscreenCanvasRenderingContext2D.rotate, .{ .noop = true });
    pub const translate = bridge.function(OffscreenCanvasRenderingContext2D.translate, .{ .noop = true });
    pub const transform = bridge.function(OffscreenCanvasRenderingContext2D.transform, .{ .noop = true });
    pub const setTransform = bridge.function(OffscreenCanvasRenderingContext2D.setTransform, .{ .noop = true });
    pub const resetTransform = bridge.function(OffscreenCanvasRenderingContext2D.resetTransform, .{ .noop = true });
    pub const clearRect = bridge.function(OffscreenCanvasRenderingContext2D.clearRect, .{ .noop = true });
    pub const fillRect = bridge.function(OffscreenCanvasRenderingContext2D.fillRect, .{ .noop = true });
    pub const strokeRect = bridge.function(OffscreenCanvasRenderingContext2D.strokeRect, .{ .noop = true });
    pub const beginPath = bridge.function(OffscreenCanvasRenderingContext2D.beginPath, .{ .noop = true });
    pub const closePath = bridge.function(OffscreenCanvasRenderingContext2D.closePath, .{ .noop = true });
    pub const moveTo = bridge.function(OffscreenCanvasRenderingContext2D.moveTo, .{ .noop = true });
    pub const lineTo = bridge.function(OffscreenCanvasRenderingContext2D.lineTo, .{ .noop = true });
    pub const quadraticCurveTo = bridge.function(OffscreenCanvasRenderingContext2D.quadraticCurveTo, .{ .noop = true });
    pub const bezierCurveTo = bridge.function(OffscreenCanvasRenderingContext2D.bezierCurveTo, .{ .noop = true });
    pub const arc = bridge.function(OffscreenCanvasRenderingContext2D.arc, .{ .noop = true });
    pub const ellipse = bridge.function(OffscreenCanvasRenderingContext2D.ellipse, .{ .noop = true });
    pub const arcTo = bridge.function(OffscreenCanvasRenderingContext2D.arcTo, .{ .noop = true });
    pub const shadowBlur = bridge.property(0.0, .{ .template = false, .readonly = false });
    pub const shadowColor = bridge.property("rgba(0, 0, 0, 0)", .{ .template = false, .readonly = false });
    pub const rect = bridge.function(OffscreenCanvasRenderingContext2D.rect, .{ .noop = true });
    pub const fill = bridge.function(OffscreenCanvasRenderingContext2D.fill, .{ .noop = true });
    pub const stroke = bridge.function(OffscreenCanvasRenderingContext2D.stroke, .{ .noop = true });
    pub const clip = bridge.function(OffscreenCanvasRenderingContext2D.clip, .{ .noop = true });
    pub const fillText = bridge.function(OffscreenCanvasRenderingContext2D.fillText, .{ .noop = true });
    pub const strokeText = bridge.function(OffscreenCanvasRenderingContext2D.strokeText, .{ .noop = true });
    pub const measureText = bridge.function(OffscreenCanvasRenderingContext2D.measureText, .{});
    pub const createLinearGradient = bridge.function(OffscreenCanvasRenderingContext2D.createLinearGradient, .{});
    pub const createRadialGradient = bridge.function(OffscreenCanvasRenderingContext2D.createRadialGradient, .{ .dom_exception = true });
    pub const createConicGradient = bridge.function(OffscreenCanvasRenderingContext2D.createConicGradient, .{});
};
