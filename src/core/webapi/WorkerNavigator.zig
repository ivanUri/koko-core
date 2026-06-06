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

const FingerprintProfile = @import("../fingerprint/Profile.zig");
const js = @import("../js/js.zig");

const NavigatorUAData = @import("NavigatorUAData.zig");
const PluginArray = @import("PluginArray.zig");
const Page = @import("../browser/Page.zig");
const navigator_extras = @import("navigator_extras.zig");

/// WorkerNavigator is the worker-context counterpart of Navigator. The HTML
/// spec defines it as a distinct interface that exposes only the subset of
/// Navigator that makes sense in a worker (no plugins, no media, no battery,
/// no protocol handlers, etc).
///
/// https://html.spec.whatwg.org/multipage/workers.html#workernavigator
///
/// The fields exposed here are the ones probed by fingerprinting libraries
/// (creepjs, fingerprintjs, etc), which compare them against the matching
/// `window.navigator` values to detect spoofing. They MUST agree with
/// `Navigator` so the cross-scope comparison passes.
const WorkerNavigator = @This();

_pad: bool = false,
_plugins: PluginArray = .{},
_mime_types: PluginArray.MimeTypeArray = .{},
_gpu: navigator_extras.GPU = .{},

pub const init: WorkerNavigator = .{};

fn identityProfile() *const FingerprintProfile.IdentityProfile {
    return FingerprintProfile.defaultIdentity();
}

pub fn getUserAgent(_: *const WorkerNavigator, page: *Page) []const u8 {
    // The Page is reachable from any execution context (frame OR worker)
    // via Context.page, and it is the source of truth for the HTTP client
    // (and thus the UA). Using *Page here means the same code path works
    // whether `navigator.userAgent` is read from window or worker.
    return page.session.browser.http_client.getUserAgent();
}

pub fn getLanguages(_: *const WorkerNavigator) [2][]const u8 {
    const profile = identityProfile();
    return .{ profile.languages[0], profile.languages[1] };
}

pub fn getPlatform(_: *const WorkerNavigator) []const u8 {
    return identityProfile().navigator_platform;
}

pub fn getUserAgentData(_: *const WorkerNavigator) NavigatorUAData {
    return .{};
}

pub fn getHardwareConcurrency(_: *const WorkerNavigator) u32 {
    return identityProfile().hardware_concurrency;
}

pub fn getDeviceMemory(_: *const WorkerNavigator) f64 {
    return identityProfile().device_memory;
}

pub fn getMaxTouchPoints(_: *const WorkerNavigator) u32 {
    return identityProfile().max_touch_points;
}

pub fn getVendor(_: *const WorkerNavigator) []const u8 {
    return identityProfile().vendor;
}

pub fn getGlobalPrivacyControl(_: *const WorkerNavigator) bool {
    return identityProfile().global_privacy_control;
}

pub fn getPlugins(self: *WorkerNavigator) *PluginArray {
    return &self._plugins;
}

pub fn getMimeTypes(self: *WorkerNavigator) *PluginArray.MimeTypeArray {
    return &self._mime_types;
}

pub fn getGpu(self: *WorkerNavigator) *navigator_extras.GPU {
    return &self._gpu;
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(WorkerNavigator);

    pub const Meta = struct {
        pub const name = "WorkerNavigator";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
        pub const empty_with_no_proto = true;
    };

    pub const userAgent = bridge.accessor(WorkerNavigator.getUserAgent, null, .{});
    pub const appName = bridge.attribute("Netscape", .{});
    pub const appCodeName = bridge.attribute("Netscape", .{});
    pub const appVersion = bridge.attribute("1.0", .{});
    pub const platform = bridge.accessor(WorkerNavigator.getPlatform, null, .{});
    pub const language = bridge.attribute("en-US", .{});
    pub const languages = bridge.accessor(WorkerNavigator.getLanguages, null, .{});
    pub const onLine = bridge.attribute(true, .{});
    pub const hardwareConcurrency = bridge.accessor(WorkerNavigator.getHardwareConcurrency, null, .{});
    pub const deviceMemory = bridge.accessor(WorkerNavigator.getDeviceMemory, null, .{});
    pub const maxTouchPoints = bridge.accessor(WorkerNavigator.getMaxTouchPoints, null, .{});
    pub const vendor = bridge.accessor(WorkerNavigator.getVendor, null, .{});
    pub const product = bridge.attribute("Gecko", .{});
    pub const webdriver = bridge.attribute(false, .{});
    pub const plugins = bridge.accessor(WorkerNavigator.getPlugins, null, .{});
    pub const mimeTypes = bridge.accessor(WorkerNavigator.getMimeTypes, null, .{});
    pub const doNotTrack = bridge.attribute(null, .{});
    pub const globalPrivacyControl = bridge.accessor(WorkerNavigator.getGlobalPrivacyControl, null, .{});
    pub const userAgentData = bridge.accessor(WorkerNavigator.getUserAgentData, null, .{});
    pub const gpu = bridge.accessor(WorkerNavigator.getGpu, null, .{});
};
