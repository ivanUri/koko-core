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

const EventTarget = @import("EventTarget.zig");
const Frame = @import("../browser/Frame.zig");

const BatteryManager = @This();

_proto: *EventTarget,
_charging: bool,
_charging_time: f64,
_discharging_time: f64,
_level: f64,
_onchargingchange: ?js.Function.Global = null,
_onchargingtimechange: ?js.Function.Global = null,
_ondischargingtimechange: ?js.Function.Global = null,
_onlevelchange: ?js.Function.Global = null,

pub const Config = struct {
    enabled: bool = true,
    charging: bool = false,
    charging_time: f64 = std.math.inf(f64),
    discharging_time: f64 = 19140,
    level: f64 = 0.86,
};

pub fn init(frame: *Frame) !*BatteryManager {
    const config = frame._session.browser.battery_config;
    return frame._factory.eventTarget(BatteryManager{
        ._proto = undefined,
        ._charging = config.charging,
        ._charging_time = config.charging_time,
        ._discharging_time = config.discharging_time,
        ._level = config.level,
    });
}

pub fn getCharging(self: *const BatteryManager) bool {
    return self._charging;
}

pub fn getChargingTime(self: *const BatteryManager) f64 {
    return self._charging_time;
}

pub fn getDischargingTime(self: *const BatteryManager) f64 {
    return self._discharging_time;
}

pub fn getLevel(self: *const BatteryManager) f64 {
    return self._level;
}

pub fn getOnChargingChange(self: *const BatteryManager) ?js.Function.Global {
    return self._onchargingchange;
}

pub fn setOnChargingChange(self: *BatteryManager, cb: ?js.Function.Global) !void {
    self._onchargingchange = cb;
}

pub fn getOnChargingTimeChange(self: *const BatteryManager) ?js.Function.Global {
    return self._onchargingtimechange;
}

pub fn setOnChargingTimeChange(self: *BatteryManager, cb: ?js.Function.Global) !void {
    self._onchargingtimechange = cb;
}

pub fn getOnDischargingTimeChange(self: *const BatteryManager) ?js.Function.Global {
    return self._ondischargingtimechange;
}

pub fn setOnDischargingTimeChange(self: *BatteryManager, cb: ?js.Function.Global) !void {
    self._ondischargingtimechange = cb;
}

pub fn getOnLevelChange(self: *const BatteryManager) ?js.Function.Global {
    return self._onlevelchange;
}

pub fn setOnLevelChange(self: *BatteryManager, cb: ?js.Function.Global) !void {
    self._onlevelchange = cb;
}

pub fn asEventTarget(self: *BatteryManager) *EventTarget {
    return self._proto;
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(BatteryManager);

    pub const Meta = struct {
        pub const name = "BatteryManager";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
        pub const enumerable = false;
    };

    pub const Prototype = EventTarget;

    // Read-only properties
    pub const charging = bridge.accessor(BatteryManager.getCharging, null, .{});
    pub const chargingTime = bridge.accessor(BatteryManager.getChargingTime, null, .{});
    pub const dischargingTime = bridge.accessor(BatteryManager.getDischargingTime, null, .{});
    pub const level = bridge.accessor(BatteryManager.getLevel, null, .{});

    // Event handlers
    pub const onchargingchange = bridge.accessor(BatteryManager.getOnChargingChange, BatteryManager.setOnChargingChange, .{});
    pub const onchargingtimechange = bridge.accessor(BatteryManager.getOnChargingTimeChange, BatteryManager.setOnChargingTimeChange, .{});
    pub const ondischargingtimechange = bridge.accessor(BatteryManager.getOnDischargingTimeChange, BatteryManager.setOnDischargingTimeChange, .{});
    pub const onlevelchange = bridge.accessor(BatteryManager.getOnLevelChange, BatteryManager.setOnLevelChange, .{});
};
