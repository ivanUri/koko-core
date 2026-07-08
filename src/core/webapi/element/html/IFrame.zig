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
const Window = @import("../../Window.zig");
const Document = @import("../../../dom/Document.zig");
const Node = @import("../../../dom/Node.zig");
const Element = @import("../../../dom/Element.zig");
const HtmlElement = @import("../Html.zig");

const IFrameSandbox = @import("../../../browser/IFrameSandbox.zig");

const IFrame = @This();
_proto: *HtmlElement,
_src: []const u8 = "",
_srcdoc: []const u8 = "",
_executed: bool = false,
/// Same-turn `load` already dispatched during inline about:blank navigation.
_sync_onload_dispatched: bool = false,
/// Queued for flush at appendChild return (Fingerprint yb onload timing).
_sync_load_queued: bool = false,
_window: ?*Window = null,

pub fn asElement(self: *IFrame) *Element {
    return self._proto._proto;
}
pub fn asNode(self: *IFrame) *Node {
    return self.asElement().asNode();
}

fn inlineChildUrl(url: []const u8) bool {
    return std.mem.eql(u8, url, "about:blank") or
        std.mem.eql(u8, url, "about:srcdoc") or
        std.mem.startsWith(u8, url, "blob:");
}

fn inlineChildReadyForAccess(child: *Frame) bool {
    if (child.realmReadyForExternalObservers()) return true;
    // about:blank / srcdoc / blob navigations finish inline during appendChild.
    // Fingerprint yb() reads contentWindow.document.readyState on the same turn
    // as appendChild returns — publish as soon as the blank document exists.
    if (!inlineChildUrl(child.url)) return false;
    if (child.document._ready_state == .complete) return true;
    if (child._parse_state == .complete and std.mem.eql(u8, child.document.getReadyState(), "complete")) {
        return true;
    }
    return false;
}

pub fn getContentWindow(self: *const IFrame, frame: *Frame) ?Window.Access {
    const frame_window = self._window orelse return null;
    if (!inlineChildReadyForAccess(frame_window._frame)) return null;
    return Window.Access.init(frame.window, frame_window);
}

pub fn getContentDocument(self: *const IFrame) ?*Document {
    const window = self._window orelse return null;
    if (!inlineChildReadyForAccess(window._frame)) return null;
    if (IFrameSandbox.usesOpaqueOrigin(IFrameSandbox.parse(@constCast(self)))) return null;
    return window._document;
}

pub fn getSrc(self: *IFrame, frame: *Frame) ![:0]const u8 {
    if (self._src.len == 0) return "";
    return self.asNode().resolveURL(self._src, frame, .{});
}

pub fn setSrc(self: *IFrame, src: []const u8, frame: *Frame) !void {
    const element = self.asElement();
    const old_src = self._src;
    try element.setAttributeSafe(comptime .wrap("src"), .wrap(src), frame);
    self._src = element.getAttributeSafe(comptime .wrap("src")) orelse unreachable;
    // HTML: srcdoc overrides src for navigation.
    if (self._srcdoc.len > 0) return;
    if (element.asNode().isConnected()) {
        if (self._window != null and isAboutBlankSrc(old_src) and isAboutBlankSrc(self._src)) {
            return;
        }
        // unlike script, an iframe is reloaded every time the src is set
        // even if it's set to the same URL.
        self._executed = false;
        try frame.iframeAddedCallback(self);
    }
}

fn isAboutBlankSrc(src: []const u8) bool {
    return src.len == 0 or std.mem.eql(u8, src, "about:blank");
}

pub fn getName(self: *IFrame) []const u8 {
    return self.asElement().getAttributeSafe(comptime .wrap("name")) orelse "";
}

pub fn setName(self: *IFrame, value: []const u8, frame: *Frame) !void {
    try self.asElement().setAttributeSafe(comptime .wrap("name"), .wrap(value), frame);
}

pub fn getSandboxList(self: *IFrame, frame: *Frame) !*@import("../../collections.zig").DOMTokenList {
    return self.asElement().getSandboxList(frame);
}

pub fn getSrcdoc(self: *IFrame) []const u8 {
    return self._srcdoc;
}

pub fn setSrcdoc(self: *IFrame, value: []const u8, frame: *Frame) !void {
    try self.asElement().setAttributeSafe(comptime .wrap("srcdoc"), .wrap(value), frame);
    self._srcdoc = self.asElement().getAttributeSafe(comptime .wrap("srcdoc")) orelse "";
    if (!self.asNode().isConnected()) return;
    self._executed = false;
    try frame.iframeAddedCallback(self);
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(IFrame);

    pub const Meta = struct {
        pub const name = "HTMLIFrameElement";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const src = bridge.accessor(IFrame.getSrc, IFrame.setSrc, .{});
    pub const srcdoc = bridge.accessor(IFrame.getSrcdoc, IFrame.setSrcdoc, .{});
    pub const name = bridge.accessor(IFrame.getName, IFrame.setName, .{});
    pub const contentWindow = bridge.accessor(IFrame.getContentWindow, null, .{});
    pub const contentDocument = bridge.accessor(IFrame.getContentDocument, null, .{});
    pub const sandbox = bridge.accessor(IFrame.getSandboxList, null, .{});
};

pub const Build = struct {
    pub fn complete(node: *Node, _: *Frame) !void {
        const self = node.as(IFrame);
        const element = self.asElement();
        self._src = element.getAttributeSafe(comptime .wrap("src")) orelse "";
        self._srcdoc = element.getAttributeSafe(comptime .wrap("srcdoc")) orelse "";
    }
};
