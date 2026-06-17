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

const js = @import("../js/js.zig");
const ProfileStore = @import("../fingerprint/ProfileStore.zig");

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

pub fn getHighEntropyValues(_: *const NavigatorUAData, hints: []const []const u8, exec: *js.Execution) !js.Promise {
    _ = hints;

    const profile = exec.identityProfile();
    const brands = brandsFromProfile(exec.loadedProfile());

    return exec.context.local.?.resolvePromise(.{
        .brands = brands,
        .mobile = profile.ua_mobile,
        .platform = profile.ua_data_platform,
        .architecture = profile.ua_architecture,
        .bitness = profile.ua_bitness,
        .model = "",
        .platformVersion = profile.platform_version,
        .uaFullVersion = profile.ua_full_version,
        .fullVersionList = brands,
        .wow64 = false,
        .formFactor = [_][]const u8{"Desktop"},
    });
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
