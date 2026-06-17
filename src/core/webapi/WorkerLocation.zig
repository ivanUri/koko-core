// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

const js = @import("../js/js.zig");
const URL = @import("URL.zig");
const Factory = @import("../browser/Factory.zig");

const WorkerLocation = @This();

_url: *URL,

pub fn init(url: [:0]const u8, exec: *js.Execution, factory: *Factory) !*WorkerLocation {
    const url_obj = try URL.init(url, null, exec);
    return factory.create(WorkerLocation{
        ._url = url_obj,
    });
}

pub fn getPathname(self: *const WorkerLocation) []const u8 {
    return self._url.getPathname();
}

pub fn getProtocol(self: *const WorkerLocation) []const u8 {
    return self._url.getProtocol();
}

pub fn getHostname(self: *const WorkerLocation) []const u8 {
    return self._url.getHostname();
}

pub fn getHost(self: *const WorkerLocation) []const u8 {
    return self._url.getHost();
}

pub fn getPort(self: *const WorkerLocation) []const u8 {
    return self._url.getPort();
}

pub fn getOrigin(self: *const WorkerLocation, exec: *const js.Execution) ![]const u8 {
    return self._url.getOrigin(exec);
}

pub fn getSearch(self: *const WorkerLocation, exec: *const js.Execution) ![]const u8 {
    return self._url.getSearch(exec);
}

pub fn getHash(self: *const WorkerLocation) []const u8 {
    return self._url.getHash();
}

pub fn toString(self: *const WorkerLocation, exec: *const js.Execution) ![:0]const u8 {
    return self._url.toString(exec);
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(WorkerLocation);

    pub const Meta = struct {
        pub const name = "WorkerLocation";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const toString = bridge.function(WorkerLocation.toString, .{});
    pub const href = bridge.accessor(WorkerLocation.toString, null, .{});
    pub const search = bridge.accessor(WorkerLocation.getSearch, null, .{});
    pub const hash = bridge.accessor(WorkerLocation.getHash, null, .{});
    pub const pathname = bridge.accessor(WorkerLocation.getPathname, null, .{});
    pub const hostname = bridge.accessor(WorkerLocation.getHostname, null, .{});
    pub const host = bridge.accessor(WorkerLocation.getHost, null, .{});
    pub const port = bridge.accessor(WorkerLocation.getPort, null, .{});
    pub const origin = bridge.accessor(WorkerLocation.getOrigin, null, .{});
    pub const protocol = bridge.accessor(WorkerLocation.getProtocol, null, .{});
};
