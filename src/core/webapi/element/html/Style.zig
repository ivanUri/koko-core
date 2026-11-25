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
const log = @import("../../../../support/log.zig");

const Node = @import("../../../dom/Node.zig");
const Element = @import("../../../dom/Element.zig");
const HtmlElement = @import("../Html.zig");
const ShadowRoot = @import("../../ShadowRoot.zig");

const Style = @This();
_proto: *HtmlElement,
_sheet: ?*CSSStyleSheet = null,
_scope: ?*ShadowRoot = null,
_scope_sheet: ?*CSSStyleSheet = null,
_registered_in_document: bool = false,
_registered_sheet: ?*CSSStyleSheet = null,

pub fn asElement(self: *Style) *Element {
    return self._proto._proto;
}
pub fn asConstElement(self: *const Style) *const Element {
    return self._proto._proto;
}
pub fn asNode(self: *Style) *Node {
    return self.asElement().asNode();
}

// Attribute-backed properties

pub fn getBlocking(self: *const Style) []const u8 {
    return self.asConstElement().getAttributeSafe(comptime .wrap("blocking")) orelse "";
}

pub fn setBlocking(self: *Style, value: []const u8, frame: *Frame) !void {
    try self.asElement().setAttributeSafe(comptime .wrap("blocking"), .wrap(value), frame);
}

pub fn getMedia(self: *const Style) []const u8 {
    return self.asConstElement().getAttributeSafe(comptime .wrap("media")) orelse "";
}

pub fn setMedia(self: *Style, value: []const u8, frame: *Frame) !void {
    try self.asElement().setAttributeSafe(comptime .wrap("media"), .wrap(value), frame);
}

pub fn getType(self: *const Style) []const u8 {
    return self.asConstElement().getAttributeSafe(comptime .wrap("type")) orelse "text/css";
}

pub fn setType(self: *Style, value: []const u8, frame: *Frame) !void {
    try self.asElement().setAttributeSafe(comptime .wrap("type"), .wrap(value), frame);
}

pub fn getDisabled(self: *const Style) bool {
    return self.asConstElement().getAttributeSafe(comptime .wrap("disabled")) != null;
}

pub fn setDisabled(self: *Style, disabled: bool, frame: *Frame) !void {
    if (disabled) {
        try self.asElement().setAttributeSafe(comptime .wrap("disabled"), .wrap(""), frame);
    } else {
        try self.asElement().removeAttribute(comptime .wrap("disabled"), frame);
    }
}

const CSSStyleSheet = @import("../../css/CSSStyleSheet.zig");

fn containingShadowRoot(self: *Style) ?*ShadowRoot {
    var parent = self.asNode().parentNode();
    var depth: u32 = 0;
    while (parent) |node| {
        depth += 1;
        if (depth > 4096) return null;
        if (node.is(ShadowRoot)) |root| return root;
        parent = node.parentNode();
    }
    return null;
}

fn detachScope(self: *Style) void {
    if (self._scope) |scope| {
        if (self._scope_sheet) |sheet| {
            scope.unregisterScopedStyleSheet(sheet);
        }
    }
    self._scope = null;
    self._scope_sheet = null;
}

pub fn getSheet(self: *Style, frame: *Frame) !?*CSSStyleSheet {
    const owner_frame = self.asNode().ownerFrame(frame);
    const scope = containingShadowRoot(self);
    // Prefer the frame argument over ownerFrame()/isConnected() parent walks.
    // Document parse after re-nav (Google knitsail → Bing) UAF'd walking _parent.
    const in_document_parse = owner_frame._document_parse_active and owner_frame._parse_mode == .document;
    // Shadow trees are connected through their host even though the generic
    // Node.isConnected implementation only walks the light-DOM parent chain.
    // Keep their scoped sheet eligible for the Stylo snapshot until the root
    // itself is detached; otherwise a first computed-style read silently
    // drops every <style> sheet inside a ShadowRoot.
    if (!in_document_parse and !self.asNode().isConnected() and scope == null) {
        self.detachScope();
        if (self._registered_in_document) {
            if (owner_frame.document.getStyleSheets(owner_frame) catch null) |sheets| {
                if (self._registered_sheet) |sheet| sheets.remove(sheet);
            }
            self._registered_in_document = false;
            self._registered_sheet = null;
        }
        self._sheet = null;
        return null;
    }
    // Per spec, sheet is null for non-CSS types.
    // Valid types: absent (defaults to "text/css"), empty string, or
    // case-insensitive match for "text/css".
    const t = self.getType();
    if (t.len != 0 and !std.ascii.eqlIgnoreCase(t, "text/css")) {
        self.detachScope();
        if (self._registered_in_document) {
            if (owner_frame.document.getStyleSheets(owner_frame) catch null) |sheets| {
                if (self._registered_sheet) |registered_sheet| sheets.remove(registered_sheet);
            }
            self._registered_in_document = false;
            self._registered_sheet = null;
        }
        self._sheet = null;
        return null;
    }

    const sheet = self._sheet orelse blk: {
        const created = try CSSStyleSheet.initWithOwner(self.asElement(), owner_frame);
        self._sheet = created;
        break :blk created;
    };

    if (scope) |shadow_root| {
        if (self._scope != shadow_root or self._scope_sheet != sheet) {
            // Register before removing the old scope so a failed allocation
            // leaves the current stylesheet ownership usable.
            try shadow_root.registerScopedStyleSheet(sheet);
            self.detachScope();
            if (self._registered_in_document) {
                if (owner_frame.document.getStyleSheets(owner_frame) catch null) |sheets| {
                    if (self._registered_sheet) |registered_sheet| sheets.remove(registered_sheet);
                }
                self._registered_in_document = false;
                self._registered_sheet = null;
            }
            self._scope = shadow_root;
            self._scope_sheet = sheet;
        }
    } else if (self._scope != null or self._scope_sheet != null or !self._registered_in_document or self._registered_sheet != sheet) {
        const sheets = try owner_frame.document.getStyleSheets(owner_frame);
        if (!self._registered_in_document or self._registered_sheet != sheet) {
            if (self._registered_sheet) |registered_sheet| {
                sheets.remove(registered_sheet);
            }
            try sheets.add(sheet, owner_frame);
            self._registered_in_document = true;
            self._registered_sheet = sheet;
        }
        self.detachScope();
    }

    return self._sheet;
}

pub fn sourceTextChanged(self: *Style) void {
    if (self._sheet) |sheet| sheet.sourceTextChanged();
}

pub fn styleAddedCallback(self: *Style, frame: *Frame) !void {
    const owner_frame = self.asNode().ownerFrame(frame);
    // Main-document HTML parse: do not allocate StyleSheetList / CSSStyleSheet
    // mid-html5ever. After Google knitsail re-nav, ArrayList growth there
    // SIGSEGV'd (Google Search → Bing). Mark StyleManager dirty; sheet is
    // created lazily on document.styleSheets / getSheet after parse.
    const mid_document_parse = owner_frame._document_parse_active and owner_frame._parse_mode == .document;
    if (mid_document_parse) {
        owner_frame.styleSheetChanged(self.asNode());
        return;
    }

    // Dynamic insert / fragment: register sheet now (spec + CSSOM probes).
    const sheet = self.getSheet(owner_frame) catch |err| blk: {
        log.warn(.frame, "style sheet register", .{ .err = err, .url = owner_frame.url });
        break :blk null;
    };
    if (sheet != null) {
        owner_frame.styleSheetChanged(self.asNode());
    }

    if (owner_frame.isGoingAway()) {
        return;
    }

    owner_frame.queueLoad(self._proto) catch |err| {
        log.warn(.frame, "style queueLoad", .{ .err = err, .url = owner_frame.url });
    };
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(Style);

    pub const Meta = struct {
        pub const name = "HTMLStyleElement";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const blocking = bridge.accessor(Style.getBlocking, Style.setBlocking, .{});
    pub const media = bridge.accessor(Style.getMedia, Style.setMedia, .{});
    pub const @"type" = bridge.accessor(Style.getType, Style.setType, .{});
    pub const disabled = bridge.accessor(Style.getDisabled, Style.setDisabled, .{});
    pub const sheet = bridge.accessor(Style.getSheet, null, .{});
};

const testing = @import("../../../../testing/testing.zig");
test "WebApi: Style" {
    try testing.htmlRunner("element/html/style.html", .{});
}
