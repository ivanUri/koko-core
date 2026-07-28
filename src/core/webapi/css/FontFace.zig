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
const RC = @import("../../../support/rc.zig").RC;

const js = @import("../../js/js.zig");
const Page = @import("../../browser/Page.zig");
const Frame = @import("../../browser/Frame.zig");
const FingerprintProfile = @import("../../profile/types.zig");

const Allocator = std.mem.Allocator;

const FontFace = @This();

_rc: RC(u8) = .{},
_arena: Allocator,
_family: []const u8,
_source: []const u8 = "",
_loaded_resolver: js.PromiseResolver.Global,
_status: Status = .unloaded,

const Status = enum {
    unloaded,
    loading,
    loaded,
    error_state,
};

pub fn init(family: []const u8, source: []const u8, frame: *Frame) !*FontFace {
    const arena = try frame.getArena(.tiny, "FontFace");
    errdefer frame.releaseArena(arena);

    const resolver = frame.js.local.?.createPromiseResolver();
    var loaded_resolver = try resolver.persist();
    errdefer loaded_resolver.deinit();

    const self = try arena.create(FontFace);
    self.* = .{
        ._arena = arena,
        ._family = try arena.dupe(u8, family),
        ._source = try arena.dupe(u8, source),
        ._loaded_resolver = loaded_resolver,
    };
    return self;
}

pub fn deinit(self: *FontFace, page: *Page) void {
    // Promise globals are registered with the owning JS Context/Page by
    // PromiseResolver.persist(). Page teardown resets that registry exactly
    // once; resetting the same V8 global here would double-release it.
    page.releaseArena(self._arena);
}

pub fn releaseRef(self: *FontFace, page: *Page) void {
    self._rc.release(self, page);
}

pub fn acquireRef(self: *FontFace) void {
    self._rc.acquire();
}

/// Chrome returns multi-word families with literal quote characters (e.g. `"Helvetica Neue"`).
pub fn getFamily(self: *const FontFace, frame: *Frame) []const u8 {
    if (std.mem.indexOfScalar(u8, self._family, ' ')) |_| {
        const formatted = std.fmt.bufPrint(&frame.buf, "\"{s}\"", .{self._family}) catch return self._family;
        return formatted;
    }
    return self._family;
}

fn trimToken(token: []const u8) []const u8 {
    var start: usize = 0;
    var end: usize = token.len;
    while (start < end and token[start] <= 0x20) : (start += 1) {}
    while (end > start and token[end - 1] <= 0x20) : (end -= 1) {}
    var family = token[start..end];
    if (family.len >= 2 and ((family[0] == '\'' and family[family.len - 1] == '\'') or
        (family[0] == '"' and family[family.len - 1] == '"')))
    {
        family = family[1 .. family.len - 1];
    }
    return family;
}

fn isLocalFontSource(source: []const u8) bool {
    var start: usize = 0;
    var end: usize = source.len;
    while (start < end and source[start] <= 0x20) : (start += 1) {}
    while (end > start and source[end - 1] <= 0x20) : (end -= 1) {}
    const trimmed = source[start..end];
    return trimmed.len >= 6 and std.ascii.eqlIgnoreCase(trimmed[0..6], "local(");
}

fn extractLocalFontName(source: []const u8) ?[]const u8 {
    if (!isLocalFontSource(source)) return null;

    var start: usize = 0;
    var end: usize = source.len;
    while (start < end and source[start] <= 0x20) : (start += 1) {}
    while (end > start and source[end - 1] <= 0x20) : (end -= 1) {}
    const trimmed = source[start..end];

    const open = std.mem.indexOfScalar(u8, trimmed, '(') orelse return null;
    var i = open + 1;
    while (i < trimmed.len and trimmed[i] <= 0x20) : (i += 1) {}
    if (i >= trimmed.len) return null;

    const quote = trimmed[i];
    if (quote == '\'' or quote == '"') {
        i += 1;
        const name_start = i;
        while (i < trimmed.len and trimmed[i] != quote) : (i += 1) {}
        if (i >= trimmed.len) return null;
        return trimToken(trimmed[name_start..i]);
    }

    const name_start = i;
    while (i < trimmed.len and trimmed[i] != ')') : (i += 1) {}
    return trimToken(trimmed[name_start..i]);
}

// load() rejects with NetworkError for local() sources when the referenced font is not in
// the profile whitelist (CreepJS system-font probe). FP uses local('Arial') under a dummy
// family name; gate on the local() target, not FontFace.family. Web fonts resolve like Chrome.
pub fn load(self: *FontFace, frame: *Frame) !js.Promise {
    const resolver = self._loaded_resolver.local(frame.js.local.?);
    const promise = resolver.promise();
    if (self._status != .unloaded) return promise;

    self._status = .loading;
    if (isLocalFontSource(self._source)) {
        const probe_family = extractLocalFontName(self._source) orelse self._family;
        const available = FingerprintProfile.isFontFamilyAvailable(frame.identityProfile(), probe_family);
        if (!available) {
            self._status = .error_state;
            resolver.rejectError("FontFace.load", .{ .dom_exception = .{ .err = error.NetworkError } });
            return promise;
        }
    }
    self._status = .loaded;
    resolver.resolve("FontFace.load", self);
    return promise;
}

pub fn getLoaded(self: *FontFace, frame: *Frame) !js.Promise {
    return self._loaded_resolver.local(frame.js.local.?).promise();
}

pub fn getStatus(self: *const FontFace) []const u8 {
    return switch (self._status) {
        .unloaded => "unloaded",
        .loading => "loading",
        .loaded => "loaded",
        .error_state => "error",
    };
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(FontFace);

    pub const Meta = struct {
        pub const name = "FontFace";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const constructor = bridge.constructor(FontFace.init, .{});
    pub const family = bridge.accessor(FontFace.getFamily, null, .{});
    pub const status = bridge.accessor(FontFace.getStatus, null, .{});
    pub const style = bridge.attribute("normal", .{});
    pub const weight = bridge.attribute("normal", .{});
    pub const stretch = bridge.attribute("normal", .{});
    pub const unicodeRange = bridge.attribute("U+0-10FFFF", .{});
    pub const variant = bridge.attribute("normal", .{});
    pub const featureSettings = bridge.attribute("normal", .{});
    pub const display = bridge.attribute("auto", .{});
    pub const loaded = bridge.accessor(FontFace.getLoaded, null, .{});
    pub const load = bridge.function(FontFace.load, .{});
};

const testing = @import("../../../testing/testing.zig");
test "WebApi: FontFace" {
    try testing.htmlRunner("css/font_face.html", .{});
}
