const std = @import("std");
const ProfilePaths = @import("ProfilePaths.zig");
const ProfileSnapshot = @import("ProfileSnapshot.zig");
const BrowserRoot = @import("BrowserRoot.zig");
const log = @import("../../support/log.zig");

const Allocator = std.mem.Allocator;

pub const local_state_filename = "Local State.json";

pub const LocalState = struct {
    version: u32 = 1,
    profiles: []const []const u8 = &.{},
    last_used: []const u8 = ProfilePaths.default_profile_name,
};

pub const ProfileEntry = struct {
    name: []const u8,
    template: []const u8,
    profile_dir: []const u8,
};

pub fn defaultTemplateForName(name: []const u8) []const u8 {
    if (std.mem.eql(u8, name, ProfilePaths.default_profile_name)) return "velora";
    return name;
}

pub fn localStatePath(user_data_dir: []const u8, buf: []u8) ?[]const u8 {
    return std.fmt.bufPrint(buf, "{s}/{s}", .{ user_data_dir, local_state_filename }) catch null;
}

fn isValidProfileName(name: []const u8) bool {
    if (name.len == 0 or name.len > 128) return false;
    for (name) |c| {
        if (c < 0x20 or c == '/' or c == '\\') return false;
    }
    return true;
}

fn emptyLocalState(allocator: Allocator) !LocalState {
    return .{
        .profiles = try allocator.alloc([]const u8, 0),
        .last_used = try allocator.dupe(u8, ProfilePaths.default_profile_name),
    };
}

/// JSON parse may leave struct defaults as static literals; filter corrupt entries.
fn sanitizeLocalState(allocator: Allocator, state: LocalState) !LocalState {
    var profiles = try std.ArrayList([]const u8).initCapacity(allocator, state.profiles.len);
    errdefer {
        for (profiles.items) |n| allocator.free(n);
        profiles.deinit(allocator);
    }

    for (state.profiles) |name| {
        if (!isValidProfileName(name)) continue;
        try profiles.append(allocator, try allocator.dupe(u8, name));
    }

    const last_used = if (isValidProfileName(state.last_used))
        try allocator.dupe(u8, state.last_used)
    else
        try allocator.dupe(u8, ProfilePaths.default_profile_name);

    return .{
        .version = state.version,
        .profiles = try profiles.toOwnedSlice(allocator),
        .last_used = last_used,
    };
}

pub fn loadLocalState(allocator: Allocator, user_data_dir: []const u8) !LocalState {
    var path_buf: [512]u8 = undefined;
    const path = localStatePath(user_data_dir, &path_buf) orelse return error.PathTooLong;

    const bytes = std.fs.cwd().readFileAlloc(allocator, path, 256 * 1024) catch |err| switch (err) {
        error.FileNotFound => return try emptyLocalState(allocator),
        else => return err,
    };
    defer allocator.free(bytes);

    const parsed = std.json.parseFromSliceLeaky(LocalState, allocator, bytes, .{
        .ignore_unknown_fields = true,
    }) catch return try emptyLocalState(allocator);
    return try sanitizeLocalState(allocator, parsed);
}

pub fn saveLocalState(allocator: Allocator, user_data_dir: []const u8, state: LocalState) !void {
    try std.fs.cwd().makePath(user_data_dir);
    var path_buf: [512]u8 = undefined;
    const path = localStatePath(user_data_dir, &path_buf) orelse return error.PathTooLong;

    var file = try std.fs.cwd().createFile(path, .{ .truncate = true });
    defer file.close();
    var buf: [4096]u8 = undefined;
    var writer = file.writer(&buf);
    try std.json.Stringify.value(state, .{}, &writer.interface);
    try writer.interface.writeByte('\n');
    try writer.end();
    _ = allocator;
}

pub fn discoverProfiles(allocator: Allocator, user_data_dir: []const u8) ![][]const u8 {
    var names = try std.ArrayList([]const u8).initCapacity(allocator, 8);
    errdefer {
        for (names.items) |n| allocator.free(n);
        names.deinit(allocator);
    }

    var dir = try std.fs.cwd().openDir(user_data_dir, .{ .iterate = true });
    defer dir.close();

    var it = dir.iterate();
    while (try it.next()) |entry| {
        if (entry.kind != .directory) continue;
        if (entry.name[0] == '.') continue;
        if (!isValidProfileName(entry.name)) continue;
        try names.append(allocator, try allocator.dupe(u8, entry.name));
    }

    std.mem.sort([]const u8, names.items, {}, struct {
        fn lessThan(_: void, a: []const u8, b: []const u8) bool {
            return std.mem.order(u8, a, b) == .lt;
        }
    }.lessThan);

    return try names.toOwnedSlice(allocator);
}

pub fn syncLocalState(allocator: Allocator, user_data_dir: []const u8) !LocalState {
    const discovered = try discoverProfiles(allocator, user_data_dir);
    defer {
        for (discovered) |n| allocator.free(n);
        allocator.free(discovered);
    }

    var state = try loadLocalState(allocator, user_data_dir);
    errdefer freeLocalState(allocator, &state);

    for (state.profiles) |n| allocator.free(n);
    allocator.free(state.profiles);

    var profiles = try std.ArrayList([]const u8).initCapacity(allocator, discovered.len);
    errdefer {
        for (profiles.items) |n| allocator.free(n);
        profiles.deinit(allocator);
    }
    for (discovered) |name| {
        try profiles.append(allocator, try allocator.dupe(u8, name));
    }
    state.profiles = try profiles.toOwnedSlice(allocator);

    var last_ok = false;
    for (state.profiles) |n| {
        if (std.mem.eql(u8, n, state.last_used)) {
            last_ok = true;
            break;
        }
    }
    if (!last_ok and state.profiles.len > 0) {
        allocator.free(state.last_used);
        state.last_used = try allocator.dupe(u8, state.profiles[0]);
    } else if (!last_ok) {
        allocator.free(state.last_used);
        state.last_used = try allocator.dupe(u8, ProfilePaths.default_profile_name);
    }

    try saveLocalState(allocator, user_data_dir, state);
    return state;
}

pub fn freeLocalState(allocator: Allocator, state: *LocalState) void {
    for (state.profiles) |n| allocator.free(n);
    allocator.free(state.profiles);
    allocator.free(state.last_used);
    state.* = .{};
}

pub fn recordLastUsed(allocator: Allocator, user_data_dir: []const u8, profile_name: []const u8) !void {
    var state = try syncLocalState(allocator, user_data_dir);
    defer freeLocalState(allocator, &state);

    allocator.free(state.last_used);
    state.last_used = try allocator.dupe(u8, profile_name);
    try saveLocalState(allocator, user_data_dir, state);
}

pub fn resolveActiveProfileName(
    allocator: Allocator,
    user_data_dir: []const u8,
    cli_name: ?[]const u8,
    pool_pick: ?[]const u8,
) ![]const u8 {
    if (cli_name) |name| return try allocator.dupe(u8, name);
    if (pool_pick) |name| return try allocator.dupe(u8, name);
    _ = user_data_dir;
    return try allocator.dupe(u8, ProfilePaths.default_profile_name);
}

pub fn templateExists(template: []const u8, template_version: u32) !bool {
    const path = try templateJsonPath(std.heap.page_allocator, template);
    defer std.heap.page_allocator.free(path);
    if (try templateFileExists(path)) return true;
    const catalog = try ProfileSnapshot.catalogFingerprintPath(std.heap.page_allocator, template, template_version);
    defer std.heap.page_allocator.free(catalog);
    return try templateFileExists(catalog);
}

pub fn templateJsonPath(allocator: Allocator, template: []const u8) ![]const u8 {
    const root = try BrowserRoot.get(allocator);
    if (std.mem.eql(u8, template, "velora")) {
        return try BrowserRoot.joinPath(allocator, root, "browser/velora.json");
    }
    if (std.mem.indexOfScalar(u8, template, '/')) |_| {
        return try allocator.dupe(u8, template);
    }
    const rel_templates = try std.fmt.allocPrint(allocator, "browser/templates/{s}.json", .{template});
    defer allocator.free(rel_templates);
    const templates = try BrowserRoot.joinPath(allocator, root, rel_templates);
    if (try templateFileExists(templates)) return templates;
    allocator.free(templates);

    const rel_legacy = try std.fmt.allocPrint(allocator, "browser/profiles/{s}.json", .{template});
    defer allocator.free(rel_legacy);
    return try BrowserRoot.joinPath(allocator, root, rel_legacy);
}

fn templateFileExists(path: []const u8) !bool {
    std.fs.cwd().access(path, .{}) catch return false;
    return true;
}

pub fn createProfile(
    allocator: Allocator,
    user_data_dir: []const u8,
    name: []const u8,
    template: []const u8,
    template_version: u32,
) !void {
    if (name.len == 0) return error.InvalidProfileName;
    if (!try templateExists(template, template_version)) return error.UnknownTemplate;

    var paths = try ProfilePaths.ProfilePaths.init(allocator, user_data_dir, name, null);
    defer paths.deinit();

    var prefs_buf: [512]u8 = undefined;
    const prefs_path = paths.preferencesPath(&prefs_buf) orelse return error.PathTooLong;

    if (try templateFileExists(prefs_path)) return error.ProfileAlreadyExists;

    try std.fs.cwd().makePath(paths.user_data_dir);
    try std.fs.cwd().makePath(paths.profile_dir);
    try writePreferences(prefs_path, .{
        .version = 2,
        .name = name,
        .template = template,
        .template_version = template_version,
    });

    _ = try syncLocalState(allocator, user_data_dir);
    try recordLastUsed(allocator, user_data_dir, name);

    log.info(.app, "profile_manager.create", .{ .name = name, .template = template, .dir = paths.profile_dir });
}

pub fn deleteProfile(allocator: Allocator, user_data_dir: []const u8, name: []const u8) !void {
    if (std.mem.eql(u8, name, ProfilePaths.default_profile_name)) return error.CannotDeleteDefaultProfile;

    var paths = try ProfilePaths.ProfilePaths.init(allocator, user_data_dir, name, null);
    defer paths.deinit();

    try std.fs.cwd().deleteTree(paths.profile_dir);

    var state = try syncLocalState(allocator, user_data_dir);
    defer freeLocalState(allocator, &state);

    var kept = try std.ArrayList([]const u8).initCapacity(allocator, state.profiles.len);
    defer kept.deinit(allocator);

    for (state.profiles) |n| {
        if (!std.mem.eql(u8, n, name)) {
            try kept.append(allocator, try allocator.dupe(u8, n));
        }
    }
    allocator.free(state.profiles);
    state.profiles = try kept.toOwnedSlice(allocator);

    if (std.mem.eql(u8, state.last_used, name)) {
        allocator.free(state.last_used);
        state.last_used = if (state.profiles.len > 0)
            try allocator.dupe(u8, state.profiles[0])
        else
            try allocator.dupe(u8, ProfilePaths.default_profile_name);
    }

    try saveLocalState(allocator, user_data_dir, state);
    log.info(.app, "profile_manager.delete", .{ .name = name });
}

pub fn importCookies(
    allocator: Allocator,
    user_data_dir: []const u8,
    name: []const u8,
    from_path: []const u8,
) !void {
    var paths = try ProfilePaths.ProfilePaths.init(allocator, user_data_dir, name, null);
    defer paths.deinit();

    var prefs_buf: [512]u8 = undefined;
    const prefs_path = paths.preferencesPath(&prefs_buf) orelse return error.PathTooLong;
    if (try templateFileExists(prefs_path)) {
        try paths.ensureProfileReadyWithTemplate(defaultTemplateForName(name));
    } else {
        try createProfile(allocator, user_data_dir, name, defaultTemplateForName(name), ProfileSnapshot.default_template_version);
    }

    const cookies_path = try paths.cookiesPathAlloc();
    defer allocator.free(cookies_path);

    try std.fs.cwd().makePath(paths.profile_dir);
    try std.fs.cwd().copyFile(from_path, std.fs.cwd(), cookies_path, .{});

    _ = try syncLocalState(allocator, user_data_dir);
    log.info(.app, "profile_manager.import_cookies", .{ .name = name, .from = from_path, .to = cookies_path });
}

pub fn listProfileEntries(allocator: Allocator, user_data_dir: []const u8) ![]ProfileEntry {
    var state = try syncLocalState(allocator, user_data_dir);
    defer freeLocalState(allocator, &state);

    var out = try std.ArrayList(ProfileEntry).initCapacity(allocator, state.profiles.len);
    errdefer out.deinit(allocator);

    for (state.profiles) |name| {
        var paths = try ProfilePaths.ProfilePaths.init(allocator, user_data_dir, name, null);
        defer paths.deinit();

        var arena = std.heap.ArenaAllocator.init(allocator);
        defer arena.deinit();
        const prefs = paths.readPreferences(arena.allocator()) catch ProfilePaths.Preferences{
            .name = name,
            .template = defaultTemplateForName(name),
        };

        const template_label = if (prefs.template_version > 1)
            try std.fmt.allocPrint(allocator, "{s}@{d}", .{ prefs.template, prefs.template_version })
        else
            try allocator.dupe(u8, prefs.template);

        try out.append(allocator, .{
            .name = try allocator.dupe(u8, name),
            .template = template_label,
            .profile_dir = try allocator.dupe(u8, paths.profile_dir),
        });
    }

    return try out.toOwnedSlice(allocator);
}

pub fn freeProfileEntries(allocator: Allocator, entries: []ProfileEntry) void {
    for (entries) |e| {
        allocator.free(e.name);
        allocator.free(e.template);
        allocator.free(e.profile_dir);
    }
    allocator.free(entries);
}

pub fn ensureFirstRun(allocator: Allocator, user_data_dir: []const u8) !void {
    try std.fs.cwd().makePath(user_data_dir);
    if (!try templateExists("velora", ProfileSnapshot.default_template_version)) return;

    var default_paths = try ProfilePaths.ProfilePaths.init(allocator, user_data_dir, ProfilePaths.default_profile_name, null);
    defer default_paths.deinit();
    try default_paths.ensureProfileReadyWithTemplate("velora");

    _ = try syncLocalState(allocator, user_data_dir);
}

fn writePreferences(path: []const u8, prefs: ProfilePaths.Preferences) !void {
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

test "ProfileManager: default template mapping" {
    try testing.expectEqualStrings("velora", defaultTemplateForName("Default"));
    try testing.expectEqualStrings("chrome-macos-sonoma", defaultTemplateForName("chrome-macos-sonoma"));
}
