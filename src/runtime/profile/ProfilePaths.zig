const std = @import("std");
const builtin = @import("builtin");
const log = @import("../../support/log.zig");
const ProfileManager = @import("ProfileManager.zig");

const Allocator = std.mem.Allocator;

pub const default_profile_name = "Default";
pub const cookies_filename = "Cookies.json";
pub const preferences_filename = "Preferences.json";
pub const local_storage_dirname = "Local Storage";
pub const cache_dirname = "Cache";

pub const Preferences = struct {
    version: u32 = 3,
    name: []const u8,
    fingerprint: []const u8,
    created: []const u8 = "",
};

pub const ProfilePaths = struct {
    allocator: Allocator,
    user_data_dir: []const u8,
    profile_name: []const u8,
    profile_dir: []const u8,
    /// CLI override pointing to a self-contained fingerprint folder.
    fingerprint_override: ?[]const u8 = null,

    pub fn init(
        allocator: Allocator,
        user_data_dir_cli: ?[]const u8,
        profile_name_cli: ?[]const u8,
        fingerprint_override: ?[]const u8,
    ) !ProfilePaths {
        const user_data_dir = if (user_data_dir_cli) |p|
            try allocator.dupe(u8, p)
        else
            try defaultUserDataDir(allocator);

        const profile_name = if (profile_name_cli) |n|
            try allocator.dupe(u8, n)
        else
            try allocator.dupe(u8, default_profile_name);

        const profile_dir = try std.fs.path.join(allocator, &.{ user_data_dir, profile_name });

        const override = if (fingerprint_override) |s| try allocator.dupe(u8, s) else null;

        return .{
            .allocator = allocator,
            .user_data_dir = user_data_dir,
            .profile_name = profile_name,
            .profile_dir = profile_dir,
            .fingerprint_override = override,
        };
    }

    pub fn deinit(self: *ProfilePaths) void {
        if (self.fingerprint_override) |s| self.allocator.free(s);
        self.allocator.free(self.profile_dir);
        self.allocator.free(self.profile_name);
        self.allocator.free(self.user_data_dir);
        self.* = undefined;
    }

    pub fn cookiesPath(self: *const ProfilePaths, buf: []u8) ?[]const u8 {
        return std.fmt.bufPrint(buf, "{s}/{s}", .{ self.profile_dir, cookies_filename }) catch null;
    }

    pub fn cookiesPathAlloc(self: *const ProfilePaths) ![]const u8 {
        return std.fs.path.join(self.allocator, &.{ self.profile_dir, cookies_filename });
    }

    pub fn preferencesPath(self: *const ProfilePaths, buf: []u8) ?[]const u8 {
        return std.fmt.bufPrint(buf, "{s}/{s}", .{ self.profile_dir, preferences_filename }) catch null;
    }

    pub fn localStorageDir(self: *const ProfilePaths, buf: []u8) ?[]const u8 {
        return std.fmt.bufPrint(buf, "{s}/{s}", .{ self.profile_dir, local_storage_dirname }) catch null;
    }

    pub fn localStorageDirAlloc(self: *const ProfilePaths) ![]const u8 {
        return std.fs.path.join(self.allocator, &.{ self.profile_dir, local_storage_dirname });
    }

    pub fn cacheDir(self: *const ProfilePaths, buf: []u8) ?[]const u8 {
        return std.fmt.bufPrint(buf, "{s}/{s}", .{ self.profile_dir, cache_dirname }) catch null;
    }

    pub fn cacheDirAlloc(self: *const ProfilePaths) ![]const u8 {
        return std.fs.path.join(self.allocator, &.{ self.profile_dir, cache_dirname });
    }

    /// Ensure user-data-dir and profile folder exist; create Preferences.json when missing.
    pub fn ensureProfileReady(self: *const ProfilePaths) !void {
        try self.ensureProfileReadyWithFingerprint(ProfileManager.defaultFingerprintForName(self.profile_name));
    }

    pub fn ensureProfileReadyWithFingerprint(self: *const ProfilePaths, fingerprint: []const u8) !void {
        try std.fs.cwd().makePath(self.user_data_dir);
        try std.fs.cwd().makePath(self.profile_dir);

        var prefs_buf: [512]u8 = undefined;
        const prefs_path = self.preferencesPath(&prefs_buf) orelse return error.PathTooLong;

        if (fileExists(prefs_path)) return;

        try writePreferences(prefs_path, .{
            .name = self.profile_name,
            .fingerprint = fingerprint,
        });
        log.info(.app, "profile_paths.created", .{
            .profile_dir = self.profile_dir,
            .fingerprint = fingerprint,
        });
    }

    pub fn readPreferences(self: *const ProfilePaths, arena: Allocator) !Preferences {
        var prefs_buf: [512]u8 = undefined;
        const prefs_path = self.preferencesPath(&prefs_buf) orelse return error.PathTooLong;

        const bytes = std.fs.cwd().readFileAlloc(arena, prefs_path, 64 * 1024) catch |err| switch (err) {
            error.FileNotFound => {
                return .{
                    .name = self.profile_name,
                    .fingerprint = self.profile_name,
                };
            },
            else => return err,
        };

        const parsed = try std.json.parseFromSliceLeaky(Preferences, arena, bytes, .{
            .ignore_unknown_fields = true,
        });
        if (parsed.version != 3) return error.UnsupportedProfilePreferencesVersion;
        if (parsed.fingerprint.len == 0) return error.MissingFingerprintId;
        return .{
            .version = parsed.version,
            .name = if (parsed.name.len > 0) parsed.name else self.profile_name,
            .fingerprint = parsed.fingerprint,
            .created = parsed.created,
        };
    }
};

fn defaultUserDataDir(allocator: Allocator) ![]const u8 {
    if (builtin.is_test) {
        return try allocator.dupe(u8, "/tmp/koko-test-user-data");
    }
    return std.fs.getAppDataDir(allocator, "koko") catch |err| {
        log.warn(.app, "profile_paths.app_data_dir", .{ .err = err });
        return try allocator.dupe(u8, ".koko-user-data");
    };
}

fn fileExists(path: []const u8) bool {
    std.fs.cwd().access(path, .{}) catch return false;
    return true;
}

fn writePreferences(path: []const u8, prefs: Preferences) !void {
    var file = try std.fs.cwd().createFile(path, .{ .truncate = true });
    defer file.close();
    var buf: [1024]u8 = undefined;
    var writer = file.writer(&buf);
    try std.json.Stringify.value(.{
        .version = 3,
        .name = prefs.name,
        .fingerprint = prefs.fingerprint,
        .created = prefs.created,
    }, .{}, &writer.interface);
    try writer.interface.writeByte('\n');
    try writer.end();
}

const testing = @import("../../testing/testing.zig");

test "ProfilePaths: default layout" {
    const allocator = std.testing.allocator;
    var paths = try ProfilePaths.init(allocator, "/tmp/koko-profile-paths-test", "TestProfile", null);
    defer paths.deinit();

    var buf: [512]u8 = undefined;
    const cookies = paths.cookiesPath(&buf).?;
    try testing.expect(std.mem.endsWith(u8, cookies, "/TestProfile/Cookies.json"));
}
