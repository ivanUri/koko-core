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

    for (table) |entry| {
        if (!std.mem.eql(u8, entry.text, text)) continue;
        if (std.mem.eql(u8, entry.family, "creep-css-font")) {
            if (normalizedStartsWith(font, "10px")) return entry;
            continue;
        }
        if (entry.font) |stored| {
            if (normalizedEql(stored, font)) return entry;
            continue;
        }
        const family = extractPrimaryFamily(font) orelse continue;
        if (!std.ascii.eqlIgnoreCase(entry.family, family)) continue;
        return entry;
    }
    return null;
}

const NormalizedFontIterator = struct {
    input: []const u8,
    index: usize = 0,
    emitted: bool = false,

    fn next(self: *NormalizedFontIterator) ?u8 {
        const whitespace_start = self.index;
        while (self.index < self.input.len and isShorthandWhitespace(self.input[self.index])) {
            self.index += 1;
        }
        if (self.index == self.input.len) return null;

        // Do not consume the first byte after a whitespace run. Returning the
        // separator first lets the next call emit that byte without buffering
        // or allocating normalized text.
        if (self.emitted and self.index != whitespace_start) return ' ';

        const byte = self.input[self.index];
        self.index += 1;
        self.emitted = true;
        return byte;
    }
};

fn isShorthandWhitespace(byte: u8) bool {
    return byte == ' ' or byte == '\t' or byte == '\r' or byte == '\n';
}

fn normalizedEql(a: []const u8, b: []const u8) bool {
    var a_it = NormalizedFontIterator{ .input = a };
    var b_it = NormalizedFontIterator{ .input = b };
    while (true) {
        const a_byte = a_it.next();
        const b_byte = b_it.next();
        if (a_byte != b_byte) return false;
        if (a_byte == null) return true;
    }
}

fn normalizedStartsWith(value: []const u8, prefix: []const u8) bool {
    var value_it = NormalizedFontIterator{ .input = value };
    var prefix_it = NormalizedFontIterator{ .input = prefix };
    while (prefix_it.next()) |prefix_byte| {
        if (value_it.next() != prefix_byte) return false;
    }
    return true;
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

test "normalized font comparison collapses shorthand whitespace" {
    try std.testing.expect(normalizedEql(
        " \titalic  10px/12px\n \"Inter\", sans-serif\r\n",
        "italic 10px/12px \"Inter\", sans-serif",
    ));
    try std.testing.expect(!normalizedEql("10px Inter", "11px Inter"));
    try std.testing.expect(normalizedEql(" \t\r\n", ""));
}

test "normalized font prefix matching handles surrounding whitespace" {
    try std.testing.expect(normalizedStartsWith(" \n10px   \"Arial\"", "10px"));
    try std.testing.expect(normalizedStartsWith("10px\t \"Arial\"", " 10px "));
    try std.testing.expect(!normalizedStartsWith("110px Arial", "10px"));
}

test "normalized font comparison has no fixed-size truncation" {
    const allocator = std.testing.allocator;
    const long_a = try allocator.alloc(u8, 8193);
    defer allocator.free(long_a);
    @memset(long_a, 'a');
    const long_b = try allocator.dupe(u8, long_a);
    defer allocator.free(long_b);
    long_a[8192] = 'x';
    long_b[8192] = 'y';

    try std.testing.expect(!normalizedEql(long_a, long_b));
}
