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

const Touch = @import("Touch.zig");

const TouchList = @This();

_touches: []const *Touch = &.{},

pub fn init(frame: *Frame) !*TouchList {
    return try frame._factory.create(TouchList{
        ._touches = &.{},
    });
}

pub fn getLength(self: *const TouchList) u32 {
    return @intCast(self._touches.len);
}

pub fn item(self: *const TouchList, index: u32) ?*Touch {
    if (index >= self._touches.len) return null;
    return self._touches[index];
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(TouchList);

    pub const Meta = struct {
        pub const name = "TouchList";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
        pub const empty_with_no_proto = true;
    };

    pub const length = bridge.accessor(TouchList.getLength, null, .{});
    pub const item = bridge.function(TouchList.item, .{});
};
