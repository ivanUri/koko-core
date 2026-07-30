//
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
const v8 = @import("v8");
const CDP = @import("../CDP.zig");

// TODO: hard coded data
const PROTOCOL_VERSION = "1.3";
const REVISION = "@9e6ded5ac1ff5e38d930ae52bd9aec09bd1a68e4";

const DEV_TOOLS_WINDOW_ID = 1923710101;

pub fn processMessage(cmd: *CDP.Command) !void {
    const action = std.meta.stringToEnum(enum {
        getVersion,
        setPermission,
        setWindowBounds,
        resetPermissions,
        grantPermissions,
        getWindowForTarget,
        setDownloadBehavior,
    }, cmd.input.action) orelse return error.UnknownMethod;

    switch (action) {
        .getVersion => return getVersion(cmd),
        .setPermission => return setPermission(cmd),
        .setWindowBounds => return setWindowBounds(cmd),
        .resetPermissions => return resetPermissions(cmd),
        .grantPermissions => return grantPermissions(cmd),
        .getWindowForTarget => return getWindowForTarget(cmd),
        .setDownloadBehavior => return setDownloadBehavior(cmd),
    }
}

fn getVersion(cmd: *CDP.Command) !void {
    const persona = &cmd.cdp.browser.app.config.profile.persona;
    const product_family = switch (persona.family) {
        .chrome => "Chrome",
        .firefox => "Firefox",
        .safari => "Safari",
    };
    const product = try std.fmt.allocPrint(
        cmd.arena,
        "{s}/{s}",
        .{ product_family, persona.version.full },
    );
    return cmd.sendResult(.{
        .protocolVersion = PROTOCOL_VERSION,
        .product = product,
        .revision = REVISION,
        .userAgent = persona.network.user_agent,
        .jsVersion = v8.getVersion(),
    }, .{ .include_session_id = false });
}

// TODO: noop method
fn setDownloadBehavior(cmd: *CDP.Command) !void {
    // const params = (try cmd.params(struct {
    //     behavior: []const u8,
    //     browserContextId: ?[]const u8 = null,
    //     downloadPath: ?[]const u8 = null,
    //     eventsEnabled: ?bool = null,
    // })) orelse return error.InvalidParams;

    return cmd.sendResult(null, .{ .include_session_id = false });
}

fn getWindowForTarget(cmd: *CDP.Command) !void {
    // const params = (try cmd.params(struct {
    //     targetId: ?[]const u8 = null,
    // })) orelse return error.InvalidParams;

    return cmd.sendResult(.{ .windowId = DEV_TOOLS_WINDOW_ID, .bounds = .{
        .windowState = "normal",
    } }, .{});
}

// TODO: noop method
fn setWindowBounds(cmd: *CDP.Command) !void {
    return cmd.sendResult(null, .{});
}

fn grantPermissions(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        permissions: []const []const u8,
        origin: ?[]const u8 = null,
        browserContextId: ?[]const u8 = null,
    })) orelse return error.InvalidParams;

    _ = params.origin;
    _ = params.browserContextId;

    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    for (params.permissions) |permission| {
        try bc.emulation.grantPermission(bc.arena, permission);
    }
    return cmd.sendResult(null, .{});
}

fn setPermission(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        permission: struct {
            name: []const u8,
            setting: enum { granted, denied, prompt },
        },
        origin: []const u8,
        browserContextId: ?[]const u8 = null,
    })) orelse return error.InvalidParams;

    _ = params.origin;
    _ = params.browserContextId;

    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    switch (params.permission.setting) {
        .granted => try bc.emulation.grantPermission(bc.arena, params.permission.name),
        .denied, .prompt => {},
    }
    return cmd.sendResult(null, .{});
}

fn resetPermissions(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        browserContextId: ?[]const u8 = null,
    })) orelse return error.InvalidParams;

    _ = params.browserContextId;

    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    bc.emulation.resetPermissions(bc.arena);
    return cmd.sendResult(null, .{});
}

const testing = @import("../testing.zig");
test "cdp.browser: getVersion" {
    var ctx = try testing.context();
    defer ctx.deinit();

    try ctx.processMessage(.{
        .id = 32,
        .method = "Browser.getVersion",
    });

    try ctx.expectSentCount(1);
    const persona = &ctx.cdp_.browser.app.config.profile.persona;
    const product_family = switch (persona.family) {
        .chrome => "Chrome",
        .firefox => "Firefox",
        .safari => "Safari",
    };
    const product = try std.fmt.allocPrint(
        testing.allocator,
        "{s}/{s}",
        .{ product_family, persona.version.full },
    );
    defer testing.allocator.free(product);
    try ctx.expectSentResult(.{
        .protocolVersion = PROTOCOL_VERSION,
        .product = product,
        .revision = REVISION,
        .userAgent = persona.network.user_agent,
        .jsVersion = v8.getVersion(),
    }, .{ .id = 32, .index = 0, .session_id = null });
}

test "cdp.browser: getWindowForTarget" {
    var ctx = try testing.context();
    defer ctx.deinit();

    try ctx.processMessage(.{
        .id = 33,
        .method = "Browser.getWindowForTarget",
    });

    try ctx.expectSentCount(1);
    try ctx.expectSentResult(.{
        .windowId = DEV_TOOLS_WINDOW_ID,
        .bounds = .{ .windowState = "normal" },
    }, .{ .id = 33, .index = 0, .session_id = null });
}
