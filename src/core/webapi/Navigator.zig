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
const Frame = @import("../browser/Frame.zig");

const PluginArray = @import("PluginArray.zig");
const Permissions = @import("Permissions.zig");
const StorageManager = @import("StorageManager.zig");
const NavigatorUAData = @import("NavigatorUAData.zig");
const BatteryManager = @import("BatteryManager.zig");
const NetworkInformation = @import("NetworkInformation.zig");
const MediaCapabilities = @import("MediaCapabilities.zig");
const navigator_extras = @import("navigator_extras.zig");

const log = @import("../../support/log.zig");

const Navigator = @This();
_pad: bool = false,
_plugins: PluginArray = .{},
_mime_types: PluginArray.MimeTypeArray = .{},
_permissions: Permissions = .{},
_storage: StorageManager = .{},
_ua_data: NavigatorUAData = .{},
_media_devices: navigator_extras.MediaDevices = .{},
_clipboard: navigator_extras.Clipboard = .{},
_credentials: navigator_extras.CredentialsContainer = .{},
_bluetooth: navigator_extras.Bluetooth = .{},
_gpu: navigator_extras.GPU = .{},
_usb: navigator_extras.USB = .{},
_serial: navigator_extras.Serial = .{},
_hid: navigator_extras.HID = .{},
_keyboard: navigator_extras.Keyboard = .{},
_locks: navigator_extras.LockManager = .{},
_wake_lock: navigator_extras.WakeLock = .{},
_contacts: navigator_extras.ContactsManager = .{},
_service_worker: navigator_extras.ServiceWorkerContainer = .{},

pub const init: Navigator = .{};

fn identityProfile() *const FingerprintProfile.IdentityProfile {
    return FingerprintProfile.defaultIdentity();
}

pub fn getUserAgent(_: *const Navigator, frame: *Frame) []const u8 {
    return frame._session.browser.http_client.getUserAgent();
}

pub fn getLanguages(_: *const Navigator) [2][]const u8 {
    const profile = identityProfile();
    return .{ profile.languages[0], profile.languages[1] };
}

pub fn getPlatform(_: *const Navigator) []const u8 {
    return identityProfile().navigator_platform;
}

/// Returns whether Java is enabled (always false)
pub fn javaEnabled(_: *const Navigator) bool {
    return false;
}

pub fn getPlugins(self: *Navigator) *PluginArray {
    return &self._plugins;
}

pub fn getMimeTypes(self: *Navigator) *PluginArray.MimeTypeArray {
    return &self._mime_types;
}

pub fn getPermissions(self: *Navigator) *Permissions {
    return &self._permissions;
}

pub fn getStorage(self: *Navigator) *StorageManager {
    return &self._storage;
}

pub fn getUserAgentData(_: *const Navigator) NavigatorUAData {
    return .{};
}

pub fn getHardwareConcurrency(_: *const Navigator) u32 {
    return identityProfile().hardware_concurrency;
}

pub fn getDeviceMemory(_: *const Navigator) f64 {
    return identityProfile().device_memory;
}

pub fn getMaxTouchPoints(_: *const Navigator) u32 {
    return identityProfile().max_touch_points;
}

pub fn getVendor(_: *const Navigator) []const u8 {
    return identityProfile().vendor;
}

pub fn getGlobalPrivacyControl(_: *const Navigator) bool {
    return identityProfile().global_privacy_control;
}

pub fn getConnection(_: *const Navigator) NetworkInformation {
    return .{};
}

pub fn getMediaCapabilities(_: *const Navigator) MediaCapabilities {
    return .{};
}

pub fn getMediaDevices(self: *Navigator) *navigator_extras.MediaDevices {
    return &self._media_devices;
}

pub fn getClipboard(self: *Navigator) *navigator_extras.Clipboard {
    return &self._clipboard;
}

pub fn getCredentials(self: *Navigator) *navigator_extras.CredentialsContainer {
    return &self._credentials;
}

pub fn getBluetooth(self: *Navigator) *navigator_extras.Bluetooth {
    return &self._bluetooth;
}

pub fn getGpu(self: *Navigator) *navigator_extras.GPU {
    return &self._gpu;
}

pub fn getUsb(self: *Navigator) *navigator_extras.USB {
    return &self._usb;
}

pub fn getSerial(self: *Navigator) *navigator_extras.Serial {
    return &self._serial;
}

pub fn getHid(self: *Navigator) *navigator_extras.HID {
    return &self._hid;
}

pub fn getKeyboard(self: *Navigator) *navigator_extras.Keyboard {
    return &self._keyboard;
}

pub fn getLocks(self: *Navigator) *navigator_extras.LockManager {
    return &self._locks;
}

pub fn getWakeLock(self: *Navigator) *navigator_extras.WakeLock {
    return &self._wake_lock;
}

pub fn getContacts(self: *Navigator) *navigator_extras.ContactsManager {
    return &self._contacts;
}

pub fn getServiceWorker(self: *Navigator) *navigator_extras.ServiceWorkerContainer {
    return &self._service_worker;
}

pub fn getPdfViewerEnabled(_: *const Navigator) bool {
    return identityProfile().pdf_viewer_enabled;
}

pub fn getOscpu(_: *const Navigator) ?[]const u8 {
    return null;
}

pub fn share(_: *const Navigator, _: js.Value, frame: *Frame) !js.Promise {
    const local = frame.js.local orelse return error.NotHandled;
    return local.rejectPromise(.{ .dom_exception = .{ .err = error.SecurityError } });
}

pub fn canShare(_: *const Navigator, _: ?js.Value) bool {
    return false;
}

pub fn getBattery(_: *const Navigator, frame: *Frame) !js.Promise {
    const battery = try BatteryManager.init(frame);
    return frame.js.local.?.resolvePromise(battery);
}

pub fn registerProtocolHandler(_: *const Navigator, scheme: []const u8, url: [:0]const u8, frame: *const Frame) !void {
    try validateProtocolHandlerScheme(scheme);
    try validateProtocolHandlerURL(url, frame);
}
pub fn unregisterProtocolHandler(_: *const Navigator, scheme: []const u8, url: [:0]const u8, frame: *const Frame) !void {
    try validateProtocolHandlerScheme(scheme);
    try validateProtocolHandlerURL(url, frame);
}

fn validateProtocolHandlerScheme(scheme: []const u8) !void {
    const allowed = std.StaticStringMap(void).initComptime(.{
        .{ "bitcoin", {} },
        .{ "cabal", {} },
        .{ "dat", {} },
        .{ "did", {} },
        .{ "dweb", {} },
        .{ "ethereum", .{} },
        .{ "ftp", {} },
        .{ "ftps", {} },
        .{ "geo", {} },
        .{ "im", {} },
        .{ "ipfs", {} },
        .{ "ipns", .{} },
        .{ "irc", {} },
        .{ "ircs", {} },
        .{ "hyper", {} },
        .{ "magnet", {} },
        .{ "mailto", {} },
        .{ "matrix", {} },
        .{ "mms", {} },
        .{ "news", {} },
        .{ "nntp", {} },
        .{ "openpgp4fpr", {} },
        .{ "sftp", {} },
        .{ "sip", {} },
        .{ "sms", {} },
        .{ "smsto", {} },
        .{ "ssb", {} },
        .{ "ssh", {} },
        .{ "tel", {} },
        .{ "urn", {} },
        .{ "webcal", {} },
        .{ "wtai", {} },
        .{ "xmpp", {} },
    });
    if (allowed.has(scheme)) {
        return;
    }

    if (scheme.len < 5 or !std.mem.startsWith(u8, scheme, "web+")) {
        return error.SecurityError;
    }
    for (scheme[4..]) |b| {
        if (std.ascii.isLower(b) == false) {
            return error.SecurityError;
        }
    }
}

fn validateProtocolHandlerURL(url: [:0]const u8, frame: *const Frame) !void {
    if (std.mem.indexOf(u8, url, "%s") == null) {
        return error.SyntaxError;
    }
    if (frame.isSameOrigin(url) == false) {
        return error.SyntaxError;
    }
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(Navigator);

    pub const Meta = struct {
        pub const name = "Navigator";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
        pub const empty_with_no_proto = true;
    };

    // Read-only properties
    pub const userAgent = bridge.accessor(Navigator.getUserAgent, null, .{});
    pub const appName = bridge.attribute("Netscape", .{});
    pub const appCodeName = bridge.attribute("Netscape", .{});
    pub const appVersion = bridge.attribute("1.0", .{});
    pub const platform = bridge.accessor(Navigator.getPlatform, null, .{});
    pub const language = bridge.attribute("en-US", .{});
    pub const languages = bridge.accessor(Navigator.getLanguages, null, .{});
    pub const onLine = bridge.attribute(true, .{});
    pub const cookieEnabled = bridge.attribute(true, .{});
    pub const hardwareConcurrency = bridge.accessor(Navigator.getHardwareConcurrency, null, .{});
    pub const deviceMemory = bridge.accessor(Navigator.getDeviceMemory, null, .{});
    pub const maxTouchPoints = bridge.accessor(Navigator.getMaxTouchPoints, null, .{});
    pub const vendor = bridge.accessor(Navigator.getVendor, null, .{});
    pub const product = bridge.attribute("Gecko", .{});
    pub const webdriver = bridge.attribute(false, .{});
    pub const plugins = bridge.accessor(Navigator.getPlugins, null, .{});
    pub const mimeTypes = bridge.accessor(Navigator.getMimeTypes, null, .{});
    pub const doNotTrack = bridge.attribute(null, .{});
    pub const globalPrivacyControl = bridge.accessor(Navigator.getGlobalPrivacyControl, null, .{});
    pub const registerProtocolHandler = bridge.function(Navigator.registerProtocolHandler, .{ .dom_exception = true });
    pub const unregisterProtocolHandler = bridge.function(Navigator.unregisterProtocolHandler, .{ .dom_exception = true });

    // Methods
    pub const javaEnabled = bridge.function(Navigator.javaEnabled, .{});
    pub const getBattery = bridge.function(Navigator.getBattery, .{});
    pub const permissions = bridge.accessor(Navigator.getPermissions, null, .{});
    pub const storage = bridge.accessor(Navigator.getStorage, null, .{});
    pub const userAgentData = bridge.accessor(Navigator.getUserAgentData, null, .{});
    pub const connection = bridge.accessor(Navigator.getConnection, null, .{});
    pub const mediaCapabilities = bridge.accessor(Navigator.getMediaCapabilities, null, .{});
    pub const mediaDevices = bridge.accessor(Navigator.getMediaDevices, null, .{});
    pub const clipboard = bridge.accessor(Navigator.getClipboard, null, .{});
    pub const credentials = bridge.accessor(Navigator.getCredentials, null, .{});
    pub const bluetooth = bridge.accessor(Navigator.getBluetooth, null, .{});
    pub const gpu = bridge.accessor(Navigator.getGpu, null, .{});
    pub const usb = bridge.accessor(Navigator.getUsb, null, .{});
    pub const serial = bridge.accessor(Navigator.getSerial, null, .{});
    pub const hid = bridge.accessor(Navigator.getHid, null, .{});
    pub const keyboard = bridge.accessor(Navigator.getKeyboard, null, .{});
    pub const locks = bridge.accessor(Navigator.getLocks, null, .{});
    pub const wakeLock = bridge.accessor(Navigator.getWakeLock, null, .{});
    pub const contacts = bridge.accessor(Navigator.getContacts, null, .{});
    pub const serviceWorker = bridge.accessor(Navigator.getServiceWorker, null, .{});
    pub const pdfViewerEnabled = bridge.accessor(Navigator.getPdfViewerEnabled, null, .{});
    pub const oscpu = bridge.accessor(Navigator.getOscpu, null, .{});
    pub const share = bridge.function(Navigator.share, .{ .dom_exception = true });
    pub const canShare = bridge.function(Navigator.canShare, .{});
};

const testing = @import("../../testing/testing.zig");
test "WebApi: Navigator" {
    try testing.htmlRunner("navigator", .{});
}
