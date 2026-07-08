//! Minimal `google` global for Search SERP compatibility (bad_srp / attn probes).
//! Real pages define `google.cv` inline; Velora provides a layout-backed shim when
//! the document looks like a SERP or the frame is on google.com/search.

const std = @import("std");

const js = @import("../js/js.zig");
const Frame = @import("../browser/Frame.zig");
const Element = @import("../dom/Element.zig");
const String = @import("../../support/string.zig").String;

const GoogleCompat = @This();

const GoogleC = struct {
    _cap: u32 = 0,

    pub fn getCap(self: *const GoogleC) u32 {
        return self._cap;
    }

    pub fn setCap(self: *GoogleC, cap: u32) void {
        self._cap = cap;
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(GoogleC);

        pub const Meta = struct {
            pub const name = "GoogleC";
            pub const own_properties = true;
            pub const empty_with_no_proto = true;
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };

        pub const cap = bridge.accessor(GoogleC.getCap, GoogleC.setCap, .{});
    };
};

_vx: f64 = 0,
_vy: f64 = 0,
_sn: []const u8 = "web",
_k_ei: ?[]const u8 = null,
_c: GoogleC = .{},

pub const init: GoogleCompat = .{};

pub fn registerTypes() []const type {
    return &.{ GoogleCompat, GoogleC };
}

pub fn shouldExpose(frame: *Frame) bool {
    if (frame.document.getElementById("rso", frame) != null) return true;
    return frame.document.getElementById("center_col", frame) != null;
}

/// SGS bootstrap / sei hop: expose `google.sn`, `kEI`, `tick`, `c` without the SERP-only cv shim gate.
pub fn shouldExposeBootstrap(frame: *Frame) bool {
    if (shouldExpose(frame)) return false;
    const url = frame.url;
    if (std.mem.indexOf(u8, url, "google.") == null) return false;
    if (std.mem.indexOf(u8, url, "accounts.google.") != null) return true;
    return std.mem.indexOf(u8, url, "/search") != null or std.mem.indexOf(u8, url, "sei=") != null;
}

pub fn ensureBootstrapDefaults(self: *GoogleCompat, frame: *Frame) void {
    if (!shouldExposeBootstrap(frame)) return;
    self._sn = "web";
    self._c._cap = 0;
    if (self._k_ei != null) return;
    const url = frame.url;
    if (std.mem.indexOf(u8, url, "sei=")) |idx| {
        const start = idx + "sei=".len;
        const rest = url[start..];
        const end = std.mem.indexOfScalar(u8, rest, '&') orelse rest.len;
        if (end > 0) {
            self._k_ei = frame.call_arena.dupe(u8, rest[0..end]) catch null;
        }
    }
}

pub fn applyPlainObject(self: *GoogleCompat, value: js.Value, frame: *Frame) void {
    if (!value.isObject()) return;
    const obj = js.Object{
        .local = value.local,
        .handle = @ptrCast(value.handle),
    };
    if (obj.get("sn")) |sn| {
        if (sn.isString()) |s| {
            if (s.toSlice() catch null) |slice| {
                self._sn = frame.call_arena.dupe(u8, slice) catch self._sn;
            }
        }
    } else |_| {}
    if (obj.get("kEI")) |kei| {
        if (kei.isString()) |s| {
            if (s.toSlice() catch null) |slice| {
                self._k_ei = frame.call_arena.dupe(u8, slice) catch self._k_ei;
            }
        }
    } else |_| {}
    if (obj.get("c")) |c| {
        if (c.isObject()) {
            const c_obj = js.Object{
                .local = c.local,
                .handle = @ptrCast(c.handle),
            };
            if (c_obj.get("cap")) |cap| {
                if (cap.toU32()) |n| {
                    self._c._cap = n;
                } else |_| {}
            } else |_| {}
        }
    } else |_| {}
}

pub fn getSn(self: *const GoogleCompat) []const u8 {
    return self._sn;
}

pub fn getKEI(self: *const GoogleCompat) ?[]const u8 {
    return self._k_ei;
}

pub fn getC(self: *GoogleCompat) *GoogleC {
    return &self._c;
}

/// Chromium `google.tick(phase, mark, ms?, label?)` — records load-phase marks for SGS bootstrap.
pub fn tick(
    _: *GoogleCompat,
    phase_val: js.Value,
    mark_val: js.Value,
    ms_val: js.Value,
    _: js.Value,
    frame: *Frame,
) void {
    _ = phase_val;
    _ = mark_val;
    const perf = &frame.window._performance;
    if (ms_val.isUndefined() or ms_val.isNull() or !ms_val.isNumber()) {
        _ = perf.now();
        return;
    }
    _ = ms_val.toF64() catch {
        _ = perf.now();
    };
}

fn elementOverflowHidden(el: *Element, frame: *Frame) bool {
    if (el.getAttributeSafe(comptime .wrap("style"))) |style| {
        var lower_buf: [128]u8 = undefined;
        if (style.len <= lower_buf.len) {
            for (style, 0..) |c, i| lower_buf[i] = std.ascii.toLower(c);
            const lower = lower_buf[0..style.len];
            if (std.mem.indexOf(u8, lower, "overflow:hidden") != null or
                std.mem.indexOf(u8, lower, "overflow: hidden") != null)
                return true;
        }
    }
    if (frame._style_manager.getLayoutProperty(el, "overflow")) |v| {
        if (std.ascii.eqlIgnoreCase(v, "hidden")) return true;
    }
    if (frame._style_manager.getLayoutProperty(el, "overflow-x")) |v| {
        if (std.ascii.eqlIgnoreCase(v, "hidden")) return true;
    }
    if (frame._style_manager.getLayoutProperty(el, "overflow-y")) |v| {
        if (std.ascii.eqlIgnoreCase(v, "hidden")) return true;
    }
    return false;
}

fn cvScrollContainer(element: *Element, stop: ?*Element) ?*Element {
    var current: ?*Element = element;
    while (current) |el| {
        if (el.hasAttributeSafe(comptime .wrap("data-csic"))) return el;
        current = el.asNode().parentElement();
    }

    current = element;
    while (current) |el| {
        if (stop) |s| {
            if (el == s) break;
        }
        if (std.ascii.eqlIgnoreCase(el.getTagNameLower(), "g-scrolling-carousel")) return el;
        if (el.getAttributeSafe(String.wrap("data-sn-container")) != null) return el;
        current = el.asNode().parentElement();
    }
    return null;
}

fn overflowClipAncestor(element: *Element, stop: ?*Element, frame: *Frame) ?*Element {
    var current: ?*Element = element;
    while (current) |el| {
        if (stop) |s| {
            if (el == s) break;
        }
        if (elementOverflowHidden(el, frame)) return el;
        current = el.asNode().parentElement();
    }
    return null;
}

fn rectOutside(ax: f64, ay: f64, aw: f64, ah: f64, bx: f64, by: f64, bw: f64, bh: f64) bool {
    const a_bottom = ay + ah;
    const a_right = ax + aw;
    const b_bottom = by + bh;
    const b_right = bx + bw;
    return a_bottom < by or ay >= b_bottom or a_right < bx or ax >= b_right;
}

fn shrinkWrapParent(element: *Element, frame: *Frame) *Element {
    const parent = element.asNode().parentElement() orelse return element;
    const class_attr = parent.getAttributeSafe(comptime .wrap("class")) orelse return element;
    const has_q1 = std.mem.indexOf(u8, class_attr, "q1MG4e") != null;
    const has_uh = std.mem.indexOf(u8, class_attr, "uhHOwf") != null;
    if (!has_q1 and !has_uh) return element;

    const style_attr = parent.getAttributeSafe(comptime .wrap("style")) orelse return element;
    if (style_attr.len == 0) return element;
    const has_fixed_size = std.mem.indexOf(u8, style_attr, "height") != null or
        std.mem.indexOf(u8, style_attr, "width") != null;
    if (!has_fixed_size) return element;

    const parent_rect = parent.getBoundingClientRectForVisible(frame);
    const self_rect = element.getBoundingClientRectForVisible(frame);
    if (parent_rect._height < self_rect._height or parent_rect._width < self_rect._width) {
        return parent;
    }
    return element;
}

fn isCvHidden(element: *Element, deep: bool, frame: *Frame) bool {
    if (frame._style_manager.isHidden(element, null, .{
        .check_display = true,
        .check_visibility = false,
        .check_opacity = false,
    })) return true;

    if (!deep) return false;

    // Deep path: inline visibility/opacity only while layout-resolve is active.
    if (frame._style_manager.isHidden(element, null, .{
        .check_display = false,
        .check_visibility = true,
        .check_opacity = true,
    })) return true;

    const rect = element.getBoundingClientRectForVisible(frame);
    return rect._width <= 0 and rect._height <= 0;
}

fn accumulateScrollLeft(element: *Element, stop: ?*Element, frame: *Frame) f64 {
    var total: f64 = 0;
    var current: ?*Element = element;
    while (current) |el| {
        if (stop) |s| {
            if (el == s) break;
        }
        total += @floatFromInt(el.getScrollLeft(frame));
        current = el.asNode().parentElement();
    }
    return total;
}

/// Chrome Search `google.cv(element[, container[, deep]])` visibility bitmask.
/// 0 = hidden/clipped, 1 = in viewport, 2 = above, 4 = below, 8 = horizontal clip.
pub fn cv(
    self: *GoogleCompat,
    element: ?*Element,
    container: ?*Element,
    deep: ?bool,
    frame: *Frame,
) f64 {
    frame.finishTopLevelLayoutResolve();
    frame.beginLayoutResolve();
    defer frame.finishTopLevelLayoutResolve();

    _ = self;
    const el_in = element orelse return 0;
    const deep_check = deep == true;

    const el = shrinkWrapParent(el_in, frame);
    if (isCvHidden(el, deep_check, frame)) return 0;

    const scroll_container = cvScrollContainer(el, container);

    if (!deep_check) {
        if (overflowClipAncestor(el, scroll_container, frame)) |clipper| {
            const clip_rect = clipper.getBoundingClientRectForVisible(frame);
            const probe = el.getBoundingClientRectForVisible(frame);
            if (rectOutside(
                probe._x,
                probe._y,
                probe._width,
                probe._height,
                clip_rect._x,
                clip_rect._y,
                clip_rect._width,
                clip_rect._height,
            )) return 0;
        }
    }

    const rect = el.getBoundingClientRectForVisible(frame);
    if (rect._width <= 0 and rect._height <= 0) return 0;

    const profile = frame.identityProfile();
    const viewport_w = @as(f64, @floatFromInt(profile.window.inner_width));
    const viewport_h: f64 = blk: {
        const base = @as(f64, @floatFromInt(profile.window.inner_height));
        if (frame.document.getDocumentElement()) |doc_el| {
            break :blk @max(base, doc_el.getClientHeight(frame));
        }
        break :blk base;
    };

    const top = rect._y;
    const bottom = rect._y + rect._height;
    const left = rect._x;
    const right = rect._x + rect._width;
    const width = rect._width;
    const height = rect._height;

    if (!deep_check and height <= 0 and width <= 0) return 0;

    var flags: u8 = 0;
    if (bottom < 0) flags |= 2;
    if (top >= viewport_h) flags |= 4;
    if (right < 0 or left >= viewport_w) flags |= 8;

    if (scroll_container) |c| {
        const scrolled_left = left + accumulateScrollLeft(el, c, frame);
        const c_rect = c.getBoundingClientRectForVisible(frame);
        if (scrolled_left + width < c_rect._x or scrolled_left >= c_rect._x + c_rect._width) {
            flags |= 8;
        }
        if (top >= c_rect._y + c_rect._height) flags |= 4;
    }

    if (flags == 0) flags = 1;
    if (bottom > viewport_h) flags |= 4;

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

    pub const sn = bridge.accessor(GoogleCompat.getSn, null, .{ .deletable = false });
    pub const kEI = bridge.accessor(GoogleCompat.getKEI, null, .{ .null_as_undefined = true });
    pub const c = bridge.accessor(GoogleCompat.getC, null, .{ .deletable = false });
    pub const tick = bridge.function(GoogleCompat.tick, .{});
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
