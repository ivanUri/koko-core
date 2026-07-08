const js = @import("../../../js/js.zig");
const Frame = @import("../../../browser/Frame.zig");
const Node = @import("../../../dom/Node.zig");
const Element = @import("../../../dom/Element.zig");
const HtmlElement = @import("../Html.zig");

const Area = @This();

_proto: *HtmlElement,

pub fn asElement(self: *Area) *Element {
    return self._proto._proto;
}
pub fn asNode(self: *Area) *Node {
    return self.asElement().asNode();
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(Area);

    pub const Meta = struct {
        pub const name = "HTMLAreaElement";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const relList = bridge.accessor(_getRelList, null, .{ .null_as_undefined = true });

    fn _getRelList(self: *Area, frame: *Frame) !?*@import("../../collections.zig").DOMTokenList {
        const element = self.asElement();
        if (element._namespace != .html) {
            return null;
        }
        return element.getRelList(frame);
    }
};
