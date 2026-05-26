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

//! Minimal CSS Media Query evaluator.
//!
//! This is **not** a complete CSS Media Queries Level 4 implementation. It
//! supports the syntactic shapes that real-world web code (responsive
//! frameworks, fingerprint probes) actually emits today:
//!
//!   * media type `screen` / `all` / `print`
//!   * `(feature)` boolean form
//!   * `(feature: value)` plain form
//!   * `(min-feature: value)` / `(max-feature: value)` range form
//!   * boolean combinators `not`, `and`, `or`, `,` (comma list)
//!
//! Units handled: `px`, `dppx`, `dpi`, `dpcm`. Unitless ratios for
//! `aspect-ratio` (e.g. `16/9`) are not yet handled and evaluate to false.
//!
//! Features evaluated against the current viewport/screen state. Anything
//! the evaluator does not understand returns `false` (deterministic "not
//! matched") rather than throwing, which matches CSS conformance behavior
//! for unknown features.

const std = @import("std");

pub const Viewport = struct {
    width_px: u32,
    height_px: u32,
    device_width_px: u32,
    device_height_px: u32,
    device_pixel_ratio: f64,
    color_scheme: ColorScheme = .light,
    reduced_motion: bool = false,

    pub const ColorScheme = enum { light, dark };
};

pub fn matches(query: []const u8, vp: Viewport) bool {
    var p: Parser = .{ .src = query };
    return p.parseQueryList(vp);
}

const Parser = struct {
    src: []const u8,
    pos: usize = 0,

    fn peek(self: *Parser) ?u8 {
        if (self.pos >= self.src.len) return null;
        return self.src[self.pos];
    }

    fn advance(self: *Parser) void {
        self.pos += 1;
    }

    fn skipWs(self: *Parser) void {
        while (self.pos < self.src.len) : (self.pos += 1) {
            const c = self.src[self.pos];
            if (c != ' ' and c != '\t' and c != '\n' and c != '\r') break;
        }
    }

    fn eatChar(self: *Parser, c: u8) bool {
        self.skipWs();
        if (self.peek() == c) {
            self.advance();
            return true;
        }
        return false;
    }

    fn eatKeyword(self: *Parser, kw: []const u8) bool {
        self.skipWs();
        if (self.pos + kw.len > self.src.len) return false;
        const slice = self.src[self.pos .. self.pos + kw.len];
        if (!std.ascii.eqlIgnoreCase(slice, kw)) return false;
        // Must end at non-ident char.
        const after = self.pos + kw.len;
        if (after < self.src.len and isIdent(self.src[after])) return false;
        self.pos = after;
        return true;
    }

    fn isIdent(c: u8) bool {
        return std.ascii.isAlphanumeric(c) or c == '-' or c == '_';
    }

    fn readIdent(self: *Parser) []const u8 {
        self.skipWs();
        const start = self.pos;
        while (self.pos < self.src.len and isIdent(self.src[self.pos])) {
            self.pos += 1;
        }
        return self.src[start..self.pos];
    }

    /// Parses a comma-separated list of media queries. Returns true if any
    /// query in the list matches.
    fn parseQueryList(self: *Parser, vp: Viewport) bool {
        var any_match = false;
        while (true) {
            const m = self.parseMediaQuery(vp);
            if (m) any_match = true;
            self.skipWs();
            if (!self.eatChar(',')) break;
        }
        return any_match;
    }

    fn parseMediaQuery(self: *Parser, vp: Viewport) bool {
        // [ not ]? ( <type> | <feature> ) ( and ( <type> | <feature> ) )*
        const negate = self.eatKeyword("not");
        const first = self.parseTermOrFalse(vp);
        var combined = first;
        while (self.eatKeyword("and")) {
            const next = self.parseTermOrFalse(vp);
            combined = combined and next;
        }
        return if (negate) !combined else combined;
    }

    fn parseTermOrFalse(self: *Parser, vp: Viewport) bool {
        self.skipWs();
        if (self.peek() == '(') {
            self.advance();
            const r = self.parseFeature(vp);
            self.skipWs();
            _ = self.eatChar(')');
            return r;
        }
        // Bare media type: `all`, `screen`, `print`.
        const id = self.readIdent();
        if (std.ascii.eqlIgnoreCase(id, "all")) return true;
        if (std.ascii.eqlIgnoreCase(id, "screen")) return true;
        if (std.ascii.eqlIgnoreCase(id, "print")) return false;
        // Anything else (including empty) fails closed.
        return false;
    }

    fn parseFeature(self: *Parser, vp: Viewport) bool {
        self.skipWs();
        const name_raw = self.readIdent();
        if (name_raw.len == 0) return false;

        // Lowercase into a fixed buffer; feature names are short.
        var lower_buf: [64]u8 = undefined;
        if (name_raw.len > lower_buf.len) return false;
        for (name_raw, 0..) |c, i| lower_buf[i] = std.ascii.toLower(c);
        const name = lower_buf[0..name_raw.len];

        // Strip min-/max- prefix.
        var bound: enum { exact, min, max } = .exact;
        var feat = name;
        if (std.mem.startsWith(u8, feat, "min-")) {
            bound = .min;
            feat = feat[4..];
        } else if (std.mem.startsWith(u8, feat, "max-")) {
            bound = .max;
            feat = feat[4..];
        }

        self.skipWs();
        if (!self.eatChar(':')) {
            // Boolean form: `(feature)` matches iff feature is "truthy".
            return featureBoolean(feat, vp);
        }

        // `(feature: value)` form.
        return matchValue(feat, bound, self.readValue(), vp);
    }

    fn readValue(self: *Parser) []const u8 {
        self.skipWs();
        const start = self.pos;
        while (self.pos < self.src.len and self.src[self.pos] != ')' and self.src[self.pos] != ',') {
            self.pos += 1;
        }
        return std.mem.trim(u8, self.src[start..self.pos], &std.ascii.whitespace);
    }
};

fn featureBoolean(feat: []const u8, vp: Viewport) bool {
    if (std.mem.eql(u8, feat, "width")) return vp.width_px > 0;
    if (std.mem.eql(u8, feat, "height")) return vp.height_px > 0;
    if (std.mem.eql(u8, feat, "device-width")) return vp.device_width_px > 0;
    if (std.mem.eql(u8, feat, "device-height")) return vp.device_height_px > 0;
    if (std.mem.eql(u8, feat, "resolution")) return vp.device_pixel_ratio > 0;
    if (std.mem.eql(u8, feat, "color")) return true;
    if (std.mem.eql(u8, feat, "any-pointer") or std.mem.eql(u8, feat, "pointer")) return true;
    if (std.mem.eql(u8, feat, "any-hover") or std.mem.eql(u8, feat, "hover")) return true;
    if (std.mem.eql(u8, feat, "prefers-color-scheme")) return true;
    if (std.mem.eql(u8, feat, "prefers-reduced-motion")) return true;
    return false;
}

fn matchValue(
    feat: []const u8,
    bound: anytype,
    value_raw: []const u8,
    vp: Viewport,
) bool {
    // Pixel-valued features.
    const Px = struct {
        fn cmp(b: @TypeOf(bound), actual: u32, want: u32) bool {
            return switch (b) {
                .exact => actual == want,
                .min => actual >= want,
                .max => actual <= want,
            };
        }
    };

    if (std.mem.eql(u8, feat, "width")) {
        const v = parseLength(value_raw) orelse return false;
        return Px.cmp(bound, vp.width_px, v);
    }
    if (std.mem.eql(u8, feat, "height")) {
        const v = parseLength(value_raw) orelse return false;
        return Px.cmp(bound, vp.height_px, v);
    }
    if (std.mem.eql(u8, feat, "device-width")) {
        const v = parseLength(value_raw) orelse return false;
        return Px.cmp(bound, vp.device_width_px, v);
    }
    if (std.mem.eql(u8, feat, "device-height")) {
        const v = parseLength(value_raw) orelse return false;
        return Px.cmp(bound, vp.device_height_px, v);
    }
    if (std.mem.eql(u8, feat, "resolution")) {
        const v = parseResolution(value_raw) orelse return false;
        return switch (bound) {
            .exact => approxEq(vp.device_pixel_ratio, v),
            .min => vp.device_pixel_ratio >= v,
            .max => vp.device_pixel_ratio <= v,
        };
    }
    if (std.mem.eql(u8, feat, "orientation")) {
        const want_landscape = std.ascii.eqlIgnoreCase(value_raw, "landscape");
        const want_portrait = std.ascii.eqlIgnoreCase(value_raw, "portrait");
        const is_landscape = vp.width_px >= vp.height_px;
        if (want_landscape) return is_landscape;
        if (want_portrait) return !is_landscape;
        return false;
    }
    if (std.mem.eql(u8, feat, "prefers-color-scheme")) {
        const want_light = std.ascii.eqlIgnoreCase(value_raw, "light");
        const want_dark = std.ascii.eqlIgnoreCase(value_raw, "dark");
        if (want_light) return vp.color_scheme == .light;
        if (want_dark) return vp.color_scheme == .dark;
        return false;
    }
    if (std.mem.eql(u8, feat, "prefers-reduced-motion")) {
        const want_reduce = std.ascii.eqlIgnoreCase(value_raw, "reduce");
        const want_no = std.ascii.eqlIgnoreCase(value_raw, "no-preference");
        if (want_reduce) return vp.reduced_motion;
        if (want_no) return !vp.reduced_motion;
        return false;
    }
    return false;
}

fn parseLength(s: []const u8) ?u32 {
    if (std.mem.endsWith(u8, s, "px")) {
        const num = std.mem.trim(u8, s[0 .. s.len - 2], &std.ascii.whitespace);
        const f = std.fmt.parseFloat(f64, num) catch return null;
        if (f < 0) return null;
        return @intFromFloat(@round(f));
    }
    // Unitless 0 is allowed by spec.
    if (std.mem.eql(u8, std.mem.trim(u8, s, &std.ascii.whitespace), "0")) return 0;
    return null;
}

fn parseResolution(s: []const u8) ?f64 {
    if (std.mem.endsWith(u8, s, "dppx")) {
        const num = std.mem.trim(u8, s[0 .. s.len - 4], &std.ascii.whitespace);
        return std.fmt.parseFloat(f64, num) catch null;
    }
    if (std.mem.endsWith(u8, s, "dpi")) {
        const num = std.mem.trim(u8, s[0 .. s.len - 3], &std.ascii.whitespace);
        const dpi = std.fmt.parseFloat(f64, num) catch return null;
        return dpi / 96.0;
    }
    if (std.mem.endsWith(u8, s, "dpcm")) {
        const num = std.mem.trim(u8, s[0 .. s.len - 4], &std.ascii.whitespace);
        const dpcm = std.fmt.parseFloat(f64, num) catch return null;
        return (dpcm * 2.54) / 96.0;
    }
    return null;
}

fn approxEq(a: f64, b: f64) bool {
    const diff = if (a > b) a - b else b - a;
    return diff < 0.001;
}

const testing = std.testing;

test "device-width and device-height exact" {
    const vp: Viewport = .{
        .width_px = 1920,
        .height_px = 1080,
        .device_width_px = 1920,
        .device_height_px = 1080,
        .device_pixel_ratio = 1.0,
    };
    try testing.expect(matches("(device-width: 1920px) and (device-height: 1080px)", vp));
    try testing.expect(!matches("(device-width: 800px)", vp));
}

test "resolution dppx" {
    const vp: Viewport = .{
        .width_px = 1920,
        .height_px = 1080,
        .device_width_px = 1920,
        .device_height_px = 1080,
        .device_pixel_ratio = 1.0,
    };
    try testing.expect(matches("(resolution: 1dppx)", vp));
    try testing.expect(!matches("(resolution: 2dppx)", vp));
}

test "min/max width" {
    const vp: Viewport = .{
        .width_px = 1920,
        .height_px = 1080,
        .device_width_px = 1920,
        .device_height_px = 1080,
        .device_pixel_ratio = 1.0,
    };
    try testing.expect(matches("(min-width: 800px)", vp));
    try testing.expect(matches("(max-width: 2000px)", vp));
    try testing.expect(!matches("(min-width: 3000px)", vp));
}

test "comma list and not" {
    const vp: Viewport = .{
        .width_px = 1920,
        .height_px = 1080,
        .device_width_px = 1920,
        .device_height_px = 1080,
        .device_pixel_ratio = 1.0,
    };
    try testing.expect(matches("print, (min-width: 800px)", vp));
    try testing.expect(!matches("not all", vp));
    try testing.expect(matches("not (max-width: 100px)", vp));
}

test "prefers-color-scheme" {
    const vp: Viewport = .{
        .width_px = 1920,
        .height_px = 1080,
        .device_width_px = 1920,
        .device_height_px = 1080,
        .device_pixel_ratio = 1.0,
        .color_scheme = .light,
    };
    try testing.expect(matches("(prefers-color-scheme: light)", vp));
    try testing.expect(!matches("(prefers-color-scheme: dark)", vp));
}
