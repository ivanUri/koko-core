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
const NavigatorState = @import("NavigatorState.zig");
const NavigatorUAData = @import("NavigatorUAData.zig");
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
_ua_data: NavigatorUAData = .{},
_gpu: navigator_extras.GPU = .{},

pub const init: WorkerNavigator = .{};

fn state() NavigatorState {
    return NavigatorState.default();
}

pub fn getUserAgent(_: *const WorkerNavigator, page: *Page) []const u8 {
    return state().userAgent(&page.session.browser.http_client);
}

pub fn getLanguages(_: *const WorkerNavigator) [2][]const u8 {
    return state().languages();
}

pub fn getLanguage(_: *const WorkerNavigator) []const u8 {
    return state().language();
}

pub fn getPlatform(_: *const WorkerNavigator) []const u8 {
    return state().platform();
}

pub fn getAppName(_: *const WorkerNavigator) []const u8 {
    return state().appName();
}

pub fn getAppCodeName(_: *const WorkerNavigator) []const u8 {
    return state().appCodeName();
}

pub fn getAppVersion(_: *const WorkerNavigator) []const u8 {
    return state().appVersion();
}

pub fn getHardwareConcurrency(_: *const WorkerNavigator) u32 {
    return state().hardwareConcurrency();
}

pub fn getUserAgentData(self: *WorkerNavigator) *NavigatorUAData {
    return &self._ua_data;
}

pub fn getOnLine(_: *const WorkerNavigator) bool {
    return state().onLine();
}

pub fn getProduct(_: *const WorkerNavigator) []const u8 {
    return state().product();
}

pub fn getWebdriver(_: *const WorkerNavigator) bool {
    return state().webdriver();
}

pub fn getDoNotTrack(_: *const WorkerNavigator) ?[]const u8 {
    return state().doNotTrack();
}

pub fn getDeviceMemory(_: *const WorkerNavigator) f64 {
    return state().deviceMemory();
}

pub fn getMaxTouchPoints(_: *const WorkerNavigator) u32 {
    return state().maxTouchPoints();
}

pub fn getVendor(_: *const WorkerNavigator) []const u8 {
    return state().vendor();
}

pub fn getGlobalPrivacyControl(_: *const WorkerNavigator) bool {
    return state().globalPrivacyControl();
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
    };

    pub const userAgent = bridge.accessor(WorkerNavigator.getUserAgent, null, .{});
    pub const appName = bridge.accessor(WorkerNavigator.getAppName, null, .{});
    pub const appCodeName = bridge.accessor(WorkerNavigator.getAppCodeName, null, .{});
    pub const appVersion = bridge.accessor(WorkerNavigator.getAppVersion, null, .{});
    pub const platform = bridge.accessor(WorkerNavigator.getPlatform, null, .{});
    pub const language = bridge.accessor(WorkerNavigator.getLanguage, null, .{});
    pub const languages = bridge.accessor(WorkerNavigator.getLanguages, null, .{});
    pub const onLine = bridge.accessor(WorkerNavigator.getOnLine, null, .{});
    pub const hardwareConcurrency = bridge.accessor(WorkerNavigator.getHardwareConcurrency, null, .{});
    pub const deviceMemory = bridge.accessor(WorkerNavigator.getDeviceMemory, null, .{});
    pub const maxTouchPoints = bridge.accessor(WorkerNavigator.getMaxTouchPoints, null, .{});
    pub const vendor = bridge.accessor(WorkerNavigator.getVendor, null, .{});
    pub const product = bridge.accessor(WorkerNavigator.getProduct, null, .{});
    pub const webdriver = bridge.accessor(WorkerNavigator.getWebdriver, null, .{});
    pub const doNotTrack = bridge.accessor(WorkerNavigator.getDoNotTrack, null, .{});
    pub const globalPrivacyControl = bridge.accessor(WorkerNavigator.getGlobalPrivacyControl, null, .{});
    pub const userAgentData = bridge.accessor(WorkerNavigator.getUserAgentData, null, .{});
    pub const gpu = bridge.accessor(WorkerNavigator.getGpu, null, .{});
};
