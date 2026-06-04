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
const Node = @import("../../dom/Node.zig");
const Element = @import("../../dom/Element.zig");
const DOMRect = @import("../../dom/DOMRect.zig");
pub const Generic = @import("svg/Generic.zig");

const String = @import("../../../support/string.zig").String;

const Svg = @This();
_type: Type,
_proto: *Element,
_tag_name: String, // Svg elements are case-preserving

pub const Type = union(enum) {
    svg,
    generic: *Generic,
};

pub fn is(self: *Svg, comptime T: type) ?*T {
    inline for (@typeInfo(Type).@"union".fields) |f| {
        if (@field(Type, f.name) == self._type) {
            if (f.type == T) {
                return &@field(self._type, f.name);
            }
            if (f.type == *T) {
                return @field(self._type, f.name);
            }
        }
    }
    return null;
}

pub fn asElement(self: *Svg) *Element {
    return self._proto;
}
pub fn asNode(self: *Svg) *Node {
    return self.asElement().asNode();
}

// ---------------------------------------------------------------------------
// SVGGraphicsElement / SVGTextContentElement geometry surface
// ---------------------------------------------------------------------------
//
// Velora is headless and does not perform SVG layout, so geometry queries
// return heuristic estimates based on text content and character counting.
// This provides deterministic values for fingerprinting and basic layout code
// without requiring a full SVG rendering engine.

/// Estimate text width based on character count
fn estimateSvgTextWidth(self: *Svg, frame: *Frame) f64 {
    const text_content = self.asNode().getTextContentAlloc(frame.call_arena) catch return 0.0;
    if (text_content.len == 0) return 0.0;

    // Default SVG font size is typically 16px
    const default_font_size: f64 = 16.0;
    const avg_char_width = default_font_size * 0.55;

    return @as(f64, @floatFromInt(text_content.len)) * avg_char_width;
}

/// Estimate text height based on font size
fn estimateSvgTextHeight(_: *Svg) f64 {
    // Default SVG font size is typically 16px
    return 16.0;
}

/// https://svgwg.org/svg2-draft/coords.html#__svg__SVGGraphicsElement__getBBox
pub fn getBBox(self: *Svg, frame: *Frame) !*DOMRect {
    const width = self.estimateSvgTextWidth(frame);
    const height = self.estimateSvgTextHeight();
    return DOMRect.init(0, 0, width, height, frame);
}

/// https://svgwg.org/svg2-draft/text.html#__svg__SVGTextContentElement__getComputedTextLength
pub fn getComputedTextLength(self: *Svg, frame: *Frame) f64 {
    return self.estimateSvgTextWidth(frame);
}

/// https://svgwg.org/svg2-draft/text.html#__svg__SVGTextContentElement__getSubStringLength
pub fn getSubStringLength(self: *Svg, char_num: u32, n_chars: u32, frame: *Frame) f64 {
    const text_content = self.asNode().getTextContentAlloc(frame.call_arena) catch return 0.0;
    const start = @min(char_num, @as(u32, @intCast(text_content.len)));
    const end = @min(start + n_chars, @as(u32, @intCast(text_content.len)));
    const length = end - start;

    const default_font_size: f64 = 16.0;
    const avg_char_width = default_font_size * 0.55;
    return @as(f64, @floatFromInt(length)) * avg_char_width;
}

/// https://svgwg.org/svg2-draft/text.html#__svg__SVGTextContentElement__getNumberOfChars
pub fn getNumberOfChars(self: *Svg, frame: *Frame) i32 {
    const text_content = self.asNode().getTextContentAlloc(frame.call_arena) catch return 0;
    return @intCast(text_content.len);
}

/// https://svgwg.org/svg2-draft/text.html#__svg__SVGTextContentElement__getExtentOfChar
pub fn getExtentOfChar(self: *Svg, char_num: u32, frame: *Frame) !*DOMRect {
    const text_content = self.asNode().getTextContentAlloc(frame.call_arena) catch {
        return DOMRect.init(0, 0, 0, 0, frame);
    };

    if (char_num >= text_content.len) {
        return DOMRect.init(0, 0, 0, 0, frame);
    }

    const default_font_size: f64 = 16.0;
    const avg_char_width = default_font_size * 0.55;

    // X position is based on character index
    const x = @as(f64, @floatFromInt(char_num)) * avg_char_width;
    const y: f64 = 0;
    const width = avg_char_width;
    const height = default_font_size;

    return DOMRect.init(x, y, width, height, frame);
}

/// https://svgwg.org/svg2-draft/text.html#__svg__SVGTextContentElement__getStartPositionOfChar
pub fn getStartPositionOfChar(_: *Svg, _: u32, frame: *Frame) !*DOMRect {
    // Spec returns SVGPoint; DOMRect with width=height=0 satisfies the
    // x/y probe pattern used by tests/fingerprinting until we add SVGPoint.
    return DOMRect.init(0, 0, 0, 0, frame);
}

/// https://svgwg.org/svg2-draft/text.html#__svg__SVGTextContentElement__getEndPositionOfChar
pub fn getEndPositionOfChar(_: *Svg, _: u32, frame: *Frame) !*DOMRect {
    return DOMRect.init(0, 0, 0, 0, frame);
}

/// https://svgwg.org/svg2-draft/text.html#__svg__SVGTextContentElement__getRotationOfChar
pub fn getRotationOfChar(_: *Svg, _: u32) f64 {
    return 0;
}

/// https://svgwg.org/svg2-draft/text.html#__svg__SVGTextContentElement__getCharNumAtPosition
pub fn getCharNumAtPosition(_: *Svg, _: f64, _: f64) i32 {
    return -1;
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(Svg);

    pub const Meta = struct {
        pub const name = "SVGElement";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const getBBox = bridge.function(Svg.getBBox, .{});
    pub const getComputedTextLength = bridge.function(Svg.getComputedTextLength, .{});
    pub const getSubStringLength = bridge.function(Svg.getSubStringLength, .{});
    pub const getNumberOfChars = bridge.function(Svg.getNumberOfChars, .{});
    pub const getExtentOfChar = bridge.function(Svg.getExtentOfChar, .{});
    pub const getStartPositionOfChar = bridge.function(Svg.getStartPositionOfChar, .{});
    pub const getEndPositionOfChar = bridge.function(Svg.getEndPositionOfChar, .{});
    pub const getRotationOfChar = bridge.function(Svg.getRotationOfChar, .{});
    pub const getCharNumAtPosition = bridge.function(Svg.getCharNumAtPosition, .{});
};

const testing = @import("../../../testing/testing.zig");
test "WebApi: Svg" {
    try testing.htmlRunner("element/svg", .{});
}
