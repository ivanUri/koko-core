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
const Frame = @import("../browser/Frame.zig");
const URL = @import("../browser/URL.zig");
const HttpClient = @import("../browser/HttpClient.zig");
const NavigatorState = @import("NavigatorState.zig");

const PluginArray = @import("PluginArray.zig");
const Permissions = @import("Permissions.zig");
const StorageManager = @import("StorageManager.zig");
const NavigatorUAData = @import("NavigatorUAData.zig");
const BatteryManager = @import("BatteryManager.zig");
const NetworkInformation = @import("NetworkInformation.zig");
const MediaCapabilities = @import("MediaCapabilities.zig");
const navigator_extras = @import("navigator_extras.zig");
const Scheduling = @import("scheduler_api.zig").Scheduling;
const NavigatorLogin = @import("credentials_api.zig").NavigatorLogin;

const log = @import("../../support/log.zig");

const Navigator = @This();
_pad: bool = false,
// Heap-backed PluginArray avoids identity-map collisions between the embedded
// field address and the parent Navigator pointer (see Permissions._pad note).
_plugin_store: ?*PluginArray = null,
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
_scheduling: Scheduling = .{},
_login: NavigatorLogin = .{},

pub const init: Navigator = .{};

pub fn getUserAgent(_: *const Navigator, frame: *Frame) []const u8 {
    return frame.navigatorState().userAgent();
}

pub fn getLanguages(_: *const Navigator, frame: *Frame) []const []const u8 {
    return frame.navigatorState().languages();
}

pub fn getLanguage(_: *const Navigator, frame: *Frame) []const u8 {
    return frame.navigatorState().language();
}

pub fn getPlatform(_: *const Navigator, frame: *Frame) []const u8 {
    return frame.navigatorState().platform();
}

pub fn getAppName(_: *const Navigator, _: *Frame) []const u8 {
    return "Netscape";
}

pub fn getAppCodeName(_: *const Navigator, _: *Frame) []const u8 {
    return "Mozilla";
}

pub fn getAppVersion(_: *const Navigator, frame: *Frame) []const u8 {
    return frame.navigatorState().appVersion();
}

/// Returns whether Java is enabled (always false)
pub fn javaEnabled(_: *const Navigator) bool {
    return false;
}

pub fn getPlugins(self: *Navigator, frame: *Frame) *PluginArray {
    if (self._plugin_store) |stored| {
        stored.ensureChrome(frame) catch {};
        return stored;
    }
    const stored = frame.arena.create(PluginArray) catch unreachable;
    stored.* = .{};
    stored.ensureChrome(frame) catch {};
    self._plugin_store = stored;
    return stored;
}

pub fn getMimeTypes(self: *Navigator, frame: *Frame) *PluginArray.MimeTypeArray {
    return self.getPlugins(frame).getMimeTypes();
}

pub fn getPermissions(self: *Navigator) *Permissions {
    return &self._permissions;
}

pub fn getStorage(self: *Navigator) *StorageManager {
    return &self._storage;
}

pub fn getUserAgentData(self: *Navigator, frame: *Frame) ?*NavigatorUAData {
    if (!frame.navigatorState().userAgentDataEnabled(
        frame.loadedProfile().persona.features.user_agent_data,
    )) return null;
    return &self._ua_data;
}

pub fn getHardwareConcurrency(_: *const Navigator, frame: *Frame) u32 {
    return frame.navigatorState().hardwareConcurrency();
}

pub fn getDeviceMemory(_: *const Navigator, frame: *Frame) f64 {
    return frame.navigatorState().deviceMemory();
}

pub fn getMaxTouchPoints(_: *const Navigator, frame: *Frame) u32 {
    return frame.navigatorState().maxTouchPoints();
}

pub fn getVendor(_: *const Navigator, frame: *Frame) []const u8 {
    return frame.navigatorState().vendor();
}

pub fn getProduct(_: *const Navigator, _: *Frame) []const u8 {
    return "Gecko";
}

pub fn getProductSub(_: *const Navigator, frame: *Frame) []const u8 {
    return frame.navigatorState().productSub();
}

pub fn getVendorSub(_: *const Navigator, frame: *Frame) []const u8 {
    return frame.navigatorState().vendorSub();
}

pub fn getWebdriver(_: *const Navigator, _: *Frame) bool {
    return false;
}

pub fn getDoNotTrack(_: *const Navigator, _: *Frame) ?[]const u8 {
    return null;
}

pub fn getOnLine(_: *const Navigator, _: *Frame) bool {
    return true;
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

pub fn getGpu(self: *Navigator, frame: *Frame) ?*navigator_extras.GPU {
    // WebGPU is a secure-context API. Returning no implementation for an
    // untrustworthy realm avoids advertising an adapter that the browser
    // cannot actually make available there.
    if (!frame.isSecureContext()) return null;
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

pub fn getScheduling(self: *Navigator) *Scheduling {
    return &self._scheduling;
}

pub fn getLogin(self: *Navigator) *NavigatorLogin {
    return &self._login;
}

pub fn getPdfViewerEnabled(_: *const Navigator, frame: *Frame) bool {
    return frame.navigatorState().pdfViewerEnabled();
}

pub fn getOscpu(_: *const Navigator) ?[]const u8 {
    return null;
}

pub fn share(_: *const Navigator, _: js.Value, frame: *Frame) !js.Promise {
    const local = frame.js.local orelse return error.NotHandled;
    return local.rejectPromise(.{ .dom_exception = .{ .err = error.SecurityError } });
}

pub fn canShare(_: *const Navigator, data: ?js.Value) bool {
    const val = data orelse return false;
    if (!val.isObject()) return false;

    const obj = val.toObject();
    const url_val = obj.get("url") catch return false;
    if (!url_val.isUndefined() and !url_val.isNull()) {
        const url = url_val.toStringSlice() catch return false;
        return std.ascii.startsWithIgnoreCase(url, "http://") or
            std.ascii.startsWithIgnoreCase(url, "https://");
    }

    const text_val = obj.get("text") catch return false;
    if (!text_val.isUndefined() and !text_val.isNull()) {
        const text = text_val.toStringSlice() catch return false;
        return text.len > 0;
    }

    return false;
}

const BeaconSink = struct {
    fn headerCallback(_: HttpClient.Response) anyerror!bool {
        return true;
    }
    fn dataCallback(_: HttpClient.Response, _: []const u8) anyerror!void {}
    fn doneCallback(_: *anyopaque) anyerror!void {}
    fn errorCallback(_: *anyopaque, _: anyerror) void {}
};

var beacon_sink: BeaconSink = .{};

pub fn sendBeacon(_: *const Navigator, url_val: js.Value, data_val: ?js.Value, frame: *Frame) !bool {
    const arena = frame.arena;
    const url_input = try url_val.toStringSlice();
    const resolved = try URL.resolve(arena, frame.url, url_input, .{});
    const url = try arena.dupeZ(u8, resolved);

    var body: ?[]const u8 = null;
    var content_type: ?[]const u8 = null;
    if (data_val) |dv| {
        if (!dv.isUndefined() and !dv.isNull()) {
            if (dv.isString()) |_| {
                body = try dv.toStringSlice();
                content_type = "text/plain;charset=UTF-8";
            }
        }
    }

    const session = frame._session;
    const http_client = &session.browser.http_client;
    var headers = try http_client.newHeaders();
    if (content_type) |ct| {
        const hdr = try std.fmt.allocPrintSentinel(arena, "Content-Type: {s}", .{ct}, 0);
        try headers.add(hdr);
    }
    try frame.headersForRequest(&headers, .{
        .request_url = url,
        .resource_type = .beacon,
    });

    http_client.request(.{
        .ctx = @ptrCast(&beacon_sink),
        .params = .{
            .url = url,
            .method = .POST,
            .headers = headers,
            .body = body,
            .frame_id = frame._frame_id,
            .loader_id = frame._loader_id,
            .cookie_jar = &session.cookie_jar,
            .cookie_origin = frame.url,
            .top_level_cookie_url = frame.topLevelUrl(),
            .resource_type = .beacon,
            // Chrome sendBeacon is keepalive: may finish after unload. Attribute
            // while the frame is alive; keepalive skips normal re-nav abort.
            .attribution_frame = frame,
            .keepalive = true,
            .notification = session.notification,
        },
        .header_callback = BeaconSink.headerCallback,
        .data_callback = BeaconSink.dataCallback,
        .done_callback = BeaconSink.doneCallback,
        .error_callback = BeaconSink.errorCallback,
    }) catch return false;

    return true;
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

pub fn setAppBadge(_: *const Navigator, _: ?js.Value, frame: *Frame) !js.Promise {
    const local = frame.js.local orelse return error.NotHandled;
    return local.resolvePromise(js.Undefined{});
}

pub fn clearAppBadge(_: *const Navigator, frame: *Frame) !js.Promise {
    const local = frame.js.local orelse return error.NotHandled;
    return local.resolvePromise(js.Undefined{});
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(Navigator);

    pub const Meta = struct {
        pub const name = "Navigator";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    // Read-only properties
    pub const userAgent = bridge.accessor(Navigator.getUserAgent, null, .{});
    pub const appName = bridge.accessor(Navigator.getAppName, null, .{});
    pub const appCodeName = bridge.accessor(Navigator.getAppCodeName, null, .{});
    pub const appVersion = bridge.accessor(Navigator.getAppVersion, null, .{});
    pub const platform = bridge.accessor(Navigator.getPlatform, null, .{});
    pub const language = bridge.accessor(Navigator.getLanguage, null, .{});
    pub const languages = bridge.accessor(Navigator.getLanguages, null, .{});
    pub const onLine = bridge.accessor(Navigator.getOnLine, null, .{});
    pub const cookieEnabled = bridge.attribute(true, .{});
    pub const hardwareConcurrency = bridge.accessor(Navigator.getHardwareConcurrency, null, .{});
    pub const deviceMemory = bridge.accessor(Navigator.getDeviceMemory, null, .{});
    pub const maxTouchPoints = bridge.accessor(Navigator.getMaxTouchPoints, null, .{});
    pub const vendor = bridge.accessor(Navigator.getVendor, null, .{});
    pub const product = bridge.accessor(Navigator.getProduct, null, .{});
    pub const productSub = bridge.accessor(Navigator.getProductSub, null, .{});
    pub const vendorSub = bridge.accessor(Navigator.getVendorSub, null, .{});
    pub const webdriver = bridge.accessor(Navigator.getWebdriver, null, .{});
    pub const plugins = bridge.accessor(Navigator.getPlugins, null, .{});
    pub const mimeTypes = bridge.accessor(Navigator.getMimeTypes, null, .{});
    pub const doNotTrack = bridge.accessor(Navigator.getDoNotTrack, null, .{});
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
    pub const scheduling = bridge.accessor(Navigator.getScheduling, null, .{});
    pub const login = bridge.accessor(Navigator.getLogin, null, .{});
    pub const pdfViewerEnabled = bridge.accessor(Navigator.getPdfViewerEnabled, null, .{});
    pub const oscpu = bridge.accessor(Navigator.getOscpu, null, .{ .null_as_undefined = true });
    pub const share = bridge.function(Navigator.share, .{ .dom_exception = true });
    pub const canShare = bridge.function(Navigator.canShare, .{});
    pub const sendBeacon = bridge.function(Navigator.sendBeacon, .{});
    pub const setAppBadge = bridge.function(Navigator.setAppBadge, .{ .dom_exception = true });
    pub const clearAppBadge = bridge.function(Navigator.clearAppBadge, .{ .dom_exception = true });
};

const testing = @import("../../testing/testing.zig");
test "WebApi: Navigator" {
    try testing.htmlRunner("navigator", .{});
}
