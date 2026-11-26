const std = @import("std");
const js = @import("../../js/js.zig");
const Frame = @import("../../browser/Frame.zig");
const Element = @import("../../dom/Element.zig");
const CSSStyleDeclaration = @import("CSSStyleDeclaration.zig");

pub const CSSUnitValue = struct {
    _value: f64,
    _unit: []const u8,
    pub fn value(self: *const CSSUnitValue) f64 {
        return self._value;
    }
    pub fn unit(self: *const CSSUnitValue) []const u8 {
        return self._unit;
    }
    pub fn toString(self: *const CSSUnitValue, frame: *Frame) ![]const u8 {
        return std.fmt.allocPrint(frame.call_arena, "{d}{s}", .{ self._value, self._unit });
    }
    pub const JsApi = struct {
        pub const bridge = js.Bridge(CSSUnitValue);
        pub const Meta = struct {
            pub const name = "CSSUnitValue";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const value = bridge.accessor(CSSUnitValue.value, null, .{});
        pub const unit = bridge.accessor(CSSUnitValue.unit, null, .{});
        pub const toString = bridge.function(CSSUnitValue.toString, .{});
    };
};

const StylePropertyMapReadOnly = @This();
_element: *Element,
pub fn init(element: *Element, frame: *Frame) !*StylePropertyMapReadOnly {
    return frame._factory.create(StylePropertyMapReadOnly{ ._element = element });
}
pub fn get(self: *StylePropertyMapReadOnly, property_name: []const u8, frame: *Frame) !?*CSSUnitValue {
    const owner = self._element.asNode().ownerFrame(frame);
    // Typed OM is a style read, not a layout read. Prepare Stylo's cascade
    // snapshot here so computedStyleMap() observes stylesheet rules without
    // forcing Taffy/Parley layout.
    _ = owner.styleEngine().prepareForLayout();
    const declaration = try CSSStyleDeclaration.init(self._element, true, owner, null);
    const value = std.mem.trim(u8, declaration.getPropertyValue(property_name, owner), &std.ascii.whitespace);
    var end: usize = 0;
    while (end < value.len and (std.ascii.isDigit(value[end]) or value[end] == '+' or value[end] == '-' or value[end] == '.' or value[end] == 'e' or value[end] == 'E')) : (end += 1) {}
    if (end == 0) return null;
    const number = std.fmt.parseFloat(f64, value[0..end]) catch return null;
    return owner._factory.create(CSSUnitValue{ ._value = number, ._unit = if (end == value.len) "number" else try owner.dupeString(value[end..]) });
}
pub const JsApi = struct {
    pub const bridge = js.Bridge(StylePropertyMapReadOnly);
    pub const Meta = struct {
        pub const name = "StylePropertyMapReadOnly";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };
    pub const get = bridge.function(StylePropertyMapReadOnly.get, .{ .null_as_undefined = true });
};

const testing = @import("../../../testing/testing.zig");
test "WebApi: CSS Typed OM" {
    try testing.htmlRunner("css/typed_om.html", .{});
}
