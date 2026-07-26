const js = @import("../../../js/js.zig");
const Frame = @import("../../../browser/Frame.zig");

const Node = @import("../../../dom/Node.zig");
const Element = @import("../../../dom/Element.zig");
const HtmlElement = @import("../Html.zig");

const Dialog = @This();

_proto: *HtmlElement,
_is_modal: bool = false,

pub fn asElement(self: *Dialog) *Element {
    return self._proto._proto;
}
pub fn asConstElement(self: *const Dialog) *const Element {
    return self._proto._proto;
}
pub fn asNode(self: *Dialog) *Node {
    return self.asElement().asNode();
}

pub fn getOpen(self: *const Dialog) bool {
    return self.asConstElement().getAttributeSafe(comptime .wrap("open")) != null;
}

pub fn setOpen(self: *Dialog, open: bool, frame: *Frame) !void {
    if (open) {
        try self.asElement().setAttributeSafe(comptime .wrap("open"), .wrap(""), frame);
    } else {
        try self.asElement().removeAttribute(comptime .wrap("open"), frame);
        self._is_modal = false;
    }
}

/// HTML dialog "show" algorithm. Calling show() on an already-open
/// non-modal dialog is a no-op; an open modal dialog is an invalid state.
pub fn show(self: *Dialog, frame: *Frame) !void {
    if (self.getOpen()) {
        if (self._is_modal) return error.InvalidStateError;
        return;
    }
    self._is_modal = false;
    try self.setOpen(true, frame);
}

/// HTML dialog "show modal" algorithm. Top-layer rendering is owned by the
/// layout/top-layer subsystem; this interface still tracks the modal state
/// and the reflected open attribute with browser-compatible state checks.
pub fn showModal(self: *Dialog, frame: *Frame) !void {
    if (self.getOpen()) return error.InvalidStateError;
    self._is_modal = true;
    try self.setOpen(true, frame);
}

pub fn close(self: *Dialog, return_value: ?[]const u8, frame: *Frame) !void {
    if (!self.getOpen()) return;
    if (return_value) |value| try self.setReturnValue(value, frame);
    try self.setOpen(false, frame);
}

pub fn requestClose(self: *Dialog, return_value: ?[]const u8, frame: *Frame) !void {
    // The cancel event is not yet cancellable in Velora's dialog top-layer
    // controller, so the default action is the close algorithm.
    try self.close(return_value, frame);
}

pub fn getReturnValue(self: *const Dialog) []const u8 {
    return self.asConstElement().getAttributeSafe(comptime .wrap("returnvalue")) orelse "";
}

pub fn setReturnValue(self: *Dialog, value: []const u8, frame: *Frame) !void {
    try self.asElement().setAttributeSafe(comptime .wrap("returnvalue"), .wrap(value), frame);
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(Dialog);

    pub const Meta = struct {
        pub const name = "HTMLDialogElement";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const open = bridge.accessor(Dialog.getOpen, Dialog.setOpen, .{});
    pub const returnValue = bridge.accessor(Dialog.getReturnValue, Dialog.setReturnValue, .{});
    pub const show = bridge.function(Dialog.show, .{ .dom_exception = true });
    pub const showModal = bridge.function(Dialog.showModal, .{ .dom_exception = true });
    pub const close = bridge.function(Dialog.close, .{ .dom_exception = true });
    pub const requestClose = bridge.function(Dialog.requestClose, .{ .dom_exception = true });
};

const testing = @import("../../../../testing/testing.zig");
test "WebApi: HTML.Dialog" {
    try testing.htmlRunner("element/html/dialog.html", .{});
}
