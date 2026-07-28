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
const js = @import("../js/js.zig");

const U = @import("../browser/URL.zig");
const URLSearchParams = @import("net/URLSearchParams.zig");
const Blob = @import("Blob.zig");
const Execution = js.Execution;
const log = @import("../../support/log.zig");

const Allocator = std.mem.Allocator;

const URL = @This();

_raw: [:0]const u8,
_arena: ?Allocator = null,
_search_params: ?*URLSearchParams = null,

// convenience
pub const resolve = @import("../browser/URL.zig").resolve;
pub const eqlDocument = @import("../browser/URL.zig").eqlDocument;

pub fn init(url: [:0]const u8, base_: ?[:0]const u8, exec: *const Execution) !*URL {
    const arena = exec.arena;

    if (std.mem.eql(u8, url, "about:blank") or std.mem.eql(u8, url, "about:srcdoc")) {
        return exec._factory.create(URL{
            ._raw = url,
            ._arena = arena,
        });
    }

    if (url.len == 0) {
        const base = base_ orelse return error.TypeError;
        const base_z = try arena.dupeZ(u8, base);
        if (!U.isValidBaseURL(base_z)) return error.TypeError;
        return exec._factory.create(URL{
            ._raw = base_z,
            ._arena = arena,
        });
    }

    const url_processed = if (base_ != null)
        try U.preprocessInput(arena, url)
    else
        try U.preprocessAbsoluteInput(arena, url);
    const url_is_absolute = U.isAbsoluteUrl(url_processed);

    const resolve_base: [:0]const u8 = if (base_) |b| blk: {
        if (url_is_absolute and !U.shouldResolveAgainstBase(url_processed, b)) {
            break :blk "";
        }
        const base_z = try arena.dupeZ(u8, b);
        if (!U.isValidParserBase(base_z)) return error.TypeError;
        break :blk base_z;
    } else blk: {
        if (!url_is_absolute) return error.TypeError;
        break :blk "";
    };

    const raw = try resolve(arena, resolve_base, url_processed, .{ .always_dupe = true });

    return exec._factory.create(URL{
        ._raw = raw,
        ._arena = arena,
    });
}

pub fn getUsername(self: *const URL) []const u8 {
    return U.getUsername(self._raw);
}

pub fn setUsername(self: *URL, value: []const u8) !void {
    const allocator = self._arena orelse return error.NoAllocator;
    self._raw = try U.setUsername(self._raw, value, allocator);
}

pub fn getPassword(self: *const URL) []const u8 {
    return U.getPassword(self._raw);
}

pub fn setPassword(self: *URL, value: []const u8) !void {
    const allocator = self._arena orelse return error.NoAllocator;
    self._raw = try U.setPassword(self._raw, value, allocator);
}

pub fn getPathname(self: *const URL, exec: *const Execution) ![]const u8 {
    if (self._search_params) |sp| {
        if (sp.isMutated()) {
            const href = try self.toString(exec);
            return U.getPathname(href);
        }
    }
    return U.getPathname(self._raw);
}

pub fn getProtocol(self: *const URL) []const u8 {
    return U.getProtocol(self._raw);
}

pub fn getHostname(self: *const URL) []const u8 {
    return U.getHostname(self._raw);
}

pub fn getHost(self: *const URL) []const u8 {
    return U.getHost(self._raw);
}

pub fn getPort(self: *const URL) []const u8 {
    return U.getPort(self._raw);
}

pub fn getOrigin(self: *const URL, exec: *const Execution) ![]const u8 {
    return (try U.getOrigin(exec.call_arena, self._raw)) orelse {
        // yes, a null string, that's what the spec wants
        return "null";
    };
}

pub fn getSearch(self: *const URL, exec: *const Execution) ![]const u8 {
    // Until searchParams are mutated, preserve the original query serialization.
    if (self._search_params) |sp| {
        if (!sp.isMutated()) {
            return U.getSearch(self._raw);
        }
        if (sp.getSize() == 0) {
            return "";
        }
        var buf = std.Io.Writer.Allocating.init(exec.call_arena);
        try buf.writer.writeByte('?');
        try sp.toString(&buf.writer);
        return buf.written();
    }
    return U.getSearch(self._raw);
}

pub fn getHash(self: *const URL) []const u8 {
    return U.getHash(self._raw);
}

pub fn getSearchParams(self: *URL, exec: *const Execution) !*URLSearchParams {
    if (self._search_params) |sp| {
        return sp;
    }

    // Get current search string (without the '?')
    const search = try self.getSearch(exec);
    const search_value = if (search.len > 0) search[1..] else "";

    const params = try URLSearchParams.initFromQueryString(search_value, exec);
    self._search_params = params;
    return params;
}

pub fn setHref(self: *URL, value: []const u8, exec: *const Execution) !void {
    // URL.href setter parses with no base (relative values must throw).
    if (!U.isCompleteHTTPUrl(value)) {
        return error.TypeError;
    }
    const raw = try U.resolve(self._arena orelse exec.arena, exec.url.*, value, .{ .always_dupe = true });
    self._raw = raw;

    // Update existing searchParams if it exists
    if (self._search_params) |sp| {
        const search = U.getSearch(raw);
        const search_value = if (search.len > 0) search[1..] else "";
        try sp.updateFromString(search_value, exec);
    }
}

pub fn setProtocol(self: *URL, value: []const u8) !void {
    const allocator = self._arena orelse return error.NoAllocator;
    self._raw = try U.setProtocol(self._raw, value, allocator);
}

pub fn setHost(self: *URL, value: []const u8) !void {
    const allocator = self._arena orelse return error.NoAllocator;
    self._raw = try U.setHost(self._raw, value, allocator);
}

pub fn setHostname(self: *URL, value: []const u8) !void {
    const allocator = self._arena orelse return error.NoAllocator;
    self._raw = try U.setHostname(self._raw, value, allocator);
}

pub fn setPort(self: *URL, value: ?[]const u8) !void {
    const allocator = self._arena orelse return error.NoAllocator;
    self._raw = try U.setPort(self._raw, value, allocator);
}

pub fn setPathname(self: *URL, value: []const u8) !void {
    const allocator = self._arena orelse return error.NoAllocator;
    self._raw = try U.setPathname(self._raw, value, allocator);
}

pub fn setSearch(self: *URL, value: []const u8, exec: *const Execution) !void {
    const allocator = self._arena orelse return error.NoAllocator;
    self._raw = try U.setSearch(self._raw, value, allocator);

    // Update existing searchParams if it exists
    if (self._search_params) |sp| {
        const search = U.getSearch(self._raw);
        const search_value = if (search.len > 0) search[1..] else "";
        try sp.updateFromString(search_value, exec);
    }
}

pub fn setHash(self: *URL, value: []const u8) !void {
    const allocator = self._arena orelse return error.NoAllocator;
    self._raw = try U.setHash(self._raw, value, allocator);
}

pub fn toString(self: *const URL, exec: *const Execution) ![:0]const u8 {
    const sp = self._search_params orelse {
        return self._raw;
    };

    // Until searchParams are mutated, preserve the original href serialization.
    if (!sp.isMutated()) {
        return self._raw;
    }

    // Rebuild URL from searchParams
    const raw = self._raw;

    // Find the base (everything before ? or #)
    const base_end = std.mem.indexOfAnyPos(u8, raw, 0, "?#") orelse raw.len;
    const base = raw[0..base_end];

    // Get the hash if it exists
    const hash = self.getHash();

    // Build the new URL string
    var buf = std.Io.Writer.Allocating.init(exec.call_arena);
    if (U.isCannotBeABase(raw)) {
        const protocol = U.getProtocol(raw);
        const pathname = U.getPathname(raw);
        const serialized_path = try U.serializeCannotBeABasePath(exec.call_arena, pathname);
        try buf.writer.writeAll(protocol);
        try buf.writer.writeAll(serialized_path);
    } else {
        try buf.writer.writeAll(base);

        // Add / if missing (e.g., "https://example.com" -> "https://example.com/")
        // Only add if pathname is just "/" and not already in the base
        const pathname = U.getPathname(raw);
        if (std.mem.eql(u8, pathname, "/") and !std.mem.endsWith(u8, base, "/")) {
            try buf.writer.writeByte('/');
        }
    }

    // Only add ? if there are params
    if (sp.getSize() > 0) {
        try buf.writer.writeByte('?');
        try sp.toString(&buf.writer);
    }

    try buf.writer.writeAll(hash);
    try buf.writer.writeByte(0);

    return buf.written()[0 .. buf.written().len - 1 :0];
}

/// WebIDL USVString: JS `undefined` arrives as null. Required arg → `"undefined"`;
/// optional base omitted (`url` present, `base` null) → no base (`""`).
fn usvUrlAndBase(url_: ?[]const u8, base_: ?[]const u8) struct { []const u8, []const u8 } {
    const url = url_ orelse "undefined";
    const base = if (base_ != null) base_.? else if (url_ == null) "undefined" else "";
    return .{ url, base };
}

pub fn canParse(url_: ?[]const u8, base_: ?[]const u8) !bool {
    const pair = usvUrlAndBase(url_, base_);
    return U.canParse(pair[0], pair[1]);
}

pub fn parse(url_: ?[]const u8, base_: ?[]const u8, exec: *const Execution) !?*URL {
    const pair = usvUrlAndBase(url_, base_);
    const url = pair[0];
    const base = pair[1];
    if (!U.canParse(url, base)) return null;

    const arena = exec.arena;

    const raw: [:0]const u8 = if (url.len == 0)
        try arena.dupeZ(u8, base)
    else blk: {
        const base_z: [:0]const u8 = if (base.len > 0)
            try arena.dupeZ(u8, base)
        else
            "";
        break :blk try resolve(arena, base_z, url, .{ .always_dupe = true });
    };

    return exec._factory.create(URL{
        ._raw = raw,
        ._arena = arena,
    });
}

pub fn createObjectURL(blob: *Blob, exec: *const Execution) ![]const u8 {
    var uuid_buf: [36]u8 = undefined;
    @import("../../support/id.zig").uuidv4(&uuid_buf);

    switch (exec.context.global) {
        inline else => |g| {
            const blob_url = try std.fmt.allocPrint(
                g.arena,
                "blob:{s}/{s}",
                .{ g.origin orelse "null", uuid_buf },
            );
            try g._blob_urls.put(g.arena, blob_url, blob);
            blob.acquireRef();
            log.info(.browser, "blob URL created", .{
                .url = blob_url,
                .origin = g.origin orelse "null",
                .len = blob.getSize(),
                .mime = blob.getType(),
            });
            return blob_url;
        },
    }
}

pub fn revokeObjectURL(url: []const u8, exec: *const Execution) void {
    // Per spec: silently ignore non-blob URLs
    if (!std.mem.startsWith(u8, url, "blob:")) {
        return;
    }

    switch (exec.context.global) {
        inline else => |g| {
            if (g._blob_urls.fetchRemove(url)) |entry| {
                log.info(.browser, "blob URL revoked", .{ .url = url });
                entry.value.releaseRef(g._page);
            } else {
                log.info(.browser, "blob URL revoke ignored", .{ .url = url });
            }
        },
    }
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(URL);

    pub const Meta = struct {
        pub const name = "URL";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const constructor = bridge.constructor(URL.init, .{});
    pub const canParse = bridge.function(URL.canParse, .{ .static = true, .length = 1 });
    pub const parse = bridge.function(URL.parse, .{ .static = true, .length = 1 });
    pub const createObjectURL = bridge.function(URL.createObjectURL, .{ .static = true });
    pub const revokeObjectURL = bridge.function(URL.revokeObjectURL, .{ .static = true });
    pub const toString = bridge.function(URL.toString, .{});
    pub const toJSON = bridge.function(URL.toString, .{});
    pub const href = bridge.accessor(URL.toString, URL.setHref, .{});
    pub const search = bridge.accessor(URL.getSearch, URL.setSearch, .{});
    pub const hash = bridge.accessor(URL.getHash, URL.setHash, .{});
    pub const pathname = bridge.accessor(URL.getPathname, URL.setPathname, .{});
    pub const username = bridge.accessor(URL.getUsername, URL.setUsername, .{});
    pub const password = bridge.accessor(URL.getPassword, URL.setPassword, .{});
    pub const hostname = bridge.accessor(URL.getHostname, URL.setHostname, .{});
    pub const host = bridge.accessor(URL.getHost, URL.setHost, .{});
    pub const port = bridge.accessor(URL.getPort, URL.setPort, .{});
    pub const origin = bridge.accessor(URL.getOrigin, null, .{});
    pub const protocol = bridge.accessor(URL.getProtocol, URL.setProtocol, .{});
    pub const searchParams = bridge.accessor(URL.getSearchParams, null, .{});
};

const testing = @import("../../testing/testing.zig");
test "WebApi: URL" {
    try testing.htmlRunner("url.html", .{});
}
