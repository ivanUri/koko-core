const std = @import("std");

const js = @import("../js/js.zig");
const Frame = @import("../browser/Frame.zig");
const Element = @import("Element.zig");
const Node = @import("Node.zig");
const TreeWalker = @import("TreeWalker.zig");
const String = @import("../../support/string.zig").String;
const TaggedOpaque = @import("../js/TaggedOpaque.zig");

pub const Attr = enum(u8) {
    aria_active_descendant,
    aria_describedby,

    pub fn contentName(self: Attr) []const u8 {
        return switch (self) {
            .aria_active_descendant => "aria-activedescendant",
            .aria_describedby => "aria-describedby",
        };
    }
};

pub const Lookup = std.AutoHashMapUnmanaged(u64, []const *Element);

fn key(owner: *const Element, attr: Attr) u64 {
    return (@as(u64, @intFromPtr(owner)) << 8) | @intFromEnum(attr);
}

pub fn clear(owner: *const Element, attr: Attr, frame: *Frame) void {
    _ = frame._attr_associated_elements.remove(key(owner, attr));
}

fn store(owner: *Element, attr: Attr, elements: []const *Element, frame: *Frame) !void {
    const slice = try frame.arena.dupe(*Element, elements);
    try frame._attr_associated_elements.put(frame.arena, key(owner, attr), slice);
}

fn stored(owner: *const Element, attr: Attr, frame: *Frame) ?[]const *Element {
    return frame._attr_associated_elements.get(key(owner, attr));
}

fn resolveIdref(owner: *const Element, token: []const u8, frame: *Frame) ?*Element {
    if (frame.document.getElementById(token, frame)) |el| return el;

    var root = @constCast(owner).asNode();
    while (root._parent) |parent| root = parent;

    var tw = TreeWalker.Full.Elements.init(root, .{});
    while (tw.next()) |el| {
        const element_id = el.getAttributeSafe(String.wrap("id")) orelse continue;
        if (std.mem.eql(u8, element_id, token)) return el;
    }
    return null;
}

fn resolveIdrefs(owner: *const Element, attr_value: []const u8, frame: *Frame) ![]const *Element {
    var list: std.ArrayListUnmanaged(*Element) = .empty;
    errdefer list.deinit(frame.arena);

    var it = std.mem.tokenizeAny(u8, attr_value, &std.ascii.whitespace);
    while (it.next()) |token| {
        if (token.len == 0) continue;
        if (resolveIdref(owner, token, frame)) |el| {
            try list.append(frame.arena, el);
        }
    }
    return try list.toOwnedSlice(frame.arena);
}

fn elementsFromJsValue(value: js.Value, frame: *Frame) ![]const *Element {
    if (value.isNullOrUndefined()) return &.{};

    if (value.isArray()) {
        const arr = value.toArray();
        var list: std.ArrayListUnmanaged(*Element) = .empty;
        errdefer list.deinit(frame.arena);
        const len: u32 = @intCast(arr.len());
        var i: u32 = 0;
        while (i < len) : (i += 1) {
            const item = try arr.get(i);
            const obj = item.toObject();
            const el = try TaggedOpaque.fromJS(*Element, obj.handle);
            try list.append(frame.arena, el);
        }
        return try list.toOwnedSlice(frame.arena);
    }

    const obj = value.toObject();
    const el = try TaggedOpaque.fromJS(*Element, obj.handle);
    return try frame.arena.dupe(*Element, &.{el});
}

fn elementsToArray(elements: []const *Element, frame: *Frame) !js.Array {
    const local = frame.js.local orelse return error.NotHandled;
    var arr = local.newArray(@intCast(elements.len));
    for (elements, 0..) |el, i| {
        _ = try arr.set(@intCast(i), el, .{});
    }
    return arr;
}

pub fn getSingle(self: *const Element, attr: Attr, frame: *Frame) !?*Element {
    const content_attr = attr.contentName();
    const attr_value = self.getAttributeSafe(String.wrap(content_attr));

    if (attr_value) |value| {
        if (value.len == 0) {
            const owned = stored(self, attr, frame) orelse return null;
            return if (owned.len > 0) owned[0] else null;
        }
        const resolved = try resolveIdrefs(self, value, frame);
        return if (resolved.len > 0) resolved[0] else null;
    }

    return null;
}

pub fn getArray(self: *const Element, attr: Attr, frame: *Frame) !?js.Array {
    const content_attr = attr.contentName();
    const attr_value = self.getAttributeSafe(String.wrap(content_attr)) orelse return null;

    if (attr_value.len == 0) {
        const owned = stored(self, attr, frame) orelse return try elementsToArray(&.{}, frame);
        return try elementsToArray(owned, frame);
    }
    const resolved = try resolveIdrefs(self, attr_value, frame);
    return try elementsToArray(resolved, frame);
}

pub fn set(self: *Element, attr: Attr, value: js.Value, frame: *Frame) !void {
    const content_attr = attr.contentName();
    if (value.isNullOrUndefined()) {
        clear(self, attr, frame);
        try self.removeAttribute(String.wrap(content_attr), frame);
        return;
    }

    const elements = try elementsFromJsValue(value, frame);
    try self.setAttributeSafe(String.wrap(content_attr), .wrap(""), frame);
    try store(self, attr, elements, frame);
}

pub fn onAttributeRemoved(self: *const Element, name: []const u8, frame: *Frame) void {
    inline for (@typeInfo(Attr).@"enum".fields) |field| {
        const attr: Attr = @enumFromInt(field.value);
        if (std.mem.eql(u8, name, attr.contentName())) {
            clear(self, attr, frame);
        }
    }
}
