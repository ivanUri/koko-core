//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

const std = @import("std");

const js = @import("../../js/js.zig");
const Page = @import("../../browser/Page.zig");

const Event = @import("../Event.zig");
const MessagePort = @import("../MessagePort.zig");

const String = @import("../../../support/string.zig").String;
const Allocator = std.mem.Allocator;

const ConnectEvent = @This();

_proto: *Event,
_ports: []const *MessagePort = &.{},

const ConnectEventOptions = struct {
    ports: []const *MessagePort = &.{},
};

const Options = Event.inheritOptions(ConnectEvent, ConnectEventOptions);

pub fn init(typ: []const u8, opts_: ?Options, page: *Page) !*ConnectEvent {
    const arena = try page.getArena(.small, "ConnectEvent");
    errdefer page.releaseArena(arena);
    const type_string = try String.init(arena, typ, .{});
    return initWithTrusted(arena, type_string, opts_, false, page);
}

pub fn initTrusted(typ: String, opts_: ?Options, page: *Page) !*ConnectEvent {
    const arena = try page.getArena(.small, "ConnectEvent.trusted");
    errdefer page.releaseArena(arena);
    return initWithTrusted(arena, typ, opts_, true, page);
}

fn initWithTrusted(arena: Allocator, typ: String, opts_: ?Options, trusted: bool, page: *Page) !*ConnectEvent {
    const opts = opts_ orelse Options{};

    const event = try page.factory.event(
        arena,
        typ,
        ConnectEvent{
            ._proto = undefined,
            ._ports = opts.ports,
        },
    );

    Event.populatePrototypes(event, opts, trusted);
    return event;
}

pub fn deinit(self: *ConnectEvent, page: *Page) void {
    _ = self;
    _ = page;
}

pub fn asEvent(self: *ConnectEvent) *Event {
    return self._proto;
}

pub fn getPorts(self: *const ConnectEvent) []*MessagePort {
    return @constCast(self._ports);
}

pub fn getSource(self: *const ConnectEvent) ?*MessagePort {
    if (self._ports.len == 0) return null;
    return self._ports[0];
}

/// Connect events have no payload; WPT `onconnect.js` expects `e.data === ""`.
pub fn getData(_: *const ConnectEvent) []const u8 {
    return "";
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(ConnectEvent);

    pub const Meta = struct {
        pub const name = "ConnectEvent";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const constructor = bridge.constructor(ConnectEvent.init, .{});
    pub const data = bridge.accessor(ConnectEvent.getData, null, .{});
    pub const ports = bridge.accessor(ConnectEvent.getPorts, null, .{});
    pub const source = bridge.accessor(ConnectEvent.getSource, null, .{});
};
