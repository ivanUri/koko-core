//
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

const js = @import("../js/js.zig");
const Frame = @import("../browser/Frame.zig");
const GenericIterator = @import("collections/iterator.zig").Entry;

pub fn registerTypes() []const type {
    return &.{ PluginArray, Plugin, MimeTypeArray, MimeType, ValueIterator, MimeTypeValueIterator };
}

const PluginArray = @This();

_initialized: bool = false,
_plugins: []const *Plugin = &.{},
_mime_types: MimeTypeArray = .{},

pub const MimeTypeArray = struct {
    _initialized: bool = false,
    _items: []const *MimeType = &.{},

    pub const IteratorValue = GenericIterator(MimeTypeIterator, null);

    pub fn ensureChrome(self: *MimeTypeArray, frame: *Frame) !void {
        _ = frame;
        if (self._initialized) return;
        self._initialized = true;
    }

    pub fn getLength(self: *const MimeTypeArray) u32 {
        return @intCast(self._items.len);
    }

    pub fn getAtIndex(self: *const MimeTypeArray, index: usize) ?*MimeType {
        if (index >= self._items.len) return null;
        return self._items[index];
    }

    pub fn getByName(self: *const MimeTypeArray, name: []const u8) ?*MimeType {
        for (self._items) |mime| {
            if (std.mem.eql(u8, mime._type, name)) return mime;
        }
        return null;
    }

    pub fn getIndexes(self: *const MimeTypeArray, frame: *Frame) !js.Array {
        const len = self.getLength();
        var arr = frame.js.local.?.newArray(len);
        for (0..len) |i| {
            var key_buf: [16]u8 = undefined;
            const key = try std.fmt.bufPrint(&key_buf, "{d}", .{i});
            _ = try arr.set(@intCast(i), key, .{});
        }
        return arr;
    }

    pub fn getNamedKeys(self: *const MimeTypeArray, frame: *Frame) !js.Array {
        var arr = frame.js.local.?.newArray(@intCast(self._items.len));
        for (self._items, 0..) |mime, i| {
            _ = try arr.set(@intCast(i), mime._type, .{});
        }
        return arr;
    }

    pub fn values(self: *MimeTypeArray, frame: *Frame) !*IteratorValue {
        return .init(.{ .list = self }, frame);
    }

    const MimeTypeIterator = struct {
        index: u32 = 0,
        list: *MimeTypeArray,

        pub fn next(self: *MimeTypeIterator, _: *Frame) !?*MimeType {
            const mime_type = self.list.getAtIndex(self.index) orelse return null;
            self.index += 1;
            return mime_type;
        }
    };

    pub const JsApi = struct {
        pub const bridge = js.Bridge(MimeTypeArray);

        pub const Meta = struct {
            pub const name = "MimeTypeArray";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };

        pub const length = bridge.accessor(MimeTypeArray.getLength, null, .{});
        pub const @"[int]" = bridge.indexed(MimeTypeArray.getAtIndex, MimeTypeArray.getIndexes, .{ .null_as_undefined = true, .enumerable = true });
        pub const @"[str]" = bridge.namedIndexed(MimeTypeArray.getByName, null, null, MimeTypeArray.getNamedKeys, .{ .null_as_undefined = true, .enumerable = true });
        pub const item = bridge.function(_item, .{});
        fn _item(self: *const MimeTypeArray, index: i32) ?*MimeType {
            if (index < 0) return null;
            return self.getAtIndex(@intCast(index));
        }
        pub const namedItem = bridge.function(MimeTypeArray.getByName, .{});
        pub const symbol_iterator = bridge.iterator(MimeTypeArray.values, .{});
    };
};

pub const MimeTypeValueIterator = MimeTypeArray.IteratorValue;

pub const ValueIterator = GenericIterator(Iterator, null);

const std = @import("std");

const chrome_mime_types = [_]struct {
    type: []const u8,
    suffixes: []const u8,
    description: []const u8,
}{
    .{ .type = "application/pdf", .suffixes = "pdf", .description = "Portable Document Format" },
    .{ .type = "text/pdf", .suffixes = "pdf", .description = "Portable Document Format" },
};

pub fn ensureChrome(self: *PluginArray, frame: *Frame) !void {
    if (self._initialized) return;

    const specs = frame._session.browser.app.config.profile.plugins;
    if (specs.len == 0) {
        self._initialized = true;
        return;
    }

    const mime_items = try frame.arena.alloc(*MimeType, chrome_mime_types.len);
    for (chrome_mime_types, 0..) |spec, i| {
        const mime = try frame.arena.create(MimeType);
        mime.* = .{
            ._type = spec.type,
            ._suffixes = spec.suffixes,
            ._description = spec.description,
            ._enabled_plugin = undefined,
        };
        mime_items[i] = mime;
    }
    self._mime_types._items = mime_items;
    self._mime_types._initialized = true;

    const plugin_items = try frame.arena.alloc(*Plugin, specs.len);
    for (specs, 0..) |spec, i| {
        const plugin = try frame.arena.create(Plugin);
        const mime_idx: usize = if (std.mem.eql(u8, spec.mime_type, "text/pdf")) 1 else 0;
        plugin.* = .{
            ._name = spec.name,
            ._filename = spec.filename,
            ._description = spec.description,
            ._mime_types = mime_items[mime_idx .. mime_idx + 1],
        };
        plugin_items[i] = plugin;
    }

    mime_items[0]._enabled_plugin = plugin_items[0];
    mime_items[1]._enabled_plugin = plugin_items[0];

    self._plugins = plugin_items;
    self._initialized = true;
}

pub fn refresh(_: *const PluginArray) void {}

pub fn getLength(self: *const PluginArray) u32 {
    return @intCast(self._plugins.len);
}

pub fn getAtIndex(self: *const PluginArray, index: usize) ?*Plugin {
    if (index >= self._plugins.len) return null;
    return self._plugins[index];
}

pub fn getByName(self: *const PluginArray, name: []const u8) ?*Plugin {
    for (self._plugins) |plugin| {
        if (std.mem.eql(u8, plugin._name, name)) return plugin;
    }
    return null;
}

pub fn getIndexes(self: *const PluginArray, frame: *Frame) !js.Array {
    const len = self.getLength();
    var arr = frame.js.local.?.newArray(len);
    for (0..len) |i| {
        var key_buf: [16]u8 = undefined;
        const key = try std.fmt.bufPrint(&key_buf, "{d}", .{i});
        _ = try arr.set(@intCast(i), key, .{});
    }
    return arr;
}

pub fn getNamedKeys(self: *const PluginArray, frame: *Frame) !js.Array {
    var arr = frame.js.local.?.newArray(@intCast(self._plugins.len));
    for (self._plugins, 0..) |plugin, i| {
        _ = try arr.set(@intCast(i), plugin._name, .{});
    }
    return arr;
}

pub fn getMimeTypes(self: *PluginArray) *MimeTypeArray {
    return &self._mime_types;
}

pub fn values(self: *PluginArray, frame: *Frame) !*ValueIterator {
    return .init(.{ .list = self }, frame);
}

const Iterator = struct {
    index: u32 = 0,
    list: *PluginArray,

    pub fn next(self: *Iterator, _: *Frame) !?*Plugin {
        const plugin = self.list.getAtIndex(self.index) orelse return null;
        self.index += 1;
        return plugin;
    }
};

pub const Plugin = struct {
    _pad: bool = false,
    _name: []const u8 = "",
    _filename: []const u8 = "",
    _description: []const u8 = "",
    _mime_types: []const *MimeType = &.{},

    pub fn getName(self: *const Plugin) []const u8 {
        return self._name;
    }

    pub fn getFilename(self: *const Plugin) []const u8 {
        return self._filename;
    }

    pub fn getDescription(self: *const Plugin) []const u8 {
        return self._description;
    }

    pub fn getLength(self: *const Plugin) u32 {
        return @intCast(self._mime_types.len);
    }

    pub fn getAtIndex(self: *const Plugin, index: usize) ?*MimeType {
        if (index >= self._mime_types.len) return null;
        return self._mime_types[index];
    }

    pub fn getByName(self: *const Plugin, name: []const u8) ?*MimeType {
        for (self._mime_types) |mime| {
            if (std.mem.eql(u8, mime._type, name)) return mime;
        }
        return null;
    }

    pub fn getVersion(_: *const Plugin) ?[]const u8 {
        return null;
    }

    pub fn getIndexes(self: *const Plugin, frame: *Frame) !js.Array {
        const len = self.getLength();
        var arr = frame.js.local.?.newArray(len);
        for (0..len) |i| {
            var key_buf: [16]u8 = undefined;
            const key = try std.fmt.bufPrint(&key_buf, "{d}", .{i});
            _ = try arr.set(@intCast(i), key, .{});
        }
        return arr;
    }

    pub fn getNamedKeys(self: *const Plugin, frame: *Frame) !js.Array {
        var arr = frame.js.local.?.newArray(@intCast(self._mime_types.len));
        for (self._mime_types, 0..) |mime, i| {
            _ = try arr.set(@intCast(i), mime._type, .{});
        }
        return arr;
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(Plugin);

        pub const Meta = struct {
            pub const name = "Plugin";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };

        pub const name = bridge.accessor(Plugin.getName, null, .{});
        pub const filename = bridge.accessor(Plugin.getFilename, null, .{});
        pub const description = bridge.accessor(Plugin.getDescription, null, .{});
        pub const version = bridge.accessor(Plugin.getVersion, null, .{ .null_as_undefined = true });
        pub const length = bridge.accessor(Plugin.getLength, null, .{});
        pub const @"[int]" = bridge.indexed(Plugin.getAtIndex, Plugin.getIndexes, .{ .null_as_undefined = true, .enumerable = true });
        pub const @"[str]" = bridge.namedIndexed(Plugin.getByName, null, null, Plugin.getNamedKeys, .{ .null_as_undefined = true, .enumerable = true });
        pub const item = bridge.function(_item, .{});
        fn _item(self: *const Plugin, index: i32) ?*MimeType {
            if (index < 0) return null;
            return self.getAtIndex(@intCast(index));
        }
        pub const namedItem = bridge.function(Plugin.getByName, .{});
    };
};

pub const MimeType = struct {
    _pad: bool = false,
    _type: []const u8 = "",
    _suffixes: []const u8 = "",
    _description: []const u8 = "",
    _enabled_plugin: *Plugin = undefined,

    pub fn getType(self: *const MimeType) []const u8 {
        return self._type;
    }

    pub fn getSuffixes(self: *const MimeType) []const u8 {
        return self._suffixes;
    }

    pub fn getDescription(self: *const MimeType) []const u8 {
        return self._description;
    }

    pub fn getEnabledPlugin(self: *const MimeType) *Plugin {
        return self._enabled_plugin;
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(MimeType);

        pub const Meta = struct {
            pub const name = "MimeType";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };

        pub const @"type" = bridge.accessor(MimeType.getType, null, .{});
        pub const suffixes = bridge.accessor(MimeType.getSuffixes, null, .{});
        pub const description = bridge.accessor(MimeType.getDescription, null, .{});
        pub const enabledPlugin = bridge.accessor(MimeType.getEnabledPlugin, null, .{});
    };
};

pub const JsApi = struct {
    pub const bridge = js.Bridge(PluginArray);

    pub const Meta = struct {
        pub const name = "PluginArray";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const length = bridge.accessor(PluginArray.getLength, null, .{});
    pub const refresh = bridge.function(PluginArray.refresh, .{});
    pub const @"[int]" = bridge.indexed(PluginArray.getAtIndex, PluginArray.getIndexes, .{ .null_as_undefined = true, .enumerable = true });
    pub const @"[str]" = bridge.namedIndexed(PluginArray.getByName, null, null, PluginArray.getNamedKeys, .{ .null_as_undefined = true, .enumerable = true });
    pub const item = bridge.function(_item, .{});
    fn _item(self: *const PluginArray, index: i32) ?*Plugin {
        if (index < 0) return null;
        return self.getAtIndex(@intCast(index));
    }
    pub const namedItem = bridge.function(PluginArray.getByName, .{});
    pub const symbol_iterator = bridge.iterator(PluginArray.values, .{});
};
