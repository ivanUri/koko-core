const std = @import("std");
const BrowserRoot = @import("BrowserRoot.zig");
const ProfileManager = @import("ProfileManager.zig");
const ProfilePaths = @import("ProfilePaths.zig");

const Allocator = std.mem.Allocator;

pub const default_template_version: u32 = 1;

pub const Manifest = struct {
    format: []const u8 = "velora-profile-bundle",
    format_version: u32 = 1,
    template: TemplateRef = .{},
};

pub const TemplateRef = struct {
    id: []const u8 = "",
    version: u32 = default_template_version,
};

pub fn parseTemplateRef(raw: []const u8, allocator: Allocator) !TemplateRef {
    if (std.mem.indexOfScalar(u8, raw, '@')) |at| {
        const id = try allocator.dupe(u8, raw[0..at]);
        const ver_str = raw[at + 1 ..];
        const version = std.fmt.parseInt(u32, ver_str, 10) catch default_template_version;
        return .{ .id = id, .version = version };
    }
    return .{ .id = try allocator.dupe(u8, raw), .version = default_template_version };
}

pub fn profileSnapshotDir(profile_dir: []const u8, buf: []u8) ?[]const u8 {
    return std.fmt.bufPrint(buf, "{s}/snapshot", .{profile_dir}) catch null;
}

pub fn profileFingerprintPath(profile_dir: []const u8, buf: []u8) ?[]const u8 {
    return std.fmt.bufPrint(buf, "{s}/snapshot/fingerprint.json", .{profile_dir}) catch null;
}

pub fn catalogFingerprintPath(allocator: Allocator, template_id: []const u8, version: u32) ![]const u8 {
    // BrowserRoot.get caches the install root — do not free it here.
    const root = try BrowserRoot.get(allocator);
    return std.fmt.allocPrint(allocator, "{s}/browser/catalog/{s}/{d}/fingerprint.json", .{
        root, template_id, version,
    });
}

pub const FingerprintSource = struct {
    path: []const u8,
    allocated: bool,
    /// Directory containing fingerprint.json (asset paths in JSON are relative to this).
    asset_base: []const u8,
    asset_base_allocated: bool,
    template_id: []const u8,
    template_version: u32,
};

pub fn resolveFingerprintSource(
    allocator: Allocator,
    paths: *const ProfilePaths.ProfilePaths,
    cli_snapshot: ?[]const u8,
) !FingerprintSource {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const prefs = try paths.readPreferences(a);

    if (cli_snapshot) |snap| {
        const fp_path = try resolveCliSnapshotPath(allocator, snap);
        defer allocator.free(fp_path);
        return try fingerprintFromPath(allocator, fp_path, prefs.template, prefs.template_version);
    }

    var snap_buf: [512]u8 = undefined;
    if (profileFingerprintPath(paths.profile_dir, &snap_buf)) |snap_path| {
        if (fileExists(snap_path)) {
            return try fingerprintFromPath(allocator, snap_path, prefs.template, prefs.template_version);
        }
    }

    const catalog = try catalogFingerprintPath(allocator, prefs.template, prefs.template_version);
    defer allocator.free(catalog);
    if (fileExists(catalog)) {
        return try fingerprintFromPath(allocator, catalog, prefs.template, prefs.template_version);
    }

    const template_path = try ProfileManager.templateJsonPath(allocator, prefs.template);

    const asset_base = try parentDirAlloc(allocator, template_path);
    errdefer allocator.free(asset_base);

    return .{
        .path = try allocator.dupe(u8, template_path),
        .allocated = true,
        .asset_base = asset_base,
        .asset_base_allocated = true,
        .template_id = try allocator.dupe(u8, prefs.template),
        .template_version = prefs.template_version,
    };
}

fn resolveCliSnapshotPath(allocator: Allocator, snap: []const u8) ![]const u8 {
    if (std.mem.endsWith(u8, snap, ".json")) return try allocator.dupe(u8, snap);
    const nested = try std.fs.path.join(allocator, &.{ snap, "fingerprint.json" });
    if (fileExists(nested)) return nested;
    allocator.free(nested);
    const snapshot_nested = try std.fs.path.join(allocator, &.{ snap, "snapshot", "fingerprint.json" });
    if (fileExists(snapshot_nested)) return snapshot_nested;
    allocator.free(snapshot_nested);
    return error.SnapshotNotFound;
}

fn fingerprintFromPath(
    allocator: Allocator,
    fingerprint_path: []const u8,
    template_id: []const u8,
    template_version: u32,
) !FingerprintSource {
    const path = try allocator.dupe(u8, fingerprint_path);
    errdefer allocator.free(path);

    const asset_base = try parentDirAlloc(allocator, fingerprint_path);
    errdefer allocator.free(asset_base);

    return .{
        .path = path,
        .allocated = true,
        .asset_base = asset_base,
        .asset_base_allocated = true,
        .template_id = try allocator.dupe(u8, template_id),
        .template_version = template_version,
    };
}

pub fn freeFingerprintSource(allocator: Allocator, src: *FingerprintSource) void {
    if (src.allocated) allocator.free(src.path);
    if (src.asset_base_allocated) allocator.free(src.asset_base);
    allocator.free(src.template_id);
    src.* = undefined;
}

fn parentDirAlloc(allocator: Allocator, file_path: []const u8) ![]const u8 {
    const parent = std.fs.path.dirname(file_path) orelse return try allocator.dupe(u8, ".");
    return try allocator.dupe(u8, parent);
}

fn fileExists(path: []const u8) bool {
    std.fs.cwd().access(path, .{}) catch return false;
    return true;
}

const testing = @import("../../testing/testing.zig");

test "ProfileSnapshot: parseTemplateRef" {
    const allocator = std.testing.allocator;
    const ref = try parseTemplateRef("chrome-local-huys-macbook-pro@3", allocator);
    defer allocator.free(ref.id);
    try testing.expect(std.mem.eql(u8, ref.id, "chrome-local-huys-macbook-pro"));
    try testing.expect(ref.version == 3);
}
