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

const js = @import("../../js/js.zig");
const Frame = @import("../../browser/Frame.zig");

const Touch = @This();

_client_x: f64 = 0,
_client_y: f64 = 0,
_identifier: i32 = 0,

pub fn init(frame: *Frame) !*Touch {
    return try frame._factory.create(Touch{});
}

pub fn getClientX(self: *const Touch) f64 {
    return self._client_x;
}

pub fn getClientY(self: *const Touch) f64 {
    return self._client_y;
}

pub fn getIdentifier(self: *const Touch) i32 {
    return self._identifier;
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(Touch);

    pub const Meta = struct {
        pub const name = "Touch";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
        pub const empty_with_no_proto = true;
    };

    pub const clientX = bridge.accessor(Touch.getClientX, null, .{});
    pub const clientY = bridge.accessor(Touch.getClientY, null, .{});
    pub const identifier = bridge.accessor(Touch.getIdentifier, null, .{});
};
