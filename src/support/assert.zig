const std = @import("std");
const log = @import("log.zig");

pub fn assert(ok: bool, comptime msg: []const u8, args: anytype) void {
    if (ok) return;
    log.err(.app, msg, args);
    std.debug.assert(ok);
}
