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
const js = @import("../../../js/js.zig");
const Frame = @import("../../../browser/Frame.zig");
const Node = @import("../../../dom/Node.zig");
const Element = @import("../../../dom/Element.zig");
const DOMRect = @import("../../../dom/DOMRect.zig");
const SVGRect = @import("../../../dom/SVGRect.zig");
const Svg = @import("../Svg.zig");

const Generic = @This();
_proto: *Svg,
_tag: Element.Tag,

pub fn asElement(self: *Generic) *Element {
    return self._proto._proto;
}
pub fn asNode(self: *Generic) *Node {
    return self.asElement().asNode();
}

pub fn getBBox(self: *Generic, frame: *Frame) !*SVGRect {
    return Svg.getBBox(self._proto, frame);
}

pub fn getComputedTextLength(self: *Generic, frame: *Frame) f64 {
    return Svg.getComputedTextLength(self._proto, frame);
}

pub fn getSubStringLength(self: *Generic, char_num: u32, n_chars: u32, frame: *Frame) f64 {
    return Svg.getSubStringLength(self._proto, char_num, n_chars, frame);
}

pub fn getNumberOfChars(self: *Generic, frame: *Frame) i32 {
    return Svg.getNumberOfChars(self._proto, frame);
}

pub fn getExtentOfChar(self: *Generic, char_num: u32, frame: *Frame) !*SVGRect {
    return Svg.getExtentOfChar(self._proto, char_num, frame);
}

pub fn getStartPositionOfChar(self: *Generic, char_num: u32, frame: *Frame) !*DOMRect {
    return Svg.getStartPositionOfChar(self._proto, char_num, frame);
}

pub fn getEndPositionOfChar(self: *Generic, char_num: u32, frame: *Frame) !*DOMRect {
    return Svg.getEndPositionOfChar(self._proto, char_num, frame);
}

pub fn getRotationOfChar(self: *Generic, char_num: u32) f64 {
    return Svg.getRotationOfChar(self._proto, char_num);
}

pub fn getCharNumAtPosition(self: *Generic, x: f64, y: f64) i32 {
    return Svg.getCharNumAtPosition(self._proto, x, y);
}

pub fn getStyle(self: *Generic, frame: *Frame) !*@import("../../css/CSSStyleProperties.zig") {
    return Svg.getStyle(self._proto, frame);
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(Generic);

    pub const Meta = struct {
        pub const name = "SVGGenericElement";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const style = bridge.accessor(Generic.getStyle, null, .{});
    pub const getBBox = bridge.function(Generic.getBBox, .{});
    pub const getComputedTextLength = bridge.function(Generic.getComputedTextLength, .{});
    pub const getSubStringLength = bridge.function(Generic.getSubStringLength, .{});
    pub const getNumberOfChars = bridge.function(Generic.getNumberOfChars, .{});
    pub const getExtentOfChar = bridge.function(Generic.getExtentOfChar, .{});
    pub const getStartPositionOfChar = bridge.function(Generic.getStartPositionOfChar, .{});
    pub const getEndPositionOfChar = bridge.function(Generic.getEndPositionOfChar, .{});
    pub const getRotationOfChar = bridge.function(Generic.getRotationOfChar, .{});
    pub const getCharNumAtPosition = bridge.function(Generic.getCharNumAtPosition, .{});
    pub const relList = bridge.accessor(_getRelList, null, .{ .null_as_undefined = true });

    fn _getRelList(self: *Generic, frame: *Frame) !?*@import("../../collections.zig").DOMTokenList {
        const element = self.asElement();
        if (element._namespace != .svg) {
            return null;
        }
        if (!std.mem.eql(u8, element.getLocalName(), "a")) {
            return null;
        }
        return element.getRelList(frame);
    }
};
