const std = @import("std");
const ProfileManager = @import("profile/ProfileManager.zig");
const ProfilePaths = @import("profile/ProfilePaths.zig");

const Allocator = std.mem.Allocator;

pub const Options = struct {
    action: ?[]const u8 = null,
    name: ?[]const u8 = null,
    template: ?[]const u8 = null,
    from: ?[]const u8 = null,
    user_data_dir: ?[]const u8 = null,
};

pub fn run(allocator: Allocator, opts: Options) !void {
    const user_data_dir_cli = opts.user_data_dir;
    const user_data_dir = if (user_data_dir_cli) |p|
        try allocator.dupe(u8, p)
    else
        try defaultUserDataDir(allocator);
    defer allocator.free(user_data_dir);

    const action = opts.action orelse {
        try printUsage();
        return error.MissingProfileAction;
    };

    if (std.mem.eql(u8, action, "list")) {
        try runList(allocator, user_data_dir);
        return;
    }
    if (std.mem.eql(u8, action, "create")) {
        const name = opts.name orelse {
            std.debug.print("error: --name required for profile create\n", .{});
            return error.MissingProfileName;
        };
        const template = opts.template orelse ProfileManager.defaultTemplateForName(name);
        try ProfileManager.createProfile(allocator, user_data_dir, name, template);
        std.debug.print("created profile '{s}' (template: {s})\n", .{ name, template });
        return;
    }
    if (std.mem.eql(u8, action, "delete")) {
        const name = opts.name orelse {
            std.debug.print("error: --name required for profile delete\n", .{});
            return error.MissingProfileName;
        };
        try ProfileManager.deleteProfile(allocator, user_data_dir, name);
        std.debug.print("deleted profile '{s}'\n", .{name});
        return;
    }
    if (std.mem.eql(u8, action, "import-cookies") or std.mem.eql(u8, action, "import_cookies")) {
        const name = opts.name orelse ProfilePaths.default_profile_name;
        const from_path = opts.from orelse {
            std.debug.print("error: --from required for profile import-cookies\n", .{});
            return error.MissingImportPath;
        };
        try ProfileManager.importCookies(allocator, user_data_dir, name, from_path);
        std.debug.print("imported cookies into profile '{s}' from {s}\n", .{ name, from_path });
        return;
    }

    std.debug.print("error: unknown profile action '{s}'\n", .{action});
    try printUsage();
    return error.UnknownProfileAction;
}

fn runList(allocator: Allocator, user_data_dir: []const u8) !void {
    try ProfileManager.ensureFirstRun(allocator, user_data_dir);

    var state = try ProfileManager.loadLocalState(allocator, user_data_dir);
    defer ProfileManager.freeLocalState(allocator, &state);

    const entries = try ProfileManager.listProfileEntries(allocator, user_data_dir);
    defer ProfileManager.freeProfileEntries(allocator, entries);

    std.debug.print("user-data-dir: {s}\n", .{user_data_dir});
    std.debug.print("last-created: {s}\n\n", .{state.last_used});
    std.debug.print("{s:<24} {s:<28} {s}\n", .{ "NAME", "TEMPLATE", "PATH" });
    for (entries) |e| {
        const marker = if (std.mem.eql(u8, e.name, state.last_used)) " *" else "";
        std.debug.print("{s:<24} {s:<28} {s}{s}\n", .{ e.name, e.template, e.profile_dir, marker });
    }
}

fn defaultUserDataDir(allocator: Allocator) ![]const u8 {
    return std.fs.getAppDataDir(allocator, "velora") catch try allocator.dupe(u8, ".velora-user-data");
}

fn printUsage() !void {
    var stdout = std.fs.File.stdout().writer(&.{});
    try stdout.interface.writeAll(
        \\profile commands:
        \\  velora profile list
        \\  velora profile create --name <id> [--template <template-id>]
        \\  velora profile delete --name <id>
        \\  velora profile import-cookies [--name <id>] --from <cookies.json>
        \\
    );
}
