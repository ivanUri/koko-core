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

/// TextMetrics is the result of `CanvasRenderingContext2D.measureText`.
/// https://html.spec.whatwg.org/multipage/canvas.html#textmetrics
///
/// Velora is headless and has no font system, so measurements are estimated
/// using simple character-based heuristics. This provides deterministic values
/// for fingerprinting and basic layout code without requiring a full font engine.
const TextMetrics = @This();

_width: f64 = 0.0,
_font_size: f64 = 10.0,
_text_length: usize = 0,

pub fn init(text: []const u8, font: []const u8, frame: *Frame) !*TextMetrics {
    const font_size = parseFontSize(font);
    const width = estimateTextWidth(text, font_size);

    return frame._factory.create(TextMetrics{
        ._width = width,
        ._font_size = font_size,
        ._text_length = text.len,
    });
}

/// Parse font size from CSS font shorthand (e.g., "10px sans-serif" -> 10.0)
fn parseFontSize(font: []const u8) f64 {
    // Find first number sequence
    var i: usize = 0;
    while (i < font.len) : (i += 1) {
        if (font[i] >= '0' and font[i] <= '9') {
            // Found start of number
            var end = i + 1;
            var has_dot = false;
            while (end < font.len) : (end += 1) {
                if (font[end] >= '0' and font[end] <= '9') continue;
                if (font[end] == '.' and !has_dot) {
                    has_dot = true;
                    continue;
                }
                break;
            }

            const num_str = font[i..end];
            return std.fmt.parseFloat(f64, num_str) catch 10.0;
        }
    }

    // Default to 10px if parsing fails
    return 10.0;
}

/// Estimate text width using simple heuristics
fn estimateTextWidth(text: []const u8, font_size: f64) f64 {
    if (text.len == 0) return 0.0;

    // Average character width as a proportion of font size
    // Real proportional fonts: ~0.5-0.6 of font size
    // We use 0.55 as a reasonable middle ground
    const avg_char_width = font_size * 0.55;

    var width: f64 = 0.0;
    var i: usize = 0;

    while (i < text.len) {
        const c = text[i];

        // Adjust width based on character type
        const char_width = if (c == ' ')
            // Space is narrower
            avg_char_width * 0.3
        else if (c >= 'A' and c <= 'Z')
            // Uppercase slightly wider
            avg_char_width * 1.1
        else if (c == 'i' or c == 'l' or c == 'I' or c == '1' or c == '!' or c == '|')
            // Narrow characters
            avg_char_width * 0.4
        else if (c == 'm' or c == 'M' or c == 'w' or c == 'W')
            // Wide characters
            avg_char_width * 1.3
        else if (c >= '0' and c <= '9')
            // Digits are typically monospaced
            avg_char_width * 0.9
        else
            // Default width
            avg_char_width;

        width += char_width;
        i += 1;
    }

    return width;
}

pub fn getWidth(self: *const TextMetrics) f64 {
    return self._width;
}

fn getActualBoundingBoxLeft(self: *const TextMetrics) f64 {
    // For LTR text, left edge is typically at 0
    _ = self;
    return 0.0;
}

fn getActualBoundingBoxRight(self: *const TextMetrics) f64 {
    // Right edge is approximately the width
    return self._width;
}

fn getActualBoundingBoxAscent(self: *const TextMetrics) f64 {
    // Typical ascent is about 0.75 of font size
    return self._font_size * 0.75;
}

fn getActualBoundingBoxDescent(self: *const TextMetrics) f64 {
    // Typical descent is about 0.25 of font size
    return self._font_size * 0.25;
}

fn getFontBoundingBoxAscent(self: *const TextMetrics) f64 {
    // Font box ascent is typically 0.8 of font size
    return self._font_size * 0.8;
}

fn getFontBoundingBoxDescent(self: *const TextMetrics) f64 {
    // Font box descent is typically 0.2 of font size
    return self._font_size * 0.2;
}

fn getEmHeightAscent(self: *const TextMetrics) f64 {
    // Em height ascent is typically 0.75 of font size
    return self._font_size * 0.75;
}

fn getEmHeightDescent(self: *const TextMetrics) f64 {
    // Em height descent is typically 0.25 of font size
    return self._font_size * 0.25;
}

fn getHangingBaseline(self: *const TextMetrics) f64 {
    // Hanging baseline is typically 0.7 of ascent
    return self._font_size * 0.75 * 0.7;
}

fn getAlphabeticBaseline(_: *const TextMetrics) f64 {
    // Alphabetic baseline is at 0 (the reference point)
    return 0.0;
}

fn getIdeographicBaseline(self: *const TextMetrics) f64 {
    // Ideographic baseline is at the descent
    return -self._font_size * 0.25;
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(TextMetrics);

    pub const Meta = struct {
        pub const name = "TextMetrics";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const width = bridge.accessor(TextMetrics.getWidth, null, .{});
    pub const actualBoundingBoxLeft = bridge.accessor(TextMetrics.getActualBoundingBoxLeft, null, .{});
    pub const actualBoundingBoxRight = bridge.accessor(TextMetrics.getActualBoundingBoxRight, null, .{});
    pub const actualBoundingBoxAscent = bridge.accessor(TextMetrics.getActualBoundingBoxAscent, null, .{});
    pub const actualBoundingBoxDescent = bridge.accessor(TextMetrics.getActualBoundingBoxDescent, null, .{});
    pub const fontBoundingBoxAscent = bridge.accessor(TextMetrics.getFontBoundingBoxAscent, null, .{});
    pub const fontBoundingBoxDescent = bridge.accessor(TextMetrics.getFontBoundingBoxDescent, null, .{});
    pub const emHeightAscent = bridge.accessor(TextMetrics.getEmHeightAscent, null, .{});
    pub const emHeightDescent = bridge.accessor(TextMetrics.getEmHeightDescent, null, .{});
    pub const hangingBaseline = bridge.accessor(TextMetrics.getHangingBaseline, null, .{});
    pub const alphabeticBaseline = bridge.accessor(TextMetrics.getAlphabeticBaseline, null, .{});
    pub const ideographicBaseline = bridge.accessor(TextMetrics.getIdeographicBaseline, null, .{});
};
