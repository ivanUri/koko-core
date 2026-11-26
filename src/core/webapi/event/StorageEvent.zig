// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

const js = @import("../../js/js.zig");
const Frame = @import("../../browser/Frame.zig");
const Page = @import("../../browser/Page.zig");
const Event = @import("../Event.zig");
const String = @import("../../../support/string.zig").String;

const StorageEvent = @This();

_proto: *Event,
_key: ?[]const u8 = null,
_old_value: ?[]const u8 = null,
_new_value: ?[]const u8 = null,
_url: []const u8 = "",

const StorageEventOptions = struct {
    key: ?[]const u8 = null,
    oldValue: ?[]const u8 = null,
    newValue: ?[]const u8 = null,
    url: []const u8 = "",
};

const Options = Event.inheritOptions(StorageEvent, StorageEventOptions);

pub fn initTrusted(typ: String, opts_: ?Options, frame: *Frame) !*StorageEvent {
    const arena = try frame.getArena(.tiny, "StorageEvent.trusted");
    errdefer frame.releaseArena(arena);
    return initWithTrusted(arena, typ, opts_, true, frame._page);
}

fn initWithTrusted(arena: anytype, typ: String, opts_: ?Options, trusted: bool, page: *Page) !*StorageEvent {
    const opts = opts_ orelse Options{};
    const event = try page.factory.event(arena, typ, StorageEvent{
        ._proto = undefined,
        ._key = if (opts.key) |value| try arena.dupe(u8, value) else null,
        ._old_value = if (opts.oldValue) |value| try arena.dupe(u8, value) else null,
        ._new_value = if (opts.newValue) |value| try arena.dupe(u8, value) else null,
        ._url = try arena.dupe(u8, opts.url),
    });
    Event.populatePrototypes(event, opts, trusted);
    return event;
}

pub fn asEvent(self: *StorageEvent) *Event {
    return self._proto;
}

pub fn getKey(self: *const StorageEvent) ?[]const u8 {
    return self._key;
}

pub fn getOldValue(self: *const StorageEvent) ?[]const u8 {
    return self._old_value;
}

pub fn getNewValue(self: *const StorageEvent) ?[]const u8 {
    return self._new_value;
}

pub fn getUrl(self: *const StorageEvent) []const u8 {
    return self._url;
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(StorageEvent);
    pub const Meta = struct {
        pub const name = "StorageEvent";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };
    pub const key = bridge.accessor(StorageEvent.getKey, null, .{});
    pub const oldValue = bridge.accessor(StorageEvent.getOldValue, null, .{});
    pub const newValue = bridge.accessor(StorageEvent.getNewValue, null, .{});
    pub const url = bridge.accessor(StorageEvent.getUrl, null, .{});
};
