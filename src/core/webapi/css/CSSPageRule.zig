const std = @import("std");

const js = @import("../../js/js.zig");
const Frame = @import("../../browser/Frame.zig");
const CSSRule = @import("CSSRule.zig");
const CSSStyleProperties = @import("CSSStyleProperties.zig");

const CSSPageRule = @This();

_proto: *CSSRule,
_selector_text: []const u8 = "",
_style: ?*CSSStyleProperties = null,

pub fn init(raw_css_text: []const u8, frame: *Frame) !*CSSPageRule {
    const page = try frame._factory.create(CSSPageRule{ ._proto = undefined });
    page._proto = try CSSRule.init(.{ .frame = page }, frame);
    page._proto._raw_css_text = try frame.dupeString(raw_css_text);

    const trimmed = std.mem.trim(u8, raw_css_text, &std.ascii.whitespace);
    const open = std.mem.indexOfScalar(u8, trimmed, '{') orelse trimmed.len;
    const header = std.mem.trim(u8, trimmed[0..open], &std.ascii.whitespace);
    if (std.ascii.startsWithIgnoreCase(header, "@page")) {
        page._selector_text = try frame.dupeString(std.mem.trim(u8, header["@page".len..], &std.ascii.whitespace));
    }
    const body = blockBody(trimmed) orelse "";
    const style = try page.getStyle(frame);
    try style.asCSSStyleDeclaration().setCssText(body, frame);
    return page;
}

pub fn getSelectorText(self: *const CSSPageRule) []const u8 {
    return self._selector_text;
}

pub fn setSelectorText(self: *CSSPageRule, text: []const u8, frame: *Frame) !void {
    const normalized = normalizeSelector(text, frame) orelse {
        self._selector_text = "";
        return;
    };
    self._selector_text = try frame.dupeString(normalized);
}

pub fn getStyle(self: *CSSPageRule, frame: *Frame) !*CSSStyleProperties {
    if (self._style) |style| return style;
    const style = try CSSStyleProperties.init(null, false, frame);
    self._style = style;
    return style;
}

pub fn setStyle(self: *CSSPageRule, text: []const u8, frame: *Frame) !void {
    try (try self.getStyle(frame)).asCSSStyleDeclaration().setCssText(text, frame);
}

pub fn getCssText(self: *CSSPageRule, frame: *Frame) ![]const u8 {
    const style = (try self.getStyle(frame)).asCSSStyleDeclaration();
    const style_text = try style.getCssText(frame);
    var output = std.Io.Writer.Allocating.init(frame.call_arena);
    const selector = if (self._selector_text.len == 0) "" else self._selector_text;
    if (style_text.len == 0) {
        if (selector.len == 0) {
            try output.writer.writeAll("@page { }");
        } else {
            try output.writer.print("@page {s} {{ }}", .{selector});
        }
        return output.written();
    }
    if (selector.len == 0) {
        try output.writer.print("@page {{ {s} }}", .{style_text});
    } else {
        try output.writer.print("@page {s} {{ {s} }}", .{ self._selector_text, style_text });
    }
    return output.written();
}

fn normalizeSelector(text: []const u8, frame: *Frame) ?[]const u8 {
    const trimmed = std.mem.trim(u8, text, &std.ascii.whitespace);
    if (trimmed.len == 0) return "";
    for (trimmed) |char| {
        if (std.ascii.isWhitespace(char)) return null;
    }

    var output = std.Io.Writer.Allocating.init(frame.call_arena);
    var parts = std.mem.splitScalar(u8, trimmed, ':');
    const name = parts.next() orelse return null;
    if (name.len > 0) output.writer.writeAll(name) catch return null;
    var pseudo_count: usize = 0;
    while (parts.next()) |pseudo| {
        if (pseudo.len == 0) return null;
        if (!(std.ascii.eqlIgnoreCase(pseudo, "first") or
            std.ascii.eqlIgnoreCase(pseudo, "left") or
            std.ascii.eqlIgnoreCase(pseudo, "right") or
            std.ascii.eqlIgnoreCase(pseudo, "blank"))) return null;
        output.writer.writeByte(':') catch return null;
        var lower: [16]u8 = undefined;
        const normalized = std.ascii.lowerString(&lower, pseudo);
        output.writer.writeAll(normalized) catch return null;
        pseudo_count += 1;
    }
    if (pseudo_count == 0 and name.len == 0) return null;
    return output.written();
}

fn blockBody(source: []const u8) ?[]const u8 {
    const open = std.mem.indexOfScalar(u8, source, '{') orelse return null;
    const close = std.mem.lastIndexOfScalar(u8, source, '}') orelse return null;
    if (close <= open) return null;
    return source[open + 1 .. close];
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(CSSPageRule);

    pub const Meta = struct {
        pub const name = "CSSPageRule";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const selectorText = bridge.accessor(CSSPageRule.getSelectorText, CSSPageRule.setSelectorText, .{});
    pub const style = bridge.accessor(CSSPageRule.getStyle, CSSPageRule.setStyle, .{});
};
