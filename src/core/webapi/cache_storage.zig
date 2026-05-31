// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

const js = @import("../js/js.zig");
const Frame = @import("../browser/Frame.zig");

pub fn registerTypes() []const type {
    return &.{ CacheStorage, Cache };
}

pub const Cache = struct {
    _name: []const u8,

    pub fn match(self: *const Cache, _: js.Value, frame: *Frame) !js.Promise {
        _ = self;
        const local = frame.js.local orelse return error.NotHandled;
        return local.resolvePromise(js.Undefined{});
    }

    pub fn keys(self: *const Cache, frame: *Frame) !js.Promise {
        _ = self;
        const local = frame.js.local orelse return error.NotHandled;
        return local.resolvePromise(local.newArray(0));
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(Cache);
        pub const Meta = struct {
            pub const name = "Cache";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const match = bridge.function(Cache.match, .{});
        pub const keys = bridge.function(Cache.keys, .{});
    };
};

pub const CacheStorage = struct {
    _pad: bool = false,

    pub fn open(self: *const CacheStorage, name: []const u8, frame: *Frame) !js.Promise {
        _ = self;
        const local = frame.js.local orelse return error.NotHandled;
        const cache = try frame._factory.create(Cache{ ._name = name });
        return local.resolvePromise(cache);
    }

    pub fn has(self: *const CacheStorage, _: []const u8, frame: *Frame) !js.Promise {
        _ = self;
        const local = frame.js.local orelse return error.NotHandled;
        return local.resolvePromise(false);
    }

    pub fn keys(self: *const CacheStorage, frame: *Frame) !js.Promise {
        _ = self;
        const local = frame.js.local orelse return error.NotHandled;
        return local.resolvePromise(local.newArray(0));
    }

    pub fn delete(self: *const CacheStorage, _: []const u8, frame: *Frame) !js.Promise {
        _ = self;
        const local = frame.js.local orelse return error.NotHandled;
        return local.resolvePromise(false);
    }

    pub fn match(self: *const CacheStorage, _: js.Value, frame: *Frame) !js.Promise {
        _ = self;
        const local = frame.js.local orelse return error.NotHandled;
        return local.resolvePromise(js.Undefined{});
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(CacheStorage);
        pub const Meta = struct {
            pub const name = "CacheStorage";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
            pub const empty_with_no_proto = true;
        };
        pub const open = bridge.function(CacheStorage.open, .{});
        pub const has = bridge.function(CacheStorage.has, .{});
        pub const keys = bridge.function(CacheStorage.keys, .{});
        pub const delete = bridge.function(CacheStorage.delete, .{});
        pub const match = bridge.function(CacheStorage.match, .{});
    };
};
