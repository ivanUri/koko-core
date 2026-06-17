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

const Event = @import("../Event.zig");
const EventTarget = @import("../EventTarget.zig");

const FontFace = @import("FontFace.zig");
const FingerprintProfile = @import("../../fingerprint/Profile.zig");
const TextMetrics = @import("../canvas/TextMetrics.zig");

const Allocator = std.mem.Allocator;

const FontFaceSet = @This();

fn identityProfile() *const FingerprintProfile.IdentityProfile {
    return FingerprintProfile.defaultIdentity();
}

_rc: RC(u8) = .{},
_proto: *EventTarget,
_arena: Allocator,

pub fn init(frame: *Frame) !*FontFaceSet {
    const arena = try frame.getArena(.tiny, "FontFaceSet");
    errdefer frame.releaseArena(arena);

    return frame._factory.eventTargetWithAllocator(arena, FontFaceSet{
        ._proto = undefined,
        ._arena = arena,
    });
}

pub fn deinit(self: *FontFaceSet, page: *Page) void {
    page.releaseArena(self._arena);
}

pub fn releaseRef(self: *FontFaceSet, page: *Page) void {
    self._rc.release(self, page);
}

pub fn acquireRef(self: *FontFaceSet) void {
    self._rc.acquire();
}

pub fn asEventTarget(self: *FontFaceSet) *EventTarget {
    return self._proto;
}

// FontFaceSet.ready - returns an already-resolved Promise.
// In a headless browser there is no font loading, so fonts are always ready.
pub fn getReady(_: *FontFaceSet, frame: *Frame) !js.Promise {
    return frame.js.local.?.resolvePromise({});
}

// check(font, text?) - checks if font is in available whitelist
pub fn check(_: *const FontFaceSet, font: []const u8) bool {
    // Parse font string to extract font family name
    // Format: "12px Arial" or "'Segoe UI' 12px" or "bold 12px 'Comic Sans MS'"
    const family = extractFontFamily(font);

    // Check against available fonts whitelist
    return isAvailableFont(family);
}

fn extractFontFamily(font: []const u8) []const u8 {
    var end = font.len;
    while (end > 0 and (font[end - 1] == ' ' or font[end - 1] == '\t')) : (end -= 1) {}
    if (end == 0) return font;

    var i: usize = end;
    while (i > 0) {
        i -= 1;
        if (font[i] == ',') {
            return trimFontToken(font[i + 1 .. end]);
        }
    }

    i = end;
    while (i > 0) {
        i -= 1;
        if (font[i] == ' ') {
            const candidate = trimFontToken(font[i + 1 .. end]);
            if (candidate.len > 0) return candidate;
        }
    }

    return trimFontToken(font[0..end]);
}

fn trimFontToken(font: []const u8) []const u8 {
    var start: usize = 0;
    var end: usize = font.len;

    while (start < end and (font[start] == ' ' or font[start] == '\t')) : (start += 1) {}
    while (end > start and (font[end - 1] == ' ' or font[end - 1] == '\t')) : (end -= 1) {}

    var family = font[start..end];
    if (family.len >= 2 and ((family[0] == '\'' and family[family.len - 1] == '\'') or (family[0] == '"' and family[family.len - 1] == '"'))) {
        family = family[1 .. family.len - 1];
    }
    return family;
}

fn isAvailableFont(family: []const u8) bool {
    return FingerprintProfile.isFontFamilyAvailable(family);
}

// load(font, text?) - resolves immediately with an array containing a loaded
// FontFace when the family is available; otherwise an empty array.
pub fn load(self: *FontFaceSet, font: []const u8, frame: *Frame) !js.Promise {
    const family = extractFontFamily(font);
    const available = isAvailableFont(family);

    const target = self.asEventTarget();
    if (frame._event_manager.hasDirectListeners(target, "loading", null)) {
        const event = try Event.initTrusted(comptime .wrap("loading"), .{}, frame._page);
        try frame._event_manager.dispatchDirect(target, event, null, .{ .context = "load font face set" });
    }

    if (frame._event_manager.hasDirectListeners(target, "loadingdone", null)) {
        const event = try Event.initTrusted(comptime .wrap("loadingdone"), .{}, frame._page);
        try frame._event_manager.dispatchDirect(target, event, null, .{ .context = "load font face set" });
    }

    if (!available) {
        const empty = frame.js.local.?.newArray(0);
        return frame.js.local.?.resolvePromise(empty.toValue());
    }

    const loaded = try FontFace.init(family, "local", frame);
    const arr = frame.js.local.?.newArray(1);
    _ = try arr.set(0, loaded, .{});
    return frame.js.local.?.resolvePromise(arr.toValue());
}

// add(fontFace) - no-op; headless browser does not track loaded fonts.
pub fn add(self: *FontFaceSet, _: *FontFace) *FontFaceSet {
    return self;
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(FontFaceSet);

    pub const Meta = struct {
        pub const name = "FontFaceSet";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const size = bridge.property(0, .{ .template = false, .readonly = true });
    pub const status = bridge.property("loaded", .{ .template = false, .readonly = true });
    pub const ready = bridge.accessor(FontFaceSet.getReady, null, .{});
    pub const check = bridge.function(FontFaceSet.check, .{});
    pub const load = bridge.function(FontFaceSet.load, .{});
    pub const add = bridge.function(FontFaceSet.add, .{});
};

const testing = @import("../../../testing/testing.zig");
test "WebApi: FontFaceSet" {
    try testing.htmlRunner("css/font_face_set.html", .{});
}
