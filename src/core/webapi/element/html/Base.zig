const js = @import("../../../js/js.zig");
const Node = @import("../../../dom/Node.zig");
const Element = @import("../../../dom/Element.zig");
const HtmlElement = @import("../Html.zig");
const Frame = @import("../../../browser/Frame.zig");

const Base = @This();

_proto: *HtmlElement,

pub fn asElement(self: *Base) *Element {
    return self._proto._proto;
}
pub fn asNode(self: *Base) *Node {
    return self.asElement().asNode();
}

pub fn getHref(self: *Base, frame: *Frame) ![]const u8 {
    const href = self.asElement().getAttributeSafe(comptime .wrap("href")) orelse return "";
    if (href.len == 0) return frame.base();
    return self.asNode().resolveURL(href, frame, .{});
}

pub fn setHref(self: *Base, value: []const u8, frame: *Frame) !void {
    const owner = self.asNode().ownerFrame(frame);
    try self.asElement().setAttributeSafe(comptime .wrap("href"), .wrap(value), owner);
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(Base);

    pub const Meta = struct {
        pub const name = "HTMLBaseElement";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const href = bridge.accessor(Base.getHref, Base.setHref, .{});
};
