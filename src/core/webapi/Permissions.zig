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
const RC = @import("../../support/rc.zig").RC;

const js = @import("../js/js.zig");
const Page = @import("../browser/Page.zig");
const Frame = @import("../browser/Frame.zig");

const Allocator = std.mem.Allocator;

pub fn registerTypes() []const type {
    return &.{ Permissions, PermissionStatus };
}

const Permissions = @This();

// Padding to avoid zero-size struct pointer collisions
_pad: bool = false,

const QueryDescriptor = struct {
    name: []const u8,
};
fn defaultPermissionState(name: []const u8) []const u8 {
    // macOS Chrome defaults for common probes.
    if (std.mem.eql(u8, name, "notifications")) return "denied";
    if (std.mem.eql(u8, name, "geolocation")) return "prompt";
    return "prompt";
}

pub fn query(_: *const Permissions, qd: QueryDescriptor, frame: *Frame) !js.Promise {
    const arena = try frame.getArena(.tiny, "PermissionStatus");
    errdefer frame.releaseArena(arena);

    const status = try arena.create(PermissionStatus);
    status.* = .{
        ._arena = arena,
        ._state = defaultPermissionState(qd.name),
        ._name = try arena.dupe(u8, qd.name),
    };
    return frame.js.local.?.resolvePromise(status);
}

const PermissionStatus = struct {
    _rc: RC(u8) = .{},
    _arena: Allocator,
    _name: []const u8,
    _state: []const u8,

    pub fn deinit(self: *PermissionStatus, page: *Page) void {
        page.releaseArena(self._arena);
    }

    pub fn releaseRef(self: *PermissionStatus, page: *Page) void {
        self._rc.release(self, page);
    }

    pub fn acquireRef(self: *PermissionStatus) void {
        self._rc.acquire();
    }

    fn getName(self: *const PermissionStatus) []const u8 {
        return self._name;
    }

    fn getState(self: *const PermissionStatus) []const u8 {
        return self._state;
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(PermissionStatus);
        pub const Meta = struct {
            pub const name = "PermissionStatus";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const name = bridge.accessor(getName, null, .{});
        pub const state = bridge.accessor(getState, null, .{});
    };
};

pub const JsApi = struct {
    pub const bridge = js.Bridge(Permissions);

    pub const Meta = struct {
        pub const name = "Permissions";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
        pub const empty_with_no_proto = true;
    };

    pub const query = bridge.function(Permissions.query, .{ .dom_exception = true });
};
