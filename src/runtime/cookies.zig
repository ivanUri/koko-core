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

const Session = @import("../core/browser/Session.zig");
const Cookie = @import("../core/webapi/storage/Cookie.zig");

const log = @import("../support/log.zig");

/// Load cookies from a JSON file into the cookie jar.
/// The file format is an array of objects with: name, value, domain, path,
/// expires (optional, float), secure (optional, bool), httpOnly (optional, bool).
/// This matches the CDP Network.Cookie format used by Puppeteer and Playwright.
pub fn loadFromFile(session: *Session, path: []const u8) void {
    _loadFromFile(session, path) catch |err| {
        log.err(.app, "Cookie.loadFromFile", .{ .err = err, .path = path });
    };
}

fn _loadFromFile(session: *Session, path: []const u8) !void {
    const arena = try session.getArena(.medium, "Cookies.loadFromFile");
    defer session.releaseArena(arena);

    const content = std.fs.cwd().readFileAlloc(arena, path, 1024 * 1024) catch |err| {
        switch (err) {
            error.FileNotFound => log.debug(.app, "Cookie.readFile", .{ .path = path, .note = "file not found" }),
            else => log.err(.app, "Cookie.readFile", .{ .path = path, .err = err }),
        }
        return;
    };

    const json_cookies = std.json.parseFromSliceLeaky([]const JsonCookie, arena, content, .{
        .ignore_unknown_fields = true,
    }) catch |err| {
        log.err(.app, "Cookie.parseFile", .{ .path = path, .err = err });
        return;
    };

    const jar = &session.cookie_jar;
    const now = std.time.timestamp();

    var loaded: usize = 0;
    for (json_cookies) |jc| {
        var cookie_arena = std.heap.ArenaAllocator.init(jar.allocator);
        errdefer cookie_arena.deinit();

        const a = cookie_arena.allocator();
        const name = try a.dupe(u8, jc.name);
        const value = try a.dupe(u8, jc.value);
        const domain = try a.dupe(u8, jc.domain);
        const cookie_path = if (jc.path) |p| try a.dupe(u8, p) else "/";

        // Restored Chrome/profile cookies were set in an HTTPS browsing context.
        // `source_secure` defaults to false on Cookie{}, which makes
        // originBindingMatches reject every https:// request — so hop-1 sent
        // zero Cookie despite a full Cookies.json (only live Set-Cookie AEC
        // from the same request survived). Mark restored entries as secure-origin.
        const secure = jc.secure orelse false;
        const cookie = Cookie{
            .arena = cookie_arena,
            .name = name,
            .value = value,
            .domain = domain,
            .path = cookie_path,
            .expires = jc.expires,
            .secure = secure,
            .http_only = jc.httpOnly orelse false,
            .same_site = parseJsonSameSite(jc.sameSite),
            .source_secure = true,
            .source_port = 443,
        };

        jar.add(cookie, now, true) catch |err| {
            cookie.deinit();
            log.warn(.app, "invalid cookie", .{ .name = jc.name, .err = err });
            continue;
        };
        // Restored session cookies are immediately eligible (unlike live Set-Cookie).
        if (jar.cookies.items.len > 0) {
            jar.cookies.items[jar.cookies.items.len - 1].available_from_nav = jar.document_nav_generation;
        }
        loaded += 1;
    }

    log.info(.app, "Cookie.loadFromFile", .{ .path = path, .count = loaded });
}

/// Save all cookies from the jar to a JSON file.
pub fn saveToFile(jar: *Cookie.Jar, path: []const u8) void {
    _saveToFile(jar, path) catch |err| {
        log.err(.app, "Cookie.saveToFile", .{ .path = path, .err = err });
    };
}

fn _saveToFile(jar: *Cookie.Jar, path: []const u8) !void {
    jar.removeExpired(null);

    var file = try std.fs.cwd().createFile(path, .{});
    defer file.close();

    var buf: [8192]u8 = undefined;
    var writer = file.writer(&buf);
    const w = &writer.interface;

    try w.writeByte('[');
    for (jar.cookies.items, 0..) |c, i| {
        if (i > 0) {
            try w.writeByte(',');
        }

        try w.writeAll("\n  ");
        try std.json.Stringify.value(JsonCookie{
            .name = c.name,
            .value = c.value,
            .domain = c.domain,
            .path = c.path,
            .expires = c.expires,
            .secure = c.secure,
            .httpOnly = c.http_only,
            .sameSite = @tagName(c.same_site),
        }, .{}, w);
    }

    if (jar.cookies.items.len > 0) {
        try w.writeByte('\n');
    }
    try w.writeAll("]\n");
    try writer.end();

    log.info(.app, "Cookie.saveToFile", .{ .path = path, .count = jar.cookies.items.len });
}

const JsonCookie = struct {
    name: []const u8,
    value: []const u8,
    domain: []const u8,
    path: ?[]const u8 = "/",
    expires: ?f64 = null,
    secure: ?bool = null,
    httpOnly: ?bool = null,
    sameSite: ?[]const u8 = null,
};

fn parseJsonSameSite(value: ?[]const u8) Cookie.SameSite {
    const same_site = value orelse return .none;
    if (std.ascii.eqlIgnoreCase(same_site, "strict")) return .strict;
    if (std.ascii.eqlIgnoreCase(same_site, "lax")) return .lax;
    if (std.ascii.eqlIgnoreCase(same_site, "none")) return .none;
    return .none;
}

test "cookies: load JSON accepts CDP SameSite casing" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const parsed = try std.json.parseFromSliceLeaky(
        []const JsonCookie,
        arena.allocator(),
        "[{\"name\":\"sid\",\"value\":\"1\",\"domain\":\"example.com\",\"sameSite\":\"Lax\"}]",
        .{ .ignore_unknown_fields = true },
    );

    try std.testing.expectEqual(Cookie.SameSite.lax, parseJsonSameSite(parsed[0].sameSite));
}
