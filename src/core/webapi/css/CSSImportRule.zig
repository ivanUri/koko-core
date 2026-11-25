const std = @import("std");

const js = @import("../../js/js.zig");
const Frame = @import("../../browser/Frame.zig");
const CSSRule = @import("CSSRule.zig");
const CSSMediaList = @import("CSSMediaList.zig");
const CSSStyleSheet = @import("CSSStyleSheet.zig");

const CSSImportRule = @This();

_proto: *CSSRule,
_href: []const u8 = "",
_media: *CSSMediaList,
_supports_text: []const u8 = "",
_layer_name: ?[]const u8 = null,
_style_sheet: ?*CSSStyleSheet = null,

pub fn init(raw_css_text: []const u8, frame: *Frame) !*CSSImportRule {
    const import_rule = try frame._factory.create(CSSImportRule{
        ._proto = undefined,
        ._media = undefined,
    });
    import_rule._proto = try CSSRule.init(.{ .import = import_rule }, frame);
    import_rule._proto._raw_css_text = try frame.dupeString(raw_css_text);

    const prelude = std.mem.trim(u8, raw_css_text, &std.ascii.whitespace);
    const after_at = if (std.ascii.startsWithIgnoreCase(prelude, "@import"))
        std.mem.trim(u8, prelude["@import".len..], &std.ascii.whitespace)
    else
        "";
    const parsed = parsePrelude(after_at);
    import_rule._href = try frame.dupeString(parsed.href);
    import_rule._supports_text = try frame.dupeString(parsed.supports_text);
    import_rule._layer_name = if (parsed.layer_name) |name| try frame.dupeString(name) else null;
    const media_text = parsed.media;
    if (!std.ascii.startsWithIgnoreCase(parsed.supports_text, "not ")) {
        const style_sheet = try CSSStyleSheet.initWithHref(parsed.href, frame);
        style_sheet._owner_rule = import_rule._proto;
        try style_sheet._media.setMediaText(media_text, frame);
        // CSSOM specifies that CSSImportRule.media is the very same
        // MediaList object exposed by its associated stylesheet.
        import_rule._style_sheet = style_sheet;
        import_rule._media = style_sheet._media;
    } else {
        import_rule._media = try CSSMediaList.init(media_text, frame);
    }
    return import_rule;
}

const ParsedPrelude = struct {
    href: []const u8,
    media: []const u8,
    supports_text: []const u8,
    layer_name: ?[]const u8,
};

fn matchingParen(text: []const u8, open: usize) ?usize {
    var depth: usize = 0;
    var index = open;
    while (index < text.len) : (index += 1) {
        if (text[index] == '(') depth += 1;
        if (text[index] == ')') {
            if (depth == 0) return null;
            depth -= 1;
            if (depth == 0) return index;
        }
    }
    return null;
}

fn validLayerName(name: []const u8) bool {
    if (name.len == 0) return false;
    for (name) |char| {
        if (std.ascii.isWhitespace(char) or char == '(' or char == ')' or char == ',') return false;
    }
    return true;
}

fn parseLayer(text: []const u8) struct { name: ?[]const u8, rest: []const u8 } {
    const rest = std.mem.trim(u8, text, &std.ascii.whitespace);
    if (!std.ascii.startsWithIgnoreCase(rest, "layer")) return .{ .name = null, .rest = rest };
    if (rest.len == "layer".len) return .{ .name = "", .rest = "" };
    const next = rest["layer".len];
    if (next != '(' and !std.ascii.isWhitespace(next)) return .{ .name = null, .rest = rest };
    if (next != '(') return .{ .name = "", .rest = std.mem.trim(u8, rest["layer".len..], &std.ascii.whitespace) };
    const close = matchingParen(rest, "layer".len) orelse return .{ .name = null, .rest = rest };
    const name = std.mem.trim(u8, rest["layer".len + 1 .. close], &std.ascii.whitespace);
    if (!validLayerName(name)) return .{ .name = null, .rest = rest };
    return .{ .name = name, .rest = std.mem.trim(u8, rest[close + 1 ..], &std.ascii.whitespace) };
}

fn parsePrelude(text: []const u8) ParsedPrelude {
    var rest = std.mem.trim(u8, text, &std.ascii.whitespace);
    var href: []const u8 = "";
    if (std.mem.startsWith(u8, rest, "url(")) {
        if (std.mem.indexOfScalar(u8, rest[4..], ')')) |close| {
            const inside = std.mem.trim(u8, rest[4 .. 4 + close], &std.ascii.whitespace);
            href = unquote(inside);
            rest = std.mem.trim(u8, rest[4 + close + 1 ..], &std.ascii.whitespace);
        }
    } else if (rest.len > 0 and (rest[0] == '"' or rest[0] == '\'')) {
        const quote = rest[0];
        if (std.mem.indexOfScalar(u8, rest[1..], quote)) |close| {
            href = rest[1 .. 1 + close];
            rest = std.mem.trim(u8, rest[2 + close ..], &std.ascii.whitespace);
        }
    }

    if (std.mem.endsWith(u8, rest, ";")) {
        rest = std.mem.trim(u8, rest[0 .. rest.len - 1], &std.ascii.whitespace);
    }
    const layer = parseLayer(rest);
    rest = layer.rest;
    var media = rest;
    var supports_text: []const u8 = "";
    if (std.ascii.indexOfIgnoreCase(rest, "supports(")) |supports_start| {
        media = std.mem.trim(u8, rest[0..supports_start], &std.ascii.whitespace);
        const start = supports_start + "supports(".len;
        if (std.mem.lastIndexOfScalar(u8, rest, ')')) |close| {
            if (close >= start) supports_text = std.mem.trim(u8, rest[start..close], &std.ascii.whitespace);
        }
    }
    return .{ .href = href, .media = media, .supports_text = supports_text, .layer_name = layer.name };
}

fn unquote(value: []const u8) []const u8 {
    if (value.len >= 2 and ((value[0] == '"' and value[value.len - 1] == '"') or (value[0] == '\'' and value[value.len - 1] == '\''))) {
        return value[1 .. value.len - 1];
    }
    return value;
}

pub fn getHref(self: *const CSSImportRule) []const u8 {
    return self._href;
}

pub fn getMedia(self: *CSSImportRule) *CSSMediaList {
    return self._media;
}

pub fn setMedia(self: *CSSImportRule, text: []const u8, frame: *Frame) !void {
    try self._media.setMediaText(text, frame);
}

pub fn getSupportsText(self: *const CSSImportRule) []const u8 {
    return self._supports_text;
}

pub fn getLayerName(self: *const CSSImportRule) ?[]const u8 {
    return self._layer_name;
}

pub fn getStyleSheet(self: *const CSSImportRule) ?*CSSStyleSheet {
    return self._style_sheet;
}

pub fn getCssText(self: *const CSSImportRule, frame: *Frame) ![]const u8 {
    const media = self._media.getMediaText();
    var output = std.Io.Writer.Allocating.init(frame.call_arena);
    try output.writer.writeAll("@import url(\"");
    for (self._href) |char| {
        if (char == '"' or char == '\\') try output.writer.writeByte('\\');
        try output.writer.writeByte(char);
    }
    try output.writer.writeAll("\")");
    if (self._layer_name) |name| {
        if (name.len == 0) try output.writer.writeAll(" layer") else try output.writer.print(" layer({s})", .{name});
    }
    if (media.len > 0) try output.writer.print(" {s}", .{media});
    if (self._supports_text.len > 0) try output.writer.print(" supports({s})", .{self._supports_text});
    try output.writer.writeByte(';');
    return output.written();
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(CSSImportRule);

    pub const Meta = struct {
        pub const name = "CSSImportRule";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const href = bridge.accessor(CSSImportRule.getHref, null, .{});
    pub const media = bridge.accessor(CSSImportRule.getMedia, CSSImportRule.setMedia, .{});
    pub const supportsText = bridge.accessor(CSSImportRule.getSupportsText, null, .{});
    pub const layerName = bridge.accessor(CSSImportRule.getLayerName, null, .{});
    pub const styleSheet = bridge.accessor(CSSImportRule.getStyleSheet, null, .{});
};
