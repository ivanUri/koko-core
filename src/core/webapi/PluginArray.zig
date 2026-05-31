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

_pad: bool = false,

pub const MimeTypeArray = struct {
    _pad: bool = false,

    pub const IteratorValue = GenericIterator(MimeTypeIterator, null);

    pub fn getAtIndex(_: *const MimeTypeArray, index: usize) ?*MimeType {
        _ = index;
        return null;
    }

    pub fn getByName(_: *const MimeTypeArray, name: []const u8) ?*MimeType {
        _ = name;
        return null;
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
            pub const empty_with_no_proto = true;
        };

        pub const length = bridge.attribute(@as(u32, 0), .{});
        pub const @"[int]" = bridge.indexed(MimeTypeArray.getAtIndex, null, .{ .null_as_undefined = true });
        pub const @"[str]" = bridge.namedIndexed(MimeTypeArray.getByName, null, null, .{ .null_as_undefined = true });
        pub const item = bridge.function(_item, .{});
        fn _item(self: *const MimeTypeArray, index: i32) ?*MimeType {
            if (index < 0) {
                return null;
            }
            return self.getAtIndex(@intCast(index));
        }
        pub const namedItem = bridge.function(MimeTypeArray.getByName, .{});
        pub const symbol_iterator = bridge.iterator(MimeTypeArray.values, .{});
    };
};

pub const MimeTypeValueIterator = MimeTypeArray.IteratorValue;

pub const ValueIterator = GenericIterator(Iterator, null);

pub fn refresh(_: *const PluginArray) void {}
pub fn getAtIndex(_: *const PluginArray, index: usize) ?*Plugin {
    _ = index;
    return null;
}

pub fn getByName(_: *const PluginArray, name: []const u8) ?*Plugin {
    _ = name;
    return null;
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

// Cannot be constructed, and we currently never return any, so no reason to
// implement anything on it (for now)
const Plugin = struct {
    pub const JsApi = struct {
        pub const bridge = js.Bridge(Plugin);
        pub const Meta = struct {
            pub const name = "Plugin";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
            pub const empty_with_no_proto = true;
        };
    };
};

const MimeType = struct {
    pub const JsApi = struct {
        pub const bridge = js.Bridge(MimeType);
        pub const Meta = struct {
            pub const name = "MimeType";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
            pub const empty_with_no_proto = true;
        };
    };
};

pub const JsApi = struct {
    pub const bridge = js.Bridge(PluginArray);

    pub const Meta = struct {
        pub const name = "PluginArray";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
        pub const empty_with_no_proto = true;
    };

    pub const length = bridge.attribute(@as(u32, 0), .{});
    pub const refresh = bridge.function(PluginArray.refresh, .{});
    pub const @"[int]" = bridge.indexed(PluginArray.getAtIndex, null, .{ .null_as_undefined = true });
    pub const @"[str]" = bridge.namedIndexed(PluginArray.getByName, null, null, .{ .null_as_undefined = true });
    pub const item = bridge.function(_item, .{});
    fn _item(self: *const PluginArray, index: i32) ?*Plugin {
        if (index < 0) {
            return null;
        }
        return self.getAtIndex(@intCast(index));
    }
    pub const namedItem = bridge.function(PluginArray.getByName, .{});
    // Per WebIDL: PluginArray is iterable<Plugin> via its indexed properties.
    pub const symbol_iterator = bridge.iterator(PluginArray.values, .{});
};
