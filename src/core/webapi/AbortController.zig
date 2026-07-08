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
const js = @import("../js/js.zig");

const AbortSignal = @import("AbortSignal.zig");

const Execution = js.Execution;

const AbortController = @This();

_signal: *AbortSignal,

pub fn init(exec: *const Execution) !*AbortController {
    const signal = try AbortSignal.init(exec);
    return exec._factory.create(AbortController{
        ._signal = signal,
    });
}

pub fn getSignal(self: *const AbortController) *AbortSignal {
    return self._signal;
}

pub fn abort(self: *AbortController, reason: ?js.Value, exec: *const Execution) !void {
    if (reason == null or reason.?.isUndefined()) {
        try self._signal.abort(null, exec);
        return;
    }
    const r = reason.?;
    if (r.isNull()) {
        try self._signal.abort(.{ .null_reason = {} }, exec);
        return;
    }
    try self._signal.abort(.{ .js_val = try r.persist() }, exec);
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(AbortController);

    pub const Meta = struct {
        pub const name = "AbortController";

        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
        pub const enumerable = false;
    };

    pub const constructor = bridge.constructor(AbortController.init, .{});
    pub const signal = bridge.accessor(AbortController.getSignal, null, .{});
    pub const abort = bridge.function(AbortController.abort, .{});
};

const testing = @import("../../testing/testing.zig");
test "WebApi: AbortController" {
    try testing.htmlRunner("event/abort_controller.html", .{});
}
