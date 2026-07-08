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

const js = @import("../../js/js.zig");

const FormData = @import("FormData.zig");
const KeyValueList = @import("../KeyValueList.zig");
const TaggedOpaque = @import("../../js/TaggedOpaque.zig");

const log = @import("../../../support/log.zig");
const String = @import("../../../support/string.zig").String;
const Execution = js.Execution;
const Allocator = std.mem.Allocator;

const URLSearchParams = @This();

_arena: Allocator,
_params: KeyValueList,
/// True after mutating ops while linked to a `URL` via `getSearchParams`.
_mutated: bool = false,

pub fn initFromQueryString(query_string: []const u8, exec: *const Execution) !*URLSearchParams {
    const arena = exec.arena;
    const params = try paramsFromString(arena, query_string, exec.buf, .from_url);
    return exec._factory.create(URLSearchParams{
        ._arena = arena,
        ._params = params,
    });
}

pub fn init(init_val: ?js.Value, exec: *const Execution) !*URLSearchParams {
    const arena = exec.arena;
    const params: KeyValueList = if (init_val) |js_val| blk: {
        // Order matters here; Array is also an Object.
        if (isJsArray(js_val)) {
            break :blk try paramsFromArray(arena, js_val.toArray());
        }
        if (js_val.isObject()) {
            const obj = js_val.toObject();

            if (try hasIterator(obj, exec)) {
                break :blk try paramsFromIterator(arena, obj, exec);
            }

            // Functions (e.g. DOMException) are objects but use record serialization, not branding.
            if (!js_val.isFunction()) {
                // DOMException.prototype carries legacy numeric constants; reject before record init.
                if (obj.has("INDEX_SIZE_ERR")) return error.TypeError;
                if (TaggedOpaque.fromJS(*URLSearchParams, @ptrCast(obj.handle)) catch null) |usp| {
                    break :blk try KeyValueList.copy(arena, usp._params);
                }
                if (TaggedOpaque.fromJS(*FormData, @ptrCast(obj.handle)) catch null) |fd| {
                    break :blk try fd.toKeyValueList(arena);
                }
                if (isRejectedObjectInit(obj, exec)) return error.TypeError;
            }
            // normalizer is null, so frame won't be used
            break :blk try KeyValueList.fromJsObject(arena, obj, null, exec.buf);
        }
        if (js_val.isString()) |js_str| {
            break :blk try paramsFromString(arena, try js_str.toSliceWithAlloc(arena), exec.buf, .from_string);
        }
        return error.InvalidArgument;
    } else .empty;

    return exec._factory.create(URLSearchParams{
        ._arena = arena,
        ._params = params,
    });
}

pub fn updateFromString(self: *URLSearchParams, query_string: []const u8, exec: *const Execution) !void {
    self._params = try paramsFromString(self._arena, query_string, exec.buf, .from_url);
    self._mutated = false;
}

pub fn isMutated(self: *const URLSearchParams) bool {
    return self._mutated;
}

fn markMutated(self: *URLSearchParams) void {
    self._mutated = true;
}

pub fn getSize(self: *const URLSearchParams) usize {
    return self._params.len();
}

pub fn get(self: *const URLSearchParams, name: []const u8) ?[]const u8 {
    return self._params.get(name);
}

pub fn getAll(self: *const URLSearchParams, name: []const u8, exec: *const Execution) ![]const []const u8 {
    return self._params.getAll(exec.call_arena, name);
}

pub fn has(self: *const URLSearchParams, name: []const u8, value: ?[]const u8) bool {
    if (value) |v| {
        return self._params.hasPair(name, v);
    }
    return self._params.has(name);
}

pub fn set(self: *URLSearchParams, name: []const u8, value: []const u8) !void {
    try self._params.set(self._arena, name, value);
    self.markMutated();
}

pub fn append(self: *URLSearchParams, name: []const u8, value: []const u8) !void {
    try self._params.append(self._arena, name, value);
    self.markMutated();
}

pub fn delete(self: *URLSearchParams, name: []const u8, value: ?[]const u8) void {
    self._params.delete(name, value);
    self.markMutated();
}

pub fn keys(self: *URLSearchParams, exec: *const Execution) !*KeyValueList.KeyIterator {
    return KeyValueList.KeyIterator.init(.{ .list = self, .kv = &self._params }, exec);
}

pub fn values(self: *URLSearchParams, exec: *const Execution) !*KeyValueList.ValueIterator {
    return KeyValueList.ValueIterator.init(.{ .list = self, .kv = &self._params }, exec);
}

pub fn entries(self: *URLSearchParams, exec: *const Execution) !*KeyValueList.EntryIterator {
    return KeyValueList.EntryIterator.init(.{ .list = self, .kv = &self._params }, exec);
}

pub fn toString(self: *const URLSearchParams, writer: *std.Io.Writer) !void {
    // URLSearchParams always uses UTF-8 per the URL Standard
    return self._params.urlEncode(.query, null, "UTF-8", writer);
}

pub fn format(self: *const URLSearchParams, writer: *std.Io.Writer) !void {
    return self.toString(writer);
}

pub fn forEach(self: *URLSearchParams, cb_: js.Function, js_this_: ?js.Object) !void {
    const cb = if (js_this_) |js_this| try cb_.withThis(js_this) else cb_;

    for (self._params._entries.items) |entry| {
        cb.call(void, .{ entry.value.str(), entry.name.str(), self }) catch |err| {
            // this is a non-JS error
            log.warn(.js, "URLSearchParams.forEach", .{ .err = err });
        };
    }
}

pub fn sort(self: *URLSearchParams) void {
    std.mem.sort(KeyValueList.Entry, self._params._entries.items, {}, struct {
        fn cmp(_: void, a: KeyValueList.Entry, b: KeyValueList.Entry) bool {
            return KeyValueList.cmpUtf16CodeUnits(a.name.str(), b.name.str()) == .lt;
        }
    }.cmp);
    self.markMutated();
}

fn isJsArray(val: js.Value) bool {
    if (val.isArray()) return true;
    if (!val.isObject()) return false;
    return js.v8.v8__Value__IsArray(@ptrCast(val.toObject().handle));
}

fn isRejectedObjectInit(obj: js.Object, exec: *const Execution) bool {
    if (isInterfacePrototype(obj)) return true;
    if (isKnownInterfacePrototype(obj, exec)) return true;
    if (hasErrorPrototypeParent(obj, exec)) return true;
    // DOMException.prototype: legacy constants + Error.prototype in chain.
    if (obj.has("INDEX_SIZE_ERR") and hasErrorPrototypeParent(obj, exec)) return true;
    return false;
}

fn hasErrorPrototypeParent(obj: js.Object, exec: *const Execution) bool {
    const local = exec.context.local orelse return false;
    const global = js.Object{
        .local = local,
        .handle = js.v8.v8__Context__Global(local.handle).?,
    };
    const error_val = global.get("Error") catch return false;
    if (!error_val.isFunction()) return false;
    const error_proto_val = error_val.toObject().get("prototype") catch return false;
    if (!error_proto_val.isObject()) return false;
    const parent = js.v8.v8__Object__GetPrototype(obj.handle) orelse return false;
    return parent == error_proto_val.toObject().handle;
}

fn isInterfacePrototype(obj: js.Object) bool {
    const ctor_val = obj.get("constructor") catch return false;
    if (!ctor_val.isFunction()) return false;

    const ctor_obj = js.Object{ .local = obj.local, .handle = @ptrCast(ctor_val.handle) };
    const proto_val = ctor_obj.get("prototype") catch return false;
    if (!proto_val.isObject()) return false;

    return proto_val.toObject().handle == obj.handle;
}

fn isKnownInterfacePrototype(obj: js.Object, exec: *const Execution) bool {
    const local = exec.context.local orelse return false;
    const global = js.Object{
        .local = local,
        .handle = js.v8.v8__Context__Global(local.handle).?,
    };

    const known = [_][]const u8{
        "DOMException",
        "Event",
        "Node",
        "Element",
        "URLSearchParams",
        "FormData",
    };
    for (known) |iface| {
        const binding = global.get(iface) catch continue;
        if (!binding.isFunction()) continue;
        const proto_val = binding.toObject().get("prototype") catch continue;
        if (!proto_val.isObject()) continue;
        if (proto_val.toObject().handle == obj.handle) return true;
    }
    return false;
}

fn getBySymbol(obj: js.Object, local: *const js.Local, symbol: *const js.v8.Symbol) !js.Value {
    const js_val_handle = js.v8.v8__Object__Get(obj.handle, local.handle, @ptrCast(symbol)) orelse return error.JsException;
    return .{ .local = local, .handle = js_val_handle };
}

fn hasIterator(obj: js.Object, exec: *const Execution) !bool {
    const local = exec.context.local orelse return false;
    const iterator_sym = js.v8.v8__Symbol__GetIterator(local.isolate.handle).?;
    const val = getBySymbol(obj, local, iterator_sym) catch return false;
    return val.isFunction();
}

fn paramsFromIterator(allocator: Allocator, obj: js.Object, exec: *const Execution) !KeyValueList {
    const local = exec.context.local orelse return error.InvalidArgument;
    const iterator_sym = js.v8.v8__Symbol__GetIterator(local.isolate.handle).?;
    const iter_method = try getBySymbol(obj, local, iterator_sym);
    if (!iter_method.isFunction()) return error.InvalidArgument;

    const iter_fn = js.Function{ .local = local, .handle = @ptrCast(iter_method.handle) };
    const iter_val = try iter_fn.callWithThis(js.Value, obj, .{});
    const iter_obj = iter_val.toObject();

    var params = KeyValueList.init();
    while (true) {
        const step = try iter_obj.callMethod(js.Value, "next", .{});
        const step_obj = step.toObject();
        const done_val = try step_obj.get("done");
        if (done_val.isTrue()) break;

        const value_val = try step_obj.get("value");
        if (!value_val.isArray()) return error.TypeError;

        const pair = value_val.toArray();
        if (pair.len() != 2) return error.TypeError;

        const name_val = try pair.get(0);
        const val_val = try pair.get(1);
        if (name_val.isString() == null or val_val.isString() == null) return error.TypeError;

        try params.append(allocator, try (try name_val.toString()).toSliceWithAlloc(allocator), try (try val_val.toString()).toSliceWithAlloc(allocator));
    }

    return params;
}

fn paramsFromArray(allocator: Allocator, array: js.Array) !KeyValueList {
    const array_len = array.len();
    if (array_len == 0) {
        return .empty;
    }

    var params = KeyValueList.init();
    try params.ensureTotalCapacity(allocator, array_len);
    // TODO: Release `params` on error.

    var i: u32 = 0;
    while (i < array_len) : (i += 1) {
        const item = try array.get(i);
        if (!item.isArray()) return error.TypeError;

        const as_array = item.toArray();
        // Web IDL sequence<sequence<USVString>> requires exactly two elements.
        if (as_array.len() != 2) return error.TypeError;

        const name_val = try as_array.get(0);
        const value_val = try as_array.get(1);
        if (name_val.isString() == null or value_val.isString() == null) return error.TypeError;

        params._entries.appendAssumeCapacity(.{
            .name = try name_val.toSSOWithAlloc(allocator),
            .value = try value_val.toSSOWithAlloc(allocator),
        });
    }

    return params;
}

const ParamsFromStringMode = enum { from_url, from_string };

fn paramsFromString(allocator: Allocator, input: []const u8, buf: []u8, mode: ParamsFromStringMode) !KeyValueList {
    return KeyValueList.fromUrlEncodedString(allocator, input, buf, .{
        .strip_leading_question_mark = mode == .from_string,
    });
}

pub const Iterator = struct {
    index: u32 = 0,
    list: *const URLSearchParams,

    const Entry = struct { []const u8, []const u8 };

    pub fn next(self: *Iterator, _: *const Execution) !?Iterator.Entry {
        const index = self.index;
        const items = self.list._params.items;
        if (index >= items.len) {
            return null;
        }
        self.index = index + 1;

        const e = &items[index];
        return .{ e.name.str(), e.value.str() };
    }
};

pub const JsApi = struct {
    pub const bridge = js.Bridge(URLSearchParams);

    pub const Meta = struct {
        pub const name = "URLSearchParams";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const constructor = bridge.constructor(URLSearchParams.init, .{});
    pub const has = bridge.function(URLSearchParams.has, .{});
    pub const get = bridge.function(URLSearchParams.get, .{});
    pub const set = bridge.function(URLSearchParams.set, .{});
    pub const append = bridge.function(URLSearchParams.append, .{});
    pub const getAll = bridge.function(URLSearchParams.getAll, .{});
    pub const delete = bridge.function(URLSearchParams.delete, .{});
    pub const size = bridge.accessor(URLSearchParams.getSize, null, .{});
    pub const keys = bridge.function(URLSearchParams.keys, .{});
    pub const values = bridge.function(URLSearchParams.values, .{});
    pub const entries = bridge.function(URLSearchParams.entries, .{});
    pub const symbol_iterator = bridge.iterator(URLSearchParams.entries, .{});
    pub const forEach = bridge.function(URLSearchParams.forEach, .{});
    pub const sort = bridge.function(URLSearchParams.sort, .{});

    pub const toString = bridge.function(_toString, .{});
    fn _toString(self: *const URLSearchParams, exec: *const Execution) ![]const u8 {
        var buf = std.Io.Writer.Allocating.init(exec.call_arena);
        try self.toString(&buf.writer);
        return buf.written();
    }
};

const testing = @import("../../../testing/testing.zig");
test "WebApi: URLSearchParams" {
    try testing.htmlRunner("net/url_search_params.html", .{});
}
