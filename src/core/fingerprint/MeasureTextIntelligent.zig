const std = @import("std");
const Frame = @import("../browser/Frame.zig");

pub const Entry = struct {
    family: []const u8,
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

    const family = extractQuotedFamily(font) orelse return null;
    for (table) |entry| {
        if (!std.mem.eql(u8, entry.text, text)) continue;
        if (!std.ascii.eqlIgnoreCase(entry.family, family)) continue;
        return entry;
    }
    return null;
}

fn extractQuotedFamily(font: []const u8) ?[]const u8 {
    const quote: u8 = '"';
    const q = std.mem.indexOfScalar(u8, font, quote) orelse return null;
    const rest = font[q + 1 ..];
    const end = std.mem.indexOfScalar(u8, rest, quote) orelse return null;
    return rest[0..end];
}
