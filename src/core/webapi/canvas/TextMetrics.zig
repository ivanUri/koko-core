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
const FingerprintProfile = @import("../../profile/types.zig");
const MeasureTextIntelligent = @import("../../../runtime/profile/MeasureTextIntelligent.zig");
const js = @import("../../js/js.zig");
const Frame = @import("../../browser/Frame.zig");

/// TextMetrics is the result of `CanvasRenderingContext2D.measureText`.
/// https://html.spec.whatwg.org/multipage/canvas.html#textmetrics
///
/// Koko is headless and has no font system, so measurements are estimated
/// using simple character-based heuristics. This provides deterministic values
/// for fingerprinting and basic layout code without requiring a full font engine.
const TextMetrics = @This();

_width: f64 = 0.0,
_font_size: f64 = 10.0,
_text_length: usize = 0,
_text_hash: u32 = 0,
_font_hash: u32 = 0,
_uses_baseline: bool = false,
_abl: f64 = 0,
_abr: f64 = 0,
_aba: f64 = 0,
_abd: f64 = 0,
_fbba: f64 = 0,
_fbbd: f64 = 0,

pub fn init(text: []const u8, font: []const u8, frame: *Frame) !*TextMetrics {
    const font_size = parseFontSize(font);
    const text_hash = simpleHash(text);
    const font_hash = simpleHash(font);

    if (MeasureTextIntelligent.lookup(frame, font, text)) |bl| {
        return frame._factory.create(TextMetrics{
            ._width = bl.width,
            ._font_size = font_size,
            ._text_length = text.len,
            ._text_hash = text_hash,
            ._font_hash = font_hash,
            ._uses_baseline = true,
            ._abl = bl.actual_bounding_box_left,
            ._abr = bl.actual_bounding_box_right,
            ._aba = bl.actual_bounding_box_ascent,
            ._abd = bl.actual_bounding_box_descent,
            ._fbba = bl.font_bounding_box_ascent,
            ._fbbd = bl.font_bounding_box_descent,
        });
    }

    const width = estimateTextWidth(text, font, font_size, frame.identityProfile());

    return frame._factory.create(TextMetrics{
        ._width = width,
        ._font_size = font_size,
        ._text_length = text.len,
        ._text_hash = text_hash,
        ._font_hash = font_hash,
    });
}

/// Simple hash function for deterministic variations
fn simpleHash(bytes: []const u8) u32 {
    var hash: u32 = 2166136261; // FNV offset basis
    for (bytes) |byte| {
        hash ^= byte;
        hash *%= 16777619; // FNV prime
    }
    return hash;
}

/// Parse font size from CSS font shorthand (e.g., "10px sans-serif" -> 10.0)
fn parseFontSize(font: []const u8) f64 {
    // Find first number sequence
    var i: usize = 0;
    while (i < font.len) : (i += 1) {
        if (font[i] >= '0' and font[i] <= '9') {
            // Found start of number
            var end = i + 1;
            var has_dot = false;
            while (end < font.len) : (end += 1) {
                if (font[end] >= '0' and font[end] <= '9') continue;
                if (font[end] == '.' and !has_dot) {
                    has_dot = true;
                    continue;
                }
                break;
            }

            const num_str = font[i..end];
            return std.fmt.parseFloat(f64, num_str) catch 10.0;
        }
    }

    // Default to 10px if parsing fails
    return 10.0;
}

/// Public layout helper for DOM offsetWidth of text spans (font fingerprint probes).
/// `font_family_css` is a CSS `font-family` list (e.g. `"'Arial', monospace"`).
/// Resolves the first available family so installed vs fallback widths differ.
pub fn estimateLayoutTextWidth(
    text: []const u8,
    font_family_css: []const u8,
    font_size: f64,
    profile: *const FingerprintProfile.IdentityProfile,
) f64 {
    if (text.len == 0) return 0.0;
    const family = resolveAvailableFontFamily(font_family_css, profile);
    return estimateTextWidthWithFamily(text, family, font_size, profile);
}

/// Estimate text width using simple heuristics (canvas `font` shorthand).
fn estimateTextWidth(text: []const u8, font: []const u8, font_size: f64, profile: *const FingerprintProfile.IdentityProfile) f64 {
    if (text.len == 0) return 0.0;

    const font_family = extractPrimaryFontFamily(font);
    return estimateTextWidthWithFamily(text, font_family, font_size, profile);
}

fn estimateTextWidthWithFamily(
    text: []const u8,
    font_family: []const u8,
    font_size: f64,
    profile: *const FingerprintProfile.IdentityProfile,
) f64 {
    if (text.len == 0) return 0.0;
    const font_scale = fontFamilyScale(font_family, profile);
    const avg_char_width = font_size * 0.52 * font_scale;

    var width: f64 = 0.0;
    var i: usize = 0;

    while (i < text.len) {
        const c = text[i];

        const char_width = if (c == ' ')
            avg_char_width * 0.32
        else if (c == '\n' or c == '\r' or c == '\t')
            avg_char_width * 0.25
        else if (c >= 'A' and c <= 'Z')
            avg_char_width * 1.08
        else if (c == 'i' or c == 'l' or c == 'I' or c == '1' or c == '!' or c == '|')
            avg_char_width * 0.52
        else if (c == 'm' or c == 'M' or c == 'w' or c == 'W')
            avg_char_width * 1.28
        else if (c >= '0' and c <= '9')
            avg_char_width * 0.88
        else if (c >= 0xF0)
            avg_char_width * 1.9
        else if (c >= 0xE0)
            avg_char_width * 1.45
        else
            avg_char_width;

        width += char_width;
        i += 1;
    }

    return width;
}

fn extractPrimaryFontFamily(font: []const u8) []const u8 {
    // Canvas font shorthand: size/style first, family last after the final comma
    // or as the trailing token ("10px Arial" / "italic 12px 'Helvetica Neue'").
    var i: usize = font.len;
    while (i > 0) {
        i -= 1;
        if (font[i] == ',') {
            return trimFontFamily(font[i + 1 ..]);
        }
    }
    // No comma: strip leading size/weight tokens → last token is family.
    var start: usize = 0;
    var last_space: ?usize = null;
    while (start < font.len) : (start += 1) {
        if (font[start] == ' ') last_space = start;
    }
    if (last_space) |sp| return trimFontFamily(font[sp + 1 ..]);
    return trimFontFamily(font);
}

/// Pick first available family from a CSS `font-family` list; else last generic.
fn resolveAvailableFontFamily(
    font_family_css: []const u8,
    profile: *const FingerprintProfile.IdentityProfile,
) []const u8 {
    var last: []const u8 = "sans-serif";
    var start: usize = 0;
    var i: usize = 0;
    while (i <= font_family_css.len) : (i += 1) {
        if (i == font_family_css.len or font_family_css[i] == ',') {
            const token = trimFontFamily(font_family_css[start..i]);
            if (token.len > 0) {
                last = token;
                if (isGenericFontFamily(token) or FingerprintProfile.isFontFamilyAvailable(profile, token)) {
                    return token;
                }
            }
            start = i + 1;
        }
    }
    return last;
}

fn isGenericFontFamily(family: []const u8) bool {
    return std.ascii.eqlIgnoreCase(family, "serif") or
        std.ascii.eqlIgnoreCase(family, "sans-serif") or
        std.ascii.eqlIgnoreCase(family, "monospace") or
        std.ascii.eqlIgnoreCase(family, "cursive") or
        std.ascii.eqlIgnoreCase(family, "fantasy") or
        std.ascii.eqlIgnoreCase(family, "system-ui") or
        std.ascii.eqlIgnoreCase(family, "ui-serif") or
        std.ascii.eqlIgnoreCase(family, "ui-sans-serif") or
        std.ascii.eqlIgnoreCase(family, "ui-monospace") or
        std.ascii.eqlIgnoreCase(family, "ui-rounded") or
        std.ascii.eqlIgnoreCase(family, "emoji") or
        std.ascii.eqlIgnoreCase(family, "math") or
        std.ascii.eqlIgnoreCase(family, "fangsong");
}

fn trimFontFamily(font: []const u8) []const u8 {
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

fn fontFamilyScale(family: []const u8, profile: *const FingerprintProfile.IdentityProfile) f64 {
    if (std.ascii.eqlIgnoreCase(family, "Menlo") or
        std.ascii.eqlIgnoreCase(family, "Monaco") or
        std.ascii.eqlIgnoreCase(family, "Courier") or
        std.ascii.eqlIgnoreCase(family, "Courier New") or
        std.ascii.eqlIgnoreCase(family, "Source Code Pro") or
        std.ascii.eqlIgnoreCase(family, "Cousine") or
        std.ascii.eqlIgnoreCase(family, "Liberation Mono") or
        std.ascii.eqlIgnoreCase(family, "monospace"))
    {
        return 0.96;
    }
    if (std.ascii.eqlIgnoreCase(family, "Times") or
        std.ascii.eqlIgnoreCase(family, "Times New Roman") or
        std.ascii.eqlIgnoreCase(family, "Palatino") or
        std.ascii.eqlIgnoreCase(family, "American Typewriter") or
        std.ascii.eqlIgnoreCase(family, "serif"))
    {
        return 1.01;
    }
    if (std.ascii.eqlIgnoreCase(family, "Apple Color Emoji") or
        std.ascii.eqlIgnoreCase(family, "Segoe UI Emoji") or
        std.ascii.eqlIgnoreCase(family, "Noto Color Emoji"))
    {
        return 1.12;
    }
    if (std.ascii.eqlIgnoreCase(family, "Helvetica") or
        std.ascii.eqlIgnoreCase(family, "Helvetica Neue") or
        std.ascii.eqlIgnoreCase(family, "Arial") or
        std.ascii.eqlIgnoreCase(family, "Geneva") or
        std.ascii.eqlIgnoreCase(family, "system-ui") or
        std.ascii.eqlIgnoreCase(family, "-apple-system") or
        std.ascii.eqlIgnoreCase(family, "-apple-system-body") or
        std.ascii.eqlIgnoreCase(family, "BlinkMacSystemFont") or
        std.ascii.eqlIgnoreCase(family, ".AppleSystemUIFont") or
        std.ascii.eqlIgnoreCase(family, "ui-sans-serif") or
        std.ascii.eqlIgnoreCase(family, "ui-serif") or
        std.ascii.eqlIgnoreCase(family, "ui-monospace") or
        std.ascii.eqlIgnoreCase(family, "ui-rounded"))
    {
        return 0.985;
    }

    for (profile.fonts) |available| {
        if (std.ascii.eqlIgnoreCase(family, available)) return 1.0;
    }

    return 1.18;
}

/// CreepJS flags fractional measureText('') metrics as noise.
fn metricValue(self: *const TextMetrics, base: f64, hash: u32) f64 {
    if (self._text_length == 0) return 0;
    const normalized = @as(f64, @floatFromInt(hash % 256)) / 255.0;
    const variation = (normalized - 0.5) * 0.0008;
    return base + variation;
}

pub fn getWidth(self: *const TextMetrics) f64 {
    if (self._uses_baseline) return self._width;
    const combined_hash = self._text_hash ^ self._font_hash;
    return metricValue(self, self._width, combined_hash);
}

fn getActualBoundingBoxLeft(self: *const TextMetrics) f64 {
    if (self._uses_baseline) return self._abl;
    return metricValue(self, 0.0, self._text_hash);
}

fn getActualBoundingBoxRight(self: *const TextMetrics) f64 {
    if (self._uses_baseline) return self._abr;
    return metricValue(self, self._width, self._text_hash +% 1);
}

pub fn getActualBoundingBoxAscent(self: *const TextMetrics) f64 {
    if (self._uses_baseline) return self._aba;
    return metricValue(self, self._font_size * 0.75, self._font_hash);
}

pub fn getActualBoundingBoxDescent(self: *const TextMetrics) f64 {
    if (self._uses_baseline) return self._abd;
    return metricValue(self, self._font_size * 0.25, self._font_hash +% 1);
}

fn getFontBoundingBoxAscent(self: *const TextMetrics) f64 {
    if (self._uses_baseline) return self._fbba;
    return metricValue(self, self._font_size * 0.8, self._font_hash +% 2);
}

fn getFontBoundingBoxDescent(self: *const TextMetrics) f64 {
    if (self._uses_baseline) return self._fbbd;
    return metricValue(self, self._font_size * 0.2, self._font_hash +% 3);
}

fn getEmHeightAscent(self: *const TextMetrics) f64 {
    return metricValue(self, self._font_size * 0.75, self._font_hash +% 4);
}

fn getEmHeightDescent(self: *const TextMetrics) f64 {
    return metricValue(self, self._font_size * 0.25, self._font_hash +% 5);
}

fn getHangingBaseline(self: *const TextMetrics) f64 {
    return metricValue(self, self._font_size * 0.75 * 0.7, self._font_hash +% 6);
}

fn getAlphabeticBaseline(self: *const TextMetrics) f64 {
    return metricValue(self, 0.0, self._font_hash +% 7);
}

fn getIdeographicBaseline(self: *const TextMetrics) f64 {
    return metricValue(self, -self._font_size * 0.25, self._font_hash +% 8);
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(TextMetrics);

    pub const Meta = struct {
        pub const name = "TextMetrics";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const width = bridge.accessor(TextMetrics.getWidth, null, .{});
    pub const actualBoundingBoxLeft = bridge.accessor(TextMetrics.getActualBoundingBoxLeft, null, .{});
    pub const actualBoundingBoxRight = bridge.accessor(TextMetrics.getActualBoundingBoxRight, null, .{});
    pub const actualBoundingBoxAscent = bridge.accessor(TextMetrics.getActualBoundingBoxAscent, null, .{});
    pub const actualBoundingBoxDescent = bridge.accessor(TextMetrics.getActualBoundingBoxDescent, null, .{});
    pub const fontBoundingBoxAscent = bridge.accessor(TextMetrics.getFontBoundingBoxAscent, null, .{});
    pub const fontBoundingBoxDescent = bridge.accessor(TextMetrics.getFontBoundingBoxDescent, null, .{});
    pub const emHeightAscent = bridge.accessor(TextMetrics.getEmHeightAscent, null, .{});
    pub const emHeightDescent = bridge.accessor(TextMetrics.getEmHeightDescent, null, .{});
    pub const hangingBaseline = bridge.accessor(TextMetrics.getHangingBaseline, null, .{});
    pub const alphabeticBaseline = bridge.accessor(TextMetrics.getAlphabeticBaseline, null, .{});
    pub const ideographicBaseline = bridge.accessor(TextMetrics.getIdeographicBaseline, null, .{});
};
