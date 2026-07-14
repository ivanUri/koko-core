const std = @import("std");
const BrowserRoot = @import("profile/BrowserRoot.zig");
const ProfileManager = @import("profile/ProfileManager.zig");
const ProfilePaths = @import("profile/ProfilePaths.zig");
const ProfileSnapshot = @import("profile/ProfileSnapshot.zig");

const Allocator = std.mem.Allocator;

pub const Options = struct {
    action: ?[]const u8 = null,
    name: ?[]const u8 = null,
    template: ?[]const u8 = null,
    from: ?[]const u8 = null,
    to: ?[]const u8 = null,
    version: u32 = ProfileSnapshot.default_template_version,
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
        const template_raw = opts.template orelse ProfileManager.defaultTemplateForName(name);
        const ref = try ProfileSnapshot.parseTemplateRef(template_raw, allocator);
        defer allocator.free(ref.id);
        const version = if (opts.version > 0 and std.mem.indexOfScalar(u8, template_raw, '@') == null)
            opts.version
        else
            ref.version;
        try ProfileManager.createProfile(allocator, user_data_dir, name, ref.id, version);
        std.debug.print("created profile '{s}' (template: {s}@{d})\n", .{ name, ref.id, version });
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
    if (std.mem.eql(u8, action, "export")) {
        const name = opts.name orelse {
            std.debug.print("error: --name required for profile export\n", .{});
            return error.MissingProfileName;
        };
        try runBundleScript(allocator, &.{
            "export",
            "--name",
            name,
            "--user-data-dir",
            user_data_dir,
        }, opts.to);
        return;
    }
    if (std.mem.eql(u8, action, "import")) {
        const name = opts.name orelse {
            std.debug.print("error: --name required for profile import\n", .{});
            return error.MissingProfileName;
        };
        const from_path = opts.from orelse {
            std.debug.print("error: --from required for profile import\n", .{});
            return error.MissingImportPath;
        };
        try runBundleScript(allocator, &.{
            "import",
            "--from",
            from_path,
            "--name",
            name,
            "--user-data-dir",
            user_data_dir,
        }, null);
        return;
    }
    if (std.mem.eql(u8, action, "publish")) {
        const template_raw = opts.template orelse {
            std.debug.print("error: --template required for profile publish\n", .{});
            return error.MissingTemplate;
        };
        const ref = try ProfileSnapshot.parseTemplateRef(template_raw, allocator);
        defer allocator.free(ref.id);
        const version = if (opts.version > 0) opts.version else ref.version;
        var ver_buf: [16]u8 = undefined;
        const ver_str = try std.fmt.bufPrint(&ver_buf, "{d}", .{version});
        try runBundleScript(allocator, &.{
            "publish",
            "--template",
            ref.id,
            "--version",
            ver_str,
        }, null);
        return;
    }

    std.debug.print("error: unknown profile action '{s}'\n", .{action});
    try printUsage();
    return error.UnknownProfileAction;
}

fn runBundleScript(allocator: Allocator, args: []const []const u8, out_path: ?[]const u8) !void {
    const root = try BrowserRoot.get(allocator);
    const script = try BrowserRoot.joinPath(allocator, root, "scripts/profile-bundle.mjs");
    defer allocator.free(script);

    var argv = try std.ArrayList([]const u8).initCapacity(allocator, 4 + args.len + 2);
    defer argv.deinit(allocator);
    try argv.append(allocator, "node");
    try argv.append(allocator, script);
    try argv.append(allocator, "--velora-root");
    try argv.append(allocator, root);
    for (args) |arg| try argv.append(allocator, arg);
    if (out_path) |out| {
        try argv.append(allocator, "--out");
        try argv.append(allocator, out);
    }

    var child = std.process.Child.init(argv.items, std.heap.page_allocator);
    child.stdin_behavior = .Ignore;
    child.stdout_behavior = .Inherit;
    child.stderr_behavior = .Inherit;
    try child.spawn();
    const term = try child.wait();
    switch (term) {
        .Exited => |code| {
            if (code != 0) return error.BundleScriptFailed;
        },
        else => return error.BundleScriptFailed,
    }
}

fn runList(allocator: Allocator, user_data_dir: []const u8) !void {
    try ProfileManager.ensureFirstRun(allocator, user_data_dir);

    var state = try ProfileManager.loadLocalState(allocator, user_data_dir);
    defer ProfileManager.freeLocalState(allocator, &state);

    const entries = try ProfileManager.listProfileEntries(allocator, user_data_dir);
    defer ProfileManager.freeProfileEntries(allocator, entries);

    std.debug.print("user-data-dir: {s}\n", .{user_data_dir});
    std.debug.print("last-created: {s}\n\n", .{state.last_used});
    std.debug.print("{s:<24} {s:<32} {s}\n", .{ "NAME", "TEMPLATE", "PATH" });
    for (entries) |e| {
        const marker = if (std.mem.eql(u8, e.name, state.last_used)) " *" else "";
        std.debug.print("{s:<24} {s:<32} {s}{s}\n", .{ e.name, e.template, e.profile_dir, marker });
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
        \\  velora profile create --name <id> [--template <id[@version]>] [--version N]
        \\  velora profile delete --name <id>
        \\  velora profile import-cookies [--name <id>] --from <cookies.json>
        \\  velora profile publish --template <id[@version]> [--version N]
        \\  velora profile export --name <id> [--to <bundle-dir>]
        \\  velora profile import --name <id> --from <bundle-dir>
        \\
    );
}
