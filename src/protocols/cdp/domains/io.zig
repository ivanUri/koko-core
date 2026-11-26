// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

const std = @import("std");
const CDP = @import("../CDP.zig");

pub fn processMessage(cmd: *CDP.Command) !void {
    const action = std.meta.stringToEnum(enum { resolveBlob }, cmd.input.action) orelse return error.UnknownMethod;
    switch (action) {
        .resolveBlob => {
            const params = (try cmd.params(struct {
                objectId: []const u8,
            })) orelse return error.InvalidParams;

            // Blob object ids are owned by the inspector's remote-object
            // table. The current public Zig boundary only exposes node
            // unwrapping; returning a made-up UUID would be observably wrong
            // and could leak a handle past navigation. Keep this explicit
            // until the inspector exposes a typed Blob resolver.
            _ = params;
            return cmd.sendError(-32000, "IO.resolveBlob requires typed inspector Blob resolution", .{});
        },
    }
}
