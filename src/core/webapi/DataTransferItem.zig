// Copyright (C) 2023-2026  Lightpanda (Selecy SAS)
//
// Adapted for Velora architecture.

const std = @import("std");

const js = @import("../js/js.zig");
const Frame = @import("../browser/Frame.zig");
const Page = @import("../browser/Page.zig");

const File = @import("File.zig");
const DataTransfer = @import("DataTransfer.zig");

const DataTransferItem = @This();

pub const Kind = enum { string, file };

_kind: Kind,
_type: []const u8,
_payload: union(Kind) {
    string: []const u8,
    file: *File,
},
_data_transfer: *DataTransfer,

pub fn deinit(_: *DataTransferItem, _: *Page) void {}

pub fn getKind(self: *const DataTransferItem) []const u8 {
    return switch (self._kind) {
        .string => "string",
        .file => "file",
    };
}

pub fn getType(self: *const DataTransferItem) []const u8 {
    return self._type;
}

pub fn getAsFile(self: *const DataTransferItem) ?*File {
    return switch (self._kind) {
        .file => self._payload.file,
        .string => null,
    };
}

pub fn getAsString(self: *DataTransferItem, callback: js.Function, frame: *Frame) !void {
    const data = switch (self._kind) {
        .string => self._payload.string,
        .file => return,
    };
    _ = frame;
    // Fire the callback asynchronously would match the HTML DnD model; for
    // headless fidelity a direct call is enough for presence checks.
    callback.call(void, .{data}) catch {};
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(DataTransferItem);

    pub const Meta = struct {
        pub const name = "DataTransferItem";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const kind = bridge.accessor(DataTransferItem.getKind, null, .{});
    pub const type_ = bridge.accessor(DataTransferItem.getType, null, .{ .js_name = "type" });
    pub const getAsFile = bridge.function(DataTransferItem.getAsFile, .{});
    pub const getAsString = bridge.function(DataTransferItem.getAsString, .{});
};
