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
const js = @import("../js/js.zig");
const ProfileStore = @import("../../runtime/profile/ProfileStore.zig");

const NavigatorUAData = @This();

_pad: bool = false,

const Brand = ProfileStore.Brand;

fn brandsFromProfile(profile: *const ProfileStore.LoadedProfile) []const Brand {
    return profile.http.brands;
}

pub fn getBrands(_: *const NavigatorUAData, exec: *js.Execution) []const Brand {
    return brandsFromProfile(exec.loadedProfile());
}

pub fn getMobile(_: *const NavigatorUAData, exec: *js.Execution) bool {
    return exec.identityProfile().ua_mobile;
}

pub fn getPlatform(_: *const NavigatorUAData, exec: *js.Execution) []const u8 {
    return exec.identityProfile().ua_data_platform;
}

pub fn toJSON(self: *const NavigatorUAData, exec: *js.Execution) struct {
    brands: []const Brand,
    mobile: bool,
    platform: []const u8,
} {
    return .{
        .mobile = getMobile(self, exec),
        .brands = getBrands(self, exec),
        .platform = getPlatform(self, exec),
    };
}

fn hintMatches(hint: []const u8, comptime name: []const u8) bool {
    return std.mem.eql(u8, hint, name);
}

pub fn getHighEntropyValues(_: *const NavigatorUAData, hints: []const []const u8, exec: *js.Execution) !js.Promise {
    const local = exec.context.local orelse return error.NotHandled;
    const profile = exec.identityProfile();

    var obj = local.newObject();
    for (hints) |hint| {
        if (hintMatches(hint, "platform")) {
            if ((try obj.set("platform", profile.ua_data_platform, .{})) == false) return error.CreateObjectFailure;
        } else if (hintMatches(hint, "platformVersion")) {
            if ((try obj.set("platformVersion", profile.platform_version, .{})) == false) return error.CreateObjectFailure;
        } else if (hintMatches(hint, "architecture")) {
            if ((try obj.set("architecture", profile.ua_architecture, .{})) == false) return error.CreateObjectFailure;
        } else if (hintMatches(hint, "bitness")) {
            if ((try obj.set("bitness", profile.ua_bitness, .{})) == false) return error.CreateObjectFailure;
        } else if (hintMatches(hint, "model")) {
            if ((try obj.set("model", "", .{})) == false) return error.CreateObjectFailure;
        } else if (hintMatches(hint, "uaFullVersion")) {
            if ((try obj.set("uaFullVersion", profile.ua_full_version, .{})) == false) return error.CreateObjectFailure;
        } else if (hintMatches(hint, "fullVersionList")) {
            const brands = brandsFromProfile(exec.loadedProfile());
            if ((try obj.set("fullVersionList", brands, .{})) == false) return error.CreateObjectFailure;
        } else if (hintMatches(hint, "wow64")) {
            if ((try obj.set("wow64", false, .{})) == false) return error.CreateObjectFailure;
        } else if (hintMatches(hint, "formFactor")) {
            const form_factor = [_][]const u8{"Desktop"};
            if ((try obj.set("formFactor", form_factor, .{})) == false) return error.CreateObjectFailure;
        }
    }

    return local.resolvePromise(obj);
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
