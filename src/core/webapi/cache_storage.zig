// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

const std = @import("std");
const js = @import("../js/js.zig");
const Frame = @import("../browser/Frame.zig");
const URL = @import("../browser/URL.zig");
const Request = @import("net/Request.zig");
const Response = @import("net/Response.zig");

pub fn registerTypes() []const type {
    return &.{ CacheStorage, Cache };
}

pub const Cache = struct {
    _name: []const u8,
    _request_url: ?[:0]const u8 = null,
    _response: ?*Response = null,

    fn resolveRequest(request: Request.Input, frame: *Frame) ![:0]const u8 {
        return switch (request) {
            .request => |req| req._url,
            .url => |url| URL.resolve(frame.arena, frame.base(), url, .{ .always_dupe = true, .encoding = frame.charset }),
        };
    }

    pub fn put(self: *Cache, request: Request.Input, response: *Response, frame: *Frame) !js.Promise {
        const local = frame.js.local orelse return error.NotHandled;
        self._request_url = try resolveRequest(request, frame);
        self._response = response;
        return local.resolvePromise(js.Undefined{});
    }

    pub fn match(self: *const Cache, request: Request.Input, frame: *Frame) !js.Promise {
        const local = frame.js.local orelse return error.NotHandled;
        const url = try resolveRequest(request, frame);
        if (self._request_url) |stored| {
            if (std.mem.eql(u8, stored, url)) {
                if (self._response) |response| return local.resolvePromise(response);
            }
        }
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
        pub const put = bridge.function(Cache.put, .{});
        pub const keys = bridge.function(Cache.keys, .{});
    };
};

pub const CacheStorage = struct {
    _pad: bool = false,

    pub fn open(self: *const CacheStorage, name: []const u8, frame: *Frame) !js.Promise {
        _ = self;
        const local = frame.js.local orelse return error.NotHandled;
        const cache = try frame._factory.create(Cache{ ._name = try frame.dupeString(name) });
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
