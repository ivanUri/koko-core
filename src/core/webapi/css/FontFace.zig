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

const Allocator = std.mem.Allocator;

const FontFace = @This();

_rc: RC(u8) = .{},
_arena: Allocator,
_family: []const u8,

pub fn init(family: []const u8, source: []const u8, frame: *Frame) !*FontFace {
    _ = source;

    const arena = try frame.getArena(.tiny, "FontFace");
    errdefer frame.releaseArena(arena);

    const self = try arena.create(FontFace);
    self.* = .{
        ._arena = arena,
        ._family = try arena.dupe(u8, family),
    };
    return self;
}

pub fn deinit(self: *FontFace, page: *Page) void {
    page.releaseArena(self._arena);
}

pub fn releaseRef(self: *FontFace, page: *Page) void {
    self._rc.release(self, page);
}

pub fn acquireRef(self: *FontFace) void {
    self._rc.acquire();
}

pub fn getFamily(self: *const FontFace) []const u8 {
    return self._family;
}

// load() - resolves immediately; headless browser has no real font loading.
// Per spec the promise resolves with the FontFace itself, so callers can read
// `.family` etc on the resolved value.
pub fn load(self: *FontFace, frame: *Frame) !js.Promise {
    return frame.js.local.?.resolvePromise(self);
}

// loaded - returns an already-resolved Promise resolving to this FontFace.
pub fn getLoaded(self: *FontFace, frame: *Frame) !js.Promise {
    return frame.js.local.?.resolvePromise(self);
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
    pub const status = bridge.attribute("loaded", .{});
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
