const std = @import("std");
const WindowProfile = @import("../../core/profile/types.zig").WindowProfile;

pub const DeviceMetrics = struct {
    width: u32,
    height: u32,
    device_scale_factor: f64,
    mobile: bool,
};

pub const Geolocation = struct {
    latitude: f64,
    longitude: f64,
    accuracy: f64,
};

/// Per BrowserContext CDP emulation overrides (Chrome DevTools Emulation domain).
pub const State = struct {
    device_metrics: ?DeviceMetrics = null,
    touch_enabled: bool = false,
    max_touch_points: u32 = 0,
    focus_emulation_enabled: bool = false,
    emulated_media: ?[]const u8 = null,
    timezone_id: ?[]const u8 = null,
    locale: ?[]const u8 = null,
    accept_language: ?[]const u8 = null,
    platform: ?[]const u8 = null,
    geolocation: ?Geolocation = null,
    granted_permissions: std.StringHashMapUnmanaged(void) = .{},

    pub fn windowProfile(self: *const State, base: WindowProfile) WindowProfile {
        const dm = self.device_metrics orelse return base;
        const chrome_h: u32 = if (dm.mobile) 0 else 85;
        return .{
            .inner_width = dm.width,
            .inner_height = dm.height,
            .outer_width = dm.width,
            .outer_height = dm.height + chrome_h,
        };
    }

    pub fn devicePixelRatio(self: *const State, base: f64) f64 {
        return if (self.device_metrics) |dm| dm.device_scale_factor else base;
    }

    pub fn effectiveTimezone(self: *const State, base: []const u8) []const u8 {
        return self.timezone_id orelse base;
    }

    pub fn effectiveLocale(self: *const State, base: []const u8) []const u8 {
        return self.locale orelse base;
    }

    pub fn effectiveMaxTouchPoints(self: *const State, base: u32) u32 {
        if (self.touch_enabled) return @max(self.max_touch_points, 1);
        return base;
    }

    pub fn isPermissionGranted(self: *const State, name: []const u8) bool {
        return self.granted_permissions.contains(name);
    }

    pub fn setDeviceMetrics(self: *State, dm: DeviceMetrics) void {
        self.device_metrics = dm;
    }

    pub fn clearDeviceMetrics(self: *State) void {
        self.device_metrics = null;
    }

    pub fn dupString(_: *State, arena: std.mem.Allocator, value: []const u8) ![]const u8 {
        return try arena.dupe(u8, value);
    }

    pub fn grantPermission(self: *State, arena: std.mem.Allocator, name: []const u8) !void {
        const owned = try arena.dupe(u8, name);
        try self.granted_permissions.put(arena, owned, {});
    }

    pub fn resetPermissions(self: *State, allocator: std.mem.Allocator) void {
        self.granted_permissions.deinit(allocator);
        self.granted_permissions = .{};
    }

    pub fn deinit(self: *State, allocator: std.mem.Allocator) void {
        self.granted_permissions.deinit(allocator);
    }
};
