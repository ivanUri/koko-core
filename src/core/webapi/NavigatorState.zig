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

const FingerprintProfile = @import("../profile/types.zig");
const HttpClient = @import("../browser/HttpClient.zig");
const NavigatorUAData = @import("NavigatorUAData.zig");

const NavigatorState = @This();

profile: *const FingerprintProfile.IdentityProfile,

pub fn userAgent(_: *const NavigatorState, http_client: *const HttpClient) []const u8 {
    return http_client.getUserAgent();
}

pub fn appName(_: *const NavigatorState) []const u8 {
    return "Netscape";
}

pub fn appCodeName(_: *const NavigatorState) []const u8 {
    return "Mozilla";
}

pub fn appVersion(self: *const NavigatorState) []const u8 {
    return self.profile.app_version;
}

pub fn platform(self: *const NavigatorState) []const u8 {
    return self.profile.navigator_platform;
}

pub fn language(self: *const NavigatorState) []const u8 {
    if (self.profile.languages.len == 0) return "en-US";
    return self.profile.languages[0];
}

pub fn languages(self: *const NavigatorState) []const []const u8 {
    return self.profile.languages;
}

pub fn onLine(_: *const NavigatorState) bool {
    return true;
}

pub fn hardwareConcurrency(self: *const NavigatorState) u32 {
    return self.profile.hardware_concurrency;
}

pub fn deviceMemory(self: *const NavigatorState) f64 {
    return self.profile.device_memory;
}

pub fn maxTouchPoints(self: *const NavigatorState) u32 {
    return self.profile.max_touch_points;
}

pub fn vendor(self: *const NavigatorState) []const u8 {
    return self.profile.vendor;
}

pub fn product(_: *const NavigatorState) []const u8 {
    return "Gecko";
}

pub fn webdriver(_: *const NavigatorState) bool {
    return false;
}

pub fn doNotTrack(_: *const NavigatorState) ?[]const u8 {
    return null;
}

pub fn globalPrivacyControl(self: *const NavigatorState) bool {
    return self.profile.global_privacy_control;
}

pub fn pdfViewerEnabled(self: *const NavigatorState) bool {
    return self.profile.pdf_viewer_enabled;
}

pub fn userAgentData(_: *const NavigatorState) NavigatorUAData {
    return .{};
}
