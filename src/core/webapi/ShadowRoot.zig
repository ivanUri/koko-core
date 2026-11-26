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
const js = @import("../js/js.zig");

const Frame = @import("../browser/Frame.zig");
const Node = @import("../dom/Node.zig");
const DocumentFragment = @import("../dom/DocumentFragment.zig");
const Element = @import("../dom/Element.zig");
const CSSStyleSheet = @import("css/CSSStyleSheet.zig");

const ShadowRoot = @This();

pub const Mode = enum {
    open,
    closed,

    pub fn fromString(str: []const u8) !Mode {
        return std.meta.stringToEnum(Mode, str) orelse error.InvalidMode;
    }
};

_proto: *DocumentFragment,
_mode: Mode,
_host: *Element,
_owner_frame: *Frame,
_elements_by_id: std.StringHashMapUnmanaged(*Element) = .{},
_removed_ids: std.StringHashMapUnmanaged(void) = .{},
_adopted_style_sheets: ?js.Object.Global = null,
_adopted_style_sheet_items: std.ArrayListUnmanaged(*CSSStyleSheet) = .empty,
_scoped_style_sheets: std.ArrayListUnmanaged(*CSSStyleSheet) = .empty,

pub fn init(host: *Element, mode: Mode, frame: *Frame) !*ShadowRoot {
    return frame._factory.documentFragment(ShadowRoot{
        ._proto = undefined,
        ._mode = mode,
        ._host = host,
        ._owner_frame = frame,
    });
}

pub fn asDocumentFragment(self: *ShadowRoot) *DocumentFragment {
    return self._proto;
}

pub fn asNode(self: *ShadowRoot) *Node {
    return self._proto.asNode();
}

pub fn asEventTarget(self: *ShadowRoot) *@import("EventTarget.zig") {
    return self.asNode().asEventTarget();
}

pub fn getMode(self: *const ShadowRoot) []const u8 {
    return @tagName(self._mode);
}

pub fn getHost(self: *const ShadowRoot) *Element {
    return self._host;
}

pub fn getElementById(self: *ShadowRoot, id: []const u8, frame: *Frame) ?*Element {
    if (id.len == 0) {
        return null;
    }

    // Fast path: ID is in the map
    if (self._elements_by_id.get(id)) |element| {
        return element;
    }

    // Slow path: id map miss (shadow DOM innerHTML may skip indexing).
    _ = self._removed_ids.remove(id);
    var tw = @import("../dom/TreeWalker.zig").Full.Elements.init(self.asNode(), .{});
    while (tw.next()) |el| {
        const element_id = el.getAttributeSafe(comptime .wrap("id")) orelse continue;
        if (std.mem.eql(u8, element_id, id)) {
            const owned_id = frame.dupeString(id) catch return null;
            self._elements_by_id.put(frame.arena, owned_id, el) catch return null;
            return el;
        }
    }

    return null;
}

pub fn registerScopedStyleSheet(self: *ShadowRoot, sheet: *CSSStyleSheet) !void {
    for (self._scoped_style_sheets.items) |existing| {
        if (existing == sheet) return;
    }
    try sheet.registerStyleScopeOwner(self._owner_frame);
    errdefer sheet.unregisterStyleScopeOwner(self._owner_frame);
    try self._scoped_style_sheets.append(self._owner_frame.arena, sheet);
}

pub fn unregisterScopedStyleSheet(self: *ShadowRoot, sheet: *CSSStyleSheet) void {
    for (self._scoped_style_sheets.items, 0..) |existing, index| {
        if (existing != sheet) continue;
        _ = self._scoped_style_sheets.swapRemove(index);
        sheet.unregisterStyleScopeOwner(self._owner_frame);
        return;
    }
}

pub fn scopedStyleSheets(self: *const ShadowRoot) []const *CSSStyleSheet {
    return self._scoped_style_sheets.items;
}

pub fn adoptedStyleSheetsNative(self: *const ShadowRoot) []const *CSSStyleSheet {
    return self._adopted_style_sheet_items.items;
}

fn sameStyleSheetList(left: []const *CSSStyleSheet, right: []const *CSSStyleSheet) bool {
    if (left.len != right.len) return false;
    for (left, right) |a, b| {
        if (a != b) return false;
    }
    return true;
}

pub fn getAdoptedStyleSheets(self: *ShadowRoot, frame: *Frame) !js.Object.Global {
    if (self._adopted_style_sheets) |ass| {
        return ass;
    }

    // Layout and observer callbacks may enter from Zig without an active V8
    // Caller. Create the persistent JS value in the shadow root's owner realm
    // instead of assuming that a native callback already has a Local scope.
    _ = frame;
    const owner_frame = self._owner_frame;
    const had_local = owner_frame.js.local != null;
    var owned_scope: js.Local.Scope = undefined;
    const local = if (owner_frame.js.local) |active| active else blk: {
        if (!owner_frame.js.tryLocalScope(&owned_scope)) return error.InvalidState;
        break :blk &owned_scope.local;
    };
    defer if (!had_local) owned_scope.deinit();

    const js_arr = local.newArray(0);
    const js_obj = js_arr.toObject();
    self._adopted_style_sheets = try js_obj.persist();
    return self._adopted_style_sheets.?;
}

pub fn setAdoptedStyleSheets(self: *ShadowRoot, sheets: js.Object) !void {
    const value = sheets.toValue();
    if (!value.isArray()) return error.InvalidArgument;

    const input = value.toArray();
    var next: std.ArrayListUnmanaged(*CSSStyleSheet) = .empty;
    defer next.deinit(self._owner_frame.call_arena);

    const local = self._owner_frame.js.local orelse return error.InvalidState;
    var snapshot = local.newArray(@intCast(input.len()));
    for (0..input.len()) |index| {
        const item = try input.get(@intCast(index));
        const sheet = try item.toZig(*CSSStyleSheet);
        // A stylesheet with an owner node is tied to its <style>/<link>
        // element and is not a constructable sheet.  Keeping that distinction
        // prevents a document-owned sheet from being registered in a shadow
        // scope whose lifecycle it does not follow.
        if (sheet.getOwnerNode() != null) return error.InvalidArgument;
        try next.append(self._owner_frame.call_arena, sheet);
        if (!(try snapshot.set(@intCast(index), item, .{}))) return error.JsException;
    }

    if (sameStyleSheetList(self._adopted_style_sheet_items.items, next.items)) return;
    self._adopted_style_sheet_items.ensureTotalCapacity(self._owner_frame.arena, next.items.len) catch |err| return err;

    // Register the new set first.  If an allocator or JS persistence failure
    // occurs, roll back only the references added by this assignment and keep
    // the previous adopted set intact.
    var registered: usize = 0;
    while (registered < next.items.len) : (registered += 1) {
        next.items[registered].registerStyleScopeOwner(self._owner_frame) catch |err| {
            for (next.items[0..registered]) |registered_sheet| {
                registered_sheet.unregisterStyleScopeOwner(self._owner_frame);
            }
            return err;
        };
    }
    const persisted = snapshot.toObject().persist() catch |err| {
        for (next.items) |registered_sheet| {
            registered_sheet.unregisterStyleScopeOwner(self._owner_frame);
        }
        return err;
    };

    for (self._adopted_style_sheet_items.items) |old_sheet| {
        old_sheet.unregisterStyleScopeOwner(self._owner_frame);
    }
    self._adopted_style_sheet_items.clearRetainingCapacity();
    self._adopted_style_sheet_items.appendSliceAssumeCapacity(next.items);
    self._adopted_style_sheets = persisted;

    if (!self._owner_frame.isGoingAway()) {
        self._owner_frame.adoptedStyleSheetsChanged();
    }
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(ShadowRoot);

    pub const Meta = struct {
        pub const name = "ShadowRoot";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const mode = bridge.accessor(ShadowRoot.getMode, null, .{});
    pub const host = bridge.accessor(ShadowRoot.getHost, null, .{});
    pub const getElementById = bridge.function(_getElementById, .{});
    fn _getElementById(self: *ShadowRoot, value_: ?js.Value, frame: *Frame) !?*Element {
        const value = value_ orelse return null;
        if (value.isNull()) {
            return self.getElementById("null", frame);
        }
        if (value.isUndefined()) {
            return self.getElementById("undefined", frame);
        }
        return self.getElementById(try value.toZig([]const u8), frame);
    }
    pub const adoptedStyleSheets = bridge.accessor(ShadowRoot.getAdoptedStyleSheets, ShadowRoot.setAdoptedStyleSheets, .{});
};

const testing = @import("../../testing/testing.zig");
test "WebApi: ShadowRoot" {
    try testing.htmlRunner("shadowroot", .{});
}
