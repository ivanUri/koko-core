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

const CDP = @import("../CDP.zig");
const Config = @import("../../../runtime/Config.zig");
const EmulationState = @import("../EmulationState.zig");

const log = @import("../../../support/log.zig");

pub fn processMessage(cmd: *CDP.Command) !void {
    const action = std.meta.stringToEnum(enum {
        setEmulatedMedia,
        setFocusEmulationEnabled,
        setDeviceMetricsOverride,
        setTouchEmulationEnabled,
        setUserAgentOverride,
        setTimezoneOverride,
        setLocaleOverride,
        setGeolocationOverride,
        setNavigatorOverrides,
        clearDeviceMetricsOverride,
    }, cmd.input.action) orelse return error.UnknownMethod;

    switch (action) {
        .setEmulatedMedia => return setEmulatedMedia(cmd),
        .setFocusEmulationEnabled => return setFocusEmulationEnabled(cmd),
        .setDeviceMetricsOverride => return setDeviceMetricsOverride(cmd),
        .setTouchEmulationEnabled => return setTouchEmulationEnabled(cmd),
        .setUserAgentOverride => return setUserAgentOverride(cmd),
        .setTimezoneOverride => return setTimezoneOverride(cmd),
        .setLocaleOverride => return setLocaleOverride(cmd),
        .setGeolocationOverride => return setGeolocationOverride(cmd),
        .setNavigatorOverrides => return setNavigatorOverrides(cmd),
        .clearDeviceMetricsOverride => return clearDeviceMetricsOverride(cmd),
    }
}

fn browserContext(cmd: *CDP.Command) !*CDP.BrowserContext {
    return cmd.browser_context orelse error.BrowserContextNotLoaded;
}

fn setEmulatedMedia(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        media: ?[]const u8 = null,
    })) orelse return error.InvalidParams;

    const bc = try browserContext(cmd);
    if (params.media) |media| {
        bc.emulation.emulated_media = try bc.emulation.dupString(bc.arena, media);
    } else {
        bc.emulation.emulated_media = null;
    }
    return cmd.sendResult(null, .{});
}

fn setFocusEmulationEnabled(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        enabled: bool,
    })) orelse return error.InvalidParams;

    const bc = try browserContext(cmd);
    bc.emulation.focus_emulation_enabled = params.enabled;
    return cmd.sendResult(null, .{});
}

fn setDeviceMetricsOverride(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        width: i32,
        height: i32,
        deviceScaleFactor: f64,
        mobile: bool,
    })) orelse return error.InvalidParams;

    const bc = try browserContext(cmd);

    // Chrome: width=0 height=0 deviceScaleFactor=0 mobile=false clears override.
    if (params.width == 0 and params.height == 0 and params.deviceScaleFactor == 0 and !params.mobile) {
        bc.emulation.clearDeviceMetrics();
        return cmd.sendResult(null, .{});
    }

    if (params.width <= 0 or params.height <= 0) return error.InvalidParams;

    bc.emulation.setDeviceMetrics(.{
        .width = @intCast(params.width),
        .height = @intCast(params.height),
        .device_scale_factor = if (params.deviceScaleFactor > 0) params.deviceScaleFactor else 1.0,
        .mobile = params.mobile,
    });
    return cmd.sendResult(null, .{});
}

fn clearDeviceMetricsOverride(cmd: *CDP.Command) !void {
    const bc = try browserContext(cmd);
    bc.emulation.clearDeviceMetrics();
    return cmd.sendResult(null, .{});
}

fn setTouchEmulationEnabled(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        enabled: bool,
        maxTouchPoints: ?u32 = null,
    })) orelse return error.InvalidParams;

    const bc = try browserContext(cmd);
    bc.emulation.touch_enabled = params.enabled;
    bc.emulation.max_touch_points = params.maxTouchPoints orelse if (params.enabled) 1 else 0;
    return cmd.sendResult(null, .{});
}

fn setTimezoneOverride(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        timezoneId: []const u8,
    })) orelse return error.InvalidParams;

    const bc = try browserContext(cmd);
    bc.emulation.timezone_id = try bc.emulation.dupString(bc.arena, params.timezoneId);
    applyProcessTimezone(params.timezoneId);
    return cmd.sendResult(null, .{});
}

extern fn setenv(name: [*:0]const u8, value: [*:0]const u8, override: c_int) c_int;

fn applyProcessTimezone(timezone_id: []const u8) void {
    if (timezone_id.len == 0 or timezone_id.len >= 96) return;
    var buf: [96:0]u8 = undefined;
    @memcpy(buf[0..timezone_id.len], timezone_id);
    buf[timezone_id.len] = 0;
    _ = setenv("TZ", &buf, 1);
}

fn setLocaleOverride(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        locale: []const u8,
    })) orelse return error.InvalidParams;

    const bc = try browserContext(cmd);
    bc.emulation.locale = try bc.emulation.dupString(bc.arena, params.locale);
    return cmd.sendResult(null, .{});
}

fn setGeolocationOverride(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        latitude: f64,
        longitude: f64,
        accuracy: f64 = 1,
    })) orelse return error.InvalidParams;

    const bc = try browserContext(cmd);
    bc.emulation.geolocation = .{
        .latitude = params.latitude,
        .longitude = params.longitude,
        .accuracy = params.accuracy,
    };
    return cmd.sendResult(null, .{});
}

fn setNavigatorOverrides(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        platform: ?[]const u8 = null,
    })) orelse return error.InvalidParams;

    const bc = try browserContext(cmd);
    if (params.platform) |platform| {
        bc.emulation.platform = try bc.emulation.dupString(bc.arena, platform);
    }
    return cmd.sendResult(null, .{});
}

// Emulation.setUserAgentOverride is also called by Network.setUserAgentOverride
pub fn setUserAgentOverride(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        userAgent: []const u8,
        acceptLanguage: ?[]const u8 = null,
        platform: ?[]const u8 = null,
    })) orelse return error.InvalidParams;

    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;

    const ua = params.userAgent;
    const allow_mozilla = cmd.cdp.browser.app.config.profile.allowsMozillaUserAgent();
    Config.validateUserAgent(ua, allow_mozilla) catch |err| switch (err) {
        error.NonPrintable => return cmd.sendError(-32602, "User agent contains non-printable characters", .{}),
        error.Reserved => {
            log.warn(.not_implemented, "Emulation.setUserAgentOverride", .{ .param = "userAgent", .value = ua, .info = "User agent must not contain Mozilla" });
            return cmd.sendResult(null, .{});
        },
    };

    const http_client = &cmd.cdp.browser.http_client;
    try http_client.setIdentityOverride(ua, params.acceptLanguage);
    bc.emulation.user_agent = try bc.emulation.dupString(bc.arena, ua);
    if (params.acceptLanguage) |value| {
        try bc.emulation.setAcceptLanguages(bc.arena, value);
    } else {
        bc.emulation.accept_language = null;
        bc.emulation.languages = null;
    }
    if (params.platform) |value| {
        bc.emulation.platform = try bc.emulation.dupString(bc.arena, value);
    } else {
        bc.emulation.platform = null;
    }
    bc.user_agent_changed = true;

    return cmd.sendResult(null, .{});
}

const testing = @import("../testing.zig");

test "cdp.Emulation: setDeviceMetricsOverride updates layout" {
    var ctx = try testing.context();
    defer ctx.deinit();
    _ = try ctx.loadBrowserContext(.{ .id = "BID-DM1", .url = "mcp_actions.html" });

    try ctx.processMessage(.{
        .id = 1,
        .method = "Emulation.setDeviceMetricsOverride",
        .params = .{
            .width = 1024,
            .height = 768,
            .deviceScaleFactor = 2,
            .mobile = false,
        },
    });
    try ctx.expectSentResult(null, .{ .id = 1 });

    const bc = ctx.cdp().browser_context.?;
    const frame = bc.session.currentFrame().?;
    try testing.expectEqual(@as(u32, 1024), frame.windowProfile().inner_width);
    try testing.expectEqual(@as(u32, 768), frame.windowProfile().inner_height);
    try testing.expectEqual(@as(f64, 2), frame.devicePixelRatio());
}

test "cdp.Emulation: setUserAgentOverride with valid user agent" {
    var ctx = try testing.context();
    defer ctx.deinit();
    _ = try ctx.loadBrowserContext(.{ .id = "BID-UA1" });

    try ctx.processMessage(.{
        .id = 1,
        .method = "Emulation.setUserAgentOverride",
        .params = .{ .userAgent = "CustomBot/1.0" },
    });

    try ctx.expectSentResult(null, .{ .id = 1 });
}

test "cdp.Emulation: setUserAgentOverride ignores mozilla" {
    const filter: testing.LogFilter = .init(&.{.not_implemented});
    defer filter.deinit();

    var ctx = try testing.context();
    defer ctx.deinit();
    _ = try ctx.loadBrowserContext(.{ .id = "BID-UA2" });

    try ctx.processMessage(.{
        .id = 2,
        .method = "Emulation.setUserAgentOverride",
        .params = .{ .userAgent = "Mozilla/5.0 (Windows NT 10.0)" },
    });

    try ctx.expectSentResult(null, .{});
    try testing.expectEqual(false, ctx.cdp().browser_context.?.user_agent_changed);
}

test "cdp.Emulation: setUserAgentOverride ignores mozilla case insensitive" {
    const filter: testing.LogFilter = .init(&.{.not_implemented});
    defer filter.deinit();

    var ctx = try testing.context();
    defer ctx.deinit();
    _ = try ctx.loadBrowserContext(.{ .id = "BID-UA3" });

    try ctx.processMessage(.{
        .id = 3,
        .method = "Emulation.setUserAgentOverride",
        .params = .{ .userAgent = "MOZILLA/5.0 test" },
    });

    try ctx.expectSentResult(null, .{});
    try testing.expectEqual(false, ctx.cdp().browser_context.?.user_agent_changed);
}

test "cdp.Emulation: setUserAgentOverride rejects non-printable characters" {
    const filter: testing.LogFilter = .init(&.{.not_implemented});
    defer filter.deinit();

    var ctx = try testing.context();
    defer ctx.deinit();
    _ = try ctx.loadBrowserContext(.{ .id = "BID-UA4" });

    try ctx.processMessage(.{
        .id = 4,
        .method = "Emulation.setUserAgentOverride",
        .params = .{ .userAgent = "Bot/1.0\x01hidden" },
    });

    try ctx.expectSentError(-32602, "User agent contains non-printable characters", .{ .id = 4 });
}

test "cdp.Emulation: setUserAgentOverride with optional params" {
    var ctx = try testing.context();
    defer ctx.deinit();
    _ = try ctx.loadBrowserContext(.{ .id = "BID-UA5" });

    try ctx.processMessage(.{
        .id = 5,
        .method = "Emulation.setUserAgentOverride",
        .params = .{
            .userAgent = "CustomBot/2.0",
            .acceptLanguage = "en-US",
            .platform = "Linux",
        },
    });

    try ctx.expectSentResult(null, .{ .id = 5 });

    const bc = ctx.cdp().browser_context.?;
    const http_client = &ctx.cdp().browser.http_client;
    try testing.expectEqualSlices(u8, "CustomBot/2.0", http_client.getUserAgent());
    try testing.expectEqualSlices(u8, "Sec-Ch-Ua:", http_client.getSecChUaHeader());
    try testing.expectEqualSlices(u8, "Accept-Language: en-US", http_client.getAcceptLanguageHeader());
    try testing.expectEqualSlices(u8, "CustomBot/2.0", bc.emulation.user_agent.?);
    try testing.expectEqualSlices(u8, "Linux", bc.emulation.platform.?);
    try testing.expectEqual(@as(usize, 1), bc.emulation.languages.?.len);
    try testing.expectEqualSlices(u8, "en-US", bc.emulation.languages.?[0]);
}

test "cdp.Emulation: Accept-Language overlay parses weights without changing HTTP value" {
    var ctx = try testing.context();
    defer ctx.deinit();
    _ = try ctx.loadBrowserContext(.{ .id = "BID-UA-LANG" });

    try ctx.processMessage(.{
        .id = 51,
        .method = "Emulation.setUserAgentOverride",
        .params = .{
            .userAgent = "CustomBot/2.0",
            .acceptLanguage = "fr-FR, fr;q=0.9, en;q=0.7",
        },
    });
    try ctx.expectSentResult(null, .{ .id = 51 });

    const languages = ctx.cdp().browser_context.?.emulation.languages.?;
    try testing.expectEqual(@as(usize, 3), languages.len);
    try testing.expectEqualSlices(u8, "fr-FR", languages[0]);
    try testing.expectEqualSlices(u8, "fr", languages[1]);
    try testing.expectEqualSlices(u8, "en", languages[2]);
    try testing.expectEqualSlices(
        u8,
        "Accept-Language: fr-FR, fr;q=0.9, en;q=0.7",
        ctx.cdp().browser.http_client.getAcceptLanguageHeader(),
    );
}

test "cdp.Emulation: setUserAgentOverride can be called multiple times" {
    var ctx = try testing.context();
    defer ctx.deinit();
    _ = try ctx.loadBrowserContext(.{ .id = "BID-UA6" });

    try ctx.processMessage(.{
        .id = 6,
        .method = "Emulation.setUserAgentOverride",
        .params = .{ .userAgent = "FirstBot/1.0" },
    });

    try ctx.expectSentResult(null, .{ .id = 6 });

    try ctx.processMessage(.{
        .id = 7,
        .method = "Emulation.setUserAgentOverride",
        .params = .{ .userAgent = "SecondBot/2.0" },
    });

    try ctx.expectSentResult(null, .{ .id = 7 });
}
