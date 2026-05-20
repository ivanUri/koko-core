const js = @import("../../../js/js.zig");
const Frame = @import("../../../browser/Frame.zig");
const Node = @import("../../../dom/Node.zig");
const Element = @import("../../../dom/Element.zig");
const HtmlElement = @import("../Html.zig");

const Object = @This();

_proto: *HtmlElement,

pub fn asElement(self: *Object) *Element {
    return self._proto._proto;
}
pub fn asConstElement(self: *const Object) *const Element {
    return self._proto._proto;
}
pub fn asNode(self: *Object) *Node {
    return self.asElement().asNode();
}

// `name` reflects the name content attribute. Required for the
// HTMLObjectElement IDL and `document[name]` named-item semantics.
pub fn getName(self: *const Object) []const u8 {
    return self.asConstElement().getAttributeSafe(comptime .wrap("name")) orelse "";
}

pub fn setName(self: *Object, value: []const u8, frame: *Frame) !void {
    try self.asElement().setAttributeSafe(comptime .wrap("name"), .wrap(value), frame);
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(Object);

    pub const Meta = struct {
        pub const name = "HTMLObjectElement";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const name = bridge.accessor(Object.getName, Object.setName, .{});
};
