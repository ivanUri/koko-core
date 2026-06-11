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

const Config = @import("../../runtime/Config.zig");
const js = @import("../js/js.zig");
const NavigatorState = @import("NavigatorState.zig");

const NavigatorUAData = @This();

fn state() NavigatorState {
    return NavigatorState.default();
}

_pad: bool = false,

const Brand = struct {
    brand: []const u8,
    version: []const u8,
};

pub fn getBrands(_: *const NavigatorUAData) []const Brand {
    return brandList();
}

pub fn getMobile(_: *const NavigatorUAData) bool {
    return false;
}

pub fn getPlatform(_: *const NavigatorUAData) []const u8 {
    return state().profile.ua_data_platform;
}

pub fn toJSON(_: *const NavigatorUAData) struct {
    brands: []const Brand,
    mobile: bool,
    platform: []const u8,
} {
    return .{
        .mobile = false,
        .brands = brandList(),
        .platform = state().profile.ua_data_platform,
    };
}

pub fn getHighEntropyValues(_: *const NavigatorUAData, hints: []const []const u8, exec: *js.Execution) !js.Promise {
    // This should always return `brands` + `mobile` + `platform` and then whatever
    // "hints" field is requested (assuming the browser has permission), but it's
    // also valid to just return everything.
    //
    // Uses *Execution rather than *Frame so the same path works in both
    // Window and Worker contexts. `context.local` is the local of whichever
    // realm we're currently dispatched in.

    _ = hints;

    return exec.context.local.?.resolvePromise(.{
        .brands = brandList(),
        .mobile = false,
        .platform = state().profile.ua_data_platform,
        .architecture = state().profile.ua_architecture,
        .bitness = state().profile.ua_bitness,
        .model = "",
        .platformVersion = "",
        .uaFullVersion = "1.0.0.0",
        .fullVersionList = brandList(),
        .wow64 = false,
        .formFactor = [_][]const u8{"Desktop"},
    });
}

fn brandList() []const Brand {
    const out = comptime blk: {
        const src = &Config.HttpHeaders.brands;
        var arr: [src.len]Brand = undefined;
        for (src, 0..) |b, i| {
            arr[i] = .{ .brand = b.brand, .version = b.version };
        }
        const final = arr;
        break :blk final;
    };
    return &out;
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(NavigatorUAData);

    pub const Meta = struct {
        pub const name = "NavigatorUAData";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
        pub const empty_with_no_proto = true;
    };

    pub const brands = bridge.accessor(NavigatorUAData.getBrands, null, .{});
    pub const mobile = bridge.accessor(NavigatorUAData.getMobile, null, .{});
    pub const platform = bridge.accessor(NavigatorUAData.getPlatform, null, .{});
    pub const toJSON = bridge.function(NavigatorUAData.toJSON, .{});
    pub const getHighEntropyValues = bridge.function(NavigatorUAData.getHighEntropyValues, .{});
};
