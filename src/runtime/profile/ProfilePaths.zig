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
    version: u32 = 1,
    name: []const u8,
    template: []const u8,
    /// Pinned catalog version for SaaS template registry (default 1).
    template_version: u32 = 1,
    /// Relative subdir under profile_dir containing fingerprint.json (e.g. "snapshot").
    snapshot: []const u8 = "",
    created: []const u8 = "",
};

pub const ProfilePaths = struct {
    allocator: Allocator,
    user_data_dir: []const u8,
    profile_name: []const u8,
    profile_dir: []const u8,
    /// CLI `--profile-snapshot` override (absolute path to fingerprint.json or bundle snapshot dir).
    snapshot_cli: ?[]const u8 = null,

    pub fn init(
        allocator: Allocator,
        user_data_dir_cli: ?[]const u8,
        profile_name_cli: ?[]const u8,
        snapshot_cli: ?[]const u8,
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

        const snapshot = if (snapshot_cli) |s| try allocator.dupe(u8, s) else null;

        return .{
            .allocator = allocator,
            .user_data_dir = user_data_dir,
            .profile_name = profile_name,
            .profile_dir = profile_dir,
            .snapshot_cli = snapshot,
        };
    }

    pub fn deinit(self: *ProfilePaths) void {
        if (self.snapshot_cli) |s| self.allocator.free(s);
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
        try self.ensureProfileReadyWithTemplate(ProfileManager.defaultTemplateForName(self.profile_name));
    }

    pub fn ensureProfileReadyWithTemplate(self: *const ProfilePaths, template: []const u8) !void {
        try std.fs.cwd().makePath(self.user_data_dir);
        try std.fs.cwd().makePath(self.profile_dir);

        var prefs_buf: [512]u8 = undefined;
        const prefs_path = self.preferencesPath(&prefs_buf) orelse return error.PathTooLong;

        if (fileExists(prefs_path)) return;

        try writePreferences(prefs_path, .{
            .name = self.profile_name,
            .template = template,
        });
        log.info(.app, "profile_paths.created", .{
            .profile_dir = self.profile_dir,
            .template = template,
        });
    }

    pub fn readPreferences(self: *const ProfilePaths, arena: Allocator) !Preferences {
        var prefs_buf: [512]u8 = undefined;
        const prefs_path = self.preferencesPath(&prefs_buf) orelse return error.PathTooLong;

        const bytes = std.fs.cwd().readFileAlloc(arena, prefs_path, 64 * 1024) catch |err| switch (err) {
            error.FileNotFound => {
                return .{
                    .name = self.profile_name,
                    .template = self.profile_name,
                };
            },
            else => return err,
        };

        const parsed = try std.json.parseFromSliceLeaky(Preferences, arena, bytes, .{
            .ignore_unknown_fields = true,
        });
        const template = if (parsed.template.len > 0) parsed.template else self.profile_name;
        return .{
            .version = parsed.version,
            .name = if (parsed.name.len > 0) parsed.name else self.profile_name,
            .template = template,
            .template_version = if (parsed.template_version > 0) parsed.template_version else 1,
            .snapshot = parsed.snapshot,
            .created = parsed.created,
        };
    }

    pub fn templateId(self: *const ProfilePaths, arena: Allocator) ![]const u8 {
        const prefs = try self.readPreferences(arena);
        if (std.mem.eql(u8, prefs.template, "velora")) return "velora";
        return try arena.dupe(u8, prefs.template);
    }
};

fn defaultUserDataDir(allocator: Allocator) ![]const u8 {
    if (builtin.is_test) {
        return try allocator.dupe(u8, "/tmp/velora-test-user-data");
    }
    return std.fs.getAppDataDir(allocator, "velora") catch |err| {
        log.warn(.app, "profile_paths.app_data_dir", .{ .err = err });
        return try allocator.dupe(u8, ".velora-user-data");
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
        .version = if (prefs.version > 0) prefs.version else 2,
        .name = prefs.name,
        .template = prefs.template,
        .template_version = if (prefs.template_version > 0) prefs.template_version else 1,
        .snapshot = prefs.snapshot,
        .created = prefs.created,
    }, .{}, &writer.interface);
    try writer.interface.writeByte('\n');
    try writer.end();
}

const testing = @import("../../testing/testing.zig");

test "ProfilePaths: default layout" {
    const allocator = std.testing.allocator;
    var paths = try ProfilePaths.init(allocator, "/tmp/velora-profile-paths-test", "TestProfile", null);
    defer paths.deinit();

    var buf: [512]u8 = undefined;
    const cookies = paths.cookiesPath(&buf).?;
    try testing.expect(std.mem.endsWith(u8, cookies, "/TestProfile/Cookies.json"));
}
