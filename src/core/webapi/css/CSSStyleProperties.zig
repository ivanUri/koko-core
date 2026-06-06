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

const Element = @import("../../dom/Element.zig");
const Frame = @import("../../browser/Frame.zig");
const CSSStyleDeclaration = @import("CSSStyleDeclaration.zig");

const CSSStyleProperties = @This();

_proto: *CSSStyleDeclaration,

pub fn init(element: ?*Element, is_computed: bool, frame: *Frame) !*CSSStyleProperties {
    return frame._factory.create(CSSStyleProperties{
        ._proto = try CSSStyleDeclaration.init(element, is_computed, frame),
    });
}

pub fn length(self: *const CSSStyleProperties) u32 {
    return self._proto.length();
}

pub fn item(self: *const CSSStyleProperties, index: i32) []const u8 {
    if (index < 0) return "";
    return self._proto.item(@intCast(index));
}

pub fn getCssText(self: *const CSSStyleProperties, frame: *Frame) ![]const u8 {
    return self._proto.getCssText(frame);
}

pub fn setCssText(self: *CSSStyleProperties, text: []const u8, frame: *Frame) !void {
    return self._proto.setCssText(text, frame);
}

pub fn getPropertyValue(self: *const CSSStyleProperties, property_name: []const u8, frame: *Frame) []const u8 {
    return self._proto.getPropertyValue(property_name, frame);
}

pub fn getPropertyPriority(self: *const CSSStyleProperties, property_name: []const u8, frame: *Frame) []const u8 {
    return self._proto.getPropertyPriority(property_name, frame);
}

pub fn setProperty(self: *CSSStyleProperties, property_name: []const u8, value: []const u8, priority_: ?[]const u8, frame: *Frame) !void {
    return self._proto.setProperty(property_name, value, priority_, frame);
}

pub fn removeProperty(self: *CSSStyleProperties, property_name: []const u8, frame: *Frame) ![]const u8 {
    return self._proto.removeProperty(property_name, frame);
}

pub fn getFloat(self: *const CSSStyleProperties, frame: *Frame) []const u8 {
    return self._proto.getFloat(frame);
}

pub fn setFloat(self: *CSSStyleProperties, value_: ?[]const u8, frame: *Frame) !void {
    return self._proto.setFloat(value_, frame);
}

pub fn asCSSStyleDeclaration(self: *CSSStyleProperties) *CSSStyleDeclaration {
    return self._proto;
}

pub fn setNamed(self: *CSSStyleProperties, name: []const u8, value: []const u8, frame: *Frame) !void {
    if (method_names.has(name)) {
        return error.NotHandled;
    }
    const dash_case = camelCaseToDashCase(name, &frame.buf);
    try self._proto.setProperty(dash_case, value, null, frame);
}

pub fn getNamed(self: *CSSStyleProperties, name: []const u8, frame: *Frame) ![]const u8 {
    if (method_names.has(name)) {
        return error.NotHandled;
    }

    const dash_case = camelCaseToDashCase(name, &frame.buf);

    // Only apply vendor prefix filtering for camelCase access (no dashes in input)
    // Bracket notation with dash-case (e.g., div.style['-moz-user-select']) should return the actual value
    const is_camelcase_access = std.mem.indexOfScalar(u8, name, '-') == null;
    if (is_camelcase_access and std.mem.startsWith(u8, dash_case, "-")) {
        // We only support -webkit-, other vendor prefixes return undefined for camelCase access
        const is_webkit = std.mem.startsWith(u8, dash_case, "-webkit-");
        const is_moz = std.mem.startsWith(u8, dash_case, "-moz-");
        const is_ms = std.mem.startsWith(u8, dash_case, "-ms-");
        const is_o = std.mem.startsWith(u8, dash_case, "-o-");

        if ((is_moz or is_ms or is_o) and !is_webkit) {
            return error.NotHandled;
        }
    }

    const value = self._proto.getPropertyValue(dash_case, frame);

    // Property accessors have special handling for empty values:
    // - Known CSS properties return '' when not set
    // - Vendor-prefixed properties return undefined when not set
    // - Unknown properties return undefined
    if (value.len == 0) {
        // Vendor-prefixed properties always return undefined when not set
        if (std.mem.startsWith(u8, dash_case, "-")) {
            return error.NotHandled;
        }

        // Known CSS properties return '', unknown properties return undefined
        if (!isKnownCSSProperty(dash_case)) {
            return error.NotHandled;
        }

        return "";
    }

    return value;
}

fn isKnownCSSProperty(dash_case: []const u8) bool {
    const known_properties = std.StaticStringMap(void).initComptime(.{
        // Colors & backgrounds
        .{ "color", {} },
        .{ "background", {} },
        .{ "background-color", {} },
        .{ "background-image", {} },
        .{ "background-position", {} },
        .{ "background-repeat", {} },
        .{ "background-size", {} },
        .{ "background-attachment", {} },
        .{ "background-clip", {} },
        .{ "background-origin", {} },
        // Typography
        .{ "font", {} },
        .{ "font-family", {} },
        .{ "font-size", {} },
        .{ "font-style", {} },
        .{ "font-weight", {} },
        .{ "font-variant", {} },
        .{ "line-height", {} },
        .{ "letter-spacing", {} },
        .{ "word-spacing", {} },
        .{ "text-align", {} },
        .{ "text-decoration", {} },
        .{ "text-indent", {} },
        .{ "text-transform", {} },
        .{ "white-space", {} },
        .{ "word-break", {} },
        .{ "word-wrap", {} },
        .{ "overflow-wrap", {} },
        // Box model
        .{ "margin", {} },
        .{ "margin-top", {} },
        .{ "margin-right", {} },
        .{ "margin-bottom", {} },
        .{ "margin-left", {} },
        .{ "margin-block", {} },
        .{ "margin-block-start", {} },
        .{ "margin-block-end", {} },
        .{ "margin-inline", {} },
        .{ "margin-inline-start", {} },
        .{ "margin-inline-end", {} },
        .{ "padding", {} },
        .{ "padding-top", {} },
        .{ "padding-right", {} },
        .{ "padding-bottom", {} },
        .{ "padding-left", {} },
        .{ "padding-block", {} },
        .{ "padding-block-start", {} },
        .{ "padding-block-end", {} },
        .{ "padding-inline", {} },
        .{ "padding-inline-start", {} },
        .{ "padding-inline-end", {} },
        // Border
        .{ "border", {} },
        .{ "border-width", {} },
        .{ "border-style", {} },
        .{ "border-color", {} },
        .{ "border-top", {} },
        .{ "border-top-width", {} },
        .{ "border-top-style", {} },
        .{ "border-top-color", {} },
        .{ "border-right", {} },
        .{ "border-right-width", {} },
        .{ "border-right-style", {} },
        .{ "border-right-color", {} },
        .{ "border-bottom", {} },
        .{ "border-bottom-width", {} },
        .{ "border-bottom-style", {} },
        .{ "border-bottom-color", {} },
        .{ "border-left", {} },
        .{ "border-left-width", {} },
        .{ "border-left-style", {} },
        .{ "border-left-color", {} },
        .{ "border-radius", {} },
        .{ "border-top-left-radius", {} },
        .{ "border-top-right-radius", {} },
        .{ "border-bottom-left-radius", {} },
        .{ "border-bottom-right-radius", {} },
        .{ "border-collapse", {} },
        .{ "border-spacing", {} },
        // Sizing
        .{ "width", {} },
        .{ "height", {} },
        .{ "block-size", {} },
        .{ "inline-size", {} },
        .{ "min-width", {} },
        .{ "min-height", {} },
        .{ "max-width", {} },
        .{ "max-height", {} },
        .{ "box-sizing", {} },
        // Positioning
        .{ "position", {} },
        .{ "top", {} },
        .{ "right", {} },
        .{ "bottom", {} },
        .{ "left", {} },
        .{ "inset", {} },
        .{ "inset-block", {} },
        .{ "inset-block-start", {} },
        .{ "inset-block-end", {} },
        .{ "inset-inline", {} },
        .{ "inset-inline-start", {} },
        .{ "inset-inline-end", {} },
        .{ "z-index", {} },
        .{ "float", {} },
        .{ "clear", {} },
        // Display & visibility
        .{ "display", {} },
        .{ "visibility", {} },
        .{ "opacity", {} },
        .{ "overflow", {} },
        .{ "overflow-x", {} },
        .{ "overflow-y", {} },
        .{ "clip", {} },
        .{ "clip-path", {} },
        // Flexbox
        .{ "flex", {} },
        .{ "flex-direction", {} },
        .{ "flex-wrap", {} },
        .{ "flex-flow", {} },
        .{ "flex-grow", {} },
        .{ "flex-shrink", {} },
        .{ "flex-basis", {} },
        .{ "order", {} },
        // Grid
        .{ "grid", {} },
        .{ "grid-template", {} },
        .{ "grid-template-columns", {} },
        .{ "grid-template-rows", {} },
        .{ "grid-template-areas", {} },
        .{ "grid-auto-columns", {} },
        .{ "grid-auto-rows", {} },
        .{ "grid-auto-flow", {} },
        .{ "grid-column", {} },
        .{ "grid-column-start", {} },
        .{ "grid-column-end", {} },
        .{ "grid-row", {} },
        .{ "grid-row-start", {} },
        .{ "grid-row-end", {} },
        .{ "grid-area", {} },
        .{ "gap", {} },
        .{ "row-gap", {} },
        .{ "column-gap", {} },
        // Alignment (flexbox & grid)
        .{ "align-content", {} },
        .{ "align-items", {} },
        .{ "align-self", {} },
        .{ "justify-content", {} },
        .{ "justify-items", {} },
        .{ "justify-self", {} },
        .{ "place-content", {} },
        .{ "place-items", {} },
        .{ "place-self", {} },
        // Transforms & animations
        .{ "transform", {} },
        .{ "transform-origin", {} },
        .{ "transform-style", {} },
        .{ "perspective", {} },
        .{ "perspective-origin", {} },
        .{ "transition", {} },
        .{ "transition-property", {} },
        .{ "transition-duration", {} },
        .{ "transition-timing-function", {} },
        .{ "transition-delay", {} },
        .{ "animation", {} },
        .{ "animation-name", {} },
        .{ "animation-duration", {} },
        .{ "animation-timing-function", {} },
        .{ "animation-delay", {} },
        .{ "animation-iteration-count", {} },
        .{ "animation-direction", {} },
        .{ "animation-fill-mode", {} },
        .{ "animation-play-state", {} },
        // Filters & effects
        .{ "filter", {} },
        .{ "backdrop-filter", {} },
        .{ "box-shadow", {} },
        .{ "text-shadow", {} },
        // Outline
        .{ "outline", {} },
        .{ "outline-width", {} },
        .{ "outline-style", {} },
        .{ "outline-color", {} },
        .{ "outline-offset", {} },
        // Lists
        .{ "list-style", {} },
        .{ "list-style-type", {} },
        .{ "list-style-position", {} },
        .{ "list-style-image", {} },
        // Tables
        .{ "table-layout", {} },
        .{ "caption-side", {} },
        .{ "empty-cells", {} },
        // Misc
        .{ "cursor", {} },
        .{ "pointer-events", {} },
        .{ "user-select", {} },
        .{ "resize", {} },
        .{ "object-fit", {} },
        .{ "object-position", {} },
        .{ "vertical-align", {} },
        .{ "content", {} },
        .{ "quotes", {} },
        .{ "counter-reset", {} },
        .{ "counter-increment", {} },
        // Scrolling
        .{ "scroll-behavior", {} },
        .{ "scroll-margin", {} },
        .{ "scroll-padding", {} },
        .{ "overscroll-behavior", {} },
        .{ "overscroll-behavior-x", {} },
        .{ "overscroll-behavior-y", {} },
        // Containment
        .{ "contain", {} },
        .{ "container", {} },
        .{ "container-type", {} },
        .{ "container-name", {} },
        // Aspect ratio
        .{ "aspect-ratio", {} },
    });

    return known_properties.has(dash_case);
}

fn camelCaseToDashCase(name: []const u8, buf: []u8) []const u8 {
    if (name.len == 0) {
        return name;
    }

    // Special case: cssFloat -> float
    const lower_name = std.ascii.lowerString(buf, name);
    if (std.mem.eql(u8, lower_name, "cssfloat")) {
        return "float";
    }

    // If already contains dashes, just return lowercased
    if (std.mem.indexOfScalar(u8, name, '-')) |_| {
        return lower_name;
    }

    // Check if this looks like proper camelCase (starts with lowercase)
    // If not (e.g. "COLOR", "BackgroundColor"), just lowercase it
    if (name.len == 0 or !std.ascii.isLower(name[0])) {
        return lower_name;
    }

    // Check for vendor prefixes: webkitTransform -> -webkit-transform
    // Must have uppercase letter after the prefix
    const has_vendor_prefix = blk: {
        if (name.len > 6 and std.mem.startsWith(u8, name, "webkit") and std.ascii.isUpper(name[6])) break :blk true;
        if (name.len > 3 and std.mem.startsWith(u8, name, "moz") and std.ascii.isUpper(name[3])) break :blk true;
        if (name.len > 2 and std.mem.startsWith(u8, name, "ms") and std.ascii.isUpper(name[2])) break :blk true;
        if (name.len > 1 and std.mem.startsWith(u8, name, "o") and std.ascii.isUpper(name[1])) break :blk true;
        break :blk false;
    };

    var write_pos: usize = 0;

    if (has_vendor_prefix) {
        buf[write_pos] = '-';
        write_pos += 1;
    }

    for (name, 0..) |c, i| {
        if (write_pos >= buf.len) {
            return lower_name;
        }

        if (std.ascii.isUpper(c)) {
            const skip_dash = has_vendor_prefix and i < 10 and write_pos == 1;

            if (i > 0 and !skip_dash) {
                if (write_pos >= buf.len) break;
                buf[write_pos] = '-';
                write_pos += 1;
            }
            if (write_pos >= buf.len) break;
            buf[write_pos] = std.ascii.toLower(c);
            write_pos += 1;
        } else {
            buf[write_pos] = c;
            write_pos += 1;
        }
    }

    return buf[0..write_pos];
}

const method_names = std.StaticStringMap(void).initComptime(.{
    .{ "getPropertyValue", {} },
    .{ "setProperty", {} },
    .{ "removeProperty", {} },
    .{ "getPropertyPriority", {} },
    .{ "item", {} },
    .{ "cssText", {} },
    .{ "length", {} },
});

pub const JsApi = struct {
    pub const bridge = js.Bridge(CSSStyleProperties);

    pub const Meta = struct {
        pub const name = "CSSStyleProperties";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const cssText = bridge.accessor(CSSStyleProperties.getCssText, CSSStyleProperties.setCssText, .{});
    pub const length = bridge.accessor(CSSStyleProperties.length, null, .{});
    pub const item = bridge.function(CSSStyleProperties.item, .{});
    pub const getPropertyValue = bridge.function(CSSStyleProperties.getPropertyValue, .{});
    pub const getPropertyPriority = bridge.function(CSSStyleProperties.getPropertyPriority, .{});
    pub const setProperty = bridge.function(CSSStyleProperties.setProperty, .{});
    pub const removeProperty = bridge.function(CSSStyleProperties.removeProperty, .{});
    pub const cssFloat = bridge.accessor(CSSStyleProperties.getFloat, CSSStyleProperties.setFloat, .{});
    pub const @"[]" = bridge.namedIndexed(CSSStyleProperties.getNamed, CSSStyleProperties.setNamed, null, .{});
};
