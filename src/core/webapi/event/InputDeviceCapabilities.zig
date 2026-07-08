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

const InputDeviceCapabilities = @This();

_fires_touch_events: bool = false,

pub fn init(frame: *Frame) !*InputDeviceCapabilities {
    return try frame._factory.create(InputDeviceCapabilities{
        ._fires_touch_events = false,
    });
}

pub fn getFiresTouchEvents(self: *const InputDeviceCapabilities) bool {
    return self._fires_touch_events;
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(InputDeviceCapabilities);

    pub const Meta = struct {
        pub const name = "InputDeviceCapabilities";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
        pub const empty_with_no_proto = true;
    };

    pub const firesTouchEvents = bridge.accessor(InputDeviceCapabilities.getFiresTouchEvents, null, .{});
};
