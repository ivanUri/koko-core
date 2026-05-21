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
// Velora is headless and does not perform SVG layout, so any geometry query
// returns zero-sized values. The methods still need to exist (and return the
// correct types) because spec-driven and fingerprinting code probes them and
// crashes when the methods are missing rather than returning a degenerate
// rect. The single `Svg` class hosts the full union of methods today; once
// the SVG hierarchy is split into proper interfaces these can move down to
// SVGGraphicsElement / SVGTextContentElement without changing the JS surface.

/// https://svgwg.org/svg2-draft/coords.html#__svg__SVGGraphicsElement__getBBox
pub fn getBBox(_: *Svg, frame: *Frame) !*DOMRect {
    return DOMRect.init(0, 0, 0, 0, frame);
}

/// https://svgwg.org/svg2-draft/text.html#__svg__SVGTextContentElement__getComputedTextLength
pub fn getComputedTextLength(_: *Svg) f64 {
    return 0;
}

/// https://svgwg.org/svg2-draft/text.html#__svg__SVGTextContentElement__getSubStringLength
pub fn getSubStringLength(_: *Svg, _: u32, _: u32) f64 {
    return 0;
}

/// https://svgwg.org/svg2-draft/text.html#__svg__SVGTextContentElement__getNumberOfChars
pub fn getNumberOfChars(_: *Svg) i32 {
    return 0;
}

/// https://svgwg.org/svg2-draft/text.html#__svg__SVGTextContentElement__getExtentOfChar
pub fn getExtentOfChar(_: *Svg, _: u32, frame: *Frame) !*DOMRect {
    return DOMRect.init(0, 0, 0, 0, frame);
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
