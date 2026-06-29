const std = @import("std");
const Frame = @import("../../core/browser/Frame.zig");

pub const Entry = struct {
    family: []const u8,
    font: ?[]const u8 = null,
    text: []const u8,
    width: f64,
    actual_bounding_box_left: f64,
    actual_bounding_box_right: f64,
    actual_bounding_box_ascent: f64,
    actual_bounding_box_descent: f64,
    font_bounding_box_ascent: f64,
    font_bounding_box_descent: f64,
};

pub fn lookup(frame: *Frame, font: []const u8, text: []const u8) ?Entry {
    const profile = frame.loadedProfile();
    if (profile.mode != .antidetect) return null;
    const table = profile.measure_text_baseline;
    if (table.len == 0) return null;

    const norm_font = normalizeFont(font);
    for (table) |entry| {
        if (!std.mem.eql(u8, entry.text, text)) continue;
        if (std.mem.eql(u8, entry.family, "creep-css-font")) {
            if (std.mem.startsWith(u8, norm_font, "10px")) return entry;
            continue;
        }
        if (entry.font) |stored| {
            if (std.mem.eql(u8, normalizeFont(stored), norm_font)) return entry;
            continue;
        }
        const family = extractPrimaryFamily(font) orelse continue;
        if (!std.ascii.eqlIgnoreCase(entry.family, family)) continue;
        return entry;
    }
    return null;
}

fn normalizeFont(font: []const u8) []const u8 {
    // Browsers collapse font shorthand whitespace; match loosely for CreepJS stack.
    var out: [4096]u8 = undefined;
    var len: usize = 0;
    var prev_space = true;
    for (std.mem.trim(u8, font, " \t\r\n")) |c| {
        const space = c == ' ' or c == '\t' or c == '\r' or c == '\n';
        if (space) {
            if (!prev_space and len < out.len) {
                out[len] = ' ';
                len += 1;
            }
            prev_space = true;
            continue;
        }
        if (len < out.len) {
            out[len] = c;
            len += 1;
        }
        prev_space = false;
    }
    if (len > 0 and out[len - 1] == ' ') len -= 1;
    return out[0..len];
}

fn extractPrimaryFamily(font: []const u8) ?[]const u8 {
    var families = font;
    if (std.mem.indexOf(u8, font, "px")) |px| {
        families = std.mem.trim(u8, font[px + 2 ..], " \t\r\n");
    }
    if (extractQuotedFamily(families)) |quoted| return quoted;
    const comma = std.mem.indexOf(u8, families, ",") orelse return trimFamily(families);
    return trimFamily(families[0..comma]);
}

fn extractQuotedFamily(font: []const u8) ?[]const u8 {
    const quote: u8 = '"';
    const q = std.mem.indexOfScalar(u8, font, quote) orelse return null;
    const rest = font[q + 1 ..];
    const end = std.mem.indexOfScalar(u8, rest, quote) orelse return null;
    return rest[0..end];
}

fn trimFamily(font: []const u8) ?[]const u8 {
    var start: usize = 0;
    var end: usize = font.len;
    while (start < end and (font[start] == ' ' or font[start] == '\t')) : (start += 1) {}
    while (end > start and (font[end - 1] == ' ' or font[end - 1] == '\t')) : (end -= 1) {}
    if (start >= end) return null;
    var family = font[start..end];
    if (family.len >= 2 and ((family[0] == '\'' and family[family.len - 1] == '\'') or
        (family[0] == '"' and family[family.len - 1] == '"')))
    {
        family = family[1 .. family.len - 1];
    }
    if (family.len == 0) return null;
    return family;
}
