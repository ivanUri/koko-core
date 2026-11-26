// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

const std = @import("std");
const CDP = @import("../CDP.zig");

const Domain = struct {
    name: []const u8,
    version: []const u8,
};

// Keep this list synchronized with dispatchCommand. It describes the CDP
// domains exposed by Koko itself, rather than claiming the complete Chrome
// protocol surface.
const domains = [_]Domain{
    .{ .name = "Accessibility", .version = "1.3" },
    .{ .name = "Audits", .version = "1.3" },
    .{ .name = "Browser", .version = "1.3" },
    .{ .name = "CSS", .version = "1.3" },
    .{ .name = "DOM", .version = "1.3" },
    .{ .name = "DOMDebugger", .version = "1.3" },
    .{ .name = "DOMSnapshot", .version = "1.3" },
    .{ .name = "Emulation", .version = "1.3" },
    .{ .name = "Fetch", .version = "1.3" },
    .{ .name = "IO", .version = "1.3" },
    .{ .name = "Input", .version = "1.3" },
    .{ .name = "Inspector", .version = "1.3" },
    .{ .name = "Koko", .version = "1.0" },
    .{ .name = "Log", .version = "1.3" },
    .{ .name = "Network", .version = "1.3" },
    .{ .name = "Overlay", .version = "1.3" },
    .{ .name = "Page", .version = "1.3" },
    .{ .name = "Performance", .version = "1.3" },
    .{ .name = "Profiler", .version = "1.3" },
    .{ .name = "Runtime", .version = "1.3" },
    .{ .name = "Security", .version = "1.3" },
    .{ .name = "Storage", .version = "1.3" },
    .{ .name = "Target", .version = "1.3" },
    .{ .name = "Tracing", .version = "1.3" },
};

pub fn processMessage(cmd: *CDP.Command) !void {
    if (!std.mem.eql(u8, cmd.input.action, "getDomains")) return error.UnknownMethod;
    _ = (try cmd.params(struct {})) orelse return error.InvalidParams;
    return cmd.sendResult(.{ .domains = domains }, .{});
}
