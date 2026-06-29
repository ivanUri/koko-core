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

// zlint-disable unused-decls
const std = @import("std");
const js = @import("../../js/js.zig");
const Frame = @import("../../browser/Frame.zig");
const EventTarget = @import("../EventTarget.zig");
const MediaQueryEval = @import("MediaQueryEval.zig");

const MediaQueryList = @This();

_proto: *EventTarget,
_media: []const u8,

pub fn deinit(self: *MediaQueryList) void {
    _ = self;
}

pub fn asEventTarget(self: *MediaQueryList) *EventTarget {
    return self._proto;
}

pub fn getMedia(self: *const MediaQueryList) []const u8 {
    return self._media;
}

fn colorSchemeFromProfile(frame: *Frame) MediaQueryEval.Viewport.ColorScheme {
    const scheme = frame.loadedProfile().http.prefers_color_scheme;
    if (std.ascii.eqlIgnoreCase(scheme, "dark")) return .dark;
    return .light;
}

pub fn getMatches(self: *const MediaQueryList, frame: *Frame) bool {
    const screen = frame.identityProfile().screen;
    const vp: MediaQueryEval.Viewport = .{
        .width_px = screen.width,
        .height_px = screen.height,
        .device_width_px = screen.width,
        .device_height_px = screen.height,
        .device_pixel_ratio = screen.device_pixel_ratio,
        .color_scheme = colorSchemeFromProfile(frame),
        .color_gamut = .p3,
    };
    return MediaQueryEval.matches(self._media, vp);
}

pub fn addListener(_: *const MediaQueryList, _: js.Function) void {}
pub fn removeListener(_: *const MediaQueryList, _: js.Function) void {}

pub const JsApi = struct {
    pub const bridge = js.Bridge(MediaQueryList);

    pub const Meta = struct {
        pub const name = "MediaQueryList";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const media = bridge.accessor(MediaQueryList.getMedia, null, .{});
    pub const matches = bridge.accessor(MediaQueryList.getMatches, null, .{});
    pub const addListener = bridge.function(MediaQueryList.addListener, .{ .noop = true });
    pub const removeListener = bridge.function(MediaQueryList.removeListener, .{ .noop = true });
};

const testing = @import("../../../testing/testing.zig");
test "WebApi: MediaQueryList" {
    try testing.htmlRunner("css/media_query_list.html", .{});
}
