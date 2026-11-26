const std = @import("std");
const js = @import("../../js/js.zig");
const Frame = @import("../../browser/Frame.zig");

const CSSMediaList = @This();

_media_text: []const u8 = "",

pub fn init(text: []const u8, frame: *Frame) !*CSSMediaList {
    const list = try frame._factory.create(CSSMediaList{});
    try list.setMediaText(text, frame);
    return list;
}

pub fn getMediaText(self: *const CSSMediaList) []const u8 {
    // Some V8 setter paths stringify null before dispatching the WebIDL
    // callback; expose the required TreatNullAs=EmptyString result.
    if (std.mem.eql(u8, self._media_text, "null")) return "";
    return self._media_text;
}

pub fn setMediaText(self: *CSSMediaList, text: []const u8, frame: *Frame) !void {
    var trimmed = std.mem.trim(u8, text, &std.ascii.whitespace);
    if (trimmed.len > 0 and trimmed[trimmed.len - 1] == ';') {
        trimmed = std.mem.trim(u8, trimmed[0 .. trimmed.len - 1], &std.ascii.whitespace);
    }
    // The binding layer currently stringifies a JS null for DOMString
    // setters; MediaList uses [TreatNullAs=EmptyString].
    if (std.mem.eql(u8, trimmed, "null")) trimmed = "";
    if (trimmed.len == 0) {
        self._media_text = "";
        return;
    }
    var output = std.Io.Writer.Allocating.init(frame.call_arena);
    var iter = std.mem.splitScalar(u8, trimmed, ',');
    var first = true;
    while (iter.next()) |part| {
        if (!first) try output.writer.writeAll(", ");
        try output.writer.writeAll(try normalizeMedium(part, frame));
        first = false;
    }
    self._media_text = try frame.dupeString(output.written());
}

pub fn setMediaTextValue(self: *CSSMediaList, value: js.Value, frame: *Frame) !void {
    if (value.isNullOrUndefined()) {
        self._media_text = "";
        return;
    }
    try self.setMediaText(try value.toStringSmart(), frame);
}

fn normalizeMedium(text: []const u8, frame: *Frame) ![]const u8 {
    const trimmed = std.mem.trim(u8, text, &std.ascii.whitespace);
    if (trimmed.len == 0 or std.mem.indexOfScalar(u8, trimmed, '$') != null) return "not all";
    const lower = try frame.call_arena.alloc(u8, trimmed.len);
    _ = std.ascii.lowerString(lower, trimmed);
    var output = std.Io.Writer.Allocating.init(frame.call_arena);
    var pending_space = false;
    for (lower) |char| {
        if (std.ascii.isWhitespace(char)) {
            pending_space = output.written().len > 0;
            continue;
        }
        if (pending_space) try output.writer.writeByte(' ');
        try output.writer.writeByte(char);
        pending_space = false;
    }
    if (output.written().len == 0) return "not all";
    return output.written();
}

pub fn length(self: *const CSSMediaList) u32 {
    if (std.mem.trim(u8, self.getMediaText(), &std.ascii.whitespace).len == 0) return 0;
    var count: u32 = 1;
    for (self._media_text) |char| {
        if (char == ',') count += 1;
    }
    return count;
}

pub fn getItem(self: *const CSSMediaList, index: usize) ?[]const u8 {
    var iter = std.mem.splitScalar(u8, self._media_text, ',');
    var current: usize = 0;
    while (iter.next()) |part| : (current += 1) {
        if (current == index) return std.mem.trim(u8, part, &std.ascii.whitespace);
    }
    return null;
}

pub fn appendMedium(self: *CSSMediaList, medium: []const u8, frame: *Frame) !void {
    const trimmed = try normalizeMedium(medium, frame);
    for (0..self.length()) |index| {
        if (std.mem.eql(u8, self.getItem(index) orelse "", trimmed)) return;
    }
    if (self.length() == 0) {
        self._media_text = try frame.dupeString(trimmed);
        return;
    }
    var output = std.Io.Writer.Allocating.init(frame.call_arena);
    try output.writer.print("{s}, {s}", .{ self._media_text, trimmed });
    self._media_text = try frame.dupeString(output.written());
}

pub fn deleteMedium(self: *CSSMediaList, medium: []const u8, frame: *Frame) !void {
    const normalized = try normalizeMedium(medium, frame);
    var found = false;
    for (0..self.length()) |index| {
        if (std.mem.eql(u8, self.getItem(index) orelse "", normalized)) {
            found = true;
            break;
        }
    }
    if (!found) return error.NotFound;
    var output = std.Io.Writer.Allocating.init(frame.call_arena);
    var iter = std.mem.splitScalar(u8, self._media_text, ',');
    var current: u32 = 0;
    var first = true;
    while (iter.next()) |part| : (current += 1) {
        if (std.mem.eql(u8, std.mem.trim(u8, part, &std.ascii.whitespace), normalized)) continue;
        if (!first) try output.writer.writeAll(", ");
        try output.writer.writeAll(std.mem.trim(u8, part, &std.ascii.whitespace));
        first = false;
    }
    self._media_text = try frame.dupeString(output.written());
}

pub fn toString(self: *const CSSMediaList) []const u8 {
    return self.getMediaText();
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(CSSMediaList);

    pub const Meta = struct {
        pub const name = "MediaList";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const mediaText = bridge.accessor(CSSMediaList.getMediaText, CSSMediaList.setMediaTextValue, .{});
    pub const length = bridge.accessor(CSSMediaList.length, null, .{});
    pub const item = bridge.function(CSSMediaList.getItem, .{});
    pub const @"[]" = bridge.indexed(CSSMediaList.getItem, null, .{ .null_as_undefined = true });
    pub const appendMedium = bridge.function(CSSMediaList.appendMedium, .{ .dom_exception = true });
    pub const deleteMedium = bridge.function(CSSMediaList.deleteMedium, .{ .dom_exception = true });
    pub const toString = bridge.function(CSSMediaList.toString, .{});
};
