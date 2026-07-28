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

const IdleDeadline = @This();
const milliTimestamp = @import("../../support/datetime.zig").milliTimestamp;

/// Idle periods are capped at 50ms by the requestIdleCallback processing model.
const idle_period_budget_ms: u64 = 50;

deadline_ms: u64 = 0,
_did_timeout: bool = false,

pub fn init(did_timeout: bool) IdleDeadline {
    return .{
        .deadline_ms = milliTimestamp(.monotonic) + idle_period_budget_ms,
        ._did_timeout = did_timeout,
    };
}

pub fn timeRemaining(self: *const IdleDeadline) f64 {
    const now = milliTimestamp(.monotonic);
    if (now >= self.deadline_ms) return 0;
    return @floatFromInt(self.deadline_ms - now);
}

pub fn getDidTimeout(self: *const IdleDeadline) bool {
    return self._did_timeout;
}

pub const JsApi = struct {
    const js = @import("../js/js.zig");
    pub const bridge = js.Bridge(IdleDeadline);

    pub const Meta = struct {
        pub const name = "IdleDeadline";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
        pub const empty_with_no_proto = true;
    };

    pub const timeRemaining = bridge.function(IdleDeadline.timeRemaining, .{});
    pub const didTimeout = bridge.accessor(IdleDeadline.getDidTimeout, null, .{});
};
