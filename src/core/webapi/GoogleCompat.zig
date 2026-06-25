//! Minimal `google` global for Search SERP compatibility (bad_srp / attn probes).
//! Real pages define `google.cv` inline; Velora provides a layout-backed shim when
//! the document looks like a SERP or the frame is on google.com/search.

const std = @import("std");

const js = @import("../js/js.zig");
const Frame = @import("../browser/Frame.zig");
const Element = @import("../dom/Element.zig");

const GoogleCompat = @This();

_vx: f64 = 0,
_vy: f64 = 0,

pub const init: GoogleCompat = .{};

pub fn registerTypes() []const type {
    return &.{GoogleCompat};
}

fn isGoogleSearchUrl(url: []const u8) bool {
    return std.mem.indexOf(u8, url, "google.com") != null and
        std.mem.indexOf(u8, url, "/search") != null;
}

pub fn shouldExpose(frame: *Frame) bool {
    if (isGoogleSearchUrl(frame.url)) return true;
    return frame.document.getElementById("center_col", frame) != null;
}

/// Visibility bitmask compatible with Google's `google.cv(element)` helper.
/// 0 = hidden, 1 = in viewport, 2 = above, 4 = below, 8 = horizontal clip.
pub fn cv(
    _: *GoogleCompat,
    element: ?*Element,
    container: ?*Element,
    deep: ?bool,
    frame: *Frame,
) f64 {
    _ = container;
    const el = element orelse return 0;
    if (deep == true and !el.checkVisibilityCached(null, frame)) return 0;

    const rect = el.getBoundingClientRectForVisible(frame);
    if (rect._width <= 0 and rect._height <= 0) return 0;

    const profile = frame.identityProfile();
    const viewport_w = @as(f64, @floatFromInt(profile.window.inner_width));
    const viewport_h = @as(f64, @floatFromInt(profile.window.inner_height));

    const top = rect._y;
    const bottom = rect._y + rect._height;
    const left = rect._x;
    const right = rect._x + rect._width;

    var flags: u8 = 0;
    if (bottom < 0) flags |= 2;
    if (top >= viewport_h) flags |= 4;
    if (right < 0 or left >= viewport_w) flags |= 8;
    if (flags == 0) flags = 1;

    return @floatFromInt(flags);
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(GoogleCompat);

    pub const Meta = struct {
        pub const name = "GoogleCompat";
        pub const own_properties = true;
        pub const empty_with_no_proto = true;
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const vx = bridge.accessor(getVx, null, .{ .deletable = false });
    pub const vy = bridge.accessor(getVy, null, .{ .deletable = false });
    pub const cv = bridge.function(GoogleCompat.cv, .{});
};

fn getVx(self: *GoogleCompat) f64 {
    return self._vx;
}

fn getVy(self: *GoogleCompat) f64 {
    return self._vy;
}
