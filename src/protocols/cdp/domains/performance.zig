//
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
const CDP = @import("../CDP.zig");

pub fn processMessage(cmd: *CDP.Command) !void {
    const action = std.meta.stringToEnum(enum {
        enable,
        disable,
        getMetrics,
    }, cmd.input.action) orelse return error.UnknownMethod;

    switch (action) {
        .enable => return cmd.sendResult(null, .{}),
        .disable => return cmd.sendResult(null, .{}),
        .getMetrics => return getMetrics(cmd),
    }
}

fn getMetrics(cmd: *CDP.Command) !void {
    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    const stats = bc.session.browser.env.isolate.getHeapStatistics();
    const has_document = bc.session.currentFrame() != null;

    // Keep metrics backed by live Koko/V8 state. Renderer counters are not
    // exposed until they have real producers, rather than returning guesses.
    const metrics = [_]struct {
        name: []const u8,
        value: f64,
    }{
        .{ .name = "Documents", .value = if (has_document) 1.0 else 0.0 },
        .{ .name = "JSHeapUsedSize", .value = @floatFromInt(stats.used_heap_size) },
        .{ .name = "JSHeapTotalSize", .value = @floatFromInt(stats.total_heap_size) },
    };
    return cmd.sendResult(.{ .metrics = metrics }, .{});
}
